// The sidebar's STATE — its query, its filtered lists, and which row is selected.
//
// IT LIVES ABOVE THE PANE, not inside it, and that is the whole reason this file exists: the
// pane LISTS the mobs and the surface PINS them, and both must be showing the same set. Typing
// "sarnak" has to narrow the map and the list together, so the filtered rows are derived exactly
// once, here, and handed to both. A pane that owned its own query would need a callback back up
// to the surface, and the two would be one render out of step forever.
//
// EVERYTHING IS DERIVED FROM THE DATA, NEVER FROM THE QUERY. `mobRows` walks the 7,866-row
// catalog and `labelRows` walks the map's points; both are memoized on the zone / the points, so
// a keystroke re-filters an array that already exists. The catalog scan is the expensive half and
// it runs once per zone (MEASURED precedent: the same join costs ~3ms on the Mobs tab).
//
// THE SELECTION IS A ROW ID, not a coordinate. Ids survive re-filtering (the ring stays on the
// row you clicked while you keep typing) and they are cleared when the map changes, because a
// mob id means nothing in another zone.

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { MapData, MapPackPrefs, MapPoint, MapSearchHit, ZoneShort } from '@shared/maps'
import type { MobEntry } from '@shared/types'
import { MOB_CATALOG } from '../mobs/mobSearch'
import { useWishlist } from '../wishlist/useWishlist'
import { CROSS_ZONE_LIMIT, crossZoneRows, type CrossZoneRow } from './crossZone'
import { loadPaneOpen, savePaneOpen } from './useMapData'
import type { MapViewport } from './useMapViewport'
import {
  filterPaneRows,
  labelRows,
  mobRows,
  paneCounts,
  pinsForRows,
  rowTarget,
  wishedDrops,
  type LabelPaneRow,
  type MapPaneRow,
  type MobPaneRow,
  type PaneCounts,
  type PlacedPin
} from './mobPins'

export interface MapPaneArgs {
  /** The LONG zone name to join the catalog on. `null` ⇒ no zone is open. */
  zoneName: string | null
  /** The map's own label points — `MapData.points`, already parsed by main. */
  points: readonly MapPoint[]
  /** The committed mob catalog. */
  catalog: MobEntry[]
  /** Identity of the loaded map. A change clears the selection. */
  mapId: string
  /** Centre the viewport on a map coordinate — `vp.centerOn`, curried by the caller. */
  onCenter: (x: number, y: number) => void
}

export interface MapPaneState {
  query: string
  setQuery: (q: string) => void
  /** The mobs currently listed AND pinned. */
  mobs: MobPaneRow[]
  labels: LabelPaneRow[]
  counts: PaneCounts
  /** The pins the surface draws — computed HERE so the list and the map share one walk. */
  pins: PlacedPin[]
  /** The drawn set hit `MAX_PINS`. Stated in the pane rather than silently trimmed. */
  pinsCapped: boolean
  /** Row id → the wish-list drops that mob carries. Derived once, read by pane rows AND pins. */
  wishes: ReadonlyMap<string, readonly string[]>
  selectedId: string | null
  /** Where the selected row is, in map coordinates — the ring's position. */
  selectedAt: { x: number; y: number } | null
  /** `at` overrides the row's own first-pin target — the surface passes the SPECIFIC pin that
   *  was clicked, so a row with several spawn points rings the one under the cursor. */
  select: (row: MapPaneRow, at?: { x: number; y: number }) => void
}

export function useMapPane({ zoneName, points, catalog, mapId, onCenter }: MapPaneArgs): MapPaneState {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<{ id: string; x: number; y: number } | null>(null)
  // The box echoes every keystroke; only the filtering waits for the paint to settle.
  const q = useDeferredValue(query)

  const allMobs = useMemo<MobPaneRow[]>(
    () => (zoneName == null ? [] : mobRows(zoneName, catalog)),
    [zoneName, catalog]
  )
  // The wish-list join — walks the zone's rows, not the catalog, so an edit re-derives cheaply.
  const wishlist = useWishlist().list
  const wishedKeys = useMemo(() => new Set(wishlist.entries.map((e) => e.itemKey)), [wishlist.entries])
  const wishes = useMemo(() => {
    const m = new Map<string, readonly string[]>()
    if (wishedKeys.size > 0)
      for (const row of allMobs) {
        const hits = wishedDrops(row.entry, wishedKeys)
        if (hits.length > 0) m.set(row.id, hits)
      }
    return m
  }, [allMobs, wishedKeys])
  const allLabels = useMemo<LabelPaneRow[]>(() => labelRows(points), [points])
  const mobs = useMemo(() => filterPaneRows(allMobs, q), [allMobs, q])
  const labels = useMemo(() => filterPaneRows(allLabels, q), [allLabels, q])
  const counts = useMemo(() => paneCounts(allMobs, allLabels), [allMobs, allLabels])
  const drawn = useMemo(() => pinsForRows(mobs), [mobs])

  // A row id from another zone would ring a coordinate that is no longer on this map.
  useEffect(() => {
    setSelected(null)
  }, [mapId])

  const select = useCallback(
    (row: MapPaneRow, at?: { x: number; y: number }) => {
      const target = at ?? rowTarget(row)
      // Unlocatable rows are already disabled in the pane; this is the belt-and-braces half, so
      // no caller can ever produce a ring floating at a position nothing stated.
      if (target == null) return
      setSelected({ id: row.id, x: target.x, y: target.y })
      onCenter(target.x, target.y)
    },
    [onCenter]
  )

  return {
    query,
    setQuery,
    mobs,
    labels,
    counts,
    pins: drawn.pins,
    pinsCapped: drawn.capped,
    wishes,
    selectedId: selected?.id ?? null,
    selectedAt: selected ? { x: selected.x, y: selected.y } : null,
    select
  }
}

// ---- the SOMEWHERE ELSE half ---------------------------------------------------------------

/** Module-level empty so a query that asks nothing hands the pane a STABLE reference. */
const NO_HITS: MapSearchHit[] = []

/** Module-level empty for the same reason, on the merged side. */
const NO_ROWS: CrossZoneRow[] = []

/**
 * The MAP CORPUS half of the third section: label text in every installed pack.
 *
 * This is the capability the toolbar's `All zones` scope carried, moved into the one filter box —
 * "which zone is Ambassador D`Vinn in?" is a question the corpus makes answerable and nothing
 * else in the app answers. It is a SECTION rather than a mode because the two other sections are
 * scoped to the map on screen: one query, three answers, each labelled with where it came from.
 *
 * It carries the viewer's pack prefs for the same reason the old in-zone search did — the corpus
 * index is built once under DEFAULT prefs and ignores them, but `maps:search` takes one field and
 * the caller has no business deciding which half reads it.
 *
 * The zone ON SCREEN is NOT filtered here: `crossZoneRows` drops it from both halves at once, so
 * the exclusion is stated in one place and a zone change re-derives rather than re-fetching.
 */
export function useCorpusHits(args: { query: string; prefs: MapPackPrefs }): MapSearchHit[] {
  const { query } = args
  const [hits, setHits] = useState<MapSearchHit[]>(NO_HITS)
  // The pref FIELDS, not the object — useMapData.ts's rule: a caller that rebuilds `prefs` every
  // render must not be able to re-query on every render.
  const { geometry, labels } = args.prefs

  useEffect(() => {
    if (query.length === 0) {
      setHits(NO_HITS)
      return
    }
    let cancelled = false
    void window.eq
      .searchMapPoints(query, {
        limit: CROSS_ZONE_LIMIT,
        prefs: {
          ...(geometry == null ? {} : { geometry }),
          ...(labels == null ? {} : { labels })
        }
      })
      .then((res) => {
        if (!cancelled) setHits(res)
      })
      .catch(() => {
        if (!cancelled) setHits(NO_HITS)
      })
    return () => {
      cancelled = true
    }
  }, [query, geometry, labels])

  return hits
}

/**
 * THE THIRD SECTION, whole: the map corpus and the wiki's bestiary, ranked into one list (JOS-135).
 *
 * The bestiary half is a FLAT SCAN in the renderer over the committed catalog (crossZone.ts carries
 * the measurement), so it costs no IPC and answers while the map-corpus promise is still in flight;
 * the merge simply re-runs when it lands. The installed stems come from the pack listing so a row
 * can say "no map installed for this zone" instead of taking you to an empty picker.
 */
export function useCrossZoneRows(args: {
  query: string
  hits: readonly MapSearchHit[]
  here: ZoneShort | null
  zones: readonly ZoneShort[]
}): CrossZoneRow[] {
  const { query, hits, here, zones } = args
  const installed = useMemo(() => new Set(zones), [zones])
  return useMemo(() => {
    if (query.length === 0) return NO_ROWS
    return crossZoneRows({ query, catalog: MOB_CATALOG, hits, here, installed })
  }, [query, hits, here, installed])
}

// ---- the view's whole pane wiring, in one call ------------------------------------------

/** Scale bump when centring from a FITTED view — fitted, a spawn point is a couple of pixels. */
const JUMP_ZOOM = 6

/** Module-level so "no map loaded" is a STABLE reference: a fresh `[]` per render would
 *  re-derive the label rows on every render of the view. */
const NO_POINTS: readonly MapPoint[] = []

export interface ZonePaneState extends MapPaneState {
  /** Is the sidebar on screen? ON by default, remembered in `eq.maps.pane`. */
  open: boolean
  setOpen: (open: boolean) => void
  /** Matches in every OTHER zone - map labels and wiki mobs alike. Empty until the box has text. */
  hits: CrossZoneRow[]
}

/**
 * Everything MapsView needs to render the sidebar and its pins: the persisted open flag, the pane
 * state wired to the viewport's `centerOn`, and the cross-zone hits for the same query.
 *
 * It lives here rather than inline in the view for the reason the whole module does — the pane
 * and the surface must read ONE derivation — and because the view is at the repo's complexity
 * ceiling and this is a self-contained slice of it.
 */
export function useZonePane(args: {
  vp: MapViewport
  /** The map on screen, or null while none is loaded. */
  data: MapData | null
  /** The LONG zone name to join the catalog on, or null when nothing is open. */
  zoneName: string | null
  /** The viewer's per-layer pack preference, carried into the cross-zone search. */
  prefs: MapPackPrefs
  /** Every stem an installed pack provides — so a cross-zone row knows whether it has a map. */
  zones: readonly ZoneShort[]
}): ZonePaneState {
  const { vp, data, zoneName, prefs, zones } = args
  const [open, setOpenState] = useState<boolean>(loadPaneOpen)
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next)
    savePaneOpen(next)
  }, [])

  const { centerOn, zoomedIn, view } = vp
  const onCenter = useCallback(
    (x: number, y: number) => {
      // The same rule the label search's jump uses: centring from a fitted view also zooms in;
      // an already-zoomed view keeps the scale the user chose.
      centerOn(x, y, zoomedIn ? undefined : view.scale * JUMP_ZOOM)
    },
    [centerOn, zoomedIn, view.scale]
  )

  const pane = useMapPane({
    zoneName,
    points: data?.points ?? NO_POINTS,
    catalog: MOB_CATALOG,
    mapId: data?.zone ?? '',
    onCenter
  })
  // The box echoes every keystroke; only what reaches the IPC and the catalog scan waits for the
  // paint to settle.
  const query = useDeferredValue(pane.query).trim()
  const hits = useCrossZoneRows({
    query,
    hits: useCorpusHits({ query, prefs }),
    here: data?.zone ?? null,
    zones
  })
  return { ...pane, open, setOpen, hits }
}

/** What the surface needs from the pane: the pins, the selection, the wish-list join, and the one
 *  `select` a clicked pin routes through (MapMobPins.tsx). Null ⇒ draw nothing. */
export interface PaneOverlay {
  pins: readonly PlacedPin[]
  selectedId: string | null
  selectedAt: { x: number; y: number } | null
  wishes: ReadonlyMap<string, readonly string[]>
  select: (row: MapPaneRow, at?: { x: number; y: number }) => void
}

export function paneOverlay(pane: ZonePaneState): PaneOverlay | null {
  if (!pane.open) return null
  return {
    pins: pane.pins,
    selectedId: pane.selectedId,
    selectedAt: pane.selectedAt,
    wishes: pane.wishes,
    select: pane.select
  }
}
