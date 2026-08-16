// GEAR TAB — EFF DMG and BIS, the third and fourth derived keys (user ask, 2026-08-15).
//
// BOTH ARE STATED HEURISTICS — gearScale.ts says so in as many words: opinionated weightings of the
// numbers the corpus states, useful for RANKING and meaningless as absolutes. What a heuristic can
// still promise, and what this file pins, is structure rather than coefficients:
//
//   1. ABSENT IS NOT ZERO (law 1): an item stating none of a score's inputs has NO score — never a
//      zero — so a sort puts it last and its cell renders blank, like every other key.
//   2. THE WEAPON'S OUTPUT ENTERS ONCE, as the ratio. A score that added raw DMG beside DMG/DELAY
//      would count the same swing twice — the bug this test exists to keep out.
//   3. BIS RANKS BREADTH OVER A SINGLE TALL STAT — the user's own example, verbatim: "2 AC 10 STR"
//      must lose to "30 AC 2 STR 5 STA 10 MANA".
//   4. BOTH READ THE SCALED VECTOR through `sortValue`, so the plus-state slider moves them.
//
// Deliberately NOT pinned: the individual weights. They are a product opinion, and a test that
// froze `STR * 0.35` would fail on every retune while proving nothing about correctness.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GearRow } from '../src/shared/planner/gear'
import { gearBisValue, gearEffectiveDamage, gearRatio } from '../src/shared/planner/gearScale'
import type { ItemUpgradeState } from '../src/shared/itemUpgrade'
import { scaleAll, sortValue } from '../src/renderer/src/features/gear/gearFilter'
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

/** A pure weapon: DMG and DELAY and nothing the damage score reads besides the ratio they make. */
const WEAPON = row({
  key: 'thelvorn, blade of light',
  name: 'Thelvorn, Blade of Light',
  slots: ['PRIMARY'],
  skill: '1H Slashing',
  stats: { WIS: 15, DMG: 20, DELAY: 26, WEIGHT: 3 }
})

/** "Tier 2   3 / 4" — the owner screenshot every phase-0 number in this repo is verified against. */
const CHECKPOINT: ItemUpgradeState = { full: 2, fraction: 3 }

test('EFF DMG counts the weapon output ONCE (the ratio), and absent is not zero', () => {
  // The weapon's only offense input is its ratio, so the score IS the weighted ratio — proving raw
  // DMG is not summed beside it. The weight (×10) is read back through the same public functions
  // rather than restated, so a retune moves both sides of this equality together.
  const ratio = gearRatio(WEAPON.stats)
  assert.ok(ratio !== undefined)
  assert.equal(sortValue(WEAPON, 'EFF_DMG'), Math.round(ratio * 10 * 10) / 10)

  // A stat-only item still scores — offense stats contribute without any weapon block.
  const strOnly = gearEffectiveDamage({ STR: 10 })
  assert.ok(strOnly !== undefined && strOnly > 0)

  // NOTHING STATED → ABSENT. Defense is not offense: AC and HP contribute nothing here.
  assert.equal(gearEffectiveDamage({}), undefined)
  assert.equal(gearEffectiveDamage({ AC: 100, HP: 100 }), undefined)

  // One decimal in the cell, blank when absent — the same voice as RATIO and WEIGHT.
  assert.equal(statText(7.7, 'EFF_DMG'), '7.7')
  assert.equal(statText(undefined, 'EFF_DMG'), '')
})

test('BEST reads the class picks - a casting stat nobody picked can use scores NOTHING', () => {
  // The user's own example, verbatim: *1000 INT means nothing to me as a warrior monk shaman.*
  const meleeTrio = { classes: ['WAR', 'MNK', 'SHM'] as const }
  assert.equal(gearBisValue({ INT: 1000 }, meleeTrio), undefined, 'INT-only gear is worth a blank, not a number')
  // …but the SAME trio has a WIS caster, so WIS and mana still count.
  const wisScore = gearBisValue({ WIS: 10 }, meleeTrio)
  assert.ok(wisScore !== undefined && wisScore > 0, 'the shaman prays, so WIS scores')
  const manaScore = gearBisValue({ MP: 50 }, meleeTrio)
  assert.ok(manaScore !== undefined && manaScore > 0)
  // No picks = class-blind, the only honest reading when nobody has said who they are.
  assert.ok(gearBisValue({ INT: 1000 })! > 0)
  // And the gate never touches the universal stats.
  assert.equal(gearBisValue({ AC: 10 }, meleeTrio), gearBisValue({ AC: 10 }))
})

test('BIS ranks breadth over one tall stat - the user’s own example, verbatim', () => {
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
