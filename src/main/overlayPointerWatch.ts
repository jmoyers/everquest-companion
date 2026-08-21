// overlayPointerWatch.ts — THE ELECTRON HALF OF THE CURSOR WATCHDOG (JOS-381).
//
// `pointerWatch.ts` is the decision (read its header first — the report, the mechanism, and the
// five performance rules that shape both files). This file is the part that has to talk to
// Electron: which overlay window is watched, where the cursor comes from, and what is sent when
// the pointer turns out to be somewhere else. The same split displayFit.ts / windowPlacement.ts
// and security.ts / windows.ts already draw, and for the same reason — the policy stays a plain
// module `npm test` can drive, and only this file needs a running Electron.
//
// ONE ENTRY POINT, ON THE PATH THAT ALREADY EXISTS. `watchOverlayPointer` is called from
// `setOverlayIgnoreMouse` (windows.ts), which is the ONE place this app changes an overlay's
// click-through state — the lock toggle, the auto-hide pass, the replay gate and the renderer's
// own hover sensor all funnel through it. So the watch starts exactly when a locked overlay takes
// the mouse and stops on every path that gives it back, without a second opinion about what
// "captured" means living anywhere.
//
// WHAT THIS FILE DOES NOT DO, stated because the owner's rule is about exactly these: it installs
// no hook (nothing here touches WH_MOUSE_LL — `overlayMouseForward` in replayGate.ts still decides
// what forwards, unchanged), it moves no window and re-asserts no z-order (no `setAlwaysOnTop`,
// no `setBounds`), and it calls `setIgnoreMouseEvents` never. Its whole per-tick cost is one
// `getCursorScreenPoint()` — a `GetCursorPos` read — against a rectangle it is already holding.
//
// THE CURSOR UNDER EQ_E2E IS THE HARNESS'S, and that is the one behavior this file changes for the
// test mode. A headless run drives Chromium's SYNTHETIC pointer: the page hovers a header that is
// never on screen while the real OS cursor is wherever the machine's owner left it. Reading the
// real one there would tell every hover step in the suite that the pointer had left the window it
// just entered. So under `EQ_E2E` the point comes from a probe object the harness writes
// (`globalThis.__eqOverlayPointerWatch`), which is also how a spec can see which kinds are being
// watched at all — the observable behind "no timer runs while an overlay is locked and idle". The
// door exists only when the flag is set, is read by nothing in the product, and crosses no IPC.

import { screen, type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import { E2E } from './e2e'
import {
  overlayShouldWatch,
  pointerWatchKeys,
  startPointerWatch,
  stopPointerWatch,
  type WatchPoint,
  type WatchRect
} from './pointerWatch'
import { getOverlayConfig } from './store'
import type { OverlayKind } from '../shared/types'

/**
 * The EQ_E2E-only door (see the header). `cursor` is written by the harness; the three readers are
 * how a spec asserts what main did with it.
 */
interface PointerWatchProbe {
  /** Where the harness says the OS cursor is. Null (the initial value) means "nothing to say". */
  cursor: WatchPoint | null
  /** The kinds with a live interval right now. */
  watching: () => string[]
  /** The last `ignore` value main applied, per kind. */
  applied: () => Record<string, boolean>
  /** How many pointer-exit pushes each kind has been sent. */
  exits: () => Record<string, number>
}

const applied: Record<string, boolean> = {}
const exits: Record<string, number> = {}

const probe: PointerWatchProbe | null = E2E
  ? {
      cursor: null,
      watching: () => pointerWatchKeys(),
      applied: () => ({ ...applied }),
      exits: () => ({ ...exits })
    }
  : null
if (probe) (globalThis as unknown as Record<string, unknown>).__eqOverlayPointerWatch = probe

/**
 * Where the pointer is, in screen DIPs — the same coordinates `getBounds()` answers in.
 *
 * `screen` throws before Electron is ready, and a null is the honest answer to that: the watch
 * treats an unreadable cursor as "say nothing" rather than as a leave (pointerWatch.ts).
 */
function cursorPoint(): WatchPoint | null {
  if (probe) return probe.cursor
  try {
    return screen.getCursorScreenPoint()
  } catch {
    return null
  }
}

/** The window's rectangle, or null once it is gone. */
function windowRect(w: BrowserWindow): WatchRect | null {
  return w.isDestroyed() ? null : w.getBounds()
}

/**
 * "The pointer is no longer over you." ONE message, at the end of one watch.
 *
 * The renderer's answer is the ordinary release it already performs on a real leave — clear every
 * capture reason, ask main to ignore the mouse again — so this channel adds a SIGNAL and no new
 * behavior on either side. That return trip lands back in `setOverlayIgnoreMouse`, which calls
 * this file again with `ignore: true`; the watch is already stopped by then, and stopping is
 * idempotent.
 */
function sendPointerExit(kind: OverlayKind, w: BrowserWindow): void {
  if (w.isDestroyed()) return
  if (probe) exits[kind] = (exits[kind] ?? 0) + 1
  w.webContents.send(IPC.onOverlayPointerExit, kind)
}

/**
 * Start or stop `kind`'s watch to match what main just applied to its window.
 *
 * `ignore` is what `setOverlayIgnoreMouse` was asked for: `false` is a capture (the state the bug
 * lives in), `true` is the release. The LOCK is read from the persisted config rather than passed,
 * because that is the same answer every other apply path in windows.ts reads and the store is
 * written before the window is (ipc/windowControls.ts) — so a lock toggle stops the watch on the
 * way through rather than leaving one running for a window the user is now dragging.
 */
export function watchOverlayPointer(kind: OverlayKind, w: BrowserWindow, ignore: boolean): void {
  if (probe) applied[kind] = ignore
  const rect = windowRect(w)
  const watch = overlayShouldWatch({
    locked: getOverlayConfig(kind).locked,
    captured: !ignore,
    alive: rect !== null
  })
  if (!watch || rect === null) {
    stopPointerWatch(kind)
    return
  }
  startPointerWatch(kind, {
    rect,
    confirm: () => windowRect(w),
    cursor: cursorPoint,
    exit: () => sendPointerExit(kind, w)
  })
}

/** Stop `kind`'s watch outright — the window closed, or is being torn down with the app. */
export function stopOverlayPointerWatch(kind: OverlayKind): void {
  stopPointerWatch(kind)
}
