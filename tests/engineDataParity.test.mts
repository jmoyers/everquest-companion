// ============================================================================
// engineDataParity.test.mts — the Rust parser's two duplications, kept honest (JOS-469).
// ============================================================================
//
// `engine/crates/eqlog` is a port of the TypeScript parse pass, and it reads the two big committed
// datasets — `spells.json` and `messageOverlay.baseline.json` — by `include_str!` straight out of
// `src/main/data/`, so there is exactly one copy of each and a re-scrape reaches both readers.
//
// TWO THINGS COULD NOT BE SHARED THAT WAY, and this suite is the tripwire for both:
//
//   1. THE OVERLAY LISTS. `SPELL_REMOVALS` and `SPELL_CORRECTIONS` are TypeScript arrays with prose
//      attached, so nothing in Rust can import them. `scripts/gen-engine-spell-overlay.mts` projects
//      the fields the parser's output depends on into a committed sidecar. A list that moved without
//      the sidecar means the two implementations are reading DIFFERENT spell databases.
//
//   2. THE SMALL TABLES the cascade matches by equality: the poison roster, the poison-proc emote
//      suffixes, the two dry lines, the consider ladder and the six pet-voiced says. Each is
//      transcribed into `engine/crates/eqlog/src/parse/`, and each is a set of exact sentences that
//      a re-scrape or a feature ticket can add to.
//
// WHY THIS SUITE RATHER THAN THE ORACLE. `npm run oracle:rust-parser` catches both — byte identity
// over the owner's real log is the strongest check there is — but it needs the gitignored corpus, so
// it runs on ONE machine and never in CI. This runs everywhere, on every push, and it fails the
// moment a list moves rather than the next time somebody remembers to re-check parity.
//
// WHAT IT DELIBERATELY DOES NOT CHECK: the Rust CODE. Reading string literals out of a source file
// proves the VOCABULARY matches; it proves nothing about what the parser does with it, and pretending
// otherwise would be worse than the gap. The oracle is what checks behaviour.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderSidecar, SIDECAR } from '../scripts/gen-engine-spell-overlay.mjs'
import { POISONS, POISON_DRY_MSG, POISON_PROCS } from '../src/shared/poisons'
import { CONSIDER_FACTION_RUNGS } from '../src/shared/considerFaction'
import { PET_SAY_LINES } from '../src/shared/logScrub'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CRATE = join(ROOT, 'engine', 'crates', 'eqlog', 'src')

/** One Rust source file's text. */
const rust = (...parts: string[]): string => readFileSync(join(CRATE, ...parts), 'utf8')

/**
 * Every double-quoted Rust string literal in a file, unescaped for the two escapes these tables
 * actually use. Deliberately crude: the tables it reads are flat lists of plain sentences, and a
 * general Rust lexer here would be a second thing to be wrong about.
 */
function rustStrings(src: string): Set<string> {
  const out = new Set<string>()
  for (const m of src.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    out.add(m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
  }
  return out
}

test('the spell-overlay sidecar is what the TypeScript lists render today', () => {
  const committed = readFileSync(SIDECAR, 'utf8').replace(/\r\n/g, '\n')
  assert.equal(
    committed,
    renderSidecar(),
    'engine/crates/eqlog/data/spell-overlay.json is stale — run `npm run gen:engine-spell-overlay`, ' +
      'rebuild the crate, re-run `npm run oracle:rust-parser`, and commit the result. ' +
      'Until then the Rust parser and the TS parser are reading two different spell databases.'
  )
})

test('every poison coat line the roster states is a literal the crate can match', () => {
  const have = rustStrings(rust('parse', 'data.rs'))
  for (const p of POISONS) {
    assert.ok(have.has(p.coatMsg), `parse/data.rs is missing the coat line for ${p.name}`)
    assert.ok(have.has(p.name), `parse/data.rs is missing the poison name ${p.name}`)
  }
  // …and the crate carries no coat line the roster has since dropped: a stale sentence would name a
  // poison that no longer exists, which is the same defect pointing the other way.
  const coatLines = [...have].filter((s) => s.startsWith('You coat your blades '))
  assert.deepEqual(
    coatLines.sort(),
    POISONS.map((p) => p.coatMsg).sort(),
    'parse/data.rs and shared/poisons.ts disagree about the coat vocabulary'
  )
})

test('the two dry lines and every proc emote suffix are transcribed exactly', () => {
  const have = rustStrings(rust('parse', 'data.rs'))
  for (const line of Object.keys(POISON_DRY_MSG)) {
    assert.ok(have.has(line), `parse/data.rs is missing the dry line "${line}"`)
  }
  const suffixes = [...have].filter((s) => POISON_PROCS.some((p) => p.suffix === s))
  assert.equal(
    suffixes.length,
    POISON_PROCS.length,
    'parse/data.rs is missing a poison-proc emote suffix — its `strike` would go unnamed'
  )
  for (const p of POISON_PROCS) {
    for (const strike of p.strikes) {
      assert.ok(have.has(strike), `parse/data.rs is missing the strike name ${strike}`)
    }
    assert.ok(have.has(p.effect), `parse/data.rs is missing the effect class ${p.effect}`)
  }
})

test('the consider ladder is transcribed IN LADDER ORDER, which the alternation depends on', () => {
  const src = rust('parse', 'data.rs')
  const table = /CONSIDER_FACTION_RUNGS[^=]*=\s*\[(.*?)\];/s.exec(src)
  assert.ok(table, 'parse/data.rs no longer states CONSIDER_FACTION_RUNGS')
  const pairs = [...table[1].matchAll(/\("([^"]+)",\s*"([^"]+)"\)/g)].map((m) => [m[1], m[2]])
  assert.deepEqual(
    pairs,
    CONSIDER_FACTION_RUNGS.map((r) => [r.phrase, r.faction]),
    'the crate and shared/considerFaction.ts disagree about the con ladder or its order'
  )
})

test('the six pet-voiced says are transcribed exactly, kind and sentence', () => {
  const src = rust('parse', 'casts.rs')
  const table = /PET_SAY_LINES[^=]*=\s*\[(.*?)\n\];/s.exec(src)
  assert.ok(table, 'parse/casts.rs no longer states PET_SAY_LINES')
  const said = rustStrings(table[1])
  for (const [kind, sentence] of PET_SAY_LINES) {
    assert.ok(said.has(sentence), `parse/casts.rs is missing the pet say "${sentence}"`)
    assert.ok(said.has(kind), `parse/casts.rs is missing the pet-say kind ${kind}`)
  }
  assert.equal(
    said.size,
    PET_SAY_LINES.length * 2,
    'parse/casts.rs carries a pet say shared/logScrub.ts does not — a loose /Master/ leaks mob flavor'
  )
})
