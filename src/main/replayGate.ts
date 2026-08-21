// ============================================================================
// replayGate.ts — nothing rides the mouse or the screen until parsing is done.
// ============================================================================
//
// THE DEFECT (JOS-62, reported live by the owner): in-game mouselook is JERKY while the app is
// still reading the log. It is not the renderer and it is not the GPU — it is a Win32 message
// hook, and it belongs to us.
//
// A LOCKED overlay is click-through via `setIgnoreMouseEvents(true, {forward:true})`, and on
// Windows Electron implements that `forward` with a low-level mouse hook (WH_MOUSE_LL) owned by
// the MAIN process. Every system mouse event — including the ones EverQuest is reading to turn
// the camera — is then delivered through OUR message loop. During the historical replay that
// loop is folding the log in ~12 ms slices (log/replaySlicer.ts), so each mouse event waits
// behind whichever slice is running. The cursor ring already refuses to forward for exactly this
// reason (see the comment at its `setIgnoreMouseEvents` call in windows.ts); this module says the
// same thing about the meters, for the seconds where it matters.
//
// So while a historical replay is running:
//
//   1. NO WINDOW OF OURS FORWARDS MOUSE EVENTS. A locked overlay is still click-through — it is
//      just click-through the cheap way, `setIgnoreMouseEvents(true)` with no hook at all. The
//      only thing it loses is the hover sensor that reveals its pin, and that is not a loss,
//      because of (2).
//   2. THE OVERLAYS AND THE RING ARE NOT ON SCREEN. They would be showing half-parsed state
//      anyway ("Reading log…"), so there is nothing to hover, nothing to raise, and nothing to
//      composite over the game.
//   3. THE 8 ms CURSOR SAMPLER DOES NOT RUN (presenceEffects.ts). Its gate already knows how to
//      say "the ring is not on screen, so read nothing"; the replay is one more reason.
//
// WHY A MODULE OF ITS OWN. Three files have to agree about this one boolean — windows.ts (which
// owns every show/hide and the `forward` flag), presenceEffects.ts (which owns the ring's
// existence and the sampler) and session.ts (which owns the replay and is therefore the only
// thing entitled to set it). A flag living in any one of them is a flag the other two import
// through a cycle. This module imports NOTHING but the E2E flag and a type, which is also what
// makes the predicates below plain unit tests (tests/replayGate.test.mts) instead of claims.
//
// WHAT IT IS NOT. It is not a second opinion about anything persisted. The overlays' locked
// flag, their open flag and the ring's `enabled` all stay exactly where they were; this gate
// only changes what they MEAN for the duration of the fold, and every restore re-reads the
// persisted value rather than a copy taken on the way in.

import { E2E } from './e2e'
import type { OverlayKind } from '../shared/types'

/**
 * Is a historical replay folding right now?
 *
 * ONE flag for the whole app, and it covers BOTH replays: the cold-start `scanLog` and the
 * shorter fold a character switch runs through the same code (session.ts `tailCharacter` is the
 * one seam, so there is no third caller to forget).
 */
let replaying = false

/** Is a historical replay folding right now? */
export function historicalReplayRunning(): boolean {
  return replaying
}

/**
 * Open or close the gate. Only session.ts calls this, and it pairs the call with re-applying the
 * window state — the flag alone changes nothing about windows that already exist.
 */
export function setHistoricalReplayRunning(running: boolean): void {
  replaying = running
}

// -------------------------------------------------------------------------- the predicates
//
// Each is stated PURELY (a function of its arguments) and then bound to this module's flag. The
// pure form is what tests pin; the bound form is what call sites read, so no call site can
// assemble the condition slightly differently from the one next to it.

/**
 * May a window be shown right now? PURE.
 *
 * `e2e` FIRST AND UNCONDITIONAL, because the headless harness's whole contract is that no window
 * is ever shown (src/main/e2e.ts) — this gate may only ever REMOVE a show, never add one. That is
 * what makes the feature inert under `EQ_E2E=1` structurally rather than by inspection: both
 * terms sit in the same conjunction, so no state of the replay flag can make this true when
 * `e2e` is.
 *
 * The MAIN window is deliberately not covered: it shows its "Reading log…" state during the
 * replay, which is the honest thing for it to do and the only window the user asked for.
 */
export function mayShowWindows(e2e: boolean, replayRunning: boolean): boolean {
  return !e2e && !replayRunning
}

/** May an overlay / the ring be shown right now? (Bound form of `mayShowWindows`.) */
export function windowsMayShow(): boolean {
  return mayShowWindows(E2E, replaying)
}

/**
 * Does this kind's click-through mode install the WH_MOUSE_LL forwarding hook? PURE.
 *
 * TWO reasons not to, and they are independent:
 *   * no STRIP forwards at all — the celebration toast, the alert banner (JOS-378) and the con card
 *     (JOS-383) drive their capture from their QUEUE, not from a hover sensor, so each would pay
 *     for a system-wide hook over a window that is empty almost all of the time (JOS-40; the rule
 *     was already here for the toast, and the other two are the same window with different words).
 *   * NOBODY forwards during a replay — the hook's cost lands on the user's own mouselook, and
 *     the window it exists for is not even on screen (JOS-62).
 */
export function overlayForwardsMouse(kind: OverlayKind, replayRunning: boolean): boolean {
  return kind !== 'toast' && kind !== 'alertBanner' && kind !== 'conCard' && !replayRunning
}

/** Should this kind's ignore-mouse call forward? (Bound form of `overlayForwardsMouse`.) */
export function overlayMouseForward(kind: OverlayKind): boolean {
  return overlayForwardsMouse(kind, replaying)
}

/**
 * What the cursor ring should be doing. PURE — and the sampler gate lives here, so "the 8 ms poll
 * does not run during the replay" is a unit test rather than something to re-measure by hand.
 *
 *   'off'       — the feature is switched off: no window, no stream (destroy what exists).
 *   'suspended' — there is nowhere to put the ring (the EQ window has never been seen) or a
 *                 replay is folding: keep whatever window exists, hidden and parked, and read
 *                 NOTHING. A replay deliberately does not even create the window — a page load
 *                 for a hidden window is main-process work at the one moment main has none to
 *                 spare, and the fold's end re-evaluates all of this anyway.
 *   'idle'      — the game does not own the screen (alt-tabbed away, game closed). The ring
 *                 window comes OFF SCREEN: it must not sit over whatever the user switched to.
 *   'parked'    — the game still owns the screen but there is no pointer to ring (mouselook, or
 *                 any mouse button held in the world view). Stop sampling and park the halo, but
 *                 LEAVE THE WINDOW WHERE IT IS. See below — this distinction is JOS-120's fix.
 *   'run'       — visible and streaming.
 *
 * ============================ WHY 'parked' IS NOT 'idle' (JOS-120) ============================
 * These two used to be one state, and hiding the window was how both were expressed. That is the
 * reported twitch: the ring visibly jumped on every click and then snapped back.
 *
 * A HIDDEN WINDOW PRODUCES NO FRAMES, so the park that is supposed to take the halo off screen is
 * never composited. MEASURED (Electron 43, a transparent frameless window driven by the shipping
 * renderer logic): with `hide()` first and the park second, the park's `requestAnimationFrame`
 * did not run for the entire 600 ms the window was hidden — the pending-frame flag stayed set and
 * the element kept the transform it had before the hide. It ran 1 ms AFTER `showInactive()`, by
 * which point Windows had already re-presented the window's last composited surface: the halo,
 * drawn where the pointer used to be. So every mouselook/click ended in a frame or two of ring at
 * the stale position, then a snap to the fresh sample.
 *
 * The cure is to not hide at all for the case that happens on every click. When EverQuest still
 * has the foreground, the ring window is exactly where it belongs and is about to be needed
 * again in a few hundred ms; parking it while it is VISIBLE composites normally, on the next
 * frame, and the halo simply disappears and reappears in the right place. Hiding stays for the
 * case it was actually written for — the game no longer owning the screen — where a stale frame
 * costs an alt-tab, not a click.
 *
 * `focused` is therefore load-bearing on its own and not merely `active`'s cause: a pointer
 * hidden by some OTHER app while EverQuest is in the background must still take the window off
 * screen, so the two facts are asked separately rather than inferred from one another.
 */
export type RingDisposition = 'off' | 'suspended' | 'idle' | 'parked' | 'run'

export function ringDisposition(o: {
  enabled: boolean
  hasBounds: boolean
  active: boolean
  /** Does the game (or one of our own windows — presence.ts's own-windows rule) hold the
   *  foreground? Decides HIDE vs PARK once the ring is not active. */
  focused: boolean
  replayRunning: boolean
}): RingDisposition {
  if (!o.enabled) return 'off'
  if (o.replayRunning || !o.hasBounds) return 'suspended'
  if (o.active) return 'run'
  return o.focused ? 'parked' : 'idle'
}
