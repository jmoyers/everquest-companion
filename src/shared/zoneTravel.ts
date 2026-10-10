// zoneTravel.ts — WHERE YOU CAN GET TO FROM HERE, read off the map the player already has.
//
// Owner ask (kaltinril 2026-09-11): *"could we update the maps section so that it shows the closest
// druid, wizard, boat, or item port? so if i'm on say befallen map, it should show the druid port to
// west commons as an example"*.
//
// ── THE ZONE GRAPH WAS ALREADY ON DISK, AND I SAID IT WAS NOT ────────────────────────────────
//
// The first answer to that ask was that this repo has no zone graph - `ZoneEntry` is
// `{ short, name, era }` and nothing states what touches what - so "closest" could not be answered
// without either a hand-authored table or a scrape. The owner pushed back: *"i mean, the zones
// should know what they connect to do they not?"*. He was right, and the data is in the last place
// a feature about maps should have had to look for it: THE MAP FILES.
//
//     P -31.9430, 75.5264, -0.8014, 150, 0, 200, 3, to_West_Commonlands     (befallen_1.txt)
//
// That is his exact example, stated by the client, in a file this app already parses into
// `MapData.points`. MEASURED over the default pack: 213 map files, 93 carrying at least one
// labelled zone line, 66 distinct destinations - and the boats name themselves
// (`to_Erud's_Crossing_or_Freeport_(boat_or_translocator)`), which is the other half of the ask.
//
// SO THIS MODULE READS POINTS AND NOTHING ELSE. No new file access, no network, no committed
// table: the exits of a zone are whatever the map of that zone says they are, which is also the
// honest bound on the answer. A pack whose author never labelled the zone lines yields nothing
// here, and the surface says so rather than inventing an edge.
//
// ── WHAT IS NOT DECIDED HERE ─────────────────────────────────────────────────────────────────
//
// Which PORTS land in a zone is a different question with a different witness - the spell corpus
// and the item corpus - and it lives in `main/zonePorts.ts`. This module answers only "what does
// this map say you can walk, sail or step to", and the two are joined at the surface.

import { ZONES, zoneEntryFor, type ZoneEntry } from './zones'
import { CURRENT_ERA, eraRank, type Era } from './planner/era'
import type { MapPoint, ZoneShort } from './maps'

/** How the map says you make this crossing. */
export type ExitKind = 'walk' | 'translocator' | 'portal'

/**
 * IS THIS ZONE IN THE GAME YET — the era gate every route runs through by default.
 *
 * Owner (2026-09-12), reading a route "via Plane of Knowledge": *"plane of knowledge doesn't exist
 * in this era of EverQuest Legends yet ... so we need a limit to era that's on by default"*. The
 * map pack ships every zone the client has ever had, PoK's portals included, and a graph that
 * walks them finds shortcuts through content nobody can stand in.
 *
 * `zones.ts` states each zone's era, or DELIBERATELY none - and the header there says which zones
 * carry none: the ones that postdate the three eras (PoK, the Bazaar, the Nexus) and the one EQL
 * expedition. Downstream, an unstated era reads as UNKNOWN, never as out-of-era, and that is the
 * right law for a filter that must not cry wolf. THIS IS A RECOMMENDER, and a recommender must not
 * offer what it cannot verify (`planner/rules.ts` states the same split for socket advice): an
 * unstated era is not a zone anybody is being sent through. So both halves are gated - a stated
 * era at or before `CURRENT_ERA` passes, anything else does not.
 */
export function zoneInEra(entry: ZoneEntry): boolean {
  return zoneInEraAt(entry, CURRENT_ERA)
}

/**
 * The gate at a given era. The ranks are the planner's `eraRank`, so the release order is stated
 * once: a private copy that stopped at Velious would rank a Luclin current era as nothing and shut
 * every zone out.
 */
export function zoneInEraAt(entry: ZoneEntry, era: Era): boolean {
  return entry.era !== undefined && eraRank(entry.era) <= eraRank(era)
}

/** One way out of the zone whose map this is. */
export interface ZoneExit {
  kind: ExitKind
  /** the destination's map stem, folded through `zones.ts` - the join key for everything else */
  zone: ZoneShort
  /** the destination's display name, as `zones.ts` spells it */
  name: string
  /** the point's RAW label, so a surface can show the map's own words (law 2) */
  label: string
}

/**
 * WHO TAKES YOU THERE — a port's witness, as opposed to an exit's.
 *
 * The TYPES live here beside `ZoneExit` and the DERIVATION lives in `main/zonePorts.ts`, because
 * the two corpora it reads (`spells.json`, and the 8.6 MB `items.json`) are main's. Preload
 * carries the shape across the wire and must never import the module that builds it.
 */
export type PortVia = 'druid' | 'wizard' | 'item'

/** One way to arrive in one zone by magic — the port half of `ZoneExit`'s walk/boat/portal half. */
export interface ZonePort {
  /** the destination's map stem — the same join key `ZoneExit.zone` carries */
  zone: ZoneShort
  /** the destination's display name, as `zones.ts` spells it */
  zoneName: string
  via: PortVia
  /** the spell's own name, whether cast or clicked */
  spell: string
  /** the caster level the class line states; absent on an item port, which needs none */
  level?: number
  /** the item you click, by its PAGE TITLE (not the corpus key), on an item port only */
  item?: string
  /** true when the spell takes the whole group rather than only the caster */
  group: boolean
}

/**
 * The parenthetical the client uses when a crossing is not a walk. Measured: every non-walk `to_`
 * label in the default pack carries `(boat_or_translocator)`, and no other parenthetical appears.
 *
 * THE CLIENT'S OWN HEDGE IS THE ANSWER. The label offers both words because the maps predate the
 * change; the owner settled which one Legends uses (2026-09-11): *"there are no boats, there are
 * teleport NPCs at the docks now"*. So the pattern still matches the boat spelling - that is what
 * the file says - and nothing this app draws calls it a boat.
 */
const DOCK = /\(.*(boat|translocat|ferry).*\)/i

/**
 * `to_West_Commonlands` → `West Commonlands`, and
 * `to_Erud's_Crossing_or_Freeport_(boat_or_translocator)` → `Erud's Crossing`, `Freeport`.
 *
 * THE `_or_` FORM NAMES TWO REAL DESTINATIONS, not an uncertainty - one dock, two runs - so both
 * are returned and the caller decides. Splitting on it is safe because no zone in the catalog
 * contains the word `or` as its own space-delimited token (checked against `ZONES`).
 *
 * BOTH CANDIDATES STILL HAVE TO NAME A ZONE. `Freeport` above does not - the catalog has East,
 * West and North and no plain one - so that half is dropped upstream and only Erud's Crossing
 * becomes an exit. The boat does land in East Freeport and saying so here would be a guess; the
 * raw label rides on the exit instead, so the reader still sees the client's own wording.
 */
function destinationsOf(raw: string): string[] {
  // THE BACKTICK IS THE CLIENT'S APOSTROPHE. Map labels write `Ak`Anon_Portal` and the zone
  // catalog writes `Ak'Anon`; measured, the fold rejects the backtick form outright. One
  // punctuation swap between two witnesses, not a fuzzy match - the letters have to agree.
  const words = raw.replace(/_/g, ' ').replace(/`/g, "'").replace(/\(.*\)/g, '').trim()
  return words
    .split(/\s+or\s+/i)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/**
 * A ZONE OUT OF ANY CORPUS TOKEN — the one door both travel witnesses knock on.
 *
 * They speak different dialects and neither is wrong. Map labels write DISPLAY names
 * (`to_West_Commonlands`), which `zoneEntryFor` already folds. The spell corpus writes MAP STEMS
 * (`Teleport to 478,1427,-48 in commons`), which it does not - measured, 46 of the 50 stated
 * teleport destinations fell on the floor until this existed.
 *
 * A TRAILING CLAUSE IS TRIMMED, once. The corpus carries `thurgadinb facing North`: a stem plus a
 * direction, which is a fact about where you arrive rather than about which zone. Only the first
 * token is retried, and only after the whole string has failed, so nothing that resolves whole is
 * ever re-read.
 *
 * NULL IS A REAL ANSWER and the common one for the tokens neither corpus means as a zone.
 */
export function resolveZone(raw: string): ZoneEntry | null {
  const token = raw.trim()
  if (token === '') return null
  const named = zoneEntryFor(token)
  if (named !== null) return named
  const lower = token.toLowerCase()
  const stem = ZONES.find((z) => z.short === lower)
  if (stem !== undefined) return stem
  const head = lower.split(/\s+/)[0]
  return head === lower ? null : (ZONES.find((z) => z.short === head) ?? null)
}

/**
 * The three label shapes that state a crossing, and which kind each is:
 *   `to_West_Commonlands` (a walk, or a translocator when the DOCK parenthetical is on it),
 *   `Ak`Anon_Portal` (a portal), and
 *   `portal_to_The_Plane_of_Sky_(click)` (a portal - East Freeport's spire, in the default pack's
 *   own words, 2026-09-23).
 * Null when the label is none of these.
 */
function crossingOf(raw: string): { body: string; kind: ExitKind } | null {
  const portalTo = /^portal[_\s]+to[_\s]+(.+)$/i.exec(raw)
  if (portalTo !== null) return { body: portalTo[1], kind: 'portal' }
  const to = /^to[_\s]+(.+)$/i.exec(raw)
  if (to !== null) return { body: to[1], kind: DOCK.test(raw) ? 'translocator' : 'walk' }
  const portal = /^(.+?)[_\s]+portal$/i.exec(raw)
  if (portal !== null) return { body: portal[1], kind: 'portal' }
  return null
}

/** One point, as zero or more exits — zero when its label is not a crossing, or names no zone. */
function exitsOfPoint(point: MapPoint): ZoneExit[] {
  const raw = point.label.trim()
  const crossing = crossingOf(raw)
  if (crossing === null) return []
  const { body, kind } = crossing
  const out: ZoneExit[] = []
  for (const candidate of destinationsOf(body)) {
    // A label naming something the catalog does not know is DROPPED rather than guessed at: the
    // packs carry guild halls, merchants and non-classic destinations under the same shapes, and
    // inventing a zone from a label is exactly the fuzzy join law 12 refuses.
    const entry = resolveZone(candidate)
    if (entry === null) continue
    out.push({ kind, zone: entry.short, name: entry.name, label: raw })
  }
  return out
}

/**
 * EVERY EXIT THIS MAP STATES, deduped by (destination, kind) and in the map's own point order.
 *
 * Deduped because a zone line is usually labelled at BOTH ends of the seam and sometimes on two
 * layers, and a panel listing "West Commonlands" three times reads as three exits.
 */
export function zoneExits(points: readonly MapPoint[]): ZoneExit[] {
  const out: ZoneExit[] = []
  const seen = new Set<string>()
  for (const point of points) {
    for (const exit of exitsOfPoint(point)) {
      const key = `${exit.kind}|${exit.zone}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(exit)
    }
  }
  return out
}

/**
 * THE SEAMS THAT ARE THEMSELVES TRAVEL — boats and portals, out of a zone's exits.
 *
 * The owner's ask named four ways in and one of them is not a spell: *"the closest druid, wizard,
 * boat, or item port"*. In EQ Legends that crossing is a TRANSLOCATOR NPC standing at the dock
 * rather than a boat you ride (owner, 2026-09-11) - the map files still print the old word, and
 * this app does not. A WALK is not in here: every zone touches something on foot, and listing
 * those would bury the crossings that matter under the ordinary.
 *
 * READ BOTH WAYS ON PURPOSE. The map states the dock as a way OUT; a translocator at a dock takes
 * you either direction, so the surface draws these as arrivals too.
 *
 * It lives here rather than in the view because ruling 4 is exactly about this: the renderer is
 * handed collections already filtered, never a corpus to sift.
 */
export function travelSeams(exits: readonly ZoneExit[], eraOnly = true): ZoneExit[] {
  const out: ZoneExit[] = []
  for (const exit of exits) {
    if (exit.kind === 'walk') continue
    if (eraOnly && !inEra(exit.zone)) continue
    out.push(exit)
  }
  return out
}

/** The era gate by stem, for the search - a stem the catalog cannot name is out too. */
function inEra(zone: ZoneShort): boolean {
  const entry = resolveZone(zone)
  return entry !== null && zoneInEra(entry)
}

// ---- the whole graph, and the nearest port through it ----------------------------------------
//
// Owner (2026-09-12), on a zone with no port and no ported neighbour: *"even if you can't, it
// should show the closest zone that has a port right?"*. Right. One hop was the first version's
// bound because it read only the map on screen; the answer to "closest" is a search over every
// map's labels, which main builds once (`main/zoneGraph.ts`) and this walks.

/** Every zone's stated exits, keyed by stem — what `main/zoneGraph.ts` ships once per window. */
export type ZoneGraph = ReadonlyMap<ZoneShort, readonly ZoneExit[]>

/** One zone entered on the way from a port's landing to where you are, with the seam crossed. */
export interface RouteStep {
  zone: ZoneShort
  name: string
  kind: ExitKind
}

/** A port and the walk after it. `path` empty means the port lands where you are. */
export interface PortRoute {
  port: ZonePort
  /** the zones entered after landing, in order, ending where you are */
  path: RouteStep[]
}

/** How far "closest" is allowed to look before the answer is a route rather than advice. */
export const MAX_HOPS = 4

export interface SearchOptions {
  maxHops?: number
  /** walk and land only in zones the current era has - on by default, see `zoneInEra` */
  eraOnly?: boolean
}

interface Edge {
  to: ZoneShort
  name: string
  kind: ExitKind
}

/** The parenthetical the packs put on an entrance with no way back out (see `undirected`). */
const ONE_WAY = /\(click/i

/**
 * THE GRAPH READ AS UNDIRECTED, which is the physical truth and the labelling's cure.
 *
 * A zone line is two-way - you walk Befallen to Commons and back through the same seam - but only
 * 93 of the default pack's 213 maps label theirs, so the stated graph is one-way wherever the
 * neighbour's author did not. Adding the reverse of every stated edge recovers the seam from
 * whichever side labelled it. The reverse edge names its destination through the catalog, because
 * a `ZoneExit` only ever names where it GOES.
 *
 * THE WALK RUNS BACKWARD FROM WHERE YOU STAND, so an edge kept at `from` means "you can arrive at
 * `from` from `to`" - the forward push is the REVERSE crossing and the reverse push is the stated
 * one. Every two-way seam wants both. A ONE-WAY entrance wants only the stated one: a label that
 * says `(click` (`to_The_Plane_of_Hate_(click)`, `portal_to_The_Plane_of_Sky_(click)`) is a door
 * into a plane that states no way back, and reading it backwards routed Oasis's players into the
 * Plane of Hate and out through Oasis (validator catch 2026-10-01). Hate still finds Oasis's ports
 * through the stated direction, which is the 2026-09-23 fix.
 */
function undirected(graph: ZoneGraph): Map<ZoneShort, Edge[]> {
  const adj = new Map<ZoneShort, Edge[]>()
  const push = (from: ZoneShort, edge: Edge): void => {
    const held = adj.get(from)
    if (held) held.push(edge)
    else adj.set(from, [edge])
  }
  for (const [from, exits] of graph) {
    const fromName = resolveZone(from)?.name ?? from
    for (const e of exits) {
      if (!ONE_WAY.test(e.label)) push(from, { to: e.zone, name: e.name, kind: e.kind })
      push(e.zone, { to: from, name: fromName, kind: e.kind })
    }
  }
  return adj
}

/** The steps from `zone` back to the search's start, read off the BFS parents. */
function pathBack(parents: ReadonlyMap<ZoneShort, Edge | null>, zone: ZoneShort): RouteStep[] {
  const out: RouteStep[] = []
  let at = zone
  for (;;) {
    const via = parents.get(at)
    if (via === null || via === undefined) return out
    out.push({ zone: via.to, name: via.name, kind: via.kind })
    at = via.to
  }
}

/** The zones reached from `start` in breadth-first order, each remembering the seam back. */
interface Walk {
  order: ZoneShort[]
  parents: Map<ZoneShort, Edge | null>
}

/** May the walk step into `zone`: not yet seen, and - by default - a zone the era has. */
function enters(zone: ZoneShort, seen: ReadonlyMap<ZoneShort, Edge | null>, eraOnly: boolean): boolean {
  if (seen.has(zone)) return false
  // A zone the era does not have is neither a landing nor a way through.
  return !eraOnly || inEra(zone)
}

/**
 * Breadth-first from `start`, so the first time a zone is reached is the shortest way to it.
 *
 * `for-of` over a list that is appended to as it runs is deliberate and correct: the array
 * iterator reads the length live, which is exactly what a queue wants.
 */
function walkFrom(adj: ReadonlyMap<ZoneShort, Edge[]>, start: ZoneShort, opts: SearchOptions): Walk {
  const maxHops = opts.maxHops ?? MAX_HOPS
  const eraOnly = opts.eraOnly ?? true
  const parents = new Map<ZoneShort, Edge | null>([[start, null]])
  const hops = new Map<ZoneShort, number>([[start, 0]])
  const order: ZoneShort[] = [start]
  for (const zone of order) {
    const depth = hops.get(zone) ?? 0
    if (depth === maxHops) continue
    for (const edge of adj.get(zone) ?? []) {
      if (!enters(edge.to, parents, eraOnly)) continue
      // The parent edge points BACK toward start: it is the seam you cross after landing.
      parents.set(edge.to, { to: zone, name: resolveZone(zone)?.name ?? zone, kind: edge.kind })
      hops.set(edge.to, depth + 1)
      order.push(edge.to)
    }
  }
  return { order, parents }
}

/**
 * EVERY PORT WITHIN `maxHops` OF `start`, NEAREST FIRST - the whole of "closest".
 *
 * A port landing in a zone is offered with exactly the walk `walkFrom` found to it. Ties at one
 * distance go to the cheapest cast, items last. A port is offered once, through its nearest
 * landing.
 *
 * `start` is always distance zero, so a port landing where you are has an empty path - the card
 * says "lands here" and nothing about walking.
 */
export function nearestPorts(
  graph: ZoneGraph,
  ports: readonly ZonePort[],
  start: ZoneShort,
  opts: SearchOptions = {}
): PortRoute[] {
  const { order, parents } = walkFrom(undirected(graph), start, opts)
  const out: PortRoute[] = []
  const seen = new Set<string>()
  for (const zone of order) {
    // The start is in `order` unconditionally - it is where you stand - but a port LANDING there
    // is still an offer, and an offer into a zone the era lacks is refused like any other.
    if ((opts.eraOnly ?? true) && !inEra(zone)) continue
    const here: PortRoute[] = []
    for (const port of ports) {
      const key = `${port.via}|${port.spell}|${port.item ?? ''}`
      if (port.zone !== zone || seen.has(key)) continue
      seen.add(key)
      here.push({ port, path: pathBack(parents, zone) })
    }
    here.sort((a, b) => (a.port.level ?? 99) - (b.port.level ?? 99))
    out.push(...here)
  }
  return out
}

// ---- one line per landing zone -----------------------------------------------------------------
//
// Owner (2026-09-12), reading two rows that differed only by spell: *"if there is a SOLO and GROUP
// port and alternate class, combine them to 1 line ... the point is to show the top 2-3 closest
// zones that you can port into"*. The unit of the answer is the ZONE you land in, not the spell
// that lands you; the spells are how, and they fold onto the line.

/** Everything that lands you in one zone, and the walk from there to where you are. */
export interface Landing {
  zone: ZoneShort
  zoneName: string
  /** the walk after landing - identical for every port landing here, so stated once */
  path: RouteStep[]
  /** druid casts that land here, cheapest level first */
  druid: ZonePort[]
  /** wizard casts that land here, cheapest level first */
  wizard: ZonePort[]
  /** item clicks that land here, in table order */
  items: ZonePort[]
}

/**
 * `nearestPorts` output folded to one entry per landing zone, in the order zones were first
 * reached - which is nearest first, because the routes already are.
 *
 * A pure fold on purpose: the card that draws this is a renderer and the renderer never groups a
 * domain collection (ruling 4). The walk is taken from the first route into the zone; the search
 * found one shortest way there and every port landing there shares it.
 */
export function landings(routes: readonly PortRoute[]): Landing[] {
  const out: Landing[] = []
  const byZone = new Map<ZoneShort, Landing>()
  for (const route of routes) {
    let landing = byZone.get(route.port.zone)
    if (landing === undefined) {
      landing = { zone: route.port.zone, zoneName: route.port.zoneName, path: route.path, druid: [], wizard: [], items: [] }
      byZone.set(route.port.zone, landing)
      out.push(landing)
    }
    if (route.port.via === 'druid') landing.druid.push(route.port)
    else if (route.port.via === 'wizard') landing.wizard.push(route.port)
    else landing.items.push(route.port)
  }
  return out
}
