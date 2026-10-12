// lib/navReturn — WHERE A VIEW WAS when a link took you away from it, so Back can put you there.
//
// THE GAP THIS CLOSES (fork report, kaltinril 2026-08-25). `navOrigin.ts` parks the VIEW a deep
// link leaves and Back returns to that view - and only the view. A mob page is `useState` inside
// MobsView, which unmounts on the tab switch, so "Open in Loot" from a mob's drop dialog said
// `Back to Mobs` and landed on the Mobs SEARCH LIST: the tab came back, the page did not. The
// origin stack cannot carry the page without `appRouting.ts` growing a payload, and that file is
// held byte-identical across the fork's open branches - so the page rides beside the stack in a
// module of its own, and the router is untouched.
//
// TWO FACTS, ONE HANDSHAKE. A view PARKS its drill state when it unmounts (whatever took it away);
// the Back affordance that navigates through `nav.back()` NOTES which view it is returning to; and
// the view that mounts next TAKES its parked state only when both agree. A manual tab switch, a
// bare opener or a fresh deep link notes nothing, so the parked state stays inert and the view
// opens on its own browse surface exactly as before - "Back means where you came from" (JOS-43)
// gains the page, and every other arrival keeps its meaning.
//
// SESSION-LIFETIME AND ONE SLOT, like the origin stack: no storage, no IPC, and the newest park
// replaces the last (a view leaves at most one page behind). The ONE arrival this does not cover
// is the mouse's Back button pressed on a destination that registered no Back of its own (the loot
// LEDGER after the drill was closed by hand): that press falls through to App's origin walk, which
// notes nothing, and the receiver opens on its list. Naming it beats a second copy of the walk.
//
// TYPE-ONLY import of `View`, the navOrigin.ts reason: `appViews` reads `import.meta.env`, and an
// erased import is what lets `node --test` load this file (tests/navReturn.test.mts).

import type { View } from '../appViews'

let parked: { view: View; state: unknown } | null = null
let returning: View | null = null

/** A view leaving the screen records what it was showing; `null` records that it showed its list. */
export function parkReturn(view: View, state: unknown): void {
  parked = state === null || state === undefined ? null : { view, state }
}

/** A Back affordance that just navigated through `nav.back()` says where it went. */
export function noteBack(origin: View): void {
  returning = origin
}

/**
 * The state a view should open on, or `null` for its own browse surface. Consumes the Back note
 * whatever the answer (it was one press's worth of signal) and the parked state only when it was
 * this view's and a Back is what brought the view back. `unknown` on purpose: the slot is typed by
 * whoever parks into it, and the one view that reads it back is the one that wrote it.
 */
export function takeReturn(view: View): unknown {
  const back = returning
  returning = null
  if (back !== view || parked?.view !== view) return null
  const state = parked.state
  parked = null
  return state
}

/** Test seam: the module is window-lifetime state, and a test wants a clean one. */
export function resetNavReturn(): void {
  parked = null
  returning = null
}
