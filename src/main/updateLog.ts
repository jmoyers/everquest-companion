// ============================================================================
// updateLog.ts — a failed update check finally says what GitHub said (JOS-295).
// ============================================================================
//
// THE GAP THIS CLOSES, and it was a gap BY CONSTRUCTION rather than by oversight: `updater.ts`
// handles electron-updater's `error` event completely — it counts the failure, records the
// telemetry outcome and pushes a sanitized sentence to the chip — and never calls `logError`. So
// an update failure has never reached `errors.log` and has never produced an error report. GitHub
// issue 29 is what that costs: a user whose check failed on every version from 0.18 to 0.23, and
// the only artefact anyone could get from him was the sanitized caption, which by then said
// `Unexpected end of JSON input` — a parse error about a body nobody asked us to parse, with the
// status, the URL and the method already destroyed by builder-util-runtime's error FORMATTER
// (shared/update.ts's JOS-211 block reads that source).
//
// So the raw error is routed HERE, BEFORE `describeUpdateFailure` gets it. What lands in
// errors.log is the whole thing (status, URL, headers, stack); what leaves the machine is what
// the error report always carries — a redacted, bounded message plus frames — and an HTTP status
// and a repo URL are on the safe side of the telemetry bright line (TELEMETRY.md: gameplay data
// never rides automatically; a diagnostic about our own public release feed is not gameplay).
//
// ---------------------------------------------------------------------------------------
// AND THE SAME BREATH HAS TO BOUND IT, OR IT BECOMES THE NEXT JOS-133
// ---------------------------------------------------------------------------------------
// A machine that is simply OFFLINE fails every check it makes, forever, and there is nothing in
// that failure about this app. The fleet has already been taught what that costs twice: 17,632
// occurrences of one image-fetch line (JOS-133) and 7,272,196 of one EPIPE (JOS-197). The rule
// those two settled on is the one applied here, and JOS-266 is the precedent it copies exactly:
//
//   * SOMEBODY ELSE'S OUTAGE IS A WARN, ONCE PER CODE PER SESSION. Console only, never
//     errors.log, never the wire. `ENOTFOUND` and `ERR_PROXY_CONNECTION_FAILED` are two different
//     stories about the machine; the second copy of either says nothing the first did not.
//   * AND AN INTERRUPTION TAKES THE SAME DOOR (JOS-307, owner ruling 2026-08-14). A laptop closing
//     its lid — or switching from Wi-Fi to a dock — under an in-flight request is not an outage and
//     is not a failure of anything; it is the most ordinary event in the life of a desktop app, and
//     0.27.0 filed twelve of them on its first day. It is warned about exactly like an unreachable
//     network, on the SAME budget (one line per code per session, `MAX_WARNED_UPDATE_CODES` wide),
//     because the two are the same claim: this failure is about the machine, and the second copy
//     adds nothing. What is NOT the same is what happens next — `updater.ts` re-anchors the cadence
//     instead of counting a failure, which is the "retry on resume" half of the ruling.
//   * AND SO DOES A POWERSHELL THIS PC WILL NOT LET RUN (JOS-421). The fleet's single biggest
//     error family is electron-updater's code-signature check shelling out to PowerShell and
//     getting nothing back — ~330 occurrences, every version since 0.28.0, filed as `parse`
//     (a bare `SyntaxError` from `JSON.parse('')`) or as `other` (`Command failed: … powershell.exe
//     …`). shared/update.ts's JOS-421 block reads the library source and shows the mechanism; what
//     matters HERE is that it is a statement about security software on the user's machine, the
//     second copy says nothing the first did not, and while it sat at the top of the store it was
//     the noise floor every real updater regression had to be found above. Same door, same budget.
//     WHAT IS DIFFERENT FROM THE OTHER TWO, said out loud because it is the reason to hesitate:
//     this one does not heal. An install in this state can never auto-update. That is precisely why
//     the demotion is paired with a SENTENCE — `SIGNATURE_BLOCKED_MESSAGE` in the chip and in
//     Preferences — instead of a silence: a permanent, user-fixable condition belongs in front of
//     the user, not in a fleet report they will never see. The fleet-side count survives as
//     `updateOutcome { step: 'download', ok: false }`, one bounded event per attempt, which is the
//     query that answers "is a cohort frozen".
//   * AN ANSWER FROM GITHUB IS AN ERROR, EVERY TIME. A 403/429/451/5xx and the parse-masked
//     failure that hides one are the entire point of the ticket and are never withheld here. What
//     bounds THEM is what bounds every other error in the app: `errorRepeat`'s five identical
//     lines and `errorBudget`'s hundred reports per fingerprint per session — the general rule,
//     asked downstream, rather than a second private opinion about the same question.
//   * THE OFFLINE SIGNAL IS NOT LOST, it moves to the counter that already existed:
//     `updateOutcome { step: 'check', ok: false, failureClass: 'network' }` is emitted per check
//     by `noteUpdate` whatever this module decides. One bounded event per check, five words wide,
//     is exactly the fleet-side answer to "how many installs cannot reach us" — and it is the
//     query the ticket already names.
//
// ---------------------------------------------------------------------------------------
// IT IMPORTS NOTHING BUT PURE SHARED CODE
// ---------------------------------------------------------------------------------------
// `errorLog.ts` cannot be imported here: `updater.ts` passes the two sinks in. That is not
// ceremony — it is what lets `tests/updateFailureLog.test.mts` drive the REAL production rule with
// no Electron in the process, which is the same technique `errorRepeat.ts` and `errorBudget.ts`
// are written for, and the only way anything on this path has ever been testable.

import {
  SIGNATURE_BLOCKED_WARN,
  classifyUpdateFailure,
  updateFailureCode,
  updateHttpStatus,
  type UpdateFailureKind
} from '../shared/update'

/** Which half of the flow failed. electron-updater funnels both through one `error` event, and
 *  only `updater.ts`'s `downloading` latch can tell them apart. */
export type UpdateStep = 'check' | 'download'

/**
 * WHICH ATTEMPT THIS WAS, and it is in the line because the retry is otherwise invisible.
 *
 * JOS-211 gave one logical check up to two attempts: a malformed/empty feed body is swallowed
 * once — no verdict, no telemetry, no backoff tick — and `runCheck` goes round again. A store that
 * showed only the second failure would describe a single-shot check and would answer "does the
 * retry help?" with silence. `retrying` is the swallowed one; `final` is the one that produced a
 * verdict.
 */
export type UpdateAttempt = 'retrying' | 'final'

/** The two sinks, handed in by `updater.ts` (see the header for why they are not imported). */
export interface UpdateLogSinks {
  /** `logError` — errors.log + dev stdout + the error report. */
  readonly error: (source: string, payload: unknown) => void
  /** `logWarn` — console only, and deliberately so. */
  readonly warn: (...args: unknown[]) => void
}

/** Source tags. Greppable by origin like every other `logError` tag, and separate per step
 *  because a CDN download failure and a feed check failure are two different facts (they are also
 *  two different `errorRepeat` budgets, which is what stops one masking the other). */
export const UPDATE_CHECK_SOURCE = 'main:updateCheck'
export const UPDATE_DOWNLOAD_SOURCE = 'main:updateDownload'
/** The tag for a line electron-updater's OWN logger produced, rather than one of our handlers. */
export const UPDATER_LIBRARY_SOURCE = 'main:updater'

/** The console prefix for the library's narration. `[everquest-companion]` is the info prefix the
 *  whole main process narrates under (errorLog.ts); the second tag says whose line it is. */
export const UPDATER_LOG_PREFIX = '[everquest-companion] [updater]'

/**
 * Distinct unreachable CODES one session will warn about. The real set is a handful of errno and
 * `net::ERR_` spellings, so this is a ceiling on a pathological machine rather than a budget
 * anybody spends — `imageCache.ts`'s `MAX_WARNED_READ_CODES`, for its reason.
 */
export const MAX_WARNED_UPDATE_CODES = 8

/**
 * The warn-budget key for a blocked PowerShell (JOS-421). A synthetic code because the real errors
 * carry none worth keying on — the `SyntaxError` has no `code` at all and the cousin family's is a
 * numeric exit status — and one key is what we want anyway: the two shapes are one condition, so
 * the second of them says nothing the first did not.
 */
export const BLOCKED_WARN_CODE = 'SIGNATURE_CHECK_BLOCKED'

/** Unreachable codes already warned about this session. Bounded by the constant above. */
const warnedCodes = new Set<string>()

/** True the FIRST time this session an update request failed with `code`, false every time after
 *  — including forever, once the ceiling is reached. */
export function takeUnreachableWarning(code: string): boolean {
  if (warnedCodes.has(code)) return false
  if (warnedCodes.size >= MAX_WARNED_UPDATE_CODES) return false
  warnedCodes.add(code)
  return true
}

/** Forget the warned codes. Tests only — a real session warns once per code and means it. */
export function resetUpdateLogWarnings(): void {
  warnedCodes.clear()
}

/** `err.message`'s first line, or the value stringified. The FULL text still reaches errors.log
 *  through the nested error below; this is the headline the wire's 200 characters get. */
function headline(err: unknown): string {
  const text = String((err as { message?: unknown } | null | undefined)?.message ?? err)
  return text.split('\n')[0].trim()
}

/**
 * THE SENTENCE THE ERROR REPORT CARRIES. It states the step, the attempt and the class up front —
 * before the library's own words — because those three are what a reader of the error store needs
 * and none of them exist anywhere in the raw error.
 *
 * `status=403` is repeated here even though `code` carries `HTTP_ERROR_403`: the redacted message
 * is what a human reads in the store's list view, and the whole ticket is that the status was the
 * one fact nobody could get.
 */
export function updateFailureLine(
  step: UpdateStep,
  attempt: UpdateAttempt,
  kind: UpdateFailureKind,
  err: unknown
): string {
  const status = updateHttpStatus(err)
  const klass = status === null ? kind : `${kind} ${String(status)}`
  return `update ${step} failed (${attempt}, ${klass}): ${headline(err)}`
}

/**
 * What `logError` is handed. A WRAPPER rather than the bare error, because the three fields the
 * raw error cannot supply are the ones this ticket is about — and because `caughtFields`
 * (shared/errorReportLocation.ts, JOS-111) unwraps exactly this shape: the outer object's
 * `message` wins, while the NESTED error supplies the stack, the name and the code. So the report
 * says `HttpError` / `HTTP_ERROR_403` with the real frames, under a message that names the step
 * and the attempt, and errors.log gets the whole object including the untouched stack.
 */
export interface UpdateFailurePayload {
  readonly step: UpdateStep
  readonly attempt: UpdateAttempt
  readonly kind: UpdateFailureKind
  readonly message: string
  /** The RAW error, exactly as electron-updater handed it over. Never pre-formatted. */
  readonly error: unknown
}

/**
 * ROUTE ONE UPDATE FAILURE, and return the kind so the caller can say what it did.
 *
 * The whole decision is here rather than at the call site so there is ONE answer to "does an
 * update failure get filed", and adding a third call site tomorrow cannot get it wrong.
 */
export function logUpdateFailure(
  step: UpdateStep,
  attempt: UpdateAttempt,
  err: unknown,
  sinks: UpdateLogSinks
): UpdateFailureKind {
  const kind = classifyUpdateFailure(err)
  if (kind === 'blocked') {
    // THIS PC'S OWN SECURITY SOFTWARE (JOS-421). One line per session, console only. The user is
    // told by the chip and by Preferences, which is where a condition only they can fix belongs.
    if (takeUnreachableWarning(BLOCKED_WARN_CODE)) {
      sinks.warn(
        UPDATER_LOG_PREFIX,
        `update ${step} failed its code-signature check (${BLOCKED_WARN_CODE}); ${SIGNATURE_BLOCKED_WARN}`
      )
    }
    return kind
  }
  if (kind === 'unreachable' || kind === 'interrupted') {
    // SOMEBODY ELSE'S NETWORK, OR A MACHINE THAT MOVED. One line per code per session, on the
    // console only; the per-check signal that survives is `updateOutcome`'s failureClass, which the
    // caller records either way. The two share a budget on purpose (see the header).
    const code = updateFailureCode(err) ?? kind
    if (takeUnreachableWarning(code)) {
      sinks.warn(
        UPDATER_LOG_PREFIX,
        kind === 'interrupted'
          ? `update ${step} was cut short by the machine suspending or changing network (${code}); ` +
              'the next check is re-anchored'
          : `update ${step} could not reach the update service (${code}); ` +
              'further unreachable attempts this session are counted, not logged'
      )
    }
    return kind
  }
  const payload: UpdateFailurePayload = {
    step,
    attempt,
    kind,
    message: updateFailureLine(step, attempt, kind, err),
    error: err
  }
  sinks.error(step === 'download' ? UPDATE_DOWNLOAD_SOURCE : UPDATE_CHECK_SOURCE, payload)
  return kind
}

// ---------------------------------------------------------------------------------------
// THE LIBRARY'S OWN LOGGER (the second half of JOS-295)
// ---------------------------------------------------------------------------------------
//
// electron-updater logs its whole life through `this._logger`, which DEFAULTS TO `console`
// (AppUpdater.js:179) — so today it prints full stacks to a packaged app's stdout, which nobody
// captures and nothing keeps. Assigning our logger is what makes those lines durable, and it also
// closes a smaller hole: a direct `console.error` bypasses `errorLog.ts`'s dead-pipe door
// (JOS-197), so under a closed pipe the library's own narration could throw where ours cannot.
//
// THE MAPPING IS NOT LEVEL-FOR-LEVEL, because errors.log has a law about what belongs in it
// (errorLog.ts: routine narration is console-only, or the file that exists so a blank window is
// never silent gets buried under progress):
//
//   info  -> logInfo   console only. "Checking for update", "Found version 0.26.0 (url: …)".
//   warn  -> logWarn   console only. Staging-percentage and staging-user-id complaints.
//   debug -> NOT PROVIDED. The library asks `if (this._logger.debug != null)` before using it, so
//            leaving it undefined keeps its per-request chatter off exactly as it is today.
//   error -> see below. Two of its error-level lines are NOT errors of ours.

/** What to do with one error-level line from the library. */
export type UpdaterLineRoute = 'error' | 'warn' | 'drop'

/**
 * THE ECHO. `AppUpdater`'s constructor registers its own `error` listener —
 * `this.on('error', err => this._logger.error(\`Error: ${err.stack || err.message}\`))`
 * (AppUpdater.js:201-203) — so EVERY error event arrives here as well as at our handler, already
 * flattened into a string that has lost the `statusCode`, the `code` and the object identity.
 *
 * It is DROPPED, and dropping it is load-bearing twice over: our own handler files the same
 * failure with the step, the attempt and the raw error attached, so keeping this one would put two
 * rows in the error store for one failure — and, worse, it would file the OFFLINE failures the
 * bound above just withheld, defeating the whole second half of the ticket through the back door.
 */
const EVENT_ECHO_PREFIX = 'Error: '

/**
 * NOT AN ERROR, BY OUR OWN RESEARCH. `Cannot download differentially, fallback to full download`
 * (AppUpdater.js:705) is logged at error level for a condition updater.ts's research §4 already
 * states is harmless: every differential failure mode falls back to a full download, so it costs
 * bandwidth and never correctness. It is worth a console line and is not worth a fleet report.
 */
const DIFFERENTIAL_FALLBACK_RE = /Cannot download differentially/i

/**
 * Where one of the library's error-level lines goes. Everything unrecognized becomes an error —
 * the failure direction a classifier owes its reader (shared/update.ts's 'other').
 */
export function routeUpdaterLibraryError(message: unknown): UpdaterLineRoute {
  const text = String((message as { message?: unknown } | null | undefined)?.message ?? message)
  if (text.startsWith(EVENT_ECHO_PREFIX)) return 'drop'
  if (DIFFERENTIAL_FALLBACK_RE.test(text)) return 'warn'
  return 'error'
}
