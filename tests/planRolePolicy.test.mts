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
import { weaponTypeOf, normalizeSkillToken } from '../src/shared/planner/weaponType'
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

test('CENSUS: `isShieldLike` is the fork\'s ONE shield rule (planner/shield.ts), and the tank offhand reads it', () => {
  const shields = ROWS.filter((r) => isShieldLike(r))
  assert.equal(shields.length >= 130, true, `shield rows: ${shields.length} (was 130)`)

  // THE RULE, restated so a future edit cannot loosen a clause unnoticed: every match sits in the
  // SECONDARY slot (a "Shield of…" cloak is not a shield), and speaks a shield word or the SHIELD skill.
  const WORDS = /shield|buckler|aegis|targe|bulwark/i
  assert.equal(shields.every((r) => r.slots.includes('SECONDARY')), true)
  assert.equal(shields.every((r) => WORDS.test(r.name) || normalizeSkillToken(r.skill ?? '') === 'SHIELD'), true)
  assert.equal(shields.some((r) => r.name === 'Crushbone Fetish'), true, 'the one page stating Skill: SHIELD')

  // WHY THE WORD RULE WON over the shape this module used to carry (only-slot SECONDARY + no weapon
  // skill + an AC): the shape missed real shields the corpus places in BACK+SECONDARY, one stating no
  // AC and one stating a Piercing skill. Each is a shield to a player, and now to the tank policy.
  for (const name of ['Lodizal Shell Shield', 'Aegis of Life', 'Shield of the Immaculate', 'Froglok Tuk Buckler']) {
    const row = ROWS.find((r) => r.name === name)
    if (row !== undefined) assert.equal(isShieldLike(row), true, `${name} reads as a shield`)
  }
  // The ONE known false positive is stated rather than filtered (law 12: no fuzzy join to hide it).
  const stave = ROWS.find((r) => r.name === 'Stave of Shielding')
  if (stave !== undefined) assert.equal(isShieldLike(stave), true, 'the stated false positive, kept honestly')
  // And the buckets it keeps out: a PRIMARY-only weapon with "shield" in its name, and an offhand
  // curio with an AC but no shield word (a lute, a stein) — the seventeen the old shape admitted.
  assert.equal(ROWS.filter((r) => !r.slots.includes('SECONDARY')).every((r) => !isShieldLike(r)), true)
  const curios = ROWS.filter(
    (r) => r.slots.length === 1 && r.slots[0] === 'SECONDARY' && r.stats.AC !== undefined && !WORDS.test(r.name)
  )
  assert.equal(curios.every((r) => normalizeSkillToken(r.skill ?? '') === 'SHIELD' || !isShieldLike(r)), true)
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
  // Tank's offhand is the shield shelf - the word rule's 130 (planner/shield.ts), not the old shape's 147.
  assert.equal(admits('tank', 'SECONDARY') >= 130, true)
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

test('the melee builds share ONE weights profile except where the game differs — the 2H bonus and backstab', () => {
  // The same 8 STR is the same 8 STR in either hand, and on anything that is not a damage bonus or
  // a backstab the four melee focuses agree to the decimal.
  for (const stats of [GREATAXE.stats, SHORT_SWORD.stats, SHIELD.stats, HELM.stats]) {
    const generic = roleValue(stats, 'dps')
    for (const role of ['dps1h', 'dps2h', 'dualwield'] as const) {
      assert.equal(roleValue(stats, role), generic)
    }
  }
  // WHERE THEY DIFFER IS A GAME FACT, NOT AN OPINION: nobody backstabs with a two-hander, so that
  // stat is absent from `dps2h` even for a rogue. The damage bonus stopped being a weights cell
  // (fork decision, kaltinril 2026-09-04, the Cursed Blade case): it rides the ratio at its
  // measured worth (`gearEffectiveRatio`), so a bonus with no weapon under it scores nothing in
  // every melee focus alike — and on a weapon it raises the ratio, never a flat line of its own.
  assert.equal(roleValue({ DMG_BONUS: 10 }, 'dps2h'), 0)
  assert.equal(roleValue({ DMG_BONUS: 10 }, 'dps1h'), 0)
  assert.equal(roleValue({ DMG_BONUS: 10 }, 'dualwield'), 0)
  assert.ok(
    roleValue({ DMG: 10, DELAY: 20, DMG_BONUS: 10 }, 'dps1h') > roleValue({ DMG: 10, DELAY: 20 }, 'dps1h')
  )
  assert.equal(roleValue({ BACKSTAB: 5 }, 'dps1h', { classes: ['ROG'] }), 10)
  assert.equal(roleValue({ BACKSTAB: 5 }, 'dps2h', { classes: ['ROG'] }), 0)
  // What DOES differ is what each will look at, and that is a different table entirely.
  assert.notDeepEqual(ROLE_WEAPON_POLICY.dps2h, ROLE_WEAPON_POLICY.dualwield)
  assert.deepEqual(ROLE_WEAPON_POLICY.dps, {}, 'the generic stays unconstrained on purpose')
})

test('RANGED takes a bow or a throwing weapon in the RANGE slot, nothing else there, and leaves both hands open', () => {
  // Three rows shaped like the corpus states them: a bow (Archery, RANGE), a javelin under one of
  // the three Throwing spellings the fold collapses, and the short sword from above.
  const bow = row({ key: 'ashen bow', name: 'Ashen Bow', slots: ['RANGE'], skill: 'Archery', stats: { DMG: 30, DELAY: 50, DEX: 5 } })
  const javelin = row({ key: 'antonian javelin', name: 'Antonian Javelin', slots: ['RANGE', 'AMMO'], skill: 'Throwingv2', stats: { DMG: 8, DELAY: 30 } })
  const rock = row({ key: 'a smooth rock', name: 'A Smooth Rock', slots: ['RANGE'], stats: { DMG: 2, DELAY: 30 } })
  const policy = ROLE_WEAPON_POLICY.range
  assert.equal(policyAdmits(policy, 'RANGE', bow), true)
  assert.equal(policyAdmits(policy, 'RANGE', javelin), true, 'Throwingv2 is Throwing')
  assert.equal(policyAdmits(policy, 'RANGE', SHORT_SWORD), false, 'a sword is not a ranged weapon')
  assert.equal(policyAdmits(policy, 'RANGE', rock), false, 'a RANGE-slot row stating no skill is not a weapon we can vouch for')
  // BOTH HANDS OPEN: the ranged player melees when the mob closes, and a constraint there would be
  // an invention — so the sword and the greataxe are both admitted where they fit.
  assert.equal(policyAdmits(policy, 'PRIMARY', SHORT_SWORD), true)
  assert.equal(policyAdmits(policy, 'PRIMARY', GREATAXE), true)
  assert.equal(policyAdmits(policy, 'SECONDARY', SHIELD), true)
  // …and no OTHER focus admits a bow into a hand: the kinds are disjoint.
  assert.equal(policyAdmits(ROLE_WEAPON_POLICY.dps2h, 'PRIMARY', bow), false)
  assert.equal(policyAdmits(ROLE_WEAPON_POLICY.dualwield, 'PRIMARY', bow), false)
  // THE WEIGHTS: DEX is the ranged accuracy stat and the one attribute this focus weighs above the
  // melee's — fivefold, since melee DEX reads at the proc stat's 0.4 (the Cursed Blade overvote is
  // `weaponGarnish`'s job now). STR falls below theirs; a bow's ratio reads as an axe's.
  assert.equal(roleValue({ DEX: 10 }, 'range'), 20)
  assert.equal(roleValue({ DEX: 10 }, 'dps'), 4)
  assert.equal(roleValue({ STR: 10 }, 'range') < roleValue({ STR: 10 }, 'dps'), true)
  assert.equal(roleValue({ DMG: 30, DELAY: 50 }, 'range'), roleValue({ DMG: 30, DELAY: 50 }, 'dps'))
})

test('the survivability dial slides the dps DEFENSE rows and nothing else', () => {
  const armour = { AC: 10, STA: 10, AGI: 10, SV_FIRE: 10 }
  const damage = { DMG: 12, DELAY: 24, STR: 10, ATTACK: 10, HASTE: 10 }
  // The table IS the midpoint: absent, 0.5, and out-of-range clamp all read the same weights.
  assert.equal(roleValue(armour, 'dps'), roleValue(armour, 'dps', { survivability: 0.5 }))
  assert.equal(roleValue(armour, 'dps', { survivability: 0 }), roleValue(armour, 'dps', { survivability: -3 }))
  // Defense is worth strictly more at every step toward the wooden end…
  const glass = roleValue(armour, 'dps', { survivability: 0 })
  const wooden = roleValue(armour, 'dps', { survivability: 1 })
  assert.ok(glass < roleValue(armour, 'dps') && roleValue(armour, 'dps') < wooden)
  // …while pure damage holds still end to end, because the dial is about defense alone.
  assert.equal(roleValue(damage, 'dps', { survivability: 0 }), roleValue(damage, 'dps', { survivability: 1 }))
  // Ranged DEX is accuracy — damage — and does not slide; melee DEX does.
  assert.equal(roleValue({ DEX: 10 }, 'range', { survivability: 0 }), roleValue({ DEX: 10 }, 'range', { survivability: 1 }))
  assert.ok(roleValue({ DEX: 10 }, 'dps', { survivability: 0 }) < roleValue({ DEX: 10 }, 'dps', { survivability: 1 }))
  // The focuses that ARE a position on this axis ignore it entirely.
  for (const role of ['tank', 'healer', 'balanced', 'dd'] as const) {
    assert.equal(roleValue(armour, role, { survivability: 0 }), roleValue(armour, role, { survivability: 1 }))
  }
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
