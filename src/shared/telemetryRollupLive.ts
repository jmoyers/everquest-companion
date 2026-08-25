// ============================================================================
// telemetryRollupLive.ts — what a live session's three riders become in storage (JOS-367).
// ============================================================================
//
// Split out of `./telemetryRollup.ts` for that file's own stated reason: it sits at the repo's
// 400-code-line ceiling, and twenty-one metric names plus their fold do not fit. The cut is by
// SUBJECT — everything here is about ONE session's account of how smoothly it ran — and the
// metric names are spread back into `USAGE_METRICS` so there is still exactly one closed table of
// what the ingest path may write.
//
// UNVERSIONED, AND DELIBERATELY SO — the one place this section departs from the startup metrics
// it is otherwise shaped like. Those are dimensioned by build because "did the release we shipped
// make launches better" is a comparison between builds. These describe a MACHINE and a SESSION:
// how much memory it had free, how big its log is, whether its two clocks went late together.
// Putting a version in the dim would split every distribution across four releases and answer the
// question nobody asked, while the cross-tab that IS worth having (stall by EQ window mode, by
// machine class) needs a cube rather than a dim and is its own ticket.
//
// TWO SHAPES, and the difference is the same one the startup section keeps: a SUM (`liveOver100`,
// `tailReads`) that needs a denominator beside it, and a HISTOGRAM (`liveStallP95`,
// `stateFreeMem`) that IS its own denominator — a bucket index is never non-positive, so `add()`
// can never refuse one, so the histogram's total is exactly the number of reports that carried
// the group. That is why no `liveReports` counter sits here: it would be a second spelling of a
// number `liveStallP95` already holds.
//
// PURE, like the file it came from: it imports the contract's rider types and nothing else, so it
// bundles into the ingest Lambda and compiles under both tsconfigs.

import { PERF_SEAMS } from './perfSeams'
import type { SessionRiders } from './telemetryLive'

/** Either session report — both extend the same five optional groups (`SessionRiders`). */
export type LiveRiderCarrier = SessionRiders

/** `add`, as `./telemetryRollup.ts` hands it over: its accumulator stays private to that file. */
export type AddCounter = (metric: string, dim: string, n: number) => void

/**
 * The live riders' metric names, spread into `USAGE_METRICS`. Additive with NO schema change, for
 * the reason every metric added since JOS-57 has been: `usage_daily` holds arbitrary (metric, dim)
 * pairs, so new NAMES are free and the ingest deploy that learns them changes no table.
 */
export const LIVE_METRICS = {
  /** n = probe ticks observed. The denominator for "how often", as opposed to "how many". */
  liveSamples: 'liveSamples',
  /** dim = index into LIVE_STALL_MS_EDGES; one row per report. THE distribution, and the total of
   *  this histogram is how many reports carried a stall reading at all. */
  liveStallP95: 'liveStallP95',
  /** dim = the same ladder — the worst single tick of each report. Read beside the p95: a max
   *  that climbs while the p95 holds still is a rare freeze, which is exactly what is reported. */
  liveStallMax: 'liveStallMax',
  /** n = ticks at least 100 ms / 500 ms late, summed. */
  liveOver100: 'liveOver100',
  liveOver500: 'liveOver500',
  /**
   * n = windows in which BOTH our threads were late — the machine-stalled verdict, summed.
   *
   * READ IT OVER `liveVerdicts`, NEVER OVER `liveStallP95`. The two populations differ: a report
   * whose probe worker never started carries no verdict at all, and dividing by every report
   * would silently deflate the rate toward zero on exactly the machines where the worker could
   * not start — which are not a random sample of machines.
   */
  liveCoincident: 'liveCoincident',
  /**
   * n = reports that carried a verdict AT ALL, whatever it said. It exists because `add()` refuses
   * a non-positive value, so a report that compared two clocks and found NO coincidence writes no
   * `liveCoincident` row — and without this counter that report would be indistinguishable from
   * one that had no second clock to compare. Those are opposite facts: the first says the stalls
   * are OURS, the second says nothing at all.
   */
  liveVerdicts: 'liveVerdicts',
  /** n = read cycles / cycles that had to re-open the handle, summed. `tailReopens` is the number
   *  JOS-363's fix is about; a fleet steady state is zero. */
  tailReads: 'tailReads',
  tailReopens: 'tailReopens',
  /** dim = index into LIVE_STALL_MS_EDGES — the SAME ladder the stall metrics use, so "our loop
   *  was 600 ms late" and "our read leg took 600 ms" land in the same row and can be compared. */
  tailReadP95: 'tailReadP95',
  tailReadMax: 'tailReadMax',
  /** n = read cycles over 100 ms / 500 ms, summed. */
  tailOver100: 'tailOver100',
  tailOver500: 'tailOver500',
  /** dim = index into NEW_BYTES_EDGES — the fattest single delta of each report. */
  tailDeltaBytes: 'tailDeltaBytes',
  /** dim = index into LOG_SIZE_BYTES_EDGES. Reads beside `setupLogSize` and `startupLogSize`,
   *  which use the same edges: this one is the size of the log while it was being TAILED. */
  tailLogSize: 'tailLogSize',
  /** dim = `0` | `1` | `2+`. Counting windows exactly past two would be a per-user layout. */
  stateOverlaysOpen: 'stateOverlaysOpen',
  /** dim = the same three. THE ONE TO WATCH: a locked overlay means the process-wide WH_MOUSE_LL
   *  hook is armed, so a stall population living entirely at `1`/`2+` is an actionable reading. */
  stateOverlaysLocked: 'stateOverlaysLocked',
  /** dim = `on` | `off`. Two more threads' worth of context for the row above. */
  statePresence: 'statePresence',
  stateRing: 'stateRing',
  /** dim = index into FREE_MEM_GB_EDGES — the paging hypothesis, per report. */
  stateFreeMem: 'stateFreeMem',
  /** dim = index into WORKING_SET_MB_EDGES — what WE were costing the machine at the time. */
  stateWorkingSet: 'stateWorkingSet',
  // ---- JOS-458: the attribution riders ------------------------------------------------------
  /** n = GC pauses observed / mark-compacts among them / pauses past a tenth of a second, summed.
   *  Read `gcMajor` over `gcPauses`: a fleet whose pause count climbs while the major count holds
   *  still is scavenging harder, which is not the shape that stops a render thread. */
  gcPauses: 'gcPauses',
  gcMajor: 'gcMajor',
  gcOver100: 'gcOver100',
  /** dim = index into LIVE_STALL_MS_EDGES — the SAME ladder as `liveStallMax`, deliberately, so
   *  "V8 paused for 640 ms" and "main was 640 ms late" are one row apart and not one unit apart. */
  gcMax: 'gcMax',
  /** n = reports that carried a GC reading at all. `liveVerdicts`' argument, one subject over: an
   *  interval of zero pauses writes no `gcPauses` row (`add` refuses a non-positive value), and
   *  without this counter it would be indistinguishable from an install whose observer never
   *  started — which are opposite facts. */
  gcReports: 'gcReports',
  /**
   * dim = THE SEAM NAME, a member of `PERF_SEAMS` and nothing else. This is the metric the whole
   * ticket is for: the fleet answer to "which of our own seams owns the stalls".
   *
   * n = calls / calls past a tenth of a second. `seamStalls` is the one to read — `seamCalls` is
   * its denominator, and a seam that is entered a thousand times an hour and is never slow must
   * not out-rank one entered twice and slow both times.
   */
  seamCalls: 'seamCalls',
  seamStalls: 'seamStalls',
  /** dim = `<seam>` — one row per report per seam that RAN, so the histogram's total per seam is
   *  how many reports that seam appeared in, which is the denominator `seamStalls` needs. */
  seamReports: 'seamReports',
  /** dim = index into LIVE_STALL_MS_EDGES, dimensioned by BUCKET rather than by seam on purpose:
   *  the seam is already carried by the three metrics above, and a composite dim would be a
   *  string this file assembled rather than a value the schema declared. */
  seamMax: 'seamMax'
} as const

/** `0` / `1` / `2+` — a window count as a dim. Past two, how many overlays a person keeps open is
 *  a description of their desktop rather than a population, and the answer stops changing. */
function windows(n: number): string {
  return n >= 2 ? '2+' : String(Math.max(0, Math.trunc(n)))
}

const flag = (on: boolean): string => (on ? 'on' : 'off')

/**
 * ONE SESSION REPORT'S LIVE RIDERS. Each group is folded only when it is PRESENT — never as a row
 * of zeros, which is `foldMachineClass`'s distinction and matters more here: bucket 0 of every
 * ladder in this section is a real reading (under 10 ms late, under half a gibibyte free), so a
 * client that predates the field would otherwise invent a population of impossibly healthy — or
 * impossibly starved — machines.
 *
 * `add` and the no-dimension spelling are handed in rather than imported, so the accumulator and
 * `DIM_NONE` stay owned by `./telemetryRollup.ts` and these two files are a split rather than a
 * cycle.
 */
export function foldLiveRiders(add: AddCounter, dimNone: string, ev: LiveRiderCarrier): void {
  const { live, tail, state } = ev
  if (live !== undefined) {
    add(LIVE_METRICS.liveSamples, dimNone, live.samples)
    add(LIVE_METRICS.liveStallP95, String(live.p95Bucket), 1)
    add(LIVE_METRICS.liveStallMax, String(live.maxBucket), 1)
    add(LIVE_METRICS.liveOver100, dimNone, live.over100)
    add(LIVE_METRICS.liveOver500, dimNone, live.over500)
    if (live.coincident !== undefined) {
      add(LIVE_METRICS.liveVerdicts, dimNone, 1)
      add(LIVE_METRICS.liveCoincident, dimNone, live.coincident)
    }
  }
  if (tail !== undefined) foldTail(add, dimNone, tail)
  if (state !== undefined) foldState(add, state)
  if (ev.gc !== undefined) foldGc(add, dimNone, ev.gc)
  if (ev.seams !== undefined) foldSeams(add, ev.seams)
}

/** The GC group (JOS-458). `gcReports` is written unconditionally so the three sums have a
 *  denominator even in the interval where all three are zero — see its declaration. */
function foldGc(add: AddCounter, dimNone: string, gc: NonNullable<LiveRiderCarrier['gc']>): void {
  add(LIVE_METRICS.gcReports, dimNone, 1)
  add(LIVE_METRICS.gcPauses, dimNone, gc.pauses)
  add(LIVE_METRICS.gcMajor, dimNone, gc.majorPauses)
  add(LIVE_METRICS.gcOver100, dimNone, gc.over100)
  add(LIVE_METRICS.gcMax, String(gc.maxBucket), 1)
}

/**
 * The seam group (JOS-458).
 *
 * IT WALKS `PERF_SEAMS`, NEVER THE PAYLOAD'S KEYS, and that is the same mechanical bright line the
 * producer keeps: this fold runs INSIDE the ingest Lambda over bytes a client sent, so a key the
 * schema does not name must not be able to become a dimension in `usage_daily`. The validator
 * already reconstructs the group field by field; this is the second lock on the same door, in the
 * one place where a `for…in` would have been the obvious spelling.
 *
 * It takes no `dimNone`, unlike its two neighbours: EVERY row this group writes is dimensioned,
 * because a seam number with no seam beside it would be a sum over six different questions.
 */
function foldSeams(add: AddCounter, seams: NonNullable<LiveRiderCarrier['seams']>): void {
  for (const seam of PERF_SEAMS) {
    const entry = seams[seam]
    if (entry === undefined) continue
    add(LIVE_METRICS.seamReports, seam, 1)
    add(LIVE_METRICS.seamCalls, seam, entry.calls)
    add(LIVE_METRICS.seamStalls, seam, entry.over100)
    add(LIVE_METRICS.seamMax, String(entry.maxBucket), 1)
  }
}

/** The tail group, split out so `foldLiveRiders` stays inside the repo's factoring ceilings. */
function foldTail(add: AddCounter, dimNone: string, tail: NonNullable<LiveRiderCarrier['tail']>): void {
  add(LIVE_METRICS.tailReads, dimNone, tail.reads)
  add(LIVE_METRICS.tailReopens, dimNone, tail.reopens)
  add(LIVE_METRICS.tailReadP95, String(tail.p95Bucket), 1)
  add(LIVE_METRICS.tailReadMax, String(tail.maxBucket), 1)
  add(LIVE_METRICS.tailOver100, dimNone, tail.over100)
  add(LIVE_METRICS.tailOver500, dimNone, tail.over500)
  add(LIVE_METRICS.tailDeltaBytes, String(tail.deltaBytesBucket), 1)
  add(LIVE_METRICS.tailLogSize, String(tail.logSizeBucket), 1)
}

/** …and the state group, for the same reason. Every row here is one report and every one of them
 *  is dimensioned, so the six share a total and can be read against each other. */
function foldState(add: AddCounter, state: NonNullable<LiveRiderCarrier['state']>): void {
  add(LIVE_METRICS.stateOverlaysOpen, windows(state.overlaysOpen), 1)
  add(LIVE_METRICS.stateOverlaysLocked, windows(state.overlaysLocked), 1)
  add(LIVE_METRICS.statePresence, flag(state.presenceOn), 1)
  add(LIVE_METRICS.stateRing, flag(state.ringOn), 1)
  add(LIVE_METRICS.stateFreeMem, String(state.freeMemBucket), 1)
  add(LIVE_METRICS.stateWorkingSet, String(state.workingSetBucket), 1)
}
