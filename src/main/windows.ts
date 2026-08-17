// ============================================================================
// windows.ts — every BrowserWindow this process creates, and the runtime policy
// applied to it.
// ============================================================================
//
// Three window populations live here because they share ONE security posture and are
// entangled at teardown (closing the main window destroys the rest):
//
//   - the main app window (frameless, bounds persisted),
//   - the floating overlays (one per OverlayKind, transparent + always-on-top), and
//   - the cursor ring (one transparent click-through window tracking the EQ window).
//
// The module owns their handles. Nothing outside reaches for a BrowserWindow: callers
// push to the renderer through `sendToMain` / `getOverlayWindow`, which keeps the
// null-when-closed lifetime in exactly one place.
//
// `src/main/security.ts` is the PURE half of the trust boundary (URL/pack-id predicates,
// no Electron, pinned by tests/security.test.mts). This file is the half that has to talk
// to Electron: the shared webPreferences object and the per-webContents / per-session
// hardening that installs those predicates.

import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { IPC } from '../shared/ipc'
// The mouse's Back button (JOS-201). Its own module, and never installed per-overlay — the
// scope argument (window-scoped, focused-only, no forward, no global hook) lives in its header.
import { installBackButton } from './appBack'
import { E2E } from './e2e'
import { logError } from './errorLog'
import { OVERLAY_MIN_SIZE, OVERLAY_TITLE, overlayDefaultSize } from './overlayLayout'
// OPT-IN drag magnetism (JOS-217). Its own module — this file is at the 400-code-line ceiling, and
// the whole feature is one `will-move` listener over pure geometry. It is handed the registry
// below rather than importing it back out of here; see that file's header.
import { installOverlaySnap } from './overlaySnapDrag'
// WHERE A WINDOW MAY GO ON THE SCREENS THAT EXIST NOW (JOS-187). The `screen` module is not
// consulted here any more: both questions this file asks of it — where an overlay opens, where the
// main window opens — are decided in windowPlacement.ts over the pure geometry in displayFit.ts,
// so the policy is testable and both windows can never drift into two answers.
import { mainWindowBounds, overlayFittedBounds } from './windowPlacement'
import { overlayMouseForward, windowsMayShow } from './replayGate'
import { allowedExternalUrl, isInternalPageUrl } from './security'
// WHAT THE X MEANS (JOS-139). One predicate, asked FIRST by the main window's `close` handler
// below: it answers whether this close is really a hide to the tray, and does the hiding itself.
// The policy behind it is pure (shared/closeToTray.ts); the icon and the popover are tray.ts.
import { hideMainWindowToTray } from './tray'
import { captureMainWindowErrors, forwardConsoleMessages } from './windowErrors'
import { resolvedGraphics } from './graphics'
// The z-order guard and its ONE exception (JOS-368). Every re-assert in this file goes through
// `assertTopmost`; the cursor ring's four raises go through `raiseTopmost` and stay unconditional,
// for the reason stated in that module's header and restated at each ring call below.
import { assertTopmost, raiseTopmost } from './topmost'
import { getOverlayConfig, getWindowBounds, setOverlayConfig } from './store'
// WHAT THE MAIN WINDOW REMEMBERS ABOUT ITSELF, and when that is written (JOS-248). The policy is
// pure and node-tested in windowState.ts; the store handle between it and this file is
// windowMemory.ts. This file supplies the only thing neither of them can: the real window.
import { declareWindowPlacement, flushWindowState, rememberWindowState } from './windowMemory'
import { DEFAULT_MAIN_WINDOW_SIZE } from './windowState'
// The main window's text size (JOS-123). Its own module because store.ts is at the 400-code-line
// ceiling — see the banner there.
import { getUiScale } from './uiScale'
import { TRANSPARENT_OVERLAY_BG, overlayBackgroundColor } from '../shared/graphicsPrefs'
import { OVERLAY_KINDS, type OverlayKind } from '../shared/types'
// ScreenRect lives in shared/presencePrefs.ts, not shared/types.ts — see the note at the
// bottom of types.ts (that file is at its factoring ceiling).
import type { ScreenRect } from '../shared/presencePrefs'

let mainWindow: BrowserWindow | null = null
// The floating overlays (Task #52; kinds in Task #54, more in Task #59): separate transparent,
// frameless, always-on-top windows created on demand — the damage meters, the healing meters and
// the event log. Any combination can be open at once. Null when that kind is closed. Built from
// OVERLAY_KINDS so adding a kind never means editing a literal here.
const overlayWindows = Object.fromEntries(OVERLAY_KINDS.map((k) => [k, null])) as Record<
  OverlayKind,
  BrowserWindow | null
>

/**
 * THE STRIP KINDS: the two overlays whose resting state is an EMPTY window — the celebration
 * toast and the alert banner (JOS-378). Every other kind is a panel that fills its window.
 *
 * The distinction earns a name because opacity means something different for them (below) and
 * because neither pays for a mouse-forwarding hook (replayGate.ts `overlayForwardsMouse`).
 */
function isStripKind(kind: OverlayKind): boolean {
  return kind === 'toast' || kind === 'alertBanner'
}

/**
 * Which LIVE strip windows were built OPAQUE (the JOS-40 compatibility switch)?
 *
 * Recorded at construction rather than re-read from the store, because transparency is fixed
 * when a BrowserWindow is created: a user who flips the setting while an overlay is open still
 * has a transparent window on screen, and the behavior that depends on this answer (a strip's
 * idle visibility, below) must describe the window that EXISTS, not the setting. Only the strips
 * need it — every other kind fills its window and behaves identically either way.
 */
const opaqueStripWindow: Partial<Record<OverlayKind, boolean>> = {}

/** Is that opaque strip window currently drawing nothing? Only ever consulted while its
 *  `opaqueStripWindow` entry is true — see `applyOpaqueStripVisibility`, which owns this value.
 *  ABSENT READS AS IDLE (hence every check spells `!== false`), because an empty window is a
 *  strip's resting state and nothing has told us otherwise until its renderer's first signal. */
const opaqueStripIdle: Partial<Record<OverlayKind, boolean>> = {}

/** The main window while it exists (null before creation / after close). */
export function getMainWindow(): BrowserWindow | null {
  // The `isDestroyed` guard is not redundant with the 'closed' handler that nulls
  // `mainWindow`: between `close` and `closed` (and on any teardown path that destroys
  // the window directly) the reference still points at a destroyed native window, and
  // every method on it throws "Object has been destroyed". Callers get null instead.
  return mainWindow?.isDestroyed() === true ? null : mainWindow
}

/**
 * Is the COMPANION WINDOW the active window right now? (JOS-199.)
 *
 * The presence watcher can tell that the foreground window belongs to this process; it cannot tell
 * WHICH of our windows it is, because they all report the same pid and the same image path and the
 * only remaining field is a page-supplied title. Electron knows, so it is asked here — one query,
 * in the module that owns every window handle, exactly as the file header requires.
 *
 * A read, never a write: nothing here shows, focuses or raises anything. `presence.ts` calls it on
 * FOREGROUND-CHANGE records only (a handful a second at most), and a `false` is always the safe
 * answer — it lands on the pre-JOS-199 behavior, which is to leave the overlays up.
 */
export function mainWindowFocused(): boolean {
  return getMainWindow()?.isFocused() === true
}

/**
 * Push to the main window's renderer, or do nothing if there isn't one — where "isn't one"
 * includes a window that exists as a JS object but is already destroyed. Every `onX`
 * broadcast in the main process goes through here, so "the window may not exist yet /
 * anymore" is answered once instead of at ~20 call sites. The 'anymore' half is load-bearing:
 * a send to a destroyed window THROWS, and one such throw inside `window-all-closed` used to
 * abort teardown before `app.quit()`, leaving a windowless zombie process that also blocked
 * relaunch via the single-instance lock.
 */
export function sendToMain(channel: string, ...args: unknown[]): void {
  getMainWindow()?.webContents.send(channel, ...args)
}

/** A kind's overlay window while it is open (null when closed). */
export function getOverlayWindow(kind: OverlayKind): BrowserWindow | null {
  return overlayWindows[kind]
}

/** Is this kind's overlay open — i.e. does a live, undestroyed window exist for it? */
export function isOverlayOpen(kind: OverlayKind): boolean {
  const w = overlayWindows[kind]
  return w !== null && !w.isDestroyed()
}

// ---- Electron runtime trust boundary (webPreferences / navigation / permissions) ----
//
// ONE definition for EVERY window (main + all five overlays): a security posture that lives in
// two places drifts, and a window created with a forgotten flag is exactly the bug this
// section exists to prevent. Values are stated EXPLICITLY even where they match today's
// Electron default — a default is a decision someone else can change in a major bump, and
// `npm audit`-style reviews read this object, not Electron's changelog.
//
// WHY `sandbox: false` — MEASURED, not assumed. The two preloads are built by electron-vite
// from a two-entry rollup input (src/preload/{index,overlay}.ts) and both import the shared
// `src/shared/ipc.ts` channel registry, so rollup hoists it into
// `out/preload/chunks/ipc-<hash>.js` and each preload begins `require("./chunks/ipc-….js")`.
// A SANDBOXED preload's `require` is NOT Node's: it resolves `electron` plus a small
// polyfilled set (events/timers/url) and nothing else. Flipping this to `true` and running
// `npm run test:e2e` fails exactly there — the harness times out with no UI, and the e2e
// errors.log carries:
//
//   [main:preload-error] module not found: ./chunks/ipc-D4DrnWdv.js
//       at preloadRequire (node:electron/js2c/sandbox_bundle)
//
// i.e. `window.eq` is never installed and the app is silently dead. Nothing in the preloads
// themselves needs Node (they use exactly `contextBridge` + `ipcRenderer` — zero `process`,
// zero `fs`; `grep -c 'process\.' out/preload/index.js` is 0), so this is a PACKAGING blocker,
// not a design one: `sandbox: true` becomes available the moment each preload is emitted as
// ONE self-contained file. That is an electron.vite.config.ts change (a per-entry preload
// build, since rollup will always hoist a module shared by two entries into a chunk), owned
// outside this pass and written up as the top recommendation of the security report.
// `app.enableSandbox()` is blocked by the same finding, for the same reason.
//
// Until then the mitigations that actually matter without the OS sandbox are all on:
// contextIsolation (the preload's Node-capable context is unreachable from page JS), no
// nodeIntegration in any form, a deny-by-default navigation/window-open/webview policy
// (hardenWebContents), permissions denied wholesale (hardenSession), and a CSP with no
// script-src escape hatch in either page.
//
// EXPORTED SINCE JOS-139, and the rule it protects is unchanged. It was module-private on the
// argument that every window in this app is created in this file, which made "never inline a
// second opinion" structural. The tray popover is the one window that could not be created here:
// this file sits exactly at the 400-code-line factoring ceiling, and the repo's answer to a
// ceiling is a split rather than a widened threshold. So the WINDOW moved (src/main/tray.ts) and
// the POSTURE did not — there is still ONE definition, spread in whole, and the export is
// read-only. A new window built with anything but this object is still the drift this section
// exists to prevent; the guard is now the review, not the module boundary.
export function WEB_PREFERENCES(preload: string): Electron.WebPreferences {
  return {
    preload,
    // The preload runs with Node available; page JS cannot see it or its globals.
    contextIsolation: true,
    // See the note above — the only reason this isn't `true`.
    sandbox: false,
    // No Node in the page, in workers, or in any sub-frame. All three are Electron defaults
    // today; all three are stated because flipping any one of them silently un-does
    // contextIsolation's value.
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    // Keep same-origin/CSP/mixed-content enforcement ON. Disabling it is how "just load this
    // one image from the wiki" turns into a renderer that can read any origin.
    webSecurity: true,
    allowRunningInsecureContent: false,
    // No experimental/unshipped Blink surface — this app renders its own bundle and nothing
    // else, so there is nothing to gain and an unaudited attack surface to lose.
    experimentalFeatures: false,
    enableBlinkFeatures: '',
    // `<webview>` is never used (hardenWebContents also denies every attach attempt).
    webviewTag: false,
    // The renderer has no <a href> to a local file and no reason to receive one by drop.
    // Chromium would otherwise NAVIGATE the window to a file dropped on it.
    navigateOnDragDrop: false,
    // Spellcheck downloads a dictionary from Google on first use; nothing here is prose input.
    spellcheck: false
  }
}

/**
 * Deny-by-default navigation policy for ONE webContents. Installed from the
 * `web-contents-created` catch-all in index.ts, so it covers the main window, every overlay
 * window, and any webContents a future feature creates — a per-window call site is exactly
 * what gets forgotten.
 *
 * Three doors, all shut:
 *   1. `will-navigate` — the app's own pages must never navigate away from the bundled
 *      files (or, in dev, off the electron-vite server's origin). A page that navigated
 *      elsewhere would keep this window's preload bridge — the ENTIRE `window.eq` IPC
 *      surface — and hand it to whatever loaded.
 *   2. `setWindowOpenHandler` — `window.open` / `<a target="_blank">` never opens an Electron
 *      window. An ALLOWLISTED https URL is handed to the user's default browser; anything
 *      else is dropped on the floor and logged. This is the door that matters most: the URLs
 *      reaching it are built from wiki page titles (see security.ts), and an unvalidated
 *      `shell.openExternal` would let one of them ask the OS to run `file:///…exe`.
 *   3. `will-attach-webview` — `<webview>` is disabled in webPreferences; this is the belt
 *      to that suspenders (and it strips node integration from the attach params first, so
 *      even a future deliberate webview can't be created Node-enabled by page markup).
 */
export function hardenWebContents(wc: Electron.WebContents): void {
  const origins = {
    devServerUrl: process.env.ELECTRON_RENDERER_URL,
    rendererDir: join(__dirname, '../renderer')
  }

  wc.on('will-navigate', (event, url) => {
    if (isInternalPageUrl(url, origins)) return
    event.preventDefault()
    logError('main:blocked-navigation', { url })
  })

  wc.setWindowOpenHandler((details) => {
    const safe = allowedExternalUrl(details.url)
    if (safe) void shell.openExternal(safe)
    else logError('main:blocked-window-open', { url: details.url })
    // NEVER 'allow': an Electron child window would inherit this app's preload.
    return { action: 'deny' }
  })

  wc.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    event.preventDefault()
    logError('main:blocked-webview', { src: params?.src })
  })
}

/**
 * Deny every web permission, for every window, forever.
 *
 * This app needs NONE of them: no camera, microphone, geolocation, notifications, clipboard
 * read, MIDI, HID/serial/USB, pointer lock, or media-key capture. The default handler grants
 * several of these to any page that asks, so the only correct answer for a UI that never asks
 * is a blanket no — a request arriving at all means something is wrong, hence the log line.
 *
 * `setPermissionCheckHandler` is the synchronous sibling (`navigator.permissions.query`,
 * and the gate some APIs consult without ever raising a request), and
 * `setDevicePermissionHandler` covers the device-picker path (WebHID/WebUSB/serial) which
 * does not go through the other two.
 */
export function hardenSession(ses: Electron.Session): void {
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    logError('main:denied-permission', { permission })
    callback(false)
  })
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
}

// The webContents error capture (Task #13) and the console forwarder moved to
// `./windowErrors.ts` when this file reached the 400-code-line ceiling — a split, not a widened
// threshold. This file keeps what it is about: creating windows, and the trust boundary.

/**
 * Draw the main window at `scale` NOW (JOS-123 — shared/uiScale.ts). No-op when there is no
 * window, like every other push in this file.
 *
 * It lives here rather than in the IPC handler for the reason stated at the top of the file:
 * nothing outside this module reaches for a BrowserWindow, so "which window does the text size
 * apply to" is answered in one place. The answer is the MAIN window and only the main window —
 * the overlays scale their own content through the per-kind `textScale` and must not be zoomed
 * out from under it.
 */
export function applyMainWindowScale(scale: number): void {
  getMainWindow()?.webContents.setZoomFactor(scale)
}

// ---- WHAT THE MAIN WINDOW REMEMBERS (JOS-248) -------------------------------------------------
//
// Every geometry event routes through here, and two things are deliberately NOT written — both
// decided in windowState.ts, not restated at any listener: a MINIMIZED window (being in the
// taskbar is not a placement) and a window still sitting exactly where this file PUT it (the
// placement declared at creation, which is how the store keeps the rectangle the user chose when a
// monitor goes away). The write itself is debounced, trailing, so a drag or a resize is ONE store
// write when the gesture ends.
const captureMainWindowState = (): void => {
  rememberWindowState(getMainWindow())
}

/** Write the main window's state NOW — its own `close`, and index.ts's `before-quit`. */
export function flushMainWindowState(): void {
  flushWindowState(getMainWindow())
}

export function createMainWindow(): void {
  // The remembered rectangle, KEPT ON A SCREEN THAT STILL EXISTS (JOS-187). A main window lost off
  // the edge is worse than a lost overlay, not better: it is frameless, so there is no title bar
  // sticking onto the remaining display to drag it back by. Unlike the overlays it needs no live
  // re-placement — the user can move this one, and Windows itself relocates ordinary top-level
  // windows when their monitor goes away; it is the RESTORE that had no answer.
  const stored = getWindowBounds()
  const bounds = mainWindowBounds(stored)
  // What we are about to apply, so the first save cannot mistake it for the user's own choice. An
  // OS-placed first launch declares nothing: it has no remembered rectangle to protect, and
  // wherever it lands is worth writing down.
  declareWindowPlacement(bounds, stored?.maximized === true)
  mainWindow = new BrowserWindow({
    // No remembered state means TODAY'S DEFAULT, exactly: the size a fresh install has always had,
    // and no position at all — a first launch is placed by the OS, as it always was.
    ...(bounds ?? DEFAULT_MAIN_WINDOW_SIZE),
    minWidth: 900,
    minHeight: 600,
    show: false,
    // Frameless (Task #23): the OS chrome is replaced by an in-app React title bar
    // (see App.tsx / TitleBar). Windows still gives us native resize edges and
    // native drag/double-click-maximize via -webkit-app-region on the bar. Keep
    // backgroundColor + min sizes + bounds so the rest of the window UX is intact.
    frame: false,
    title: 'EQ Legends Companion',
    backgroundColor: '#0f1115',
    webPreferences: {
      ...WEB_PREFERENCES(join(__dirname, '../preload/index.js')),
      // THE TEXT SIZE, APPLIED BEFORE THE FIRST PAINT (JOS-123). Not a second opinion about the
      // trust boundary — `zoomFactor` is a rendering preference and the security posture above is
      // spread in whole and unedited. It is set at CONSTRUCTION because the alternative (zoom the
      // page once it has loaded) is a window that visibly resizes its own contents on every
      // launch. Only this window carries it: the overlays and the cursor ring take
      // WEB_PREFERENCES() unchanged.
      zoomFactor: getUiScale()
    }
  })

  // E2E: never show (and therefore never focus) the window — the harness drives it
  // entirely through the renderer's DOM while the user is playing.
  //
  // …WHICH IS ALSO WHY THE MAXIMIZE RESTORE LIVES INSIDE THAT GUARD (JOS-248). `maximize()` is not
  // a geometry write: Electron's own doc says it "will also show (but not focus) the window if it
  // isn't being shown already", so calling it at construction would put a window on screen over the
  // user's game in the one mode whose whole promise is that it never does. Here it is a single
  // gesture at first paint — maximize, then `show()` for the focus the ordinary path gives. The
  // window was CONSTRUCTED at its normal bounds, so the restore button lands back where the user
  // left it rather than on some fresh default.
  mainWindow.on('ready-to-show', () => {
    if (E2E) return
    if (stored?.maximized === true) mainWindow?.maximize()
    mainWindow?.show()
  })

  // Frameless title bar (Task #23): push maximize state so the React max/restore
  // button can swap its icon. Sent on every transition + once at first paint.
  const pushMaximized = (): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.onWindowMaximized, mainWindow.isMaximized())
    }
  }
  // …and REMEMBER it, on the same two transitions (JOS-248). The title bar's double-click is the
  // gesture that produces most of them (JOS-204: `isDragSurfaceDoubleClick` decides which
  // double-clicks reach `window:toggleMaximize` at all), and the window buttons the rest — both
  // arrive here as Electron's own events, so there is no third opinion about whether the window is
  // maximized and nothing for the IPC handler to remember. `getNormalBounds()` keeps the RECTANGLE
  // honest across the transition: a maximized window still reports the rectangle a restore returns
  // to, so the two halves of the state are recorded together and never fight.
  mainWindow.on('maximize', pushMaximized)
  mainWindow.on('unmaximize', pushMaximized)
  mainWindow.on('maximize', captureMainWindowState)
  mainWindow.on('unmaximize', captureMainWindowState)
  // Give the renderer its initial state once the page is ready to receive it.
  mainWindow.webContents.on('did-finish-load', pushMaximized)

  // NO SECOND `did-finish-load` LISTENER RE-STATING THE TEXT SIZE, AND THAT IS MEASURED (JOS-123).
  // The first cut had one, on the theory that Chromium keeps zoom per ORIGIN and a reload or a
  // dev-server navigation is where that bookkeeping is easiest to lose. Both halves of the theory
  // turned out to be wrong, in opposite directions:
  //   * IT WAS NOT NEEDED. The constructor's `zoomFactor` survives a reload of this window —
  //     asserted in tests/e2e/text-size.e2e.mts, which reloads and re-measures rather than
  //     assuming either way.
  //   * IT WAS NOT FREE. A `setZoomFactor` call AFTER the page has loaded left this window in a
  //     state where Playwright's actionability check ("visible, enabled and stable") never
  //     completed: loadout-override.e2e.mts went from 30 s green to a 60 s timeout on its next
  //     click, deterministically, with no other change in the tree. That is a hidden, never
  //     composited window (EQ_E2E) whose rAF is already throttled to nothing — but a call that
  //     buys nothing and can wedge a frame loop does not get to stay on the strength of a maybe.
  // The setter still zooms the live window, because there the call is the whole point.

  // The mouse's Back button (JOS-201). Installed on THIS window only, and only for a press this
  // window received while focused — see appBack.ts for why that is the entire scope.
  installBackButton(mainWindow)

  // --- webContents error capture (Task #13) ---
  // The window is passed as a GETTER: every guard inside fires long after this call returns, and
  // must see the module's current `mainWindow` rather than the one that existed at wiring time.
  captureMainWindowErrors(mainWindow.webContents, () => mainWindow)

  // Remember window position + size across restarts (JOS-248 — the policy is in windowState.ts).
  // `moved`/`resized` are END-of-gesture events, and the saver debounces on top of that; `close`
  // flushes, as does `before-quit` (index.ts) for the quit paths that never close a window.
  mainWindow.on('moved', captureMainWindowState)
  mainWindow.on('resized', captureMainWindowState)

  // ONE `close` HANDLER, AND ITS FIRST QUESTION IS WHETHER THIS IS A CLOSE AT ALL (JOS-139).
  //
  // The geometry is written on BOTH paths — a window the user pushed somewhere and then hid is
  // still a window that was left there — so `flushMainWindowState` runs before the question. It
  // used to be its own `close` listener; the two are merged because Electron runs `close`
  // listeners in registration order and a `preventDefault` from one does NOT stop the others from
  // RUNNING, so the hide path has to be able to RETURN before the teardown below rather than
  // merely cancel the close. A hidden main window that destroyed the overlays would be the exact
  // opposite of the feature: the whole promise is that the meters, timers and alerts carry on.
  //
  // Then the accessories (Task #52). An overlay is an accessory of the main window: tear it down
  // when the main window really closes so it can't keep the app alive on its own. Its persisted
  // open-state is left intact (open:true) so the next launch restores it — we skip the 'closed'
  // handler that would otherwise flip open:false. Same contract for the ring, whose persisted
  // `enabled` is likewise untouched.
  mainWindow.on('close', (e) => {
    flushMainWindowState()
    if (hideMainWindowToTray(e)) return
    for (const kind of OVERLAY_KINDS) {
      const w = overlayWindows[kind]
      if (!w || w.isDestroyed()) continue
      w.removeAllListeners('closed')
      w.destroy()
      overlayWindows[kind] = null
    }
    destroyCursorRingWindow()
  })

  // Null the module reference once the window is gone, like the overlays and the ring
  // already do. Without this, everything downstream of `window-all-closed` still sees a
  // (destroyed) window through `mainWindow` and any direct method call on it throws.
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Navigation + window.open policy is installed for EVERY webContents by the
  // `web-contents-created` catch-all (hardenWebContents) — never per window, so a window
  // added later can't miss it.

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---- Floating overlay DPS meters (Task #52; two kinds in Task #54) ----
//
// Separate BrowserWindows that sit transparent + always-on-top over the game. EQ Legends runs
// windowed/borderless — including under its own Fullscreen setting, which is a BORDERLESS
// fullscreen window on this client (JOS-375) — and an always-on-top overlay composites fine over
// either (see AGENTS.md). No native helper app is
// needed — Electron's transparent/frameless + setAlwaysOnTop('screen-saver') +
// setIgnoreMouseEvents(forward) covers it.
//
// Three KINDS (Task #54; 'events' in Task #59), each an independent window with its own
// persisted config:
//   - 'fight'   : current-fight meter + FIGHT selector.
//   - 'overall' : zone meter + ZONE-session selector.
//   - 'events'  : the live event log (alerts / notable loot / quest completions).
// All can be open simultaneously. The overlay renderer reads its kind from the ?kind= query on
// its URL so a single overlay.html bundle serves every window.
//
// Two interaction modes per window, persisted in that kind's `locked`:
//   - interactive: normal focusable window, -webkit-app-region drag on the header, resize
//     edges, close/config controls + selector + drill-down visible.
//   - locked (click-through): mouse events pass through to the game via
//     setIgnoreMouseEvents(true, {forward:true}); the renderer's hover sensor toggles capture
//     back on so the hover-revealed pin stays clickable. Never steals focus. No drilling.

/**
 * Set a kind's click-through state. ONE definition, used by the lock toggle below and by the
 * renderer's fine-grained `overlay:setIgnoreMouse` — two call sites disagreeing about
 * `forward` would be a performance bug nobody could see.
 *
 * WHY `forward` IS PER-KIND. On Windows, `forward:true` installs a low-level mouse hook
 * (WH_MOUSE_LL) owned by the MAIN process: every system mouse event then waits on our message
 * loop, so a blocked main freezes the user's cursor system-wide (measured — it is why the
 * cursor ring deliberately does NOT forward). The METERS pay that cost for a reason: their
 * hover sensor is what re-enables capture over the pin button, and it only ever sees a
 * mouse-move if we forward one. The TOAST has no hover sensor — its capture is driven by its
 * QUEUE (a card is on screen, or it is not), which it learns over IPC — so it would pay the
 * hook for a window that is empty and idle almost all of the time. It does not forward.
 *
 * ...AND NOBODY FORWARDS DURING A HISTORICAL REPLAY (JOS-62). "Does this kind forward" is
 * answered by `overlayMouseForward` (replayGate.ts), which folds both rules into ONE place: for
 * the seconds the fold owns the message loop, the hook the meters normally pay for would land
 * squarely on the user's own mouselook — and the window it exists to serve is hidden anyway.
 * Click-through itself is unchanged; only its implementation gets cheaper.
 */
export function setOverlayIgnoreMouse(kind: OverlayKind, ignore: boolean): void {
  const w = overlayWindows[kind]
  if (!w || w.isDestroyed()) return
  if (ignore) w.setIgnoreMouseEvents(true, { forward: overlayMouseForward(kind) })
  else w.setIgnoreMouseEvents(false)
  applyOpaqueStripVisibility(kind, ignore)
}

/**
 * THE KINDS OPACITY CHANGES THE BEHAVIOR OF (JOS-40): the two STRIPS.
 *
 * Every other overlay is a panel that fills its window — opaque, it looks like the same meter
 * with its see-through taken away, and nothing else about it moves. A strip is the opposite:
 * it is a mostly-EMPTY window whose resting state is invisible, so building it opaque
 * would park a solid dark rectangle across the game forever. That is not a compatibility mode,
 * it is a new bug.
 *
 * So an opaque strip window is SHOWN ONLY WHEN IT HAS SOMETHING TO SHOW, and this function reads
 * that state off the signal the overlay already sends: `overlay:setIgnoreMouse`. Both strip
 * renderers share one rule (`useQueueMouseCapture`, renderer/overlay/cardQueue.ts): `ignore =
 * !ready ? true : locked ? !hasCards : false` — i.e. they ask to be ignored in exactly the states
 * where they are drawing nothing, and to capture the moment a card is on screen or the user is
 * positioning the window unlocked. One signal, one meaning, no second timer in main that could
 * disagree with the queue.
 *
 * Transparent windows are untouched: an empty transparent strip is already invisible, and
 * hiding/showing it on every card would be churn for no pixel.
 */
function applyOpaqueStripVisibility(kind: OverlayKind, idle: boolean): void {
  if (!isStripKind(kind) || opaqueStripWindow[kind] !== true) return
  opaqueStripIdle[kind] = idle
  const w = overlayWindows[kind]
  if (!w || w.isDestroyed()) return
  if (idle && w.isVisible()) w.hide()
  // Idle is done here; and nothing shows while a window may not be shown at all — E2E (the whole
  // test mode, src/main/e2e.ts) or a historical replay in flight (replayGate.ts).
  if (idle || !windowsMayShow() || w.isVisible()) return
  w.showInactive()
  assertTopmost(w)
  raiseCursorRing()
}

// ---- `setFocusable` IS NOT AN ATTRIBUTE WRITE, IT MOVES THE FOREGROUND (JOS-199) --------------
//
// THE ALT-TAB HIJACK, and it is Electron's documented Windows behavior rather than a mystery.
// `BrowserWindow.setFocusable` is spelled "changes whether the window can be focused" and carries
// the note "on macOS it does not remove the focus from the window" — i.e. on WINDOWS it does.
// `setFocusable(false)` deactivates the window, and Chromium's deactivate walks the Z-ORDER and
// calls `SetForegroundWindow` on the first VISIBLE window below it. An overlay of ours is
// always-on-top directly over the game, so the first window below it is EverQuest.
//
// That turned every auto-hide into a foreground grab, because `setOverlaysHidden` re-asserted the
// locked mode on the way DOWN as well as up, and the locked mode is `setFocusable(false)`:
//
//   "Alt tabbing from EQ will bring you back to EQ the first time but with hidden overlay… but if
//    you click into EQ, alt tab will continue to bring you back ANY TIME THE OVERLAYS ARE VISIBLE"
//                                            — report 01KZPTD3MHP3DFG7NJY5QF96VJ, v0.18.0
//
// The reporter's last clause is the diagnosis: Chromium's deactivate is a no-op on a window that
// is not visible, so the alt-tab that happened while the overlays were already hidden worked, and
// the next one — after they came back — did not. Alt-tab away, the debounce commits ~300 ms later,
// the hide pass re-states `setFocusable(false)` on five still-visible topmost windows, and the
// user is standing in EverQuest again wondering what they did wrong.
//
// THE FIX IS TO STOP RE-STATING IT. Focusability is a WINDOW STYLE (WS_EX_NOACTIVATE); it survives
// hide/show, so unlike always-on-top and the mouse mode it has nothing to re-assert. So:
//
//   * a window is BORN with the focusability its persisted lock implies, which costs no call at
//     all and takes the very first `setFocusable` — the one at `ready-to-show`, which used to fire
//     while another app was in front and could yank the foreground off it — out of existence too;
//   * and every later apply is a no-op unless the value actually CHANGED, which now happens only
//     when the user toggles the lock. There, moving the foreground is the point: locking hands the
//     game back, unlocking gives you the window you are about to drag.
//
// THE WINDOW ITSELF IS ASKED, never a remembered copy. `isFocusable()` is the exact state
// `setFocusable` writes, so there is no bookkeeping to seed at construction, none to clear when an
// overlay closes, and no way for a map to disagree with the window it describes.

/** Set a window's focusability, but ONLY on a real change — see the block above. */
function setOverlayFocusable(w: BrowserWindow, focusable: boolean): void {
  if (w.isFocusable() === focusable) return
  w.setFocusable(focusable)
}

/**
 * Apply the locked/interactive mouse + focus behavior to a kind's overlay window.
 *
 * The MOUSE half is idempotent and re-stated freely (a hidden window must drop its WH_MOUSE_LL
 * hook, which is why the auto-hide path calls this at all). The FOCUS half is guarded, because on
 * Windows it is not idempotent at all — it moves the foreground window. See above.
 */
export function applyOverlayLocked(kind: OverlayKind, locked: boolean): void {
  const w = overlayWindows[kind]
  if (!w || w.isDestroyed()) return
  setOverlayIgnoreMouse(kind, locked)
  setOverlayFocusable(w, !locked)
}

// ---- WHAT IS SHOWN vs WHAT IS STORED (JOS-187) ------------------------------------------------
//
// THE STORE KEEPS THE RECTANGLE THE USER CHOSE. THE SCREEN GETS THE ONE THAT FITS. That is the
// whole policy, and it is what makes a docking round trip lossless: undock the widescreen and the
// overlay is DRAWN on the laptop panel while `overlays.<kind>.bounds` still says "x: 2600, on the
// right-hand monitor"; plug the monitor back in and the same fit puts it back where it was, on the
// display the user actually put it on. Persisting the corrected rectangle instead would silently
// destroy that layout the first time a cable came out — and it would do it on a laptop screen the
// user may only be on for the length of a train journey.
//
// The mechanism is one remembered rectangle. Every rectangle this file applies to a window ITSELF
// is recorded here first, and `saveOverlayBounds` refuses to persist the one it recognises as its
// own — so the only writes that reach the store are the user's own moves and resizes. The marker is
// dropped the moment a window reports any OTHER rectangle, so a user who later drags a window back
// onto that exact spot still has it saved. Deliberately not a timer or a re-entrancy flag: Electron
// may emit 'moved'/'resized' synchronously from `setBounds` or a tick later, and a policy that
// depended on which would be a policy that worked on one platform.
//
// A PIXEL OF SLACK, because `setBounds` is not always an identity: on a scaled display the value
// makes a round trip through physical pixels and can come back one off. The cost is that a 1px
// nudge in the instant after a re-placement is not persisted — which is not a position anyone is
// expressing — and it is paid only until the window next moves anywhere else.
const appliedBounds = new Map<OverlayKind, Electron.Rectangle>()
const RECT_KEYS = ['x', 'y', 'width', 'height'] as const
const sameSpot = (a: Electron.Rectangle, b: Electron.Rectangle): boolean =>
  RECT_KEYS.every((k) => Math.abs(a[k] - b[k]) <= 1)
/** The EXACT twin of `sameSpot`, for the ring: it is re-bounded to the EQ window and re-drawn from
 *  that origin, so a pixel of slack here would be a pixel of drift in the halo's offset. */
const sameRect = (a: Electron.Rectangle, b: ScreenRect): boolean =>
  RECT_KEYS.every((k) => a[k] === b[k])

/**
 * Where a kind's overlay opens. Persisted bounds win — FITTED to the displays that exist right now
 * (windowPlacement.ts), so a position remembered from a monitor that has since been unplugged
 * lands on screen instead of past the edge of it. A first open (and a rectangle on no display at
 * all) is placed by the shared layout (bottom-right, stacked per kind — overlayLayout.ts) so two
 * overlays never open exactly on top of each other.
 */
function overlayPlacement(kind: OverlayKind) {
  const b = overlayFittedBounds(kind, getOverlayConfig(kind).bounds)
  if (!b) return overlayDefaultSize(kind) // no display info (headless/e2e) — size only
  appliedBounds.set(kind, b)
  return b
}

/** Move a kind's overlay onto `b` without that move being mistaken for the user's own (see above). */
export function applyOverlayBounds(kind: OverlayKind, b: Electron.Rectangle): void {
  const w = overlayWindows[kind]
  if (!w || w.isDestroyed() || sameSpot(w.getBounds(), b)) return
  appliedBounds.set(kind, b)
  w.setBounds(b)
}

/**
 * Put every open overlay back on a display that exists — the live half of JOS-187, run whenever the
 * monitor arrangement changes (index.ts wires it to `watchDisplays`).
 *
 * It re-fits the STORED rectangle rather than the window's current one, which is what lets a
 * re-plugged monitor take its overlays back: the correction applied while that display was gone was
 * never written down, so the user's own position is still there to return to.
 */
export function reconcileOverlayDisplays(): void {
  for (const kind of OVERLAY_KINDS) {
    const w = overlayWindows[kind]
    if (!w || w.isDestroyed()) continue
    const b = overlayFittedBounds(kind, getOverlayConfig(kind).bounds)
    if (b) applyOverlayBounds(kind, b)
  }
}

export function createOverlayWindow(kind: OverlayKind): void {
  const existing = overlayWindows[kind]
  if (existing && !existing.isDestroyed()) {
    if (windowsMayShow()) existing.show()
    return
  }
  // OPAQUE-OVERLAY COMPATIBILITY MODE (JOS-40; automatic under Wine since JOS-31). Read here, at
  // construction, because that is the only moment a window's transparency can be decided — which
  // is exactly why the setting is documented as applying when an overlay is next opened rather
  // than instantly. `resolvedGraphics()` is the switch AND the detection folded together: on a
  // machine whose compositor turns a transparent frameless window into a black box, an untouched
  // 'auto' arrives here as `true` without the user having found anything.
  const opaque = resolvedGraphics().opaqueOverlays.on
  if (isStripKind(kind)) opaqueStripWindow[kind] = opaque
  // BORN WITH THE RIGHT FOCUSABILITY (JOS-199 — see `setOverlayFocusable`). The lock state is read
  // here, at construction, purely so that the `ready-to-show` apply below has nothing to do:
  // `setFocusable` on Windows moves the FOREGROUND window, and an overlay opened from the
  // Companion's own Overlay menu used to deactivate itself the instant it appeared.
  const locked = getOverlayConfig(kind).locked
  const w = new BrowserWindow({
    ...overlayPlacement(kind),
    focusable: !locked,
    // THE FLOOR IS NOT A NUMBER THIS FILE OWNS (JOS-278). It is derived from what the overlay
    // chrome can render without losing a control off an edge, so it lives beside the other
    // overlay geometry — and beside the argument for it — in overlayLayout.ts.
    minWidth: OVERLAY_MIN_SIZE.width,
    minHeight: OVERLAY_MIN_SIZE.height,
    maxWidth: 720,
    maxHeight: 820,
    // The toast strip is a fixed-width card LANE, not a resizable panel: the card sizes itself
    // and everything around it is transparent, so resizing that window would only change how
    // much invisible nothing surrounds the card. It still MOVES, and its bounds still persist —
    // position is the knob that matters for a notifier.
    //
    // THE ALERT BANNER IS RESIZABLE, and that is not an inconsistency (JOS-378): its lines are
    // sentences that WRAP, so the window's width is the one thing that decides whether a raid
    // call reads as one glance or three, and the height is how many lines fit before the oldest
    // has to go. Both are the user's business.
    resizable: kind !== 'toast',
    show: false,
    frame: false,
    // THE ONE FLAG THE COMPATIBILITY SWITCH EXISTS FOR. A transparent window is composited by the
    // driver per pixel, and that is the path a player's RTX 5080 turned into black-screen
    // artifacting (JOS-40) — unreproducible here, so the app ships a way out instead of a guess.
    // Opaque, this is an ordinary window on a solid background and none of that path runs.
    transparent: !opaque,
    // Never take focus from the game when it appears (locked mode). We also avoid
    // adding it to the taskbar — it's an accessory of the main app.
    skipTaskbar: true,
    // …and out of ALT-TAB, which skipTaskbar alone does NOT do on Windows (it only
    // deletes the taskbar button). 'toolbar' sets WS_EX_TOOLWINDOW, the style Alt-Tab
    // (and Win+Tab) actually consults, so five open overlays don't turn window
    // switching into a lineup of accessories. NOT `parent: mainWindow` — an OWNED
    // window would also leave Alt-Tab but gets minimized with its owner, and hiding
    // the main app while playing must never take the overlays down with it.
    type: 'toolbar',
    // A transparent window can't have a native background; element rgba does the
    // translucency (per-element alpha beats window-level setOpacity). Opaque, it is the SAME
    // RGB the page already paints, so the meter simply loses its see-through and keeps its
    // colour — the alpha slider still works, it just has nothing left to show through to
    // (shared/graphicsPrefs.ts).
    backgroundColor: overlayBackgroundColor(opaque),
    hasShadow: false,
    title: OVERLAY_TITLE[kind],
    // Same hardened posture as the main window — one definition, every window (see
    // WEB_PREFERENCES). The overlay's preload is the LEANER bridge (preload/overlay.ts), but
    // its window-level privileges must not be a second, weaker opinion.
    webPreferences: WEB_PREFERENCES(join(__dirname, '../preload/overlay.js'))
  })
  overlayWindows[kind] = w

  // Always-on-top at the screen-saver level so it floats above ordinary windows (and the
  // borderless game). Re-asserted after show for reliability on Windows — but ONLY when the
  // window says it has lost the style (./topmost.ts): the re-assert is a SetWindowPos, and every
  // one of them is compositor work over a running game.
  assertTopmost(w)
  raiseCursorRing()

  const wc = w.webContents
  wc.on('preload-error', (_e, preloadPath, error) =>
    logError('overlay:preload-error', { preloadPath, error })
  )
  forwardConsoleMessages(wc, 'overlay:console')

  // External links (the event log's wiki links, Task #59) open in the user's DEFAULT BROWSER —
  // the overlay window itself must NEVER navigate away from overlay.html. Both halves of that
  // are installed by the `web-contents-created` catch-all (hardenWebContents), which allows
  // only an ALLOWLISTED https host through to shell.openExternal; `<a target="_blank">` stays
  // the one link idiom across the app.

  w.on('ready-to-show', () => {
    // E2E: overlays stay hidden too (they're always-on-top — showing one would cover the game).
    // A HISTORICAL REPLAY holds the same door shut (JOS-62): an overlay that first painted mid-fold
    // would be showing half-parsed state over the game, and the fold's end shows it properly (with
    // its locked mode re-applied) via `applyOverlayReplayGate` + the presence pass beside it.
    if (!windowsMayShow()) return
    // An OPAQUE strip opens HIDDEN and is brought up by its own queue (see
    // applyOpaqueStripVisibility). Showing it here would put a solid rectangle over the game for
    // the moment between first paint and the renderer's first capture signal — the very thing
    // this mode exists to avoid.
    if (isStripKind(kind) && opaque) {
      applyOverlayLocked(kind, getOverlayConfig(kind).locked)
      return
    }
    // showInactive so opening the overlay never steals focus from the game.
    w.showInactive()
    assertTopmost(w)
    applyOverlayLocked(kind, getOverlayConfig(kind).locked)
    raiseCursorRing()
  })

  // Persist position + size so the overlay restores where the user left it — the USER's moves only,
  // never one of ours (JOS-187; the marker is explained at `appliedBounds`).
  const saveOverlayBounds = (): void => {
    if (w.isDestroyed()) return
    const b = w.getBounds()
    const applied = appliedBounds.get(kind)
    if (applied && sameSpot(applied, b)) return
    appliedBounds.delete(kind)
    setOverlayConfig(kind, { bounds: b })
  }
  w.on('moved', saveOverlayBounds)
  w.on('resized', saveOverlayBounds)

  // A drag that lines this window up with its neighbours and the screen edges — but ONLY for a
  // user who has turned it on in Preferences (JOS-217). Installed for every overlay so the
  // preference takes effect on the next drag rather than the next launch; with it off the
  // listener's first line returns and this window drags exactly as it always has. A snapped
  // rectangle IS the user's own, so it goes through `saveOverlayBounds` above like any other move.
  installOverlaySnap(w, kind, overlayWindows, getMainWindow)

  w.on('closed', () => {
    overlayWindows[kind] = null
    setOverlayConfig(kind, { open: false })
    // Tell the main app so the TitleBar overlay menu reflects the closed state.
    sendToMain(IPC.onOverlayState, { kind, open: false })
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    void w.loadURL(`${rendererUrl}/overlay.html?kind=${kind}`)
  } else {
    void w.loadFile(join(__dirname, '../renderer/overlay.html'), { search: `kind=${kind}` })
  }
}

/** Open/close a kind's overlay and persist + broadcast its new open-state. Returns it. */
export function setOverlayOpen(kind: OverlayKind, open: boolean): boolean {
  const w = overlayWindows[kind]
  if (open) {
    createOverlayWindow(kind)
  } else if (w && !w.isDestroyed()) {
    w.close() // 'closed' handler resets state + persists open:false + broadcasts
  }
  const isOpen = isOverlayOpen(kind)
  setOverlayConfig(kind, { open: isOpen })
  sendToMain(IPC.onOverlayState, { kind, open: isOpen })
  return isOpen
}

/** Current open-state map across all overlay kinds (for the TitleBar menu). */
export function overlayStateMap(): Record<OverlayKind, boolean> {
  const out = {} as Record<OverlayKind, boolean>
  for (const kind of OVERLAY_KINDS) {
    out[kind] = isOverlayOpen(kind)
  }
  return out
}

// ---- overlay AUTO-HIDE (presence-driven; src/main/presence.ts) ----
//
// HIDE, NEVER DESTROY. An auto-hidden overlay is the same window it was a moment ago: its
// bounds, its lock state, its selected fight and its drill-down are all still there, and its
// persisted `open:true` is untouched, so the TitleBar menu keeps telling the truth and a
// re-show is instant. Closing and re-creating them would churn five windows on every alt-tab,
// lose the mini drill-down, and (via the 'closed' handler) silently rewrite the user's
// open-state on a transition they never asked about.
//
// Only OPEN overlays are affected — this is a visibility filter layered over the open-state,
// never a second opinion about it.

/**
 * Show or hide every open overlay window.
 *
 * `showInactive`, not `show`: the same reason the first open uses it. An overlay must never
 * steal focus from the game, and coming back from auto-hide is exactly the moment it would —
 * the user just alt-tabbed INTO EverQuest, and a window that grabs focus on the way would undo
 * the thing that triggered it. Always-on-top and the click-through mode are re-asserted on the
 * way back, because a hidden window can lose both on Windows.
 *
 * ...AND THE ALWAYS-ON-TOP HALF IS NOW CONDITIONAL (JOS-368). `assertTopmost` re-asserts only when
 * the window itself says the style is gone, so the case that made this call necessary is still
 * covered while the ordinary alt-tab — five windows that never lost it — stops issuing five
 * SetWindowPos calls over a running game. `raiseCursorRing()` below is
 * deliberately NOT guarded; ./topmost.ts's header is why.
 *
 * AND NOTHING HERE TOUCHES FOCUSABILITY, in either direction (JOS-199). It is a window style that
 * survives hide/show, so there is nothing to re-assert — and re-asserting it anyway is what made
 * this function grab the foreground on every alt-tab. `applyOverlayLocked` still carries the whole
 * locked mode; its focus half is now a no-op unless the value really changed. See
 * `setOverlayFocusable`.
 *
 * E2E never shows a window (src/main/e2e.ts is the whole test mode), so a re-show is skipped
 * there; hiding stays live, since hiding an already-hidden window is a no-op. A historical replay
 * (replayGate.ts) suppresses the re-show for the same seconds and by the same predicate — and
 * this function is ALSO the restore path afterwards, which is why the re-show re-asserts the
 * locked mode from the persisted config rather than remembering anything of its own.
 */
export function setOverlaysHidden(hidden: boolean): void {
  for (const kind of OVERLAY_KINDS) {
    const w = overlayWindows[kind]
    if (!w || w.isDestroyed()) continue
    if (hidden) {
      // The mouse mode is re-applied on the way DOWN as well as on the way back up, from the same
      // persisted flag — which is what makes this function the whole of the JOS-62 replay gate's
      // overlay half (session.ts hides them for the fold). A locked overlay's click-through drops
      // its WH_MOUSE_LL forwarding hook the moment the gate closes, rather than keeping a
      // system-wide mouse hook alive for a window that is not even on screen. Idempotent
      // otherwise: for an ordinary auto-hide this re-states what was already true.
      applyOverlayLocked(kind, getOverlayConfig(kind).locked)
      if (w.isVisible()) w.hide()
      continue
    }
    if (!windowsMayShow() || w.isVisible()) continue
    // An OPAQUE strip with nothing queued must not come back as a solid rectangle: its
    // visibility belongs to its queue, and the next card brings it up (JOS-40).
    if (isStripKind(kind) && opaqueStripWindow[kind] === true && opaqueStripIdle[kind] !== false) continue
    w.showInactive()
    assertTopmost(w)
    applyOverlayLocked(kind, getOverlayConfig(kind).locked)
  }
  // Overlays re-asserting always-on-top just raised them ABOVE the ring (same 'screen-saver'
  // level; the most recent assertion wins). Put the ring back on top, or the circle slides
  // BEHIND an overlay on mouseover — the flicker auto-hide users saw on every EQ refocus.
  raiseCursorRing()
}

// ---- the CURSOR RING window ----
//
// A fourth population of one: transparent, click-through, always-on-top, sized to the EQ window,
// containing a single <div> that follows the pointer (renderer: src/renderer/cursor.html +
// src/renderer/src/overlay/cursorRing.ts).
//
// It is built HERE, from the same `WEB_PREFERENCES()` every other window uses, for the reason
// stated at the top of that function: a window created somewhere else with its own idea of
// webPreferences is precisely the drift this file exists to prevent. Its preload is the third
// and leanest bridge (preload/cursor.ts — three receive-only methods).
//
// Three properties make it invisible to everything except the eye:
//   * `focusable:false` + `type:'toolbar'` + `skipTaskbar` — never takes focus, never appears in
//     Alt-Tab or the taskbar. A ring that could be focused would be a ring that could steal a
//     keystroke mid-fight.
//   * `setIgnoreMouseEvents(true, {forward:true})` — every click passes straight through to the
//     game. Unlike the overlays there is NO hover sensor and no interactive mode: this window
//     has nothing to click, so pass-through is unconditional and permanent.
//   * NO `-webkit-app-region` anywhere in its page — it is not draggable, and cannot become a
//     window the user accidentally picks up while playing.
//
// AND ONE PROPERTY THIS FILE DELIBERATELY DOES NOT SET: ITS ZOOM (JOS-154). The ring's CSS pixels
// have to be DIPs, because main sends it a DIP offset from this window's own origin to use as a
// CSS translation — so the app's text size (`uiScale`, JOS-123) must not reach it. It used to,
// and not through anything written here: `setZoomFactor` stores a zoom PER HOST, every page is
// served from one host in development, and the ring inherited the main window's (measured on
// Electron 43.2.0 — 1.0 to 1.25 on a main-window setZoomFactor). The pin is
// `webFrame.setZoomLevel(0)` in `src/preload/cursor.ts`, which is a per-view TEMPORARY zoom and
// therefore the only one that can hold this window still without moving the main window with it —
// the full argument, and the two alternatives that were measured and rejected, are in that file's
// header. Nothing to add to the BrowserWindow options below; the absence is the point.

let cursorRingWindow: BrowserWindow | null = null

/** The ring window while it exists (null when the ring is off). */
export function getCursorRingWindow(): BrowserWindow | null {
  return cursorRingWindow
}

/** Is there a live, undestroyed ring window? */
export function isCursorRingOpen(): boolean {
  return cursorRingWindow !== null && !cursorRingWindow.isDestroyed()
}

/**
 * Create the ring window at `bounds` (the EQ window's rectangle) if it does not already exist.
 * Idempotent: an existing window is simply re-bounded, so the presence watcher can call this on
 * every transition without tracking whether it already did.
 */
export function createCursorRingWindow(bounds: ScreenRect): void {
  if (isCursorRingOpen()) {
    setCursorRingBounds(bounds)
    return
  }
  const w = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    // Never take focus, never appear in the taskbar or Alt-Tab (see the note above).
    focusable: false,
    skipTaskbar: true,
    type: 'toolbar',
    // NEVER OPAQUE, whatever the JOS-40 compatibility switch says: this window is sized to the
    // WHOLE EverQuest window and holds one small circle. Opaque, it would not be a cursor aid,
    // it would be a lid over the game. A user on a driver that cannot composite transparency
    // turns the ring off; there is no solid version of it to offer.
    backgroundColor: TRANSPARENT_OVERLAY_BG,
    hasShadow: false,
    title: 'Cursor Ring',
    // Same hardened posture as every other window in this app — ONE definition (WEB_PREFERENCES).
    webPreferences: WEB_PREFERENCES(join(__dirname, '../preload/cursor.js'))
  })
  cursorRingWindow = w

  // Above the overlays' own 'screen-saver' level is not expressible; within one level the most
  // recent setAlwaysOnTop assertion wins. "Ring above overlays" is therefore an INVARIANT kept
  // by construction: every overlay show/re-raise path ends with raiseCursorRing(), never by
  // creation-order luck — auto-hide re-shows overlays on every EQ refocus, and before this rule
  // each re-show buried the ring, so the circle slid behind an overlay on mouseover.
  //
  // WHICH IS WHY THE RING'S RAISES ARE THE ONE THING THE JOS-368 GUARD DOES NOT TOUCH:
  // `assertTopmost` would skip precisely when the ring is already topmost, and "already topmost"
  // is the state a re-raise exists to improve on. `raiseTopmost` is the unconditional spelling.
  raiseTopmost(w)
  // Unconditional and permanent: this window is never a mouse target — and DELIBERATELY not
  // `forward:true`. On Windows, forwarding installs a low-level mouse hook (WH_MOUSE_LL) owned
  // by the MAIN process; every system mouse event then waits on our message loop, so a blocked
  // main (the 8.5 s startup replay) froze the user's cursor system-wide for the duration. The
  // overlays' locked mode pays that cost for a reason (their hover sensor re-enables capture
  // over the pin); the ring has no hover sensor and nothing to click, so it pays nothing.
  w.setIgnoreMouseEvents(true)

  const wc = w.webContents
  wc.on('preload-error', (_e, preloadPath, error) =>
    logError('cursorRing:preload-error', { preloadPath, error })
  )
  forwardConsoleMessages(wc, 'cursorRing:console')

  // ONE SHOW PATH FOR THIS WINDOW, and first paint is just the first time down it. It used to be
  // a second copy of `setCursorRingVisible`'s body — the same replay/e2e gate, the same
  // showInactive, the same raise — which is two places to keep the ring's unconditional raise
  // (JOS-368) correct in. Reading the module-level handle rather than this closure's `w` is also
  // the more honest of the two: if the ring were torn down and rebuilt before this fired, the
  // window to show is the one that exists now.
  w.on('ready-to-show', () => setCursorRingVisible(true))
  w.on('closed', () => {
    cursorRingWindow = null
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    void w.loadURL(`${rendererUrl}/cursor.html`)
  } else {
    void w.loadFile(join(__dirname, '../renderer/cursor.html'))
  }
}

/** Move/resize the ring window onto the EQ window. Called ONLY when the bounds actually
 *  changed — a setBounds per cursor sample would be a window-manager round trip at 125 Hz. */
export function setCursorRingBounds(bounds: ScreenRect): void {
  const w = cursorRingWindow
  if (!w || w.isDestroyed() || sameRect(w.getBounds(), bounds)) return
  w.setBounds(bounds)
}

/**
 * Show/hide the ring without destroying it — the same hide-never-destroy contract the overlays
 * follow, and for a sharper reason here: the ring window hosts a renderer, and re-creating one
 * on every alt-tab would pay a page load (and a fresh compositor layer) for a window whose whole
 * value is that it is already warm when the game comes back.
 */
export function setCursorRingVisible(visible: boolean): void {
  const w = cursorRingWindow
  if (!w || w.isDestroyed()) return
  if (!visible) {
    if (w.isVisible()) w.hide()
    return
  }
  if (!windowsMayShow() || w.isVisible()) return
  w.showInactive()
  // Unconditional: a ring coming back from auto-hide has to land ABOVE the overlays that came
  // back with it, and it can only do that by being the most recent assertion (see below).
  raiseTopmost(w)
}

/**
 * Re-assert the ring's always-on-top so it sits ABOVE the overlays. Within one z-level the most
 * recent assertion wins, so every overlay show/re-raise path calls this last — that ordering IS
 * the "ring above overlays" invariant (see the creation-time comment). A no-op when the ring is
 * absent, destroyed, or hidden: raising a hidden window on Windows can flash it.
 *
 * THE ONE CALL THE JOS-368 GUARD DELIBERATELY SKIPS. `assertTopmost` returns early on a window
 * that already holds WS_EX_TOPMOST, which is every ring this function is ever asked about — so a
 * guarded version of this line would be a no-op forever and the circle would go back to sliding
 * behind an overlay on mouseover. It is one window per re-show against the five it saved.
 */
function raiseCursorRing(): void {
  const w = cursorRingWindow
  if (!w || w.isDestroyed() || !w.isVisible()) return
  raiseTopmost(w)
}

/** Tear the ring window down (setting switched off, app quitting). */
export function destroyCursorRingWindow(): void {
  const w = cursorRingWindow
  cursorRingWindow = null
  if (!w || w.isDestroyed()) return
  w.removeAllListeners('closed')
  // `closable:false` makes `close()` a no-op — destroy is the only way out for this window.
  w.destroy()
}
