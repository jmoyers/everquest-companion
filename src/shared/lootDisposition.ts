// ============================================================================
// lootDisposition.ts — WHAT A DESTROY MEANS TO EVERY READER OF THE LOOT LANE (JOS-401).
// ============================================================================
//
// `You successfully destroyed 38 Bone Chips.` is a real line and this app spent two releases
// asserting it was not (`reconcile.ts` and the Cleanup tab both said "the log records the loot and
// never records the destruction"). It does: 356 of them in the owner's live log, four in the
// committed fixture `tests/fixtures/w32-item-merge-failures.log`. `parseWorld.classifyLoot` now
// emits it as a loot event with `disposition: 'destroyed'` and no `source`.
//
// WHY THE LOOT LANE. Everything a destroy has to reach already reads loot rows — the LootModule
// persists/snapshots/deltas them, and every held-count fold in the renderer is a walk over that
// same array. A `destroy` kind of its own would have had to be plumbed through all of it before it
// could subtract anything.
//
// THE COST OF THAT REUSE is that a row on the loot lane now means one of TWO opposite things, so
// every reader has to say which it wants. There are exactly three answers, and this file is the
// vocabulary for all three:
//
//   1. COUNTING what you hold — a destroy SUBTRACTS (`posky/heldCounts.ts` folds it chronologically
//      and floors at 0; `inventory/reconcile.ts` discounts each windowed witness by the destroys
//      recorded after it).
//   2. ACQUISITION surfaces — drop rates, drop recency, mob drop knowledge, the notable-pickup
//      strip, the recent-drops feed, "times looted". A destroy is NOT an acquisition and NEVER a
//      drop from a mob: it names no mob, it happened in your bags. These read `isAcquisition`.
//   3. BAG HISTORY — the Loot ledger's chronological rows and the event feed. A destroy belongs
//      there, labelled as itself. Those readers pass it through and say "destroyed".
//
// The predicate is here rather than in each reader so a fourth answer cannot be invented quietly:
// a new consumer of `LootEvent` has to import one of these two names and thereby state its case.

import type { LootDisposition } from './logEvents'

/** A row that states an item LEAVING you rather than arriving. */
export function isDestroyed(row: { disposition?: LootDisposition }): boolean {
  return row.disposition === 'destroyed'
}

/**
 * TRUE when the row states an item ARRIVING — which is every disposition except the destroy.
 *
 * 'sold' and 'combined' are acquisitions here on purpose: the item did reach you off a corpse (the
 * line names the mob), it is the HELD count that then declines to keep it. Which is exactly the
 * split this predicate exists to keep straight — "did an item come off a mob" and "do you still
 * have it" are different questions with different readers.
 */
export function isAcquisition(row: { disposition?: LootDisposition }): boolean {
  return !isDestroyed(row)
}
