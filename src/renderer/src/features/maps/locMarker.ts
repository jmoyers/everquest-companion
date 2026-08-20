// WHERE YOU SAID YOU ARE — the typed `/loc` marker: parsing it, remembering it, and forgetting it
// on request. Pure: no React, no DOM beyond a `getItem/setItem` pair it is HANDED, so every rule
// here is node-testable (tests/mapLocMarker.test.mts), exactly like zoneFollow.ts beside it.
//
// THE ASK (JOS-98, a v0.10.0 report): "Would also be nice if there was a marker on the map for my
// current positon. I realize I would need to feed the map a /loc but would gladly do so."
//
// WHAT THIS MODULE IS FOR NOW THE LOG IS READ TOO. `/loc` output IS written to the log (see
// `parseWorld.classifyLoc`, JOS-98 wave 2), and the maps view moves its marker on it automatically —
// so the common case needs no typing at all. This parser is the OTHER path: a line the user PASTES,
// which may be a /loc for a spot they are not standing on (a wiki walkthrough's coordinate), or the
// game's sentence copied by hand. Wave 1's premise that the log never carries the line was measured
// against a character who simply never ran /loc while logging (`eqlog_Primitive_freeport.txt`); the
// sibling `eqlog_Arcc_freeport.txt` carries it verbatim.
//
// THE SHAPE IS EVIDENCED, NOT INVENTED — and it is the SAME shape the log-side classifier reads. The
// exact wording was taken from players pasting their own /loc into wiki walkthroughs (24 pages in
// `scripts/sources/cache/quests/`), e.g. page-15280: `Your Location is -192.19, -129.81, 3.26`. So:
// the literal words `Your Location is`, then three signed decimals at two places, comma-and-space
// separated, no parentheses, no trailing period of the game's own. Everything this parser accepts
// BEYOND that shape is defensive slack for a hand-paste, never a second believed format.
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

/**
 * Up to FIVE markers a zone can carry, from two kinds of authority (JOS-98, waves 3 & 4):
 *   * `typed`  — `/loc`s the user PASTED into the toolbar box. Up to FOUR, each a spot they may not
 *                be standing on (a wiki coordinate, a rally point, the four corners of a pull). They
 *                are theirs to add and clear, and nothing scraped ever overwrites them.
 *   * `player` — the last `/loc` the LOG scraped, i.e. where the character actually stood (drawn
 *                light red). Exactly one, and it updates itself as you type /loc in game.
 * The two kinds are separate on purpose: before this, one overwrote the other.
 */

/**
 * The four colours a TYPED marker cycles through, in the order a new one claims them: a new marker
 * takes the first colour not currently in use, so clearing a marker frees its colour for reuse. At
 * capacity (all four in use) the OLDEST marker is evicted and its freed colour goes to the new one —
 * a true cycle (blue → green → yellow → violet → blue …). `player` (light red) is deliberately NOT
 * in this list; it is a fifth colour nothing typed can take.
 */
export const TYPED_COLORS = ['blue', 'green', 'yellow', 'violet'] as const
export type MarkerColor = (typeof TYPED_COLORS)[number]

/** The most typed markers a zone holds — one per colour (so the max total per zone is this + 1). */
export const MAX_TYPED = TYPED_COLORS.length

/** The CSS colour each typed colour draws in — a fixed, vivid set that reads on the map paper in
 *  both themes (the crosshair carries its own dark shadow ring). `player` red lives in the view. */
export const MARKER_COLOR_HEX: Record<MarkerColor, string> = {
  blue: '#4c8dff',
  green: '#3ecf6b',
  yellow: '#f5c518',
  violet: '#b06cff'
}

/** One typed marker: where it is, and which colour identifies it (unique within a zone). */
export interface TypedMarker {
  loc: EqLoc
  color: MarkerColor
}

/** A zone's markers — up to four typed and one player, or (as an absent key) none. */
export interface ZoneMarks {
  typed?: TypedMarker[]
  player?: EqLoc
}

/** Every zone's markers, keyed by `ZoneShort`. */
export type LocMarkers = Record<string, ZoneMarks>

/** The first colour not already used by these markers, in cycle order — null when all four are. */
function firstUnusedColor(typed: readonly TypedMarker[]): MarkerColor | null {
  const used = new Set(typed.map((m) => m.color))
  return TYPED_COLORS.find((c) => !used.has(c)) ?? null
}

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
 * Read one zone's stored value into `ZoneMarks`, tolerating BOTH shapes:
 *   * the CURRENT nested form `{ typed?, player? }`, each read through `readLoc`;
 *   * the LEGACY bare `{ ns, ew, z }` a pre-wave-3 install wrote — that value was always the box's
 *     marker, so it loads as `typed` and the user's pasted marks survive the upgrade with no re-save.
 * Returns null when nothing readable is in it, so an empty or corrupt entry drops ALONE (one bad
 * zone never takes the others with it — same rule as before).
 */
function readZoneMarks(value: unknown): ZoneMarks | null {
  // A LEGACY bare `{ns,ew,z}` — the pre-wave-3 box marker. Loads as one blue typed marker.
  const bare = readLoc(value)
  if (bare != null) return { typed: [{ loc: bare, color: TYPED_COLORS[0] }] }
  if (typeof value !== 'object' || value === null) return null
  const { typed, player } = value as Record<string, unknown>
  const t = readTyped(typed)
  const p = readLoc(player)
  const out: ZoneMarks = { ...(t.length === 0 ? {} : { typed: t }), ...(p == null ? {} : { player: p }) }
  return t.length === 0 && p == null ? null : out
}

/**
 * Read the typed markers, tolerating every shape this key has ever held: the CURRENT array of
 * `{loc,color}`, the wave-3 SINGLE `{ns,ew,z}` (one blue marker), and an array of bare readings.
 * A stored colour is honoured when it is one of the four and not already taken; anything else falls
 * to the first unused colour. Capped at `MAX_TYPED`, and one unreadable element drops alone.
 */
function readTyped(value: unknown): TypedMarker[] {
  const out: TypedMarker[] = []
  const push = (loc: EqLoc | null, color: unknown): void => {
    if (loc == null || out.length >= MAX_TYPED) return
    const stated = TYPED_COLORS.find((c) => c === color && !out.some((m) => m.color === c))
    const use = stated ?? firstUnusedColor(out)
    if (use != null) out.push({ loc, color: use })
  }
  if (Array.isArray(value)) {
    for (const el of value) {
      const asBare = readLoc(el)
      if (asBare != null) {
        push(asBare, undefined)
      } else if (typeof el === 'object' && el !== null) {
        const { loc, color } = el as Record<string, unknown>
        push(readLoc(loc), color)
      }
    }
    return out
  }
  // The wave-3 single-typed shape (a bare reading under `typed`): one blue marker.
  push(readLoc(value), undefined)
  return out
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
      if (zone === '') continue
      const marks = readZoneMarks(value)
      if (marks != null) out[zone] = marks
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

/** Write a zone's markers, dropping the zone key entirely when it would hold nothing. */
function putZone(marks: LocMarkers, zone: string, next: ZoneMarks): LocMarkers {
  const out = { ...marks }
  if ((next.typed == null || next.typed.length === 0) && next.player == null) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the key IS the zone stem
    delete out[zone]
  } else {
    out[zone] = next
  }
  return out
}

/**
 * ADD a typed marker to this zone, in the first unused colour.
 *
 * Below capacity, the new marker takes `firstUnusedColor`. AT capacity (four already), the OLDEST
 * marker is evicted so its colour frees, and the new one takes that colour — the cycle the ask
 * describes. The `player` marker is untouched either way.
 */
export function addTypedMarker(marks: LocMarkers, zone: string, loc: EqLoc): LocMarkers {
  const cur = marks[zone]?.typed ?? []
  // At capacity, drop the oldest so exactly one colour is free; below it, keep them all.
  const kept = cur.length < MAX_TYPED ? cur : cur.slice(1)
  const color = firstUnusedColor(kept) ?? TYPED_COLORS[0]
  return putZone(marks, zone, { ...marks[zone], typed: [...kept, { loc, color }] })
}

/**
 * Forget the typed marker of a given COLOUR, leaving the other typed markers, the player marker, and
 * every other zone alone. When nothing is left in the zone, its key is dropped (no empty shell).
 */
export function clearTypedMarker(marks: LocMarkers, zone: string, color: MarkerColor): LocMarkers {
  const cur = marks[zone]?.typed
  if (cur == null) return marks
  const typed = cur.filter((m) => m.color !== color)
  if (typed.length === cur.length) return marks
  const nextZone: ZoneMarks = { ...marks[zone] }
  if (typed.length === 0) delete nextZone.typed
  else nextZone.typed = typed
  return putZone(marks, zone, nextZone)
}

/** Set (replace) this zone's single PLAYER marker, leaving every typed marker alone. */
export function setPlayerMarker(marks: LocMarkers, zone: string, loc: EqLoc): LocMarkers {
  return putZone(marks, zone, { ...marks[zone], player: loc })
}

/** Forget this zone's player marker, leaving the typed markers alone. */
export function clearPlayerMarker(marks: LocMarkers, zone: string): LocMarkers {
  if (marks[zone]?.player == null) return marks
  const nextZone: ZoneMarks = { ...marks[zone] }
  delete nextZone.player
  return putZone(marks, zone, nextZone)
}

/** This zone's typed markers, in the order they were added. `zone == null` ⇒ none. */
export function typedMarkersFor(marks: LocMarkers, zone: string | null): TypedMarker[] {
  if (zone == null) return []
  return marks[zone]?.typed ?? []
}

/** This zone's player marker, or null. `zone == null` (no map open) is the honest "nothing". */
export function playerMarkerFor(marks: LocMarkers, zone: string | null): EqLoc | null {
  if (zone == null) return null
  return marks[zone]?.player ?? null
}
