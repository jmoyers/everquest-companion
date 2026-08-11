// chartWindow.ts — WHICH SLICE OF THE HISTORY the two leveling charts show, and the sampling
// grid that slice is quantized to (JOS-71).
//
// Pure: no React, no DOM, no MUI, and only TYPE imports from sibling modules, so
// tests/chartWindow.test.mts can import it straight under tsx (the same constraint
// levelChartGeometry.ts and zoneBands.ts document).
//
// ONE TIME BASE, STILL (world-model law 9). Picking a timescale replaces `{t0, t1, bucketMs}`
// WHOLESALE and hands the new one to everything at once: both curves' vertices, the zone-band
// strip, the swap rules, the range-selection band, the hover crosshair and its X→time inverse
// all read the SAME `ChartScale` object out of `ChartChrome`. There is no per-consumer window
// and no second opinion about what a pixel means — which is what keeps a zoomed chart from
// growing the marker-swim the DPS curve had to be cured of (5a9dbc2).
//
// THE BUCKET RULE, and what the bucket is FOR here.
//   • SIZE: `bucketMs` is the smallest step on the ladder below with at most TARGET_BUCKETS of
//     them in the window — i.e. one bucket is never narrower than ~2 of the chart's 720 user
//     units. It therefore SCALES WITH THE WINDOW: an hour buckets by 15 s, a day by 5 m, a
//     month by 2 h. TARGET_BUCKETS mirrors the DPS curve's own budget (dashboardData.ts), so
//     this app has one answer to "how fine may a chart's grid be", not two.
//   • JOB 1 — QUANTIZATION. A fixed-length window is anchored on the newest data, so it slides
//     left as the log grows. Both ends snap to whole multiples of `bucketMs`, so it advances by
//     a whole bucket at a time instead of by whatever fraction the last event happened to add.
//     That is law 9's "live windows advance in whole buckets": an un-snapped edge re-scales
//     every marker on every tick and they swim against a still curve.
//   • JOB 2 — RESOLUTION. It is the finest distinction the window claims to draw, which is what
//     `bandRects`' sub-pixel drop and the readouts are ultimately talking in.
//   • WHAT IT DELIBERATELY DOES NOT DO: bucket-AVERAGE the series. Both leveling curves are
//     STEP functions over discrete log lines (a ding, a gain line), and the hover layer reads
//     the very same array the curve is drawn from — so collapsing three gain lines into one
//     bucketed vertex would make the tooltip's "+N AA" name a total no single line reported,
//     and put the step at a time nothing happened. That is the index-vs-time mixing law 9 is a
//     scar from, so the vertices stay at their own instants; readability at a narrow scale
//     comes from CLIPPING the series to the window (below) and re-deriving the y-range inside
//     it, not from smearing events across a grid. Sparse by nature, too: the real log carries
//     ~200 AA gain lines and ~60 dings in 1.4M lines, so there is no vertex count to defend.

import type { LevelSegment } from './levelSeries'
import { stepIndexAt } from './levelChartGeometry'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/**
 * Trailing pad on any window, as a fraction of its span. Preserved from the level chart's own
 * former domain: without it the CURRENT level is a bare endpoint on the right edge instead of
 * reading as the plateau it is. Applied identically at every scale, so the picture's right-hand
 * gutter does not change shape when the user zooms.
 */
export const TRAILING_FRAC = 0.04

/** At most this many buckets in a window — one bucket ≥ ~2 of the chart's 720 user units. */
export const TARGET_BUCKETS = 360

/**
 * The grid steps a window may quantize to. Round, human times only: an edge that lands on the
 * top of an hour is a readable edge, `ceil(span/360)` is a 3-minute-17-second one.
 */
const BUCKET_LADDER: readonly number[] = [
  1000,
  5000,
  15_000,
  30_000,
  MIN,
  2 * MIN,
  5 * MIN,
  15 * MIN,
  30 * MIN,
  HOUR,
  2 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY
]

export type TimescaleId = 'full' | 'd7' | 'h24' | 'h6' | 'h1'

export interface Timescale {
  id: TimescaleId
  /** The segmented control's label. STATE, not process: it names the window, not the zooming. */
  label: string
  /** Window length in ms. 0 is the sentinel for "everything the log holds". */
  ms: number
}

/** Widest first, which is the order the control renders and the order a user reads a zoom in. */
export const TIMESCALES: readonly Timescale[] = [
  { id: 'full', label: 'All', ms: 0 },
  { id: 'd7', label: '7d', ms: 7 * DAY },
  { id: 'h24', label: '24h', ms: DAY },
  { id: 'h6', label: '6h', ms: 6 * HOUR },
  { id: 'h1', label: '1h', ms: HOUR }
]

/**
 * The scales THIS character's history can actually fill.
 *
 * A preset is offered only when the log spans strictly longer than it. Three hours of history
 * therefore offers `All · 1h` and nothing else — never "7d". The rejected alternative was to
 * offer every scale and let a short history draw into an empty left half: these charts have no
 * time axis, so empty space beside a curve reads as a stretch where you played and gained
 * nothing, which is a lie about the log rather than a statement about it. A scale exactly as
 * long as the history is withheld too — it would be `All` under a second name.
 *
 * `full` is always in the list and is always first, so the default is available to every
 * character and the control can never come up empty.
 */
export function availableTimescales(spanMs: number): Timescale[] {
  return TIMESCALES.filter((s) => s.ms === 0 || s.ms < spanMs)
}

/** The chosen scale if this history can fill it, else `full`. A character switch can shrink the
 *  span under the current pick, and the picture must degrade to the honest window rather than to
 *  a window the log cannot fill. */
export function resolveTimescale(id: TimescaleId, spanMs: number): TimescaleId {
  return availableTimescales(spanMs).some((s) => s.id === id) ? id : 'full'
}

/** The grid a window of `spanMs` is drawn on — see THE BUCKET RULE in the header. */
export function bucketMsFor(spanMs: number): number {
  const span = Math.max(1, spanMs)
  for (const step of BUCKET_LADDER) {
    if (span / step <= TARGET_BUCKETS) return step
  }
  // Past a year of history the ladder runs out; keep whole DAYS rather than inventing a step.
  return Math.ceil(span / TARGET_BUCKETS / DAY) * DAY
}

/**
 * The window drawn over an ARBITRARY pair of instants — the `full` rule, generalized (JOS-130).
 *
 * `windowFor(lo, hi, 'full')` is exactly this call, so the whole-history domain is byte-identical
 * to what it has always been. It is what every SEMANTIC slice draws with (this session, this
 * zone, a custom pair): those are anchored on the DATA at both ends, like `full` and unlike a
 * fixed-length rung, so they take the trailing pad and NOT the outward bucket snap — a snap is
 * what makes a sliding window advance in whole buckets, and a slice with two stated ends is not
 * sliding.
 */
export function windowOver(t0: number, t1: number): TimeWindow {
  const span = Math.max(1, t1 - t0)
  const end = t1 + span * TRAILING_FRAC
  return { t0, t1: end, bucketMs: bucketMsFor(end - t0) }
}

/** The one time base a chart draws on: the window and the grid it is quantized to. */
export interface TimeWindow {
  t0: number
  t1: number
  bucketMs: number
}

/**
 * The window for one timescale over data spanning `[lo, hi]`.
 *
 * `full` is byte-identical to the domain these charts have always drawn — `lo` to `hi` plus the
 * trailing pad, unquantized — because it is anchored on the DATA at both ends and so cannot
 * drift against itself. A user who never touches the control sees exactly the chart they saw
 * before this feature existed.
 *
 * A fixed-length window ends at the newest data (plus the same trailing pad) and reaches back
 * its own length; both ends then snap OUTWARD to the bucket grid, which is what makes it
 * advance in whole buckets as the log grows (header, JOB 1).
 */
export function windowFor(lo: number, hi: number, id: TimescaleId): TimeWindow {
  const scale = TIMESCALES.find((s) => s.id === id) ?? TIMESCALES[0]
  if (scale.ms === 0) return windowOver(lo, hi)
  const bucketMs = bucketMsFor(scale.ms * (1 + TRAILING_FRAC))
  return {
    t0: Math.floor((hi - scale.ms) / bucketMs) * bucketMs,
    t1: Math.ceil((hi + scale.ms * TRAILING_FRAC) / bucketMs) * bucketMs,
    bucketMs
  }
}

/**
 * The drawn slice of a step series: everything from the window's start onward, PLUS the last
 * sample at or before it.
 *
 * That carried sample is the ANCHOR, and it is the difference between a curve that enters the
 * left edge at the value actually in force there and one that starts in mid-air at the first
 * event inside the window. It keeps its OWN timestamp — it plots off-plot to the left and the
 * SVG viewport clips it — so nothing claims to have happened at the window edge.
 *
 * There is no right-hand clip: every window this module builds ends at or after the newest
 * sample (that is what the trailing pad is), so the tail is always already inside.
 */
export function visibleFrom<T extends { ts: number }>(points: readonly T[], t0: number): T[] {
  if (points.length === 0) return []
  const anchor = stepIndexAt(points, t0)
  return points.slice(Math.max(0, anchor))
}

/**
 * The same clip for the level chart's disjoint runs.
 *
 * Exactly ONE anchor survives across the whole list — the last ding at or before `t0`, wherever
 * it lives — and the run that owns it keeps it even when everything else in that run is older.
 * A run reduced to its anchor still matters: it is what `levelAt` reads to report a `swap-gap`
 * whose gap started before the window opened, and what stops the y-range from being computed
 * off the post-swap dings alone.
 *
 * `afterSwap` rides along untouched, so a swap whose first ding is inside the window still draws
 * its dashed rule, and a swap that happened before it draws that rule off-plot where it belongs.
 */
export function visibleSegments(segments: readonly LevelSegment[], t0: number): LevelSegment[] {
  // The anchor belongs to the LAST run that opened at or before the window — runs are ascending
  // and disjoint by construction, so that is the only one whose older dings still say anything.
  let anchorSeg = -1
  for (let s = 0; s < segments.length; s++) {
    if (segments[s].points[0].ts <= t0) anchorSeg = s
  }
  const out: LevelSegment[] = []
  for (let s = 0; s < segments.length; s++) {
    const pts = segments[s].points
    const after = pts.filter((p) => p.ts > t0)
    const kept = s === anchorSeg ? [pts[stepIndexAt(pts, t0)], ...after] : after
    if (kept.length > 0) out.push({ points: kept, afterSwap: segments[s].afterSwap })
  }
  return out
}
