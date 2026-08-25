// ============================================================================
// perfSeams.ts — WHO OWNED THE STALL (JOS-458).
// ============================================================================
//
// JOS-367 built two clocks and they answer a question with two arms: BOTH threads late ⇒ the
// machine, ONLY MAIN late ⇒ us. Field reports have now come back with the second arm lit
// (`coincident: 0`, tail reads 0 ms, main stalls of 250-1186 ms in the minute after `replayDone`),
// and at that point the instrument is finished talking. It says how LATE main was. It cannot say
// WHAT main was doing, so a real stall with an address still arrives as "the app hitched".
//
// This file is the vocabulary for the missing half. Two suspects, measured two different ways:
//
//   * GC — a `PerformanceObserver('gc')` on main. Field working sets are 1.6-1.7 GB and a major
//     mark-compact over a heap that size is a stop-the-world pause of exactly the reported
//     magnitude. It is measured rather than assumed because it is a HYPOTHESIS, and the honest
//     outcome of this ticket is as likely to be "GC was quiet, look elsewhere".
//   * SEAMS — a bracket around the six places main is known to do bounded-but-large work on its
//     own loop. A seam that was never entered reports nothing at all, which is the reading that
//     eliminates it.
//
// ================================ THE ENUM IS THE BRIGHT LINE ================================
// `PERF_SEAMS` IS CLOSED AND IT IS CLOSED ON PURPOSE. Both riders below travel: the bucketed half
// on the telemetry heartbeat, the millisecond half inside a user's bug report. A seam identifier
// that could be built from a module id, a character, a zone or a file path would be a string from
// the machine on a wire that carries none — the telemetry bright line, and the same rule
// `shared/telemetryLive.ts` states for every number it declares. So the seam is named at the CALL
// SITE from this list, the fold only ever copies members of this list, and the validators
// reconstruct their output by walking THIS array rather than the payload's own keys. A new seam is
// a source change in this file, visible in a diff, and never something a running app can invent.
//
// IT IMPORTS NOTHING, for `shared/telemetryLive.ts`'s reasons: it is read by the validators, the
// rollup, the ingest Lambda, the feedback block and main's own instrument, and it must compile
// under both of the repo's tsconfigs.

/**
 * THE SIX SEAMS, and why each one is a suspect rather than a guess.
 *
 *   moduleSnapshot     — `ipc/world.ts` serves one module's whole state to a hydrating window.
 *                        Synchronous, and its cost scales with how long the session has run.
 *   combatSnapshot     — the pull-snapshot variant's `combat:snapshot`. Same shape, different
 *                        model, and it is asked for repeatedly rather than once.
 *   registryFlush      — `registry.flushNow()`. Every module folds its pending delta at once,
 *                        on the loop, because an out-of-band write asked it to.
 *   inventoryLoad      — `loadInventoryNow()`. A file read plus a parse, on main.
 *   achievementsLoad   — `loadAchievementsNow()`. The same shape, a second file.
 *   worldRebuilt       — `sendWorldRebuilt()` fans a rebuild out to the main window and every
 *                        module-reading overlay. It is the one seam whose cost is a FAN-OUT, and
 *                        it fires in the minute after a fold — which is the window the field
 *                        reports are about.
 *
 * ORDER IS THE WIRE ORDER. Readers render in this order and the validators walk it, so it is
 * append-only in spirit: reordering it would reshuffle every rendered readout without changing a
 * single measurement.
 */
export const PERF_SEAMS = [
  'moduleSnapshot',
  'combatSnapshot',
  'registryFlush',
  'inventoryLoad',
  'achievementsLoad',
  'worldRebuilt'
] as const

export type PerfSeamName = (typeof PERF_SEAMS)[number]

/**
 * The window the ticket's goals are stated over: "max ms per 10s window, per seam".
 *
 * It is `PERF_INTERVAL_MS` (shared/feedbackPerf.ts) by value, and that is not a coincidence — a
 * seam reading and the main-lateness row it is meant to explain have to be indexable by the same
 * grid or a reader cannot line them up. The two constants are pinned equal in the tests rather
 * than one importing the other, because this file imports nothing.
 */
export const SEAM_WINDOW_MS = 10_000

/**
 * How long a seam call has to take before it is worth a TIMESTAMP in the ring.
 *
 * Equal to `LIVE_PROBE_REPORT_MS` (25 ms) by value and for its reason: below the point where a
 * timer's own lateness stops being the Windows quantum, a measurement is noise wearing a number's
 * name. Every call is still counted and still folded into the running max — only the ring is
 * gated, because the ring is the part that costs an allocation.
 */
export const SEAM_LATE_MS = 25

/** …and what makes a seam call a STALL rather than a slow moment: `LIVE_STALL_LATE_MS` by value,
 *  a tenth of a second, past which a person watching has seen something. */
export const SEAM_STALL_MS = 100

/**
 * GC pause kinds, folded from V8's own four into the three distinctions that predict a stall.
 *
 * `major` is the mark-compact that stops the world over the whole heap and is the one this ticket
 * suspects; `minor` is a scavenge of the young generation and is measured in hundreds of
 * microseconds; `other` collects incremental marking steps and weak-callback processing, which are
 * real pauses but not the shape being hunted. Three members rather than V8's four so that a future
 * V8 that renames or adds a kind lands in `other` instead of failing a validator.
 */
export const GC_KINDS = ['minor', 'major', 'other'] as const

export type GcKind = (typeof GC_KINDS)[number]

// ---- the LOCAL (millisecond) shapes ----------------------------------------------------------
//
// The same split `perfLive.ts` keeps against `telemetryLive.ts`: raw milliseconds live in the
// process and in a user-initiated bug report, bucket indices are what leaves on a heartbeat. Two
// sets of types so nothing can accidentally send the wrong one.

/** One seam's account of an interval, in milliseconds. A seam never entered has NO entry — which
 *  is the reading that eliminates it, and is a different claim from `maxMs: 0`. */
export interface SeamTallyEntry {
  calls: number
  /** Calls at or over `SEAM_STALL_MS`. Kept BESIDE the max rather than derived from it, because
   *  "one seam call in this interval was slow" and "eleven were" are the difference between a
   *  one-off and a regression, and a maximum cannot tell them apart. */
  over100Calls: number
  maxMs: number
  totalMs: number
  /** `Date.now()` when the worst call ENDED. The reason a reader can line this up against the
   *  lateness row that made them open the dialog. */
  worstAt: number
}

/** Every seam that was entered this interval. Drained and reset by whichever report fires first,
 *  exactly as `takeLiveProbeReading()` is drained. */
export type SeamTally = Partial<Record<PerfSeamName, SeamTallyEntry>>

/** One GC-observer entry, as much of it as anything here needs. */
export interface GcSample {
  at: number
  ms: number
  kind: GcKind
}

/** The GC account of an interval, in milliseconds. */
export interface GcTally {
  pauses: number
  majorPauses: number
  maxMs: number
  totalMs: number
  /** Pauses at or over `SEAM_STALL_MS`. */
  over100: number
  /** `Date.now()` when the worst pause ended, or 0 when nothing was observed. */
  worstAt: number
}

/** A GC tally with nothing in it. Its own function so the accumulator's reset and the fold's
 *  identity element are the same eleven characters in one place. */
export function emptyGcTally(): GcTally {
  return { pauses: 0, majorPauses: 0, maxMs: 0, totalMs: 0, over100: 0, worstAt: 0 }
}

/** Whole, finite, non-negative. Every number here comes off a C++ boundary or a subtraction of two
 *  clocks, and both can produce a NaN. */
function ms(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0
}

/**
 * Fold one seam call into a tally. PURE — returns the new tally, never mutates its input, so the
 * arithmetic that decides which call is "the worst" is pinned by tests rather than inferred from a
 * session nobody can re-run.
 *
 * Ties go to the FIRST call that reached the maximum, `foldBlockSamples`' stated choice, for its
 * reason: two runs of the same seam then describe the same call.
 */
export function addSeamCall(tally: SeamTally, seam: PerfSeamName, took: number, at: number): SeamTally {
  const took0 = ms(took)
  const stall = took0 >= SEAM_STALL_MS ? 1 : 0
  const prior = tally[seam]
  const entry: SeamTallyEntry =
    prior === undefined
      ? { calls: 1, over100Calls: stall, maxMs: took0, totalMs: took0, worstAt: ms(at) }
      : {
          calls: prior.calls + 1,
          over100Calls: prior.over100Calls + stall,
          maxMs: Math.max(prior.maxMs, took0),
          totalMs: prior.totalMs + took0,
          worstAt: took0 > prior.maxMs ? ms(at) : prior.worstAt
        }
  return { ...tally, [seam]: entry }
}

/** Fold one GC pause into a tally. Pure, for `addSeamCall`'s reason. */
export function addGcPause(tally: GcTally, sample: GcSample): GcTally {
  const took = ms(sample.ms)
  return {
    pauses: tally.pauses + 1,
    majorPauses: tally.majorPauses + (sample.kind === 'major' ? 1 : 0),
    maxMs: Math.max(tally.maxMs, took),
    totalMs: tally.totalMs + took,
    over100: tally.over100 + (took >= SEAM_STALL_MS ? 1 : 0),
    worstAt: took > tally.maxMs ? ms(sample.at) : tally.worstAt
  }
}

/**
 * THE WORST SEAM of an interval, or `null` when none was entered.
 *
 * It exists so that "name the culprit" is answered in ONE place rather than by each of the three
 * readers deciding for itself which number is the headline. `null` is a real answer and is not
 * "nothing was slow": it means no instrumented seam ran at all in the window, which — beside a
 * main-lateness reading that is not zero — is itself the finding.
 */
export function worstSeam(tally: SeamTally): { seam: PerfSeamName; entry: SeamTallyEntry } | null {
  let best: { seam: PerfSeamName; entry: SeamTallyEntry } | null = null
  for (const seam of PERF_SEAMS) {
    const entry = tally[seam]
    if (entry === undefined) continue
    if (best === null || entry.maxMs > best.entry.maxMs) best = { seam, entry }
  }
  return best
}

// ---- the WIRE (bucketed) shapes --------------------------------------------------------------
//
// Bucket indices only, into `LIVE_STALL_MS_EDGES` (shared/telemetryLive.ts). The edges are NOT
// imported here — this file declares shapes and the fold that produces them lives at the telemetry
// seam (`main/telemetry/liveFacts.ts`), which is the one place a millisecond becomes a decade.

/** One seam's interval, bucketed. Present only for a seam that was actually entered. */
export interface SeamStatsEntry {
  calls: number
  /** Worst single call, as an index into `LIVE_STALL_MS_EDGES`. */
  maxBucket: number
  /** Calls at or over `SEAM_STALL_MS` — the count that makes a fleet-wide "this seam owns the
   *  stalls" readable without a percentile over a population of one. */
  over100: number
}

/**
 * THE SEAM RIDER. A partial record keyed by the closed enum above, so a seam that never ran is
 * ABSENT rather than a row of zeros — the same distinction `TailReadStats`' omission carries, and
 * for the same reason: zeros from a seam that did not run would drag every fleet figure toward an
 * app that did no work.
 */
export type SeamStallStats = Partial<Record<PerfSeamName, SeamStatsEntry>>

/**
 * THE GC RIDER. Absent when the observer never fired — which on a healthy short session is normal
 * and is not "no GC pauses were observed", it is "this session has no GC reading".
 */
export interface GcStallStats {
  pauses: number
  /** Mark-compacts specifically: the stop-the-world kind, and the ticket's actual suspect. */
  majorPauses: number
  /** Worst single pause / total time in GC, as indices into `LIVE_STALL_MS_EDGES`. */
  maxBucket: number
  totalBucket: number
  /** Pauses at or over `SEAM_STALL_MS`. */
  over100: number
}
