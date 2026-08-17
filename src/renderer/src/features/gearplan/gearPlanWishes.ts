// gearplan/gearPlanWishes.ts — THE BOARD, AS THINGS TO GO AND GET.
//
// `wishSeed.ts`'s shape, for the live document instead of the retired one. That file exists because
// JOS-326 removed the plan board and its stored decisions had to survive as wishes; this one exists
// because the board is back and those decisions are being made again, on purpose, now.
//
// ---------------------------------------------------------------------------------------------
// AND THIS IS THE JOIN THE WISH LIST WAS PARKED WAITING FOR.
//
// `progressState.ts` states the ruling at the `wishlist` key: the list names "no cell, no socket,
// no host, on an owner ruling: host targeting is an explicitly later addition, and a wish list that
// grew a cell map would be the plan board again under a friendlier name". Both halves of that hold
// here. The wish list's SHAPE is untouched — still flat, still keyed by `itemKey`, still no cell —
// and the targeting lives where it belongs, on a board, which then hands the flat list exactly the
// rows it has always been able to hold. Nothing about `WishList` changes; this is a producer.
//
// TWO KINDS OUT OF ONE CELL, and they are the wish list's own two kinds:
//   * the ITEM you planned into the cell is a `gear` wish — you want that helm.
//   * each DONOR you planned into its sockets is a `donor` wish, carrying the effect and the socket
//     — you want that robe FOR its Improved Healing, and the socket is what lets the row state a
//     merge cost later.
// `wishFromGear` / `wishFromDonor` build both, so a wish written from here is byte-identical to one
// written from the wish list's own add control. Two builders for one row is how a reverted rule
// survives in one of them.
//
// WHAT YOU ALREADY HAVE IS NOT A WISH (owner direction). The first cut of this file offered every
// row and let the wish list's done strip sort it out — the `wishSeed.ts` bet — and that reads
// wrong on a control somebody presses on purpose: "add this plan" answering with twenty rows you
// already own is a list you then have to clean up by hand. So `newWishes` takes the wish list's
// OWN verdict (`wishFarm.wishFulfilled`, the same predicate that draws the done strip) and drops
// what it says is finished.
//
// THE RISK IS STATED RATHER THAN HIDDEN: that join reads three sources that settle
// asynchronously, so pressing this the instant the tab mounts can drop a row whose progress had
// not arrived. That is why the caller reports the NUMBER it added — a count that is lower than you
// expected is visible, and the per-item control is still there for anything the filter ate.
//
// AND ALREADY-WISHED IS ALSO NOT A WISH. `addWish` dedupes by `itemKey` anyway, but a caller that
// wants to SAY how many it added has to know before it writes — the model returns the same object
// for a no-op and a count taken afterwards would read zero.
//
// PURE AND NODE-TESTABLE (`tests/gearPlanWishes.test.mts`): a board in, `WishEntry[]` out, no React.

import type { GearPlan, GearPlanCell } from '../../../../shared/planner/gearPlan'
import { filledCells } from '../../../../shared/planner/gearPlan'
import { SOCKET_TYPES } from '../../../../shared/planner/types'
import type { WishEntry } from '../../../../shared/planner/wishlist'
import { wishFromDonor, wishFromGear } from '../wishlist/wishSearch'

/**
 * ONE CELL's wishes: the item, then each planned exaltation's donor, in socket order.
 *
 * The ITEM FIRST is the reading order somebody would say it in — "I want that helm, and these
 * effects in it" — and `addWish` keeps insertion order, so the wish list shows it that way too.
 */
export function cellWishes(planned: GearPlanCell, now: number): WishEntry[] {
  const out: WishEntry[] = [wishFromGear({ key: planned.key, name: planned.name }, now)]
  for (const socket of SOCKET_TYPES) {
    const inSocket = planned.sockets[socket]
    if (inSocket === undefined) continue
    out.push(
      wishFromDonor(
        { key: inSocket.donorKey, name: inSocket.donorName, effect: inSocket.effect, socket },
        now
      )
    )
  }
  return out
}

/** THE WHOLE BOARD, in board order — every row it could want, before any filtering. */
export function planWishes(gearPlan: GearPlan, now: number): WishEntry[] {
  return filledCells(gearPlan).flatMap(({ planned }) => cellWishes(planned, now))
}

/** What a caller must be able to answer before a row can be dropped. */
export interface WishFilter {
  /** is this already on the list? (`wishlist.hasWish`) */
  wished: (itemKey: string) => boolean
  /** is this already YOURS? (`wishFarm.wishFulfilled`, so both surfaces agree) */
  fulfilled: (entry: WishEntry) => boolean
}

/**
 * The rows that are worth writing: not already wished, not already yours, and each item once.
 *
 * DEDUPED WITHIN THE BATCH TOO, because `addWish` collapses duplicates silently and this list is
 * counted out loud — the same robe planned into three sockets is one row and must be reported as
 * one. The FIRST occurrence wins, which is board order, which is the order they were offered in.
 */
export function newWishes(offered: readonly WishEntry[], filter: WishFilter): WishEntry[] {
  const out: WishEntry[] = []
  const seen = new Set<string>()
  for (const entry of offered) {
    if (seen.has(entry.itemKey) || filter.wished(entry.itemKey) || filter.fulfilled(entry)) continue
    seen.add(entry.itemKey)
    out.push(entry)
  }
  return out
}
