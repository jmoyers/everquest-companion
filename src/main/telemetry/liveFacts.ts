// ============================================================================
// telemetry/liveFacts.ts — the live riders, as pure functions of what was measured (JOS-367).
// ============================================================================
//
// THE ARITHMETIC HALF OF THE PRODUCER, split from `./liveRiders.ts` for `setupFacts.ts`'s reason:
// everything here can be TESTED, and nothing here could be if it imported `electron`. The
// gathering half asks the probe, the tail, the windows and the OS what happened; this half turns
// those raw millisecond and byte counts into the bucket indices and whole numbers the wire schema
// allows, and it imports nothing but the contract and the probe's own local shapes.
//
// THAT SPLIT IS ALSO THE PRIVACY BOUNDARY, drawn where a reader can see it. Everything that
// leaves here is a count, a boolean or an index into a ladder declared in
// `shared/telemetryLive.ts`. A millisecond becomes a decade; a byte count becomes a decade; there
// is no path through this module by which a path, a character name or a line of a log could reach
// the ring, because none of its inputs can hold one.
//
// WHY THE PERCENTILES ARE COMPUTED HERE AND NOT STORED. `takeTailIoSummary()` deliberately keeps
// no p95 — "a percentile folded out of a reset accumulator is a percentile of nothing"
// (log/tailIoStats.ts) — so the tail's p95 is computed from its RING, over the samples that fall
// inside the interval being reported. That ring holds 600 samples, so an interval busier than
// that describes its own tail rather than all of it; the counts (`reads`, `over100`, `over500`)
// come from the accumulator and are exact either way.

import { bucketOf, LOG_SIZE_BYTES_EDGES, MAX_COUNT, NEW_BYTES_EDGES } from '../../shared/telemetry'
import {
  FREE_MEM_GB_EDGES,
  LIVE_STALL_MS_EDGES,
  WORKING_SET_MB_EDGES,
  type LiveStallStats,
  type SessionStateStats,
  type TailReadStats
} from '../../shared/telemetryLive'
import { percentile } from '../../shared/perf'
import type { LiveStallFold } from '../../shared/perfLive'
import {
  PERF_SEAMS,
  type GcStallStats,
  type GcTally,
  type SeamStallStats,
  type SeamTally
} from '../../shared/perfSeams'
import type { TailIoSample, TailIoSummary } from '../log/tailIoStats'

const KB = 1024
const MB = 1024 * 1024
const GB = 1024 * 1024 * 1024

/** Whole, non-negative, and inside the schema's ceiling for a count field. */
function count(n: number): number {
  return Math.max(0, Math.min(MAX_COUNT, Math.round(Number.isFinite(n) ? n : 0)))
}

/**
 * The stall reading (main thread), bucketed. `coincident` is passed through as a COUNT rather than
 * a bucket — it is small by construction and the number itself is the answer ("three times in ten
 * minutes the whole box paused"), where a decade would say almost nothing.
 *
 * Absent `coincident` stays absent: the contract's own distinction between "no second clock ran"
 * and "two clocks were compared and agreed on nothing", which is the difference between no verdict
 * and a verdict against us.
 */
export function liveStallStats(fold: LiveStallFold & { coincident?: number }): LiveStallStats {
  const stats: LiveStallStats = {
    samples: count(fold.samples),
    p95Bucket: bucketOf(fold.p95Ms, LIVE_STALL_MS_EDGES),
    maxBucket: bucketOf(fold.maxMs, LIVE_STALL_MS_EDGES),
    over100: count(fold.over100),
    over500: count(fold.over500)
  }
  if (fold.coincident !== undefined) stats.coincident = count(fold.coincident)
  return stats
}

/**
 * WHAT V8 SPENT, bucketed (JOS-458).
 *
 * `pauses` and `majorPauses` are COUNTS rather than buckets for `coincident`'s reason: they are
 * small by construction and the number itself is the answer ("four mark-compacts, one of them past
 * a tenth of a second"), where a decade would say almost nothing. The two millisecond figures ride
 * `LIVE_STALL_MS_EDGES` — deliberately the same ladder as the main-loop lateness they are meant to
 * explain, so "GC took 640 ms" and "main was 640 ms late" land in the same row.
 */
export function gcStallStats(tally: GcTally): GcStallStats {
  return {
    pauses: count(tally.pauses),
    majorPauses: count(tally.majorPauses),
    maxBucket: bucketOf(tally.maxMs, LIVE_STALL_MS_EDGES),
    totalBucket: bucketOf(tally.totalMs, LIVE_STALL_MS_EDGES),
    over100: count(tally.over100)
  }
}

/**
 * WHICH SEAMS RAN, bucketed (JOS-458).
 *
 * IT WALKS `PERF_SEAMS`, NEVER THE TALLY'S OWN KEYS, and that is the bright line made mechanical:
 * the output can only ever contain members of the compiled enum, so no key a running app could
 * invent — a module id, a character, a path — has a route onto this wire even if one somehow
 * reached the tally. A seam with no entry is left ABSENT rather than zero-filled, which is the
 * distinction `TailReadStats`' omission carries: zeros from a seam that did not run would drag
 * every fleet figure toward an app that did no work.
 */
export function seamStallStats(tally: SeamTally): SeamStallStats {
  const out: SeamStallStats = {}
  for (const seam of PERF_SEAMS) {
    const entry = tally[seam]
    if (entry === undefined) continue
    out[seam] = {
      calls: count(entry.calls),
      maxBucket: bucketOf(entry.maxMs, LIVE_STALL_MS_EDGES),
      over100: count(entry.over100Calls)
    }
  }
  return out
}

/** What the gathering half hands over about the tail: the interval's fold, the samples inside it,
 *  and how big the attached log is right now. */
export interface TailFacts {
  summary: TailIoSummary
  /** The read cycles from `peekTailIoTimeline()` that fall inside the reported interval. */
  window: readonly TailIoSample[]
  /** `stat().size` of the attached log, bytes. */
  logBytes: number
}

/**
 * The tail's read cost, bucketed.
 *
 * `deltaBytesBucket` IS A MAXIMUM, not a total, and that is the whole reason it is a separate
 * number from `summary.bytes`: the same megabyte arriving in one read and in a hundred are very
 * different events, and only the first can plausibly stall an appender. It rides `NEW_BYTES_EDGES`
 * because it is a delta — the ladder built for exactly that shape.
 */
export function tailReadStats(facts: TailFacts): TailReadStats {
  const legs = facts.window.map((s) => s.readMs)
  const maxDelta = facts.window.reduce((worst, s) => Math.max(worst, s.bytes), 0)
  return {
    reads: count(facts.summary.reads),
    reopens: count(facts.summary.reopens),
    // The p95 comes from the ring (see the header); the MAX comes from the accumulator, which
    // saw every cycle in the interval — so the worst read can never be under-reported by a ring
    // that had already rolled past it.
    p95Bucket: bucketOf(percentile(legs, 95), LIVE_STALL_MS_EDGES),
    maxBucket: bucketOf(facts.summary.maxReadMs, LIVE_STALL_MS_EDGES),
    over100: count(facts.summary.over100),
    over500: count(facts.summary.over500),
    deltaBytesBucket: bucketOf(maxDelta, NEW_BYTES_EDGES),
    logSizeBucket: bucketOf(facts.logBytes, LOG_SIZE_BYTES_EDGES)
  }
}

/** What the gathering half hands over about the app's own state. Memory arrives in KIBIBYTES,
 *  which is what both Electron sources answer in (`process.getSystemMemoryInfo`,
 *  `app.getAppMetrics()[].memory.workingSetSize`) — converted once, here. */
export interface StateFacts {
  overlaysOpen: number
  overlaysLocked: number
  presenceOn: boolean
  ringOn: boolean
  freeMemKb: number
  workingSetKb: number
}

/** What the app was doing while the two readings above were taken. */
export function sessionStateStats(facts: StateFacts): SessionStateStats {
  return {
    overlaysOpen: count(facts.overlaysOpen),
    overlaysLocked: count(facts.overlaysLocked),
    presenceOn: facts.presenceOn,
    ringOn: facts.ringOn,
    freeMemBucket: bucketOf((facts.freeMemKb * KB) / GB, FREE_MEM_GB_EDGES),
    workingSetBucket: bucketOf((facts.workingSetKb * KB) / MB, WORKING_SET_MB_EDGES)
  }
}
