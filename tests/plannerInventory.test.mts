// EXALTATION PLANNER — what you are WEARING, joined into the planner's slots (V7).
//
// The Inventory tab fills each cell's host from the character's own `/outputfile inventory` dump,
// and the join between the two vocabularies is a HAND-AUTHORED TABLE (law 12: cross-source
// renames are knowledge, never fuzzy) — `Fingers` vs `FINGER`, and `Any Slot`, which has no wiki
// counterpart at all and gets a CELL instead of a slot (JOS-104). A fuzzy matcher here would put a
// ring on a finger by luck and a two-hander somewhere
// embarrassing by the same luck, so the table is pinned three ways: it is TOTAL over the client's
// closed token set, it maps onto real planner slots only, and it produces the right answer on the
// real 295-line dump.
//
// Same fixture the outputs engine uses (`tests/fixtures/Primitive_freeport-Inventory.txt`, the dev
// character's real dump, committed verbatim). Pure: no Electron, no fs beyond that read.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EQUIP_LOCATIONS, splitLocationPath, walkEntries } from '../src/shared/outputs/inventory'
import { parseInventoryDump } from '../src/main/outputs/inventoryParse'
import { ANY_CELL_LOCATIONS, SLOT_OF_LOCATION, equippedHosts } from '../src/shared/planner/inventorySlots'
import {
  ANY_CELLS,
  cellsForSlot,
  equipSlotOf,
  EQUIP_SLOTS,
  hostSlotsOf,
  isAnyCell,
  PAIRED_SLOTS,
  PLAN_SLOTS,
  planSlotLabel
} from '../src/shared/planner/types'

const REAL_DUMP = readFileSync(
  join(import.meta.dirname, 'fixtures', 'Primitive_freeport-Inventory.txt'),
  'utf8'
)
const dump = parseInventoryDump(REAL_DUMP)
const hosts = equippedHosts(dump)

test('the join is TOTAL over the client tokens, and lands only on real planner slots', () => {
  const slots = new Set<string>(EQUIP_SLOTS)
  for (const token of EQUIP_LOCATIONS) {
    assert.ok(token in SLOT_OF_LOCATION, `no decision recorded for the client token ${token}`)
    const slot = SLOT_OF_LOCATION[token]
    if (slot !== null) assert.ok(slots.has(slot), `${token} maps to ${slot}, which is not a planner slot`)
  }
  // The two deliberate nulls, stated so a future edit has to argue with them: `Any Slot` is a real
  // place to wear something that the wiki vocabulary does not have, and `Held` does not say which
  // hand. Neither may be guessed into a slot.
  assert.equal(SLOT_OF_LOCATION['Any Slot'], null)
  assert.equal(SLOT_OF_LOCATION.Held, null)
  assert.equal(SLOT_OF_LOCATION.Fingers, 'FINGER', 'the plural is the whole reason this table exists')

  // …and JOS-104 is the difference between "names no slot" and "goes nowhere". `Any Slot` names no
  // slot AND has a cell; `Held` names no slot and has none, because an any-cell would be a claim
  // about where the thing is worn that the token refuses to make.
  assert.ok(ANY_CELL_LOCATIONS.has('Any Slot'))
  assert.ok(!ANY_CELL_LOCATIONS.has('Held'))
  for (const token of ANY_CELL_LOCATIONS) {
    assert.equal(SLOT_OF_LOCATION[token], null, `${token} cannot be both an any-cell and a slot`)
  }
})

test('the real dump yields one host per CELL, top-level and non-empty only', () => {
  console.log('planner equipped hosts', hosts.map((h) => `${h.slot}=${h.name}`).join(', '))
  assert.ok(hosts.length > 0, 'the fixture is a real dump — something must be equipped')

  const seen = new Set<string>()
  for (const h of hosts) {
    assert.ok(!seen.has(h.slot), `${h.slot} appears twice — one host per cell`)
    seen.add(h.slot)
    assert.ok(h.name.length > 0)
    assert.ok(!h.name.endsWith('(Exaltation)'), 'a socketed exaltation is not the item being worn')
    assert.ok(!/ \+\d+$/.test(h.name), 'the merge tier is split off into `tier`, never left in the name')
  }
})

test('a host carries the DONOR NAMES the dump printed in its sockets, and nothing more', () => {
  // WHAT THE FILE ACTUALLY SAYS. A socketed exaltation is a `-Slot<n>` CHILD whose name is the
  // DONOR ITEM the effect was extracted from, marked `(Exaltation)` — never the effect. So this is
  // all a host may carry, and turning a donor into an effect is the corpus's job downstream
  // (`gearPlanTotals.equippedRead`), done conservatively and counted where it cannot be done.
  const socketed = hosts.filter((h) => h.exaltations.length > 0)
  assert.ok(socketed.length > 0, 'the committed character has exaltations in worn gear')

  for (const h of socketed) {
    for (const donor of h.exaltations) {
      assert.ok(donor.length > 0)
      assert.ok(!donor.includes('(Exaltation)'), 'the marker is stripped — the NAME is the payload')
      assert.ok(!/ \+\d+$/.test(donor), 'and so is any merge tier, exactly as for the host itself')
    }
    // A host never carries more donors than the game has sockets (R1's four).
    assert.ok(h.exaltations.length <= 4, `${h.slot} claims ${String(h.exaltations.length)} sockets`)
  }

  // THE SUB-SLOT NUMBER IS DELIBERATELY DROPPED, not lost. The children print as `Face-Slot7`,
  // `Ear-Slot10` and so on, and nothing in the file or the wiki maps those integers onto
  // focus/click/worn/proc — `InventoryEntry.slots` says the file does not distinguish them. Reading
  // one as a socket type would be inventing a fact (law 1), so the order is all that survives.
  const marked = [...walkEntries(dump.items)].filter(
    (e) =>
      !e.empty &&
      e.path.length === 1 &&
      e.name.includes('(Exaltation)') &&
      EQUIP_LOCATIONS.includes(splitLocationPath(e.location).base)
  )
  assert.ok(marked.length > 0, 'the fixture is expected to print exaltation children')
  assert.equal(
    hosts.reduce((n, h) => n + h.exaltations.length, 0),
    marked.length,
    'every marked child of a worn row reaches its host, and no host invents one'
  )
  // The numbers themselves are real and various — which is exactly why they are not a socket map.
  assert.ok(new Set(marked.map((e) => e.path[0])).size > 0)
})

test('BOTH of a paired slot fill, in file order — the dump never says which ear is which', () => {
  // Ear / Wrist / Fingers each appear twice at top level in the real dump, because the character
  // wears two of each. That is the measurement JOS-67 rests on, so it is asserted against the real
  // bytes rather than described: the dump's own repetition is the game stating the pair rule.
  // Until JOS-67 the second row of each was DISCARDED (the plan could hold one cell per slot), so
  // a player's second ring had nowhere to go — reported as "only allows one finger slot focus
  // effect" (feedback 01KZCGQ5M395WN93FQD40RXZC6).
  for (const [token, slot] of [
    ['Ear', 'EAR'],
    ['Wrist', 'WRIST'],
    ['Fingers', 'FINGER']
  ] as const) {
    const rows = [...walkEntries(dump.items)].filter(
      (e) => e.path.length === 0 && e.place.raw === token && !e.empty
    )
    assert.equal(rows.length, 2, `the fixture is expected to carry two equipped ${token} rows`)
    // File order, and nothing else: there is no left/right column, which is exactly why the cells
    // are NUMBERED rather than named.
    assert.equal(hosts.find((h) => h.slot === slot)?.name, rows[0].parsedName.base)
    assert.equal(hosts.find((h) => h.slot === `${slot}2`)?.name, rows[1].parsedName.base)
  }

  // …and FOUR tokens repeat in the dump, not three: `PLAN_SLOTS` is 18 + 3 + 2, and nothing else
  // repeats. A fifth would be a game fact we have never observed (awaiting-sample law).
  //
  // `Any Slot` used to be filtered OUT of this assertion by name, with no cell to go to — which is
  // the defect JOS-104 fixed, sitting in the test that measured it. It is now counted like the
  // other three: the dump doubles it, so the board doubles it.
  assert.equal(PLAN_SLOTS.length, EQUIP_SLOTS.length + PAIRED_SLOTS.length + ANY_CELLS.length)
  const doubled = [...walkEntries(dump.items)]
    .filter((e) => e.path.length === 0 && !e.empty && e.place.kind === 'equip')
    .map((e) => e.place.raw)
  const counts = new Map<string, number>()
  for (const raw of doubled) counts.set(raw, (counts.get(raw) ?? 0) + 1)
  const repeated = [...counts].filter(([, n]) => n > 1).map(([raw]) => raw)
  assert.deepEqual(repeated.sort(), ['Any Slot', 'Ear', 'Fingers', 'Wrist'])
  for (const [raw, n] of counts) assert.ok(n <= 2, `${raw} appears ${String(n)} times — no cell is tripled`)
})

test('BOTH any-slots fill, from a dump wearing three chest items at once (JOS-104)', () => {
  // The report was "missing 2x any slots" (feedback 01KZGHFSF6TW32TA4SMJQNWJE9, v0.12.0). The dump
  // is the witness: two top-level `Any Slot` rows, both holding real gear, PLUS a separately filled
  // `Chest` row — and the corpus states all three occupants as CHEST items. Three chest-slot items
  // worn at once is what makes these EXTRA PLACES rather than another spelling of an existing slot.
  const rows = [...walkEntries(dump.items)].filter(
    (e) => e.path.length === 0 && e.place.raw === 'Any Slot' && !e.empty
  )
  assert.equal(rows.length, 2, 'the fixture is expected to carry two equipped Any Slot rows')
  assert.equal(hosts.find((h) => h.slot === 'ANY1')?.name, rows[0].parsedName.base)
  assert.equal(hosts.find((h) => h.slot === 'ANY2')?.name, rows[1].parsedName.base)

  // The `Chest` cell is filled by a DIFFERENT item in the same dump — the whole argument, asserted
  // rather than described. If a rescrape of the fixture ever lost that, the any-cells would lose
  // their justification with it.
  const chest = hosts.find((h) => h.slot === 'CHEST')
  assert.ok(chest, 'the fixture wears a Chest item too')
  for (const cell of ANY_CELLS) {
    assert.notEqual(hosts.find((h) => h.slot === cell)?.name, chest.name)
  }

  // AND THE SOCKETS ARE REAL: the client prints `-Slot<n>` children under both any-slot rows, the
  // same shape it prints under `Face` (where one of them holds a `(Exaltation)`). No wiki or patch
  // note states whether an any-slot item can host exaltations; this is the game saying it does, and
  // it is the entire basis for these cells planning what every other cell plans.
  const sockets = [...walkEntries(dump.items)].filter((e) => e.place.raw === 'Any Slot' && e.path.length > 0)
  assert.ok(sockets.length > 0, 'both any-slot rows are expected to print exaltation socket children')
})

test('a cell maps back to the equip slot R2 is really about — or to none at all', () => {
  // The bridge every compatibility question crosses. Two rings are two PLACES to wear a FINGER
  // item, not a new kind of item, so nothing below the board ever meets `FINGER2`.
  for (const cell of PLAN_SLOTS) {
    const slot = equipSlotOf(cell)
    if (isAnyCell(cell)) assert.equal(slot, null, `${cell} occupies no equip slot`)
    else assert.ok(slot !== null && (EQUIP_SLOTS as readonly string[]).includes(slot))
  }
  assert.equal(equipSlotOf('FINGER2'), 'FINGER')
  assert.equal(equipSlotOf('HEAD'), 'HEAD')
  assert.deepEqual(cellsForSlot('FINGER'), ['FINGER', 'FINGER2'])
  assert.deepEqual(cellsForSlot('HEAD'), ['HEAD'])
  // Numbered, never named: "FINGER 1"/"FINGER 2" is the honest label for two rows in an order.
  assert.equal(planSlotLabel('FINGER'), 'FINGER 1')
  assert.equal(planSlotLabel('FINGER2'), 'FINGER 2')
  assert.equal(planSlotLabel('HEAD'), 'HEAD')
})

test('an any-cell constrains no slot, and every other cell constrains exactly one (JOS-104)', () => {
  // `hostSlotsOf` is the R2 question; `equipSlotOf` is the FILTER question. They agree everywhere
  // except the two cells this ticket added, which is the whole point of there being two functions.
  for (const cell of PLAN_SLOTS) {
    const slots = hostSlotsOf(cell)
    if (isAnyCell(cell)) {
      assert.deepEqual([...slots], [...EQUIP_SLOTS], `${cell} accepts every equip slot`)
    } else {
      assert.deepEqual([...slots], [equipSlotOf(cell)])
    }
  }

  // The any-cells are NOT returned by `cellsForSlot`: that answers "where does a CHEST item
  // naturally go", and the honest answer is the chest cell. Reachability is the board's job.
  for (const slot of EQUIP_SLOTS) {
    for (const cell of cellsForSlot(slot)) assert.ok(!isAnyCell(cell))
  }

  // The client's own noun, numbered for the same reason the rings are — two rows in an order, and
  // the dump has no column saying which is which.
  assert.equal(planSlotLabel('ANY1'), 'ANY SLOT 1')
  assert.equal(planSlotLabel('ANY2'), 'ANY SLOT 2')
  assert.deepEqual([...ANY_CELLS], ['ANY1', 'ANY2'])
})

test('bag contents and exaltation sockets are never mistaken for equipment', () => {
  // Both are `-Slot<n>` children; only top-level rows are worn. A regression here would put a
  // socketed effect (or a stack of bandages) forward as the host item of a slot.
  const children = [...walkEntries(dump.items)].filter((e) => e.path.length > 0 && !e.empty)
  assert.ok(children.length > 0, 'the fixture is expected to carry bag contents and sockets')
  assert.ok(hosts.length < children.length, 'the hosts must be the small top-level set, not the walk')
})

test('the tier rides beside the name: `+N` is stated or it is unknown, never 0', () => {
  for (const h of hosts) {
    if (h.tier === undefined) continue
    assert.ok(Number.isInteger(h.tier) && h.tier > 0, `${h.name} has a nonsense tier ${String(h.tier)}`)
  }
})
