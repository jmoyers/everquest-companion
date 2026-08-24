// THE AREA CORE (JOS-449) — the shape test, the hit arithmetic, the cap default and the marker.
//
// Four tiny pure functions, and the reason they get a suite of their own is that all four are
// CLAIMS ABOUT THE GAME rather than code: which target types mean "more than one thing gets hit",
// that a rain is capped on HITS and not on targets per wave, that the number is four, and that the
// assumption is worded from the rows in force rather than from the constant. Each of those was
// measured or quoted (`src/shared/aoeSpells.ts` and `src/main/data/rainSpells.ts` carry the
// evidence), and a change to any of them should have to come here and re-argue it.
//
// No Electron, no network, no live log — this suite never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AE_TARGET_TYPES,
  AOE_ASSUMPTION_TITLE,
  DEFAULT_AE_MAX_TARGETS,
  aeHits,
  aeMaxTargets,
  aoeAssumptionLabel,
  isAeTargetType
} from '../src/shared/aoeSpells'

// ---- the shape test --------------------------------------------------------------------------

test('the AE shapes are the four the committed catalog actually spells, case-blind', () => {
  assert.deepEqual([...AE_TARGET_TYPES].sort(), ['ae', 'pb ae', 'pbaoe', 'targeted ae'])
  for (const t of ['Targeted AE', 'PB AE', 'PBAOE', 'AE', 'targeted ae', '  PB AE  ']) {
    assert.equal(isAeTargetType(t), true, t)
  }
})

test('a single-target shape is NOT an area shape, and neither is silence', () => {
  // Every one of these is a real `target_type` in the committed catalog. `Line of Sight` and `Bolt`
  // are the near-misses worth naming: both can strike more than one creature in flight and neither
  // states a target count anywhere, so a tab whose premise is a stated maximum cannot figure them.
  for (const t of ['Single', 'Self', 'Group', 'Lifetap', 'Undead', 'Line of Sight', 'Bolt', 'Animal']) {
    assert.equal(isAeTargetType(t), false, t)
  }
  assert.equal(isAeTargetType(undefined), false)
  assert.equal(isAeTargetType(''), false)
})

// ---- the cap ---------------------------------------------------------------------------------

test('the default cap is four, and a stated cap wins over it', () => {
  assert.equal(DEFAULT_AE_MAX_TARGETS, 4)
  assert.equal(aeMaxTargets(undefined), 4, 'no client install: the stated default answers')
  assert.equal(aeMaxTargets(null), 4)
  assert.equal(aeMaxTargets(8), 8, "the client's PB AE cap")
  assert.equal(aeMaxTargets(5), 5, "Denon's Desperate Dirge, where the client and the page disagree")
  // A zero in the client's column is what a single-target row says; it is not a cap of nothing.
  assert.equal(aeMaxTargets(0), 4)
  assert.equal(aeMaxTargets(-3), 4)
})

// ---- the arithmetic, which is the whole oddity -------------------------------------------------

test('A RAIN IS CAPPED ON HITS, NOT ON TARGETS PER WAVE — the four-page quote, in numbers', () => {
  // "Rain nukes are limited to 4 hits total. Either you can hit the same mobs 3 times, you can hit
  // 2 mobs twice each, or you can hit 4 mobs once each." (Avalanche, Blizzard, Cascade of Hail,
  // Pogonip — all four quoted in rainSpells.ts.)
  assert.equal(aeHits(3, 1, 4), 3, 'one mob takes all three waves')
  assert.equal(aeHits(3, 2, 4), 4, 'two mobs twice each is four hits, not six')
  assert.equal(aeHits(3, 4, 4), 4, 'four mobs once each: the cap is the answer, never 12')
})

test('a plain area spell reads targets x1, and a single-target reading is unchanged forever', () => {
  assert.equal(aeHits(1, 4, 4), 4, 'a quad nuke at max targets')
  assert.equal(aeHits(1, 1, 4), 1, 'and at one target it is the figure this app always printed')
  assert.equal(aeHits(1, 8, 8), 8, 'a PB AE with the client cap in hand')
  assert.equal(aeHits(1, 8, 4), 4, '…and never past the cap')
})

test('hits are whole and never below one, whatever the caller hands in', () => {
  assert.equal(aeHits(0, 0, 0), 1)
  assert.equal(aeHits(-2, -2, -2), 1)
  assert.equal(aeHits(2.9, 1, 9), 2, 'truncated, because a fraction of a hit is not a thing')
})

// ---- the visible assumption --------------------------------------------------------------------

test('the marker states the count the table ACTUALLY used, not the constant', () => {
  assert.equal(aoeAssumptionLabel([4, 4, 4]), 'x4 targets')
  assert.equal(aoeAssumptionLabel([8]), 'x8 targets')
  // The mixed table a client install really produces: targeted AEs at 4 beside PB AEs at 8.
  assert.equal(aoeAssumptionLabel([4, 8, 4]), 'x4 to x8 targets')
  // An empty table still has to say something: the marker sits on the tab, not inside the table.
  assert.equal(aoeAssumptionLabel([]), 'x4 targets')
  assert.equal(aoeAssumptionLabel([0, -1]), 'x4 targets', 'nonsense counts are not a range')
})

test('the marker copy is player-facing: no em dashes, and the tooltip states the whole assumption', () => {
  for (const s of [aoeAssumptionLabel([4]), aoeAssumptionLabel([4, 8]), AOE_ASSUMPTION_TITLE]) {
    assert.equal(s.includes('—'), false, `em dash in player copy: ${s}`)
    assert.equal(s.includes('–'), false, `en dash in player copy: ${s}`)
  }
  // The two facts a reader needs to judge the number: where four comes from, and that a rain's cap
  // is on hits rather than on targets.
  assert.match(AOE_ASSUMPTION_TITLE, /max targets|every target/i)
  assert.match(AOE_ASSUMPTION_TITLE, /four hits in total/i)
})
