// The renderer's DOOR to the map IPC, plus the two prefs the viewer remembers between launches
// (docs/plans/map-viewer.md §4.3, §11 wave 3).
//
// Nothing here parses anything. Main owns `fs`, owns `effectiveEqRoot()` and owns the parse LRU
// (src/main/maps/packs.ts), so a zone arrives as one already-columnar `MapData` — this module's
// whole job is to ask for the right one, to ignore the answer to a question that has since been
// superseded, and to keep the asking honest while it is in flight.
//
// TWO RULES IT EXISTS TO ENFORCE:
//
//   * ONE IN-FLIGHT ANSWER WINS, AND IT IS THE LATEST QUESTION'S. Zoning twice quickly (or
//     clicking two search hits) fires two `maps:get` calls, and IPC gives no ordering guarantee
//     across invokes. Each effect run captures a `cancelled` flag, so a superseded reply is
//     dropped rather than painted over the newer map. There is no renderer-side cache to
//     invalidate: re-asking is an LRU hit in main.
//   * A FAILURE IS DATA. `maps:get` answers `{ok:false, error}` for the ordinary "this machine
//     has no map file for that zone" case, and the view renders that as a quiet state. Nothing
//     in this module throws, and the `.catch` exists only for a torn-down bridge.
//
// PREFS ARE MACHINE-LOCAL, IN `localStorage`, AND DELIBERATELY NOT IN `UI_PREF_SPECS`: which map
// packs are installed and which zone you were last standing in are facts about THIS install, so
// sharing them through a settings bundle would hand another machine a pack id it does not have
// (map-viewer.md §11 wave 3). The keys sit under the `eq.maps.` prefix like every other
// renderer-local view pref (`eq.view`, `eq.combat.scope`).
//
// THE ZONE ITSELF IS NOT ONE OF THEM ANY MORE. `eq.maps.zone` moved to `zoneFollow.ts` (JOS-97),
// where it lives beside the MODE that says what it means — a followed zone and a pinned one are
// stored the same way and behave completely differently, so the two keys are read and written
// together, by pure functions a node test can drive without React.

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { MapData, MapPackInfo, MapPackPrefs, ZoneShort } from '@shared/maps'

/** Per-layer pack preference — `{geometry?, labels?}`, JSON. Absent/corrupt ⇒ `{}` (auto). */
export const PACK_PREFS_KEY = 'eq.maps.packs'
/**
 * Is the find-a-mob-or-label sidebar open? `'0'` when the user closed it, absent when open.
 *
 * ON BY DEFAULT, and stored INVERTED for exactly that reason: absent means open, so a fresh
 * install and an install that has never touched the control both get the sidebar. It is the way
 * you find anything on a map — the toolbar carries no search box — so the default cannot be the
 * state where nothing is findable.
 *
 * It lives here rather than in `UI_PREF_SPECS` for the same reason the other two do: it is a fact
 * about this window's layout, not a setting worth carrying to another machine. The control is the
 * sidebar's own close button (and the reopen affordance on the map), not Preferences.
 */
export const PANE_OPEN_KEY = 'eq.maps.pane'

export function loadPaneOpen(): boolean {
  return localStorage.getItem(PANE_OPEN_KEY) !== '0'
}

export function savePaneOpen(open: boolean): void {
  if (open) localStorage.removeItem(PANE_OPEN_KEY)
  else localStorage.setItem(PANE_OPEN_KEY, '0')
}

/**
 * Whether the "Closest port" strip under the toolbar is open — the pane's twin (owner,
 * 2026-09-12: *"be collapsible so someone doesn't have to use up much space on the map page if
 * they don't want to"*). Same shape, same tier, same default: open until you close it, and only the
 * closed state is stored, so a cleared key means the default rather than a wrong reading.
 */
export const TRAVEL_OPEN_KEY = 'eq.maps.travel'

export function loadTravelOpen(): boolean {
  try {
    return localStorage.getItem(TRAVEL_OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

export function saveTravelOpen(open: boolean): void {
  try {
    if (open) localStorage.removeItem(TRAVEL_OPEN_KEY)
    else localStorage.setItem(TRAVEL_OPEN_KEY, '0')
  } catch {
    // Storage refused (private window, quota): the toggle still works for this session.
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read the persisted pack preference.
 *
 * Everything unrecognised folds to `{}` — the auto resolution order (§6.3), which always yields
 * a map when one exists. A pref naming a pack the user has since deleted is likewise harmless:
 * `resolveLayer` falls through to the next pack rather than failing.
 */
export function loadPackPrefs(): MapPackPrefs {
  const raw = localStorage.getItem(PACK_PREFS_KEY)
  if (raw == null || raw === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const { geometry, labels } = parsed as Record<string, unknown>
    const g = nonEmpty(geometry)
    const l = nonEmpty(labels)
    return { ...(g == null ? {} : { geometry: g }), ...(l == null ? {} : { labels: l }) }
  } catch {
    return {}
  }
}

export function savePackPrefs(prefs: MapPackPrefs): void {
  localStorage.setItem(PACK_PREFS_KEY, JSON.stringify(prefs))
}

/** What the viewer knows about the installed packs. `ready` distinguishes "none" from "not yet". */
export interface MapPacksState {
  packs: MapPackInfo[]
  /** Every zone stem any pack provides, ascending — the manual picker's corpus. */
  zones: ZoneShort[]
  /** Prose from main when there is nothing to list (no EQ install, no `maps\` dir). */
  error: string | null
  /** The listing has answered. Before it does, the view says nothing rather than "no maps". */
  ready: boolean
}

const NO_PACKS: MapPacksState = { packs: [], zones: [], error: null, ready: false }

/**
 * List the packs and the zone corpus ONCE per mount.
 *
 * Both are main-side scans behind a memoized library keyed on the EQ root, so a remount is
 * cheap; there is no push channel for pack changes in v1 (nothing installs packs yet — §9.2),
 * and re-entering the tab re-lists.
 */
export function useMapPacks(): MapPacksState {
  const [state, setState] = useState<MapPacksState>(NO_PACKS)
  useEffect(() => {
    let cancelled = false
    void Promise.all([window.eq.listMapPacks(), window.eq.listMapZones()])
      .then(([list, zones]) => {
        if (cancelled) return
        setState({ packs: list.packs, zones, error: list.error ?? null, ready: true })
      })
      .catch(() => {
        if (!cancelled) setState({ ...NO_PACKS, ready: true })
      })
    return () => {
      cancelled = true
    }
  }, [])
  return state
}

/** One zone's load: the parsed map, the honest failure, or the in-flight state. */
export interface MapLoad {
  data: MapData | null
  /** `maps:get`'s prose — "no map files for zone 'x'" is the ordinary case, not a crash. */
  error: string | null
  loading: boolean
}

/**
 * Fetch one zone under a per-layer pack preference.
 *
 * The effect depends on the two pref FIELDS rather than on the `prefs` object, so a caller that
 * rebuilds the object each render (every caller does) doesn't re-fetch a map it already has.
 */
export function useMapData(zone: ZoneShort | null, prefs: MapPackPrefs): MapLoad {
  const [load, setLoad] = useState<MapLoad>({ data: null, error: null, loading: zone != null })
  const { geometry, labels } = prefs
  useEffect(() => {
    if (zone == null) {
      setLoad({ data: null, error: null, loading: false })
      return
    }
    let cancelled = false
    setLoad((prev) => ({ ...prev, loading: true }))
    void window.eq
      .getMapData(zone, {
        ...(geometry == null ? {} : { geometry }),
        ...(labels == null ? {} : { labels })
      })
      .then((res) => {
        if (cancelled) return
        setLoad(
          res.ok
            ? { data: res.data, error: null, loading: false }
            : { data: null, error: res.error, loading: false }
        )
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoad({ data: null, error: String(err), loading: false })
      })
    return () => {
      cancelled = true
    }
  }, [zone, geometry, labels])
  return load
}

/**
 * Whether the "Closest port" search is limited to zones the current era has - ON by default
 * (owner, 2026-09-12: *"we need a limit to era that's on by default"*). The fold's twin: only the
 * lifted state is stored, so a cleared key means the default.
 *
 * ONE LIVE VALUE, not a copy per surface. The Closest-port card's hook stays mounted above the
 * tabs while Where to level shows the same switch, and each used to copy the stored value into its
 * own state, so a flip in one left the other on the old value until restart. Both now read
 * `useTravelEra`, and a save tells every reader.
 */
export const TRAVEL_ERA_KEY = 'eq.maps.travelEra'

/** The value this session set, which outlives a refused storage write; null until the first save. */
let travelEra: boolean | null = null
const travelEraListeners = new Set<() => void>()

export function loadTravelEra(): boolean {
  if (travelEra !== null) return travelEra
  try {
    return localStorage.getItem(TRAVEL_ERA_KEY) !== '0'
  } catch {
    return true
  }
}

export function saveTravelEra(on: boolean): void {
  travelEra = on
  try {
    if (on) localStorage.removeItem(TRAVEL_ERA_KEY)
    else localStorage.setItem(TRAVEL_ERA_KEY, '0')
  } catch {
    // Storage refused: the toggle still works for this session.
  }
  for (const listener of travelEraListeners) listener()
}

export function subscribeTravelEra(listener: () => void): () => void {
  travelEraListeners.add(listener)
  return () => {
    travelEraListeners.delete(listener)
  }
}

/** The era switch, live: every surface that shows it reads this and writes `saveTravelEra`. */
export function useTravelEra(): boolean {
  return useSyncExternalStore(subscribeTravelEra, loadTravelEra)
}
