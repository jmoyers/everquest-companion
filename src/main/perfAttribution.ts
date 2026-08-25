// ============================================================================
// perfAttribution.ts — THE INSTRUMENT THAT NAMES THE CULPRIT (JOS-458).
// ============================================================================
//
// `livePerfProbe.ts` measures how LATE main was and, with its second thread, whether the machine
// was late with it. Two field reports have now come back with that verdict pointing squarely at
// us — `coincident: 0`, tail read legs at 0 ms, and main-process stalls of 250-1186 ms in the
// minute after `replayDone` — and at that point the two clocks have said everything they can. A
// stall with a magnitude, a timestamp and no owner is still un-actionable.
//
// So this file measures the OTHER side of the same seconds. Two instruments, two hypotheses:
//
//   * A `PerformanceObserver('gc')`. Field working sets are 1.6-1.7 GB, and a major mark-compact
//     over a heap that size stops the world for exactly the reported magnitude. It is a SUSPECT,
//     not a conclusion — a run that reports quiet GC beside a 900 ms stall has eliminated it, and
//     that is worth as much as a run that convicts it.
//   * A bracket around six named seams (`shared/perfSeams.ts PERF_SEAMS`), each one a place main
//     is known to do bounded-but-large work on its own loop. A seam never entered reports NOTHING
//     — absence is the reading that clears it.
//
// ============================ THE TWO HALVES START AT DIFFERENT TIMES ============================
// AND THAT IS DELIBERATE RATHER THAN AN OVERSIGHT, so it is stated where a reader will look:
//
//   * THE SEAM BRACKETS ARE LIVE FROM PROCESS START. `timeSeam` records unconditionally; nothing
//     gates it on `startStallAttribution`. That is the correct behaviour and not a leak, because
//     a seam tally is a PER-SEAM MAX AND COUNT, never a distribution — the argument that keeps the
//     lateness probe out of the fold (JOS-367: a replay's own fold is not a live stall, and a
//     population mixing them answers neither question) simply does not apply to a max. And the
//     launch's OWN first `registryFlush` and `worldRebuilt` happen at the end of `tailCharacter`,
//     one statement before `startTailing()` resolves — i.e. BEFORE `markStartupPhase('replayDone')`
//     is even called. Those two are the cold fan-out: the single most interesting instance of the
//     seam this ticket suspects most. Gating the brackets on the mark would have silently excluded
//     exactly them.
//   * THE GC OBSERVER STARTS AT `replayDone`, beside `startLiveProbe`. A 1.4M-event fold generates
//     enormous garbage that is nothing like a running session's, and `gc` IS a population — the
//     fleet reads `gcPauses` over `gcReports`. Mixing a boot into that would move every install's
//     numbers by an amount that depends on how big its log is.
//
// The consequence, stated plainly: the FIRST drained interval of a session carries seam readings
// from the launch and GC readings only from after it. Both are honest about their own window.
//
// A LEAF, LIKE `livePerfProbe.ts` AND `log/tailIoStats.ts`, AND FOR THE SAME TWO REASONS. It is
// plain data in memory with no idea the user's telemetry switch exists (the telemetry seam drains
// it and applies the gate, once, where every other producer does), and it must not join an import
// cycle: `perf.ts` starts it, `telemetry/liveRiders.ts` drains it, `feedback/perf.ts` peeks it, and
// six seams across `ipc/`, `modules/`, `pipeline.ts` and `session.ts` call into it. It imports the
// pure vocabulary and `node:perf_hooks` and nothing else — anything more would make one of those
// six callers a cycle.
//
// ============================ WHAT IT COSTS, MEASURED =============================
// Rule 1 of perf.ts's performance contract is that an instrument which costs something is a bug,
// so this one states its bill rather than promising it is small. MEASURED on the dev box, node
// v24.18.1, over 1e6 / 1e5 iterations against a bare-call baseline in the same process:
//
//   * A SEAM BRACKET: 165 ns per call — two `performance.now()` reads, a subtraction, and one
//     six-key tally rebuild. The busiest of the six is `combatSnapshot` at roughly one call a
//     second, so the whole seam layer costs well under a microsecond of CPU per second of wall
//     clock. `timeSeam` wraps a SYNCHRONOUS body and returns its value, so it adds no scheduling
//     and cannot itself become the stall it is looking for; none of the six is `async`.
//   * THE RING PUSH, the arm a LATE call additionally takes: 104 ns. It is separately priced
//     because it allocates, and because the first spelling of `trim` cost 2,949 ns — see
//     `RING_KEEP` for the compaction that fixed it and why the naive version was a real bug.
//   * OUR HALF OF A GC CALLBACK: 74 ns per entry.
//   * THE GC OBSERVER ITSELF: BELOW WHAT THIS MEASUREMENT CAN RESOLVE. An interleaved A/B over
//     three passes of an allocation-churning workload (12 collections actually delivered) came out
//     at -1 ms of CPU with the observer attached — i.e. inside the noise of `process.cpuUsage()`,
//     which is the same honest answer `livePerfProbe.ts` gives about its own two timers. It is a
//     native hook V8 already runs; what we add per collection is the 74 ns above.
//
// ONE MEASURED FACT WORTH KEEPING, because it will cost the next person an afternoon: a forced
// `global.gc()` EMITS NO `gc` PERFORMANCE ENTRY on node v24 — a loop of them with an observer
// attached and the microtask queue drained delivers exactly zero. Natural churn across real
// event-loop turns delivers them normally (minor, major and weakcb kinds all observed). So a test
// that wants a GC pause cannot manufacture one on demand; `noteGcSamples` exists for that reason.

import { PerformanceObserver, constants, type PerformanceEntry } from 'node:perf_hooks'
import {
  addGcPause,
  addSeamCall,
  emptyGcTally,
  SEAM_LATE_MS,
  type GcKind,
  type GcSample,
  type GcTally,
  type PerfSeamName,
  type SeamTally
} from '../shared/perfSeams'
import { LIVE_TIMELINE_MS } from '../shared/perfLive'

/** One late seam call, timestamped, for the ten-minute ring a bug report reads. */
export interface SeamRingSample {
  at: number
  seam: PerfSeamName
  ms: number
}

/** The un-reset rings, as `peekAttributionTimeline()` answers with. Same posture as
 *  `peekLiveTimeline()`: pure data on the user's own machine, nothing bucketed, nothing sent. */
export interface AttributionTimeline {
  seams: readonly SeamRingSample[]
  gc: readonly GcSample[]
}

// ---- state ---------------------------------------------------------------------------------
//
// TWO STRUCTURES PER SUBJECT, the `tailIoStats.ts` / `livePerfProbe.ts` shape: an ACCUMULATOR that
// a report drains and resets, and a RING that it does not. A fold and a shape are different
// questions, and a reader of one must not silently consume the other.

let observer: PerformanceObserver | null = null
/** Every seam entered since the last drain. */
let seamTally: SeamTally = {}
/** The GC account since the last drain. `null` while the observer is not running — which is the
 *  distinction between "no reading available" and "a reading of zero pauses". */
let gcTally: GcTally | null = null
/** ~10 minutes of late seam calls and GC pauses, never drained by a report. */
const seamRing: SeamRingSample[] = []
const gcRing: GcSample[] = []

/**
 * The ring's hard cap, BESIDE its time bound.
 *
 * The time bound alone is what `livePerfProbe.ts` uses, and it is enough there because that probe
 * ticks on a fixed cadence — ten minutes of samples is a number known in advance. These two rings
 * are driven by the app's own behaviour instead: a pathological session could enter a seam
 * thousands of times a second, and a ring bounded only by time would then be a memory leak inside
 * the instrument that is looking for one. Whichever bound bites first wins, oldest dropped.
 */
const RING_CAP = 2_000

/**
 * How far under the cap a compaction cuts back to. It exists because the naive spelling — drop
 * exactly one when the cap is exceeded — makes every subsequent push an O(cap) `splice`, and that
 * is a REAL cost rather than a theoretical one: MEASURED at 2,949 ns per late call against 295 ns
 * for the same loop once the compaction is amortized, a 10× tax paid by precisely the pathological
 * session this instrument exists to describe. Cutting back by a slice means one `splice` per
 * `RING_CAP - RING_KEEP` pushes and an amortized constant.
 */
const RING_KEEP = 1_600

/** Drop everything older than the ring's span, then compact if the cap is exceeded. Called on the
 *  write, so the bound is enforced by the only thing that can violate it. */
function trim(ring: { at: number }[], now: number): void {
  const cutoff = now - LIVE_TIMELINE_MS
  let drop = 0
  while (drop < ring.length && ring[drop].at < cutoff) drop++
  if (ring.length - drop > RING_CAP) drop = ring.length - RING_KEEP
  if (drop > 0) ring.splice(0, drop)
}

// ---- the seam bracket ------------------------------------------------------------------------

/**
 * Time one synchronous seam and return what it returned.
 *
 * IT IS A PASS-THROUGH AND IT MUST STAY ONE. A wrapper that swallowed a throw would change what
 * the app does in order to measure it, so the `finally` records the call and the exception keeps
 * travelling — a seam that threw still took the time it took, and that reading is if anything the
 * more interesting one.
 */
export function timeSeam<T>(seam: PerfSeamName, run: () => T): T {
  const started = performance.now()
  try {
    return run()
  } finally {
    noteSeam(seam, performance.now() - started)
  }
}

/**
 * Record a seam call whose duration the caller already has.
 *
 * It exists for the seams `timeSeam` cannot wrap without restructuring the call site around it —
 * and for the tests, which must be able to state a duration rather than produce one. The two
 * paths fold into the same tally, so nothing downstream can tell them apart.
 */
export function noteSeam(seam: PerfSeamName, tookMs: number, at = Date.now()): void {
  seamTally = addSeamCall(seamTally, seam, tookMs, at)
  if (tookMs < SEAM_LATE_MS) return
  seamRing.push({ at, seam, ms: Math.round(tookMs) })
  trim(seamRing, at)
}

// ---- the GC observer -------------------------------------------------------------------------

/**
 * V8's kind constant → our three-member fold. Anything V8 adds or renames lands in `other` rather
 * than failing a validator downstream — `GC_KINDS` states that trade where the enum is declared.
 */
function gcKindOf(kind: number | undefined): GcKind {
  if (kind === constants.NODE_PERFORMANCE_GC_MAJOR) return 'major'
  if (kind === constants.NODE_PERFORMANCE_GC_MINOR) return 'minor'
  return 'other'
}

/** One `gc` entry from the observer. `entry.duration` is the pause in milliseconds and
 *  `entry.startTime` is on `performance.now()`'s clock, so the ring's `at` is derived rather than
 *  read — `Date.now()` at callback time would place the pause after itself. */
function noteGcEntry(entry: PerformanceEntry): void {
  const detail = (entry as { detail?: { kind?: number } }).detail
  const at = Math.round(Date.now() - (performance.now() - (entry.startTime + entry.duration)))
  const sample: GcSample = { at, ms: entry.duration, kind: gcKindOf(detail?.kind) }
  gcTally = addGcPause(gcTally ?? emptyGcTally(), sample)
  if (sample.ms < SEAM_LATE_MS) return
  gcRing.push({ ...sample, ms: Math.round(sample.ms) })
  trim(gcRing, at)
}

// ---- lifecycle -------------------------------------------------------------------------------

/**
 * Start THE GC OBSERVER — and only it; the seam brackets have been recording since process start
 * (see the header for why the two halves differ, and why that is the right way round).
 *
 * Idempotent, and called from `markStartupPhase('replayDone')` beside `startLiveProbe()` — the
 * same moment, for the same reason JOS-367 chose it: a replay's own fold is not a live stall, and
 * a population that mixed the two could answer neither question.
 *
 * A platform that refuses the observer is NOT an error the user should hear about and not a reason
 * to lose the seam readings: `gcTally` simply stays `null`, and absent is a documented answer
 * meaning "there was no GC reading", never "there were no GC pauses".
 */
export function startStallAttribution(): void {
  if (observer !== null) return
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) noteGcEntry(entry)
    })
    obs.observe({ entryTypes: ['gc'] })
    gcTally = emptyGcTally()
    observer = obs
  } catch {
    gcTally = null
  }
}

/** Stop the observer. Called from `stopPerf` (window-all-closed), and safe to call twice. The
 *  tallies are left standing so a report composed during teardown still has them. */
export function stopStallAttribution(): void {
  if (observer !== null) observer.disconnect()
  observer = null
}

// ---- the two readers -------------------------------------------------------------------------

/**
 * FOLD AND RESET, for the interval reporter — `takeLiveProbeReading()`'s discipline, for the same
 * no-double-counting reason: whichever session report fires first drains it, so a fleet-wide sum is
 * a sum of deltas and a killed session loses at most its last window.
 *
 * `null` when NO seam was entered this interval, and that is not a row of zeros: it says the six
 * instrumented places did no work at all, which — beside a lateness reading that is not zero — is
 * itself the finding, and is what clears all six at once.
 */
export function takeSeamTally(): SeamTally | null {
  const tally = seamTally
  seamTally = {}
  return Object.keys(tally).length === 0 ? null : tally
}

/**
 * The GC account, drained. `null` ONLY when the observer is not running — a running observer that
 * saw nothing answers with zeros, because "we watched and V8 never collected" is a measurement and
 * "we were not watching" is not.
 */
export function takeGcTally(): GcTally | null {
  const tally = gcTally
  if (gcTally !== null) gcTally = emptyGcTally()
  return tally
}

/**
 * THE LAST ~10 MINUTES, unreset — the SHAPE rather than the fold, for the bug report that wants to
 * say which seam owned a freeze the user is complaining about.
 *
 * PURE DATA, NO WIRE, the posture `peekLiveTimeline()` takes one file over: nothing here is
 * bucketed, nothing here is sent, and nothing here consults the user's switch. The seam NAMES in
 * it are members of a closed enum compiled into the app, never strings the machine produced.
 */
export function peekAttributionTimeline(now = Date.now()): AttributionTimeline {
  const cutoff = now - LIVE_TIMELINE_MS
  return {
    seams: seamRing.filter((s) => s.at >= cutoff),
    gc: gcRing.filter((s) => s.at >= cutoff)
  }
}

/** Test seam: forget everything, stop everything. Never called by the app. */
export function resetStallAttribution(): void {
  stopStallAttribution()
  seamTally = {}
  gcTally = null
  seamRing.length = 0
  gcRing.length = 0
}

/**
 * Test seam: inject GC pauses as though the observer had reported them. It exists because the
 * thing worth pinning is the ARITHMETIC over a pause — and a test that had to make V8 stop the
 * world for 600 ms to check the fold would be a test about the machine running it. The observer
 * itself is watched by the e2e (tests/e2e/perf.e2e.mts).
 */
export function noteGcSamples(samples: readonly GcSample[]): void {
  for (const s of samples) {
    gcTally = addGcPause(gcTally ?? emptyGcTally(), s)
    if (s.ms < SEAM_LATE_MS) continue
    gcRing.push({ ...s, ms: Math.round(s.ms) })
    trim(gcRing, s.at)
  }
}
