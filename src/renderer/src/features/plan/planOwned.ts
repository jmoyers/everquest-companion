// plan/planOwned.ts — WHAT THE CHARACTER ALREADY HAS, folded the two ways the route reads it
// (docs/plans/gear-progression-planner.md §2.3, §2.4; `progressionPlan.ts` rules 8 and 12).
//
// PURE, with RELATIVE value imports — the `maps/mobPins.ts` precedent — so `tests/planOwned.test.mts`
// drives it under plain node. `planData.ts` is the React half and only wires these into memos.
//
// TWO READINGS OF ONE OWNERSHIP MAP, AND THEY ARE DIFFERENT SETS ON PURPOSE (corrected 2026-08-25;
// the first cut used one set for both, and it was the wider one):
//
//   * HELD is what the route must not send you to farm: a copy the dump names, or an exaltation —
//     proof a copy is in your possession right now, melted included. NOT a bare loot line (the
//     2026-09-05 ruling on `ownedKeysOf`). That is the fold's `owned` set, the EXCLUSION (rule 8).
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

import type { GearRow } from '../../../../shared/planner/gear'
import type { EquipSlot } from '../../../../shared/planner/types'
import {
  ownedHasteOutside,
  roleValue,
  type OwnedHaste,
  type PlanScope
} from '../../../../shared/planner/progressionPlan'
import { ROLE_WEAPON_POLICY, policyAdmits } from '../../../../shared/planner/roleWeights'
import type { GearOwnershipMap } from '../gear/gearOwnership'

/** The two sets — see the header for why they differ. */
export interface OwnedKeys {
  /** excluded as targets: you do not farm what has passed through your hands */
  held: ReadonlySet<string>
  /** sets the bars and states the owned haste: what the dump files as EQUIPPED in a real cell */
  worn: ReadonlySet<string>
  /** EQUIPPED only in a wildcard cell (`Any Slot` / `Held`): worn — its haste is haste you have —
   *  but occupying no wiki slot, so it sets NO bar (fork report, kaltinril 2026-09-04: a resist
   *  shield parked in Any Slot barred the offhand it was not in). A key worn in a real cell TOO
   *  stays in `worn`. */
  wornAny: ReadonlySet<string>
}

/**
 * One pass over the ownership map, both sets. `null` (no dump, no loot) is two empty sets.
 * A key is WORN when any of its dump facts sits at an equipped location — a copy worn AND a copy
 * banked is still worn — and HELD when the DUMP names a copy or an exaltation row proves one was
 * melted in.
 *
 * A LOOT LINE ALONE IS NOT HELD (fork ruling, kaltinril 2026-09-05: *"Looted once doesn't mean i
 * didn't accidently destroy, sell, or give it to a friend, so you can't count looted alone, i have
 * to own it"*) — the log proves a copy passed THROUGH your hands, the dump proves one is IN them,
 * and only the second is a reason to stop recommending the farm. This reverses the 2026-08-25
 * reading, which hid the Bow of the Underfoot from the very player who had lost his.
 */
export function ownedKeysOf(map: GearOwnershipMap | null): OwnedKeys {
  const held = new Set<string>()
  const worn = new Set<string>()
  const wornAny = new Set<string>()
  if (map !== null) {
    for (const [key, o] of map) {
      const cell = o.facts.some((fact) => fact.place === 'equipped' && fact.wildcard === undefined)
      const wild = o.facts.some((fact) => fact.place === 'equipped' && fact.wildcard === true)
      if (cell) worn.add(key)
      else if (wild) wornAny.add(key)
      if (o.owned || o.exaltations > 0) held.add(key)
    }
  }
  return { held, worn, wornAny }
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
 * replacement is not allowed to clear. The same survivability dial too, for the same reason: a bar
 * scored glass-cannon against candidates scored wooden would clear or block on taste alone.
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
  keys: Pick<OwnedKeys, 'worn' | 'wornAny'>,
  byKey: ReadonlyMap<string, GearRow>,
  scope: Pick<PlanScope, 'role' | 'classes' | 'survivability'>
): OwnedSide {
  const rows: GearRow[] = []
  const haste: OwnedHaste[] = []
  for (const key of [...keys.worn, ...keys.wornAny]) {
    const row = byKey.get(key)
    if (row === undefined) continue
    // A wildcard resident is worn for HASTE (it is on the character) and absent for BARS (it
    // occupies no wiki slot) — the fork report above.
    if (keys.worn.has(key)) rows.push(row)
    // A haste WEAPON's percentage is still haste you own — swapped out of the hand, it keeps
    // granting from an Any Slot (fork ruling, 2026-09-05: "i could still toss the monsoon in one
    // of the two ANY slots to gain the haste") — so every worn source counts here, weapons
    // included. What changed is the other side: `roleValue` prices haste at NOTHING on a weapon
    // row, so a blade never wins or loses the HAND comparison on a stat the loadout keeps anyway.
    if (row.stats.HASTE !== undefined && row.stats.HASTE > 0) haste.push({ haste: row.stats.HASTE, slots: row.slots })
  }
  const bars = new Map<EquipSlot, number>()
  const ctx = { classes: scope.classes, survivability: scope.survivability }
  for (const row of rows) {
    for (const slot of row.slots) {
      const score = roleValue(row.stats, scope.role, { ...ctx, ownedHaste: ownedHasteOutside(haste, slot) })
      const held = bars.get(slot)
      if (held === undefined || score > held) bars.set(slot, score)
    }
  }
  return { bars, haste }
}

/** One thing you already own that beats what you wear — the "equip it, you idiot" advisory. */
export interface OwnedUpgrade {
  key: string
  name: string
  /** the slot it clears, at its highest-clearing score */
  slot: EquipSlot
}

/**
 * WHAT YOU OWN BUT DO NOT WEAR THAT BEATS WHAT YOU WEAR (fork ruling, kaltinril 2026-09-05: *"if i
 * have it in a bank slot and i'm an idiot it needs to tell me to equip it"*). The route excludes
 * everything HELD as a farm target — correctly, you do not farm what you have — but a banked
 * upgrade was falling into the silence between "go get" and "already worn". Same math as the gap
 * test on candidates: the held row's score in a slot, against that slot's bar, base against base,
 * through the same dial — AND THROUGH THE SAME WEAPON-SLOT POLICY (fork report, minutes after it
 * shipped without one: "it's recommending my 2h for 1h dps" — a banked two-hander is not advice a
 * 1H focus may give about the main hand, exactly as the route may not suggest one). A slot with NO
 * bar is a gap and the held item fills it. Sorted best first.
 */
export function ownedUpgrades(
  keys: OwnedKeys,
  byKey: ReadonlyMap<string, GearRow>,
  side: OwnedSide,
  scope: Pick<PlanScope, 'role' | 'classes' | 'survivability'>
): OwnedUpgrade[] {
  const out: { up: OwnedUpgrade; score: number }[] = []
  const ctx = { classes: scope.classes, survivability: scope.survivability }
  const policy = ROLE_WEAPON_POLICY[scope.role]
  for (const key of keys.held) {
    if (keys.worn.has(key) || keys.wornAny.has(key)) continue
    const row = byKey.get(key)
    if (row === undefined) continue
    let bestSlot: EquipSlot | undefined
    let bestScore = -Infinity
    for (const slot of row.slots) {
      if (!policyAdmits(policy, slot, row)) continue
      const score = roleValue(row.stats, scope.role, { ...ctx, ownedHaste: ownedHasteOutside(side.haste, slot) })
      const bar = side.bars.get(slot)
      if (bar !== undefined && score <= bar) continue
      if (score > bestScore) {
        bestScore = score
        bestSlot = slot
      }
    }
    if (bestSlot !== undefined) out.push({ up: { key, name: row.name, slot: bestSlot }, score: bestScore })
  }
  return out.sort((a, b) => b.score - a.score || a.up.name.localeCompare(b.up.name)).map((o) => o.up)
}
