// planner/plannerPreset.ts — WHICH ITEM IS THE BROWSER NARROWED TO.
//
// The planner had one way in: pick an effect, then say which slot it lands in. The owner asked for
// the other one, which is how the game itself presents the decision — you name an item and you see
// what can legally go in it. JOS-210 opened two doors onto that one narrowing, and JOS-326 closed
// the first of them:
//
//   * THE INVENTORY TAB'S `BrowsePreset` — a cell, one of its four sockets, and the host that cell
//     was wearing — IS GONE with the plan board it was a message from. Its whole apparatus went
//     with it: the exact-key lookup that turned a dump-filled host name into slots and classes, the
//     merge that let a preset outrank a hand-picked item, and the cell the focus used to carry.
//   * THE FILTER BAR'S OWN ITEM PICKER remains, and it was always the wider of the two: it reaches
//     ANY item the committed DB carries rather than only the ones a set already hosted, which was
//     the whole of the owner's ask. It is now the only way a focus is set, so an `ItemFocus` is
//     simply what the user picked.
//
// AND THE FOCUS SURVIVES A KIND SWITCH (JOS-210, the bug half), now by construction rather than by
// arrangement: the picked item is its own state in EffectBrowser and no filter-bar write touches
// it, so "show me this item's worn effects instead of its procs" cannot throw the item away.

import { useEffect, useState } from 'react'
import type { ClassAbbr } from '@shared/classCombo'
// RELATIVE value imports (the mobSearch house law): `itemFits` is reached under the node runner by
// tests/plannerItemFilter.test.mts, where the vite-only `@shared` alias does not resolve.
import { socketCompatibility } from '../../../../shared/planner/rules'
import {
  EQUIP_SLOTS,
  type EquipSlot,
  type PlannerDonor,
  type PlannerItemHit
} from '../../../../shared/planner/types'
import { classesMismatch } from './plannerClasses'

/**
 * THE ITEM THE BROWSER IS FILTERING BY.
 *
 * `slots` and `classes` are R2's two halves as facts about the ITEM, and both are empty when
 * nothing states them: an empty list is UNKNOWN and narrows nothing (law 1), never "nowhere" or
 * "nobody".
 */
export interface ItemFocus {
  /** `itemKey(name)` */
  key: string
  name: string
  /** where it is worn. `[]` = unknown, which filters nothing. */
  slots: readonly EquipSlot[]
  /** who can use it. `[]` = unknown, which filters nothing. */
  classes: readonly ClassAbbr[]
}

/**
 * CAN THIS DONOR'S EFFECT MOVE INTO THIS ITEM? — R2 and R3, asked as a FILTER.
 *
 * The rule itself is `socketCompatibility` (shared/planner/rules.ts) and is not restated here: it
 * owns R3's flat no on haste and R2's slot half, and passing it an EMPTY class list is how this
 * file asks for those two alone. The class half is then `classesMismatch`, which is the one rule
 * the browser filter and the Board's mismatch chip already share.
 *
 * WHY THE CLASS HALF IS ASKED SEPARATELY: `socketCompatibility` answers for a PLANNED socket, where
 * an unknown must be reported rather than passed ("this page states no class list"). A browser
 * filter has the opposite obligation — hiding every donor whose page stayed silent would assert a
 * fact the wiki declined to state (law 1) — so an unknown on either side passes here and the row is
 * chipped instead.
 *
 * An item with NO STATED SLOTS narrows nothing rather than matching nothing: the filter bar's
 * picker only ever offers items that state one, so this arm is unreachable from the UI and exists
 * so a gap in our own data can never blank the browser.
 */
export function itemFits(donor: PlannerDonor, item: ItemFocus): boolean {
  const slots = item.slots.length === 0 ? EQUIP_SLOTS : item.slots
  if (!socketCompatibility(donor, slots, []).ok) return false
  return !classesMismatch(donor.classes, item.classes)
}

// ---- the item index, as the two pickers ask it ----------------------------------------

/**
 * Shortest query worth a round trip — one letter matches thousands of items and says nothing.
 *
 * IT APPLIES ONLY WHEN THERE IS NO SLOT TO NARROW BY. A caller that names an equipment slot has a
 * CLOSED, small set to offer and does not need a query at all ("what can go here" is the question
 * an empty cell poses), so `useItemSearch` waives this for them. Without a slot the haystack is
 * still the whole corpus and the rule stands unchanged.
 */
export const MIN_QUERY = 2

export interface ItemHitsState {
  hits: PlannerItemHit[]
  loading: boolean
}

/**
 * One search per settled query, shared by the host picker and the filter bar's item picker. An
 * in-flight answer for an older query is dropped, not shown; `enabled` is the popover's own open
 * state, because a closed picker must not keep asking.
 *
 * `slot` IS PASSED TO MAIN RATHER THAN APPLIED TO THE ANSWER, and it changes two things. Main
 * narrows before its fifty-hit cap, so the fifty that come back are fifty the caller can use — a
 * FINGER cell searching "ri" used to get fifty rows ranked across the whole corpus and keep
 * whichever happened to be rings. And a slotted search needs no minimum query, because the set it
 * offers is closed: see `MIN_QUERY`.
 */
export function useItemSearch(
  query: string,
  enabled: boolean,
  slot?: EquipSlot,
  limit?: number
): ItemHitsState {
  const [state, setState] = useState<ItemHitsState>({ hits: [], loading: false })
  useEffect(() => {
    if (!enabled || (slot === undefined && query.trim().length < MIN_QUERY)) {
      setState({ hits: [], loading: false })
      return
    }
    let alive = true
    setState((prev) => ({ hits: prev.hits, loading: true }))
    void window.eq
      .plannerSearchItems(query.trim(), slot, limit)
      .then((hits) => {
        if (alive) setState({ hits, loading: false })
      })
      .catch(() => {
        /* main never rejects; an empty list is the honest answer */
        if (alive) setState({ hits: [], loading: false })
      })
    return () => {
      alive = false
    }
  }, [query, enabled, slot, limit])
  return state
}
