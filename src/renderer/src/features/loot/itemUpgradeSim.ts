// loot/itemUpgradeSim.ts — the item card's simulate-upgrade slider, as a PURE MODEL.
//
// The Loot drill-down draws a wearable item at any plus-state with the Gear toolbar's own control
// (fork decision, kaltinril 2026-09-13). The component (ItemDetailDialog.tsx `ItemWindowColumn`)
// owns one `useState`; every decision around it is here, where a node test can reach it:
//
//   * WHICH ITEMS get the control — the ones that state a `Slot:` line. That is the same census the
//     Gear tab's index takes (shared/planner/gear.ts: a row exists when it has a slot); an item
//     with no slot is not worn and has nothing to simulate.
//   * WHERE THE SLIDER OPENS — the tier the displayed name states, else base. `upgradeStateForTier`
//     is the one reading of a ` +N` the app has (a name says the tier and stops), so a ` +3` loot
//     line opens at tier 3 with the wiki's base numbers scaled to it.
//   * WHEN THE WINDOW IS TOLD — the stats are the wiki's base block, so the window is handed the
//     seed itself when the name puts it past base, and its meter reads the name's tier as always.
//     Only once the reader has moved off the seed is it a `simulated` state; at a base seed the
//     window is handed nothing (the name, or your own merge history with its `yours` tag).
//
// Nothing here scales a number: that is `scaleStatBlock` (shared/itemUpgrade.ts), called by the
// window itself.

import { itemTierFromName, parseStatsBlock, type ItemStatBlock } from '../../../../shared/itemStats'
import { normalizeUpgradeState, upgradeStateForTier, type ItemUpgradeState } from '../../../../shared/itemUpgrade'

/** The block the window draws: the lookup's structured one when it has arrived, else the raw text parsed. */
export function itemWindowBlock(stats?: ItemStatBlock, raw?: string): ItemStatBlock | undefined {
  return stats ?? (raw ? parseStatsBlock(raw) : undefined)
}

/** An item is wearable when it states a slot — the Gear index's own rule. No block, no slot, no slider. */
export function isWearable(block?: ItemStatBlock): boolean {
  return Boolean(block?.slot)
}

/** Where the slider opens: the tier the name states, else base. */
export function upgradeSeed(name: string): ItemUpgradeState {
  return upgradeStateForTier(itemTierFromName(name))
}

/** Two states are the same when they normalize to the same tier and fraction. */
export function sameUpgradeState(a: ItemUpgradeState, b: ItemUpgradeState): boolean {
  const x = normalizeUpgradeState(a)
  const y = normalizeUpgradeState(b)
  return x.full === y.full && x.fraction === y.fraction
}

/** What the window is handed: the state to draw the stats at, and whether the reader chose it. The
    block is the wiki's BASE one, so a seed past base is handed too (a ` +3` card drawn at base numbers
    reads lower than +2), but only a state off the seed is `simulated`. At a base seed: nothing. */
export function windowUpgrade(
  state: ItemUpgradeState,
  seed: ItemUpgradeState
): { upgrade?: ItemUpgradeState; simulated: boolean } {
  const simulated = !sameUpgradeState(state, seed)
  const atBase = sameUpgradeState(state, upgradeStateForTier(0))
  return { upgrade: simulated || !atBase ? normalizeUpgradeState(state) : undefined, simulated }
}

/** What a HOVER card is handed: the name's own seed, unmoved. A hover has no slider, so a ` +4` name
    draws the base block at +4 (untagged) and a plain name draws it as it always has. */
export function nameUpgrade(name: string): ItemUpgradeState | undefined {
  const seed = upgradeSeed(name)
  return windowUpgrade(seed, seed).upgrade
}
