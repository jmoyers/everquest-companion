// ============================================================================
// enginePerf.ts — THE ENGINE'S ROW IN THE PERFORMANCE PANEL, as pure data (JOS-483).
// ============================================================================
//
// > "i want to see the server in the cpu/performance overlay in app."
//
// `shared/perf.ts` is the pure half of the HUD — the fold, the percentile, the formatters, all of
// it testable with no Electron and no window. This is the same half for the engine section, and it
// is a separate file for the reason `preload/perf.ts` is separate from `preload/index.ts`: that one
// is at the repo's factoring ceiling and the answer to that is a split.
//
// TWO SOURCES, ONE SHAPE, AND THE JOIN IS MAIN'S. The engine's row has two halves that no single
// reader could give:
//
//   * WHAT THE OS SEES — CPU and working set for the engine's pid. `app.getAppMetrics()` cannot
//     answer it (Chromium's own process list does not contain a child this app spawned), so
//     `main/processSample.ts` reads it directly.
//   * WHAT THE ENGINE SAYS — status, epoch, events, the mark, the ingest's bill and the serve
//     table. `perf.snapshot` (owner ruling 19), asked over the one door.
//
// Main joins them and pushes one object. The renderer never talks to the engine — brokering a
// client into a window is a separate ticket — so this arrives on the perf channels that already
// exist, exactly like every other number in that panel.
//
// EVERY FIELD THAT COULD BE UNKNOWN IS `null` RATHER THAN ZERO, and that is the same law
// `HealthResult`'s optional fields keep at the other end of the wire. A CPU percentage needs an
// interval behind it; a scan time does not exist until a scan finishes; a parity verdict that has
// not run has established nothing. Each of those is drawn as its own words, never as a zero that
// reads like a measurement.

import type { PerfBudgetsResult, PerfSnapshotResult } from './dataServer/protocol.generated'

/**
 * Where the supervisor is, as the panel needs to know it.
 *
 * `'absent'` IS NOT HERE, deliberately. A build with no engine binary is the ordinary state of any
 * checkout that has not run `cargo build`, and the panel does not draw an ENGINE section at all in
 * that case — so an absent engine is the absence of this whole object rather than a value inside
 * it. Main's `engineSupervisorStatus()` owns that gate.
 */
export type EngineSupervisorSay = 'stopped' | 'starting' | 'ready' | 'backoff' | 'stopping'

/** What the OS says about the engine's process. */
export interface EngineProcessSay {
  pid: number
  /** Percent of ONE core — Chromium's own convention, so this row compares with the ones above
   *  it. `null` on the first reading of a pid: a rate needs an interval. */
  cpuPercent: number | null
  /** Resident working set, MB. `null` when the handle could not be opened wide enough. */
  memoryMb: number | null
}

/** The last parity probe's counts, and when it finished. */
export interface EngineParitySay {
  at: number
  logPath: string
  agree: number
  diverge: number
  skipped: number
}

/** One push: everything the ENGINE section draws, at one instant. */
export interface EnginePerfSample {
  /** Host clock at the join, so the panel can age the engine's own log timestamp against it. */
  ts: number
  supervisor: EngineSupervisorSay
  /** `null` when no engine process is running, or when this platform cannot read one. */
  process: EngineProcessSay | null
  /** `null` when there is no connected client to ask, or the engine refused. */
  engine: PerfSnapshotResult | null
  /**
   * THE ENGINE'S OWN BUDGETS AND ITS VERDICT ON THEM (ruling 19, JOS-502) — `null` on the same
   * terms as `engine`.
   *
   * IT RIDES EVERY TICK RATHER THAN BEING FETCHED ONCE, and the reason is the one moment this
   * surface exists for: the fold-rate verdict goes `unmeasured` → judged the instant the scan
   * finishes, which is exactly the stretch a person has the panel open watching the engine come up.
   * A budget read once at mount would show `unmeasured` for the whole of it and then never correct
   * itself. The extra cost is one small round trip on a connection that is already open and only
   * while the panel is open at all (`enginePerfWatch.ts`).
   */
  budgets: PerfBudgetsResult | null
  /** `null` when no parity probe has run in this launch — which is NOT "everything agreed". */
  parity: EngineParitySay | null
}

/**
 * THE POLL CADENCE, and it is the panel's own (`PERF_SAMPLE_INTERVAL_MS`) rather than a second
 * number. One object arrives every two seconds beside the process sample, so the two halves of the
 * panel never drift into showing different instants.
 */
export const ENGINE_PERF_INTERVAL_MS = 2_000

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * A FIRE COUNT, IF THE ENGINE EVER REPORTS ONE — read defensively and absent by default.
 *
 * No build of the engine publishes this today and the generated type has no field for it, so this
 * is a forward read rather than a live one: the moment a schema edit adds it, the panel draws it
 * with no further work, and until then the row simply is not there. It is written as a widened
 * property read rather than a cast to a hand-written shape, because a hand-written shape would be
 * a second opinion about a contract that has exactly one source.
 */
export function engineFireCount(result: PerfSnapshotResult | null): number | null {
  if (result === null) return null
  const value = (result as unknown as Record<string, unknown>).fires
  return finite(value) ? value : null
}

/** `2.4 MB/s`-style byte formatting for the scan's own total. `formatMemory` is for resident
 *  memory and rounds to MB; a scan reads hundreds of MB and its number wants the same shape. */
export function formatBytes(bytes: number): string {
  const b = Math.max(0, finite(bytes) ? bytes : 0)
  if (b >= 1024 * 1024 * 1024) return `${String(Math.round((b / 1024 / 1024 / 1024) * 10) / 10)} GB`
  if (b >= 1024 * 1024) return `${String(Math.round(b / 1024 / 1024))} MB`
  if (b >= 1024) return `${String(Math.round(b / 1024))} kB`
  return `${String(Math.round(b))} B`
}

/**
 * A microsecond figure a person reads, at a precision that does not throw it away.
 *
 * THE SAME RULE THE ENGINE'S OWN STDERR LINE KEEPS (`views::meter::took`): under a millisecond it
 * stays in microseconds, because cutting a fifty-row window off a fold takes tens of them and a
 * serve path that reported `0.0 ms` would read as a measurement nobody took rather than as the
 * good news it is.
 */
export function formatMicros(us: number): string {
  const v = Math.max(0, finite(us) ? us : 0)
  return v < 1000 ? `${String(Math.round(v))} µs` : `${String(Math.round(v / 100) / 10)} ms`
}

/**
 * HOW STALE THE ENGINE'S VIEW OF THE LOG IS, in words.
 *
 * `lastEventTs` IS THE LOG'S OWN CLOCK and `ts` is the host's, and the subtraction is deliberately
 * done HERE rather than in the engine — the engine reads no wall clock to answer `perf.snapshot`,
 * which is the determinism law its store seam is built on (`world.rs`'s header, law 1).
 *
 * `null` when there is nothing to age: no fold has produced a stamped event. A clock skew that
 * puts the log's last line in the future is reported as `now` rather than as a negative age,
 * because a negative freshness is a statement about two clocks rather than about the fold.
 */
export function eventFreshnessMs(sample: EnginePerfSample): number | null {
  const last = sample.engine?.lastEventTs
  if (!finite(last)) return null
  return Math.max(0, sample.ts - last)
}

/**
 * AN AGE A PERSON READS, at whatever scale it happens to be.
 *
 * `shared/perf.ts`'s `formatMs` is the right formatter for a lag figure and the wrong one here, and
 * a real run is what showed it: a fixture log whose last line is three weeks old rendered as
 * `1695178.84 s`, which is a number nobody can read and which buries the one fact it was drawn to
 * carry. Freshness spans nine orders of magnitude — a live session is milliseconds behind, a log
 * the game has not written to since last month is weeks — so the unit follows the value.
 *
 * COARSE ON PURPOSE ABOVE A MINUTE. "3 days behind" and "3.06 days behind" answer the same question,
 * and the second one invites arithmetic nobody wanted to do (`formatCpu`'s argument, one panel over).
 */
export function formatAge(ms: number): string {
  const v = Math.max(0, finite(ms) ? ms : 0)
  if (v < 1_000) return `${String(Math.round(v))} ms`
  if (v < 60_000) return `${String(Math.round(v / 100) / 10)} s`
  if (v < 3_600_000) return `${String(Math.round(v / 60_000))} min`
  if (v < 86_400_000) return `${String(Math.round(v / 360_000) / 10)} h`
  return `${String(Math.round(v / 8_640_000) / 10)} days`
}

/** `live · epoch 2` — the engine's state in the two terms that decide what everything else means. */
export function formatEngineState(sample: EnginePerfSample): string {
  const engine = sample.engine
  if (engine === null) return `${sample.supervisor} · not answering`
  return `${engine.status} · epoch ${String(engine.epoch)}`
}

/**
 * `5 agree · 0 diverge · 0 skipped`, or the honest absence.
 *
 * A PROBE THAT NEVER RAN IS NOT A CLEAN BILL, which is why the empty case says so in words. It is
 * the same mistake `engineHost.ts` refuses to make about a missing binary: silence and success
 * must never look alike.
 */
export function formatParity(parity: EngineParitySay | null): string {
  if (parity === null) return 'no probe has run'
  return `${String(parity.agree)} agree · ${String(parity.diverge)} diverge · ${String(parity.skipped)} skipped`
}
