// ============================================================================
// perf.ts — the main-process half of performance profiling.
// ============================================================================
//
// Two independent things live here, and they are wired from the composition root
// (`src/main/index.ts`) the same way `startQueueFlush` and `startTelemetry` are:
//
//   THE HUD SAMPLER — `app.getAppMetrics()` every 2 s plus an event-loop lag probe every
//   500 ms, aggregated into one `PerfSample` pushed to the renderer. It runs ONLY while the
//   user's switch is on.
//
//   THE STARTUP PROFILE — eight phase marks, recorded on EVERY launch whether the HUD is on or
//   off, written once to `<userData>/perf-startup.json`.
//
// ============================== THE PERFORMANCE CONTRACT ==============================
// An instrument that costs something when it is off is a bug, not a feature. Concretely:
//
//   1. NOTHING RUNS WHEN THE HUD IS OFF. No interval is created — not a skipped one, not a
//      no-op one. With the default install (`perfHud.enabled: false`) this module's entire
//      runtime cost is the eight `markStartupPhase` calls below (an array push each) plus the two
//      always-on startup probes, which exist only between `appReady` and `replayDone` and are
//      described where they are started.
//   2. EVERY TIMER IS `unref`'d, so none of them can be the reason the process outlives its
//      windows.
//   3. THE PUSH IS ONE MESSAGE PER 2 s, and only while a renderer exists to receive it.
//   4. MARKING IS FREE, WHICH IS WHY IT IS UNCONDITIONAL. `performance.now()` plus a push is
//      microseconds; the launch you wish you had profiled is always the one that already
//      happened (plan P4), so there is no switch to forget to turn on.
//
// The pure half — aggregation, lag stats, severity, phase accounting, formatting — is
// `src/shared/perf.ts` and is pinned by `tests/perf.test.mts`. What is left here is I/O.

import { app } from 'electron'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import {
  addMark,
  aggregateMetrics,
  buildProfile,
  describeMarkError,
  foldBlockSamples,
  foldStutterSamples,
  lagStats,
  PERF_LAG_PROBE_INTERVAL_MS,
  PERF_SAMPLE_INTERVAL_MS,
  phaseMarked,
  replayDutyOf,
  STARTUP_STUTTER_INTERVAL_MS,
  STARTUP_STUTTER_MIN_SAMPLES,
  totalsOf,
  type BlockSample,
  type PerfSample,
  type RawProcessMetric,
  type ReplayDutyStats,
  type StartupBlockStats,
  type StartupMark,
  type StartupPhase,
  type StartupProfile,
  type StartupStutterProbe
} from '../shared/perf'
import { formatDataWeight } from '../shared/dataWeight'
import { startupReplayStats } from '../shared/telemetryStartup'
// The per-file decomposition of the `dataLoaded` phase (JOS-458). A leaf holding one committed
// table plus this launch's own heap reading.
import { dataWeightLedger } from './dataWeight'
import { logError, logInfo } from './errorLog'
// THE LIVE HALF of the same subject (JOS-367), in its own leaf module for `tailIoStats.ts`'s two
// reasons: it is plain data that knows nothing about telemetry, and a leaf cannot join the import
// cycle that would otherwise form between this file and the seam that drains it.
import { startLiveProbe, stopLiveProbe } from './livePerfProbe'
// …and the half that says WHO (JOS-458), started and stopped in lockstep with it and a leaf for
// the identical two reasons. The two measurements are one window on purpose: a stall's magnitude
// and its owner have to describe the same seconds or neither can explain the other.
import { startStallAttribution, stopStallAttribution } from './perfAttribution'
// The fleet half of the same measurement (JOS-57). Through the telemetry FAÇADE, like every other
// producer in this app — the wiring may not reach around it into the ring.
import { noteStartupReplay, scheduleSetupSnapshot } from './telemetry'
import { sendToMain } from './windows'

const PROFILE_FILE = 'perf-startup.json'

// ------------------------------------------------------------------------ startup marking

/**
 * Wall clock of this launch, captured against `performance.timeOrigin` — the process's OWN
 * start, not this module's evaluation. That distinction is the whole point: the earliest phase
 * (`storeLoaded`) measures work that finished before anything in this file ran, and a start
 * captured at module scope would silently exclude it.
 */
const LAUNCH_STARTED_AT = Math.round(performance.timeOrigin)

let marks: StartupMark[] = []
let eventsReplayed: number | undefined
let replayStats: ReplayDutyStats | undefined
let replayBytes: number | undefined
// JOS-57's scope addition, both arriving with `replayDone` and both meaning UNKNOWN while unset.
let newBytes: number | undefined
let firstMbMs: number | undefined
let profileWritten = false

// ------------------------------------------------------------------- the startup block probe
//
// ALWAYS ON, from `appReady` to `replayDone` (docs/plans/chunked-replay.md §2). The HUD's probe
// below is the same measurement asked of a running app and gated on the user's switch; this one
// is asked of the boot itself and gated on nothing, because a boot happens once and cannot be
// re-run with the instrument turned on afterwards.
//
// It obeys the same performance contract as everything else in this file: ONE unref'd timer, for
// the few seconds a replay lasts, and nothing at all outside that window.

let blockTimer: ReturnType<typeof setInterval> | null = null
let blockDrifts: BlockSample[] = []
let blockDueAt = 0
let blockStats: StartupBlockStats | undefined

/** Start measuring the main loop's lateness. Idempotent; the window is opened by `appReady`. */
function startStartupBlockProbe(): void {
  if (blockTimer !== null) return
  blockDrifts = []
  blockDueAt = performance.now() + PERF_LAG_PROBE_INTERVAL_MS
  blockTimer = setInterval(() => {
    const now = performance.now()
    // `atMs` is the SAME clock the phase marks use (`performance.now()` against timeOrigin), so
    // the worst block can be placed against the phase list without any further arithmetic.
    blockDrifts.push({ driftMs: Math.max(0, now - blockDueAt), atMs: now })
    blockDueAt = now + PERF_LAG_PROBE_INTERVAL_MS
  }, PERF_LAG_PROBE_INTERVAL_MS)
  blockTimer.unref()
}

// ------------------------------------------------------------------- the startup stutter probe
//
// THE SECOND CLOCK OVER THE SAME WINDOW (JOS-57 scope addition, 2026-08-11) — the argument for it
// is in `shared/perf.ts` beside `foldStutterSamples`; what lives here is the timer.
//
// IT SHARES THE BLOCK PROBE'S WINDOW ON PURPOSE (`appReady` → `replayDone`, opened and closed by
// the same two marks): the reading is a COMPARISON — a drift distribution that moved while the
// worst block did not — and two probes measuring different seconds could not be compared at all.
//
// THE COST, stated because rule 1 above demands it: one `setInterval` for the few seconds a replay
// lasts, unref'd, whose callback is a subtraction and a push. At 125 ms it fires ~48 times across
// a six-second fold and ~480 times across a minute-long one, and it holds one number per tick.

let stutterTimer: ReturnType<typeof setInterval> | null = null
let stutterDrifts: number[] = []
let stutterDueAt = 0
let stutterStats: StartupStutterProbe | undefined

/** Start the stutter heartbeat. Idempotent; opened by `appReady` beside the block probe. */
function startStutterProbe(): void {
  if (stutterTimer !== null) return
  stutterDrifts = []
  stutterDueAt = performance.now() + STARTUP_STUTTER_INTERVAL_MS
  stutterTimer = setInterval(() => {
    const now = performance.now()
    stutterDrifts.push(Math.max(0, now - stutterDueAt))
    // Re-based on the tick that actually happened, exactly as the block probe rebases: each sample
    // is then this tick's own lateness rather than a running total of every earlier one, which is
    // what makes a percentile over them mean anything.
    stutterDueAt = now + STARTUP_STUTTER_INTERVAL_MS
  }, STARTUP_STUTTER_INTERVAL_MS)
  stutterTimer.unref()
}

/** Close the heartbeat's window and FREEZE its answer. A window that held no ticks reports
 *  nothing, for the same reason the block probe's does: nothing measured is not a smooth launch. */
function stopStutterProbe(): void {
  if (stutterTimer === null) return
  clearInterval(stutterTimer)
  stutterTimer = null
  const stats = foldStutterSamples(stutterDrifts)
  stutterDrifts = []
  if (stats.samples > 0) stutterStats = stats
}

/**
 * Close the window and FREEZE the answer. Called when `replayDone` lands — and from `stopPerf`,
 * so a launch that quit mid-replay still states how blocked it got before it died.
 *
 * A window that held no ticks reports nothing rather than `{max: 0}`: a probe that never sampled
 * has not observed a smooth launch, it has observed nothing (see StartupBlockStats.samples).
 */
function stopStartupBlockProbe(): void {
  if (blockTimer === null) return
  clearInterval(blockTimer)
  blockTimer = null
  const stats = foldBlockSamples(blockDrifts)
  blockDrifts = []
  if (stats.samples > 0) blockStats = stats
}

/** Extra facts a mark may carry. `atMs` exists because the two module-evaluation phases finished
 *  BEFORE the composition root could speak (see shared/perf.ts's phase table) and are marked with
 *  the timestamp the module that did the work recorded. */
export interface MarkOptions {
  atMs?: number
  eventsReplayed?: number
  /** How the replay's slicer split its wall clock (JOS-50). Only `replayDone` carries it, and
   *  only when there was a log to replay. */
  replay?: ReplayDutyStats
  /**
   * Bytes the historical scan actually folded — its own frozen EOF (JOS-57). Only `replayDone`
   * carries it, and it is the one mark option that does NOT land in `perf-startup.json`: the
   * profile is about TIME, and this exists solely so the fleet reading can be bucketed by log size
   * ("6 s" means something different for a 2 MB log than for a 600 MB one). It never leaves this
   * process as a byte count — `startupReplayStats` turns it into a bucket index first.
   */
  bytesReplayed?: number
  /**
   * Bytes the log grew by since this app last shut down cleanly (JOS-57's scope addition, from the
   * first-start-stutter investigation). Only `replayDone` carries it, and only when a mark from a
   * previous clean shutdown could be compared — absent is UNKNOWN, never zero.
   *
   * Unlike `bytesReplayed` this one DOES land in `perf-startup.json`, raw: a support answer read on
   * the user's own machine wants the number, and the bucketing exists to stop a fingerprint leaving
   * the machine rather than to stop the user seeing their own log.
   */
  newBytes?: number
  /** How long the first megabyte of the historical read took, ms — the cold-disk hint. Only
   *  `replayDone` carries it, and only on a log at least that big. */
  firstMbMs?: number
}

/**
 * Record one startup phase. NEVER THROWS and never takes the app down: a refused mark (a
 * duplicate, or one that arrived out of order) is a wiring bug worth one log line, not a reason
 * for the app not to start. The refusal is a TYPED value from `addMark`, so the log line can say
 * which phase and why instead of a NaN appearing three screens later in the UI.
 *
 * Completing the last phase writes the profile — once. Everything after that is ignored.
 */
export function markStartupPhase(phase: StartupPhase, opts: MarkOptions = {}): void {
  const at = opts.atMs ?? performance.now()
  if (opts.eventsReplayed !== undefined) eventsReplayed = opts.eventsReplayed
  if (opts.replay !== undefined) replayStats = opts.replay
  if (opts.bytesReplayed !== undefined) replayBytes = opts.bytesReplayed
  if (opts.newBytes !== undefined) newBytes = opts.newBytes
  if (opts.firstMbMs !== undefined) firstMbMs = opts.firstMbMs
  const result = addMark(marks, phase, at)
  if (!result.ok) {
    logError('main:perfStartup', describeMarkError(result.error))
    return
  }
  marks = result.marks
  // The block probe's window IS the replay (plan §2), so the two phases that bound it own the
  // probe's lifetime. Wiring it here rather than in the composition root means the window can
  // never drift away from the phases the profile reports it against.
  if (phase === 'appReady') {
    startStartupBlockProbe()
    startStutterProbe()
  }
  if (phase === 'replayDone') {
    // ORDER MATTERS: both probes are closed FIRST so `blockStats` and `stutterStats` are frozen
    // before the reading that reports them is built. All of this belongs to this one mark rather
    // than to the composition root, for the same reason the probes' lifetime does — they cannot
    // drift from the phase.
    stopStartupBlockProbe()
    stopStutterProbe()
    reportStartupReplay(at)
    // …and THIS is where the setup snapshot is armed (JOS-364). It belongs to this mark for the
    // same reason the probes do: `replayDone` is the one moment the app agrees its launch is
    // over, and a machine-class reading taken during the replay would both steal from the launch
    // it is measured beside and describe an app that is still booting. It is armed rather than
    // taken — the producer waits out a short delay of its own and never blocks this call.
    //
    // NOT gated on `replayStats` like the reading above: an install with no log to replay still
    // has a machine, and it is disproportionately the install something is wrong with.
    scheduleSetupSnapshot()
    // …and the LIVE probes take over from the startup ones at the same instant (JOS-367). The
    // handover is the point: the two startup probes have just been closed, and everything after
    // this mark is a running app rather than a boot. Two clocks from here to quit — main's, and
    // one on a thread of its own — because a single clock can prove it was late and can never say
    // who made it late, and the freezes this hunts are reported on a machine we do not own.
    startLiveProbe()
    // …and with them the GC half of the instrument that answers WHO (JOS-458). Same instant, same
    // window, same argument as the probes beside it: `gc` is a POPULATION the fleet reads as a
    // rate, and a 1.4M-event fold's garbage is nothing like a running session's, so mixing a boot
    // into it would move every install's numbers by an amount that depends on the size of its log.
    //
    // THE SEAM BRACKETS ARE NOT STARTED HERE AND DO NOT NEED TO BE — they record from process
    // start, deliberately, because a per-seam max is not a distribution and because the launch's
    // own first `registryFlush` and `worldRebuilt` fire one statement before THIS MARK is reached.
    // Gating them on it would have excluded the cold fan-out, which is the single most interesting
    // instance of the seam the ticket suspects most. `perfAttribution.ts`'s header has the full
    // argument.
    startStallAttribution()
  }
  if (startupProfile().complete) writeStartupProfile()
}

/**
 * THE FLEET READING (JOS-57): hand this launch's replay numbers to telemetry, once.
 *
 * WHY HERE. This is the seam where every one of them is known and frozen at the same instant — the
 * duty ledger and the event count arrived with the mark, the block probe has just been closed, and
 * `marks` holds the two timestamps the replay ran between. Anywhere else would have to re-derive
 * one of them, and a launch cannot be re-run to check.
 *
 * ONE LAUNCH IS ONE READING, and it is structural rather than a flag: `replayDone` can be marked
 * exactly once per process (`addMark` refuses a duplicate), so a character SWITCH — which replays
 * a log through the same code — cannot produce a second. That refusal is the whole comparability
 * argument: a switch replay is a different kind of work under different conditions, and a
 * population that mixed the two could not answer "how long does starting this app take".
 *
 * A launch with NO LOG TO REPLAY reports nothing at all (`replayStats` is undefined — session.ts
 * only supplies it when a character was tailed). A replay that did not happen is not a replay that
 * took 0 ms, and a fabricated zero would drag every percentile in the fleet down with it.
 */
function reportStartupReplay(replayDoneAtMs: number): void {
  if (replayStats === undefined) return
  // The replay's own window: `tailAttached` is marked the moment the composition root hands the
  // session its work, and this phase lands when the fold is done. Subtracting the two is exact
  // even though `rendererHydrated` may have landed BETWEEN them (they race — CONCURRENT_PHASES),
  // which is precisely why this is not the profile's own `durationMs` for the phase.
  const attached = marks.find((m) => m.phase === 'tailAttached')
  if (attached === undefined) return
  noteStartupReplay(
    startupReplayStats({
      replayMs: replayDoneAtMs - attached.atMs,
      eventsReplayed: eventsReplayed ?? 0,
      workMs: replayStats.workMs,
      restMs: replayStats.restMs,
      // A probe window that held no ticks has observed NOTHING, not a smooth launch — so the
      // reading says zero blocks, which is what an unmeasured window can honestly contribute to
      // a sum. `samples` is why the profile on disk keeps the distinction and this cannot.
      maxBlockMs: blockStats?.maxBlockMs ?? 0,
      blocksOver50: blockStats?.blocksOver50Ms ?? 0,
      logBytes: replayBytes ?? 0,
      // THE TWO DISCRIMINATORS, each passed through only when it was genuinely measured — a
      // `?? 0` here would be the one thing this whole addition exists to avoid, because "no mark
      // to compare against" and "no new bytes" are opposite facts about a launch.
      ...(newBytes === undefined ? {} : { newBytes }),
      ...(firstMbMs === undefined ? {} : { firstMbMs }),
      ...stutterReading()
    })
  )
}

/**
 * The stutter reading, IF the probe saw enough ticks to describe (`STARTUP_STUTTER_MIN_SAMPLES`).
 *
 * A short fold reports nothing rather than a percentile over a handful of samples: the wire has no
 * `samples` field to qualify it with (the local profile keeps that distinction, which is where it
 * is readable), so a reading that arrives has to be one that can stand alone.
 */
function stutterReading(): { stutter?: { p50Ms: number; p95Ms: number; latePct: number } } {
  if (stutterStats === undefined || stutterStats.samples < STARTUP_STUTTER_MIN_SAMPLES) return {}
  const { p50Ms, p95Ms, latePct } = stutterStats
  return { stutter: { p50Ms, p95Ms, latePct } }
}

/**
 * Has this phase already landed on THIS launch? (JOS-99.)
 *
 * For the one caller that has a legitimate reason to ask rather than mark: `rendererHydrated`
 * arrives over IPC from a window that can RELOAD, and a reloaded window re-reporting hydration is
 * expected rather than a wiring bug (see `phaseMarked` in shared/perf.ts). Asking is deliberately
 * not the same as marking-and-being-refused: the refusal is what writes an error line, and the
 * whole point is that a reload must not write one.
 *
 * It reads the live `marks` list, so it answers about the accounting itself and cannot drift from
 * it the way a second boolean beside it would.
 */
export function startupPhaseMarked(phase: StartupPhase): boolean {
  return phaseMarked(marks, phase)
}

/** This launch's profile so far. Complete once every phase has landed. */
export function startupProfile(): StartupProfile {
  return buildProfile(marks, {
    startedAt: LAUNCH_STARTED_AT,
    version: app.getVersion(),
    ...(eventsReplayed === undefined ? {} : { eventsReplayed }),
    ...(blockStats === undefined ? {} : { block: blockStats }),
    ...(replayStats === undefined ? {} : { replay: replayStats }),
    ...(stutterStats === undefined ? {} : { stutter: stutterStats }),
    ...(newBytes === undefined ? {} : { newBytes }),
    ...(firstMbMs === undefined ? {} : { firstMbMs }),
    // UNCONDITIONAL, unlike its neighbours, and that is the difference between a measurement and a
    // manifest: every other member here is absent on a launch that did not produce it, while the
    // committed rows describe the BUILD and are true of every launch of it. The one part that is
    // per-launch (`heapAfterDataMb`) carries its own absence inside the ledger.
    data: dataWeightLedger()
  })
}

/** One line per launch, in the same voice as the other boot logs: total, replay size, and the
 *  three costliest phases — enough to know from `errors.log` alone whether a launch was slow. */
function logStartupSummary(profile: StartupProfile): void {
  const worst = [...profile.phases]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 3)
    .map((p) => `${p.phase} ${String(Math.round(p.durationMs))}ms`)
    .join(', ')
  const replayed =
    profile.eventsReplayed === undefined ? '' : `, ${String(profile.eventsReplayed)} events replayed`
  // The block figures ride the same line: "6 s of replay" and "6 s of replay during which the main
  // loop was never more than 14 ms late" are different launches, and errors.log should say which.
  const blocked =
    profile.block === undefined
      ? ''
      : `, worst main-loop block ${String(profile.block.maxBlockMs)}ms (${String(profile.block.blocksOver50Ms)} over 50ms` +
        // WHERE it landed, so errors.log alone says which phase to look at (JOS-59).
        `${profile.block.worstAtMs === undefined ? '' : `, at ${String(Math.round(profile.block.worstAtMs))}ms - ${phaseAt(profile, profile.block.worstAtMs)}`})`
  // …and so does the duty the replay ACHIEVED (JOS-50). The slicer aims at REPLAY_DUTY and the
  // Windows timer decides what it actually gets, so the launch states the measurement rather than
  // the intention — a replay that somehow rested not at all is then visible in errors.log.
  const duty =
    profile.replay === undefined
      ? ''
      : `, replay duty ${String(Math.round(replayDutyOf(profile.replay) * 100))}%` +
        ` (${String(Math.round(profile.replay.workMs))}ms folding / ${String(Math.round(profile.replay.restMs))}ms resting` +
        ` over ${String(profile.replay.slices)} slices)`
  logInfo(
    `[everquest-companion] Startup ${String(Math.round(profile.totalMs))}ms` +
      `${replayed}${blocked}${duty}${coldRead(profile)} (${worst}) - profile at ${profilePath()}`
  )
  // THE DATA LEDGER GETS ITS OWN LINE (JOS-458) rather than another clause on the one above. The
  // line above describes THIS launch; this one describes the BUILD, and it is the same every time
  // until a data file changes — which is exactly the property that makes a change to it visible in
  // errors.log the release it lands, and the reason it must not be buried mid-sentence.
  if (profile.data !== undefined) {
    logInfo(`[everquest-companion] ${formatDataWeight(profile.data)}`)
  }
}

/**
 * The cold-read half of the summary line (JOS-57 scope addition), so `errors.log` ALONE can tell
 * the two launches apart that this whole addition exists to separate: the same fold, the same
 * duty, the same worst block — one of them reading 400 MB the machine has cached and one of them
 * reading 40 MB it has not, with our own clock drifting through it.
 *
 * Each clause appears only when its number was measured, and none of them is faked to keep the
 * line's shape stable: a launch with no mark to compare against simply says less.
 */
function coldRead(profile: StartupProfile): string {
  const mb = (bytes: number): string => `${String(Math.round((bytes / 1_048_576) * 10) / 10)}MB`
  const cold =
    profile.newBytes === undefined ? '' : `, ${mb(profile.newBytes)} new since last clean exit`
  const first =
    profile.firstMbMs === undefined
      ? ''
      : `, first MB in ${String(Math.round(profile.firstMbMs))}ms`
  const drift =
    profile.stutter === undefined
      ? ''
      : `, timer drift p50 ${String(profile.stutter.p50Ms)}ms / p95 ${String(profile.stutter.p95Ms)}ms` +
        ` (${String(profile.stutter.latePct)}% of ${String(profile.stutter.samples)} ticks late)`
  return `${cold}${first}${drift}`
}

/**
 * Which phase was in flight at `atMs` — the phase whose window CONTAINS it (JOS-59).
 *
 * Phases are marked at their END, so the one that owns an instant is the first mark at or after
 * it. Before the first mark is impossible (the probe opens at `appReady`) and after the last is
 * reported as such rather than attributed to a phase that had already finished.
 */
function phaseAt(profile: StartupProfile, atMs: number): string {
  for (const p of profile.phases) if (atMs <= p.atMs) return `during ${p.phase}`
  return 'after the last phase'
}

function profilePath(): string {
  return join(app.getPath('userData'), PROFILE_FILE)
}

/**
 * Persist the profile ATOMICALLY (temp file + rename), replacing the previous launch's —
 * one file, last launch only (plan P4/P6). Best effort: a profile that cannot be written is
 * never a reason to fail a launch, so every failure is logged and startup continues.
 *
 * Written once per launch, when the final phase lands. `flushStartupProfile` covers the launch
 * that quits before that, so a boot that died half-way still leaves evidence of how far it got.
 */
function writeStartupProfile(): void {
  const profile = startupProfile()
  if (profile.phases.length === 0) return
  profileWritten = true
  const path = profilePath()
  const tmp = `${path}.tmp`
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(tmp, JSON.stringify(profile, null, 2), 'utf8')
    renameSync(tmp, path)
    logStartupSummary(profile)
  } catch (err) {
    logError('main:perfStartup', { message: 'perf-startup.json write failed', err })
  }
}

/** Write an INCOMPLETE profile on the way out, if the launch never reached the last phase. Both
 *  startup probes are closed FIRST so a launch that quit mid-replay still states how blocked it
 *  got and what its clock was doing. */
export function flushStartupProfile(): void {
  stopStartupBlockProbe()
  stopStutterProbe()
  if (!profileWritten) writeStartupProfile()
}

// ---------------------------------------------------------------------------- the sampler

let sampleTimer: ReturnType<typeof setInterval> | null = null
let lagTimer: ReturnType<typeof setInterval> | null = null
/** Drift samples for the CURRENT window; taken and cleared by each 2 s sample. */
let drifts: number[] = []
/** When the next lag tick is DUE. Its lateness is the measurement. */
let lagDueAt = 0

/**
 * The event-loop lag probe (plan P2). A 500 ms interval that measures its own lateness: the
 * event loop can only be late because something else was holding it, so the drift IS the block.
 *
 * Sub-millisecond scheduling noise is real (Windows' 15.6 ms timer quantum sits under all of
 * this), which is why the chip colours on a p95 rather than a max, and alerts only at 200 ms.
 */
function startLagProbe(): void {
  lagDueAt = performance.now() + PERF_LAG_PROBE_INTERVAL_MS
  lagTimer = setInterval(() => {
    const now = performance.now()
    drifts.push(Math.max(0, now - lagDueAt))
    lagDueAt = now + PERF_LAG_PROBE_INTERVAL_MS
  }, PERF_LAG_PROBE_INTERVAL_MS)
  lagTimer.unref()
}

/** One sample: fold Electron's per-process metrics, drain the drift window, push. */
function emitSample(): void {
  const metrics = app.getAppMetrics() as unknown as RawProcessMetric[]
  const byType = aggregateMetrics(metrics)
  const totals = totalsOf(byType)
  const lag = lagStats(drifts)
  drifts = []
  const sample: PerfSample = {
    ts: Date.now(),
    cpuPercent: totals.cpuPercent,
    memoryMb: totals.memoryMb,
    byType,
    lag
  }
  sendToMain(IPC.onPerfSample, sample)
}

/** Is the HUD's machinery running right now? (The gating tests' seam — and the IPC's guard.) */
export function perfSamplerRunning(): boolean {
  return sampleTimer !== null
}

/**
 * Start sampling. Idempotent. The DECISION to call this belongs to the caller (the composition
 * root at launch, the IPC handler on a toggle) because the pref lives in the store and this
 * module deliberately does not import it — one direction of dependency, no cycle.
 *
 * The first sample is emitted IMMEDIATELY so the chip appears the moment the switch is flipped
 * rather than up to two seconds later. Its `cpuPercent` covers the interval since Electron's
 * last internal metrics read, and its `lag` window is empty (`samples: 0`), which the chip
 * renders as "not measured yet" rather than as zero lag.
 */
export function startPerfSampler(): void {
  if (sampleTimer !== null) return
  drifts = []
  startLagProbe()
  emitSample()
  sampleTimer = setInterval(emitSample, PERF_SAMPLE_INTERVAL_MS)
  sampleTimer.unref()
  logInfo('[everquest-companion] perf HUD: sampler started (2s metrics, 500ms lag probe)')
}

/**
 * Stop sampling and tell the renderer, with a `null` push on the same channel — the chip is
 * hidden ENTIRELY when the HUD is off (plan P3), so it needs to hear "no more numbers" rather
 * than being left holding the last one it saw.
 */
export function stopPerfSampler(): void {
  const wasRunning = sampleTimer !== null
  if (sampleTimer) clearInterval(sampleTimer)
  if (lagTimer) clearInterval(lagTimer)
  sampleTimer = null
  lagTimer = null
  drifts = []
  if (wasRunning) sendToMain(IPC.onPerfSample, null)
}

/** Teardown from `window-all-closed`: stop the timers and make sure the launch left a profile.
 *  The live probes go with them — including the worker thread, which `stopLiveProbe` terminates
 *  rather than leaving to an `unref`'d handle nobody closed. */
export function stopPerf(): void {
  stopPerfSampler()
  stopLiveProbe()
  // The GC observer goes with them (JOS-458). It disconnects only — the tallies are left standing
  // so a `sessionEnd` report composed during the same teardown still carries its last interval.
  stopStallAttribution()
  flushStartupProfile()
}
