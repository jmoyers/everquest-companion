// windowScope.ts — WHICH STRETCH OF THE LOG the Leveling tab's numbers describe (JOS-75).
//
// JOS-71 gave the two plots a timescale; it moved the CURVES and nothing else, so a user who
// picked `1h` got an hour-wide chart sitting above a rate measured over the whole log. This
// module is the seam that fixes that: one scope, computed once, read by every number on the tab.
//
// Pure. No React, no DOM, no MUI. The one VALUE import is relative
// (`../../../../shared/progressionStats`) rather than `@shared/*`, because the node test runner
// has no such alias — the overviewLevelingData.ts precedent, and the reason
// tests/levelingWindowScope.test.mts can import this file straight under tsx.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE THREE RULES
//
//   1. ONE DERIVATION, NEVER A SECOND RATE MATH. The scope's numbers are `rangeStats` — the
//      same pure query the drag-select panel has always used, over a different pair of
//      instants. Nothing here divides anything by anything; a second implementation of
//      "levels per active hour" is exactly the drift this seam exists to prevent.
//
//   2. THE SCOPE IS THE WINDOW ∩ THE RECORD. The DRAWN window is not the stats window: every
//      scale carries a trailing pad (chartWindow.ts `TRAILING_FRAC`) and a fixed one snaps both
//      ends OUTWARD to the bucket grid, so the drawn `t1` sits past the newest event on purpose
//      — that gutter is what makes the current level read as a plateau instead of a bare
//      endpoint. Counting it as time would hand every window a slab of manufactured silence at
//      its right edge. So the scope clamps to `dataBounds`, and the consequence is the identity
//      this module is pinned on: at `All` the scope is EXACTLY `[lo, hi]`, which is the range a
//      full-history read has always meant.
//
//   3. A SELECTION IS A NARROWER RANGE ON THE SAME BASE, AND IT WINS. A committed drag is the
//      user saying something more specific than the timescale did, so while one exists every
//      number follows IT — and `useChartSelection` already drops a selection the new window
//      cannot contain, so the two can never describe disjoint stretches. Clearing it falls back
//      to the window with no other state involved: the scope is a function of (snapshot,
//      window, bounds, selection), never a thing anybody stores.
//
//      AND IT CLAMPS, EXACTLY LIKE A WINDOW (JOS-454). This used to hand the drag through
//      VERBATIM — a test asserted the words "never re-clamped to the record" — and rule 2 is the
//      reason that was wrong: the DRAWN window's right edge sits in the trailing gutter, so a
//      drag to the right edge of the chart selects instants the log has not reached. MEASURED on
//      the owner's report: a selection whose header read `15:29:55` over a record that ended at
//      `15:20:27` handed 9m28s of manufactured silence to the numbers, and because
//      `zoneSegments` closes a still-OPEN zone interval at the range's end, every one of those
//      minutes was booked as time standing in that zone. The panel read `15m elapsed · 0s
//      active`. Rule 2's whole argument — "counting it as time would hand every window a slab of
//      manufactured silence at its right edge" — never depended on which gesture produced the
//      edge. The DRAWN band is untouched (the user's rectangle stays where they drew it); only
//      the stats range is clamped, which is the same split rule 2 already makes.

import type { ProgressionSnap } from '@shared/types'
import type { ComboSource, RangeStats } from '@shared/progressionStats'
import { rangeStats } from '../../../../shared/progressionStats'
import { TIMESCALES, type TimescaleId } from './chartWindow'
import type { DataBounds } from './zoneBands'

/** A half-open pair of instants. Structurally what `rangeStats` and `ChartScale` both carry. */
export interface ScopeRange {
  t0: number
  t1: number
}

/** Which of the two things a user can ask for produced these numbers. */
export type ScopeKind = 'window' | 'selection'

export interface ScopedStats {
  kind: ScopeKind
  /**
   * How the scope is WORDED wherever a number has to say which stretch it covers. One spelling
   * per scope, so the AA pace caption and the range panel can never describe the same instants
   * differently — the mistake `HEADLINE_WINDOW_LABEL` exists to prevent on the Overview card.
   */
  label: string
  /** The instants the numbers cover — always `stats.t0`/`stats.t1`, restated for callers that
   *  need the range without the whole answer (the progress feed filters on it). */
  range: ScopeRange
  /**
   * The ZONE half of the slice (JOS-130) — a `shared/zones.zoneKey` fold, or null for every zone.
   * It rides
   * on the scope for the same reason the range does: a consumer that filters its own rows (the
   * in-window drops panel, the progress feed) has to apply BOTH halves or it will describe a
   * different stretch of play than the numbers beside it.
   */
  zoneKey: string | null
  /**
   * The TIER half of that zone (JOS-291) — a `zoneScope.zoneIdKey` fold, or null for every tier of
   * the place, which is the default and is byte-identical to every read before the option existed.
   * It rides beside `zoneKey` for `zoneKey`'s own reason: a consumer filtering its own rows has to
   * apply the WHOLE membership or it describes a different stretch of play than the numbers do.
   */
  zoneExactKey: string | null
  /** RAW display name of that zone, for wording. Null when the slice is not restricted. */
  zoneName: string | null
  /**
   * THE ZONE HALF, WORDED, MEMBERSHIP AND ALL (`timeslice.zoneCaption` — `Befallen 2 (Adaptive),
   * this tier only`). Null when the slice is not restricted to a zone.
   *
   * It rides on the scope because JOS-454 found the one place the membership went dark: a drag
   * replaced the slice's caption with its own, and the tier clause — the half that decides
   * whether 1h35m in an instance counts at all — went with it. The panel that prints the elapsed
   * span reads this, so the denominator and the membership that produced it are one sentence
   * (JOS-288's honesty rule).
   */
  zoneCaption: string | null
  stats: RangeStats
}

/** How a committed drag is worded. It names the gesture's result, not the gesture. */
export const SELECTION_LABEL = 'the selected range'

/**
 * How a timescale is worded on a number that covers it: `All` is the whole log, every other
 * rung is "last <its own button label> of the log".
 *
 * Derived from the button the user pressed rather than spelled out a second time — a scale
 * whose label and whose caption could disagree is a scale nobody can trust.
 */
export function timescaleLabel(id: TimescaleId): string {
  const scale = TIMESCALES.find((s) => s.id === id)
  if (!scale || scale.ms === 0) return 'the whole log'
  return `last ${scale.label} of the log`
}

/**
 * THE RECORD'S NEWEST INSTANT IS INSIDE EVERY SCOPE.
 *
 * `rangeStats` ranges are half-open `[t0, t1)`, which is the right semantics for a band dragged
 * with a cursor — the instant under the pointer belongs to whatever is to its right. For a
 * WINDOW it is off by one event: the newest kill, gain line or ding in the log is stamped at
 * `bounds.hi` EXACTLY, so an end at `hi` leaves the last thing that happened out of totals whose
 * chart is plainly drawing it. MEASURED as a real off-by-one while writing
 * tests/levelingWindowScope.test.mts, not reasoned about afterwards. So a scope ends one
 * millisecond past the record; EQ stamps whole seconds, so nothing but the events already at
 * `hi` can live in that millisecond, and no duration a user reads is moved by it.
 */
const TAIL_MS = 1

/**
 * The stretch of the RECORD a drawn window covers — rule 2 in the header.
 *
 * Both ends clamp: the right one drops the trailing gutter (and any outward bucket snap past
 * the newest event), the left one drops an outward snap that reached back before the first.
 * At `All` both clamps are no-ops apart from `TAIL_MS`, which is the identity the tests pin.
 */
export function statsRangeFor(win: ScopeRange, bounds: DataBounds): ScopeRange {
  // WHOLE MILLISECONDS. A drawn edge can be fractional — the trailing pad is a FRACTION of the
  // span, so a one-instant record draws a window 0.04 ms wide — and a duration of 0.04 ms is
  // noise in every rate derived from it. Outward at both ends, so rounding never clips an event.
  const t0 = Math.floor(Math.max(win.t0, bounds.lo))
  return { t0, t1: Math.max(t0, Math.min(Math.ceil(win.t1), bounds.hi + TAIL_MS)) }
}

export interface ScopeArgs {
  snap: ProgressionSnap
  /** The DRAWN window — the `ChartScale` both plots read (chartWindow.ts `windowFor`). */
  win: ScopeRange
  /** Where the record actually starts and ends (zoneBands.ts `dataBounds`). */
  bounds: DataBounds
  /** Which timescale produced `win`. It supplies the WORDING and never the arithmetic. */
  id: TimescaleId
  /** A committed drag, or null. Present ⇒ it wins (rule 3). */
  selection: ScopeRange | null
  /** The optional class-combo seam `rangeStats` declares. Absent ⇒ `combos: []`. */
  combo?: ComboSource
  /**
   * THE SLICE'S OWN RANGE, when the caller has one (JOS-130). Absent ⇒ derived from the drawn
   * window exactly as before (rule 2), which is what the duration rungs still want: their ends
   * come from the bucket snap and must be clamped back to the record.
   *
   * A semantic slice states BOTH its ends (this session starts at a login line; a custom range is
   * two instants the user typed), so re-deriving them from a padded drawn window would push the
   * end past what was asked for. Passed through verbatim.
   */
  range?: ScopeRange
  /**
   * The slice's zone restriction — a `shared/zones.zoneKey` fold, or null. Handed straight to
   * `rangeStats`; nothing here interprets it, which is what keeps "one derivation" true.
   */
  zoneKey?: string | null
  /** The slice's tier restriction (JOS-291) — a `zoneScope.zoneIdKey` fold, or null. Handed
   *  straight to `rangeStats` beside the key above; nothing here interprets either. */
  zoneExactKey?: string | null
  /** The slice's own wording. Absent ⇒ `timescaleLabel(id)`, the JOS-71 spelling. */
  label?: string
  /** RAW display name of the restricted zone, for the wording only. */
  zoneName?: string | null
  /**
   * The slice's ZONE HALF worded with its membership (`timeslice.zoneCaption`). Absent ⇒ the
   * wording falls back to `zoneName` alone, which is what every caller that has no slice passes.
   */
  zoneCaption?: string | null
}

/**
 * The tab's ONE scope: the range in force, what to call it, and everything `rangeStats` says
 * about it. Exactly one query runs — the losing candidate is never computed, so widening the
 * dashboard's scope-awareness cost the view a `rangeStats` call rather than adding one.
 */
export function scopedStats(args: ScopeArgs): ScopedStats {
  const { snap, win, bounds, id, selection, combo } = args
  const zoneKey = args.zoneKey ?? null
  const zoneExactKey = args.zoneExactKey ?? null
  const zoneName = args.zoneName ?? null
  const zoneCaption = args.zoneCaption ?? zoneName
  // THE DRAG IS CLAMPED TO THE RECORD (JOS-454, rule 3): the same `statsRangeFor` a window goes
  // through, for the same reason a window goes through it — the drawn edge the user dragged to
  // sits in the trailing gutter, and the gutter is not time anybody played.
  const range = selection ? statsRangeFor(selection, bounds) : (args.range ?? statsRangeFor(win, bounds))
  // A DRAG NARROWS TIME AND NOTHING ELSE (JOS-130). The zone half of a slice is a different
  // dimension from the range half, so a selection drawn while `Zone` is in force still describes
  // that zone — and the wording says both, rather than letting one silently outrank the other.
  // It says the MEMBERSHIP too (JOS-454): `zoneCaption` carries the tier clause the slice's own
  // caption carried, so a drag can no longer quietly drop the half of the sentence that decides
  // whether the visits it excluded were excluded on purpose.
  const drag = zoneCaption ? `${SELECTION_LABEL} in ${zoneCaption}` : SELECTION_LABEL
  return {
    kind: selection ? 'selection' : 'window',
    label: selection ? drag : (args.label ?? timescaleLabel(id)),
    range,
    zoneKey,
    zoneExactKey,
    zoneName,
    zoneCaption,
    stats: rangeStats({ snap, range, combo, zoneKey, zoneExactKey })
  }
}
