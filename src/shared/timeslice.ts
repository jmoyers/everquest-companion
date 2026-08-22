// timeslice.ts — THE ONE ANSWER TO "WHICH STRETCH OF PLAY ARE THESE NUMBERS ABOUT" (JOS-130).
//
// A 0.14.0 user asked the loot ledger for "what did I gain in totality vs this session", and two
// earlier reports asked the same question from the other side ("motes per hour", "compare zones
// over equal time"). All three are one control: a SLICE of the record that every loot and xp
// analysis surface reads, worded the same way everywhere.
//
// Pure. No React, no DOM, no Electron, no clock read — the live edge comes from the snapshot's
// own `lastTs`, never from `Date.now()`, so the same snapshot always yields the same slice and
// tests/timeslice.test.mts can import this file straight under tsx.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// A SLICE IS A RANGE ∩ A ZONE, and those two dimensions are deliberately orthogonal.
//
// Time is contiguous; a zone is not (you leave and come back). Encoding "this zone" as a range
// would mean either lying about the gaps or carrying a span LIST through every consumer. So a
// slice carries ONE half-open range `[t0, t1)` and ONE optional zone key, and each consumer
// applies both — `rangeStats` by restricting its zone segments, the loot surfaces by testing the
// zone their rows already recorded. That is why `Zone` and `Zone + Session` are two presets over
// one mechanism rather than two mechanisms.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE PRESETS, DEFINED EXACTLY (owner direction 2026-08-09). These sentences are the contract;
// every surface states them with the same words, and no surface may re-derive one.
//
//   • ALL TIME (`all`) — the whole record: `[bounds.lo, bounds.hi + TAIL_MS)`, no zone filter.
//     IT IS THE DEFAULT ON EVERY SURFACE. A user who never touches the control sees exactly the
//     numbers this app showed before the control existed.
//
//   • SESSION (`session`) — THIS APP-SESSION OF GAMEPLAY, decided by LOG CONTINUITY: from the
//     most recent login the log states, to the live edge. That instant is the END of the newest
//     derived `offlineGap` interval (`offlineEnd`), which the bus emits only after the
//     "Welcome to EverQuest Legends!" line that ended the absence. It is NOT a wall-clock window
//     and NOT "since the app started" — the app can be restarted mid-session and the answer must
//     not move, and a replay of yesterday's log must give yesterday's answer.
//     WHEN THE RECORD STATES NO LOGOUT AT ALL the whole record IS one unbroken session, so the
//     preset is NOT OFFERED — it would be `All` under a second name, and a control with two
//     buttons for one answer teaches the user something false.
//
//   • ZONE (`zone`) — THE CURRENT ZONE, every visit ever: the whole record's range, restricted to
//     the zone the log last named. "Current" is the last row of the snapshot's zone timeline, not
//     a guess; before the first zone line there is no current zone and the preset is not offered.
//
//   • ZONE + SESSION (`zoneSession`) — both at once: this session's range, restricted to the
//     current zone. Offered only when both of its halves are.
//
//   • CUSTOM (`custom`) — the two instants the user picked, clamped to the record, no zone filter.
//     Always offerable; a surface that has not been given a custom range yet falls back to `All`.
//     AN END MAY BE OPEN (JOS-436): `+Infinity` clamps to the live edge on every read, so a range
//     that says "from here on" grows with the log instead of having to be retyped. That is what
//     `sessionSegments.ts` hands in, and it is why this slice — not a tenth id — is the one the
//     Details!-style session split rides on. Its `caption` may be SUPPLIED for the same reason:
//     a segment has a name ("session 2") and `the custom range` would throw it away.
//
//   • THE DURATION RUNGS (`d7` / `h24` / `h6` / `h1`) — "the last N of the log", anchored on the
//     newest event rather than on the clock. They predate this module (JOS-71's timescale) and are
//     folded into the same id space so ONE control offers every slice this app can describe.
//     Offered only when the record spans strictly longer than the rung (chartWindow.ts
//     `availableTimescales` is the authority; this module quotes its lengths).
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE ZONE FOLD IS `shared/zones.zoneKey`, THE ONE THAT STRIPS INSTANCE NOISE — and this app now
// carries TWO zone folds on purpose, doing two different jobs.
//
//   • MEMBERSHIP (this one): "is this the place I am standing in?" EQ Legends spells instance
//     difficulty and selection into the zone name — `Najena 4 (Refined)`,
//     `The Ruins of Old Paineel - Solo 4 (Refined)` — and 81 of the 344 real post-epoch zone
//     intervals are bounces of the SAME camp. A player asking for "this zone" means the PLACE, so
//     a re-entry that changed the ordinal has to stay in the slice. The leveling tab's band strip
//     has merged exactly those bounces since JOS-71; this is the same rule applied to the numbers.
//     MEASURED while writing the e2e: the deep-link fixture's current zone is literally
//     `Nagafen's Lair - Solo 4 (Refined)`, so a trim-only fold is not a hypothetical here.
//
//   • JOINING (`zoneIdKey`, trim + lowercase): "which row does this drop belong to?"
//     `rangeStats` groups its zone rows with it and `lootRates.ts` rule 2 joins drops onto them;
//     a second answer THERE would bucket drops under one key and their active time under another,
//     which is world-model law 12's drift in miniature. Untouched.
//
// The two coexist without drifting because they are applied at different moments: membership
// admits a zone INTERVAL, the join then groups whatever was admitted by its own spelling. So a
// zone-filtered range can hand back two rows when the log spelled the camp two ways, and each row
// is still exactly the row its drops join onto.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// AND SINCE JOS-291 WHICH OF THE TWO MEMBERSHIP RUNS ON IS THE READER'S CALL (owner directive
// 2026-08-13: *there should be an option to differentiate between levels of the zone, d0 -> d4, vs
// not*). `ZoneScope` is that choice and `shared/zoneScope.ts` owns its whole argument:
//
//   • `allTiers` — THE DEFAULT, and everything above stands verbatim: the place fold, every tier.
//   • `exactTier` — the place fold AND the row fold of the zone the log last named, so only the
//     tier you are standing in is admitted. `Befallen` and `Befallen 2 (Adaptive)` stop being one
//     slice, because they do not pay alike.
//
// THE CHOICE IS A DIMENSION OF THE SLICE, NOT A SECOND SLICE. It travels on the resolved
// `Timeslice` beside the range and the zone key, it is applied by the SAME one predicate
// (`zoneAdmits`) everywhere, and it is NAMED IN THE CAPTION — because the span line is the
// denominator (JOS-288's honesty rule), and a caption printing `Befallen 2 (Adaptive)` over numbers
// that admitted plain `Befallen` is the exact defect this option was filed for.

import type { ProgressionSnap } from './progressionTypes'
import { zoneKey } from './zones'
import {
  ZONE_SCOPE_PHRASE,
  resolveZoneScope,
  zoneAdmits,
  zoneIdKey,
  type ZoneScope
} from './zoneScope'
// The one spelling of "the stretch the log could not place" — `zoneSegments` names that row, and
// `lootRates` joins onto it. Imported rather than re-spelled, for the same reason as the fold.
import { UNKNOWN_ZONE } from './lootRates'

/**
 * Ranges are half-open `[t0, t1)` and the newest event in the log is stamped at `bounds.hi`
 * EXACTLY, so a slice ends one millisecond past the record or the last thing that happened falls
 * out of totals the user can plainly see. Same constant, same measured reason, as
 * `windowScope.ts TAIL_MS`; EQ stamps whole seconds, so nothing but the events already at `hi`
 * can live in that millisecond.
 */
export const TAIL_MS = 1

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Every slice this app can describe. The four duration rungs carry JOS-71's own ids. */
export type SliceId = 'all' | 'session' | 'zone' | 'zoneSession' | 'd7' | 'h24' | 'h6' | 'h1' | 'custom'

/** Fixed lengths for the duration rungs, in ms. 0 is not a member: `all` is not a length. */
const DURATION_MS: Partial<Record<SliceId, number>> = {
  d7: 7 * DAY,
  h24: DAY,
  h6: 6 * HOUR,
  h1: HOUR
}

/** The rung's own length, or null when the slice is not a fixed-length one. */
export function sliceDurationMs(id: SliceId): number | null {
  return DURATION_MS[id] ?? null
}

/** A half-open pair of instants. Structurally what `rangeStats` and `ChartScale` both carry. */
export interface SliceRange {
  t0: number
  t1: number
}

/** Where the record starts and ends. Supplied by the caller (`zoneBands.dataBounds`) rather than
 *  recomputed here: the leveling tab's bounds include series this module cannot see. */
export interface RecordBounds {
  lo: number
  hi: number
}

/**
 * A resolved slice: what to measure, where, and what to call it. Consumers take the WHOLE object
 * — handing three unpacked fields around is how a range from one slice ends up beside a zone
 * filter from another.
 */
export interface Timeslice {
  id: SliceId
  /** The segmented control's own word for it. Short by owner direction, when short still says it. */
  label: string
  /** How it is worded INSIDE a sentence ("no drops in ___"). One spelling per slice. */
  caption: string
  range: SliceRange
  /** The MEMBERSHIP fold (`shared/zones.zoneKey`) of the zone this slice is restricted to, or
   *  null for every zone. See the header for why it is not the row-grouping fold. */
  zoneKey: string | null
  /** RAW display name of that zone (law 2: canonicalize at boundaries, display raw). */
  zoneName: string | null
  /**
   * WHICH TIERS OF THAT ZONE THIS SLICE ADMITS (JOS-291). `allTiers` on every slice that carries no
   * zone at all, so a consumer never has to ask two questions to find out it has nothing to filter.
   */
  zoneScope: ZoneScope
  /**
   * The ROW fold (`zoneScope.zoneIdKey`) of that zone's raw name — the EXACT-TIER membership key —
   * or null. NULL UNDER `allTiers`, so every consumer can hand this straight to `rangeStats` /
   * `windowItemRows` / `zoneAdmits` without re-reading the scope: absent is the default and the
   * default is byte-identical to the read this app has always done.
   */
  zoneExactKey: string | null
  /**
   * The ZONE HALF, worded — `Befallen 2 (Adaptive), every tier`. Null when the slice is not
   * restricted to a zone.
   *
   * It exists because two surfaces print the zone half WITHOUT the range half (`SliceBar`'s window
   * caption states the two instants itself), and the membership has to read back in both. One
   * spelling, composed once, exactly like `caption`.
   */
  zoneCaption: string | null
}

/** The button label for each id. `Zone + Session` is the one long label: neither half survives
 *  being dropped, and a two-letter code for it would be a legend nobody has. */
const LABELS: Record<SliceId, string> = {
  all: 'All',
  session: 'Session',
  zone: 'Zone',
  zoneSession: 'Zone + Session',
  d7: '7d',
  h24: '24h',
  h6: '6h',
  h1: '1h',
  custom: 'Custom'
}

export function sliceLabel(id: SliceId): string {
  return LABELS[id]
}

/**
 * Every id as VALUES — the runtime half of `SliceId`, derived from `LABELS` so the two cannot
 * drift, and in that object's own order (which is the control's render order).
 *
 * It exists because a slice pick is now PERSISTED somewhere (JOS-195: the XP overlay remembers
 * its own), and anything read back off disk has to be checked against the closed union rather
 * than trusted to still be one of its members.
 */
export const SLICE_IDS = Object.keys(LABELS) as SliceId[]

/** Is `v` one of the ids this build knows? The store's gate — see `SLICE_IDS`. */
export function isSliceId(v: unknown): v is SliceId {
  return typeof v === 'string' && (SLICE_IDS as string[]).includes(v)
}

/**
 * THE MOST RECENT LOGIN THE LOG STATES, or null when it states none.
 *
 * `offlineEnd` is the instant the absence ended — the "Welcome to EverQuest Legends!" line — and
 * the column is ascending and disjoint by construction, so the newest row's end is the newest
 * login. Null is a REAL answer and not a fallback: a record with no logout in it is one session,
 * and the caller must offer `All` rather than invent a boundary (law 1).
 *
 * The capped column (`OFFLINE_CAP`) can in principle drop its oldest rows; it never drops its
 * newest, which is the only one this reads.
 */
export function sessionStartOf(snap: ProgressionSnap): number | null {
  const n = snap.offlineEnd.length
  return n > 0 ? snap.offlineEnd[n - 1] : null
}

/** The zone the log last named, or null before the first zone line. */
export function currentZoneOf(snap: ProgressionSnap): { key: string; name: string } | null {
  const n = snap.zoneName.length
  if (n === 0) return null
  const name = snap.zoneName[n - 1]
  const key = zoneKey(name)
  return key === '' ? null : { key, name }
}

/**
 * Which presets THIS record can actually offer, in the order the control renders them.
 *
 * A preset is withheld when it could only restate another one (`session` with no logout in the
 * log) or when the log has not said enough to define it (`zone` before the first zone line, a
 * duration rung longer than the record). `all` and `custom` are always in the list, so the
 * control can never come up empty and the default is available to every character.
 */
export function availableSlices(snap: ProgressionSnap, bounds: RecordBounds | null): SliceId[] {
  const out: SliceId[] = ['all']
  const session = sessionStartOf(snap)
  const zone = currentZoneOf(snap)
  const spanMs = bounds ? bounds.hi - bounds.lo : 0
  // A session boundary at or before the first instant of the record describes the whole record.
  const hasSession = session !== null && bounds !== null && session > bounds.lo && session <= bounds.hi
  if (hasSession) out.push('session')
  if (zone) out.push('zone')
  if (hasSession && zone) out.push('zoneSession')
  for (const id of ['d7', 'h24', 'h6', 'h1'] as const) {
    const ms = DURATION_MS[id]
    if (ms !== undefined && ms < spanMs) out.push(id)
  }
  out.push('custom')
  return out
}

/** The picked id if this record can offer it, else `all`. A character switch can shrink the
 *  record under the current pick, and the answer must degrade to the honest slice rather than to
 *  one the log cannot define. */
export function resolveSliceId(id: SliceId, snap: ProgressionSnap, bounds: RecordBounds | null): SliceId {
  return availableSlices(snap, bounds).includes(id) ? id : 'all'
}

export interface ResolveSliceArgs {
  snap: ProgressionSnap
  /** Null ⇒ nothing has a timestamp at all; every slice degenerates to an empty range. */
  bounds: RecordBounds | null
  id: SliceId
  /** The user's custom pair, when they have drawn one. Absent under `custom` ⇒ falls back to the
   *  whole record, which is the honest reading of "a custom range nobody has chosen yet". */
  custom?: SliceRange | null
  /**
   * WHAT TO CALL THAT CUSTOM RANGE, when the thing that supplied it has a name for it (JOS-436).
   *
   * Only `custom` reads it, and only when it is a non-empty string — every preset words itself, and
   * a preset that could be renamed from a call site is a preset with two definitions. Absent ⇒ `the
   * custom range`, the wording a hand-typed pair has always had.
   */
  customCaption?: string | null
  /**
   * WHICH TIERS OF THE CURRENT ZONE COUNT (JOS-291). Absent ⇒ `ZONE_SCOPE_DEFAULT` (`allTiers`),
   * which resolves to exactly the slice this function returned before the option existed.
   *
   * It is ignored, deliberately silently, by every id that carries no zone: `Session` says nothing
   * about where, so a membership for it would be a setting with no subject.
   */
  zoneScope?: ZoneScope | null
}

/** The whole-record range: the identity every other slice narrows. */
function wholeRange(bounds: RecordBounds | null): SliceRange {
  return bounds ? { t0: bounds.lo, t1: bounds.hi + TAIL_MS } : { t0: 0, t1: 0 }
}

/**
 * `range` clamped inside the record, never inverted.
 *
 * IT IS ALSO WHAT RESOLVES AN OPEN END (JOS-436), with no branch of its own: `±Infinity` is
 * already the identity of these two `Math.min`/`Math.max` pairs, so a range spelled
 * `[-Infinity, +Infinity)` IS the whole record and `[m, +Infinity)` is "from m to the live edge",
 * re-read on every render as the log grows. A mark taken from the wall clock can sit PAST the
 * newest log line, and the result is then an empty range at the end of the record — which is the
 * honest answer ("nothing has happened in the new session yet") and heals itself the moment the
 * log catches up.
 */
function clamp(range: SliceRange, bounds: RecordBounds | null): SliceRange {
  const whole = wholeRange(bounds)
  const t0 = Math.max(whole.t0, Math.min(range.t0, whole.t1))
  return { t0, t1: Math.max(t0, Math.min(range.t1, whole.t1)) }
}

/**
 * THE ZONE HALF, WORDED — the RAW zone name (law 2) plus the clause that says which of its tiers
 * the numbers admitted (JOS-291).
 *
 * The clause is ALWAYS printed, including under the default, and that is the honesty rule rather
 * than a verbosity: `every tier` is the fact that a caption reading `Befallen 2 (Adaptive)` had
 * been hiding since JOS-130 — the slice admitted plain `Befallen` too and said nothing. Under
 * `exactTier` the name IS the whole membership, and the clause is what tells the reader that.
 *
 * Null zone ⇒ null caption: `resolveSlice` then falls back to the id's own wording, which is the
 * pre-first-zone-line state the control normally prevents by not offering the button.
 */
function zoneCaptionOf(zoneName: string | null, scope: ZoneScope): string | null {
  return zoneName === null ? null : `${zoneName}, ${ZONE_SCOPE_PHRASE[scope]}`
}

/**
 * The supplier's own name for a custom range when it has one (JOS-436) — `session 2` — and the
 * wording a hand-typed pair has always had when it does not.
 *
 * Its own function so `captionOf` stays inside the measured complexity ceiling, and so that the
 * three ways of saying "nobody named this" (absent, null, empty) are answered in ONE place.
 */
function customCaptionOf(supplied?: string | null): string {
  return supplied === null || supplied === undefined || supplied === '' ? 'the custom range' : supplied
}

/** How a slice is worded inside a sentence. `zone` is the pair `zoneCaptionOf` composes from, so
 *  the session phrase can slot BETWEEN the name and the membership clause. */
function captionOf(
  id: SliceId,
  zone: { name: string; scope: ZoneScope } | null,
  customCaption?: string | null
): string {
  switch (id) {
    case 'session':
      return 'this session'
    case 'zone':
      return zoneCaptionOf(zone?.name ?? null, zone?.scope ?? 'allTiers') ?? 'this zone'
    case 'zoneSession':
      // The membership clause lands LAST, after the session phrase, so the sentence reads as one
      // subject with two qualifiers rather than as "only this session" — which would be a claim
      // about the RANGE, and is not what this clause is about.
      return zone === null
        ? 'this zone this session'
        : `${zone.name} this session, ${ZONE_SCOPE_PHRASE[zone.scope]}`
    case 'custom':
      return customCaptionOf(customCaption)
    case 'all':
      return 'the whole log'
    default:
      return `last ${LABELS[id]} of the log`
  }
}

/**
 * The RANGE half of a slice — its own function so `resolveSlice` stays a composition and inside
 * the measured complexity ceiling. Every branch falls back to the whole record rather than
 * throwing: see `resolveSlice`.
 */
function rangeFor(args: ResolveSliceArgs): SliceRange {
  const { snap, bounds, id, custom } = args
  const whole = wholeRange(bounds)
  if (id === 'session' || id === 'zoneSession') {
    const session = sessionStartOf(snap)
    return session === null ? whole : clamp({ t0: session, t1: whole.t1 }, bounds)
  }
  if (id === 'custom') return custom ? clamp(custom, bounds) : whole
  const ms = DURATION_MS[id]
  // A rung reaches back its OWN length from the newest event, then carries the same tail every
  // slice does — so it spans its hour of record and still holds the last line in the log.
  return ms === undefined ? whole : clamp({ t0: whole.t1 - TAIL_MS - ms, t1: whole.t1 }, bounds)
}

/**
 * THE resolution: one id plus one snapshot becomes one range and one zone filter.
 *
 * `id` is taken as given — call `resolveSliceId` first if the pick may be stale. An id the record
 * cannot define still resolves rather than throwing: `session` with no logout is the whole record
 * (which is what "this session" means for a log that never ended one), and `zone` before the
 * first zone line carries a null `zoneKey` (every zone, i.e. no restriction). Both are states the
 * control normally prevents by not offering the button; refusing here would be a crash where the
 * honest answer is available.
 *
 * THE MEMBERSHIP RIDES ALONG THE SAME WAY (JOS-291): `zoneScope` decides which tiers of that zone
 * the slice admits, `zoneExactKey` is that decision as the key every consumer hands on, and both
 * degrade to the default — a scope on a slice with no zone in it is not an error, it is a setting
 * with no subject, and it resolves to `allTiers` with a null key.
 */
export function resolveSlice(args: ResolveSliceArgs): Timeslice {
  const { snap, id } = args
  const zone = id === 'zone' || id === 'zoneSession' ? currentZoneOf(snap) : null
  const where = zoneHalfOf(zone, args.zoneScope)
  return {
    id,
    label: LABELS[id],
    caption: captionOf(id, zone ? { name: zone.name, scope: where.zoneScope } : null, args.customCaption),
    range: rangeFor(args),
    ...where
  }
}

/** The ZONE HALF of a resolved slice — its four fields, derived together so no caller can assemble
 *  three of them from one membership and the fourth from another. */
function zoneHalfOf(
  zone: { key: string; name: string } | null,
  picked: ZoneScope | null | undefined
): Pick<Timeslice, 'zoneKey' | 'zoneName' | 'zoneScope' | 'zoneExactKey' | 'zoneCaption'> {
  if (!zone) return { zoneKey: null, zoneName: null, zoneScope: 'allTiers', zoneExactKey: null, zoneCaption: null }
  const zoneScope = resolveZoneScope(picked)
  return {
    zoneKey: zone.key,
    zoneName: zone.name,
    zoneScope,
    // NULL UNDER `allTiers`, on purpose: every consumer passes this straight down, so "the default
    // is byte-identical to the read before this existed" is a property of the DATA rather than a
    // rule each caller has to remember.
    zoneExactKey: zoneScope === 'exactTier' ? zoneIdKey(zone.name) : null,
    zoneCaption: zoneCaptionOf(zone.name, zoneScope)
  }
}

/**
 * The ONE membership test: does an event at `ts`, recorded in `zone`, belong to this slice?
 *
 * Half-open at the top, exactly like `rangeStats` — so a row is counted by the loot ledger if and
 * only if the same instant is inside the range the xp numbers were measured over. A row with NO
 * zone is the pre-first-zone-line remainder, and it folds to `unknown` here exactly as it does in
 * `zoneSegments` and in `lootRates.itemZoneRows`: the three agree by construction rather than by
 * coincidence, and a slice for a NAMED zone therefore excludes it rather than guessing where it
 * happened (law 1).
 *
 * The zone half is `zoneScope.zoneAdmits` — the SAME predicate `rangeStats` and `lootRates` run, so
 * the exact-tier choice (JOS-291) cannot reach one of the three and miss the others.
 */
export function inSlice(slice: Timeslice, ts: number, zone?: string): boolean {
  if (ts < slice.range.t0 || ts >= slice.range.t1) return false
  if (slice.zoneKey === null) return true
  return zoneAdmits(zone ?? UNKNOWN_ZONE, slice.zoneKey, slice.zoneExactKey)
}
