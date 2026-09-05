// GEAR TAB — EFF DMG and BIS, the third and fourth derived keys (fork decision, kaltinril
// 2026-08-15), and since 2026-08-25 THE ROLE MODEL'S OWN ANSWERS: `gearEffectiveDamage` is
// `roleValue(stats, 'dps', …)` and `gearBisValue` is `roleValue(stats, 'balanced', …)`
// (src/shared/planner/roleWeights.ts, byte-identical to the plan branch's), so the Gear tab and
// the progression plan can never rank one item two ways.
//
// BOTH ARE STATED HEURISTICS — roleWeights.ts says so in as many words: opinionated weightings of
// the numbers the corpus states, useful for RANKING and meaningless as absolutes. What a heuristic
// can still promise, and what this file pins, is structure rather than coefficients:
//
//   1. ABSENT IS NOT ZERO (law 1): an item stating none of a focus's inputs has NO score — never a
//      zero — so a sort puts it last and its cell renders blank; an item that states an input the
//      class gate zeroes has a score of 0, which is a number.
//   2. THE WEAPON'S OUTPUT ENTERS ONCE, as the ratio, at the focus's ratio weight. A score that
//      added raw DMG beside DMG/DELAY would count the same swing twice.
//   3. BIS RANKS BREADTH OVER A SINGLE TALL STAT — the fork example, verbatim: "2 AC 10 STR" must
//      lose to "30 AC 2 STR 5 STA 10 MANA".
//   4. THE CLASS GATE is the role model's: a casting stat nobody picked can use scores nothing.
//   5. HASTE IS CREDITED ONLY ABOVE WHAT IS WORN (`ownedHaste`), and the Ignore-haste chip is an
//      infinite worn haste — a stated PENALTY still scores under it (a stated negative is stated).
//   6. BOTH READ THE SCALED VECTOR through `sortValue`, so the plus-state slider moves them.
//
// The expected NUMBERS are re-derived through `roleValue` and the one coefficient each claim is
// about, never typed as literals a retune would rot — the ratio weight and the haste weight are
// read back off the same public functions the table reads.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GearRow } from '../src/shared/planner/gear'
import { gearBisValue, gearEffectiveDamage, gearRatio } from '../src/shared/planner/gearScale'
import { roleValue } from '../src/shared/planner/roleWeights'
import type { ItemUpgradeState } from '../src/shared/itemUpgrade'
import { scaleAll, sortGearRows, sortValue } from '../src/renderer/src/features/gear/gearFilter'
import { statText } from '../src/renderer/src/features/gear/gearColumns'

function row(over: Partial<GearRow> & Pick<GearRow, 'key' | 'name'>): GearRow {
  return {
    searchKey: over.name.toLowerCase(),
    slots: [],
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

/** A pure weapon: DMG and DELAY and nothing else the damage focus reads. */
const WEAPON = row({
  key: 'thelvorn, blade of light',
  name: 'Thelvorn, Blade of Light',
  slots: ['PRIMARY'],
  skill: '1H Slashing',
  stats: { DMG: 20, DELAY: 26, WEIGHT: 3 }
})

/** "Tier 2   3 / 4" — the owner screenshot every phase-0 number in this repo is verified against. */
const CHECKPOINT: ItemUpgradeState = { full: 2, fraction: 3 }

test('EFF DMG is the dps focus, the weapon output enters ONCE as the ratio, and absent is not zero', () => {
  // The weapon's only input is its ratio, so the score IS the weighted ratio — proving raw DMG is
  // not summed beside it. The weight is read back off `roleValue` with a unit ratio rather than
  // restated, so a retune moves both sides of this equality together.
  const ratio = gearRatio(WEAPON.stats)
  assert.ok(ratio !== undefined)
  const ratioWeight = roleValue({ DMG: 1, DELAY: 1 }, 'dps')
  assert.equal(sortValue(WEAPON, 'EFF_DMG'), Math.round(ratio * ratioWeight * 1000) / 1000)
  assert.equal(gearEffectiveDamage(WEAPON.stats), roleValue(WEAPON.stats, 'dps'), 'the shim IS the role model')

  // A stat-only item still scores — offense stats contribute without any weapon block.
  const strOnly = gearEffectiveDamage({ STR: 10 })
  assert.ok(strOnly !== undefined && strOnly > 0)

  // NOTHING THE FOCUS READS → ABSENT. Weight is a cost, not worth; a blank row is a blank cell.
  assert.equal(gearEffectiveDamage({}), undefined)
  assert.equal(gearEffectiveDamage({ WEIGHT: 3 }), undefined)
  // The dps focus reads AC at a SMALL weight - a melee wears armour too - so an armour-only item
  // has a small damage score rather than none (the 2026-08-15 shim read none): ten AC is worth
  // less than a 0.5-ratio weapon to a dps, and the table says by how much.
  const defence = gearEffectiveDamage({ AC: 10 })
  assert.ok(defence !== undefined && defence > 0 && defence < gearEffectiveDamage({ DMG: 10, DELAY: 20 })!)

  // One decimal in the cell, blank when absent — the same voice as RATIO and WEIGHT.
  assert.equal(statText(7.7, 'EFF_DMG'), '7.7')
  assert.equal(statText(undefined, 'EFF_DMG'), '')
})

test('BEST reads the class picks through the role model`s gate - a casting stat nobody picked can use scores NOTHING', () => {
  // The fork example, verbatim: *1000 INT means nothing to me as a warrior monk shaman.*
  const meleeTrio = { classes: ['WAR', 'MNK', 'SHM'] as const }
  assert.equal(gearBisValue({ INT: 1000 }, meleeTrio), 0, 'INT-only gear is worth exactly nothing to this trio - a stated 0, not a blank')
  // …but the SAME trio has a WIS caster, so WIS and mana still count.
  const wisScore = gearBisValue({ WIS: 10 }, meleeTrio)
  assert.ok(wisScore !== undefined && wisScore > 0, 'the shaman prays, so WIS scores')
  const manaScore = gearBisValue({ MP: 50 }, meleeTrio)
  assert.ok(manaScore !== undefined && manaScore > 0)
  // No picks = class-blind, the only honest reading when nobody has said who they are.
  assert.ok(gearBisValue({ INT: 1000 })! > 0)
  // And the gate never touches the universal stats.
  assert.equal(gearBisValue({ AC: 10 }, meleeTrio), gearBisValue({ AC: 10 }))
  assert.equal(gearBisValue({ AC: 10 }), roleValue({ AC: 10 }, 'balanced'), 'the shim IS the role model')
})

test('BIS ranks breadth over one tall stat - the fork example, verbatim', () => {
  const tall = gearBisValue({ AC: 2, STR: 10 })
  const broad = gearBisValue({ AC: 30, STR: 2, STA: 5, MP: 10 })
  assert.ok(tall !== undefined && broad !== undefined)
  assert.ok(broad > tall, '30 AC with spread stats outscores 2 AC 10 STR')

  // A single stated stat still scores; silence about every input is the only absence.
  const chaOnly = gearBisValue({ CHA: 15 })
  assert.ok(chaOnly !== undefined && chaOnly > 0)
  assert.equal(gearBisValue({}), undefined)
  assert.equal(statText(undefined, 'BIS'), '')
})

test('haste is credited only ABOVE what is worn, and the chip is an infinite worn haste', () => {
  const hasteWeight = roleValue({ HASTE: 1 }, 'dps')
  assert.ok(hasteWeight > 0)
  // Nothing worn: the whole 20% counts. Wearing 15%: five points of it. Wearing 20% or more: none.
  assert.equal(gearEffectiveDamage({ HASTE: 20 }), 20 * hasteWeight)
  assert.equal(gearEffectiveDamage({ HASTE: 20 }, { ownedHaste: 15 }), 5 * hasteWeight)
  assert.equal(gearEffectiveDamage({ HASTE: 20 }, { ownedHaste: 20 }), 0)
  assert.equal(gearEffectiveDamage({ HASTE: 20 }, { ownedHaste: 41 }), 0)
  // The chip drops the credit whatever is worn - and only the CREDIT: a stated penalty is a stated
  // number and still scores (the one place the chip differs from the 2026-08-15 term-drop).
  assert.equal(gearEffectiveDamage({ HASTE: 20 }, { ignoreHaste: true }), 0)
  assert.equal(gearEffectiveDamage({ HASTE: -5 }, { ignoreHaste: true }), -5 * hasteWeight)
  // BEST reads the same rule through the balanced focus.
  assert.equal(gearBisValue({ HASTE: 20 }, { ownedHaste: 20 }), 0)
  assert.ok(gearBisValue({ HASTE: 20 })! > 0)
})

test('ORDER: the better ratio leads REGARDLESS of haste — a weapon never wins the hand on it', () => {
  // Superseding the 2026-08-15 measurement by the 2026-09-05 fork ruling (the Fangol case): worn
  // haste does not stack, lives equally on belts and capes, and keeps granting from an Any Slot,
  // so it is a property of the LOADOUT and prices at ZERO on a weapon row. The stronger swing
  // leads the sort with or without haste owned — the haste column still SHOWS the percentage, it
  // just cannot decide a weapon comparison any more.
  const hasty = row({ key: 'hasty', name: 'Hasty Blade', stats: { DMG: 10, DELAY: 20, HASTE: 41 } })
  const strong = row({ key: 'strong', name: 'Strong Blade', stats: { DMG: 15, DELAY: 20 } })
  const bare = sortGearRows([hasty, strong], { key: 'EFF_DMG', dir: 'desc' }).map((r) => r.name)
  assert.deepEqual(bare, ['Strong Blade', 'Hasty Blade'], 'nothing worn: damage decides, not haste')
  const worn = sortGearRows([hasty, strong], { key: 'EFF_DMG', dir: 'desc' }, { ownedHaste: 41 }).map((r) => r.name)
  assert.deepEqual(worn, ['Strong Blade', 'Hasty Blade'], 'wearing 41% already: same order — the rule is unconditional')
})

test('the slider moves both scores - they read the SCALED vector through sortValue', () => {
  const [scaled] = scaleAll([WEAPON], CHECKPOINT)
  const baseDmg = sortValue(WEAPON, 'EFF_DMG')
  const atDmg = sortValue(scaled, 'EFF_DMG')
  assert.ok(baseDmg !== undefined && atDmg !== undefined)
  assert.ok(atDmg > baseDmg, 'DMG scales and DELAY does not, so the damage score grows with the tier')

  const baseBis = sortValue(WEAPON, 'BIS')
  const atBis = sortValue(scaled, 'BIS')
  assert.ok(baseBis !== undefined && atBis !== undefined)
  assert.ok(atBis > baseBis)
})
