import { useDeferredValue, useMemo } from 'react'
import type { LootEvent } from '@shared/types'
import { itemCountKey } from '../../lib/itemName'
import { normalizeQuery } from '../../lib/search'
import type { InventoryRow } from '../inventory/reconcile'
import { buildInvOnlyRows, filterLootEvents, groupLootRows, type GroupRow, type KeyedLoot } from './lootGrouping'
import { selectInvOnly, showsInvOnly } from './ownedItems'
import type { LootSortKey } from './lootSort'

export interface LootRowsInput {
  history: LootEvent[]
  inventoryRows: InventoryRow[]
  /** The raw search box value — deferred in here, so typing never blocks on the filter. */
  query: string
  questOnly: boolean
  showInventoryOnly: boolean
  /** Which order the GROUPED table is in (lootSort.ts). The flat ledger is a chronological
   *  ledger and stays newest-first whatever this says — see the toolbar's gate. */
  sort: LootSortKey
  isFavorite: (name: string) => boolean
}

export interface LootRows {
  /** The filtered flat history, most recent first. */
  events: KeyedLoot[]
  /** The grouped-by-item rows (loot only) — the "unique items" count comes from here. */
  grouped: GroupRow[]
  /** What the grouped table renders: `grouped`, plus the opt-in inventory-only tail. */
  groupRows: GroupRow[]
  /** Held per the export but never looted this epoch — the toolbar chip counts these. */
  invOnlySource: InventoryRow[]
  /** Those of them the current filters admit. Already inside `groupRows`; surfaced separately so
   *  the UNGROUPED ledger — which renders loot events and so can never hold one — can still say
   *  that a search matched something the app owns (JOS-160). */
  invOnlyRows: GroupRow[]
  /** countKey → reconciled inventory row, for the O(1) per-row "In inventory" estimate. */
  invByKey: Map<string, InventoryRow>
}

/**
 * Everything the Loot tables derive from the raw history + reconciled inventory. Split out
 * of the view because it is pure derivation: each step is memoized on exactly the inputs it
 * reads, so a keystroke re-runs the filter and nothing else.
 */
export function useLootRows({
  history,
  inventoryRows,
  query,
  questOnly,
  showInventoryOnly,
  sort,
  isFavorite
}: LootRowsInput): LootRows {
  // Typing echoes IMMEDIATELY (the caller's local `query` state); the filter consumes a
  // DEFERRED copy so a keystroke never blocks on the filter + re-render (Task #41).
  const deferredQuery = useDeferredValue(query)
  const q = normalizeQuery(deferredQuery)

  // Precompute the lowercase + counting keys ONCE per history change (not per keystroke).
  const keyed = useMemo<KeyedLoot[]>(
    () => history.map((e) => ({ ...e, itemKey: e.item.toLowerCase(), countKey: itemCountKey(e.item) })),
    [history]
  )

  // countKey → reconciled inventory row, rebuilt ONCE per inventory change so the estimate
  // lookup stays O(1) per rendered row (the table is windowed; never scan per row).
  const invByKey = useMemo(() => {
    const m = new Map<string, InventoryRow>()
    for (const r of inventoryRows) m.set(r.key, r)
    return m
  }, [inventoryRows])

  // Every counting key that appears in loot history, so "inventory-only" means exactly
  // "held per the export but never looted this epoch".
  const lootCountKeys = useMemo(() => new Set(keyed.map((e) => e.countKey)), [keyed])

  const invOnlySource = useMemo(
    () => selectInvOnly(inventoryRows, lootCountKeys),
    [inventoryRows, lootCountKeys]
  )

  const events = useMemo(() => filterLootEvents({ keyed, questOnly, q }), [keyed, q, questOnly])
  // Re-sorting is the ONLY thing a sort change costs: the filter above it is memoized on the
  // query, so switching to "last looted" never re-runs the per-keystroke work.
  const grouped = useMemo(() => groupLootRows(events, isFavorite, sort), [events, isFavorite, sort])

  // The inventory-only tail is kept OUT of the default BROWSE so the Loot table stays a loot
  // table (the toolbar chip says how many are hiding) — but a SEARCH always reaches it, because a
  // search asks whether the app knows this item at all (JOS-160, `showsInvOnly`).
  const invOnlyRows = useMemo<GroupRow[]>(
    () =>
      showsInvOnly(showInventoryOnly, q)
        ? buildInvOnlyRows({ source: invOnlySource, questOnly, q, isFavorite })
        : [],
    [showInventoryOnly, invOnlySource, questOnly, q, isFavorite]
  )

  const groupRows = useMemo(
    () => (invOnlyRows.length === 0 ? grouped : [...grouped, ...invOnlyRows]),
    [grouped, invOnlyRows]
  )

  return { events, grouped, groupRows, invOnlySource, invOnlyRows, invByKey }
}
