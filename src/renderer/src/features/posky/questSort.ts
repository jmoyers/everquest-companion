// THE quest-list sort orders, pure. useQuestList filters, then calls `orderQuests` from here —
// so a new order is a case in this file and a line in SORT_OPTIONS, and nothing else moves.
//
// Every comparator is TOTAL: each one bottoms out in quest name (then class), so the list has
// one deterministic order per key and never shuffles on re-render.
//
// THE FAVORITE PIN LIVES HERE TOO (JOS-146), because it is part of the ORDER rather than a thing
// that happens to the order afterwards. It used to be a second `sort()` pass in useQuestList, and
// a second pass on a rank ALWAYS wins: whatever the chosen order computed, a starred quest ended
// up on top of it. See `pinsFavorites` for why that is wrong for exactly one of the six orders.

import type { QuestProgress } from './useProgress'

export type SortKey = 'recent' | 'closest' | 'least-missing' | 'name' | 'class' | 'island'

/**
 * "What did my last drops affect" is the question the tab is usually open to answer, so
 * recency leads.
 */
export const DEFAULT_SORT: SortKey = 'recent'

export const SORT_OPTIONS: readonly { value: SortKey; label: string }[] = [
  // The label is the owner's own words for it (JOS-146). It is not "most recent DROP": a drop
  // nobody picked up leaves no line in the log and has no timestamp, so what this orders by is
  // the loot you made, which is also the only thing the ledger can honestly date.
  { value: 'recent', label: 'Most recently looted' },
  { value: 'closest', label: 'Closest to done' },
  { value: 'least-missing', label: 'Fewest missing' },
  { value: 'name', label: 'Quest name (A-Z)' },
  { value: 'class', label: 'By class' },
  { value: 'island', label: 'By island' }
]

export function isSortKey(v: unknown): v is SortKey {
  return SORT_OPTIONS.some((o) => o.value === v)
}

/**
 * Does this order let a starred quest jump the queue? (JOS-146.)
 *
 * FIVE OF THE SIX ORDERS: yes. They order by a STANDING PROPERTY of a quest — its name, its
 * class, its island, how close it is, how much it is missing. Floating the quests you starred
 * above that costs the user nothing: the order they picked still holds inside each group, nothing
 * has been hidden, and "the ones I am working on first" is exactly what a star is for.
 *
 * 'recent': NO. This order's subject is an EVENT — a loot that just happened — and a pin does not
 * reorder that answer, it DESTROYS it. The owner hit it live (2026-08-09): he had starred Warrior
 * Test of Think, looted a Hazy Opal, and the Magician quest that needs Hazy Opal never moved,
 * because the starred quest was pinned above every recency the sort could compute. Replayed
 * against his real log, the recency key was RIGHT the whole time (the Magician quest takes first
 * place the instant that opal lands); the pin was simply applied after it and outranked it.
 * "Most recently looted" has to mean the loot you just made, or it means nothing at all.
 *
 * The star is not weakened by this, because under a recency order the quests you are actively
 * farming are the ones your last drops belong to — they arrive at the top on their own merits.
 */
export function pinsFavorites(sort: SortKey): boolean {
  return sort !== 'recent'
}

/** The universal last resort: name, then class (names repeat across classes — sharedItems.ts). */
function byName(a: QuestProgress, b: QuestProgress): number {
  return a.name.localeCompare(b.name) || a.className.localeCompare(b.className)
}

const ISLAND_RE = /^island\s+(\d+)$/i

/**
 * The part of a required-item row each derivation below reads — structural, like
 * poskyDroppers' DropperSource, so both the live `ItemProgress` and the raw bundled
 * `PoskyItem` satisfy them and neither derivation drags a React module into a node test.
 */
interface ItemWhere {
  where: string
}
interface ItemDropped {
  lastLootedAt?: number
}

/**
 * Which Sky island a quest starts you on, or undefined when the data does not say.
 *
 * There is no island field on a quest — only `where` per required ITEM, and most of those read
 * "Plane of Sky" or empty. So the quest's island is the LOWEST numbered island any of its items
 * names: 88 of the 95 committed quests name exactly one island anyway, 6 name two (this picks the
 * earlier, which is where progression starts you), and 1 names none and stays undefined. A guessed
 * island would be a fabricated progression order (law 1), so that one sorts with the unknowns.
 */
export function questIsland(q: { items: readonly ItemWhere[] }): number | undefined {
  let lowest: number | undefined
  for (const it of q.items) {
    const m = ISLAND_RE.exec(it.where.trim())
    if (!m) continue
    const n = Number(m[1])
    if (lowest === undefined || n < lowest) lowest = n
  }
  return lowest
}

/**
 * A quest's "most recent drop" key: the NEWEST time any item it requires last dropped.
 * undefined when none of them ever has — the absence the sort is required to honour rather
 * than round down to zero.
 */
export function questDropRecency(items: readonly ItemDropped[]): number | undefined {
  let newest: number | undefined
  for (const it of items) {
    const t = it.lastLootedAt
    if (t !== undefined && (newest === undefined || t > newest)) newest = t
  }
  return newest
}

/**
 * Keyed quests first, ordered by `key`; unkeyed ones ALL below, ordered by name.
 * The shape both "no drops yet" and "no island in the data" need: absence is not a low value,
 * it is a missing answer, and it must not interleave with real ones.
 */
function byOptional(
  key: (q: QuestProgress) => number | undefined,
  order: (a: number, b: number) => number
): (a: QuestProgress, b: QuestProgress) => number {
  return (a, b) => {
    const ka = key(a)
    const kb = key(b)
    if (ka === undefined || kb === undefined) {
      if (ka === kb) return byName(a, b)
      return ka === undefined ? 1 : -1
    }
    return order(ka, kb) || byName(a, b)
  }
}

export function compareQuests(sort: SortKey): (a: QuestProgress, b: QuestProgress) => number {
  switch (sort) {
    // Newest drop first. A quest none of whose items has ever dropped has NO recency —
    // it sorts below every quest that has one, by name.
    case 'recent':
      return byOptional((q) => q.lastDropAt, (x, y) => y - x)
    case 'closest':
      return (a, b) =>
        b.ratio - a.ratio || a.missing.length - b.missing.length || byName(a, b)
    case 'least-missing':
      return (a, b) => a.missing.length - b.missing.length || b.ratio - a.ratio || byName(a, b)
    case 'name':
      return byName
    case 'class':
      return (a, b) => a.className.localeCompare(b.className) || byName(a, b)
    case 'island':
      return byOptional(questIsland, (x, y) => x - y)
  }
}

/** Non-mutating sort — the caller's array is filter output it may still be holding. */
export function sortQuests(quests: readonly QuestProgress[], sort: SortKey): QuestProgress[] {
  return [...quests].sort(compareQuests(sort))
}

/**
 * How high a quest is pinned, above the chosen order: 2 for a quest the user STARRED outright,
 * 1 for one that merely contains a starred ITEM, 0 for everything else. The caller supplies it
 * because both stars live in renderer-local stores this module knows nothing about.
 */
export type PinRank = (q: QuestProgress) => number

/**
 * THE list order: the chosen sort, then the favorite pin on top of it — but only for the orders
 * `pinsFavorites` says may carry one.
 *
 * The pin is a SECOND pass on purpose (Array#sort is stable, so ties keep the first pass's
 * order); what changed in JOS-146 is that it no longer runs for every order. Non-mutating, like
 * `sortQuests` — the caller's array is filter output it may still be holding.
 */
export function orderQuests(
  quests: readonly QuestProgress[],
  sort: SortKey,
  rank: PinRank
): QuestProgress[] {
  const sorted = sortQuests(quests, sort)
  if (pinsFavorites(sort)) sorted.sort((a, b) => rank(b) - rank(a))
  return sorted
}
