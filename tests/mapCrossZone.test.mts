// The Maps tab's CROSS-ZONE search (JOS-135) — "where is that, then?", answered from anywhere.
//
// THE REPORT IS THE HEADLINE ASSERTION, and it is checked against the REAL committed catalog and
// the REAL zone table rather than a fixture: standing in High Pass and searching `Tarn Visilin`
// must produce a HIGH KEEP row that lands on the High Keep map at his stated spot. Before this
// wave it produced nothing at all — the pane's mob section is the catalog joined to the zone on
// screen, and its cross-zone section read map-file LABEL text, which no pack spells that name in.
//
// FOUR CLAIMS, in the order they cost something when they break:
//
//   1. THE ANSWER EXISTS AND IT IS PLACED. Name match, zone named, map stem resolved, and the
//      coordinate is `mapFromLoc`'s and nobody else's (the seam every mark in this app goes
//      through — mapGeometry.ts).
//   2. RANK: the zone ON SCREEN never appears here (it is the pane's own two sections), and an
//      exact name beats a prefix beats a substring, across BOTH authorities in one list. A
//      wiki mob and a map label are comparable because `shared/fuzzy` scored both.
//   3. IT REFUSES TO INVENT. A page naming several zones states a position that cannot be
//      attributed to any one of them, so the row opens the zone and points at nothing. A zone
//      spelling the hand-authored table refuses (`Freeport`, `Various`) resolves to NO map, and
//      the row says so under the wiki's own spelling.
//   4. IT NEVER SENDS YOU SOMEWHERE THERE IS NO MAP. A stem no installed pack provides is listed
//      and disabled, not offered as a doorway into an empty picker.
//
// Pure string/arithmetic work over committed data — no React, no DOM, no Electron — so it never
// skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CROSS_ZONE_LIMIT,
  crossZoneRows,
  isReachable,
  jumpTarget,
  searchMobsAcrossZones,
  type CrossZoneRow
} from '../src/renderer/src/features/maps/crossZone'
import { MOB_CATALOG } from '../src/renderer/src/features/mobs/mobSearch'
import { ZONES, zoneShortNameFromCatalog } from '../src/shared/zones'
import type { MapPoint, MapSearchHit } from '../src/shared/maps'
import type { MobEntry } from '../src/shared/types'

/** Every stem the zone table knows, standing in for a machine with a full pack installed. */
const INSTALLED = new Set(ZONES.map((z) => z.short))

function find(rows: readonly CrossZoneRow[], name: string): CrossZoneRow | undefined {
  return rows.find((r) => r.name === name)
}

// ---- 1. the owner's report ------------------------------------------------------------------

test('the report: searching a High Keep NPC while in High Pass answers with High Keep', () => {
  const rows = searchMobsAcrossZones({
    query: 'Tarn Visilin',
    catalog: MOB_CATALOG,
    here: 'highpass',
    installed: INSTALLED
  })
  const row = find(rows, 'Tarn Visilin')
  assert.ok(row, 'the catalog knows him and the search reaches him from another zone')
  assert.equal(row.kind, 'mob')
  assert.equal(row.zone, 'highkeep', 'the row opens the High Keep map')
  assert.equal(row.zoneName, 'High Keep', 'and names the zone in the words a player uses')
  assert.equal(row.note, null, 'his page states one zone and one position, so there is nothing to excuse')
  // `/loc (65, -223)` is map (223, -65): mapX = -ew, mapY = -ns. The ONE seam (mapGeometry.ts).
  assert.deepEqual(row.at, { x: 223, y: -65 })
  assert.deepEqual(jumpTarget(row), { zone: 'highkeep', at: { x: 223, y: -65 } })
  assert.equal(row.score, 1, 'both query tokens matched exactly')
})

test('…and the zone you are STANDING in is never repeated here', () => {
  const here = searchMobsAcrossZones({
    query: 'Tarn Visilin',
    catalog: MOB_CATALOG,
    here: 'highkeep',
    installed: INSTALLED
  })
  assert.equal(find(here, 'Tarn Visilin'), undefined, 'that row is the pane’s own "Named mobs" section')
})

// ---- 2. ranking, across both authorities -----------------------------------------------------

const CATALOG: MobEntry[] = [
  { page: 'Exact', name: 'Visilin', level: '45', zones: ['High Keep'], loc: [{ ns: 1, ew: 2 }] },
  { page: 'Prefix', name: 'Visilinius', zones: ['High Keep'], loc: [{ ns: 3, ew: 4 }] },
  // Substring WITHIN a token: `the Visilin Guard` would not be one — the scorer works per token,
  // so a whole word sitting in a longer name is an EXACT match and ranks like one.
  { page: 'Substring', name: 'Provisilin', zones: ['High Keep'], loc: [{ ns: 5, ew: 6 }] },
  { page: 'Elsewhere', name: 'Visilin', zones: ['Befallen'] }
]

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

test('exact beats prefix beats substring, and the ordering is the scorer’s, not the list’s', () => {
  const rows = searchMobsAcrossZones({
    query: 'visilin',
    catalog: CATALOG,
    here: null,
    installed: INSTALLED
  })
  assert.deepEqual(
    rows.map((r) => r.name),
    ['Visilin', 'Visilin', 'Visilinius', 'Provisilin']
  )
  assert.ok(rows[0].score > rows[2].score && rows[2].score > rows[3].score)
})

test('a map label and a wiki mob land in ONE ranked list, comparable because one scorer scored both', () => {
  const hits: MapSearchHit[] = [
    { zone: 'befallen', point: POINT({ label: 'Visilin', display: 'Visilin' }), score: 1 },
    { zone: 'befallen', point: POINT({ label: 'Visilin_Road', display: 'Visilin Road', x: 9 }), score: 0.5 }
  ]
  const rows = crossZoneRows({
    query: 'visilin',
    catalog: CATALOG,
    hits,
    here: null,
    installed: INSTALLED
  })
  // The two exact matches (one label, one mob) sit above every weaker row, whichever list they
  // arrived in — which is the whole reason the two halves are merged rather than stacked.
  assert.equal(rows[0].score, 1)
  assert.equal(rows[1].score, 1)
  assert.deepEqual(new Set([rows[0].kind, rows[1].kind]), new Set(['mob', 'label']))
  assert.ok(rows.some((r) => r.name === 'Visilin Road'))
})

test('crossZoneRows drops the zone on screen from BOTH halves at once', () => {
  const hits: MapSearchHit[] = [
    { zone: 'highkeep', point: POINT({ display: 'Visilin' }), score: 1 },
    { zone: 'befallen', point: POINT({ display: 'Visilin' }), score: 1 }
  ]
  const rows = crossZoneRows({
    query: 'visilin',
    catalog: CATALOG,
    hits,
    here: 'highkeep',
    installed: INSTALLED
  })
  assert.deepEqual(new Set(rows.map((r) => r.zone)), new Set(['befallen']))
})

test('a blank query answers nothing at all — never the whole world', () => {
  assert.deepEqual(
    searchMobsAcrossZones({ query: '   ', catalog: CATALOG, here: null, installed: INSTALLED }),
    []
  )
  assert.deepEqual(
    crossZoneRows({ query: '', catalog: CATALOG, hits: [], here: null, installed: INSTALLED }),
    []
  )
})

test('the list is capped, and the cap is a real ceiling', () => {
  const rows = crossZoneRows({
    query: 'a',
    catalog: MOB_CATALOG,
    hits: [],
    here: null,
    installed: INSTALLED,
    limit: 5
  })
  assert.equal(rows.length, 5)
  assert.ok(CROSS_ZONE_LIMIT > 0)
})

// ---- 3. what it refuses to invent -------------------------------------------------------------

test('a page that names SEVERAL zones opens each of them and points at none', () => {
  const wanderer: MobEntry = {
    page: 'Wanderer',
    name: 'a wanderer',
    zones: ['High Keep', 'Befallen'],
    loc: [{ ns: 9, ew: 9 }]
  }
  const rows = searchMobsAcrossZones({
    query: 'wanderer',
    catalog: [wanderer],
    here: null,
    installed: INSTALLED
  })
  assert.deepEqual(rows.map((r) => r.zone).sort(), ['befallen', 'highkeep'])
  for (const row of rows) {
    assert.equal(row.at, null, 'nothing on the page says WHICH zone the coordinate describes')
    assert.equal(row.note, 'position stated, but the page lists 2 zones')
    assert.ok(isReachable(row), 'the zone itself is still a real answer, so the row still opens it')
    assert.deepEqual(jumpTarget(row), { zone: row.zone, at: null })
  }
})

test('a page that states no position is LISTED, opens its zone, and says so', () => {
  const rows = searchMobsAcrossZones({
    query: 'quiet one',
    catalog: [{ page: 'Quiet', name: 'a quiet one', zones: ['Befallen'] }],
    here: null,
    installed: INSTALLED
  })
  assert.equal(rows[0].zone, 'befallen')
  assert.equal(rows[0].at, null)
  assert.equal(rows[0].note, 'no location on the wiki page')
})

test('a zone spelling the table refuses resolves to NO map, under the wiki’s own words', () => {
  // `Freeport` is deliberately unclaimed: the catalog also carries East and West Freeport, and a
  // nearest-name match would serve one city's bestiary for the other (zones.ts, law 1).
  assert.equal(zoneShortNameFromCatalog('Freeport'), null)
  const rows = searchMobsAcrossZones({
    query: 'ambiguous one',
    catalog: [{ page: 'Amb', name: 'an ambiguous one', zones: ['Freeport'] }],
    here: null,
    installed: INSTALLED
  })
  assert.equal(rows[0].zone, null)
  assert.equal(rows[0].zoneName, 'Freeport', 'stated as the wiki spells it, never as a guessed stem')
  assert.equal(rows[0].note, 'no map is named that')
  assert.equal(isReachable(rows[0]), false)
  assert.equal(jumpTarget(rows[0]), null)
})

test('the catalog’s own zone spellings resolve where the table verified them, and only there', () => {
  // The nine the fold cannot reach — knowledge, not a string rule (zones.ts `mobCatalogNames`).
  assert.equal(zoneShortNameFromCatalog('EC'), 'ecommons')
  assert.equal(zoneShortNameFromCatalog('Lower Guk'), 'gukbottom')
  assert.equal(zoneShortNameFromCatalog('The Hole'), 'hole')
  // …and the ones it plainly can, through the ordinary name/alias index.
  assert.equal(zoneShortNameFromCatalog('High Keep'), 'highkeep')
  assert.equal(zoneShortNameFromCatalog('The Feerrott'), 'feerrott')
  // Dirt stays dirt: a run-together wiki table cell is not a zone name and is never split.
  assert.equal(zoneShortNameFromCatalog('Everfrost PeaksLake Rathetear'), null)
  assert.equal(zoneShortNameFromCatalog(''), null)
  assert.equal(zoneShortNameFromCatalog(undefined), null)
})

// ---- 4. no doorway into an empty picker -------------------------------------------------------

test('a zone no installed pack provides is listed and disabled, never offered as a doorway', () => {
  const rows = searchMobsAcrossZones({
    query: 'visilin',
    catalog: CATALOG,
    here: null,
    installed: new Set(['befallen'])
  })
  const keep = rows.filter((r) => r.zoneName === 'High Keep')
  assert.ok(keep.length > 0, 'the answer is still shown — the mob does live there')
  for (const row of keep) {
    assert.equal(row.zone, null)
    assert.equal(row.note, 'no map installed for this zone')
    assert.equal(isReachable(row), false)
  }
  // …and the reachable ones sort ahead of the dead ones at equal score.
  assert.ok(isReachable(rows[0]))
})

test('an EMPTY installed list means "not known yet", never "nothing is installed"', () => {
  // The pack listing lands a beat after the first render; disabling every row in the meantime
  // would make the section briefly, and wrongly, useless.
  const rows = searchMobsAcrossZones({
    query: 'visilin',
    catalog: CATALOG,
    here: null,
    installed: new Set()
  })
  assert.ok(rows.every(isReachable))
})

// ---- against the REAL catalog -----------------------------------------------------------------

test('the shipped catalog is reachable across zones: most rows resolve to a real map stem', () => {
  let reachable = 0
  for (const m of MOB_CATALOG) {
    if ((m.zones ?? []).some((z) => zoneShortNameFromCatalog(z) != null)) reachable += 1
  }
  // A FLOOR, never today's number (AGENTS.md: frozen numbers rot). Measured 2026-08-09: 7,806 of
  // 7,872 rows name at least one zone the table can point at.
  assert.ok(
    reachable > MOB_CATALOG.length * 0.9,
    `only ${String(reachable)} of ${String(MOB_CATALOG.length)} catalog rows name a resolvable zone`
  )
})

test('every row the real corpus produces is internally consistent', () => {
  const rows = searchMobsAcrossZones({
    query: 'ambassador',
    catalog: MOB_CATALOG,
    here: null,
    installed: INSTALLED
  })
  assert.ok(rows.length > 0)
  for (const row of rows) {
    assert.equal(row.kind, 'mob')
    assert.ok(row.zoneName.length > 0, 'a row always names the zone it is talking about')
    // A position is only ever offered when there is a map to put it on.
    if (row.at != null) assert.notEqual(row.zone, null)
    // And a row that can do both owes the reader no excuse.
    if (row.zone != null && row.at != null) assert.equal(row.note, null)
  }
})
