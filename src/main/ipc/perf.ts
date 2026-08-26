// IPC: the performance HUD + the startup profile (docs/plans/perf-profiling.md).
//
// Four channels, and the interesting one is the SETTER: flipping the pref is only half the job —
// this session's timers have to come into line with it too. One handler doing both is what makes
// "off means no timer exists" true right now rather than after the next launch, and it is the
// same discipline `applyTelemetryEnabled` uses for the analytics switch.
//
// THE COMPOSITION SEAM. `src/main/perf.ts` deliberately does not import the store: the sampler
// is a mechanism, the pref is a policy, and keeping the dependency one-way means the store can
// stay reachable from module scope without a cycle. So the DECISION lives here (and, at launch,
// in the composition root) — both of which already import both halves.
//
// VALIDATED AT THE HANDLER, never trusted because today's only caller is the app's own UI (the
// `sounds:getData` rule). A non-boolean is not a guess: it leaves the pref exactly as it was.
// `perf:rendererHydrated` carries no payload at all, so there is nothing to validate — it is a
// SEND (fire-and-forget), because a startup mark must never be something the renderer waits on.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import {
  markStartupPhase,
  startPerfSampler,
  startupPhaseMarked,
  startupProfile,
  stopPerfSampler
} from '../perf'
import { startEnginePerfWatch, stopEnginePerfWatch } from '../enginePerfWatch'
import { getPerfHudPrefs, setPerfHudPrefs } from '../store'
import { getProcessPriorityPrefs, setProcessPriorityPrefs } from '../storeProcessPriority'
import { setYieldToGame } from '../processPriority'
import type { PerfHudPrefs } from '../../shared/perf'
import type { ProcessPriorityPrefs } from '../../shared/processPriority'

/** Persist the switch AND bring this session's sampler into line with it. */
export function applyPerfHudEnabled(enabled: boolean): PerfHudPrefs {
  const next = setPerfHudPrefs({ enabled })
  if (next.enabled) startPerfSampler()
  else stopPerfSampler()
  return next
}

/**
 * Persist "yield CPU to the game" AND re-apply the priority class to every process this session
 * owns, in the same call — the same seam `applyPerfHudEnabled` keeps for the sampler, and for the
 * same reason: a setting that only takes effect at the next launch is a setting a player cannot
 * A/B against a stutter they are looking at right now.
 *
 * `setYieldToGame` is the module's own no-op on any platform but Windows and under EQ_E2E, so the
 * decision does not have to be restated here (two copies of a platform gate is how one drifts).
 */
export function applyYieldToGame(yieldToGame: boolean): ProcessPriorityPrefs {
  const next = setProcessPriorityPrefs({ yieldToGame })
  setYieldToGame(next.yieldToGame)
  return next
}

export function registerPerfIpc(): void {
  ipcMain.handle(IPC.perfPrefsGet, () => getPerfHudPrefs())

  ipcMain.handle(IPC.processPriorityGet, () => getProcessPriorityPrefs())

  // VALIDATED AT THE HANDLER, never trusted because today's only caller is the app's own UI: a
  // non-boolean is not a guess, it leaves the pref exactly as it was.
  ipcMain.handle(IPC.processPrioritySet, (_e, yieldToGame: unknown) =>
    typeof yieldToGame === 'boolean' ? applyYieldToGame(yieldToGame) : getProcessPriorityPrefs()
  )

  ipcMain.handle(IPC.perfSetEnabled, (_e, enabled: unknown) =>
    typeof enabled === 'boolean' ? applyPerfHudEnabled(enabled) : getPerfHudPrefs()
  )

  ipcMain.handle(IPC.perfGetStartup, () => startupProfile())

  // THE ENGINE SECTION'S POLL, armed by the panel being open and by nothing else (JOS-483).
  //
  // The same mechanism/policy seam every handler above keeps: `enginePerfWatch.ts` owns the timer
  // and the join, this owns the decision. A non-boolean is not a guess — it leaves the watch
  // exactly as it was — and `false` is idempotent, which matters because a renderer that reloads
  // with the popover open never sends its own close.
  ipcMain.handle(IPC.perfEngineWatch, (_e, open: unknown) => {
    if (typeof open !== 'boolean') return
    if (open) startEnginePerfWatch()
    else stopEnginePerfWatch()
  })

  // The one phase main cannot observe: the renderer is the only thing that knows it has mounted.
  //
  // A REPEAT SEND IS A RELOAD, NOT A BUG (JOS-99). The renderer's own send-once guard is module
  // scope, so every reload resets it — and this app reloads windows on purpose: the dev watcher
  // does it on every renderer edit, `did-fail-load` retries once, and `render-process-gone`
  // recovers by reloading. Each of those re-mounts the hook and sends this again. Handing that to
  // `markStartupPhase` produced "startup phase 'rendererHydrated' was marked twice" in errors.log
  // every single time, which is a large share of the fleet's `mainErrorLogLines` for an event that
  // means the recovery WORKED.
  //
  // So the ignoring happens HERE, at the one channel that can legitimately repeat, and `addMark`
  // is left exactly as strict as it was: every other phase is marked once from a single main-side
  // call site, where a duplicate really is a wiring bug and still earns its logged refusal. The
  // profile keeps the FIRST hydration — the launch's own — because that is the number "how long
  // did this app take to draw its interface" is asking for; a reload three minutes later is not
  // part of the launch and must not overwrite it.
  ipcMain.on(IPC.perfRendererHydrated, () => {
    if (startupPhaseMarked('rendererHydrated')) return
    markStartupPhase('rendererHydrated')
  })
}
