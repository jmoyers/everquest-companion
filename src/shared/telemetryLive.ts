// ============================================================================
// telemetryLive.ts — THE LIVE-SESSION RIDERS' half of the contract (JOS-367).
// ============================================================================
//
// WHAT THIS MEASURES, AND WHY IT IS SHAPED AS A COINCIDENCE TEST. Field reports describe ~1 s
// EverQuest render freezes while this app runs. We cannot measure the game's frame time without
// injecting into it, so the best available proxy is TWO CLOCKS OF OUR OWN: a lateness probe on
// main, and the same probe on a thread that does nothing else (`src/main/perfProbeWorker.ts`).
// A window in which BOTH went late is the MACHINE stalling — paging, a driver reset, a DPC storm,
// a disk that stopped answering. A window in which only main went late is US. `coincident` is
// that verdict, counted, and it is the one number here no single-threaded instrument can produce.
//
// Beside it rides what our TAIL READS COST (`src/main/log/tailIoStats.ts`), because the tail sits
// on the very file EverQuest appends to synchronously from its render thread — so "shared-file
// contention" and "system-wide stall on a low-RAM box" become two different readings instead of
// one shrug — and a handful of SESSION STATE flags, so a stall reading can be read against what
// the app was actually doing at the time.
//
// A SEPARATE FILE FROM `./telemetry.ts` FOR THE REASON EVERY SPLIT IN THIS SET HAS BEEN MADE: the
// contract sits at the repo's 400-code-line ceiling, and these three groups plus their three
// ladders do not fit. Importers reach in here directly (the `telemetryStartup.ts` precedent) —
// `./telemetry.ts` names the two events these ride on and points at this file; nothing is
// re-exported, so there is exactly one place each of these names is spelled.
//
// IT IMPORTS ONE ZERO-IMPORT SIBLING AND NOTHING ELSE. It used to import nothing at all, like the
// contract it belongs to; JOS-458 added two more riders whose vocabulary has to be shared with the
// call sites that PRODUCE them (`shared/perfSeams.ts` — a seam is named at the bracket, in
// milliseconds, long before anything is bucketed), and that file is itself zero-import. So the
// properties this rule was protecting are intact: it is read by the validators, the rollup, the
// doc generator and the ingest Lambda, it drags no runtime dependency into any of them, and it
// compiles under both of the repo's tsconfigs.
import type { GcStallStats, SeamStallStats } from './perfSeams'
//
// EVERY NUMBER IS A COUNT OR A BUCKET INDEX. There is no field here a character, a zone, a spell,
// a path or a line of log could go in — the ladders exist so that a millisecond, a byte count or
// a free-memory figure becomes a decade before it is ever assigned.

/**
 * OBSERVED LATENESS OF A 250 ms PROBE, LIVE — 10 / 25 / 50 / 100 / 250 / 500 / 1000 / 2500 ms
 * ⇒ nine buckets.
 *
 * NOT `STUTTER_MS_EDGES`, and the difference is the whole ticket. That ladder tops out at 250 ms
 * because it describes a STARTUP fold, where a quarter-second hitch is already the worst thing
 * that happens; the freezes this one hunts are reported as about a second, and a ladder whose top
 * bucket is "≥ 250 ms" would put a 300 ms hiccup and a 3 s lockup in the same row and answer
 * nothing. The low edges are kept anyway (10 / 25 sit around Windows' 15.6 ms timer quantum), so
 * an ordinary session still reads as a distribution rather than as an empty bottom bucket.
 *
 * The same ladder measures the TAIL's read latency (`TailReadStats`) on purpose: "our read leg
 * took 600 ms" and "our main loop was 600 ms late" are the two halves of one story, and they can
 * only be read against each other if they are counted in the same decades.
 */
export const LIVE_STALL_MS_EDGES = [10, 25, 50, 100, 250, 500, 1_000, 2_500] as const

/**
 * FREE PHYSICAL MEMORY IN GIBIBYTES — 0.5 / 1 / 2 / 4 / 8 ⇒ six buckets.
 *
 * The low edges are where the answer is: a box with under half a gibibyte free is a box that is
 * PAGING, which is the leading candidate for a whole-system stall that hits the game and this app
 * in the same window. Everything above 8 GB free only has to say "plenty". A ratio against
 * installed memory is deliberately not sent — `setupSnapshot.totalMemBucket` already carries the
 * denominator, and the pair reads better than a derived number nobody can check.
 */
export const FREE_MEM_GB_EDGES = [0.5, 1, 2, 4, 8] as const

/**
 * THIS APP'S OWN RESIDENT FOOTPRINT, summed across its processes, in MEBIBYTES — 200 / 400 / 800 /
 * 1200 / 2000 ⇒ six buckets.
 *
 * It is the honesty term. Every other number here can be read as "the machine did something to
 * us"; this one is what we were costing the machine while it did. A stall population that
 * clusters in the top bucket is a report about US, and the ladder has to be able to say so.
 */
export const WORKING_SET_MB_EDGES = [200, 400, 800, 1_200, 2_000] as const

/**
 * HOW LATE OUR OWN CLOCKS RAN over the interval since the previous session report.
 *
 * FOLDED AND RESET PER REPORT, exactly as `linesParsed` is, so a fleet-wide sum is a sum of
 * deltas and a killed session loses at most its last window rather than double-counting an
 * earlier one.
 *
 * ALL SIX OR NONE (`coincident` excepted, below). A percentile with no maximum beside it cannot
 * say whether a distribution moved or one tick fell over, and a late-tick count with no sample
 * count under it is not a rate — the same refusal `StartupStutterStats` makes, for the same
 * reason.
 */
export interface LiveStallStats {
  /** Probe ticks main observed this interval. The denominator for everything below. */
  samples: number
  /** 95th-percentile main-thread lateness, as an index into `LIVE_STALL_MS_EDGES`. */
  p95Bucket: number
  /** The single worst tick, same ladder — the number a person actually felt. */
  maxBucket: number
  /** Ticks at least 100 ms / 500 ms late: a dropped frame's worth, and a visible freeze. */
  over100: number
  over500: number
  /**
   * THE VERDICT: windows in which BOTH main and the dedicated probe worker were at least 100 ms
   * late within half a second of each other — i.e. the MACHINE stalled, not us.
   *
   * OPTIONAL, and absent means UNKNOWN rather than zero: the worker probe failed to start, died,
   * or the platform refused it. Zero is a real and very different answer — two threads that both
   * kept time, or a session where only main went late, which is the reading that says the fault
   * is ours.
   */
  coincident?: number
}

/**
 * WHAT THE LIVE TAIL'S READS COST over the same interval (`src/main/log/tailIoStats.ts` is the
 * instrument; this is its wire shape).
 *
 * WHY IT RIDES BESIDE THE STALL NUMBERS. The tail reads the file the game is appending to, from
 * its render thread, synchronously. If our reads are what the freezes are made of, the two rows
 * move together on the same installs; if they are not, this is the field that says so — and it is
 * the same argument in the other direction as `coincident`.
 *
 * OMITTED ENTIRELY when no character is attached. A session that never tailed anything has no
 * read latency to describe, and a row of zeros from it would drag every fleet-wide figure toward
 * a machine that did no work (`takeTailIoSummary`'s own `null` makes that mechanical).
 */
export interface TailReadStats {
  /** Read cycles — one chokidar wake, however many bounded slices it took to catch up. */
  reads: number
  /** Cycles that had to OPEN a handle. The steady state is zero (JOS-363); a rotating or failing
   *  tail is not, and the two are worth telling apart under a stall report. */
  reopens: number
  /** 95th-percentile / worst read leg, as indices into `LIVE_STALL_MS_EDGES` — the same ladder
   *  the main-loop lateness above uses, so the two can be read against each other. */
  p95Bucket: number
  maxBucket: number
  /** Read cycles over 100 ms / 500 ms. */
  over100: number
  over500: number
  /** The BIGGEST SINGLE delta read this interval, as an index into `NEW_BYTES_EDGES`. A single
   *  fat catch-up read is a different event from the same bytes arriving in a hundred small ones,
   *  and only the big one can plausibly stall an appender. */
  deltaBytesBucket: number
  /** Size of the attached log at report time, as an index into `LOG_SIZE_BYTES_EDGES` — the
   *  context every read figure above is read in. */
  logSizeBucket: number
}

/**
 * WHAT THE APP WAS DOING while the numbers above were taken. Flags and buckets only.
 *
 * This is the smallest set that can turn a stall reading into a lead: an armed low-level mouse
 * hook (`overlaysLocked`) puts every system mouse event through our message loop, a presence
 * watcher is a second thread polling the OS, and a machine with no memory left behaves nothing
 * like one with room. None of it is a preference audit — `setupSnapshot` already reports what the
 * install is SET to; this reports what was running in the window that stalled.
 */
export interface SessionStateStats {
  /** Overlay windows open at report time. */
  overlaysOpen: number
  /**
   * How many of those are LOCKED — click-through, which on Windows means each one is forwarding
   * mouse events and the process-wide `WH_MOUSE_LL` hook is ARMED. That hook makes every system
   * mouse event wait on our message loop, so a blocked main can freeze a cursor system-wide; a
   * stall population that lives entirely at `overlaysLocked > 0` is the single most actionable
   * reading this rider can produce.
   */
  overlaysLocked: number
  /** Is the presence watcher wanted by this install's preferences (a second thread polling the
   *  OS for the game's window)? */
  presenceOn: boolean
  /** Is the cursor ring on (the app's only high-frequency timer)? */
  ringOn: boolean
  /** Free physical memory, as an index into `FREE_MEM_GB_EDGES`. */
  freeMemBucket: number
  /** This app's summed resident memory, as an index into `WORKING_SET_MB_EDGES`. */
  workingSetBucket: number
}

/**
 * ALL FIVE RIDERS, AS ONE CARRIER — what `sessionHeartbeat` and `sessionEnd` both extend.
 *
 * IT IS A CARRIER RATHER THAN FIVE FIELDS SPELLED TWICE, and that is a factoring decision with a
 * correctness consequence. `shared/telemetry.ts` sits at the repo's 400-code-line ceiling, and ten
 * lines of rider declaration across two events is what took it past — but the reason to fix it
 * HERE rather than by trimming something else is that the two events must never drift: a session
 * that ends before its first heartbeat is the common case AND is disproportionately the bad one,
 * so a rider that rode only the heartbeat would be missing from exactly the reports worth having.
 * Declared once, extended twice, and `Pick<EvSessionHeartbeat, …>` still resolves through it, so
 * every existing importer is unchanged.
 *
 * EVERY GROUP IS INDEPENDENTLY OPTIONAL, and every absence means something specific rather than
 * zero — the individual declarations say which.
 */
export interface SessionRiders {
  /** How late our two clocks ran since the previous report (JOS-367). Absent: the probe never
   *  observed a tick, which is not a smooth interval — it is no interval. */
  live?: LiveStallStats
  /** What the live tail's reads cost over the same interval. Absent: nothing was attached. */
  tail?: TailReadStats
  /** What the app was doing while the two above were measured. */
  state?: SessionStateStats
  /** What V8 spent over the same interval (JOS-458). Absent: the GC observer was not running —
   *  never "no collections happened", which a running observer reports as zeros. */
  gc?: GcStallStats
  /** Which of our own seams ran, and what the worst call cost (JOS-458). Absent: none of the six
   *  ran at all, which — read beside a `live` reading that is not zero — is itself the finding. */
  seams?: SeamStallStats
}
