// GEAR TAB — the ZONE FILTER (fork decision, kaltinril 2026-09-26: *add a filter by zone to the gear
// tab search page*). A file of its own because `gearFilter.test.mts` sits at the repo's
// 400-code-line factoring ceiling — the gearQueryFilter.test.mts precedent, fixtures duplicated
// the same way and for the same reason.
//
// THE CLAIMS PINNED HERE:
//
//   1. A PICK IS A ZONE, NEVER A SPELLING. The wiki spells Unrest three ways in the committed
//      corpus (`Unrest`, `Estate of Unrest`, `The Estate of Unrest` — measured, gearZones.ts), and
//      one pick keeps all three.
//   2. THE PICKS UNION, AND THE UNION ANDS with every other filter — the slot picker's rule.
//   3. SILENCE FAILS EVERY PICK: a row stating no source, or only a spelling the zone table
//      refuses, is not a row that drops in the zone asked for (law 1).
//   4. THE OPTIONS ARE THE ZONES THE ROWS NAME, once each, in lookup order.
//   5. A STORED PICK DEGRADES, and a HIDDEN control is not filtering — the two laws every other
//      field of the form already obeys.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GearRow } from '../src/shared/planner/gear'
import {
  DEFAULT_GEAR_FILTERS,
  filterGearRows,
  zoneMatches,
  type GearFilters
} from '../src/renderer/src/features/gear/gearFilter'
import {
  GEAR_ZONE_STEMS,
  gearZoneLabel,
  gearZoneOf,
  gearZoneOptions,
  zoneOptionsWith
} from '../src/renderer/src/features/gear/gearZones'
import { DEFAULT_GEAR_FORM, sanitizeGearForm } from '../src/renderer/src/features/gear/areaMemory'
import { GEAR_CONTROLS, controlsVisible, inertFilters } from '../src/renderer/src/features/gear/gearPrefs'

function row(over: Partial<GearRow> & Pick<GearRow, 'key' | 'name'>): GearRow {
  return {
    searchKey: over.name.toLowerCase(),
    slots: [],
    classes: [],
    races: ['ALL'],
    flags: [],
    quest: false,
    playerCrafted: false,
    stats: {},
    effects: [],
    ...over
  }
}

// One zone, three spellings — each of them one the committed corpus actually prints.
const BLADE = row({ key: 'a blade', name: 'A Blade', slots: ['PRIMARY'], dropZones: ['The Estate of Unrest'] })
const CAP = row({ key: 'b cap', name: 'B Cap', slots: ['HEAD'], dropZones: ['Unrest'] })
const RING = row({ key: 'c ring', name: 'C Ring', slots: ['FINGER'], dropZones: ['Estate of Unrest', 'Befallen'] })
const CLUB = row({ key: 'd club', name: 'D Club', slots: ['PRIMARY'], dropZones: ['Befallen'] })
const FEER = row({ key: 'e sash', name: 'E Sash', slots: ['WAIST'], dropZones: ['The Feerrott'] })
/** States no source at all — the wire omits the arrays for a row nobody names. */
const PLAIN = row({ key: 'f cloak', name: 'F Cloak', slots: ['BACK'] })
/** States only spellings the zone table refuses: a placeholder and two links that ran together. */
const DIRT = row({ key: 'g belt', name: 'G Belt', slots: ['WAIST'], dropZones: ['Various', 'Burning WoodsEmerald Jungle'] })

const ALL = [BLADE, CAP, RING, CLUB, FEER, PLAIN, DIRT]

function filters(over: Partial<GearFilters> = {}): GearFilters {
  return { ...DEFAULT_GEAR_FILTERS, eraOnly: false, ...over }
}

const names = (rows: readonly GearRow[]): string[] => rows.map((r) => r.name)

test('a pick is a ZONE - the three spellings the corpus prints for Unrest are one pick', () => {
  assert.equal(gearZoneOf('The Estate of Unrest'), 'unrest')
  assert.equal(gearZoneOf('Estate of Unrest'), 'unrest')
  assert.equal(gearZoneOf('Unrest'), 'unrest')
  assert.equal(gearZoneLabel('unrest'), 'The Estate of Unrest', 'and it wears the zone table`s own name')
  assert.deepEqual(names(filterGearRows(ALL, filters({ zones: ['unrest'] }))), ['A Blade', 'B Cap', 'C Ring'])
})

test('several zones are a UNION, and the union ANDs with everything else', () => {
  assert.deepEqual(names(filterGearRows(ALL, filters({ zones: ['unrest', 'befallen'] }))), [
    'A Blade',
    'B Cap',
    'C Ring',
    'D Club'
  ])
  // A row that drops in two zones answers to either, and is listed once.
  assert.deepEqual(names(filterGearRows(ALL, filters({ zones: ['befallen'] }))), ['C Ring', 'D Club'])
  assert.deepEqual(names(filterGearRows(ALL, filters({ zones: ['unrest', 'befallen'], slots: ['PRIMARY'] }))), [
    'A Blade',
    'D Club'
  ])
  assert.deepEqual(names(filterGearRows(ALL, filters({ zones: [] }))), names(ALL), 'no pick is no zone filter')
})

test('silence fails every pick - an unstated source and a refused spelling are not a zone', () => {
  assert.equal(zoneMatches(PLAIN, []), true, 'nothing picked keeps a row that states no source')
  assert.equal(zoneMatches(PLAIN, ['unrest']), false)
  // `Various` and a run-together cell resolve to nothing, and nothing is guessed out of them -
  // `Burning WoodsEmerald Jungle` is NOT a Burning Woods row for this filter (shared/zones.ts).
  assert.equal(gearZoneOf('Various'), null)
  assert.equal(gearZoneOf('Burning WoodsEmerald Jungle'), null)
  assert.equal(zoneMatches(DIRT, ['burningwood']), false)
  assert.equal(zoneMatches(DIRT, []), true)
})

test('the options are the zones the rows name - once each, article folded, refusals left out', () => {
  // Befallen, then The Estate of Unrest under E, then The Feerrott under F.
  assert.deepEqual(gearZoneOptions(ALL), ['befallen', 'unrest', 'feerrott'])
  assert.deepEqual(gearZoneOptions([PLAIN, DIRT]), [], 'rows naming no zone the table knows offer nothing')
  for (const stem of gearZoneOptions(ALL)) assert.ok(GEAR_ZONE_STEMS.includes(stem), `${stem} is a table stem`)
})

test('a pick the options do not hold is still offered, so it is still a chip that comes off', () => {
  const options = gearZoneOptions(ALL)
  assert.equal(zoneOptionsWith(options, ['unrest']), options, 'an offered pick changes nothing')
  assert.equal(zoneOptionsWith(options, []), options)
  // Before the index arrives the options are empty and the stored picks are all there is.
  assert.deepEqual(zoneOptionsWith([], ['unrest']), ['unrest'])
  assert.deepEqual(zoneOptionsWith(options, ['bazaar', 'unrest']), [...options, 'bazaar'])
})

test('a stored zone pick round-trips, and a stem the table does not know drops out', () => {
  assert.deepEqual(DEFAULT_GEAR_FORM.zones, [])
  assert.deepEqual(sanitizeGearForm({ zones: ['unrest', 'not_a_zone', 'unrest', 7, 'befallen'] }).zones, [
    'unrest',
    'befallen'
  ])
  // A form stored before the control existed has no `zones` key, and keeps every sibling.
  const older = sanitizeGearForm({ slots: ['HEAD'], eraOnly: false })
  assert.deepEqual(older.zones, [])
  assert.deepEqual(older.slots, ['HEAD'])
  assert.equal(older.eraOnly, false)
  assert.deepEqual(sanitizeGearForm({ zones: 'unrest' }).zones, [], 'a string is not a list')
})

test('the Zones control is on for everyone, and hidden it stops filtering', () => {
  assert.ok(GEAR_CONTROLS.includes('zone'))
  assert.ok(controlsVisible(null).has('zone'))
  const busy = filters({ zones: ['unrest'], slots: ['PRIMARY'] })
  assert.deepEqual(inertFilters(busy, controlsVisible(['slot'])).zones, [], 'hidden: inert')
  assert.deepEqual(inertFilters(busy, controlsVisible(['zone'])).zones, ['unrest'], 'shown: untouched')
  assert.deepEqual(inertFilters(busy, controlsVisible(null)), busy)
})
