// zoneAdvice.ts — WHERE SHOULD I BE, for one of three reasons.
//
// Owner ask (kaltinril 2026-09-11): *"somewhere it shows recommendation for where to level, where
// to get motes (should be equal or higher level but not crazy higher)"* - and, the next night,
// having seen every row of the first version print the same number: *"why not expand this new tab
// inside maps to give different level ranges for different stuff - like if you're going for D4
// mote farming, or best EXP or best gear, or most wishlist items in a single zone"*.
//
// ── ONE RANKER, THREE GOALS, AND WHY IT IS NOT FOUR ──────────────────────────────────────────
//
//   EXPERIENCE. Con drives experience and this project's own logged fights put the rates on it
//   (owner's shadowknight, 2026-09-07, con bands from the bestiary against his level per kill):
//   white / yellow / red 7 to 10 motes per 100 kills, blue 4.2, green 3.1. Even and a-reach lead,
//   green is listed last rather than dropped - it is slower, not useless.
//
//   MOTE GRADE. The same measurements say the grade FLOOR rises with zone difficulty and that
//   Superior-and-better come from harder content, not from luckier kills in easy content. So this
//   goal leads with the zones that start ABOVE you and drops green entirely: 3.1 per hundred is
//   not a mote plan. "D4" is what the owner called it, and D4 is a real thing - the top instance
//   difficulty tier - but WHICH ZONES OFFER WHICH TIERS IS STATED NOWHERE IN ANY CORPUS THIS APP
//   HOLDS, so this goal is named for what it can measure (harder zone, higher floor) and not for
//   the tier it cannot see.
//
//   WISH LIST. The bestiary states what each mob drops and where it stands; the wish list states
//   what you want. Zones are ranked by how many DISTINCT wished items can drop in them. This is the
//   one goal that keeps a `deadly` zone: the item is where it is, and hiding the zone would hide
//   the item. The fit chip still says deadly, so the reader knows what the trip costs.
//
//   NOT BUILT: "best gear". That needs a value for a piece of gear, and the worth-score that
//   answers it lives on the `gear-tab-improvements` branch, not this one. A ranking on
//   "how many items drop here" would be a count of junk. It is deferred, not forgotten.
//
// ── WHAT EVERY GOAL STILL REFUSES ────────────────────────────────────────────────────────────
//
// NO ROUTE, NO PER-HOUR. These rank zones by fit and by what the catalog says drops there; they say
// nothing about how fast you kill, what you survive with a given group, or how far the zone is.
// `n` rides on every row for the same reason it rides on the band: a zone the catalog knows through
// four mobs is a weaker claim than one it knows through forty, and hiding that overstates the list.
//
// ── THREE ZONES THAT ARE NEVER ADVICE, WHATEVER THE BAND SAYS (owner, 2026-09-14) ────────────
//
// The first cut ranked by the band alone, and the owner's screenshot at level 44 led with Siren's
// Grotto, Velketor's and Chardok, listed Neriak Commons and the Felwithes as hunting grounds, and
// offered the Plane of Fear to a character the game would not let in. Each is a fact the zone
// table holds (`shared/zones.ts`) and the band cannot express:
//
//   NOT IN THIS ERA. *"some of these recommendations are not in the current era"*. The catalog
//   documents Kunark and Velious wholesale; `zoneInEra` is the one rule that says what EQ Legends
//   has, and the same "Current era" switch the Closest-port card wears lifts it here. A zone the
//   table places but gives NO era (New Sebilis Expedition, EQL-new) is kept - it is in the game,
//   and calling it out of era would be a lie - and so is a spelling the table cannot place at
//   all: unknown reads as unknown, never as out of era (`zones.ts`, the `ZoneEra` rule).
//
//   A CITY. *"make sure it exits cities, we don't want to kill npcs like that"*. A home city has
//   a band because the catalog documents its guards; farming them is not a plan, on any goal.
//
//   LOCKED BELOW YOUR LEVEL. *"plane of fear is locked to level 45"*. A door that will not open is
//   not deadly, it is absent - so this holds for the wish list too, the one goal that keeps deadly.

import { zoneEntryFromCatalog } from './zones'
import { zoneInEra } from './zoneTravel'
import { zoneFit, type ZoneFit, type ZoneLevelBand } from './zoneLevels'

/** Why you are asking. */
export type ZoneGoal = 'exp' | 'motes' | 'wish'

/**
 * MOTES PER HUNDRED KILLS, by how the zone cons — measured, this project's own log (2026-09-07,
 * the owner's shadowknight). The band figures are the midpoint of the measured 7-to-10 range for
 * the con colours each fit implies.
 *
 * These are RATES PER KILL and the surface must say so: a green zone you clear three times faster
 * is not three times worse, and no number here knows your kill speed.
 */
export const MOTES_PER_100: Readonly<Record<ZoneFit, number>> = {
  green: 3.1,
  even: 8.5,
  hard: 8.5,
  deadly: 8.5
}

/** One zone, judged against one level for one goal. */
export interface ZoneAdvice {
  zone: string
  band: ZoneLevelBand
  fit: ZoneFit
  /** the measured per-100-kill mote rate for this fit — a rate, never a total */
  motesPer100: number
  /** how many catalog mobs the band rests on — the weight of the whole row */
  n: number
  /** how many DISTINCT wished items the bestiary says can drop here (0 when none, or no list) */
  wished: number
}

export interface RankOptions {
  goal?: ZoneGoal
  /** zones the catalog knows through fewer mobs than this are held back */
  min?: number
  /** zone → distinct wished items droppable there; absent means "no wish list", every zone 0 */
  wished?: ReadonlyMap<string, number>
  /** keep only these fits; absent or empty means every fit the goal admits */
  fits?: ReadonlySet<ZoneFit>
  /** a zone-name search, folded case-insensitively; absent or blank means everything */
  search?: string
  /** keep only zones EQ Legends has now - ON unless the caller lifts it, the Closest-port rule */
  eraOnly?: boolean
}

/** Best first for experience: even, then a reach, then green. `deadly` is never experience advice. */
const EXP_RANK: Readonly<Record<ZoneFit, number>> = { even: 0, hard: 1, green: 2, deadly: 3 }

/** Best first for motes: the reach leads, because that is where the grade floor is higher. */
const MOTE_RANK: Readonly<Record<ZoneFit, number>> = { hard: 0, even: 1, green: 2, deadly: 3 }

/** Does this row belong on the list for this goal at all? */
function admits(goal: ZoneGoal, fit: ZoneFit, wished: number): boolean {
  if (goal === 'wish') return wished > 0
  if (goal === 'motes') return fit === 'even' || fit === 'hard'
  return fit !== 'deadly'
}

/**
 * Can this zone be walked into and hunted at all - the three refusals in the header. Reads the
 * zone table through the catalog's own spelling, because the bands are keyed by it; a spelling
 * the table does not hold is unknown, and unknown is kept.
 */
function huntable(zone: string, level: number, eraOnly: boolean): boolean {
  const entry = zoneEntryFromCatalog(zone)
  if (entry === null) return true
  if (entry.city === true) return false
  if (entry.minLevel !== undefined && level < entry.minLevel) return false
  return !eraOnly || entry.era === undefined || zoneInEra(entry)
}

/** The caller's narrowing - evidence floor, search, fit filter - on top of what the goal admits. */
function keeps(zone: string, band: ZoneLevelBand, fit: ZoneFit, opts: RankOptions): boolean {
  if (band.n < (opts.min ?? 0)) return false
  const needle = (opts.search ?? '').trim().toLowerCase()
  if (needle !== '' && !zone.toLowerCase().includes(needle)) return false
  return opts.fits === undefined || opts.fits.size === 0 || opts.fits.has(fit)
}

/** The goal's order. Every comparator ends on the zone name so the same input always lists the same way. */
function compare(goal: ZoneGoal): (a: ZoneAdvice, b: ZoneAdvice) => number {
  if (goal === 'wish') {
    return (a, b) =>
      b.wished - a.wished ||
      EXP_RANK[a.fit] - EXP_RANK[b.fit] ||
      b.band.typical[0] - a.band.typical[0] ||
      a.zone.localeCompare(b.zone)
  }
  const rank = goal === 'motes' ? MOTE_RANK : EXP_RANK
  // Within a fit the HARDER band leads: the measured grade floor rises with difficulty and the
  // per-kill rate does not separate them. Ties break on `n`, so the better-documented zone is
  // named first — a statement about our confidence, not about the game.
  return (a, b) =>
    rank[a.fit] - rank[b.fit] ||
    b.band.typical[0] - a.band.typical[0] ||
    b.n - a.n ||
    a.zone.localeCompare(b.zone)
}

/**
 * The zones worth your time at `level`, for `goal`, best first.
 *
 * `deadly` ZONES ARE DROPPED for experience and motes rather than ranked last. The owner's own
 * words bound this feature - *"not crazy higher"* - and a list that ends in six zones you cannot
 * survive teaches the reader to stop reading. The wish-list goal is the one exception and the
 * header says why.
 */
export function rankZones(
  bands: ReadonlyMap<string, ZoneLevelBand>,
  level: number,
  opts: RankOptions = {}
): ZoneAdvice[] {
  const goal = opts.goal ?? 'exp'
  const eraOnly = opts.eraOnly ?? true
  const out: ZoneAdvice[] = []
  for (const [zone, band] of bands) {
    if (!huntable(zone, level, eraOnly)) continue
    const fit = zoneFit(band, level)
    const wished = opts.wished?.get(zone) ?? 0
    if (!admits(goal, fit, wished) || !keeps(zone, band, fit, opts)) continue
    out.push({ zone, band, fit, motesPer100: MOTES_PER_100[fit], n: band.n, wished })
  }
  return out.sort(compare(goal))
}

// ---- a column sort on top of the goal's order (owner, 2026-09-12: "need filters/search/sort") -

export type AdviceSortKey = 'fit' | 'zone' | 'low' | 'high' | 'motes' | 'wished' | 'n'
export interface AdviceSort {
  key: AdviceSortKey
  dir: 'asc' | 'desc'
}

/** What a column reads for one row - numbers for the numeric columns, the fit's rank for the chip. */
const SORT_VALUE: Readonly<Record<AdviceSortKey, (row: ZoneAdvice) => number | string>> = {
  fit: (r) => EXP_RANK[r.fit],
  zone: (r) => r.zone.toLowerCase(),
  low: (r) => r.band.typical[0],
  high: (r) => r.band.typical[1],
  motes: (r) => r.motesPer100,
  wished: (r) => r.wished,
  n: (r) => r.n
}

/**
 * The rows in column order, the Gear table's arrangement (`sortGearRows`): the view owns a sort
 * state and asks for the rows in it, and the ordering runs HERE rather than in the renderer.
 * Ties fall back to the goal's own order, which the input already carries - a stable sort keeps it.
 */
export function sortAdvice(rows: readonly ZoneAdvice[], sort: AdviceSort): ZoneAdvice[] {
  const value = SORT_VALUE[sort.key]
  const sign = sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = value(a)
    const y = value(b)
    if (x === y) return 0
    return (x < y ? -1 : 1) * sign
  })
}

/** Click a column: a new column starts descending for numbers and ascending for names; the same column flips. */
export function nextAdviceSort(sort: AdviceSort | null, key: AdviceSortKey): AdviceSort {
  if (sort !== null && sort.key === key) return { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
  return { key, dir: key === 'zone' || key === 'fit' ? 'asc' : 'desc' }
}

/**
 * THE GRADE YOUR LEVEL CAN BANK — measured at about one tier per five levels, with 50 reaching
 * tier 10 (`eql-measured-game-facts`). Stated here because it is the half of the mote answer that
 * a zone ranking cannot express: a low character in a high zone is capped by his own level, not by
 * what drops there.
 */
export function moteGradeCap(level: number): number {
  return Math.max(1, Math.min(10, Math.floor(level / 5)))
}
