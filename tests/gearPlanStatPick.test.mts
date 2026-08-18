// THE STAT FILTER'S RULES — "show me boots with more wisdom than the ones I have on".
//
// The whole module is pure, so every claim the surface makes about narrowing and ordering is
// settled here rather than in the e2e, which is left to prove only that the controls reach the
// screen and drive these functions.
//
// THE ONE THAT MATTERS MOST IS THE DIRECTION. `DELAY` and `WEIGHT` are better SMALLER, and a filter
// that tested `>` would hide every faster weapon while the delta line beside it drew that same
// shorter delay green. So `betterIsLess` has one home and both read it, and the last test here
// walks every key in the vector to pin that the exception list is exactly two long.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GEAR_STAT_KEYS } from '../src/shared/planner/gear'
import {
  STAT_PICK_OPTIONS,
  beatsOne,
  beatsWornOn,
  betterIsLess,
  pickScore
} from '../src/shared/planner/gearPlanStatPick'
import { isImprovement } from '../src/shared/planner/gearPlanTotals'

// The user's own example: gloves at +5 WIS / +10 INT are what a candidate has to beat.
const WORN = { WIS: 5, INT: 10, AC: 12 }

test('one picked stat narrows to items that beat the worn one on it', () => {
  assert.equal(beatsWornOn(['WIS'], { WIS: 6 }, WORN), true)
  assert.equal(beatsWornOn(['WIS'], { WIS: 5 }, WORN), false, 'equal is not better')
  assert.equal(beatsWornOn(['WIS'], { WIS: 4 }, WORN), false)
  // The other stats are not consulted at all - a pick is the whole question.
  assert.equal(beatsWornOn(['WIS'], { WIS: 6, INT: 0, AC: 0 }, WORN), true)
})

test('two picked stats are ANDed - the strict reading, and the useful one', () => {
  // Straight from the request: with WIS and INT both picked against +5/+10 gloves, only items
  // better on BOTH survive. Winning one axis and losing the other is exactly the trade the delta
  // line exists to show, and folding it into "matches" would make the filter mean nothing.
  assert.equal(beatsWornOn(['WIS', 'INT'], { WIS: 6, INT: 11 }, WORN), true)
  assert.equal(beatsWornOn(['WIS', 'INT'], { WIS: 6, INT: 10 }, WORN), false, 'ties on INT')
  assert.equal(beatsWornOn(['WIS', 'INT'], { WIS: 4, INT: 99 }, WORN), false, 'loses WIS, wins INT')
  assert.equal(beatsWornOn(['WIS', 'INT'], { WIS: 99, INT: 4 }, WORN), false, 'and the mirror')
})

test('an empty pick rejects nothing - no filter is not a filter that says no', () => {
  assert.equal(beatsWornOn([], {}, WORN), true)
  assert.equal(beatsWornOn([], { WIS: 1 }, null), true)
})

test('absent is ZERO on both sides, so a stat neither states is a tie', () => {
  // The rule the rest of the board's arithmetic already runs on: a page without STR is an item
  // without STR, not an item whose STR is unknown.
  assert.equal(beatsOne('STR', {}, { STR: 3 }), false)
  assert.equal(beatsOne('STR', { STR: 1 }, {}), true)
  assert.equal(beatsOne('STR', {}, {}), false, 'nothing beats nothing')
})

test('with NOTHING worn the baseline is zero, so the filter asks "states this at all"', () => {
  // A different question from the usual one, and the surface labels it differently for that
  // reason ("Has these" rather than "Beats worn"). What must not happen is it passing everything.
  assert.equal(beatsWornOn(['WIS'], { WIS: 1 }, null), true)
  assert.equal(beatsWornOn(['WIS'], { INT: 40 }, null), false, 'silent on WIS is not better at it')
  assert.equal(beatsWornOn(['WIS'], {}, null), false)
})

test('DELAY and WEIGHT are BETTER SMALLER, in the filter and in the sort alike', () => {
  // The defect this pins: a `>` test would hide every faster weapon in the game.
  assert.equal(beatsOne('DELAY', { DELAY: 20 }, { DELAY: 26 }), true, 'faster is better')
  assert.equal(beatsOne('DELAY', { DELAY: 30 }, { DELAY: 26 }), false)
  assert.equal(beatsOne('WEIGHT', { WEIGHT: 2 }, { WEIGHT: 5 }), true, 'lighter is better')
  assert.equal(beatsOne('WEIGHT', { WEIGHT: 8 }, { WEIGHT: 5 }), false)
  // …and the ranking agrees with the filter rather than inverting it.
  assert.ok(pickScore(['DELAY'], { DELAY: 20 }) > pickScore(['DELAY'], { DELAY: 26 }))
  assert.ok(pickScore(['WEIGHT'], { WEIGHT: 2 }) > pickScore(['WEIGHT'], { WEIGHT: 9 }))
})

test('the score ranks on the picked stats and ignores everything else', () => {
  assert.equal(pickScore(['WIS'], { WIS: 12, INT: 999 }), 12)
  assert.equal(pickScore(['WIS', 'INT'], { WIS: 12, INT: 3 }), 15, 'several picks add')
  assert.equal(pickScore(['WIS'], {}), 0, 'silent is zero, not absent')
  assert.equal(pickScore([], { WIS: 12 }), 0, 'nothing picked ranks nothing')
})

test('`betterIsLess` is the SAME rule the coloured delta line reads', () => {
  // Two surfaces, one direction. If these ever disagreed, an item could be filtered out for being
  // worse on delay while the delta line drew that same delay as a gain.
  for (const key of GEAR_STAT_KEYS) {
    const down = { key, delta: -1 } as const
    assert.equal(
      isImprovement(down),
      betterIsLess(key),
      `${key}: the delta line and the filter must agree on which way is up`
    )
  }
})

test('the exception list is exactly DELAY and WEIGHT, and the picker offers every key', () => {
  const less = GEAR_STAT_KEYS.filter(betterIsLess)
  assert.deepEqual(less, ['DELAY', 'WEIGHT'])
  // Every OTHER key reads its sign straight — the saves included, since the corpus states those as
  // resistances rather than as damage taken.
  for (const key of GEAR_STAT_KEYS) {
    if (betterIsLess(key)) continue
    assert.equal(beatsOne(key, { [key]: 2 }, { [key]: 1 }), true, `${key}: more should be better`)
  }
  // The structural keys are OFFERED deliberately: DMG and DELAY are exactly what someone shopping
  // for a weapon narrows on, and `betterIsLess` is what makes them safe to include.
  assert.deepEqual([...STAT_PICK_OPTIONS], [...GEAR_STAT_KEYS])
})
