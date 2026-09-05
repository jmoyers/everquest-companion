// crossZone.ts — "where is that, then?" answered across the WHOLE world, not just the map you
// happen to be looking at (JOS-135).
//
// THE REPORT THIS EXISTS FOR: standing in High Pass, searching `Tarn Visilin` and being told
// nothing. He is a High Keep NPC, and before this the Maps tab could not say so — the pane's mob
// section is the catalog joined to the zone ON SCREEN, and its cross-zone section searched the map
// files' own LABEL text, which no Brewall pack spells that name in. Two corpora, both scoped in a
// way that put the answer in the gap between them.
//
// SO THE CROSS-ZONE LIST NOW HAS TWO SOURCES, AND EVERY ROW SAYS WHICH ZONE IT IS TALKING ABOUT:
//
//   1. THE MAP CORPUS — `maps:search` with no `zone`, which main has always been able to do
//      (packs.ts `corpusRows`). Label text in every installed pack.
//   2. THE WIKI'S BESTIARY — the committed 7,872-row mob catalog, matched on the mob's NAME.
//
// NAME-ONLY HAYSTACK, and that is a deliberate difference from the Mobs tab (mobSearch.ts tokenizes
// name + zones). Here the ZONE IS THE ANSWER, printed on every row, so admitting zone tokens to the
// query side would make `high keep` return that zone's entire 93-row bestiary and bury the name
// matches this section exists to find. The toolbar's zone selector is how you ask for a zone.
//
// ONE RANKED LIST OVER BOTH, because ranking is only meaningful within one order: `shared/fuzzy`
// scores both halves (exact 1 > prefix .85 > substring .7 > typo ≤ .6), so an exact mob name
// outranks a substring label hit rather than losing to it for being in the second list. The zone
// ON SCREEN never appears here at all — those rows are the pane's own two sections, and listing
// them twice under two headings would make the headings meaningless.
//
// PERFORMANCE: A FLAT SCAN, MEASURED, NOT AN INDEX. Over the real 7,872-row catalog with
// name-only haystacks (throwaway probe, 2026-08-09): `tarn visilin` 5.4 ms cold / `ambassador`
// 1.2 ms / `a bandit` 6.0 ms / `x` (384 hits) 0.7 ms — inside a keystroke budget the pane defers
// anyway. Tokens are built ONCE, LAZILY, keyed on the catalog array itself (the mobSearch.ts
// posture; a WeakMap so a test's synthetic catalog does not leak).
//
// WHAT IT REFUSES TO INVENT. A row is only PLACED when the page names exactly one zone — the same
// rule `mobRows` applies on the map you are standing on, for the same reason: `|location` is one
// field and `|zone` may name several, so nothing on the page says which zone the numbers describe.
// An unplaceable row is still listed (the mob does live there, and that is the fact being asked
// for); it opens the zone and claims nothing more. A zone spelling the hand-authored table refuses
// (`Freeport`, `Various`, and the wiki cells whose links ran together — see zones.ts) resolves to
// NO map, and the row says so under the wiki's own spelling rather than guessing a stem.
//
// RELATIVE value imports, the repo-wide rule for node-tested pure modules (mobPins.ts:38).

import type { MapSearchHit, ZoneShort } from '@shared/maps'
import type { MobEntry } from '@shared/types'
import { scoreQuery, tokenize } from '../../../../shared/fuzzy'
import { zoneShortNameFromCatalog } from '../../../../shared/zones'
import { mobPins } from './mobPins'
import { zoneLabel } from './zoneOptions'

/** Rows handed to the pane. Main clamps its own half again; a longer list is scrolled, not fetched. */
export const CROSS_ZONE_LIMIT = 60

/**
 * One answer from somewhere else: what it is, which zone it is in, and where on that map.
 *
 * `zone` null ⇒ there is no map to open, so the row states the zone and is not clickable.
 * `at` null ⇒ the zone opens, but nothing stated a position, so no mark is dropped.
 */
export interface CrossZoneRow {
  /** Stable across re-queries — the React key and the row identity. */
  id: string
  /** Which authority answered. The pane shows it, so a wiki claim never reads as a map fact. */
  kind: 'mob' | 'label'
  /** Displayed RAW (world-model law 2). */
  name: string
  /** Level exactly as the wiki page states it ("36-40", "~53"). Mobs only, when stated. */
  level?: string
  /** The map stem to open, or null when no map answers to the zone name the source used. */
  zone: ZoneShort | null
  /** What to call that zone: the table's long name, else the spelling the source itself used. */
  zoneName: string
  /** Where to centre once that map is drawn, in MAP coordinates. */
  at: { x: number; y: number } | null
  /** Why this row cannot open a map, or cannot point at a spot on it. Null when it can do both. */
  note: string | null
  score: number
}

/**
 * What clicking a cross-zone row asks the viewer to do: open that map, and then either centre on a
 * spot or simply be there.
 *
 * `at` null is a real, common answer rather than a failure — a wiki page that states no position
 * still says which zone the mob lives in, and taking the user to that zone is the whole of what is
 * known. Inventing a centre for it would be world-model law 1's exact sin.
 */
export interface JumpTarget {
  zone: ZoneShort
  at: { x: number; y: number } | null
}

/** The jump a row stands for, or null when there is no map on the other side of it. */
export function jumpTarget(row: CrossZoneRow): JumpTarget | null {
  return row.zone == null ? null : { zone: row.zone, at: row.at }
}

/** Lazily-built, name-only token arrays, keyed on the catalog array they describe. */
const HAYSTACKS = new WeakMap<readonly MobEntry[], string[][]>()

function haystacks(catalog: readonly MobEntry[]): string[][] {
  const cached = HAYSTACKS.get(catalog)
  if (cached) return cached
  const built = catalog.map((m) => tokenize(m.name))
  HAYSTACKS.set(catalog, built)
  return built
}

/** True when this row can be clicked at all — i.e. there is a map on the other side of it. */
export function isReachable(row: CrossZoneRow): boolean {
  return row.zone != null
}

/**
 * Rank rows into ONE list: score first, then the rows that actually go somewhere, then the name.
 *
 * Fully deterministic to the id, so a re-query never reshuffles equal rows under the cursor.
 */
function byRank(a: CrossZoneRow, b: CrossZoneRow): number {
  if (a.score !== b.score) return b.score - a.score
  const ra = isReachable(a)
  const rb = isReachable(b)
  if (ra !== rb) return ra ? -1 : 1
  const na = a.name.toLowerCase()
  const nb = b.name.toLowerCase()
  if (na !== nb) return na < nb ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** The label corpus's hits, as rows. Main already ranked them; the merge re-ranks against mobs. */
function labelRow(hit: MapSearchHit): CrossZoneRow {
  const { zone, point } = hit
  return {
    id: `label#${zone}#${point.label}#${String(point.x)},${String(point.y)}`,
    kind: 'label',
    name: point.display,
    zone,
    zoneName: zoneLabel(zone),
    at: { x: point.x, y: point.y },
    note: null,
    score: hit.score
  }
}

/** What this catalog row can say about ONE of the zones its page names. */
function mobRow(entry: MobEntry, zoneRaw: string, score: number, installed: ReadonlySet<ZoneShort>): CrossZoneRow {
  const stem = zoneShortNameFromCatalog(zoneRaw)
  const zone = stem != null && (installed.size === 0 || installed.has(stem)) ? stem : null
  const zoneCount = entry.zones?.length ?? 0
  // The SAME attribution rule the pane applies on the map you are standing on (mobPins.ts): one
  // stated position and several named zones is a coin flip, so it places nothing.
  const pins = zoneCount === 1 ? mobPins(entry) : []
  const first = pins[0]
  return {
    id: `mob#${entry.page}#${zoneRaw}`,
    kind: 'mob',
    name: entry.name,
    ...(entry.level === undefined ? {} : { level: entry.level }),
    zone,
    zoneName: stem == null ? zoneRaw : zoneLabel(stem),
    at: zone == null || !first ? null : { x: first.x, y: first.y },
    note: mobNote(entry, stem, zone, zoneCount),
    score
  }
}

/**
 * The one extra fact the row owes the reader, in the order the reader can act on.
 *
 * "There is no map" comes before "the page states no position", because the first makes the second
 * moot. The two no-position reasons stay DIFFERENT sentences (the pane's own rule): a page that
 * stated nothing and a page whose statement cannot be attributed are not the same missing thing.
 */
function mobNote(entry: MobEntry, stem: ZoneShort | null, zone: ZoneShort | null, zoneCount: number): string | null {
  if (stem == null) return 'no map is named that'
  if (zone == null) return 'no map installed for this zone'
  if (zoneCount > 1) return `position stated, but the page lists ${String(zoneCount)} zones`
  return (entry.loc?.length ?? 0) > 0 ? null : 'no location on the wiki page'
}

/**
 * Every catalog row whose NAME matches, once per zone its page names, minus the zone on screen.
 *
 * Exported for its own test and for the measurement above; the pane goes through `crossZoneRows`.
 */
export function searchMobsAcrossZones(args: {
  query: string
  catalog: readonly MobEntry[]
  /** The stem ON SCREEN — its mobs are the pane's own section, so they are not repeated here. */
  here: ZoneShort | null
  /** Stems an installed pack provides. EMPTY means "not known yet", never "nothing is installed". */
  installed: ReadonlySet<ZoneShort>
  limit?: number
}): CrossZoneRow[] {
  const query = tokenize(args.query)
  if (query.length === 0) return []
  const hay = haystacks(args.catalog)
  const rows: CrossZoneRow[] = []
  for (let i = 0; i < args.catalog.length; i += 1) {
    const score = scoreQuery(query, hay[i])
    if (score == null) continue
    const entry = args.catalog[i]
    for (const zoneRaw of entry.zones ?? []) {
      const row = mobRow(entry, zoneRaw, score, args.installed)
      if (row.zone != null && row.zone === args.here) continue
      rows.push(row)
    }
  }
  return rows.sort(byRank).slice(0, args.limit ?? CROSS_ZONE_LIMIT)
}

/**
 * THE PANE'S "somewhere else" LIST: the map corpus and the bestiary, ranked together.
 *
 * `hits` arrive from `maps:search` already scored by the same `shared/fuzzy` scorer main and the
 * renderer share, which is what makes one ranked list honest rather than two lists interleaved by
 * assertion. `here` is dropped from BOTH halves; main's half is filtered by the caller, which
 * knows which zone is actually drawn.
 */
export function crossZoneRows(args: {
  query: string
  catalog: readonly MobEntry[]
  hits: readonly MapSearchHit[]
  here: ZoneShort | null
  installed: ReadonlySet<ZoneShort>
  limit?: number
}): CrossZoneRow[] {
  const limit = args.limit ?? CROSS_ZONE_LIMIT
  const mobs = searchMobsAcrossZones({ ...args, limit })
  // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 8: MapSearchHit comes from a corpus still bundled in the renderer (mobs/posky/bosses JSON). Moves behind knowledge queries when that surface cuts over.
  const labels = args.hits.filter((h) => h.zone !== args.here).map(labelRow)
  return [...mobs, ...labels].sort(byRank).slice(0, limit)
}
