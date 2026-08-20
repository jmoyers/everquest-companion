// WHAT "DEFEATED" MEANS, PER VIEW (JOS-237) — the pure half of the roster's toolbar filters,
// split out of BossView so the one predicate this ticket is about can be pinned by a node test
// instead of only by a running app.
//
// THE DEFECT, owner-reported 2026-08-12 while release-testing: "Defeated only" filtered on
// `s.killed` in BOTH modes. That flag is the ALL-TIME one — "a kill of this target is on the
// record, at some difficulty, at some point in the app's history" — so on the THIS WEEK view the
// switch answered a question the view is not asking. A boss cleared three weeks ago and not since
// stayed on screen with five grey rungs under it, which is precisely the card a raid coordinator
// turns the switch on to get RID of: the week view exists to say what this reset week has taken.
//
// THE RULE. The two modes are two readings of one roster (BossView's `Mode`), so they get two
// readings of "defeated" and nothing else moves:
//
//   OVERALL   → `everDefeated`      — ever, at any difficulty, however long ago. Unchanged.
//   THIS WEEK → `defeatedThisWeek`  — a credited kill inside the current lockout window.
//
// ONE CLOCK, AND IT IS `lockout.ts`'s. The week reading is `tierLocks(...).length > 0` over the
// SAME `LockoutWindow` the view already computes for the ladder and the chips (useLockoutWeek →
// lockoutWindow), so the filter can never disagree with the rungs it is filtering by: a card is
// kept exactly when at least one of its five rungs is green. There is no second boundary here,
// no `Date.now()`, and no day arithmetic of its own — the reset day/hour and their sourcing are
// lockout.ts's business alone (and the analytics day/week boundary rule is the owner's, so a
// surface must never quietly grow its own).
//
// TWO GRAINS, ONE PREDICATE. A `TargetStatus` is a fold over `tiers`, and the loadout sectioning
// projects a target onto a SUBSET of its runs (loadoutGroups.ts) — so the same test applied to a
// projected card answers "did the kills THIS CARD claims take a lockout this week", which is what
// keeps the switch honest once the class-loadout sectioning splits a target into several cards.
// That is why this is a predicate over a status rather than a filter over the roster array.

import type { TargetStatus } from './bossStatus'
import { tierLocks, type LockoutWindow } from './lockout'

/** What "defeated" means in one view — see the file header. */
export type DefeatedTest = (s: TargetStatus) => boolean

/**
 * OVERALL: the roster's historical reading, exactly as it has always been. A kill of this target
 * is on the record — no window, no difficulty, no credit test (the roster tracks what died; the
 * celebration seam is the one that asks whose kill it was).
 */
export const everDefeated: DefeatedTest = (s) => s.killed

/**
 * THIS WEEK: a credited kill of this target, at a real instance difficulty, inside `w`.
 *
 * It is `tierLocks` and nothing else, so every qualification that predicate carries comes along
 * for free and stays stated in ONE place: credited rather than merely witnessed, a difficulty
 * rather than an open-world or unknown-zone kill, and the half-open Pacific week `[start, next)`.
 * An empty lock set is "open this week", which is a different sentence from "never killed" — and
 * on this view it is the sentence the switch is there to hide.
 */
export function defeatedThisWeek(w: LockoutWindow): DefeatedTest {
  return (s) => tierLocks(s.tiers, w).length > 0
}

/** The toolbar's filters, as the view holds them. */
export interface RosterFilter {
  /** the search box, matched case-insensitively against the target name */
  query: string
  /** the "Defeated only" switch */
  defeatedOnly: boolean
  /** what that switch MEANS in the current view */
  defeated: DefeatedTest
  /**
   * Targets the user hid from this tab (issue #32) — LOWERCASED names, the `useQuestFlags`
   * casing armour (useHiddenTargets.ts owns the set). Optional so the two call shapes that
   * predate the flag stand unchanged; absent means nothing is hidden.
   */
  hidden?: ReadonlySet<string>
  /**
   * The "Hidden (n)" toolbar switch: a PEEK, not an un-hide. It stops the drop so the hidden
   * cards can render (dimmed, carrying the restore control) and consults nothing else.
   */
  showHidden?: boolean
}

/**
 * The roster the view draws: the hide flag, then the search box and the defeated switch, in that
 * order of narrowing. Hidden drops FIRST because it is an identity statement about the roster
 * ("this card is not my raid week") where the other two are momentary narrowings of it — a
 * hidden target that matches the search box is still gone.
 *
 * Returns the input array itself when no filter is on, so an untouched toolbar cannot churn
 * the memoised sectioning below it.
 */
export function filterRoster(list: TargetStatus[], f: RosterFilter): TargetStatus[] {
  const q = f.query.trim().toLowerCase()
  let out = list
  if (f.hidden?.size && !f.showHidden) out = out.filter((s) => !f.hidden?.has(s.target.name.toLowerCase()))
  if (f.defeatedOnly) out = out.filter(f.defeated)
  if (q) out = out.filter((s) => s.target.name.toLowerCase().includes(q))
  return out
}
