// THE BOARD AS THINGS TO GO AND GET, and the seed-from-equipped that starts one.
//
// Two folds, both pure, both node-driven: `features/gearplan/gearPlanWishes.ts` (a board → wish
// rows) and `shared/planner/gearPlan.ts fromEquipped` (the dump → a board).
//
// WHAT THIS FILE IS FOR:
//
//  1. A CELL PRODUCES THE WISH LIST'S OWN TWO KINDS. The item is a `gear` wish; each planned donor
//     is a `donor` wish CARRYING its effect and socket, because that context is what lets the wish
//     list state a merge cost later. Both come from the wish list's own builders, so a row written
//     from the board is byte-identical to one written by its add control.
//  2. WHAT YOU ALREADY HAVE IS NOT A WISH. `newWishes` drops rows the wish list's own predicate
//     calls finished, drops rows already on the list, and dedupes the batch — so the number the
//     control reports afterwards is the number it actually wrote.
//  3. `fill` NEVER TOUCHES PLANNED WORK, which is what lets its control skip a confirmation.
//     `replace` overwrites, and `overwriteCount` is the number its control must state first.
//  4. A LOAD SEEDS THE SOCKETS THE DUMP CAN ACTUALLY BE READ TO MEAN, AND NO OTHERS.
//     `fromEquipped` copies whatever `equippedRead` resolved and resolves nothing itself. The dump
//     names a DONOR ITEM and never an effect, so a socket is seeded only where the effect database
//     makes that pair determined; where it does not, the socket stays EMPTY and is counted. Reading
//     that silence as "none" would be inventing a fact (law 1).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ITEM_UPGRADE_BASE } from '../src/shared/itemUpgrade'
import {
  EMPTY_GEAR_PLAN,
  assignToCell,
  cellAt,
  filledCells,
  fromEquipped,
  overwriteCount,
  withSocket,
  type GearPlan
} from '../src/shared/planner/gearPlan'
import { equippedRead } from '../src/shared/planner/gearPlanTotals'
import { cellWishes, newWishes, planWishes } from '../src/renderer/src/features/gearplan/gearPlanWishes'

const NOW = 1_754_200_000_000

const HELM = { key: 'crown of narandi', name: 'Crown of Narandi' }
const RING = { key: 'ring of pureblood', name: 'Ring of Pureblood' }
const DONOR = {
  effect: 'Improved Healing III',
  donorKey: 'robe of the lost circle',
  donorName: 'Robe of the Lost Circle'
}
const PROC = {
  effect: 'Lifetap Strike',
  donorKey: 'blade of the black dragon eye',
  donorName: 'Blade of the Black Dragon Eye'
}

/** A board with a socketed helm and a bare ring. */
function board(): GearPlan {
  const withHelm = assignToCell(EMPTY_GEAR_PLAN, 'HEAD', cellAt(HELM, { full: 4, fraction: 0 })).gearPlan
  const socketed = withSocket(withSocket(withHelm, 'HEAD', 'focus', DONOR), 'HEAD', 'proc', PROC)
  return assignToCell(socketed, 'FINGER', cellAt(RING)).gearPlan
}

// =================================================================================
// THE BOARD AS WISHES
// =================================================================================

test('a cell yields the ITEM first, then each planned donor in socket order', () => {
  const cell = filledCells(board()).find((c) => c.cell === 'HEAD')
  assert.ok(cell)
  const rows = cellWishes(cell.planned, NOW)
  assert.deepEqual(rows.map((r) => [r.kind, r.itemKey]), [
    ['gear', HELM.key],
    ['donor', DONOR.donorKey],
    ['donor', PROC.donorKey]
  ])
})

test('a donor wish CARRIES its effect and socket; a gear wish states neither', () => {
  const cell = filledCells(board()).find((c) => c.cell === 'HEAD')
  assert.ok(cell)
  const [item, focus, proc] = cellWishes(cell.planned, NOW)

  assert.equal(item.kind, 'gear')
  assert.equal(item.effect, undefined, 'an item you want is not a request for an effect')
  assert.equal(item.socket, undefined)

  assert.equal(focus.effect, DONOR.effect)
  assert.equal(focus.socket, 'focus')
  assert.equal(proc.socket, 'proc')
  // Written as the USER's own wish, never labelled an import — nothing imported it.
  assert.equal(focus.source, 'user')
  assert.equal(focus.addedAt, NOW)
})

test('a cell with nothing socketed yields exactly one row', () => {
  const cell = filledCells(board()).find((c) => c.cell === 'FINGER')
  assert.ok(cell)
  assert.deepEqual(cellWishes(cell.planned, NOW).map((r) => r.itemKey), [RING.key])
})

test('the whole board reads out in BOARD order, and an empty board wants nothing', () => {
  assert.deepEqual(planWishes(board(), NOW).map((r) => r.itemKey), [
    HELM.key,
    DONOR.donorKey,
    PROC.donorKey,
    RING.key
  ])
  assert.deepEqual(planWishes(EMPTY_GEAR_PLAN, NOW), [])
})

test('duplicates are RETURNED, not deduped here — `addWish` owns identity by itemKey', () => {
  // The same donor planned into two cells is offered twice; the model collapses it to one row.
  const two = withSocket(
    assignToCell(board(), 'CHEST', cellAt({ key: 'x', name: 'X' }, { full: 4, fraction: 0 })).gearPlan,
    'CHEST',
    'focus',
    DONOR
  )
  const keys = planWishes(two, NOW).map((r) => r.itemKey)
  assert.equal(keys.filter((k) => k === DONOR.donorKey).length, 2)
})

// =================================================================================
// SEEDING FROM WHAT YOU ARE WEARING
// =================================================================================

const WORN = equippedRead([
  { slot: 'HEAD', name: 'Worn Helm', key: 'worn helm', tier: 5 },
  { slot: 'FEET', name: 'Worn Boots', key: 'worn boots' }
]).gearPlan

test('`fill` writes only into EMPTY cells — nothing you planned is touched', () => {
  const next = fromEquipped(board(), WORN, 'fill', NOW)
  assert.equal(next.cells.HEAD?.key, HELM.key, 'the planned helm survives')
  assert.equal(next.cells.HEAD?.state.full, 4, '…at the tier YOU planned, not the one you wear')
  assert.equal(next.cells.HEAD?.sockets.focus?.effect, DONOR.effect, '…with its exaltations')
  assert.equal(next.cells.FEET?.key, 'worn boots', 'and the empty cell is filled')
})

test('`replace` overwrites every worn cell, and `overwriteCount` is what it would discard', () => {
  assert.equal(overwriteCount(board(), WORN), 1, 'only HEAD is planned AND worn')
  const next = fromEquipped(board(), WORN, 'replace', NOW)
  assert.equal(next.cells.HEAD?.key, 'worn helm')
  assert.equal(next.cells.HEAD?.state.full, 5, 'the tier the dump stated')
  assert.deepEqual(next.cells.HEAD?.sockets, {}, 'and the planned exaltations go with the item')
  // A cell the dump says nothing about is NOT cleared: replace loads what is worn, it does not
  // strip what is not.
  assert.equal(next.cells.FINGER?.key, RING.key)
})

test('a dump that names no exaltations seeds no sockets — silence is not a socket', () => {
  for (const mode of ['fill', 'replace'] as const) {
    const next = fromEquipped(EMPTY_GEAR_PLAN, WORN, mode, NOW)
    for (const { planned } of filledCells(next)) assert.deepEqual(planned.sockets, {})
  }
})

// ---- the sockets a load DOES carry, and the ones it refuses to invent -------------------------
//
// `equippedRead` does all the resolving; these tests hold `fromEquipped` to carrying its answer
// through unchanged, in both modes, and to counting rather than guessing at the rest.

/** The effect database, as much of it as these four donors need. */
const OFFERS = (key: string): readonly { effect: string; socket: 'focus' | 'click' | 'worn' | 'proc' }[] =>
  ({
    // one effect, one socket — determined, and therefore seeded
    'robe of the lost circle': [{ effect: 'Improved Healing III', socket: 'focus' as const }],
    // two effects in ONE socket — the measured 0.2%; which one was extracted is not in the file
    'twin idol': [
      { effect: 'Aegis of Ro', socket: 'click' as const },
      { effect: 'Shield of Words', socket: 'click' as const }
    ],
    // one effect each in TWO sockets — determined per socket, but not between them
    'split talisman': [
      { effect: 'Bite of the Shissar', socket: 'proc' as const },
      { effect: 'Haste of the Wind', socket: 'worn' as const }
    ]
  })[key] ?? []

const SOCKETED = equippedRead(
  [
    {
      slot: 'HEAD',
      name: 'Worn Helm',
      key: 'worn helm',
      tier: 5,
      exaltationKeys: ['robe of the lost circle', 'twin idol'],
      exaltations: ['Robe of the Lost Circle', 'Twin Idol']
    },
    {
      slot: 'FEET',
      name: 'Worn Boots',
      key: 'worn boots',
      tier: 4,
      exaltationKeys: ['split talisman', 'a donor no corpus carries'],
      exaltations: ['Split Talisman', 'A Donor No Corpus Carries']
    }
  ],
  NOW,
  OFFERS
)

test('the read seeds the determined socket and counts the rest — it never picks one', () => {
  assert.equal(SOCKETED.unresolved, 3, 'ambiguous socket, ambiguous donor, and a corpus miss')
  const head = SOCKETED.gearPlan.cells.HEAD
  assert.equal(head?.sockets.focus?.effect, 'Improved Healing III')
  assert.equal(head?.sockets.focus?.donorName, 'Robe of the Lost Circle', 'the row reads as itself')
  assert.equal(head?.sockets.click, undefined, 'two effects share that socket, so it stays empty')
  assert.deepEqual(SOCKETED.gearPlan.cells.FEET?.sockets, {}, 'neither donor settles a socket')
})

test('a load carries the resolved sockets through, in either mode', () => {
  for (const mode of ['fill', 'replace'] as const) {
    const next = fromEquipped(EMPTY_GEAR_PLAN, SOCKETED.gearPlan, mode, NOW)
    assert.equal(next.cells.HEAD?.sockets.focus?.effect, 'Improved Healing III', mode)
    assert.equal(next.cells.HEAD?.sockets.focus?.donorKey, 'robe of the lost circle', mode)
    assert.equal(next.cells.HEAD?.sockets.click, undefined, mode)
  }
})

test('the loaded cell owns its sockets — editing one cannot reach back into the read', () => {
  const next = fromEquipped(EMPTY_GEAR_PLAN, SOCKETED.gearPlan, 'replace', NOW)
  const edited = withSocket(next, 'HEAD', 'proc', PROC)
  assert.equal(edited.cells.HEAD?.sockets.proc?.effect, PROC.effect)
  assert.equal(SOCKETED.gearPlan.cells.HEAD?.sockets.proc, undefined, 'the read is untouched')
})

// THE REGRESSION TEST FOR THE BUG THIS WHOLE PATH SHIPPED WITH.
//
// The donor corpus arrives over IPC after first paint. A load run in that gap resolved NOTHING and
// reported `unresolved: 0` — a clean read of a body with five exaltations on it — and because the
// cells were then filled, `fill` never revisited them. Silent, permanent, and indistinguishable
// from a character who simply has no exaltations. Reported from a real board.
//
// TWO THINGS HOLD IT SHUT and this test is the second: the toolbar hides the load until the corpus
// is in hand, and a resolver-less read now COUNTS every donor it could not attempt. The count is
// what makes the state observable at all; without it the surface has nothing to notice.
test('a read with NO resolver counts every donor - a blind read must never look clean', () => {
  const blind = equippedRead(
    [
      {
        slot: 'HEAD',
        name: 'Worn Helm',
        key: 'worn helm',
        tier: 5,
        exaltationKeys: ['robe of the lost circle'],
        exaltations: ['Robe of the Lost Circle']
      }
    ],
    NOW
  )
  assert.deepEqual(blind.gearPlan.cells.HEAD?.sockets, {}, 'nothing is invented without a corpus')
  assert.equal(blind.unresolved, 1, 'and the donor it could not even attempt is still counted')

  // The SAME hosts with the corpus in hand: the socket fills and the count goes to zero. The pair
  // is the point — the two states produce identical `sockets`, so only the count tells them apart.
  const seeing = equippedRead(
    [
      {
        slot: 'HEAD',
        name: 'Worn Helm',
        key: 'worn helm',
        tier: 5,
        exaltationKeys: ['robe of the lost circle'],
        exaltations: ['Robe of the Lost Circle']
      }
    ],
    NOW,
    OFFERS
  )
  assert.equal(seeing.gearPlan.cells.HEAD?.sockets.focus?.effect, 'Improved Healing III')
  assert.equal(seeing.unresolved, 0)
})

test('a host with NO exaltations counts nothing either way - silence is not a failure', () => {
  // The other half of the rule: `unresolved` must not become "how many hosts we looked at". A body
  // wearing nothing socketed reads zero with or without a corpus, so the count stays a statement
  // about the DUMP's own claims rather than about the app's confidence.
  const bare = [{ slot: 'HEAD' as const, name: 'Worn Helm', key: 'worn helm', tier: 5 }]
  assert.equal(equippedRead(bare, NOW).unresolved, 0)
  assert.equal(equippedRead(bare, NOW, OFFERS).unresolved, 0)
})

test('a worn item stating no ` +N` seeds at BASE, not at tier 0 by accident', () => {
  const next = fromEquipped(EMPTY_GEAR_PLAN, WORN, 'fill', NOW)
  assert.deepEqual(next.cells.FEET?.state, ITEM_UPGRADE_BASE)
})

test('a load that would change nothing returns the SAME object — no write, no re-render', () => {
  // Every worn cell is already filled, so `fill` has nowhere to write.
  const full = fromEquipped(EMPTY_GEAR_PLAN, WORN, 'fill', NOW)
  assert.equal(fromEquipped(full, WORN, 'fill', NOW), full)
  // …and there is nothing to load from a body the dump says nothing about, in either mode. The
  // SAME reference back is what `useGearPlan.apply` tests to decide whether to write at all.
  const mine = board()
  assert.equal(fromEquipped(mine, EMPTY_GEAR_PLAN, 'replace', NOW), mine)
  assert.equal(fromEquipped(mine, EMPTY_GEAR_PLAN, 'fill', NOW), mine)
})

// =================================================================================
// WHAT IS ACTUALLY WORTH WRITING
// =================================================================================

/** Nothing wished, nothing owned — the state a fresh character is in. */
const OPEN = { wished: () => false, fulfilled: () => false }

test('an already-WISHED row is dropped, so the count the control states is truthful', () => {
  const offered = planWishes(board(), NOW)
  const taken = newWishes(offered, { ...OPEN, wished: (key) => key === HELM.key })
  assert.equal(taken.length, offered.length - 1)
  assert.equal(taken.some((r) => r.itemKey === HELM.key), false)
})

test('an already-OWNED row is dropped — the wish list`s own verdict, not a second opinion', () => {
  const taken = newWishes(planWishes(board(), NOW), {
    ...OPEN,
    fulfilled: (entry) => entry.itemKey === DONOR.donorKey
  })
  assert.equal(taken.some((r) => r.itemKey === DONOR.donorKey), false)
  assert.equal(taken.some((r) => r.itemKey === HELM.key), true, 'and it drops only what it names')
})

test('the batch dedupes by itemKey, so one robe in three sockets is ONE row and counts as one', () => {
  const twice = withSocket(
    assignToCell(board(), 'CHEST', cellAt({ key: 'x', name: 'X' }, { full: 4, fraction: 0 })).gearPlan,
    'CHEST',
    'focus',
    DONOR
  )
  const offered = planWishes(twice, NOW)
  assert.equal(offered.filter((r) => r.itemKey === DONOR.donorKey).length, 2, 'offered twice…')
  const taken = newWishes(offered, OPEN)
  assert.equal(taken.filter((r) => r.itemKey === DONOR.donorKey).length, 1, '…written once')
})

test('a board with nothing new to want writes nothing, and says so with a zero', () => {
  assert.deepEqual(newWishes(planWishes(board(), NOW), { ...OPEN, wished: () => true }), [])
  assert.deepEqual(newWishes(planWishes(EMPTY_GEAR_PLAN, NOW), OPEN), [])
})

test('board order survives the filter — the first occurrence of an item is the one kept', () => {
  assert.deepEqual(newWishes(planWishes(board(), NOW), OPEN).map((r) => r.itemKey), [
    HELM.key,
    DONOR.donorKey,
    PROC.donorKey,
    RING.key
  ])
})
