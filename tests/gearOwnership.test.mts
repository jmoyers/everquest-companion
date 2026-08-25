// ============================================================================
// THE GEAR TAB'S OWNERSHIP JOIN (JOS-285, Gear Planner phase 4) — own it, where, at what +N.
// ============================================================================
//
// The join itself is a `Map.get`, and there is nothing to test in that. What IS worth pinning is
// every DECISION the join makes on the way to a cell, because each one is a sentence a player will
// read as a fact about their own bags:
//
//   * a `+2` in the bank and a base copy equipped are TWO facts and must render as two;
//   * an `<Item> (Exaltation)` row is a GEM MADE FROM the item, not a copy of it — the owner's own
//     dump has four, and one of them (Golden Efreeti Boots) is the item's ONLY appearance;
//   * a key ring this app does not count is "not counted", which is not "not owned";
//   * looted-with-no-copy is its own answer, and it never restates the dump's age.
//
// TWO INPUTS, the `plannerOwnership.test.mts` arrangement:
//
//   * HAND-WRITTEN ROWS, for the shapes and orderings a fold can produce — cheap, exhaustive, and
//     honest about being synthetic.
//   * THE REAL 295-line dump (`tests/fixtures/Primitive_freeport-Inventory.txt`) through the REAL
//     parser and the REAL fold, for the claims that must hold against bytes the game wrote: the
//     `(Exaltation)`-only item, the `Activated` row the fold leaves out, and the exact cell text
//     for a weapon the owner is wearing at +5.
//
// The corpus is NOT loaded here. This file is about the join, and `tests/gearIndex.test.mts` is
// where the corpus's own numbers are asserted — so a rescrape turns THAT file red and names the
// corpus, rather than this one going red and blaming the join.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseInventoryDump } from '../src/main/outputs/inventoryParse'
import {
  NO_OWNERSHIP,
  ownershipIndex,
  ownershipIndexFrom,
  ownershipPayload,
  uncountedKeyRings,
  type OwnershipEntry,
  type OwnershipRow
} from '../src/shared/planner/ownership'
import type { GearRow } from '../src/shared/planner/gear'
import {
  factText,
  gearOwnershipMap,
  gearOwnershipOf,
  ownedCellText,
  ownedCellTitle,
  ownedFacts,
  ownershipFor,
  placeLabel,
  uncountedNote
} from '../src/renderer/src/features/gear/gearOwnership'
import {
  DEFAULT_GEAR_FILTERS,
  filterGearRows,
  matchesGear,
  type GearFilters
} from '../src/renderer/src/features/gear/gearFilter'
import { isAcquisition, isKept } from '../src/shared/lootDisposition'
import type { LootDisposition } from '../src/shared/logEvents'
import { parseEvent } from '../src/main/log/parser'
import { LootModule } from '../src/main/modules/loot'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const REAL_DUMP = readFileSync(join(FIXTURES, 'Primitive_freeport-Inventory.txt'), 'utf8')

// =================================================================================
// FIXTURES
// =================================================================================

/** One ownership row, with only the fields the join reads spelled out. */
function row(over: Partial<OwnershipRow> & Pick<OwnershipRow, 'key' | 'place'>): OwnershipRow {
  return {
    name: over.key,
    rawName: over.key,
    location: '',
    count: 1,
    section: 'Location',
    exaltation: false,
    containment: 'top',
    itemId: 0,
    line: 1,
    ...over
  }
}

/** A gear candidate row — only `key` and `name` matter to a join keyed on `key`. */
function gear(key: string): GearRow {
  return {
    key,
    name: key,
    searchKey: key,
    slots: [],
    classes: [],
    races: ['ALL'],
    flags: [],
    quest: false,
    playerCrafted: false,
    stats: {},
    effects: []
  }
}

const CLOAK = 'cloak of flames'

/** The brief's own example: a base copy equipped, and a `+2` in the bank. */
const TWO_FACTS: OwnershipRow[] = [
  row({ key: CLOAK, place: 'equipped' }),
  row({ key: CLOAK, place: 'bank', tier: 2 })
]

function filters(over: Partial<GearFilters> = {}): GearFilters {
  return { ...DEFAULT_GEAR_FILTERS, eraOnly: false, ...over }
}

// =================================================================================
// RULE 1 — +N IS A FACT, NOT A SUMMARY
// =================================================================================

test('a +2 in the bank and a base copy equipped stay two facts', () => {
  const facts = ownedFacts(TWO_FACTS)
  assert.deepEqual(facts, [
    { place: 'equipped', count: 1 },
    { place: 'bank', tier: 2, count: 1 }
  ])
  // …and they read as two. Never "2 owned", which is the fold nobody can undo.
  assert.equal(ownedCellText(gearOwnershipOf(TWO_FACTS, false)), 'Equipped · Bank +2')
})

test('an unstated +N renders as the bare place — absent is not +0', () => {
  assert.equal(factText({ place: 'inventory', count: 1 }), 'Inventory')
  assert.equal(factText({ place: 'inventory', tier: 0, count: 1 }), 'Inventory +0')
  // The two are DIFFERENT rows and never collapse into one fact.
  const facts = ownedFacts([row({ key: 'x', place: 'inventory' }), row({ key: 'x', place: 'inventory', tier: 0 })])
  assert.equal(facts.length, 2)
})

test('two copies at the same place AND plus fold into one fact with a count', () => {
  const rows = [
    row({ key: 'boots', place: 'keyring', tier: 1 }),
    row({ key: 'boots', place: 'keyring', tier: 1 }),
    row({ key: 'boots', place: 'keyring' })
  ]
  assert.deepEqual(ownedFacts(rows), [
    { place: 'keyring', count: 1 },
    { place: 'keyring', tier: 1, count: 2 }
  ])
  assert.equal(ownedCellText(gearOwnershipOf(rows, false)), 'Keyring · Keyring +1 x2')
})

test('facts read equipped first, then the places a player looks in, then the unclassified one', () => {
  const rows = [
    row({ key: 'x', place: 'unknown' }),
    row({ key: 'x', place: 'keyring' }),
    row({ key: 'x', place: 'bank' }),
    row({ key: 'x', place: 'inventory' }),
    row({ key: 'x', place: 'equipped' })
  ]
  assert.deepEqual(
    ownedFacts(rows).map((f) => f.place),
    ['equipped', 'inventory', 'bank', 'keyring', 'unknown']
  )
  // The token the outputs model could not classify is NAMED, never folded into a neighbour.
  assert.equal(placeLabel('unknown'), 'Unfiled')
})

// =================================================================================
// RULE 2 — AN (Exaltation) ROW IS NOT A COPY
// =================================================================================

test('an exaltation row is never a wearable copy', () => {
  const rows = [row({ key: 'boots', place: 'equipped', exaltation: true })]
  const o = gearOwnershipOf(rows, false)
  assert.equal(o.owned, false, 'a gem made from the boots is not a pair of boots')
  assert.deepEqual(o.facts, [])
  assert.equal(o.exaltations, 1)
  assert.equal(ownedCellText(o), 'Exaltation only')
  assert.match(ownedCellTitle(o), /not a copy you can wear/)
})

test('a copy and its exaltation are reported as the two different things they are', () => {
  const rows = [
    row({ key: 'thelvorn', place: 'equipped', tier: 5 }),
    row({ key: 'thelvorn', place: 'equipped', exaltation: true, containment: 'socket' })
  ]
  const o = gearOwnershipOf(rows, false)
  assert.equal(ownedCellText(o), 'Equipped +5')
  assert.equal(o.exaltations, 1)
  assert.match(ownedCellTitle(o), /Equipped \+5/)
  assert.match(ownedCellTitle(o), /\(Exaltation\) row/)
})

// =================================================================================
// RULE 4 — LOOTED, AND LOOTED-BUT-NOT-IN-THE-DUMP
// =================================================================================

test('looted with no copy is its own answer, and it points at the freshness line', () => {
  const o = gearOwnershipOf([], true)
  assert.equal(o.owned, false)
  assert.equal(o.lootedNotInDump, true)
  assert.equal(ownedCellText(o), 'Looted')
  const title = ownedCellTitle(o)
  assert.match(title, /sold, traded, consumed into an exaltation/)
  assert.match(title, /line above says when it was written/)
  // AND IT STATES NO AGE OF ITS OWN — that is the `/outputfile` line's fact, said once.
  assert.doesNotMatch(title, /\d+\s*(m|h|d)\b|ago/)
})

test('looted AND owned is not the looted-not-in-dump case', () => {
  const o = gearOwnershipOf(TWO_FACTS, true)
  assert.equal(o.lootedNotInDump, false)
  assert.equal(ownedCellText(o), 'Equipped · Bank +2')
  assert.match(ownedCellTitle(o), /log also saw you loot it/)
})

test('a row nobody has ever seen says nothing at all — a blank cell and no tooltip', () => {
  const map = gearOwnershipMap([], [])
  const o = ownershipFor(map, gear('some item nobody owns'))
  assert.equal(ownedCellText(o), '')
  assert.equal(ownedCellTitle(o), '')
})

// =================================================================================
// THE MAP — the join, both witnesses
// =================================================================================

test('the map joins the dump by key, and a looted key the dump never names gets its own entry', () => {
  const entries: OwnershipEntry[] = [[CLOAK, TWO_FACTS]]
  const map = gearOwnershipMap(entries, ['Shiny Brass Shield +3', 'Cloak of Flames'])

  assert.equal(ownershipFor(map, gear(CLOAK)).owned, true)
  assert.equal(ownershipFor(map, gear(CLOAK)).looted, true, 'the loot line keys onto the dump row')

  // `ownershipForLootName` strips the ` +N` the LOG spelled, so the looted key is the base key.
  const shield = ownershipFor(map, gear('shiny brass shield'))
  assert.equal(shield.owned, false)
  assert.equal(shield.lootedNotInDump, true)
})

test('the transport round-trips: payload entries rebuild the index the fold produced', () => {
  const dump = parseInventoryDump(REAL_DUMP)
  const payload = ownershipPayload({ path: 'C:/eq/Primitive_freeport-Inventory.txt', loadedAt: 'T', dump })
  // AN IDENTITY, NOT A COUNT (frozen numbers rot): what comes back out of the transport is what
  // the fold put in, key for key and row for row.
  assert.deepEqual(ownershipIndexFrom(payload.entries), ownershipIndex(dump))
  assert.equal(ownershipIndexFrom(payload.entries).get('thelvorn, blade of light')?.length, 2)
  // No dump is "there is nothing to read", never "you own nothing".
  assert.deepEqual(ownershipPayload(null), NO_OWNERSHIP)
  assert.equal(NO_OWNERSHIP.path, null)
})

// =================================================================================
// RULE 3 — "NOT COUNTED" IS NOT "NOT OWNED", said over the player's OWN file
// =================================================================================

test('the uncounted keyring note names the categories the real dump actually has', () => {
  const uncounted = uncountedKeyRings(parseInventoryDump(REAL_DUMP))
  assert.deepEqual(uncounted, [{ category: 'Activated', rows: 1 }])

  const note = uncountedNote(uncounted)
  assert.ok(note !== null)
  assert.match(note, /1 on Activated/)
  assert.match(note, /not the same as you not having it/)
  // A dump with nothing uncounted says nothing — no chrome for a caveat that does not apply.
  assert.equal(uncountedNote([]), null)
})

// =================================================================================
// THE REAL DUMP — the join against bytes the game wrote
// =================================================================================

test('the real dump renders the cells the owner would recognise', () => {
  const dump = parseInventoryDump(REAL_DUMP)
  const map = gearOwnershipMap(ownershipPayload({ path: 'p', loadedAt: 't', dump }).entries, [])
  const cell = (key: string): string => ownedCellText(ownershipFor(map, gear(key)))

  // The e2e's anchor item: worn, at +5, with its own exaltation socketed beside it.
  assert.equal(cell('thelvorn, blade of light'), 'Equipped +5')
  assert.equal(ownershipFor(map, gear('thelvorn, blade of light')).exaltations, 1)

  // Two plus-states of one ring, in bags — two facts, in ascending order.
  assert.equal(cell('moonstone ring'), 'Inventory +1 · Inventory +3')

  // THE CASE RULE 2 EXISTS FOR: the dump's only Golden Efreeti Boots row is an exaltation socketed
  // into whatever is on his feet. He does not own the boots.
  assert.equal(cell('golden efreeti boots'), 'Exaltation only')
  assert.equal(ownershipFor(map, gear('golden efreeti boots')).owned, false)

  // A keyring row is ownership (JOS-66's reporter), and it keeps its plus-state.
  assert.equal(cell('sword of the lost'), 'Keyring +6')

  // The `Activated` row is in the file and NOT in the join — inherited, not re-decided here.
  assert.equal(cell('guise of the deceiver'), '')
})

// =================================================================================
// THE CHECKBOX — only owned or looted
// =================================================================================

test('the owned filter keeps a copy, an exaltation and a loot line, and drops everything else', () => {
  const map = gearOwnershipMap(
    [
      [CLOAK, TWO_FACTS],
      ['golden efreeti boots', [row({ key: 'golden efreeti boots', place: 'equipped', exaltation: true })]]
    ],
    ['Shiny Brass Shield']
  )
  const ownedOrLooted = (r: GearRow): boolean => {
    const o = ownershipFor(map, r)
    return o.owned || o.looted || o.exaltations > 0
  }
  const rows = [gear(CLOAK), gear('golden efreeti boots'), gear('shiny brass shield'), gear('rusty dagger')]

  const kept = filterGearRows(rows, filters({ ownedOnly: true }), { ownedOrLooted }).map((r) => r.key)
  assert.deepEqual(kept, [CLOAK, 'golden efreeti boots', 'shiny brass shield'])

  // THE LOOTED-NOT-IN-DUMP ARM IS THE ONE THE CHECKBOX EXISTS FOR: the shield is in nobody's dump
  // and the log is the only witness that it was ever his.
  assert.equal(ownershipFor(map, gear('shiny brass shield')).lootedNotInDump, true)

  // Off, it filters nothing at all.
  assert.equal(filterGearRows(rows, filters({ ownedOnly: false }), { ownedOrLooted }).length, 4)
})

test('the owned filter with no answer to inject hides everything rather than doing nothing', () => {
  // A no-op would be a control that lies about being on; an empty table is visible, and the view
  // names the toggle responsible for it (GearView `emptyText`).
  assert.equal(matchesGear(gear(CLOAK), filters({ ownedOnly: true })), false)
  assert.equal(matchesGear(gear(CLOAK), filters({ ownedOnly: false })), true)
})

test('the owned filter ANDs with the others rather than replacing them', () => {
  const map = gearOwnershipMap([[CLOAK, TWO_FACTS]], [])
  const deps = { ownedOrLooted: (r: GearRow): boolean => ownershipFor(map, r).owned }
  const cloak = { ...gear(CLOAK), name: 'Cloak of Flames', searchKey: 'cloak of flames' }
  assert.equal(matchesGear(cloak, filters({ ownedOnly: true, text: 'cloak' }), deps), true)
  assert.equal(matchesGear(cloak, filters({ ownedOnly: true, text: 'sword' }), deps), false)
})

// =================================================================================
// WHAT THE OWNED COLUMN MAY READ (JOS-453) — the auto-sell is not ownership
// =================================================================================
//
// `gearData.ts` filters the loot history before handing names to `gearOwnershipMap`, and until
// JOS-453 it filtered with `isAcquisition` — which answers "did this drop off a mob", not "do you
// have one". An auto-sold item answers YES to the first and NO to the second: the game vendored it
// in the same sentence that reported it. Measured on the owner's log the day it was reported:
// 8,816 of 12,045 loot events are `sold`, and 467 distinct base names appear NO OTHER WAY — 467
// items the Owned column called `Looted` that this character has never held.
//
// The predicate now lives in `shared/lootDisposition.ts` as `isKept`, beside the two it joins, so
// the three questions the loot lane can be asked stay written down in one place.

test('isKept answers ownership where isAcquisition answers "did it drop"', () => {
  // The two that state an item LEAVING you — one after you held it, one before you ever did.
  assert.equal(isKept({ disposition: 'destroyed' }), false)
  assert.equal(isKept({ disposition: 'sold' }), false)
  // …and every disposition that leaves you holding something.
  assert.equal(isKept({ disposition: undefined }), true, 'plain dashed loot')
  assert.equal(isKept({ disposition: 'currency' }), true)
  assert.equal(isKept({ disposition: 'hoard' }), true)
  assert.equal(isKept({ disposition: 'depot' }), true)
  // 'combined' consumed the looted copy INTO `created`, whose base name is the same one — you
  // finish the line owning one, so ownership says yes where the held COUNT nets zero.
  assert.equal(isKept({ disposition: 'combined' }), true)

  // The split this is all about: the sold row is an acquisition and is not ownership.
  assert.equal(isAcquisition({ disposition: 'sold' }), true, 'a sold item really did drop')
  assert.equal(isAcquisition({ disposition: 'destroyed' }), false)
})

test('W47 real bytes: the auto-sold +4 drops never reach the Owned column', () => {
  // The REAL Aug 23 Plane of Hate window, through the REAL parser and LootModule, filtered by the
  // predicate `gearData` ships — so what is asserted here is what the column will say.
  const mod = new LootModule()
  mod.reset()
  let seq = 0
  for (const raw of readFileSync(join(FIXTURES, 'w47-autosell-patch.log'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.length > 0)) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  const history = mod.snapshot().state

  const namesOf = (pred: (r: { disposition?: LootDisposition }) => boolean): string[] => [
    ...new Set(history.filter(pred).map((e) => e.item))
  ]
  // No dump at all: every key in the map is there because the LOG put it there, which isolates
  // the claim being tested from the inventory half of the join.
  const owned = (names: string[], key: string): boolean =>
    gearOwnershipMap([], names).get(key)?.looted === true

  const kept = namesOf(isKept)
  const acquired = namesOf(isAcquisition)

  // THE REGRESSION. Both of these were looted and vendored in the same line.
  assert.equal(owned(kept, 'ethereal mist gauntlets'), false, 'an auto-sold +4 is not owned')
  assert.equal(owned(kept, 'shadow rage sleeves'), false)
  assert.equal(owned(kept, 'crystallized sulfur'), false, '11 sold rows still claim nothing')
  // …and the old predicate DID claim them, so this test fails if the fix is reverted.
  assert.equal(owned(acquired, 'ethereal mist gauntlets'), true, 'isAcquisition used to say yes')

  // WHAT MUST STILL BE CLAIMED — the fix has to be narrow or it eats real ownership.
  assert.equal(owned(kept, 'ruby'), true, 'dashed keeps are owned')
  assert.equal(owned(kept, 'diamond'), true)
  assert.equal(owned(kept, 'mote of infinitesimal potential'), true)
  // The auto-merge: you hold the upgraded copy, and the ` +N` folds onto the base key.
  assert.equal(owned(kept, 'lustrous russet vambraces'), true, 'a combine leaves you holding one')
  assert.equal(owned(kept, 'ethereal mist greaves'), true)
  assert.equal(owned(kept, 'valorium vambraces'), true)
})
