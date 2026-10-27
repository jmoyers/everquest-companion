// maps/zoneBands — every zone's level band, computed once for the whole window.
//
// `useZoneTravel` needs ONE zone's band and computes it per zone; the advice list needs ALL of
// them at once and would otherwise walk the 7,918-row bestiary on every keystroke of the level
// field. The catalog is a committed JSON module that cannot change while the app runs, so the
// answer is taken once and kept — `mobSearch.MOB_CATALOG`'s own posture, one level up.
//
// IT IS KEYED BY ZONE, NOT BY SPELLING. The bestiary writes one place several ways ("Cazic Thule"
// and "Cazic-Thule", "RunnyEye Citadel" and "Runnyeye"), and keyed raw each spelling was a row of
// its own, splitting one zone's mobs across several bands. So a spelling the zone table knows
// (`zoneEntryFromCatalog`) folds to that zone's row and is shown under the table's name; one it
// does not know folds through `zoneKey` and keeps the bestiary's first spelling. A surface that
// wants to OPEN one of these maps still folds the name to a stem through `zones.ts` at the point of
// use, and says nothing when the fold has no answer (law 12: a zone we cannot name is not a zone we
// guess at).
//
// OUT-OF-ERA MOBS COUNT FOR NOTHING while the "Current era only" switch is on (the default). The
// Plane of Hate's page list carries the Fear/Hate revamp's level 60-63 mobs beside the classic
// ones, and they stretched its band and credited it with drops no classic server holds. Which
// mob is out is `shared/mobEra.mobOutOfEra`, the flag the data build sets from the era rules (a
// raw page banner alone decides nothing), outranked by the player's own log (a mob they killed,
// conned or looted from is in era for them); a mob without the flag is in. Every walk here asks
// it through `shared/zoneLevels.mobCountsInEra`. Lifting the switch counts every documented mob
// again, as it lifts the zone rule.
//
// THE CACHE IS KEYED BY THE LOG'S EVIDENCE TOO (`metInLog.metVersion()`): the evidence arrives
// after the first walk, and a mob it brings back must count from then on.

// Relative value imports, as in mobSearch.ts, so the node test runner can load this module.
import { metVersion } from '../../../../shared/metInLog'
import { mobCountsInEra, zoneLevelBand, type ZoneLevelBand } from '../../../../shared/zoneLevels'
import { zoneEntryFromCatalog, zoneKey } from '../../../../shared/zones'
import type { MobEntry } from '@shared/types'
import { MOB_CATALOG } from '../mobs/mobSearch'
import { mobsInZone, sortLevel } from '../mobs/mobZone'
// The same two readers the map's own wish-list pins use, so a zone's count and the pins on its map
// can never disagree about which drops are wished.
import { sourceItemKey } from '../../lib/itemSources'
import { wishedDrops } from './mobPins'

/** One answer per state of the era switch, each taken once per state of the log's evidence. */
const CACHE = new Map<boolean, ReadonlyMap<string, ZoneLevelBand>>()
/** The evidence version the cached answers were taken under; a move empties the cache. */
let cachedMet = metVersion()

/** The fold key → the name its row is shown under, filled as the catalog is walked. */
const ROW_NAME = new Map<string, string>()

/** The rows a mob's zones land in - a set, so two spellings of one zone count the mob once. */
function rowsOf(zones: readonly string[] | undefined): Set<string> {
  const out = new Set<string>()
  for (const zone of zones ?? []) {
    const entry = zoneEntryFromCatalog(zone)
    // Prefixed so a fold can never land on a stem that happens to read the same.
    const key = entry === null ? `fold:${zoneKey(zone)}` : `map:${entry.short}`
    if (key === 'fold:') continue
    if (!ROW_NAME.has(key)) ROW_NAME.set(key, entry?.name ?? zone)
    out.add(ROW_NAME.get(key) ?? zone)
  }
  return out
}

/**
 * Zone row name → what its documented inhabitants say about it.
 *
 * A mob standing in several zones counts in each, which is correct: it really is in all of them,
 * and the band is about the zone rather than about the mob.
 *
 * `eraOnly` (the "Current era only" switch, on by default) leaves out the mobs `mobOutOfEra` names.
 */
export function zoneBands(eraOnly = true): ReadonlyMap<string, ZoneLevelBand> {
  const met = metVersion()
  if (met !== cachedMet) {
    CACHE.clear()
    cachedMet = met
  }
  let held = CACHE.get(eraOnly)
  if (held === undefined) {
    held = zoneBandsOf(MOB_CATALOG, eraOnly)
    CACHE.set(eraOnly, held)
  }
  return held
}

/** `zoneBands` over any catalog, uncached - the fold itself, so a test can hand in fixtures. */
export function zoneBandsOf(catalog: readonly MobEntry[], eraOnly: boolean): ReadonlyMap<string, ZoneLevelBand> {
  const levels = new Map<string, number[]>()
  for (const mob of catalog) {
    if (!mobCountsInEra(mob, eraOnly)) continue
    // The first digit run, as the mob lists read it, so "~19" and "<52" are levels too.
    const level = sortLevel(mob)
    if (level === null) continue
    for (const zone of rowsOf(mob.zones)) {
      const held = levels.get(zone)
      if (held) held.push(level)
      else levels.set(zone, [level])
    }
  }
  const out = new Map<string, ZoneLevelBand>()
  for (const [zone, ls] of levels) {
    const band = zoneLevelBand(ls)
    if (band !== null) out.set(zone, band)
  }
  return out
}

/**
 * ONE zone's band, the Maps tab's caption for the map on screen (`useZoneTravel`). Joined through
 * `mobsInZone`, the join the map's own pins and mob list make, so the caption and the list never
 * describe two different sets of inhabitants; under `eraOnly` without the mobs out of era, as
 * every band here. Uncached: one zone, on a zone change.
 */
export function zoneBandOf(zoneName: string, eraOnly: boolean, catalog: MobEntry[] = MOB_CATALOG): ZoneLevelBand | null {
  const rows = mobsInZone(zoneName, catalog, (m) => mobCountsInEra(m, eraOnly))
  return zoneLevelBand(rows.map((m) => sortLevel(m) ?? Number.NaN))
}

/**
 * Zone row name, as `zoneBands` keys it → how many DISTINCT wished items the bestiary says can
 * drop there (owner ask, 2026-09-12: *"most wishlist items in a single zone"*).
 *
 * DISTINCT ITEMS, not drop rows: three mobs in one zone that each drop the same wished sword are
 * one reason to go, not three. Keyed through `sourceItemKey`, the way `wishedDrops` is, because
 * the catalog spells `Ghoulbane` and `Ghoulbane +1` on different mobs and they are one item.
 *
 * A mob standing in several zones counts in each - it really is in all of them.
 *
 * ONE WALK, not one per zone: `mobsInZone` would answer this too, but 193 zones times the catalog
 * on every wish-list edit is the wrong shape for a list that redraws as you type.
 *
 * `eraOnly` as `zoneBands`: a drop counts only from a mob in era, so an item only an out-of-era mob
 * drops is no reason to go. The item's own era is the Gear tab's business, not this count's.
 */
export function wishedByZone(
  wished: ReadonlySet<string>,
  eraOnly = true,
  catalog: readonly MobEntry[] = MOB_CATALOG
): ReadonlyMap<string, number> {
  const out = new Map<string, number>()
  if (wished.size === 0) return out
  const byZone = new Map<string, Set<string>>()
  for (const mob of catalog) {
    if (!mobCountsInEra(mob, eraOnly)) continue
    const drops = wishedDrops(mob, wished)
    if (drops.length === 0) continue
    for (const zone of rowsOf(mob.zones)) {
      let items = byZone.get(zone)
      if (items === undefined) {
        items = new Set()
        byZone.set(zone, items)
      }
      for (const name of drops) items.add(sourceItemKey(name))
    }
  }
  for (const [zone, items] of byZone) out.set(zone, items.size)
  return out
}
