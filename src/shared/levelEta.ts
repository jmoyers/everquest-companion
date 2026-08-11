// levelEta.ts — WHEN YOU WILL LEVEL, or the reason nobody can say (JOS-195 moved it here).
//
// It was written for the Overview card (`features/overview/overviewLevelingData.ts`) and lived
// there for as long as that card was the only surface asking. The XP OVERLAY asks the same
// question from a different window — a second renderer entry that must not pull the overview's
// view model (and its zone colours, its sparkline, its date formatting) into a bundle whose whole
// contract is to be cheap to paint over the game. So the DERIVATION moved and the WORDING did not:
// this file computes, `overviewLevelingData` re-exports it unchanged for its existing callers and
// keeps every sentence it prints, and `overlay/xpRows.ts` writes its own three-word version.
//
// ONE DERIVATION, NEVER A SECOND (the windowScope.ts rule, applied across windows). A copy of the
// four gates below in the overlay would be a second answer to "how far into the bar am I", and the
// two would drift the first time one of them learned something.
//
// Pure: no React, no Electron, no clock read — same snapshot + same stats ⇒ same answer, so
// tests/overviewLeveling.test.mts drives it under plain node exactly as it always has.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE PROJECTION (owner request: "predict next level timing at the same level of activity")
//
//   The log NEVER states where you are in the level bar. It states a percentage PER GAIN, and
//   nothing else — no total, no remainder, no bar position. So the only way to know how far into
//   the current bar you are is to add up every stated percentage SINCE THE LAST DING, and that sum
//   is trustworthy only when nothing is missing from it. Four things can make it untrustworthy,
//   and each one KILLS the estimate rather than degrading it (law 1: anything inferred is labeled,
//   and a projection built on a guessed bar position is not labelable — it is just wrong):
//
//     • no ding has been observed at all ⇒ there is no anchor to sum from;
//     • an at-cap line (no percentage stated) landed since the ding ⇒ a hole in the sum;
//     • the retention floor has risen past the ding ⇒ dropped samples, a hole in the sum;
//     • the range states no pace at all ⇒ nothing to project with.
//
//   A fifth gate is about the WINDOW rather than the sum: a range that was mostly a logout has too
//   little play left in it to project an hour's pace from (`ETA_MIN_ONLINE_MS`).
//
//   With all of them clear the estimate is `remaining fraction / the range's ONLINE WALL rate`.
//   WALL, not active: the user asked when they will level, and they will experience that in wall
//   time, including the same proportion of medding and looting the range already contained. The
//   ACTIVE rate GATES it (that is the honest "were you actually playing" signal) and the WALL rate
//   DIVIDES. The `~` every surface prints is real: this is a projection forward, never a countdown
//   to a known instant.

import type { ProgressionSnap } from './progressionTypes'
import type { RangeStats } from './progressionStats'

const MS_PER_HOUR = 3_600_000

/** Beyond this the estimate is stated as a horizon, not a duration. */
export const ETA_ABSURD_MS = 24 * MS_PER_HOUR

/**
 * How much of the range must be ONLINE for a projection to be offered at all.
 *
 * A window is a stretch of LOG time, and a logout can eat almost all of it: log in at 12:55 after
 * an overnight and 55 of the last 60 minutes are an empty chair. The pace measured over the
 * surviving five minutes is a real rate — it is just not an hour of evidence, and extrapolating it
 * to "~1h 40m to level 44" dresses a sample of five minutes as a prediction. A QUARTER of the
 * Overview card's hour is the floor: enough play to have a shape, and low enough that an ordinary
 * session that began mid-window still gets its estimate.
 *
 * The gate fires ONLY when an offline interval was actually derived, so a range with no logout in
 * it — which is every range this app saw before offline existed — reaches the same verdict it
 * always did.
 */
export const ETA_MIN_ONLINE_MS = 15 * 60_000

/** WHY there is no estimate. Each one is a hole in the evidence, and each is shown on hover. */
export type EtaBlocked = 'no-ding' | 'unstated' | 'clipped' | 'overfull' | 'offline' | 'no-pace'

/**
 * The reason there is no estimate — one clause per `EtaBlocked` (AGENTS.md tooltip diet).
 *
 * It sits with the DERIVATION rather than with either surface, because it describes the hole in
 * the evidence and not the card or the window that ran into it. Two surfaces refusing the same
 * projection for the same reason must say the same sentence.
 */
export const ETA_BLOCKED_TITLE: Record<EtaBlocked, string> = {
  'no-ding': 'No level-up has been recorded yet, so your place in the bar is unknown.',
  unstated: 'Experience lines since your last level-up stated no percentage - unknown, not zero.',
  clipped: 'The retained record no longer reaches back to your last level-up.',
  overfull: 'The percentages since your last level-up already exceed a full level.',
  offline: 'Most of this stretch is time you were logged out.',
  'no-pace': 'This stretch states no levels of progress.'
}

/**
 * Either a projection or the reason there isn't one. A UNION rather than a bag of nullables so the
 * renderer cannot read `ms` without having proven `blocked === null` first. `offlineMs` is carried
 * so a tooltip can state the logged-out assumption ONLY when there was one.
 */
export type LevelEta =
  | { blocked: EtaBlocked }
  | { blocked: null; ms: number; toLevel: number; progress: number; offlineMs: number }

/**
 * The CURRENT level as the log last reported it — the tail of `levelValue`, never `max()`.
 * You level three classes at once and a loadout swap re-reports the level of the new (lowest)
 * class with no line of its own, so the latest value is the only honest "your level" (the same
 * rule `latestLevel` follows in the Leveling tab). Null when the snapshot holds no ding: a surface
 * omits the chip rather than guessing one.
 */
export function currentLevel(snap: ProgressionSnap): number | null {
  const n = snap.levelValue.length
  return n > 0 ? snap.levelValue[n - 1] : null
}

/**
 * True when the range gained experience but the log stated no percentage for ANY of it — the
 * AT-CAP shape. Every levels-based number is null here, and it is the moment a character starts
 * caring about AA instead (shared/aaPace.ts). Exported because two surfaces now switch what they
 * are talking about on exactly this test, and a second spelling of it would let them disagree.
 */
export function atCap(stats: RangeStats): boolean {
  return stats.expSamples > 0 && stats.expSamples === stats.expUnstated
}

/**
 * Σ stated level-bar percentage for the samples STRICTLY AFTER `dingTs`, plus how many samples in
 * that span stated none.
 *
 * Strictly after, on purpose: EQ timestamps are whole seconds, so the experience line that pushed
 * you over sits in the SAME second as "You have gained a level!". Counting it would credit the
 * previous bar's last gain to the new bar. The carry-over it represents is not in the log either
 * way, so the estimate is deliberately the conservative one.
 *
 * Walks backwards from the tail: the span since the last ding is small, and the columns are
 * ascending, so this stops the moment it passes the anchor.
 */
function statedSinceDing(snap: ProgressionSnap, dingTs: number): { equiv: number; unstated: number } {
  let equiv = 0
  let unstated = 0
  for (let i = snap.expTs.length - 1; i >= 0 && snap.expTs[i] > dingTs; i--) {
    if ((snap.expFlag[i] & 1) !== 0) unstated++
    else equiv += snap.expPct[i] / 100
  }
  return { equiv, unstated }
}

/**
 * True when the range has too little ONLINE play left in it to project a pace from. Guarded on
 * `offlineMs > 0` so a range the log never said anything about is never gated.
 */
function tooOffline(stats: RangeStats): boolean {
  return stats.offlineMs > 0 && stats.durationMs - stats.offlineMs < ETA_MIN_ONLINE_MS
}

/**
 * The next-level estimate, or the reason there is none. `stats` is the range's own `rangeStats` —
 * the SAME object the surface's headline rate came from, so the number on screen and the number
 * the projection used can never diverge.
 */
export function levelEta(snap: ProgressionSnap, stats: RangeStats): LevelEta {
  const n = snap.levelTs.length
  if (n === 0) return { blocked: 'no-ding' }
  const dingTs = snap.levelTs[n - 1]
  // The retention floor rose past the anchor ⇒ samples between the ding and the floor are gone
  // and the sum below would silently under-count. (`levelTs` itself is uncapped; `expTs` is not.)
  if (snap.windowStart > 0 && dingTs < snap.windowStart) return { blocked: 'clipped' }
  const { equiv, unstated } = statedSinceDing(snap, dingTs)
  if (unstated > 0) return { blocked: 'unstated' }
  // More than a full bar's worth stated with no ding to show for it: the model and the log
  // disagree, and the honest answer to "where am I in the bar" is that we do not know.
  if (equiv >= 1) return { blocked: 'overfull' }
  // Most of the range was an empty chair: what is left is a rate, not an hour of evidence.
  if (tooOffline(stats)) return { blocked: 'offline' }
  // The ACTIVE rate is the gate (null ⇒ no active time, or at cap); the ONLINE WALL rate
  // divides — see `RangeStats.levelsPerHourWall`, whose denominator excludes the logout.
  if (stats.levelsPerHourActive == null) return { blocked: 'no-pace' }
  const pace = stats.levelsPerHourWall
  if (pace == null || pace <= 0) return { blocked: 'no-pace' }
  return {
    blocked: null,
    ms: ((1 - equiv) / pace) * MS_PER_HOUR,
    toLevel: snap.levelValue[n - 1] + 1,
    progress: equiv,
    offlineMs: stats.offlineMs
  }
}
