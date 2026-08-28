/**
 * rustFactoring.mts — MEASURING the engine's Rust the way ESLint measures the TypeScript (JOS-523).
 *
 * The gate that reads this is `scripts/checkRustFactoring.mts` (`npm run check:rust-factoring`).
 * The bars are the TS side's, unchanged: `eslint.config.mjs`'s FACTORING_RULES, whose header argues
 * every number against a measured distribution. This file only says how the same three numbers are
 * COUNTED on the other side of the wire.
 *
 * ── THE COUNTING RULES, in full ───────────────────────────────────────────────────────────────
 *
 * CODE LINES. A line counts when something survives after comments are erased — line comments,
 * doc comments and nested block comments all go, blanks never counted. String and char literals
 * SURVIVE as
 * placeholder text, so a line holding nothing but `"a literal"` is still a line of code (and a `//`
 * inside a string is not a comment). Identical to ESLint's `skipBlankLines` + `skipComments`, and
 * deliberate: the metric is CODE mass, so the comment-pruning waves cannot move these numbers.
 *
 * FUNCTIONS are `fn name…` items with a BODY. A trait method signature or an `extern` declaration
 * ends in `;` and is not a function. Length runs from the `fn` keyword's line to the closing
 * brace's line, code lines only, and INCLUDES any nested `fn` — ESLint's rule, same reason: a
 * function you had to nest something inside is still that long to read. Closures are NOT separate
 * functions; they are measured as part of the `fn` that holds them.
 *
 * COMPLEXITY is cyclomatic, base 1, over the body with nested `fn` bodies removed (ESLint again:
 * the inner function carries its own score). One point each for `if`, `while`, `for`, `loop`, every
 * `match` arm except the `_` wildcard (the arm ESLint spares as `default:`), every `&&`, and every
 * `||` that is an OR rather than an empty closure's parameter list — told apart by the character
 * before it, since Rust spells both with the same two pipes. Deliberately NOT counted: `?`, which
 * is error propagation rather than a branch the reader has to hold, and would price idiomatic Rust
 * out of any threshold worth having.
 *
 * WHAT IS MEASURED: every `.rs` file under `engine/crates`, minus `generated.rs` (written by
 * `npm run gen:protocol`; nobody edits it, so it cannot carry debt) and minus every per-crate
 * `tests` directory. Inline `#[cfg(test)] mod tests` blocks in a `src` file DO count — mass in
 * that file, they are what the owner's 2026-08-27 measurement counted, and carving them out would
 * make a 1,600-line file's number depend on where its author chose to put the tests.
 */

/** One `fn` with a body, qualified by every named scope around it (`Ops::dispatch`). */
export interface RustFunction {
  name: string
  /** 1-based line of the `fn` keyword. */
  line: number
  /** Code lines from the `fn` keyword's line through the closing brace's, inclusive. */
  lines: number
  complexity: number
}

export interface RustFileMetrics {
  /** Code lines in the whole file. */
  lines: number
  functions: RustFunction[]
  /**
   * Braces that never closed. The scanner is a lexer, not a Rust parser, so it says when it lost
   * the thread instead of quietly reporting a wrong number. The gate treats it as a failure.
   */
  unbalanced: boolean
}

const IDENT = /[A-Za-z0-9_]/
/** What a real `||` follows. Anything else (`(`, `,`, `=`, `|`) opens a no-argument closure. */
const OR_FOLLOWS = /[A-Za-z0-9_)\]"'#?]/

// ── blanking ───────────────────────────────────────────────────────────────────────────────────

function endOfBlockComment(src: string, from: number): number {
  let depth = 0
  let i = from
  while (i < src.length) {
    if (src.startsWith('/*', i)) {
      depth++
      i += 2
    } else if (src.startsWith('*/', i)) {
      depth--
      i += 2
      if (depth === 0) return i
    } else i++
  }
  return src.length
}

function endOfString(src: string, from: number): number {
  let i = from + 1
  while (i < src.length) {
    if (src[i] === '\\') i += 2
    else if (src[i] === '"') return i + 1
    else i++
  }
  return src.length
}

/** How many `#` a raw-string opener at `i` carries (`r"` → 0, `br##"` → 2), or -1 if it is not one. */
function rawStringHashes(src: string, i: number): number {
  if (src[i] !== 'r') return -1
  const prev = i === 0 ? ' ' : src[i - 1]
  const bytePrefixed = prev === 'b' || prev === 'c'
  if (IDENT.test(prev) && !bytePrefixed) return -1
  if (bytePrefixed && i > 1 && IDENT.test(src[i - 2])) return -1
  let j = i + 1
  while (src[j] === '#') j++
  return src[j] === '"' ? j - i - 1 : -1
}

function endOfRawString(src: string, from: number, hashes: number): number {
  const close = `"${'#'.repeat(hashes)}`
  const at = src.indexOf(close, from + hashes + 2)
  return at < 0 ? src.length : at + close.length
}

/**
 * End of a CHAR literal at `i`, or -1 when that quote opens a LIFETIME (`'a`, `'static`, `'outer:`)
 * — the one place Rust reuses a string delimiter for something that never closes.
 */
function endOfCharLiteral(src: string, i: number): number {
  const rest = src.slice(i + 1, i + 14)
  if (rest.startsWith('\\')) {
    const q = rest.indexOf("'", 1)
    return q < 0 ? -1 : i + q + 2
  }
  const first = rest.codePointAt(0)
  if (first === undefined) return -1
  const width = String.fromCodePoint(first).length
  return rest[width] === "'" ? i + width + 2 : -1
}

/**
 * One array slot per UTF-16 UNIT, which is what every index in this file means. Spreading a string
 * would split it by CODE POINT instead, and one emoji in a comment would silently shift every
 * offset after it by one.
 */
function units(src: string): string[] {
  const out = new Array<string>(src.length)
  for (let i = 0; i < src.length; i++) out[i] = src[i]
  return out
}

function fill(out: string[], from: number, to: number, ch: string): number {
  for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ch
  return to
}

/** Erase a literal's CONTENTS but keep its outer characters, so a literal-only line stays code. */
function hollow(out: string[], from: number, to: number): number {
  fill(out, from + 1, to - 1, '.')
  return to
}

function blankAt(src: string, out: string[], i: number): number {
  const c = src[i]
  if (c === '/' && src[i + 1] === '/') {
    const nl = src.indexOf('\n', i)
    return fill(out, i, nl < 0 ? src.length : nl, ' ')
  }
  if (c === '/' && src[i + 1] === '*') return fill(out, i, endOfBlockComment(src, i), ' ')
  const hashes = rawStringHashes(src, i)
  if (hashes >= 0) return hollow(out, i, endOfRawString(src, i, hashes))
  if (c === '"') return hollow(out, i, endOfString(src, i))
  if (c !== "'") return i
  const end = endOfCharLiteral(src, i)
  return end < 0 ? i : hollow(out, i, end)
}

/**
 * The file with every comment turned to blanks and every literal's insides turned to dots. Line
 * numbers, brace nesting and keyword positions all survive; nothing that only LOOKS like code does.
 */
export function blankNonCode(src: string): string {
  const out = units(src)
  let i = 0
  while (i < src.length) {
    const next = blankAt(src, out, i)
    i = next > i ? next : i + 1
  }
  return out.join('')
}

// ── the scan ───────────────────────────────────────────────────────────────────────────────────

interface Pending {
  name: string
  start: number
}
interface Frame {
  label: string
  open: number
  fn: Pending | null
}
interface RawFn {
  name: string
  start: number
  body: number
  end: number
}
interface Scan {
  stack: Frame[]
  nesting: number
  boundary: number
  pending: Pending | null
  found: RawFn[]
}

/** The name a block contributes to what is inside it: the impl'd type, or the module/trait. */
function labelOf(header: string): string {
  const implFor = /\bimpl\b[\s\S]*\bfor\s+(?:&\s*)?(?:mut\s+)?([A-Za-z_]\w*)/.exec(header)
  if (implFor !== null) return implFor[1]
  const implPlain = /\bimpl\b\s*(?:<[^<>]*>)?\s*([A-Za-z_]\w*)/.exec(header)
  if (implPlain !== null) return implPlain[1]
  const named = /\b(?:mod|trait)\s+([A-Za-z_]\w*)/.exec(header)
  return named === null ? '' : named[1]
}

function openBrace(s: Scan, text: string, i: number): void {
  const label = s.pending === null ? labelOf(text.slice(s.boundary, i)) : s.pending.name
  s.stack.push({ label, open: i, fn: s.pending })
  s.pending = null
  s.boundary = i + 1
}

function closeBrace(s: Scan, i: number): void {
  const frame = s.stack.pop()
  s.boundary = i + 1
  if (frame?.fn == null) return
  const scope = s.stack
    .map((f) => f.label)
    .filter((l) => l !== '')
    .join('::')
  const name = scope === '' ? frame.fn.name : `${scope}::${frame.fn.name}`
  s.found.push({ name, start: frame.fn.start, body: frame.open, end: i + 1 })
}

function step(s: Scan, text: string, i: number, fnAt: Map<number, string>): void {
  const named = fnAt.get(i)
  if (named !== undefined && s.pending === null) s.pending = { name: named, start: i }
  const c = text[i]
  if (c === '(' || c === '[') s.nesting++
  else if (c === ')' || c === ']') s.nesting--
  else if (s.nesting > 0) return
  else if (c === '{') openBrace(s, text, i)
  else if (c === '}') closeBrace(s, i)
  else if (c === ';') {
    // A `fn` that reached a top-level `;` was a signature, not a function.
    s.pending = null
    s.boundary = i + 1
  }
}

function scanFunctions(text: string): { fns: RawFn[]; unbalanced: boolean } {
  const fnAt = new Map<number, string>()
  for (const m of text.matchAll(/\bfn\s+([A-Za-z_]\w*)/g)) fnAt.set(m.index, m[1])
  const s: Scan = { stack: [], nesting: 0, boundary: 0, pending: null, found: [] }
  for (let i = 0; i < text.length; i++) step(s, text, i, fnAt)
  return { fns: s.found, unbalanced: s.stack.length !== 0 }
}

// ── the metrics ────────────────────────────────────────────────────────────────────────────────

/**
 * The `||` that are an OR rather than an empty closure's parameter list. Rust spells both with the
 * same two pipes, so the tell is what comes BEFORE: an OR follows a value, a closure follows the
 * punctuation that opens an argument. `move ||` and `return ||` are the two closures that end in a
 * word and would otherwise read as values — measured on the tree, they are the only ones.
 */
function countLogicalOr(text: string): number {
  let n = 0
  for (const m of text.matchAll(/\|\|/g)) {
    const before = text.slice(Math.max(0, m.index - 40), m.index).trimEnd()
    if (OR_FOLLOWS.test(before.slice(-1)) && !/\b(?:move|return)$/.test(before)) n++
  }
  return n
}

function countMatches(text: string, re: RegExp): number {
  return [...text.matchAll(re)].length
}

/** Cyclomatic complexity of one body's OWN text — see the header for what earns a point. */
export function complexityOf(body: string): number {
  const arms = countMatches(body, /=>/g) - countMatches(body, /(?:^|[^A-Za-z0-9_])_\s*=>/g)
  const keywords = countMatches(body, /\b(?:if|while|for|loop)\b/g)
  return 1 + keywords + arms + countMatches(body, /&&/g) + countLogicalOr(body)
}

function lineIndex(text: string): { lineOf: (i: number) => number; code: boolean[] } {
  const lines = text.split('\n')
  const starts: number[] = []
  let at = 0
  for (const line of lines) {
    starts.push(at)
    at += line.length + 1
  }
  const lineOf = (i: number): number => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= i) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  return { lineOf, code: lines.map((l) => l.trim() !== '') }
}

/** The body of `fn` with every nested `fn` erased, so the inner one's branches are not counted twice. */
function ownBody(text: string, fn: RawFn, all: RawFn[]): string {
  const chars = units(text.slice(fn.body, fn.end))
  for (const other of all) {
    if (other === fn || other.start < fn.start || other.end > fn.end) continue
    fill(chars, other.start - fn.body, other.end - fn.body, ' ')
  }
  return chars.join('')
}

/** Measure one Rust source file. `src` is the raw file text. */
export function measureRustSource(src: string): RustFileMetrics {
  const text = blankNonCode(src)
  const { lineOf, code } = lineIndex(text)
  const { fns, unbalanced } = scanFunctions(text)
  const seen = new Map<string, number>()
  const functions = fns.map((fn) => {
    const first = lineOf(fn.start)
    const last = lineOf(fn.end - 1)
    let lines = 0
    for (let l = first; l <= last; l++) if (code[l]) lines++
    const count = (seen.get(fn.name) ?? 0) + 1
    seen.set(fn.name, count)
    return {
      // Two same-named items in one file (`new` on two types, `fmt` twice) get a stable ordinal
      // rather than a line number, which the comment waves would move under the baseline.
      name: count === 1 ? fn.name : `${fn.name}#${String(count)}`,
      line: first + 1,
      lines,
      complexity: complexityOf(ownBody(text, fn, fns)),
    }
  })
  return { lines: code.filter(Boolean).length, functions, unbalanced }
}
