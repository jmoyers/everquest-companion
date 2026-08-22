// SESSION MARKS IN THE ENGINE (JOS-322) — the split, and the proof it is reversible.
//
// The owner's ruling: *split in engine. we should have the capability to merge it back/undo split,
// but not put that in the app, just build it into the api and design philosophy. new session should
// split everything at once.* So a mark closes the running zone stay and opens a fresh one — the
// move a zone line makes, minus the room change — and the boundary it leaves must be a boundary the
// engine can REMOVE.
//
// THE CENTREPIECE IS W1: mark BETWEEN pulls, `unsplit()`, and deep-equal the whole live aggregate
// against a replay of the identical lines that was never marked. Every map, every counter, window
// by window. That is the assertion the ruling's "no derived value baked in at split time" reduces
// to, and it is why the merge is a test rather than a promise.
//
// W2 is the honest other half: a mark MID-PULL cuts an encounter in two, and merge-back
// reconstructs the RECORDS rather than the counterfactual never-split run. Σ-equality holds on
// every accumulator class; what differs is enumerated there and only there.
//
// The lines below are shaped exactly like the real log (verb conjugation, `for N points of damage`,
// the paren annotations, the slain line, `You have entered X.`).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { CombatEngine } from '../src/main/combat/engine'
import { mergeZoneSessions } from '../src/main/combat/mergeSessions'
import { ZONE_HISTORY_CAP, type ZoneSession } from '../src/main/combat/encounter'
import { MAX_SESSION_MARKS } from '../src/shared/sessionSegments'
import type { EngineState } from '../src/main/combat/state'
import type { Agg } from '../src/main/combat/aggregate'

/**
 * The engine's own state. `private` is a COMPILE-TIME fence and this reaches through it on purpose:
 * the merge-back obligation is about the RECORD — every map and every counter — and the serialized
 * `SegmentView` is a lossy projection of it (rates re-derived, lanes capped, rings dropped). A test
 * that compared views could pass while two accumulators quietly disagreed.
 */
function stateOf(eng: CombatEngine): EngineState {
  return (eng as unknown as { st: EngineState }).st
}

function fresh(): CombatEngine {
  const eng = new CombatEngine()
  // LIVE from the start: a mark is refused while hydrating (that refusal is W5), so every arm that
  // is supposed to be able to split has to be past the historical fold.
  eng.setLive()
  eng.setPlayerName('Primitive')
  return eng
}

function feed(eng: CombatEngine, lines: readonly string[]): void {
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) eng.ingestEvent(ev, false)
  }
}

/** The epoch-ms instant a log line carries — used to place a mark BETWEEN two lines without
 *  hand-computing an EQ timestamp. The line itself is never ingested. */
function tsOf(line: string): number {
  const ev = parseEvent(line, 0)
  assert.ok(ev, `parsed: ${line}`)
  return ev.ts
}

const ZONE = '[Sat Aug 15 20:00:00 2026] You have entered South Ro.'

/**
 * TWO PULLS, ONE ROOM, 45 seconds apart — and deliberately in two different wall-clock MINUTES, so
 * the minute-window ledger is exercised with DISTINCT keys here and with a SHARED one in W2.
 *
 * Everything the aggregate can hold is represented: landed melee (with a `(Critical)` and a
 * `(Riposte)` so the modifier tallies and the round exclusions both move), avoided swings, a spell
 * lane, a resist, incoming damage, a heal on you, a rune grant, and the slain line that retires the
 * mob so the pull closes on the death timeline rather than on a timeout.
 */
const PULL_ONE: string[] = [
  '[Sat Aug 15 20:00:10 2026] You slash a sand giant for 83 points of damage. (Critical)',
  '[Sat Aug 15 20:00:11 2026] You try to slash a sand giant, but miss!',
  '[Sat Aug 15 20:00:12 2026] You kick a sand giant for 41 points of damage.',
  '[Sat Aug 15 20:00:13 2026] a sand giant hits YOU for 55 points of damage.',
  '[Sat Aug 15 20:00:14 2026] You gain a rune for 22 points of absorption.',
  '[Sat Aug 15 20:00:15 2026] You hit a sand giant for 243 points of magic damage by Condemnation of Nife.',
  '[Sat Aug 15 20:00:16 2026] A sand giant resisted your Mesmerization III!',
  '[Sat Aug 15 20:00:17 2026] You healed Primitive for 120 hit points by Healing Light.',
  '[Sat Aug 15 20:00:18 2026] You slash a sand giant for 12 points of damage. (Riposte)',
  '[Sat Aug 15 20:00:20 2026] You have slain a sand giant!'
]

const PULL_TWO: string[] = [
  '[Sat Aug 15 20:01:05 2026] You slash a sand elemental for 77 points of damage.',
  '[Sat Aug 15 20:01:06 2026] You try to kick a sand elemental, but miss!',
  '[Sat Aug 15 20:01:07 2026] You kick a sand elemental for 39 points of damage. (Critical)',
  '[Sat Aug 15 20:01:08 2026] a sand elemental hits YOU for 61 points of damage.',
  '[Sat Aug 15 20:01:09 2026] You hit a sand elemental for 210 points of magic damage by Condemnation of Nife.',
  '[Sat Aug 15 20:01:10 2026] You healed Primitive for 90 hit points by Healing Light.',
  '[Sat Aug 15 20:01:12 2026] You have slain a sand elemental!'
]

/** Between the pulls: no damage is attributed anywhere near it, which is the actual instance-reset
 *  gesture the report asked for ("pop a new session when i reset the instance"). */
const MARK_BETWEEN = tsOf('[Sat Aug 15 20:00:40 2026] You have entered South Ro.')

// ── W1: the glue-back centrepiece ────────────────────────────────────────────────────────

test('W1: a mark between pulls, unsplit, is DEEP-EQUAL to a replay that was never marked', () => {
  const control = fresh()
  feed(control, [ZONE, ...PULL_ONE, ...PULL_TWO])

  const split = fresh()
  feed(split, [ZONE, ...PULL_ONE])
  assert.equal(split.sessionMark(MARK_BETWEEN), true, 'a live engine accepts the mark')
  feed(split, PULL_TWO)

  // The split really happened: the closed stay is frozen and browsable, and the live one restarted.
  const mid = stateOf(split)
  assert.equal(mid.zoneHistory.length, 1, 'the mark minted one finalized stay')
  assert.equal(mid.zoneHistory[0].closedBy, 'mark', '…tagged as the user having closed it')
  assert.equal(mid.zoneHistory[0].zone, 'South Ro', '…in the room you never left')

  assert.equal(split.unsplit(), true, 'the boundary is removable')
  assert.equal(stateOf(split).zoneHistory.length, 0, '…and the record it minted is gone with it')

  const a = stateOf(control)
  const b = stateOf(split)
  assert.deepEqual(b.zoneAgg, a.zoneAgg, 'every map and every counter of the aggregate')
  assert.equal(b.zoneFinalizedMs, a.zoneFinalizedMs, 'the DPS denominator')
  assert.equal(b.zoneActiveMs, a.zoneActiveMs, 'the active-time denominator')
  assert.equal(b.zoneStartTs, a.zoneStartTs, 'the stay started where the earlier half did')
  assert.equal(b.zoneLastTs, a.zoneLastTs, 'and ends where the later half does')
  assert.equal(b.zoneSeq, a.zoneSeq, 'the id counter left no hole behind')
})

test('W1b: the merged stay serializes to the same numbers the unsplit one does', () => {
  const control = fresh()
  feed(control, [ZONE, ...PULL_ONE, ...PULL_TWO])
  const split = fresh()
  feed(split, [ZONE, ...PULL_ONE])
  split.sessionMark(MARK_BETWEEN)
  feed(split, PULL_TWO)
  split.unsplit()

  const now = tsOf('[Sat Aug 15 20:01:20 2026] You have entered South Ro.')
  const a = control.snapshot(now, { selectedId: 'zone' }).selected
  const b = split.snapshot(now, { selectedId: 'zone' }).selected
  assert.ok(a && b)
  assert.deepEqual(b, a, 'the whole SegmentView, bars and lanes and healing and procs alike')
})

// ── W2: the mid-pull case, and the edges it is honest about ──────────────────────────────

/** ONE pull, six seconds long. The mark lands BETWEEN two seconds of it — the case the design
 *  promises Σ-equality for rather than byte-identity. */
const ONE_PULL: string[] = [
  '[Sat Aug 15 21:00:10 2026] You slash a dune tarantula for 40 points of damage.',
  '[Sat Aug 15 21:00:11 2026] You kick a dune tarantula for 30 points of damage.',
  '[Sat Aug 15 21:00:12 2026] You slash a dune tarantula for 20 points of damage.',
  // ── the mark falls here ──
  '[Sat Aug 15 21:00:13 2026] You slash a dune tarantula for 10 points of damage.',
  '[Sat Aug 15 21:00:14 2026] You hit a dune tarantula for 100 points of magic damage by Condemnation of Nife.',
  '[Sat Aug 15 21:00:15 2026] You have slain a dune tarantula!'
]
const MID_PULL_AT = tsOf('[Sat Aug 15 21:00:12 2026] You have entered South Ro.') + 500
/** Past the death linger, so BOTH arms have finalized what they had open. `finalizedMs` only
 *  accrues at finalize, so a comparison of denominators has to close the fights first — and the
 *  shipped way to close one on elapsed time is a snapshot, exactly as the UI's poll does it. */
const MID_PULL_CLOSE = tsOf('[Sat Aug 15 21:00:30 2026] You have entered South Ro.')

/** The two arms of the mid-pull comparison, both closed and the split one glued back. */
function midPullArms(): { control: CombatEngine; split: CombatEngine } {
  const control = fresh()
  feed(control, [ZONE, ...ONE_PULL])
  control.snapshot(MID_PULL_CLOSE, {})

  const split = fresh()
  feed(split, [ZONE, ...ONE_PULL.slice(0, 3)])
  assert.equal(split.sessionMark(MID_PULL_AT), true)
  feed(split, ONE_PULL.slice(3))
  split.snapshot(MID_PULL_CLOSE, {})
  assert.equal(split.unsplit(), true)
  return { control, split }
}

function outTotal(agg: Agg): number {
  let t = 0
  for (const s of agg.out.values()) t += s.total
  return t
}

function youRow(agg: Agg): { total: number; hits: number; crits: number; misses: number } {
  const s = agg.out.get('you')
  assert.ok(s, 'the You row exists')
  return { total: s.total, hits: s.hits, crits: s.crits, misses: s.misses }
}

/** One minute window, with the active-time field lifted out — the one field the straddling gap
 *  reaches, asserted on its own below rather than folded into a wholesale comparison. */
function windowShape(w: { minute: number; swings: number; outDamage: number; procDamage: number }): {
  minute: number
  swings: number
  outDamage: number
  procDamage: number
} {
  return { minute: w.minute, swings: w.swings, outDamage: w.outDamage, procDamage: w.procDamage }
}

test('W2: a mark MID-PULL still re-adds exactly — every damage counter survives the seam', () => {
  const { control, split } = midPullArms()
  const a = stateOf(control)
  const b = stateOf(split)
  assert.equal(outTotal(b.zoneAgg), outTotal(a.zoneAgg), 'Σ outgoing damage is untouched by the cut')
  assert.deepEqual(youRow(b.zoneAgg), youRow(a.zoneAgg), 'hits, crits and misses all re-add')
  assert.deepEqual(
    b.zoneAgg.out.get('you')?.bySkill,
    a.zoneAgg.out.get('you')?.bySkill,
    'and so does every per-lane breakdown, minimum and maximum included'
  )
  // The minute ledger is keyed on ABSOLUTE time, so both halves of the cut minute carry the SAME
  // key and sum straight back into the one window the unsplit fold held. Its `activeMs` is the
  // engine's own per-hit delta and therefore carries edge 2 below, and nothing else does.
  assert.deepEqual(
    b.zoneAgg.windows.list().map(windowShape),
    a.zoneAgg.windows.list().map(windowShape),
    'window by window'
  )
})

test('W2b: the mid-pull EDGES are exactly the two the design enumerates, and no others', () => {
  const { control, split } = midPullArms()
  const a = stateOf(control)
  const b = stateOf(split)
  // EDGE 1 — the two fights stay two fights. A merge reconstructs the STAY, never the pull.
  assert.equal(a.history.length, 1, 'unsplit: one encounter')
  assert.equal(b.history.length, 2, 'split: the pull was cut in two, and stays cut')
  // EDGE 2 — the inter-hit gap straddling the mark is absent from both denominators, by exactly
  // the one second it spans. Bounded: the closure windows ONCE per mark.
  const straddle = 1000
  assert.equal(a.zoneFinalizedMs - b.zoneFinalizedMs, straddle, 'the wall denominator is short by the straddling gap')
  assert.equal(a.zoneActiveMs - b.zoneActiveMs, straddle, 'and the active one by the same gap')
  // …and the minute ledger's own active-time column is the SAME gap seen from the other end — one
  // edge, reported twice, never two independent drifts.
  const activeOf = (agg: Agg): number => agg.windows.list().reduce((t, w) => t + w.activeMs, 0)
  assert.equal(activeOf(a.zoneAgg) - activeOf(b.zoneAgg), straddle, 'and the window ledger agrees')
})

/**
 * THE BOUNDARY-SECOND ROUND GROUPING, the third enumerated edge — and the one that only fires when
 * the mark lands INSIDE a second that carries two swings.
 *
 * A round is "the swings one attacker made with one verb at one target in one second" (rounds.ts).
 * Split between the two halves of such a second, the merged accumulator reports two 1-swing rounds
 * where the never-marked fold reports one 2-swing round. Asserted rather than hidden: an edge a
 * test does not name is an edge somebody rediscovers as a bug.
 */
test('W2c: a mark inside a multi-swing SECOND splits that round, and says so', () => {
  const lines = [
    '[Sat Aug 15 22:00:10 2026] You slash a dune tarantula for 40 points of damage.',
    '[Sat Aug 15 22:00:10 2026] You slash a dune tarantula for 35 points of damage.',
    '[Sat Aug 15 22:00:12 2026] You slash a dune tarantula for 30 points of damage.'
  ]
  const control = fresh()
  feed(control, [ZONE, ...lines])
  const split = fresh()
  feed(split, [ZONE, lines[0]])
  split.sessionMark(tsOf(lines[0]) + 500)
  feed(split, lines.slice(1))
  split.unsplit()

  const lanesOf = (eng: CombatEngine): { rounds: number; multi: number } => {
    const src = stateOf(eng).zoneAgg.out.get('you')
    assert.ok(src)
    const slash = src.roundAcc.snapshot().find((l) => l.verb === 'slash')
    assert.ok(slash)
    return { rounds: slash.rounds, multi: slash.multiRounds }
  }
  assert.deepEqual(lanesOf(control), { rounds: 2, multi: 1 }, 'unsplit: one double-swing round, one single')
  assert.deepEqual(lanesOf(split), { rounds: 3, multi: 0 }, 'split mid-second: the round is two singles')
  // …and the damage is untouched either way, which is the point of enumerating the edge at all.
  assert.equal(
    outTotal(stateOf(split).zoneAgg),
    outTotal(stateOf(control).zoneAgg),
    'not one point of damage moved'
  )
})

// ── W3: the refusals ─────────────────────────────────────────────────────────────────────

test('W3a: an EMPTY stay mints nothing, so a double click is harmless', () => {
  const eng = fresh()
  feed(eng, [ZONE])
  assert.equal(eng.sessionMark(MARK_BETWEEN), true, 'the mark is accepted')
  assert.equal(stateOf(eng).zoneHistory.length, 0, 'but a stay with no damage in it is not a record')

  feed(eng, PULL_ONE)
  eng.sessionMark(MARK_BETWEEN + 1)
  eng.sessionMark(MARK_BETWEEN + 2)
  assert.equal(stateOf(eng).zoneHistory.length, 1, 'the second click had nothing left to close')
})

test('W3b: a mark is REFUSED while the historical fold is still running', () => {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  feed(eng, [ZONE, ...PULL_ONE])
  assert.equal(eng.sessionMark(MARK_BETWEEN), false, 'a replaying engine cannot be marked')
  assert.equal(stateOf(eng).zoneHistory.length, 0, 'and nothing was minted behind the refusal')
})

test('W3c: unsplit refuses a ZONE-LINE boundary and a cross-zone pair', () => {
  const eng = fresh()
  feed(eng, [ZONE, ...PULL_ONE, '[Sat Aug 15 20:00:30 2026] You have entered Oasis of Marr.'])
  assert.equal(stateOf(eng).zoneHistory.length, 1, 'zoning froze the stay')
  assert.equal(stateOf(eng).zoneHistory[0].closedBy, 'zone')
  assert.equal(eng.unsplit(), false, 'a room you walked out of is not a boundary the engine may remove')
  assert.equal(stateOf(eng).zoneHistory.length, 1, 'and the refusal changed nothing')
})

test('W3d: unsplit refuses when the live stay is in a DIFFERENT room from the marked one', () => {
  const eng = fresh()
  feed(eng, [ZONE, ...PULL_ONE])
  eng.sessionMark(MARK_BETWEEN)
  feed(eng, ['[Sat Aug 15 20:00:45 2026] You have entered Oasis of Marr.', ...PULL_TWO])
  assert.equal(eng.unsplit(), false, 'the mark-closed stay names another zone now')
})

test('W3e: with no mark at all there is nothing to unsplit', () => {
  const eng = fresh()
  feed(eng, [ZONE, ...PULL_ONE, ...PULL_TWO])
  assert.equal(eng.unsplit(), false)
})

test('W3f: the pure merge refuses an ineligible pair from the records alone', () => {
  const eng = fresh()
  feed(eng, [ZONE, ...PULL_ONE])
  eng.sessionMark(MARK_BETWEEN)
  feed(eng, PULL_TWO)
  eng.sessionMark(MARK_BETWEEN + 60_000)
  const hist: ZoneSession[] = stateOf(eng).zoneHistory
  assert.equal(hist.length, 2, 'two mark-closed stays')

  const merged = mergeZoneSessions(hist[0], hist[1])
  assert.ok(merged, 'two mark-closed stays in one room merge')
  assert.equal(merged.id, hist[0].id, 'the joined stay keeps the earlier identity')
  assert.equal(merged.summary.total, hist[0].summary.total + hist[1].summary.total, 'and the totals re-add')

  const foreign: ZoneSession = { ...hist[1], zone: 'Oasis of Marr' }
  assert.equal(mergeZoneSessions(hist[0], foreign), null, 'two rooms never merge')
  const walked: ZoneSession = { ...hist[0], closedBy: 'zone' }
  assert.equal(mergeZoneSessions(walked, hist[1]), null, 'a zone line is never a removable boundary')
})

// ── W4: replay determinism, and the inertness gate ───────────────────────────────────────

test('W4: a restart replays the log to the UNMARKED records — a mark is stored nowhere', () => {
  const marked = fresh()
  feed(marked, [ZONE, ...PULL_ONE])
  marked.sessionMark(MARK_BETWEEN)
  feed(marked, PULL_TWO)
  assert.equal(stateOf(marked).zoneHistory.length, 1, 'the live session carries the split')

  // The restart: a brand-new engine folding the identical bytes, hydrating throughout — which is
  // the only state a relaunch has, and the state in which a mark cannot be taken at all.
  const restarted = new CombatEngine()
  restarted.setPlayerName('Primitive')
  feed(restarted, [ZONE, ...PULL_ONE, ...PULL_TWO])
  const control = fresh()
  feed(control, [ZONE, ...PULL_ONE, ...PULL_TWO])

  assert.equal(stateOf(restarted).zoneHistory.length, 0, 'no split survived the relaunch')
  assert.deepEqual(stateOf(restarted).zoneAgg, stateOf(control).zoneAgg, 'one uninterrupted stay, as the log says')
})

test('W5: the two new entry points are INERT until somebody presses the button', () => {
  const now = tsOf('[Sat Aug 15 20:01:20 2026] You have entered South Ro.')
  const eng = fresh()
  feed(eng, [ZONE, ...PULL_ONE, ...PULL_TWO])
  const before = eng.snapshot(now, { selectedId: 'zone' })
  assert.equal(eng.unsplit(), false, 'an unmarked engine has no boundary to remove')
  const after = eng.snapshot(now, { selectedId: 'zone' })
  assert.deepEqual(after, before, 'and the refusal moved nothing in the snapshot')
})

// ── W6: the ring, and the cap the owner raised to match the marks ────────────────────────

test('W6: the zone-session ring reaches exactly as far as the session marks do', () => {
  assert.equal(
    ZONE_HISTORY_CAP,
    MAX_SESSION_MARKS,
    'one click mints a mark AND a zone session; two rings at two depths would let the loot picker ' +
      'offer a session the meter had already dropped'
  )
})

test('W6b: a mark-closed stay is called a SESSION, and a zone-closed one an OVERALL', () => {
  const now = tsOf('[Sat Aug 15 20:01:20 2026] You have entered South Ro.')
  const eng = fresh()
  feed(eng, [ZONE, ...PULL_ONE])
  eng.sessionMark(MARK_BETWEEN)
  feed(eng, PULL_TWO)
  feed(eng, ['[Sat Aug 15 20:01:30 2026] You have entered Oasis of Marr.'])

  const snap = eng.snapshot(now, {})
  const finalized = snap.zoneSessions.filter((z) => !z.live)
  assert.equal(finalized.length, 2, 'one closed by the mark, one by the zone line')
  assert.deepEqual(
    finalized.map((z) => z.closedBy).sort(),
    ['mark', 'zone'],
    'and the record says which is which'
  )
  const marked = finalized.find((z) => z.closedBy === 'mark')
  assert.ok(marked)
  const view = eng.snapshot(now, { selectedId: marked.id }).selected
  assert.ok(view)
  assert.match(view.name, / - session$/, 'the meter speaks loot and leveling’s word for the same click')
})
