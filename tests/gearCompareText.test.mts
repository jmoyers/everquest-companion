// THE SWAP VOCABULARY — `gearCompare.ts`'s grouped form (fork, kaltinril 2026-09-05): the hover
// card stopped printing comparisons ("AC 5 vs 10 (-5)", direction unlabeled) and started printing
// the SWAP — what equipping the hovered item gains you and what it costs, `KEY worn→this`, grouped
// and colored by `compareDirection`. These pins are what keeps that reading honest:
//   * the direction is about the SWAP, so a key only the hovered item states is a GAIN and a key
//     only the worn item states is a LOSS — no subtraction is claimed for either (law 1);
//   * DELAY and WEIGHT invert, because more of either is worse — the one editorial fact the form
//     adds, spelled in one Set;
//   * the arrow order is WORN FIRST, hovered second — the direction the swap moves — and `—` marks
//     a side that states nothing (the "none is the word" rule is about prose, where a dash misreads
//     as a minus; between a label and an arrow it is a blank cell).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GearRow } from '../src/shared/planner/gear'
import {
  NO_BASE_CHANGE,
  arrowText,
  compareDirection,
  compareStats,
  swapSections
} from '../src/renderer/src/features/gear/gearCompare'

test('the swap direction: gain what the hovered item brings, lose what the worn one had', () => {
  assert.equal(compareDirection({ key: 'DEX', item: 8 }), 'gain', 'stated only on the hovered item')
  assert.equal(compareDirection({ key: 'STA', equipped: 13 }), 'loss', 'stated only on the worn one')
  assert.equal(compareDirection({ key: 'AC', item: 10, equipped: 5, delta: 5 }), 'gain')
  assert.equal(compareDirection({ key: 'AC', item: 5, equipped: 10, delta: -5 }), 'loss')
})

test('DELAY and WEIGHT run the other way: more of either is worse', () => {
  assert.equal(compareDirection({ key: 'DELAY', item: 40, equipped: 24, delta: 16 }), 'loss')
  assert.equal(compareDirection({ key: 'DELAY', item: 24, equipped: 40, delta: -16 }), 'gain')
  assert.equal(compareDirection({ key: 'WEIGHT', item: 2.5, equipped: 0.1, delta: 2.4 }), 'loss')
  // …and one-sided reads flip with them: a stated weight where none was is a cost arriving.
  assert.equal(compareDirection({ key: 'WEIGHT', item: 2.5 }), 'loss')
  assert.equal(compareDirection({ key: 'WEIGHT', equipped: 2.5 }), 'gain')
})

test('the arrow entry is `KEY worn→this`, dash for a silent side, table spelling throughout', () => {
  assert.equal(arrowText({ key: 'AC', item: 5, equipped: 10, delta: -5 }), 'AC 10→5')
  assert.equal(arrowText({ key: 'DEX', item: 8 }), 'DEX —→8')
  assert.equal(arrowText({ key: 'STA', equipped: 13 }), 'STA 13→—')
  // Percent keys keep the table's own spelling (`statText`), and underscores read as spaces.
  assert.equal(arrowText({ key: 'HASTE', item: 41, equipped: 36, delta: 5 }), 'HASTE 36%→41%')
  assert.equal(arrowText({ key: 'HP_REGEN', item: 6 }), 'HP REGEN —→6')
})

test('the card compares BASE TO BASE, and a merged worn copy is stated in the frame, not the math', () => {
  // The 2026-09-05 ruling: the route admits base-against-base (fold rule 6), and the card stopped
  // contradicting it — a worn `+4`'s scaled numbers never enter the subtraction, its tier enters
  // the LABEL. Same item at base: nothing differs, and the card says so rather than going silent.
  const worn: GearRow = {
    key: 'shiverback-hide boots', name: 'Shiverback-Hide Boots', searchKey: 'shiverback-hide boots',
    slots: ['FEET'], classes: [], races: ['ALL'], flags: [], quest: false, playerCrafted: false,
    stats: { AC: 6, STR: 5, STA: 9, AGI: 9 }, effects: []
  }
  const host = { key: worn.key, name: worn.name, tier: 4 }
  const [section] = swapSections({ AC: 5, DEX: 8 }, host, worn)
  assert.equal(section.label, 'base vs base — you wear it merged to +4')
  assert.deepEqual(section.changes.map(arrowText), ['AC 6→5', 'STR 5→—', 'STA 9→—', 'AGI 9→—', 'DEX —→8'])
  // A base worn copy states no frame — there is only one reading and nothing to flag.
  const [plain] = swapSections({ AC: 5 }, { key: worn.key, name: worn.name }, worn)
  assert.equal(plain.label, undefined)
  // No host, or a corpus with no row for it, is NO section — the card's other branches own those.
  assert.deepEqual(swapSections({ AC: 5 }, null, worn), [])
  assert.deepEqual(swapSections({ AC: 5 }, host, undefined), [])
  // The same item against itself has an empty section and a spelled reason.
  const [same] = swapSections(worn.stats, host, worn)
  assert.deepEqual(same.changes, [])
  assert.equal(typeof NO_BASE_CHANGE, 'string')
})

test('the pipeline end to end: compareStats rows feed the grouped form losslessly', () => {
  // The screenshot case, in miniature: hovered states DEX and HP, worn states AC higher and STR.
  const rows = compareStats({ AC: 5, DEX: 8, HP: 40 }, { AC: 10, STR: 9 })
  const byKey = new Map(rows.map((r) => [r.key, r]))
  assert.equal(compareDirection(byKey.get('AC')!), 'loss')
  assert.equal(compareDirection(byKey.get('STR')!), 'loss')
  assert.equal(compareDirection(byKey.get('DEX')!), 'gain')
  assert.equal(compareDirection(byKey.get('HP')!), 'gain')
  assert.equal(arrowText(byKey.get('AC')!), 'AC 10→5')
})
