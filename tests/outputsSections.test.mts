// ============================================================================
// A SECTION IS A SHAPE, NOT A NAME — the `/outputfile inventory` tables (JOS-185).
// ============================================================================
//
// Its sibling `tests/outputsInventory.test.mts` pins the parser against the REAL dumps. This file
// pins the one rule those dumps cannot exercise, because neither of them contains a third table:
// how a section the client has never shown us is read.
//
// EVERY DUMP BELOW IS SYNTHETIC AND SAYS SO. No sample of a Dragon's Hoard table exists in this
// repo or anywhere on the internet — the CONDITION is documented everywhere ("Dragon's Hoard items
// if the Dragon's Hoard window is open", eqlwiki.com/Commands) and the SHAPE is documented
// nowhere, which is exactly why the parser stopped keying on names. So these tests assert the RULE
// and never a token: the section is called `Hoard` here only to demonstrate that its name is not
// what makes it readable, and a real dump calling it anything at all passes these same assertions
// unchanged. `tests/fixtures/` stays real bytes only — nothing invented is committed as a fixture.
//
// The defect that earned the rule: report 01KZNQK6ZSRB8SMN8D5PJ8BS28, whose Plane of Sky weapons
// sat in the hoard. eqlposky.com read them out of his dump; this app said he had none, because a
// section it could not name went to `unknownSections` and never reached held counts.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { heldCountsFromDump } from '../src/shared/outputs/inventory'
import { storagesCoveredBy } from '../src/shared/outputs/baseline'
import { sheetCells } from '../src/shared/characterSheet'
import { equippedHosts } from '../src/shared/planner/inventorySlots'
import { parseInventoryDump } from '../src/main/outputs/inventoryParse'

const REAL_DUMP = readFileSync(
  join(import.meta.dirname, 'fixtures', 'Primitive_freeport-Inventory.txt'),
  'utf8'
)

/** A synthetic second item table — INVENTED, see the header. */
const EXTRA_ITEM_SECTION = [
  'Location\tName\tID\tCount\tSlots',
  'Head\tHat\t1\t1\t10',
  '',
  'Hoard\tName\tID\tCount\tSlots',
  'Hoard1\tRuned Bone Fork\t20802\t1\t10',
  'Hoard2\tEmpty\t0\t0\t0',
  'Hoard3\tShiny Metallic Robe\t20790\t2\t10'
].join('\n')

test('an item-shaped section counts as held, whatever the client called that table', () => {
  const dump = parseInventoryDump(EXTRA_ITEM_SECTION)
  assert.deepEqual(dump.sections, ['Location', 'Hoard'])
  assert.deepEqual(dump.sectionShapes, { Location: 'items', Hoard: 'items' })
  // Nothing was refused: the rows are ITEMS, not retained-verbatim mystery rows.
  assert.deepEqual(dump.unknownSections, [])
  assert.deepEqual(dump.malformed, [])

  // This is the whole reported defect: items stored outside the ordinary item table used to
  // reach `heldCountsFromDump` as a zero.
  const counts = heldCountsFromDump(dump)
  assert.equal(counts['runed bone fork'], 1)
  assert.equal(counts['shiny metallic robe'], 2)
  assert.equal(counts['hat'], 1)
  assert.equal(counts['empty'], undefined)

  // Each row remembers which table it came from — that is what keeps the two apart downstream.
  assert.deepEqual(
    dump.items.map((e) => [e.section, e.name]),
    [
      ['Location', 'Hat'],
      ['Hoard', 'Runed Bone Fork'],
      ['Hoard', 'Empty'],
      ['Hoard', 'Shiny Metallic Robe']
    ]
  )
})

test('only the Location table says what is WORN — a second table never dresses the character', () => {
  // Same shape, but the second table spells a token the equipment grid knows. The rows still
  // COUNT (above); they must not become the hat.
  const dump = parseInventoryDump(
    [
      'Location\tName\tID\tCount\tSlots',
      'Head\tReal Helm\t1\t1\t10',
      '',
      'Hoard\tName\tID\tCount\tSlots',
      'Head\tStored Helm\t2\t1\t10'
    ].join('\n')
  )
  assert.equal(heldCountsFromDump(dump)['stored helm'], 1)

  const sheet = sheetCells(dump)
  const worn = sheet.cells.find((c) => c.location === 'Head')
  assert.ok(worn)
  assert.equal(worn.item?.name, 'Real Helm')
  assert.deepEqual(sheet.unplaced, [])
  assert.deepEqual(equippedHosts(dump), [{ slot: 'HEAD', name: 'Real Helm' }])

  // …and coverage follows the same split: the stored row is not evidence about what is equipped.
  assert.deepEqual(storagesCoveredBy(dump), ['equip'])
})

test('a keyring-shaped section parses as a keyring, whatever that table is called', () => {
  const dump = parseInventoryDump(
    [
      'Location\tName\tID\tCount\tSlots',
      'Head\tHat\t1\t1\t10',
      '',
      'Equipment Ring\tName\tID\t',
      'Equipment\tLight Woolen Mask\t20821'
    ].join('\n')
  )
  assert.deepEqual(dump.sectionShapes, { Location: 'items', 'Equipment Ring': 'keyRing' })
  assert.equal(dump.keyRing.length, 1)
  assert.equal(dump.keyRing[0].section, 'Equipment Ring')
  assert.equal(dump.keyRing[0].category, 'Equipment')
  // The HELD rule is still the CATEGORY's, not the table's (JOS-66).
  assert.equal(heldCountsFromDump(dump)['light woolen mask'], 1)
})

test('the real dump reads exactly as it did before the shape rule', () => {
  const dump = parseInventoryDump(REAL_DUMP)
  assert.deepEqual(dump.sectionShapes, { Location: 'items', KeyRing: 'keyRing' })
  assert.ok(dump.items.every((e) => e.section === 'Location'))
  assert.ok(dump.keyRing.every((k) => k.section === 'KeyRing'))
  assert.deepEqual(dump.unknownSections, [])
})
