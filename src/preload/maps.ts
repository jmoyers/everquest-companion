// preload/maps — the map viewer's calls (docs/plans/map-viewer.md §4.3).
//
// Split out of `index.ts` at the measured 400-line ceiling, the `knowledge.ts` precedent exactly:
// the owner's travel ask (2026-09-11) added a fifth call and the file crossed the bar. A split,
// never a ratchet.
//
// Main reads and parses `<eqRoot>\maps`; the renderer never sees a path. `zone` is a map-file STEM
// ('airplane'), not the log's long name — fold that through `shared/zones.ts` first.

import { ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  MapGetResult,
  MapPackListResult,
  MapPackPrefs,
  MapSearchHit,
  MapSearchOpts,
  ZoneShort
} from '../shared/maps'
import type { ZoneExit, ZonePort } from '../shared/zoneTravel'

export const mapsBridge = {
  /** The installed map packs. Empty list + `error` prose on a machine with no EQ maps dir. */
  listMapPacks: (): Promise<MapPackListResult> => ipcRenderer.invoke(IPC.mapsListPacks),
  /** Zone stems, ascending — across every pack, or within one when `packId` is given. */
  listMapZones: (packId?: string): Promise<ZoneShort[]> =>
    ipcRenderer.invoke(IPC.mapsListZones, packId),
  /** One zone's parsed map. `prefs` picks the pack PER LAYER (geometry and labels routinely
   *  come from different packs); what was actually used comes back in `data.sources`. */
  getMapData: (zone: string, prefs?: MapPackPrefs): Promise<MapGetResult> =>
    ipcRenderer.invoke(IPC.mapsGet, zone, prefs),
  /** Fuzzy label search: one zone (`opts.zone`) or the whole corpus. Same scorer as every
   *  other search box in the app (`shared/fuzzy.ts`). Empty query resolves to no hits.
   *  Pass the viewer's `opts.prefs` for an in-zone search so the hits rank over the SAME pack
   *  resolution `getMapData` drew; the corpus index is default-prefs by construction. */
  searchMapPoints: (q: string, opts?: MapSearchOpts): Promise<MapSearchHit[]> =>
    ipcRenderer.invoke(IPC.mapsSearch, q, opts),

  /** Every druid, wizard and item port the corpora state — a static table, fetched once. */
  getZonePorts: (): Promise<ZonePort[]> => ipcRenderer.invoke(IPC.mapsPorts),
  /** Every zone's stated exits, as entries (a Map does not cross IPC) — fetched once, kept. */
  getZoneGraph: (): Promise<[ZoneShort, ZoneExit[]][]> => ipcRenderer.invoke(IPC.mapsGraph)
}
