// THE RECOMMENDED TAB'S FOCUS PARAGRAPH — what "Gearing for" looks for, in the player's words
// (src/renderer/src/features/plan/planBlurb.ts; owner ask 2026-08-22).
//
// WHAT IS PINNED: every role has a reading and it names the role; the class sentence restates the
// class gate of roleWeights.ts — no bar for the pure melee, the right attribute for a caster or a
// hybrid, both when a trio mixes them, backstab only beside a rogue — and an empty trio says so.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planBlurb } from '../src/renderer/src/features/plan/planBlurb'
import type { GearRole } from '../src/shared/planner/roleWeights'

const ROLES: readonly [GearRole, string][] = [
  ['balanced', 'Balanced'],
  ['tank', 'Tank'],
  ['healer', 'Healer'],
  ['dps', 'DPS (any)'],
  ['dps1h', '1H DPS'],
  ['dps2h', '2H DPS'],
  ['dualwield', 'Dual wield'],
  ['range', 'Ranged'],
  ['dd', 'Caster DD'],
  ['dot', 'Caster DoT']
]

test('every focus has a reading, opens with its own picker label, and says what weapon shape it takes', () => {
  for (const [role, label] of ROLES) {
    const text = planBlurb(role, [])
    assert.equal(text.startsWith(`${label} weighs`), true, `${role} opens "${label} weighs"`)
    assert.match(text, /Takes only|any weapon|both hands/i, `${role} states its weapon shape`)
  }
  // The one cell the melee builds differ on is said where it applies, and only there.
  assert.match(planBlurb('dps2h', []), /damage bonus/)
  assert.doesNotMatch(planBlurb('dps1h', []), /damage bonus/)
  assert.match(planBlurb('range', []), /DEX first/)
})

test('the class sentence is the class gate in the player\'s words', () => {
  // The owner's own trio: no bar, so the caster stats and mana are dead — the sentence that
  // explains why a 10 INT glove stopped appearing.
  assert.match(planBlurb('dps2h', ['BER', 'WAR']), /BER and WAR: no mana bar, so INT, WIS and mana score nothing\.$/)
  // A caster reads its own attribute and the other is named as dead.
  assert.match(planBlurb('dd', ['WIZ']), /WIZ: mana reads INT, so WIS scores nothing\.$/)
  assert.match(planBlurb('healer', ['CLR']), /CLR: mana reads WIS, so INT scores nothing\.$/)
  // A mixed trio reads both, and says neither is dead.
  assert.match(planBlurb('balanced', ['SHD', 'PAL', 'WAR']), /SHD, PAL and WAR: mana reads INT and WIS\.$/)
  // Backstab is said only beside a rogue.
  assert.match(planBlurb('dps1h', ['ROG']), /backstab counts\.$/)
  assert.doesNotMatch(planBlurb('dps1h', ['MNK']), /backstab/)
  // No trio is unknown, not nobody.
  assert.match(planBlurb('dps', []), /No class picked, so every stat an item states counts\.$/)
})
