// mobTypes.ts — the MOB-KNOWLEDGE half of the shared type vocabulary.
//
// Split out of `types.ts` when the map viewer's zone pane added spawn coordinates to the
// catalog (`MobEntry.loc`) and the barrel crossed its measured 400-code-line ceiling. That
// ceiling is not arbitrary — it sits between p90 and p95 of this tree (eslint.config.mjs) —
// and a barrel that has to grow is precisely what it is asking to have split, so the mob
// block moved out WHOLE rather than the rule moving up. `types.ts` re-exports every name
// below with `export type *`, so not one import site anywhere had to change.
//
// Types only: nothing here executes, and the re-export is type-only, so this file adds no
// runtime import to any bundle.

// ----- Scraped MOB catalog (produced by scripts/scrape-mobs.ts) -----
//
// The DEFINITIVE drop source. The wiki's mob pages state what a mob drops; your own loot
// history only corroborates it ("and you've had 3 of these"). So the drop list is scraped ONCE,
// committed, and consulted LOCALLY — the same local-first precedent posky.json and quests.json
// set, for the same reasons: instant, offline, and no per-mob network call to answer a `/con`.
//
// Deliberately COMPACT: names only, no wikitext blobs, no drop-rate spans. The catalog is
// ES-imported (electron-vite inlines it into the main bundle), so every field costs bundle size
// on every user's disk; rarity annotations and the rest of a page stay behind the live-wiki
// FALLBACK, which mobLookup still uses for a mob the catalog doesn't have yet.

/**
 * ONE spawn point a mob page states under `|location`, in the page's OWN `/loc` order.
 *
 * MEASURED (2026-08-04, all 7,866 catalog pages re-read from eqlwiki.com): 6,309 of them state
 * at least one numeric coordinate. The dominant shapes are `(131, 342)` (2,349 pages) and
 * `60% @ (131, 342)` (2,193, often repeated for several spawn points); 120 pages state a third
 * number. The rest are prose the parser refuses to guess at — `Various` (533), `?` (273),
 * `Need Info` (79), `Wanders` (10).
 *
 * THE ORDER IS THE GAME'S, NOT A MAP'S, so the field names are the ones the app already uses
 * for a `/loc` reading (`EqLoc` in renderer/src/features/maps/mapGeometry.ts): EverQuest prints
 * North/South first, West/East second, elevation last. `mapFromLoc` is the ONE conversion into
 * map-file coordinates and this type is shaped to feed it directly.
 *
 * THAT CONVERSION IS NOW MEASURED, not merely documented. `mapFromLoc` was written from one
 * worked example (Yther Ore's `/loc (155, -411, 15)` = `P 411, -155, 15`); of the six candidate
 * transforms tried over 7,423 stated mob coordinates in the 119 zones whose map files are on
 * this machine, its `(mapX, mapY) = (-ew, -ns)` puts 99.4% inside the zone's own extent (next
 * best: 66.4%) and lands a median 14.8 map units from the nearest wall segment (next best:
 * 170.8). Elevation un-negated wins 117 of the 120 pages that state one.
 */
export interface MobLoc {
  /** `/loc`'s FIRST number — North/South, verbatim. */
  ns: number
  /** `/loc`'s SECOND number — West/East, verbatim. */
  ew: number
  /** `/loc`'s third number, elevation, on the ~2% of pages that state one. */
  z?: number
  /** The spawn-point share the page stated (`60% @ (…)`), 0-100. Absent when it stated none. */
  pct?: number
}

/** One mob/NPC page from the wiki, reduced to what a consider card needs. */
export interface MobEntry {
  /** wiki page title (linkable, and the resolve key for the live fallback) */
  page: string
  /** the page's own `|name` — the IN-GAME name, article and casing as the wiki writes it */
  name: string
  /** level EXACTLY as the page states it — a RANGE as often as a number ("36-40", "2 - 4") */
  level?: string
  /** home zone(s) from the `|zone` field; "Various" is a real value, not a placeholder */
  zones?: string[]
  /** item names from `|known_loot`. Absent when the page has no loot section at all. */
  drops?: string[]
  /**
   * Spawn points from `|location`, in page order. Absent when the page stated no numbers at all
   * — which is the honest answer for the ~20% that say "Various" or "?" (world-model law 1).
   */
  loc?: MobLoc[]
}

export interface MobData {
  scrapedAt: string
  /** human-readable provenance (which enumeration produced this) */
  source: string
  mobs: MobEntry[]
}

// ----- Mob knowledge ("what does this thing drop", Task #63) -----
//
// The consider answer: you `/con` something, and the app says what it drops. THREE sources,
// mirroring itemLookup's local-first architecture (main/mobLookup.ts):
//   LOCAL 1 — your OWN loot history for that mob (`dropsSeen`). Personal, offline, always
//             current, and the only source that can say "you've had 3 of these off it".
//   LOCAL 2 — the scraped quest catalog's `relatedNpcs` (`quests`), so a mob that matters to a
//             quest says so without a network call.
//   WIKI    — the mob page's `|known_loot` list (`dropsWiki`), plus the level/zone it states.
// Every field is present only when a source actually said it (law 1) — a mob with no page, or a
// page with no loot section, comes back with `notFound` and no invented drop list.

/** One item a mob's wiki page lists under `|known_loot`. */
export interface MobDrop {
  /** item name, exactly as the `{{:Item Name}}` transclusion spells it */
  item: string
  /**
   * Rarity EXACTLY as the page states it — the wiki writes it three different ways
   * ("Rare" / "Ultra Rare" / "Common", a bare "18.4%", or an empty span meaning "unstated").
   * Absent when the span was empty or missing; never normalized into a scale we'd be inventing.
   */
  rarity?: string
  /**
   * THE ITEM PAGE'S OWN ERA BANNER, VERBATIM ("Velious", "FearHateRevamp") — the two fields
   * below are the ERA JOIN'S EVIDENCE, attached in main by `mobDropEra.ts` because that is where
   * the 11k-item corpus lives (`src/main/data/items.json`). They carry no verdict: what a token
   * MEANS is decided in exactly one place for the whole app (`shared/planner/era.ts`), and the
   * renderer folds these two into the same `EraSubject` the planner and the wish list use.
   *
   * WHY THIS EXISTS (JOS-377). The wiki's mob page transcludes `{{:Item}}` per row and each row
   * draws its OUT OF ERA pill from the item page; our mob-loot surfaces rendered `dropsWiki`
   * straight from the catalog and never consulted the era layer, so Cazic Thule offered the
   * seven-item Fear-revamp table as farmable loot.
   *
   * BOTH ARE OPTIONAL AND ABSENT IS HONEST. A record served by an older build's persistent cache,
   * or an item the corpus does not hold, simply arrives without them and renders as `era?` -
   * "nothing states an era", never "it is gone" (law 1).
   */
  eraTag?: string
  /**
   * The zones the ITEM PAGE itself named under `|dropsfrom`, deduped. Layer 1's evidence from the
   * half of the wiki the renderer cannot see: it already inverts the mob catalog for zones
   * (`lib/itemSources.sourcesFor`), and the two halves omit different things.
   */
  eraZones?: string[]
}

/** One item the CURRENT character has actually looted off this mob (own loot history). */
export interface MobSeenDrop {
  item: string
  /** how many we've looted (stacked loots add their `count`, not 1) */
  count: number
  /** most recent loot timestamp */
  lastTs: number
}

/** One quest the local catalog associates with this mob (`relatedNpcs`). */
export interface MobQuestUse {
  quest: string
  page?: string
  giver?: string
  zone?: string
}

/** The "what does this drop" card for a single mob name. */
export interface MobKnowledge {
  /** the mob name looked up, as requested (raw display casing) */
  name: string
  /** the wiki page title actually resolved */
  page?: string
  /**
   * Level EXACTLY as the page states it — a RANGE at least as often as a number ("36-40",
   * "2 - 4", "18"). Kept as text rather than parsed into a number we'd have to pick a side of.
   */
  levelText?: string
  /** home zone from the page ("Lower Guk", "Various"); wiki link markup stripped. */
  zone?: string
  /** the page's `|known_loot` list. Absent when the page has no such field (e.g. a merchant). */
  dropsWiki?: MobDrop[]
  /** what YOU have looted off it, newest/most-looted first. Absent when you never have. */
  dropsSeen?: MobSeenDrop[]
  /** quests the local catalog ties to this mob. Absent when none do. */
  quests?: MobQuestUse[]
  /** served from the persistent cache (vs a fresh network lookup) */
  cached: boolean
  /** the wiki lookup ran and found no page for this mob (a real negative) */
  notFound?: boolean
  /** the wiki was unreachable — local sources may still have answered */
  offline?: boolean
}
