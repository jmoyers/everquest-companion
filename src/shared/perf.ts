// shared/perf.ts — THE PURE HALF of performance profiling (docs/plans/perf-profiling.md).
//
// One type is imported (`./dataWeight.ts`, JOS-458) and it is TYPE-ONLY, which keeps the
// zero-runtime-import property below intact: `storeMigrations.ts` still reads this file from
// module scope before electron-store exists.
//
// Everything here is arithmetic and vocabulary: the sample shape main pushes, the startup
// phase enum and its accounting, the lag thresholds, and the formatters the chip renders. No
// Electron, no Node, no React — so `tests/perf.test.mts` pins every rule that decides what a
// number MEANS, and main/renderer are left with wiring.
//
// It is a ZERO-IMPORT module for the same reason `shared/telemetry.ts` is one: `storeMigrations.ts`
// runs from store.ts's module scope, before electron-store exists, and needs the prefs
// normalizer without dragging the LogEvent union in behind it.
//
// TWO PROBES, TWO DIFFERENT QUESTIONS (plan P2). CPU% answers "is the app busy"; event-loop lag
// answers "is the app BLOCKED". They are not the same fact and the difference is the whole point
// of the feature: high lag with low app CPU says the MACHINE is loaded, not this app — which is
// what lets the app exonerate itself instead of being blamed for someone else's build.

// ---------------------------------------------------------------------------- live sampling

/**
 * Process types as this app groups them. Electron's own `type` strings are Chromium's
 * ('Browser', 'Tab', 'GPU', 'Utility', 'Zygote', 'Sandbox helper', 'Unknown'), which are not the
 * words anyone reading a HUD thinks in — `perfProcessType` maps them, and 'other' is a real
 * bucket rather than a dropped row: memory that exists must appear somewhere or the total lies.
 */
import type { DataWeightLedger } from './dataWeight'

export type PerfProcessType = 'main' | 'renderer' | 'gpu' | 'utility' | 'other'

/** Fixed render order, so the popover's table rows never reshuffle between samples. */
export const PERF_PROCESS_TYPES: readonly PerfProcessType[] = [
  'main',
  'renderer',
  'gpu',
  'utility',
  'other'
]

/**
 * Chromium's process-type string → our bucket. MEASURED, not guessed: the main process reports
 * as 'Browser' and each renderer (main window, every overlay) as 'Tab'; anything unrecognized
 * lands in 'other' rather than being dropped.
 */
export function perfProcessType(raw: string): PerfProcessType {
  if (raw === 'Browser') return 'main'
  if (raw === 'Tab') return 'renderer'
  if (raw === 'GPU') return 'gpu'
  if (raw === 'Utility') return 'utility'
  return 'other'
}

/** One row of `app.getAppMetrics()`, named structurally — main passes Electron's own objects in
 *  and this module never learns what Electron is. Every field is optional because a metric row
 *  from a process that is going away can be missing either half. */
export interface RawProcessMetric {
  type: string
  cpu?: { percentCPUUsage?: number }
  memory?: { workingSetSize?: number }
}

/** One aggregated process-type row: how many, how much CPU, how much resident memory. */
export interface PerfProcessRow {
  type: PerfProcessType
  count: number
  cpuPercent: number
  memoryMb: number
}

/** Event-loop lag over one sample window (plan P2). `samples` is how many probe ticks the
 *  window actually held — 0 means "not measured", which is NOT the same as "no lag". */
export interface PerfLagStats {
  samples: number
  p95Ms: number
  maxMs: number
}

/** One push on `perf:sample`. Compact on purpose: this crosses IPC every 2 s while the HUD is on. */
export interface PerfSample {
  /** Wall clock of the sample, for the sparkline's own bookkeeping. */
  ts: number
  /** Summed across every process this app owns. */
  cpuPercent: number
  /** Summed resident (working set) memory, MB. */
  memoryMb: number
  byType: PerfProcessRow[]
  lag: PerfLagStats
}

/**
 * What the RENDERER holds: main's sample plus the one probe main cannot see. Long tasks are a
 * renderer fact (`PerformanceObserver('longtask')` — main has no such API), so they are joined
 * on arrival rather than round-tripped through main.
 */
export interface PerfHudSample extends PerfSample {
  longtasks: number
}

/** Poll cadence for `app.getAppMetrics()` (plan P1). Slow enough to be free, fast enough to see
 *  a stutter you are still looking at. */
export const PERF_SAMPLE_INTERVAL_MS = 2_000

/** Event-loop probe cadence (plan P2): a self-timing interval whose DRIFT is the measurement. */
export const PERF_LAG_PROBE_INTERVAL_MS = 500

/** Samples the renderer keeps for the sparkline. 60 × 2 s = the last two minutes, and that is
 *  the entire retention story for live numbers (plan P6: no history, nothing on disk). */
export const PERF_RING_SIZE = 60

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A finite number, or `fallback`. Metrics come from a C++ boundary; NaN is a real possibility. */
function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Round to `places` decimals without the float noise a bare toFixed round-trip leaves. */
export function round(value: number, places = 1): number {
  const f = 10 ** places
  return Math.round(value * f) / f
}

/**
 * Fold Electron's per-PROCESS metrics into per-TYPE rows (plan P1).
 *
 * Every type in `PERF_PROCESS_TYPES` gets a row even at zero, so the popover's table has a
 * stable height and a disappearing GPU process reads as "0", not as a row that vanished.
 * `workingSetSize` is KILOBYTES (Electron's unit) — the conversion lives here so no caller has
 * to remember it.
 */
export function aggregateMetrics(metrics: readonly RawProcessMetric[]): PerfProcessRow[] {
  const rows = new Map<PerfProcessType, PerfProcessRow>(
    PERF_PROCESS_TYPES.map((type) => [type, { type, count: 0, cpuPercent: 0, memoryMb: 0 }])
  )
  for (const m of metrics) {
    const row = rows.get(perfProcessType(m.type))
    if (!row) continue
    row.count += 1
    row.cpuPercent += finite(m.cpu?.percentCPUUsage)
    row.memoryMb += finite(m.memory?.workingSetSize) / 1024
  }
  return PERF_PROCESS_TYPES.map((type) => {
    const row = rows.get(type) ?? { type, count: 0, cpuPercent: 0, memoryMb: 0 }
    return { ...row, cpuPercent: round(row.cpuPercent), memoryMb: Math.round(row.memoryMb) }
  })
}

/** App-wide totals from the per-type rows — summed from the SAME rows the table renders, so the
 *  chip and the popover can never disagree about what the app is using. */
export function totalsOf(rows: readonly PerfProcessRow[]): { cpuPercent: number; memoryMb: number } {
  let cpu = 0
  let mem = 0
  for (const r of rows) {
    cpu += r.cpuPercent
    mem += r.memoryMb
  }
  return { cpuPercent: round(cpu), memoryMb: Math.round(mem) }
}

/**
 * The p-th percentile of `values`, NEAREST-RANK (no interpolation).
 *
 * Interpolation would invent a lag figure between two measured ones; nearest-rank always answers
 * with a millisecond count that was actually observed. An empty input is 0 — and callers state
 * `samples` beside it so "0 because nothing was measured" is distinguishable from "0 ms of lag".
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? 0
}

/** p95 + max over one window's drift samples. Never NaN, never negative. */
export function lagStats(drifts: readonly number[]): PerfLagStats {
  const clean = drifts.filter((d) => Number.isFinite(d)).map((d) => Math.max(0, d))
  return {
    samples: clean.length,
    p95Ms: round(percentile(clean, 95), 0),
    maxMs: round(clean.length ? Math.max(...clean) : 0, 0)
  }
}

/** How the chip is coloured. Three states, because "slow" and "blocked" deserve different words. */
export type PerfSeverity = 'normal' | 'warn' | 'alert'

/** p95 at or above this ⇒ warn: the loop is late often enough that the UI feels heavy. */
export const LAG_WARN_P95_MS = 50
/** A single stall at or above this ⇒ alert: a fifth of a second is a visible freeze. */
export const LAG_ALERT_MAX_MS = 200

/**
 * THE STARTUP BLOCK PROBE's answer (docs/plans/chunked-replay.md §2).
 *
 * The HUD's lag probe runs only while the user's switch is on; this one runs on EVERY launch,
 * from `appReady` to `replayDone`, and lands in perf-startup.json beside the phases. Same
 * measurement (a self-timing interval's own lateness IS the block), different question: the HUD
 * asks "is the app blocked right now", this asks "was the launch that already happened blocked" —
 * and the launch you wish you had profiled is always that one.
 *
 * `samples` rides along for the same reason `PerfLagStats.samples` does: a probe window that held
 * no ticks reports 0 ms because nothing was MEASURED, which is not the same claim as 0 ms of
 * blocking, and a reader with only the max cannot tell those apart.
 */
export interface StartupBlockStats {
  samples: number
  /** The worst single stall observed in the window, ms. THE chunking invariant's subject. */
  maxBlockMs: number
  /** How many probe ticks were at least `STARTUP_BLOCK_THRESHOLD_MS` late. */
  blocksOver50Ms: number
  /**
   * WHEN the worst stall ENDED, on the same `atMs` clock the phases use (JOS-59). Absent when the
   * window held no ticks, and absent from any profile written before this existed.
   *
   * It is here because "maxBlockMs 617" could not be acted on. Real dev boots report one block of
   * 600-750 ms that no bench or e2e run reproduces (those measure 15-24 ms with the same log, the
   * same 1.4M events and a copy of the same userData), and with only a magnitude there was no way
   * to say WHICH of the eight phases it happened inside — the profile listed a `rendererHydrated`
   * phase lasting 1,440 ms in dev against 170 ms in a production-shaped build, and a number that
   * could be placed against it settles the question the next time anyone launches. One assignment
   * per probe tick, on a probe that was already running: the performance contract at the top of
   * main/perf.ts is unchanged.
   */
  worstAtMs?: number
}

/**
 * What counts as a BLOCK during startup. Deliberately the same number the HUD already calls
 * "warn" (`LAG_WARN_P95_MS`) rather than a second opinion: one threshold, one vocabulary — a
 * startup that would have coloured the chip is a startup that reports blocks.
 */
export const STARTUP_BLOCK_THRESHOLD_MS = LAG_WARN_P95_MS

/** One probe tick: how late it was, and when it landed on the profile's own `atMs` clock. */
export interface BlockSample {
  driftMs: number
  atMs: number
}

/** Drift samples → the facts the profile states. Pure, so the arithmetic is pinned by tests
 *  rather than inferred from a boot. Never NaN, never negative.
 *
 *  Ties go to the FIRST tick that reached the maximum — an arbitrary but stated choice, so two
 *  runs of the same launch describe the same tick. */
export function foldBlockSamples(samples: readonly BlockSample[]): StartupBlockStats {
  const clean = samples
    .filter((s) => Number.isFinite(s.driftMs))
    .map((s) => ({ driftMs: Math.max(0, s.driftMs), atMs: s.atMs }))
  let worst: BlockSample | undefined
  for (const s of clean) if (worst === undefined || s.driftMs > worst.driftMs) worst = s
  return {
    samples: clean.length,
    maxBlockMs: round(worst ? worst.driftMs : 0, 0),
    blocksOver50Ms: clean.filter((s) => s.driftMs >= STARTUP_BLOCK_THRESHOLD_MS).length,
    ...(worst && Number.isFinite(worst.atMs) ? { worstAtMs: round(worst.atMs, 0) } : {})
  }
}

// ------------------------------------------------------------------- the startup stutter probe
//
// THE SECOND CLOCK (JOS-57 scope addition, 2026-08-11). The block probe above answers "how badly
// was the main loop held", which is a question about a MAXIMUM and therefore about US. This one
// answers "what did our clock do while the fold ran", which is a question about a DISTRIBUTION and
// therefore, read beside the first, about the MACHINE: many moderately late ticks while the worst
// single block stays small is a process behaving itself on a computer that is not.
//
// WHY IT IS NOT THE SAME PROBE. Two properties differ and both are load-bearing. It ticks fast
// enough to have a distribution — a 500 ms probe over a six-second fold holds twelve samples, and
// a p95 over twelve samples is a rumour — and its interval is chosen against Windows' timer
// quantum so the BASELINE drift is near zero rather than a constant tax that would eat two buckets
// before any real stutter arrived (AGENTS.md's measured timer law: a sleep ends at the next tick
// edge, so 125 ms — exactly eight 15.625 ms quanta — is asked for and is what a healthy machine
// delivers, while `setInterval(100)` would report ~9 ms of drift on an idle box forever).

/**
 * The stutter heartbeat's cadence. 125 ms = 8 × Windows' 15.625 ms timer quantum — see above; it
 * is a measured choice, not a round number, and changing it changes what "drift" means.
 */
export const STARTUP_STUTTER_INTERVAL_MS = 125

/**
 * What counts as a LATE tick. Comfortably past one quantum, so a tick that simply landed on the
 * next edge is not called a stutter: at this cadence the OS owes us nothing better than ~15.6 ms,
 * and a rate built on noise would be a number that always looks alarming.
 */
export const STARTUP_STUTTER_LATE_MS = 25

/**
 * Fewest ticks a launch may describe with a percentile. Below this the reading is DROPPED rather
 * than sent — 2.5 s of fold, which is also the point below which a launch has no replay problem to
 * discriminate. A p95 over four samples is the largest of four numbers wearing a statistic's name.
 */
export const STARTUP_STUTTER_MIN_SAMPLES = 20

/**
 * The probe's own answer, in MILLISECONDS — the local shape, written to perf-startup.json.
 * `shared/telemetry.ts StartupStutterStats` is the WIRE shape, where each percentile has already
 * become a bucket index; the two are deliberately different types so nothing can send this one.
 */
export interface StartupStutterProbe {
  /** Heartbeat ticks observed. Stated for the same reason `StartupBlockStats.samples` is. */
  samples: number
  p50Ms: number
  p95Ms: number
  /** The worst single tick, ms — the local file's own read, never sent. */
  maxMs: number
  /** Ticks at least `STARTUP_STUTTER_LATE_MS` late. */
  lateTicks: number
  /** `lateTicks` as a whole percent of `samples`, 0..100 — the summable form. */
  latePct: number
}

/** Drift samples → the probe's answer. Pure, so the arithmetic is pinned by tests rather than
 *  inferred from a boot. An empty window reports zeros beside `samples: 0`, which is what an
 *  unmeasured window honestly is — never a smooth one. */
export function foldStutterSamples(drifts: readonly number[]): StartupStutterProbe {
  const clean = drifts.filter((d) => Number.isFinite(d)).map((d) => Math.max(0, d))
  const lateTicks = clean.filter((d) => d >= STARTUP_STUTTER_LATE_MS).length
  return {
    samples: clean.length,
    p50Ms: round(percentile(clean, 50), 0),
    p95Ms: round(percentile(clean, 95), 0),
    maxMs: round(clean.length ? Math.max(...clean) : 0, 0),
    lateTicks,
    latePct: clean.length ? Math.round((lateTicks / clean.length) * 100) : 0
  }
}

/**
 * WHAT THE DUTY-CYCLED REPLAY ACTUALLY SPENT (JOS-50, `main/log/replaySlicer.ts`).
 *
 * The slicer rests on a real timer between slices so the fold cannot hold a core flat out, and a
 * timer on Windows delivers whatever the 15.6 ms quantum decides rather than what was asked for.
 * So the achieved duty is a MEASUREMENT, not a setting, and the launch states it: `restMs` is time
 * the OS handed back, timed by the slicer itself.
 *
 * Separate from `block` because they answer different questions about the same seconds — `block`
 * says how LATE the loop ran, this says how much of the wall clock the fold claimed at all.
 */
export interface ReplayDutyStats {
  /** Slices folded; each one ended in a yield (resting or not). */
  slices: number
  /** Milliseconds spent FOLDING. */
  workMs: number
  /** Milliseconds spent RESTING — measured, never requested. */
  restMs: number
}

/**
 * Achieved duty: the fraction of the replay's wall clock that was folding. 0 when nothing was
 * measured, which is honest — a replay that folded no events had no duty, it had no work.
 */
export function replayDutyOf(stats: ReplayDutyStats): number {
  const total = Math.max(0, finite(stats.workMs)) + Math.max(0, finite(stats.restMs))
  return total > 0 ? round(Math.max(0, finite(stats.workMs)) / total, 3) : 0
}

/**
 * Chip colour, from lag ALONE (plan P3). Deliberately not from CPU%: an app that is busy because
 * you asked it to replay a 1.1M-line log is not misbehaving, and colouring that red would train
 * the user to ignore the chip exactly when it finally means something.
 */
export function lagSeverity(lag: PerfLagStats): PerfSeverity {
  if (lag.samples === 0) return 'normal'
  if (lag.maxMs >= LAG_ALERT_MAX_MS) return 'alert'
  if (lag.p95Ms >= LAG_WARN_P95_MS) return 'warn'
  return 'normal'
}

/** Append with the ring cap applied; the OLDEST sample is dropped. Never mutates its input. */
export function pushSample(
  ring: readonly PerfHudSample[],
  next: PerfHudSample,
  cap = PERF_RING_SIZE
): PerfHudSample[] {
  if (cap <= 0) return []
  const out = [...ring, next]
  return out.length <= cap ? out : out.slice(out.length - cap)
}

// ------------------------------------------------------------------------------- formatting

/** `12%` — whole percent. A HUD that reads 12.4% invites arithmetic nobody wanted to do. */
export function formatCpu(cpuPercent: number): string {
  return `${String(Math.round(Math.max(0, finite(cpuPercent))))}%`
}

/** `480 MB` / `1.4 GB`. Same k/M spirit as `lib/formatRate`: the unit word follows the number. */
export function formatMemory(memoryMb: number): string {
  const mb = Math.max(0, finite(memoryMb))
  return mb >= 1024 ? `${String(round(mb / 1024, 1))} GB` : `${String(Math.round(mb))} MB`
}

/** `CPU 12% · 480 MB` — the chip's whole text (plan P3). */
export function formatChip(sample: Pick<PerfSample, 'cpuPercent' | 'memoryMb'>): string {
  return `CPU ${formatCpu(sample.cpuPercent)} · ${formatMemory(sample.memoryMb)}`
}

/** `8 ms` / `1.24 s`. Startup phases run to seconds; lag figures stay in milliseconds. */
export function formatMs(ms: number): string {
  const v = Math.max(0, finite(ms))
  return v >= 1000 ? `${String(round(v / 1000, 2))} s` : `${String(Math.round(v))} ms`
}

/**
 * An SVG polyline `points` string for `values` inside a `width`×`height` box, oldest at the left.
 *
 * Pure so the sparkline is TESTED rather than eyeballed, and so the popover needs no chart
 * library for sixty numbers (plan P3). The baseline is always 0 — a sparkline auto-scaled to its
 * own minimum makes 11%→12% look like a cliff — and a flat series draws a flat line at the
 * bottom rather than dividing by a zero range.
 */
export function sparklinePoints(values: readonly number[], width: number, height: number): string {
  if (values.length === 0 || width <= 0 || height <= 0) return ''
  const peak = Math.max(1, ...values.map((v) => Math.max(0, finite(v))))
  const step = values.length > 1 ? width / (values.length - 1) : 0
  return values
    .map((v, i) => {
      const y = height - (Math.max(0, finite(v)) / peak) * height
      return `${String(round(i * step, 2))},${String(round(y, 2))}`
    })
    .join(' ')
}

// -------------------------------------------------------------------------- startup profile

/**
 * The startup phases, in the order this app actually boots — which is NOT the order the plan
 * guessed, and the difference is measured rather than argued (docs/plans/perf-profiling.md P4
 * listed `appReady` first and `tailAttached` before `replayDone`).
 *
 *   storeLoaded       process start → the settings store is migrated and open. Everything before
 *                     it is module EVALUATION (channel choice, the one-time legacy seed, the
 *                     schema chain, electron-store's own construction), all of which happens
 *                     while Electron's `ready` is still pending — so it cannot be marked after
 *                     `appReady` without inventing a zero.
 *   dataLoaded        → the spell DB, the learned message overlay and every log module are in
 *                     memory (pipeline.ts's module body).
 *   appReady          → Electron's `ready` fired.
 *   protocols         → eqimg:// + eqspeech:// are serving and the IPC surface is registered.
 *   windowCreated     → the main BrowserWindow exists.
 *   tailAttached      → the composition root handed the log session its work.
 *   replayDone        → the historical scan finished folding into every module (+ how many
 *                     events it replayed). This is the long one on a real log.
 *   rendererHydrated  → the renderer reported, over IPC, that it had mounted.
 *
 * CLOSED SET. A phase that is not in this list cannot be marked, which is what makes the
 * accounting below total-able: the sum of the durations IS the startup.
 */
export const STARTUP_PHASES = [
  'storeLoaded',
  'dataLoaded',
  'appReady',
  'protocols',
  'windowCreated',
  'tailAttached',
  'replayDone',
  'rendererHydrated'
] as const

export type StartupPhase = (typeof STARTUP_PHASES)[number]

/**
 * The two phases that genuinely RACE, and are therefore not ordered against each other.
 *
 * MEASURED, and it is a fact about the app rather than a concession: the window loads its
 * renderer while the historical scan is still folding, which is exactly what the `hydrating`
 * state exists to say ("Reading log…" on a meter that is not live yet). So on a months-old log
 * the interface is drawn LONG before the replay finishes, and on a machine with no log at all
 * the replay finishes before the window has painted. Whichever lands first is the truth about
 * that launch, and a fixed opinion about their order would turn one of those two perfectly
 * ordinary launches into a refused mark and an incomplete profile.
 *
 * Everything else IS strictly sequential, and an arrival out of that order is still refused —
 * that is a wiring bug, and `addMark` says so.
 */
export const CONCURRENT_PHASES: readonly StartupPhase[] = ['replayDone', 'rendererHydrated']

/** One recorded mark: `atMs` is milliseconds since PROCESS START, never a wall clock. */
export interface StartupMark {
  phase: StartupPhase
  atMs: number
}

/** A phase's slice of the launch: when it landed, and how long it took to get there. */
export interface StartupPhaseTiming extends StartupMark {
  /** `atMs` minus the previous mark's `atMs` (the first phase's is its own `atMs`). */
  durationMs: number
}

/** `<userData>/perf-startup.json` — the LAST launch, and only the last (plan P4/P6). */
export interface StartupProfile {
  /** Wall clock of the launch, so "Last startup" can say when. */
  startedAt: number
  /** App version, so a profile read next week names the build it describes. */
  version: string
  phases: StartupPhaseTiming[]
  /** The last mark's `atMs` — i.e. how long the launch took to reach the furthest phase. */
  totalMs: number
  /** Events the historical scan folded, when `replayDone` reported one. */
  eventsReplayed?: number
  /**
   * How badly the main loop was BLOCKED between `appReady` and `replayDone` — the always-on probe
   * of docs/plans/chunked-replay.md §2. Absent on a launch whose probe never ran (or never held a
   * tick), never a fabricated zero.
   */
  block?: StartupBlockStats
  /**
   * How the historical fold split its wall clock between working and resting (JOS-50). Absent on a
   * launch with no log to replay, never a fabricated zero.
   */
  replay?: ReplayDutyStats
  /**
   * What our own clock did across the same window (JOS-57 scope addition) — the system-stutter
   * proxy, in milliseconds. Absent on a launch whose heartbeat never ticked.
   */
  stutter?: StartupStutterProbe
  /**
   * Bytes the log grew by since this app last shut down cleanly. RAW here and bucketed before it
   * can leave the machine: this file describes the user's own launch to the user (and to a support
   * answer they choose to paste), where an exact number is the useful one.
   *
   * Absent means UNKNOWN — no mark from a previous clean shutdown, or a log that had shrunk under
   * one — and never zero, which would claim the launch had nothing new to read.
   */
  newBytes?: number
  /** How long the first megabyte of the historical read took, ms — the cold-disk hint. Absent when
   *  the log is smaller than a megabyte. */
  firstMbMs?: number
  /**
   * WHAT THE COMMITTED DATA WEIGHS (JOS-458) — the per-file decomposition of the `dataLoaded`
   * phase, which has otherwise always been one number. `shared/dataWeight.ts` states why the rows
   * are generated rather than measured per launch, and which single figure in it is not.
   *
   * Absent on a build with no committed ledger, never a fabricated empty one.
   */
  data?: DataWeightLedger
  /** Did every phase land? False for a launch that quit early (or crashed) mid-boot. */
  complete: boolean
}

/**
 * Why a mark was REFUSED. A typed value, never a thrown error and never a silent NaN: the caller
 * is startup code and must not be able to take the app down, but a phase arriving twice or out of
 * order is a real wiring bug and has to be nameable in a log line.
 */
export type StartupMarkError =
  | { code: 'duplicate'; phase: StartupPhase }
  | { code: 'out-of-order'; phase: StartupPhase; after: StartupPhase }
  | { code: 'time-went-backwards'; phase: StartupPhase; atMs: number; previousMs: number }

export type StartupMarkResult =
  | { ok: true; marks: StartupMark[] }
  | { ok: false; error: StartupMarkError; marks: StartupMark[] }

const phaseIndex = (phase: StartupPhase): number => STARTUP_PHASES.indexOf(phase)

/**
 * Has `phase` already landed? The question `addMark` asks itself before refusing a duplicate —
 * exported so a caller that has a LEGITIMATE reason to expect a repeat can ASK instead of marking
 * and being refused (JOS-99).
 *
 * There is exactly one such caller today, and it is a fact about the app rather than a loophole:
 * `rendererHydrated` is sent by the renderer, and a renderer can RELOAD (the dev watcher, the
 * did-fail-load retry, the render-process-gone recovery). Every one of those re-mounts the hook
 * that sends it, so the second send is the expected consequence of a reload — not a wiring bug,
 * and not something errors.log should carry. The refusal itself is untouched and stays LOUD for
 * every other phase, all of which are marked once from a single main-side call site where a
 * duplicate really would mean the wiring is wrong.
 */
export function phaseMarked(marks: readonly StartupMark[], phase: StartupPhase): boolean {
  return marks.some((m) => m.phase === phase)
}

/** Are these two phases allowed to arrive in either order? (See CONCURRENT_PHASES.) */
const race = (a: StartupPhase, b: StartupPhase): boolean =>
  CONCURRENT_PHASES.includes(a) && CONCURRENT_PHASES.includes(b)

/**
 * Record one mark against the marks so far. PURE — returns the new list, never mutates.
 *
 * Three refusals, and each one protects the same property: that `buildProfile` can subtract
 * consecutive marks and always get a non-negative number.
 *   * duplicate            — a phase marked twice would make one duration 0 and hide the other.
 *   * out-of-order         — a LATER phase already landed, so this one is wired to the wrong
 *                            place. Exempt: the two phases that genuinely race
 *                            (CONCURRENT_PHASES), which may arrive either way round.
 *   * time-went-backwards  — the clock disagreed with the order. `performance.now()` is monotonic,
 *                            so this is unreachable in practice and is exactly why it is checked:
 *                            an unreachable invariant that is never asserted is a hope.
 *
 * Accepted marks are kept in ARRIVAL order, which is time order — so a profile reads as the
 * launch actually happened, not as the enum wishes it had.
 */
export function addMark(
  marks: readonly StartupMark[],
  phase: StartupPhase,
  atMs: number
): StartupMarkResult {
  const kept = [...marks]
  if (phaseMarked(kept, phase)) {
    return { ok: false, error: { code: 'duplicate', phase }, marks: kept }
  }
  const last = kept[kept.length - 1]
  if (last && phaseIndex(phase) < phaseIndex(last.phase) && !race(phase, last.phase)) {
    return { ok: false, error: { code: 'out-of-order', phase, after: last.phase }, marks: kept }
  }
  const at = Math.max(0, finite(atMs))
  if (last && at < last.atMs) {
    return {
      ok: false,
      error: { code: 'time-went-backwards', phase, atMs: at, previousMs: last.atMs },
      marks: kept
    }
  }
  return { ok: true, marks: [...kept, { phase, atMs: at }] }
}

/** English for a refusal, for the one log line it earns. */
export function describeMarkError(error: StartupMarkError): string {
  if (error.code === 'duplicate') return `startup phase '${error.phase}' was marked twice`
  if (error.code === 'out-of-order') {
    return `startup phase '${error.phase}' arrived after '${error.after}'`
  }
  return `startup phase '${error.phase}' at ${String(error.atMs)}ms precedes ${String(error.previousMs)}ms`
}

/** What a profile carries beyond its marks. Its own interface so `buildProfile` stays at two
 *  parameters and every caller states the same four facts. */
export interface StartupProfileMeta {
  startedAt: number
  version: string
  eventsReplayed?: number
  block?: StartupBlockStats
  replay?: ReplayDutyStats
  stutter?: StartupStutterProbe
  newBytes?: number
  firstMbMs?: number
  data?: DataWeightLedger
}

/**
 * Marks → profile, in ARRIVAL (i.e. chronological) order. Durations are differences between
 * CONSECUTIVE marks, so they sum to `totalMs` exactly and no phase can be blamed for another's
 * cost. `addMark` has already guaranteed the timestamps are monotonic, which is what keeps every
 * duration ≥ 0 even where two phases raced.
 */
export function buildProfile(
  marks: readonly StartupMark[],
  meta: StartupProfileMeta
): StartupProfile {
  let previous = 0
  const phases = marks.map((m) => {
    const durationMs = round(Math.max(0, m.atMs - previous), 1)
    previous = m.atMs
    return { phase: m.phase, atMs: round(m.atMs, 1), durationMs }
  })
  const profile: StartupProfile = {
    startedAt: meta.startedAt,
    version: meta.version,
    phases,
    totalMs: round(previous, 1),
    complete: marks.length === STARTUP_PHASES.length
  }
  if (meta.eventsReplayed !== undefined) profile.eventsReplayed = Math.max(0, meta.eventsReplayed)
  if (meta.block !== undefined) profile.block = meta.block
  if (meta.replay !== undefined) {
    profile.replay = {
      slices: Math.max(0, Math.round(finite(meta.replay.slices))),
      workMs: round(Math.max(0, finite(meta.replay.workMs)), 1),
      restMs: round(Math.max(0, finite(meta.replay.restMs)), 1)
    }
  }
  // JOS-57's scope addition. The probe folded its own numbers (`foldStutterSamples`), so this
  // copies rather than re-rounds; the other two are single values and are cleaned here.
  if (meta.stutter !== undefined) profile.stutter = meta.stutter
  if (meta.newBytes !== undefined) profile.newBytes = Math.max(0, Math.round(finite(meta.newBytes)))
  if (meta.firstMbMs !== undefined) profile.firstMbMs = round(Math.max(0, finite(meta.firstMbMs)), 1)
  // Copied rather than re-cleaned: `foldDataWeight` has already rounded and totalled its own
  // numbers, the same reason `stutter` is copied above.
  if (meta.data !== undefined) profile.data = meta.data
  return profile
}

/** Shape check for the block stats read back off disk. The three ORIGINAL fields or none — a
 *  half-parsed probe result would let a reader draw a conclusion from a number the file never
 *  stated. `worstAtMs` is optional and is simply absent from a profile written before it existed
 *  (JOS-59), which is exactly what "the worst block's position is unknown for that launch" means. */
function parseBlockStats(raw: unknown): StartupBlockStats | null {
  if (!isPlainObject(raw)) return null
  if (typeof raw.samples !== 'number' || typeof raw.maxBlockMs !== 'number') return null
  if (typeof raw.blocksOver50Ms !== 'number') return null
  return {
    samples: Math.max(0, finite(raw.samples)),
    maxBlockMs: Math.max(0, finite(raw.maxBlockMs)),
    blocksOver50Ms: Math.max(0, finite(raw.blocksOver50Ms)),
    ...(typeof raw.worstAtMs === 'number' ? { worstAtMs: Math.max(0, finite(raw.worstAtMs)) } : {})
  }
}

/** Shape check for the duty stats read back off disk. All three fields or none, for the same
 *  reason `parseBlockStats` insists: a half-parsed ledger invites a duty computed from one number
 *  the file never stated. */
function parseReplayStats(raw: unknown): ReplayDutyStats | null {
  if (!isPlainObject(raw)) return null
  if (typeof raw.slices !== 'number' || typeof raw.workMs !== 'number') return null
  if (typeof raw.restMs !== 'number') return null
  return {
    slices: Math.max(0, finite(raw.slices)),
    workMs: Math.max(0, finite(raw.workMs)),
    restMs: Math.max(0, finite(raw.restMs))
  }
}

/** Shape check for the stutter probe read back off disk. All six fields or none, the same rule
 *  its two neighbours follow — and absent from every profile written before JOS-57's scope
 *  addition, which is exactly what "that launch measured no drift" means. */
function parseStutterProbe(raw: unknown): StartupStutterProbe | null {
  if (!isPlainObject(raw)) return null
  const keys = ['samples', 'p50Ms', 'p95Ms', 'maxMs', 'lateTicks', 'latePct'] as const
  if (keys.some((k) => typeof raw[k] !== 'number')) return null
  return {
    samples: Math.max(0, finite(raw.samples)),
    p50Ms: Math.max(0, finite(raw.p50Ms)),
    p95Ms: Math.max(0, finite(raw.p95Ms)),
    maxMs: Math.max(0, finite(raw.maxMs)),
    lateTicks: Math.max(0, finite(raw.lateTicks)),
    latePct: Math.max(0, finite(raw.latePct))
  }
}

/**
 * Shape check for the data ledger read back off disk (JOS-458).
 *
 * STRUCTURAL rather than field by field, and that is a deliberate difference from its three
 * neighbours: they are small fixed shapes a reader draws a conclusion from, while this is a table
 * whose consumers (the bench, and a person) re-read it whole. Its correctness is guarded where it
 * is WRITTEN — `tests/dataWeight.test.mts` re-reads every listed file's real size against the
 * committed ledger — so a per-field parser here would be a second, weaker copy of that check
 * standing between a disposable file and its own author.
 */
function parseDataWeight(raw: unknown): DataWeightLedger | null {
  if (!isPlainObject(raw) || !Array.isArray(raw.rows)) return null
  return raw as unknown as DataWeightLedger
}

/** Shape check for a profile read back off disk — the file half's parser (never a migration:
 *  a profile is disposable by design, so anything unexpected simply means "no last startup"). */
export function parseStartupProfile(raw: unknown): StartupProfile | null {
  if (!isPlainObject(raw)) return null
  const phases = raw.phases
  if (!Array.isArray(phases)) return null
  const timings: StartupPhaseTiming[] = []
  for (const entry of phases) {
    if (!isPlainObject(entry)) continue
    const phase = STARTUP_PHASES.find((p) => p === entry.phase)
    if (!phase) continue
    timings.push({ phase, atMs: finite(entry.atMs), durationMs: finite(entry.durationMs) })
  }
  if (timings.length === 0) return null
  const block = parseBlockStats(raw.block)
  const replay = parseReplayStats(raw.replay)
  const stutter = parseStutterProbe(raw.stutter)
  const data = parseDataWeight(raw.data)
  return {
    startedAt: finite(raw.startedAt),
    version: typeof raw.version === 'string' ? raw.version : '',
    phases: timings,
    totalMs: finite(raw.totalMs),
    ...optionalCount(raw.eventsReplayed, 'eventsReplayed'),
    ...(block === null ? {} : { block }),
    ...(replay === null ? {} : { replay }),
    ...(stutter === null ? {} : { stutter }),
    ...optionalCount(raw.newBytes, 'newBytes'),
    ...optionalCount(raw.firstMbMs, 'firstMbMs'),
    ...(data === null ? {} : { data }),
    complete: raw.complete === true
  }
}

/**
 * One optional number off the file, under `key`, or nothing at all. Three fields read exactly this
 * way (a count and the two JOS-57 measurements), and folding them into one helper keeps the parser
 * inside the repo's complexity ceiling — a number that is simply not there stays not there, which
 * is the whole distinction these fields carry.
 */
function optionalCount(raw: unknown, key: string): Record<string, number> {
  return typeof raw === 'number' ? { [key]: Math.max(0, finite(raw)) } : {}
}

// -------------------------------------------------------------------------------- the pref

/**
 * The HUD switch (plan P5). OFF by default and it stays that way: an enabled HUD costs a 2 s
 * metrics poll, a 500 ms lag probe and an IPC message every two seconds, and a user who has
 * never wondered about performance should pay none of it. Nothing else is persisted — the
 * samples are a two-minute ring in renderer memory and the startup profile is one file.
 */
export interface PerfHudPrefs {
  enabled: boolean
}

export const DEFAULT_PERF_HUD_PREFS: PerfHudPrefs = { enabled: false }

/** Defaulted field by field, from `unknown`: the same value arrives from the store file, from a
 *  renderer toggle and from the v6 → v7 migration. */
export function normalizePerfHudPrefs(value: unknown): PerfHudPrefs {
  const v = isPlainObject(value) ? value : {}
  return { enabled: typeof v.enabled === 'boolean' ? v.enabled : DEFAULT_PERF_HUD_PREFS.enabled }
}
