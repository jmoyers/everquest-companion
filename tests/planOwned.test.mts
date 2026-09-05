// THE OWNED SIDE OF THE GAP TEST — `features/plan/planOwned.ts`, the production fold behind
// `PlanCorpora.owned`, `ownedBestBySlot` and `ownedHaste` (progressionPlan.ts rules 8 and 12).
//
// WHAT IS PINNED:
//   1. TWO SETS. A dump-owned copy and a melted one are EXCLUDED as targets; a bare loot line is
//      NOT (fork ruling 2026-09-05 — the log is a memory of possession, the dump is proof). No
//      copy in a BAG or the BANK sets a bar or haste (owner, 2026-08-25: "haste should only be
//      EQUIPPED items"): only an EQUIPPED copy does either.
//   2. ONE HASTE RULE. The haste weapon's own bar keeps full credit for its haste; a haste item in
//      another slot is scored against the sword; a hasteless slot's bar is its plain score.
//
// Synthetic rows (the corpus type is `GearRow`, the scores are `roleValue`'s own numbers).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GearRow } from '../src/shared/planner/gear'
import { roleValue } from '../src/shared/planner/progressionPlan'
import type { GearOwnership, GearOwnershipMap, OwnedFact } from '../src/renderer/src/features/gear/gearOwnership'
import { ownedKeysOf, ownedSide, ownedUpgrades } from '../src/renderer/src/features/plan/planOwned'

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
    // Looted this epoch and no longer in the dump: sold, destroyed, or handed to a friend — which
    // is exactly why it is STILL A TARGET (fork ruling, 2026-09-05: "you can't count looted alone,
    // i have to own it"). The dump is the proof of possession; the log is only a memory of one.
    ['quick gloves', own({ looted: true })],
    // Melted: the exaltation row proves the copy is in your gear right now, just not as itself.
    ['plain tunic', own({ exaltations: 1 })]
  ])
  const keys = ownedKeysOf(map)
  assert.deepEqual([...keys.held].sort(), ['haste sword', 'plain tunic'], 'dump-owned and melted are excluded as targets')
  assert.equal(keys.held.has('quick gloves'), false, 'a bare loot line does NOT exclude the farm')
  assert.deepEqual([...keys.worn], ['haste sword'], 'only the equipped copy sets a bar')

  // …so the looted glove sets NO haste and the melted tunic NO chest bar.
  const side = ownedSide(keys, BY_KEY, { role: 'dps', classes: ['WAR'] })
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
    const side = ownedSide(stowed, BY_KEY, { role: 'dps', classes: ['WAR'] })
    assert.deepEqual(side.haste, [], `${place}: a haste blade there is not haste you have`)
    assert.equal(side.bars.size, 0, `${place}: sets no bar`)
  }
  // EQUIPPED — and a second copy in the bank beside it changes nothing: the worn one is worn.
  for (const facts of [[at('equipped')], [at('bank'), at('equipped')]]) {
    const keys = ownedKeysOf(new Map([['haste sword', own({ facts })]]))
    assert.deepEqual([...keys.worn], ['haste sword'])
    const side = ownedSide(keys, BY_KEY, { role: 'dps', classes: ['WAR'] })
    assert.deepEqual(side.haste, [{ haste: 36, slots: ['PRIMARY'] }])
    assert.equal(side.bars.get('PRIMARY'), roleValue(SWORD.stats, 'dps'))
  }
})

test('the haste source keeps full credit in its own slot, and every other bar is read against it', () => {
  const worn = new Set(['haste sword', 'quick gloves', 'plain tunic'])
  const side = ownedSide({ worn, wornAny: new Set() }, BY_KEY, { role: 'dps', classes: ['WAR'] })
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
  const side = ownedSide({ worn: new Set(['unknown relic']), wornAny: new Set() }, BY_KEY, { role: 'tank', classes: [] })
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
  const side = ownedSide({ worn: new Set([BLOOD_FIRE.key]), wornAny: new Set() }, byKey, { role: 'dps1h', classes: ['WAR'] })
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
  const side = ownedSide(keys, BY_KEY, { role: 'dps', classes: ['WAR'] })
  assert.equal(side.bars.size, 0, 'no bar from the wildcard cell')
  assert.deepEqual(side.haste, [{ haste: 36, slots: ['PRIMARY'] }], 'its haste still counts')
  // Worn in a REAL cell too: the real cell wins and the bar is back.
  const both = ownedKeysOf(new Map([['haste sword', own({ facts: [wild, at('equipped')] })]]))
  assert.deepEqual([...both.worn], ['haste sword'])
  assert.equal(ownedSide(both, BY_KEY, { role: 'dps', classes: ['WAR'] }).bars.size > 0, true)
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
  const bar = ownedSide({ worn: new Set([FISTS.key]), wornAny: new Set() }, byKey, { role: 'dps1h', classes: ['WAR', 'MNK', 'SHM'] }).bars.get('SECONDARY')
  assert.ok(bar !== undefined)
  const challenger = roleValue(VACRA.stats, 'dps1h', { classes: ['WAR', 'MNK', 'SHM'] })
  assert.ok(
    challenger < bar,
    `the stat-stick (${challenger.toFixed(1)}) must not clear the offhand bar (${bar.toFixed(1)})`
  )
})

test('boots of brawn lose to shiverback-hide boots: a dps focus prices defense, not just STR', () => {
  // The third field case (fork, kaltinril 2026-09-04: "if you have 500 str, and no other stats,
  // you're going to die"): with defense at a token weight, +9 STR bought −13 DEX and the loss of
  // nine STA and nine AGI, and the route called it an upgrade. The dial's DEFAULT midpoint pins
  // the verdict the other way; the GLASS-CANNON end is allowed to keep the old one — that end of
  // the slider is the old table, on purpose.
  const SHIVERBACK = row({
    key: 'shiverback-hide boots', name: 'Shiverback-Hide Boots', slots: ['FEET'],
    stats: { STR: 5, STA: 9, AGI: 9, AC: 6 }
  })
  const BRAWN_STATS = { STR: 9, DEX: -13, AC: 8 }
  const byKey = new Map([[SHIVERBACK.key, SHIVERBACK]])
  const scope = { role: 'dps' as const, classes: ['SHM' as const] }
  const bar = ownedSide({ worn: new Set([SHIVERBACK.key]), wornAny: new Set() }, byKey, scope).bars.get('FEET')
  assert.ok(bar !== undefined)
  const challenger = roleValue(BRAWN_STATS, 'dps', { classes: scope.classes })
  assert.ok(
    challenger < bar,
    `the STR boots (${challenger.toFixed(1)}) must not clear the FEET bar (${bar.toFixed(1)})`
  )
  // …and the bar reads the dial too (`ownedSide`): both sides move together at the glass end.
  const glass = ownedSide({ worn: new Set([SHIVERBACK.key]), wornAny: new Set() }, byKey, { ...scope, survivability: 0 }).bars.get('FEET')
  assert.ok(glass !== undefined && glass < bar, 'the glass-cannon bar prices the defense off both sides')
})

test('withered leather boots lose to shiverback at EVERY dial position: flat HP is priced ridiculously low', () => {
  // The fourth field case (fork, kaltinril 2026-09-05: "rank stats like hp ridiculously low, and
  // MP on a melee heavy 3 class build low"): a caster hitpoint stick — no damage stat at all —
  // outbid the melee boots at full Glass Cannon, because 40 flat HP through a shared ehp channel
  // dwarfed five STR. The melee ehp is a token now (zero at the glass end), mana is a rounding
  // error, and STA — attribute-sized, unlike HP — moved to its own row so THIS fix cannot re-open
  // the Boots of Brawn case above.
  const SHIVERBACK = row({
    key: 'shiverback-hide boots', name: 'Shiverback-Hide Boots', slots: ['FEET'],
    stats: { STR: 5, STA: 9, AGI: 9, AC: 6 }
  })
  const WITHERED = { AC: 5, DEX: 8, WIS: 3, HP: 40, MP: 5, SV_POISON: 10 }
  const byKey = new Map([[SHIVERBACK.key, SHIVERBACK]])
  for (const survivability of [0, 0.3, 0.5, 1]) {
    const scope = { role: 'dps' as const, classes: ['SHM' as const], survivability }
    const bar = ownedSide({ worn: new Set([SHIVERBACK.key]), wornAny: new Set() }, byKey, scope).bars.get('FEET')
    assert.ok(bar !== undefined)
    const challenger = roleValue(WITHERED, 'dps', { classes: scope.classes, survivability })
    assert.ok(
      challenger < bar,
      `at dial ${String(survivability)} the HP stick (${challenger.toFixed(1)}) must not clear the bar (${bar.toFixed(1)})`
    )
  }
})

test('imbued granite spaulders lose to sode of empowerment near the glass end: resists are chunks too', () => {
  // The fifth field case (fork, kaltinril 2026-09-05: "only 1 click off glass cannon and it's
  // recommending shoulders that lose str and dex??"): five +10 saves on one shoulder piece — 50
  // flat points through the per-point saves weight — bought back a lost 7 STR / 7 DEX / 7 STA /
  // 7 AGI. Saves on the melee focuses are now the ehp treatment: zero at the glass end, real only
  // toward wooden. The full-wooden verdict stays the spaulders' on purpose — trading 28 attribute
  // points for +10 AC and +50 resists IS the max-defense end of the dial.
  const SODE = row({
    key: 'sode of empowerment', name: 'Sode of Empowerment', slots: ['SHOULDERS'],
    stats: { STR: 7, STA: 7, AGI: 7, DEX: 7, AC: 10 }
  })
  const SPAULDERS = { AC: 20, SV_FIRE: 10, SV_COLD: 10, SV_MAGIC: 10, SV_DISEASE: 10, SV_POISON: 10 }
  const byKey = new Map([[SODE.key, SODE]])
  for (const survivability of [0, 0.2, 0.3, 0.5]) {
    const scope = { role: 'dps' as const, classes: ['WAR' as const, 'MNK' as const, 'SHM' as const], survivability }
    const bar = ownedSide({ worn: new Set([SODE.key]), wornAny: new Set() }, byKey, scope).bars.get('SHOULDERS')
    assert.ok(bar !== undefined)
    const challenger = roleValue(SPAULDERS, 'dps', { classes: scope.classes, survivability })
    assert.ok(
      challenger < bar,
      `at dial ${String(survivability)} the resist slab (${challenger.toFixed(1)}) must not clear the bar (${bar.toFixed(1)})`
    )
  }
})

test('what you OWN but do not WEAR that beats what you wear is called out — the equip advisory', () => {
  // Fork ruling, 2026-09-05: "if i have it in a bank slot and i'm an idiot it needs to tell me to
  // equip it." Worn: the plain tunic. Banked: a better chest (beats the bar), the haste sword (a
  // PRIMARY gap — fills it), and a worse chest (stays silent). Same dial, same bars, base v base.
  const BETTER = row({ key: 'fine tunic', name: 'Fine Tunic', slots: ['CHEST'], stats: { AC: 30 } })
  const WORSE = row({ key: 'ragged tunic', name: 'Ragged Tunic', slots: ['CHEST'], stats: { AC: 5 } })
  const byKey = new Map([...BY_KEY, [BETTER.key, BETTER], [WORSE.key, WORSE]])
  const keys = ownedKeysOf(
    new Map([
      ['plain tunic', own({ facts: [at('equipped')] })],
      ['fine tunic', own({ facts: [at('bank')] })],
      ['haste sword', own({ facts: [at('inventory')] })],
      ['ragged tunic', own({ facts: [at('bank')] })]
    ])
  )
  const scope = { role: 'dps' as const, classes: ['WAR' as const] }
  const ups = ownedUpgrades(keys, byKey, ownedSide(keys, byKey, scope), scope)
  assert.deepEqual(ups.map((u) => `${u.name}:${u.slot}`).sort(), ['Fine Tunic:CHEST', 'Haste Sword:PRIMARY'])
  // Sorted best-first: the sword's ratio and haste dwarf a chest's AC.
  assert.equal(ups[0].name, 'Haste Sword')
  // Nothing worn, nothing advised about it: the worn tunic itself never appears.
  assert.equal(ups.some((u) => u.key === 'plain tunic'), false)
})
