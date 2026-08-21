// ============================================================================
// packInstall.ts — a failed sound-pack install finally says WHY (JOS-307).
// ============================================================================
//
// THE READING THIS FILE EXISTS FOR. The `install-failed` family in the fleet's error store is the
// single largest non-presence cluster the updater ticket's triage turned up, and it is not the
// auto-updater at all — it is the sound-pack registry:
//
//   6e42033dce2bdd33  0.25.0  x26   Error: install <str> failed
//   ed2cfb95cdc785ab  0.26.0  x21   Error: install <str> failed
//   ed…, a44e…, a318…, 7fab…, 0778…, 4934…  the same message on six more builds
//
// EVERY ONE OF THOSE ROWS IS THE SAME SENTENCE, AND THE SENTENCE SAYS NOTHING. `ipc/sounds.ts`
// filed `{ message: "install '<name>' failed", err }`, and `caughtFields`
// (shared/errorReportLocation.ts) has a rule that is right in general and wrong here: THE OUTER
// LAYER WINS EVERY FIELD IT HAS. So the wrapper's message is what reached the store and the nested
// cause's message — the only part that differs between a 404, a rate limit, a truncated tarball
// and a pack with no audio in it — was dropped on the floor. Sixty-odd occurrences across eight
// builds, and not one of them says which.
//
// THE STACK IS WHAT IDENTIFIED THEM, since the message could not: every exemplar's single in-bundle
// frame is `ClientRequest.<anonymous>`, under `parserOnIncomingClient` — the RESPONSE callback of
// `packRegistry.ts httpGetBuffer`. That is the release-tarball GET answering with a status we
// refuse, not a socket that never connected. So these are answers, and an answer has a number.
//
// ---------------------------------------------------------------------------------------
// WHAT IS RETRIED, AND WHY THE DEFAULT IS "NO"
// ---------------------------------------------------------------------------------------
// The registry browser's install path had NO retry at all (provisionPacks.ts has had one since it
// was written — the asymmetry is the bug). A retry is added here, and the predicate defaults to
// NOT transient: a failure we do not recognize is attempted ONCE. That direction is deliberate and
// is the opposite of the classifier's in shared/update.ts, because the two are answering different
// questions — an unknown FAILURE should be reported (report what you do not understand), but an
// unknown failure should not be RE-REQUESTED (a pack that is gone is gone, and three requests
// prove it no better than one while costing a stranger's bandwidth three times over).
//
// ---------------------------------------------------------------------------------------
// A 429 IS "LATER", NOT "BROKEN" (JOS-420)
// ---------------------------------------------------------------------------------------
// The retry above was right about WHICH failures to re-request and wrong about WHEN. 429 was in the
// transient set from the day it was written, and the schedule it inherited was three attempts at
// 1.5s and 3s — 4.5 seconds of "backoff" against a rate limiter whose window is minutes. The fleet
// says exactly that: fingerprint 60f5821abd26c594, `install <pack> failed (attempt 3/3, http 429)`,
// 26 occurrences on 1.4.0 and one on 1.5.0 — every one of them a user who watched three requests
// bounce off the same closed door inside five seconds and got a generic failure for it.
//
// So a rate limit gets its own everything, and each half is a separate claim:
//
//   * ITS OWN CLOCK. `Retry-After` when the server sent one — it is the only party that knows when
//     the window reopens, and guessing over the top of an explicit number is just being wrong on
//     purpose. Absent, an EQUAL-JITTER backoff (uniform in [ceiling/2, ceiling), ceiling doubling
//     from 30s to a 4-minute cap) — the same shape `telemetry/schedule.ts retryDelayMs` uses and
//     for the same reason: a fleet that all got 429 in the same second must not all come back in
//     the same second.
//   * ITS OWN BUDGET. Six attempts spread over a 15-minute horizon, and the horizon is the real
//     bound — a `Retry-After` longer than what is left of it gives up NOW rather than parking a
//     download for an hour.
//   * ITS OWN KIND, so the reporting can put it where it belongs. `rate-limited` is not `http`:
//     see `packInstallLog.ts` for why a 429 is a console warn where a 404 is a filed report.
//   * ITS OWN SENTENCE. Out of budget, the user is told the thing that is actually true — the
//     server is busy, the pack is fine, click again in a few minutes — and nothing is left
//     half-installed to click through (installPack stages into `<pack>.installing` and swaps, so
//     "resumable" here means the next click starts clean and costs nothing but the download).
//
// Everything this file is pure so `tests/packInstallRetry.test.mts` can drive the real rule with
// no Electron and no network in the process — the same technique updateLog.ts is written for. That
// now includes the retry LOOP itself (`runPackInstallAttempts`): the install, the sleep and the
// randomness are handed in, so a test states a minutes-long schedule without waiting a minute.

import { isUnreachableFailure } from './update'

/** A source of randomness, injected everywhere it is used so a schedule is reproducible in a test. */
export type Rand = () => number

/** Attempts a user-initiated install gets, INCLUDING the first. Matches provisionPacks' own
 *  `MAX_ATTEMPTS`, which is the number this path should have had all along. */
export const MAX_INSTALL_ATTEMPTS = 3

/** First backoff between install attempts; doubles per retry. Shorter than provisioning's 2s
 *  because a person is watching this one — provisioning is invisible by design and can afford
 *  to be politer. */
export const INSTALL_RETRY_BASE_MS = 1_500

/** No store row, no console line and no chip caption carries a stack or a headers dump. */
export const MAX_INSTALL_MESSAGE_CHARS = 200

/** Attempts a RATE-LIMITED install gets. More than the general budget because the thing being
 *  waited out is a window that reopens, not a resource that is gone. */
export const MAX_RATE_LIMITED_ATTEMPTS = 6

/** Ceiling of the FIRST rate-limit wait; doubles per retry up to `RATE_LIMIT_MAX_DELAY_MS`. Thirty
 *  seconds because a rate limiter's window is measured in minutes and 1.5s is not a wait. */
export const RATE_LIMIT_BASE_MS = 30_000

/** Ceiling of any single rate-limit wait we schedule ourselves. An explicit `Retry-After` is
 *  honoured past this — the server knows and we do not. */
export const RATE_LIMIT_MAX_DELAY_MS = 4 * 60_000

/** Total time one install may spend WAITING on rate limits before it gives up and says so. The
 *  real bound on the whole thing: attempts run out or this does, whichever comes first. */
export const RATE_LIMIT_BUDGET_MS = 15 * 60_000

/** A wait is never scheduled shorter than this — a `Retry-After: 0` is still a "not yet". */
export const MIN_RATE_LIMIT_DELAY_MS = 1_000

/** What a user is told when the budget ran out. The pack is FINE, and the sentence says so before
 *  it says anything else — this is the one place the old generic "install failed" did real harm. */
export const RATE_LIMITED_MESSAGE =
  'Rate limited by the download host - the pack is fine, nothing was changed. Try again in a few minutes.'

/** Which kind of failure an install hit. `rejected` is OUR OWN refusal — the archive was the
 *  wrong shape, the name was not installable, the conversion produced nothing. `rate-limited` is
 *  split out of `http` on purpose (JOS-420): it is the only status that is a statement about the
 *  CLOCK rather than about the pack or this machine. */
export type PackInstallFailureKind =
  | 'http'
  | 'rate-limited'
  | 'unreachable'
  | 'truncated'
  | 'rejected'
  | 'other'

/**
 * OUR OWN REFUSALS, matched on the sentences `packRegistry.ts` itself throws. A list rather than a
 * pattern, and each entry is a literal from that file — if one is reworded this stops matching and
 * the failure classes as 'other', which is reported and never retried. Failing that way round is
 * the point: the cost of a stale entry is a less precise word in a log line, never a swallowed
 * failure or a retry storm.
 */
const REJECTION_MESSAGES = [
  'pack name is not a valid identifier',
  'pack source fields are not valid',
  'is reserved for your imported sounds',
  'archive contained no files',
  'unsafe archive path',
  'pack has no openpeon.json',
  'pack contained no audio files',
  'openpeon.json is not valid JSON',
  'no sounds after conversion',
  'download exceeded size cap',
  'too many redirects'
] as const

/**
 * A DOWNLOAD THAT ARRIVED BROKEN. zlib's words for a truncated/garbled gzip body plus the stream
 * errors Node prints when a connection dies mid-body. All of these are worth exactly one more
 * attempt: the bytes were wrong, and the next set of bytes may not be.
 */
const TRUNCATED_RE =
  /incorrect header check|unexpected end of file|invalid distance|invalid block type|Z_BUF_ERROR|Z_DATA_ERROR|premature close|socket hang up|\baborted\b|ERR_STREAM_PREMATURE_CLOSE/i

/** `err.message` when there is one, else the value stringified. */
function failureText(err: unknown): string {
  return String((err as { message?: unknown } | null | undefined)?.message ?? err)
}

/**
 * The HTTP status behind an install failure, or null.
 *
 * `statusCode` first — `packRegistry.ts httpGetBuffer` hangs it off the error it throws for exactly
 * this reader. The `→ <status>` arm is the same fact read back out of the SENTENCE, which is what
 * survives when the error has been through a log line and lost its properties; `HTTP_ERROR_<n>` is
 * builder-util-runtime's spelling and is here so one reader covers both downloaders.
 */
export function packInstallHttpStatus(err: unknown): number | null {
  const direct = (err as { statusCode?: unknown } | null | undefined)?.statusCode
  if (typeof direct === 'number' && Number.isInteger(direct) && direct >= 400 && direct <= 599) {
    return direct
  }
  const text = failureText(err)
  const m = /→\s*(\d{3})\b/.exec(text) ?? /\bHTTP_ERROR_(\d{3})\b/.exec(text)
  if (m === null) return null
  const status = Number(m[1])
  return status >= 400 && status <= 599 ? status : null
}

/**
 * WHEN THE SERVER SAID TO COME BACK, in ms from `nowMs`, or null when it did not say.
 *
 * RFC 9110 spells `Retry-After` two ways and both are in the wild: delta-seconds (GitHub's) and an
 * HTTP-date (some CDNs). A value we cannot read is null rather than zero — "unparseable" must fall
 * through to our own backoff, never to "retry immediately", which is the exact behaviour the header
 * exists to prevent. A date already in the past clamps to 0 (the window has reopened).
 */
export function parseRetryAfterMs(value: unknown, nowMs: number): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value * 1_000 : null
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length === 0) return null
  if (/^\d+$/.test(text)) {
    const secs = Number(text)
    return Number.isFinite(secs) ? secs * 1_000 : null
  }
  const at = Date.parse(text)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - nowMs)
}

/**
 * THE ERROR A REFUSED RESPONSE BECOMES, built where the readers live.
 *
 * `statusCode` and `retryAfterMs` are not decoration: every decision below is made from one or the
 * other, and both exist only at the response. The SENTENCE carries the status too, as the fallback
 * for a copy that lost its properties in a log line — but a property is what code in this process
 * should be reading, and the constructor lives here so a second downloader cannot spell it
 * differently (`speech/provision.ts` is the second one).
 */
export function packInstallHttpError(
  url: string,
  status: number,
  retryAfterHeader?: unknown,
  nowMs: number = Date.now()
): Error {
  return Object.assign(new Error(`GET ${url} → ${String(status)}`), {
    statusCode: status,
    retryAfterMs: parseRetryAfterMs(retryAfterHeader, nowMs)
  })
}

/** The `Retry-After` the failure is carrying, in ms, or null. `packInstallHttpError` hangs it off
 *  the error — parsed at the response, where the header still exists. */
export function packInstallRetryAfterMs(err: unknown): number | null {
  const raw = (err as { retryAfterMs?: unknown } | null | undefined)?.retryAfterMs
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null
}

/** Which of the six kinds this failure is. Our own refusals are asked FIRST: they are the only
 *  ones whose text we wrote, so nothing else may claim them. */
export function classifyPackInstallFailure(err: unknown): PackInstallFailureKind {
  if (err == null) return 'other'
  const text = failureText(err)
  if (REJECTION_MESSAGES.some((m) => text.includes(m))) return 'rejected'
  if (packInstallHttpStatus(err) === 429) return 'rate-limited'
  if (packInstallHttpStatus(err) !== null) return 'http'
  if (isUnreachableFailure(err)) return 'unreachable'
  if (TRUNCATED_RE.test(text)) return 'truncated'
  return 'other'
}

/**
 * Is another attempt worth making? See the header for why the default is NO.
 *
 * A 4xx is an answer about the pack — 404 (the tag is gone), 403 (the repo went private) — and a
 * second identical request cannot change it. The two exceptions are the two 4xx that are about
 * TIMING rather than the resource: 408 and 429.
 */
export function isTransientPackInstallFailure(err: unknown): boolean {
  switch (classifyPackInstallFailure(err)) {
    // A 429 is the most retryable answer there is — it is the server saying "ask again" in as many
    // words. What it is NOT is retryable on the general schedule; see `rateLimitDelayMs`.
    case 'unreachable':
    case 'truncated':
    case 'rate-limited':
      return true
    case 'http': {
      const status = packInstallHttpStatus(err) ?? 0
      return status === 408 || status >= 500
    }
    default:
      return false
  }
}

/** Is this failure the server telling us to slow down? */
export function isRateLimitedPackInstall(err: unknown): boolean {
  return classifyPackInstallFailure(err) === 'rate-limited'
}

/** How long to wait before attempt `attempt` (1-based: the delay BEFORE attempt 2 is the base).
 *  The GENERAL schedule — a rate limit does not use it (`rateLimitDelayMs`). */
export function packInstallRetryDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt))
  return INSTALL_RETRY_BASE_MS * 2 ** (n - 1)
}

/**
 * How long to wait after a 429.
 *
 * `Retry-After` WINS WHEN IT EXISTS, at whatever length it names (clamped up to
 * `MIN_RATE_LIMIT_DELAY_MS` so a `0` is still a beat, and never down — the server is the only
 * party that knows when its window reopens, and second-guessing it downward is how a client earns
 * a longer ban). Whether we can AFFORD the wait is a separate question, asked by
 * `planPackInstallRetry` against the budget.
 *
 * Absent, EQUAL JITTER: uniform in [ceiling/2, ceiling) where the ceiling doubles from
 * `RATE_LIMIT_BASE_MS` up to `RATE_LIMIT_MAX_DELAY_MS`. Half the window is guaranteed wait (a rate
 * limiter answered — coming back in a hundred milliseconds is not a retry, it is the same request)
 * and half is spread, which is what keeps a fleet that hit the limit together from returning
 * together. `telemetry/schedule.ts retryDelayMs` argues the same herd point at length.
 */
export function rateLimitDelayMs(
  attempt: number,
  opts?: { readonly retryAfterMs?: number | null; readonly random?: Rand }
): number {
  const explicit = opts?.retryAfterMs
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    return Math.max(MIN_RATE_LIMIT_DELAY_MS, Math.round(explicit))
  }
  const n = Math.max(1, Math.floor(attempt))
  const ceiling = Math.min(RATE_LIMIT_BASE_MS * 2 ** (n - 1), RATE_LIMIT_MAX_DELAY_MS)
  const rand = opts?.random ?? Math.random
  return Math.max(MIN_RATE_LIMIT_DELAY_MS, Math.floor(ceiling / 2 + rand() * (ceiling / 2)))
}

/** What one failure buys: another attempt after `delayMs`, or the end of the run. `attempts` is the
 *  budget this failure is measured against — which a 429 WIDENS, and never narrows. */
export interface PackInstallRetryPlan {
  readonly retry: boolean
  readonly delayMs: number
  readonly attempts: number
  readonly rateLimited: boolean
  /** Why the run stopped, for the caller's sentence. Absent when `retry` is true. */
  readonly stop?: 'not-transient' | 'attempts' | 'budget'
}

/**
 * THE WHOLE RETRY DECISION, as a pure function of the failure and what has been spent so far.
 *
 * The budget only ever GROWS: once a run has seen a 429 its attempt budget is the rate-limited one
 * for the rest of the run, so an install that was rate limited three times and then hit a dropped
 * socket does not suddenly read `attempt 4/3`. `waitedMs` is the sum of the delays already slept —
 * a clock is deliberately not consulted, so a fake sleep and a real one plan identically.
 */
export function planPackInstallRetry(opts: {
  readonly err: unknown
  readonly attempt: number
  readonly waitedMs: number
  /** The budget so far — `MAX_INSTALL_ATTEMPTS` unless a caller or an earlier 429 widened it. */
  readonly attempts: number
  readonly random?: Rand
}): PackInstallRetryPlan {
  const rateLimited = isRateLimitedPackInstall(opts.err)
  const attempts = rateLimited ? Math.max(opts.attempts, MAX_RATE_LIMITED_ATTEMPTS) : opts.attempts
  const stopped = (stop: PackInstallRetryPlan['stop']): PackInstallRetryPlan => ({
    retry: false,
    delayMs: 0,
    attempts,
    rateLimited,
    stop
  })
  if (!isTransientPackInstallFailure(opts.err)) return stopped('not-transient')
  if (opts.attempt >= attempts) return stopped('attempts')
  if (!rateLimited) {
    return { retry: true, delayMs: packInstallRetryDelayMs(opts.attempt), attempts, rateLimited }
  }
  const delayMs = rateLimitDelayMs(opts.attempt, {
    retryAfterMs: packInstallRetryAfterMs(opts.err),
    random: opts.random
  })
  // THE HORIZON IS THE REAL BOUND. A `Retry-After: 3600` is honest and unaffordable: parking a
  // click for an hour is not "installing", so the run ends here and says the true thing instead.
  if (opts.waitedMs + delayMs > RATE_LIMIT_BUDGET_MS) return stopped('budget')
  return { retry: true, delayMs, attempts, rateLimited }
}

/** The cause, as ONE bounded line. The full object still reaches errors.log through the nested
 *  error; this is the headline the store row and the console get. */
export function describePackInstallFailure(err: unknown): string {
  if (err == null) return 'unknown error'
  const oneLine = failureText(err).split('\n')[0].trim()
  if (oneLine.length === 0) return 'unknown error'
  return oneLine.length > MAX_INSTALL_MESSAGE_CHARS
    ? `${oneLine.slice(0, MAX_INSTALL_MESSAGE_CHARS - 1).trimEnd()}…`
    : oneLine
}

/**
 * THE LINE THE STORE ROW READS, and every word of it is a fact the old one lacked: which pack,
 * which attempt of how many, which class (with the status when there is one) — and then the CAUSE,
 * which is the whole ticket.
 *
 *   install 'alan-rickman' failed (attempt 3/3, http 404): GET https://github.com/… → 404
 */
export function packInstallFailureLine(
  name: string,
  attempt: number,
  attempts: number,
  err: unknown
): string {
  const kind = classifyPackInstallFailure(err)
  const status = packInstallHttpStatus(err)
  const klass =
    kind === 'rate-limited'
      ? `rate limited (http ${String(status ?? 429)})`
      : kind === 'http' && status !== null
        ? `http ${String(status)}`
        : kind
  return (
    `install '${name}' failed (attempt ${String(attempt)}/${String(attempts)}, ${klass}): ` +
    describePackInstallFailure(err)
  )
}

/**
 * WHAT THE PERSON WHO CLICKED INSTALL READS. Everywhere else in this file is written for whoever
 * reads the logs; this one sentence is for the user, and for a rate limit the honest sentence and
 * the raw one point in opposite directions — `GET https://github.com/… → 429` reads as "your pack
 * is broken" and the truth is "the host is busy, click again shortly".
 */
export function packInstallUserMessage(err: unknown): string {
  if (isRateLimitedPackInstall(err)) return RATE_LIMITED_MESSAGE
  return describePackInstallFailure(err)
}

// ---------------------------------------------------------------------------------------
// THE LOOP (pure, so the schedule is testable without living through it)
// ---------------------------------------------------------------------------------------

/** What an install run produced. `error` is the user-facing cause of the FINAL attempt. */
export interface PackInstallRunResult {
  readonly ok: boolean
  readonly error?: string
  /** How many attempts were actually made (1 when the first succeeded or was not worth retrying). */
  readonly attempts: number
  /** True when the run ended against a rate limit — the caller's cue that this is a "later", and
   *  that the row should read as retryable rather than as a broken pack. */
  readonly rateLimited?: boolean
}

/** One failed attempt, as the caller is told about it. `final` false means a retry is scheduled in
 *  `delayMs`; `attempts` is the budget as it now stands (a 429 widens it). */
export interface PackInstallAttemptFailure {
  readonly attempt: number
  readonly attempts: number
  readonly final: boolean
  readonly delayMs: number
  readonly rateLimited: boolean
  readonly err: unknown
}

/** Everything the loop needs from the outside world, handed in. */
export interface PackInstallAttemptDeps {
  /** One attempt. Rejects to fail it. */
  readonly install: () => Promise<void>
  readonly sleep: (ms: number) => Promise<void>
  /** Called for EVERY failed attempt, retried or not — the log line and the UI both hang off it. */
  readonly onFailure?: (info: PackInstallAttemptFailure) => void
  /** Starting attempt budget. A 429 widens it; nothing narrows it. */
  readonly attempts?: number
  readonly random?: Rand
}

/**
 * Run one install to a verdict: attempt, classify, wait, repeat — the policy above and no I/O of
 * its own. `packInstallRun.ts` supplies the real install/sleep/log; the tests supply fakes and
 * state a fifteen-minute schedule in a millisecond.
 */
export async function runPackInstallAttempts(
  deps: PackInstallAttemptDeps
): Promise<PackInstallRunResult> {
  let attempts = Math.max(1, deps.attempts ?? MAX_INSTALL_ATTEMPTS)
  let waitedMs = 0
  for (let attempt = 1; ; attempt++) {
    try {
      await deps.install()
      return { ok: true, attempts: attempt }
    } catch (err) {
      const plan = planPackInstallRetry({ err, attempt, waitedMs, attempts, random: deps.random })
      attempts = plan.attempts
      deps.onFailure?.({
        attempt,
        attempts,
        final: !plan.retry,
        delayMs: plan.delayMs,
        rateLimited: plan.rateLimited,
        err
      })
      if (!plan.retry) {
        return {
          ok: false,
          error: packInstallUserMessage(err),
          attempts: attempt,
          rateLimited: plan.rateLimited
        }
      }
      waitedMs += plan.delayMs
      await deps.sleep(plan.delayMs)
    }
  }
}
