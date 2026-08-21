// ============================================================================
// presenceEffects.ts — what the presence facts DO.
// ============================================================================
//
// `presence.ts` answers "is EQ running / focused / where". This file is the only place that
// acts on those answers, and it owns exactly two behaviors:
//
//   * OVERLAY AUTO-HIDE — hide/show the floating meters per the two independent settings.
//   * THE CURSOR RING — create, position, show/hide the ring window, and run the cursor stream.
//
// The split matters: the watcher stays a pure source (spawn, parse, debounce) that can be
// reasoned about and tested without windows, and every window side effect in the feature lives
// in one file you can read top to bottom.
//
// ================================= THE PERFORMANCE CONTRACT =================================
// The owner's gate was "it can't feel like it's lagging — performance thought through by
// default". Main's half of that is five rules, all enforced here:
//
//   1. NOTHING RUNS WHEN NOTHING IS ON. `presenceNeeded()` gates the watcher itself: with the
//      ring off and both auto-hide switches at a state that needs no watcher, no child process
//      exists, no interval exists, and this file's cost is a single subscription that was never
//      made. That is the default install.
//   2. THE 8 ms POLL IS THE NARROWEST GATE IN THE APP. It runs only while the ring is ENABLED
//      *and* EQ is FOCUSED *and* the SYSTEM CURSOR IS VISIBLE *and* the ring window exists.
//      Alt-tab out of the game — or hold a mouse button for mouselook, which hides the cursor —
//      and the interval is cleared, not skipped, cleared. The ring is parked with a single message on
//      the way out and reads nothing until it is active again, so a mouselook turn costs zero
//      `getCursorScreenPoint()` calls rather than one per tick of a pointer EverQuest is
//      re-centering every frame. `cursorStreamStats()` exists so that can be MEASURED rather
//      than asserted. A HISTORICAL REPLAY is one more reason to be off (JOS-62): the ring is not
//      on screen while the log is being folded, so main does not carry a 125 Hz timer through the
//      fold either. That gate is `ringDisposition` in replayGate.ts.
//   3. AN UNMOVED CURSOR SENDS NOTHING. The sample is compared against the last one sent and
//      dropped if identical, so a hand resting on the mouse costs one `getCursorScreenPoint()`
//      per tick and zero IPC. Reading a quest text with the ring on is free.
//   4. WINDOW GEOMETRY IS NEVER TOUCHED PER SAMPLE. The ring window is re-bounded only when the
//      EQ window actually moves; the per-sample work is two subtractions against a cached
//      origin. `setBounds()` at 125 Hz would be a window-manager round trip per frame.
//   5. WITH THE RING OFF, THE APP DOES NOT TOUCH THE CURSOR — the owner's ruling, 2026-08-10
//      (JOS-193). Rule 1 covers the case where NOTHING is on; this one covers the DEFAULT install,
//      where auto-hide is on and the ring is not. The watcher exists there, so it used to poll
//      `GetCursorInfo` ~69 times a second for `cursorVisible` — a fact whose only consumer in the
//      whole application is `cursorRingActive`, for a ring that does not exist. `setCursorWatch`
//      below is that gate, and it is the reason a cursor tool like Yolomouse shares the cursor
//      with nothing of ours unless the user asked for a ring.
//
// The renderer's half of the contract (coalesce to rAF, compositor-only transform, never queue)
// is in `src/renderer/src/overlay/cursorRing.ts`.

import { screen, type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import { logError } from './errorLog'
import { presenceSnapshot, setCursorWatch, stopPresence, subscribePresence } from './presence'
import { CURSOR_POLL_MS, cursorRingActive, overlaysShouldHide } from './presenceProtocol'
import { historicalReplayRunning, ringDisposition } from './replayGate'
import { getCursorRing, getOverlayAutoHide } from './store'
import {
  createCursorRingWindow,
  destroyCursorRingWindow,
  getCursorRingWindow,
  parkOverlays,
  setCursorRingBounds,
  setCursorRingVisible
} from './windows'
import { cursorWatchNeeded, presenceNeeded } from '../shared/presencePrefs'
import type { CursorPoint, PresenceState, ScreenRect } from '../shared/presencePrefs'

/** Where a parked ring goes when the pointer leaves the EQ window (a half-ring clipped against
 *  the window edge reads as a bug; absence reads as "not over the game"). */
const PARKED: CursorPoint = { x: -9999, y: -9999 }

let unsubscribe: (() => void) | null = null
let pollTimer: NodeJS.Timeout | null = null
/** The ring window's top-left, cached so the hot path never calls `getBounds()`. */
let ringOrigin: ScreenRect | null = null
let lastSent: CursorPoint | null = null
let sends = 0
let samples = 0

/**
 * MEASUREMENT SEAM. `samples` counts `getCursorScreenPoint()` calls, `sends` counts IPC
 * messages actually pushed to the ring. `streaming` says whether the interval exists at all.
 *
 * This is how "the stream stops when EQ is unfocused" is proven rather than claimed: read it,
 * alt-tab away, read it again — `streaming` is false and `sends` has stopped advancing.
 */
export function cursorStreamStats(): {
  streaming: boolean
  samples: number
  sends: number
} {
  return { streaming: pollTimer !== null, samples, sends }
}

/** Push a point to the ring unless it is already the point the ring has. Unchanged ⇒ nothing to
 *  say: this is what makes a still mouse (and a parked one) free. */
function sendPoint(w: BrowserWindow, next: CursorPoint): void {
  if (lastSent?.x === next.x && lastSent.y === next.y) return
  lastSent = next
  sends++
  w.webContents.send(IPC.onCursorPoint, next)
}

/**
 * One cursor sample: read the pointer, convert to the ring window's own CSS px, send if it moved.
 * Kept tiny on purpose — this is the only code in the app that runs at 125 Hz.
 *
 * BOTH READINGS ARE DIP — `screen.getCursorScreenPoint()` and the cached `getBounds()` origin —
 * so the difference is a DIP offset, and it is a CSS pixel offset only while the ring window is
 * drawn at zoom 1. That is not an assumption, it is pinned at the far end
 * (`webFrame.setZoomLevel(0)` in src/preload/cursor.ts, JOS-154, with the measurement). No zoom
 * arithmetic belongs in this function: it runs 125 times a second, and a division here would be
 * paying per sample for a constant that is fixed at 1 for the life of the window.
 */
function sampleCursor(): void {
  const w = getCursorRingWindow()
  const origin = ringOrigin
  if (!w || w.isDestroyed() || !origin) return
  samples++
  const p = screen.getCursorScreenPoint()
  const x = p.x - origin.x
  const y = p.y - origin.y
  const inside = x >= 0 && y >= 0 && x <= origin.width && y <= origin.height
  sendPoint(w, inside ? { x, y } : PARKED)
}

/**
 * Park the ring because it is not active: one PARKED point, then silence.
 *
 * The ring window is hidden rather than destroyed, so without this it would carry the last point
 * it was told about — a stale halo for the frame between `showInactive()` and the first fresh
 * sample. Parking also settles the inside/outside question ONCE: while the ring is suppressed the
 * stream is stopped, so nothing re-evaluates the edge test against a pointer EverQuest is
 * re-centering, and a cursor sitting on the window border cannot flip the ring on and off.
 *
 * A PARK IS ONLY REAL ONCE IT IS COMPOSITED (JOS-120). This is one IPC message and the renderer
 * paints it on the next animation frame — so it does nothing at all if the window is already
 * hidden, because a hidden window produces no frames (measured: the pending frame simply waits,
 * for as long as the window stays hidden, and runs 1 ms after it is shown again — one frame too
 * late to keep the stale halo off the screen). Every caller therefore parks while the window is
 * still visible, and `ringDisposition`'s 'parked' exists so that the case that happens on every
 * click never hides the window at all.
 */
function parkRing(): void {
  const w = getCursorRingWindow()
  if (!w || w.isDestroyed()) return
  sendPoint(w, PARKED)
}

function startStream(): void {
  if (pollTimer) return
  lastSent = null
  pollTimer = setInterval(sampleCursor, CURSOR_POLL_MS)
  // A cursor poll must never be the reason the app stays alive at quit.
  pollTimer.unref?.()
}

/** Stop sampling. `lastSent` deliberately SURVIVES: the caller parks the ring next, and the
 *  dedup is what makes that park cost one message instead of one per presence transition. It is
 *  cleared by `startStream` (a fresh stream owes the renderer an unconditional first point) and
 *  by a bounds change (the point it holds describes the wrong origin). */
function stopStream(): void {
  if (!pollTimer) return
  clearInterval(pollTimer)
  pollTimer = null
}

/** Stop sampling and park the halo, leaving the window exactly where it is — the 'parked'
 *  disposition. The window stays VISIBLE on purpose: that is what lets the park actually reach
 *  the screen (see `parkRing`), and it is why a click no longer ends in a displaced ring. */
function parkRingInPlace(): void {
  stopStream()
  parkRing()
}

/**
 * Stop sampling and take the ring off screen, without touching the window itself.
 *
 * ORDER MATTERS, and it is not the order this had (JOS-120). Stop sampling FIRST so the park is
 * the last word the ring hears — and park BEFORE hiding, never after. `hide()` stops the window's
 * frames, so a park sent after it is a message the renderer records and cannot paint; the window
 * then keeps its last composited surface, and the next `showInactive()` puts the old halo back on
 * screen for a frame. Parking first gives the renderer a visible window to paint into.
 *
 * Exported because session.ts needs exactly this on the way INTO a historical replay (JOS-62) —
 * and only this. `refreshPresenceEffects` would be the symmetric-looking call and is the wrong
 * one there: at cold start the replay begins before `initPresenceEffects` has run, and a full
 * re-evaluation would spawn the presence watcher child early, during the fold, which is the
 * opposite of the point. On the way OUT the full pass is exactly right, and that is what
 * session.ts calls.
 */
export function suspendCursorStream(): void {
  stopStream()
  parkRing()
  setCursorRingVisible(false)
}

/** Fold the current presence + settings into the ring window's existence, bounds and stream. */
function applyRing(state: PresenceState): void {
  const ring = getCursorRing()
  const bounds = state.eqBounds
  // THE 8 ms POLL'S GATE, in one pure decision (replayGate.ts ringDisposition): the feature
  // switch, whether we know where to put the ring, whether it is active right now, and whether a
  // historical replay is folding. The last of those is JOS-62's half — main must not be carrying
  // a 125 Hz timer while it is slicing the log, and the ring is not on screen to need one.
  const disposition = ringDisposition({
    enabled: ring.enabled,
    hasBounds: bounds !== null,
    active: cursorRingActive(state, ring),
    // Asked SEPARATELY from `active`, not derived from it: it is the difference between "the
    // pointer is gone" (park in place) and "the game is gone" (take the window off screen).
    focused: state.eqFocused,
    replayRunning: historicalReplayRunning()
  })
  if (disposition === 'off') {
    stopStream()
    ringOrigin = null
    destroyCursorRingWindow()
    return
  }
  // 'suspended' — the ring is on, but the EQ window has never been seen this session (there is
  // nowhere to put it, and inventing a rectangle would put a halo over the desktop; a watcher
  // that DIES lands here too, with a live ring window, so it parks like any other deactivation)
  // or a replay is folding. Either way the window is NOT created: a page load for a window that
  // will not be shown is main-process work at the one moment there is none to spare, and the
  // fold's end re-runs this whole pass. The `bounds === null` half is also what proves the
  // rectangle below is real.
  if (disposition === 'suspended' || bounds === null) {
    suspendCursorStream()
    return
  }
  createCursorRingWindow(bounds)
  setCursorRingBounds(bounds)
  if (!sameRect(ringOrigin, bounds)) {
    ringOrigin = bounds
    // The window moved under the pointer, so the last sent point describes the wrong origin.
    lastSent = null
  }
  if (disposition === 'run') {
    setCursorRingVisible(true)
    startStream()
    return
  }
  if (disposition === 'parked') {
    // 'parked' — EverQuest still owns the screen, there is just no pointer to ring (mouselook, or
    // any mouse button held in the world view). The window is left VISIBLE and merely emptied:
    // this is the transition that happens on every click, and hiding for it is what put a stale
    // halo back on screen a frame later (JOS-120, replayGate.ts).
    parkRingInPlace()
    return
  }
  // 'idle' — warm and positioned, but not on screen and not sampling.
  suspendCursorStream()
}

function sameRect(a: ScreenRect | null, b: ScreenRect | null): boolean {
  if (a === null || b === null) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** The subscriber. Runs on every presence CHANGE (and once on subscribe). Presence PARKS the
 *  overlays rather than hiding them (JOS-427, windows.ts `parkOverlays`) — a hidden window stops
 *  compositing and its re-show strobes a stale frame; a parked one is an opacity flip. */
function onPresence(state: PresenceState): void {
  try {
    parkOverlays(overlaysShouldHide(state, getOverlayAutoHide()))
    applyRing(state)
  } catch (err) {
    // A window that died between the check and the call must not kill the watcher pump.
    logError('main:presenceEffects', err)
  }
}

/**
 * Re-evaluate everything: whether the watcher is needed at all, and — if it is — what the
 * current facts imply. Called at startup and after every settings write, which is the ONLY way
 * either setting changes.
 *
 * Turning the last consumer off is the interesting path: it kills the child process, then
 * RESTORES the pre-feature world (overlays visible, ring gone) rather than freezing whatever
 * the last presence transition happened to leave behind. A user who switches auto-hide off
 * while their overlays are hidden must get them back immediately.
 */
export function refreshPresenceEffects(): void {
  const ring = getCursorRing()
  const needed = presenceNeeded(ring, getOverlayAutoHide())
  if (!needed) {
    unsubscribe?.()
    unsubscribe = null
    stopStream()
    ringOrigin = null
    destroyCursorRingWindow()
    parkOverlays(false)
    return
  }
  // THE CURSOR GATE, SET BEFORE THE WATCHER CAN EXIST (JOS-193). This is the only place in the app
  // that reads `cursorRing.enabled` for this purpose, and it runs before the `subscribePresence`
  // below — so the very first watcher of a session is already told whether it may call
  // `GetCursorInfo`, and there is no window in which a default-install watcher polls a cursor for
  // a ring that is off. On a later call it is the live toggle: `setCursorWatch` replaces the
  // running thread when the answer changes.
  setCursorWatch(cursorWatchNeeded(ring))
  // Push the (possibly resized) ring config to a live ring window so a Preferences slider
  // resizes the halo under the user's pointer instead of on the next restart.
  getCursorRingWindow()?.webContents.send(IPC.onCursorRingConfig, ring)
  if (!unsubscribe) {
    // subscribePresence fires the callback immediately with what is already known, so this
    // single call both starts the watcher and applies the current state.
    unsubscribe = subscribePresence(onPresence)
    return
  }
  onPresence(presenceSnapshot())
}

/** Start the presence-driven features. Called once from the composition root, after the
 *  windows exist. A no-op posture (both settings off) costs one store read. */
export function initPresenceEffects(): void {
  refreshPresenceEffects()
}

/** Full teardown (app quit). */
export function stopPresenceEffects(): void {
  unsubscribe?.()
  unsubscribe = null
  stopStream()
  ringOrigin = null
  destroyCursorRingWindow()
  stopPresence()
}
