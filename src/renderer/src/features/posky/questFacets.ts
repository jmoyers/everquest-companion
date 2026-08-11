// questFacets.ts — "show me only the quests for THIS boss / THIS island" (JOS-124).
//
// The Sky tab already knew both facts per required ITEM: posky's stated `where` (the island) and
// the mob catalog's inverted loot lists (the boss), both resolved in poskyDroppers.ts and already
// drawn on every row as the "Kill: Gorgalosk · Island 3" caption. What the tab could not do was
// USE them to narrow the list — a player standing on island 7 in front of the Spiroc Lord had to
// read 95 accordions to find the four that his kill advances. This file lifts those two per-item
// facts to the QUEST level and turns them into a filter.
//
// A FACET IS A PROPERTY OF THE QUEST, NOT OF YOUR PROGRESS. `questKillTargets` (poskyDroppers)
// answers "what is LEFT" and so drops an item the moment you hold it; that is right for a caption
// and wrong for a filter, because a quest would silently leave the boss you filtered by the
// instant its drop landed — the one moment you are most likely to be looking at it. So both
// derivations read EVERY required item, completed quests included, and the tab's existing
// "Hide completed" / "Only quests with turn-ins" toggles remain the way to ask the progress
// question. The two compose; neither is folded into the other.
//
// EMPTY IS NO FILTER (the ChipMultiSelect contract, world-model law 1). Nothing here substitutes
// a selection of its own, and a quest whose items resolve NO boss (the wind-rune quests: posky
// itself calls them a random drop) simply matches no boss pick — it is not filed under a guessed
// one.
//
// WITHIN a dimension the picks are OR (island 3 or island 5); ACROSS the two they are AND (on
// island 5 AND dropped by Bazzt Zzzt). That is the class filter's existing semantics, extended
// rather than reinvented — one more chip always narrows.
//
// Pure + React-free, node-tested in `tests/questFacets.test.mts` against the committed data.
// MEASURED there (95 quests): 7 islands and 20 distinct bosses, so both pickers are short closed
// lists and neither needs search or windowing.

import { islandNumber, islandOf } from './poskyDroppers'

/**
 * The part of a required-item row the facets read. `ItemProgress` (useProgress.ts) satisfies it
 * structurally, and spelling the shape out here is what keeps this module free of React and of
 * the `@shared/*` alias — the questSort.ts precedent.
 */
export interface FacetItem {
  /** posky's stated location string for this item, e.g. "Island 3" */
  where: string
  /** the Plane of Sky mobs the committed data says drop it; empty for a random drop */
  droppers: readonly { name: string }[]
}

export interface FacetQuest {
  items: readonly FacetItem[]
}

/** What the user picked. Empty on both sides is the default, and means every quest. */
export interface QuestFacets {
  islands: readonly string[]
  bosses: readonly string[]
}

/** What the two pickers offer, in the order they offer it. */
export interface FacetOptions {
  islands: string[]
  bosses: string[]
}

/** Case-folded, so a boss whose name starts with an article does not sort by its capital. */
function byFoldedName(a: string, b: string): number {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  if (x !== y) return x < y ? -1 : 1
  return 0
}

/**
 * Every island a quest's required items STATE, ascending. Never inferred: `islandOf` reads an
 * explicit "Island N" and nothing else, so the wind runes' honest "Plane of Sky" contributes no
 * island at all rather than being dressed up as one.
 */
export function questIslands(q: FacetQuest): string[] {
  const out = new Set<string>()
  for (const it of q.items) {
    const island = islandOf(it.where)
    if (island) out.add(island)
  }
  return [...out].sort((a, b) => islandNumber(a) - islandNumber(b))
}

/**
 * Every mob the committed data says drops something this quest requires, by NAME, name-ordered.
 * Empty when nothing it needs resolves a dropper (law 1: no guess, and so no chip).
 */
export function questBosses(q: FacetQuest): string[] {
  const out = new Set<string>()
  for (const it of q.items) for (const d of it.droppers) out.add(d.name)
  return [...out].sort(byFoldedName)
}

/** Does this quest survive the picked facets? OR inside a dimension, AND across them. */
export function matchesFacets(q: FacetQuest, f: QuestFacets): boolean {
  if (f.islands.length > 0 && !questIslands(q).some((i) => f.islands.includes(i))) return false
  if (f.bosses.length > 0 && !questBosses(q).some((b) => f.bosses.includes(b))) return false
  return true
}

/**
 * Narrow a list by the picked facets. Nothing picked returns the SAME array untouched, so the
 * default path costs one comparison and allocates nothing.
 */
export function filterByFacets<T extends FacetQuest>(
  quests: readonly T[],
  f: QuestFacets
): readonly T[] {
  if (f.islands.length === 0 && f.bosses.length === 0) return quests
  return quests.filter((q) => matchesFacets(q, f))
}

/**
 * The options the pickers show, derived from the quests actually on the tab (so an ignored quest
 * takes its boss out of the list along with itself, and a re-scrape needs no hand-edit here).
 *
 * ISLANDS ascend. BOSSES are ordered by HOW MANY quests they stand in front of, then by name —
 * counted, never guessed, the same argument `questKillTargets` makes for its lead target. The
 * alternative, plain alphabetical, opens with the three one-off drakes and buries the six bosses
 * the whole zone is about.
 */
export function facetOptions(quests: readonly FacetQuest[]): FacetOptions {
  const islands = new Set<string>()
  const bosses = new Map<string, number>()
  for (const q of quests) {
    for (const i of questIslands(q)) islands.add(i)
    for (const b of questBosses(q)) bosses.set(b, (bosses.get(b) ?? 0) + 1)
  }
  return {
    islands: [...islands].sort((a, b) => islandNumber(a) - islandNumber(b)),
    bosses: [...bosses.entries()]
      .sort((a, b) => b[1] - a[1] || byFoldedName(a[0], b[0]))
      .map(([name]) => name)
  }
}

/**
 * The offered options PLUS anything already picked that they no longer contain, appended.
 *
 * The picks are persisted across restarts, so a re-scrape that renames a mob (or a user who
 * ignores the last quest a boss appears in) can leave a stored pick with no option behind it.
 * Keeping it in the list is what lets the user SEE the chip that is hiding everything and take
 * it off; dropping it silently would change their filter behind their back.
 */
export function withPicked(options: readonly string[], picked: readonly string[]): string[] {
  const out = [...options]
  const known = new Set(options)
  for (const p of picked) {
    if (known.has(p)) continue
    known.add(p)
    out.push(p)
  }
  return out
}
