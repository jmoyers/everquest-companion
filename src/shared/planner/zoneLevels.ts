// planner/zoneLevels.ts — HOW HIGH A ZONE READS, FOLDED FROM MOB LEVELS THE WIKI ACTUALLY STATED
// (docs/plans/gear-progression-planner.md §2.2, §3).
//
// THE QUESTION THAT MADE THIS FILE. The progression planner has to say "you belong in Crushbone at
// 12-18", and NOTHING in this repo states a zone's level range. `shared/zones.ts` refuses to invent
// one and says so in as many words. What the corpus DOES state is a level string per mob and a zone
// list per mob (7,872 `MobEntry` rows, plan §0.2), so a zone's profile is a FOLD OF STATED NUMBERS
// and never a range anybody typed. `sampled` rides on every profile for exactly that reason: the
// surface says "from N stated mob levels" rather than presenting a derived number as a fact.
//
// THE LEVEL RULE IS `mobZone.ts sortLevel`'s, PROMOTED OUT OF ITS PRIVATE CORNER (plan §2.2) and
// unchanged: the catalog states level exactly as the wiki wrote it — "56", "9-12", "2 - 4", "~53",
// "<50", "50+", "35?", "Unknown", "You can't consider that.", ~90 shapes over 7,872 rows — and the
// only thing every numeric shape shares is that its FIRST DIGIT RUN is the low end. No digits at all
// is `null`, NEVER 0 (law 1: absent is not zero, and a level-0 mob would sink to the front of every
// ranking this module feeds).
//
// AND THE CAVEAT THAT COMES WITH IT, STATED HERE RATHER THAN INHERITED SILENTLY: `"<50"` and `"50+"`
// both read 50. The rule is "first digit run", not "true low end", so a mob the wiki hedges as
// under-50 is folded at 50 and one it hedges as over-50 is folded at 50 as well. Both shapes are a
// handful of rows and neither has a reading a parser could defend — "<50" states no floor at all —
// so the fold takes the one number the string contains and this paragraph is the disclosure.
//
// THE KEY RULE, deliberately NARROW: `zoneLevelKey` is a TRIM + CASE-FOLD + whitespace collapse of
// the catalog's own spelling, and nothing else. It is NOT `shared/zones.ts zoneKey` — no leading
// article fold, no hyphen collapse, no alias table, no tier strip. That fold exists to join a LOG
// zone to a CATALOG zone, two naming authorities that must be reconciled; this map is a fold of the
// catalog against ITSELF, and merging "Feerrott" (1 row) into "The Feerrott" (40) here would state
// that two catalog spellings profile the same place, which is a claim only the alias table is
// allowed to make. Callers holding a zone name from anywhere else key through this same function,
// which is why it is exported. The DISPLAY spelling — the first one the catalog stated for the key
// — rides along in `.zone`, so no surface ever draws the folded key at a reader.
//
// PURE, and the catalog is INJECTED. This module imports no data: the renderer hands in its
// `MOB_CATALOG` and the tests hand in a synthetic one, which is what keeps the fold node-testable
// (the shared/planner house rule — relative imports, no `@shared` for values).

import type { MobEntry } from '../mobTypes'

// ---- the two spellings of a tiered zone ------------------------------------------------------

/**
 * A tiered name, split into the base place and its tier number.
 *
 * `plus` is the wiki's spelling of the tier because the wiki is the side that will be READ against
 * a catalog that has none (plan §0.2: zero `MobEntry` names carry `+N`).
 */
export interface PlusName {
  /** the name with the tier suffix removed, trailing whitespace trimmed */
  base: string
  /** the tier, 1 or higher */
  plus: number
}

/**
 * THE WIKI'S SPELLING: `<base> +N` — `Timorous Deep +4`, `Ixiblat Fer +5` (plan §0.2). The `+` is
 * allowed to sit tight against the base because the item pages spell it both ways.
 */
const WIKI_PLUS_RE = /^(.*\S)\s*\+(\d+)$/
/**
 * THE GAME'S SPELLING: `<base> <N> (<TierWord>)`, MEASURED off the real log 2026-08-15 —
 * `You have entered Temple of Cazic-Thule 4 (Refined).`, `The Ruins of Old Guk 3 (Fused)`,
 * `Kerra Isle 4 (Refined)`, `Toxxulia Forest 1 (Awakened)`.
 *
 * THE TIER WORD IS MATCHED GENERICALLY, never against a closed list, and that is a law-1 decision
 * with a live gap behind it: the log states 1 = Awakened, 3 = Fused and 4 = Refined, and TIER 2'S
 * WORD IS UNSTATED ANYWHERE ON THIS MACHINE. A table of three words would silently refuse to parse
 * the first tier-2 zone the player walks into; the shape is the thing that is known, so the shape is
 * what is matched.
 *
 * It DOES require the parenthetical to be letters, which is the one discrimination the corpus forces:
 * the catalog's own page-disambiguation suffixes are numeric (`Northern Karana (35)`), and a rule
 * that read `(35)` as a tier word would invent a tier for a zone that has none.
 */
const GAME_TIER_RE = /^(.*\S)\s+(\d+)\s*\(\s*([A-Za-z][A-Za-z' -]*)\s*\)$/

/**
 * BOTH SPELLINGS OF A TIERED NAME, or `null` for a base name — the one place the tier suffix rule
 * lives (plan §3: "one exported `plusSuffix(name)` helper — the spelling rule in one place").
 *
 * Works on a ZONE or a MOB: the item pages spell the tier on either side (`Timorous Deep +4` is a
 * zone heading, `Ixiblat Fer +5` a dropper), and the suffix is the same suffix.
 *
 * THREE THINGS IT REFUSES, each because refusing is the only honest answer:
 *   * A BARE TRAILING NUMBER IS NOT A TIER. `Kerra Isle 3` alone returns `null`. Only the two
 *     spellings above are attested; a rule that ate any trailing digit run would also eat the
 *     catalog's disambiguators and the numbers that are simply part of a name.
 *   * `+0` IS THE BASE ZONE, not tier zero — `null`. That is the fork user's own vocabulary in the
 *     ask ("when to grind +0 for exp vs +4 areas for gear"), so `plus` starts at 1 and a caller
 *     testing `plusSuffix(name) === null` is asking exactly "is this the plain zone".
 *   * IT DOES NOT STRIP INSTANCE SELECTION. The log also prints `- Solo` / `- Group 2` noise
 *     (`The Ruins of Old Paineel - Solo 4 (Refined)`), and folding that is `zoneKey`'s job on the
 *     renderer side. This function answers about the TIER SUFFIX and hands back whatever else the
 *     caller gave it.
 */
export function plusSuffix(name: string): PlusName | null {
  const m = WIKI_PLUS_RE.exec(name) ?? GAME_TIER_RE.exec(name)
  if (!m) return null
  const plus = Number(m[2])
  if (!Number.isFinite(plus) || plus < 1) return null
  return { base: m[1].trim(), plus }
}

// ---- the level string ------------------------------------------------------------------------

/** Whitespace runs, collapsed to one space by `zoneLevelKey`. */
const SPACE_RUN_RE = /\s+/g
/** The first digit run anywhere in the string — `sortLevel`'s rule, promoted (see the header). */
const FIRST_DIGITS_RE = /\d+/

/**
 * The level a catalog row STATES, or `null` when it states none.
 *
 * `null` covers the 16 rows with no level field, "Unknown", "You can't consider that." and every
 * other digitless shape. It is not 0 and never becomes 0 downstream — a zone whose every mob lands
 * here gets NO profile at all rather than a profile reading zero.
 */
export function statedLevel(level: string | undefined): number | null {
  const m = FIRST_DIGITS_RE.exec(level ?? '')
  return m ? Number(m[0]) : null
}

// ---- the profile ------------------------------------------------------------------------------

/** One zone's level profile, folded from the levels its mobs state. Derived — label it as such. */
export interface ZoneLevels {
  /** the DISPLAY spelling: the first one the catalog stated for this key */
  zone: string
  /** the lowest stated level in the zone */
  low: number
  /** the median stated level, rounded to a whole level (see `zoneLevelProfile`) */
  median: number
  /** how many mobs stated a readable level — the number every surface prints beside the profile */
  sampled: number
}

/**
 * The fold key: trim, case-fold, collapse whitespace runs. Narrow on purpose — see the header.
 * A blank or whitespace-only zone folds to `''` and is never keyed.
 */
export function zoneLevelKey(zone: string): string {
  return zone.trim().toLowerCase().replace(SPACE_RUN_RE, ' ')
}

/**
 * The MEDIAN of a sorted list, rounded to a WHOLE LEVEL on the even case.
 *
 * Rounded rather than carried at .5 because the only consumer is a con lookup, and the con model
 * this feeds is stated in whole levels on both sides — asking it about level 22.5 would be asking a
 * question the game never answers. Ties round up (`Math.round`), which is arbitrary and is the only
 * arbitrary choice in this file; it moves one level on an even-sized sample and nothing else.
 */
function medianOf(sorted: readonly number[]): number {
  const mid = sorted.length >> 1
  if (sorted.length % 2 === 1) return sorted[mid]
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/**
 * EVERY ZONE THE CATALOG PLACES A LEVELLED MOB IN, profiled.
 *
 * A mob folds into EVERY zone it states — `MobEntry.zones` is PLURAL and a wanderer really is in
 * both places, so counting it once per zone is the fold, not double-counting. A mob with no readable
 * level is skipped entirely: it contributes to no `sampled` count anywhere, because "we could not
 * read this row's level" is not evidence about the zone.
 *
 * A ZONE WITH ZERO READABLE LEVELS GETS NO ENTRY. Absent, not a zero profile — law 1, and the
 * practical version of it is that `Various` (a real catalog value, not a placeholder) and the
 * merchant-only zones must not surface in a route as "level 0 content".
 */
export function zoneLevelProfile(catalog: readonly MobEntry[]): Map<string, ZoneLevels> {
  const levels = new Map<string, number[]>()
  const display = new Map<string, string>()
  for (const mob of catalog) {
    const level = statedLevel(mob.level)
    if (level === null) continue
    for (const zone of mob.zones ?? []) {
      const key = zoneLevelKey(zone)
      if (key === '') continue
      if (!display.has(key)) display.set(key, zone.trim())
      const bucket = levels.get(key)
      if (bucket) bucket.push(level)
      else levels.set(key, [level])
    }
  }
  const out = new Map<string, ZoneLevels>()
  for (const [key, bucket] of levels) {
    bucket.sort((a, b) => a - b)
    out.set(key, {
      zone: display.get(key) ?? key,
      low: bucket[0],
      median: medianOf(bucket),
      sampled: bucket.length
    })
  }
  return out
}
