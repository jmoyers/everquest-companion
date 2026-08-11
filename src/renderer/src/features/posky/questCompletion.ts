// ============================================================================
// questCompletion.ts — what "completed" means on the Sky tab, now that it is two things.
// ============================================================================
//
// A pure module with no React and no data bundle, so the decisions below are pinned by a plain
// node test (tests/questTurnIns.test.mts) rather than only by a browser. JOS-147 added a third
// export, `readyQuests` — the Ready tab's whole membership rule — for the same reason: it is one
// predicate and an order, and it belongs where the predicate is argued. JOS-155 added the fourth,
// `firstTimeReady`, which is that set with the quests you have already run taken out.
//
// JOS-145 SETTLED THE ARGUMENT BY SHIPPING BOTH READINGS AS TWO SEPARATE BOXES. JOS-131 (below)
// chose has-every-item-now for the one box that existed, and the reasoning still holds for THAT
// box — but the owner wants the other meaning available too, because a player farming each quest
// once wants the done ones gone even though the app now knows they are refarmable. So there are
// two predicates here and two independent toggles above them, never a tri-state or a dropdown:
// they answer different questions ("what is left to gather" vs "what have I not run yet"), a
// player can want either, both, or neither, and AND-ing two checkboxes is the only combination
// rule that needs no explaining. Neither predicate reads the other's input, which is what makes
// "both ticked" mean exactly what it looks like.
//
// WHAT "HIDE COMPLETED" HIDES, DECIDED (JOS-131): a quest you are HOLDING EVERY ITEM FOR right
// now — NOT a quest you have ever turned in.
//
// The question only exists because a turn-in stopped being terminal. Before JOS-131 the two
// readings were the same state: turning a quest in pinned it at 5/5 forever, so "done" and "has
// every item" could not disagree. Now a turn-in SUBTRACTS what it consumed, the quest drops back
// to 0/5, and the two readings disagree about exactly the quest this ticket exists for.
//
// WHY THIS READING WINS.
//   * The box means "show me what is left to farm", and a quest you just handed in IS work left:
//     every item it needed is gone from your bags. Hiding it by has-ever-turned-in would make the
//     refarm invisible — the very bug JOS-131 removes, re-introduced one filter later — and would
//     also hide a quest you are 4/5 of the way through re-running.
//   * A quest with every item in hand genuinely has nothing left to grind for. Whether you have
//     walked it to the giver yet is a two-minute errand, not a place in the grind.
//   * "I never want to see this quest again" already has a dedicated, permanent, per-quest and
//     reversible affordance: the Ignored tab. A filter trying to be that as well would only be a
//     worse version of it.
//
// A quest that requires NOTHING is never "has every item": zero required items is missing data
// about a quest, not a finished one (law 1), and `hideNoItems` is the toggle that speaks to those.
//
// THE PERSISTENCE IS UNTOUCHED (JOS-90's conventions): same `eq.posky.hideCompleted` key, same
// '1'/'0' one-bit idiom, an absent key still means the DEFAULT rather than `false`, the box and
// the pref are still one thing (so `revealQuest`'s un-tick still persists), and it is still not
// whitelisted for share bundles. A user who had it ticked keeps it ticked and gets the new
// reading, which is the same promise they ticked it for. JOS-145's second box takes the same
// deal under its own key (`eq.posky.hideTurnedIn`) rather than sharing one, so a user who wants
// one reading is never handed the other by an upgrade.

import type { QuestProgress } from './useProgress'
import { sortQuests } from './questSort'

/** The part of a quest's progress this rule reads. Structural, so a test needs no whole quest. */
export interface CompletableQuest {
  /** total items required, summed over the required counts */
  needCount: number
  /** the required items not fully held right now */
  missing: readonly string[]
}

/** Are you holding everything this quest asks for, right now? */
export function hasEveryItem(q: CompletableQuest): boolean {
  return q.needCount > 0 && q.missing.length === 0
}

/** The part of a quest's progress the turn-in rule reads — the JOS-131 ledger's count, nothing else. */
export interface TurnedInQuest {
  /** how many times this quest has been handed in; 0 is never (useProgress.QuestProgress.turnIns) */
  turnIns: number
}

/**
 * Have you EVER handed this quest in? (JOS-145.)
 *
 * The count, not the holdings: this is the reading `hasEveryItem` deliberately is not. It stays
 * true for a quest you are refarming — that is the entire point, because the player this box is
 * for runs each quest once and wants the finished ones off the screen whether or not the app
 * thinks they could go again. A count of 2 is no more turned-in than a count of 1, so the
 * threshold is >= 1 and there is no "hide only the ones I did twice"; nobody asked for a dial.
 *
 * Zero required items is irrelevant here, unlike above: a turn-in is an EVENT that was observed
 * (or stated), so it is a fact about the player rather than an inference from the item data, and
 * a quest with a turn-in on it has been run no matter what the scrape knows about its items.
 */
export function everTurnedIn(q: TurnedInQuest): boolean {
  return q.turnIns >= 1
}

/**
 * THE READY SET (JOS-147) — every quest you are holding every required item for, right now.
 *
 * MEMBERSHIP IS THE PREDICATE, and nothing else. This is `hasEveryItem` over the quests the tab
 * can see, so the set moves with your bags and with nothing else: looting the last item a quest
 * needs ADDS it, a turn-in spends those items and REMOVES it (JOS-131 made a turn-in subtract
 * rather than pin), and refarming the set brings it straight back. There is deliberately no
 * "I marked this one ready" state to drift out of sync with the ledger, and no dismiss button:
 * the only way off this list is to stop holding the items, which is what handing them in does.
 *
 * IT IGNORES THE TWO HIDE-BOXES, and that is not an oversight. "Hide completed" hides EXACTLY
 * `hasEveryItem` (see above) — the same predicate this list is made of — so honouring it would
 * empty the list every time the box is ticked, which is a control that can only break the
 * feature. "Hide turned in" would drop a quest you have run before and have just refarmed to
 * full, which is the single most likely row here on a Sky farmer's screen. Both boxes narrow
 * "what is left to work on"; this list answers "what can I hand in", and the boxes are not drawn
 * on the tab at all (like Ignored, it has no filter bar), so there is no visible control whose
 * state is being disregarded.
 *
 * The ORDER is class then name — the same stable order the Ignored tab uses, via the shared
 * comparator. It is not sorted into a walking route: `where` on a required item is where that
 * item DROPS, not where the quest's giver stands, so this tab has no route to sort by and one
 * would have to be invented (law 1).
 *
 * The caller passes the quests the user can see — i.e. NOT the ignored ones. A quest the user
 * permanently hid must not come back through a side door; the Ignored tab is where that is undone.
 */
export function readyQuests(quests: readonly QuestProgress[]): QuestProgress[] {
  return sortQuests(quests.filter(hasEveryItem), 'class')
}

/**
 * THE FIRST-TIME READING OF THAT SET (JOS-155) — the ready quests you have NEVER handed in.
 *
 * The owner's ask, 2026-08-09: the default walk-the-islands list is first-time turn-ins, and the
 * refarms you have already completed are what you untick to see. So this is a SECOND narrowing
 * applied on top of `readyQuests`, not a rewrite of its membership: the set above stays exactly
 * `hasEveryItem`, and this is `everTurnedIn` removed from it. Composing rather than parameterising
 * keeps each predicate answering one question, the same way the two hide-boxes do.
 *
 * IT IS NOT THE QUESTS TAB'S "hide turned in" BOX WEARING A NEW HAT. That box reads the same
 * predicate, but it is a different control over a different list under a different stored key, and
 * the Ready tab still ignores it (`readyQuests` above says why at length). What changed is that
 * this tab now draws a toggle of its OWN, which is the only thing that can narrow it.
 *
 * The order is inherited: this filters an already-ordered list, so class-then-name survives.
 */
export function firstTimeReady(quests: readonly QuestProgress[]): QuestProgress[] {
  return quests.filter((q) => !everTurnedIn(q))
}
