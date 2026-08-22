// logStream.ts — the slice of the main app's bridge that carries WHAT THE LOG IS DOING: each parsed
// line, the active character being rebuilt, and (JOS-432) the offer to follow a different one.
//
// A separate file for FILE MASS, not for scope: src/preload/index.ts sits at the measured
// 400-code-line ceiling and the rule here is to SPLIT rather than ratchet (knowledge.ts, roster.ts,
// windows.ts, sounds.ts and perf.ts are the same pattern). This object is spread into that bridge,
// so `window.eq.onLine` / `onCharacter` are the same members they always were and no call site
// moved — `onLogSwitchNudge` simply joined the two subscriptions it belongs beside.
//
// All three are one-way pushes with the same contract: subscribe, get an unsubscribe back.

import { ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { CharacterRef, LogLine, LogSwitchNudge } from '../shared/types'

export const logStreamBridge = {
  onLine: (cb: (line: LogLine) => void): (() => void) => {
    const listener = (_e: unknown, line: LogLine): void => cb(line)
    ipcRenderer.on(IPC.onLine, listener)
    return () => ipcRenderer.removeListener(IPC.onLine, listener)
  },
  /** Main rebuilt the world for a character (startup, or any switch). Views re-hydrate on this. */
  onCharacter: (cb: (c: CharacterRef | null) => void): (() => void) => {
    const listener = (_e: unknown, c: CharacterRef | null): void => cb(c)
    ipcRenderer.on(IPC.onCharacter, listener)
    return () => ipcRenderer.removeListener(IPC.onCharacter, listener)
  },
  /**
   * "Another character's log is active — switch?" (JOS-432): the attached log has been silent for
   * minutes while a sibling `eqlog_*.txt` grows.
   *
   * IT ARRIVES AT MOST ONCE PER CANDIDATE LOG PER APP SESSION, guaranteed structurally in main
   * (src/main/log/quietSwitch.ts) — so a subscriber may render it directly and needs no rate
   * limiting, no seen-set and no dedupe of its own. Nothing switches until the user says so.
   */
  onLogSwitchNudge: (cb: (n: LogSwitchNudge) => void): (() => void) => {
    const listener = (_e: unknown, n: LogSwitchNudge): void => cb(n)
    ipcRenderer.on(IPC.onLogSwitchNudge, listener)
    return () => ipcRenderer.removeListener(IPC.onLogSwitchNudge, listener)
  }
}
