// ============================================================================
// WHERE IT BROKE, WHEN THE THROW WOULD NOT SAY — the frameless half (JOS-111).
// ============================================================================
//
// `./errorReport.ts` turns a stack into BUNDLE frames and hashes them into a fingerprint. That
// works exactly as long as the throw has a stack with `out/` in it, and the fleet's own numbers
// say how often it does not: triage of the live 0.13.0 error stream found the two loudest issues
// were both FRAMELESS. With no frames, `errorFingerprint` hashes the NAME alone — so every
// unnamed throw in the whole app collapses into `hash('Error')`, one row, and the only thing left
// to diagnose from is the message a reader has to squint at.
//
// This module is the four answers to that, and every one of them is a LOCATION rather than more
// text:
//
//   1. EXTERNAL FRAMES. A stack can be full of frames and still have no `out/` in it — an ENOENT
//      raised inside `node:internal/fs/promises`, a chokidar handler, an Electron init script.
//      `normalizeFrameFile` drops all of those (correctly: they are not the wire's `out/` shape),
//      and dropping them was the whole stack. So they are CLASSIFIED AND TRUNCATED instead —
//      `node:<module>`, `node_modules/<package>`, `electron/<script>` — and only the
//      unrecognizable is dropped. Truncation is what makes this safe: everything to the LEFT of
//      the `node_modules/` boundary is the install path (and therefore the user's account name)
//      and everything to the RIGHT of the package name is detail the package name already
//      implies, so the value that survives names a PUBLIC artefact and nothing else.
//
//   2. THE CAPTURE SITE. Some payloads have no stack at all and never did: a forwarded renderer
//      `console.error` is `{ level, message, source }`, a `did-fail-load` is four fields about a
//      URL, a rejected string is a string. For those, the app still knows one true location —
//      WHERE IT WAS CAUGHT — and `errorLog` can hand that over as a stack captured at its own
//      call site. It is not the throw site and is never presented as one (`frameOrigin` says
//      which), but `out/main/index.js:5178` in the console forwarder and `out/main/index.js:5310`
//      in the load handler are two different issues, which is precisely what was lost.
//
//   3. THE NESTED ERROR. `logError('main:preload-error', { preloadPath, error })` carries a real
//      Error with a real stack one property down, and the top-level read found `stack: undefined`
//      and gave up. Unwrapping is a strictly better answer than synthesising a capture site.
//
//   4. THE MESSAGE SKELETON, and only as a LAST resort. When there is no location of any kind, the
//      fingerprint folds in a deliberately coarse shape of the ALREADY-REDACTED message (see
//      `messageSkeleton`) so that two different frameless failures stop being one row. It is never
//      sent — it exists only inside the hash.
//
// PLUS ONE FIELD THAT IS NOT A FRAME: React's `componentStack` (`parseComponentPath`), which is
// the only thing that can say a Tooltip warning came from the inventory row rather than the
// tooltip. Component names are OUR OWN identifiers, but they are still bounded by charset, by
// name length and by depth — the bright line is held by SHAPE here as everywhere else.
//
// PURE, like `./errorReport.ts`, and it imports only that. It bundles into the telemetry Lambda.

import { FINGERPRINT_FRAMES, framesFrom, type ErrorFrame } from './errorReport'

// ---------------------------------------------------------------- external frames

/**
 * How many external frames a report may carry. HALF the app-frame budget on purpose: an external
 * frame is CONTEXT (which library, which Node subsystem) and never the answer, and the deepest
 * five of `node:internal/...` say nothing the first two did not.
 */
export const MAX_EXTERNAL_FRAMES = 5

/** Characters allowed in one segment of an external file, and how long it may be. */
const EXT_SEGMENT = String.raw`[A-Za-z0-9_-][A-Za-z0-9_.-]{0,39}`

/**
 * The shape an external frame's file must have — the PRODUCER's copy of
 * `EXTERNAL_FRAME_FILE_RE` (shared/telemetry.ts), which cannot be imported here for the reason
 * `BUNDLE_FILE_RE` states about its own twin. `tests/errorReportContract.test.mts` pins the two
 * SOURCE STRINGS equal.
 *
 * THREE ARMS, ALL OF THEM NAMING SOMETHING PUBLIC:
 *   `node:fs`, `node:internal/fs/promises`   — Node's own module graph.
 *   `electron/js2c/renderer_init`            — Electron's own bootstrap scripts.
 *   `node_modules/chokidar`, `node_modules/@scope/pkg` — a package from our own lockfile.
 *
 * NO SEGMENT MAY START WITH A DOT, which refuses `node_modules/../../secret` for exactly the
 * reason `FRAME_FILE_RE` refuses `out/../../secret.txt`. Three segments is the ceiling on the two
 * path-shaped arms, which is also the truncation this module applies before testing.
 */
const EXTERNAL_FILE_RE = new RegExp(
  `^(?:node:${EXT_SEGMENT}(?:/${EXT_SEGMENT}){0,2}` +
    `|electron/${EXT_SEGMENT}(?:/${EXT_SEGMENT}){0,2}` +
    `|node_modules/(?:@${EXT_SEGMENT}/)?${EXT_SEGMENT})$`
)

/** The producer's copy of the wire's external-file pattern, exported for the parity pin only. */
export const EXTERNAL_FILE_PATTERN = EXTERNAL_FILE_RE.source

/** A candidate value, or null if the wire's own pattern would not hold it. */
const accept = (file: string): string | null => (EXTERNAL_FILE_RE.test(file) ? file : null)

/** The first `n` path segments of a location, forward-slashed, with any query/hash cut off. */
function head(raw: string, n: number): string {
  return raw
    .replace(/[?#].*$/, '')
    .split(/[\\/]/)
    .filter((s) => s !== '')
    .slice(0, n)
    .join('/')
}

/**
 * The PACKAGE a location belongs to, or null.
 *
 * THE LAST `node_modules` WINS, and that is the same greedy argument `BUNDLE_ROOT_RE` makes: a
 * nested dependency lives under two of them, and the last one names the package that actually
 * holds the frame. It also means nothing to the LEFT of the boundary can survive, which is where
 * the account name lives.
 */
function packageOf(location: string): string | null {
  const i = location.toLowerCase().lastIndexOf('node_modules')
  if (i === -1) return null
  const rest = location.slice(i + 'node_modules'.length).replace(/^[\\/]/, '')
  if (rest === '') return null
  return head(rest, rest.startsWith('@') ? 2 : 1)
}

/**
 * A NON-BUNDLE frame's file, reduced to something the wire may carry: a public module name and
 * nothing else. Returns null for anything this function cannot RECOGNIZE — an eval, a `<anonymous>`
 * location, a bare absolute path with no package boundary in it — because a location we cannot
 * classify is a location we cannot promise is not somebody's home directory.
 *
 * The package arm is tried FIRST: a bundled copy of Electron lives at
 * `…\node_modules\electron\dist\…`, which both the package arm and the electron arm would match,
 * and `node_modules/electron` is the truer of the two answers.
 */
export function classifyExternalFrameFile(raw: string): string | null {
  const noScheme = raw.replace(/^file:\/{2,3}/, '')
  const pkg = packageOf(noScheme)
  if (pkg !== null) return accept(`node_modules/${pkg}`)
  // `node:electron/js2c/renderer_init` is BOTH spellings at once in current Electron; the inner
  // specifier is what the electron arm reads, so the two orders agree on one answer.
  const spec = /^node:(.+)$/.exec(noScheme)?.[1]
  const inner = spec ?? noScheme
  const el = /(?:^|[\\/])electron[\\/](.+)$/.exec(inner)
  if (el !== null) return accept(`electron/${head(el[1], 2)}`)
  if (spec !== undefined) return accept(`node:${head(spec, 3)}`)
  return null
}

/**
 * Parse a stack into at most `max` EXTERNAL frames, newest first — the same pass
 * `parseStackFrames` makes, with the other classifier. A stack yields both lists independently,
 * so an error that threw in a dependency and passed through our code appears in both, in order,
 * and neither list is a subset of the other.
 */
export function parseExternalFrames(stack: unknown, max = MAX_EXTERNAL_FRAMES): ErrorFrame[] {
  return framesFrom(stack, classifyExternalFrameFile, max)
}

// ---------------------------------------------------------------- the nested error

/** The four fields anything thrown might carry. Structurally `CaughtError` in
 *  `main/telemetry/errorReports.ts`, which is where it is consumed. */
export interface CaughtFields {
  name?: unknown
  message?: unknown
  stack?: unknown
  code?: unknown
}

/** How many wrappers deep the unwrap will look. Three covers `{ error }`, an `Error` with a
 *  `cause`, and a cause of a cause; past that a payload is not a wrapper, it is a graph. */
const MAX_UNWRAP_DEPTH = 3

/** Own properties scanned for a nested error. A bound on work, and on how much of a hostile
 *  object's shape can influence what we read. */
const MAX_UNWRAP_KEYS = 20

/** True when a value can supply a STACK — the only thing an unwrap is for. */
function hasStack(v: unknown): v is { stack: string } {
  return typeof v === 'object' && v !== null && typeof (v as { stack?: unknown }).stack === 'string'
}

/**
 * The nested Error inside a payload, if there is one. `cause` first (it is the language's own
 * spelling of "the error behind this error"), then any own property holding something with a
 * string `stack` — which is how `{ preloadPath, error }` and `{ err }` and `{ reason }` are all
 * covered without a list of blessed key names that would go stale on the next call site.
 */
function nestedOf(o: Record<string, unknown>): { stack: string } | null {
  if (hasStack(o.cause)) return o.cause
  let n = 0
  for (const key of Object.keys(o)) {
    if (++n > MAX_UNWRAP_KEYS) break
    const v = o[key]
    if (hasStack(v)) return v
  }
  return null
}

/**
 * PULL THE FOUR FIELDS out of whatever was actually thrown, following nested errors for the one
 * field the outer layer could not supply.
 *
 * THE OUTER LAYER WINS EVERY FIELD IT HAS. A wrapper that states its own message is stating the
 * thing the app meant to say, and replacing it with the inner one would trade a sentence somebody
 * wrote for a sentence a library wrote. What the inner layer contributes is the STACK, plus a
 * name and a code where the outer has none — which is exactly the `{ preloadPath, error }` case:
 * no message, no stack, no name of its own, and a whole real Error one property down.
 *
 * Total: `throw 42`, `throw null`, a circular object and a Proxy that throws on read all land
 * somewhere honest rather than throwing out of the error path.
 */
export function caughtFields(payload: unknown, depth = 0): CaughtFields {
  if (payload instanceof Error) {
    const self: CaughtFields = {
      name: payload.name,
      message: payload.message,
      stack: payload.stack,
      // Node hangs `code` off the error object; it is not on the `Error` type.
      code: (payload as unknown as { code?: unknown }).code
    }
    return typeof payload.stack === 'string' ? self : merge(self, payload, depth)
  }
  if (typeof payload === 'object' && payload !== null) {
    const o = payload as Record<string, unknown>
    return typeof o.stack === 'string' ? o : merge(o, o, depth)
  }
  // A thrown string or number is its own message and has nothing else.
  return { message: typeof payload === 'string' ? payload : String(payload) }
}

/** `outer` with the first nested error's fields filled in behind it. */
function merge(outer: CaughtFields, from: object, depth: number): CaughtFields {
  if (depth >= MAX_UNWRAP_DEPTH) return outer
  const nested = nestedOf(from as Record<string, unknown>)
  if (nested === null) return outer
  const inner = caughtFields(nested, depth + 1)
  return {
    name: outer.name ?? inner.name,
    message: outer.message ?? inner.message,
    stack: inner.stack,
    code: outer.code ?? inner.code
  }
}

// ---------------------------------------------------------------- React's component stack

/**
 * The literal `ErrorBoundary.tsx` writes ahead of `info.componentStack` when it appends it to the
 * reported `stack` and to its console line. Duplicated there rather than imported FROM there:
 * that file deliberately imports no app code (the app may be the crash source), and this file
 * bundles into a Lambda that has never heard of React. `tests/errorReportContract.test.mts` pins
 * the two spellings equal.
 *
 * A MARKER RATHER THAN A HEURISTIC. React's own component-stack lines are `at <Name> (<url>)`,
 * which is character-for-character a V8 frame — there is no way to tell the two apart by looking,
 * and guessing wrong would either lose real frames or invent components. So only a stack WE
 * marked is read as a component stack; React's dev-mode append (which carries no marker) is left
 * alone, and says so here rather than being silently half-supported.
 */
export const COMPONENT_STACK_MARKER = 'Component stack:'

/** Characters allowed in one component name, and how long it may be. */
const COMPONENT_NAME = String.raw`[A-Za-z_$][A-Za-z0-9_$.]{0,39}`

/** How many components deep the path goes. Eight is the anchor, its row, its list and the view
 *  around them — enough to place a warning, few enough that the field stays a label. */
export const MAX_COMPONENT_DEPTH = 8

/** The producer's copy of `COMPONENT_PATH_RE` (shared/telemetry.ts); pinned by the contract. */
const COMPONENT_PATH_RE = new RegExp(`^${COMPONENT_NAME}(?:>${COMPONENT_NAME}){0,7}$`)

/** Exported for the parity pin only. */
export const COMPONENT_PATH_PATTERN = COMPONENT_PATH_RE.source

/** One line of a React component stack, both of React's spellings (`at X`, and 17's `in X`). */
const COMPONENT_LINE_RE = new RegExp(String.raw`^\s*(?:at|in)\s+(${COMPONENT_NAME})`)

/**
 * The chain of COMPONENTS a React error came through, innermost first, `>`-joined —
 * `Tooltip>InventoryRow>InventoryPanel`. Undefined when the stack carries no marked component
 * stack, which is every non-React error in the app.
 *
 * HOST ELEMENTS ARE DROPPED. React's stack interleaves `div`, `span` and `li` between the
 * components, and they spend the depth budget on the one part of the tree that says nothing about
 * whose code it is. The test is the initial capital (or a dotted name like `Foo.Bar`), which is
 * React's own convention for "this is a component and not a tag".
 */
export function parseComponentPath(stack: unknown): string | undefined {
  if (typeof stack !== 'string') return undefined
  const i = stack.indexOf(COMPONENT_STACK_MARKER)
  if (i === -1) return undefined
  const names: string[] = []
  for (const raw of stack.slice(i + COMPONENT_STACK_MARKER.length).split('\n')) {
    if (names.length >= MAX_COMPONENT_DEPTH) break
    const name = COMPONENT_LINE_RE.exec(raw)?.[1]
    if (name === undefined) continue
    if (!/^[A-Z]/.test(name) && !name.includes('.')) continue
    names.push(name)
  }
  if (names.length === 0) return undefined
  const path = names.join('>')
  return COMPONENT_PATH_RE.test(path) ? path : undefined
}

// ---------------------------------------------------------------- the last-resort skeleton

/**
 * How much of the skeleton is folded into the fingerprint. Short ON PURPOSE — see below.
 */
export const MAX_MESSAGE_SKELETON = 60

/**
 * THE SHAPE OF A MESSAGE, for grouping and for nothing else.
 *
 * IT IS NEVER SENT. It exists only as an argument to `errorFingerprint`, and only when a report
 * has no location of any kind — so what leaves the machine is sixteen hex characters, exactly as
 * before. Its input is the ALREADY-REDACTED message, so even that hash is taken over a string
 * whose paths, quotes, long numbers and log lines are already placeholders.
 *
 * DELIBERATELY COARSE. Lowercased, every run of digits folded to `0`, every punctuation run
 * folded to a space, and cut at sixty characters — so `did-fail-load errorCode -105` and
 * `errorCode -3` are ONE issue while a console error and a failed load are two. The failure this
 * guards against is not collision, it is the opposite: a fingerprint that varies with the message
 * shatters one bug into a hundred singletons and burns the 20-fingerprint session bound doing it.
 */
export function messageSkeleton(redacted: string, cap = MAX_MESSAGE_SKELETON): string {
  return redacted
    .toLowerCase()
    .replace(/\d+/g, '0')
    .replace(/[^a-z0-9<>_ ]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, cap)
}

// ---------------------------------------------------------------- the never-blank belt

/**
 * WHAT A REPORT SAYS WHEN THE MESSAGE CAME OUT EMPTY (JOS-418).
 *
 * Three capture sites shipped blank families to the fleet before this — `main:gpu-process-gone`,
 * `main:render-process-gone`, and every one of their bundle-line twins across four releases — and
 * each was fixed AT THE SITE, which is the right place and the only place that can say something
 * specific. This is the belt behind those braces: it does not make a report diagnosable, it makes
 * an UNDIAGNOSABLE report say which of the app's eighty-odd `logError` calls produced it, so a
 * capture site added next year cannot ship the same silent family.
 */
export const NO_MESSAGE = '(no message)'

/**
 * The shape a `logError` source tag must have to be repeated back into a message, and the reason
 * this is a shape and not a trust decision: ONE `logError` source in the app is renderer-supplied
 * (`ipc/windowControls.ts` builds `renderer:${report.source}` out of the `error:report` IPC), so
 * "every call site passes a literal" is false and a belt that assumed it would be a free-text
 * channel out of an untrusted process.
 *
 * `main:render-process-gone`, `renderer:ErrorBoundary`, `cursorRing:preload-error`,
 * `main:stopTelemetry` — a short identifier, a colon, a short kebab identifier. No spaces, no
 * quotes, no separators, no digits worth folding: a character name, a zone, an item or a line of
 * anyone's log cannot be spelled inside it, which is the bright line held by shape exactly as
 * `alertCaptures.ts` and `classifyExternalFrameFile` hold theirs.
 *
 * IT ADDS NO EXPOSURE THAT WAS NOT ALREADY THERE, which is the JOS-353 argument in its other
 * form: the same renderer already supplies the `message` field outright, and that field is
 * redacted and transmitted. A 56-character tag-shaped string is strictly less than what it can
 * already say — and it only rides at all when it has said nothing.
 */
const SOURCE_TAG_RE = /^[A-Za-z][A-Za-z0-9]{0,23}:[A-Za-z][A-Za-z0-9-]{0,31}$/

/**
 * THE MESSAGE A REPORT WILL ACTUALLY CARRY. `redacted` when it has anything to say; otherwise the
 * stamp — `(no message) [main:render-process-gone]`, or a bare `(no message)` when even the tag
 * was not tag-shaped.
 *
 * IT IS APPLIED AFTER `redactMessage` AND MUST BE A FIXED POINT OF IT, because the server re-runs
 * the redaction and REFUSES a message that changes (`telemetryValidateError.ts`). Every byte this
 * can emit is checked against that: no path separators, no quotes, no run of five or more digits,
 * printable ASCII, no double spaces, and far inside `MAX_REDACTED_MESSAGE`. The suite pins it.
 *
 * WHY NOT THE CAPTURE-SITE FRAME. The frames are already ON the report and say it exactly; a
 * bundle position repeated into the message would be redacted down to `out<path>:<n>` on a deep
 * renderer frame and to `<n>` for its line number on every frame past 9999, which is a worse
 * answer than the app's own name for the same site.
 */
export function stampedMessage(redacted: string, source: unknown): string {
  if (redacted.trim() !== '') return redacted
  const tag = typeof source === 'string' && SOURCE_TAG_RE.test(source) ? source : null
  return tag === null ? NO_MESSAGE : `${NO_MESSAGE} [${tag}]`
}

/**
 * WHAT THE FINGERPRINT FALLS BACK ON when `frames` is empty, in the order that prefers a real
 * location to a derived one: the external frames if the stack had any, otherwise the message
 * skeleton. Returns the empty string when there is nothing at all to add, which leaves the
 * fingerprint exactly what it was before this ticket.
 */
export function fingerprintFallback(external: readonly ErrorFrame[], redacted: string): string {
  if (external.length > 0) {
    return external
      .slice(0, FINGERPRINT_FRAMES)
      .map((f) => `${f.file}:${String(f.line)}:${f.func}`)
      .join('|')
  }
  return messageSkeleton(redacted)
}
