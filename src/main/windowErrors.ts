// ============================================================================
// windowErrors.ts — webContents error capture, split out of windows.ts (Task #13).
// ============================================================================
//
// A PURE MOVE. Both functions below came out of `windows.ts` unchanged when that file reached the
// 400-code-line ceiling; the repo's answer to that is a split, not a widened threshold (the same
// call `usageStore.ts`, `AnalyticsBits.tsx` and `releaseHealth.ts` all made). Nothing here is new
// behaviour — the only edit the move required is the one described under `captureMainWindowErrors`.
//
// WHY THIS IS THE RIGHT CUT. `windows.ts` is about CREATING windows and owns the trust boundary
// (`WEB_PREFERENCES`, `hardenWebContents`, `hardenSession` — all of which stay there, beside the
// only code that constructs a BrowserWindow). What is here is the other thing that file had grown:
// the plumbing that makes a broken renderer AUDIBLE rather than a blank rectangle. It is attached
// to a webContents, it talks only to `errorLog`, and it decides nothing about how a window is made.
//
// It is also the natural home for the renderer-crash HEALTH COUNTER (JOS-96): the crash count and
// the crash log are the same event observed twice, and they now sit in the same handler.
//
// THE ONE BEHAVIOUR CHANGE SINCE THE MOVE (JOS-99): `forwardConsoleMessages` no longer writes
// renderer WARNINGS into errors.log — see its doc comment, and `consoleForward.ts` for the rule.
//
// AND THE SECOND (JOS-418): TWO OF THE THREE HANDLERS HERE FILED BLANK REPORTS. Electron hands
// `render-process-gone` a `{ reason, exitCode }` and `did-fail-load` four fields about a URL, and
// both were passed to `logError` as-is. `caughtFields` reads `name`, `message`, `stack` and `code`
// off a payload — a bare details object has none of them — so the error store filed 9 occurrences
// on 1.5.0 alone (fingerprint 75c31a27) as the literal text `Error: `, with everything Electron
// had just told us sitting one property away, unread.
//
// The two SENTENCES are `./windowGone.ts`, a leaf with no imports — the same split
// `consoleForward.ts` made in this same handler set, and for the same reason: this file imports
// `electron`, so nothing in it can be driven by a unit test, and the shape of what the fleet
// receives is exactly the thing that has to be pinned. That module's header carries the whole
// argument (the never-empty guarantee, the shape gate on Chromium's strings, and why the exit code
// rides in `code` as well as in the prose). `preload-error` needed nothing: it already carries a
// real Error one property down and `caughtFields` unwraps it — `Unable to load preload script:
// <path>` is that family, and it was never blank.

import { app } from 'electron'
import { join } from 'path'
import { consoleForward } from './consoleForward'
import { logError, logWarn } from './errorLog'
import { noteRendererCrash } from './telemetry'
import { DID_FAIL_LOAD_ERROR_NAME, didFailLoadMessage, numericOr, renderGoneReport } from './windowGone'

/** How the capture reaches the window it may need to reload. Injected rather than imported so
 *  this module does not import `windows.ts` back and close a cycle. */
export type WindowRef = () => Electron.BrowserWindow | null

/**
 * Forward renderer console messages to main, so agents reading the dev task output see
 * renderer-side trouble too. level: 0=verbose 1=info 2=warning 3=error.
 *
 * ERRORS ONLY REACH errors.log (JOS-99). A renderer `console.warn` used to be written there
 * exactly like an error, which made both of that file's readers wrong: a human greps it for what
 * broke, and `mainErrorLogLines` counts its lines as the fleet's error rate. Warnings still print
 * to stdout in an unpackaged build — dev visibility is unchanged, verbatim, through `logWarn` —
 * they simply do not enter the file or the count. The rule itself is `consoleForward` (a leaf
 * module with no imports, so it is unit-tested against the real production decision); what is here
 * is the wiring and the two sinks.
 *
 * Electron's `console-message` listener is five positional arguments wide; the four fields
 * are taken as a rest tuple so the callback stays inside the project's max-params ceiling.
 * `tag` is the source tag ('renderer:console' / 'overlay:console' / 'cursorRing:console') — it
 * labels the stdout line too, so a warning is still attributable to the window that printed it.
 */
export function forwardConsoleMessages(wc: Electron.WebContents, tag: string): void {
  wc.on('console-message', (_e, ...rest) => {
    const [level, message, line, sourceId] = rest
    const source = `${sourceId}:${line}`
    // `app.isPackaged` is read PER MESSAGE rather than captured at wiring time: this function runs
    // during window creation, and reading a flag at call time is one property fewer to argue about.
    const where = consoleForward(level, app.isPackaged)
    if (where === 'drop') return
    if (where === 'stdout') logWarn('[everquest-companion:warn]', `[${tag}]`, message, source)
    else logError(tag, { level, message, source })
  })
}

/**
 * webContents error capture for the MAIN window (Task #13). Each of these would otherwise
 * leave a blank window with no console trace. Log everything to errors.log + dev stdout, and
 * self-heal once where it's safe.
 *
 * THE ONE EDIT THE SPLIT REQUIRED: the module-local `mainWindow` this used to close over is now
 * the `window` argument. Every read is still a fresh call, so the late-crash guards
 * (`!window() || window().isDestroyed()`) mean exactly what they meant when they read a mutable
 * module variable — which is the property that matters, since every one of them fires long after
 * this function has returned.
 */
export function captureMainWindowErrors(wc: Electron.WebContents, window: WindowRef): void {
  // The renderer process died/crashed (OOM, GPU crash, killed). Log the reason,
  // then reload the window ONCE so a transient crash doesn't strand the user.
  let renderProcessReloaded = false
  wc.on('render-process-gone', (_e, details) => {
    // ONE CRASH IS ONE COUNT (JOS-96) — counted here rather than off `logError`, because this
    // handler writes TWO log lines per crash (the details, then the recovery reload) and counting
    // lines would report every crash as two. `mainErrorLogLines` still sees both, correctly.
    // MAIN WINDOW ONLY: overlays get `forwardConsoleMessages` but no crash handler, so an overlay
    // crash is invisible to this counter and `telemetry/health.ts` says so.
    noteRendererCrash()
    // THE DETAILS RIDE ALONG UNDERNEATH the three fields the wire reads, so `errors.log` on the
    // machine still holds Electron's payload verbatim while the fleet gets a sentence.
    logError('main:render-process-gone', renderGoneReport(details))
    const win = window()
    if (!renderProcessReloaded && win && !win.isDestroyed()) {
      renderProcessReloaded = true
      logError('main:render-process-gone', 'reloading window once to recover')
      win.reload()
    }
  })

  // The page (or dev server) failed to load. Retry ONCE — most common in dev when
  // the window opens a beat before electron-vite's renderer server is ready.
  // (Rest tuple for the same max-params reason as forwardConsoleMessages.)
  let didFailReloaded = false
  wc.on('did-fail-load', (_e, ...rest) => {
    const [errorCode, errorDescription, validatedURL, isMainFrame] = rest
    // errorCode -3 (ABORTED) is a benign navigation cancel; don't spam or retry.
    if (errorCode === -3) return
    logError('main:did-fail-load', {
      name: DID_FAIL_LOAD_ERROR_NAME,
      message: didFailLoadMessage(errorDescription, errorCode, isMainFrame),
      code: numericOr(errorCode),
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame
    })
    const win = window()
    if (isMainFrame && !didFailReloaded && win && !win.isDestroyed()) {
      didFailReloaded = true
      setTimeout(() => {
        // RE-READ, never the `win` captured above: 300 ms is long enough for the window to have
        // gone, and this guard is the whole reason the delay is safe.
        const live = window()
        if (!live || live.isDestroyed()) return
        const url = process.env.ELECTRON_RENDERER_URL
        if (url) void live.loadURL(url)
        else void live.loadFile(join(__dirname, '../renderer/index.html'))
      }, 300)
    }
  })

  // A preload script threw while initializing (the contextBridge/api is then
  // missing — a classic invisible cause of a broken renderer).
  wc.on('preload-error', (_e, preloadPath, error) => {
    logError('main:preload-error', { preloadPath, error })
  })

  forwardConsoleMessages(wc, 'renderer:console')
}
