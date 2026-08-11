// ============================================================================
// ownedItems.ts — what you OWN but never looted, and when the Loot page shows it (JOS-160).
// ============================================================================
//
// THE DEFECT THIS MODULE EXISTS FOR. A 0.15.0 player held three `Ivory Sky Diamond` — `/finditem`
// said so, his `/outputfile inventory` said so, and the Plane of Sky tab agreed, showing the
// Paladin Test of Spirit ready to hand in. The Loot page could not find the item at all: the
// search returned nothing and the item page reported it had never been looted. Two surfaces of one
// app, one reconcile, opposite answers.
//
// The cause was not a name (there is exactly one spelling of that item in the whole tree, and no
// `+N` variant), not a parser gap (the item was acquired before this log exists, so no loot line
// will ever appear), and not the keyring (JOS-66's rule already counts it — that is WHY the Sky tab
// was right). The cause is that the Loot page's search corpus is the LOOT LEDGER while the Sky
// tab's is what you HOLD, and everything the export knows lived in a second list the search only
// reached after the user found and clicked a chip — under the default `log` count source, a list
// that had already been emptied (see reconcile.ts's `buildRows`).
//
// So the two rules below are the reconciliation, and they are kept in their own file because
// `lootGrouping.ts` cannot be loaded by node (it imports `lootItemData` → `data/index` →
// `@shared/profiles`, a value import that only the bundler resolves — the same reason `lootSort.ts`
// lives apart). A rule nobody can unit-test is a rule that drifts; `tests/lootOwnedItems.test.mts`
// drives these directly.

import type { InventoryRow } from '../inventory/reconcile'
import type { GroupRow } from './lootGrouping'

/**
 * Which reconciled rows are "held per the export but never looted this epoch".
 *
 * THE WITNESS IS `inv`, NOT `net`. `net` is the ACTIVE count source's answer, and under the
 * default source `log` it is 0 for every item the log never saw — so filtering on it emptied this
 * list for exactly the player it exists for. `inv` is what the `/outputfile inventory` dump itself
 * vouched for, which is the question being asked.
 */
export function selectInvOnly(
  inventoryRows: readonly InventoryRow[],
  lootCountKeys: ReadonlySet<string>
): InventoryRow[] {
  return inventoryRows.filter((r) => r.inv > 0 && !lootCountKeys.has(r.key))
}

/**
 * Does the grouped table show that tail right now?
 *
 * A SEARCH ALWAYS REACHES IT. Browsing the ledger stays opt-in — the chip is what keeps a loot
 * table a loot table — but typing a name is not browsing. It asks whether the app knows this item,
 * and "no results" for something the app is simultaneously counting three of on another tab is the
 * contradiction this ticket is about. The chip still governs the unfiltered list, so the default
 * view is unchanged.
 */
export function showsInvOnly(showInventoryOnly: boolean, q: string): boolean {
  return showInventoryOnly || q !== ''
}

export interface OwnedRowsInput {
  source: readonly InventoryRow[]
  /** Restrict to Plane of Sky quest items (the toolbar switch). */
  questOnly: boolean
  /** Already normalized (trimmed + lowercased) by `normalizeQuery`. */
  q: string
  isFavorite: (name: string) => boolean
  /** Is this COUNTING KEY required by a Sky quest? Injected so this module stays node-loadable. */
  isQuestItem: (countKey: string) => boolean
}

/**
 * The owned-but-never-looted rows, as grouped-table rows.
 *
 * `count` is 0 and `last` is 0 because the LOG has nothing to say — the row renders those as
 * dashes rather than as zeros, since "never looted" is a fact about this log and not a measurement
 * of the item. `owned` carries the export's count, which is the only witness the row has: `net`
 * would read 0 under the `log` source and the whole row would be dashes.
 *
 * Already net-desc from reconcile, so only the favorites pin re-sorts it.
 */
export function buildOwnedRows({
  source,
  questOnly,
  q,
  isFavorite,
  isQuestItem
}: OwnedRowsInput): GroupRow[] {
  let list: readonly InventoryRow[] = source
  if (questOnly) list = list.filter((r) => isQuestItem(r.key))
  if (q) list = list.filter((r) => r.name.toLowerCase().includes(q))
  const rows: GroupRow[] = list.map((r) => ({
    key: `inv:${r.key}`,
    countKey: r.key,
    item: r.name,
    count: 0,
    last: 0,
    zoneCount: 0,
    invOnly: true,
    owned: r.inv
  }))
  return rows.sort((a, b) => Number(isFavorite(b.item)) - Number(isFavorite(a.item)))
}
