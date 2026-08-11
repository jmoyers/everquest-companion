import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { IPC } from '../shared/ipc'
import type { CursorPoint, CursorRingPrefs } from '../shared/presencePrefs'

export type { CursorPoint, CursorRingPrefs }

/**
 * ============================ THE ZOOM PIN (JOS-154) ============================
 * THIS WINDOW'S CSS PIXELS ARE DEVICE-INDEPENDENT PIXELS, AND THAT IS A COORDINATE CONTRACT.
 *
 * Main samples the pointer with `screen.getCursorScreenPoint()` and subtracts the ring window's
 * own origin from `getBounds()` — both DIP — then sends the difference to be used as a CSS
 * translation (presenceEffects.ts sampleCursor / renderer/src/overlay/cursorRing.ts). Those two
 * units are the same number only while this page is drawn at zoom 1. At zoom z a point p lands at
 * p*z, so the halo drifts away from the pointer the further it is from the window's top-left, and
 * the ring is drawn z times its chosen size as well.
 *
 * THE TEXT SIZE WAS TAKING THIS WINDOW WITH IT, AND THE REASON IS CHROMIUM'S ZOOM POLICY, NOT
 * THIS APP'S WIRING. `uiScale` (JOS-123) is applied to the MAIN window alone — at construction as
 * `webPreferences.zoomFactor`, and afterwards by `webContents.setZoomFactor` — but a zoom set
 * that way is stored PER HOST in the session's zoom map, not per window, and every page this app
 * serves in development comes from the SAME host (the electron-vite dev server), so the ring
 * window inherited it. MEASURED on Electron 43.2.0: with both windows on `http://localhost:<port>`
 * a main-window `setZoomFactor(1.25)` moved a plain ring window from 1.0 to 1.25; a packaged
 * build escapes it only by accident, because a `file:` URL is keyed by its whole spec, so
 * index.html and cursor.html happen to get separate entries. Accidental immunity in one build and
 * a visible defect in the other is not a property worth keeping either way.
 *
 * `webFrame.setZoomLevel` is the fix because it is the one zoom API that is NOT the host map:
 * Electron routes it to `SetTemporaryZoomLevel`, which is keyed by this render view, so pinning
 * it here takes this window out of the shared entry and leaves the main window's own zoom
 * untouched. MEASURED: with the pin in place the ring holds 1.0 across `setZoomFactor` calls of
 * 1.25, 1.5 and 0.9 on the main window, in either creation order, and across a reload; the main
 * window still reports exactly what Preferences asked for.
 *
 * IT MUST BE HERE, in the preload, and not in `windows.ts` beside every other window property:
 *   * `cursorRingWindow.webContents.setZoomFactor(1)` from main writes the SHARED host entry, so
 *     it would un-zoom the main window — the one window the setting is for.
 *   * `webPreferences: { zoomFactor: 1 }` is inert. Measured: an existing host entry wins over
 *     it, which is exactly the case that matters (the ring is created long after the setting).
 *   * windows.ts's own landmine forbids a post-load `setZoomFactor` regardless (it wedges
 *     Playwright's actionability check in a hidden window).
 * A preload runs before the first paint and again after every navigation, so the pin costs one
 * call at exactly the two moments it is needed and there is no frame drawn at the wrong size.
 */
webFrame.setZoomLevel(0)

/**
 * The THIRD preload, for the cursor-ring window (`cursor.html`) — and the smallest surface in
 * the app: three receive-only methods and no way to change anything.
 *
 * WHY NOT REUSE `preload/overlay.ts`. That bridge can persist overlay config, toggle
 * click-through, close its window and deep-link into the main app. The ring needs none of it,
 * and a window that cannot act cannot be made to act — the same reasoning that made the overlay
 * bridge a separate, leaner surface than `window.eq` in the first place. Handing the ring the
 * meters' capabilities to save one build entry would be a second, weaker opinion about the
 * blast radius of a window whose whole job is to draw a circle.
 *
 * There is deliberately no SETTER here. The ring is configured from Preferences (the main
 * window's `window.eq` bridge); this window only ever learns what was decided elsewhere.
 *
 * Exposed as `window.eqCursor`.
 */
const cursorApi = {
  /** The ring's current size/thickness/enabled prefs. Read once on mount. */
  getConfig: (): Promise<CursorRingPrefs> => ipcRenderer.invoke(IPC.cursorRingGet),
  /** Subscribe to prefs changes so a slider in Preferences resizes the live ring. */
  onConfig: (cb: (c: CursorRingPrefs) => void): (() => void) => {
    const listener = (_e: unknown, c: CursorRingPrefs): void => cb(c)
    ipcRenderer.on(IPC.onCursorRingConfig, listener)
    return () => ipcRenderer.removeListener(IPC.onCursorRingConfig, listener)
  },
  /**
   * Subscribe to cursor samples, already converted to THIS window's CSS px by main.
   *
   * That sentence is true because of the zoom pin at the top of this file, not by luck: what main
   * sends is a DIP offset from the window's origin, and it is a CSS pixel offset only while this
   * page is drawn at zoom 1 (JOS-154).
   *
   * Samples arrive at ~8 ms and are meant to be COALESCED, not consumed one by one: the
   * renderer keeps the latest and paints it on the next animation frame (see
   * `renderer/src/overlay/cursorRing.ts`). Main sends nothing at all while the pointer is
   * still, or while the ring is gated off.
   */
  onPoint: (cb: (p: CursorPoint) => void): (() => void) => {
    const listener = (_e: unknown, p: CursorPoint): void => cb(p)
    ipcRenderer.on(IPC.onCursorPoint, listener)
    return () => ipcRenderer.removeListener(IPC.onCursorPoint, listener)
  }
}

export type EqCursorApi = typeof cursorApi

contextBridge.exposeInMainWorld('eqCursor', cursorApi)
