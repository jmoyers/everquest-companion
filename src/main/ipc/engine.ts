// IPC: what the shell may ask about the engine's LAUNCH (JOS-503).
//
// Two channels, and neither of them carries game data — which is why they are here rather than in
// `src/main/dataServer/`. The engine's brokered wire (`engine:connect` / `engine:port`) is main
// getting out of a renderer's way; these two are main answering for itself about a child process it
// supervises, which is the boundary main is allowed to speak on (plan §"The shape": window
// management and the OS, no game data ever).
//
// WHY A LEAF OF ITS OWN. `engine:retry` reaches `engineHost.ts`, and `engineHost.ts` imports
// `rendererBroker.ts` — so registering these beside `engine:connect` would close a require cycle
// between the broker and the composition root. `src/main/ipc/*` is already the layer that imports
// downward and is imported by nothing, so it is where the loop opens. `perf.ts` next door states
// the same rule from the other side ("keeping the dependency one-way means the store can stay
// reachable from module scope without a cycle").
//
// NEITHER HOLDS A GATE, deliberately, and they are registered in every build:
//   * `engine:launchState` reads a value that always exists — there is always a launch state, and
//     `starting` is the honest one before anything has happened.
//   * `engine:retry` reaches a supervisor that MAY not exist (nothing has started one yet), and
//     answers by doing nothing rather than by throwing. A retry with nothing to retry is not an
//     error; it is a button pressed a moment early.
//
// THE RETRY VALIDATES NOTHING BECAUSE IT TAKES NOTHING. It is a verb with no payload — the
// `perf:rendererHydrated` shape — so there is no argument to distrust. It is an `invoke` rather
// than a send only so the renderer can disable its own button until the round trip returns, which
// is what stops a frustrated double-click becoming two launches.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { engineLaunchSay } from '../dataServer/engineLaunchState'
import { retryEngineSupervisor } from '../dataServer/engineHost'

/** Register both. Called from `registerIpc()` beside every other domain. */
export function registerEngineLaunchIpc(): void {
  ipcMain.handle(IPC.engineLaunchState, () => engineLaunchSay())
  ipcMain.handle(IPC.engineRetry, () => {
    retryEngineSupervisor()
  })
}
