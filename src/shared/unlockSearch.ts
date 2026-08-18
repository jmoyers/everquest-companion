// UNLOCK SEARCH — the "New at this level" panel's OTHER question (JOS-392).
//
// The panel answers "what does level 27 give MY loadout". This is the same rows answering a
// different question: "where does <this> sit in the game" — typed as a spell name, a class, a
// level or a band, in any order (`27-28 cleric shaman`). The grammar is
// `shared/spellSearch.ts` (one tokenizer for both search boxes in the app); this file is the
// PROJECTION: which spells survive the query, and what each surviving row says.
//
// FOUR DECISIONS, and each of them is about what a row is a claim about:
//
//   CHIPS ARE PER CLASS, WITH LEVELS. A level row is drawn AT a level and its chips need no
//   numbers. A search row is drawn at no level at all, so it carries every class the DB places it
//   for and the level each one gets it at — `CLR 24 · PAL 30`, the shape the spell card already
//   prints (`spellClassLine`). That is `UnlockRow.levels`, and its presence is what tells the row
//   component it is drawing a search result.
//
//   THE CONTEXT LINES STAY SCOPED TO THE CHARACTER. `already yours`, `replaces` and `memorized`
//   are claims about THIS trio, so they are computed over the loadout classes and nothing else — a
//   search that lists every class's Complete Heal must not tell a cleric what a paladin replaces.
//   With no loadout resolved the lines simply do not appear; the figures still do, because
//   `dmg 143 · 2.1 dmg/mana` is a fact about the spell.
//
//   `already yours` IS READ AGAINST THE CHARACTER'S OWN LEVEL, not against a level on screen —
//   there is no level on screen here. A loadout class that reaches this spell at or below the level
//   the character has actually reached owns it; anything above is a spell to look forward to and
//   the row says nothing about it.
//
//   SORTED BY THE LOWEST MATCHING LEVEL. `27-28 cleric shaman` sorts by the cleric/shaman level
//   inside the band, never by a wizard's level at 12 — the same `matchedClassLevels` the matcher
//   used to admit the row, so the order can never disagree with the reason a row is there.
//
// CAPPED, AND THE CAP SAYS SO. A bare `27` matches hundreds of rows; mounting them all would make
// the panel the tallest thing on the tab. The caller draws `+N more, refine your search`.
//
// Pure, dependency-free, RELATIVE value imports (the mobSearch.ts precedent) so `npm test` drives
// it over the REAL committed dataset with no Electron and no vite alias.

import type { ClassAbbr } from './classCombo'
import type { UnlockRow, UnlockSpell } from './levelUnlocks'
import {
  compileSpellQuery,
  matchedClassLevels,
  matchesCompiledQuery,
  type CompiledSpellQuery,
  type SearchClassLevel,
  type SearchableSpell,
  type SpellSearchToken
} from './spellSearch'

/** Most result rows the panel mounts at once. Beyond it the reader is told what is not shown. */
export const UNLOCK_SEARCH_CAP = 100

/** What the character brings to the query — the only reason a row can make a claim about YOU. */
export interface UnlockSearchContext {
  /** the loadout classes (resolved ∪ candidates); empty when nothing is known yet */
  classes: readonly ClassAbbr[]
  /** the character's current level, or null — the `already yours` cutoff */
  currentLevel: number | null
}

/** The rows to draw, and the honest count behind them. */
export interface UnlockSearchResults {
  rows: UnlockRow[]
  /** how many spells MATCHED — `rows.length` when the cap did not bite */
  matched: number
  /** matched − rows.length: what the `+N more` line is about */
  hidden: number
}

export const EMPTY_UNLOCK_SEARCH: UnlockSearchResults = { rows: [], matched: 0, hidden: 0 }

/** The unlock row as the shared matcher reads it. `usageCount` is absent by design — see below. */
function searchable(spell: UnlockSpell): SearchableSpell {
  return {
    name: spell.name,
    searchText: spell.searchText ?? spell.name.toLowerCase(),
    spellType: spell.spellType,
    illusion: spell.illusion,
    classLevels: spell.at
  }
}

/** One class per entry at its LOWEST stated level, ascending by level then class code. */
function foldLevels(pairs: readonly SearchClassLevel[]): SearchClassLevel[] {
  const lowest = new Map<ClassAbbr, number>()
  for (const p of pairs) {
    const seen = lowest.get(p.cls)
    if (seen === undefined || p.level < seen) lowest.set(p.cls, p.level)
  }
  return [...lowest]
    .map(([cls, level]) => ({ cls, level }))
    .sort((a, b) => a.level - b.level || a.cls.localeCompare(b.cls))
}

/**
 * The loadout classes that ALREADY have this spell — they reach it at or below the level the
 * character has actually reached. Ascending, the `already yours (CLR 24)` claim's own order.
 */
function earlierFor(levels: readonly SearchClassLevel[], ctx: UnlockSearchContext): SearchClassLevel[] {
  if (ctx.currentLevel === null) return []
  const at = ctx.currentLevel
  return levels.filter((p) => ctx.classes.includes(p.cls) && p.level <= at)
}

/** One matching spell as a row: its chips, its scoped context, and the level it sorts on. */
function searchRow(spell: UnlockSpell, pairs: readonly SearchClassLevel[], q: CompiledSpellQuery, ctx: UnlockSearchContext): UnlockRow {
  const levels = foldLevels(pairs)
  // The pairs that satisfied the query — and, when the row got in on its TEXT alone (a bare number
  // matching a rank numeral, say), every pair it has. A row always sorts on a level it really has.
  const matched = matchedClassLevels(levels, q)
  const sortOn = matched.length > 0 ? matched : levels
  const row: UnlockRow = {
    kind: 'spell',
    name: spell.name,
    classes: levels.map((p) => p.cls).filter((c) => ctx.classes.includes(c)).sort((a, b) => a.localeCompare(b)),
    level: sortOn.length > 0 ? Math.min(...sortOn.map((p) => p.level)) : 0,
    levels,
    spell
  }
  const earlier = earlierFor(levels, ctx)
  if (earlier.length > 0) row.earlier = earlier
  return row
}

/**
 * THE RESULTS for one (dataset, query) pair.
 *
 * FOLDED BY NAME, like the level join is and for the same measured reason: the wiki carries
 * duplicate pages for a few spells (`Imbue Emerald` twice at CLR 29), and two identical rows in a
 * result list read as a bug in the app rather than a bookkeeping artefact on the wiki. The first
 * record's fields win — they are the same spell — and the (class, level) pairs are merged.
 *
 * An empty token list matches everything, which is the honest answer to "no query"; the panel does
 * not ask, because an empty box is the level view.
 */
export function searchUnlockSpells(
  spells: readonly UnlockSpell[],
  tokens: readonly SpellSearchToken[],
  ctx: UnlockSearchContext,
  cap: number = UNLOCK_SEARCH_CAP
): UnlockSearchResults {
  const q = compileSpellQuery(tokens)
  const byName = new Map<string, { spell: UnlockSpell; pairs: SearchClassLevel[] }>()
  for (const spell of spells) {
    if (!matchesCompiledQuery(searchable(spell), q)) continue
    const key = spell.name.toLowerCase()
    const seen = byName.get(key)
    if (seen) seen.pairs.push(...spell.at)
    else byName.set(key, { spell, pairs: [...spell.at] })
  }
  const rows = [...byName.values()]
    .map((r) => searchRow(r.spell, r.pairs, q, ctx))
    .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))
  return { rows: rows.slice(0, cap), matched: rows.length, hidden: Math.max(0, rows.length - cap) }
}

/** The class-level chip label — `CLR 24`, the one spelling both the chips and the tests use. */
export function classLevelLabel(pair: SearchClassLevel): string {
  return `${pair.cls} ${String(pair.level)}`
}
