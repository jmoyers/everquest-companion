// THE OWNED SIDE OF THE GAP TEST — `features/plan/planOwned.ts`, the production fold behind
// `PlanCorpora.owned`, `ownedBestBySlot` and `ownedHaste` (progressionPlan.ts rules 8 and 12).
//
// WHAT IS PINNED, and both were bugs on 2026-08-25:
//   1. TWO SETS. A looted-but-not-in-dump item and a melted one are EXCLUDED as targets and set NO
//      bar and NO haste; only a dump-present copy does either.
//   2. ONE HASTE RULE. The haste weapon's own bar keeps full credit for its haste; a haste item in
//      another slot is scored against the sword; a hasteless slot's bar is its plain score.
//
// Synthetic rows (the corpus type is `GearRow`, the scores are `roleValue`'s own numbers).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GearRow } from '../src/shared/planner/gear'
import { roleValue } from '../src/shared/planner/progressionPlan'
import type { GearOwnership, GearOwnershipMap } from '../src/renderer/src/features/gear/gearOwnership'
import { ownedKeysOf, ownedSide } from '../src/renderer/src/features/plan/planOwned'

function row(over: Partial<GearRow> & Pick<GearRow, 'key' | 'name'>): GearRow {
  return {
    searchKey: over.name.toLowerCase(),
    slots: ['CHEST'],
    classes: [],
    races: ['ALL'],
    flags: [],
    quest: false,
    playerCrafted: false,
    stats: {},
    effects: [],
    ...over
  }
}

/** One ownership record, with only the three bits this fold reads set — the rest are its defaults. */
function own(over: Partial<Pick<GearOwnership, 'owned' | 'looted' | 'exaltations'>>): GearOwnership {
  return { facts: [], exaltations: 0, owned: false, looted: false, lootedNotInDump: false, ...over }
}

const SWORD = row({ key: 'haste sword', name: 'Haste Sword', slots: ['PRIMARY'], stats: { DMG: 10, DELAY: 20, HASTE: 36 } })
const GLOVES = row({ key: 'quick gloves', name: 'Quick Gloves', slots: ['HANDS'], stats: { AC: 2, HASTE: 9 } })
const TUNIC = row({ key: 'plain tunic', name: 'Plain Tunic', slots: ['CHEST'], stats: { AC: 20 } })
const BY_KEY = new Map([SWORD, GLOVES, TUNIC].map((r) => [r.key, r]))

test('HELD is what the route will not farm; WORN is what the dump says is on you — two sets, not one', () => {
  const map: GearOwnershipMap = new Map([
    ['haste sword', own({ owned: true })],
    // Looted this epoch and no longer in the dump: sold, banked elsewhere, or handed on.
    ['quick gloves', own({ looted: true })],
    // Melted: the exaltation row proves a copy passed through, and the dump names no copy.
    ['plain tunic', own({ exaltations: 1 })]
  ])
  const keys = ownedKeysOf(map)
  assert.deepEqual([...keys.held].sort(), ['haste sword', 'plain tunic', 'quick gloves'], 'all three are excluded as targets')
  assert.deepEqual([...keys.worn], ['haste sword'], 'only the dump-present copy sets a bar')

  // …so the looted glove sets NO haste and the melted tunic NO chest bar.
  const side = ownedSide(keys.worn, BY_KEY, 'dps', ['WAR'])
  assert.deepEqual(side.haste, [{ haste: 36, slots: ['PRIMARY'] }])
  assert.deepEqual([...side.bars.keys()], ['PRIMARY'])

  // No dump and no loot is two empty sets, never a throw.
  assert.deepEqual(ownedKeysOf(null), { held: new Set(), worn: new Set() })
})

test('the haste source keeps full credit in its own slot, and every other bar is read against it', () => {
  const worn = new Set(['haste sword', 'quick gloves', 'plain tunic'])
  const side = ownedSide(worn, BY_KEY, 'dps', ['WAR'])
  // Two sources, each placed in every slot it fits.
  assert.deepEqual(side.haste, [
    { haste: 36, slots: ['PRIMARY'] },
    { haste: 9, slots: ['HANDS'] }
  ])
  // PRIMARY: with the sword swapped out you would still own the glove's 9, so the bar credits 36-9.
  assert.equal(side.bars.get('PRIMARY'), roleValue(SWORD.stats, 'dps', { ownedHaste: 9 }))
  // HANDS: swapping the glove keeps the sword, so the glove's 9 is worth nothing to the bar — it is
  // AC 2 and no more, which is exactly what a 9% glove offered INTO that slot would score too.
  assert.equal(side.bars.get('HANDS'), roleValue(GLOVES.stats, 'dps', { ownedHaste: 36 }))
  assert.equal(side.bars.get('HANDS'), roleValue({ AC: 2 }, 'dps'))
  // CHEST states no haste, so the rule does not touch it.
  assert.equal(side.bars.get('CHEST'), roleValue(TUNIC.stats, 'dps'))
})

test('a key the corpus has no row for contributes nothing — a gap, not a bar of zero', () => {
  const side = ownedSide(new Set(['unknown relic']), BY_KEY, 'tank', [])
  assert.equal(side.bars.size, 0)
  assert.deepEqual(side.haste, [])
})
