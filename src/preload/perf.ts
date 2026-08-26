// preload/perf.ts — the performance-HUD half of the app bridge (docs/plans/perf-profiling.md).
//
// Spread into `api` in index.ts rather than written there, because that file is at the repo's
// 400-code-line factoring ceiling and the answer to that is a split, not a widened threshold.
// It is the same one-module-per-domain shape main's `ipc/` uses, and it changes nothing about
// the surface: `window.eq.getPerfPrefs()` and friends sit exactly where they always would.
//
// NOTHING HERE COSTS ANYTHING WHILE THE HUD IS OFF. Main creates no timer until the switch is
// on, so `onPerfSample` subscribes to a channel that is genuinely silent — which is why the
// title-bar chip may subscribe unconditionally.

import { ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { EnginePerfSample } from '../shared/enginePerf'
import type { PerfHudPrefs, PerfSample, StartupProfile } from '../shared/perf'
import type { ProcessPriorityPrefs } from '../shared/processPriority'

export const perfBridge = {
  /**
   * Subscribe to the live sample push (one every 2 s while the HUD is on). The payload is
   * `null` EXACTLY ONCE when the HUD is switched off — the chip hides on it rather than freezing
   * on the last numbers it received, which is what "hidden entirely when disabled" means.
   */
  onPerfSample: (cb: (sample: PerfSample | null) => void): (() => void) => {
    const listener = (_e: unknown, sample: PerfSample | null): void => cb(sample)
    ipcRenderer.on(IPC.onPerfSample, listener)
    return () => ipcRenderer.removeListener(IPC.onPerfSample, listener)
  },
  /**
   * Subscribe to the ENGINE section's push (JOS-483). `null` means there is nothing to draw —
   * the engine flag is off, this build carries no engine binary, or the watch has just stopped —
   * and the section hides on it rather than freezing on the last numbers it saw, exactly as the
   * chip does on a `null` sample.
   *
   * SUBSCRIBING COSTS NOTHING. Main polls only while `watchEnginePerf(true)` is in force, so a
   * component may subscribe on mount and decide separately when to ask for numbers.
   */
  onEnginePerf: (cb: (sample: EnginePerfSample | null) => void): (() => void) => {
    const listener = (_e: unknown, sample: EnginePerfSample | null): void => cb(sample)
    ipcRenderer.on(IPC.onEnginePerf, listener)
    return () => ipcRenderer.removeListener(IPC.onEnginePerf, listener)
  },
  /**
   * "The performance panel is open" / "it is closed" — the ENGINE poll's only arming signal.
   *
   * IT IS THE RENDERER'S JOB TO SAY BOTH, and to say `false` on unmount, because the engine's
   * numbers cost a loopback round trip and a native per-pid read. A perf surface that polled for
   * the hours the app is up would be the bug it exists to find; a popover is open for seconds.
   */
  watchEnginePerf: (open: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.perfEngineWatch, open) as Promise<void>,
  /** The persisted HUD switch. Off by default. */
  getPerfPrefs: (): Promise<PerfHudPrefs> => ipcRenderer.invoke(IPC.perfPrefsGet),
  /** Flip the HUD switch; the sampler starts/stops in the same call, so the first sample lands
   *  immediately rather than at the next tick. Resolves to what was actually stored. */
  setPerfHudEnabled: (enabled: boolean): Promise<PerfHudPrefs> =>
    ipcRenderer.invoke(IPC.perfSetEnabled, enabled),
  /** The persisted "yield CPU to the game" switch (JOS-366). ON by default. */
  getProcessPriority: (): Promise<ProcessPriorityPrefs> =>
    ipcRenderer.invoke(IPC.processPriorityGet),
  /** Flip it; main + every renderer are re-prioritised in the same call, so the switch describes
   *  what the app is doing rather than what it will do after a relaunch. Resolves to what was
   *  actually stored. */
  setYieldToGame: (enabled: boolean): Promise<ProcessPriorityPrefs> =>
    ipcRenderer.invoke(IPC.processPrioritySet, enabled),
  /** The startup profile for the launch you are in (also written to disk for the next one). */
  getStartupProfile: (): Promise<StartupProfile> => ipcRenderer.invoke(IPC.perfGetStartup),
  /** Report the `rendererHydrated` startup phase — the one mark only the renderer can make.
   *  Fire-and-forget: a startup measurement must never be something the UI waits on, and a
   *  duplicate is refused by main's phase accounting rather than by a flag kept here. */
  reportRendererHydrated: (): void => {
    try {
      ipcRenderer.send(IPC.perfRendererHydrated)
    } catch {
      // A missing startup mark is a missing measurement, never a broken window.
    }
  }
}
