import type { LootDisposition, LootEvent } from '@shared/types'
import { isAcquisition } from '@shared/lootDisposition'
import type { InventoryRow } from '../inventory/reconcile'
import { questItemNames } from './lootItemData'
import { DEFAULT_LOOT_SORT, sortLootRows, type LootSortKey } from './lootSort'
import { buildOwnedRows } from './ownedItems'

// A loot event with two precomputed keys — computed ONCE per history change so the
// per-keystroke filter is a plain substring test (never re-lowercasing thousands of rows
// on every character typed).
//   itemKey  — raw lowercase; the GROUPING identity, so `Sphinx Claw +1` keeps its own row.
//   countKey — `+N`-stripped counting key (Task #42); the join key onto quest items and
//              onto the reconciled inventory rows, which are keyed the same way.
export type KeyedLoot = LootEvent & { itemKey: string; countKey: string }

export interface GroupRow {
  /** Stable React key — the raw lowercase item name, or `inv:<countKey>` for an
   *  inventory-only row (which has no loot history to group). */
  key: string
  /** Normalized counting key — the join onto the reconciled inventory rows. */
  countKey: string
  item: string
  count: number
  last: number
  topSource?: string
  zoneCount: number
  disposition?: LootDisposition
  /** Held per the inventory export but never looted this epoch — no loot columns. */
  invOnly?: boolean
  /** What the EXPORT vouches for on this key. Set on inventory-only rows, which have no loot
   *  history to count and whose reconciled `net` is 0 under the `log` count source (JOS-160). */
  owned?: number
}

/** The active filters, most recent first. */
export function filterLootEvents({
  keyed,
  questOnly,
  q
}: {
  keyed: KeyedLoot[]
  questOnly: boolean
  q: string
}): KeyedLoot[] {
  let list: KeyedLoot[] = keyed
  if (questOnly) list = list.filter((e) => questItemNames.has(e.countKey))
  if (q) list = list.filter((e) => e.itemKey.includes(q))
  return [...list].reverse() // most recent first
}

interface Group {
  item: string
  countKey: string
  count: number
  last: number
  sources: Map<string, number>
  zones: Set<string>
  /** Distinct dispositions seen across the group's rows (undefined = kept). */
  dispositions: Set<LootDisposition | undefined>
}

/**
 * ONE ROW PER ITEM, over the LOOT rows only.
 *
 * A destroy is honest bag history and the flat chronological ledger keeps it, wearing its own chip
 * (JOS-401) — but this table's columns are `Times looted`, `Top source` and `Zones`, and a destroy
 * answers none of them: it names no mob, and adding its stack size to a times-looted count would
 * make emptying a bag look like farming. So the grouped table is built from acquisitions, and an
 * item this character ONLY ever destroyed has no group row (its flat rows are still in the ledger,
 * and the inventory-only tail is where a held-but-never-looted item is reported).
 */
function tallyGroups(events: KeyedLoot[]): Map<string, Group> {
  const map = new Map<string, Group>()
  for (const e of events) {
    if (!isAcquisition(e)) continue
    const key = e.itemKey
    let cur = map.get(key)
    if (!cur) {
      cur = {
        item: e.item,
        countKey: e.countKey,
        count: 0,
        last: 0,
        sources: new Map(),
        zones: new Set(),
        dispositions: new Set()
      }
      map.set(key, cur)
    }
    // Stacked loots count their stack size (Task #47): "2 Bone Chips" is two items.
    cur.count += e.count ?? 1
    cur.last = Math.max(cur.last, e.ts)
    if (e.source) cur.sources.set(e.source, (cur.sources.get(e.source) ?? 0) + 1)
    if (e.zone) cur.zones.add(e.zone)
    cur.dispositions.add(e.disposition)
  }
  return map
}

/**
 * One row per item, in the reader's chosen order (lootSort.ts) — and in nothing else.
 *
 * IT USED TO CARRY A SECOND PASS (JOS-345). Favorited items were re-sorted into a block on top,
 * stably, so the chosen order survived inside each block. The star that set the flag has left this
 * window on the owner's ruling, and the pin left with it: an order the reader has no control over
 * is an order the reader cannot account for. One comparator, one order, and every comparator in
 * lootSort.ts is total — so the list is deterministic without the pass that used to follow it.
 */
export function groupLootRows(
  events: KeyedLoot[],
  sort: LootSortKey = DEFAULT_LOOT_SORT
): GroupRow[] {
  const list: GroupRow[] = [...tallyGroups(events).entries()].map(([key, g]) => {
    const topSource = [...g.sources.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    // The group's dominant disposition — shown only when ALL of its rows share one, so a
    // mixed item (some kept, some sold) stays unlabeled rather than mislabeled.
    const disposition = g.dispositions.size === 1 ? [...g.dispositions][0] : undefined
    return {
      key,
      countKey: g.countKey,
      item: g.item,
      count: g.count,
      last: g.last,
      topSource,
      zoneCount: g.zones.size,
      disposition
    }
  })
  return sortLootRows(list, sort)
}

/**
 * The tail of items the inventory export knows about but that were never looted this epoch (bank
 * stock, pre-epoch gear, anything acquired before this log started). Shown when the chip is lit or
 * whenever a search is running — `showsInvOnly`.
 *
 * The RULE is `ownedItems.ts` (JOS-160); this is the binding that hands it the Sky quest-item set.
 * The split is not decoration: this module cannot be loaded by node (`lootItemData` → `data/index`
 * → a `@shared/profiles` value import the bundler alone resolves), and the rule needed a unit test.
 */
export function buildInvOnlyRows({
  source,
  questOnly,
  q
}: {
  source: InventoryRow[]
  questOnly: boolean
  q: string
}): GroupRow[] {
  return buildOwnedRows({ source, questOnly, q, isQuestItem: (k) => questItemNames.has(k) })
}
