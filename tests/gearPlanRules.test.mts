// THE GEAR PLAN BOARD'S PICKER RULES — which donors a cell may offer, in what order, and what
// socketing them narrows the item to.
//
// Pure model only: `features/gearplan/gearPlanRules.ts` touches no React, no storage and no IPC, so
// it runs under the node runner exactly like `gearCompare` and `gearFilter` before it.
//
// WHAT THIS FILE IS FOR, in four sentences:
//
//  1. THE THREE REFUSALS ARE R2 AND R3, ASKED RATHER THAN RESTATED. A haste-locked donor is refused
//     for the HASTE reason first, a donor that shares no slot with the cell is refused, and a donor
//     that shares no class with the PLANNED ITEM is refused. Nothing here re-implements those.
//  2. AN ANY-CELL CONSTRAINS NOTHING. `hostSlotsOf` returns all eighteen slots for `ANY1`/`ANY2`
//     (JOS-104: the game gives you two places that constrain nothing), so the same donor that fails
//     on a HEAD cell passes on an any-cell — and that is the game's answer, not a hole.
//  3. UNKNOWN IS NOT A FAIL (law 1). A page that stated no class list is UNKNOWN, never "nobody",
//     and both sides of that test are checked here because the failure mode is silent: a picker
//     that treats unknown as a refusal simply shows fewer rows and never says why.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PLANNER_SEARCH_LIMIT, PLANNER_SEARCH_MAX } from '../src/main/planner/effectIndex'
import type { ClassAbbr } from '../src/shared/classCombo'
import type { EquipSlot, PlannerDonor, SocketType } from '../src/shared/planner/types'
import {
  donorFitsCell,
  donorPickerRows,
  PLANNER_PAGE,
  PLANNER_PAGE_MAX
} from '../src/renderer/src/features/gearplan/gearPlanRules'

// =================================================================================
// FIXTURES
// =================================================================================

function donor(over: Partial<PlannerDonor> & Pick<PlannerDonor, 'key' | 'name' | 'effect'>): PlannerDonor {
  return {
    slots: ['HEAD'] as EquipSlot[],
    classes: ['PAL'] as ClassAbbr[],
    socket: 'focus' as SocketType,
    tierRequired: 1,
    hasteLocked: false,
    quest: false,
    playerCrafted: false,
    ...over
  }
}

const HEALING = donor({
  key: 'robe of the lost circle',
  name: 'Robe of the Lost Circle',
  effect: 'Improved Healing III',
  slots: ['HEAD', 'CHEST'],
  classes: ['PAL', 'CLR']
})

/** Same slot and class, but it is a PROC — the socket is the row's identity, not a filter. */
const PROC = donor({
  key: 'blade of the black dragon eye',
  name: 'Blade of the Black Dragon Eye',
  effect: 'Lifetap Strike',
  socket: 'proc',
  tierRequired: 4,
  slots: ['HEAD'],
  classes: ['PAL']
})

/** R3: haste never travels, and it must be refused for the haste reason before anything else. */
const HASTE = donor({
  key: 'flowing black robe',
  name: 'Flowing Black Robe',
  effect: 'Alacrity',
  hasteLocked: true,
  slots: ['HEAD'],
  classes: ['PAL']
})

/** Shares the class but not the slot. */
const FOOTWEAR = donor({
  key: 'boots of the storm',
  name: 'Boots of the Storm',
  effect: 'Improved Healing I',
  slots: ['FEET'],
  classes: ['PAL']
})

/** Shares the slot but not the class. */
const WIZARDLY = donor({
  key: 'circlet of the arcane',
  name: 'Circlet of the Arcane',
  effect: 'Improved Damage II',
  slots: ['HEAD'],
  classes: ['WIZ']
})

/** States NO class list at all — UNKNOWN, and law 1 says that is not a refusal. */
const UNSTATED = donor({
  key: 'plain circlet',
  name: 'Plain Circlet',
  effect: 'Improved Healing II',
  slots: ['HEAD'],
  classes: []
})

const PALADIN: ClassAbbr[] = ['PAL']

const HEAD_FOCUS = {
  cell: 'HEAD',
  socket: 'focus',
  itemClasses: PALADIN,
  itemSlots: ['HEAD']
} as const

// =================================================================================
// LEGALITY — R2 and R3, asked rather than restated
// =================================================================================

test('a donor of the WRONG SOCKET is never offered — the socket is the row`s identity', () => {
  assert.equal(donorFitsCell(PROC, HEAD_FOCUS), false)
  assert.equal(donorFitsCell(PROC, { ...HEAD_FOCUS, socket: 'proc' }), true)
})

test('R3: a haste-locked donor is refused, and haste is checked before slot or class', () => {
  assert.equal(donorFitsCell(HASTE, HEAD_FOCUS), false)
  // …and it stays refused even where slot and class both agree, which is the whole point of R3:
  // the refusal is a property of the EFFECT, not of the pairing.
  assert.equal(donorFitsCell(HASTE, { ...HEAD_FOCUS, itemClasses: ['PAL', 'CLR'] }), false)
})

test('R2 slot: a donor that shares no equip slot with the cell is refused', () => {
  assert.equal(donorFitsCell(FOOTWEAR, HEAD_FOCUS), false)
  assert.equal(donorFitsCell(HEALING, HEAD_FOCUS), true)
})

test('an ANY-cell constrains nothing OF ITS OWN - but the item in it still does (JOS-104)', () => {
  // THIS TEST USED TO ASSERT THE BUG. It spread a HEAD item's context, changed only the cell, and
  // expected a BOOT donor to pass — which it did, because `hostSlotsOf('ANY1')` is all eighteen
  // slots. That is the right answer about the CELL and the wrong question: an any-cell holding a
  // helm is holding a helm. What JOS-104 actually established is that the CELL adds no constraint,
  // and that survives — it is now visible only where the item adds none either.
  assert.equal(donorFitsCell(FOOTWEAR, { ...HEAD_FOCUS, cell: 'ANY1' }), false, 'the item is a helm')
  assert.equal(donorFitsCell(FOOTWEAR, { ...HEAD_FOCUS, cell: 'ANY2' }), false)
  // …and with nothing known about the item, the any-cell constrains nothing, exactly as before.
  const unknown = { ...HEAD_FOCUS, cell: 'ANY1', itemSlots: [] } as const
  assert.equal(donorFitsCell(FOOTWEAR, unknown), true)
})

test('R2 class is asked against the PLANNED ITEM, not against a class trio', () => {
  assert.equal(donorFitsCell(WIZARDLY, HEAD_FOCUS), false)
  // The same donor, in a cell holding a WIZ item, is legal — which a set-level trio could not have
  // expressed without the user also re-picking the trio.
  assert.equal(donorFitsCell(WIZARDLY, { ...HEAD_FOCUS, itemClasses: ['WIZ'] }), true)
})

test('UNKNOWN is not a fail, on either side (law 1)', () => {
  // The DONOR states no class list.
  assert.equal(donorFitsCell(UNSTATED, HEAD_FOCUS), false, 'a donor with no class list cannot be PROVEN to fit')
  // The ITEM states no class list — `socketCompatibility`'s documented exception: no filter asked.
  assert.equal(donorFitsCell(HEALING, { ...HEAD_FOCUS, itemClasses: [] }), true)
  assert.equal(donorFitsCell(WIZARDLY, { ...HEAD_FOCUS, itemClasses: [] }), true)
})

// =================================================================================
// THE PICKER'S ORDER
// =================================================================================

const CORPUS = [HEALING, PROC, HASTE, FOOTWEAR, WIZARDLY, UNSTATED]

test('an EMPTY query LISTS the legal set rather than returning nothing', () => {
  const rows = donorPickerRows(CORPUS, HEAD_FOCUS, '', 50)
  assert.deepEqual(rows.map((r) => r.donor.key), [HEALING.key])
})

test('the three readings rank name-prefix, then name-contains, then donor-name-only', () => {
  const many = [
    donor({ key: 'a', name: 'Alpha', effect: 'Improved Healing III', slots: ['HEAD'], classes: ['PAL'] }),
    donor({ key: 'b', name: 'Bravo', effect: 'Greatly Improved Healing', slots: ['HEAD'], classes: ['PAL'] }),
    donor({ key: 'c', name: 'Improved Charlie', effect: 'Shielding', slots: ['HEAD'], classes: ['PAL'] })
  ]
  const rows = donorPickerRows(many, HEAD_FOCUS, 'improved', 50)
  assert.deepEqual(rows.map((r) => r.donor.key), ['a', 'b', 'c'])
  assert.deepEqual(rows.map((r) => r.score), [0, 1, 2])
})

test('a query matching nothing returns nothing, and the limit is honoured', () => {
  assert.deepEqual(donorPickerRows(CORPUS, HEAD_FOCUS, 'zzzz', 50), [])
  // An any-cell whose item the corpus cannot place: the one context that still offers everything,
  // which is what makes it the right one for measuring the LIMIT rather than the filter.
  const open = { ...HEAD_FOCUS, cell: 'ANY1', itemSlots: [], itemClasses: [] } as const
  assert.equal(donorPickerRows(CORPUS, open, '', 2).length, 2)
})

test('ties break by effect-name LENGTH then locale, so the order is stable across renders', () => {
  const ties = [
    donor({ key: 'long', name: 'L', effect: 'Improved Healing III', slots: ['HEAD'], classes: ['PAL'] }),
    donor({ key: 'short', name: 'S', effect: 'Improved Aid', slots: ['HEAD'], classes: ['PAL'] })
  ]
  assert.deepEqual(
    donorPickerRows(ties, HEAD_FOCUS, 'improved', 50).map((r) => r.donor.key),
    ['short', 'long']
  )
})

test('the picker`s page numbers ARE main`s - stated twice, pinned once', () => {
  // The renderer cannot import main, so the two page sizes are written out in both places. That is
  // a drift waiting to happen in exactly one direction: the picker asks for more than main will
  // ever serve, its "show more" stops adding rows, and nothing anywhere goes red. This is the pin.
  assert.equal(PLANNER_PAGE, PLANNER_SEARCH_LIMIT, 'the page size drifted from main`s')
  assert.equal(PLANNER_PAGE_MAX, PLANNER_SEARCH_MAX, 'the ceiling drifted from main`s')
  assert.ok(PLANNER_PAGE_MAX > PLANNER_PAGE, 'a ceiling at the page size makes "show more" a lie')
})

// ---- R2's SLOT axis asks the ITEM, not the cell -----------------------------------------------
//
// THE ANY-CELL BUG, REPORTED FROM A REAL BOARD. `hostSlotsOf` answers about the CELL, and an
// any-cell constrains nothing — so it returns all eighteen slots and every donor in the corpus
// passed the slot axis. Every other cell filtered correctly, which is exactly why it survived: the
// two agree everywhere except the one place the cell has no slot of its own.

const HEAD_DONOR = donor({ key: 'helm', name: 'A Helm', effect: 'Focus A', slots: ['HEAD'] })
const FINGER_DONOR = donor({ key: 'band', name: 'A Band', effect: 'Focus B', slots: ['FINGER'] })

test('an ANY cell holding a RING is still holding a ring - the item decides, not the hole', () => {
  const ring = { cell: 'ANY1', socket: 'focus', itemClasses: [], itemSlots: ['FINGER'] } as const
  assert.equal(donorFitsCell(FINGER_DONOR, ring), true, 'a finger donor fits the ring')
  // Before the fix this was TRUE: the cell said "all eighteen slots", so a helm-only donor passed.
  assert.equal(donorFitsCell(HEAD_DONOR, ring), false, 'a helm-only donor must not fit a ring')
})

test('an ordinary cell is unchanged - the item and the cell agree there, which hid the bug', () => {
  const helm = { cell: 'HEAD', socket: 'focus', itemClasses: [], itemSlots: ['HEAD'] } as const
  assert.equal(donorFitsCell(HEAD_DONOR, helm), true)
  assert.equal(donorFitsCell(FINGER_DONOR, helm), false)
})

test('an item the corpus does not carry falls back to the CELL, never to a refusal (law 1)', () => {
  // No slot list stated: an any-cell then constrains nothing (its old behaviour, now scoped to the
  // one case that earns it), and an ordinary cell still constrains to its own slot.
  const unknownInAny = { cell: 'ANY1', socket: 'focus', itemClasses: [], itemSlots: [] } as const
  assert.equal(donorFitsCell(HEAD_DONOR, unknownInAny), true)
  assert.equal(donorFitsCell(FINGER_DONOR, unknownInAny), true)

  const unknownInHead = { cell: 'HEAD', socket: 'focus', itemClasses: [], itemSlots: [] } as const
  assert.equal(donorFitsCell(HEAD_DONOR, unknownInHead), true)
  assert.equal(donorFitsCell(FINGER_DONOR, unknownInHead), false)
})
