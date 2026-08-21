// ============================================================================
// windowGone.ts — what a dead renderer and a failed load SAY about themselves (JOS-418).
// ============================================================================
//
// Two `webContents` handlers in `windowErrors.ts` used to hand `logError` Electron's raw details
// object and nothing else. `caughtFields` reads `name`, `message`, `stack` and `code` off a
// payload, and `{ reason, exitCode }` has none of them — so the error store filed the family as
// the literal text `Error: `, nine times on 1.5.0 alone (fingerprint 75c31a27; the store's own
// exemplar pins the capture site at `out/main/index.js:10455:5`, which is that `logError` call).
//
// A LEAF MODULE, AND THAT IS THE POINT — the same move `consoleForward.ts` made, for the same
// reason, in the same handler set. `windowErrors.ts` imports `electron`, so nothing in it can be
// driven by a unit test; these are pure string builders with NO IMPORTS AT ALL, so the shape of
// what the fleet receives is pinned by `tests/windowGoneReports.test.mts` with no Electron in the
// process. The wiring stays where the wiring belongs.
//
// THREE PROPERTIES, and they are the ticket:
//   1. THE MESSAGE IS NEVER EMPTY. Every field has a fallback computed above it and the leading
//      clause is a literal, so there is no input — not `undefined`, not a hostile object, not a
//      payload from an Electron that changed its mind — that produces a blank.
//   2. OUTSIDE STRINGS ARE HELD TO A SHAPE. `reason` and `errorDescription` arrive from Chromium
//      and are repeated back into a message the fleet TRANSMITS. Nothing that could spell a path,
//      a character name, a zone or a line of the game's log fits through these patterns; a value
//      that does not fit reads as `unknown`, which is the honest thing to say about it.
//   3. THE NUMBER RIDES IN `code` TOO. `redactMessage` folds any run of five or more digits to
//      `<n>`, and a Windows crash exit code is ten digits (0xC0000005 is 3221225477). `code` is
//      the wire's machine-readable field, `errorCodeOf` accepts a number, and `errors show`
//      prints it — so the one value that separates an access violation from a stack overflow
//      survives the redactor by riding in the field that exists for it.

/**
 * The error NAME a dead renderer carries. `errorFingerprint` hashes the NAME and the frames and
 * never the message (shared/errorReport.ts says why), so the name is the only field that can give
 * this diagnosis a row of its own instead of a share of everything else that reported `Error`.
 *
 * The recovery line beneath it in `captureMainWindowErrors` keeps the default `Error`, on purpose:
 * it is a second sentence about the same crash, and the two being two rows is what lets a reader
 * see a crash that was NOT followed by a reload — which is the interesting one.
 */
export const RENDER_GONE_ERROR_NAME = 'RenderProcessGone'

/** The error NAME a failed load carries, by the same argument. */
export const DID_FAIL_LOAD_ERROR_NAME = 'DidFailLoad'

/**
 * Chromium's `render-process-gone` reasons, held to a SHAPE rather than to a list that would go
 * stale on the next Electron: they are all lower-kebab words (`crashed`, `oom`, `killed`,
 * `launch-failed`, `integrity-failure`, `abnormal-exit`, `clean-exit`). A reason a future Electron
 * adds still reads through; nothing that is not one of Chromium's words can.
 */
const REASON_RE = /^[a-z][a-z-]{0,23}$/

/** A `did-fail-load` description is Chromium's net-error name — `ERR_FILE_NOT_FOUND`,
 *  `ERR_CONNECTION_REFUSED`. SCREAMING_SNAKE, and nothing else. */
const NET_ERROR_RE = /^[A-Z][A-Z0-9_]{0,47}$/

/** What this file says when it could not read a value: the same word everywhere, so a reader
 *  learns it once. */
export const UNKNOWN = 'unknown'

/** A string repeated back into a transmitted message, or the honest fallback. */
function shaped(value: unknown, re: RegExp): string {
  return typeof value === 'string' && re.test(value) ? value : UNKNOWN
}

/** A number repeated back, or `-1` — which is not a real exit code and so cannot be mistaken for
 *  one, the same sentinel `childProcessGone.ts` uses for the same field. */
export function numericOr(value: unknown, fallback = -1): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** The `logError` payload for one dead renderer. `reason` and `exitCode` ride along under the
 *  three wire fields so `errors.log` on the machine with the problem still holds Electron's own
 *  payload as fields rather than only as prose. */
export interface RenderGoneReport {
  name: string
  message: string
  code: number
  reason: string
  exitCode: number
}

export function renderGoneReport(details: unknown): RenderGoneReport {
  const d = (typeof details === 'object' && details !== null ? details : {}) as Record<string, unknown>
  const reason = shaped(d.reason, REASON_RE)
  const exitCode = numericOr(d.exitCode)
  return {
    name: RENDER_GONE_ERROR_NAME,
    message: `render process gone: reason=${reason}, exitCode=${String(exitCode)}`,
    code: exitCode,
    reason,
    exitCode
  }
}

/**
 * The message for one failed load.
 *
 * `validatedURL` IS DELIBERATELY NOT IN IT. In a packaged install it is a
 * `file:///C:/Users/<the user's name>/…` URL; `redactMessage` would fold it to `<path>`, so the
 * fleet would receive four characters of nothing where a reader wanted the reason. It stays in the
 * payload — `errors.log` on the affected machine holds it in full, which is where it is useful.
 */
export function didFailLoadMessage(errorDescription: unknown, errorCode: unknown, isMainFrame: unknown): string {
  const description = shaped(errorDescription, NET_ERROR_RE)
  const code = numericOr(errorCode)
  return `load failed: ${description} (errorCode=${String(code)}, mainFrame=${String(isMainFrame === true)})`
}
