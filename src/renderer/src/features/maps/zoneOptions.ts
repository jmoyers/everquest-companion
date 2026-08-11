// The two spellings a map stem answers to, and the filter the zone selector runs over them.
//
// SEPARATE FROM THE CONTROL because it is the only part of zone selection that can be tested
// without a DOM: a stem's display name and whether a query reaches it are string facts. The
// component beside it (MapZoneSelect.tsx) is then a rendering of these three functions and
// nothing else.
//
// A STEM THE TABLE DOES NOT CARRY IS SHOWN RAW. `src/shared/zones.ts` is hand-authored — there is
// no algorithm from `airplane` to `The Plane of Sky` — so a pack that provides a stem the table
// has never heard of is offered under its own name rather than a guessed prettification
// (world-model law 1). It is still selectable, and its map still draws.
//
// THE FILTER IS THE APP'S ONE SCORER, not a private substring test (JOS-135). `shared/fuzzy` is
// what the fight search, the Mobs tab and the map corpus all rank with, so a typo behaves the same
// in every box in the app: `nagafn` reaches Nagafen's Lair here exactly as `gohul knigt` reaches
// the ghoul knights there. It also RANKS — exact > prefix > substring > typo — which matters for a
// control with `autoHighlight`: the row Enter selects is now the best match rather than whichever
// stem happens to sort first alphabetically. The tokens are built ONCE PER STEM and cached, rather
// than lowercasing every option's long name on every keystroke.
//
// RELATIVE value imports, the repo-wide rule for node-tested pure modules (mobPins.ts:38).

import type { ZoneShort } from '@shared/maps'
import { scoreQuery, tokenize } from '../../../../shared/fuzzy'
import { ZONES } from '../../../../shared/zones'

/**
 * Cap on offered rows.
 *
 * The installed corpus is ~600 stems (measured: 580 in the shipped Brewall pack, 133 in the
 * game's own set) and MUI renders every option in an open popup, so an unfiltered list is a
 * rendering cost with no reader on the far end. Typing is how you reach row 201.
 */
export const ZONE_OPTIONS_MAX = 200

/** Stem -> the long name the zone table knows it by. Built once; the table is ~130 rows. */
const NAMES = new Map<ZoneShort, string>(ZONES.map((z) => [z.short, z.name]))

/**
 * What to call a map stem in the UI.
 *
 * The stem is the truth on disk (`airplane`) and the long name is what the player calls it
 * (`The Plane of Sky`), so both are shown wherever there is room.
 */
export function zoneLabel(short: ZoneShort): string {
  return NAMES.get(short) ?? short
}

/**
 * BOTH SPELLINGS IN ONE HAYSTACK — the stem on disk and the long name the table gives it.
 *
 * Built once per stem and kept for the window's lifetime (the mobSearch.ts posture: the corpus is
 * immutable, so the tokens are too). A Map rather than an array because the caller hands us stems,
 * not indices, and the corpus arrives from the pack scan in whatever order the packs did.
 */
const HAYSTACKS = new Map<ZoneShort, string[]>()

function haystack(short: ZoneShort): string[] {
  const cached = HAYSTACKS.get(short)
  if (cached) return cached
  const built = tokenize(`${short} ${zoneLabel(short)}`)
  HAYSTACKS.set(short, built)
  return built
}

/**
 * How well a stem answers an already-tokenized query — `null` when it does not answer at all.
 *
 * Every query token must land somewhere (fuzzy.ts's coverage rule), so `plane sky` reaches The
 * Plane of Sky and no other plane.
 */
export function zoneScore(short: ZoneShort, query: readonly string[]): number | null {
  return scoreQuery([...query], haystack(short))
}

/** Either spelling matches. `q` is the raw typed text; tokenizing and folding is this call's job. */
export function zoneMatches(short: ZoneShort, q: string): boolean {
  const query = tokenize(q)
  return query.length === 0 || zoneScore(short, query) != null
}

/**
 * The offered rows for a query: every stem when it is empty, RANKED matches otherwise, capped.
 *
 * An empty query keeps the corpus in the order it arrived (ascending stems, the pack scan's own
 * order) — there is nothing to rank by, and re-sorting a 600-row list into some other order would
 * only move the rows a user was about to scroll to. Ties break on the stem, so the list is fully
 * deterministic and never reshuffles under the cursor.
 */
export function filterZones(
  zones: readonly ZoneShort[],
  query: string,
  limit = ZONE_OPTIONS_MAX
): ZoneShort[] {
  const q = tokenize(query)
  if (q.length === 0) return zones.slice(0, limit)
  const scored: { zone: ZoneShort; score: number }[] = []
  for (const zone of zones) {
    const score = zoneScore(zone, q)
    if (score != null) scored.push({ zone, score })
  }
  scored.sort((a, b) => (a.score === b.score ? (a.zone < b.zone ? -1 : 1) : b.score - a.score))
  return scored.slice(0, limit).map((s) => s.zone)
}

/**
 * The options list, guaranteed to contain the current selection.
 *
 * A remembered stem (`eq.maps.zone`) can outlive the pack that provided it, and a value MUI
 * cannot find among its options renders as an empty box — which reads as "no zone is open" while
 * a map is plainly on screen. The stem stays offered instead, under its own name.
 */
export function zoneOptions(zones: readonly ZoneShort[], zone: ZoneShort | null): ZoneShort[] {
  if (zone == null || zones.includes(zone)) return [...zones]
  return [zone, ...zones]
}
