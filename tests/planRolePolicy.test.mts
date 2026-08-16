// THE ROLE VOCABULARY AND ITS WEAPON-SLOT POLICY — the 2026-08-15 widening
// (`src/shared/planner/roleWeights.ts`; the fold that reads it is `progressionPlan.ts`, rule 10).
//
// TWO ASKS, ONE ROUND. The owner asked for the picker to be finer — *"we should probably have it be
// choseable also, 1h DPS, 2h DPS, dual weild, DD, DOT, Healer, Tank, etc"* — and reported the bug
// that made it urgent: he wields a two-handed greataxe, his Secondary/Held is empty ON PURPOSE, and
// the upgrade-gap rule read that empty slot as a gap and offered him shields.
//
// THIS FILE IS DELIBERATELY TWO SUITES IN ONE, and the seam matters:
//
//   PART 1 IS AGAINST THE REAL COMMITTED CORPUS (`src/main/data/items.json`, through the SHIPPED
//   `buildGearIndex`). The policy's predicates are claims ABOUT THE CORPUS — "a two-hander lists
//   PRIMARY", "a shield is a SECONDARY-only AC-bearing non-weapon" — and a synthetic fixture cannot
//   falsify a claim about 6,814 real rows. It re-derives the census the module header quotes, so a
//   rescrape that changes the shape of the data turns this red instead of quietly changing what
//   "1H DPS" means. The floors are floors (the wiki gains pages); the SETS are equalities, the same
//   discipline `gearIndex.test.mts` uses on its stat vocabulary.
//
//   PART 2 IS SYNTHETIC, like the rest of the plan suites: what each policy ADMITS and REFUSES,
//   pinned on four hand-made rows where every number is visible.
//
// WHAT IS NOT RE-PINNED HERE: the fifteen `Skill:` spellings and their fold. `weaponType.ts` owns
// that vocabulary and `gearIndex.test.mts` already holds it to an equality; this file consumes it
// and pins only what it ADDS — handedness, shield-shape, and the policy table.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import itemsJson from '../src/main/data/items.json'
import type { ItemDbFile } from '../src/main/itemsDb'
import { buildGearIndex } from '../src/main/planner/gearIndex'
import type { GearRow } from '../src/shared/planner/gear'
import {
  ROLE_WEAPON_POLICY,
  gearHandedness,
  isShieldLike,
  policyAdmits,
  roleValue,
  rowIsKind,
  type GearRole
} from '../src/shared/planner/roleWeights'
import { buildProgressionPlan, type PlanCorpora, type PlanInputs } from '../src/shared/planner/progressionPlan'
import { weaponTypeOf } from '../src/shared/planner/weaponType'
import { zoneLevelKey, type ZoneLevels } from '../src/shared/planner/zoneLevels'
import type { ConBand } from '../src/shared/conBands'

const ROWS = buildGearIndex(itemsJson as unknown as ItemDbFile).rows

// =================================================================================================
// PART 1 — THE CENSUS THE POLICY RESTS ON (real corpus)
// =================================================================================================

test('CENSUS: handedness is read off the corpus, and every two-hander lists PRIMARY', () => {
  const twoHand = ROWS.filter((r) => gearHandedness(r.skill) === '2h')
  const oneHand = ROWS.filter((r) => gearHandedness(r.skill) === '1h')

  // Floors, not equalities: a rescrape may add weapon pages and must not turn this red for growing.
  assert.equal(twoHand.length >= 442, true, `two-handers: ${twoHand.length} (was 442 on 2026-08-15)`)
  assert.equal(oneHand.length >= 1071, true, `one-handers: ${oneHand.length} (was 1,071)`)

  // THE CLAIM `dps2h`'s PRIMARY CONSTRAINT RESTS ON: a two-hander is a main-hand item, every time.
  assert.equal(twoHand.every((r) => r.slots.includes('PRIMARY')), true)

  // AND THE DIRT THAT IS WHY `dps2h` CLOSES THE OFFHAND OUTRIGHT rather than trusting slot lists:
  // three two-handers also list SECONDARY. Pinned as an equality — a fourth is a corpus change
  // somebody should look at, not something this policy should silently absorb.
  assert.deepEqual(
    twoHand.filter((r) => r.slots.includes('SECONDARY')).map((r) => r.name).sort(),
    ['Rantho Rapier', 'Runed Velium Claidhmore', 'Thunder Staff']
  )

  // Dual wield has something to say in both hands, which is what makes its policy worth having.
  assert.equal(oneHand.filter((r) => r.slots.includes('PRIMARY')).length >= 1044, true)
  assert.equal(oneHand.filter((r) => r.slots.includes('SECONDARY')).length >= 757, true)
})

test('CENSUS: a row that states NO skill is not a weapon, and a weapon-only slot excludes it', () => {
  // 217 PRIMARY rows state no `Skill:` at all — brooms, torches, fishing poles, dolls. Law 1: the
  // wiki did not say, so we do not know, and "1H DPS" asked for a one-hander.
  const skillless = ROWS.filter((r) => r.slots.includes('PRIMARY') && r.skill === undefined)
  assert.equal(skillless.length >= 217, true, `skill-less PRIMARY rows: ${skillless.length}`)
  assert.equal(skillless.every((r) => gearHandedness(r.skill) === null), true)
  assert.equal(skillless.every((r) => !rowIsKind(r, 'weapon-1h') && !rowIsKind(r, 'weapon-2h')), true)

  // Ranged skills are weapons but are neither one- nor two-handed for policy purposes: no role
  // constrains RANGE, so they are simply not the thing any of these three kinds names.
  const ranged = ROWS.filter((r) => {
    const type = weaponTypeOf(r.skill)
    return type === 'ARCHERY' || type === 'THROWING'
  })
  assert.equal(ranged.length >= 100, true, `ranged rows: ${ranged.length}`)
  assert.equal(ranged.every((r) => gearHandedness(r.skill) === null), true)
})

test('CENSUS: `isShieldLike` is a SHAPE, and the false positives are stated rather than filtered', () => {
  const shields = ROWS.filter((r) => isShieldLike(r))
  assert.equal(shields.length >= 147, true, `shield-shaped rows: ${shields.length} (was 147)`)

  // THE SHAPE, restated as three predicates so a future edit cannot loosen one of them unnoticed.
  assert.equal(shields.every((r) => r.slots.length === 1 && r.slots[0] === 'SECONDARY'), true)
  assert.equal(shields.every((r) => weaponTypeOf(r.skill) === null), true)
  assert.equal(shields.every((r) => r.stats.AC !== undefined), true)

  // IT IS NOT A CLAIM OF SHIELD-NESS, and the honest measure of that is how many of them read like
  // shields: 130 of the 147 carry a shield word, and the rest are offhand curios that happen to
  // state an AC. The module header names them; this pins that the gap is real and small.
  const SHIELDISH = /shield|aegis|barrier|buckler|targ|protector|bulwark|guard|ward|orb|crest|kite|tower/i
  const odd = shields.filter((r) => !SHIELDISH.test(r.name))
  assert.equal(odd.length <= 25, true, `unshieldish shield-shaped rows: ${odd.length} (was 17)`)
  assert.equal(odd.some((r) => r.name === 'Crushbone Fetish'), true, 'the one page stating Skill: SHIELD')

  // THE BUCKETS IT KEEPS OUT, which are the reason the AC clause and the SECONDARY-ONLY clause both
  // exist: horns/dolls/books state no AC, and a PRIMARY+SECONDARY curio is not an offhand choice.
  const secondaryOnly = ROWS.filter(
    (r) => r.slots.length === 1 && r.slots[0] === 'SECONDARY' && weaponTypeOf(r.skill) === null
  )
  assert.equal(secondaryOnly.filter((r) => r.stats.AC === undefined).every((r) => !isShieldLike(r)), true)
  assert.equal(
    ROWS.filter((r) => r.slots.includes('SECONDARY') && r.slots.length > 1).every((r) => !isShieldLike(r)),
    true
  )
  // And nothing skill-less in that bucket is secretly a weapon: none of them states a DMG.
  assert.equal(secondaryOnly.every((r) => r.stats.DMG === undefined), true)
})

test('CENSUS: the real corpus answers each policy differently, and none of them is empty', () => {
  const admits = (role: GearRole, slot: 'PRIMARY' | 'SECONDARY'): number =>
    ROWS.filter((r) => r.slots.includes(slot) && policyAdmits(ROLE_WEAPON_POLICY[role], slot, r)).length

  // 2H closes the offhand ENTIRELY — not "narrows it", zero.
  assert.equal(admits('dps2h', 'SECONDARY'), 0)
  assert.equal(admits('dps2h', 'PRIMARY') >= 442, true)
  // Dual wield takes one-handers in both hands and nothing else.
  assert.equal(admits('dualwield', 'SECONDARY') >= 757, true)
  assert.equal(admits('dualwield', 'PRIMARY') >= 1044, true)
  // Tank's offhand is the shield shelf.
  assert.equal(admits('tank', 'SECONDARY') >= 147, true)
  assert.equal(admits('tank', 'SECONDARY') < admits('dualwield', 'SECONDARY'), true)
  // The unconstrained roles see every row their slots reach — today's behaviour, written down.
  for (const role of ['balanced', 'dps', 'dd', 'dot', 'healer'] as const) {
    assert.equal(admits(role, 'PRIMARY'), ROWS.filter((r) => r.slots.includes('PRIMARY')).length)
    assert.equal(admits(role, 'SECONDARY'), ROWS.filter((r) => r.slots.includes('SECONDARY')).length)
  }
})

// =================================================================================================
// PART 2 — WHAT THE POLICY ADMITS, on rows whose every number is visible
// =================================================================================================

function con(myLevel: number, mobLevel: number): ConBand {
  const diff = mobLevel - myLevel
  if (diff <= -6) return 'trivial'
  if (diff <= -1) return 'safe'
  if (diff <= 1) return 'even'
  if (diff <= 4) return 'risky'
  return 'deadly'
}

const PROFILES: ReadonlyMap<string, ZoneLevels> = new Map(
  [{ zone: 'Crushbone', low: 8, median: 12, sampled: 40 }].map((z) => [zoneLevelKey(z.zone), z])
)

function row(over: Partial<GearRow> & Pick<GearRow, 'key' | 'name'>): GearRow {
  return {
    searchKey: over.name.toLowerCase(),
    slots: ['PRIMARY'],
    classes: [],
    races: ['ALL'],
    flags: [],
    quest: false,
    playerCrafted: false,
    stats: {},
    effects: [],
    wikiSources: [{ mob: 'a young kobold', zone: 'Crushbone' }],
    ...over
  }
}

/** THE OWNER'S OWN LOADOUT, in miniature: a greataxe, and the shield the route kept offering him. */
const GREATAXE = row({
  key: 'verishe mal greataxe',
  name: 'Verishe Mal Greataxe',
  skill: '2H Slashing',
  stats: { DMG: 40, DELAY: 45, STR: 10 }
})
const SHIELD = row({
  key: 'bark shield',
  name: 'Bark Shield',
  slots: ['SECONDARY'],
  stats: { AC: 15 }
})
const SHORT_SWORD = row({
  key: 'short sword',
  name: 'Short Sword',
  slots: ['PRIMARY', 'SECONDARY'],
  skill: '1H Slashing',
  stats: { DMG: 10, DELAY: 22 }
})
/** A PRIMARY that states no skill at all — the broom/torch/doll bucket, in one row. */
const TORCH = row({ key: 'a torch', name: 'A Torch', stats: { AC: 2 } })
/** Nothing to do with a hand: the control that proves policy touches only the weapon slots. */
const HELM = row({ key: 'iron helm', name: 'Iron Helm', slots: ['HEAD'], stats: { AC: 12 } })

const GEAR = [GREATAXE, SHIELD, SHORT_SWORD, TORCH, HELM]

function corpora(over: Partial<PlanCorpora> = {}): PlanCorpora {
  return {
    gear: GEAR,
    profiles: PROFILES,
    mobLevel: (name) => (name === 'a young kobold' ? 14 : null),
    con,
    owned: new Set(),
    wished: new Set(),
    ownedBestBySlot: new Map(),
    ...over
  }
}

function inputs(role: GearRole, over: Partial<PlanInputs> = {}): PlanInputs {
  return { level: 13, classes: [], role, reach: 'solo', eraOnly: false, ...over }
}

/** Every key the whole route admits, for one role. */
function admitted(role: GearRole, over: Partial<PlanCorpora> = {}): string[] {
  return buildProgressionPlan(inputs(role), corpora(over))
    .flatMap((b) => b.targets.map((t) => t.key))
    .sort()
}

test('2H DPS: the empty offhand is a STATEMENT, and no shield is ever offered for it', () => {
  // THE REPORTED BUG. Every slot is a gap here — nothing is owned — so under the generic DPS role
  // the shield walks straight in, exactly as it did on the owner's screen.
  assert.equal(admitted('dps').includes('bark shield'), true, 'the bug, reproduced')

  // …and under 2H DPS it does not, because SECONDARY is CLOSED rather than merely outranked. The
  // shield's only slot is a slot this role does not listen to.
  assert.equal(admitted('dps2h').includes('bark shield'), false)

  // THE MAIN HAND TAKES TWO-HANDERS ONLY: the greataxe is in, the one-hander and the torch are out.
  assert.deepEqual(admitted('dps2h'), ['iron helm', 'verishe mal greataxe'])

  // The helmet is untouched — policy constrains the weapon slots and nothing else.
  assert.equal(admitted('dps2h').includes('iron helm'), true)
})

test('DUAL WIELD takes one-handers in BOTH hands, and nothing else in either', () => {
  const keys = admitted('dualwield')
  assert.equal(keys.includes('short sword'), true, 'a 1H that lists both hands is the whole point')
  assert.equal(keys.includes('verishe mal greataxe'), false, 'a two-hander fills a hand it needs')
  assert.equal(keys.includes('bark shield'), false, 'the offhand is for a weapon, not a shield')
  assert.equal(keys.includes('a torch'), false, 'a row stating no skill is not a one-hander')
  assert.deepEqual(keys, ['iron helm', 'short sword'])
})

test('1H DPS constrains the MAIN hand only — the offhand stays open', () => {
  const keys = admitted('dps1h')
  assert.equal(keys.includes('short sword'), true)
  assert.equal(keys.includes('verishe mal greataxe'), false, 'the main hand wants one-handers')
  // SECONDARY carries no constraint for this role, so a shield is a legitimate offhand answer.
  assert.equal(keys.includes('bark shield'), true)
  assert.equal(keys.includes('a torch'), false, 'still not a stated one-hander')
})

test('TANK takes shield-shaped offhands, and the generic roles constrain nothing', () => {
  const tank = admitted('tank')
  assert.equal(tank.includes('bark shield'), true)
  // The short sword's SECONDARY is refused, but its PRIMARY is unconstrained for a tank — so it is
  // admitted through the main hand. "At least one slot the role is listening to" is the whole rule.
  assert.equal(tank.includes('short sword'), true)
  assert.equal(tank.includes('verishe mal greataxe'), true, 'a tank may swing a two-hander')

  // AND THE FIVE UNCONSTRAINED ROLES SEE EVERYTHING, which is today's behaviour written down.
  const everything = ['a torch', 'bark shield', 'iron helm', 'short sword', 'verishe mal greataxe']
  for (const role of ['balanced', 'dps', 'dd', 'dot', 'healer'] as const) {
    assert.deepEqual(admitted(role), everything, `${role} constrains no weapon slot`)
  }
})

test('a WISHED item beats the policy too — a wish is the opposite of an unsolicited suggestion', () => {
  // The policy exists to stop the route OFFERING a shield to a two-hander. A shield the player has
  // already put on their wish list was not offered; it was asked for, and rule 9 outranks rule 10.
  const keys = admitted('dps2h', { wished: new Set(['bark shield']) })
  assert.equal(keys.includes('bark shield'), true)
})

test('a CLOSED slot is closed even when the sheet says something is worn there', () => {
  // The gap test and the policy are independent gates: an offhand bar of any size cannot reopen a
  // slot the role has closed, and no bar at all cannot either.
  for (const bars of [new Map(), new Map([['SECONDARY', 0]]), new Map([['SECONDARY', 9999]])]) {
    assert.equal(
      admitted('dps2h', { ownedBestBySlot: bars as ReadonlyMap<never, number> }).includes('bark shield'),
      false
    )
  }
})

// =================================================================================================
// PART 3 — the new roles' WEIGHTS
// =================================================================================================

test('the three melee builds share ONE weights profile — they differ by policy, not by value', () => {
  // The same 8 STR is the same 8 STR in either hand. Anything else would be three sets of invented
  // coefficients nobody could justify, so the fold shares the object and this pins that it does.
  for (const stats of [GREATAXE.stats, SHORT_SWORD.stats, SHIELD.stats, HELM.stats]) {
    const generic = roleValue(stats, 'dps')
    for (const role of ['dps1h', 'dps2h', 'dualwield'] as const) {
      assert.equal(roleValue(stats, role), generic)
    }
  }
  // What DOES differ is what each will look at, and that is a different table entirely.
  assert.notDeepEqual(ROLE_WEAPON_POLICY.dps2h, ROLE_WEAPON_POLICY.dualwield)
  assert.deepEqual(ROLE_WEAPON_POLICY.dps, {}, 'the generic stays unconstrained on purpose')
})

test('the caster roles read mana and INT where the melee roles read a weapon', () => {
  const staff = { INT: 20, MP: 80, MANA_REGEN: 2 }
  const axe = { DMG: 40, DELAY: 45, STR: 10 }

  for (const role of ['dd', 'dot'] as const) {
    assert.equal(roleValue(staff, role) > roleValue(staff, 'dps'), true, `${role} values a caster item higher`)
    assert.equal(roleValue(staff, role) > roleValue(axe, role), true, `${role} prefers the staff to the axe`)
  }
  assert.equal(roleValue(axe, 'dps') > roleValue(axe, 'dd'), true, 'and a melee role still prefers the axe')
})

test('DD and DOT are NEARLY THE SAME RANKING, on purpose, and differ on exactly one axis', () => {
  // THE HONESTY CLAUSE, pinned. The corpus states no spell damage, cast time, resist rate or
  // duration, so nothing in a stat block tells burst apart from a dot. The two tables differ in one
  // lean and are otherwise identical — anybody expecting two visibly different lists should expect
  // two nearly identical ones.
  const pool = { INT: 20, MP: 100 }
  const regen = { INT: 20, MANA_REGEN: 8 }

  // DD leans the raw pool you walked in with; DOT leans the bar refilling during a long fight.
  assert.equal(roleValue(pool, 'dd') > roleValue(pool, 'dot'), true)
  assert.equal(roleValue(regen, 'dot') > roleValue(regen, 'dd'), true)

  // …and on everything that is neither, they agree exactly — which is what "one axis" means.
  for (const stats of [{ AC: 20 }, { STR: 10, DEX: 10 }, { HP: 40, STA: 10 }, { SV_FIRE: 15 }]) {
    assert.equal(roleValue(stats, 'dd'), roleValue(stats, 'dot'))
  }
})
