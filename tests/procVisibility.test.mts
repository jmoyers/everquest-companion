// PROC VISIBILITY (docs/plans/proc-visibility.md §3) — the ledger announcing itself, and the
// drill rows that learned their rate.
//
// The bug this feature fixes is a DISCOVERABILITY bug, not an arithmetic one: proc data shipped
// behind the breakdown card's second tab and nothing on screen ever said so — the owner, who
// wrote the engine half, could not find it. JOS-37 closed that structurally (the tab pair is
// gone; procs own a dashboard cell), and the assertions here survived it unchanged in spirit:
//
//   1. THE NUMBERS ARE READ, NEVER RECOMPUTED. The card's header readout must equal the totals
//      of the list beneath it, so `procSummary` is pinned against `procListRows` — the panel's
//      own rows — rather than against a hand-written arithmetic of its own. A second rollup is
//      the failure mode; equality is the test.
//   2. THE IS-A-PROC JOIN GOES BOTH WAYS. A poison Strike and a cast-less spell effect annotate;
//      an ordinary melee lane and a spell you actually CAST do not. The join is built in main
//      (procViews.ts) from the poison roster and procDetect's inference, so the fixture half
//      below is what proves the renderer never guesses.
//
// THE FIXTURES, replayed through the REAL parser + engine (w35 primes the coats that make the
// later windows slow-capable — the harness's established pattern):
//   w36-poison-slow-timing.log  the slow landings; 23 Strike procs + 27 Smiting Strike
//   w41-poison-asp-venom.log    the poison DAMAGE lane (Asp Venom Strike deals; Weakening does not)
//   w38-proc-ppm.log            no poison at all — three cast-less lanes and the slay group
//
// ONE MEASURED CORRECTION TO THE PLAN, AND ITS LATER REVERSAL — both written down rather than
// smoothed over. §3 asked for "Weakening/Venom drill rows"; `Weakening Strike` is a SLOW that
// deals no damage, so wave 1 found no meter row to annotate and pinned that ABSENCE instead of
// inventing a row. The owner's 2026-08-04 report is what settled it the other way: the absence
// was not neutral, because a RESIST does create a row, and that row then read `0 landed`. A
// damage-less Strike now gets a row built from its landing emotes and the annotation to match
// (tests/procAccuracy.test.mts owns the full case; the two cases below pin the reversal here).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { CombatEngine } from '../src/main/combat/engine'
import { formatPpm } from '../src/renderer/src/lib/formatRate'
import {
  hasProcActivity,
  procAnnotationFor,
  procCount,
  procListRows,
  procSummary,
  procTagIndex
} from '../src/renderer/src/features/combat/procRows'
import { flattenSkills } from '../src/renderer/src/features/combat/dashboardData'
import { landEvidence } from '../src/renderer/src/features/combat/landEvidence'
import type { ProcsView, SegmentView, SourceView } from '../src/shared/combat'
import type { ProcRateView, ProcSkillTag } from '../src/shared/procAnalytics'

// ── synthetic half: the shaping, with every dimension controllable ───────────────────

/** A ProcsView with nothing in it. The shipped poison fields are all required, so an empty
 *  ledger has to be spelled out; `over` supplies only the dimension under test. */
function view(over: Partial<ProcsView> = {}): ProcsView {
  return {
    combatAtEngage: [],
    slowExpected: false,
    coats: [],
    strikes: [],
    strikeCount: 0,
    slowLands: 0,
    poisonDamage: [],
    poisonDamageTotal: 0,
    dispels: [],
    dispelCount: 0,
    stanceSwitches: 0,
    invocationSwitches: 0,
    ...over
  }
}

function rate(count: number, swings: number, over: Partial<ProcRateView> = {}): ProcRateView {
  return { count, swings, ...over }
}

/** One is-a-proc tag as main would emit it. An args object because five positional parameters
 *  blow `max-params`, and `activeSec` defaults to the window every case below shares. */
function tag(t: Omit<ProcSkillTag, 'activeSec'> & { activeSec?: number }): ProcSkillTag {
  return { ...t, activeSec: t.activeSec ?? 200 }
}

test('zero procs: no header readout at all — an empty selection grows no furniture', () => {
  const s = procSummary(view())
  assert.equal(s.count, 0)
  assert.equal(hasProcActivity(view()), false)
  assert.equal(s.ppm, undefined)
  assert.deepEqual(procListRows(view()), [], 'and the card draws its quiet note, not a table')
})

test('the header readout: one count and one rate, in the app’s own spellings', () => {
  const overall = rate(12, 400, { ppmActive: 3.1, ppmWall: 2.8, per100Swings: 3 })
  const s = procSummary(view({ overall }))
  assert.equal(s.count, 12)
  // The rate is the app's ONE proc-rate spelling (formatRate.formatPpm), not a second one.
  assert.equal(s.ppm, formatPpm(3.1))
  assert.equal(s.header, `12 procs · ${formatPpm(3.1)}`)

  // The SLOW is not restated here. "It landed at +4.2s" is the segment header's line, and a
  // second copy of it in the proc list is exactly the clutter JOS-37 removed.
  assert.equal(procSummary(view({ overall, slowLandMs: 4200 })).header, `12 procs · ${formatPpm(3.1)}`)
})

test('a rate the engine withheld is ABSENT from the header, never zero (law 5)', () => {
  // Below MIN_ACTIVE_SEC the engine sends no `ppmActive` at all. The COUNT is still exact, so
  // the header shows it — a count with no rate, which is the honest shape.
  const s = procSummary(view({ overall: rate(3, 12) }))
  assert.equal(s.header, '3 procs')
  assert.equal(s.ppm, undefined)
})

test('the count falls back to the shipped poison total when the engine sent no lanes', () => {
  // The pre-analytics payload shape: `strikes` only. The badge must still say something true.
  assert.equal(procCount(view({ strikes: [{ name: 'Weakening Strike', count: 4 }], strikeCount: 4 })), 4)
  assert.equal(procCount(view({ strikeCount: 4, overall: rate(9, 100) })), 9)
})

test('the is-a-proc join, BOTH directions', () => {
  const tags = [
    tag({
      skill: 'Asp Venom Strike',
      lane: 'Asp Venom Strike / Cobra Venom Strike',
      origin: 'poison',
      rate: rate(7, 400, { ppmActive: 2.1 })
    }),
    tag({ skill: 'Smiting Strike', lane: 'Smiting Strike', origin: 'spell', rate: rate(27, 400, { ppmActive: 8.6 }) })
  ]
  const idx = procTagIndex(tags)

  // TAGGED: the poison Strike and the cast-less spell effect, each with the LANE's own rate.
  assert.equal(procAnnotationFor(idx, 'Asp Venom Strike')?.text, `proc · ${formatPpm(2.1)}`)
  assert.equal(procAnnotationFor(idx, 'Smiting Strike')?.text, `proc · ${formatPpm(8.6)}`)

  // NOT TAGGED: an ordinary melee lane, and a spell with no ledger entry (i.e. one you cast).
  assert.equal(procAnnotationFor(idx, 'Melee'), undefined)
  assert.equal(procAnnotationFor(idx, 'Backstab'), undefined)
  assert.equal(procAnnotationFor(idx, 'Wrath'), undefined)

  // Names are dirty; keys fold (law 2).
  assert.equal(procAnnotationFor(idx, 'asp venom strike')?.text, `proc · ${formatPpm(2.1)}`)

  // The hover names the BASIS (count over active seconds) and, for a shared emote, says the
  // count is exact while the name is not.
  const hint = procAnnotationFor(idx, 'Asp Venom Strike')?.hint ?? ''
  assert.match(hint, /7 procs over 200s of active combat/)
  assert.match(hint, /Asp Venom Strike \/ Cobra Venom Strike/)
  // The inferred lane says it is inferred (law 1) and the poison lane does not claim to be.
  assert.match(procAnnotationFor(idx, 'Smiting Strike')?.hint ?? '', /INFERENCE/)
  assert.doesNotMatch(hint, /INFERENCE/)

  // No tags at all ⇒ nothing annotates. An absent payload is an absence, never a crash.
  assert.equal(procAnnotationFor(procTagIndex(undefined), 'Smiting Strike'), undefined)
})

test('a tagged row whose rate the engine withheld degrades to a bare `proc`', () => {
  const idx = procTagIndex([
    tag({ skill: 'Asp Venom Strike', lane: 'Asp Venom Strike', origin: 'poison', rate: rate(1, 8), activeSec: 4 })
  ])
  const a = procAnnotationFor(idx, 'Asp Venom Strike')
  assert.equal(a?.text, 'proc')
  // The fact that it IS a proc is still worth stating; the withheld division says why.
  assert.match(a?.hint ?? '', /No per-minute rate/)
})

// ── fixture half: the real windows ───────────────────────────────────────────────────

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function fixture(name: string): string[] {
  const p = join(FIXTURES, name)
  return existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.length > 0) : []
}

const W35 = fixture('w35-poison-coats.log') // PRIME: the coats the later windows fight under
const W36 = fixture('w36-poison-slow-timing.log')
const W38 = fixture('w38-proc-ppm.log')
const W41 = fixture('w41-poison-asp-venom.log')

const missing = (...w: string[][]): string | false =>
  w.some((f) => f.length === 0) ? 'fixture not present' : false

function replay(lines: string[]): { eng: CombatEngine; lastTs: number } {
  installSpellDb(loadSpellDb())
  const eng = new CombatEngine()
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) {
      lastTs = ev.ts
      eng.ingestEvent(ev, false)
    }
  }
  return { eng, lastTs }
}

function segment(eng: CombatEngine, lastTs: number, id: string): SegmentView {
  const s = eng.snapshot(lastTs, { selectedId: id })
  assert.ok(s.selected, `segment ${id} resolves`)
  return s.selected
}

function you(seg: SegmentView): SourceView {
  const row = seg.entities.find((e) => e.id === 'you')
  assert.ok(row, `${seg.id} has a You row`)
  return row
}

/** Every drill row the level-2 list would draw, mapped to its proc annotation text (rows with
 *  no annotation are simply absent) — i.e. exactly what the user sees. */
function annotatedRows(seg: SegmentView): Map<string, string> {
  const idx = procTagIndex(seg.procs.procSkills)
  const out = new Map<string, string>()
  for (const r of flattenSkills(you(seg))) {
    const a = procAnnotationFor(idx, r.name)
    if (a) out.set(r.name, a.text)
  }
  return out
}

const sortedKeys = (m: Map<string, string>): string[] => [...m.keys()].sort()

test('W36: the header, the list and the drill rows all light from the same ledger', { skip: missing(W35, W36) }, () => {
  const { eng, lastTs } = replay([...W35, ...W36])
  const zone = segment(eng, lastTs, 'zone')
  const s = procSummary(zone.procs)

  // Hand-read: 23 poison Strike emotes + 27 cast-less Smiting Strike + 5 Finishing Blow = 55
  // procs in the window. The five are JOS-437's: grepping W36 for `(Finishing Blow)` returns
  // exactly those five of the player's own swings (W35's sixth is in the earlier zone session
  // this replay primes with). They were happening here before and the panel did not count them.
  assert.equal(zone.procs.strikeCount, 23)
  assert.equal(s.count, 55)
  assert.match(s.header, /^55 procs · /)
  assert.equal(hasProcActivity(zone.procs), true)
  // The list is ranked by count, and its counts add up to the header's number.
  const list = procListRows(zone.procs)
  assert.equal(list.reduce((n, r) => n + r.count, 0), 55)
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].count >= list[i].count, 'count desc')

  // THE DRILL. Three lanes carry damage — and THREE MORE carry only landing emotes (2026-08-04,
  // the owner's report). Befuddling, Stunning and Weakening Strike deal nothing at all; before
  // the fix they were in the ledger and absent from the drill, which is how the same Strike came
  // to read `90 landings` in one panel and `0 landed · N resisted` in the other. Every one of
  // the six now learns the lane's rate. The five weapon lanes and the one spell the player
  // actually CAST (Wrath — it has a cast line, so procDetect scores it no proc) stay
  // unannotated.
  // The two lanes carrying `· proc` are the two the CAST-LESS detector judged (JOS-167 names
  // the lane after its origin): Asp Venom Strike and Smiting Strike both arrive as
  // `dtype: 'spell'` damage with no cast line. Blood Siphon Strike parses as a DoT (ineligible,
  // see the w41 header) and the three damage-less Strikes have no damage row at all — they are
  // grafted from the emote ledger — so none of the four is renamed.
  const rows = annotatedRows(zone)
  assert.deepEqual(sortedKeys(rows), [
    'Asp Venom Strike · proc',
    'Befuddling Strike',
    'Blood Siphon Strike',
    'Smiting Strike · proc',
    'Stunning Strike',
    'Weakening Strike'
  ])
  for (const plain of ['Melee', 'Backstab', 'Frenzy', 'Bash', 'Kick', 'Wrath']) {
    assert.equal(rows.get(plain), undefined, `${plain} is not a proc`)
  }
  for (const text of rows.values()) assert.match(text, /^proc · \d/)
})

test('the slow stays the ENGINE’s fact, and no longer the proc list’s', { skip: missing(W35, W36) }, () => {
  const { eng, lastTs } = replay([...W35, ...W36])
  // e4 is the pull whose first Weakening Strike landed 31s in (hand-read off the fixture clock).
  // The engine still states it — the segment header renders it — and JOS-37 only stopped the
  // proc list from restating it a second time.
  const e4 = segment(eng, lastTs, 'e4')
  assert.equal(e4.procs.slowLandMs, 31_000)
  // The Strike that carried it is still IN the list, as a counted lane like any other.
  const weakening = procListRows(e4.procs).find((r) => r.name.includes('Weakening'))
  assert.ok(weakening, 'the slow lane is a proc row like any other')
  assert.ok(weakening.count >= 1)

  const e3 = segment(eng, lastTs, 'e3')
  assert.equal(e3.procs.slowLandMs, undefined, 'e3 opened slow-capable and never landed one')
})

test('the header EQUALS the list’s own totals — read, never recomputed', { skip: missing(W35, W36, W41) }, () => {
  for (const [prime, win] of [
    [W35, W36],
    [W35, W41]
  ]) {
    const { eng, lastTs } = replay([...prime, ...win])
    for (const id of ['zone', 'e2', 'e3', 'e4']) {
      const seg = segment(eng, lastTs, id)
      const p = seg.procs
      const s = procSummary(p)
      const rows = procListRows(p)
      const overall = p.overall
      assert.ok(overall, `${id} carries an overall rate`)

      // The header is an IDENTITY over the rows the panel lists.
      assert.equal(s.count, rows.reduce((n, r) => n + r.count, 0))
      assert.equal(s.count, overall.count)

      // …and its rate is the engine's `ppmActive` through the app's ONE spelling — never a
      // second division, and absent (not zero) whenever the engine withheld it.
      assert.equal(s.ppm, overall.ppmActive === undefined ? undefined : formatPpm(overall.ppmActive))
      assert.equal(s.header, s.ppm === undefined ? `${s.count} procs` : `${s.count} procs · ${s.ppm}`)
    }
  }
})

test('W41: the venom row learns its rate; the slow lane has no row to learn one', { skip: missing(W35, W41) }, () => {
  const { eng, lastTs } = replay([...W35, ...W41])
  const zone = segment(eng, lastTs, 'zone')
  const rows = annotatedRows(zone)

  // Asp Venom Strike deals damage (2 hits, 106) so the meter has a row for it, and the row now
  // carries the LANE's rate — the ambiguous `Asp Venom Strike / Cobra Venom Strike` lane, whose
  // count is exact and whose name is not.
  const asp = procAnnotationFor(procTagIndex(zone.procs.procSkills), 'Asp Venom Strike · proc')
  assert.match(asp?.text ?? '', /^proc · /)
  assert.match(asp?.hint ?? '', /Asp Venom Strike \/ Cobra Venom Strike/)
  assert.deepEqual(sortedKeys(rows), [
    'Asp Venom Strike · proc',
    'Befuddling Strike',
    'Blood Siphon Strike',
    'Smiting Strike · proc',
    'Stunning Strike',
    'Weakening Strike'
  ])

  // THE OVERTURNED DECISION (owner report, 2026-08-04). Weakening Strike fired six times in this
  // window. It is a SLOW: it deals nothing, so the damage meter had no row for it and the wave
  // that shipped the drill annotation deliberately emitted no tag — "the drill lists damage".
  // The owner's screenshots showed the cost of that: the Procs tab counted the landings while
  // the drill, on the strength of RESISTS alone, said `0 landed`. A damage-less Strike now gets
  // its row and its tag, and the row carries the landings rather than a damage total.
  const weakening = (zone.procs.lanes ?? []).find((l) => l.name === 'Weakening Strike')
  assert.equal(weakening?.count, 6)
  assert.equal(
    (zone.procs.procSkills ?? []).some((t) => t.lane === 'Weakening Strike'),
    true
  )
  const row = flattenSkills(you(zone)).find((r) => r.name === 'Weakening Strike')
  assert.ok(row, 'the damage-less Strike now has a drill row')
  assert.equal(row.total, 0, 'and it still deals nothing — the row is landings, not damage')
  assert.equal(row.hits, 0)
  assert.equal(row.lands, 6, 'the six emote landings, the same six the ledger counted')

  // …and the row's own wording is the fix in one line: not `0 landed`.
  const ev = landEvidence(row)
  assert.equal(ev.landed, 6)
  assert.match(ev.text, /^0 dmg · 6 landed/)
})

test('W38: the merged Slay Undead row learns the slay lane rate; no poison anywhere', { skip: missing(W38) }, () => {
  const { eng, lastTs } = replay(W38)
  const zone = segment(eng, lastTs, 'zone')
  assert.equal(zone.procs.strikeCount, 0)

  // A slay proc rides an ordinary weapon swing, so the aggregate's rows are weapon names and
  // the drill merges them into ONE row named after the lane. That merged row is what carries
  // the rate — the weapon rows underneath it are mostly ordinary swings and must not.
  const rows = annotatedRows(zone)
  assert.deepEqual(sortedKeys(rows), [
    'Condemnation of Nife · proc',
    'Dismiss Undead · proc',
    'Slay Undead',
    'Smiting Strike · proc'
  ])
  assert.equal(rows.get('Melee'), undefined)
  assert.equal(rows.get('Backstab'), undefined)

  const slay = (zone.procs.procSkills ?? []).find((t) => t.skill === 'Slay Undead')
  assert.equal(slay?.origin, 'slay')
  assert.match(procAnnotationFor(procTagIndex(zone.procs.procSkills), 'Slay Undead')?.hint ?? '', /rides an ordinary weapon swing/)
})
