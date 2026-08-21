// update.ts — the PURE half of auto-update (Task #60).
//
// Everything here is side-effect free so it can be unit-tested without Electron:
// the polling cadence (interval + jitter + failure backoff), semver-ish version
// comparison (the "we already got updated away from that build" guard), and the
// status -> UI-state mapping the left-nav chip and Preferences both render from.
//
// The effectful half (electron-updater wiring, IPC, persistence) lives in
// src/main/updater.ts; the chip lives in components/UpdateChip.tsx.

import type { UpdateStatus } from './types'

// ---------------------------------------------------------------- cadence
//
// "Somewhat infrequently" (user's word). The old cadence was +10s then every
// 30 min — 48 feed hits per day per install, for a desktop app whose releases
// land a few times a week at most. That is pure noise against GitHub's
// unauthenticated rate limit and buys nothing: an update the user learns about
// 3 hours late still installs itself the next time they quit.
//
//   startup  : ~45s after launch, + up to 30s of jitter.
//              10s was inside the startup log replay (~6s of `hydrating` on the
//              real log, plus window paint + sound-pack provisioning). 45s puts
//              the check in idle time, where it belongs.
//   periodic : every 4 h, +/- 25% jitter -> a real spacing of 3 h - 5 h.
//              Jitter matters because every install of a hobby app tends to be
//              launched at the same time of day (raid night); a fixed interval
//              turns that into a synchronized burst on one GitHub repo. Six
//              checks a day is still far more than the release rate.
//   failure  : exponential backoff from 15 min, doubling, CAPPED AT the normal
//              interval — so a flaky network retries sooner than 4 h, and a
//              hard outage (or a rate-limit wall) decays to the normal cadence
//              instead of hammering. Jitter applies to backoff too.
//
// Manual "Check for updates" in Preferences always bypasses all of this.

//   resume   : ~20s after the machine WAKES (JOS-307). A suspend freezes this process mid-poll,
//              and whatever was left of a 4h timer is what the user comes back to — so a laptop
//              that sleeps on the 3h55m mark can go a whole working day without a check while its
//              chip cheerfully reports an age. Waking RE-ANCHORS the cadence instead of counting
//              the sleep as a failure. Short, because the machine is demonstrably awake and the
//              radio is the only thing still settling; jittered, because every install of a hobby
//              app wakes at about the same time of day for exactly the reason the periodic jitter
//              exists.

/** Delay from launch to the FIRST check. */
export const STARTUP_DELAY_MS = 45_000
/** Delay from a machine WAKING to the re-anchored check (JOS-307). */
export const RESUME_DELAY_MS = 20_000
/** Extra uniform jitter [0, n) added to the resume delay. */
export const RESUME_JITTER_MS = 20_000
/** Extra uniform jitter [0, n) added to the startup delay. */
export const STARTUP_JITTER_MS = 30_000
/** Base spacing between background checks. */
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
/** Fractional jitter applied to every periodic/backoff delay: +/- 25%. */
export const JITTER_FRACTION = 0.25
/** First retry delay after a failed check; doubles per consecutive failure. */
export const BACKOFF_BASE_MS = 15 * 60 * 1000
/**
 * How many times we let autoDownload re-attempt the SAME version before we stop
 * pulling it automatically. Prevents an unbounded download loop against a
 * corrupt asset / a proxy that truncates; the user can still retry by hand.
 */
export const MAX_DOWNLOAD_ATTEMPTS = 3

/** Apply +/- JITTER_FRACTION to `ms`. `rand` is injectable so tests are deterministic. */
function jitter(ms: number, rand: () => number): number {
  const span = ms * JITTER_FRACTION
  return Math.round(ms - span + rand() * span * 2)
}

/**
 * How long to wait before the next background check.
 *
 * `consecutiveFailures` counts checks that ended in an error since the last
 * successful one (0 = healthy). The returned delay is always > 0 and never
 * exceeds CHECK_INTERVAL_MS * (1 + JITTER_FRACTION).
 */
export function nextCheckDelayMs(
  opts: { phase: 'startup' | 'periodic' | 'resume'; consecutiveFailures?: number },
  rand: () => number = Math.random
): number {
  if (opts.phase === 'startup') return STARTUP_DELAY_MS + Math.round(rand() * STARTUP_JITTER_MS)
  // A WAKE IGNORES THE BACKOFF ON PURPOSE (JOS-307). The failures that walked the backoff out were
  // made by a machine that is no longer the machine we have: the radio has been re-associated and
  // the very error that got us here (`ERR_NETWORK_IO_SUSPENDED`) is a statement about the suspend,
  // not about the feed. One short check settles it; if the feed really is unhappy, that check
  // fails and the backoff re-forms from `consecutiveFailures`, which this branch never resets.
  if (opts.phase === 'resume') return RESUME_DELAY_MS + Math.round(rand() * RESUME_JITTER_MS)
  const fails = Math.max(0, Math.floor(opts.consecutiveFailures ?? 0))
  if (fails === 0) return jitter(CHECK_INTERVAL_MS, rand)
  // 15m, 30m, 1h, 2h, 4h, 4h, ... — capped at the healthy interval.
  const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (fails - 1), CHECK_INTERVAL_MS)
  return jitter(backoff, rand)
}

// ----------------------------------------------------- feed failure messages
//
// JOS-211. A 0.18.0 user pressed "Check for updates" and the app answered
// `Unexpected end of JSON input`. That sentence is not ours and it is not about
// updates: it is a bare `SyntaxError` from `JSON.parse`, escaping THREE layers
// down, with nothing left of the HTTP request that produced it.
//
// WHERE IT COMES FROM (read out of the installed builder-util-runtime@6.x /
// electron-updater@6.8.9, not the docs). One check is three plain github.com
// GETs (updater.ts research §5). Every one of them lands in
// `HttpExecutor.handleResponse` (builder-util-runtime/out/httpExecutor.js), whose
// response-end handler is:
//
//     if (statusCode >= 400) {
//       const isJson = contentType != null && contentType.includes("json")
//       reject(createHttpError(response, `… Data: ${isJson ? safeStringifyJson(JSON.parse(data)) : data}`))
//     }
//
// The `JSON.parse(data)` there runs while FORMATTING the error, inside the same
// try whose `catch (e) { reject(e) }` is the only handler — so on a >= 400
// response that ADVERTISES json and carries an empty or truncated body, the
// SyntaxError REPLACES the HttpError entirely. The status code, the URL and the
// method are all thrown away, and what reaches us is a parse error about a body
// nobody asked us to parse. (Measured 2026-08-12: `GET
// github.com/<owner>/<repo>/releases/latest` — the second of the three requests —
// answers `content-type: application/json; charset=utf-8`, so its error responses
// take exactly that branch.) Two of the three call sites in `GitHubProvider`
// rethrow whatever they get without wrapping it, which is how it arrives bare.
//
// Everything that can produce an empty/truncated body on a 4xx/5xx is out of our
// hands and TRANSIENT by nature: an abuse-detection 429, an edge node that closes
// the connection mid-body, a captive-portal/proxy error page, a 5xx from a
// deploy. So the policy is: ONE retry, then a sentence that says what happened
// and that it is worth trying again — never the parser's words.
//
// These predicates are here (not in main/updater.ts) so they can be tested with
// the REAL failures: `tests/updateCadence.test.mts` runs `JSON.parse` over an
// empty body, a truncated body and an HTML error page and feeds the thrown error
// straight in, which is precisely what httpExecutor does to us.

/**
 * electron-updater's own codes for "the feed did not parse". Each one wraps the
 * underlying failure into a message that embeds a whole XML feed or a stack
 * trace — readable to nobody, and several kilobytes wide in a caption.
 */
const FEED_PARSE_CODES = new Set([
  // GitHubProvider: `Cannot parse releases feed: <stack>,\nXML:\n<the entire atom feed>`.
  'ERR_UPDATER_INVALID_RELEASE_FEED',
  // Provider.parseUpdateInfo: latest.yml was absent, empty or not YAML.
  'ERR_UPDATER_INVALID_UPDATE_INFO'
])

/** The parser sentences a body can produce, across Node versions (they were reworded in 20+). */
const PARSE_MESSAGE =
  /unexpected end of json input|unexpected token|unexpected non-whitespace|in json at position|unterminated string in json|json\.parse|end of the stream or a document separator/i

/**
 * True when a check failed because the FEED BODY could not be parsed — as opposed
 * to a failure that names something the user might act on (no network, DNS, a
 * 404 with a real status attached).
 *
 * Deliberately message-shaped as well as code-shaped: the bare case carries no
 * code at all (it is a raw `SyntaxError`), and `ERR_UPDATER_LATEST_VERSION_NOT_FOUND`
 * is NOT in the code set because that code also covers a repo with no release —
 * it only counts here when the message it interpolated shows a parse failure
 * inside.
 */
export function isFeedParseError(err: unknown): boolean {
  if (err == null) return false
  const e = err as { code?: unknown; name?: unknown; message?: unknown }
  if (typeof e.code === 'string' && FEED_PARSE_CODES.has(e.code)) return true
  // js-yaml throws YAMLException for a truncated latest.yml; JSON.parse throws SyntaxError.
  if (e.name === 'SyntaxError' || e.name === 'YAMLException') return true
  return typeof e.message === 'string' && PARSE_MESSAGE.test(e.message)
}

/**
 * ONE retry for a malformed/empty feed body, and no more.
 *
 * `attempts` is how many attempts have already FINISHED. The retry is immediate:
 * each attempt is a fresh set of requests, an empty body is a per-response event,
 * and a rate-limit wall that survives the retry falls through to the ordinary
 * exponential backoff (nextCheckDelayMs) rather than being hammered here.
 * Nothing else is retried — a network outage already has the backoff, and
 * retrying a 404 twice as fast helps nobody.
 */
export function shouldRetryCheck(err: unknown, attempts: number): boolean {
  // AND NEVER THE SIGNATURE CHECK'S OWN SyntaxError (JOS-421). It satisfies `isFeedParseError` by
  // name and is not a feed failure at all; an immediate re-check would re-download an installer to
  // hand it to the same PowerShell. It cannot reach this predicate today (it is thrown on the
  // download path, and this gate is asked only for `step === 'check'`), and the guard is here so a
  // future call site cannot make it reachable by accident.
  return attempts < 1 && isFeedParseError(err) && !isSignatureCheckBlocked(err)
}

/** What the user reads when the feed came back unreadable twice. */
export const FEED_PARSE_MESSAGE =
  'The update service sent an unreadable response (an empty or partial reply from GitHub). Nothing is wrong with your install - please try again later.'

/** No caption should carry a multi-kilobyte XML dump or a stack trace. */
export const MAX_UPDATE_MESSAGE_CHARS = 200

/** `err.message` when there is one, else the value itself, stringified. */
function failureText(err: unknown): string {
  return String((err as { message?: unknown } | null | undefined)?.message ?? err)
}

/**
 * The ONE producer of `UpdateStatus.message` (src/main/updater.ts pushes nothing
 * else). A parse failure becomes the sentence above; everything else keeps the
 * text it always had — "getaddrinfo ENOTFOUND github.com" is genuinely useful —
 * but reduced to its FIRST LINE and bounded, because electron-updater's wrapped
 * errors embed stacks and whole feeds.
 */
export function describeUpdateFailure(err: unknown): string {
  if (err == null) return 'unknown error'
  // BEFORE the parse arm, for the same reason the classifier asks it there: the blocked shape IS a
  // `SyntaxError`, and answering it with FEED_PARSE_MESSAGE blames GitHub for this PC's PowerShell.
  if (isSignatureCheckBlocked(err)) return SIGNATURE_BLOCKED_MESSAGE
  if (isFeedParseError(err)) return FEED_PARSE_MESSAGE
  const oneLine = failureText(err).split('\n')[0].trim()
  if (oneLine.length === 0) return 'unknown error'
  return oneLine.length > MAX_UPDATE_MESSAGE_CHARS
    ? `${oneLine.slice(0, MAX_UPDATE_MESSAGE_CHARS - 1).trimEnd()}…`
    : oneLine
}

// ------------------------------------------------- WHAT THE FAILURE WAS (JOS-295)
//
// `describeUpdateFailure` above answers "what does the user read". These answer the OTHER
// question, the one nobody could ask until JOS-295: WHAT KIND OF FAILURE WAS IT, so the main
// process can decide whether it belongs in errors.log (and therefore in the fleet's error store)
// or is somebody else's outage that must not be allowed to file one line per check.
//
// SIX KINDS, AND THE ORDER THEY ARE ASKED IN IS THE DESIGN:
//
//   'interrupted' THE MACHINE MOVED UNDER AN IN-FLIGHT REQUEST (JOS-307). Asked FIRST, because it
//                 is the one kind that is not a failure of anything: Chromium tears down network
//                 IO when the host suspends (`ERR_NETWORK_IO_SUSPENDED`) or when the active
//                 interface changes underneath it (`ERR_NETWORK_CHANGED` — Wi-Fi to Ethernet, a
//                 VPN coming up, a hotspot handover), and whatever was mid-flight rejects. MEASURED,
//                 and it is why this arm exists rather than being imagined: 0.27.0 filed 12 of the
//                 first on its FIRST DAY (fingerprint 36e52c753767490b), every one of them
//                 classified 'other' and therefore reported to the fleet as an unexplained update
//                 failure. Owner ruling 2026-08-14, verbatim: *classify IO-suspended /
//                 network-change as a benign transient: retry on resume, never error-store it*.
//                 The two are one kind because the ANSWER is one answer — wait for the machine to
//                 settle and ask again — even though only the first has a `powerMonitor` event to
//                 hang that on (there is no main-process network-change event in Electron, so the
//                 network case re-anchors on the same short timer and nothing more).
//   'blocked'     THIS PC'S OWN POWERSHELL ANSWERED NOTHING (JOS-421). Asked SECOND, and it has to
//                 be asked before 'parse' because its commonest shape IS a `SyntaxError` — see the
//                 block below, which carries the source read. Same argument as 'interrupted': it is
//                 not a failure of ours, of GitHub's, or of the network's, and the fleet was
//                 reporting ~330 of them as if it were.
//   'http'        GitHub answered, and it answered 4xx/5xx. THE THING THAT MUST ALWAYS LAND.
//                 A 403/429 is a throttle we can act on, a 404 means our feed is wrong, a 5xx is
//                 an outage worth knowing the date of. `HttpError` (builder-util-runtime) carries
//                 `statusCode` and `code = HTTP_ERROR_<status>`; both are read, plus the name, so
//                 a re-thrown or stringified copy still classifies.
//   'parse'       The masked-status bug this ticket came from: on a >= 400 response advertising
//                 json with an empty/truncated body, `JSON.parse` runs inside httpExecutor's ERROR
//                 FORMATTER and its SyntaxError REPLACES the HttpError (see the JOS-211 block
//                 above for the source read). It LANDS, always: it is an HTTP failure whose status
//                 was destroyed, and the only way to learn anything about it is to keep the ones
//                 the fleet produces.
//   'unreachable' The request never got out of the machine: DNS, no route, refused, reset, timed
//                 out - a laptop on a plane, a captive portal, a machine that is simply offline.
//                 BOUNDED (src/main/updateLog.ts): an install that checks all day while offline
//                 would otherwise file an error per check forever, and every one of those lines
//                 says the same thing about the user's network rather than anything about us.
//   'other'       Anything unrecognized. LANDS, because the honest failure direction for a
//                 classifier is to report what it does not understand rather than to swallow it.
//                 A TLS/certificate failure is deliberately in here and not in 'unreachable': a
//                 MITM proxy or an expired root is diagnosable and is not "the network is away".

/** Which of the six kinds a failed check/download was. */
export type UpdateFailureKind =
  | 'interrupted'
  | 'blocked'
  | 'http'
  | 'parse'
  | 'unreachable'
  | 'other'

// ------------------------------------------- A POWERSHELL THAT ANSWERS NOTHING (JOS-421)
//
// THE TOP LINE OF THE WHOLE FLEET'S ERROR STORE, and it is not about this app.
//
//   `SyntaxError: update download failed (final, parse): Unexpected end of JSON input`
//     at parseOut (node_modules/electron-updater/out/windowsExecutableCodeSignatureVerifier.js:104)
//     at <anonymous> (…/windowsExecutableCodeSignatureVerifier.js:55)
//     at ChildProcess.exithandler (node:child_process:410)
//
// ~330 occurrences across every version since 0.28.0, on many installs, plus a smaller cousin
// family reading `update download failed (final, other): Command failed: set "PSModulePath=" &
// chcp 65001 >NUL & powershell.exe -NoProfile …`. Both come from ONE call site.
//
// WHAT THE SOURCE SAYS (read out of the installed electron-updater@6.8.9 —
// windowsExecutableCodeSignatureVerifier.js + NsisUpdater.js, not the docs). After the installer
// is downloaded, `NsisUpdater.doDownloadUpdate` awaits `verifySignature(destinationFile)`, which
// shells out through cmd:
//
//     set "PSModulePath=" & chcp 65001 >NUL & powershell.exe -NoProfile -NonInteractive
//       -InputFormat None -Command "Get-AuthenticodeSignature -LiteralPath '<exe>' | ConvertTo-Json -Compress"
//
// and then, in the `execFile` callback:
//
//     if (error != null || stderr) { handleError(…); resolve(null); return }
//     const data = parseOut(stdout)          // parseOut = JSON.parse(out)
//
// So the reported family is the case where PowerShell EXITED 0 WITH NO STDOUT AND NO STDERR —
// `ChildProcess.exithandler` in the frames is the clean-exit path, and `parseOut` only runs when
// `error == null && !stderr`. `JSON.parse('')` throws, and the catch calls `handleError(logger, e,
// null, reject)` and then `resolve(null)`.
//
// AND `handleError` IS THE TRAP. It probes the environment with a SECOND PowerShell call
// (`execFileSync(… "ConvertTo-Json test")`) and only skips verification when that probe THROWS:
//
//   * PowerShell missing/denied outright ⇒ the probe throws ⇒ warn, return, `resolve(null)` ⇒
//     verification is SKIPPED and the update installs fine.
//   * PowerShell present but answering nothing ⇒ the probe exits 0 too, so it does NOT throw ⇒
//     `reject(error)` runs BEFORE the `resolve(null)` on the line after ⇒ the promise REJECTS.
//
// A rejection there rejects `doDownloadUpdate`, which becomes an `error` event with our
// `downloading` latch set — a FAILED DOWNLOAD. So the answer to "does electron-updater fall
// through?" is NO, and the answer is the wrong way round: the harder PowerShell is blocked, the
// more likely the update succeeds. These installs can never auto-update, they re-download the
// whole installer up to `MAX_DOWNLOAD_ATTEMPTS` times per session, and every attempt wiped the
// pending dir on the way (research §6f in main/updater.ts).
//
// WHAT WE DO ABOUT IT. Nothing in the message names the cause: the user was told "the update
// service sent an unreadable response", which blames GitHub for a local PowerShell. So this
// classifier learns the shape, `describeUpdateFailure` says what actually happened, and
// `main/updateLog.ts` demotes it to a console warn (the 'interrupted'/'unreachable' door) so that
// a real updater regression is visible above it. The per-check `updateOutcome` telemetry is
// untouched and still counts every failed download, which is where a frozen cohort stays
// countable — JOS-310's rule that a demotion needs an honest home for the count.

/**
 * THE MARKERS, and every one of them is a string this call site OWNS.
 *
 * `windowsExecutableCodeSignatureVerifier` and `at parseOut` come from the STACK (the module is
 * externalized, so the real path survives into the report — measured in the error store; the
 * function name is the belt for a future build that bundles it). `powershell.exe` and
 * `Get-AuthenticodeSignature` come from the MESSAGE of the cousin family, whose `Command failed:`
 * text quotes the whole command line, and from `err.cmd`, which `child_process` sets beside it.
 *
 * Nothing else in the update path can produce any of the four: a feed failure is three plain
 * github.com GETs and never shells out.
 */
const SIGNATURE_CHECK_RE =
  /windowsExecutableCodeSignatureVerifier|\bat parseOut\b|powershell\.exe|Get-AuthenticodeSignature/i

/** Message + stack + `cmd`, joined. The commonest shape is a bare `SyntaxError` whose message says
 *  only `Unexpected end of JSON input`, so the STACK is the only thing that identifies it. */
function blockedText(err: unknown): string {
  const e = err as { message?: unknown; stack?: unknown; cmd?: unknown } | null | undefined
  return [e?.message, e?.stack, e?.cmd].filter((v) => typeof v === 'string').join('\n')
}

/**
 * True when the failure came out of electron-updater's PowerShell code-signature check rather than
 * out of the network — i.e. security software, a policy, or a gutted PowerShell on THIS PC.
 */
export function isSignatureCheckBlocked(err: unknown): boolean {
  if (err == null) return false
  return SIGNATURE_CHECK_RE.test(blockedText(err))
}

/** What the user reads while the environment is blocking the verification step. */
export const SIGNATURE_BLOCKED_MESSAGE =
  "Security software on this PC blocked the update's PowerShell signature check, so the new version could not be verified. Nothing is wrong with your install - the next check will try again."

/** …and what they read once the bounded automatic retries are spent for this session. */
export const SIGNATURE_BLOCKED_PAUSED_MESSAGE =
  "Security software on this PC keeps blocking the update's PowerShell signature check. Automatic updates are paused - allow PowerShell, or install the new version by hand."

/**
 * …and the console line, which lives HERE rather than in `main/updateLog.ts` for one reason:
 * `tests/noChildProcess.test.mts` forbids any shipped string literal from naming PowerShell, and
 * keeping every sentence that has to name it in ONE module keeps that guard's exemption to a short
 * list in a single file (its header carries the argument).
 */
export const SIGNATURE_BLOCKED_WARN =
  "security software or policy is blocking this PC's PowerShell signature check - the next check retries, and the user is told"

/**
 * THE INTERRUPTION CODES, and the list is TWO long because two is what the owner named.
 *
 * Both are Chromium's own words for "this request died because the machine moved out from under
 * it", and neither can be produced by anything else: `ERR_NETWORK_IO_SUSPENDED` comes from the
 * network service tearing down for a suspend, `ERR_NETWORK_CHANGED` from the active interface
 * being replaced mid-request.
 *
 * THE AWAITING-SAMPLE LAW APPLIES TO EVERYTHING THAT IS NOT HERE. `ERR_ABORTED` was the obvious
 * third candidate and is deliberately absent: it also covers a request WE cancelled, so a wrong
 * entry would silently stop reporting a real failure. A code that is not in this list falls through
 * to the classifier's other arms and is REPORTED — the honest direction for the cost of forgetting
 * one.
 *
 * `ERR_NETWORK_CHANGED` MOVED HERE OUT OF `UNREACHABLE_ERROR_CODES`, which is the one behavioural
 * change in that reshuffle: it was already never reaching the error store (unreachable is bounded
 * to a console warn), but it was not earning the re-anchored retry, so a laptop that switched from
 * Wi-Fi to a dock could sit out the rest of a four-hour timer over an event that resolved in two
 * seconds.
 */
export const INTERRUPTED_ERROR_CODES = ['ERR_NETWORK_IO_SUSPENDED', 'ERR_NETWORK_CHANGED'] as const

/** The same list as one word-bounded alternation — `net::ERR_X` matches on `ERR_X` because `:` is
 *  not a word character, exactly like `UNREACHABLE_RE` below. */
const INTERRUPTED_RE = new RegExp(`\\b(?:${INTERRUPTED_ERROR_CODES.join('|')})\\b`)

/**
 * THE CODES THAT MEAN "THE REQUEST NEVER REACHED GITHUB", spelled out rather than pattern-matched.
 *
 * An explicit list is the only shape that keeps the failure direction right: a code that is NOT
 * here falls through to 'other' and is REPORTED, so the cost of forgetting one is a line in
 * errors.log, never a silently swallowed failure.
 *
 * Both executors are covered because electron-updater uses either depending on how it was
 * constructed: Node's own errno spellings (`ENOTFOUND`, `ETIMEDOUT`) from the https executor, and
 * Chromium's (`net::ERR_NAME_NOT_RESOLVED`) from `ElectronHttpExecutor`, which arrive inside the
 * MESSAGE with no `code` property at all.
 */
export const UNREACHABLE_ERROR_CODES = [
  // Node / libuv.
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'EPIPE',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  // Chromium, as they appear inside a `net::ERR_…` message.
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_NAME_RESOLUTION_FAILED',
  // `ERR_NETWORK_CHANGED` USED TO BE HERE and is now an INTERRUPTION (JOS-307) — the list above
  // says why. Left as a note rather than silently removed: it is the only entry this list has ever
  // lost, and the next reader deserves to know it was a move rather than an omission.
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_ABORTED',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_FAILED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_TIMED_OUT'
] as const

/** The same list as one word-bounded alternation. `net::ERR_X` matches on `ERR_X` because `:` is
 *  not a word character, so one pattern covers both spellings. */
const UNREACHABLE_RE = new RegExp(`\\b(?:${UNREACHABLE_ERROR_CODES.join('|')})\\b`)

/** Errno/Chromium code shape: uppercase, digits and underscores. Deliberately NOT the same
 *  predicate as `errorCodeOf` (which is about what the wire will carry) - this one is about what
 *  can identify a transport failure, and a lowercase or dotted value never does. */
const TRANSPORT_CODE_RE = /^[A-Z][A-Z0-9_]{1,31}$/

/**
 * The HTTP status behind a failure, or null when there is none to be had.
 *
 * `statusCode` is `HttpError`'s own field; `HTTP_ERROR_<status>` is the `code` it sets beside it
 * and is also what survives when the error has been stringified into a log line. Anything outside
 * 4xx/5xx reads as "no status": a 2xx/3xx does not arrive here, and a nonsense number is not a
 * status we are willing to state.
 *
 * AND THE THIRD SPELLING IS `HttpError: <status>` IN THE MESSAGE (JOS-307), which is what
 * electron-updater's OWN wrappers leave behind. `newError` (electron-updater/out/error.js) builds a
 * plain Error carrying an `ERR_UPDATER_*` code and INTERPOLATES the HttpError into the sentence, so
 * the object no longer has `statusCode`, `code` no longer matches `HTTP_ERROR_…`, and a real answer
 * from GitHub was reading as `other`. MEASURED: 0.26.0's
 * `Cannot find latest-linux.yml in the latest release artifacts (… HttpError: 404` — 7 occurrences,
 * fingerprint 2e535fdf79476239 — is a 404 on OUR feed (this app ships no Linux artifact) filed
 * under a class that says we do not understand it. It is a 404, and now it says so.
 */
export function updateHttpStatus(err: unknown): number | null {
  const e = err as { statusCode?: unknown; code?: unknown } | null | undefined
  const direct = e?.statusCode
  if (typeof direct === 'number' && isFailureStatus(direct)) return direct
  return statusFromText(typeof e?.code === 'string' ? e.code : '', failureText(err))
}

/** The ONE opinion about which numbers are statuses we are willing to state. */
function isFailureStatus(n: number): boolean {
  return Number.isInteger(n) && n >= 400 && n <= 599
}

/** The three ways a status survives as TEXT once the error object has lost its properties: the
 *  `code` `HTTP_ERROR_<n>`, that same code inside a stringified copy, and electron-updater's own
 *  `HttpError: <n>` interpolation (the JOS-307 case argued above). */
function statusFromText(code: string, text: string): number | null {
  const m =
    /\bHTTP_ERROR_(\d{3})\b/.exec(code) ??
    /\bHTTP_ERROR_(\d{3})\b/.exec(text) ??
    /\bHttpError:\s*(\d{3})\b/.exec(text)
  if (m === null) return null
  const status = Number(m[1])
  return isFailureStatus(status) ? status : null
}

/** True when GitHub ANSWERED and the answer was a failure status - the class that must always be
 *  reported. The name arm catches an `HttpError` whose status we could not read. */
export function isHttpFailure(err: unknown): boolean {
  if (err == null) return false
  if (updateHttpStatus(err) !== null) return true
  return (err as { name?: unknown }).name === 'HttpError'
}

/**
 * True when the request died because the MACHINE MOVED under it — a suspend or a network change
 * (see `INTERRUPTED_ERROR_CODES`).
 *
 * Both spellings are covered for the same reason `isUnreachableFailure` covers both: the code can
 * arrive as a `code` property from one executor and inside the message from the other.
 */
export function isInterruptedFailure(err: unknown): boolean {
  if (err == null) return false
  const code = (err as { code?: unknown }).code
  if (typeof code === 'string' && (INTERRUPTED_ERROR_CODES as readonly string[]).includes(code)) {
    return true
  }
  return INTERRUPTED_RE.test(failureText(err))
}

/** True when the request never left the machine (see `UNREACHABLE_ERROR_CODES`). */
export function isUnreachableFailure(err: unknown): boolean {
  if (err == null) return false
  const code = (err as { code?: unknown }).code
  if (typeof code === 'string' && (UNREACHABLE_ERROR_CODES as readonly string[]).includes(code)) {
    return true
  }
  return UNREACHABLE_RE.test(failureText(err))
}

/**
 * The machine-readable code a failure is known by - `ENOTFOUND`, `ERR_NAME_NOT_RESOLVED`,
 * `HTTP_ERROR_403`. Used as the KEY of the once-per-session unreachable warning, so it has to be
 * stable across occurrences and carry nothing about this machine.
 */
export function updateFailureCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null | undefined)?.code
  if (typeof code === 'string' && TRANSPORT_CODE_RE.test(code)) return code
  const text = failureText(err)
  return UNREACHABLE_RE.exec(text)?.[0] ?? INTERRUPTED_RE.exec(text)?.[0] ?? null
}

/** Which of the five kinds this failure is. Asked in the order the block above argues. */
export function classifyUpdateFailure(err: unknown): UpdateFailureKind {
  if (err == null) return 'other'
  // FIRST, and the position is the point: an interruption is the one kind that is not a failure, so
  // nothing else may claim it. Nothing else can, either — neither code carries a status and neither
  // is in the parse patterns — and asking it first means a future widening of the other arms cannot
  // quietly start reporting sleeps and Wi-Fi handovers again.
  if (isInterruptedFailure(err)) return 'interrupted'
  // SECOND, and BEFORE 'parse' — the shape it has to beat is a bare `SyntaxError` thrown by
  // `JSON.parse('')`, which is character for character the JOS-211 feed failure and is a completely
  // different fact about the machine (JOS-421's block above reads the source).
  if (isSignatureCheckBlocked(err)) return 'blocked'
  if (isHttpFailure(err)) return 'http'
  if (isFeedParseError(err)) return 'parse'
  if (isUnreachableFailure(err)) return 'unreachable'
  return 'other'
}

// ------------------------------------------------------- version comparison
//
// Our versions are semver with a CI-stamped prerelease on the main channel
// (`1.4.0-main.231`). electron-updater does its own comparison, but we guard
// independently for one specific case the user hits: apply-on-quit already
// installed build N, and a status pushed just before the relaunch (or a feed
// that still lists N) must NOT resurface as "restart to update" on a build that
// IS N. Never offer a version that isn't strictly newer than what's running.

/** Split "1.4.0-main.231" into [major, minor, patch] + prerelease identifiers. */
function parseVersion(v: string): { nums: number[]; pre: string[] } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim())
  if (!m) return null
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.') : []
  }
}

/**
 * semver precedence: -1 / 0 / 1. Numeric prerelease identifiers compare
 * numerically (`main.9` < `main.10` — a plain string compare gets this wrong,
 * which is exactly the CI run-number case), a prerelease sorts BELOW its
 * release, and an unparseable version compares equal (we refuse to guess).
 */
export function compareVersions(a: string | undefined, b: string | undefined): number {
  if (!a || !b) return 0
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  const core = compareCore(pa.nums, pb.nums)
  if (core !== 0) return core
  return comparePrerelease(pa.pre, pb.pre)
}

/** major.minor.patch, left to right. 0 when all three are equal. */
function compareCore(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

/**
 * Prerelease precedence: NO prerelease sorts above one (1.0.0 > 1.0.0-main.1), then
 * identifier by identifier, and a shorter identifier list sorts below a longer one that
 * agrees on the shared prefix.
 */
function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const c = compareIdentifier(x, y)
    if (c !== 0) return c
  }
  return 0
}

/** One prerelease identifier pair. All-digit identifiers compare NUMERICALLY (`main.9` < `main.10`). */
function compareIdentifier(x: string, y: string): number {
  const nx = /^\d+$/.test(x) ? Number(x) : null
  const ny = /^\d+$/.test(y) ? Number(y) : null
  if (nx !== null && ny !== null) return nx === ny ? 0 : nx < ny ? -1 : 1
  return x === y ? 0 : x < y ? -1 : 1
}

/** True when `candidate` is strictly newer than `current` (unknown ⇒ false). */
export function isNewerVersion(candidate: string | undefined, current: string | undefined): boolean {
  if (!candidate || !current) return false
  return compareVersions(candidate, current) > 0
}

/**
 * True when `candidate` is NOT worth offering because we already run it (or
 * newer) — the "apply-on-quit already installed this" case.
 *
 * Deliberately conservative: if either version is missing or unparseable we
 * return FALSE (not stale) rather than silently suppressing a real update.
 * Never guess (world-model law 1) — an unknown comparison defers to
 * electron-updater's own verdict.
 */
export function isStaleVersion(candidate: string | undefined, current: string | undefined): boolean {
  if (!candidate || !current) return false
  if (!parseVersion(candidate) || !parseVersion(current)) return false
  return compareVersions(candidate, current) <= 0
}

// -------------------------------------------------------- status -> UI state
//
// ONE mapping, shared by the nav chip and (for its headline) Preferences, so the
// two surfaces can never disagree about whether an update is really waiting.
//
// Product rule: the ONLY loud state is 'ready'. Everything else — including every
// error — renders as the quiet "checked <age> ago" line. A failed check is not
// the user's problem and must never look like one; the message survives in
// Preferences > Updates for whoever goes looking.

export type UpdateChipState =
  /** An update is downloaded and staged: the one inviting, clickable state. */
  | { kind: 'ready'; version?: string; checkedAt?: number }
  /** Downloading in the background — a thin, calm progress affordance. */
  | { kind: 'downloading'; percent: number; version?: string; checkedAt?: number }
  /** Transient work (checking / found-but-not-started): muted one-liner. */
  | { kind: 'working'; label: string; checkedAt?: number }
  /** The resting state: "checked 2h ago" (or "never"), click to check. `disabled` means the
   *  updater is off for this process (dev build) — render a truthful static note, not a
   *  forever-stale check affordance. */
  | { kind: 'quiet'; checkedAt?: number; failed: boolean; message?: string; disabled?: boolean }

/**
 * Map a raw UpdateStatus onto what the chip should render.
 *
 * `currentVersion` (app.getVersion()) is the updated-away guard: a status naming
 * a version we are ALREADY running is stale — demote it to quiet rather than
 * inviting a pointless relaunch. An unknown/unparseable pair is trusted as-is
 * (we only demote on a positive "not newer" verdict).
 */
export function updateChipState(status: UpdateStatus, currentVersion?: string): UpdateChipState {
  const checkedAt = status.checkedAt
  const stale = (v?: string): boolean => isStaleVersion(v, currentVersion)

  switch (status.state) {
    case 'ready':
      if (stale(status.version)) return { kind: 'quiet', checkedAt, failed: false }
      return { kind: 'ready', version: status.version, checkedAt }
    case 'downloading':
      if (stale(status.version)) return { kind: 'quiet', checkedAt, failed: false }
      return {
        kind: 'downloading',
        percent: Math.max(0, Math.min(100, Math.round(status.percent ?? 0))),
        version: status.version,
        checkedAt
      }
    case 'available':
      if (stale(status.version)) return { kind: 'quiet', checkedAt, failed: false }
      return { kind: 'working', label: 'Update found…', checkedAt }
    case 'checking':
      return { kind: 'working', label: 'Checking for updates…', checkedAt }
    case 'error':
      return { kind: 'quiet', checkedAt, failed: true, message: status.message }
    case 'idle':
    default:
      return { kind: 'quiet', checkedAt, failed: false, disabled: status.disabled }
  }
}

// ------------------------------------------------- WHAT THE CHIP SAYS OUT LOUD (JOS-307)
//
// THE LINE THAT WAS NOT TRUE. Until this ticket a failed check rendered CHARACTER FOR CHARACTER
// like a successful one — `v0.26.0 · checked 2h ago` — with the failure admitted only in a native
// `title` nobody hovers and in a Preferences panel nobody opens. The worst shape of it is the one
// the user ASKED about: click the chip, the check fails, and the cooldown window then reads
// `checked just now`, which is a sentence about a check that did not happen. GitHub issue 29 is a
// user who watched that line for six versions.
//
// WHAT CHANGES IS THE WORDS, NOT THE VOLUME. The product rule stands and is not this ticket's to
// move: the ONLY loud state is 'ready' — no badge, no red, no modal, no repeat. A failed check is
// still not the user's problem. It is, however, a FACT, and the chip is where this app states
// facts about itself. So the resting line says which of the two things happened, stays muted, and
// stays one click from trying again. The detail (the message, the exact timestamp) is still
// Preferences' job.
//
// `age` is passed IN rather than computed: `formatAge` is a renderer concern and this file is
// imported by the main process. `null` means never checked.

/** What the chip's muted line needs to know that `UpdateChipState` does not carry. */
export interface UpdateChipLineCtx {
  /** The INSTALLED version (`app.getVersion()`), or '' before it has been read. */
  readonly version: string
  /** `formatAge(checkedAt, now)`, or null when nothing has ever been checked. */
  readonly age: string | null
  /** A manual check is in flight right now. */
  readonly busy: boolean
  /** Inside the post-manual-check window (an answer this recent is still THE answer). */
  readonly cooldown: boolean
}

/** The muted line's text, its hover title, and whether it is stating a failure. */
export interface UpdateChipLine {
  readonly label: string
  readonly tip: string
  /** True when the line is stating a failed check — the renderer's cue to lift it out of
   *  `text.disabled`. Never a colour and never an icon: the caller decides how muted is muted. */
  readonly failed: boolean
}

/**
 * The ONE producer of the quiet/working line. Pure, so `tests/updateCadence.test.mts` can pin the
 * sentence the user actually reads — which is the only artefact issue 29 ever produced.
 */
export function updateChipLine(ui: UpdateChipState, ctx: UpdateChipLineCtx): UpdateChipLine {
  const vPrefix = ctx.version ? `v${ctx.version} · ` : ''
  const failed = ui.kind === 'quiet' && ui.failed
  const message = ui.kind === 'quiet' ? ui.message : undefined
  const tip = failed
    ? `Last check didn't complete${message ? ` - ${message}` : ''}. Click to try again.`
    : 'Click to check for updates'

  // Transient work speaks for itself, and a check in flight outranks whatever the last one said —
  // including a failure, which the click is in the middle of retrying.
  if (ui.kind === 'working') return { label: ui.label, tip, failed: false }
  if (ctx.busy) return { label: 'Checking for updates…', tip, failed: false }
  // THE FAILURE BRANCH COMES BEFORE THE COOLDOWN, and that ordering IS the fix: the cooldown's
  // "up to date" and the age line are both claims that a check completed.
  if (failed) return { label: `${vPrefix}update check failed`, tip, failed: true }
  if (ctx.cooldown) return { label: `${vPrefix}up to date`, tip, failed: false }
  return {
    label: ctx.age === null ? `${vPrefix}not checked yet` : `${vPrefix}checked ${ctx.age}`,
    tip,
    failed: false
  }
}
