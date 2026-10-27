// gear/gearZones.ts — THE ZONE FILTER'S VOCABULARY (fork decision, kaltinril 2026-09-26: *add a
// filter by zone to the gear tab search page*).
//
// A PICK IS A ZONE, NEVER A SPELLING. The drop trio's zone strings are the wiki's, and the wiki
// spells one place several ways — MEASURED 2026-09-26 over the committed corpus: 174 distinct
// spellings on 3,790 rows, among them `Unrest` (6 rows), `Estate of Unrest` (3) and `The Estate of
// Unrest` (106). A picker over the spellings would offer all three and each would answer for a
// third of the zone. So the pick is the MAP STEM (`unrest`), reached through the same resolution the
// Zone cell's link already uses (`dropLinks.dropZoneTarget` → `zoneShortNameFromCatalog`): the zone
// a cell opens and the zone a pick keeps cannot disagree, because they are one lookup.
//
// WHAT THE TABLE REFUSES IS NOT OFFERED (world-model law 1). 20 of the 174 spellings resolve to
// nothing — the ambiguous ones (`Commonlands`, `Kaladim`), the placeholders (`Various`) and the wiki
// cells whose links ran together (`Burning WoodsEmerald Jungle`); shared/zones.ts lists them and
// why none is guessed at. They are 5 rows of the 3,790 that state a zone at all and every one of
// them is still in the search box's haystack (gearData.toRow), so nothing became unreachable.
//
// PURE AND NODE-TESTABLE (`tests/gearZoneFilter.test.mts`), the gearFilter.ts precedent: value
// imports are RELATIVE, nothing here touches React, storage, IPC or the corpus.

import type { ZoneShort } from '../../../../shared/maps'
import type { GearRow } from '../../../../shared/planner/gear'
import { ZONES, zoneKey, zoneShortNameFromCatalog } from '../../../../shared/zones'

/** Every stem the zone table knows — the closed vocabulary a STORED pick is checked against. */
export const GEAR_ZONE_STEMS: readonly ZoneShort[] = ZONES.map((z) => z.short)

const NAME_BY_STEM: ReadonlyMap<ZoneShort, string> = new Map(ZONES.map((z) => [z.short, z.name]))

/** The words a pick wears: the table's own name for the zone (`unrest` → `The Estate of Unrest`). */
export function gearZoneLabel(stem: ZoneShort): string {
  return NAME_BY_STEM.get(stem) ?? stem
}

// The filter asks once per zone per row and the corpus has 174 spellings, so the fold runs 174
// times per window rather than ten thousand times per pick. `null` is cached too — a refusal is an
// answer.
const STEM_BY_SPELLING = new Map<string, ZoneShort | null>()

/** The zone a drop-zone spelling names, or null when the table refuses it. */
export function gearZoneOf(spelling: string): ZoneShort | null {
  let stem = STEM_BY_SPELLING.get(spelling)
  if (stem === undefined) {
    stem = zoneShortNameFromCatalog(spelling)
    STEM_BY_SPELLING.set(spelling, stem)
  }
  return stem
}

/**
 * The zones the picker offers: every zone at least one row drops in, in the order a reader looks a
 * name up — by the name with its article folded, so `The Feerrott` files under F.
 *
 * DERIVED FROM THE ROWS rather than read off the table, because the table also knows places
 * nothing drops in (`The Bazaar`), and an option that can only ever answer with an empty table is
 * not an option.
 */
export function gearZoneOptions(rows: readonly Pick<GearRow, 'dropZones'>[]): ZoneShort[] {
  const seen = new Set<ZoneShort>()
  for (const row of rows) {
    for (const spelling of row.dropZones ?? []) {
      const stem = gearZoneOf(spelling)
      if (stem !== null) seen.add(stem)
    }
  }
  return [...seen].sort((a, b) => zoneKey(gearZoneLabel(a)).localeCompare(zoneKey(gearZoneLabel(b))))
}

/**
 * The offered zones, plus any PICK that is not among them. A stored pick can outlive its zone (a
 * rescrape moved the last item out of it) and is read before the index has arrived; either way it
 * is still filtering, so it must still be a chip somebody can take off.
 */
export function zoneOptionsWith(options: readonly ZoneShort[], picks: readonly ZoneShort[]): readonly ZoneShort[] {
  const missing = picks.filter((p) => !options.includes(p))
  return missing.length === 0 ? options : [...options, ...missing]
}
