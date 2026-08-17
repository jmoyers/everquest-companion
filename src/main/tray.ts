// ============================================================================
// tray.ts — the notification-area icon, and what the X on the main window means (JOS-139).
// ============================================================================
//
// THE FEATURE IN ONE SENTENCE: closing the main window HIDES it and the companion keeps running —
// the log watcher, the timers, the alerts, the voice, the presence watcher and every open overlay
// carry on exactly as they were — and a tray icon is how you get the window back.
//
// WHAT LIVES HERE, and why it is one file:
//   * the `Tray` itself: the icon, the tooltip, the context menu, the left-click restore;
//   * the QUITTING LATCH, so every real quit still ends the process;
//   * the close INTERCEPTOR that windows.ts calls from the main window's own `close` handler; and
//   * the POPOVER — the card that appears above the icon the first time a close hides the window.
// They are one file because they are one behaviour: an icon with no interceptor is decoration, an
// interceptor with no icon is a lost app, and the popover exists only to explain the first time
// the two of them act.
//
// THE POLICY IS NOT HERE. `shared/closeToTray.ts` holds the decision (`closeIntent`), the notice
// rule (`shouldShowTrayNotice`) and the card's placement geometry (`trayNoticeBounds`), all pure
// and node-tested. This file supplies the three facts they need — the stored preference, whether
// we are quitting, and whether an icon exists — and carries out the answer.
//
// THE CLOSE IS NEVER BLOCKED. `preventDefault` here always comes with a `hide()` in the same
// statement; there is no path on which the user presses X and nothing happens.
//
// THE OVERLAYS ARE UNTOUCHED BY A HIDE, and that is the whole feature rather than a detail. The
// main window's `close` handler in windows.ts destroys every overlay and the cursor ring — an
// accessory must never keep the app alive — so the hide path has to return BEFORE it. That is why
// the interceptor is a predicate the destroy handler asks first, rather than a listener of its
// own: Electron runs `close` listeners in registration order and a `preventDefault` from one does
// not stop the others from RUNNING, so a second listener would have watched the overlays go.
//
// THE CYCLE WITH windows.ts IS DELIBERATE AND CHEAP. This file imports the window handles and the
// shared `WEB_PREFERENCES`; windows.ts imports exactly one predicate back. Both sides are function
// declarations, main is bundled into a single chunk by electron-vite, and the alternative — a
// registration seam windows.ts hands its close decision to — costs that file lines it does not
// have (it sits exactly at the 400-code-line ceiling).

import { app, BrowserWindow, Menu, nativeImage, screen, Tray, ipcMain } from 'electron'
import { join } from 'path'
// THE ICON, THROUGH THE BUILD (not off the filesystem). `build/icon.png` is the installer's art
// and electron-builder ships `out/**` plus the wiki images and nothing else, so a runtime
// `readFile('build/icon.png')` would resolve in dev and find nothing in a packaged app. The
// `?asset` import hands the file to electron-vite's asset pipeline, which emits it beside the main
// bundle and rewrites this to the emitted path — so it ships with no electron-builder change.
import trayIconAsset from '../../build/icon.png?asset'
import { IPC } from '../shared/ipc'
import {
  TRAY_NOTICE_MS,
  TRAY_NOTICE_SIZE,
  closeIntent,
  shouldShowTrayNotice,
  trayNoticeBounds,
  type CloseToTrayPrefs
} from '../shared/closeToTray'
import { E2E } from './e2e'
import { logError } from './errorLog'
import { getCloseToTray, setCloseToTray } from './storeCloseToTray'
import { WEB_PREFERENCES, getMainWindow, sendToMain } from './windows'

/**
 * THE E2E OPT-IN, and it is read in exactly one file.
 *
 * `EQ_E2E` never creates a Tray: the harness runs beside the user's own session and must not put
 * an icon in their notification area, and `tests/e2e/appWindow.mts closeWindows` ends a test app
 * by closing every window and relying on `window-all-closed` — a window that hid instead would
 * hang the suite. So under E2E `closeIntent` answers 'close' and nothing about the app changes.
 *
 * `EQ_TRAY_E2E=1` says "pretend the icon is there" for the ONE spec that drives the hide path
 * (tests/e2e/close-to-tray.e2e.mts). It still creates no Tray and still shows no popover — the
 * popover is anchored to an icon rectangle that does not exist — it only makes the interceptor
 * answer 'hide', so a test can assert that the window survived and the overlays did too. Every
 * other spec is untouched because it does not set the variable.
 */
const TRAY_E2E = process.env.EQ_TRAY_E2E === '1'

let tray: Tray | null = null
/** THE LATCH. Set by `before-quit` (and by our own Quit, which quits by closing the window). Once
 *  it is true no close is ever intercepted again, which is what makes every quit path terminal. */
let quitting = false
/** The popover window. Created on the first close that needs it and then REUSED: the card is
 *  static, so a hidden window re-presenting its last composited surface (JOS-120) is exactly
 *  right here, and it saves a page load at the one moment the user is watching. */
let noticeWindow: BrowserWindow | null = null
let noticeTimer: NodeJS.Timeout | null = null

/** Is there something on screen that could bring a hidden window back? */
function trayAvailable(): boolean {
  return tray !== null || TRAY_E2E
}

/**
 * Hide the main window instead of closing it, when that is what a close means.
 *
 * Called FIRST from the main window's own `close` handler (windows.ts). `true` means the close was
 * turned into a hide and the caller must not run the accessory teardown below it.
 */
export function hideMainWindowToTray(e: Electron.Event): boolean {
  const w = getMainWindow()
  if (!w) return false
  const intent = closeIntent({
    enabled: getCloseToTray().enabled,
    quitting,
    trayAvailable: trayAvailable()
  })
  if (intent === 'close') {
    // A REAL CLOSE TAKES THE CARD WITH IT, and this line is not tidiness — it is the difference
    // between quitting and a zombie. The popover is REUSED rather than re-created (it is hidden,
    // not destroyed, when it is dismissed), and a hidden BrowserWindow is still an OPEN window:
    // `window-all-closed` does not fire while one exists, so index.ts's whole teardown — and the
    // `app.quit()` at the end of it — would never run. The sequence that finds it is real: hide to
    // the tray (card appears, times out), restore, turn the preference OFF, press X.
    destroyTrayNotice()
    return false
  }
  e.preventDefault()
  w.hide()
  maybeShowTrayNotice()
  return true
}

/**
 * Bring the window back: the tray's left click, and its `Open` item.
 *
 * `restore()` first, because a window can be minimized AND hidden (minimize, then close), and
 * `show()` on its own would put a minimized window back in the taskbar rather than on the screen.
 */
function restoreMainWindow(): void {
  dismissTrayNotice()
  const w = getMainWindow()
  if (!w) return
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

/**
 * QUIT THE WAY THE X USED TO, so the teardown is the same teardown.
 *
 * MEASURED, and it is why this is not `app.quit()`: Electron does not emit `window-all-closed` on
 * the quit path (tests/e2e/appWindow.mts records the same finding), and index.ts hangs the session
 * stop, the telemetry `sessionEnd`, the perf profile and the learned message-overlay flush off
 * exactly that event. Closing the last window with the latch already set therefore runs MORE of
 * the teardown than `app.quit()` would, in the order index.ts already documents — and it ends in
 * `app.quit()` anyway, so `before-quit` still does its half.
 *
 * The popover is destroyed first: an open BrowserWindow, however small, is a window, and
 * `window-all-closed` does not fire while one is up.
 */
function requestQuit(): void {
  quitting = true
  destroyTrayNotice()
  const w = getMainWindow()
  if (w) w.close()
  else app.quit()
}

// ---------------------------------------------------------------- the icon and its menu

/**
 * The context menu, rebuilt whenever the preference moves.
 *
 * Electron has no "update one item" for a tray menu — `setContextMenu` takes a whole Menu — so the
 * mirror is a rebuild, which is also what keeps the checkbox and the Preferences switch from ever
 * being two answers: both render the value the store just returned, never a remembered copy.
 */
function buildMenu(prefs: CloseToTrayPrefs): Menu {
  return Menu.buildFromTemplate([
    { label: 'Open EQ Legends Companion', click: restoreMainWindow },
    {
      label: 'Keep running in the tray when the window closes',
      type: 'checkbox',
      checked: prefs.enabled,
      click: (item) => {
        applyCloseToTray({ enabled: item.checked })
      }
    },
    { type: 'separator' },
    { label: 'Quit', click: requestQuit }
  ])
}

/** Re-render the menu from the given prefs. Exported so the renderer's own write (the Preferences
 *  switch, through ipc/windowControls.ts) moves the checkbox too. A no-op with no icon. */
export function syncTrayMenu(prefs: CloseToTrayPrefs): void {
  tray?.setContextMenu(buildMenu(prefs))
}

/**
 * Store a patch made OUTSIDE the app window — the menu's checkbox, the popover's buttons — and
 * tell both surfaces what was stored.
 *
 * The echo is not decoration: the Preferences pane reads this value once and keeps it warm, so
 * without a push the switch would still be showing the old answer the next time the window came
 * back. A hidden window's renderer still receives IPC, which is what makes one push enough.
 */
function applyCloseToTray(patch: Partial<CloseToTrayPrefs>): CloseToTrayPrefs {
  const next = setCloseToTray(patch)
  syncTrayMenu(next)
  sendToMain(IPC.onCloseToTray, next)
  return next
}

// ---------------------------------------------------------------- the popover

/** Show the card, if this install has not been told yet and there is an icon to point at. */
function maybeShowTrayNotice(): void {
  if (!tray) return
  if (!shouldShowTrayNotice({ acknowledged: getCloseToTray().noticeAcknowledged })) return
  showTrayNotice(tray)
}

/** Where the card goes right now: above the icon, clamped into the work area it sits in. */
function noticeBounds(t: Tray): Electron.Rectangle {
  const b = t.getBounds()
  const area = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea
  return trayNoticeBounds(b, area)
}

function showTrayNotice(t: Tray): void {
  const w = noticeWindow ?? createTrayNoticeWindow()
  if (w.isDestroyed()) return
  w.setBounds(noticeBounds(t))
  // `show`, not `showInactive`: the card has buttons, and its own blur is one of the two ways it
  // goes away. A window that never takes focus can never lose it.
  w.show()
  armNoticeTimer()
}

/**
 * The fifteen-second clock. Re-armed on every showing, and cleared by every dismissal, so a second
 * close while the first card is still up gets a full fifteen seconds rather than the remainder.
 */
function armNoticeTimer(): void {
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(dismissTrayNotice, TRAY_NOTICE_MS)
  // Unref'd: a card on screen must never be the reason a quitting process stays alive.
  noticeTimer.unref()
}

/**
 * Take the card away WITHOUT acknowledging it.
 *
 * This is the timeout, the blur, and the restore — the three endings that are not an answer. Only
 * `Got it` and `Always quit instead` set the flag, so somebody who did not read the card sees it
 * again on their next close. Hide rather than destroy: the copy is static and the window is warm.
 */
function dismissTrayNotice(): void {
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = null
  const w = noticeWindow
  if (w && !w.isDestroyed() && w.isVisible()) w.hide()
}

/** Tear it down for good — the quit paths, where a live window would hold `window-all-closed` off. */
function destroyTrayNotice(): void {
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = null
  const w = noticeWindow
  noticeWindow = null
  if (w && !w.isDestroyed()) w.destroy()
}

/**
 * The card's window: a fourth tiny population, built like the cursor ring and hardened by the same
 * catch-alls (`web-contents-created` → hardenWebContents, index.ts).
 *
 * OPAQUE and FOCUSABLE, which is where it differs from every other accessory window in this app:
 * it is drawn over the desktop beside the taskbar rather than over the game, it has to be
 * readable, and it has three buttons to press. It stays out of the taskbar and out of Alt-Tab
 * (`skipTaskbar` + `type:'toolbar'`) because it is a notice with a fifteen-second life, not a
 * window anybody should have to switch to.
 *
 * NO `setFocusable` CALL ANYWHERE (JOS-199): focusability is a window STYLE, so it is set in the
 * constructor and never re-stated.
 */
function createTrayNoticeWindow(): BrowserWindow {
  const w = new BrowserWindow({
    ...TRAY_NOTICE_SIZE,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    type: 'toolbar',
    // The app's own background, so the first frame is never a white rectangle beside the taskbar.
    backgroundColor: '#0f1115',
    title: 'EQ Legends Companion',
    // ONE definition of the trust boundary, for every window in this app (windows.ts).
    webPreferences: WEB_PREFERENCES(join(__dirname, '../preload/tray.js'))
  })
  noticeWindow = w
  w.webContents.on('preload-error', (_e, preloadPath, error) =>
    logError('trayNotice:preload-error', { preloadPath, error })
  )
  // Dismissed WITHOUT acknowledging: clicking anywhere else is not an answer.
  w.on('blur', dismissTrayNotice)
  w.on('closed', () => {
    noticeWindow = null
  })
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) void w.loadURL(`${rendererUrl}/tray.html`)
  else void w.loadFile(join(__dirname, '../renderer/tray.html'))
  return w
}

// ---------------------------------------------------------------- installation

/**
 * The three sends the popover can make. Registered with the rest of the IPC surface (ipc/index.ts)
 * rather than at tray creation, so the channels exist whether or not an icon does — a handler
 * missing on one path and present on another is how a window ends up shouting into nothing.
 */
export function registerTrayIpc(): void {
  ipcMain.on(IPC.trayNoticeQuit, () => {
    // Deliberately NOT an acknowledgement: somebody who quits without reading the card may want
    // to read it next time.
    requestQuit()
  })
  ipcMain.on(IPC.trayNoticeAlwaysQuit, () => {
    applyCloseToTray({ enabled: false, noticeAcknowledged: true })
    requestQuit()
  })
  ipcMain.on(IPC.trayNoticeAcknowledge, () => {
    applyCloseToTray({ noticeAcknowledged: true })
    dismissTrayNotice()
  })
}

/**
 * Arm the whole feature. Called from the composition root once the main window exists.
 *
 * THE LATCH IS ARMED FIRST AND UNCONDITIONALLY, before any early return: it costs one boolean and
 * it is the thing standing between an auto-update (or an OS logoff) and a window that refuses to
 * close. `once`, because a quit that has begun is not a state this app ever leaves.
 *
 * A FAILED TRAY IS NOT A FAILED LAUNCH. `new Tray` can throw on a session with no notification
 * area; the app then simply behaves as it always did (no icon ⇒ `closeIntent` answers 'close'),
 * which is why the catch logs and returns rather than re-throwing.
 */
export function installCloseToTray(): void {
  app.once('before-quit', () => {
    quitting = true
  })
  if (E2E) return
  try {
    const icon = nativeImage.createFromPath(trayIconAsset).resize({ width: 16, height: 16 })
    tray = new Tray(icon)
    tray.setToolTip('EQ Legends Companion')
    tray.on('click', restoreMainWindow)
    syncTrayMenu(getCloseToTray())
  } catch (err) {
    tray = null
    logError('main:tray', err)
  }
}
