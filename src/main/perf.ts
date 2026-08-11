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
//      runtime cost is the eight `markStartupPhase` calls below, which are an array push each.
//   2. BOTH TIMERS ARE `unref`'d, so neither can be the reason the process outlives its windows.
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
  lagStats,
  PERF_LAG_PROBE_INTERVAL_MS,
  PERF_SAMPLE_INTERVAL_MS,
  phaseMarked,
  replayDutyOf,
  totalsOf,
  type BlockSample,
  type PerfSample,
  type RawProcessMetric,
  type ReplayDutyStats,
  type StartupBlockStats,
  type StartupMark,
  type StartupPhase,
  type StartupProfile
} from '../shared/perf'
import { startupReplayStats } from '../shared/telemetry'
import { logError, logInfo } from './errorLog'
// The fleet half of the same measurement (JOS-57). Through the telemetry FAÇADE, like every other
// producer in this app — the wiring may not reach around it into the ring.
import { noteStartupReplay } from './telemetry'
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
  const result = addMark(marks, phase, at)
  if (!result.ok) {
    logError('main:perfStartup', describeMarkError(result.error))
    return
  }
  marks = result.marks
  // The block probe's window IS the replay (plan §2), so the two phases that bound it own the
  // probe's lifetime. Wiring it here rather than in the composition root means the window can
  // never drift away from the phases the profile reports it against.
  if (phase === 'appReady') startStartupBlockProbe()
  if (phase === 'replayDone') {
    // ORDER MATTERS: the probe is closed FIRST so `blockStats` is frozen before the reading that
    // reports it is built. Both of these belong to this one mark rather than to the composition
    // root, for the same reason the probe's lifetime does — they cannot drift from the phase.
    stopStartupBlockProbe()
    reportStartupReplay(at)
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
      logBytes: replayBytes ?? 0
    })
  )
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
    ...(replayStats === undefined ? {} : { replay: replayStats })
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
      `${replayed}${blocked}${duty} (${worst}) - profile at ${profilePath()}`
  )
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

/** Write an INCOMPLETE profile on the way out, if the launch never reached the last phase. The
 *  block probe is closed FIRST so a launch that quit mid-replay still states how blocked it got. */
export function flushStartupProfile(): void {
  stopStartupBlockProbe()
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

/** Teardown from `window-all-closed`: stop the timers and make sure the launch left a profile. */
export function stopPerf(): void {
  stopPerfSampler()
  flushStartupProfile()
}
