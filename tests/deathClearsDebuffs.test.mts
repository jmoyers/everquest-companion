// JOS-156 — A MOB THAT DIES TAKES ITS ROWS WITH IT, WHOEVER LANDED THE KILL.
//
// The owner, live-testing the Plane of Sky on 2026-08-09: a Shiftless Deeds row survived its
// mob's death. The kills that day were all landed by his CHARM PET, so no death in the fight took
// the first-person `You have slain <X>!` shape.
//
// WHAT THE MEASUREMENT FOUND, and it is NOT what the report assumed. The three death SHAPES were
// never the problem — `parseWorld.ts` has unified `You have slain <X>!`, `<X> has been slain by
// <Y>!` and the killerless `<X> died.` into ONE `death` event naming the dead one since JOS-101,
// and `modules/buffs.ts` has read `ev.name` off all three ever since. Replaying the owner's own
// window proves it: three of the four bees the pet killed had their slow cleared correctly.
//
// The one that did not was `Bzzazzt has been slain by Bzzazzt!` — a charmed bee killing a bee of
// the SAME NAME. That name matched the live charmed pet, so the death went into the branch whose
// whole job is to refuse to censor a live pet on an ambiguous death (`charmedPetDiesOnDeathLine`,
// which correctly returns false and always will), and NOTHING happened. Not the pet's buffs,
// which is right, and not the slow on the corpse, which is the ticket.
//
// So a death is two questions with different answers: "did something of that name die?" (always
// yes, in all three shapes) and "is the ENTITY retired?" (identity, and the only place the pet
// bindings get a vote). This file pins the first one, the discrimination between them, and the
// two rules the clearing obeys: ONE landing closes per death (JOS-140 ruling 7), and a
// death-clear MINTS NOTHING (ruling 5 — a land-to-death span is not a duration).
//
// Fixture: w18-charm-pet-kills.log (tests/extract-fixtures.mjs W18 has the hand-read timeline).
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSpellDb } from '../src/main/data/spellDb.ts'
import { installSpellDb } from '../src/main/log/rulesets.ts'
import { BuffsModule } from '../src/main/modules/buffs.ts'
import { BuffTimersModule } from '../src/main/modules/buffTimers.ts'
import { CastAnchors } from '../src/main/modules/buffAnchors.ts'
import { SpellStats } from '../src/main/modules/buffsStats.ts'
import { spellKey } from '../src/main/modules/buffsShapes.ts'
import type { LogEvent } from '../src/shared/logEvents.ts'
import type { BuffsSnap } from '../src/shared/types.ts'
import { readFixture, replayBuffs, findActive, tsOf } from './harness.mts'

const W18 = 'w18-charm-pet-kills.log'

/** The pet is charmed at 15:20:40; the first three deaths are 15:21:11 / 15:21:37 / 15:22:08. */
const BEFORE_FIRST_DEATH = tsOf('[Sun Aug 09 15:21:10 2026] x')
const AFTER_FIRST_DEATH = tsOf('[Sun Aug 09 15:21:12 2026] x')

/** The real line the ticket is about, verbatim from the owner's log. */
const TWIN_DEATH = '[Sun Aug 09 15:21:11 2026] Bzzazzt has been slain by Bzzazzt!'

/** Replay the window, stopping at `until` — the model as the owner's overlay would have shown it. */
function at(until: number, lines = readFixture(W18)): BuffsSnap {
  return replayBuffs(lines.filter((l) => tsOf(l) <= until))
}

/** The same window with the twin death rewritten into another real death shape. */
function withDeathShape(line: string): BuffsSnap {
  return at(AFTER_FIRST_DEATH, readFixture(W18).map((l) => (l === TWIN_DEATH ? line : l)))
}

/** Every active row bound to `target`, by spell name (lowercased). */
function onTarget(snap: BuffsSnap, target: string): string[] {
  return snap.active.filter((a) => a.target === target).map((a) => a.spell.toLowerCase())
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PREMISE. Without it the assertions below would pass against an empty model.

test('JOS-156 premise: the bee named Bzzazzt is carrying two debuffs when it dies', () => {
  const rows = onTarget(at(BEFORE_FIRST_DEATH), 'Bzzazzt')
  assert.ok(
    rows.some((s) => s.includes('shiftless deeds')),
    'the Shiftless Deeds the owner reported is on the board at 15:21:10'
  )
  assert.ok(rows.some((s) => s.includes('tashania')), 'and so is the Tashania cast on it at 15:20:23')
})

// ─────────────────────────────────────────────────────────────────────────────
// THE TICKET.

test('JOS-156: a mob killed by your charm pet, sharing its name, still loses its debuff rows', () => {
  const snap = at(AFTER_FIRST_DEATH)
  const rows = onTarget(snap, 'Bzzazzt')
  assert.equal(
    rows.some((s) => s.includes('shiftless deeds')),
    false,
    'the slow goes with the corpse even though the killer answers to the same name'
  )
  assert.equal(rows.some((s) => s.includes('tashania')), false, 'and so does the Tashania')
})

test('JOS-156: the SAME line leaves the live pet its own buffs', () => {
  // This is why the death cannot simply retire the entity: the pet is named Bzzazzt too, and it
  // is wearing a Swift Like the Wind the owner cast on it at 15:20:59. The censor reads the
  // spell's CLASS, so a detrimental row on that name goes and a beneficial one stays.
  const rows = onTarget(at(AFTER_FIRST_DEATH), 'Bzzazzt')
  assert.deepEqual(rows, ['swift like the wind iv'], 'the pet keeps its haste and loses nothing else')
})

test('JOS-156: the player keeps their own buffs when a mob dies', () => {
  const swift = findActive(at(AFTER_FIRST_DEATH), 'swift like the wind')
  assert.ok(swift, 'a mob dying is not a player death')
  assert.equal(at(AFTER_FIRST_DEATH).active.some((a) => a.self), true, 'the self row survives')
})

// ─────────────────────────────────────────────────────────────────────────────
// THE CONTROL ARM — the three bees whose names did NOT collide with the pet's. These cleared
// before JOS-156 as well; they are here so a future change to the death path cannot quietly
// break the case that always worked while fixing the one that did not.

test('JOS-156: every third-party kill in the window clears its own mob, and only its own', () => {
  const kills: [string, string][] = [
    ['Bazzzazzt', '[Sun Aug 09 15:21:38 2026] x'],
    ['Bzzzt', '[Sun Aug 09 15:22:09 2026] x'],
    ['Bazzt Zzzt', '[Sun Aug 09 15:22:49 2026] x']
  ]
  for (const [mob, after] of kills) {
    const before = at(tsOf(after) - 2_000)
    assert.ok(onTarget(before, mob).length > 0, `${mob} is slowed before it dies`)
    assert.deepEqual(onTarget(at(tsOf(after)), mob), [], `${mob} loses its rows to a kill it did not land`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// THE SHAPE MATRIX. Every death sentence EQ prints, substituted for the real one at 15:21:11.
// Each shape is a real one: `You have slain <X>!` occurs 327× in the owner's log, the
// third-person form is what the whole window is made of, and the killerless `<X> died.` is the
// DoT-tick death JOS-101 added (19 mob occurrences in a 1.44M-line sweep).

test('JOS-156: all three death shapes clear the dead mob rows', () => {
  const shapes = [
    '[Sun Aug 09 15:21:11 2026] You have slain Bzzazzt!',
    '[Sun Aug 09 15:21:11 2026] Bzzazzt has been slain by Bzzazzt!',
    '[Sun Aug 09 15:21:11 2026] Bzzazzt has been slain by Primitive!',
    '[Sun Aug 09 15:21:11 2026] Bzzazzt has been slain by a greater sphinx!',
    '[Sun Aug 09 15:21:11 2026] Bzzazzt died.'
  ]
  for (const line of shapes) {
    assert.deepEqual(
      onTarget(withDeathShape(line), 'Bzzazzt'),
      ['swift like the wind iv'],
      `the debuffs go and the pet buff stays: ${line.slice(27)}`
    )
  }
})

test('JOS-156: a death with no line at all leaves the rows standing', () => {
  // The negative control for the matrix above: drop the death and both debuffs are still there,
  // so each assertion above is a delta the death line caused rather than a hygiene sweep.
  const rows = onTarget(at(AFTER_FIRST_DEATH, readFixture(W18).filter((l) => l !== TWIN_DEATH)), 'Bzzazzt')
  assert.equal(rows.length, 3, 'slow + Tashania + the pet haste, with nothing to remove them')
})

// ─────────────────────────────────────────────────────────────────────────────
// THE KILLER IS NOT THE KILLED.

test('JOS-156: the killer keeps its debuff rows', () => {
  // The window with the third kill removed (so Bzzzt keeps the slow it took at 15:21:45) and the
  // fourth rewritten to make Bzzzt the victim of a mob that is itself slowed. Both names, both
  // shapes, one line apart — the only thing separating them is which side of "slain by" they sit.
  const lines = readFixture(W18)
    .filter((l) => !l.includes('Bzzzt has been slain by Bzzazzt!'))
    .map((l) =>
      l.includes('Bazzt Zzzt has been slain by')
        ? '[Sun Aug 09 15:22:48 2026] Bzzzt has been slain by Bazzt Zzzt!'
        : l
    )
  const after = at(tsOf('[Sun Aug 09 15:22:49 2026] x'), lines)
  assert.deepEqual(onTarget(after, 'Bzzzt'), [], 'the mob the line says DIED loses its slow')
  assert.ok(onTarget(after, 'Bazzt Zzzt').length > 0, 'the mob the line says killed it keeps its own')
})

// ─────────────────────────────────────────────────────────────────────────────
// THE ROUND RULES (JOS-140 ruling 7), driven through the real module. One AE landing can put a
// spell on several mobs of one name in a single log second — measured in w10-cazic-slow.log,
// where one Mesmerization cast prints two `has been mesmerized.` lines in the same second and
// later three — and the row that results carries a COUNT CHIP. A death is evidence about ONE of
// them. The owner's own log has no same-second duplicate slow landing to cut a fixture from
// (a whole-log sweep of `<X> slows down.` finds zero repeated stamps), so this drives the events
// the parser would have emitted rather than inventing a sentence the game has never printed.

/** A DB-backed module plus a monotonic feeder — the buffOverlayDuration.test.mts pattern. */
function makeModule(): { mod: BuffsModule; feed: (ev: Omit<LogEvent, 'seq'>) => void } {
  const db = loadSpellDb()
  installSpellDb(db)
  const mod = new BuffsModule(db)
  mod.reset()
  let seq = 0
  return { mod, feed: (ev) => { mod.onEvent({ ...ev, seq: seq++ } as LogEvent) } }
}

const SD = 'Shiftless Deeds IV'
const SD_MS = 150_000
const T0 = tsOf('[Sun Aug 09 15:20:00 2026] x')

/** An AE slow landing on `n` mobs that share a name, all inside one log second. */
function aeSlow(feed: (ev: Omit<LogEvent, 'seq'>) => void, n: number, ts: number): void {
  feed({ kind: 'castBegin', ts: ts - 3_000, raw: `[x] You begin casting ${SD}.`, spell: SD })
  for (let i = 0; i < n; i++) {
    feed({
      kind: 'buffApply',
      ts,
      raw: `[x] Bzzazzt slows down.`,
      spell: SD,
      target: 'Bzzazzt',
      illusion: false,
      durationMs: SD_MS,
      candidates: [{ name: SD, durationMs: SD_MS, illusion: false }]
    })
  }
}

function slowRow(mod: BuffsModule): BuffsSnap['active'][number] | undefined {
  return findActive(mod.snapshot().state, 'shiftless deeds')
}

/** The row's count chip. A chip of one is OMITTED from the snapshot (buffsView.ts: it would be noise). */
function slowCount(mod: BuffsModule): number | undefined {
  const row = slowRow(mod)
  return row ? (row.count ?? 1) : undefined
}

test('JOS-156: one death closes ONE landing of a same-named group', () => {
  const { mod, feed } = makeModule()
  aeSlow(feed, 3, T0)
  assert.equal(slowCount(mod), 3, 'three bees of one name are one row with a count of three')

  feed({ kind: 'death', ts: T0 + 10_000, raw: '[x] Bzzazzt has been slain by Bzzazzt!', name: 'Bzzazzt', bySelf: false, killer: 'Bzzazzt' })
  assert.equal(slowCount(mod), 2, 'a kill is evidence about ONE of them, not about the name')

  feed({ kind: 'death', ts: T0 + 20_000, raw: '[x] You have slain Bzzazzt!', name: 'Bzzazzt', bySelf: true })
  assert.equal(slowCount(mod), 1, 'and a different death shape counts exactly the same')

  feed({ kind: 'death', ts: T0 + 30_000, raw: '[x] Bzzazzt died.', name: 'Bzzazzt', bySelf: false })
  assert.equal(slowRow(mod), undefined, 'only an empty group removes the row')
})

test('JOS-156: a death-clear mints nothing', () => {
  // Land one slow, kill the mob 20 s later, then land another on a differently-named mob and read
  // the learner's sample count off the row. A land-to-death span is not a duration: the spell was
  // cut short by the corpse. The refusal is structural today (`onEntityDeath` throws away what
  // `closeOldest` returns) — this pins it so a future refactor that routes the close through
  // `recordFade`'s sampling path cannot teach the estimator from kills.
  const { mod, feed } = makeModule()
  aeSlow(feed, 1, T0)
  feed({ kind: 'death', ts: T0 + 20_000, raw: '[x] Bzzazzt has been slain by Bzzazzt!', name: 'Bzzazzt', bySelf: false, killer: 'Bzzazzt' })
  assert.equal(slowRow(mod), undefined, 'the row is gone')

  feed({ kind: 'castBegin', ts: T0 + 30_000, raw: `[x] You begin casting ${SD}.`, spell: SD })
  feed({
    kind: 'buffApply',
    ts: T0 + 33_000,
    raw: '[x] Bazzzazzt slows down.',
    spell: SD,
    target: 'Bazzzazzt',
    illusion: false,
    durationMs: SD_MS,
    candidates: [{ name: SD, durationMs: SD_MS, illusion: false }]
  })
  const row = slowRow(mod)
  assert.ok(row, 'the next slow lands')
  assert.equal(row!.n, 0, 'the corpse contributed no observation: the learner still has zero samples')
})

test('JOS-156: a real wear-off DOES still mint', () => {
  // The other side of the rule, so the refusal above is a distinction and not a broken path: the
  // same land, ended by the line that says it wore off, is exactly the clean cycle ruling 5 admits.
  const { mod, feed } = makeModule()
  aeSlow(feed, 1, T0)
  feed({ kind: 'buffFade', ts: T0 + 20_000, raw: '[x] Your Shiftless Deeds spell has worn off of Bzzazzt.', spell: SD, target: 'Bzzazzt' })
  feed({ kind: 'castBegin', ts: T0 + 30_000, raw: `[x] You begin casting ${SD}.`, spell: SD })
  feed({
    kind: 'buffApply',
    ts: T0 + 33_000,
    raw: '[x] Bazzzazzt slows down.',
    spell: SD,
    target: 'Bazzzazzt',
    illusion: false,
    durationMs: SD_MS,
    candidates: [{ name: SD, durationMs: SD_MS, illusion: false }]
  })
  assert.equal(slowRow(mod)?.n, 1, 'a witnessed wear-off is a sample')
})

// ─────────────────────────────────────────────────────────────────────────────
// THE CROWD-CONTROL HALF (modules/buffTimers.ts). A DEATH ENDS A HOLD BUT TEACHES NOTHING.
//
// This half never had the ticket's defect: it reads `ev.name` off the one unified death event, so
// all three shapes have always closed the right hold. What it DID do is mint — a mez ended by a
// corpse was fed to the learner as if the spell had been observed running out, when a
// land-to-death span is the hold being cut short. buffRounds.ts's ruling 5 has always listed a
// death among the contaminating events; this is that sentence finally enforced on this path.
//
// Driven through the real module rather than a fixture because the owner's log has no mez whose
// CLEAN cycle a death closes (every mez that dies in w10-cazic-slow.log was refreshed first, and a
// refresh already contaminates), so no committed bytes can tell the two behaviours apart. The
// events are the ones the parser emits for lines that window is full of.
const MEZ = 'Mesmerization III'
const MEZ_START = tsOf('[Sat Aug 01 20:50:33 2026] x')

/** A bare BuffTimersModule over its own anchors + learner, with a self cast already anchored. */
function timersWithAnchoredCast(ts: number): { timers: BuffTimersModule; stats: SpellStats } {
  const db = loadSpellDb()
  installSpellDb(db)
  const anchors = new CastAnchors()
  const stats = new SpellStats(db)
  const timers = new BuffTimersModule(anchors, stats)
  timers.reset()
  anchors.noteSelfCast(MEZ, ts)
  return { timers, stats }
}

/** `<mob> has been mesmerized.` as the parser emits it with the DB installed. */
function ccLanding(mob: string, ts: number): LogEvent {
  return {
    kind: 'cc',
    seq: 1,
    ts,
    raw: `[x] ${mob} has been mesmerized.`,
    mob,
    candidates: [{ name: MEZ, durationMs: 24_000 }]
  }
}

function mezSamples(stats: SpellStats): number {
  return stats.statFor(spellKey(MEZ))?.n ?? 0
}

test('JOS-156: a hold ended by a DEATH mints no duration sample', () => {
  const { timers, stats } = timersWithAnchoredCast(MEZ_START)
  timers.onEvent(ccLanding('a scareling', MEZ_START + 1_000))
  assert.equal(timers.snapshot().state.holds.length, 1, 'the mez opened a hold')

  timers.onEvent({
    kind: 'death',
    seq: 2,
    ts: MEZ_START + 15_000,
    raw: '[x] You have slain a scareling!',
    name: 'a scareling',
    bySelf: true
  })
  assert.equal(timers.snapshot().state.holds.length, 0, 'and the death closed it')
  assert.equal(mezSamples(stats), 0, 'a corpse is not an observation of how long a mez lasts')
})

test('JOS-156: every death shape closes the hold, and none of them mints', () => {
  const deaths: Omit<LogEvent & { kind: 'death' }, 'seq' | 'ts' | 'raw'>[] = [
    { kind: 'death', name: 'a scareling', bySelf: true },
    { kind: 'death', name: 'a scareling', bySelf: false, killer: 'phoboplasm' },
    { kind: 'death', name: 'a scareling', bySelf: false }
  ]
  for (const d of deaths) {
    const { timers, stats } = timersWithAnchoredCast(MEZ_START)
    timers.onEvent(ccLanding('a scareling', MEZ_START + 1_000))
    timers.onEvent({ ...d, seq: 2, ts: MEZ_START + 15_000, raw: '[x] a death line' })
    assert.equal(timers.snapshot().state.holds.length, 0, `killer=${d.killer ?? String(d.bySelf)}`)
    assert.equal(mezSamples(stats), 0, `killer=${d.killer ?? String(d.bySelf)} taught the learner nothing`)
  }
})

test('JOS-156: …while a real break line still mints, so the CC refusal is a distinction', () => {
  const { timers, stats } = timersWithAnchoredCast(MEZ_START)
  timers.onEvent(ccLanding('a scareling', MEZ_START + 1_000))
  timers.onEvent({
    kind: 'cc',
    seq: 2,
    ts: MEZ_START + 15_000,
    raw: '[x] Your Mesmerization spell has worn off of a scareling.',
    mob: 'a scareling',
    refresh: true,
    spell: MEZ
  })
  assert.equal(mezSamples(stats), 1, 'a witnessed break IS a clean cycle')
})
