// mobDropEra.ts — THE ERA JOIN'S EVIDENCE, attached to a mob's drop list (JOS-377).
//
// THE BUG THIS EXISTS FOR (owner, 2026-08-15): the Cazic Thule mob page listed eighteen drops and
// SEVEN of them are the Fear/Hate revamp table — Bile Etched Obsidian Choker, Brain of Cazic
// Thule, Cloak of the Fearsome, Eye of Cazic Thule, Halo of the Enlightened, Pauldrons of
// Ferocity, Robe of Inspiration — loot that is not in this game. The item corpus ALREADY KNEW:
// every one of those pages carries a `{{FearHateRevamp Era}}` or `{{Velious Era}}` banner, both
// OUT keys in the wiki's own register (`shared/planner/era.ts PAGE_ERA`, mirrored from
// `wgEQLEraOutKeys`), and the wiki's own mob page draws an OUT OF ERA pill on each of those rows
// because it transcludes `{{:Item}}` and the pill comes off the ITEM page. Our mob-loot surfaces
// rendered the catalog's `dropsWiki` straight through and never consulted the era layer at all.
// This applies to EVERY mob, not only Cazic Thule.
//
// WHAT THIS FILE DOES, AND WHAT IT REFUSES TO DO. It attaches EVIDENCE — the item page's era
// banner token and the zones that page named — and it reaches NO VERDICT. There is exactly one
// era rule in this app (`layeredVerdict`, three layers deep, argued over four tickets), and a
// second opinion computed main-side would be the beginning of a third. The renderer folds these
// two fields into the same `EraSubject` the planner and the wish list build and calls the same
// `eraChip` (features/mobs/dropEra.ts).
//
// WHY MAIN AND NOT THE RENDERER: the renderer can already invert the mob catalog for a drop's
// ZONES (`lib/itemSources.sourcesFor`) but there is no era banner in `mobs.json` — the banner
// lives on the item page, and the 11k-item corpus that holds it (`src/main/data/items.json`, 8.6
// MB) is main-only and includes the quest items a slotted-gear index does not (Brain of Cazic
// Thule is a quest piece, not gear).
//
// NO SECOND LOAD, NO SECOND INDEX. `itemLookup.ts` already ES-imports this exact JSON module, so
// the import below resolves to the same module instance and the same parse — and rather than
// building a second `Map` over it, the lookup reads the `items` record's OWN keys, which are
// already `itemKey(name)` (`itemsDb.ts` writes them). One object property read per drop.
//
// ELECTRON-FREE on purpose, the `mobLookupLocal.ts` precedent: `tests/mobDropEra.test.mts` drives
// the real annotation over the real committed corpus under the node runner.

import { itemKey, type ItemDbFile } from './itemsDb'
import type { MobDrop, MobKnowledge } from '../shared/types'
// ES-imported so electron-vite INLINES it into the main bundle — a path-relative readFile would
// miss in out/main/ (AGENTS.md toolchain note). Same module instance as itemLookup.ts's import.
import itemsJson from './data/items.json'

const items = (itemsJson as unknown as ItemDbFile).items

/**
 * ONE drop, annotated with what the ITEM PAGE says about its era. Returns the drop UNCHANGED when
 * the corpus has no page for it or that page states neither — absent is the honest answer, and the
 * renderer renders it as `era?` rather than as a verdict (law 1).
 */
export function annotateDrop(drop: MobDrop): MobDrop {
  const entry = items[itemKey(drop.item)]
  if (entry === undefined) return drop
  // `dropsFrom` is the page's `|dropsfrom` list; only the zone half is era evidence, and a zone
  // named by three of its mobs is one zone. Order is the page's, which no fold depends on.
  const zones = [...new Set((entry.dropsFrom ?? []).flatMap((s) => (s.zone === undefined ? [] : [s.zone])))]
  if (entry.eraTag === undefined && zones.length === 0) return drop
  const out: MobDrop = { ...drop }
  if (entry.eraTag !== undefined) out.eraTag = entry.eraTag
  if (zones.length > 0) out.eraZones = zones
  return out
}

/**
 * A knowledge record whose `dropsWiki` carries the era evidence.
 *
 * CALLED ON EVERY READ, NEVER BAKED INTO THE CACHE — the `mergeLocalKnowledge` posture, for the
 * same reason: the item corpus ships with the app and the mob cache does not expire its positives,
 * so an annotation written into a cached record would be frozen at whatever the corpus said the
 * day that mob was first looked up. Doing it on the way out also means the cache SHAPE is
 * unchanged and no `CACHE_VERSION` bump throws away anybody's mob cache.
 *
 * `dropsSeen` is deliberately untouched: those are items YOU pulled off this corpse, which is a
 * fact about your own play and not a claim about what the server ships.
 */
export function annotateDropEras(k: MobKnowledge): MobKnowledge {
  if (!k.dropsWiki?.length) return k
  return { ...k, dropsWiki: k.dropsWiki.map(annotateDrop) }
}
