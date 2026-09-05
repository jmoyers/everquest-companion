// ============================================================================
// enginePerfWatch.ts — the ENGINE's numbers, polled ONLY while somebody is looking (JOS-483).
// ============================================================================
//
// > "i want to see the server in the cpu/performance overlay in app." — owner, ruling 19 surface.
//
// WHAT IT JOINS. Two readers that no single caller could be:
//
//   * `processSample.ts` — CPU and working set for the engine's pid, straight off Windows.
//     `app.getAppMetrics()` cannot answer it: that is Chromium's own process list and the engine is
//     a child THIS app spawned, not one Chromium did.
//   * `dataServer/engineClientHost.ts` — `perf.snapshot` over the one door, plus the counts the
//     last parity probe established.
//
// One object out, on the perf channel family that already exists. The renderer never speaks to the
// engine (brokering a client into a window is JOS-484); main measures, main pushes, exactly as it
// does for every other number in that panel.
//
// ── THE POLLING DISCIPLINE, WHICH IS THE POINT OF THIS FILE ────────────────────────────────────
//
// THE PERF SURFACE MUST NOT BECOME A PERF COST. `perf.ts`'s rule 1 is that an instrument which
// costs something is a bug, and this instrument is not free: a loopback round trip that makes the
// engine's ingest thread answer at its next boundary, plus two Win32 calls and a handle open. That
// is nothing at two-second intervals for the seconds a popover is open, and it is a real
// (small, permanent, entirely wasted) tax if it runs for the hours the app is up.
//
// So the poll is armed by the RENDERER SAYING THE PANEL IS OPEN and disarmed the moment it closes:
//
//   * `startEnginePerfWatch()` — the panel opened. Emits IMMEDIATELY (so the section is populated
//     rather than blank for two seconds) and then every `ENGINE_PERF_INTERVAL_MS`.
//   * `stopEnginePerfWatch()` — the panel closed, the window went away, or the app is quitting.
//     Clears the timer and pushes one `null`, which is how the section learns to disappear instead
//     of freezing on the last numbers it saw — `stopPerfSampler`'s contract, restated.
//
// THE TIMER IS `unref`'d, like every other timer in this process: a diagnostic must never be the
// reason a quitting app stays alive.
//
// ── WHAT IT DOES WHEN THERE IS NO ENGINE ───────────────────────────────────────────────────────
//
// It says so, once, with a `null` push, and does not arm a timer at all. `EQC_ENGINE=0` and a
// build with no engine binary are the same answer to the panel — there is no ENGINE section to
// draw — and they are distinguished nowhere but in `engineSupervisorStatus()`, which owns that
// gate so this file does not re-decide it.

import { logError } from './errorLog'
import { sendToMain } from './windows'
import { IPC } from '../shared/ipc'
import {
  ENGINE_PERF_INTERVAL_MS,
  type EnginePerfSample,
  type EngineProcessSay,
  type EngineSupervisorSay
} from '../shared/enginePerf'
import { enginePerfBudgets, enginePerfSnapshot } from './dataServer/engineClientHost'
import { engineSupervisorStatus } from './dataServer/engineHost'
import { getEnginePid } from './processPriority'
import { createProcessSampler, systemProcessReader } from './processSample'

let timer: ReturnType<typeof setInterval> | null = null
/** Guards against a slow round trip overlapping the next tick — see `emit`. */
let inFlight = false

/** One sampler for the life of the process: it remembers the last CPU total per pid, and that
 *  memory is what makes the SECOND poll a rate rather than another "measuring". */
const sampler = createProcessSampler(systemProcessReader())

/** Is the watch armed right now? The IPC's idempotence guard, and a test's seam. */
export function enginePerfWatching(): boolean {
  return timer !== null
}

/**
 * The engine's supervisor status, narrowed to what the panel draws.
 *
 * `null` (the flag is off) and `'absent'` (this build has no binary) both mean THERE IS NO SECTION,
 * and they collapse here rather than in the renderer: a UI that had to know what `absent` meant
 * would be a second place the gate lives.
 */
function drawableStatus(): EngineSupervisorSay | null {
  const status = engineSupervisorStatus()
  if (status === null || status === 'absent') return null
  return status
}

/** The OS's half. `null` when no engine process is running, or this platform cannot read one. */
function processSay(): EngineProcessSay | null {
  const pid = getEnginePid()
  if (pid === null) return null
  const sample = sampler.sample(pid)
  if (sample === null) return null
  return { pid, cpuPercent: sample.cpuPercent, memoryMb: sample.memoryMb }
}

/**
 * One join, and one push.
 *
 * IT NEVER OVERLAPS ITSELF. `perf.snapshot` waits on the engine's ingest thread, which answers at a
 * boundary it already reaches — one nap while live, one megabyte mid-scan — so a poll during a
 * historical fold can outlast its own interval. Stacking those would put several requests on one
 * connection for a panel that can only draw the last of them, which is the "rapid-switch crash
 * preempted instead of stacked" lesson applied to a diagnostic.
 */
async function emit(): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    const supervisor = drawableStatus()
    if (supervisor === null) {
      sendToMain(IPC.onEnginePerf, null)
      return
    }
    const sample: EnginePerfSample = {
      ts: Date.now(),
      supervisor,
      process: processSay(),
      engine: await enginePerfSnapshot(),
      // THE BUDGETS RIDE THE SAME TICK (ruling 19, JOS-502). Sequential rather than raced with the
      // snapshot on purpose: the engine answers both through ONE door on the ingest thread's own
      // boundary, so two concurrent asks would queue behind each other anyway and the only thing
      // `Promise.all` would buy is two in-flight requests to abandon when the panel closes.
      budgets: await enginePerfBudgets(),
      // ALWAYS NULL SINCE JOS-499. A parity verdict compared this process's fold against the
      // engine's; there is one fold. The field stays on the wire because the panel already draws
      // a null as "no verdict" and removing it would be a shared-shape change for a row that is
      // permanently empty.
      parity: null
    }
    // The watch may have been stopped while the round trip was in flight; a push after the stop
    // would leave the section holding numbers after it had been told to hide.
    if (timer !== null) sendToMain(IPC.onEnginePerf, sample)
  } catch (err) {
    // A DIAGNOSTIC MUST NEVER BREAK THE THING IT MEASURES. Everything above already degrades to
    // `null` on its own; this is the backstop for the case nobody thought of, and it reports the
    // failure once rather than turning the timer into a source of unhandled rejections.
    logError('main:enginePerf', { message: 'the engine perf poll failed', err })
  } finally {
    inFlight = false
  }
}

/**
 * Arm the poll — the performance panel opened. Idempotent.
 *
 * A BUILD WITH NO ENGINE ARMS NOTHING. The first emit answers `null` and returns without a timer,
 * so an install that will never have an engine pays one `if` per panel open and not one timer for
 * the life of the window.
 */
export function startEnginePerfWatch(): void {
  if (timer !== null) return
  if (drawableStatus() === null) {
    sendToMain(IPC.onEnginePerf, null)
    return
  }
  timer = setInterval(() => {
    void emit()
  }, ENGINE_PERF_INTERVAL_MS)
  timer.unref()
  // AFTER the timer exists, because `emit` checks it before pushing — and the first sample must
  // land immediately rather than two seconds into a popover that is open for five.
  void emit()
}

/** Disarm — the panel closed, or the app is going away. Idempotent, and it always says so. */
export function stopEnginePerfWatch(): void {
  const wasWatching = timer !== null
  if (timer !== null) clearInterval(timer)
  timer = null
  sampler.forget()
  if (wasWatching) sendToMain(IPC.onEnginePerf, null)
}
