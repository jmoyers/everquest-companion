// THE MEZ THAT WAS OVERWRITTEN AND NEVER TOLD ANYBODY (JOS-410).
//
// THE REPORT (01M0B6KS9CFPPQ9WG6V8S9R5T1, 1.5.0): *"The debuff window doesn't properly keep track
// of Dazzle if it has been used to overwrite a Mesmerization spell. Once Mesmerize is overwritten
// the debuff window still tracks it and also shows a Mesmerize/Dazzle bar under it that just counts
// up."* Two defects in one sentence, and this file reproduces both before it pins their fixes:
//
//   1. THE STALE BAR. EQ prints NOTHING when one mez-line spell replaces another on the same mob —
//      no wear-off, no `awakened`, nothing — so the old hold counted down to zero and squatted
//      there until the unwitnessed-expiry cull got to it. There was no overwrite rule anywhere.
//   2. THE PHANTOM COUNT-UP. Both casts sit inside `OWN_CAST_WINDOW_MS` of the second landing
//      sentence, so BOTH anchored, `resolveCc` gave up, and the row was a two-candidate FAMILY
//      (`Dazzle / Mesmerize`) whose members state 96 s and 24 s. They disagree, so `statedDuration`
//      states nothing and the bar renders as ELAPSED time counting up — while the Dazzle that was
//      actually cast is never tracked as Dazzle at all.
//
// THE LINES ARE INJECTED, AND THIS IS THE SANCTIONED FORM (AGENTS.md: a reporter's slice never
// becomes a fixture). The reporter's own log window contains only SOLO Dazzle cycles — the
// overwrite he describes is not in the bytes he sent — so the sequence below is authored from
// shapes that ARE real: `You begin casting Mesmerization III.` and `<mob> has been mesmerized.` are
// verbatim from the committed `w10-cazic-slow.log` (the owner's own Plane of Fear pull, mob name
// and all), and `You begin casting Dazzle VII.` is quoted from the reporter's slice with the mob
// swapped for the owner's. Nothing here is a shape no real log has printed.
//
// Every assertion runs the real parser through the real BuffsModule + BuffTimersModule and out
// through the real projection.

import test from 'node:test'
import assert from 'node:assert/strict'
import { replayBuffTimers, tsOf } from './harness.mts'
import type { SpellStats } from '../src/main/modules/buffsStats.ts'
import { learnKey, SELF_CASTER } from '../src/shared/buffTrust.ts'

/** Dazzle's committed spells.json row — the number the reporter's bar should have been drawing. */
const DAZZLE_DB_MS = 96_000
/** Mesmerization's — the stale bar's, and the reason the family could agree on nothing. */
const MEZ_DB_MS = 24_000

const MOB = 'a turmoil toad'

/** The reported sequence: mez, then overwrite it with a different mez line eight seconds later. */
const OVERWRITE = [
  '[Sat Aug 01 20:50:33 2026] You begin casting Mesmerization III.',
  `[Sat Aug 01 20:50:34 2026] ${MOB} has been mesmerized.`,
  '[Sat Aug 01 20:50:41 2026] You begin casting Dazzle VII.',
  `[Sat Aug 01 20:50:42 2026] ${MOB} has been mesmerized.`
]
const AFTER_OVERWRITE = tsOf(`[Sat Aug 01 20:50:42 2026] ${MOB} has been mesmerized.`)

function samplesOf(stats: SpellStats, key: string): { ms: number }[] {
  return stats.samples.get(learnKey(key, SELF_CASTER))?.samples ?? []
}

// ---------------------------------------------------------------------------------------------
// THE ACCEPTANCE CASE, whole: one row, named Dazzle, counting down from 96 s.
// ---------------------------------------------------------------------------------------------

test('the overwritten mez RETIRES — the debuff window stops tracking Mesmerization', () => {
  const { timers, rows } = replayBuffTimers(OVERWRITE)
  assert.equal(timers.holds.length, 1, `one mob holds one mez: ${timers.holds.map((h) => h.spell ?? '?').join(', ')}`)
  assert.equal(
    rows.filter((r) => r.name.startsWith('Mesmerization')).length,
    0,
    'the bar the reporter watched squat at 0s must be gone the instant the new one lands'
  )
})

test('…and the spell that overwrote it is tracked AS ITSELF, counting down from its own 96 s', () => {
  const { rows } = replayBuffTimers(OVERWRITE)
  const cc = rows.filter((r) => r.kind === 'cc')
  assert.equal(cc.length, 1, `exactly one crowd-control row: ${cc.map((r) => r.name).join(', ')}`)
  assert.equal(cc[0].name, 'Dazzle VII', 'the RANKED name, from the only line in the family that carries one')
  assert.equal(cc[0].target, MOB)
  assert.equal(cc[0].mode, 'countdown')
  assert.equal(cc[0].durationMs, DAZZLE_DB_MS)
  assert.equal(cc[0].startedTs, AFTER_OVERWRITE, 'the clock starts at the NEW landing, not the old one')
})

test('…and there is no `Dazzle / Mesmerize` family row counting UP underneath it', () => {
  const { rows } = replayBuffTimers(OVERWRITE)
  assert.equal(
    rows.filter((r) => r.mode === 'elapsed').length,
    0,
    'a two-candidate family that agrees on no duration is exactly the phantom row of the report'
  )
  assert.equal(rows.filter((r) => r.ambiguous === true).length, 0, 'nothing on screen claims ambiguity any more')
})

test('the overwrite-shortened hold teaches the learner NOTHING — a cut cycle was never a duration', () => {
  // The whole group is contaminated before the close, so the 8-second span mints no sample: the
  // same refusal JOS-228 makes for a death, for the same reason (this fix is about DISPLAY).
  const { spellStats, buffs } = replayBuffTimers(OVERWRITE)
  assert.deepEqual(samplesOf(spellStats, 'mesmerization'), [], 'an 8 s "Mesmerization" would poison the estimator')
  assert.deepEqual(samplesOf(spellStats, 'dazzle'), [], 'and nothing was observed about Dazzle either — it is still up')
  const stat = buffs.stats['mesmerization']
  assert.ok(stat, 'the line is still KNOWN — the Buffs tab lists what the model has seen')
  assert.equal(stat.n, 0, 'with zero cycles behind it')
  assert.equal(stat.estimateMs, MEZ_DB_MS, 'so the estimate is still the committed DB floor')
})

// ---------------------------------------------------------------------------------------------
// THE NARROWING ON ITS OWN. Recency is EVIDENCE (casting is serial), not a preference between two
// spells — so the rule has to answer the mirror sequence with the other spell.
// ---------------------------------------------------------------------------------------------

test('the NEAREST cast wins, not the longest duration — the mirror sequence resolves to Mesmerization', () => {
  const mirrored = [
    '[Sat Aug 01 20:50:33 2026] You begin casting Dazzle VII.',
    `[Sat Aug 01 20:50:34 2026] ${MOB} has been mesmerized.`,
    '[Sat Aug 01 20:50:41 2026] You begin casting Mesmerization III.',
    `[Sat Aug 01 20:50:42 2026] ${MOB} has been mesmerized.`
  ]
  const { rows } = replayBuffTimers(mirrored)
  const cc = rows.filter((r) => r.kind === 'cc')
  assert.equal(cc.length, 1)
  assert.equal(cc[0].name, 'Mesmerization III', 'a 24 s mez overwriting a 96 s one is still what the log said')
  assert.equal(cc[0].durationMs, MEZ_DB_MS, 'and it draws the number the spell it named states')
})

test('a TIE stays a family — two cast lines in one second is not something recency can separate', () => {
  const tied = [
    '[Sat Aug 01 20:50:33 2026] You begin casting Mesmerization III.',
    '[Sat Aug 01 20:50:33 2026] You begin casting Dazzle VII.',
    `[Sat Aug 01 20:50:34 2026] ${MOB} has been mesmerized.`
  ]
  const { rows } = replayBuffTimers(tied)
  const cc = rows.filter((r) => r.kind === 'cc')
  assert.equal(cc.length, 1)
  assert.equal(cc[0].ambiguous, true, 'the honest do-not-know JOS-84 requires')
  assert.equal(cc[0].mode, 'elapsed', '96 s and 24 s agree on nothing, so no bar is drawn')
  assert.deepEqual(cc[0].candidates, ['Dazzle', 'Mesmerization'], 'and the row names both')
})

// ---------------------------------------------------------------------------------------------
// WHAT THE OVERWRITE MAY NOT TOUCH. The retire is keyed on the mob AND on the landing VERB, so a
// hold the game does not maintain exclusively — and every hold on another mob — is left standing.
// ---------------------------------------------------------------------------------------------

test('a mez overwrite leaves the SNARE on the same mob alone — a rooted mob can also be mezzed', () => {
  const { rows } = replayBuffTimers([
    '[Sat Aug 01 20:50:20 2026] You begin casting Ensnare.',
    `[Sat Aug 01 20:50:21 2026] ${MOB} has been ensnared.`,
    ...OVERWRITE
  ])
  const cc = rows.filter((r) => r.kind === 'cc')
  assert.deepEqual(cc.map((r) => r.name).sort(), ['Dazzle VII', 'Ensnare'], 'the root is not a mez and never was')
})

test('…and leaves the mez on the OTHER mob alone — the retire is keyed by entity, not by spell line', () => {
  const { rows } = replayBuffTimers([
    '[Sat Aug 01 20:50:33 2026] You begin casting Mesmerization III.',
    `[Sat Aug 01 20:50:34 2026] ${MOB} has been mesmerized.`,
    '[Sat Aug 01 20:50:34 2026] a scareling has been mesmerized.',
    '[Sat Aug 01 20:50:41 2026] You begin casting Dazzle VII.',
    `[Sat Aug 01 20:50:42 2026] ${MOB} has been mesmerized.`
  ])
  const scareling = rows.filter((r) => r.target === 'a scareling')
  assert.equal(scareling.length, 1, 'the other half of the AE mez is untouched')
  assert.equal(scareling[0].name, 'Mesmerization III')
  assert.equal(rows.filter((r) => r.target === MOB).map((r) => r.name).join(), 'Dazzle VII')
})

test('it closes ONE landing of a same-named round, not the whole row — a name is still just a name', () => {
  // Two mobs called `a turmoil toad` mezzed in one round, then ONE of them re-mezzed with Dazzle.
  // Nothing in the log says which, so the count chip decrements by one exactly as a death does to a
  // snare row (JOS-140 ruling 7) — deleting both would invent a fact about the mob still held.
  const { timers } = replayBuffTimers([
    '[Sat Aug 01 20:50:33 2026] You begin casting Mesmerization III.',
    `[Sat Aug 01 20:50:34 2026] ${MOB} has been mesmerized.`,
    `[Sat Aug 01 20:50:34 2026] ${MOB} has been mesmerized.`,
    '[Sat Aug 01 20:50:41 2026] You begin casting Dazzle VII.',
    `[Sat Aug 01 20:50:42 2026] ${MOB} has been mesmerized.`
  ])
  const mez = timers.holds.find((h) => h.spell === 'Mesmerization III')
  assert.ok(mez, 'one of the two mezzed toads is still held')
  assert.equal(mez.count, undefined, 'and the chip is gone, because one is not a count worth printing')
  assert.ok(timers.holds.some((h) => h.spell === 'Dazzle VII'), 'beside the toad that was re-mezzed')
})

// ---------------------------------------------------------------------------------------------
// THE ORDINARY PATH IS UNTOUCHED. The reporter's own window is solo Dazzle cycles — cast, land,
// wear off — and they must still track and still teach.
// ---------------------------------------------------------------------------------------------

test('a SOLO Dazzle cycle still tracks and still mints its own clean sample', () => {
  const solo = [
    '[Sat Aug 01 20:50:33 2026] You begin casting Dazzle VII.',
    `[Sat Aug 01 20:50:34 2026] ${MOB} has been mesmerized.`,
    `[Sat Aug 01 20:51:52 2026] Your Dazzle spell has worn off of ${MOB}.`
  ]
  const landed = tsOf(solo[1])
  const mid = replayBuffTimers(solo, { until: landed })
  const midRow = mid.rows.find((r) => r.kind === 'cc')
  assert.ok(midRow)
  assert.equal(midRow.name, 'Dazzle VII')
  assert.equal(midRow.durationMs, DAZZLE_DB_MS)

  const { timers, spellStats } = replayBuffTimers(solo)
  assert.equal(timers.holds.length, 0, 'the wear-off closes the hold')
  assert.deepEqual(
    samplesOf(spellStats, 'dazzle').map((s) => s.ms),
    [78_000],
    'and a clean cycle is exactly what the learner exists for'
  )
})
