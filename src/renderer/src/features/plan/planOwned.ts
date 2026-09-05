// plan/planOwned.ts — WHAT THE CHARACTER ALREADY HAS, folded the two ways the route reads it
// (docs/plans/gear-progression-planner.md §2.3, §2.4; `progressionPlan.ts` rules 8 and 12).
//
// PURE, with RELATIVE value imports — the `maps/mobPins.ts` precedent — so `tests/planOwned.test.mts`
// drives it under plain node. `planData.ts` is the React half and only wires these into memos.
//
// TWO READINGS OF ONE OWNERSHIP MAP, AND THEY ARE DIFFERENT SETS ON PURPOSE (corrected 2026-08-25;
// the first cut used one set for both, and it was the wider one):
//
//   * HELD is what the route must not send you to farm: a copy the dump names, a copy the log saw
//     you loot this epoch, or an exaltation — proof a copy passed through your hands, even if you
//     melted it (`gearOwnership.ts` rule 2, and `gearData.useOwnedOrLooted`'s own predicate). That
//     is the fold's `owned` set, the EXCLUSION (rule 8).
//   * WORN is what sets a slot's BAR and states the haste you have: copies the dump files at an
//     EQUIPPED location, and nothing else. Owner ruling, 2026-08-25: *"haste should only be
//     EQUIPPED items"* — haste and bars come from what is EQUIPPED, and a haste blade in the bank is
//     not haste you have. A looted item the dump does not name is not on your character at all
//     (sold, banked on another, melted), and a copy in a bag or the bank is not on your character
//     EITHER for this question — a bar it set would be a bar for something you are not wearing,
//     hiding every real upgrade under it, and a banked haste blade would zero the haste credit of
//     every glove in the game. The place is READ, never re-derived: `gearOwnership.ts` already
//     classified every dump row into `OwnedFact.place` off `ownership.ts placeOfLocation`, and
//     `'equipped'` is that vocabulary's own word.
//
// THE BAR AND THE CANDIDATE ARE SCORED UNDER ONE HASTE RULE (rule 12, the corrected reading): a
// row's haste is credited only above the haste you would still own with THAT slot swapped out
// (`ownedHasteOutside`), on both sides. The haste weapon's own bar therefore keeps full credit for
// its haste — swapping its slot is what loses it — and its replacement is scored with the same
// full credit, so a better haste weapon clears the bar and a hasteless one with a slightly better
// ratio does not.

import type { ClassAbbr } from '../../../../shared/classCombo'
import type { GearRow } from '../../../../shared/planner/gear'
import type { EquipSlot } from '../../../../shared/planner/types'
import {
  ownedHasteOutside,
  roleValue,
  type GearRole,
  type OwnedHaste
} from '../../../../shared/planner/progressionPlan'
import { scaleGearRow } from '../../../../shared/planner/gearScale'
import type { GearOwnershipMap, OwnedFact } from '../gear/gearOwnership'

/** The two collections — see the header for why they differ. */
export interface OwnedKeys {
  /** excluded as targets: you do not farm what has passed through your hands */
  held: ReadonlySet<string>
  /** sets the bars and states the owned haste: what the dump files as EQUIPPED, nothing else —
   *  each key carrying the ` +N` its worn copy's name stated. `undefined` is a name that stated
   *  none (never `+0`, phase 1's rule). The bar is scored AT this plus (fork decision, kaltinril
   *  2026-09-04): a +7 blade scored at +0 set a bar a third under what the player actually
   *  swings, and a level-20 drop cleared it. */
  worn: ReadonlyMap<string, number | undefined>
}

/** Fold one dump fact into the worn map: worn at all, and at the best stated plus among copies. */
function noteEquipped(worn: Map<string, number | undefined>, key: string, fact: OwnedFact): void {
  if (fact.place !== 'equipped') return
  const held = worn.get(key)
  if (!worn.has(key) || (fact.tier !== undefined && fact.tier > (held ?? -1))) worn.set(key, fact.tier)
}

/**
 * One pass over the ownership map, both collections. `null` (no dump, no loot) is two empty ones.
 * A key is WORN when any of its dump facts sits at an equipped location — a copy worn AND a copy
 * banked is still worn — and HELD when the dump, the log or an exaltation names it anywhere.
 */
export function ownedKeysOf(map: GearOwnershipMap | null): OwnedKeys {
  const held = new Set<string>()
  const worn = new Map<string, number | undefined>()
  if (map !== null) {
    for (const [key, o] of map) {
      for (const fact of o.facts) noteEquipped(worn, key, fact)
      if (o.owned || o.looted || o.exaltations > 0) held.add(key)
    }
  }
  return { held, worn }
}

/** The owned side of the gap test, as the fold's two corpora fields. */
export interface OwnedSide {
  /** `PlanCorpora.ownedBestBySlot` */
  bars: ReadonlyMap<EquipSlot, number>
  /** `PlanCorpora.ownedHaste` */
  haste: readonly OwnedHaste[]
}

/**
 * THE BAR EACH SLOT HAS TO BEAT, AND THE HASTE YOU OWN — the half of the plan that makes it "look
 * at what I have" (owner, 2026-08-15: *"i should be able to gear my guy up, so it needs to look at
 * what I have and the best in slot"*), and the production side of `PlanCorpora.ownedBestBySlot`
 * and `PlanCorpora.ownedHaste`.
 *
 * ONE OWNED ITEM RAISES EVERY SLOT IT FITS, and the bar is the MAX rather than a sum or an average:
 * the question the fold asks is "would this beat what I would actually wear there", and what you
 * would wear there is your best. An earring that fits two ear cells raises both. The same reading
 * places a haste source in every slot it fits (`OwnedHaste.slots`).
 *
 * BASE STATS, LIKE THE TARGETS THEY ARE COMPARED AGAINST (fold rule 6, the owner's *"base stats can
 * be used, that's fine, because we can upgrade"*). `useGearIndex` hands out the UNSCALED corpus, so
 * this is base-against-base by construction — and it has to be, because the owned copy's real `+N`
 * is a fact off the dump while a drop's tier is a thing you have not earned yet. Scoring the owned
 * side at its merged tier would raise every bar past every drop and empty the route. Haste is a
 * percentage the `+N` tier does not move, so base is not even an approximation there.
 *
 * THE SAME CLASS GATE THE CANDIDATES ARE READ THROUGH (fold rule 13) — a bar and the item measured
 * against it must agree on which stats are live, or a warrior's INT glove would set a bar its own
 * replacement is not allowed to clear.
 *
 * A KEY THE CORPUS HAS NO ROW FOR CONTRIBUTES NOTHING (law 1). The dump names items this scrape may
 * not describe; a row we cannot score is not a bar of zero, it is a slot this map declines to speak
 * for — which the fold then reads as a gap and keeps offering upgrades into. That is the honest
 * failure direction.
 *
 * ONE WALK OF THE WORN SET: the rows are resolved and the haste sources collected in the same pass,
 * and the bars are scored afterwards because a bar's haste term needs every source known first.
 */
export function ownedSide(
  worn: ReadonlyMap<string, number | undefined>,
  byKey: ReadonlyMap<string, GearRow>,
  role: GearRole,
  classes: readonly ClassAbbr[]
): OwnedSide {
  const rows: GearRow[] = []
  const haste: OwnedHaste[] = []
  for (const [key, plus] of worn) {
    const base = byKey.get(key)
    if (base === undefined) continue
    // The bar is what the player actually swings: the corpus row scaled to the worn ` +N`
    // (fork decision, kaltinril 2026-09-04). No plus stated is the base row, never `+0` invented.
    const row = plus === undefined ? base : scaleGearRow(base, { full: plus, fraction: 0 })
    rows.push(row)
    if (row.stats.HASTE !== undefined && row.stats.HASTE > 0) haste.push({ haste: row.stats.HASTE, slots: row.slots })
  }
  const bars = new Map<EquipSlot, number>()
  for (const row of rows) {
    for (const slot of row.slots) {
      const score = roleValue(row.stats, role, { classes, ownedHaste: ownedHasteOutside(haste, slot) })
      const held = bars.get(slot)
      if (held === undefined || score > held) bars.set(slot, score)
    }
  }
  return { bars, haste }
}
