// planner/gearPlanStatPick.ts — "show me boots with more WISDOM than the ones I have on".
//
// THE QUESTION THE ITEM PICKER COULD NOT ANSWER. Search is by NAME, which is the right default and
// the wrong tool for the only question that matters once you know what you want: not "what is this
// item called" but "does it beat what I am wearing, on the stats I care about". You cannot type
// that. The delta line already computes the answer per row — this makes it something you can ASK.
//
// TWO SEPARATE THINGS, and keeping them separate is the design:
//   * PICKING stats ORDERS the list. Pick WIS and the highest-wisdom candidates come first.
//   * The `beatsWorn` toggle FILTERS it, against the item worn in that cell.
// A pick alone changes nothing about which rows exist, so it is safe to explore with; the toggle is
// the destructive one and is its own deliberate act.
//
// EVERY PICKED STAT MUST BE BEATEN — AND, never OR. Pick WIS and INT on gloves that give +5 WIS and
// +10 INT, and only gloves better on BOTH survive. That is the strict reading and it is the useful
// one: a replacement that wins on one axis and loses on the other is exactly the trade the delta
// line is for, and folding it into "matches" would make the filter mean nothing in particular.
//
// "BETTER" IS NOT ALWAYS "MORE", which is why this file owns `LOWER_IS_BETTER` rather than testing
// `>` and hoping. `DELAY` and `WEIGHT` are better smaller — a filter that hid every faster weapon
// because 20 is not more than 26 would be confidently backwards. `gearPlanTotals.isImprovement`
// reads the same set, so the filter and the coloured delta line cannot disagree about which
// direction is up.
//
// ABSENT IS ZERO ON BOTH SIDES, the same rule the rest of the board's arithmetic runs on: an item
// page lists what the item gives, so a page without `STR` is an item without STR. The consequence
// worth stating is that with nothing worn in the cell (no dump, or an empty slot) the baseline is
// zero, so `beatsWorn` degrades to "states this stat at all" — still a useful question, and a
// different one from what the toggle usually asks. The surface says which of the two it is doing.

import { GEAR_STAT_KEYS, type GearStatKey, type GearStats } from './gear'

/**
 * THE TWO STATS A SMALLER NUMBER IS BETTER ON.
 *
 * `DELAY` is the time between swings, so less of it is more attacks; `WEIGHT` is what you carry
 * against your encumbrance limit, so less of it is more of everything else. Every other key is a
 * quantity you want more of, the saves included — the corpus states those as resistances, not as
 * the damage taken.
 */
const LOWER_IS_BETTER: ReadonlySet<GearStatKey> = new Set<GearStatKey>(['DELAY', 'WEIGHT'])

/** Is this stat one where a smaller number is the better one? */
export function betterIsLess(key: GearStatKey): boolean {
  return LOWER_IS_BETTER.has(key)
}

/**
 * The stats worth offering as a filter, in the board's own reading order.
 *
 * ALL OF THEM, including the structural ones. `DMG` and `DELAY` are exactly what someone shopping
 * for a weapon wants to narrow on, and excluding them because they are not summable would be
 * confusing a rule about TOTALS with a rule about comparison. `betterIsLess` is what makes them
 * safe to include.
 */
export const STAT_PICK_OPTIONS: readonly GearStatKey[] = GEAR_STAT_KEYS

/** One stat, strictly better on the candidate than on the baseline. Absent is zero on both sides. */
export function beatsOne(key: GearStatKey, mine: GearStats, worn: GearStats | null): boolean {
  const a = mine[key] ?? 0
  const b = worn?.[key] ?? 0
  return betterIsLess(key) ? a < b : a > b
}

/**
 * Does this candidate beat the baseline on EVERY picked stat?
 *
 * An empty pick passes everything — no filter is not a filter that rejects. The caller is expected
 * to skip this entirely when nothing is picked; this is the belt to that braces.
 */
export function beatsWornOn(
  keys: readonly GearStatKey[],
  mine: GearStats,
  worn: GearStats | null
): boolean {
  return keys.every((key) => beatsOne(key, mine, worn))
}

/**
 * HOW HIGH THIS CANDIDATE RANKS on the picked stats — bigger sorts first.
 *
 * A PLAIN SUM, AND ITS LIMITS ARE REAL. Adding WIS to DMG adds two things measured in nothing
 * comparable, and with several picks the largest-numbered stat dominates the order. It is chosen
 * anyway, because every alternative is worse for the job: normalising per stat would rank an item
 * top for being unusually good at a stat you picked second, and a strict per-key lexicographic sort
 * would make the second pick decorative. The user picked these stats and asked for more of them.
 *
 * The stats a smaller number is better on are SUBTRACTED, so "sort by DELAY" puts the fastest
 * weapon first rather than the slowest — the same direction `beatsOne` uses, from the same set.
 */
export function pickScore(keys: readonly GearStatKey[], stats: GearStats): number {
  return keys.reduce((sum, key) => {
    const v = stats[key] ?? 0
    return sum + (betterIsLess(key) ? -v : v)
  }, 0)
}
