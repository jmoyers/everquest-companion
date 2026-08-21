// ============================================================================
// telemetry/errorReports.ts — turn a caught error into a reportable one (JOS-100).
// ============================================================================
//
// `health.ts` counts that something broke. This turns the SAME event into something a person
// could fix from: which error, at which bundle position, after which parser events, in which
// view, how far into the session, and how many times.
//
// ---------------------------------------------------------------------------------------
// WHERE IT IS FED FROM, AND WHY THERE
// ---------------------------------------------------------------------------------------
// `errorLog.ts logError` — the ONE funnel every main-process error append already passes
// through, and the same line `noteErrorLogLine()` is bumped on. Everything lands there:
//   * `main:uncaughtException` / `main:unhandledRejection` (crashGuards.ts),
//   * `renderer:ErrorBoundary`, `renderer:onerror`, `renderer:unhandledrejection` (the
//     `error:report` IPC in ipc/windowControls.ts, which the renderer's own handlers feed),
//   * `main:render-process-gone`, `main:did-fail-load`, `main:preload-error` (windowErrors.ts).
// One capture point rather than six is the same argument JOS-96 made for `mainErrorLogLines`:
// a producer that has to be remembered at each of six sites is a producer that will be
// forgotten at the seventh.
//
// IT MUST NOT IMPORT `collector.ts`. `collector` imports `errorLog`, and `errorLog` imports
// THIS — so reaching for `recordEvent`, `sessionUptimeMs` or the store from here would close
// the cycle `errorLog → errorReports → collector → errorLog`, on the app's error path, which is
// the single worst place in the process to find a module-init order bug (health.ts's header
// says the same thing about the same cycle). Hence:
//   * the session clock is kept HERE, stamped by `resetErrorReports(now)` from the collector's
//     own session boundaries, rather than read from the collector;
//   * nothing here transmits. Reports are held in memory and leave only through `recordEvent`,
//     which flush.ts calls at drain time and which is THE gate — the user's switch is checked
//     there and nowhere else, exactly as it is for every other event.
//
// ---------------------------------------------------------------------------------------
// WHEN THE THROW WILL NOT SAY WHERE (JOS-111)
// ---------------------------------------------------------------------------------------
// "At which bundle position" assumes the payload HAS a bundle position, and the fleet's own
// numbers said otherwise: the two loudest issues in the live 0.13.0 stream were both FRAMELESS,
// so both hashed the error name alone and collapsed into one row. `locate` below is the ladder
// that answers it anyway — the throw's own frames, else a stack `errorLog` captured at its call
// site (labelled `capture`, never passed off as a throw site), else nothing — with external
// frames and an unwrapped nested error riding independently, and the fingerprint falling back on
// a shape of the already-redacted message when there is no location at all. The classification,
// the unwrap and the skeleton are all pure and live in `shared/errorReportLocation.ts`.
//
// ---------------------------------------------------------------------------------------
// ONE EXEMPLAR PER FINGERPRINT PER SESSION
// ---------------------------------------------------------------------------------------
// The first occurrence of a fingerprint keeps its message, frames and breadcrumbs. Every repeat
// adds to a count. A render loop that throws ten thousand times is ONE ring record carrying
// `count: 10000`, not ten thousand records that would blow the 500-entry ring and take every
// other counter in it out with them.
//
// The PENDING count is a delta drained by whichever session report fires first, exactly like
// `linesPending` and the health counters: no double counting, and a killed session loses at
// most its last window. The EXEMPLAR is kept across drains, so a fingerprint that fires again
// after a heartbeat re-sends the same stack with the new count — and the server's UPSERT is
// first-wins, so that is idempotent by construction rather than by agreement.
//
// ---------------------------------------------------------------------------------------
// …AND AT MOST N OCCURRENCES OF IT, EVER (JOS-197)
// ---------------------------------------------------------------------------------------
// "One exemplar carrying `count: 10000`" was written as a boast about how cheap a repeat is. The
// fleet then filed 7,272,196 occurrences of ONE fingerprint from ONE install in ONE day, and the
// sentence above is exactly why nothing stopped it: the count was free, so nobody bounded it.
// `../errorBudget.ts` bounds it now, and `noteError` RETURNS its verdict rather than merely obeying
// it — because the budget has to govern the errors.log line and the dev stdout line too, and
// `logError` is the only place that owns those. That module's header carries the whole rule; what
// matters here is that this file no longer decides on its own how many times a fingerprint may be
// reported, and that the fingerprint is computed HERE because here is where it already was.
//
// ---------------------------------------------------------------------------------------
// …AND THE ERRORS THAT HAPPEN BEFORE THERE IS A SESSION TO PUT THEM IN (JOS-272)
// ---------------------------------------------------------------------------------------
// `logError` works from the first line of the first module. `beginSession()` does not run until the
// composition root has created a window and called `startTelemetry` — and its very first act is to
// `resetErrorReports(now)`, which used to CLEAR everything filed up to that point. So every error
// raised at module scope was recorded, held, and then thrown away a second before the pipeline that
// could have carried it came up. Nothing in the fleet has ever seen one.
//
// That is not a hypothetical class. `src/main/store.ts` runs the schema migration from module scope,
// before `new Store()` — deliberately, so no reader can observe a pre-migration shape — and the one
// event a torn store write produces (`store schema: … is not valid JSON`) is filed from exactly
// there. The single most important thing this app can say about a settings reset was the one thing
// it structurally could not say.
//
// THE FIX IS A PARAMETER, NOT A LATCH. `resetErrorReports` takes `keepPending`, and the collector —
// which is the module that knows what a session IS — passes true for the FIRST session of the
// process and false for every one after it. Two consequences, both wanted:
//   * everything filed before the first session survives INTO it, with its real exemplar, frames and
//     capture site (they were computed at boot; nothing is re-derived later and nothing is faked);
//   * a session that was ENDED and resumed still starts empty, because `endSession` clears and the
//     collector's counter has already moved past one. An install that turned analytics off does not
//     get the errors it filed while it was off, which is what `endSession`'s own docstring promises.
// A pre-session report buckets its `sessionAgeMs` at 0 — `sessionStartedAt` was 0 when it was
// built — and 0 is the honest answer for something that happened before the session existed.

import { errorBudget, resetErrorBudget, type BudgetVerdict } from '../errorBudget'
import {
  errorCodeOf,
  errorFingerprint,
  errorNameOf,
  parseStackFrames,
  redactMessage,
  type ErrorFrame
} from '../../shared/errorReport'
import {
  caughtFields,
  fingerprintFallback,
  parseComponentPath,
  parseExternalFrames,
  stampedMessage,
  type CaughtFields
} from '../../shared/errorReportLocation'
import {
  bucketOf,
  MAX_SESSION_FINGERPRINTS,
  SESSION_AGE_MS_EDGES,
  TELEMETRY_BREADCRUMB_KINDS,
  TELEMETRY_ERROR_VIEWS,
  type EvErrorReport,
  type TelemetryBreadcrumb,
  type TelemetryBreadcrumbKind,
  type TelemetryErrorView
} from '../../shared/telemetry'
import { currentMode, readBreadcrumbs, resetBreadcrumbs } from './breadcrumbs'

/**
 * The ring's crumbs, narrowed onto the wire's closed enum.
 *
 * `breadcrumbs.ts` types its `kind` as a bare `string` because it may not import the enum — it
 * has to stay import-free to be callable from `LogBus.emit` — so the narrowing happens HERE,
 * at the one boundary where the two meet. It is a real FILTER and not a cast: every value it
 * sees today is a `LogEventKind` and so is a member, but a kind added to the parser and
 * forgotten in the duplicated wire list would otherwise fail the whole event at the validator
 * and take a real crash report down with it. Dropping one crumb is the cheaper failure, and
 * `tests/errorReportContract.test.mts` pins the two lists equal so it should never happen.
 */
function wireCrumbs(): TelemetryBreadcrumb[] {
  const known = TELEMETRY_BREADCRUMB_KINDS as readonly string[]
  return readBreadcrumbs()
    .filter((c) => known.includes(c.kind))
    .map((c) => ({ kind: c.kind as TelemetryBreadcrumbKind, offsetMs: c.offsetMs }))
}

/** The exemplar plus its undrained count. `report.count` is filled in at drain time. */
interface Pending {
  exemplar: Omit<EvErrorReport, 'count'>
  n: number
}

const pending = new Map<string, Pending>()
let sessionStartedAt = 0
let currentView: TelemetryErrorView = 'unknown'

/** The verdict for an occurrence that never reached the budget at all — see `noteError`'s two
 *  named fail-open cases. It says "write it as you always did", and never carries a notice. */
const UNBUDGETED: BudgetVerdict = { report: true, notice: null }

/**
 * WHICH TAB IS OPEN, as the renderer last stated it.
 *
 * It comes from the renderer because that is the only process that knows. A MAIN-process error
 * therefore reports the last view a window mentioned, or `unknown` before any has — which is
 * why `unknown` is in the enum at all. Guessing `overview` because it is the default would put
 * a made-up value in the one column a reader would use to decide where to look.
 *
 * The value is checked against the closed enum HERE and not merely at the wire, because it
 * arrives over IPC from an untrusted renderer and is stored between calls: an unchecked one
 * would sit in this variable poisoning every LATER report, including main-process ones the
 * renderer had nothing to do with.
 */
export function noteCurrentView(view: unknown): void {
  if (typeof view !== 'string') return
  if (!(TELEMETRY_ERROR_VIEWS as readonly string[]).includes(view)) return
  currentView = view as TelemetryErrorView
}

/**
 * What `logError` hands over. Deliberately NOT `Error`: the renderer's IPC report is a plain
 * object, `unhandledRejection` can carry anything at all, and `throw 42` is legal JavaScript.
 * Every field is read defensively and every one has an honest fallback.
 *
 * The read itself lives in `shared/errorReportLocation.ts` (`caughtFields`), because since
 * JOS-111 it also FOLLOWS NESTED ERRORS — `logError('main:preload-error', { preloadPath, error })`
 * carries a real stack one property down — and that unwrap is pure, adversarial, and worth
 * driving from a test with no Electron in the process.
 */
export type CaughtError = CaughtFields

/**
 * WHERE THIS ERROR HAPPENED, in the order that prefers the truest answer (JOS-111).
 *
 * 1. THE THROW'S OWN BUNDLE FRAMES. Everything below is only reached when there are none.
 * 2. THE CAPTURE SITE, synthesised from a stack `logError` took at its own call site. A forwarded
 *    renderer console error is `{ level, message, source }` and never had a stack; the app still
 *    knows which of its eighty-odd `logError` calls the report came out of, and those are
 *    different issues. It is labelled `capture` so it is never read as a throw site.
 * 3. NOTHING, and the fingerprint's fallback (below) is what stops that colliding.
 *
 * `externalFrames` is independent of all three: a stack can carry Node/Electron/dependency frames
 * whether or not it carries ours, and they are worth having either way.
 */
interface Location {
  frames: ErrorFrame[]
  external: ErrorFrame[]
  origin: 'thrown' | 'capture'
}

function locate(stack: unknown, captureSite: (() => string) | undefined): Location {
  const external = parseExternalFrames(stack)
  const frames = parseStackFrames(stack)
  if (frames.length > 0 || captureSite === undefined) {
    return { frames, external, origin: 'thrown' }
  }
  const site = parseStackFrames(captureSite())
  return site.length > 0
    ? { frames: site, external, origin: 'capture' }
    : { frames, external, origin: 'thrown' }
}

/**
 * RECORD ONE CAUGHT ERROR. Never throws — it is called from inside `logError`, which is itself
 * called from inside `catch` blocks and from process-level crash handlers. An exception here
 * would turn a logged error into an unlogged crash, so the whole body is guarded.
 *
 * `source` is the tag `logError` already uses (`main:uncaughtException`, `renderer:ErrorBoundary`,
 * …). It is taken so this function can refuse the one source that would be circular — and, since
 * JOS-418, as the LAST RESORT for a report whose message came out empty.
 *
 * THAT IS A NARROWING OF "it is NOT sent", not an abandonment of it, and the narrowing is the
 * whole of it: the tag never travels beside a message that says anything, it travels INSTEAD of a
 * message that says nothing, and it travels only in the tag SHAPE `stampedMessage` enforces
 * (`shared/errorReportLocation.ts` carries the argument, including why one source in this app is
 * renderer-supplied and the shape is therefore load-bearing). The old sentence was right that the
 * frames say where far better — right up to the reports where the frames are all there is and the
 * message is the empty string, which is exactly the family this ticket came from.
 *
 * `captureSite` IS A THUNK AND IS CALLED AT MOST ONCE, only when the payload turned out to carry
 * no bundle frames of its own. Capturing a stack is the expensive part of this function and the
 * overwhelming majority of errors do not need it, so the cost is paid by the reports that would
 * otherwise have had no location at all. `errorLog.ts` supplies it; a direct caller (the tests,
 * and nothing else) may leave it out, in which case step 2 above simply does not happen.
 *
 * IT RETURNS THE BUDGET'S VERDICT (JOS-197). The per-fingerprint session cap is the OUTER gate over
 * every reporting path, and two of those paths — the errors.log line and the dev stdout line —
 * belong to `logError`. The fingerprint is known only here, so the decision is taken here and
 * handed back rather than computed a second time on the app's error path.
 *
 * THE TWO FAIL-OPEN CASES ARE NAMED RATHER THAN IMPLIED, and both stay bounded downstream by
 * `errorRepeat`'s five identical lines: the `errorLog` self-report refusal and the `catch`. Neither
 * computes a fingerprint, so neither has anything to budget — and neither can be the shape this
 * ticket is about, which had a fingerprint and is how the store counted it to seven million.
 */
export function noteError(
  source: string,
  payload: unknown,
  now = Date.now(),
  captureSite?: () => string
): BudgetVerdict {
  try {
    // A failure INSIDE the error-log writer must not mint a report about the error-log writer,
    // on the path that is already failing to write. `errorLog.ts` tags that line `[errorLog]`.
    if (source.includes('errorLog')) return UNBUDGETED
    const f = caughtFields(payload)
    const where = locate(f.stack, captureSite)
    const errorName = errorNameOf(f.name)
    // THE BELT (JOS-418). A capture site that states nothing used to file the literal text
    // `Error: ` — three such families were live in the fleet when this was written, and the two
    // that mattered were fixed at their sites, which is where a SPECIFIC answer can come from.
    // This is what stops the NEXT one: a message that is empty after the site did its best is
    // stamped with the app's own name for that site instead of being sent blank.
    //
    // IT CANNOT MOVE A FINGERPRINT THAT ALREADY EXISTS, and that is provable rather than hoped
    // for: `errorFingerprint` reads `fallback` ONLY when `frames` is empty, and every report in
    // this app has frames — `errorLog` hands over a capture site precisely so that the frameless
    // ones are not all one row. Where there genuinely are none, the stamp is what the fallback
    // folds in, and two blank reports from two different sites stop being one row. That is the
    // same repair JOS-111 made with `messageSkeleton`, applied to the case where there is no
    // skeleton either because there was no message.
    const redactedMessage = stampedMessage(redactMessage(f.message), source)
    // The fallback is read only when `where.frames` is empty (errorFingerprint says why), so a
    // report that HAS frames hashes exactly what it hashed before this ticket and keeps the
    // identity the error store already knows it by.
    const fingerprint = errorFingerprint(
      errorName,
      where.frames,
      fingerprintFallback(where.external, redactedMessage)
    )
    // THE HARD CAP (JOS-197), asked BEFORE anything is recorded and before the storm bound below,
    // so that a fingerprint the exemplar ring had no room for is budgeted all the same — its
    // occurrences still reach errors.log, and they still have to stop.
    const budget = errorBudget(fingerprint)
    if (!budget.report) return budget
    const held = pending.get(fingerprint)
    if (held) {
      held.n += 1
      return budget
    }
    // THE STORM BOUND. A session that has already produced this many DISTINCT issues is a
    // session where something is badly wrong, and the twenty-first fingerprint is not the one
    // that explains it. Repeats of a fingerprint already held still count (the branch above),
    // so the cap limits distinct exemplars and never the totals of what is already tracked.
    if (pending.size >= MAX_SESSION_FINGERPRINTS) return budget
    pending.set(fingerprint, {
      exemplar: exemplarOf({ errorName, redactedMessage, fingerprint }, where, f, now),
      n: 1
    })
    return budget
  } catch {
    // A telemetry producer is never worth an app failure, and this one runs on the error path.
    return UNBUDGETED
  }
}

/** The three values `noteError` has already computed and would otherwise pass one by one — the
 *  parameter that keeps `exemplarOf` inside the repo's four. */
interface Identity {
  errorName: string
  redactedMessage: string
  fingerprint: string
}

/**
 * THE EXEMPLAR. Every OPTIONAL field is set only when it has something to say, which is the wire
 * contract read from the producer's side: a field that is absent costs an older server nothing,
 * and a field that is present is one the reader can trust to mean something.
 */
function exemplarOf(
  id: Identity,
  where: Location,
  f: CaughtFields,
  now: number
): Omit<EvErrorReport, 'count'> {
  const exemplar: Omit<EvErrorReport, 'count'> = {
    t: 'errorReport',
    errorName: id.errorName,
    redactedMessage: id.redactedMessage,
    frames: where.frames,
    fingerprint: id.fingerprint,
    breadcrumbs: wireCrumbs(),
    view: currentView,
    sessionAgeBucket: bucketOf(sessionAgeMs(now), SESSION_AGE_MS_EDGES),
    mode: currentMode()
  }
  const code = errorCodeOf(f.code)
  if (code !== undefined) exemplar.code = code
  // Stated whenever there are frames to describe. A report with none says nothing about their
  // origin rather than claiming one, which is also what an exemplar from an older client means.
  if (where.frames.length > 0) exemplar.frameOrigin = where.origin
  if (where.external.length > 0) exemplar.externalFrames = where.external
  // BOTH CARRIERS, because the ErrorBoundary reports itself twice by design: over the `error:report`
  // IPC, where the marked component stack is appended to `stack`, and through `console.error`,
  // where the console forwarder's payload has no `stack` field at all and the whole line arrives
  // as `message`. Same marker, same parser, so neither path is the one that quietly does not work.
  const componentPath = parseComponentPath(f.stack) ?? parseComponentPath(f.message)
  if (componentPath !== undefined) exemplar.componentPath = componentPath
  return exemplar
}

function sessionAgeMs(now: number): number {
  return sessionStartedAt === 0 ? 0 : Math.max(0, now - sessionStartedAt)
}

/**
 * Drain the reports for one session report. Returns one event per fingerprint that has fired
 * SINCE THE LAST DRAIN, with its accumulated count; the exemplar stays behind so a later
 * recurrence re-sends the same stack (the server's UPSERT is first-wins, so that is free).
 *
 * A fingerprint with nothing pending yields NOTHING — unlike `takeHealth`, which always
 * reports. The difference is deliberate and is the same reasoning read from the other side:
 * `healthCounters` is written even when zero BECAUSE the report itself is the per-version
 * "this build can report" signal, and `healthReports` is the denominator every rate is divided
 * by. That denominator already exists, so an empty errorReport would add a record to the ring
 * every ten minutes to say nothing that `healthReports` does not already say.
 */
export function takeErrorReports(): EvErrorReport[] {
  const out: EvErrorReport[] = []
  for (const held of pending.values()) {
    if (held.n <= 0) continue
    out.push({ ...held.exemplar, count: held.n })
    held.n = 0
  }
  return out
}

/**
 * Drop everything, including the breadcrumb ring. Called from the collector's session
 * boundaries beside `resetHealth()` — a switch turned off must not leave a session's errors
 * waiting to be reported if it is turned back on, and the crumbs that would have travelled with
 * them are the same data.
 *
 * THE BUDGET RESETS WITH THEM (JOS-197), because this is what a SESSION boundary means in this
 * process and the cap is per session. It also means the two can never drift: there is no path that
 * starts a fresh session's exemplars while the previous session's spend is still holding a
 * fingerprint silent.
 *
 * `keepPending` IS THE ONE EXCEPTION, AND IT BELONGS TO THE CALLER (JOS-272 — the header's last
 * section argues it). The FIRST session of a process inherits whatever was filed before it existed,
 * because module-scope errors have nowhere else to go and were previously dropped here. Every other
 * boundary — a later session, a switch turned off, a switch turned back on — clears, exactly as it
 * always did. This function does not decide which it is: `collector.ts` counts the sessions, and a
 * flag passed in is a flag a test can drive without owning a hidden latch.
 */
export function resetErrorReports(now = Date.now(), keepPending = false): void {
  if (!keepPending) pending.clear()
  sessionStartedAt = now
  currentView = 'unknown'
  resetErrorBudget()
  resetBreadcrumbs()
}

/** The undrained reports, for tests and for nothing else. Never sent. */
export function peekErrorReports(): { fingerprint: string; n: number }[] {
  return [...pending.entries()].map(([fingerprint, held]) => ({ fingerprint, n: held.n }))
}
