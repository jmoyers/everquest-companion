/**
 * gen-engine-spell-overlay.mts — project the TWO TypeScript overlay LISTS into the sidecar the Rust
 * parser reads (JOS-469).
 *
 * `engine/crates/eqlog` loads the SAME committed `spells.json` and `messageOverlay.baseline.json`
 * the app does, by `include_str!`, so those two have exactly one copy each. `SPELL_REMOVALS` and
 * `SPELL_CORRECTIONS` are not JSON — they are TypeScript arrays with prose attached — and nothing
 * on the Rust side can import them. This writes the fields the PARSER's output depends on into
 * `engine/crates/eqlog/data/spell-overlay.json`.
 *
 * WHAT IS PROJECTED, and what is deliberately dropped: `attribution` and `evidence` are the
 * argument for a correction, not an input to it, and `verified`/`reason`/`supersededBy` are the
 * argument for a removal. The load path reads `spells` / `field` / `from` / `to`, and `spell`. A
 * `classes` correction is carried anyway even though no classifier reads that field, because
 * `rowsFor` treats it like `name`/`spellType` and dropping it would make the two sides' row
 * accounting differ for a reason that is invisible until it isn't.
 *
 * DRIFT IS CAUGHT TWICE. `npm run oracle:rust-parser` regenerates this file and refuses to compare
 * when the committed copy is stale; and a list that moved without the sidecar moves the TS goldens,
 * so byte-identity fails on the next check either way.
 *
 * The output is LF-normalized and ends with a newline, on JOS-458's ruling: a line ending is not a
 * data change and must not make two checkouts disagree about a committed artifact.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SPELL_CORRECTIONS } from '../src/main/data/spellCorrections'
import { SPELL_REMOVALS } from '../src/main/data/spellRemovals'

const ROOT = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
export const SIDECAR = join(ROOT, 'engine', 'crates', 'eqlog', 'data', 'spell-overlay.json')

/** The sidecar's bytes, as the generator would write them right now. */
export function renderSidecar(): string {
  const body = {
    removals: SPELL_REMOVALS.map((r) => r.spell),
    corrections: SPELL_CORRECTIONS.map((c) => ({
      spells: [...c.spells],
      field: c.field,
      from: c.from,
      to: c.to
    }))
  }
  return JSON.stringify(body, null, 2) + '\n'
}

/** Write it. Returns true when the bytes on disk changed. */
export function writeSidecar(): boolean {
  const next = renderSidecar()
  const prev = existsSync(SIDECAR) ? readFileSync(SIDECAR, 'utf8').replace(/\r\n/g, '\n') : ''
  if (prev === next) return false
  mkdirSync(dirname(SIDECAR), { recursive: true })
  writeFileSync(SIDECAR, next, 'utf8')
  return true
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const changed = writeSidecar()
  console.log(
    `[gen-engine-spell-overlay] ${changed ? 'REWROTE' : 'unchanged'} ${SIDECAR} — ` +
      `${String(SPELL_REMOVALS.length)} removals, ${String(SPELL_CORRECTIONS.length)} corrections.`
  )
}
