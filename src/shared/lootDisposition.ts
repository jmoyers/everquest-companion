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
// every reader has to say which it wants. There are exactly four answers, and this file is the
// vocabulary for all four:
//
//   1. COUNTING what you hold — a destroy SUBTRACTS (`posky/heldCounts.ts` folds it chronologically
//      and floors at 0; `inventory/reconcile.ts` discounts each windowed witness by the destroys
//      recorded after it).
//   2. ACQUISITION surfaces — drop rates, drop recency, mob drop knowledge, the notable-pickup
//      strip, the recent-drops feed, "times looted". A destroy is NOT an acquisition and NEVER a
//      drop from a mob: it names no mob, it happened in your bags. These read `isAcquisition`.
//   3. BAG HISTORY — the Loot ledger's chronological rows and the event feed. A destroy belongs
//      there, labelled as itself. Those readers pass it through and say "destroyed".
//   4. OWNERSHIP — "does this character OWN one of these" (the Gear tab's Owned column). Neither
//      of the two above answers it, which is what JOS-453 found; `isKept` is that answer and the
//      argument for it is on the predicate below.
//
// The predicate is here rather than in each reader so a fifth answer cannot be invented quietly:
// a new consumer of `LootEvent` has to import one of these three names and thereby state its case.

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

/**
 * TRUE when the row states an item that arrived AND STAYED — the OWNERSHIP question (answer 4).
 *
 * THE CASE THIS EXISTS FOR (JOS-453). `You looted an Ethereal Mist Gauntlets +4 from High Priest
 * M`kari's corpse and sold it for free.` is an acquisition — the line names a mob, the item really
 * did drop — and `isAcquisition` rightly keeps it for every drop-rate and "times looted" surface.
 * But the item was VENDORED in the same sentence that reported it. It was never in the bags, and
 * the Gear tab's Owned column was reading exactly this row and printing `Looted`.
 *
 * IT IS THE SAME LAW AS THE DESTROY, one step earlier. `gearData.ts` already said it about
 * destroys — "a line saying an item left the bags must not be the reason the app says it is
 * owned" — and an auto-sell is a line saying an item left the bags. The only difference is that
 * the destroy leaves after some time holding it and the auto-sell never begins.
 *
 * MEASURED, and this is why it is not a nicety (full-log sweep, eqlog_Primitive_freeport.txt,
 * 2026-08-23, 12,045 loot events): 8,816 of them — 73% — are `sold`. 637 distinct base names have
 * been auto-sold, and 467 OF THOSE APPEAR IN THE LOG NO OTHER WAY: this character has never held
 * one, and the Owned column claimed all 467. 227 of the 467 carry a ` +N`, which is the 2026-08-18
 * patch making `+N` drops routine — the change that turned a small wrong answer into a loud one.
 *
 * 'combined' IS KEPT, deliberately. The looted copy is consumed, but it is consumed INTO `created`,
 * whose base name is the same one (`itemTierKey` folds the ` +N`; 847 of 847 real combine lines in
 * the sweep create `<same base> +N`, zero cross-base). You finish the line owning one, so the
 * ownership answer is yes. 'currency'/'hoard'/'depot' are ordinary kept storage and the bare
 * dashed loot is the plain case.
 */
export function isKept(row: { disposition?: LootDisposition }): boolean {
  return row.disposition !== 'destroyed' && row.disposition !== 'sold'
}
