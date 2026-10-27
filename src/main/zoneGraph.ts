// zoneGraph.ts — EVERY ZONE'S STATED EXITS, read once off every map the player has.
//
// Owner (2026-09-12), standing in a zone whose neighbours had no port either: *"it should show
// the closest zone that has a port right?"* - and then, in West Freeport: *"freeport doesn't seem
// to give that you can come from west commons or nektulos forest, OR, from the islands via the dock
// NPC port"*. Those are two-hop answers. The renderer had been reading only the map on screen, so
// it could see one hop and nothing further; this is the whole graph, and
// `shared/zoneTravel.nearestPorts` walks it.
//
// ── IT IS THE MAP LIBRARY'S OWN PARSE, WALKED ONCE ───────────────────────────────────────────
//
// No second reader of the maps directory. `mapLibrary()` already indexes the packs and resolves
// each zone's layers; this asks it for every zone's LABELS in turn (`labels`, the label-only
// reader) and keeps their verdict (`zoneExits`). It used to ask for the full parse, and that was
// the whole of the owner's 2026-09-12 report that the Maps tab took seconds to draw: 581 layers,
// 215 MB of geometry parsed on the main thread to read about 1,500 label lines, 3.9 s measured,
// with the map the tab asked for queued behind it. The result is memoized, and ipc/maps.ts builds
// it at idle so the tab never pays it.
//
// WHAT IT STILL COSTS, measured 2026-10-01 on the owner's install (2 packs, 581 zones, 1,786
// files): 1.4-1.6 s. The earlier "0.13 s" was not true of the every-pack union below. The bulk is
// reading 194 MB, because a zone's BASE file holds some of its labels and has to be read to find
// them; scanning for labels is about 0.15 s of it. Two things keep that off the main thread's
// critical path: each file is read and scanned ONCE per build (a `LabelMemo`, since every pack
// preference resolves the same base file - about 0.1 s of the total), and the build YIELDS to the
// event loop between zones, so IPC and window work interleave with it instead of waiting ~1.5 s.
//
// MEMOIZED AGAINST THE LIBRARY INSTANCE, not forever: `mapLibrary()` hands back a fresh object when
// the EQ directory changes (its own header says so), and a graph read off the old directory would
// then describe maps the player no longer has.
//
// A ZONE WITH NO LABELLED SEAMS IS ABSENT, not present-and-empty. Measured: 90 of 213 maps label
// at least one seam. The search adds the reverse of every stated edge, so a zone absent here is
// still reachable from a neighbour that labelled the shared seam.

import { mapLibrary } from './maps'
import type { LabelMemo } from './maps/packs'
import { zoneExits, type ZoneExit, type ZoneGraph } from '../shared/zoneTravel'
import type { ZoneShort } from '../shared/maps'

let CACHE: { library: unknown; graph: Promise<ZoneGraph> } | null = null

/** One turn of the event loop, so a long build does not hold the main process. */
const yieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * Every zone with at least one stated exit, keyed by map stem.
 *
 * EVERY PACK IS READ, NOT THE PREFERRED ONE. The Maps tab picks one label pack per zone
 * (brewall first, for its 26,607 points to the default set's 285), and this used to ask for the
 * same pick - so a seam only the OTHER pack labelled was invisible. Measured (owner report,
 * 2026-09-23: *"the plane of hate ... incorrectly showing no ports near"*): the Oasis entrance to
 * Hate (`to_The_Plane_of_Hate_(click)`) and East Freeport's portal to Sky are stated by the
 * default pack's `oasis_1.txt` / `freporte_1.txt` alone, and brewall's Oasis labels only the two
 * deserts. A seam is a fact about the zone whichever pack wrote it down, so the graph is the
 * union across packs, deduped the way `zoneExits` dedupes within one map.
 *
 * One build per library: concurrent asks share the promise, and a build that FAILS is forgotten,
 * so the next ask tries again rather than serving the failure for the life of the process.
 */
export function zoneGraph(): Promise<ZoneGraph> {
  const library = mapLibrary()
  if (CACHE !== null && CACHE.library === library) return CACHE.graph
  const graph = buildGraph(library)
  CACHE = { library, graph }
  graph.catch(() => {
    if (CACHE?.graph === graph) CACHE = null
  })
  return graph
}

async function buildGraph(library: ReturnType<typeof mapLibrary>): Promise<ZoneGraph> {
  const packIds = library.packs().map((p) => p.id)
  const memo: LabelMemo = new Map()
  const out = new Map<ZoneShort, ZoneExit[]>()
  for (const stem of library.zones()) {
    const exits = statedExits(library, stem, { packIds, memo })
    if (exits.length > 0) out.set(stem, exits)
    await yieldTurn()
  }
  return out
}

/** One zone's exits across every pack, each (kind, destination) once. */
function statedExits(
  library: ReturnType<typeof mapLibrary>,
  stem: ZoneShort,
  walk: { packIds: readonly string[]; memo: LabelMemo }
): ZoneExit[] {
  const exits: ZoneExit[] = []
  const seen = new Set<string>()
  for (const labels of walk.packIds) {
    // A pack that lacks the zone hands back another pack's file (resolveLayer's fallback); the
    // dedupe makes that a harmless repeat rather than a doubled seam, and the memo a free one.
    const points = library.labels(stem, { labels }, walk.memo)
    if (points === null) continue
    for (const exit of zoneExits(points)) {
      const key = `${exit.kind}|${exit.zone}`
      if (seen.has(key)) continue
      seen.add(key)
      exits.push(exit)
    }
  }
  return exits
}
