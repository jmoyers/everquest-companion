// IPC: the map viewer — installed packs, zone lists, one zone's parsed geometry, label search.
//
// VALIDATION HAPPENS HERE, not at the caller. Three renderer-supplied strings reach a `join()`
// inside the pack layer: the zone stem (it names `<pack>\<zone>[_N].txt`) and both pack ids in
// `MapPackPrefs` (each names a pack DIRECTORY). A crafted stem — `..\..\..\Users\x\Documents\
// secret` — would otherwise turn `maps:get` into a "read any .txt on this disk" primitive, and
// today's only caller being the app's own UI is a convention, not a boundary (AGENTS.md, and
// the `sounds:getData` packId precedent one file over).
//
// `isSafePackId` from ../security is REUSED rather than mirrored: its allowlist
// `/^[A-Za-z0-9_][A-Za-z0-9._-]*$/` already admits every real map stem in the corpus
// (`thurgadina1`, `poknowledge`, `newsebexp`, `csHome`) and every pack directory name
// (`brewall`), while rejecting separators, drive letters, `..` and leading dots outright.
// Nothing about map stems motivated widening it.
//
// Every handler returns DATA, never throws: an error crossing IPC arrives as a bare
// `Error: Error invoking remote method` with the real message stripped.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { mapLibrary } from '../maps'
import { isSafePackId } from '../security'
import type { MapGetResult, MapPackPrefs, MapSearchOpts } from '../../shared/maps'
import { portsInClient, zonePorts } from '../zonePorts'
import { spellTable } from '../resist/spellTable'
import { logError } from '../errorLog'
import { zoneGraph } from '../zoneGraph'

/** Narrow the renderer's `prefs` to validated pack ids. `false` = something unsafe was sent. */
function safePrefs(raw: unknown): MapPackPrefs | false {
  if (raw == null) return {}
  if (typeof raw !== 'object') return false
  const { geometry, labels } = raw as MapPackPrefs
  if (geometry != null && !isSafePackId(geometry)) return false
  if (labels != null && !isSafePackId(labels)) return false
  return {
    ...(geometry == null ? {} : { geometry }),
    ...(labels == null ? {} : { labels })
  }
}

/**
 * THE GRAPH IS BUILT AT IDLE, NOT ON THE FIRST MAPS TAB (owner report 2026-09-12). Its build is
 * about 1.5 s of disk read, yielding between zones (zoneGraph.ts), but it sat in front of the map
 * the tab asked for, and a tab that draws its map and its port advice together needs the graph
 * already there. A short
 * delay after registration keeps it out of the startup path; the memo means the tab's own request
 * then costs nothing, and a library rebuilt for a new EQ root rebuilds it on the next ask.
 */
const GRAPH_WARM_MS = 4_000

function warmZoneGraph(): void {
  setTimeout(() => {
    zoneGraph().catch((err: unknown) => {
      logError('main:zoneGraph', err)
    })
  }, GRAPH_WARM_MS)
}

export function registerMapsIpc(): void {
  warmZoneGraph()
  ipcMain.handle(IPC.mapsListPacks, () => {
    const packs = mapLibrary().packs()
    // No packs is the fresh-machine state (no EQ install, or an install without `maps\`), and
    // the UI shows a quiet empty state for it — so it comes back as prose, not a rejection.
    return packs.length > 0 ? { packs } : { packs, error: 'no map packs found' }
  })

  ipcMain.handle(IPC.mapsListZones, (_e, packId: unknown) => {
    if (packId == null) return mapLibrary().zones()
    return isSafePackId(packId) ? mapLibrary().zones(packId) : []
  })

  // `zone` is a map-file STEM, lowercased by the pack index. Long zone names as the log spells
  // them ("The Plane of Sky" -> `airplane`) fold through `src/shared/zones.ts`, which is pure
  // shared code the renderer imports directly — no long name ever reaches this channel, and
  // the character-limited allowlist below stays exactly as tight as it is.
  ipcMain.handle(IPC.mapsGet, (_e, zone: unknown, prefs: unknown): MapGetResult => {
    if (!isSafePackId(zone)) return { ok: false, error: 'invalid zone' }
    const safe = safePrefs(prefs)
    if (safe === false) return { ok: false, error: 'invalid pack id' }
    return mapLibrary().get(zone.toLowerCase(), safe)
  })

  // NO ARGUMENT, so nothing to validate: the table is derived from two committed corpora and is
  // the same for every caller. Memoized in `zonePorts()`, so a second call costs a return.
  // Awaited, not sampled: on a cold start the client table may still be parsing, and a port list
  // read before it settles would offer the wiki's ghosts once and never again (zonePorts.ts
  // `portsInClient`). The promise settles once per run; every later await is immediate.
  ipcMain.handle(IPC.mapsPorts, async () => portsInClient(zonePorts(), await spellTable()))

  // Likewise no argument. The first call parses every map in the default pack once (`zoneGraph`
  // memoizes); a Map cannot cross IPC, so it goes as entries and the renderer rebuilds it.
  ipcMain.handle(IPC.mapsGraph, async () => [...(await zoneGraph())])

  // `prefs` goes through the SAME `safePrefs` gate as `maps:get` — an in-zone search parses the
  // zone under the caller's preference, so both pack ids reach the same `join()` they do there.
  ipcMain.handle(IPC.mapsSearch, (_e, query: unknown, opts: unknown) => {
    if (typeof query !== 'string') return []
    const { zone, limit, prefs } = (opts ?? {}) as MapSearchOpts
    if (zone != null && !isSafePackId(zone)) return []
    const safe = safePrefs(prefs)
    if (safe === false) return []
    return mapLibrary().search(query, {
      ...(zone == null ? {} : { zone: zone.toLowerCase() }),
      ...(typeof limit === 'number' ? { limit } : {}),
      prefs: safe
    })
  })
}
