// gear/dropLinks.ts — what the drop trio's names OPEN (user ask, 2026-08-17).
//
// The Zone / Level / Mob columns state where an item comes from; this module is the door half of
// that statement, so a Gear row can hand its reader to the surfaces that already exist rather
// than making them retype a name. Two resolutions, both refuse-over-guess:
//
//   * A ZONE CELL opens the Maps tab. The cell's spellings are the mob catalog's + the item
//     page's own zone headings, which is exactly the corpus `zoneShortNameFromCatalog` was built
//     for (shared/zones.ts JOS-135) — and its `null` is honored here: a zone the table refuses
//     (`Freeport`, `Various`, …) renders as the plain text it always was, never a link to a
//     nearest guess (world-model law 1).
//
//   * A MOB CELL opens the mob's page. `ItemSource.mobPage` is the catalog row's wiki page title
//     — the catalog's own primary key — so when the source carried one, the click lands on THAT
//     page rather than whatever a bare-name search would pick ("a bandit" is nine pages). A
//     `dropsfrom`-only witness has no page; the bare name is still an honest `MobTarget` (the
//     same payload Overview's recent-kills rows send).
//
// Pure and node-tested (tests/gearDropLinks.test.mts): value imports are RELATIVE, the
// mobSearch.ts law. The page index is built lazily ONCE per window, off the same committed
// catalog `MOB_CATALOG` already loaded — a per-click scan of 7.9k rows would be rent paid on
// every click for an answer that never changes.

import type { MobEntry } from '@shared/types'
import type { ZoneShort } from '@shared/maps'
import type { MobTarget } from '../mobs/mobTarget'
import { zoneShortNameFromCatalog } from '../../../../shared/zones'
import { MOB_CATALOG } from '../mobs/mobSearch'

/** The map stem a drop-zone spelling opens, or null when the table refuses the name. */
export function dropZoneTarget(zone: string): ZoneShort | null {
  return zoneShortNameFromCatalog(zone)
}

let PAGE_INDEX: Map<string, MobEntry> | null = null

function entryForPage(page: string, catalog: readonly MobEntry[]): MobEntry | undefined {
  if (PAGE_INDEX === null) {
    PAGE_INDEX = new Map()
    // First writer wins, matching the catalog's own contract that `page` is unique.
    for (const e of catalog) if (!PAGE_INDEX.has(e.page)) PAGE_INDEX.set(e.page, e)
  }
  return PAGE_INDEX.get(page)
}

/**
 * The `MobTarget` a drop-mob cell opens. `page` is `dropPages[i]` — `''` when the witness stated
 * none (gearData.dropDetails keeps the arrays aligned), which degrades to the bare-name target.
 * `catalog` is injectable for the node tests; callers pass nothing.
 */
export function dropMobTarget(
  mob: string,
  page: string,
  catalog: readonly MobEntry[] = MOB_CATALOG
): MobTarget {
  const entry = page === '' ? undefined : entryForPage(page, catalog)
  return entry === undefined ? { mob } : { mob, entry }
}

/** Test seam: the lazy index survives the module the way any window-lifetime cache does. */
export function resetDropLinkIndex(): void {
  PAGE_INDEX = null
}
