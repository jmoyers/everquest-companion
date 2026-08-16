// ============================================================================
// rewardInference.ts — the reward item in your inventory export IS evidence (issue #27).
// ============================================================================
//
// THE REPORT: a fresh install loads an inventory export that plainly contains a Sky quest's
// reward, and the quest still reads "not turned in". Nothing was broken — nothing ever consulted
// the reward. The ledger (shared/questTurnIns.ts) has three sources: log-detected trades, hand
// statements, and the legacy `completedQuests` key. A turn-in done before logging was on leaves
// none of those, and rotating a log un-completes history the same way.
//
// WHY POSSESSION IS PROOF, measured against the committed data (2026-08-16): all 95 Sky quests
// have a reward, every reward is UNIQUE to its quest, none appears as a drop anywhere in the
// items DB, none is consumed as another Sky quest's required item, and 92 of the 94 in the DB
// are NO DROP. The rewards cannot be obtained without doing the quest, so holding one proves at
// least one turn-in as surely as a log line would.
//
// WHAT THE INFERENCE IS — a DERIVED floor of one, in the classUnlocks.ts mold (observed wins,
// derived is labelled) and on the legacy `completedQuests` precedent (a completion that is real
// but undated floors the count at 1 and says nothing else):
//   * applied AFTER `computeQuestProgress`, never written to the ledger. Consumption never sees
//     it (an inferred turn-in predates the log, so its items were never in the log counts and it
//     owes no subtraction — the "a dump owes none" rule, reconcile.ts), the celebration baseline
//     never sees it (no false toast on first load), and nothing is persisted (the export is
//     re-read every time, so the reading can never go stale in a store);
//   * LABELLED (`rewardInferred`), and only present when it is the count's ONLY source — any
//     ledger evidence wins and leaves the row exactly as the ledger said it;
//   * ONE-DIRECTIONAL. Reward present ⇒ turned in; reward ABSENT proves nothing, because the
//     export only covers what was open when it was written (a banked reward is invisible — the
//     owner's own store has two turned-in quests whose rewards the export never saw). Nothing
//     here un-completes anything, which is the promise "a dump adds, it never subtracts"
//     already makes about counts.
//
// The match is on the COUNTING key (`itemCountKey`: lowercased, ` +N` folded), because the
// export's keys are raw names lowercased (heldCountsFromDump) and a reward the player has
// exalted to `+2` is still the quest's reward.

import type { PoskyQuest } from '@shared/types'
import { itemCountKey } from '../../lib/itemName'
import { questKey } from './keys'
import type { QuestProgress } from './useProgress'

/**
 * Which quests the loaded export vouches for: every quest whose reward item the inventory holds.
 *
 * `inventory` is `ProgressState.inventory` as stored — raw names lowercased, `+N` variants NOT
 * yet folded — so the fold happens here, on both sides of the match. A count of zero or less is
 * an absent item: the parser never writes one, so it can only mean a hand-edited store, and an
 * item you hold none of vouches for nothing.
 */
export function rewardInferredQuests(
  quests: readonly Pick<PoskyQuest, 'className' | 'name' | 'reward'>[],
  inventory: Record<string, number> | undefined
): Set<string> {
  const vouched = new Set<string>()
  if (!inventory) return vouched
  const held = new Set<string>()
  for (const [name, count] of Object.entries(inventory)) {
    if (count > 0) held.add(itemCountKey(name))
  }
  for (const q of quests) {
    // A quest with no reward in the data never infers: that is missing data about a quest, not
    // a finished one (the `hasEveryItem` refusal, law 1).
    if (q.reward !== undefined && held.has(itemCountKey(q.reward))) vouched.add(questKey(q))
  }
  return vouched
}

/**
 * The floor: a vouched-for quest with NO other evidence reads turnIns 1 / completed, labelled.
 *
 * Applied per row after `computeQuestProgress`, the way `firstTimeReady` narrows `readyQuests` —
 * a composition, not a rewrite — so every downstream reading of `turnIns` (`everTurnedIn`, the
 * hide-turned-in box, the class-unlock derivation, the Ready tab's first-time default) agrees
 * without consulting a second field. `logTurnIns` stays 0: the log's share is a fact about the
 * log, and this is not log evidence.
 */
export function withRewardInference(
  q: QuestProgress,
  vouched: ReadonlySet<string>
): QuestProgress {
  if (q.turnIns > 0 || !vouched.has(q.key)) return q
  return { ...q, turnIns: 1, completed: true, rewardInferred: true }
}
