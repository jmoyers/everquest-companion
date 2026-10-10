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
  assert.deepEqual(ownedKeysOf(null), { held: new Set(), worn: new Set(), wornAny: new Set(), wornCopies: new Map() })
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
  // Sorted best-first: the sword's plain RATIO leads — its 36% haste buys it nothing (the Fangol
  // ruling), and since the 2026-09-05 audit AC slides from zero, so the chest's 30 AC at the
  // damage-leaning default is worth less than a real weapon's white damage.
  assert.equal(ups[0].name, 'Haste Sword')
  // Nothing worn, nothing advised about it: the worn tunic itself never appears.
  assert.equal(ups.some((u) => u.key === 'plain tunic'), false)
})

test('fangol clears the monsoon bar: a weapon never wins the hand on haste', () => {
  // The sixth field case (fork, kaltinril 2026-09-05): a worn 36% haste 2H set a 144-point bar no
  // hasteless weapon could clear — but worn haste does not stack, lives equally on belts and
  // capes, and keeps granting from an Any Slot after the swap ("i'd obviously put a haste belt or
  // cape on when i get the fangol" / "i could still toss the monsoon in one of the two ANY
  // slots"). So haste prices at ZERO on a weapon row, weapons compete on damage, and the better
  // ratio wins the hand — while the haste itself still counts as haste the player owns.
  const MONSOON = row({
    key: 'monsoon, sword of the swiftwind', name: 'Monsoon, Sword of the Swiftwind', slots: ['PRIMARY'],
    skill: '2H Slashing', stats: { DMG: 30, DELAY: 45, HASTE: 36, STR: 10, STA: 9 }
  })
  const FANGOL = { DMG: 29, DELAY: 35, STR: 3, DEX: 10, STA: 10, SV_POISON: 5 }
  const byKey = new Map([[MONSOON.key, MONSOON]])
  const scope = { role: 'dps2h' as const, classes: ['WAR' as const] }
  const keys = ownedKeysOf(new Map([[MONSOON.key, own({ facts: [at('equipped')] })]]))
  const side = ownedSide(keys, byKey, scope)
  const bar = side.bars.get('PRIMARY')
  assert.ok(bar !== undefined)
  const challenger = roleValue(FANGOL, 'dps2h', { classes: scope.classes })
  assert.ok(challenger > bar, `the better ratio (${challenger.toFixed(1)}) clears the haste incumbent (${bar.toFixed(1)})`)
  // …and the monsoon's 36% is still haste the player OWNS: an offered belt gets no credit past it.
  assert.deepEqual(side.haste, [{ haste: 36, slots: ['PRIMARY'] }])
})

test('the advisory obeys the weapon-slot policy: a banked 2H is not main-hand advice on a 1H focus', () => {
  // Fork report, minutes after the advisory shipped: "it's recommending my 2h for 1h dps :)".
  const GREATAXE = row({
    key: 'monsoon', name: 'Monsoon, Sword of the Swiftwind', slots: ['PRIMARY'],
    skill: '2H Slashing', stats: { DMG: 25, DELAY: 40 }
  })
  const SABER = row({
    key: 'fine saber', name: 'Fine Saber', slots: ['PRIMARY'],
    skill: '1H Slashing', stats: { DMG: 10, DELAY: 24 }
  })
  const byKey = new Map([[GREATAXE.key, GREATAXE], [SABER.key, SABER]])
  const keys = ownedKeysOf(
    new Map([
      ['monsoon', own({ facts: [at('bank')] })],
      ['fine saber', own({ facts: [at('bank')] })]
    ])
  )
  const oneHand = { role: 'dps1h' as const, classes: ['WAR' as const] }
  const ups = ownedUpgrades(keys, byKey, ownedSide(keys, byKey, oneHand), oneHand)
  assert.deepEqual(ups.map((u) => u.name), ['Fine Saber'], 'the 1H focus advises only the one-hander')
  // …and the 2H focus advises the two-hander and never the saber — the same table, both ways.
  const twoHand = { role: 'dps2h' as const, classes: ['WAR' as const] }
  const ups2 = ownedUpgrades(keys, byKey, ownedSide(keys, byKey, twoHand), twoHand)
  assert.deepEqual(ups2.map((u) => u.name), ['Monsoon, Sword of the Swiftwind'])
})

test('the advisory obeys the class gate: a banked bow only a ranger can draw is not advice to a monk', () => {
  // Fork report, 2026-09-27, a WAR/MNK/SHM trio: "it's recommending is RNG (Ranger) only". Five
  // items were named and four were another class's. The real rows' slots and classes, stats cut
  // to what the focus reads.
  const WINDSTRIKER = row({
    key: 'windstriker', name: 'Windstriker', slots: ['RANGE'], classes: ['RNG'],
    skill: 'Archery', stats: { DMG: 45, DELAY: 60 }
  })
  const PAL_SHIELD = row({
    key: 'shield of the stalwart seas', name: 'Shield of the Stalwart Seas', slots: ['SECONDARY'],
    classes: ['PAL'], stats: { AC: 35 }
  })
  const SASH = row({
    key: 'golden sash of tranquility', name: 'Golden Sash of Tranquility', slots: ['WAIST'],
    classes: ['MNK'], stats: { AC: 5 }
  })
  const UNSTATED = row({ key: 'plain belt', name: 'Plain Belt', slots: ['WAIST'], stats: { AC: 3 } })
  const rows = [WINDSTRIKER, PAL_SHIELD, SASH, UNSTATED]
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const keys = ownedKeysOf(new Map(rows.map((r) => [r.key, own({ facts: [at('bank')] })])))
  const trio = { role: 'dps1h' as const, classes: ['WAR' as const, 'MNK' as const, 'SHM' as const] }
  const ups = ownedUpgrades(keys, byKey, ownedSide(keys, byKey, trio), trio)
  // The monk's sash, and nothing a ranger or a paladin wears. The belt that states no classes is
  // kept, the route's own reading ("UNKNOWN, never nobody"); nothing is worn at the waist, so
  // both fill the gap.
  assert.deepEqual(ups.map((u) => u.name), ['Golden Sash of Tranquility', 'Plain Belt'])
  // And a trio nobody stated gates nothing, as on the route.
  const anyone = { role: 'dps1h' as const, classes: [] }
  const all = ownedUpgrades(keys, byKey, ownedSide(keys, byKey, anyone), anyone).map((u) => u.name)
  assert.ok(all.includes('Windstriker') && all.includes('Shield of the Stalwart Seas'), all.join(', '))
})

test('a 3-STA necklace does not beat the worn regen talisman: regen keeps a glass floor', () => {
  // The seventh field case (fork, 2026-09-05: "regen should mean something more than nothing") —
  // when regen slid from zero like the mitigation rows, every trinket with a scrap of garnish
  // cleared the 2-regen talisman's collapsed bar and flooded NECK. Regen is UPTIME, not
  // mitigation, so it floors at 2 even at full Glass cannon.
  const TALISMAN = row({ key: 'talisman of kejaar kerrath', name: 'Talisman of Kejaar Kerrath', slots: ['NECK'], stats: { HP_REGEN: 2 } })
  const BEARTOOTH = { STA: 3, HP: 10 }
  const byKey = new Map([[TALISMAN.key, TALISMAN]])
  const keys = ownedKeysOf(new Map([[TALISMAN.key, own({ facts: [at('equipped')] })]]))
  for (const survivability of [0, 0.3, 0.5]) {
    const scope = { role: 'dps' as const, classes: ['SHM' as const], survivability }
    const bar = ownedSide(keys, byKey, scope).bars.get('NECK')
    assert.ok(bar !== undefined)
    const challenger = roleValue(BEARTOOTH, 'dps', { classes: scope.classes, survivability })
    assert.ok(challenger < bar, `at dial ${String(survivability)} the trinket (${challenger.toFixed(1)}) must not clear the regen bar (${bar.toFixed(1)})`)
  }
})

test('a paired slot is two cells: its bar is the weaker worn copy, and a gap until two are worn', () => {
  // Rings of AC 30 and AC 2 worn, an AC 15 ring in the bank. Read as the best copy, the bar was the
  // AC 30 ring and the banked one was never offered over the AC 2 one it beats.
  const ring = (name: string, AC: number): GearRow => row({ key: name.toLowerCase(), name, slots: ['FINGER'], stats: { AC } })
  const [STRONG, WEAK, BANKED] = [ring('Strong Band', 30), ring('Weak Band', 2), ring('Banked Band', 15)]
  const byKey = new Map([STRONG, WEAK, BANKED].map((r) => [r.key, r]))
  const scope = { role: 'tank' as const, classes: ['WAR' as const] }
  const advise = (worn: [string, number][]): { bar?: number; ups: string[] } => {
    const map: GearOwnershipMap = new Map(worn.map(([key, count]) => [key, own({ facts: [{ place: 'equipped', count }] })]))
    map.set(BANKED.key, own({ facts: [at('bank')] }))
    const keys = ownedKeysOf(map)
    const side = ownedSide(keys, byKey, scope)
    return { bar: side.bars.get('FINGER'), ups: ownedUpgrades(keys, byKey, side, scope).map((u) => u.name) }
  }
  const both = advise([[STRONG.key, 1], [WEAK.key, 1]])
  assert.equal(both.bar, roleValue(WEAK.stats, 'tank'), 'the bar is the weaker of the two worn rings')
  assert.deepEqual(both.ups, ['Banked Band'], 'so the AC 15 ring is advice: it replaces the AC 2 one')
  const one = advise([[STRONG.key, 1]])
  assert.equal(one.bar, undefined, 'one ring worn: the other finger is empty, a gap')
  assert.deepEqual(one.ups, ['Banked Band'], 'and the banked ring fills it')
  const pair = advise([[STRONG.key, 2]])
  assert.equal(pair.bar, roleValue(STRONG.stats, 'tank'), 'two copies of one ring are two worn copies')
  assert.deepEqual(pair.ups, [], 'and an AC 15 ring beats neither')
})

test('fang of the wolf does not clear an earring bar: a weapon block does nothing worn in the ear', () => {
  // Owner report, 2026-10-03: the route offered Fang of the Wolf (EAR, PRIMARY, SECONDARY) over two
  // stat earrings on the 7.7 points its DMG 5 / DELAY 26 ratio earns in a hand.
  const FANG = row({
    key: 'fang of the wolf',
    name: 'Fang of the Wolf',
    slots: ['EAR', 'PRIMARY', 'SECONDARY'],
    skill: 'Piercing',
    classes: ['WAR', 'ROG', 'SHM'],
    stats: { DMG: 5, DELAY: 26 }
  })
  const DIAMONDINE = row({ key: 'diamondine earring', name: 'Diamondine Earring', slots: ['EAR'], stats: { AC: 2, STR: 3, HP: 12 } })
  const BASHING = row({
    key: 'earring of bashing',
    name: 'Earring of Bashing',
    slots: ['EAR'],
    stats: { AC: 5, STR: 8, WIS: 8, SV_FIRE: 5, SV_COLD: 5, SV_MAGIC: 5, SV_DISEASE: 5, SV_POISON: 5 }
  })
  const scope = { role: 'dps1h' as const, classes: ['WAR' as const, 'MNK' as const, 'SHM' as const] }
  const ctx = { classes: scope.classes }
  assert.ok(
    roleValue(FANG.stats, scope.role, { ...ctx, slot: 'EAR' }) < roleValue(DIAMONDINE.stats, scope.role, ctx),
    'in the ear the fang states nothing a 1H focus reads'
  )
  assert.ok(roleValue(FANG.stats, scope.role, { ...ctx, slot: 'PRIMARY' }) > 7, 'in a hand its ratio still counts')

  const byKey = new Map([FANG, DIAMONDINE, BASHING].map((r) => [r.key, r]))
  const map: GearOwnershipMap = new Map([
    [DIAMONDINE.key, own({ facts: [at('equipped')] })],
    [BASHING.key, own({ facts: [at('equipped')] })],
    [FANG.key, own({ facts: [at('bank')] })]
  ])
  const keys = ownedKeysOf(map)
  const side = ownedSide(keys, byKey, scope)
  assert.deepEqual(
    ownedUpgrades(keys, byKey, side, scope).map((u) => u.slot),
    ['PRIMARY'],
    'the banked fang is hand advice (both hands empty here), never ear advice'
  )
})
