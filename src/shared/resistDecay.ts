// RECENT EVIDENCE WEIGHS MORE (JOS-397, owner ruling 2026-08-16).
//
// Pure, dependency-free. One subject: how OLD an observation is, and what that costs it in the
// likelihood. `resistTerms.ts` turns a row into a term, `resistFit.ts` fits a bag of them, and this
// file is the weight each one carries into that bag.
//
// ── WHY AT ALL ─────────────────────────────────────────────────────────────────────────────────
//
// The estimator pools every observation ever filed about a cell and weighs them equally, which is
// right for a creature that never changes and wrong for a game that patches. Two things it costs:
//
//   A RETUNE IS INVISIBLE FOR AS LONG AS THE OLD DATA OUTNUMBERS THE NEW. JOS-382 already answered
//   the shipped-baseline half of this (`BASELINE_K`, your own log beats the frozen file); it said
//   nothing about your own log from March against your own log from today.
//   THE OWNER'S OWN CASE, which is what got this built: three resists running on the female vampires
//   in Hate against a long-run estimate that says magic is ordinary. A four-week-old cell should not
//   outvote this evening by four to one just because it is bigger. (JOS-397 also shipped a separate
//   run detector that PRINTED such a run as its own verdict; the owner removed it the same day —
//   JOS-400 — because a second verdict beside the formula is not the formula. This file is the half
//   that was kept, and it is the half that lives INSIDE the one estimate.)
//
// ── THE TWO NUMBERS, AND WHY THEY ARE THESE NUMBERS ────────────────────────────────────────────
//
//   HALF-LIFE 21 DAYS. Patches land weeks apart, so the unit that matters is the week and the
//   half-life has to be a small multiple of it: at 21 days a three-week-old observation counts half
//   and a six-week-old one a quarter, which is slow enough that an evening of bad luck cannot
//   rewrite a cell and fast enough that a retune surfaces inside a month of play. A half-life of
//   days would make every card a mood ring; a half-life of months would not be worth the field.
//
//   FLOOR 0.15. History never vanishes. A creature you fought last spring and have not seen since
//   still knows something about itself, and a weight that decays to zero would silently delete the
//   whole shipped baseline the moment a user played for a month — which is not the same statement as
//   "your own log outweighs it" and is not one anybody asked for. The floor is the standing minimum
//   an observation is worth however old it is, and it composes with (multiplies) the baseline
//   down-weighting rather than replacing it.
//
// ── AGE IS MEASURED FROM THE NEWEST OBSERVATION, NOT FROM THE WALL CLOCK ───────────────────────
//
// A paused log must not decay itself. If age were `Date.now() - observedAt`, a player who stops for
// three months would come back to five cards of floored weights and doubled intervals having
// learned nothing new — the app would have forgotten what it knew because nobody was looking. So
// the reference is the newest observation the LEDGER holds: while you play it advances with you,
// and while you do not it stands still. Decay is therefore a statement about the ORDER of your own
// evidence, which is the thing a retune actually changes.
//
// ── AND IT IS BUCKETED BY WEEK ─────────────────────────────────────────────────────────────────
//
// The unit is the ISO week, and it rides the ROW KEY (`ledger.ts rowKey`) rather than being read off
// a timestamp. Two reasons, and the first is structural: a row POOLS counts, so a row that spans
// March and today has no age at all and no honest weight to give — splitting the key by week is what
// gives every count an age. The second is size: a day bucket would multiply the ledger by seven for
// a resolution three weeks of half-life cannot use.
//
// Both ends of the subtraction are snapped to their week's Monday, so an observation made this week
// weighs exactly 1 whatever hour it was made at, and the answer moves in whole weeks.

/** Milliseconds in a day and in a week. Spelled once. */
const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

/**
 * 1970-01-01 was a THURSDAY, so the Monday that opens epoch week zero is three days earlier. This
 * offset is the whole of the ISO week arithmetic below; everything else is division.
 */
const EPOCH_MONDAY = -3 * DAY_MS

/** Half the weight at three weeks. See the header for why weeks and why three of them. */
export const RESIST_HALF_LIFE_DAYS = 21

/** The least an observation is ever worth, however old. History fades; it does not vanish. */
export const RESIST_WEIGHT_FLOOR = 0.15

/** Monday 00:00 UTC of the week containing `ts`. */
export function weekStart(ts: number): number {
  return Math.floor((ts - EPOCH_MONDAY) / WEEK_MS) * WEEK_MS + EPOCH_MONDAY
}

/**
 * The ISO-8601 week the instant falls in, as `2026-W33`.
 *
 * ISO'S OWN RULE, not a naive year-plus-week: the week belongs to the year containing its THURSDAY,
 * which is why the last days of December can read `2027-W01`. Spelled out because the string is a
 * ledger KEY — it is written to disk and compared for equality across builds — and a week numbering
 * that drifted between two readings would silently re-pool a cell.
 */
export function isoWeekKey(ts: number): string {
  const monday = weekStart(ts)
  if (monday === memoMonday) return memoKey
  const thursday = new Date(monday + 3 * DAY_MS)
  const year = thursday.getUTCFullYear()
  const week = Math.round((monday - weekStart(Date.UTC(year, 0, 4))) / WEEK_MS) + 1
  memoMonday = monday
  memoKey = `${String(year)}-W${week < 10 ? '0' : ''}${String(week)}`
  return memoKey
}

/**
 * ONE ENTRY OF MEMO, AND IT IS MEASURED (JOS-397). The fold calls this on EVERY observation and a
 * log's lines arrive in order, so consecutive calls answer the same week for hours at a time — the
 * uncached version allocated a `Date` and read a calendar per row. It costs nothing in correctness:
 * the function is total and referentially transparent, so a cache of its last answer is the answer.
 * MEASURED on the owner's 2.08M-line log (`npm run bench:replay`): the resist module costs
 * 1.01 us/event with this off and 0.99 with it on, against 0.94 before this ticket existed — so the
 * memo is most of the week key's own cost, and what is left is the recent-outcome ring's writes.
 */
let memoMonday = Number.NaN
let memoKey = ''

/** The Monday an `isoWeekKey` names, or null when the string is not one. */
export function weekStartOfKey(key: string): number | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(key)
  if (!m) return null
  const week = Number(m[2])
  if (week < 1 || week > 53) return null
  return weekStart(Date.UTC(Number(m[1]), 0, 4)) + (week - 1) * WEEK_MS
}

/** How many whole days separate two week keys. Negative gaps answer 0 - nothing ages backwards. */
export function weekAgeDays(week: string, newest: string): number {
  const a = weekStartOfKey(week)
  const b = weekStartOfKey(newest)
  if (a === null || b === null) return 0
  return Math.max(0, (b - a) / DAY_MS)
}

/**
 * What one observation from `week` is worth when the newest thing the ledger has seen is `newest`.
 *
 * `w = max(FLOOR, 0.5 ^ (ageDays / HALF_LIFE))`. An unparseable or missing week answers 1: a row
 * whose age nothing states is not evidence to discount, it is evidence with no date on it, and
 * silently flooring it would be a migration bug wearing a statistics costume.
 */
export function decayWeight(week: string | undefined, newest: string | undefined): number {
  if (week === undefined || newest === undefined) return 1
  const w = Math.pow(0.5, weekAgeDays(week, newest) / RESIST_HALF_LIFE_DAYS)
  return w < RESIST_WEIGHT_FLOOR ? RESIST_WEIGHT_FLOOR : w
}

/**
 * The later of two week keys.
 *
 * A STRING COMPARE, and it is exact rather than approximate: `YYYY-Www` is zero-padded and
 * fixed-width, so its lexicographic order IS its chronological order, ISO's year-boundary rule
 * included (`2027-W01` sorts after `2026-W52`, which is what it is). That matters because this runs
 * on every row of the ledger — parsing each one back into an instant to compare it would be a date
 * library's worth of work to re-derive an ordering the format already carries.
 */
export function laterWeek(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return a >= b ? a : b
}

/** The newest week among some rows, or undefined when none of them carries one. */
export function newestWeekOf(rows: readonly { week?: string }[]): string | undefined {
  let best: string | undefined
  for (const row of rows) best = laterWeek(best, row.week)
  return best
}
