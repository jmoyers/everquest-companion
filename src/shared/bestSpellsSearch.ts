// THE READOUT LEARNS SEARCH — the whole catalog, read as best-spells rows (JOS-450).
//
// The owner's ask, verbatim: "want search, same as the level spells" and "i want to be able to
// search for things outside my class to compare". Those are one feature, and this file is its
// model: which spells a query admits, and what each surviving row says when the thing drawing it is
// the efficiency readout rather than the unlock list.
//
// FIVE DECISIONS, and each of them is about what a row here is a claim about.
//
//   THE CORPUS IS THE WHOLE CATALOG, NOT THE LOADOUT'S SLICE. `bestSpellsAt` ranks what you OWN,
//   which is the right corpus for a table nobody asked a question of. A typed question deserves the
//   whole answer — the unlock search's own rule — so a wizard who types `nature's touch` gets the
//   druid heal, and the row says DRU 44 rather than pretending the spell does not exist. Rows
//   outside the loadout exist ONLY under a query: they are never added to the ranked tabs, because
//   those tabs answer "what should I cast" and a spell you cannot cast is not an answer to it.
//
//   A RESULT IS A ROW OF THIS READOUT. Same figures, same columns, same sort, same `RankChip` — so
//   the comparison the owner wants is a comparison of like with like, read straight down one
//   column. That is the whole reason this is not just the unlock search shown in a second place: an
//   unlock row states the spell at ITS gain level, and two spells stated at two different levels
//   cannot be compared at all.
//
//   THE FIGURES ARE READ AT THE VIEWED LEVEL, INCLUDING FOR A SPELL YOU HAVE NOT REACHED. The
//   reader is window-shopping: "what would this be worth to me, now". A ramp read below its own
//   first breakpoint is CLAMPED, never extrapolated (`spellMetrics.ts rampAt` — the wiki's ramp is
//   a statement about a band), so an out-of-reach spell reads at the lowest figure its page states
//   and never at a number nobody claimed. The row's own chip carries the level it is really gained
//   at, which is what tells the reader the figure is a preview.
//
//   THE ROW ANSWERS ON THE TAB IN FRONT OF THE READER. The panel draws one table, so a result is
//   placed by exactly the membership test the ranked table uses (`spellInTab`) and figured under
//   exactly that tab's assumption — the AOE tab reads its corpus at max target count, here too. A
//   match that has no reading on this tab is COUNTED and said out loud (`elsewhere`) rather than
//   dropped in silence: a search that answers "no matches" over a spell it can see is lying.
//
//   ERA IS MARKED, NEVER FOLDED. The ranked tables put out-of-era rows behind a disclosure because
//   a ranking answers "what is mine now". A search answers the question the player typed, so the
//   row is drawn in place with its chip — the same split `UnlockList` already makes, for the same
//   reason, in the same words.
//
// CAPPED, AND THE CAP SAYS SO, like every other search in this app.
//
// Pure, dependency-free of Electron, RELATIVE value imports (the mobSearch.ts precedent) so
// `npm test` drives it over the REAL committed dataset with no vite alias in sight.

import { isAeTargetType } from './aoeSpells'
import {
  catalogMana,
  ownedBy,
  pctOfSide,
  rowFocus,
  sortBestSpells,
  spellHitsFor,
  spellInTab,
  spellMetricsForLevel,
  targetsFor,
  type BestSpellFocus,
  type BestSpellRow,
  type BestSpellSort,
  type BestSpellTab
} from './bestSpells'
import type { WornFocus } from './wornFocus'
import type { ClassAbbr } from './classCombo'
import type { LevelUnlockData, UnlockSpell } from './levelUnlocks'
import type { SpellMetrics } from './spellMetrics'
import { observedRankRow, type ObservedSpellRanksSnap } from './spellRanks'
import { effectiveSpellRank, normalizeSpellRank } from './spellScale'
import {
  compileSpellQuery,
  matchesCompiledQuery,
  type CompiledSpellQuery,
  type SearchClassLevel,
  type SpellSearchToken
} from './spellSearch'
import { foldClassLevels, unlockSearchSurface } from './unlockSearch'

/**
 * Most result rows the panel mounts at once.
 *
 * Half the unlock search's hundred, and the column is why: a result here is TWO lines (the name
 * with its chips, then the figures) in a band with a 260px floor, so a hundred of them is a
 * quarter-mile of readout under a box somebody is still typing into. Beyond the cap the reader is
 * told what is not shown, which is the difference between a cap and a lie by omission.
 */
export const BEST_SPELL_SEARCH_CAP = 50

/**
 * One result: a readout row, plus the two things a search row needs and a ranked row does not.
 *
 * `levels` is every class the DB places this spell for, at the level each one gets it — the chips.
 * A ranked row needs none: it is drawn under a stepper that states the level once, and every class
 * on it is one of yours by construction. A search row is drawn beside rows from other classes
 * entirely, so a bare `DRU` would be a fact withheld.
 */
export interface BestSpellSearchRow extends BestSpellRow {
  /** every class placement, lowest level each, ascending by level then class code */
  levels: SearchClassLevel[]
  /** true when a loadout class has this spell AT OR BELOW the viewed level: it is really yours */
  owned: boolean
}

/** The rows to draw, and the honest counts behind them. */
export interface BestSpellSearchResults {
  rows: BestSpellSearchRow[]
  /** how many matches this tab can READ — `rows.length` when the cap did not bite */
  matched: number
  /** matched − rows.length: what the `+N more` line is about */
  hidden: number
  /**
   * Matches this tab has NO reading for: a buff with no hitpoint line at all, a heal while the DD
   * tab is open, a single-target nuke while the AOE tab is. Said out loud by the panel, because a
   * reader who can see a spell exists and is told "no matches" has been misinformed.
   */
  elsewhere: number
}

export const EMPTY_BEST_SPELL_SEARCH: BestSpellSearchResults = {
  rows: [],
  matched: 0,
  hidden: 0,
  elsewhere: 0
}

/**
 * WHAT THE READOUT IS ASKING ON THE READER'S BEHALF: the loadout, the level, the tab in front of
 * them, and how that tab is sorted — plus the two rank inputs every figure in this app is read at.
 *
 * One object rather than seven parameters (the repo caps a function at four), and they really are
 * one thought: this is the state of the panel at the moment a key was pressed.
 */
export interface BestSpellSearchAsk {
  /** the loadout classes (resolved ∪ candidates); empty is fine — a search still answers */
  classes: readonly ClassAbbr[]
  /** the VIEWED level, which is where every figure is read */
  level: number
  /** the tab on screen: it decides membership, the columns, and the AOE reading */
  tab: BestSpellTab
  /** that tab's own sort, so results are ordered by the same question the table above them was */
  sort: BestSpellSort
  /** JOS-446's observed-rank map. Null before hydration, which is base. */
  observed?: ObservedSpellRanksSnap | null
  /** the panel's simulate slider, 0..10. Every row reads at `max(observed, this)`. */
  simulate?: number
  /**
   * THE FOCUS EFFECTS THE READER IS WEARING (JOS-452), threaded through for the same reason the
   * ranks are: the marker over this table is the RANKED table's, drawn in the header above both
   * bodies, so a result read without the reader's gear would sit under a caption stating a
   * percentage it did not use. A spell outside the loadout is read at its own earliest placement,
   * which is the level the row prints beside it.
   */
  focus?: readonly WornFocus[]
  /** rows mounted at once; the default is `BEST_SPELL_SEARCH_CAP` */
  cap?: number
}

/** One matched spell with every duplicate wiki page for it already merged into its class pairs. */
interface FoldedMatch {
  spell: UnlockSpell
  pairs: SearchClassLevel[]
}

/**
 * The matching spells, FOLDED BY NAME — the unlock search's rule and the ranked fold's, for the one
 * measured reason both of them state: the wiki carries a few spells on two pages (`Imbue Emerald`
 * twice at CLR 29), and two identical rows read as a bug in the app rather than an artefact on the
 * wiki. The first record's fields win — it is the same spell — and the class pairs merge.
 */
function matchingSpells(spells: readonly UnlockSpell[], q: CompiledSpellQuery): FoldedMatch[] {
  const byName = new Map<string, FoldedMatch>()
  for (const spell of spells) {
    if (!matchesCompiledQuery(unlockSearchSurface(spell), q)) continue
    const key = spell.name.toLowerCase()
    const seen = byName.get(key)
    if (seen) seen.pairs.push(...spell.at)
    else byName.set(key, { spell, pairs: [...spell.at] })
  }
  return [...byName.values()]
}

/** What one spell reads as under the tab's assumption and the reader's ranks. */
interface SpellReading {
  metrics: SpellMetrics
  rank: number
  observedRank: number
  targets: number
  /** JOS-452 — the worn focus that answered, one entry per side. Empty when none did. */
  focus: BestSpellFocus[]
}

/**
 * ONE SPELL, READ THE WAY THE TAB IN FRONT OF THE READER READS IT — or null when this tab has
 * nothing to say about it.
 *
 * Three ways to answer nothing, and all three are the same claim to the caller ("not on this tab"):
 * the AOE tab's corpus is AE-shaped spells only, a spell with no hitpoint line has no figures at
 * all, and a heal is not a DD row. The ranks are the readout's own (`max(observed, simulated)`),
 * so a result and a ranked row of the same spell can never disagree about which rung it is read at.
 */
function readingOf(spell: UnlockSpell, ask: BestSpellSearchAsk, gainedAt: number): SpellReading | null {
  const area = ask.tab === 'aoe'
  if (area && !isAeTargetType(spell.targetType)) return null
  const observedRank = normalizeSpellRank(observedRankRow(ask.observed, spell.name)?.rank)
  const rank = effectiveSpellRank(observedRank, normalizeSpellRank(ask.simulate))
  const targets = area ? targetsFor(spell) : 1
  // JOS-452 — the reader's own gear, resolved by the SAME function the ranked fold uses so a result
  // and a ranked row of one spell can never disagree about which item answered for it.
  const focus = rowFocus(spell, ask.focus ?? [], gainedAt)
  const metrics = spellMetricsForLevel(spell, ask.level, {
    rank,
    targets,
    focusDamagePct: pctOfSide(focus, 'damage'),
    focusHealPct: pctOfSide(focus, 'heal')
  })
  if (!metrics || !spellInTab(ask.tab, metrics)) return null
  return { metrics, rank, observedRank, targets, focus }
}

/**
 * THE LEVEL A RESULT ROW PRINTS BESIDE ITS NAME.
 *
 * For a spell the loadout owns it is the level it became YOURS, exactly as a ranked row states it.
 * For everything else it is the spell's OWN earliest placement — the lowest level any class in the
 * game gets it at — because that is the honest answer to "when does this exist", and the chips
 * beside it name which class that is.
 */
function gainLevelOf(owned: { gainedAt: number } | null, levels: readonly SearchClassLevel[]): number {
  if (owned) return owned.gainedAt
  return levels.length > 0 ? Math.min(...levels.map((p) => p.level)) : 0
}

/** One matched spell as a result row, or null when this tab cannot read it. */
function searchRow(found: FoldedMatch, ask: BestSpellSearchAsk, want: ReadonlySet<string>): BestSpellSearchRow | null {
  // The gain level is resolved FIRST since JOS-452: it is the level the row prints and the level the
  // focus's `Limit Max Level` is tested against, and those two must be one number.
  const levels = foldClassLevels(found.pairs)
  const owned = ownedBy(found.spell, want, ask.level)
  const gainedAt = gainLevelOf(owned, levels)
  const reading = readingOf(found.spell, ask, gainedAt)
  if (!reading) return null
  return {
    name: found.spell.name,
    gainedAt,
    classes: owned?.classes ?? [],
    mana: catalogMana(found.spell),
    metrics: reading.metrics,
    outOfEra: found.spell.outOfEra === true,
    rank: reading.rank,
    observedRank: reading.observedRank,
    targets: reading.targets,
    hits: spellHitsFor(found.spell, reading.targets),
    ...(reading.focus.length > 0 ? { focus: reading.focus } : {}),
    levels,
    owned: owned !== null
  }
}

/**
 * THE RESULTS for one (dataset, query, panel state) triple.
 *
 * AN EMPTY TOKEN LIST IS NOT A QUESTION HERE, and that is the one place this parts company with
 * `searchUnlockSpells` (where no tokens match everything). An empty box in this panel means the
 * ranked tabs, which are a different and better answer than the whole catalog in query order — and
 * the level view must cost exactly what it cost before the box existed.
 */
export function searchBestSpells(
  data: LevelUnlockData,
  tokens: readonly SpellSearchToken[],
  ask: BestSpellSearchAsk
): BestSpellSearchResults {
  if (tokens.length === 0 || !Number.isFinite(ask.level)) return EMPTY_BEST_SPELL_SEARCH
  const q = compileSpellQuery(tokens)
  const want = new Set<string>(ask.classes)
  const rows: BestSpellSearchRow[] = []
  let elsewhere = 0
  for (const found of matchingSpells(data.spells, q)) {
    const row = searchRow(found, ask, want)
    if (row) rows.push(row)
    else elsewhere += 1
  }
  const sorted = sortBestSpells(rows, ask.sort)
  const cap = ask.cap ?? BEST_SPELL_SEARCH_CAP
  return {
    rows: sorted.slice(0, cap),
    matched: sorted.length,
    hidden: Math.max(0, sorted.length - cap),
    elsewhere
  }
}

/**
 * THE SENTENCE FOR THE MATCHES THIS TAB CANNOT READ, or null when there are none.
 *
 * Worded here rather than in the panel so a test can pin it, and worded as a fact about the TAB
 * rather than about the spells: they are not wrong answers, they are answers to another question.
 */
export function elsewhereLabel(count: number, tabLabel: string): string | null {
  if (count <= 0) return null
  return `${String(count)} more match with no ${tabLabel} reading`
}
