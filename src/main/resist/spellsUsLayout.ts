// spellsUsLayout.ts — which column layout a client's spells_us.txt is in.
//
// THE 2026-10-13 GAME PATCH INSERTED ONE COLUMN somewhere in fields 52..75. Measured on the
// owner's patched install: the icon moved 75 -> 76, the resist adjustment 78 -> 79 and the effect
// slots 172 -> 173, while everything up to the class levels (36..51) stayed put. No reader takes
// a field in 52..74, so dropping ONE column at 52 from every row of a patched file puts every field
// a reader takes back where the parsers expect it, whichever column the patch actually added. The
// exact insertion point is not needed and is not claimed.
//
// THE LAYOUT IS READ FROM THE FILE, not assumed, so an unpatched client (or a test's 173-field
// rows) parses exactly as before: the effect-slot list (`1|35|1|0|100|0$2|...`) sits in 172 in
// the old layout and in 173 in the new one, and the majority over a sample of rows decides.
// The engine's Rust reader carries the same rule (fold/src/spells_us_layout.rs).

/** Where the extra column is dropped from a patched row. Any index in 52..75 restores every read field. */
export const INSERTED_COLUMN = 52
const OLD_SLOTS = 172
const NEW_SLOTS = 173
/** Rows sampled to decide; the effect lists start within the first few hundred rows. */
const SAMPLE_ROWS = 4000
const SLOT_LIST = /^\d+\|/

/** True when the file is in the patched (2026-10-13) layout. */
export function spellsUsShifted(text: string): boolean {
  let oldVotes = 0
  let newVotes = 0
  let seen = 0
  for (const line of text.split('\n', SAMPLE_ROWS)) {
    const f = line.split('^')
    if (f.length <= OLD_SLOTS) continue
    seen += 1
    if (SLOT_LIST.test(f[OLD_SLOTS])) oldVotes += 1
    else if (f.length > NEW_SLOTS && SLOT_LIST.test(f[NEW_SLOTS])) newVotes += 1
  }
  return seen > 0 && newVotes > oldVotes
}

/** A row's fields in the layout the readers index: the inserted column dropped from a patched row. */
export function unshiftRow(f: string[], shifted: boolean): string[] {
  if (shifted && f.length > INSERTED_COLUMN) f.splice(INSERTED_COLUMN, 1)
  return f
}
