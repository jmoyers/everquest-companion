// THE ITEM CARD'S SIMULATE-UPGRADE SLIDER (fork, kaltinril 2026-09-13): the Loot drill-down mounts
// the Gear toolbar's control under a wearable item's window. These pins are the three decisions the
// pure model makes for the component (renderer/features/loot/itemUpgradeSim.ts):
//   * only an item that states a slot gets the control — the Gear index's own census;
//   * the slider opens at the tier the NAME states (a ` +3` loot line is at tier 3), else base;
//   * the window draws the base block at that seed (a ` +3` card shows +3 numbers), and tags a
//     state `simulated` only once the reader has moved off it — a simulation is never on screen unasked.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseStatsBlock } from '../src/shared/itemStats'
import { scaleStatBlock } from '../src/shared/itemUpgrade'
import {
  isWearable,
  itemWindowBlock,
  nameUpgrade,
  sameUpgradeState,
  upgradeSeed,
  windowUpgrade
} from '../src/renderer/src/features/loot/itemUpgradeSim'
import { tierReading } from '../src/renderer/src/lib/itemTierReading'

const WARHAMMER = `Magic Item, Lore Item, No Drop<br>
Slot: PRIMARY<br>
Class: SHM<br>
Race: ALL<br>
Skill: 1H Blunt  Atk Delay: 24<br>
DMG: 12<br>
WIS: +14  HP: +50  MANA: +50<br>
WT: 3.5  Size: LARGE<br>`

test('wearable is "states a slot": a Primary weapon yes, a slotless page no, no block no', () => {
  const worn = parseStatsBlock(WARHAMMER)
  assert.ok(worn.slot, 'the fixture states a slot line')
  assert.equal(isWearable(worn), true)
  assert.equal(isWearable(parseStatsBlock('Magic Item<br>\nWT: 0.1  Size: TINY<br>')), false, 'no Slot line')
  assert.equal(isWearable(undefined), false, 'nothing known yet - no slider, not a disabled one')
})

test('the window block: the structured lookup wins, else the raw text is parsed, else nothing', () => {
  const structured = parseStatsBlock(WARHAMMER)
  assert.equal(itemWindowBlock(structured, 'WT: 9.9'), structured)
  assert.equal(itemWindowBlock(undefined, WARHAMMER)?.dmg, 12)
  assert.equal(itemWindowBlock(undefined, undefined), undefined)
})

test('the seed is the tier the name states, else base', () => {
  assert.deepEqual(upgradeSeed('Warhammer of the Wind'), { full: 0, fraction: 0 })
  assert.deepEqual(upgradeSeed('Warhammer of the Wind +3'), { full: 3, fraction: 0 })
  assert.deepEqual(upgradeSeed('Warhammer of the Wind +10'), { full: 10, fraction: 0 })
})

test('the window is told nothing at a base seed and the normalized state once moved', () => {
  const base = upgradeSeed('Warhammer of the Wind')
  assert.deepEqual(windowUpgrade({ full: 0, fraction: 0 }, base), { upgrade: undefined, simulated: false }, 'untouched: reads as it always has')
  assert.deepEqual(windowUpgrade({ full: 2, fraction: 3 }, base), { upgrade: { full: 2, fraction: 3 }, simulated: true })
  assert.deepEqual(windowUpgrade({ full: 10, fraction: 7 }, base).upgrade, { full: 10, fraction: 0 }, 'tier 10 banks nothing')
  const three = upgradeSeed('Warhammer of the Wind +3')
  assert.deepEqual(windowUpgrade({ full: 0, fraction: 0 }, three), { upgrade: { full: 0, fraction: 0 }, simulated: true }, 'dragging a +3 down to base IS one')
  assert.equal(sameUpgradeState({ full: 0, fraction: 5 }, { full: 0, fraction: 0 }), true, 'tier 0 has no fraction to differ on')
})

test('a +3 name at its seed draws the base block at tier 3, untagged: +3 never reads below +2', () => {
  const three = upgradeSeed('Warhammer of the Wind +3')
  const atSeed = windowUpgrade(three, three)
  assert.deepEqual(atSeed, { upgrade: { full: 3, fraction: 0 }, simulated: false }, 'scaled, but not a simulation')
  const block = parseStatsBlock(WARHAMMER)
  const shown3 = scaleStatBlock(block, atSeed.upgrade!)
  const shown2 = scaleStatBlock(block, windowUpgrade({ full: 2, fraction: 0 }, three).upgrade!)
  assert.ok(shown3.dmg! >= shown2.dmg!, 'DMG at +3 is at least DMG at +2')
  assert.ok(shown3.dmg! > block.dmg!, 'and above the base block the lookup returned')
  // ItemWindow hands the meter the state only when it is simulated, so at the seed it reads the name.
  assert.deepEqual(tierReading(undefined, 3), { tier: 3 }, 'Tier 3, no `simulated` tag')
  assert.equal(tierReading({ full: 2, fraction: 0 }, 3).note, 'simulated', 'moved off the seed: tagged')
})

test('what the card will show at +10 is phase 0 arithmetic, not a restatement', () => {
  // The window calls scaleStatBlock itself; this pins the numbers the reader will see on the
  // fixture so a change to the calculator shows up here beside the slider that exposes it.
  const at10 = scaleStatBlock(parseStatsBlock(WARHAMMER), { full: 10, fraction: 0 })
  assert.equal(at10.dmg, 24, 'DMG 12 + floor(12 * 10 / 10)')
  assert.equal(at10.atkDelay, 24, 'delay never scales - that is why the ratio improves')
  assert.equal(at10.stats.find((s) => s.key === 'WIS')?.value, '+28', 'floor(14 + round(14 * 10 / 10))')
  assert.equal(at10.stats.find((s) => s.key === 'HP')?.value, '+100')
})

test('a hover card draws the name at its own tier: a +4 hover shows +4 numbers, a plain name base', () => {
  // The hover cards (lib/KnownItemTooltip, overlay/feedHoverCards) have no slider; they hand the
  // window this, so "Warhammer of the Wind +4" never hovers with the wiki's base numbers.
  assert.equal(nameUpgrade('Warhammer of the Wind'), undefined, 'base: the window reads as it always has')
  assert.deepEqual(nameUpgrade('Warhammer of the Wind +4'), { full: 4, fraction: 0 })
  const block = parseStatsBlock(WARHAMMER)
  assert.ok(scaleStatBlock(block, nameUpgrade('Warhammer of the Wind +4')!).dmg! > block.dmg!, 'above base')
})
