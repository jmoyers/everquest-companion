// Pure unit tests for the leveling charts' TIMESCALE
// (src/renderer/src/features/leveling/chartWindow.ts, JOS-71).
//
// No log, no fixture, no DOM — so this file never skips. It pins the four things a
// user-selectable window can get quietly wrong:
//   1. DATA HONESTY — a scale is offered only when the character's history can fill it, so a
//      three-hour log never grows a "7d" button that would draw two empty thirds;
//   2. THE DEFAULT IS UNCHANGED — `full` is byte-identical to the domain these charts drew
//      before the control existed, which is what "nothing changes for users who ignore it" means
//      in numbers rather than in prose;
//   3. ONE TIME BASE, ADVANCING IN WHOLE BUCKETS (world-model law 9) — a fixed-length window is
//      anchored on the newest data, so it slides as the log grows; both ends snap to the bucket
//      grid, and this suite proves each edge only ever moves by exactly one bucket. An un-snapped
//      edge is the marker swim the DPS curve had to be cured of (5a9dbc2);
//   4. THE ANCHOR — clipping a step series to a window keeps the last sample BEFORE it, or the
//      curve would enter the plot in mid-air and the level chart would scale itself off the
//      post-window dings alone.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TARGET_BUCKETS,
  TIMESCALES,
  TRAILING_FRAC,
  availableTimescales,
  bucketMsFor,
  resolveTimescale,
  visibleFrom,
  visibleSegments,
  windowFor,
  windowOver
} from '../src/renderer/src/features/leveling/chartWindow'
import { buildLevelSegments } from '../src/renderer/src/features/leveling/levelSeries'
import { levelAt, stepIndexAt } from '../src/renderer/src/features/leveling/levelChartGeometry'

const T0 = Date.parse('2026-07-28T12:00:00')
const MIN = 60_000
const H = 3_600_000
const DAY = 24 * H

const ids = (spanMs: number): string[] => availableTimescales(spanMs).map((s) => s.id)

// ── 1. data honesty ───────────────────────────────────────────────────────────────────

test('a scale is offered only when the history is LONGER than it', () => {
  assert.deepEqual(ids(3 * H), ['full', 'h1'], 'three hours of play offers the hour and nothing wider')
  assert.deepEqual(ids(4.8 * DAY), ['full', 'h24', 'h6', 'h1'], 'five days does not offer a week')
  assert.deepEqual(ids(30 * DAY), TIMESCALES.map((s) => s.id), 'a month fills every rung')
})

test('a scale exactly as long as the history is withheld (it would be `All` under a second name)', () => {
  assert.deepEqual(ids(H), ['full'])
  assert.deepEqual(ids(H + 1), ['full', 'h1'])
})

test('`full` is always offered and always first, so the control can never come up empty', () => {
  for (const span of [0, 1, 90 * MIN, 400 * DAY]) {
    assert.equal(availableTimescales(span)[0]?.id, 'full', `span ${span}`)
  }
})

test('a pick the current character cannot fill degrades to `full`, never to an unfillable window', () => {
  assert.equal(resolveTimescale('h6', 30 * DAY), 'h6', 'kept while the log can fill it')
  assert.equal(resolveTimescale('h6', 2 * H), 'full', 'a shorter character switches the picture back')
  assert.equal(resolveTimescale('full', 0), 'full')
})

// ── 2. the bucket ladder ──────────────────────────────────────────────────────────────

test('the bucket is the smallest ROUND step that keeps the window inside the budget', () => {
  for (const [spanMs, bucketMs] of [
    [H, 15_000],
    [6 * H, MIN],
    [DAY, 5 * MIN],
    [7 * DAY, 30 * MIN],
    [30 * DAY, 2 * H]
  ] as const) {
    assert.equal(bucketMsFor(spanMs), bucketMs, `${spanMs}ms window`)
  }
})

test('every window stays inside the bucket budget, and the bucket never shrinks as it widens', () => {
  let prev = 0
  for (const spanMs of [1, 30_000, 10 * MIN, H, 8 * H, DAY, 3 * DAY, 9 * DAY, 60 * DAY, 400 * DAY]) {
    const b = bucketMsFor(spanMs)
    assert.ok(spanMs / b <= TARGET_BUCKETS, `${spanMs}ms would draw ${String(spanMs / b)} buckets`)
    assert.ok(b >= prev, 'a wider window may never get a finer grid')
    prev = b
  }
})

// ── 3. the windows themselves ─────────────────────────────────────────────────────────

test('`full` is byte-identical to the domain these charts always drew', () => {
  const lo = T0
  const hi = T0 + 5 * H
  const w = windowFor(lo, hi, 'full')
  assert.equal(w.t0, lo, 'the earliest instant opens the window')
  assert.equal(w.t1, hi + 5 * H * 0.04, 'the 4% trailing pad, unchanged and unquantized')
})

test('a fixed window ends on the newest data and reaches back its own length', () => {
  const hi = T0 + 9 * DAY
  const w = windowFor(T0, hi, 'h6')
  assert.ok(w.t0 <= hi - 6 * H, 'it covers the whole six hours…')
  assert.ok(w.t1 >= hi, '…and every one of them ends inside it')
  assert.equal(w.t0 % w.bucketMs, 0, 'both ends sit on the grid')
  assert.equal(w.t1 % w.bucketMs, 0)
  // Six hours, plus the same 4% trailing gutter every scale draws, plus at most one bucket of
  // outward snap at each end. Nothing else may creep into a window's length.
  assert.ok(w.t1 - w.t0 < 6 * H * 1.04 + 2 * w.bucketMs, 'quantizing outward costs at most a bucket an end')
})

test('a fixed window ADVANCES IN WHOLE BUCKETS as the log grows (law 9: no swim)', () => {
  const hi0 = T0 + 3 * DAY
  const w0 = windowFor(T0, hi0, 'h1')
  let t0s = 0
  let t1s = 0
  let prev = w0
  // Walk the newest instant forward a minute at a time across four buckets' worth of growth.
  for (let k = 1; k <= 4 * (w0.bucketMs / 1000) * 1000; k += 1000) {
    const w = windowFor(T0, hi0 + k, 'h1')
    assert.equal(w.bucketMs, w0.bucketMs, 'the grid itself never changes for a fixed length')
    if (w.t0 !== prev.t0) {
      assert.equal(w.t0 - prev.t0, w.bucketMs, 'the left edge moves by exactly one bucket')
      t0s++
    }
    if (w.t1 !== prev.t1) {
      assert.equal(w.t1 - prev.t1, w.bucketMs, 'the right edge moves by exactly one bucket')
      t1s++
    }
    prev = w
  }
  assert.ok(t0s > 0 && t1s > 0, 'the window really did advance (a frozen window proves nothing)')
})

test('every timescale produces a window a chart can map (t1 > t0, positive bucket)', () => {
  for (const s of TIMESCALES) {
    const w = windowFor(T0, T0 + 40 * DAY, s.id)
    assert.ok(w.t1 > w.t0, `${s.id} spans time`)
    assert.ok(w.bucketMs > 0, `${s.id} has a grid`)
  }
})

// ── 4. clipping the series to the window ──────────────────────────────────────────────

const pts = [0, 1, 2, 3, 4].map((i) => ({ ts: T0 + i * H, y: (i + 1) * 10 }))

test('visibleFrom keeps everything inside the window PLUS the sample that preceded it', () => {
  const v = visibleFrom(pts, T0 + 2 * H + 5 * MIN)
  assert.deepEqual(
    v.map((p) => p.ts - T0),
    [2 * H, 3 * H, 4 * H],
    'the 2h sample is the anchor: it is the value in force at the left edge'
  )
  assert.equal(visibleFrom(pts, T0 - H).length, pts.length, 'a window opening before the series keeps all of it')
  assert.deepEqual(visibleFrom(pts, T0 + 9 * H).map((p) => p.ts), [T0 + 4 * H], 'past the last sample, the anchor alone')
  assert.deepEqual(visibleFrom([], T0), [], 'nothing in, nothing out')
})

test('the anchor keeps its OWN timestamp — nothing is claimed to have happened at the edge', () => {
  const t0 = T0 + 2 * H + 5 * MIN
  assert.equal(visibleFrom(pts, t0)[0].ts, T0 + 2 * H)
  assert.notEqual(visibleFrom(pts, t0)[0].ts, t0)
})

// Two loadouts: 48→50 over three hours, then a swap down to 11→12 the next day.
const dings = [
  { ts: T0, level: 48 },
  { ts: T0 + H, level: 49 },
  { ts: T0 + 2 * H, level: 50 },
  { ts: T0 + DAY, level: 11 },
  { ts: T0 + DAY + H, level: 12 }
]
const segs = buildLevelSegments(dings)

test('visibleSegments drops runs the window has left behind and anchors the one it straddles', () => {
  const v = visibleSegments(segs, T0 + DAY + 30 * MIN)
  assert.equal(v.length, 1, 'the pre-swap run is entirely behind the window')
  assert.deepEqual(v[0].points.map((p) => p.level), [11, 12], 'anchored on the level in force at the edge')
  assert.equal(v[0].afterSwap, true, 'the swap flag rides along, so its dashed rule is still drawn')
})

test('a run reduced to its anchor SURVIVES, so the gap it opens is still reportable', () => {
  // A window opening between the last pre-swap ding and the first post-swap one: the level there
  // is genuinely unknown (the swap is never logged), and only the surviving anchor can say so.
  const v = visibleSegments(segs, T0 + 12 * H)
  assert.equal(v.length, 2)
  assert.deepEqual(v[0].points.map((p) => p.level), [50], 'the old run keeps exactly its last ding')
  assert.equal(levelAt(v, T0 + 13 * H).kind, 'swap-gap', 'and the hover still reports the unlogged gap')
})

test('a window over the whole history clips nothing at all', () => {
  const v = visibleSegments(segs, T0 - 1)
  assert.deepEqual(v.map((s) => s.points.length), segs.map((s) => s.points.length))
  assert.deepEqual(v.map((s) => s.afterSwap), segs.map((s) => s.afterSwap))
})

test('the clipped series still answers the same questions the full one did, inside the window', () => {
  const t0 = T0 + 90 * MIN
  const v = visibleSegments(segs, t0)
  for (const ts of [t0, t0 + 10 * MIN, T0 + 2 * H, T0 + 5 * H]) {
    assert.deepEqual(levelAt(v, ts), levelAt(segs, ts), `level at ${ts - T0}ms into the window`)
  }
  const va = visibleFrom(pts, t0)
  assert.equal(va[stepIndexAt(va, t0 + 30 * MIN)].y, pts[stepIndexAt(pts, t0 + 30 * MIN)].y, 'and so does the AA step lookup')
})

// ── 5. the generalized domain (JOS-130) ───────────────────────────────────────────────
//
// The app-wide timeslice draws SEMANTIC slices — this session, this zone, a custom pair — and
// those are anchored on stated instants at both ends, exactly like `full` and unlike a sliding
// rung. `windowOver` is that rule, factored out of `windowFor`, and the pin that matters is that
// `full` still goes through it: a user who never touches the control must see the same chart.

test('windowOver IS the `full` rule — the whole-history domain is unchanged, byte for byte', () => {
  for (const [lo, hi] of [
    [T0, T0 + 3 * H],
    [T0, T0 + 40 * DAY],
    [T0, T0]
  ] as const) {
    assert.deepEqual(windowOver(lo, hi), windowFor(lo, hi, 'full'), `${String(hi - lo)}ms of history`)
  }
})

test('windowOver pads a narrower slice by the same 4%, and buckets it for its OWN span', () => {
  const win = windowOver(T0 + 2 * H, T0 + 3 * H)
  assert.equal(win.t0, T0 + 2 * H, 'the near end is the instant asked for — no outward snap')
  assert.equal(win.t1, T0 + 3 * H + H * TRAILING_FRAC, 'and the far end carries the trailing gutter')
  assert.equal(win.bucketMs, bucketMsFor(win.t1 - win.t0), 'the grid is derived from the drawn span')
  assert.ok(win.bucketMs < windowOver(T0, T0 + 40 * DAY).bucketMs, 'a narrower slice draws on a finer grid')
})

test('windowOver never produces a zero-width or inverted domain', () => {
  const win = windowOver(T0, T0)
  assert.ok(win.t1 > win.t0, 'one instant of history still spans something to divide by')
  assert.ok(Number.isFinite(win.bucketMs) && win.bucketMs > 0)
})
