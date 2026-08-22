// THE CLASS LAYER OF THE ROLE WEIGHTS — which stats are LIVE for the classes picked
// (src/shared/planner/roleWeights.ts, its header; docs/plans/gear-progression-planner.md §2.3;
// fold rule 13 in progressionPlan.ts). Owner rulings 2026-08-22: *"a DPS class doesn't care about
// INT, CHA, WIS"*, *"stats need to be weighted based on the type of focus"*, and the standing ask
// for a grid of what helps which class.
//
// A FILE OF ITS OWN because the subject is the GATE and not the fold: every claim here is a
// `roleValue` arithmetic claim about one class or one trio, and none of them needs a route.
//
// WHAT IS PINNED:
//   1. the census — every class the combo vocabulary names has facts, and the facts are the game's;
//   2. NO FOCUS ROW NAMES INT OR WIS — the mana stat is a class fact resolved at read time;
//   3. the mana stat lands on the class's own attribute and nowhere else, at the focus's weight;
//   4. MP and mana regen die with the mana bar; CHA lives for ENC/BRD; BACKSTAB for ROG; END for
//      the disciplines classes;
//   5. a TRIO is "live for any"; an EMPTY trio is unknown and gates nothing (law 1).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLASS_ABBRS } from '../src/shared/classCombo'
import { CLASS_FACTS, roleStatKeys, roleValue, type GearRole } from '../src/shared/planner/roleWeights'

const ROLES: readonly GearRole[] = ['balanced', 'tank', 'healer', 'dps', 'dps1h', 'dps2h', 'dualwield', 'dd', 'dot']

test('every class the combo vocabulary names has facts, and the facts are the game\'s', () => {
  for (const abbr of CLASS_ABBRS) assert.ok(abbr in CLASS_FACTS, `${abbr} has a row`)
  // The four pure melee have no bar at all; the INT and WIS families are the game's, not a guess.
  for (const abbr of ['WAR', 'ROG', 'MNK', 'BER'] as const) assert.equal(CLASS_FACTS[abbr].manaStat, null, abbr)
  for (const abbr of ['ENC', 'MAG', 'NEC', 'WIZ', 'SHD', 'BRD'] as const) assert.equal(CLASS_FACTS[abbr].manaStat, 'INT', abbr)
  for (const abbr of ['CLR', 'DRU', 'SHM', 'PAL', 'RNG', 'BST'] as const) assert.equal(CLASS_FACTS[abbr].manaStat, 'WIS', abbr)
  // Backstab is a rogue skill; charisma resolves charm and mez for the two classes that cast them;
  // disciplines belong to the melee and the hybrids.
  assert.deepEqual(CLASS_ABBRS.filter((a) => CLASS_FACTS[a].backstab), ['ROG'])
  assert.deepEqual(CLASS_ABBRS.filter((a) => CLASS_FACTS[a].charisma), ['BRD', 'ENC'])
  assert.deepEqual(CLASS_ABBRS.filter((a) => !CLASS_FACTS[a].endurance), ['CLR', 'DRU', 'ENC', 'MAG', 'NEC', 'SHM', 'WIZ'])
})

test('NO focus row names INT or WIS — the mana stat is resolved by the class, never by the focus', () => {
  for (const role of ROLES) {
    const keys = roleStatKeys(role)
    assert.equal(keys.includes('INT'), false, `${role} names INT`)
    assert.equal(keys.includes('WIS'), false, `${role} names WIS`)
  }
})

test('the mana stat lands on the class\'s OWN attribute, at the focus\'s weight, and nowhere else', () => {
  // A wizard's INT is worth the DD focus's 1.7 per point; its WIS is worth nothing. A cleric the
  // other way round under HEALER (1.5). A warrior: neither, under anything.
  assert.equal(roleValue({ INT: 10 }, 'dd', { classes: ['WIZ'] }), 17)
  assert.equal(roleValue({ WIS: 10 }, 'dd', { classes: ['WIZ'] }), 0)
  assert.equal(roleValue({ WIS: 10 }, 'healer', { classes: ['CLR'] }), 15)
  assert.equal(roleValue({ INT: 10 }, 'healer', { classes: ['CLR'] }), 0)
  for (const role of ROLES) {
    assert.equal(roleValue({ INT: 10, WIS: 10 }, role, { classes: ['WAR'] }), 0, `${role}: a warrior has no mana stat`)
  }
  // THE HYBRID CASE the melee ruling left open: a Shadowknight on 2H DPS keeps a small INT credit
  // (the melee focuses' 0.3) because he does have a bar — and a Paladin the same for WIS.
  assert.equal(roleValue({ INT: 10 }, 'dps2h', { classes: ['SHD'] }), 3)
  assert.equal(roleValue({ WIS: 10 }, 'dps2h', { classes: ['PAL'] }), 3)
  assert.equal(roleValue({ WIS: 10 }, 'dps2h', { classes: ['SHD'] }), 0)
})

test('MP and mana regen die with the bar; CHA, BACKSTAB and END live only where the class can use them', () => {
  // No bar, no mana: a warrior's +100 mana and +10 regen are dead under every focus.
  for (const role of ROLES) {
    assert.equal(roleValue({ MP: 100, MANA_REGEN: 10 }, role, { classes: ['WAR'] }), 0, `${role}: mana is dead for WAR`)
  }
  assert.ok(roleValue({ MP: 100, MANA_REGEN: 10 }, 'dps', { classes: ['SHD'] }) > 0, 'a hybrid keeps its mana')
  // CHA resolves charm and mez: live for an enchanter, dead for a wizard on the SAME focus.
  assert.equal(roleValue({ CHA: 10 }, 'dd', { classes: ['ENC'] }), 5)
  assert.equal(roleValue({ CHA: 10 }, 'dd', { classes: ['WIZ'] }), 0)
  // BACKSTAB: a rogue's skill. A monk on the same one-hand focus reads it as nothing.
  assert.equal(roleValue({ BACKSTAB: 5 }, 'dps', { classes: ['ROG'] }), 10)
  assert.equal(roleValue({ BACKSTAB: 5 }, 'dps', { classes: ['MNK'] }), 0)
  // END regen feeds disciplines: live for the warrior, dead for the wizard — under BALANCED, the
  // one focus that weighs it for both.
  assert.equal(roleValue({ END_REGEN: 3 }, 'balanced', { classes: ['WAR'] }), 3)
  assert.equal(roleValue({ END_REGEN: 3 }, 'balanced', { classes: ['WIZ'] }), 0)
})

test('a TRIO is live-for-any, and an EMPTY trio is unknown — it gates nothing (law 1)', () => {
  const glove = { STR: 4, INT: 10 }
  // The owner's example: a 4 STR / 10 INT glove. To a warrior it is 4 STR. Add a Shadowknight to
  // the trio and the INT is live again, because somebody picked can use it.
  assert.equal(roleValue(glove, 'dps', { classes: ['WAR'] }), 6)
  assert.equal(roleValue(glove, 'dps', { classes: ['WAR', 'SHD'] }), 9)
  assert.equal(roleValue(glove, 'dps', { classes: ['WAR', 'BER', 'MNK'] }), 6)
  // NO CLASS STATED is not "nobody": both mana stats count, and so do CHA, BACKSTAB and END —
  // exactly what the fold scored before the gate existed, so an unpinned trio loses nothing.
  assert.equal(roleValue(glove, 'dps'), 9)
  assert.equal(roleValue({ INT: 10, WIS: 10 }, 'dd'), 34)
  assert.equal(roleValue({ CHA: 10, BACKSTAB: 5, END_REGEN: 3 }, 'balanced'), 2 + 2.5 + 3)
  assert.equal(roleValue(glove, 'dps', { classes: [] }), roleValue(glove, 'dps'))
})
