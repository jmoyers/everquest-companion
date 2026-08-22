// ============================================================================
// THE `/outputfile` ENGINE — inventory kind. Parser + registry + compatibility gate.
// ============================================================================
//
// The fixture `tests/fixtures/Primitive_freeport-Inventory.txt` is the dev character's REAL
// `/outputfile inventory` dump, committed verbatim (295 lines). It contains item names and
// item ids and nothing else — no chat, no third-party anything — so the scrub law has
// nothing to drop here; the file IS the evidence, and trimming it would weaken the
// equivalence proof below.
//
// The load-bearing test replays the OLD flat parser verbatim and diffs it key-for-key
// against the derivation. It began life as an equality gate (JOS-44 replaced a lossy line
// reader with a deep model + a derivation, and no downstream consumer was allowed to tell).
// JOS-66 makes ONE deliberate change on top, so the gate is now stated as a MEASURED
// DIFFERENCE: identical on the `Location` table, plus exactly the held `KeyRing` rows. The
// refactor's proof is intact — that is all it ever claimed — and the one behavior change
// has to be spelled out in numbers to pass.
//
// JOS-185 made section reading SHAPE-driven rather than name-driven, and the real dumps here are
// exactly the evidence that it changed nothing they can see: the file still reads as `Location`
// items plus a `KeyRing`, byte for byte. The rule those files cannot exercise — what happens when
// the client writes a THIRD table — lives in `tests/outputsSections.test.mts`, which is synthetic
// and says so.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  HELD_KEYRING_CATEGORIES,
  heldCountsFromDump,
  looksLikeContainer,
  parseItemName,
  parentLocation,
  parsePlace,
  splitLocationPath,
  walkEntries,
  type InventoryEntry
} from '../src/shared/outputs/inventory'
import { inventoryHeldCounts, parseInventoryDump } from '../src/main/outputs/inventoryParse'
import { OUTPUT_KINDS, outputKind, parseOutput } from '../src/main/outputs/kinds'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const REAL_DUMP = readFileSync(join(FIXTURES, 'Primitive_freeport-Inventory.txt'), 'utf8')

/**
 * THE OLD PARSER, verbatim (src/main/inventory/parseInventory.ts before this wave). Kept
 * here as the regression oracle — the new derivation is only allowed to be a refactor if
 * this function and `inventoryHeldCounts` agree on the real dump.
 */
function legacyParseInventoryText(text: string): Record<string, number> {
  const counts: Record<string, number> = {}
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim()) continue
    const cols = line.split('\t')
    if (cols.length < 4) continue
    const location = cols[0].trim()
    const name = cols[1].trim()
    if (location === 'Location' || name === 'Name') continue // header
    if (!name || name === 'Empty') continue
    const count = Number.parseInt(cols[3], 10)
    const n = Number.isFinite(count) && count > 0 ? count : 1
    const key = name.toLowerCase()
    counts[key] = (counts[key] ?? 0) + n
  }
  return counts
}

/** Every top-level row, by its raw Location, in file order. */
function topLocations(dump: ReturnType<typeof parseInventoryDump>): string[] {
  return dump.items.map((e) => e.location)
}

/** All entries (parents and children) as a flat array. */
function allEntries(dump: ReturnType<typeof parseInventoryDump>): InventoryEntry[] {
  return [...walkEntries(dump.items)]
}

// ---------------------------------------------------------------------------
// THE COMPATIBILITY GATE
// ---------------------------------------------------------------------------

test('held counts differ from the old flat parser by EXACTLY the held keyring rows', () => {
  const legacy = legacyParseInventoryText(REAL_DUMP)
  const derived = inventoryHeldCounts(REAL_DUMP)
  const dump = parseInventoryDump(REAL_DUMP)

  // Not a vacuous pass: the real dump holds a substantial map.
  assert.ok(Object.keys(legacy).length > 50, 'oracle produced a non-trivial map')

  // The expected difference, derived from the dump's own keyring rather than hand-listed.
  const expectedDelta: Record<string, number> = {}
  for (const k of dump.keyRing) {
    if (!HELD_KEYRING_CATEGORIES.includes(k.category)) continue
    const key = k.name.toLowerCase()
    expectedDelta[key] = (expectedDelta[key] ?? 0) + 1
  }
  assert.equal(
    Object.values(expectedDelta).reduce((s, n) => s + n, 0),
    36,
    'the real dump carries 36 Equipment keyring rows'
  )

  // Key-for-key, so a failure names the item rather than dumping two objects.
  const keys = new Set([...Object.keys(legacy), ...Object.keys(derived)])
  for (const k of keys) {
    assert.equal(derived[k], (legacy[k] ?? 0) + (expectedDelta[k] ?? 0), `count mismatch for ${k}`)
  }

  // And the item table alone still reproduces the old parser EXACTLY — the JOS-44 refactor's
  // equivalence proof, unchanged, with the one JOS-66 addition subtracted back out.
  const itemsOnly = heldCountsFromDump({ ...dump, keyRing: [] })
  assert.deepEqual(itemsOnly, legacy)
})

test('held counts: the derivation counts what the old one counted, and nothing else', () => {
  const counts = inventoryHeldCounts(REAL_DUMP)
  // A bag row counts as an item (three identical Backpacks, name kept verbatim with its `*`).
  assert.equal(counts['backpack*'], 3)
  assert.equal(counts['backpack'], 3)
  // Stack counts come from the Count column, not from the row count.
  assert.equal(counts['tiny dagger'], 86)
  assert.equal(counts['bandages*'], 20)
  // Duplicate rows of one item sum.
  assert.equal(counts['prayers of life'], 6)
  assert.equal(counts['red dragon scales'], 3)
  // Socket rows count too — that is what the old parser did, and reconcile relies on it.
  assert.equal(counts['moonstone ring (exaltation)'], 2)
  // `+N` variants stay SEPARATE here; folding happens downstream at the counting key.
  assert.equal(counts['moonstone ring +1'], 1)
  assert.equal(counts['moonstone ring +3'], 1)
  // Empty slots never count.
  assert.equal(counts['empty'], undefined)
  // An `Equipment` keyring row counts ONE — the table has no Count column, and a copy is a
  // row: `Boots of the Long Road` 177708 is listed base once and `+1` twice (JOS-66).
  assert.equal(counts['boots of the long road'], 1)
  assert.equal(counts['boots of the long road +1'], 2)
  // …and the `Activated` category still does not count (awaiting a dump that says what it is).
  assert.equal(counts['guise of the deceiver'], undefined)
})

// ---------------------------------------------------------------------------
// SUB-ROW ATTACHMENT
// ---------------------------------------------------------------------------

test('sub-rows attach to their own parent — the two Ear rows keep their own sockets', () => {
  const dump = parseInventoryDump(REAL_DUMP)
  const ears = dump.items.filter((e) => e.location === 'Ear')
  assert.equal(ears.length, 2, 'both ears are top-level rows with the same Location token')
  assert.equal(ears[0].name, 'Drop of Crystallized Flame +7')
  assert.equal(ears[1].name, 'Earring of Disease Reflection +4')
  for (const ear of ears) {
    assert.deepEqual(
      ear.children.map((c) => c.path[c.path.length - 1]),
      [7, 8, 9, 10],
      'each ear owns its own four socket rows'
    )
    assert.ok(ear.children.every((c) => c.empty))
  }
  // The same shape for the other duplicated tokens.
  assert.equal(dump.items.filter((e) => e.location === 'Wrist').length, 2)
  assert.equal(dump.items.filter((e) => e.location === 'Fingers').length, 2)
  assert.equal(dump.items.filter((e) => e.location === 'Any Slot').length, 2)
})

test('nesting goes two deep: a bagged item carries its own exaltation', () => {
  const dump = parseInventoryDump(REAL_DUMP)
  const bag = dump.items.find((e) => e.location === 'General 1')
  assert.ok(bag)
  assert.equal(bag.name, 'Spacious Rucksack')
  assert.equal(bag.slots, 24)
  assert.equal(bag.children.length, 24)

  const lute = bag.children.find((c) => c.location === 'General 1-Slot9')
  assert.ok(lute)
  assert.equal(lute.name, 'Kelin`s Seven Stringed Lute +1')
  assert.deepEqual(lute.path, [9])
  assert.equal(lute.children.length, 1)
  const exalt = lute.children[0]
  assert.equal(exalt.location, 'General 1-Slot9-Slot7')
  assert.deepEqual(exalt.path, [9, 7])
  assert.equal(exalt.parsedName.exaltation, true)
  assert.equal(exalt.parsedName.base, 'Kelin`s Seven Stringed Lute')

  // No row is lost by nesting: every data row of the item table is reachable from the tree.
  const itemRows = REAL_DUMP.split(/\r?\n/).filter(
    (l) => l.trim() && l.split('\t').length === 5
  ).length
  assert.equal(allEntries(dump).length, itemRows - 1, 'all rows minus the header')
})

test('an orphan row is kept at top level and flagged, never re-parented by guesswork', () => {
  const dump = parseInventoryDump(
    ['Location\tName\tID\tCount\tSlots', 'General 3-Slot4\tMystery Gem\t99\t1\t10'].join('\n')
  )
  assert.equal(dump.items.length, 1)
  assert.equal(dump.items[0].orphan, true)
  assert.deepEqual(dump.items[0].path, [4])
  // A genuine top-level row is NOT an orphan.
  const ok = parseInventoryDump(['Location\tName\tID\tCount\tSlots', 'Head\tHat\t1\t1\t10'].join('\n'))
  assert.equal(ok.items[0].orphan, false)
})

// ---------------------------------------------------------------------------
// NAMES
// ---------------------------------------------------------------------------

test('tier suffixes, exaltation markers and the trailing star split off the base name', () => {
  assert.deepEqual(parseItemName('Brigandine Tunic +1'), {
    base: 'Brigandine Tunic',
    tier: 1,
    exaltation: false,
    starred: false
  })
  assert.deepEqual(parseItemName('Drop of Crystallized Flame +7'), {
    base: 'Drop of Crystallized Flame',
    tier: 7,
    exaltation: false,
    starred: false
  })
  assert.deepEqual(parseItemName('Polished Mithril Mask (Exaltation)'), {
    base: 'Polished Mithril Mask',
    tier: undefined,
    exaltation: true,
    starred: false
  })
  assert.deepEqual(parseItemName('Backpack*'), {
    base: 'Backpack',
    tier: undefined,
    exaltation: false,
    starred: true
  })
  // Untiered names are left alone, and an interior `+N` is not a tier.
  assert.deepEqual(parseItemName('Pauldrons of Power'), {
    base: 'Pauldrons of Power',
    tier: undefined,
    exaltation: false,
    starred: false
  })
  assert.equal(parseItemName('Sword +2 of Doom').tier, undefined)
})

test('the raw Name column survives verbatim on every entry', () => {
  const dump = parseInventoryDump(REAL_DUMP)
  const tunic = dump.items.find((e) => e.name === 'Brigandine Tunic +1')
  assert.ok(tunic)
  assert.equal(tunic.parsedName.base, 'Brigandine Tunic')
  assert.equal(tunic.parsedName.tier, 1)
  assert.equal(tunic.itemId, 3307)
})

// ---------------------------------------------------------------------------
// EMPTY SLOTS
// ---------------------------------------------------------------------------

test('empty sockets are modeled, not dropped — an empty slot is a fact about the item', () => {
  const dump = parseInventoryDump(REAL_DUMP)
  const empties = allEntries(dump).filter((e) => e.empty)
  assert.ok(empties.length > 100, 'the real dump is mostly empty slots')
  for (const e of empties) {
    assert.equal(e.name, 'Empty')
    assert.equal(e.itemId, 0)
    assert.equal(e.count, 0)
    assert.equal(e.slots, 0)
  }
  // A face with one filled socket and two empty ones.
  const face = dump.items.find((e) => e.location === 'Face')
  assert.ok(face)
  assert.deepEqual(
    face.children.map((c) => [c.path[0], c.parsedName.exaltation]),
    [
      [7, true],
      [8, false],
      [9, false]
    ]
  )
  // A blank name reads as empty too.
  const blank = parseInventoryDump(['Location\tName\tID\tCount\tSlots', 'Head\t\t0\t0\t0'].join('\n'))
  assert.equal(blank.items[0].empty, true)
  assert.deepEqual(heldCountsFromDump(blank), {})
})

// ---------------------------------------------------------------------------
// LOCATION TOKENS
// ---------------------------------------------------------------------------

test('Personal-Depot1 is ONE base token, not a Personal row with a Depot sub-slot', () => {
  assert.deepEqual(splitLocationPath('Personal-Depot1'), { base: 'Personal-Depot1', path: [] })
  assert.equal(parentLocation('Personal-Depot1'), null)
  assert.deepEqual(parsePlace('Personal-Depot1'), {
    kind: 'container',
    container: 'personalDepot',
    index: 1,
    raw: 'Personal-Depot1'
  })
  const dump = parseInventoryDump(REAL_DUMP)
  const depot = dump.items.find((e) => e.location === 'Personal-Depot1')
  assert.ok(depot)
  assert.equal(depot.name, 'Griffenne Blood')
  assert.equal(depot.count, 2)
  assert.equal(depot.orphan, false)
})

test('every Location token in the real dump classifies; nothing lands in unknown', () => {
  const dump = parseInventoryDump(REAL_DUMP)
  const unknown = allEntries(dump).filter((e) => e.place.kind === 'unknown')
  assert.deepEqual(unknown.map((e) => e.location), [])

  const bases = new Set(dump.items.map((e) => e.place.raw))
  // Equipment slots, verbatim as the client spells them.
  for (const token of ['Any Slot', 'Ear', 'Head', 'Face', 'Fingers', 'Ammo', 'Held']) {
    assert.ok(bases.has(token), `expected the equip token ${token}`)
  }
  const kinds = dump.items.map((e) => e.place)
  assert.equal(kinds.filter((p) => p.kind === 'container' && p.container === 'general').length, 12)
  assert.equal(kinds.filter((p) => p.kind === 'container' && p.container === 'bank').length, 24)
  assert.equal(
    kinds.filter((p) => p.kind === 'container' && p.container === 'sharedBank').length,
    6
  )
  assert.equal(
    kinds.filter((p) => p.kind === 'container' && p.container === 'personalDepot').length,
    1
  )
})

test('an unknown Location token is reported honestly, never coerced to the nearest slot', () => {
  const dump = parseInventoryDump(
    [
      'Location\tName\tID\tCount\tSlots',
      'Mount Keyring 3\tSaddle\t42\t1\t10',
      'Mount Keyring 3-Slot7\tSaddle (Exaltation)\t42\t1\t10'
    ].join('\n')
  )
  assert.equal(dump.items.length, 1)
  assert.deepEqual(dump.items[0].place, { kind: 'unknown', raw: 'Mount Keyring 3' })
  // Unknown or not, the PATH still works — sub-rows attach as usual.
  assert.equal(dump.items[0].children.length, 1)
  assert.equal(dump.items[0].children[0].parsedName.exaltation, true)
  // And an unknown location does not stop the row from counting (compatibility).
  assert.equal(heldCountsFromDump(dump)['saddle'], 1)
})

// ---------------------------------------------------------------------------
// SECTIONS
// ---------------------------------------------------------------------------

test('the KeyRing table parses into its own section, and only held categories count', () => {
  const dump = parseInventoryDump(REAL_DUMP)
  assert.deepEqual(dump.sections, ['Location', 'KeyRing'])
  assert.equal(dump.keyRing.length, 37)
  assert.equal(dump.keyRing.filter((k) => k.category === 'Equipment').length, 36)
  assert.equal(dump.keyRing.filter((k) => k.category === 'Activated').length, 1)
  const drums = dump.keyRing.find((k) => k.name.startsWith('Selo`s Drums'))
  assert.ok(drums)
  assert.equal(drums.itemId, 11626)
  assert.equal(drums.parsedName.tier, 4)
  // No keyring row leaked into the item tree, and none is malformed.
  assert.deepEqual(dump.malformed, [])
  assert.equal(
    topLocations(dump).some((l) => l === 'Equipment' || l === 'Activated'),
    false
  )
  // The held set is closed and stated (JOS-66): `Equipment` is in, everything else waits for
  // a dump that says what it is.
  assert.deepEqual(HELD_KEYRING_CATEGORIES, ['Equipment'])
})

// ---------------------------------------------------------------------------
// THE KEYRING IS A STORAGE LOCATION (JOS-66)
// ---------------------------------------------------------------------------

test('the Equipment keyring is DISJOINT from the item table — counting it adds, never doubles', () => {
  const dump = parseInventoryDump(REAL_DUMP)
  const itemNames = new Set([...walkEntries(dump.items)].filter((e) => !e.empty).map((e) => e.name))
  const shared = dump.keyRing
    .filter((k) => k.category === 'Equipment' && itemNames.has(k.name))
    .map((k) => k.name)
  assert.deepEqual(shared, [], 'no Equipment keyring row names an item the Location table lists')

  // A copy is a ROW: one item id, three rows, two of them the same name. A registry of
  // distinct appearances cannot print that; a bin holding real copies does.
  const boots = dump.keyRing.filter((k) => k.itemId === 177708)
  assert.deepEqual(
    boots.map((k) => k.name),
    ['Boots of the Long Road', 'Boots of the Long Road +1', 'Boots of the Long Road +1']
  )
})

// The refusal JOS-44 wrote, still standing after JOS-185 made section reading shape-driven: this
// header has FIVE columns like the item table and still means nothing, because `Rank` and `Tier`
// are not `Count` and `Slots` and no sample has ever said what they are. The shape rule widened
// what "recognized" means from the section's NAME to its COLUMNS; it did not lower the bar.
test('a section whose header shape we do not recognize is retained verbatim, never interpreted', () => {
  const dump = parseInventoryDump(
    [
      'Location\tName\tID\tCount\tSlots',
      'Head\tHat\t1\t1\t10',
      '',
      'Mercenary\tName\tID\tRank\tTier',
      'Suspended\tGoblin Mercenary\t7\t3\t2'
    ].join('\n')
  )
  assert.deepEqual(dump.sections, ['Location', 'Mercenary'])
  assert.deepEqual(dump.sectionShapes, { Location: 'items', Mercenary: 'unknown' })
  assert.equal(dump.items.length, 1)
  assert.equal(dump.unknownSections.length, 1)
  assert.deepEqual(dump.unknownSections[0], {
    section: 'Mercenary',
    columns: ['Suspended', 'Goblin Mercenary', '7', '3', '2'],
    line: 5
  })
  // THE ONE DELIBERATE BEHAVIOR DIFFERENCE from the old parser, pinned: it would have
  // counted `goblin mercenary` as a held item because the row happened to have five
  // columns. A table whose shape we have never seen does not feed item counts.
  assert.deepEqual(heldCountsFromDump(dump), { hat: 1 })
})

test('a malformed row is counted, never thrown on', () => {
  const dump = parseInventoryDump(
    ['Location\tName\tID\tCount\tSlots', 'Head\tHat\t1\t1\t10', 'Truncated\trow'].join('\n')
  )
  assert.equal(dump.items.length, 1)
  assert.equal(dump.malformed.length, 1)
  assert.equal(dump.malformed[0].line, 3)
  assert.equal(dump.malformed[0].section, 'Location')
  assert.deepEqual(heldCountsFromDump(dump), { hat: 1 })
})

test('an empty file parses to an empty dump rather than throwing', () => {
  const dump = parseInventoryDump('')
  assert.deepEqual(dump, {
    items: [],
    keyRing: [],
    unknownSections: [],
    malformed: [],
    sections: [],
    sectionShapes: {}
  })
  assert.deepEqual(heldCountsFromDump(dump), {})
})

// ---------------------------------------------------------------------------
// THE OPT-IN STRUCTURAL GUESS
// ---------------------------------------------------------------------------

test('looksLikeContainer separates bags from socketed items across the whole dump', () => {
  const dump = parseInventoryDump(REAL_DUMP)
  const containerish = allEntries(dump)
    .filter((e) => looksLikeContainer(e))
    .map((e) => e.name)
  assert.deepEqual(containerish, [
    'Spacious Rucksack',
    'Light Burlap Sack',
    'Backpack*',
    'Backpack*',
    'Backpack*',
    'Backpack',
    'Backpack',
    'Backpack'
  ])
  // Every socketed item is excluded — its children are a SPARSE subset of 1..10.
  const face = dump.items.find((e) => e.location === 'Face')
  assert.ok(face)
  assert.equal(looksLikeContainer(face), false)
})

// ---------------------------------------------------------------------------
// THE REGISTRY
// ---------------------------------------------------------------------------

test('registry: inventory and achievements are the graduated kinds; the rest refuse typed', () => {
  // TWO KINDS SINCE JOS-429, and the list is asserted rather than counted so a kind cannot
  // graduate without somebody editing this line. `achievements` earned it the same way `inventory`
  // did: a real dump read, its format written down, a fixture committed (see
  // tests/outputsAchievements.test.mts, which owns that kind's own claims).
  const supported = OUTPUT_KINDS.filter((k) => k.status === 'supported').map((k) => k.id)
  assert.deepEqual(supported, ['inventory', 'achievements'])

  const res = parseOutput('inventory', REAL_DUMP)
  assert.equal(res.ok, true)
  assert.ok(res.ok && res.data.kind === 'inventory')
  assert.ok(res.ok && res.data.dump.items.length > 0)

  for (const kind of OUTPUT_KINDS.filter((k) => k.status === 'awaiting-sample')) {
    const refused = parseOutput(kind.id, 'anything at all\n')
    assert.equal(refused.ok, false, `${kind.id} must not parse`)
    assert.ok(!refused.ok && refused.reason === 'unsupported')
    assert.match(refused.ok ? '' : refused.message, /^unsupported: no verified sample/)
    // The filename suffix of an ungraduated kind is knowledge we have NOT verified.
    assert.equal(kind.fileKindVerified, false)
  }
})

test('registry: the inventory filename suffix is the measured one', () => {
  const def = outputKind('inventory')
  assert.equal(def.fileKind, 'Inventory')
  assert.equal(def.fileKindVerified, true)
  // Every registered kind has a distinct, non-empty suffix — discovery matches on it.
  const suffixes = OUTPUT_KINDS.map((k) => k.fileKind.toLowerCase())
  assert.equal(new Set(suffixes).size, suffixes.length)
  assert.ok(suffixes.every((s) => s.length > 0))
})
