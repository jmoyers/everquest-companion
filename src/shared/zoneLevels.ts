// zoneLevels.ts — WHAT LEVEL IS THIS ZONE FOR, from the bestiary the app already carries.
//
// Owner ask (kaltinril 2026-09-11): *"also to show the level range of the map area?"*.
//
// No new data: `mobs.json` states a level on 7,897 of its 7,918 rows and names the zones each mob
// stands in, and `features/mobs/mobZone.mobsInZone` already does the zone join for the pins on the
// very map this answers for. This module is only the arithmetic on top.
//
// ── WHY A TYPICAL BAND AND NOT MIN-TO-MAX ────────────────────────────────────────────────────
//
// Min and max are the wrong two numbers and Befallen is the proof. Measured on the committed
// catalog: 37 mobs, min 4, MAX 61 — one wandering high-level named drags a low-forties dungeon's
// stated range across the whole game, and "Befallen: 4-61" tells a level 20 nothing at all. The
// tenth and ninetieth percentiles say 6-26, which is what the zone is actually for.
//
// BOTH PAIRS ARE KEPT, because they answer different questions and neither is noise: the band is
// "should I be here", the outright range is "what is the worst thing that can walk into me". The
// surface leads with the band and keeps the extremes available.
//
// ── WHAT IT DOES NOT CLAIM ───────────────────────────────────────────────────────────────────
//
// THIS IS THE BESTIARY'S OPINION, not the server's. The catalog is what wiki editors have written
// down, so a zone with four documented mobs gets a band computed from four mobs — `n` rides on the
// answer for exactly that reason, and a surface that draws this without drawing `n` is overstating
// it. A zone with NO levelled rows answers null, never a zero (law 1: silence is not a number).

/** What a zone's documented inhabitants say about it. */
export interface ZoneLevelBand {
  /** how many catalog rows carried a level — the weight of every other number here */
  n: number
  /** the tenth and ninetieth percentiles: what the zone is FOR */
  typical: readonly [number, number]
  /** the outright extremes, including the one wandering named */
  min: number
  max: number
}

/** The p-th percentile of an ascending list, nearest-rank — no interpolation to invent a level. */
function percentile(ascending: readonly number[], p: number): number {
  const rank = Math.min(ascending.length - 1, Math.max(0, Math.round(p * (ascending.length - 1))))
  return ascending[rank]
}

/**
 * The band, or null when nothing in the catalog states a level for this zone.
 *
 * `levels` is every stated level of every mob the catalog places in the zone — duplicates included,
 * because a zone with thirty level-25 mobs and one level-60 named IS a level-25 zone and the
 * percentiles can only know that if the thirty are all present.
 */
export function zoneLevelBand(levels: readonly number[]): ZoneLevelBand | null {
  const clean = levels.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
  if (clean.length === 0) return null
  return {
    n: clean.length,
    typical: [percentile(clean, 0.1), percentile(clean, 0.9)],
    min: clean[0],
    max: clean[clean.length - 1]
  }
}

/**
 * IS THIS ZONE WORTH YOUR TIME AT THIS LEVEL — the shared judgement behind both the map caption
 * and the mote advice (owner ask: motes *"should be equal or higher level but not crazy higher"*).
 *
 *   'green'  the zone's band sits below you: safe, and the experience with it
 *   'even'   you are inside the band, or within a level of it - where you want to be
 *   'hard'   the band starts above you but within reach (the owner's "not crazy higher")
 *   'deadly' the band starts far enough above you that this is somebody else's zone
 *
 * THE THRESHOLDS ARE THE GAME'S CON COLOURS, not invented: even-and-up is where experience is
 * worth taking, and the app's own measured con-rate work uses the same shape. They are stated as
 * ONE table here so the map caption and the mote recommender can never disagree about what
 * "a bit higher" means.
 */
export type ZoneFit = 'green' | 'even' | 'hard' | 'deadly'

/** How far above your level the band may start before it stops being worth walking into. */
export const REACH = 4

export function zoneFit(band: ZoneLevelBand, level: number): ZoneFit {
  const [low, high] = band.typical
  if (high < level) return 'green'
  if (low <= level + 1) return 'even'
  return low <= level + REACH ? 'hard' : 'deadly'
}
