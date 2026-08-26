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
import { respawnWithoutWatch } from '../../shared/respawn'
import { getRespawnPrefs, setRespawnPrefs } from '../storeRespawn'
// A FOURTH DUTY, ADDITIVE (JOS-482): the engine's own respawn module holds the same watch list and
// bumps its own revision on the push, which is the engine-side spelling of duties 2 and 3 above.
// Duty 1 — persistence — stays here and only here; the engine never reads a settings file.
import { pushAppKnowledge } from '../dataServer/definePush'
// A FIFTH DUTY, ALSO ADDITIVE (JOS-494), and it goes through a different door than the one above:
// the confirm is a COMMAND rather than app knowledge — nothing persists it here or there — so it
// rides `serveCommands.ts` beside the session mark. That file's header carries the argument.
import { serveConfirmSighting } from '../dataServer/serveCommands'

/**
 * Longest row id the confirm handler will look at. A row id is `<zone key>::<mob key>` and both
 * halves are already bounded by the log's own names; this is the handler-side refusal that keeps a
 * renderer-supplied string from reaching a Map lookup unmeasured (the `sounds:getData` rule — the
 * validation belongs at the door, not at the one caller that exists today).
 */
const MAX_ROW_ID = 160

/**
 * Longest mob key the unwatch handler will look at — the same 64 the store's own normalizer slices
 * a key to, so a string this door accepts is a string that could have been stored in the first
 * place. Same rule as `MAX_ROW_ID` above: the refusal belongs at the door.
 */
const MAX_MOB_KEY = 64

export function registerRespawnIpc(): void {
  ipcMain.handle(IPC.respawnGet, () => getRespawnPrefs())
  ipcMain.handle(IPC.respawnSet, (_e, value: unknown) => {
    const next = setRespawnPrefs(value)
    pushAppKnowledge('respawn.define')
    return next
  })
  /**
   * STOP WATCHING ONE MOB (round 4). All three of the setter's duties apply — persist, apply live,
   * push now — and it is a separate channel from the setter for one reason: the surfaces that call
   * it know a mob, not a list. A clock row in the tab and a row in an interactive overlay each hold
   * exactly one name; making them read the whole watch list, remove an entry and write it back
   * would put a second author on a list they never edited, and the loser of a race would be a watch
   * the user did not touch.
   *
   * It reports `false` — a no-op, honestly — when nothing was watching that name, which is what a
   * click that lost a race with another surface's unwatch looks like. Nothing is persisted in that
   * case, so a stale click cannot re-write the list it agrees with.
   */
  ipcMain.handle(IPC.respawnUnwatch, (_e, key: unknown) => {
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_MOB_KEY) return false
    const current = getRespawnPrefs()
    const next = respawnWithoutWatch(current, key)
    if (next.watches.length === current.watches.length) return false
    setRespawnPrefs(next)
    pushAppKnowledge('respawn.define')
    return true
  })
  /**
   * CONFIRM A SIGHTING (round 3). Two of the setter's three duties apply and the third does not:
   * it applies live and it pushes now, but it PERSISTS NOTHING. The confirmation is a judgement
   * about one spawn of one mob in one session; the fold it lives in is rebuilt from the log at
   * every launch and the log has never heard of it, so a stored copy would outlive its subject
   * (the argument is written out in shared/respawn.ts).
   *
   * It is a no-op — reported honestly as `false` — when the id is unknown or the row is no longer
   * seen, which is what a click racing a death looks like.
   */
  ipcMain.handle(IPC.respawnConfirmSighting, (_e, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ROW_ID) return false
    // THE APP NO LONGER HAS AN OPINION TO GATE ON (JOS-499). This used to run
    // `respawnModule.confirmSighting(id)` first and announce to the engine only when this
    // process's own fold took the press — so a stale click could not be reported as a real one.
    // There is no second fold to disagree, and the engine answers `confirmed: false` for a row
    // it cannot re-base, which is the same refusal arriving from the only world there is.
    //
    // THE HANDLER ANSWERS TRUE, and that is honest rather than optimistic: the press was
    // ACCEPTED and forwarded. Whether it re-based a clock is the engine's answer, and it comes
    // back on the served respawn rows a moment later — which is the surface the person is
    // looking at.
    {
      // A FIFTH DUTY, AND IT IS THE SETTER'S FOURTH ONE IN A DIFFERENT FILE (JOS-494). The two
      // sibling handlers above push through `pushAppKnowledge` because a watch list is app
      // KNOWLEDGE — a preference the engine's world records and re-applies at the next attach. A
      // confirmation is a COMMAND: it is stored by nobody, on either side, so it goes through
      // `serveCommands.ts` beside the session mark, which is the file for exactly that shape of
      // thing. Same fire-and-forget law either way — the person has already been answered by the
      // line above, and an engine that said no is a dev-log line rather than a failed press.
      //
      // AFTER THE APP-SIDE APPLY, AND ONLY WHEN IT TOOK. Inside the `if` rather than beside it:
      // a press this process itself read as a no-op must not be announced to a second world as
      // though it happened.
      serveConfirmSighting(id)
    }
    return true
  })
}
