// THE BUFFS/TIMER OVERLAY's entry model, pinned to real bytes (JOS-89).
// Design record: docs/plans/buff-timer-overlay.md.
//
// Ten user reports converge on this surface and the loudest ask in all of them is the one this
// file exists to prove: chain-mez four or five enemies and see a NAMED COUNTDOWN PER ENEMY. The
// owner's own log already contains that exact sequence, so nothing here is authored — every
// assertion below is read off `tests/fixtures/w10-cazic-slow.log`, a scrubbed excerpt of a real
// Plane of Fear pull, replayed through the real parser + the real BuffsModule + the real
// BuffTimersModule and out through the real projection.
//
// THE LAW UNDER TEST: a duration spells.json STATES becomes a receding countdown; a duration
// nobody states becomes elapsed time counting UP; an invented remaining is never displayed.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES, readFixture, replayBuffTimers, tsOf } from './harness.mts'
import {
  buildTimerRows,
  rowsForSurface,
  statedDuration,
  timerReading,
  timerRowSurface,
  type BuffTimerRow
} from '../src/shared/buffTimers.ts'
import { CC_UNKNOWN_CAP_MS } from '../src/main/modules/buffTimers.ts'
import { getParserConfig } from '../src/main/log/rulesets.ts'
import type { ActiveBuff, SpellDbFile } from '../src/shared/types.ts'

const W10 = readFixture('w10-cazic-slow.log')

/** The rows for one target, by the mob's display name. */
function rowsFor(rows: BuffTimerRow[], target: string): BuffTimerRow[] {
  return rows.filter((r) => r.target === target)
}
function ccRowFor(rows: BuffTimerRow[], target: string): BuffTimerRow | undefined {
  return rowsFor(rows, target).find((r) => r.kind === 'cc')
}

// ---------------------------------------------------------------------------------------------
// THE CHAIN-MEZ. One cast, two enemies, two independent clocks, two independent break lines.
//
//   [20:50:33] You begin casting Mesmerization III.
//   [20:50:34] a turmoil toad has been mesmerized.
//   [20:50:34] a scareling has been mesmerized.
//   [20:50:36] Your Mesmerization spell has worn off of a scareling.
//   [20:50:52] Your Mesmerization spell has worn off of a turmoil toad.
//
// Note the two break lines are 2 s and 18 s after one 24 s-stated cast — the same sentence for a
// mez that ran and a mez a nuke broke. That is exactly why "it ended" is all this surface claims.
// ---------------------------------------------------------------------------------------------

const CAST = tsOf('[Sat Aug 01 20:50:33 2026] You begin casting Mesmerization III.')
const LANDED = CAST + 1_000
const AFTER_SCARELING_BREAK = tsOf('[Sat Aug 01 20:50:36 2026] Your Mesmerization spell has worn off of a scareling.')
const AFTER_TOAD_BREAK = tsOf('[Sat Aug 01 20:50:52 2026] Your Mesmerization spell has worn off of a turmoil toad.')

test('one AE mez cast produces a NAMED row per enemy — the chain-mez the reports asked for', () => {
  const { rows, timers } = replayBuffTimers(W10, { until: LANDED })

  const toad = ccRowFor(rows, 'a turmoil toad')
  const scareling = ccRowFor(rows, 'a scareling')
  assert.ok(toad, 'no crowd-control row for a turmoil toad')
  assert.ok(scareling, 'no crowd-control row for a scareling')

  // THREE HOLDS, NOT TWO, SINCE JOS-159 — and the extra one is this fixture reporting a defect it
  // has carried all along. Its first two lines are `You begin casting Allure VI.` /
  // `phoboplasm has been charmed.` at 20:46:21, a 16-minute charm still running at 20:50:34, and
  // it used to open NOTHING because the scraped DB left Allure's cast-on-other message empty and
  // the charm broadcast therefore resolved to seven candidates none of which the player had cast.
  // The corrections overlay supplies the sentence, so the charm now holds like any other. The AE
  // mez this test is about is still exactly two of the three.
  assert.equal(timers.holds.length, 3, 'the AE mez`s two, plus the Allure charm that was already live')
  assert.equal(
    timers.holds.filter((h) => h.target !== 'phoboplasm').length,
    2,
    'one cast, two mobs, two holds'
  )

  // NAMED, not a family: "has been mesmerized." is FOUR spells in the committed DB (Dazzle,
  // Mesmerization, Mesmerize, Sathir's Mesmerization). The player's own cast anchor names one,
  // which is JOS-84's law working — the parser hands over candidates, the MODEL resolves.
  //
  // AND IT NAMES THE RANK (JOS-140). `You begin casting Mesmerization III.` is the ONLY line in
  // the whole family that carries one — the landing sentence names no spell at all and the
  // wear-off names the rank-less base — so the anchor is the one chance the row has to say which
  // rank of yours is on that mob. This is also the field the alerts tracker was missing
  // (JOS-126's DF5V60 note): before this, no event in the app ever carried a ranked name.
  assert.equal(toad.name, 'Mesmerization III')
  assert.equal(scareling.name, 'Mesmerization III')
  assert.equal(toad.ambiguous, undefined, 'a resolved row must not claim ambiguity')
  assert.equal(scareling.ambiguous, undefined)

  // Two INDEPENDENT entries keyed per target — not one row with a list of mobs.
  assert.notEqual(toad.id, scareling.id)
  assert.equal(toad.targetKey, 'a turmoil toad')
  assert.equal(scareling.targetKey, 'a scareling')
})

test('…and each counts DOWN, because spells.json states Mesmerization at 24s', () => {
  const { rows } = replayBuffTimers(W10, { until: LANDED })
  for (const name of ['a turmoil toad', 'a scareling']) {
    const row = ccRowFor(rows, name)
    assert.ok(row)
    assert.equal(row.mode, 'countdown', `${name} should count down from a STATED duration`)
    assert.equal(row.durationMs, 24_000, `${name}: the DB's stated Mesmerization duration`)
    // Read at the landing instant: full bar, 24s left, not overdue.
    const r = timerReading(row, row.startedTs)
    assert.equal(r.remainingMs, 24_000)
    assert.equal(r.fraction, 1)
    assert.equal(r.overdue, false)
    // Read 10s in: receding, never negative.
    const later = timerReading(row, row.startedTs + 10_000)
    assert.equal(later.remainingMs, 14_000)
    assert.ok(later.fraction > 0 && later.fraction < 1)
  }
})

test('a countdown never renders a negative remaining — it clamps at zero and says overdue', () => {
  const { rows } = replayBuffTimers(W10, { until: LANDED })
  const row = ccRowFor(rows, 'a turmoil toad')
  assert.ok(row)
  const past = timerReading(row, row.startedTs + 999_000)
  assert.equal(past.remainingMs, 0, 'a countdown must clamp, never go negative')
  assert.equal(past.fraction, 0)
  assert.equal(past.overdue, true)
})

test('a break line clears ONLY its own target — the other enemy keeps counting', () => {
  // The scareling broke at 20:50:36; the toad has 16s of its window left.
  const { rows } = replayBuffTimers(W10, { until: AFTER_SCARELING_BREAK })
  assert.equal(ccRowFor(rows, 'a scareling'), undefined, 'the broken mez must clear its target')
  assert.ok(ccRowFor(rows, 'a turmoil toad'), 'the OTHER target must be untouched by it')
})

test('…and when the second break line prints, its target clears too', () => {
  const { rows, timers } = replayBuffTimers(W10, { until: AFTER_TOAD_BREAK })
  assert.equal(ccRowFor(rows, 'a turmoil toad'), undefined)
  assert.equal(
    timers.holds.filter((h) => h.key === 'a turmoil toad' || h.key === 'a scareling').length,
    0,
    'both holds gone'
  )
})

test('one cast landing on THREE enemies at once produces three rows', () => {
  // [20:53:52] one Mesmerization III → a dracoliche pet / a glare lord pet / a glare lord.
  const at = tsOf('[Sat Aug 01 20:53:53 2026] x')
  const { rows } = replayBuffTimers(W10, { until: at })
  const cc = rows.filter((r) => r.kind === 'cc')
  assert.ok(cc.length >= 3, `expected at least three concurrent holds, got ${cc.length}`)
  // Every one of them is a distinct, named target with its own clock.
  assert.equal(new Set(cc.map((r) => r.targetKey)).size, cc.length, 'holds must be keyed per target')
})

// ---------------------------------------------------------------------------------------------
// THE HONESTY LAW, as an invariant over EVERY row EVERY fixture produces — not one happy case.
// ---------------------------------------------------------------------------------------------

/** Every committed fixture that carries a cast, a landing or a wear-off worth folding. */
const ALL_FIXTURES = [
  'w7-quick-buff.log',
  'w8-wears-off.log',
  'w9-permanent-illusion.log',
  'w10-cazic-slow.log',
  'w11-illusion-exclusivity.log',
  'w16-shared-wearsoff-speed.log',
  'w17-own-cast-gating.log',
  'w44-poison-slow-per-mob.log',
  'g2-buff-fanout.log',
  'w13-charm-break-recharm.log',
  'w5-charm-zone.log'
]

test('AN UNKNOWN DURATION NEVER COUNTS DOWN — over every row of every fixture', () => {
  let elapsedRows = 0
  let countdownRows = 0
  for (const name of ALL_FIXTURES) {
    const { rows } = replayBuffTimers(readFixture(name))
    for (const row of rows) {
      if (row.mode === 'countdown') {
        countdownRows++
        assert.ok(
          row.durationMs != null && row.durationMs > 0,
          `${name}: a countdown row without a stated duration — ${row.name}`
        )
      } else {
        elapsedRows++
        assert.equal(
          row.durationMs,
          undefined,
          `${name}: a non-countdown row carrying a duration — ${row.name} (${row.mode})`
        )
        // …and its reading is pure elapsed: no remaining is offered at all.
        const r = timerReading(row, row.startedTs + 5_000)
        assert.equal(r.remainingMs, undefined, `${name}: ${row.name} offered a remaining it cannot know`)
        assert.equal(r.elapsedMs, 5_000)
      }
    }
  }
  assert.ok(countdownRows > 0, 'the fixtures produced no countdown rows at all — the test proves nothing')
  assert.ok(elapsedRows > 0, 'the fixtures produced no count-up rows at all — the test proves nothing')
})

test('OBSERVED WINS OVER DB — an observed duration earns the countdown (JOS-117 unifies the estimator)', () => {
  // JOS-89 refused to count down from anything but a DB-stated duration, because a mined estimate
  // could be a censored (too-short) sample. JOS-117's estimator makes an observation safe to trust:
  // `overlayDurationMs` = max(DB floor, recent observed max), so a below-base click-off cannot pull
  // it down and a focus-extended cast beats the base. The overlay reads that one field, and the
  // Buffs TAB reads its own copy of the SAME number (`estimatedMs`/`durationSource`) — they agree.
  //
  // SAY WHICH: asserted on the PROJECTION with typed ActiveBuffs — the model's own documented shape
  // from buffsView.ts `durationFields` — not an invented log sentence. The end-to-end estimator
  // (click-off ignored, floor held, refresh reset) is pinned in tests/buffOverlayDuration.test.mts
  // against the real modules.
  const observed: ActiveBuff = {
    spell: 'Swift Like the Wind',
    cls: 'buff',
    self: true,
    startedTs: 1_000,
    // Both surfaces now carry the player's own observed 33m — the log beat the 16m DB floor.
    estimatedMs: 1_980_000,
    durationSource: 'observed',
    p25: null,
    p75: null,
    n: 1,
    overlayDurationMs: 1_980_000,
    overlaySource: 'observed'
  }
  const dbOnly: ActiveBuff = {
    spell: 'A Spell Never Observed',
    cls: 'buff',
    self: true,
    startedTs: 1_000,
    estimatedMs: 300_000,
    durationSource: 'db',
    p25: null,
    p75: null,
    n: 0,
    overlayDurationMs: 300_000,
    overlaySource: 'db'
  }
  const rows = buildTimerRows({ active: [observed, dbOnly], stats: {} }, { holds: [], ends: [] })

  const obsRow = rows.find((r) => r.name === 'Swift Like the Wind')
  assert.ok(obsRow)
  assert.equal(obsRow.mode, 'countdown', 'an observed duration now counts DOWN (the reversal)')
  assert.equal(obsRow.durationMs, 1_980_000, 'and it counts down from the OBSERVED 33m, not the DB 16m')
  assert.equal(timerReading(obsRow, 1_000 + 60_000).remainingMs, 1_920_000)

  // A spell the player has never cleanly observed falls back to the DB base — still a countdown.
  const dbRow = rows.find((r) => r.name === 'A Spell Never Observed')
  assert.ok(dbRow)
  assert.equal(dbRow.mode, 'countdown')
  assert.equal(dbRow.durationMs, 300_000)
})

test('a buff with NO observed sample and NO DB duration still counts UP — nothing invented', () => {
  // `overlayDurationMs` null (no sample, no DB base) is the only count-up case left. The overlay
  // never draws a bar from a number it does not have.
  const bare: ActiveBuff = {
    spell: 'Some Unscraped Spell',
    cls: 'buff',
    self: true,
    startedTs: 1_000,
    estimatedMs: null,
    p25: null,
    p75: null,
    n: 0,
    overlayDurationMs: null
  }
  const rows = buildTimerRows({ active: [bare], stats: {} }, { holds: [], ends: [] })
  const row = rows.find((r) => r.name === 'Some Unscraped Spell')
  assert.ok(row)
  assert.equal(row.mode, 'elapsed', 'no honest duration ⇒ count up')
  assert.equal(row.durationMs, undefined, 'and carry no duration at all')
  assert.equal(timerReading(row, 1_000 + 60_000).remainingMs, undefined)
})

test('a permanent illusion gets no timer at all, rather than a fabricated one', () => {
  const { buffs, rows } = replayBuffTimers(readFixture('w9-permanent-illusion.log'))
  const permanent = buffs.active.filter((a) => a.permanent === true)
  assert.ok(permanent.length > 0, 'fixture no longer produces a permanent illusion')
  for (const p of permanent) {
    const row = rows.find((r) => r.name === p.spell)
    assert.ok(row, `no row for the permanent ${p.spell}`)
    assert.equal(row.mode, 'permanent')
    assert.equal(row.durationMs, undefined)
    assert.equal(timerReading(row, row.startedTs + 60_000).remainingMs, undefined)
  }
})

// ---------------------------------------------------------------------------------------------
// OWN-CAST GATING and JOS-88's death clear — the two rules that decide what may appear at all.
// ---------------------------------------------------------------------------------------------

test('a mez with no own cast behind it opens no hold — a stranger`s crowd control is not ours', () => {
  // Feed the landing sentence with NO preceding own cast: the identical ruling
  // combat/ingest.ts ingestCc makes for the encounter model.
  const foreign = [
    '[Sat Aug 01 20:46:05 2026] You have entered The Plane of Fear - Solo 1 (Awakened).',
    '[Sat Aug 01 20:50:34 2026] a turmoil toad has been mesmerized.'
  ]
  const { rows, timers } = replayBuffTimers(foreign)
  assert.equal(timers.holds.length, 0, 'a broadcast with no own cast behind it must open no hold')
  assert.equal(rows.filter((r) => r.kind === 'cc').length, 0)
})

test('your death clears your SELF rows and leaves everything else standing (JOS-88)', () => {
  const lines = readFixture('w7-quick-buff.log')
  const deathLine = lines.find((l) => l.includes('You have been slain by'))
  assert.ok(deathLine, 'w7 no longer carries a player death')
  const before = replayBuffTimers(lines, { until: tsOf(deathLine) - 1 })
  const after = replayBuffTimers(lines, { until: tsOf(deathLine) })

  const selfBefore = before.rows.filter((r) => r.group === 'self')
  assert.ok(selfBefore.length > 0, 'no self rows before the death — the assertion would be vacuous')
  assert.equal(
    after.rows.filter((r) => r.group === 'self').length,
    0,
    'your corpse and your buffs are gone — every self row must clear'
  )
  // A death strips YOUR buffs, not the ones on other entities.
  assert.equal(
    after.rows.filter((r) => r.group === 'target').length,
    before.rows.filter((r) => r.group === 'target').length,
    'a player death must not touch rows bound to other entities'
  )
})

// ---------------------------------------------------------------------------------------------
// THE CANDIDATE LAW (JOS-84) and the numbers the constants rest on.
// ---------------------------------------------------------------------------------------------

test('a shared landing sentence yields a FAMILY and no duration, never a coin flip', () => {
  // `statedDuration` is the whole rule, and the DB's own numbers are what make it non-trivial.
  assert.equal(statedDuration([{ durationMs: 48_000 }]), 48_000, 'one candidate states its own duration')
  assert.equal(
    statedDuration([{ durationMs: 24_000 }, { durationMs: 24_000 }]),
    24_000,
    'candidates that AGREE keep the number — the ambiguity never reaches the clock'
  )
  assert.equal(
    statedDuration([{ durationMs: 96_000 }, { durationMs: 24_000 }]),
    null,
    'candidates that DISAGREE state nothing'
  )
  assert.equal(
    statedDuration([{ durationMs: 24_000 }, { durationMs: null }]),
    null,
    'one candidate with no duration poisons the set — we do not know which spell it was'
  )
  assert.equal(statedDuration([]), null)
})

test('THE ORACLE: the unknown-duration cap is still the longest CC duration spells.json states', () => {
  // Re-derived from the committed DB against the parser's OWN cc roster on every run — the
  // charmCcRoster.test.mts pattern. A future scrape that adds a longer hold fails here instead of
  // silently truncating somebody's timer.
  const db = JSON.parse(readFileSync(join(FIXTURES, '..', '..', 'src/main/data/spells.json'), 'utf8')) as SpellDbFile
  const cc = getParserConfig().ccSpell
  const stated = db.spells.filter((s) => cc.test(s.name) && s.durationMs != null).map((s) => s.durationMs as number)
  assert.ok(stated.length > 0, 'the cc roster matched no spell in the DB — the roster or the DB moved')
  assert.equal(
    Math.max(...stated),
    CC_UNKNOWN_CAP_MS,
    'the longest stated CC duration moved; CC_UNKNOWN_CAP_MS must move with it (or say why not)'
  )
})

test('rows are ordered self-first, then per target, soonest to expire', () => {
  const { rows } = replayBuffTimers(W10, { until: LANDED })
  const firstTarget = rows.findIndex((r) => r.group === 'target')
  if (firstTarget >= 0) {
    assert.ok(
      rows.slice(firstTarget).every((r) => r.group === 'target'),
      'a self row appeared after a target row — self buffs render first (world-model law 4)'
    )
  }
  // A target's rows are contiguous: you read one enemy's block, not an interleave.
  const seen = new Set<string>()
  let prev = ''
  for (const r of rows.filter((x) => x.group === 'target')) {
    const k = r.targetKey ?? ''
    if (k !== prev) {
      assert.ok(!seen.has(k), `rows for ${k} are split across the list`)
      seen.add(k)
      prev = k
    }
  }
})

test('every row id is stable and unique within a snapshot', () => {
  for (const name of ALL_FIXTURES) {
    const { rows } = replayBuffTimers(readFixture(name))
    const ids = rows.map((r) => r.id)
    assert.equal(new Set(ids).size, ids.length, `${name}: duplicate row ids ${ids.join(', ')}`)
  }
})

// ---------------------------------------------------------------------------------------------
// TWO WINDOWS, ONE MODEL (JOS-119). The owner asked for buffs and debuffs to be separate windows
// he can enable and place independently. The split is a FILTER over the rows this file already
// pins — not a second fold, not a second model — so the property that matters is a PARTITION:
// every row lands on exactly one surface and nothing is invented or lost on the way.
// ---------------------------------------------------------------------------------------------

test('the two timer surfaces PARTITION the rows — nothing lost, nothing duplicated', () => {
  for (const name of ALL_FIXTURES) {
    const { rows } = replayBuffTimers(readFixture(name))
    const buffRows = rowsForSurface(rows, 'buffs')
    const debuffRows = rowsForSurface(rows, 'debuffs')
    assert.equal(
      buffRows.length + debuffRows.length,
      rows.length,
      `${name}: ${rows.length} rows split into ${buffRows.length} + ${debuffRows.length}`
    )
    const ids = new Set([...buffRows, ...debuffRows].map((r) => r.id))
    assert.equal(ids.size, rows.length, `${name}: a row reached both windows, or neither`)
    // …and the order inside each window is the model's own order, untouched by the filter.
    assert.deepEqual(buffRows, rows.filter((r) => buffRows.includes(r)), `${name}: buffs re-ordered`)
    assert.deepEqual(debuffRows, rows.filter((r) => debuffRows.includes(r)), `${name}: debuffs re-ordered`)
  }
})

test('a beneficial spell goes to the BUFFS window even when it is on somebody else', () => {
  // g2-buff-fanout.log is the fixture that has one buff up on several entities. `group` is not the
  // discriminator: a buff you put on your pet is `group: 'target'` and is still a BUFF, so routing
  // by target would file your own group buffs under "debuffs".
  const { rows } = replayBuffTimers(readFixture('g2-buff-fanout.log'))
  const onOthers = rows.filter((r) => r.kind === 'buff' && r.group === 'target')
  assert.ok(onOthers.length > 0, 'the fan-out fixture should leave a buff standing on somebody else')
  for (const r of onOthers) {
    assert.equal(timerRowSurface(r), 'buffs', `${r.name} on ${r.target ?? '?'} was filed as a debuff`)
  }
  assert.ok(
    rowsForSurface(rows, 'buffs').some((r) => r.group === 'target'),
    'the buffs window must carry the buffs you put on other people'
  )
})

test('the chain-mez lands on the DEBUFFS window, and the buffs window never sees a mez', () => {
  // The owner rules mez and slow ARE debuffs, so the CC holds belong beside the debuffs rather
  // than in a third place. This is the ten-reports scenario, routed.
  const { rows } = replayBuffTimers(W10, { until: LANDED })
  const debuffRows = rowsForSurface(rows, 'debuffs')
  const buffRows = rowsForSurface(rows, 'buffs')

  const mez = debuffRows.filter((r) => r.kind === 'cc' && r.name === 'Mesmerization III')
  assert.equal(mez.length, 2, 'both mez holds belong to the debuffs window')
  assert.deepEqual(
    mez.map((r) => r.target).sort(),
    ['a scareling', 'a turmoil toad'],
    'per-target, on the debuffs window'
  )
  assert.equal(buffRows.some((r) => r.kind === 'cc' || r.kind === 'debuff'), false, 'a debuff reached the buffs window')
  assert.equal(debuffRows.some((r) => r.kind === 'buff'), false, 'a buff reached the debuffs window')
})

test('a slow you put on a mob is a DEBUFF row on the debuffs window, not a buff', () => {
  // The ActiveBuff path (land → "worn off of <mob>"), which is the other half of what the debuffs
  // window is for. MEASURED on the committed fixture: the full w10 replay leaves Shiftless Deeds
  // (the slow the owner's Plane of Fear pull opens with) and Tashani standing on their targets.
  const { rows } = replayBuffTimers(W10)
  const debuffs = rows.filter((r) => r.kind === 'debuff')
  assert.ok(debuffs.length > 0, 'the Cazic pull should leave debuff rows standing')
  assert.ok(
    // The RANK is on the row since JOS-140 — the cast line says `Shiftless Deeds IV` and the
    // wear-off says `Shiftless Deeds`, and the row now shows the one you actually cast.
    debuffs.some((r) => r.name === 'Shiftless Deeds IV'),
    `the slow itself should be one of them: ${debuffs.map((r) => r.name).join(', ')}`
  )
  for (const r of debuffs) assert.equal(timerRowSurface(r), 'debuffs', `${r.name} was filed as a buff`)
  // …and they arrive on the debuffs window under the enemy they are on, not under a self heading.
  const onDebuffWindow = rowsForSurface(rows, 'debuffs')
  for (const r of debuffs) {
    assert.ok(onDebuffWindow.includes(r), `${r.name} never reached the debuffs window`)
    assert.equal(r.group, 'target', `${r.name} on ${r.target ?? '?'} is not filed per target`)
  }
})

// The CC half's DEATH path (JOS-156 — it closes the right hold and mints nothing) lives in
// tests/deathClearsDebuffs.test.mts beside the buffs half's, so the ticket's evidence is in one
// place and this file stays under the 400-code-line ceiling.
test('a debuff row is never routed by GROUP — the row kind is the whole discriminator', () => {
  // The regression this guards: routing by `group` would send every buff you put on your pet or
  // your group to the debuffs window, and would send a debuff standing on YOU to the buffs one.
  for (const name of ALL_FIXTURES) {
    const { rows } = replayBuffTimers(readFixture(name))
    for (const r of rows) {
      assert.equal(timerRowSurface(r), r.kind === 'buff' ? 'buffs' : 'debuffs', `${name}: ${r.id}`)
    }
  }
})
