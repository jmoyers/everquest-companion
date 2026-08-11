// IPC: the RESPAWN WATCH LIST (JOS-194 — shared/respawn.ts).
//
// One channel pair over the only thing about respawn clocks that is not derived from the log:
// which mobs you want a clock for, and the number you typed if you typed one.
//
// THE SETTER MUST DO THREE THINGS, AND MISSING ANY ONE IS A SILENT WRONG ANSWER. This is JOS-87's
// lesson applied to a module that has the same shape as the one it was learned on (a second input
// that advances no log seq):
//
//   1. PERSIST — through `normalizeRespawnPrefs`, the SAME normalizer the store reader uses, so a
//      renderer and a hand-edited settings file cannot hold two ideas of what a watch is. Validated
//      at the handler and never trusted because today's only caller is the app's own UI (the
//      `sounds:getData` rule).
//   2. APPLY LIVE — `setPrefs` on the running module, which bumps its private revision. Waiting for
//      the next launch would make "watch this mob" do nothing until you restart.
//   3. PUSH NOW — `registry.flushNow()`. `setPrefs` marks the module dirty, but the flush that
//      carries it is on a 1 s heartbeat that only runs while the tail is LIVE. A user adding a
//      watch is by definition looking at the screen, and quite possibly parked in a zone with an
//      idle log; without this the row appears whenever the next log line happens to arrive, which
//      on an idle log is never. The combo module's `republish()` is the precedent.
//
// The GET exists for the same reason its siblings' do: the renderer's editor mounts before any
// module delta has necessarily arrived, and the prefs also ride inside the module snapshot, so
// this is the cheap read that does not depend on the fold's timing.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { getRespawnPrefs, setRespawnPrefs } from '../storeRespawn'
import { registry, respawnModule } from '../pipeline'

export function registerRespawnIpc(): void {
  ipcMain.handle(IPC.respawnGet, () => getRespawnPrefs())
  ipcMain.handle(IPC.respawnSet, (_e, value: unknown) => {
    const next = setRespawnPrefs(value)
    respawnModule.setPrefs(next)
    registry.flushNow()
    return next
  })
}
