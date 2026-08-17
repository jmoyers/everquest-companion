// THE THREE WARNINGS A PICKER ROW WEARS — the class half, and the rule about when to draw any.
//
// `features/gearplan/gearPlanSignals.ts` is pure; the era and ownership verdicts are BORROWED
// whole (`plannerData.eraChip`, `gearOwnership.ownershipFor`) and are pinned by their own suites,
// so what is left to test here is the one rule this file adds and the one it must not break.
//
//  1. UNKNOWN IS NOT A REFUSAL (law 1), and there are TWO kinds of unknown: an item that states no
//     class list, and a character whose loadout the app has not inferred. Reporting either as `no`
//     would hang a warning on a row for a fact nobody established.
//  2. A ROW WITH NOTHING TO SAY WEARS NOTHING. `hasSignal` is what stops an ordinary in-era,
//     wearable, unowned item growing an empty chip strip — which is most rows in the picker.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ClassAbbr } from '../src/shared/classCombo'
import {
  classFitOf,
  hasSignal,
  hidesRow,
  NO_ROW_FILTER,
  type GearPlanRowFilter,
  type RowSignals
} from '../src/renderer/src/features/gearplan/gearPlanSignals'

const TRIO: ClassAbbr[] = ['PAL', 'CLR', 'ENC']

test('an item naming ANY class you run fits — one overlap is enough', () => {
  assert.equal(classFitOf(['PAL'], TRIO), 'fits')
  assert.equal(classFitOf(['WIZ', 'MAG', 'ENC'], TRIO), 'fits')
  assert.equal(classFitOf(TRIO, TRIO), 'fits')
})

test('an item naming ONLY classes you do not run is the one honest `no`', () => {
  assert.equal(classFitOf(['WIZ'], TRIO), 'no')
  assert.equal(classFitOf(['WIZ', 'MAG', 'NEC'], TRIO), 'no')
})

test('an item that states NO class list is unknown, never a refusal (law 1)', () => {
  assert.equal(classFitOf([], TRIO), 'unknown')
})

test('a character whose loadout is not known yet cannot be excluded by anything', () => {
  assert.equal(classFitOf(['WIZ'], []), 'unknown')
  assert.equal(classFitOf([], []), 'unknown')
})

// ---- when a row is decorated at all ----------------------------------------------------------

const QUIET: RowSignals = { era: null, classFit: 'fits', owned: null, wished: false }

test('an ordinary row — in era, wearable, unowned — wears no chip strip at all', () => {
  assert.equal(hasSignal(QUIET), false)
})

test('any one of the three is enough to draw the strip', () => {
  assert.equal(hasSignal({ ...QUIET, classFit: 'no' }), true)
  assert.equal(hasSignal({ ...QUIET, classFit: 'unknown' }), true)
  assert.equal(hasSignal({ ...QUIET, owned: { label: 'Bank +2', lootedOnly: false } }), true)
  assert.equal(
    hasSignal({ ...QUIET, era: { label: 'out of era', unknown: false, tooltip: 'x' } }),
    true
  )
  assert.equal(hasSignal({ ...QUIET, wished: true }), true)
})

// ---- narrowing the pool ------------------------------------------------------------------------
//
// `hidesRow` is the half of this file that REVERSED a ruling ("warnings, never filters"), so these
// tests carry the four rules that made the reversal defensible rather than just the truth table.

const OUT_OF_ERA = { label: 'Velious', unknown: false, tooltip: 'x' }
const ERA_UNKNOWN = { label: 'era?', unknown: true, tooltip: 'x' }
const HELD = { label: 'Bank +2', lootedOnly: false }

test('RULE 1 - the shipped filter hides NOTHING, whatever a row says about itself', () => {
  const loud: RowSignals = { era: OUT_OF_ERA, classFit: 'no', owned: null, wished: false }
  assert.equal(hidesRow(loud, NO_ROW_FILTER, false), false)
  assert.equal(hidesRow(QUIET, NO_ROW_FILTER, false), false)
})

test('era hides BOTH a positive verdict and an unknown one - `eraHides`, borrowed', () => {
  // The owner ruling of 2026-08-13, quoted in plannerData: a question mark under a filter called
  // "Current era" is a leak, not a courtesy. `era === null` is exactly in-era, so both chips hide.
  assert.equal(hidesRow({ ...QUIET, era: OUT_OF_ERA }, NO_ROW_FILTER, true), true)
  assert.equal(hidesRow({ ...QUIET, era: ERA_UNKNOWN }, NO_ROW_FILTER, true), true)
  assert.equal(hidesRow(QUIET, NO_ROW_FILTER, true), false, 'an in-era row survives its own filter')
})

test('RULE 3 - the two filters that ARE ours never hide an unknown (law 1)', () => {
  // `class?` is a gap in the wiki, not a refusal. A filter that treated our ignorance as the
  // user's answer would turn a missing page into a missing item.
  const unknown: RowSignals = { ...QUIET, classFit: 'unknown' }
  assert.equal(hidesRow(unknown, { ...NO_ROW_FILTER, usableOnly: true }, false), false)
  // …and the one honest `no` is the only thing it does hide.
  assert.equal(
    hidesRow({ ...QUIET, classFit: 'no' }, { ...NO_ROW_FILTER, usableOnly: true }, false),
    true
  )
})

test('owned and wishlisted are KEEP-ONLY, so absence is what hides', () => {
  const owned: GearPlanRowFilter = { ...NO_ROW_FILTER, ownedOnly: true }
  assert.equal(hidesRow(QUIET, owned, false), true, 'no copy, no row')
  assert.equal(hidesRow({ ...QUIET, owned: HELD }, owned, false), false)

  const wished: GearPlanRowFilter = { ...NO_ROW_FILTER, wishedOnly: true }
  assert.equal(hidesRow(QUIET, wished, false), true)
  assert.equal(hidesRow({ ...QUIET, wished: true }, wished, false), false)
})

test('the filters AND together - each one narrows what the last one left', () => {
  const both: GearPlanRowFilter = { ...NO_ROW_FILTER, ownedOnly: true, wishedOnly: true }
  assert.equal(hidesRow({ ...QUIET, owned: HELD }, both, false), true, 'owned but not wished')
  assert.equal(hidesRow({ ...QUIET, wished: true }, both, false), true, 'wished but not owned')
  assert.equal(hidesRow({ ...QUIET, owned: HELD, wished: true }, both, false), false)
})

test('RULE 4 - surviving a filter does not quiet a row: the chips are independent', () => {
  // An owned, out-of-era row passes "Owned or looted" and must STILL wear both chips. `hasSignal`
  // is what the strip asks, and it knows nothing about the filter - which is the point.
  const row: RowSignals = { ...QUIET, owned: HELD, era: OUT_OF_ERA }
  assert.equal(hidesRow(row, { ...NO_ROW_FILTER, ownedOnly: true }, false), false)
  assert.equal(hasSignal(row), true)
})

