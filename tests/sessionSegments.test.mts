// PURE UNIT TESTS for the DETAILS!-STYLE SESSION SPLIT (src/shared/sessionSegments.ts, JOS-436).
//
// The ticket: *really it would be ideal to just say "start a new session" from now so i can pop a
// new session when i reset the instance.* The owner ruled the model — keep the old reference, split
// forward from the click — and the research that shaped it is in the file's own header.
//
// No log, no fixture, no DOM, no clock: the mark is an ARGUMENT here exactly as it is in the
// module, so this file never skips and never drifts with the wall clock. It pins the four things a
// "reset" affordance can quietly get wrong:
//
//   1. THE SPLIT TILES THE RECORD. n marks make n+1 half-open segments, adjacent, no gap and no
//      overlap, exactly one of them still running. A reset that left a seam would double-count the
//      drop that fell in it; one that overlapped would count it twice.
//
//   2. BROWSING IS A PICK, NOT A MUTATION (Details! rule 4). An old segment has both its ends and
//      cannot move again — which is the whole meaning of "the old session's totals are frozen" —
//      while the current one keeps reaching the live edge on every read.
//
//   3. THE DENOMINATORS PARTITION TOO (JOS-261 lineage, and the reason this test exists at all).
//      Σ over the segments must equal the unsplit range for duration, active, idle AND offline. The
//      hard case is a silence that STRADDLES a mark: split naively, a 21-minute AFK becomes two
//      ~10-minute gaps, each UNDER `IDLE_GAP_MS`, and both sides invent active time that nobody
//      played. `progressionStats.idleSpans` already prevents that by pulling the BRACKETING samples
//      into its walk unconditionally — this file is what holds it to that across a mark.
//
//   4. AN OPEN END IS RESOLVED, NEVER STORED. `+Infinity` clamps to the live edge every read, so a
//      segment opened "from now" grows with the log; and a mark taken from the wall clock, which
//      can legitimately sit PAST the newest log line, yields an EMPTY range rather than an inverted
//      one — the honest "nothing has happened in the new session yet".
//
// Imported RELATIVELY: node tests run through tsx with no `@shared` alias.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { rangeStats, IDLE_GAP_MS } from '../src/shared/progressionStats'
import { inSlice, resolveSlice, TAIL_MS } from '../src/shared/timeslice'
import type { LootEvent } from '../src/shared/types'
import type { ProgressionSnap } from '../src/shared/progressionTypes'
import {
  MAX_SESSION_MARKS,
  OPEN_END,
  RECORD_START,
  addSessionMark,
  currentSegment,
  segmentAt,
  sessionSegments
} from '../src/shared/sessionSegments'

const MIN = 60_000
const HOUR = 60 * MIN
/** An arbitrary, readable anchor — nothing here depends on the wall clock. */
const T0 = Date.parse('Sat Aug 01 12:00:00 2026')

function emptySnap(): ProgressionSnap {
  return {
    expTs: [], expPct: [], expFlag: [],
    killTs: [], killZone: [], killCredit: [],
    witnessTs: [], recentKills: [], lootTs: [],
    zoneStart: [], zoneEnd: [], zoneName: [],
    offlineStart: [], offlineEnd: [], offlineCamped: [],
    levelTs: [], levelValue: [], aaGainTs: [], aaGainAmount: [],
    lastTs: 0, windowStart: 0, dropped: 0
  }
}

function addZone(snap: ProgressionSnap, ts: number, name: string): void {
  const n = snap.zoneStart.length
  if (n > 0) snap.zoneEnd[n - 1] = ts
  snap.zoneStart.push(ts)
  snap.zoneEnd.push(0)
  snap.zoneName.push(name)
  snap.lastTs = Math.max(snap.lastTs, ts)
}

function addPull(snap: ProgressionSnap, ts: number, pct: number): void {
  snap.expTs.push(ts)
  snap.expPct.push(pct)
  snap.expFlag.push(0)
  snap.killTs.push(ts)
  snap.killZone.push(snap.zoneStart.length - 1)
  snap.killCredit.push(0)
  snap.lastTs = Math.max(snap.lastTs, ts)
}

function addOffline(snap: ProgressionSnap, start: number, end: number): void {
  snap.offlineStart.push(start)
  snap.offlineEnd.push(end)
  snap.offlineCamped.push(1)
  snap.lastTs = Math.max(snap.lastTs, end)
}

/**
 * THE INSTANCE-RESET EVENING, shaped so that every seam this ticket can break sits ON a mark.
 *
 * An hour of pulls; an EIGHT-minute silence (the reset itself — zoning out, re-forming, zoning in);
 * a fresh instance to +140; a 40-minute camp; and a last half hour. That gives one IDLE span and
 * one OFFLINE span, and the marks below sit in the MIDDLE of each.
 *
 * THE EIGHT MINUTES ARE CHOSEN, not incidental. The gap has to be LONGER than `IDLE_GAP_MS` (5
 * minutes) so the record counts it as silence, and each HALF of it has to be SHORTER — otherwise
 * both sides of the split would qualify on their own and the test would pass under an
 * implementation that measured each segment in isolation, which is exactly the defect it exists to
 * catch. 8 minutes cut at 4 is the smallest arrangement that separates the two.
 */
function resetEvening(): { snap: ProgressionSnap; lo: number; hi: number; idleMark: number; offlineMark: number } {
  const snap = emptySnap()
  addZone(snap, T0, 'Najena 4 (Refined)')
  for (let m = 0; m < 60; m++) addPull(snap, T0 + m * MIN, 1)
  // …the last pull is at +59m and the next at +67m.
  addZone(snap, T0 + 67 * MIN, 'Najena 7 (Awakened)')
  for (let m = 67; m < 141; m++) addPull(snap, T0 + m * MIN, 2)
  addOffline(snap, T0 + 141 * MIN, T0 + 181 * MIN)
  for (let m = 181; m < 211; m++) addPull(snap, T0 + m * MIN, 2)
  return {
    snap,
    lo: T0,
    hi: snap.lastTs,
    idleMark: T0 + 63 * MIN,
    offlineMark: T0 + 161 * MIN
  }
}

// ── 1. the split tiles the record ─────────────────────────────────────────────────────

test('n marks make n+1 segments, adjacent and half-open, with exactly one still running', () => {
  const segs = sessionSegments([T0 + HOUR, T0 + 2 * HOUR])
  assert.equal(segs.length, 3, 'two resets cut the evening into three stretches')
  assert.deepEqual(segs.map((s) => s.n), [1, 2, 3], 'ordinals are 1-based and in walk order')

  assert.equal(segs[0].range.t0, RECORD_START, 'the first reaches back to wherever the record starts')
  assert.equal(segs[0].range.t1, T0 + HOUR, '…and ends AT the mark, exclusive')
  assert.deepEqual(segs[1].range, { t0: T0 + HOUR, t1: T0 + 2 * HOUR }, 'the middle is mark to mark')
  assert.equal(segs[2].range.t1, OPEN_END, 'the newest has no end yet')

  for (let i = 1; i < segs.length; i++) {
    assert.equal(segs[i].range.t0, segs[i - 1].range.t1, `segment ${String(i)} starts where ${String(i - 1)} ended`)
  }
  assert.deepEqual(segs.map((s) => s.current), [false, false, true], 'exactly one is current, and it is the last')
  assert.equal(currentSegment([T0 + HOUR, T0 + 2 * HOUR]).n, 3)
})

test('no marks at all is ONE segment — the whole record, still running', () => {
  const segs = sessionSegments([])
  assert.equal(segs.length, 1)
  assert.deepEqual(segs[0].range, { t0: RECORD_START, t1: OPEN_END }, 'which is `All`, spelled as a segment')
  assert.equal(segs[0].current, true)
})

test('a segment says its own number, in a label and in a sentence', () => {
  const segs = sessionSegments([T0 + HOUR])
  assert.equal(segs[0].label, 'Session 1')
  assert.equal(segs[0].caption, 'session 1')
  assert.equal(segs[1].label, 'Session 2 (now)', 'the running one says so where you pick it')
  assert.equal(segs[1].caption, 'session 2', '…and not inside a sentence, where the ends are stated anyway')
  assert.equal(segmentAt([T0 + HOUR], 2)?.n, 2)
  assert.equal(segmentAt([T0 + HOUR], 9), null, 'a pick the marks cannot offer is null, never a read past the end')
})

test('marks stay ascending, deduped and bounded', () => {
  assert.deepEqual(addSessionMark([], T0), [T0])
  assert.deepEqual(addSessionMark([T0], T0), [T0], 'a second press in the same millisecond opens nothing')
  assert.deepEqual(addSessionMark([T0 + HOUR], T0), [T0 + HOUR], 'and neither does one that moves backwards')
  assert.deepEqual(addSessionMark([T0], T0 + MIN), [T0, T0 + MIN])
  assert.deepEqual(addSessionMark([T0], Number.NaN), [T0], 'an unreadable instant is not a mark')

  let many: number[] = []
  for (let i = 0; i < MAX_SESSION_MARKS + 5; i++) many = addSessionMark(many, T0 + i * MIN)
  assert.equal(many.length, MAX_SESSION_MARKS, 'the history is bounded, like Details!’s own')
  assert.equal(many[many.length - 1], T0 + (MAX_SESSION_MARKS + 4) * MIN, 'and it is the OLDEST that falls off')
})

// ── 2 + 4. what a segment resolves to ─────────────────────────────────────────────────

test('the current segment reaches the LIVE EDGE and follows it as the log grows', () => {
  const { snap, lo, hi, idleMark } = resetEvening()
  const seg = currentSegment([idleMark])
  const at = (edge: number): { t0: number; t1: number } =>
    resolveSlice({ snap, bounds: { lo, hi: edge }, id: 'custom', custom: seg.range }).range

  assert.deepEqual(at(hi), { t0: idleMark, t1: hi + TAIL_MS }, 'from the mark to the newest event, tail and all')
  assert.deepEqual(
    at(hi + HOUR),
    { t0: idleMark, t1: hi + HOUR + TAIL_MS },
    'an hour later it covers that hour too — nothing was retyped'
  )
})

test('a closed segment cannot move again — its totals are frozen in the only sense that matters', () => {
  const { snap, lo, hi, idleMark } = resetEvening()
  const closed = sessionSegments([idleMark])[0]
  const early = resolveSlice({ snap, bounds: { lo, hi }, id: 'custom', custom: closed.range })
  const later = resolveSlice({ snap, bounds: { lo, hi: hi + HOUR }, id: 'custom', custom: closed.range })
  assert.deepEqual(early.range, later.range, 'the record grew under it and the old session did not')
  assert.deepEqual(
    rangeStats({ snap, range: early.range }),
    rangeStats({ snap, range: later.range }),
    'so every number it states is the same number'
  )
})

test('a mark PAST the newest log line is an empty range, never an inverted one', () => {
  const { snap, lo, hi } = resetEvening()
  // The click is the user's "now"; the log's newest line can be minutes old (they were zoning).
  const seg = currentSegment([hi + 10 * MIN])
  const slice = resolveSlice({ snap, bounds: { lo, hi }, id: 'custom', custom: seg.range })
  assert.equal(slice.range.t0, slice.range.t1, 'nothing has happened in the new session yet, and it says so')
  assert.equal(rangeStats({ snap, range: slice.range }).durationMs, 0, 'and no denominator is fabricated for it')
  // …and it heals itself the moment the log catches up, with no second click.
  const grown = resolveSlice({ snap, bounds: { lo, hi: hi + 20 * MIN }, id: 'custom', custom: seg.range })
  assert.equal(grown.range.t0, hi + 10 * MIN, 'the mark is the start again as soon as the record reaches it')
  assert.ok(grown.range.t1 > grown.range.t0)
})

test('a segment names the slice it resolves to, and a hand-typed pair still does not', () => {
  const { snap, lo, hi, idleMark } = resetEvening()
  const bounds = { lo, hi }
  const seg = sessionSegments([idleMark])[0]
  const named = resolveSlice({ snap, bounds, id: 'custom', custom: seg.range, customCaption: seg.caption })
  assert.equal(named.caption, 'session 1', 'the ledger can say "no loot in session 1"')
  const typed = resolveSlice({ snap, bounds, id: 'custom', custom: { t0: lo, t1: lo + HOUR } })
  assert.equal(typed.caption, 'the custom range', 'and an unnamed pair keeps the wording it always had')
  // A caption may never rename a PRESET: those word themselves, and two definitions is one too many.
  assert.equal(resolveSlice({ snap, bounds, id: 'all', customCaption: 'session 1' }).caption, 'the whole log')
})

// ── 3. THE DENOMINATORS PARTITION ACROSS THE SPLIT ────────────────────────────────────

/** The four spans every rate on this app divides by, summed over a list of ranges. */
function spansOver(snap: ProgressionSnap, ranges: readonly { t0: number; t1: number }[]): Record<string, number> {
  const parts = ranges.map((range) => rangeStats({ snap, range }))
  const sum = (pick: (s: (typeof parts)[number]) => number): number => parts.reduce((n, p) => n + pick(p), 0)
  return {
    durationMs: sum((p) => p.durationMs),
    activeMs: sum((p) => p.activeMs),
    idleMs: sum((p) => p.idleMs),
    offlineMs: sum((p) => p.offlineMs),
    kills: sum((p) => p.kills)
  }
}

test('Σ over the segments is the unsplit range — even when the mark lands INSIDE a silence', () => {
  const { snap, lo, hi, idleMark } = resetEvening()
  const bounds = { lo, hi }
  const whole = rangeStats({ snap, range: { t0: lo, t1: hi + TAIL_MS } })
  // Sanity: the split really does cut a qualifying silence in half, which is the case that breaks a
  // naive implementation. Both halves are ~10 minutes — each UNDER the idle threshold on its own.
  assert.ok(whole.idleMs > IDLE_GAP_MS, 'the evening contains a real silence to straddle')

  const ranges = sessionSegments([idleMark]).map(
    (s) => resolveSlice({ snap, bounds, id: 'custom', custom: s.range }).range
  )
  assert.equal(ranges.length, 2)
  assert.ok(ranges[0].t1 - ranges[0].t0 > 0 && ranges[1].t1 - ranges[1].t0 > 0, 'both halves hold real play')

  // THE LOAD-BEARING HALF, stated out loud: the old session's whole share of the silence is FOUR
  // minutes — under the threshold, so a walk that began at the mark would see no qualifying gap at
  // all and hand those minutes to `activeMs` as play. It is counted only because the gap was
  // measured at its true length and then clipped.
  const halves = ranges.map((range) => rangeStats({ snap, range }))
  assert.ok(halves[0].idleMs > 0 && halves[1].idleMs > 0, 'the silence is on both sides of the reset')
  assert.ok(halves[0].idleMs < IDLE_GAP_MS, '…and the old session’s piece of it would not qualify alone')

  const split = spansOver(snap, ranges)
  assert.equal(split.durationMs, whole.durationMs, 'every millisecond of the record is in exactly one session')
  assert.equal(
    split.idleMs,
    whole.idleMs,
    'the straddling silence is measured at its TRUE length and clipped to each side'
  )
  assert.equal(
    split.activeMs,
    whole.activeMs,
    'so neither side invents active time — the JOS-261 denominator survives the split'
  )
  assert.equal(split.offlineMs, whole.offlineMs)
  assert.equal(split.kills, whole.kills, 'and every credited kill belongs to one session')
})

test('…and when it lands inside a LOGOUT, which is the other kind of hole', () => {
  const { snap, lo, hi, offlineMark } = resetEvening()
  const bounds = { lo, hi }
  const whole = rangeStats({ snap, range: { t0: lo, t1: hi + TAIL_MS } })
  assert.ok(whole.offlineMs > 0, 'the evening contains a stated logout to straddle')

  const ranges = sessionSegments([offlineMark]).map(
    (s) => resolveSlice({ snap, bounds, id: 'custom', custom: s.range }).range
  )
  const split = spansOver(snap, ranges)
  assert.equal(split.offlineMs, whole.offlineMs, 'the absence is split, not doubled and not dropped')
  assert.equal(split.activeMs, whole.activeMs, 'and the elapsed hour (duration − offline) partitions with it')
  assert.equal(split.durationMs, whole.durationMs)
})

test('three sessions partition just as two do — the identity is in the tiling, not in the count', () => {
  const { snap, lo, hi, idleMark, offlineMark } = resetEvening()
  const bounds = { lo, hi }
  const whole = rangeStats({ snap, range: { t0: lo, t1: hi + TAIL_MS } })
  const ranges = sessionSegments([idleMark, offlineMark]).map(
    (s) => resolveSlice({ snap, bounds, id: 'custom', custom: s.range }).range
  )
  assert.equal(ranges.length, 3)
  const split = spansOver(snap, ranges)
  for (const key of ['durationMs', 'activeMs', 'idleMs', 'offlineMs', 'kills'] as const) {
    assert.equal(split[key], (whole as unknown as Record<string, number>)[key], key)
  }
  // …and each identity still holds INSIDE every segment.
  for (const range of ranges) {
    const s = rangeStats({ snap, range })
    assert.equal(s.activeMs + s.idleMs + s.offlineMs, s.durationMs)
  }
})

test('the LEDGER partitions with the denominators: every drop is in exactly one session', () => {
  const { snap, lo, hi, idleMark, offlineMark } = resetEvening()
  const bounds = { lo, hi }
  const drops: LootEvent[] = [
    { ts: T0 + 10 * MIN, item: 'Mote of Potential', zone: 'Najena 4 (Refined)' },
    // ON the mark: half-open at the bottom means it belongs to the session that just opened.
    { ts: idleMark, item: 'Bone Chips', zone: 'Najena 4 (Refined)' },
    { ts: T0 + 100 * MIN, item: 'Mote of Potential', zone: 'Najena 7 (Awakened)', count: 3 },
    { ts: T0 + 200 * MIN, item: 'Rusty Dagger', zone: 'Najena 7 (Awakened)' }
  ]
  const slices = sessionSegments([idleMark, offlineMark]).map((s) =>
    resolveSlice({ snap, bounds, id: 'custom', custom: s.range, customCaption: s.caption })
  )
  for (const drop of drops) {
    const holders = slices.filter((s) => inSlice(s, drop.ts, drop.zone))
    assert.equal(holders.length, 1, `${drop.item} at ${String(drop.ts)} is in exactly one session`)
  }
  assert.equal(slices[0].caption, 'session 1')
  assert.ok(inSlice(slices[1], idleMark), 'the drop AT the reset is in the session the reset opened')
  assert.ok(!inSlice(slices[0], idleMark), '…and not in the one it closed')
  const counted = slices.reduce((n, s) => n + drops.filter((d) => inSlice(s, d.ts, d.zone)).length, 0)
  assert.equal(counted, drops.length, 'and the whole ledger is accounted for, once each')
})

// ── where the affordance is, and is not ───────────────────────────────────────────────

/** A source file, read as text — the same structural-pin trick `tests/zoneScope.test.mts` uses for
 *  claims that are about WHICH surface mounts what, and that no arithmetic can reach. */
function code(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
}

/** The same file with its comments stripped — for the pins that are about what the code DOES.
 *  These files argue about `Date.now()` in prose at length, and a claim that a module never reads
 *  the clock must not be satisfiable by deleting the paragraph that explains why. */
function codeOnly(rel: string): string {
  return code(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

test('the split is the LOOT ledger’s affordance, and the EXP surfaces do not grow a second one', () => {
  // The ledger asks for it by name. Everything else reads the resulting slice without knowing the
  // button exists — which is the whole reason this rides `custom` instead of a tenth slice id.
  assert.match(code('../src/renderer/src/features/loot/LootView.tsx'), /sessions=\{\{ segments/)
  assert.doesNotMatch(
    code('../src/renderer/src/features/timeslice/ScopeBar.tsx'),
    /sessions=/,
    'the Leveling scope row must not sprout its own reset button'
  )
  // THE SECOND AFFORDANCE THE OWNER DID ASK FOR (JOS-322, 2026-08-21): the ZONE METER OVERLAY's
  // title bar, small, beside the lock and close. It is deliberately not a second CONTROL — it is
  // the same app-wide mark pressed from the surface the original report was written in front of.
  // The exp surfaces are still the ones excluded, and that is what the clause above pins.
  assert.match(
    code('../src/renderer/src/overlay/OverlayMeter.tsx'),
    /label: 'New session'/,
    'the zone meter must keep the title-bar affordance the owner ruled for'
  )
})

test('the ONE clock read moved to MAIN, where both halves of the split can share it', () => {
  // The pure modules stay replayable: a replay of yesterday's log has to give yesterday's answer,
  // whatever the wall clock says today.
  assert.doesNotMatch(codeOnly('../src/shared/sessionSegments.ts'), /Date\.now|new Date/)
  assert.doesNotMatch(codeOnly('../src/shared/timeslice.ts'), /Date\.now|new Date/)
  // …AND THE RENDERER NO LONGER READS IT EITHER (JOS-322). It used to be `addSessionMark(marks,
  // Date.now())` right here, which was correct while the only consumer was this window's ledger.
  // Once one click had to split the COMBAT ENGINE too — and the engine is in main — a renderer's
  // clock would have given the two halves two boundaries a round trip apart. So main stamps it
  // once; tests/sessionMarks.test.mts pins that the same identifier reaches both halves.
  const hook = codeOnly('../src/renderer/src/features/timeslice/useTimeslice.ts')
  assert.doesNotMatch(hook, /Date\.now|new Date/, 'the renderer started stamping its own instant again')
  assert.match(hook, /useSessionMarks\(window\.eq\)/, 'the marks must come from main')
  assert.match(codeOnly('../src/main/sessionMarks.ts'), /const at = Date\.now\(\)/)
})

test('the two datetime fields display the RAW pick, which is the future-end-time fix', () => {
  const bar = code('../src/renderer/src/features/timeslice/SliceBar.tsx')
  // `inputRange(custom, …)` is the whole fix: the control shows what was typed, the SLICE stays
  // clamped. Re-pinning `slice.range` straight onto the fields is the regression it prevents.
  assert.match(bar, /<CustomRange range=\{inputRange\(custom, slice\.range\)\}/)
  assert.match(bar, /Number\.isFinite\(custom\.t1\)/, 'and an OPEN end has no wall time to show')
  // Both surfaces that draw the fields hand the raw pick down — one of them displaying a different
  // range than the other is two controls wearing one design.
  assert.match(code('../src/renderer/src/features/timeslice/ScopeBar.tsx'), /custom=\{custom\}/)
  assert.match(code('../src/renderer/src/features/loot/LootView.tsx'), /custom=\{ts\.custom\}/)
})
