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
// are NO DROP or No Trade. For THOSE, holding the reward proves at least one turn-in as surely
// as a log line would - an item that cannot move has exactly one way into a bag.
//
// THE TWO THAT CAN MOVE PROVE NOTHING, and the gate below is that sentence as code. Bloody
// Griffon-Hide Wrist Guard and Sphinx Heart Amulet (both Necromancer rewards) carry no
// NO DROP / No Trade flag: they can be bought or handed over, so possession is not evidence and
// inferring from it would mark a quest done that never ran - with the undo control honestly
// disabled, leaving no way to say otherwise. So the inference fires only when the reward's own
// stat blob states it cannot be traded, in either spelling the scrape uses ("NO DROP" on the
// classic pages, "Lore Equipped, No Trade" on the newer ones). Those two quests simply never
// infer, which is the status quo they had before this module existed.
//
// WHAT THE INFERENCE IS — a DERIVED floor of one, in the classUnlocks.ts mold (observed wins,
// derived is labelled) and on the legacy `completedQuests` precedent (a completion that is real
// but undated floors the count at 1 and says nothing else):
//   * applied AFTER `computeQuestProgress`, never written to the ledger. Consumption never sees
//     it (an inferred turn-in predates the log, so its items were never in the log counts and it
//     owes no subtraction — the "a dump owes none" rule, reconcile.ts), the celebration baseline
//     never sees it (no false toast on first load), and nothing is persisted (the export is
//     re-read every time, so the reading can never go stale in a store);
//   * LABELLED, and only present when it is the count's ONLY source — any ledger evidence wins
//     and leaves the row exactly as the ledger said it;
//   * ONE-DIRECTIONAL. Reward present ⇒ turned in; reward ABSENT proves nothing, because the
//     export only covers what was open when it was written (a banked reward is invisible — the
//     owner's own store has two turned-in quests whose rewards the export never saw). Nothing
//     here un-completes anything, which is the promise "a dump adds, it never subtracts"
//     already makes about counts.
//
// The match is on the COUNTING key (`itemCountKey`: lowercased, ` +N` folded), because the
// export's keys are raw names lowercased (heldCountsFromDump) and a reward the player has
// exalted to `+2` is still the quest's reward.
//
// SINCE JOS-429 THIS IS THE SECOND-RANKED DERIVED SOURCE, not the only one. The achievements dump
// (achievementInference.ts) is the SERVER'S OWN ANSWER about the same question and outranks this
// inference wherever both speak; the ladder and the argument for that order live in
// shared/questTurnIns.ts, and `withDerivedCompletion` (questCompletion.ts) is what applies it.
// Nothing about the set this module produces changed — only that it is now handed to a resolver
// instead of being applied directly.

import type { PoskyQuest } from '@shared/types'
import { itemCountKey } from '../../lib/itemName'
import { questKey } from './keys'

/**
 * Does the reward's own stat blob say it cannot be traded? Both spellings the scrape carries:
 * "NO DROP" (the classic wiki pages) and "No Trade" (the newer ones, sometimes "LORE ITEM NO
 * TRADE"). An ABSENT or silent blob reads as tradeable - the conservative side of the gate,
 * because the failure modes are asymmetric: not inferring costs a badge the user can still
 * record by hand, while inferring falsely marks a quest done with the undo honestly disabled.
 */
function isUntradeable(rewardStats: string | undefined): boolean {
  return /no[ -]?(drop|trade)/i.test(rewardStats ?? '')
}

/**
 * Which quests the loaded export vouches for: every quest whose UNTRADEABLE reward item the
 * inventory holds (the header's gate - a reward that can move proves nothing).
 *
 * `inventory` is `ProgressState.inventory` as stored — raw names lowercased, `+N` variants NOT
 * yet folded — so the fold happens here, on both sides of the match. A count of zero or less is
 * an absent item: the parser never writes one, so it can only mean a hand-edited store, and an
 * item you hold none of vouches for nothing.
 */
export function rewardInferredQuests(
  quests: readonly Pick<PoskyQuest, 'className' | 'name' | 'reward' | 'rewardStats'>[],
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
    // a finished one (the `hasEveryItem` refusal, law 1). A tradeable reward never infers either
    // (the header's gate).
    if (q.reward === undefined || !isUntradeable(q.rewardStats)) continue
    if (held.has(itemCountKey(q.reward))) vouched.add(questKey(q))
  }
  return vouched
}
