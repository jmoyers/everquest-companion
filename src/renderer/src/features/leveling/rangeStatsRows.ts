// rangeStatsRows.ts — the PURE shaping behind RangeStatsPanel: a `RangeStats` (the answer
// `shared/progressionStats.rangeStats` computed) turned into the exact strings the panel
// prints. No React, no DOM, no MUI, and only TYPE imports from `@shared`, so
// tests/rangeStatsRows.test.mts can import it straight under tsx (there is no `@shared/*`
// alias in the node test runner — the same constraint zoneBands.ts / levelChartGeometry.ts
// document).
//
// WHY IT IS A SEPARATE FILE. Every honesty rule this feature has is a FORMATTING decision:
// whether a rate prints or an em-dash prints, whether a number is called "levels" or "xp",
// whether a zone row admits the log stated no percentage. Those are the things that rot
// silently inside JSX. Here they are functions with return values, and the test file pins
// them.
//
// THE THREE RULES THIS FILE EXISTS TO ENFORCE (plan §4, §6.4):
//   1. A NULL rate renders as an em-dash — NEVER '0.0'. `levelsPerHourActive` is null when
//      the window has no active time, and also when every experience line in it stated no
//      percentage. Printing 0.0 there would be a fabricated measurement of a quantity the
//      log declined to report.
//   2. `levelEquiv` is LEVELS OF PROGRESS, never "xp". The log prints a percentage of the
//      CURRENT level's bar and nothing else — no raw total, no to-next-level requirement,
//      no bar position — and 1% at level 40 is far more raw experience than 1% at level 10.
//      No surface in this file may say xp, exp points, or experience points.
//   3. A row with unstated samples SAYS SO. `expUnstated > 0` is a real state of the world
//      (the game prints a percentage only while a level bar exists), not a rounding artifact.
//   4. "OFFLINE" IS SAID ONLY WHERE THE LOG SAID IT. Every offline string here is null unless
//      `offlineMs > 0` — i.e. unless a camp/login line actually derived a logout. Silence with
//      no login line yet is still "idle" with its existing caption, because the user may be
//      logged out RIGHT NOW and the log cannot say so until they come back. That is why the
//      idle caption below is untouched by this feature: it must not learn a word it cannot
//      justify, and with no offline interval in range every string in this file is byte
//      identical to what it was before offline existed.

import type { ComboInterval, RangeStats, ZoneRangeRow } from '@shared/progressionStats'
// The idle threshold as a VALUE, relatively imported (the aaPaceRows `AA_POTION_CHARGES`
// precedent): `ACTIVE_TIME_TITLE` states the number of minutes out loud, and a hand-typed 5 there
// would be a second copy of a measured constant waiting to drift from the one that classifies.
import { IDLE_GAP_MS } from '../../../../shared/progressionStats'
// WHICH HOUR THESE RATES ARE PER (JOS-288). The vocabulary, the default and the just-arrived gate
// all live in `shared/rateBasis.ts`; this file only chooses the words, as it always has.
import {
  RATE_BASES,
  RATE_BASIS_DEFAULT,
  RATE_TOO_SHORT_TITLE,
  basisRead,
  pickRate,
  type BasisRead,
  type RateBasis
} from '../../../../shared/rateBasis'
import { formatAaRate, formatKillRate, formatLevelRate, formatPointRate } from '../../lib/formatRate'
import { fmtDuration } from './levelChartGeometry'
import { zoneColor } from './zoneBands'

/** Every unknown prints as this. Rule 1: an em-dash, never a zero. */
export const NONE = '-'

/** Which column the per-zone table is ordered by. */
export type ZoneSort = 'levels' | 'time'

export interface ZoneStatRow {
  /** React key + stable identity: the row's raw zone name, which `rangeStats` already made
   *  unique (it groups by a case-folded key and keeps the first-seen spelling). */
  key: string
  /** RAW display name (law 2: canonicalize at boundaries, display raw). */
  zone: string
  /** From `zoneBands.zoneColor`, so a row's swatch is the SAME hue as its chart band. */
  color: string
  spanMs: number
  activeMs: number
  idleMs: number
  offlineMs: number
  visits: number
  kills: number
  /** wall time in the zone, e.g. '2h 41m'. */
  time: string
  /** the active half of that time, e.g. '2h 03m' — always <= `time`. */
  active: string
  /** the idle half, or null when the zone had no qualifying silence at all. */
  idle: string | null
  /** the logged-out half, or null when the log derived no logout in this zone. */
  offline: string | null
  /**
   * The parenthetical the table prints after `time`: '2h 03m active', or
   * '2h 03m active · 8h 12m offline' when the camp is one you logged out of. Null when the
   * zone was pure activity, so a row that needs no qualifier carries none — and a row with no
   * offline reads exactly as it always did.
   */
  detail: string | null
  /** Σ levels of progress, or an em-dash when every sample here was unstated. */
  levels: string
  levelsPerHour: string
  killsPerHour: string
  /** how many experience lines in this zone stated no percentage (0 = none). */
  unstated: number
}

/** One hero card's text. The icon and accent stay in the component; these are the words. */
export interface HeroStat {
  id: 'rate' | 'kills' | 'levels' | 'range'
  value: string
  label: string
  sub: string
  /** Hover sentence, when the card's number needs one. Only the RATE card has one: it is the
   *  only card here whose denominator is active time (JOS-249). Absent ⇒ no `title` at all. */
  title?: string
}

const MS_PER_MIN = 60_000

/** A rate, or the em-dash. The ONLY place a `number | null` rate becomes text. */
function rate(n: number | null, fmt: (v: number) => string): string {
  return n == null ? NONE : fmt(n)
}

/**
 * Levels of progress as text. An em-dash when the range gained experience but the log stated
 * no percentage for ANY of it — unknown is not zero. A genuine zero (no experience lines at
 * all) is a stated fact and prints as 0.00.
 */
function levelsText(levelEquiv: number, expSamples: number, expUnstated: number): string {
  return expSamples > 0 && expSamples === expUnstated ? NONE : levelEquiv.toFixed(2)
}

/** Order: the farming-efficiency question first (levels/hr desc), nulls last. */
function byLevels(a: ZoneRangeRow, b: ZoneRangeRow): number {
  const av = a.levelsPerHourActive
  const bv = b.levelsPerHourActive
  if (av == null && bv == null) return b.spanMs - a.spanMs
  if (av == null) return 1
  if (bv == null) return -1
  return bv - av || b.spanMs - a.spanMs
}

/** Order: where the time actually went (span desc), the secondary toggle. */
function byTime(a: ZoneRangeRow, b: ZoneRangeRow): number {
  return b.spanMs - a.spanMs || byLevels(a, b)
}

/** '2h 03m active' (+ ' · 8h 12m offline' when a logout landed in this camp), or null. */
function zoneDetail(z: ZoneRangeRow): string | null {
  if (z.idleMs <= 0 && z.offlineMs <= 0) return null
  const active = `${fmtDuration(z.activeMs)} active`
  return z.offlineMs > 0 ? `${active} · ${fmtDuration(z.offlineMs)} offline` : active
}

/** A zone row's own spans, in the shape `basisRead` takes: its wall clock is its `spanMs`. */
function zoneRead(z: ZoneRangeRow, basis: RateBasis): BasisRead {
  return basisRead(basis, { durationMs: z.spanMs, activeMs: z.activeMs, offlineMs: z.offlineMs })
}

function shapeZone(z: ZoneRangeRow, basis: RateBasis): ZoneStatRow {
  // EVERY RATE ON THE ROW OVER ONE HOUR (JOS-288), and the gate is the row's own: a camp you passed
  // through for ninety seconds states its time and its counts and refuses its rates, while the camp
  // above it that you farmed all evening keeps both of its numbers.
  const read = zoneRead(z, basis)
  return {
    key: z.zone,
    zone: z.zone,
    color: zoneColor(z.zone),
    spanMs: z.spanMs,
    activeMs: z.activeMs,
    idleMs: z.idleMs,
    offlineMs: z.offlineMs,
    visits: z.visits,
    kills: z.kills,
    time: fmtDuration(z.spanMs),
    active: fmtDuration(z.activeMs),
    idle: z.idleMs > 0 ? fmtDuration(z.idleMs) : null,
    offline: z.offlineMs > 0 ? fmtDuration(z.offlineMs) : null,
    detail: zoneDetail(z),
    levels: levelsText(z.levelEquiv, z.expSamples, z.expUnstated),
    levelsPerHour: rate(pickRate(read, z.levelsPerHourActive, z.levelsPerHourWall), formatLevelRate),
    killsPerHour: rate(pickRate(read, z.killsPerHourActive, z.killsPerHourWall), formatKillRate),
    unstated: z.expUnstated
  }
}

/**
 * The per-zone table rows, sorted. `zones` is left untouched (the array is the snapshot
 * query's, not ours to reorder in place).
 *
 * THE SORT IS DELIBERATELY NOT BASIS-AWARE. It orders by `levelsPerHourActive` — the farming
 * -efficiency question, which is what active time was always the right denominator for — so
 * flipping the displayed hour re-words the table without reshuffling it under the reader's cursor.
 */
export function zoneStatRows(
  zones: readonly ZoneRangeRow[],
  sort: ZoneSort = 'levels',
  basis: RateBasis = RATE_BASIS_DEFAULT
): ZoneStatRow[] {
  // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives ZoneRangeRow. Becomes a view descriptor when the source lands.
  return [...zones].sort(sort === 'time' ? byTime : byLevels).map((z) => shapeZone(z, basis))
}

/** The kills card's caption. The pet half is INFERRED — pet binding is learned from the
 *  `<Name> told you, '… Master.'` tell and charm lines, never stated per kill. */
function killsSub(stats: RangeStats): string {
  if (stats.kills === 0) return 'no credited kills in this range'
  const mine = `${stats.killsSelf} your killing blow${stats.killsSelf === 1 ? '' : 's'}`
  return stats.killsPet > 0 ? `${mine} · ${stats.killsPet} pet (inferred)` : mine
}

/**
 * THE ACTIVE SPAN A RATE WAS MEASURED OVER, in the words this feature already used for it.
 *
 * Exported because it is the honesty rule for every windowed rate on the tab (JOS-75), not just
 * this panel's: a levels-per-hour or an AA-per-hour over a window the character barely played
 * is a real measurement of a very small sample, and the only thing that separates it from a
 * confident claim is saying how much play it is over. One spelling, so the range panel and the
 * AA pace caption can never describe the same denominator differently.
 */
export function activeSpanText(activeMs: number): string {
  return basisSpanText({ basis: 'active', word: 'active', ms: activeMs, measurable: true })
}

/**
 * THE SPAN A RATE WAS MEASURED OVER, whichever hour that is (JOS-288) — `over 1h 0m elapsed`,
 * `over 42m active`. The generalisation of `activeSpanText`, which is now one call of it and still
 * renders byte for byte what it always did.
 *
 * The WORD is never dropped. A bare "over 42m" beside a rate is the exact ambiguity the pair exists
 * to remove, and it is the ambiguity a toggle makes easiest to fall into.
 */
export function basisSpanText(read: BasisRead): string {
  return `over ${fmtDuration(read.ms)} ${read.word}`
}

/** The levels-per-hour card's caption — including WHY it is an em-dash when it is. */
function rateSub(stats: RangeStats, read: BasisRead): string {
  // ORDER MATTERS, and the two denominator refusals are NOT the same sentence (JOS-288). A range
  // with NO time of this kind at all is the older, more specific fact and keeps its own words; a
  // range that has some but too little is the just-arrived case. Both outrank anything the
  // numerator could say, because with no hour to divide by there is nothing to say about it yet.
  if (pickRate(read, stats.levelsPerHourActive, stats.levelsPerHourWall) != null) return basisSpanText(read)
  if (read.ms === 0) return `no ${read.word} time in this range`
  if (!read.measurable) return `${basisSpanText(read)} - too short to state as a rate`
  if (stats.expSamples > 0) return 'the log stated no percentage in this range'
  return `no ${read.word} time in this range`
}

/** Dings in range as level runs. A loadout swap opens a NEW run: the level legitimately goes
 *  DOWN and the drop is never logged, so the two runs are never joined into one span. */
function levelRangeText(runs: RangeStats['levelRuns']): string {
  if (runs.length === 0) return NONE
  return runs.map((r) => (r.fromLevel === r.toLevel ? `${r.toLevel}` : `${r.fromLevel} → ${r.toLevel}`)).join(' · ')
}

function levelRangeSub(stats: RangeStats): string {
  const n = stats.levelUps.length
  if (n === 0) return 'no level-ups in this range'
  const dings = `${n} ding${n === 1 ? '' : 's'}`
  return stats.levelRuns.length > 1 ? `${dings} · ${stats.levelRuns.length - 1} class swap` : dings
}

/**
 * The four headline cards (plan §6.4): levels/hr active · mobs killed · levels gained ·
 * level range covered. Every value that can be unknown is an em-dash with a caption that
 * says which kind of unknown it is.
 */
export function rangeHeroes(stats: RangeStats, basis: RateBasis = RATE_BASIS_DEFAULT): HeroStat[] {
  const read = basisRead(basis, stats)
  return [
    {
      id: 'rate',
      value: rate(pickRate(read, stats.levelsPerHourActive, stats.levelsPerHourWall), formatLevelRate),
      label: 'Levels per hour',
      sub: rateSub(stats, read),
      // The caption already says "over 2h 03m elapsed"; this says what that hour is (JOS-249), and
      // says instead why there is no number when the stretch is too short to have one (JOS-288).
      title: withBasis(`Levels of progress per hour of ${read.word} time.`, read)
    },
    { id: 'kills', value: stats.kills.toLocaleString(), label: 'Mobs killed', sub: killsSub(stats) },
    {
      id: 'levels',
      value: levelsText(stats.levelEquiv, stats.expSamples, stats.expUnstated),
      label: 'Levels of progress',
      sub: `${stats.expSamples} experience gain${stats.expSamples === 1 ? '' : 's'}`
    },
    {
      id: 'range',
      value: levelRangeText(stats.levelRuns),
      label: 'Level range covered',
      sub: levelRangeSub(stats)
    }
  ]
}

/** '2h 41m active · 38m idle', or just the active half when nothing qualified as idle. */
export function activeIdleText(stats: RangeStats): string {
  const active = `${fmtDuration(stats.activeMs)} active`
  return stats.idleMs > 0 ? `${active} · ${fmtDuration(stats.idleMs)} idle` : active
}

/**
 * The idle rule, literally, as a caption on the number it explains. The threshold is a
 * CHOICE, not a fact, so it is always shown beside the value it produced — and it is read
 * from the stats object (`IDLE_GAP_MS`), never typed in as a number here.
 *
 * The wording is deliberate: "idle", never "AFK" and never "offline". Within a session the log
 * records EVENTS, not PRESENCE, so medding, banking, crafting, travelling and being away from
 * the keyboard are all the same silence — and so is a logout the log has not yet CLOSED with a
 * login line. This string is therefore left exactly as it was when offline landed: it covers
 * every silence the app cannot attribute, which is precisely the set that must not be called
 * offline. `OFFLINE_TITLE` states that limit where the offline number itself is shown.
 */
export function idleRuleCaption(idleThresholdMs: number): string {
  const mins = idleThresholdMs / MS_PER_MIN
  return `idle = no experience, kill, or loot event for over ${mins} minutes`
}

/**
 * WHY THE ELAPSED SPAN IS SHORTER THAN THE RANGE IT WAS MEASURED OVER (JOS-454).
 *
 * A zone slice's `durationMs` is Σ of the visits its MEMBERSHIP admitted, not `t1 - t0`, and the
 * header prints both numbers with nothing between them. The owner's report is what that costs: a
 * drag across 1h51m of a Plane of Hate session read `15m`, because he had stepped out of
 * `The Plane of Hate 4 (Refined)` into open-world `The Plane of Hate` and the slice opens on
 * `exactTier` (JOS-332) — so the 1h35m in the instance was not in the slice at all, while the
 * chart above the panel went on drawing it, bands, rising level curve and all. Nothing on the
 * panel named a zone, let alone a tier.
 *
 * So the shortfall is STATED rather than left to be inferred: how much of the selected span the
 * numbers actually cover, and which membership decided that. It is the same honesty rule JOS-288
 * applied to the rate denominators — the span line IS the denominator, so it has to say what it
 * counted.
 */
export const MEMBERSHIP_TITLE =
  'These numbers cover only the visits this slice admits, so the elapsed span is shorter than the range it was ' +
  'measured over. Time spent in another zone - or in another tier of this one, while "this tier" is in force - is ' +
  'left out, even where the chart above still draws it.'

/**
 * The shortfall line, or null when there is none: `of 1h 51m selected · The Plane of Hate, this
 * tier only`.
 *
 * NULL IS THE COMMON CASE and it has to stay cheap: an unrestricted range's `durationMs` IS
 * `t1 - t0` (`rangeStats` computes it that way), so an unsliced read prints nothing new and every
 * string on this panel is byte-identical to what it was. It is also null when a zone slice
 * happened to admit the whole span — there is no shortfall to explain then, and the ScopeBar's
 * own caption already names the slice.
 */
export function membershipText(stats: RangeStats, zoneCaption: string | null | undefined): string | null {
  if (!zoneCaption) return null
  const span = Math.max(0, stats.t1 - stats.t0)
  // WHOLE SECONDS, because that is the resolution `fmtDuration` prints at: a sub-second remainder
  // off a bucket-snapped edge is not a shortfall anybody can see, and announcing one would put a
  // permanent second clause on every zone-sliced read.
  if (span - stats.durationMs < 1000) return null
  return `of ${fmtDuration(span)} selected · ${zoneCaption}`
}

/**
 * WHAT "ACTIVE TIME" MEANS, IN ONE SENTENCE, WHEREVER A RATE DIVIDES BY IT (JOS-249).
 *
 * A 0.22.0 user asked the question this string answers — "is that AFK removed, or any time not in
 * combat?" — and neither guess is right, so the sentence says what it IS and then names both
 * guesses to close them out. It is the reading of `progressionStats.rangeStats` exactly:
 *
 *   activeMs = durationMs - idleMs - offlineMs
 *
 * where `durationMs` is the selection's wall clock (Σ of the zone's own visits when the slice or
 * the row carries a zone), `idleMs` is every gap longer than `IDLE_GAP_MS` in the exp ∪ credited
 * kill ∪ loot stream — the WHOLE gap, not `gap - threshold` — and `offlineMs` is the logouts the
 * log closed with a login line. MEASURED while writing this (synthetic snapshots through the real
 * `rangeStats`): a 6-minute hole costs the full 6 minutes, a 4m59s hole costs nothing, loot alone
 * keeps the clock running, and a 30-minute stretch of pure fighting with no kill, exp or loot line
 * scored 0 active — which is why the sentence refuses "out of combat" out loud. Damage is not a
 * column of `ProgressionSnap` at all, so combat can neither start nor stop this clock.
 *
 * ONE SPELLING, ON EVERY SURFACE THAT DIVIDES BY IT — the Leveling range panel, the AA pace,
 * the in-window drops, the Loot drill-down's per-zone rates, the Overview leveling card and the XP
 * overlay all hover the same words, because a definition worded twice is a definition that will
 * eventually say two things.
 */
export const ACTIVE_TIME_TITLE =
  `Active time = the span shown minus every gap over ${IDLE_GAP_MS / MS_PER_MIN} minutes with no experience, credited kill, ` +
  'or loot line, and minus any stretch the log says you were logged out - not an AFK check, and not out-of-combat time.'

/**
 * WHAT THE OTHER DENOMINATOR IS, in one clause, wherever it is shown.
 *
 * It was written for the loot ledger (JOS-261, `lootRateText.ts`) and MOVED HERE in JOS-288 — beside
 * its twin, and for the reason the twin's own doc gives: the two sentences define each other's
 * complement, three more surfaces now show them as a pair, and `lootRateText.ts` importing this file
 * while this file imported that one would be a cycle around one string. `lootRateText.ts` re-exports
 * it, so every existing importer is untouched and there is still exactly one spelling.
 *
 * It is `RangeStats.levelsPerHourWall`'s denominator read out loud (`wallMs` = `durationMs -
 * offlineMs`), and the sentence says what stays IN as well as what comes out: the point of this half
 * of the pair is that the medding, the banking and the run back are counted, because you spent them.
 */
export const ELAPSED_TIME_TITLE =
  'Elapsed time = the whole stretch the slice covers, including the idle time inside it, minus only ' +
  'any stretch the log says you were logged out - so medding, banking and travelling stay in this denominator.'

/** The defining sentence for each basis. One lookup, so no surface can pair a word with the wrong
 *  definition (JOS-288). */
export const BASIS_TITLE: Record<RateBasis, string> = {
  active: ACTIVE_TIME_TITLE,
  elapsed: ELAPSED_TIME_TITLE
}

/**
 * WHAT PICKING A BASIS DOES TO THE NUMBERS, on the button that picks it (JOS-304).
 *
 * Owner feedback 2026-08-13: *the elapsed/active toggle is hard to understand*. One word on a
 * button cannot say which denominator it is, and the caption under the row only reads the pick
 * back ("rates per hour of active time") — true, and no help to somebody who does not yet know
 * what active time is. So the button hover leads with the EFFECT and then hands over to the
 * definition proper.
 *
 * DERIVED FROM `BASIS_TITLE`, NEVER RE-WORDED. The definition half is the same string the caption
 * hovers, looked up rather than copied, so the button and the line under it cannot come to disagree
 * about what the hour is — which is the whole reason `BASIS_TITLE` is a lookup and not two
 * literals. Built over `RATE_BASES` for the same reason: a third denominator would arrive with its
 * sentence already written instead of with a missing key.
 */
export const BASIS_BUTTON_TITLE: Record<RateBasis, string> = Object.fromEntries(
  RATE_BASES.map((id) => [id, `Divides every rate by ${id} time. ${BASIS_TITLE[id]}`])
) as Record<RateBasis, string>

/** `title` with the definition appended — the ONE way a surface that already had a hover sentence
 *  gains this one, so the two can never be separated by a copy-paste. */
export function withActiveTime(title: string): string {
  return `${title} ${ACTIVE_TIME_TITLE}`
}

/**
 * `title` with the definition of the hour actually in force, plus the refusal when there is not
 * enough of that hour to divide by. The basis-aware `withActiveTime`, and the only way a rate
 * surface should be building a hover since JOS-288.
 */
export function withBasis(title: string, read: BasisRead): string {
  const definition = BASIS_TITLE[read.basis]
  return read.measurable ? `${title} ${definition}` : `${RATE_TOO_SHORT_TITLE} ${definition}`
}

/**
 * Time the log SAYS you were logged out, or null when it said nothing of the kind. Null is the
 * common case and the important one: no derived offline interval ⇒ no offline word anywhere
 * (rule 4 in the header).
 */
export function offlineText(stats: RangeStats): string | null {
  return stats.offlineMs > 0 ? `${fmtDuration(stats.offlineMs)} offline` : null
}

/** The offline chip's caption. One word for the state, no account of how it was derived. */
export const OFFLINE_CAPTION = 'logged out'

/** The offline chip's tooltip — what the number is, in one clause (AGENTS.md tooltip diet). */
export const OFFLINE_TITLE = 'Time the log says you were logged out.'

/** How many separate logouts produced that total — a title-attribute detail, null when none. */
export function offlineGapsText(stats: RangeStats): string | null {
  if (stats.offlineGaps === 0) return null
  return `${stats.offlineGaps} logout${stats.offlineGaps === 1 ? '' : 's'}`
}

/** How many separate silences produced that idle total — a title-attribute detail. */
export function idleGapsText(stats: RangeStats): string | null {
  if (stats.idleGaps === 0) return null
  return `${stats.idleGaps} gap${stats.idleGaps === 1 ? '' : 's'} over ${fmtDuration(stats.idleThresholdMs)}`
}

/**
 * The class loadout, as the combo model stated it. ZERO inference here: an empty list is a
 * first-class state, not an error — the self `/who` row is the only line that ever states a
 * loadout and there are 11 of them in 1.1M lines, so "unknown" is the COMMON case and has to
 * look deliberate rather than broken.
 */
export function comboText(combos: readonly ComboInterval[]): string {
  if (combos.length === 0) return 'class combo: not stated in this range'
  const seen = new Set<string>()
  for (const c of combos) seen.add(c.classes.join('/'))
  return `class combo: ${[...seen].join(' → ')}`
}

/** True when any stated combo carried the combo model's own `inferred` flag. */
export function comboInferred(combos: readonly ComboInterval[]): boolean {
  return combos.some((c) => c.inferred)
}

/** Kills you only WITNESSED — other players', other mobs'. Deliberately outside every rate,
 *  so a busy zone cannot inflate your farming numbers; null when there were none. */
export function witnessedText(stats: RangeStats): string | null {
  return stats.killsWitnessed > 0 ? `${stats.killsWitnessed.toLocaleString()} kills by others seen` : null
}

/** AA gained in range, or null when none. */
export function aaText(stats: RangeStats): string | null {
  return stats.aaGainEvents > 0 ? `+${stats.aaGained.toLocaleString()} AA` : null
}

/**
 * The AA caption. It is Σ of the gain LINES, not the AA identity — the reservation stays in
 * this doc comment, where it belongs; the caption just names the source in two words.
 */
export const AA_RESPEC_CAPTION = 'from the gain lines'

/**
 * The AA pace in the selection: completions per hour and points per hour, both over ACTIVE
 * time — the same denominator `levelsPerHour` uses, so the three read against each other.
 * Null when the range holds no AA at all (rule 1: no chip beats a chip full of em-dashes).
 *
 * The two rates are shown TOGETHER on purpose. They are equal until an item-shop bottle is
 * running and diverge while one is, which is the only way a surface can show what the potion
 * did without claiming the potion made AA arrive faster. It does not — it doubles what a
 * completion pays, never what a completion costs.
 */
export function aaRateText(stats: RangeStats, basis: RateBasis = RATE_BASIS_DEFAULT): string | null {
  if (stats.aaGainEvents === 0) return null
  const read = basisRead(basis, stats)
  const completions = rate(pickRate(read, stats.aaPerHourActive, stats.aaPerHourWall), formatAaRate)
  const points = rate(pickRate(read, stats.aaPointsPerHourActive, stats.aaPointsPerHourWall), formatPointRate)
  return `${completions} · ${points}`
}

/** The AA-rate chip's tooltip — what each half measures, and what the hour under it is. */
export function aaRateTitle(stats: RangeStats, basis: RateBasis = RATE_BASIS_DEFAULT): string {
  const read = basisRead(basis, stats)
  return withBasis(`AA completions and ability points per hour of ${read.word} time.`, read)
}

/** The pre-JOS-288 constant, kept for surfaces that state the active reading unconditionally. */
export const AA_RATE_TITLE = withActiveTime('AA completions and ability points per hour of active time.')

/**
 * The footnote for rows whose experience lines stated no percentage. Null when every sample
 * in the range stated one, so the panel carries no caption it does not need.
 */
export function unstatedCaption(stats: RangeStats): string | null {
  if (stats.expUnstated === 0) return null
  const n = stats.expUnstated
  return `* ${n} experience line${n === 1 ? '' : 's'} stated no percentage`
}
