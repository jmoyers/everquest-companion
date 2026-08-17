// THE GEAR PLAN BOARD'S DOCUMENT — the cell model, the per-item plus-state, the sockets, and what
// the tier says about them.
//
// Pure model only: `shared/planner/gearPlan.ts` touches no React, no storage and no IPC, so it runs
// under the node runner exactly like `gearFilter` and `inventorySlots` before it. The arithmetic
// and the diff are next door in `tests/gearPlanTotals.test.mts` — a separate file because this repo
// splits at the measured 400-code-line ceiling rather than after it (`gearEffectiveHp.test.mts`'s
// precedent), and because the two halves fail for different reasons.
//
// WHAT THIS FILE IS FOR, in five sentences:
//
//  1. THE BOARD IS A CELL MAP AND ASSIGNING DISPLACES. `PLAN_SLOTS` is the model — two ears, two
//     wrists, two rings, two any-slots — so a third ring has to take somebody's place, and the
//     displaced item has to be REPORTED rather than dropped on the floor. Revived from the deleted
//     `tests/gearSet.test.mts`, whose claims about this model were never wrong.
//  2. A DIFFERENT ITEM CLEARS THE SOCKETS AND THE SAME ITEM KEEPS THEM. This is the one rule this
//     document redesigned rather than revived (`usePlans.withHost` did the opposite), so this file
//     is its whole justification.
//  3. A SLIDER DRAG NEVER DESTROYS A PICK. Lowering a cell's tier below a planned socket's unlock
//     tier leaves the socket alone; the surface says `+3 to unlock` instead.
//  4. THE UNLOCK LADDER HAS ONE HOME. `unlockedSockets` is asserted against `unlockedExaltationSlots`
//     at EVERY tier, so the derived fold and `EXALTATION_SLOT_TYPES` cannot drift apart.
//  5. AN ABSENT ` +N` IS NOT TIER 0. `wornState` reads a dump's silence as base and the totals
//     count those separately, rather than inventing a tier the client never printed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ITEM_MAX_TIER,
  unlockedExaltationSlots,
  type ExaltationSlotType
} from '../src/shared/itemStats'
import { ITEM_UPGRADE_BASE, type ItemUpgradeState } from '../src/shared/itemUpgrade'
import {
  EMPTY_GEAR_PLAN,
  assignToCell,
  assignedCount,
  cellAt,
  cellForItem,
  cellsForItem,
  clearCell,
  filledCells,
  gearPlanCells,
  plannedSockets,
  unlockedSockets,
  withCellState,
  withSocket,
  wornState,
  type GearPlan,
  type GearPlanSocket
} from '../src/shared/planner/gearPlan'
import { PLAN_SLOTS, SOCKET_TYPES, type EquipSlot } from '../src/shared/planner/types'

// =================================================================================
// FIXTURES
// =================================================================================

const RING = { key: 'ring of pureblood', name: 'Ring of Pureblood', slots: ['FINGER'] as EquipSlot[] }
const RING2 = { key: 'ring of the shissar', name: 'Ring of the Shissar', slots: ['FINGER'] as EquipSlot[] }
const RING3 = { key: 'band of steel', name: 'Band of Steel', slots: ['FINGER'] as EquipSlot[] }
const HELM = { key: 'crown of narandi', name: 'Crown of Narandi', slots: ['HEAD'] as EquipSlot[] }
const HELM2 = { key: 'skullcap of the wraith', name: 'Skullcap of the Wraith', slots: ['HEAD'] as EquipSlot[] }

const HEALING: GearPlanSocket = {
  effect: 'Improved Healing III',
  donorKey: 'robe of the lost circle',
  donorName: 'Robe of the Lost Circle'
}
const LIFETAP: GearPlanSocket = {
  effect: 'Lifetap Strike',
  donorKey: 'blade of the black dragon eye',
  donorName: 'Blade of the Black Dragon Eye'
}

/** Put an item in its natural cell, the way the picker does when the user names no cell. */
function add(
  gearPlan: GearPlan,
  item: { key: string; name: string; slots: EquipSlot[] },
  state?: ItemUpgradeState
): GearPlan {
  return assignToCell(gearPlan, cellForItem(gearPlan, item.slots), cellAt(item, state)).gearPlan
}

// =================================================================================
// THE CELL MODEL
// =================================================================================

test('the cell model IS `PLAN_SLOTS` — no second opinion about how many ears you have', () => {
  assert.deepEqual(
    gearPlanCells(EMPTY_GEAR_PLAN).map((c) => c.cell),
    [...PLAN_SLOTS]
  )
  assert.equal(gearPlanCells(EMPTY_GEAR_PLAN).length, 23)
  assert.equal(assignedCount(EMPTY_GEAR_PLAN), 0)
})

test('an item is offered its own slot`s cells first and the two any-slots last (JOS-104)', () => {
  assert.deepEqual(cellsForItem(['FINGER']), ['FINGER', 'FINGER2', 'ANY1', 'ANY2'])
  assert.deepEqual(cellsForItem(['PRIMARY']), ['PRIMARY', 'ANY1', 'ANY2'])
  // A two-slot item offers both, in board order, deduped.
  assert.deepEqual(cellsForItem(['SECONDARY', 'PRIMARY']), ['SECONDARY', 'PRIMARY', 'ANY1', 'ANY2'])
  // An item the corpus places nowhere still has the two places that constrain nothing.
  assert.deepEqual(cellsForItem([]), ['ANY1', 'ANY2'])
})

test('rings fill FINGER, FINGER2, then the two any-slots — and the fifth displaces the first', () => {
  const one = add(EMPTY_GEAR_PLAN, RING)
  assert.equal(one.cells.FINGER?.key, RING.key)
  const two = add(one, RING2)
  assert.equal(two.cells.FINGER?.key, RING.key, 'the first ring stays put')
  assert.equal(two.cells.FINGER2?.key, RING2.key)

  // Both fingers are taken and the game gives two places that constrain nothing (JOS-104), so the
  // third and fourth land THERE rather than displacing anybody. That is the game's own answer.
  const four = add(add(two, RING3), RING3)
  assert.deepEqual(
    filledCells(four).map((c) => c.cell),
    ['FINGER', 'FINGER2', 'ANY1', 'ANY2']
  )

  // Now there is genuinely nowhere free, so the FIRST candidate takes the hit. Refusing would
  // leave the user's click doing nothing at all, which is the one answer nobody can debug.
  const cell = cellForItem(four, RING3.slots)
  assert.equal(cell, 'FINGER')
  const { gearPlan: five, displaced } = assignToCell(four, cell, cellAt(RING3))
  assert.equal(five.cells.FINGER?.key, RING3.key)
  assert.equal(displaced?.key, RING.key, 'the displaced item must be reported, never dropped silently')
  assert.equal(assignedCount(five), 4, 'displacing does not grow the board')
})

test('clearing a cell removes the KEY, not just the value — and leaves the rest alone', () => {
  const board = add(add(EMPTY_GEAR_PLAN, RING), RING2)
  const cleared = clearCell(board, 'FINGER')
  assert.equal('FINGER' in cleared.cells, false)
  assert.equal(cleared.cells.FINGER2?.key, RING2.key)
  assert.deepEqual(
    filledCells(cleared).map((c) => c.cell),
    ['FINGER2']
  )
  assert.equal(board.cells.FINGER?.key, RING.key, 'the input board is never mutated')
})

test('a plus-state is stored NORMALIZED, and a cell with nothing in it has no state to move', () => {
  const board = add(EMPTY_GEAR_PLAN, RING, { full: 3, fraction: 99 })
  // 2^3 - 1 = 7 is the ceiling the game's own item window states (normalizeUpgradeState).
  assert.deepEqual(board.cells.FINGER?.state, { full: 3, fraction: 7 })
  // Tier 0 banks nothing at all.
  assert.deepEqual(withCellState(board, 'FINGER', { full: 0, fraction: 5 }).cells.FINGER?.state, {
    full: 0,
    fraction: 0
  })
  assert.equal(withCellState(board, 'HEAD', { full: 4, fraction: 0 }), board, 'no item, no state')
})

// =================================================================================
// THE SOCKETS — the one rule this document redesigned
// =================================================================================

test('re-assigning the SAME item keeps its sockets; a DIFFERENT item clears them', () => {
  const planned = withSocket(add(EMPTY_GEAR_PLAN, HELM, { full: 4, fraction: 0 }), 'HEAD', 'focus', HEALING)
  assert.equal(planned.cells.HEAD?.sockets.focus?.effect, HEALING.effect)

  // The same key at a new plus-state is a re-statement of the cell, not a new plan for it.
  const same = assignToCell(planned, 'HEAD', cellAt(HELM, { full: 6, fraction: 0 })).gearPlan
  assert.equal(same.cells.HEAD?.sockets.focus?.effect, HEALING.effect, 'the same item keeps its plan')
  assert.equal(same.cells.HEAD?.state.full, 6)

  // A different helm cannot inherit them: R2 is asked against the ITEM's own class list, so a
  // carried-over pick would be a plan `socketCompatibility` refuses on the very next render.
  const swapped = assignToCell(planned, 'HEAD', cellAt(HELM2)).gearPlan
  assert.deepEqual(swapped.cells.HEAD?.sockets, {})
  assert.equal(swapped.cells.HEAD?.key, HELM2.key)
})

test('a socket is written and cleared on its own, and its siblings never move', () => {
  const one = withSocket(add(EMPTY_GEAR_PLAN, HELM), 'HEAD', 'focus', HEALING)
  const two = withSocket(one, 'HEAD', 'proc', LIFETAP)
  assert.deepEqual(Object.keys(two.cells.HEAD?.sockets ?? {}).sort(), ['focus', 'proc'])

  const cleared = withSocket(two, 'HEAD', 'focus', null)
  assert.equal('focus' in (cleared.cells.HEAD?.sockets ?? {}), false, 'the KEY goes, not just the value')
  assert.equal(cleared.cells.HEAD?.sockets.proc?.effect, LIFETAP.effect)

  // There is no host-less cell on this board to hang a socket on — the item IS the cell.
  assert.equal(withSocket(EMPTY_GEAR_PLAN, 'HEAD', 'focus', HEALING), EMPTY_GEAR_PLAN)
})

test('lowering a cell`s tier NEVER prunes a planned socket — a drag passes through every value', () => {
  const board = withSocket(add(EMPTY_GEAR_PLAN, HELM, { full: 4, fraction: 0 }), 'HEAD', 'proc', LIFETAP)
  const lowered = withCellState(board, 'HEAD', { full: 1, fraction: 0 })
  assert.equal(lowered.cells.HEAD?.sockets.proc?.effect, LIFETAP.effect, 'the plan may be ahead of the merge')
  // …and the surface can still tell it is out of reach, from the tier alone.
  assert.equal(unlockedSockets(lowered.cells.HEAD?.state ?? ITEM_UPGRADE_BASE).includes('proc'), false)
})

test('the planned exaltations read out flat, in board order, one entry per socket', () => {
  const board = withSocket(
    withSocket(add(add(EMPTY_GEAR_PLAN, HELM), RING), 'HEAD', 'focus', HEALING),
    'FINGER',
    'proc',
    LIFETAP
  )
  assert.deepEqual(
    plannedSockets(board).map((p) => [p.cell, p.socket, p.planned.effect]),
    [
      ['HEAD', 'focus', HEALING.effect],
      ['FINGER', 'proc', LIFETAP.effect]
    ]
  )
  assert.deepEqual(plannedSockets(add(EMPTY_GEAR_PLAN, HELM)), [], 'an item with nothing in it lists nothing')
})

// =================================================================================
// WHAT THE TIER SAYS
// =================================================================================

test('`unlockedSockets` IS `unlockedExaltationSlots`, at every tier — one ladder, two readers', () => {
  const transferable = (rows: ExaltationSlotType[]): string[] =>
    rows.map((r) => r.type.toLowerCase()).filter((t) => (SOCKET_TYPES as readonly string[]).includes(t))

  for (let tier = 0; tier <= ITEM_MAX_TIER; tier += 1) {
    assert.deepEqual(
      unlockedSockets({ full: tier, fraction: 0 }),
      transferable(unlockedExaltationSlots(tier)),
      `tier ${String(tier)} must agree with EXALTATION_SLOT_TYPES`
    )
  }
  // The ladder itself, spelled out once so a silent re-ordering is visible here too.
  assert.deepEqual(unlockedSockets({ full: 0, fraction: 0 }), [])
  assert.deepEqual(unlockedSockets({ full: 2, fraction: 0 }), ['focus', 'click'])
  assert.deepEqual(unlockedSockets({ full: 4, fraction: 0 }), ['focus', 'click', 'worn', 'proc'])
})

test('banked exp is not a merge — only the whole tier unlocks a socket', () => {
  assert.deepEqual(unlockedSockets({ full: 0, fraction: 0 }), [])
  assert.deepEqual(unlockedSockets({ full: 1, fraction: 0 }), ['focus'])
})

test('a dump that stated no ` +N` reads at BASE, and that is not a claim of tier 0', () => {
  assert.deepEqual(wornState(undefined), ITEM_UPGRADE_BASE)
  // A stated tier is a FLOOR: the client prints the tier and never the exp banked toward the next.
  assert.deepEqual(wornState(5), { full: 5, fraction: 0 })
  assert.deepEqual(wornState(0), { full: 0, fraction: 0 })
})
