// THE quest-list sort orders, pure. useQuestList filters, then calls exactly one comparator
// from here with no hidden re-ranking — the selected order is authoritative. A new order is a
// case in this file and a line in SORT_OPTIONS, and nothing else moves.
//
// Every comparator is TOTAL: each one bottoms out in quest name (then class), so the list has
// one deterministic order per key and never shuffles on re-render.

import type { QuestProgress } from './useProgress'

export type SortKey = 'recent' | 'closest' | 'least-missing' | 'name' | 'class' | 'island'
export type SortDirection = 'asc' | 'desc'

/**
 * "What did my last drops affect" is the question the tab is usually open to answer, so
 * recency leads.
 */
export const DEFAULT_SORT: SortKey = 'recent'

export const SORT_OPTIONS: readonly { value: SortKey; label: string }[] = [
  { value: 'recent', label: 'Drop recency' },
  { value: 'closest', label: 'Completion progress' },
  { value: 'least-missing', label: 'Missing items' },
  { value: 'name', label: 'Quest name' },
  { value: 'class', label: 'Class' },
  { value: 'island', label: 'Main item island' }
]

const DEFAULT_DIRECTIONS: Readonly<Record<SortKey, SortDirection>> = {
  recent: 'desc',
  closest: 'desc',
  'least-missing': 'asc',
  name: 'asc',
  class: 'asc',
  island: 'asc'
}

export function isSortKey(v: unknown): v is SortKey {
  return SORT_OPTIONS.some((o) => o.value === v)
}

export function isSortDirection(v: unknown): v is SortDirection {
  return v === 'asc' || v === 'desc'
}

/** The direction that preserves each order's existing, user-facing meaning. */
export function defaultSortDirection(sort: SortKey): SortDirection {
  return DEFAULT_DIRECTIONS[sort]
}

/** The universal last resort: name, then class (names repeat across classes — sharedItems.ts). */
function byName(a: QuestProgress, b: QuestProgress): number {
  return a.name.localeCompare(b.name) || a.className.localeCompare(b.className)
}

const ISLAND_RE = /^island\s+(\d+)$/i

function itemIsland(where: string): number | undefined {
  const m = ISLAND_RE.exec(where.trim())
  return m ? Number(m[1]) : undefined
}

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
 * Every explicitly-stated Sky island among a quest's required items, ascending and unique.
 *
 * `Plane of Sky` (the Wind Rune rows) and blank locations (the Efreeti-cycle inputs) are not
 * island claims and are excluded. This is the complete set for filters; `questIsland` below is
 * deliberately source-ordered instead, because the first stated item is the primary progression
 * item the quest page leads with.
 */
export function questIslands(q: { items: readonly ItemWhere[] }): number[] {
  const islands = new Set<number>()
  for (const it of q.items) {
    const island = itemIsland(it.where)
    if (island !== undefined) islands.add(island)
  }
  return [...islands].sort((a, b) => a - b)
}

/**
 * The primary progression island: the FIRST required item whose source states `Island N`.
 *
 * Source order is load-bearing. Wind Runes state only `Plane of Sky`; Efreeti-cycle inputs have
 * no location; neither can displace the real progression item. No stated island stays undefined
 * rather than inventing one (the Efreeti-only Shadow Knight quest is the committed example).
 */
export function questIsland(q: { items: readonly ItemWhere[] }): number | undefined {
  for (const it of q.items) {
    const island = itemIsland(it.where)
    if (island !== undefined) return island
  }
  return undefined
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
  order: (a: number, b: number) => number,
  direction: SortDirection,
  naturalDirection: SortDirection
): (a: QuestProgress, b: QuestProgress) => number {
  return (a, b) => {
    const ka = key(a)
    const kb = key(b)
    if (ka === undefined || kb === undefined) {
      if (ka === kb) return orient(byName(a, b), direction, naturalDirection)
      return ka === undefined ? 1 : -1
    }
    return orient(order(ka, kb) || byName(a, b), direction, naturalDirection)
  }
}

function orient(value: number, direction: SortDirection, naturalDirection: SortDirection): number {
  return direction === naturalDirection ? value : -value
}

function isReady(q: QuestProgress): boolean {
  return q.completed || q.missing.length === 0
}

export function compareQuests(
  sort: SortKey,
  direction: SortDirection = defaultSortDirection(sort)
): (a: QuestProgress, b: QuestProgress) => number {
  const naturalDirection = defaultSortDirection(sort)
  switch (sort) {
    // Newest drop first. A quest none of whose items has ever dropped has NO recency —
    // it sorts below every quest that has one, by name.
    case 'recent':
      return byOptional((q) => q.lastDropAt, (x, y) => y - x, direction, naturalDirection)
    case 'closest':
      return (a, b) =>
        orient(
          Number(isReady(b)) - Number(isReady(a)) ||
            b.ratio - a.ratio ||
            a.missing.length - b.missing.length ||
            byName(a, b),
          direction,
          naturalDirection
        )
    case 'least-missing':
      return (a, b) =>
        orient(
          a.missing.length - b.missing.length || b.ratio - a.ratio || byName(a, b),
          direction,
          naturalDirection
        )
    case 'name':
      return (a, b) => orient(byName(a, b), direction, naturalDirection)
    case 'class':
      return (a, b) =>
        orient(
          a.className.localeCompare(b.className) || byName(a, b),
          direction,
          naturalDirection
        )
    case 'island':
      return byOptional(questIsland, (x, y) => x - y, direction, naturalDirection)
  }
}

/** Non-mutating sort — the caller's array is filter output it may still be holding. */
export function sortQuests(
  quests: readonly QuestProgress[],
  sort: SortKey,
  direction?: SortDirection
): QuestProgress[] {
  return [...quests].sort(compareQuests(sort, direction))
}
