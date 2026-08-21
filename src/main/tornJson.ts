// tornJson.ts — reading a JSON file that a torn write left behind, and doing it ONCE.
//
// EXTRACTED FROM storeFile.ts (JOS-419), not invented here. JOS-272 worked out what may and may not
// be recovered from a half-written JSON file while giving the settings store its salvage path, and
// the resist ledger (JOS-419) needs exactly the same reasoning about exactly the same failure. The
// alternative was a second copy of a string scanner whose correctness is subtle — the same argument
// storeFile.ts's own header makes for reusing `writeFileDurable` instead of re-spelling temp+rename.
//
// THE RULE THE WHOLE FILE IS BUILT AROUND, restated because it travels with the code: A SALVAGE THAT
// HALF-RESTORES IS WORSE THAN STARTING EMPTY. Everything here recovers a COMPLETE value or nothing:
//
//   * BOM and trailing padding are stripped. A torn write on Windows characteristically leaves the
//     file extended with NUL bytes; NUL is not legal JSON and this app never writes one (AGENTS.md
//     forbids the byte in source, and `JSON.stringify` escapes it), so its presence at the tail is
//     evidence of the tear and never of content.
//   * A BALANCED TOP-LEVEL OBJECT PREFIX is accepted, with whatever follows it discarded. That is
//     the signature of an in-place rewrite that was SHORTER than the file it replaced: complete new
//     content, stale old bytes behind it.
//   * REFUSED, EXPLICITLY: closing unbalanced brackets to make a truncated file parse. That is the
//     half-restore, and it is the one repair that looks the most like a fix.
//
// `balancedObjectSequence` is the one thing JOS-419 added, and it does not bend that rule: it reads
// whole ELEMENTS out of the head of an array body and stops dead at the first incomplete one. It is
// for a file whose top-level array is a list of INDEPENDENT records (the ledger's per-character
// buckets), where "the first nine of eleven buckets" is nine complete answers rather than a
// fraction of one. A caller whose array elements are not independent must not use it.
//
// PURE STRING WORK — no node:fs, no Electron, no logger. Both callers do their own I/O.

/** The padding byte a torn write leaves, SPELLED and never written literally — AGENTS.md's rule
 *  about raw control bytes in source (one in a source file makes git call it binary). */
const NUL = '\u0000'

/**
 * Drop a leading BOM and any trailing whitespace/NUL padding. Both are lossless: neither can carry
 * content, and NUL at the tail is the fingerprint of a torn write.
 *
 * Trimmed with a loop rather than a regex because a character class containing NUL is a control
 * character in a regular expression, which `no-control-regex` refuses — and rightly: the one
 * legible spelling of that byte is the named constant above.
 */
export function stripTornPadding(raw: string): string {
  const noBom = raw.replace(/^\uFEFF/, '')
  let end = noBom.length
  while (end > 0) {
    const ch = noBom.charAt(end - 1)
    if (ch !== NUL && ch.trim() !== '') break
    end--
  }
  return noBom.slice(0, end)
}

const OPENERS = '{['
const CLOSERS = '}]'

/**
 * The longest prefix of `text` that is a COMPLETE top-level `{…}`, or undefined when the object
 * never closes. String-aware (a brace inside a string value is not structure) and escape-aware.
 * Returning a prefix is the only way this file may discard bytes, and it discards only bytes that
 * come AFTER a finished object.
 */
export function balancedObjectPrefix(text: string): string | undefined {
  if (!text.startsWith('{')) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i)
    if (escaped) escaped = false
    else if (ch === '\\') escaped = inString
    else if (ch === '"') inString = !inString
    else if (inString) continue
    else if (OPENERS.includes(ch)) depth++
    else if (CLOSERS.includes(ch) && --depth === 0) return text.slice(0, i + 1)
  }
  return undefined
}

/**
 * Every COMPLETE `{…}` at the head of `text`, in order, separated by whitespace and commas — the
 * body of an array, read until the first element that does not close. `text` is expected to start
 * at the character AFTER the opening `[`.
 *
 * The stop is deliberate and total: once an element is incomplete, nothing after it can be trusted
 * to be an element boundary at all (the tear could be anywhere inside it), so the scan does not go
 * looking for the next `{`.
 */
export function balancedObjectSequence(text: string): string[] {
  const out: string[] = []
  let at = 0
  for (;;) {
    while (at < text.length && (text.charAt(at) === ',' || text.charAt(at).trim() === '')) at++
    if (at >= text.length || text.charAt(at) !== '{') return out
    const element = balancedObjectPrefix(text.slice(at))
    if (element === undefined) return out
    out.push(element)
    at += element.length
  }
}

/** What a lossless recovery found: the value, and how many bytes after it were thrown away. */
export interface SalvagedJson<T> {
  value: T
  /** Stale bytes discarded from the tail. 0 ⇒ the whole (de-padded) text parsed. */
  residue: number
}

/**
 * `JSON.parse` that answers `undefined` rather than throwing, and only for a value the caller's own
 * predicate is willing to adopt. Every salvage path funnels through it, so the validation cannot be
 * skipped.
 */
export function parseIf<T>(text: string, accept: (v: unknown) => v is T): T | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return accept(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Recover a complete top-level object from torn bytes: de-pad, parse, and failing that accept a
 * balanced object prefix with the stale tail discarded. Lossless or nothing — see the header.
 */
export function salvageJsonObject<T>(raw: string, accept: (v: unknown) => v is T): SalvagedJson<T> | undefined {
  const text = stripTornPadding(raw)
  if (text === '') return undefined
  const whole = parseIf(text, accept)
  if (whole !== undefined) return { value: whole, residue: 0 }
  const prefix = balancedObjectPrefix(text)
  if (prefix === undefined) return undefined
  const partial = parseIf(prefix, accept)
  return partial === undefined ? undefined : { value: partial, residue: text.length - prefix.length }
}

/** `…/x.json` → `…/x.corrupt.json`. Where a file that would not parse is KEPT, never deleted. */
export function quarantinePathFor(storePath: string): string {
  const stem = storePath.replace(/\.json$/i, '')
  return `${stem}.corrupt.json`
}
