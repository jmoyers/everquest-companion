// preload/dev.ts — the dev-only slice of the app bridge (JOS-61). One method and one flag.
//
// A separate file for FILE MASS, not for scope: src/preload/index.ts sits at the measured
// 400-code-line ceiling and the rule here is to split rather than ratchet (perf.ts, graphics.ts
// and windows.ts are the same pattern). Spread into `api` there, so `window.eq.restartApp()`
// sits exactly where it would have if it were written inline.
//
// THE TWO MEMBERS ARE DIFFERENT TIERS and that is worth saying out loud (JOS-72). `restartApp`
// is a contributor convenience — credential-free, useful on any fork, gated on plain DEV.
// `ownerTools` is the READOUT of the tier-2 opt-in: it tells the renderer whether the OWNER's
// backlog tab may be shown at all. Reporting a flag is not granting anything; main holds the
// only real door (src/main/ownerTools.ts) and a renderer that ignored this would find no
// handlers behind it.
//
// THE METHOD EXISTS IN EVERY BUILD; WHAT IT DOES DOES NOT. The bridge is a door — main decides
// what is on the other side of it, and in a packaged build the handler refuses having done
// nothing (src/main/ipc/dev.ts). The only caller is compiled out of production bytes anyway
// (`DEV_TOOLS`, anchored on `import.meta.env.DEV`).

import { ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { DevRestartResult } from '../shared/devRestart'
import { ownerToolsOptIn } from '../shared/ownerTools'

export const devBridge = {
  /**
   * Did this launch opt in to OWNER tooling (`EQ_OWNER_TOOLS=1`)? — JOS-72.
   *
   * A STATIC boolean read from `process.env`, exactly like `isE2E` in index.ts and for exactly
   * its reasons: the variable is decided before the process starts and can never change, the
   * renderer has no `process` of its own (nodeIntegration is off), and an IPC round trip would
   * make every consumer async for an answer that is fixed. The renderer combines it with its
   * compile-time `DEV_TOOLS` in ONE reader (src/renderer/src/devFlags.ts).
   *
   * FALSE IS THE ANSWER TO EVERYTHING ELSE. No variable, an empty one, `0`, `true` — all no.
   * This tier degrades CLOSED (see src/shared/ownerTools.ts), which is the opposite of the
   * stale-dev-server rule that governs `DEV_TOOLS`.
   */
  ownerTools: ownerToolsOptIn(process.env),

  /**
   * Restart the app — DEV BUILDS ONLY.
   *
   * The reply says WHICH restart happened (JOS-63), because they feel different: 'relaunched'
   * means this process is already going away, 'watcher' means main asked the electron-vite
   * watcher to rebuild and relaunch it and the window has a couple of seconds left, and
   * 'refused' means nothing happened. Nothing should be sequenced after this promise — in two
   * of the three cases the process dies while it is in flight.
   */
  restartApp: (): Promise<DevRestartResult> => ipcRenderer.invoke(IPC.devRestart),
  isE2E: process.env.EQ_E2E === '1'
}
