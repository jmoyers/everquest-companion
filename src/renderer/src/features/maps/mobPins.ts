// mobPins.ts — the PURE half of the Maps tab's right-hand pane: what is in this zone, and where.
//
// The pane answers one question with TWO authorities that have never been shown side by side
// before, and the whole point of this module is that it never lets them blur into one:
//
//   1. THE WIKI'S BESTIARY — the committed mob catalog (`data/eqlegends/mobs.json`), joined to
//      the zone on screen by `mobsInZone` (features/mobs/mobZone.ts, Task #64). That join is
//      REUSED verbatim, not re-implemented: the Mobs tab already answers "what lives where I
//      am", and two folds that could disagree about a zone would be an invisible bug.
//   2. THE MAP FILE'S OWN LABELS — `MapData.points`, already extracted by the main-side parser
//      (src/main/maps/parseMap.ts). Nothing here re-parses anything; the renderer receives the
//      points and this module shapes them into rows.
//
// COORDINATES ARE REAL OR THEY ARE ABSENT (world-model law 1). A mob is PINNED only when its
// wiki page stated numbers under `|location`; a mob whose page says "Various" or "?" is still
// listed — it lives here, that is a fact — with no pin and nothing that looks like one. There
// is no interpolation, no zone-centre fallback, no "probably near the entrance".
//
// MEASURED, 2026-08-04 (all 7,866 catalog pages re-read from eqlwiki.com): 6,283 state at least
// one usable coordinate — 8,990 spawn points in total, since a page may state several
// (`50% @ (a, b), 50% @ (c, d)`). So roughly FOUR IN FIVE named mobs are locatable and one in
// five is not, and the pane says which is which per row rather than in a footnote.
//
// THE CONVERSION IS `mapFromLoc` AND NOTHING ELSE. mapGeometry.ts has owned the `/loc` → map
// transform since wave 1 (`mapX = -ew, mapY = -ns, mapZ = elevation`, documented from Yther
// Ore's worked example). This wave measured it against real data for the first time: of six
// candidate transforms over 7,423 stated coordinates in the 119 mapped zones, that one puts
// 99.4% of them inside the zone's own extent (next best 66.4%) and a median 14.8 map units from
// the nearest wall segment (next best 170.8). It was right; now it is evidence.
//
// WHY ELEVATION DOES NOT SLICE. Only ~2% of pages state a third number, so filtering pins by the
// active floor band would hide 98% of them on a floor-sliced map for want of data the wiki does
// not have. Pins are carried with `z` when stated and drawn regardless — a pin you can see on
// the wrong floor is a smaller lie than a mob the pane silently deleted.

import type { MapPoint } from '@shared/maps'
import type { MobEntry } from '@shared/types'
// RELATIVE value imports, the repo-wide rule for node-tested pure modules (mobSearch.ts:33):
// the `@shared/*` alias exists only inside the vite build, and tests/mapMobPane.test.mts drives
// this module — against the REAL catalog — under plain `node --import tsx --test`.
import { sourceItemKey } from '../../lib/itemSources'
import { mobsInZone } from '../mobs/mobZone'
import { mapFromLoc } from './mapGeometry'

/**
 * The legend layer (`<zone>_2.txt`). Its "labels" are the colour key, the credits and the
 * `Height_Filter:` hint, drawn at fixed OFF-MAP coordinates — centring the viewport on one would
 * fly the user outside the zone. Excluded from the pane's label list for that reason alone; the
 * layer itself is still drawable from the toolbar.
 */
const LEGEND_LAYER = 2

/** How many pins the surface will draw at once. See `pinsForRows`. */
export const MAX_PINS = 400

/**
 * `a skeleton` / `an orc pawn` — the game's own convention for a COMMON spawn is the leading
 * article, and the named mobs worth walking to go without one (`skeleton Lrodd`, `the ghoul
 * lord`, Baron Telyx V`Zher). The catalog carries no rarity field (mobTypes.ts keeps it
 * compact on purpose), so the article is the one signal the data itself states.
 *
 * Case-insensitive because the wiki capitalizes some articles (`A Chokidai Growler`). MEASURED
 * over the committed catalog, 2026-08-16: 2,137 of 7,872 pages are articled.
 */
const COMMON_NAME_RE = /^(a|an)\s/i

/** True for the trash spawns the map pane does not list. Exported for its own test. */
export function isCommonMob(name: string): boolean {
  return COMMON_NAME_RE.test(name)
}

/** One spawn point, already in MAP coordinates — ready for `vp.toScreen`. */
export interface MobPin {
  x: number
  y: number
  /** The share the page stated for this point (`60% @ …`), when it stated one. */
  pct?: number
}

/** A named mob the wiki places in this zone. `pins` is empty when its page states no numbers. */
export interface MobPaneRow {
  kind: 'mob'
  /** The wiki page title — unique across the catalog, so it is the React key and the row id. */
  id: string
  /** The in-game name, displayed RAW (law 2). */
  name: string
  /** Level EXACTLY as the page states it ("36-40", "~53"). Absent when it states none. */
  level?: string
  pins: MobPin[]
  /** How many zones the page names. > 1 ⇒ a stated position cannot be attributed to this map. */
  zoneCount: number
  /**
   * The page DID state a position, but it names several zones, so which one the numbers describe
   * is unknowable — the row is listed with no pin and says so. MEASURED: 235 catalog pages name
   * more than one zone and 84 of those state coordinates, so this is 1.3% of the placeable
   * corpus, and every one of them would otherwise be a pin in the wrong zone half the time.
   */
  unattributable: boolean
  /** The catalog row itself — pins the mob-page deep link's identity, and carries the drops. */
  entry: MobEntry
  /** Lowercased haystack, computed once per data change (AGENTS.md "Search"). */
  searchKey: string
}

/** One of the map file's own label points. Always locatable — it IS a coordinate. */
export interface LabelPaneRow {
  kind: 'label'
  id: string
  /** `MapPoint.display` — the parser's underscore-expanded text. */
  name: string
  point: MapPoint
  searchKey: string
}

export type MapPaneRow = MobPaneRow | LabelPaneRow

/** Every spawn point a catalog row states, converted to map coordinates. `[]` when it states none. */
export function mobPins(entry: MobEntry): MobPin[] {
  return (entry.loc ?? []).map((l) => {
    const p = mapFromLoc({ ns: l.ns, ew: l.ew, z: l.z ?? 0 })
    return { x: p.x, y: p.y, ...(l.pct === undefined ? {} : { pct: l.pct }) }
  })
}

/**
 * The zone's named mobs, in `mobsInZone` order (level ascending, unknown level last).
 *
 * `zoneRaw` is a LONG zone name — the raw one the log printed, or the zone table's name for a
 * manually picked stem. Folding it is `mobsInZone`'s job; pass it unmodified.
 *
 * A MULTI-ZONE PAGE IS NOT PINNED. `|location` is one field and `|zone` may name several places;
 * nothing on the page says which zone the numbers describe, so attributing them to the map on
 * screen would be a coin flip dressed as knowledge. Those rows are LISTED — the mob does live
 * here — and the pane states why they carry no pin (world-model law 1).
 *
 * COMMON SPAWNS ARE NOT LISTED AT ALL (owner call, 2026-08-16): the map pane exists for the
 * mobs worth walking to, and a zone's forty `a skeleton`s bury its nameds. `isCommonMob` is the
 * gate; the Mobs tab and the cross-zone search still answer for commons — this is the MAP's
 * filter, not the app's.
 */
export function mobRows(zoneRaw: string, catalog: MobEntry[]): MobPaneRow[] {
  return mobsInZone(zoneRaw, catalog)
    .filter((m) => !isCommonMob(m.name))
    .map((m) => {
      const zoneCount = m.zones?.length ?? 0
      const ambiguous = zoneCount > 1
      return {
        kind: 'mob' as const,
        id: m.page,
        name: m.name,
        ...(m.level === undefined ? {} : { level: m.level }),
        pins: ambiguous ? [] : mobPins(m),
        zoneCount,
        unattributable: ambiguous && (m.loc?.length ?? 0) > 0,
        entry: m,
        searchKey: `${m.name} ${m.level ?? ''}`.toLowerCase()
      }
    })
}

/**
 * The drop names on this page that the wish list asks for. Keyed through `sourceItemKey` — the
 * wish list stores canonical keys and ~1,900 catalog drop names carry a `+N` suffix — and deduped
 * per key ("Ghoulbane" / "Ghoulbane +1" are one item).
 */
export function wishedDrops(entry: MobEntry, wished: ReadonlySet<string>): string[] {
  if (wished.size === 0) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const drop of entry.drops ?? []) {
    const key = sourceItemKey(drop)
    if (!wished.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(drop)
  }
  return out
}

/**
 * The map's own label points as pane rows, in file order.
 *
 * Legend-layer points are dropped (see `LEGEND_LAYER`). Nothing is re-parsed: `points` is the
 * array `maps:get` already delivered.
 */
export function labelRows(points: readonly MapPoint[]): LabelPaneRow[] {
  const out: LabelPaneRow[] = []
  for (const p of points) {
    if (p.layer === LEGEND_LAYER) continue
    out.push({
      kind: 'label',
      id: `${p.label}#${String(p.x)},${String(p.y)},${String(p.layer)}`,
      name: p.display,
      point: p,
      searchKey: p.display.toLowerCase()
    })
  }
  return out
}

/**
 * Filter rows by a query — ALL of the query's whitespace-separated words must appear somewhere
 * in the row's key.
 *
 * Substring-AND rather than `shared/fuzzy`'s scorer, and that is a deliberate difference from
 * the label search box above it: this pane is a FILTER over a list the user is already reading
 * (a zone's 343 mobs at worst), not a ranked lookup into a 35,720-record corpus. Typing narrows
 * what is on screen and keeps its order — the sort is "lowest level first", which is the reason
 * to read the list at all, and a relevance re-rank would destroy it on every keystroke.
 */
export function filterPaneRows<T extends MapPaneRow>(rows: readonly T[], query: string): T[] {
  const words = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
  if (words.length === 0) return [...rows]
  return rows.filter((r) => words.every((w) => r.searchKey.includes(w)))
}

/** Where a row can be centred, or null when nothing stated a position. Mobs use their FIRST pin. */
export function rowTarget(row: MapPaneRow): { x: number; y: number } | null {
  if (row.kind === 'label') return { x: row.point.x, y: row.point.y }
  const first = row.pins[0]
  return first ? { x: first.x, y: first.y } : null
}

/** True when the row can be pinned and centred at all — what the pin affordance is gated on. */
export function isLocatable(row: MapPaneRow): boolean {
  return rowTarget(row) !== null
}

/** One pin about to be drawn: which row it belongs to, where it is, and its React key. */
export interface PlacedPin {
  row: MobPaneRow
  pin: MobPin
  key: string
}

/**
 * The pins to DRAW for a list of mob rows, capped.
 *
 * Capped rather than unbounded because the list is filtered, not paged: an unfiltered Kael
 * Drakkel is 343 mobs and some of them state eight spawn points each. The cap is on POINTS, not
 * rows, and it is reported so the surface can say it drew a subset instead of quietly lying
 * about how crowded a zone is.
 */
export function pinsForRows(
  rows: readonly MobPaneRow[],
  limit: number = MAX_PINS
): { pins: PlacedPin[]; capped: boolean } {
  const pins: PlacedPin[] = []
  for (const row of rows) {
    for (let i = 0; i < row.pins.length; i += 1) {
      if (pins.length >= limit) return { pins, capped: true }
      pins.push({ row, pin: row.pins[i], key: `${row.id}#${String(i)}` })
    }
  }
  return { pins, capped: false }
}

/** What the pane's header states: how much of each authority it is showing. */
export interface PaneCounts {
  mobs: number
  /** …of which the wiki actually states a position for. The rest are listed WITHOUT a pin. */
  located: number
  labels: number
}

export function paneCounts(mobs: readonly MobPaneRow[], labels: readonly LabelPaneRow[]): PaneCounts {
  return {
    mobs: mobs.length,
    located: mobs.reduce((n, m) => n + (m.pins.length > 0 ? 1 : 0), 0),
    labels: labels.length
  }
}
