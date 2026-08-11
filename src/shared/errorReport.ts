// ============================================================================
// ERROR REPORT — the message redactor, the stack parser, and the fingerprint.
// ============================================================================
//
// The three pure functions behind `errorReport` (JOS-100). They sit BESIDE `sanitizeText.ts`
// because they are the same kind of thing: the one definition of how a hostile-by-accident
// string is made safe to carry, run on the client before a byte leaves the machine AND on the
// server before a byte is stored.
//
// -----------------------------------------------------------------------------------------
// WHY THIS FILE EXISTS AT ALL — and what changed about the privacy promise.
// -----------------------------------------------------------------------------------------
// Every other telemetry field is a member of a closed enum or a bucket index, and TELEMETRY.md
// could therefore say "there is no free-text field anywhere in it". An error report cannot be
// built that way and still be worth having: the whole value of one is the part that is
// SPECIFIC — which error, thrown where, after what. So the owner's ruling (JOS-100) is to
// prioritise DIAGNOSABILITY over pure anonymity, holding ONE bright line:
//
//     GAMEPLAY DATA — log lines, chat, character names — NEVER RIDES AUTOMATICALLY.
//
// That line is held by SHAPE, not by discipline. An error report can carry a redacted message,
// a stack of BUNDLE-RELATIVE frames, and a list of parser event KINDS. There is no field on it
// that a zone, a mob, a spell, an item, a character or a line of log could travel in — the
// frames name files in `out/`, the breadcrumbs are enum members, and the message is the OUTPUT
// of `redactMessage` (below), re-run and re-checked at the server.
//
// -----------------------------------------------------------------------------------------
// THE REDACTOR IS NEW, AND THE BRIEF'S PREMISE THAT IT COULD BE REUSED WAS WRONG.
// -----------------------------------------------------------------------------------------
// `src/shared/logScrub.ts` is a DROP LIST — it decides whether a whole log line survives, and
// its own law is "never rewrite a line with a placeholder" (a rewritten line still parses into
// a fake event). It has no path/quote/number patterns to borrow, and borrowing its posture
// would be wrong here anyway: a message is not a log line, and dropping it entirely is exactly
// the outcome this feature exists to avoid. So the patterns below are written fresh, and they
// are the FIRST placeholder-substituting redactor in this repo.
//
// PURE: the only import is `./sanitizeText` (itself import-free). No `node:`, no Electron, no
// DOM. It compiles under both tsconfigs and bundles into the telemetry Lambda.

import { sanitizeOneLine } from './sanitizeText'

// ---------------------------------------------------------------- the bounds
//
// Declared FIRST because two of them are default arguments below, and a reader looking for
// "how long may a message be" should not have to scroll past the regex that produces it.
// Each is restated as a wire bound in `./telemetry.ts`; `tests/errorReportContract.test.mts`
// pins the two copies equal, the same way the overlay-kind list is pinned.

/** Length ceiling for `redactedMessage`. */
export const MAX_REDACTED_MESSAGE = 200
/** Frames per report. Ten is a stack a person reads; the rest is noise the fingerprint already
 *  summarises. */
export const MAX_ERROR_FRAMES = 10
/** Ceiling for a line/column number — a whole number, not a fingerprint. */
export const MAX_FRAME_POSITION = 1_000_000
/** Ceiling for a function name. */
export const MAX_FRAME_FUNC = 80
/** How many top frames the fingerprint folds in. Three is enough to separate two call sites in
 *  one file and few enough that a deeper caller changing does not mint a new issue. */
export const FINGERPRINT_FRAMES = 3

// ---------------------------------------------------------------- the redactor

/**
 * A FILESYSTEM PATH. Three arms, and the shape of each was decided by a failing test rather
 * than by taste — the first draft of this regex stopped at the first SPACE, and the suite
 * immediately produced `Cannot find module <path> Legends\Logs` out of a real UNC share.
 * Windows paths contain spaces constantly (`C:\Program Files\…`, and this game's own install
 * directory is `EverQuest Legends`), so a space-terminated path pattern leaks the tail of every
 * one of them.
 *
 *   1. WINDOWS, drive-letter or UNC. After the prefix it consumes SEGMENT-BY-SEGMENT: any run
 *      of characters — spaces included — that ends in a separator, repeated, then one final
 *      segment with no spaces in it. So `C:\Program Files\eqc\out\a.js` goes whole, while
 *      `seek to C:\a\b failed after 3 retries` gives up the path and keeps the sentence: the
 *      loop cannot take ` failed after 3 retries` because there is no separator after it.
 *   2. POSIX HOME DIRECTORIES BY NAME (`/home/…`, `/Users/…`, `/root/…`), consumed to the end
 *      of the run. This arm exists because arm 3 cannot cover `/Users/josh` — two segments,
 *      structurally identical to `/v1/telemetry` — and `/Users/josh` is precisely where a
 *      person's name lives. Naming the three directories is the only non-guessing way to tell
 *      those two apart.
 *   3. POSIX, GENERIC: at least three segments (`/usr/lib/node_modules/x`). Two segments are
 *      deliberately left alone — a URL path (`POST /v1/telemetry failed`) looks exactly like
 *      one, and eating it would cost the diagnosable half of a message to cover a shape arm 2
 *      already covers where it matters.
 *
 * NONE of the arms can match the placeholder they produce (`<path>` has no separator and no
 * drive letter), which is half of why `redactMessage` is idempotent.
 *
 * OVER-REDACTION IS THE SAFE DIRECTION AND IS TAKEN DELIBERATELY: two paths in one sentence can
 * be swallowed as one match. Losing a few words of a message is a cost; publishing a fragment
 * of somebody's home directory is a broken promise.
 */
const PATH_RE = new RegExp(
  [
    // 1. Windows. The optional `file://` prefix is consumed INTO the match, and the lookbehind
    //    is what stops the drive-letter arm firing on the `e:/` inside the word `file:` —
    //    without it, `Failed to fetch file:///C:/Users/…` redacts to `Failed to fetch fil<path>`
    //    and publishes three letters of nothing while looking like it worked. (The suite found
    //    that; it is exactly the class of near-miss a regex reviewer reads straight past.)
    String.raw`(?:file:\/{2,3})?(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\)(?:[^'"<>|\r\n\\/]*[\\/])*[^\s'"<>|\r\n\\/]*`,
    // 2. POSIX home directories, by name.
    String.raw`\/(?:home|Users|root)\/[^'"<>|\r\n]*[^\s'"<>|\r\n]`,
    // 3. POSIX, generic: three segments or more.
    String.raw`\/(?:[^\s'"<>|\r\n\\/]+\/){2,}[^\s'"<>|\r\n\\/]*`
  ].join('|'),
  'g'
)

/**
 * AN EQ LOG LINE, recognised by the one signature it cannot be written without: the
 * `[Sat Aug 01 13:00:28 2026]` timestamp prefix every single line in the game's log carries.
 *
 * IT SWALLOWS THE REST OF THE MESSAGE, and that is the point. The bright line on this whole
 * feature is that GAMEPLAY DATA NEVER RIDES AUTOMATICALLY, and the one way a log line could
 * reach an error message is a `throw new Error(line)` somewhere in the parser — which is a
 * plausible thing for a future version of this app to do by accident. The redactor cannot know
 * that "You slash a rat for 12 points of damage." is gameplay; it can know that anything
 * FOLLOWING an EQ timestamp is, and a log line without its timestamp is not a log line the
 * parser was handed.
 *
 * The validator's fixed-point check then does the other half: a raw log line is not a fixed
 * point of this function, so a client that somehow sends one is REFUSED rather than repaired.
 * (`tests/errorReportContract.test.mts` pins both halves; this arm was written because that
 * suite proved a log line otherwise passed the validator untouched.)
 */
const EQ_LOG_LINE_RE =
  /\[(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}\].*$/

/**
 * A QUOTED STRING, single or double. The quotes are the game's own tell: EQ names arrive
 * quoted (`'a Nisch Mas Mender'`), `JSON.parse` quotes the token it choked on, and a
 * `Cannot read properties of undefined (reading 'characterName')` quotes a property name.
 * Every one of those is either gameplay data or a detail the frames already carry better.
 *
 * IT RUNS AFTER THE PATH PASS, and the callback is why: `open 'C:\Users\…\alerts.json'` should
 * read `open <path>` and not `open <str>`. The path pass has already turned the body into the
 * placeholder, so a quoted body that is EXACTLY a placeholder is unwrapped rather than
 * collapsed — the reader keeps the fact that the thing was a path, and keeps nothing else.
 */
const QUOTED_RE = /'[^']*'|"[^"]*"/g

/**
 * A LONG NUMBER: five digits or more. Short numbers stay, and that is a decision rather than a
 * threshold nobody thought about — an errno (`-4058`), an HTTP status, a line number, a small
 * count and a byte size under 10 KB are all diagnostic, while the five-digit-and-up runs in a
 * real message are ids, offsets, timestamps and sizes that describe one machine's one file.
 */
const LONG_NUMBER_RE = /\d{5,}/g

/** What each family collapses to. Spelled once so the doc, the tests and the code agree. */
export const REDACTION_PLACEHOLDERS = ['<path>', '<str>', '<n>', '<logline>'] as const

/**
 * REDACT ONE ERROR MESSAGE. Total, deterministic, and IDEMPOTENT — `redact(redact(x))` is
 * `redact(x)` for every input, which is not a nicety: the server RE-RUNS this function on the
 * message a client sent and REFUSES the report if the output differs (telemetryValidate.ts).
 * That is the defense-in-depth check, and it can only be written because the function has a
 * fixed point.
 *
 * The order is the design:
 *   1. ONE LINE. `sanitizeOneLine` folds newlines/tabs to spaces and deletes every control and
 *      invisible character, ANSI sequences whole — so a message can never forge a row in the
 *      owner's terminal, and the printable-ASCII bound below has something to be true of.
 *   2. AN EQ LOG LINE, first of the content passes, because it swallows everything after it and
 *      running it after the others would only mean redacting text that is about to be thrown
 *      away anyway.
 *   3. PATHS, before quotes (see `QUOTED_RE`).
 *   4. QUOTED STRINGS, unwrapping a quoted placeholder rather than swallowing it.
 *   5. LONG NUMBERS.
 *   6. COLLAPSE RUNS OF SPACES and trim — a redaction leaves gaps behind, and two messages
 *      that differ only in how much whitespace the redaction left are the same message.
 *   7. CAP, LAST. Capping before redacting would break idempotence: a cut could leave half a
 *      path (`C:\Users\jm`) that the next pass would redact, so the second run would not equal
 *      the first. Cutting AFTER the placeholders are in place cannot create a new match —
 *      there are no paths, quotes or long numbers left to cut into.
 *
 * Anything not a string reads as the empty string: the caller is handing us whatever was
 * thrown, and `throw 42` is legal JavaScript.
 */
export function redactMessage(raw: unknown, cap = MAX_REDACTED_MESSAGE): string {
  if (typeof raw !== 'string') return ''
  const oneLine = sanitizeOneLine(raw).replace(EQ_LOG_LINE_RE, '<logline>')
  const paths = oneLine.replace(PATH_RE, '<path>')
  const quoted = paths.replace(QUOTED_RE, (m) => {
    const body = m.slice(1, -1)
    return (REDACTION_PLACEHOLDERS as readonly string[]).includes(body) ? body : '<str>'
  })
  const numbers = quoted.replace(LONG_NUMBER_RE, '<n>')
  // Any character outside printable ASCII is dropped rather than carried: the wire predicate
  // (REDACTED_MESSAGE_RE) refuses one, and a redactor whose output its own validator rejects
  // would silently lose every report from a locale whose error strings are translated.
  const ascii = numbers.replace(/[^\x20-\x7E]/g, '')
  const tidy = ascii.replace(/ {2,}/g, ' ').trim()
  return tidy.length > cap ? tidy.slice(0, cap).trimEnd() : tidy
}

// ---------------------------------------------------------------- the stack parser

/** One frame, as the wire carries it. Bundle-relative file, 1-based line, 0-based column. */
export interface ErrorFrame {
  /** ALWAYS `out/…` — see `normalizeFrameFile`. Never an absolute path, never a URL. */
  file: string
  line: number
  col: number
  /** Identifier-shaped, `<anonymous>` when the engine did not name it. */
  func: string
}

/**
 * V8 stack line, both spellings:
 *   `    at Object.foo (C:\…\out\main\index.js:12:34)`
 *   `    at C:\…\out\renderer\assets\index-abc.js:12:34`
 * plus the renderer's `file:///…` URL form, which the location group swallows unchanged and
 * `normalizeFrameFile` then cuts down.
 */
const STACK_LINE_RE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/

/**
 * Everything up to and including the LAST separator before the bundle root.
 *
 * GREEDY, AND THE SEPARATOR IS MANDATORY — both halves are load-bearing, and a lazy version of
 * this regex LEAKS. `\Users\scout\app\out\main\index.js` contains the letters `out` inside a
 * user's own account name, so a lazy match with an optional separator returns
 * `out\app\out\main\index.js` and publishes a directory the user named. Greedy takes the LAST
 * root, which is the bundle by construction, and requiring the separator means the match can
 * only ever start at a path segment boundary. The prefix group is optional so an already
 * relative frame (`out/main/index.js`) still parses.
 *
 * TWO ROOT SPELLINGS, ONE WIRE VALUE. `out/` is what `electron-vite build` emits and what ships;
 * `out-e2e/` is what the headless harness builds into (an ABSOLUTE `--outDir`, so it never races
 * the dev watcher's `out/` — AGENTS.md). They are the SAME FILES from the same sources, so both
 * normalize to `out/` and the wire has exactly one root to know about. Discovered by the e2e
 * spec, which asserted on frames and got an empty list: every renderer frame under the harness
 * lives in `out-e2e/`, so the whole stack was being dropped and nothing said so.
 */
const BUNDLE_ROOT_RE = /^(?:.*[\\/])?(?:out|out-e2e)[\\/](.*)$/

/** Not an identifier, not `<anonymous>`, not a dotted method path — refused rather than sent. */
const FUNC_ALLOWED_RE = /^[A-Za-z0-9_$.<>[\]]+$/

/**
 * The shape a normalized frame file must have — the PRODUCER's copy of `FRAME_FILE_RE`
 * (shared/telemetry.ts), which cannot be imported here without giving that file an import it
 * is not allowed to have. `tests/errorReportContract.test.mts` pins the two SOURCE STRINGS
 * equal, so the copy cannot rot.
 *
 * It is applied at the producer as well as the validator because a frame that the wire would
 * refuse must never reach the wire: an event dropped at the boundary is an error report nobody
 * ever sees, which is indistinguishable from a fleet with no errors in it.
 */
const BUNDLE_FILE_RE = /^out\/[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/

/**
 * A stack frame's file, reduced to something the wire may carry: BUNDLE-RELATIVE, forward
 * slashes, `out/…` or nothing at all.
 *
 * NOTHING OUTSIDE THE BUNDLE SURVIVES, and that is the whole privacy argument for this field.
 * The absolute prefix of a frame is `C:\Users\<the user's name>\AppData\Local\Programs\…` in a
 * packaged install and a checkout path in a dev build — it names a person either way and says
 * nothing about the bug. What is left after the cut (`out/main/index.js`) is a file the repo
 * built and the sourcemaps can symbolicate, which is the entire point of keeping frames.
 *
 * Returns null for a frame that has no `out/` in it: a `node:internal/...` frame, an
 * `electron/js2c/...` frame, an eval, or anything else. Those are dropped rather than repaired,
 * which is also what makes "top APP frames" a meaningful input to the fingerprint.
 */
export function normalizeFrameFile(raw: string): string | null {
  const noScheme = raw.replace(/^file:\/{2,3}/, '').replace(/^[A-Za-z]:/, '')
  const m = BUNDLE_ROOT_RE.exec(noScheme)
  if (m === null) return null
  const file = `out/${m[1].replace(/\\/g, '/').replace(/[?#].*$/, '')}`
  return BUNDLE_FILE_RE.test(file) ? file : null
}

/** The producer's copy of the wire's file pattern, exported for the parity pin only. */
export const BUNDLE_FILE_PATTERN = BUNDLE_FILE_RE.source

/**
 * Parse a stack into at most `max` frames, newest first, keeping whatever `normalize` recognises.
 *
 * THE CLASSIFIER IS AN ARGUMENT because there are now two of them and they must read the same
 * stack the same way (JOS-111): `normalizeFrameFile` keeps the bundle, and
 * `classifyExternalFrameFile` in `./errorReportLocation.ts` keeps Node, Electron and our own
 * dependencies. Everything else about a frame — the position cap, the function-name rule, the
 * newest-first order — is one implementation rather than two that could drift.
 *
 * Frames the classifier refuses are SKIPPED, not counted — a stack whose top three frames are
 * Node internals still yields the app frames beneath them, which is exactly the stack a reader
 * wants. A frame whose function name is not identifier-shaped (an engine can put almost anything
 * in there) degrades to `<anonymous>` rather than being dropped: the LOCATION is the diagnostic
 * half and losing a whole frame over its label would be the wrong trade.
 */
export function framesFrom(
  stack: unknown,
  normalize: (raw: string) => string | null,
  max: number
): ErrorFrame[] {
  if (typeof stack !== 'string') return []
  const out: ErrorFrame[] = []
  for (const raw of stack.split('\n')) {
    if (out.length >= max) break
    const m = STACK_LINE_RE.exec(raw)
    if (m === null) continue
    const file = normalize(m[2])
    if (file === null) continue
    const func = m[1] ?? ''
    out.push({
      file,
      line: Math.min(Number(m[3]), MAX_FRAME_POSITION),
      col: Math.min(Number(m[4]), MAX_FRAME_POSITION),
      func: FUNC_ALLOWED_RE.test(func) ? func.slice(0, MAX_FRAME_FUNC) : '<anonymous>'
    })
  }
  return out
}

/** Parse a stack into at most `max` APP frames — `framesFrom` with the bundle classifier. */
export function parseStackFrames(stack: unknown, max = MAX_ERROR_FRAMES): ErrorFrame[] {
  return framesFrom(stack, normalizeFrameFile, max)
}

// ---------------------------------------------------------------- the fingerprint

/**
 * FNV-1a, 32 bits, with a caller-supplied offset basis. Chosen over anything in `node:crypto`
 * for one reason: this function has to run in the SAME form on the client and inside a bundled
 * Lambda handler and under `tsx` in a unit test, and a hand-written integer loop is the only
 * version of that with no import and no platform. It is not a security primitive and is not
 * used as one — the fingerprint groups reports; it never authenticates one.
 */
function fnv1a(text: string, basis: number): number {
  let h = basis >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i) & 0xff
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

const hex8 = (n: number): string => n.toString(16).padStart(8, '0')

/**
 * THE GROUPING KEY: `hash(errorName + the top app frames)`, sixteen lowercase hex characters.
 *
 * WHAT IS IN IT, AND WHAT IS DELIBERATELY NOT. The name and the top `FINGERPRINT_FRAMES`
 * frames, each as `file:line:func` — so the same bug reported by two hundred installs is ONE
 * row, and the same file failing two different ways is two.
 *
 * THE MESSAGE IS NOT IN IT, on purpose. A message carries the varying part (`open <path>`,
 * a different property name each time), so folding it in would shatter one issue into a
 * hundred singletons — which is the failure mode that makes an error dashboard useless. The
 * exemplar still carries one message, which is where a reader gets that detail back.
 *
 * COLUMNS ARE NOT IN IT either: a minifier moves columns between builds far more readily than
 * it moves lines, and an issue that re-fingerprints on every release cannot be tracked across
 * one.
 *
 * `fallback` IS READ ONLY WHEN THERE ARE NO FRAMES (JOS-111), and that condition is the whole
 * design of it. A report WITH frames hashes exactly what it hashed before this ticket existed, so
 * every issue already being tracked in the store keeps its identity across the release — a
 * fingerprint change is indistinguishable, from the outside, from an old bug ending and a new one
 * starting on the same day. What changes is only the case that was broken: a FRAMELESS report used
 * to hash the name alone, so every unnamed throw in the app collapsed into one row.
 * `fingerprintFallback` (./errorReportLocation.ts) is what fills it, and it is never transmitted.
 */
export function errorFingerprint(
  errorName: string,
  frames: readonly ErrorFrame[],
  fallback = ''
): string {
  const parts = [errorName]
  for (const f of frames.slice(0, FINGERPRINT_FRAMES)) parts.push(`${f.file}:${String(f.line)}:${f.func}`)
  if (frames.length === 0 && fallback !== '') parts.push(fallback)
  const text = parts.join('|')
  return `${hex8(fnv1a(text, 0x811c9dc5))}${hex8(fnv1a(text, 0x01000193))}`
}

// ---------------------------------------------------------------- the error's own name/code

/** `TypeError`, `Error`, `EqError` — an identifier, capped. Anything else reads as `Error`. */
const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/

/**
 * The name of whatever was thrown, folded onto something the wire will accept.
 *
 * `Error` is the fallback rather than `unknown`, and that is honest rather than lazy: something
 * WAS thrown, the name is the only part of it we could not read, and a bucket called `Error` is
 * where an unnamed throw belongs. A thrown string or number has no name at all and lands here.
 */
export function errorNameOf(name: unknown): string {
  return typeof name === 'string' && NAME_RE.test(name) ? name : 'Error'
}

/** `ENOENT`, `EPERM`, `ERR_MODULE_NOT_FOUND`, `-4058` — Node's own machine-readable code, when
 *  the thrown value carries one. Undefined when it does not, or when it is not code-shaped. */
export function errorCodeOf(code: unknown): string | undefined {
  const text = typeof code === 'number' ? String(code) : code
  if (typeof text !== 'string') return undefined
  return /^[A-Za-z0-9_.-]{1,32}$/.test(text) ? text : undefined
}
