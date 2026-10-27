// THE ZONE GRAPH, read off the client's own map files (owner ask, kaltinril 2026-09-11).
//
// The ask was "show the closest druid, wizard, boat, or item port", and the first answer it got was
// that this repo has no zone graph and could not know that Befallen touches West Commons. The owner
// pushed back - *"i mean, the zones should know what they connect to do they not?"* - and he was
// right: the map files label their own zone lines, and this app already parses them into
// `MapData.points`.
//
//     P -31.9430, 75.5264, -0.8014, 150, 0, 200, 3, to_West_Commonlands     (befallen_1.txt)
//
// The fixtures below are label shapes taken verbatim from the default pack. The corpus half needs
// the player's own install and skips without it, exactly as `resistBaseline` and
// `stackGroundTruth` do - map files are Daybreak's and are never committed.

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import {
  landings,
  nearestPorts,
  travelSeams,
  zoneExits,
  zoneInEraAt,
  type ZoneGraph,
  type ZonePort
} from '../src/shared/zoneTravel'
import { ERA_ORDER } from '../src/shared/planner/era'
import { parseMapText } from '../src/main/maps/parseMap'
import { splitMapFileName } from '../src/main/maps/packs'
import type { MapPoint } from '../src/shared/maps'

function point(label: string): MapPoint {
  return { x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, size: 1, label, display: label.replace(/_/g, ' '), layer: 1 }
}

test('a to_ label is a walk, and it folds onto the catalog`s own zone', () => {
  // befallen_1.txt, verbatim - the owner's example.
  const exits = zoneExits([point('to_West_Commonlands')])
  assert.equal(exits.length, 1)
  assert.equal(exits[0].kind, 'walk')
  assert.equal(exits[0].name, 'West Commonlands')
  assert.equal(exits[0].label, 'to_West_Commonlands', 'the map`s own words survive for display')
})

test('a dock crossing is a translocator, and a destination the catalog lacks is not invented', () => {
  const exits = zoneExits([point("to_Erud's_Crossing_or_Freeport_(boat_or_translocator)")])
  // Legends has no boats - translocator NPCs stand at the docks (owner, 2026-09-11). The map file
  // still prints the old word and nothing this app draws repeats it.
  assert.equal(exits[0].kind, 'translocator', 'the client says which crossings are not walks')
  assert.equal(exits[0].name, "Erud's Crossing")
  // AND ONLY ONE EXIT, because the catalog has no plain `Freeport` - it has East, West and North.
  // The boat really does land in East Freeport and mapping it there would be a GUESS (law 12), so
  // the half that resolves is kept and the half that does not is dropped. Nothing is lost to the
  // reader: `label` carries the client's own words, and the surface shows them.
  assert.equal(exits.length, 1)
  assert.match(exits[0].label, /Freeport/, 'the map`s own wording still reaches the surface')
})

test('a _Portal label is a portal, and an unknown destination is dropped rather than guessed', () => {
  assert.equal(zoneExits([point('Ak`Anon_Portal')])[0]?.kind, 'portal')
  // The packs carry guild halls, merchants and non-classic destinations under the same shapes.
  // A label the catalog cannot name yields NOTHING (law 12: no fuzzy joins).
  assert.deepEqual(zoneExits([point('to_The_Bazaar_Merchant')]), [])
  assert.deepEqual(zoneExits([point('Bank')]), [])
})

test('both ends of a seam are one exit, not two', () => {
  // Zone lines are labelled at both ends of the seam and often on two layers.
  const exits = zoneExits([point('to_West_Commonlands'), point('to_West_Commonlands')])
  assert.equal(exits.length, 1)
})

// ---- the real pack ---------------------------------------------------------------------------

const MAPS =
  process.env.EQ_MAPS ??
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/maps'
const skip = !existsSync(MAPS) && 'no client maps directory'

test('the default pack states a usable graph, and Befallen leads to West Commons', { skip }, () => {
  const byZone = new Map<string, ReturnType<typeof zoneExits>>()
  let files = 0
  for (const name of readdirSync(MAPS)) {
    const split = splitMapFileName(name)
    if (!split) continue
    files++
    const parsed = parseMapText(readFileSync(`${MAPS}/${name}`, 'latin1'), split.layer)
    const exits = zoneExits(parsed.points)
    if (exits.length === 0) continue
    const held = byZone.get(split.stem) ?? []
    for (const e of exits) {
      if (!held.some((h) => h.zone === e.zone && h.kind === e.kind)) held.push(e)
    }
    byZone.set(split.stem, held)
  }
  // The census, so a pack that changes shape is visible rather than silently thinner. Measured
  // 2026-09-11 on the owner's install: 213 files, 90 zones, 204 edges.
  assert.ok(files > 200, `expected the default pack, saw ${String(files)} files`)
  assert.ok(byZone.size >= 80, `expected a usable graph, saw ${String(byZone.size)} zones`)

  // The ask, verbatim.
  const befallen = byZone.get('befallen') ?? []
  assert.deepEqual(befallen.map((e) => e.name), ['West Commonlands'])

  // A zone with several exits, all of them true of the game.
  const faydark = new Set((byZone.get('gfaydark') ?? []).map((e) => e.name))
  for (const z of ['Butcherblock Mountains', 'Clan Crushbone', 'The Lesser Faydark', 'North Felwithe']) {
    assert.ok(faydark.has(z), `Greater Faydark should state ${z}`)
  }
})

// ---- the nearest port, through the whole graph (owner, 2026-09-12) ----------------------------
//
// *"even if you can't, it should show the closest zone that has a port right?"* - and, standing in
// West Freeport: *"freeport doesn't seem to give that you can come from west commons or nektulos
// forest, OR, from the islands via the dock NPC port"*. Those are two-hop answers and a dock
// crossing, and the one-hop first version could not give any of them.


function port(zone: string, spell: string, level?: number): ZonePort {
  return {
    zone,
    zoneName: zone,
    via: level === undefined ? 'item' : 'druid',
    spell,
    ...(level === undefined ? { item: `${spell} charm` } : { level }),
    group: false
  }
}

/** befallen -> commons -> ecommons -> freportw, labelled from the west only. */
const CHAIN: ZoneGraph = new Map([
  ['befallen', [{ kind: 'walk', zone: 'commons', name: 'West Commonlands', label: 'to_West_Commonlands' }]],
  ['commons', [{ kind: 'walk', zone: 'ecommons', name: 'East Commonlands', label: 'to_East_Commonlands' }]],
  ['ecommons', [{ kind: 'walk', zone: 'freportw', name: 'West Freeport', label: 'to_West_Freeport' }]]
])
const COMMONS_PORTS = [port('commons', 'Circle of Commons', 29), port('commons', 'Ring of Commons', 19)]

test('a port landing where you stand has no walk, and the cheapest cast leads', () => {
  const routes = nearestPorts(CHAIN, COMMONS_PORTS, 'commons')
  assert.deepEqual(routes.map((r) => r.port.spell), ['Ring of Commons', 'Circle of Commons'])
  assert.deepEqual(routes[0].path, [], '"lands here" - the owner`s West Commons case')
})

test('closest means a search, not one hop: Freeport reaches the Commons port two seams away', () => {
  // The chain is labelled west-to-east only; the reverse edges the search adds are what let
  // Freeport find a port that no map east of Commons ever names.
  const routes = nearestPorts(CHAIN, COMMONS_PORTS, 'freportw')
  assert.equal(routes.length, 2)
  assert.deepEqual(
    routes[0].path.map((s) => s.zone),
    ['ecommons', 'freportw'],
    'the walk after landing, in order, ending where you are'
  )
  assert.deepEqual(routes[0].path.map((s) => s.kind), ['walk', 'walk'])
})

test('the walk names each zone it enters through the catalog, not the label', () => {
  const [route] = nearestPorts(CHAIN, [port('commons', 'Ring of Commons', 19)], 'befallen')
  assert.deepEqual(route.path, [{ zone: 'befallen', name: 'Befallen', kind: 'walk' }])
})

test('the search is bounded, and says nothing past the bound', () => {
  const far: ZoneGraph = new Map([
    ['a', [{ kind: 'walk', zone: 'b', name: 'b', label: 'to_b' }]],
    ['b', [{ kind: 'walk', zone: 'c', name: 'c', label: 'to_c' }]],
    ['c', [{ kind: 'walk', zone: 'd', name: 'd', label: 'to_d' }]]
  ])
  const at_d = [port('d', 'Far Gate', 1)]
  // Invented stems are not in the catalog and so not in any era: this test is about the BOUND, so
  // it lifts the gate the way a reader would to see the pack's own graph.
  assert.equal(nearestPorts(far, at_d, 'a', { maxHops: 3, eraOnly: false }).length, 1, 'three hops away, reachable at three')
  assert.equal(nearestPorts(far, at_d, 'a', { maxHops: 2, eraOnly: false }).length, 0, 'and not at two - no guessing past the bound')
})

test('a port is offered once, through its nearest landing, and a dock crossing keeps its kind', () => {
  const two: ZoneGraph = new Map([
    ['isle', [{ kind: 'translocator', zone: 'freporte', name: 'East Freeport', label: 'to_Freeport_(boat_or_translocator)' }]],
    ['freporte', [{ kind: 'walk', zone: 'freportw', name: 'West Freeport', label: 'to_West_Freeport' }]]
  ])
  // `isle` is invented (not in the catalog, so not in any era); the test is about the KIND.
  const routes = nearestPorts(two, [port('isle', 'Isle Gate', 5)], 'freportw', { eraOnly: false })
  assert.equal(routes.length, 1)
  assert.deepEqual(routes[0].path.map((s) => s.kind), ['translocator', 'walk'], 'the dock NPC that replaced the boat')
})

// ---- one line per landing zone (owner, 2026-09-12) --------------------------------------------
//
// *"if there is a SOLO and GROUP port and alternate class, combine them to 1 line ... the point is
// to show the top 2-3 closest zones that you can port into"*.


test('every port into one zone folds onto one line, nearest zone first, cheapest cast first', () => {
  const routes = nearestPorts(
    CHAIN,
    [
      port('commons', 'Circle of Commons', 29),
      port('commons', 'Ring of Commons', 19),
      { ...port('commons', 'Common Gate', 24), via: 'wizard' },
      port('commons', 'Ring of Commons'),
      port('befallen', 'Befallen Gate', 40)
    ],
    'befallen'
  )
  const lines = landings(routes)
  assert.deepEqual(lines.map((l) => l.zone), ['befallen', 'commons'], 'here first, then one hop')
  const commons = lines[1]
  assert.deepEqual(commons.druid.map((p) => p.level), [19, 29], 'druid casts, cheapest first')
  assert.deepEqual(commons.wizard.map((p) => p.spell), ['Common Gate'])
  assert.equal(commons.items.length, 1, 'the item click lands here too')
  assert.deepEqual(commons.path.map((s) => s.zone), ['befallen'], 'the walk, stated once for the zone')
  assert.deepEqual(lines[0].path, [], 'and none for where you stand')
})

// ---- the era gate (owner, 2026-09-12) ---------------------------------------------------------
//
// "plane of knowledge doesn't exist in this era of EverQuest Legends yet ... so we need a limit
// to era that's on by default". The pack ships PoK's map and its portals; the graph found a route
// through it. zones.ts gives PoK no era at all, on purpose, and a recommender does not send
// anyone through a zone it cannot place in the game.

test('a route never passes through, or lands in, a zone the era does not have - unless asked', () => {
  // befallen -> PoK -> gfaydark, the only way stated; a port lands in gfaydark.
  const viaPok: ZoneGraph = new Map([
    ['befallen', [{ kind: 'portal', zone: 'poknowledge', name: 'Plane of Knowledge', label: 'Knowledge_Portal' }]],
    ['poknowledge', [{ kind: 'portal', zone: 'gfaydark', name: 'The Greater Faydark', label: 'Kelethin_Portal' }]]
  ])
  const fay = [port('gfaydark', 'Fay Gate', 20)]
  assert.deepEqual(nearestPorts(viaPok, fay, 'befallen'), [], 'on by default: no way through PoK')
  const lifted = nearestPorts(viaPok, fay, 'befallen', { eraOnly: false })
  assert.equal(lifted.length, 1, 'lifted, the pack\'s own route shows')
  assert.deepEqual(lifted[0].path.map((s) => s.zone), ['poknowledge', 'befallen'])
  // ...and a port that LANDS in a zone the era lacks is not offered either.
  assert.deepEqual(nearestPorts(new Map(), [port('poknowledge', 'Knowledge Gate', 1)], 'poknowledge'), [])
})

test('the dock crossings on the card are gated the same way', () => {
  // The catalog names it "Plane of Knowledge"; the pack's bare `Knowledge_Portal` never resolves to
  // a zone at all (and is not how PoK reached a route - its OWN map's exits did that).
  const exits = zoneExits([point('Plane_of_Knowledge_Portal'), point("to_Erud's_Crossing_(boat_or_translocator)")])
  assert.deepEqual(travelSeams(exits).map((e) => e.zone), ['erudsxing'], 'the PoK portal is not a ride you can take')
  assert.equal(travelSeams(exits, false).length, 2, 'lifted, it is listed')
})

test('a portal_to_ label is a portal - East Freeport`s spire to the Plane of Sky (2026-09-23)', () => {
  // freporte_1.txt (default pack), verbatim: the third portal spelling the packs use.
  const exits = zoneExits([point('portal_to_The_Plane_of_Sky_(click)')])
  assert.equal(exits.length, 1)
  assert.equal(exits[0].kind, 'portal')
  assert.equal(exits[0].zone, 'airplane')
  // oasis_1.txt (default pack): the click into Hate is a plain to_ with a parenthetical.
  assert.equal(zoneExits([point('to_The_Plane_of_Hate_(click)')])[0]?.zone, 'hateplane')
})

test('a (click) entrance is one-way: the route never walks back out through it (2026-10-01)', () => {
  // oasis_1.txt states the click into Hate; Hate's map states no way back. A port into Hate is
  // no way to reach Oasis, and Hate still finds Oasis's ports through the stated direction.
  const graph: ZoneGraph = new Map([
    ['oasis', [{ kind: 'walk', zone: 'hateplane', name: 'The Plane of Hate', label: 'to_The_Plane_of_Hate_(click)' }]]
  ])
  const ports = [port('hateplane', 'Hate Gate', 30), port('oasis', 'Oasis Gate', 20)]
  const fromOasis = nearestPorts(graph, ports, 'oasis', { eraOnly: false })
  assert.deepEqual(fromOasis.map((r) => r.port.zone), ['oasis'], 'no route lands in Hate and walks out to Oasis')
  const fromHate = nearestPorts(graph, ports, 'hateplane', { eraOnly: false })
  assert.deepEqual(
    fromHate.map((r) => `${r.port.zone}:${r.path.map((s) => s.zone).join('>')}`),
    ['hateplane:', 'oasis:hateplane'],
    'Hate still shows the Oasis port, through the click'
  )
})

test('the era gate ranks eras by the planner`s ERA_ORDER, Luclin included', () => {
  // A private copy of the ordering stopped at Velious, so a current era of Luclin ranked nothing
  // and every zone, classic ones included, read as out of era.
  const commons = { short: 'ecommons', name: 'East Commonlands', era: 'classic' } as const
  for (const era of ERA_ORDER) assert.equal(zoneInEraAt(commons, era), true, `classic is in ${era}`)
  const kael = { short: 'kael', name: 'Kael Drakkel', era: 'velious' } as const
  assert.equal(zoneInEraAt(kael, 'luclin'), true)
  assert.equal(zoneInEraAt(kael, 'kunark'), false)
  assert.equal(zoneInEraAt({ short: 'poknowledge', name: 'The Plane of Knowledge' }, 'luclin'), false)
})
