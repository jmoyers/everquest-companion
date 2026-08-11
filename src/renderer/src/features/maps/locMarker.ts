// WHERE YOU SAID YOU ARE — the typed `/loc` marker: parsing it, remembering it, and forgetting it
// on request. Pure: no React, no DOM beyond a `getItem/setItem` pair it is HANDED, so every rule
// here is node-testable (tests/mapLocMarker.test.mts), exactly like zoneFollow.ts beside it.
//
// THE ASK (JOS-98, a v0.10.0 report): "Would also be nice if there was a marker on the map for my
// current positon. I realize I would need to feed the map a /loc but would gladly do so."
//
// WHY THE USER HAS TO TYPE IT AT ALL. The log states the zone you entered and nothing else
// positional — `Your Location` appears ZERO times in it, re-measured for this ticket across the
// owner's whole 116.8 MB `eqlog_Primitive_freeport.txt` and every other log in that directory,
// because /loc answers in the game window and is never written to the file the app tails. So there
// is no live tracking to build and none is pretended: the app knows one position, the one you
// handed it, and it says so rather than implying a dot that follows you. That absence is also why
// the reporter offered to feed it in by hand — they had already worked out that nothing else could.
//
// THE SHAPE IS EVIDENCED, NOT INVENTED. Since the log never carries the line, the exact wording was
// taken from players pasting their own /loc output into wiki walkthroughs (24 pages in
// `scripts/sources/cache/quests/`), e.g. page-15280: `Your Location is -192.19, -129.81, 3.26`. So:
// the literal words `Your Location is`, then three signed decimals at two places, comma-and-space
// separated, no parentheses, no trailing period of the game's own. Everything this parser accepts
// BEYOND that shape is defensive slack, never a second believed format.
//
// THE TRANSFORM IS NOT REDERIVED HERE. `mapGeometry.mapFromLoc` has owned `/loc` → map-file
// coordinates since wave 1 (`mapX = -ew, mapY = -ns, mapZ = elevation`), it is the transform
// `mobPins.ts` measured against 7,423 wiki-stated coordinates across 119 mapped zones (99.4%
// inside their own zone's extent, median 14.8 map units from the nearest wall), and JOS-65 settled
// which way the RESULT points. This module's whole job on that axis is to produce a well-formed
// `EqLoc` and hand it over. A second copy of those two negations is a second thing to get wrong.
//
// PARSE FORGIVINGLY, REJECT HONESTLY. A paste is a paste: it may carry the log's timestamp, the
// game's own sentence, commas or plain spaces, a `+`, any amount of surrounding whitespace. All of
// that is stripped. What is NOT done is guessing — a line with a word in the middle of the numbers,
// or two numbers where three were meant, produces a stated refusal and NO marker. A marker in
// roughly the right place is the one outcome worse than no marker at all (world-model law 1).
//
// /loc PRINTS Y, X, Z — north/south FIRST. That is the trap this module exists to hold still: the
// first number the game prints is the north/south reading, not an x. `EqLoc` names its fields
// `ns`/`ew` for that reason and nothing here ever calls them x and y.

import type { EqLoc } from './mapGeometry'

/** One remembered marker per zone stem, keyed by `ZoneShort`. One marker per zone is the scope. */
export type LocMarkers = Record<string, EqLoc>

/**
 * Every zone's marker, in ONE key beside `eq.maps.zone` / `eq.maps.packs` / `eq.maps.pane`.
 *
 * One key rather than `eq.maps.loc.<zone>` per zone so that reading them is one parse and clearing
 * them is one write — and so a user who has marked forty zones has not written forty keys into a
 * store the rest of the app scans.
 */
export const LOC_MARKERS_KEY = 'eq.maps.loc'

/** The two `localStorage` methods this module uses — passed in so the rules are testable. */
export interface LocStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** A parse that produced a position, or a parse that produced a sentence. Never both, never neither. */
export type LocParse = { ok: true; loc: EqLoc } | { ok: false; reason: string }

/** What to paste, said once, and reused by every refusal so the guidance never drifts between them. */
// A dash pair would sit right beside the example's own negative number, so this one reads with
// parentheses instead (JOS-106: normal dashes, or no dash where a dash reads worse).
const EXAMPLE = 'Paste the line the game printed (“Your Location is 1414.20, -735.55, 12.19”) or just the numbers.'

/** The log's own stamp, in case the paste came from the log file rather than the game window. */
const TIMESTAMP = /^\[[^\]]*\]\s*/

/**
 * The game's sentence, and the command that produces it.
 *
 * Anchored and explicit rather than "strip everything before the first digit": a rule that skips
 * arbitrary prose would happily eat the front of a sentence it did not understand and place a
 * marker from whatever numbers survived. These are the forms /loc actually takes.
 */
const PREFIX = /^(?:\/loc\b|your\s+location\s+is|your\s+location)\s*[:=]?\s*/i

/** A whole token that is a number: optional sign, digits with an optional fractional part. */
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/

/**
 * Text → a `/loc` reading, or prose saying why not.
 *
 * ACCEPTED, all of which are one paste away from a real user: the game's sentence with or without
 * the log's timestamp, comma-separated numbers, whitespace-separated numbers, both together, and a
 * trailing period (the sentence ends in one). TWO numbers are accepted as a position at ground
 * elevation — elevation places nothing on a 2-D map and a user reading a /loc off a wiki page
 * routinely has only the pair — but THREE is what the game prints and what round-trips.
 *
 * REFUSED, in prose, with no marker placed: an empty box, a token that is not a number, and any
 * count other than two or three. The refusal names what it choked on, because "invalid input" sends
 * the user back to the same paste with nothing to change.
 */
export function parseLoc(text: string): LocParse {
  const body = text.trim().replace(TIMESTAMP, '').replace(PREFIX, '').replace(/\.$/, '').trim()
  if (body === '') return { ok: false, reason: `Nothing to place. ${EXAMPLE}` }
  const tokens = body.split(/[\s,]+/).filter((t) => t !== '')
  const bad = tokens.find((t) => !NUMBER.test(t))
  if (bad !== undefined) return { ok: false, reason: `“${bad}” isn’t a number. ${EXAMPLE}` }
  const nums = tokens.map(Number)
  if (!nums.every((n) => Number.isFinite(n))) return { ok: false, reason: `That reads as no position at all. ${EXAMPLE}` }
  if (nums.length !== 2 && nums.length !== 3) {
    return { ok: false, reason: `${String(nums.length)} numbers - a /loc is three (north/south, west/east, elevation). ${EXAMPLE}` }
  }
  // ORDER IS THE WHOLE POINT: /loc prints north/south first, then west/east, then elevation.
  return { ok: true, loc: { ns: nums[0], ew: nums[1], z: nums[2] ?? 0 } }
}

/** Trim a coordinate to the two decimals /loc itself prints, without a trailing `.00`. */
function short(n: number): string {
  return String(Math.round(n * 100) / 100)
}

/** The marker's position back in the game's own words — what the chip states and the tooltip repeats. */
export function formatLoc(loc: EqLoc): string {
  return `${short(loc.ns)}, ${short(loc.ew)}, ${short(loc.z)}`
}

function readLoc(value: unknown): EqLoc | null {
  if (typeof value !== 'object' || value === null) return null
  const { ns, ew, z } = value as Record<string, unknown>
  if (!Number.isFinite(ns) || !Number.isFinite(ew) || !Number.isFinite(z)) return null
  return { ns: ns as number, ew: ew as number, z: z as number }
}

/**
 * Read the remembered markers.
 *
 * Everything unrecognised folds to `{}` and every unreadable ENTRY is dropped individually, so one
 * corrupt zone cannot take the other thirty-nine with it. A dropped entry is a marker the user has
 * to re-enter; a thrown error is a Maps tab that does not render.
 */
export function loadLocMarkers(store: LocStore = localStorage): LocMarkers {
  const raw = store.getItem(LOC_MARKERS_KEY)
  if (raw == null || raw === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: LocMarkers = {}
    for (const [zone, value] of Object.entries(parsed as Record<string, unknown>)) {
      const loc = readLoc(value)
      if (loc != null && zone !== '') out[zone] = loc
    }
    return out
  } catch {
    return {}
  }
}

/** Remember them, and hand the map straight back so a caller can persist inline. */
export function saveLocMarkers(marks: LocMarkers, store: LocStore = localStorage): LocMarkers {
  store.setItem(LOC_MARKERS_KEY, JSON.stringify(marks))
  return marks
}

/**
 * Place (or replace) this zone's marker.
 *
 * Entering a new loc REPLACES the old one rather than adding to it — one marker per zone is the
 * scope, so there is never a list to manage, prune or explain.
 */
export function setLocMarker(marks: LocMarkers, zone: string, loc: EqLoc): LocMarkers {
  return { ...marks, [zone]: loc }
}

/** Forget this zone's marker, leaving every other zone's alone. */
export function clearLocMarker(marks: LocMarkers, zone: string): LocMarkers {
  if (!(zone in marks)) return marks
  const next = { ...marks }
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the key IS the zone stem
  delete next[zone]
  return next
}

/** This zone's marker, or null. `zone == null` (no map open) is the honest "nothing to draw". */
export function locMarkerFor(marks: LocMarkers, zone: string | null): EqLoc | null {
  if (zone == null) return null
  return marks[zone] ?? null
}
