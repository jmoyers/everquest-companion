// ============================================================================
// achievementInference.ts — the achievements dump is the SERVER'S OWN ANSWER about your Sky quests
// (JOS-429).
// ============================================================================
//
// THE REPORTS, four wordings of one question: 01M0GH44G2F0EB1CH83RR7NT5Z ("There doesn't seem to be
// a way to import what Plane of Sky achievements I've already completed"), 01M00NET9PEG9MEB1J5BT7KBJQ
// ("sky quests -- process /outputfile achievements to close completed quests"),
// 01M0BF54C4159KG7S19QNBQ4VZ, and Fountsy on Reddit ("if i forgot to turn logs on and did a bunch of
// sky raids... how would I import that data?"). The ledger (shared/questTurnIns.ts) knows log-detected
// trades, hand statements and the legacy key — and a player who did Sky on another PC, or before
// installing, or with logging off, has none of them.
//
// WHY THIS IS THE STRONGEST EVIDENCE THIS APP HAS, and why it outranks the reward inference it
// composes with. classUnlocks.ts states the model: a turn-in is evidence of PROGRESS, the
// achievement line is evidence of the ANSWER. `/outputfile achievements` is that answer written to
// disk — the SERVER has already decided whether you obtained each Sky quest reward, and its `C`
// stays true after the item is destroyed, sold, or left in a bank the inventory export never opened.
// rewardInference.ts's floor is sound but it is still a conclusion drawn from a bag; this is not a
// conclusion at all. Hence `DERIVED_EVIDENCE_RANK` puts 'achievement' above 'reward'.
//
// AND WHY THAT PARAGRAPH IS NOW HALF THE STORY (JOS-441). It is true of a row under a class you
// UNLOCKED BY PLAYING, and false of the same row under a class whose unlock was GRANTED — confirming
// your primary class, or spending a Primary Class Unlock Token, cascades `C` into every component,
// so the server's answer is about the unlock and not about the quest. Three v1.7.0 reports in the
// hours after JOS-429 shipped said exactly that. The file itself discriminates the two (the pseudo-
// row flags — shared/outputs/achievements.ts's cascade section carries the measurement), the
// projection stamps each claim with its `grant`, and the join below sorts the rows into the two
// ladder rungs accordingly. Nothing is filtered away: the cascaded rows are still read, still
// stored, still shown — under the name of what they actually are.
//
// THE FILE HALF LIVES IN shared/outputs/achievements.ts and its header carries the measured format.
// This module is the JOIN, and it is here for the same reason `rewardInference.ts` is: the Sky quest
// set is the RENDERER's bundle, so main persists the flat claims (`ProgressState.achievementUnlocks`)
// and the renderer resolves them against posky.json on every read.
//
// ---------------------------------------------------------------------------
// THE JOIN: BY ITEM NAME, INSIDE THE CLASS THE ACHIEVEMENT NAMES.
// ---------------------------------------------------------------------------
// MEASURED against the committed fixture and the committed scrape: 95 `Obtain <Item>` rows, 95 Sky
// quests, per-class counts equal class for class, and 95 distinct `<class, reward>` keys — no
// collisions to break a tie over. `tests/achievementInference.test.mts` re-derives all of that, so
// it is a gate rather than a note.
//
// ORDER IS NEVER USED. Within a class the file lists its components in a different order from the
// wiki's quest table (Cleric: the file leads with Necklace of Resolution, the scrape with Truewind
// Earring), so an ordinal join would credit the wrong quest for eleven of the sixteen classes. That
// was measured before this code existed, and it is why the join is a name lookup.
//
// THE CLASS IS A CHECK, NOT A TIEBREAK. Every reward is unique to its quest already
// (rewardInference.ts measured that), so the class narrows nothing that the item name does not
// — it is in the key so that a future data change which DID introduce a shared reward name cannot
// silently credit the wrong class's quest. Folded on comparison because the file says
// `Shadowknight` where the scrape says `Shadow Knight`, and neither spelling is wrong.
//
// ---------------------------------------------------------------------------
// AND THREE ROWS WHERE THE GAME AND THE WIKI DISAGREE ABOUT A REWARD'S NAME.
// ---------------------------------------------------------------------------
// 92 of the 95 match outright ONCE THE EXISTING OVERLAYS ARE APPLIED — which is worth stating,
// because the achievements file independently CONFIRMED both of them: it spells Bard Test of Wind's
// reward `Amulet of the Fae` (JOS-428's correction, not the scrape's `Fae Amulet`) and Rogue Test of
// Stealth's `Shimmering Bracer of Protection` (JOS-415's rename, not `Scintillating`). Two overlays
// written from a reporter's bag and a wiki redirect, and the game agrees with both.
//
// The remaining three are in `ACHIEVEMENT_REWARD_ALIASES` below. They are NOT rows for
// `skyQuestRewards.ts` or `itemRenames.ts`, and the distinction is the point:
//   * `itemRenames.ts` is for an item the wiki RETITLED under us (the old page `#REDIRECT`s to the
//     new one). None of these three is that.
//   * `skyQuestRewards.ts` is for a quest page linking the WRONG ITEM, and it changes what the app
//     DISPLAYS and links — which needs a transcribed stat block and an owner's eye on the item card.
//   * This table changes NOTHING the user sees. It is one fact and one fact only: how the
//     achievements file words a reward this app already knows about. Confining it here keeps a
//     format's spelling quirks inside the reader of that format.
// If a re-scrape ever lands one of these upstream, the row stops matching anything and the audit
// test fails — the `SkyQuestReward.from` idempotence rule, restated for this table.

import type { ClassUnlockClaim, ClassUnlockGrant } from '@shared/outputs/achievements'
import type { PoskyQuest } from '@shared/types'
import { questKey } from './keys'

/** One reward the achievements file spells differently from the (corrected) scrape. */
export interface AchievementRewardAlias {
  /** The class as the SCRAPE spells it — the quest this row is about. */
  className: string
  /** The quest, for the reader and for the audit. */
  questName: string
  /** What the corrected scrape calls the reward TODAY, so a fixed re-scrape fails the audit. */
  reward: string
  /** What the achievements file's `Obtain` row says instead. */
  achievementItem: string
  /** ISO date the row was last checked against the evidence below. */
  verified: string
  /** What was checked and what it said, in one line. */
  evidence: string
}

export const ACHIEVEMENT_REWARD_ALIASES: readonly AchievementRewardAlias[] = [
  // The Bard row (`Harmonic Spear` → `Spear of Harmony`, verified 2026-08-20) RETIRED 2026-08-22:
  // the wiki fixed its own outlier reward cell, and the posky rescrape now says `Spear of Harmony`
  // everywhere — the audit test's own instruction is to delete a row the scrape has caught up to.
  {
    className: 'Beastlord',
    questName: 'Beastlord Test of Claw',
    reward: 'Windhowl',
    achievementItem: 'Windhowl and Spirit Render',
    verified: '2026-08-20',
    evidence:
      'The quest hands out a WEAPON PAIR and the achievement names both halves in one row. ' +
      'items.json carries `Windhowl` AND `Spirit Render` as separate pages, both eraTag Sky, both ' +
      'with questUses naming Beastlord Test of Claw; the scrape’s reward cell records only the ' +
      'first. This is the one row whose achievement text is not an item name at all, which is ' +
      'exactly why it cannot be a rename or a reward correction.'
  }
  // The Rogue row (`Griffon Wing Spauldors` → `Griffon Wing Spaulders`, verified 2026-08-20)
  // RETIRED 2026-08-22: the wiki retitled the item page to the game's spelling (the rescrape's
  // new-pages list carries `Griffon Wing Spaulders`), so scrape and achievements file now agree
  // and the row had stopped describing a mismatch.
]

/**
 * The comparison fold for a CLASS name. Case and spacing only — `Shadowknight` (the game) and
 * `Shadow Knight` (the wiki) are one class, and nothing else about a class name is dirty.
 */
const classFold = (name: string): string => name.toLowerCase().replace(/\s+/g, '')

/**
 * The comparison fold for an ITEM name. Case and internal whitespace, and NOTHING ELSE — no
 * apostrophe stripping, no punctuation folding.
 *
 * MEASURED, and the restraint is the finding: with apostrophes preserved, 92 of the 95 rows match
 * and the 95 keys are distinct. Every loosening beyond this would be a guess bought for nothing,
 * and world-model law 2's warning about canonicalizing names applies with force here — the whole
 * join is names, and a fold that collides two rewards would credit the wrong quest silently. The
 * ` +N` suffix is deliberately NOT stripped either: an achievement names the reward the quest
 * hands out, and the game never writes an exalted spelling into an `Obtain` row.
 */
const itemFold = (name: string): string => name.toLowerCase().replace(/\s+/g, ' ').trim()

/** The lookup key both sides are reduced to. */
const joinKey = (className: string, item: string): string =>
  `${classFold(className)}\u0000${itemFold(item)}`

/**
 * Every spelling of one quest's reward the achievements file might use: the reward itself, plus the
 * alias row when there is one. Exported for the audit test, which asserts the aliases still describe
 * the scrape they were written against.
 */
export function achievementItemsFor(className: string, reward: string): string[] {
  const out = [reward]
  for (const a of ACHIEVEMENT_REWARD_ALIASES) {
    if (classFold(a.className) === classFold(className) && itemFold(a.reward) === itemFold(reward)) {
      out.push(a.achievementItem)
    }
  }
  return out
}

/**
 * THE TWO SETS THE LOADED DUMP SPEAKS ABOUT, kept apart (JOS-441).
 *
 * `quest` is the ladder's `'achievement'` rung — rows under a class whose unlock the file says was
 * EARNED, and which therefore answer "did you run this quest". `classUnlock` is the `'class-unlock'`
 * rung — the identical `C` rows under a class the file says was unlocked by confirmation or by a
 * token, where the server cascaded the grant down into every component and the row answers a
 * different question entirely. Both are returned because both are tracked; only the first floors.
 */
export interface AchievementVouchedQuests {
  quest: Set<string>
  classUnlock: Set<string>
}

/**
 * WHICH QUESTS THE LOADED ACHIEVEMENTS DUMP SPEAKS FOR, SPLIT BY WHICH QUESTION ITS ROWS ANSWER.
 *
 * `unlocks` is `ProgressState.achievementUnlocks` as stored: the EARNED `Obtain` rows only, in the
 * game's own spelling, each carrying the `grant` its class's pseudo-rows stated
 * (shared/outputs/achievements.ts takes that projection). Absent means the command has never been
 * run on this machine, which vouches for nothing — a different state from a dump that ran and had
 * nothing to say, and both correctly yield empty sets here.
 *
 * A CLAIM WITH NO `grant` IS DROPPED, and that is the v1.7.0 store migration stated as one line. A
 * claim persisted by the build this ticket fixes cannot say which kind it is, so it is not usable as
 * either — and the cost is nothing in the ordinary case, because `loadAchievementsNow` re-reads the
 * export at startup and on every file change, so a store whose file is still on disk is corrected
 * before the renderer ever sees it. A store whose export has since been deleted loses its derived
 * completions until the player runs `/outputfile achievements` once, which is the honest answer:
 * that store contains rows this build knows it cannot interpret.
 *
 * A quest with no reward in the data never matches: that is missing data about a quest, not a
 * finished one (the `hasEveryItem` refusal, law 1). There is no `isUntradeable` gate and there must
 * not be one — that gate exists in rewardInference.ts because possession of a TRADEABLE item proves
 * nothing, and this source is not reasoning from possession at all.
 */
export function achievementVouchedQuests(
  quests: readonly Pick<PoskyQuest, 'className' | 'name' | 'reward'>[],
  unlocks: readonly ClassUnlockClaim[] | undefined
): AchievementVouchedQuests {
  const vouched: AchievementVouchedQuests = { quest: new Set(), classUnlock: new Set() }
  if (!unlocks || unlocks.length === 0) return vouched
  const earned = new Map<string, ClassUnlockGrant>()
  for (const u of unlocks) {
    if (u.grant === undefined) continue
    earned.set(joinKey(u.className, u.item), u.grant)
  }
  for (const q of quests) {
    if (q.reward === undefined) continue
    for (const item of achievementItemsFor(q.className, q.reward)) {
      const grant = earned.get(joinKey(q.className, item))
      if (grant === undefined) continue
      if (grant === 'quest') vouched.quest.add(questKey(q))
      else vouched.classUnlock.add(questKey(q))
      break
    }
  }
  return vouched
}
