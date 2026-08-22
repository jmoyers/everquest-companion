// sessionSegments.ts — "START A NEW SESSION NOW", ON THE DETAILS! RESET MODEL (JOS-436).
//
// A 1.5.0 reporter, on the Loot tab's custom slice: *date picker is trashola. cannot select a
// future date on the end time. really it would be ideal to just say "start a new session" from now
// so i can pop a new session when i reset the instance.* The owner ruled the shape: keep the old
// reference, split the record FORWARD from the click, and look at how the WoW meter Details!
// handles it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT DETAILS! ACTUALLY DOES (the desk research, in five sentences).
//
//   1. It keeps a LIST of segments — `Overall` (the running accumulation), `Current` (the fight in
//      progress), and a bounded history of past fights — and every window renders over exactly one
//      of them, picked from a dropdown.
//   2. A new segment OPENS automatically at each combat start; the one that was current is pushed
//      onto the history stack rather than discarded, so yesterday's pull is still readable.
//   3. `Reset` is the manual version of the same move — it closes what is running and starts a
//      fresh Current, which is the button raiders press at the start of a night; `Reset Overall`
//      and `Reset All` differ only in how much history they take with them.
//   4. BROWSING IS A PICK, NEVER A MUTATION: selecting an old segment changes what is drawn and
//      does not stop the current one from accruing behind it.
//   5. Every segment carries its OWN start and end, and every per-second number is divided by that
//      segment's own time — never by a global clock — which is the only reason two segments of one
//      night can be compared at all.
//
// THE TRANSLATION TO THIS APP. This repo already has (4) and (5): `shared/timeslice.ts` is a PICK
// over a half-open range, and `rangeStats` divides by the spans of exactly that range (JOS-261).
// What it did not have is (3) — a way to say "the stretch I care about starts NOW" without typing
// an end instant the picker would not accept anyway. So a session mark is nothing but an INSTANT,
// and the segments are the half-open intervals BETWEEN the marks. Nothing is stored twice, nothing
// is frozen or copied, and an old segment's totals are "frozen" in the only sense that matters:
// its range has both ends now, so it cannot move again.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THE DENOMINATORS STAY HONEST ACROSS THE SPLIT (JOS-261 lineage, and the reason this file
// hands back RANGES rather than pre-measured numbers).
//
// The segments TILE the record: `[start, m1) [m1, m2) … [mn, end)`, half-open, adjacent, with no
// gap and no overlap — the same convention `inSlice` and `rangeStats` already share. So the
// numerator partitions trivially (a drop is in exactly one segment).
//
// THE DENOMINATOR IS THE INTERESTING HALF, and it partitions too — because of a rule
// `progressionStats.idleSpans` was already written to: the samples BRACKETING a range are pulled
// into its walk unconditionally, so a silence that STRADDLES a mark is measured at its true length
// and then clipped to each side. Without that, splitting an 8-minute AFK at minute 4 would leave
// two 4-minute gaps, each under `IDLE_GAP_MS`, and `activeMs` would be INVENTED on both sides of
// the split — the segments would sum to more active time than the record they came from. They do
// not, and `tests/sessionSegments.test.mts` pins Σ over the segments == the unsplit range for
// duration, active, idle and offline alike, over exactly that arrangement.
//
// PURE, and clock-free for `shared/timeslice.ts`'s own reason: the mark is an argument. The one
// `Date.now()` in this feature lives in the click handler (`useTimeslice.newSession`), where the
// user's "now" actually is.

import type { SliceRange } from './timeslice'

/**
 * THE END THAT HAS NOT HAPPENED YET — the whole point of the ticket, spelled as a number so that
 * every consumer downstream stays plain arithmetic.
 *
 * `timeslice.clamp` resolves it to the live edge of the record on EVERY read, so a segment opened
 * with this end grows as the log grows and never needs to be rewritten. That is what "an open end"
 * means here, and it is why the reporter no longer has to type a future instant into a picker that
 * would clamp it back.
 */
export const OPEN_END = Number.POSITIVE_INFINITY

/**
 * The other open end: the first segment starts wherever the RECORD does, which this file cannot
 * know (bounds belong to the caller — `zoneBands.dataBounds`). Same trick, same clamp.
 */
export const RECORD_START = Number.NEGATIVE_INFINITY

/** How many marks are kept. Details! keeps a bounded history for the same reason: a browsing
 *  control is only browsable while you can still read it. The OLDEST is dropped, so the segment
 *  you are standing in is never the one that falls off. */
export const MAX_SESSION_MARKS = 24

/**
 * One stretch of play between two marks. The `range` is the WHOLE contract: hand it to
 * `resolveSlice` as a custom range and every number on every surface is measured over it.
 */
export interface SessionSegment {
  /** 1-based, oldest first — the number the label prints, and the index `pickSegment` takes. */
  n: number
  range: SliceRange
  /** Exactly one segment is current: the newest, the one still accruing. */
  current: boolean
  /** The picker's word for it. `Session 3 (now)` for the one still running. */
  label: string
  /** How it is worded INSIDE a sentence ("no loot in ___"), like every `Timeslice.caption`. */
  caption: string
}

/**
 * Add a mark, keeping the list ascending, deduped and bounded.
 *
 * A mark at or before the newest one is DROPPED rather than sorted in: two clicks in the same
 * millisecond would otherwise open a segment that can never hold anything, and a segment nobody
 * can put a drop in is a row in a picker that lies about being a choice.
 */
export function addSessionMark(marks: readonly number[], at: number): number[] {
  if (!Number.isFinite(at)) return [...marks]
  const last = marks.length > 0 ? marks[marks.length - 1] : null
  if (last !== null && at <= last) return [...marks]
  const next = [...marks, at]
  return next.length > MAX_SESSION_MARKS ? next.slice(next.length - MAX_SESSION_MARKS) : next
}

/**
 * THE SPLIT: n marks make n+1 segments, tiling the record end to end.
 *
 * With no marks at all there is ONE segment — the whole record, still running — which is the
 * honest reading of "you have never pressed the button" and is byte-identical to `All`. The
 * caller decides whether a one-segment list is worth drawing a picker for; this function does not
 * withhold it, because the current segment is what `newSession` selects.
 */
export function sessionSegments(marks: readonly number[]): SessionSegment[] {
  const starts = [RECORD_START, ...marks]
  return starts.map((t0, i) => {
    const current = i === starts.length - 1
    const n = i + 1
    return {
      n,
      range: { t0, t1: current ? OPEN_END : starts[i + 1] },
      current,
      label: current ? `Session ${String(n)} (now)` : `Session ${String(n)}`,
      caption: `session ${String(n)}`
    }
  })
}

/** The segment still accruing — the one `newSession` leaves you looking at. Never null: the split
 *  of an empty mark list is the whole record, and the whole record is always running. */
export function currentSegment(marks: readonly number[]): SessionSegment {
  const segs = sessionSegments(marks)
  return segs[segs.length - 1]
}

/**
 * The segment with that ordinal, or null when the list cannot offer it.
 *
 * Null is a real answer: a pick can outlive the marks it was made against (a character rebuild
 * clears them), and the caller then falls back the way `resolveSliceId` does rather than reading
 * past the end of the list.
 */
export function segmentAt(marks: readonly number[], n: number): SessionSegment | null {
  return sessionSegments(marks).find((s) => s.n === n) ?? null
}
