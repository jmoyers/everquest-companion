// The Maps tab's ZONE PANE — the wiki's bestiary and the map's own labels, side by side.
//
// TWO PURE MODULES, ONE QUESTION. `parseMobLocations` (src/main/mobLookupParse.ts) turns a wiki
// page's `|location` field into spawn points; `mobPins.ts` turns those points, plus the map
// parser's own label points, into the rows the pane lists and the pins the surface draws. Both
// are arithmetic and string work — no React, no DOM, no Electron — so this suite NEVER skips.
//
// THE CLAIM UNDER TEST IS A CLAIM ABOUT HONESTY, not about pixels:
//
//   1. A COORDINATE IS PARSED OR IT IS ABSENT. The wiki writes `|location` ten different ways
//      (measured across all 7,866 catalog pages, 2026-08-04) and 1,470 of them are prose —
//      `Various`, `?`, `Need Info`, `Wanders`. Every shape below is VERBATIM from a real page,
//      including the prose ones, which must yield nothing at all rather than a zero.
//   2. THE MAP TRANSFORM IS `mapFromLoc` AND NOTHING ELSE. `/loc (155, -411)` is map (411, -155)
//      — the sign convention that, got wrong, produces a mirrored map of a zone you have never
//      been to. Measured this wave over 7,423 real coordinates in 119 mapped zones: 99.4% land
//      inside their zone's own extent under this transform, 66.4% under the next best.
//   3. A MOB WITH NO STATED POSITION IS STILL LISTED. `isLocatable` false, `pins` empty, and the
//      counts say how many of the zone's mobs that is. The pane must never invent a pin.
//   4. THE FILTER NARROWS AND KEEPS ORDER. One box drives both sections; the list's order is
//      "lowest level first", which a relevance re-rank would destroy on every keystroke.
//
// The REAL committed catalog is exercised too (the same posture tests/mobSearch.test.mts takes),
// because the join it depends on — `mobsInZone` — is only interesting against real rows.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMobLocations } from '../src/main/mobLookupParse'
import {
  MAX_PINS,
  filterPaneRows,
  isCommonMob,
  isLocatable,
  labelRows,
  mobPins,
  mobRows,
  paneCounts,
  pinsForRows,
  rowTarget,
  wishedDrops,
  type MobPaneRow
} from '../src/renderer/src/features/maps/mobPins'
import { MOB_CATALOG } from '../src/renderer/src/features/mobs/mobSearch'
import type { MapPoint } from '../src/shared/maps'
import type { MobEntry } from '../src/shared/types'

// ---- 1. the `|location` field, in every shape the wiki actually writes -------------------

test('parseMobLocations reads the plain parenthesised pair', () => {
  assert.deepEqual(parseMobLocations('(131, 342)'), [{ ns: 131, ew: 342 }])
})

test('parseMobLocations reads a triple — the ~2% of pages that state an elevation', () => {
  // Verbatim, "The Tenderizer" (Najena).
  assert.deepEqual(parseMobLocations('(131, 342, 4)'), [{ ns: 131, ew: 342, z: 4 }])
})

test('parseMobLocations keeps EVERY spawn point, with the share the page stated', () => {
  assert.deepEqual(parseMobLocations('50% @ (1, 2), 50% @ (-3, 4)'), [
    { ns: 1, ew: 2, pct: 50 },
    { ns: -3, ew: 4, pct: 50 }
  ])
})

test('parseMobLocations tolerates the unparenthesised and bare-@ shapes', () => {
  assert.deepEqual(parseMobLocations('1000, -2000'), [{ ns: 1000, ew: -2000 }])
  assert.deepEqual(parseMobLocations('@ (10, 20)'), [{ ns: 10, ew: 20 }])
  assert.deepEqual(parseMobLocations('~(10, 20)'), [{ ns: 10, ew: 20 }])
})

test('parseMobLocations ignores the prose either side of a coordinate', () => {
  // Both verbatim shapes: a floor note before, a map-key note after (with a wiki link in it).
  assert.deepEqual(parseMobLocations('Basement 25% @ (10,20)'), [{ ns: 10, ew: 20, pct: 25 }])
  assert.deepEqual(parseMobLocations('50% @ (-1121, 233) at [[The Velium Keg]] No. 3 on map'), [
    { ns: -1121, ew: 233, pct: 50 }
  ])
})

test('parseMobLocations yields NOTHING for the 1,470 pages that state only prose', () => {
  for (const prose of ['Various', 'various', '?', "''Need Info''", 'Need Info', 'Wanders', 'Droga Main', ''])
    assert.deepEqual(parseMobLocations(prose), [], prose)
})

// ---- 2. the conversion into map coordinates ---------------------------------------------

test('mobPins converts /loc to map coordinates through mapFromLoc — mapX = -ew, mapY = -ns', () => {
  // The pinned worked example (mapGeometry.ts): /loc (155, -411, 15) is written `P 411, -155, 15`.
  const entry: MobEntry = { page: 'p', name: 'n', loc: [{ ns: 155, ew: -411, z: 15 }] }
  assert.deepEqual(mobPins(entry), [{ x: 411, y: -155 }])
})

test('mobPins carries the stated spawn share and drops nothing when several are stated', () => {
  const entry: MobEntry = { page: 'p', name: 'n', loc: [{ ns: 1, ew: 2, pct: 60 }, { ns: 3, ew: 4 }] }
  assert.deepEqual(mobPins(entry), [{ x: -2, y: -1, pct: 60 }, { x: -4, y: -3 }])
})

test('mobPins invents nothing for a mob whose page stated no numbers', () => {
  assert.deepEqual(mobPins({ page: 'p', name: 'n' }), [])
})

// ---- 3. the rows -------------------------------------------------------------------------

// NAMED fixtures — mobRows drops articled commons, so the pane fixtures are named mobs.
const CATALOG: MobEntry[] = [
  { page: 'Placed One', name: 'Placed One', level: '10', zones: ['Najena'], loc: [{ ns: 100, ew: 200 }] },
  { page: 'Unplaced One', name: 'Unplaced One', level: '20', zones: ['Najena'] },
  { page: 'Elsewhere One', name: 'Elsewhere One', level: '5', zones: ['Befallen'], loc: [{ ns: 1, ew: 1 }] }
]

/** A page that states a position AND names two zones — the coordinate belongs to one of them. */
const WANDERER: MobEntry = {
  page: 'Wanderer',
  name: 'Wanderer',
  level: '30',
  zones: ['Najena', 'Befallen'],
  loc: [{ ns: 9, ew: 9 }]
}

test('mobRows lists the zone’s mobs, lowest level first, and marks which are placeable', () => {
  const rows = mobRows('Najena', CATALOG)
  assert.deepEqual(
    rows.map((r) => r.name),
    ['Placed One', 'Unplaced One']
  )
  assert.equal(isLocatable(rows[0]), true)
  assert.equal(isLocatable(rows[1]), false, 'a mob with no stated position is LISTED but not placeable')
  assert.deepEqual(rowTarget(rows[0]), { x: -200, y: -100 })
  assert.equal(rowTarget(rows[1]), null)
})

test('isCommonMob is the game’s own article convention, case-insensitive, prefix-anchored', () => {
  assert.equal(isCommonMob('a mummy'), true)
  assert.equal(isCommonMob('an orc pawn'), true)
  assert.equal(isCommonMob('A Chokidai Growler'), true, 'the wiki capitalizes some articles')
  assert.equal(isCommonMob('the ghoul lord'), false, 'lowercase `the` is a classic NAMED spelling')
  assert.equal(isCommonMob('Asaka L`Rei'), false)
  assert.equal(isCommonMob('Arisen Thaumaturgist'), false, '`a`/`an` must be whole words')
  assert.equal(isCommonMob('Anaconda'), false)
})

test('wishedDrops joins on the canonical item key and dedupes upgrade suffixes', () => {
  const entry: MobEntry = {
    page: 'p',
    name: 'n',
    drops: ['Ghoulbane', 'Ghoulbane +1', 'Rusty Sword', 'Cloak of Flames']
  }
  const wished = new Set(['ghoulbane', 'cloak of flames'])
  assert.deepEqual(wishedDrops(entry, wished), ['Ghoulbane', 'Cloak of Flames'])
  assert.deepEqual(wishedDrops(entry, new Set()), [])
  assert.deepEqual(wishedDrops({ page: 'p', name: 'n' }, wished), [])
})

test('mobRows drops common spawns — the map pane is for the mobs worth walking to', () => {
  const common: MobEntry = {
    page: 'A Mummy',
    name: 'a mummy',
    level: '4',
    zones: ['Najena'],
    loc: [{ ns: 5, ew: 5 }]
  }
  const rows = mobRows('Najena', [...CATALOG, common])
  assert.deepEqual(
    rows.map((r) => r.name),
    ['Placed One', 'Unplaced One'],
    'a stated position does not earn a common spawn a row'
  )
})

test('mobRows folds the instance suffix the log prints, so an instance shows the zone’s bestiary', () => {
  assert.equal(mobRows('Najena 4 (Refined)', CATALOG).length, 2)
})

test('a page that names SEVERAL zones is listed but never pinned — the position is unattributable', () => {
  const rows = mobRows('Najena', [...CATALOG, WANDERER])
  const row = rows.find((r) => r.name === 'Wanderer')
  assert.ok(row, 'the mob still appears — it does live here')
  assert.deepEqual(row.pins, [], 'nothing on the page says WHICH zone the coordinate describes')
  assert.equal(row.unattributable, true, 'and the pane must say that, not "no location"')
  assert.equal(row.zoneCount, 2)
  assert.equal(isLocatable(row), false)
  // The honest count follows: it is listed, and it is not placed.
  assert.deepEqual(paneCounts(rows, []), { mobs: 3, located: 1, labels: 0 })
})

const POINT = (over: Partial<MapPoint>): MapPoint => ({
  x: 0,
  y: 0,
  z: 0,
  r: 255,
  g: 0,
  b: 0,
  size: 2,
  label: 'A_Label',
  display: 'A Label',
  layer: 1,
  ...over
})

test('labelRows takes the parser’s points as-is and drops the LEGEND layer', () => {
  const rows = labelRows([
    POINT({ label: 'Bank', display: 'Bank', x: 10, y: 20 }),
    POINT({ label: 'Height_Filter:_25/25', display: 'Height Filter: 25/25', layer: 2 })
  ])
  assert.deepEqual(
    rows.map((r) => r.name),
    ['Bank'],
    'the legend is drawn at off-map coordinates — centring on it would fly outside the zone'
  )
  assert.deepEqual(rowTarget(rows[0]), { x: 10, y: 20 })
  assert.equal(isLocatable(rows[0]), true, 'a map label IS a coordinate; it is always locatable')
})

test('labelRows keeps two same-named points apart (ids carry the position)', () => {
  const rows = labelRows([POINT({ x: 1, y: 2 }), POINT({ x: 3, y: 4 })])
  assert.equal(rows.length, 2)
  assert.notEqual(rows[0].id, rows[1].id)
})

// ---- 4. the filter -----------------------------------------------------------------------

test('filterPaneRows requires EVERY word, and preserves the list’s order', () => {
  const rows = mobRows('Najena', CATALOG)
  assert.deepEqual(
    filterPaneRows(rows, 'one').map((r) => r.name),
    ['Placed One', 'Unplaced One']
  )
  assert.deepEqual(
    filterPaneRows(rows, 'placed one').map((r) => r.name),
    ['Placed One', 'Unplaced One'],
    '"placed" is a substring of "unplaced" — substring-AND, not word-boundary matching'
  )
  assert.deepEqual(filterPaneRows(rows, 'unplaced').map((r) => r.name), ['Unplaced One'])
  assert.deepEqual(filterPaneRows(rows, 'nothing here'), [])
})

test('filterPaneRows treats a blank query as "everything", not "nothing"', () => {
  const rows = mobRows('Najena', CATALOG)
  assert.equal(filterPaneRows(rows, '').length, 2)
  assert.equal(filterPaneRows(rows, '   ').length, 2)
})

test('filterPaneRows matches a mob by the level the page states', () => {
  assert.deepEqual(
    filterPaneRows(mobRows('Najena', CATALOG), '20').map((r) => r.name),
    ['Unplaced One']
  )
})

// ---- 5. the drawn set --------------------------------------------------------------------

function pinRow(id: string, n: number): MobPaneRow {
  return {
    kind: 'mob',
    id,
    name: id,
    pins: Array.from({ length: n }, (_v, i) => ({ x: i, y: i })),
    zoneCount: 1,
    unattributable: false,
    entry: { page: id, name: id },
    searchKey: id
  }
}

test('pinsForRows walks rows in order and reports when it hit the cap', () => {
  const one = pinsForRows([pinRow('a', 2), pinRow('b', 1)])
  assert.equal(one.capped, false)
  assert.deepEqual(
    one.pins.map((p) => p.key),
    ['a#0', 'a#1', 'b#0']
  )
  const capped = pinsForRows([pinRow('a', 5), pinRow('b', 5)], 3)
  assert.equal(capped.capped, true)
  assert.equal(capped.pins.length, 3)
})

test('the cap is a real ceiling, not a suggestion', () => {
  assert.equal(pinsForRows([pinRow('a', MAX_PINS + 50)]).pins.length, MAX_PINS)
})

test('paneCounts separates "listed" from "placeable" — the pane’s whole honesty claim', () => {
  const counts = paneCounts(mobRows('Najena', CATALOG), labelRows([POINT({})]))
  assert.deepEqual(counts, { mobs: 2, located: 1, labels: 1 })
})

// ---- 6. against the REAL committed catalog -----------------------------------------------

test('the shipped catalog states coordinates for most named mobs, and they reach the pane', () => {
  const withLoc = MOB_CATALOG.filter((m) => m.loc?.length)
  // A FLOOR, never today's number (AGENTS.md: frozen numbers rot). Measured 2026-08-04: 6,283 of
  // 7,866 pages state at least one coordinate — four in five.
  assert.ok(
    withLoc.length > MOB_CATALOG.length * 0.6,
    `only ${String(withLoc.length)} of ${String(MOB_CATALOG.length)} catalog rows carry a location`
  )
  for (const m of withLoc.slice(0, 200)) {
    for (const l of m.loc ?? []) {
      assert.ok(Number.isFinite(l.ns) && Number.isFinite(l.ew), `${m.page} has a non-numeric loc`)
      // EQ world coordinates are bounded; a parse that swallowed a drop rate or a page id would
      // land far outside this and put a pin in empty space.
      assert.ok(Math.abs(l.ns) < 25_000 && Math.abs(l.ew) < 25_000, `${m.page} loc is out of world range`)
    }
  }
})

test('a real zone yields a real pane: rows, pins, and an honest placed count', () => {
  const rows = mobRows('Najena', MOB_CATALOG)
  assert.ok(rows.length > 0, 'the catalog knows Najena')
  const counts = paneCounts(rows, [])
  assert.ok(counts.located > 0, 'and states where at least some of them are')
  assert.ok(counts.located <= counts.mobs, 'placed can never exceed listed')
  for (const r of rows) assert.equal(isLocatable(r), r.pins.length > 0)
})
