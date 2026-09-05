// THE OWNED SIDE OF THE GAP TEST — `features/plan/planOwned.ts`, the production fold behind
// `PlanCorpora.owned`, `ownedBestBySlot` and `ownedHaste` (progressionPlan.ts rules 8 and 12).
//
// WHAT IS PINNED, and both were bugs on 2026-08-25:
//   1. TWO SETS. A looted-but-not-in-dump item and a melted one are EXCLUDED as targets and set NO
//      bar and NO haste; neither does a copy the dump files in a BAG or the BANK (owner, 2026-08-25:
//      "haste should only be EQUIPPED items"). Only an EQUIPPED copy does either.
//   2. ONE HASTE RULE. The haste weapon's own bar keeps full credit for its haste; a haste item in
//      another slot is scored against the sword; a hasteless slot's bar is its plain score.
//
// Synthetic rows (the corpus type is `GearRow`, the scores are `roleValue`'s own numbers).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GearRow } from '../src/shared/planner/gear'
import { roleValue } from '../src/shared/planner/progressionPlan'
import type { GearOwnership, GearOwnershipMap, OwnedFact } from '../src/renderer/src/features/gear/gearOwnership'
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

/** One ownership record, with only the bits this fold reads set — the rest are its defaults. */
function own(over: Partial<Pick<GearOwnership, 'facts' | 'looted' | 'exaltations'>>): GearOwnership {
  const facts = over.facts ?? []
  return { facts, exaltations: 0, owned: facts.length > 0, looted: false, lootedNotInDump: false, ...over }
}

/** A dump fact at one place — `gearOwnershipOf`'s own classification, handed in rather than re-derived. */
const at = (place: OwnedFact['place']): OwnedFact => ({ place, count: 1 })

const SWORD = row({ key: 'haste sword', name: 'Haste Sword', slots: ['PRIMARY'], stats: { DMG: 10, DELAY: 20, HASTE: 36 } })
const GLOVES = row({ key: 'quick gloves', name: 'Quick Gloves', slots: ['HANDS'], stats: { AC: 2, HASTE: 9 } })
const TUNIC = row({ key: 'plain tunic', name: 'Plain Tunic', slots: ['CHEST'], stats: { AC: 20 } })
const BY_KEY = new Map([SWORD, GLOVES, TUNIC].map((r) => [r.key, r]))

test('HELD is what the route will not farm; WORN is what the dump says is EQUIPPED — two sets, not one', () => {
  const map: GearOwnershipMap = new Map([
    ['haste sword', own({ facts: [at('equipped')] })],
    // Looted this epoch and no longer in the dump: sold, banked elsewhere, or handed on.
    ['quick gloves', own({ looted: true })],
    // Melted: the exaltation row proves a copy passed through, and the dump names no copy.
    ['plain tunic', own({ exaltations: 1 })]
  ])
  const keys = ownedKeysOf(map)
  assert.deepEqual([...keys.held].sort(), ['haste sword', 'plain tunic', 'quick gloves'], 'all three are excluded as targets')
  assert.deepEqual([...keys.worn], ['haste sword'], 'only the equipped copy sets a bar')

  // …so the looted glove sets NO haste and the melted tunic NO chest bar.
  const side = ownedSide(keys, BY_KEY, 'dps', ['WAR'])
  assert.deepEqual(side.haste, [{ haste: 36, slots: ['PRIMARY'] }])
  assert.deepEqual([...side.bars.keys()], ['PRIMARY'])

  // No dump and no loot is two empty sets, never a throw.
  assert.deepEqual(ownedKeysOf(null), { held: new Set(), worn: new Set(), wornAny: new Set() })
})

test('a haste item in a BAG or the BANK sets neither a bar nor the haste ceiling; the same item EQUIPPED sets both', () => {
  // Owner, 2026-08-25: "haste should only be EQUIPPED items". The dump names the sword either way
  // and `owned` is true either way — the place is the whole difference.
  for (const place of ['inventory', 'bank', 'sharedBank', 'personalDepot'] as const) {
    const stowed = ownedKeysOf(new Map([['haste sword', own({ facts: [at(place)] })]]))
    assert.deepEqual([...stowed.held], ['haste sword'], `${place}: still not a thing to farm`)
    assert.deepEqual([...stowed.worn], [], `${place}: not worn`)
    const side = ownedSide(stowed, BY_KEY, 'dps', ['WAR'])
    assert.deepEqual(side.haste, [], `${place}: a haste blade there is not haste you have`)
    assert.equal(side.bars.size, 0, `${place}: sets no bar`)
  }
  // EQUIPPED — and a second copy in the bank beside it changes nothing: the worn one is worn.
  for (const facts of [[at('equipped')], [at('bank'), at('equipped')]]) {
    const keys = ownedKeysOf(new Map([['haste sword', own({ facts })]]))
    assert.deepEqual([...keys.worn], ['haste sword'])
    const side = ownedSide(keys, BY_KEY, 'dps', ['WAR'])
    assert.deepEqual(side.haste, [{ haste: 36, slots: ['PRIMARY'] }])
    assert.equal(side.bars.get('PRIMARY'), roleValue(SWORD.stats, 'dps'))
  }
})

test('the haste source keeps full credit in its own slot, and every other bar is read against it', () => {
  const worn = new Set(['haste sword', 'quick gloves', 'plain tunic'])
  const side = ownedSide({ worn, wornAny: new Set() }, BY_KEY, 'dps', ['WAR'])
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
  const side = ownedSide({ worn: new Set(['unknown relic']), wornAny: new Set() }, BY_KEY, 'tank', [])
  assert.equal(side.bars.size, 0)
  assert.deepEqual(side.haste, [])
})

// ---- the Cursed Blade regression (fork, kaltinril 2026-09-04) ---------------------------------
// A reworked level-20 drop (12/36 with a flat DMG Bonus 17 and 10 DEX) outranked an 11/24 blade
// twice over: the bonus was weighted flat at 3, and melee DEX at 1 let ten of it outvote a third
// of a blade's white damage. Both leaks are pinned here BASE against BASE, the fold's own rule 6
// ("base stats can be used, that's fine, because we can upgrade") — the bars stay unscaled.

const BLOOD_FIRE = row({
  key: 'blood fire', name: 'Blood Fire', slots: ['PRIMARY', 'SECONDARY'],
  stats: { DMG: 11, DELAY: 24 }
})
const CURSED_BLADE = row({
  key: 'cursed blade', name: 'Cursed Blade', slots: ['PRIMARY', 'SECONDARY'],
  stats: { DMG: 12, DELAY: 36, DMG_BONUS: 17, DEX: 10, STA: -5 }
})

test('cursed blade loses to blood fire, base against base: the flat bonus and the DEX are garnish', () => {
  const byKey = new Map([[BLOOD_FIRE.key, BLOOD_FIRE]])
  const side = ownedSide({ worn: new Set([BLOOD_FIRE.key]), wornAny: new Set() }, byKey, 'dps1h', ['WAR'])
  const bar = side.bars.get('PRIMARY')
  assert.ok(bar !== undefined, 'the worn blade sets a PRIMARY bar')
  const challenger = roleValue(CURSED_BLADE.stats, 'dps1h', { classes: ['WAR'] })
  assert.ok(
    challenger < bar,
    `the level-20 drop (${challenger.toFixed(1)}) must not clear the bar (${bar.toFixed(1)})`
  )
})

test('an Any Slot resident is worn for haste and absent for bars — the wildcard is not its native slot', () => {
  // The field case: a resist shield parked in Any Slot (slot: null in the dump) must not bar the
  // offhand it is not in — but a haste item there is still haste you have (worn is worn).
  const wild: OwnedFact = { place: 'equipped', count: 1, wildcard: true }
  const keys = ownedKeysOf(new Map([['haste sword', own({ facts: [wild] })]]))
  assert.deepEqual([...keys.worn], [])
  assert.deepEqual([...keys.wornAny], ['haste sword'])
  const side = ownedSide(keys, BY_KEY, 'dps', ['WAR'])
  assert.equal(side.bars.size, 0, 'no bar from the wildcard cell')
  assert.deepEqual(side.haste, [{ haste: 36, slots: ['PRIMARY'] }], 'its haste still counts')
  // Worn in a REAL cell too: the real cell wins and the bar is back.
  const both = ownedKeysOf(new Map([['haste sword', own({ facts: [wild, at('equipped')] })]]))
  assert.deepEqual([...both.worn], ['haste sword'])
  assert.equal(ownedSide(both, BY_KEY, 'dps', ['WAR']).bars.size > 0, true)
})

test('vacra av svim loses the offhand to whitened treant fists: weapon garnish is damped', () => {
  // The second field case (fork, kaltinril 2026-09-04): a 10/31 stat-stick outranked a 14/28+13
  // because six STR at full weight outvoted a fifth of the offhand's white damage. On a weapon
  // row the attribute garnish counts at the focus's stated fraction (`weaponGarnish`), and the
  // stick belongs in a wildcard cell, not the offhand.
  const FISTS = row({
    key: 'whitened treant fists', name: 'Whitened Treant Fists', slots: ['PRIMARY', 'SECONDARY'],
    stats: { DMG: 14, DELAY: 28, DMG_BONUS: 13 }
  })
  const VACRA = row({
    key: 'vacra av svim', name: 'Vacra Av Svim', slots: ['SECONDARY'],
    stats: { DMG: 10, DELAY: 31, STR: 6, WIS: 6, AGI: 6, HP: 5, AC: 6 }
  })
  const byKey = new Map([[FISTS.key, FISTS]])
  const bar = ownedSide({ worn: new Set([FISTS.key]), wornAny: new Set() }, byKey, 'dps1h', ['WAR', 'MNK', 'SHM']).bars.get('SECONDARY')
  assert.ok(bar !== undefined)
  const challenger = roleValue(VACRA.stats, 'dps1h', { classes: ['WAR', 'MNK', 'SHM'] })
  assert.ok(
    challenger < bar,
    `the stat-stick (${challenger.toFixed(1)}) must not clear the offhand bar (${bar.toFixed(1)})`
  )
})
