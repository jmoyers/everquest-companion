// APP-WIDE SESSION MARKS — main's copy of "start a new session now", and the ONE instant that
// splits everything (JOS-436's model, JOS-322's seam).
//
// WHY MAIN OWNS IT, and it is two reasons rather than one:
//
//   1. THE SAME REASON `scopeSelection.ts` NEXT DOOR DOES. The Loot ledger, the Leveling surfaces
//      and every floating window are separate RENDERER PROCESSES with no shared memory; the only
//      thing they all already talk to is main. The marks used to be a module variable inside
//      `useTimeslice`, which meant each window quietly kept its own list — the latent second copy
//      that JOS-332 had already had to fix once for the scope selection.
//   2. THE ENGINE IS HERE. The owner's ruling is that one click splits EVERYTHING: the loot ledger
//      AND the meter's engine records, from the same boundary. The combat engine lives in main, so
//      main is the only place that can stamp the instant and hand that very number to
//      `combat.sessionMark(ts)` in the same synchronous breath. A renderer stamping its own clock
//      and telling main afterwards would give the two halves two boundaries a round trip apart —
//      and everything looted in between would fall on the wrong side of one of them.
//
// EPHEMERAL BY DESIGN. Module scope, no electron-store, no migration: the list is empty at every
// launch, exactly as it was when it lived in the renderer (`shared/sessionSegments.ts` states the
// argument — a slice is a thing you choose while you are looking, not a preference). That is also
// half of the replay-determinism story: a mark is stored NOWHERE, so a relaunch replays the log
// into the records the log alone describes. The other half is the engine's own `hydrating` refusal.
//
// IT NEVER TOUCHES A SELECTION. This module knows a list of instants. WHICH segment a surface is
// browsing stays that surface's own pick (`useTimeslice`), and no code path here can move one.

import { IPC } from '../shared/ipc'
import { addSessionMark } from '../shared/sessionSegments'
import { OVERLAY_KINDS } from '../shared/types'
import { combat } from './pipeline'
import { getMainWindow, getOverlayWindow } from './windows'

/** The whole state, ascending. Resets to empty at process start — see the header. */
let marks: number[] = []

/** The marks in force. Every surface with a session picker hydrates from this on mount. */
export function getSessionMarks(): readonly number[] {
  return marks
}

/**
 * PRESS "NEW SESSION" — the one instant, stamped once, applied to both halves.
 *
 * THE ORDER IS LOAD-BEARING and it is the order a reader would guess: stamp, then split the ENGINE,
 * then record the mark, then tell every window. The engine call goes first because it is the one
 * that can be refused (`sessionMark` returns false while the historical fold is still running), and
 * a refusal there must not leave a mark behind claiming the meter split when it did not.
 *
 * THE CLOCK, NOT THE NEWEST LOG LINE (JOS-436's rule, moved rather than re-decided). Marking at the
 * live edge would hand the stale minutes since that line — the zoning, the corpse run, the instance
 * reset itself — to the session that had not started yet.
 *
 * A DOUBLE PRESS IS HARMLESS AT BOTH ENDS, and neither end relies on the other for it:
 * `addSessionMark` drops a mark at or before the newest one, and an empty stay mints no zone
 * session (`finalizeZoneSession`'s drop rule).
 *
 * Returns the new list, so the window that pressed can select the segment it just opened without
 * waiting for its own broadcast to come back to it.
 */
export function pressNewSession(): readonly number[] {
  const at = Date.now()
  // BOTH HALVES OR NEITHER. The engine refuses a mark while the historical fold is still running,
  // and in that state the loot half must not record one either — "one concept, one word, one
  // button" is a promise about the BOUNDARY, and a mark the meter never took is a boundary only
  // half the app has. The surfaces are showing their own loading states meanwhile.
  if (!combat.sessionMark(at)) return marks
  const next = addSessionMark(marks, at)
  // The shared dedupe declined it (two presses inside one millisecond): the instant it would have
  // opened is not the newest one. Nothing moved, so nothing is broadcast — a control re-asserting
  // an instant that already exists must not re-render every surface in every window. Length is NOT
  // the test: at the cap an accepted mark also leaves the list the same length.
  if (next.length === 0 || next[next.length - 1] !== at) return marks
  marks = next
  broadcastSessionMarks()
  return marks
}

/** Back to no marks. Exported for the same reason `resetScopeSelection` is — nothing in the app
 *  calls it today, and a test that presses the button must be able to put the list back. */
export function resetSessionMarks(): void {
  marks = []
}

/**
 * Tell every window. The MAIN window and all overlay kinds get the same payload on the same
 * channel — a window with no session picker simply has no listener, which is cheaper and far
 * harder to get wrong than maintaining a registry of which windows care today.
 */
function broadcastSessionMarks(): void {
  const targets = [getMainWindow(), ...OVERLAY_KINDS.map((k) => getOverlayWindow(k))]
  for (const w of targets) {
    if (w && !w.isDestroyed()) w.webContents.send(IPC.onSessionMarks, marks)
  }
}
