// ============================================================================
// SHARED TEXT SANITIZER — the ONE definition of "characters a client may send us".
// ============================================================================
//
// WHY THIS FILE EXISTS. Sanitization used to live entirely on the CLIENT: the log scrubber
// (src/shared/logScrub.ts) and the contract's bounds (src/shared/feedback.ts) both run in the
// app before a byte leaves the machine, and the server trusted that an honest client had run
// them. A hostile or merely buggy client is not obliged to. Two concrete consequences, and this
// module closes the first of them at every boundary WE control:
//
//   1. TERMINAL ESCAPE INJECTION. `description` and the free-form `env.*` strings are rendered
//      in the OWNER's terminal by `scripts/triage-feedback.mts` and in the owner's triage tab.
//      A description carrying `ESC ] 0 ; ... BEL` retitles the operator's terminal; `ESC [ 2 J`
//      clears it; the OSC 52 sequence WRITES THE CLIPBOARD. The report is DATA. It must never
//      be able to speak to the terminal that prints it.
//   2. INVISIBLE TEXT. Zero-width joiners, the BiDi overrides (the "Trojan Source" class) and
//      the BOM let one string RENDER as another. A triage decision made on rendered text that
//      is not the stored text is a decision made on a lie.
//
// THE LAW, and it is the same law `trim` already obeys:
//
//   * STRIPPING A CONTROL CHARACTER IS NORMALIZATION, NOT TRUNCATION. A NUL, an ESC or a BiDi
//     override is not content — no user typed one into a bug report — so removing it is the
//     same class of act as removing the newline the textarea left on the end. It never shortens
//     what the user actually WROTE.
//   * REJECT, NEVER TRUNCATE still governs LENGTH (feedback.ts, plan section 8.3 step 2), and
//     it governs SINGLE-LINE fields entirely: `env.osRelease` is `os.release()`, a value with
//     no legitimate control character in it at all, so one arriving there means the payload is
//     forged and the honest answer is `invalid_payload`, not a quiet repair.
//
// PURE, like every other module in `src/shared/**`: zero imports, no `node:`, no Electron, no
// DOM. It compiles under both tsconfigs, bundles into BOTH Lambdas, and is safe to call once
// per line over a 50,000-line slice.

/* eslint-disable no-control-regex -- control characters ARE this module's subject matter.
   Every class below is written in explicit hex escapes so the source stays plain ASCII and a
   reviewer can check the code points against the tables without a hex editor. */

/**
 * ANSI/VT escape sequences, matched WHOLE so the payload (`[31m`, `]0;title`) leaves with the
 * ESC instead of being left behind as visible litter.
 *
 * Four ORDERED arms, and the order is the design:
 *   1. CSI              ESC [ params intermediates final   — colors, cursor moves, erase-display
 *   2. string-openers   ESC ] P ^ _ X … BEL|ST             — OSC (window title, and OSC 52,
 *                                                            which WRITES THE CLIPBOARD), DCS,
 *                                                            PM, APC, SOS; payload eaten whole
 *   3. nF               ESC <0x20..0x2F>+ <0x30..0x7E>     — charset selection, e.g. `ESC ( B`
 *   4. anything else    ESC <one printable>                — Fe (0x40..0x5F, the C1 twins), Fs
 *                                                            (0x60..0x7E, incl. `ESC c` = full
 *                                                            terminal reset), Fp private forms
 *
 * Arm 4 is the catch-all ON PURPOSE: an ESC this file does not recognise must still lose its
 * ESC. A malformed CSI/OSC falls out of arms 1–2 into it and is defanged rather than passed
 * through. A trailing lone ESC matches nothing here and is deleted by the control class below,
 * as are the C1 single-byte equivalents (0x9B CSI, 0x9D OSC).
 */
const ANSI_RE =
  /\x1B(?:\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]|[\]P^_X][^\x07\x1B]*(?:\x07|\x1B\\)?|[\x20-\x2F]+[\x30-\x7E]|[\x20-\x7E])/g

/** Every C0 control, DEL, and every C1 control. Nothing in this class is content. */
const CONTROL_ANY_RE = /[\x00-\x1F\x7F-\x9F]/g

/** The same class MINUS TAB (0009) and LF (000A) — the two a multi-line report may keep. */
const CONTROL_BLOCK_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g

/** The same class MINUS TAB ALONE — for ONE LINE of a tab-separated table (see
 *  `sanitizeTabbedLine`). LF and CR are in it: a line that contains one is not a row. */
const CONTROL_BLOCK_TAB_RE = /[\x00-\x08\x0A-\x1F\x7F-\x9F]/g

/** CR and CRLF, normalized to LF before anything else looks at the string. */
const NEWLINE_RE = /\x0D\x0A?/g

/* eslint-enable no-control-regex */

/**
 * Characters that render as nothing, or that reorder what renders around them:
 * ZWSP/ZWNJ/ZWJ and the LRM/RLM marks (200B-200F), LINE and PARAGRAPH SEPARATOR plus the BiDi
 * embeddings and OVERRIDES (2028-202E), the word joiner and the invisible operators (2060-2064),
 * the BiDi isolates (2066-2069), and the BOM/ZWNBSP (FEFF).
 */
const INVISIBLE_RE = /[\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g

/** In a ONE-LINE rendering these three become a single space; every other control is deleted. */
const AS_SPACE = new Set(['\t', '\n', '\r'])

/**
 * A NUL anywhere in a RAW request body, tested BEFORE `JSON.parse` by both ingest Lambdas.
 *
 * Cheap, crude, and in front of everything else on purpose. Nothing on either wire can
 * legitimately contain a NUL; JSON parsers and postgres `text` columns do not agree about what
 * an embedded one means; and a body we have already measured costs one more scan to check. The
 * shared validators are still what govern the PARSED values — this only refuses the bodies that
 * are obviously not ours before a parser has to have an opinion about them.
 */
export function hasNulByte(raw: string): boolean {
  return raw.includes(String.fromCharCode(0))
}

/** Strip ANSI/VT escape sequences whole. Exported by name because the CLI asks for it by name. */
export function stripAnsi(raw: string): string {
  return raw.replace(ANSI_RE, '')
}

/**
 * The WIRE predicate for a SINGLE-LINE field (`env.platform`, `env.osRelease`, `env.arch`,
 * `env.electron`, `env.chrome`, `env.node`).
 *
 * True for ANY control character — INCLUDING TAB and LF, which a runtime string like
 * `process.arch` cannot legitimately contain — and for any invisible formatting character.
 * Callers trim FIRST (surrounding whitespace is normalization, exactly as it always was) and
 * then reject on this: a control character surviving in the INTERIOR of `os.release()` is not a
 * formatting accident, it is a forged payload.
 */
export function hasWireControls(raw: string): boolean {
  // `.test` on a /g regex is stateful; resetting the index makes these functions total.
  CONTROL_ANY_RE.lastIndex = 0
  INVISIBLE_RE.lastIndex = 0
  return CONTROL_ANY_RE.test(raw) || INVISIBLE_RE.test(raw)
}

/**
 * The WIRE normalizer for the one MULTI-LINE field (`draft.description`), and the display
 * normalizer for that same text afterwards. Keeps TAB and LF; removes everything else that is
 * not content, in this order:
 *
 *   CRLF/CR -> LF, then ANSI sequences whole, then C0 (minus TAB/LF) + DEL + C1, then invisibles.
 *
 * NOT trimmed here — the CALLER trims, because the trim and the length bound that follows it
 * are the contract's rules and belong in the contract.
 */
export function sanitizeMultiline(raw: string): string {
  return stripAnsi(raw.replace(NEWLINE_RE, '\n'))
    .replace(CONTROL_BLOCK_RE, '')
    .replace(INVISIBLE_RE, '')
}

/**
 * The DISPLAY normalizer for anything that must occupy exactly one line: an `env.*` value in a
 * detail pane, a description collapsed into a CLI list row, a log line in the slice box.
 *
 * Newlines and tabs become a single space — a report must not be able to forge extra rows in a
 * table — and every other control and invisible character is deleted, ANSI sequences whole.
 */
export function sanitizeOneLine(raw: string): string {
  return stripAnsi(raw)
    .replace(NEWLINE_RE, '\n')
    .replace(CONTROL_ANY_RE, (c) => (AS_SPACE.has(c) ? ' ' : ''))
    .replace(INVISIBLE_RE, '')
}

/**
 * ONE LINE OF A TAB-SEPARATED TABLE THE GAME ITSELF WROTE — today exactly one caller, the
 * `/outputfile inventory` dump (`src/main/triage/rows.ts sanitizeInventory`, JOS-404).
 *
 * WHY TAB SURVIVES HERE AND NOWHERE ELSE, because that is the only interesting thing about this
 * function. `sanitizeOneLine` folds TAB to a space so that a REPORTER'S OWN TEXT — a description,
 * an `env.*` value, a log line — cannot forge columns in a table the CLI is drawing. An inventory
 * export is the opposite kind of string: the TABS ARE THE FORMAT (`Location<TAB>Name<TAB>ID<TAB>
 * Count<TAB>Slots`, the shape measured in `src/main/feedback/inventory.ts`'s header), the columns
 * are the game's and not the reporter's, and the file is not drawn into a table at all — it is
 * written to disk for the owner to read and to feed back through the app's own dump parser.
 * Folding the tabs there destroyed the structure AND made "this line carried a control character"
 * true of every honest row, which is a warning that fires always and therefore says nothing.
 *
 * Everything else `sanitizeOneLine` removes is still removed, and for its own reason: the dump is
 * text the app did not write and an operator will eventually `cat`. ANSI sequences go whole, then
 * C0 (minus TAB) + DEL + C1 — LF and CR included, so the output IS one line — then the invisibles.
 *
 * DO NOT widen `sanitizeOneLine` to match this. The narrowness is the guarantee.
 */
export function sanitizeTabbedLine(raw: string): string {
  return stripAnsi(raw).replace(CONTROL_BLOCK_TAB_RE, '').replace(INVISIBLE_RE, '')
}

/**
 * `sanitizeTabbedLine`'s flagging twin — `sanitizeAndFlag` for a table row. The caller counts the
 * lines that changed and reports the count as evidence, so it needs the fact, not a second pass.
 */
export function sanitizeTabbedAndFlag(raw: string): { text: string; changed: boolean } {
  const text = sanitizeTabbedLine(raw)
  return { text, changed: text !== raw }
}

/**
 * DEFENSE IN DEPTH FOR LEGACY ROWS AND RAW UPLOADS. Rows written before the wire rules above
 * existed can carry anything, and so can a slice a client POSTed straight at the presigned URL
 * without ever running the scrubber. Every owner-side reader that turns a stored value into
 * something a human will look at runs it through here, so the hardening does not depend on
 * which front end happens to be reading.
 *
 * Returns the sanitized text AND whether it changed, so a caller that wants to report the delta
 * (the slice re-scrub does, loudly) gets the fact for free instead of comparing twice.
 */
export function sanitizeAndFlag(raw: string): { text: string; changed: boolean } {
  const text = sanitizeOneLine(raw)
  return { text, changed: text !== raw }
}
