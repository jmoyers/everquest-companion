// skyQuestRewards.ts — WHICH ITEM A SKY QUEST ACTUALLY HANDS OUT, when the wiki quest page links
// the wrong one (JOS-428).
//
// THE DEFECT, reported 01M0FH3XC4ST5Q3XXPJ0H3X75J (1.6.0), verbatim: "The link Fae Amulet/name
// should be Amulet of the Fae." The reporter is a Bard who has run Bard Test of Wind, and their
// attached inventory export carries `Amulet of the Fae` (item id 27723, Bank7-Slot1) and no Fae
// Amulet at all. Two consequences, one of them invisible until the reward inference landed with
// this same ticket: the reward caption and its wiki link name an item the player will never see,
// and `rewardInference.ts` matches the export against the reward NAME, so Bard Test of Wind is the
// one Sky quest that could hold its reward in hand and still read "not turned in".
//
// WHY THIS IS NOT A RENAME, and so not a row in `itemRenames.ts`. That table is for an item the
// wiki has RETITLED under us (Scintillating -> Shimmering Bracer of Protection: the old page is
// literally `#REDIRECT` to the new one, and the new title appears in no committed scrape). Here
// BOTH pages exist and both are scraped, as two separate records:
//
//   * `Fae Amulet` — AC 5, DEX +4 STA +4 HP +50, eraTag Sky, questUses: Bard Test of Wind. Its own
//     summary asks "Is the Amulet of the Fae an upgraded version of this item?"
//   * `Amulet of the Fae` — AC 8, STR +5 DEX +4 STA +4 HP +50, same NECK slot, same BRD class, same
//     4 charges of Healing at 45, same icon 1043, no dropsFrom and no questUses at all. Its own
//     summary asks the mirror question, "Is this an upgraded version of Fae Amulet?"
//
// So the wiki holds two pages for one buffed item and is openly unsure; the player's bag is not.
// An `ITEM_RENAMES` row could not carry this even if the shape were right: `renamedItems` writes
// the renamed source record onto the target key, which would REPLACE the real AC 8 record with the
// stale AC 5 one, and `tests/itemRenames.test.mts` asserts no committed scrape carries the new
// spelling — items.json carries `Amulet of the Fae` as a page of its own, and posky.json carries it
// inside the very note quoted above. Both guards are correct about renames and both would have to
// be weakened to admit a row that is not one.
//
// WHY AN OVERLAY AND NOT A DATA EDIT. `posky.json` is a scrape rewritten wholesale by
// `npm run scrape:posky` (`parseRewardCell` reads the reward cell's ANCHOR, and the stat block is
// then fetched from whatever page that anchor points at — scripts/sources/eqlegends.ts), so a hand
// edit into it is undone by the next run and makes that run's diff unreadable. Nothing in the
// scrape is wrong about the wiki either: the wiki quest page really does link Fae Amulet. This is
// the `skyMobIslands.ts` arrangement, one row, applied at the one seam where the dataset enters the
// renderer (`renderer/src/data/index.ts`).
//
// THE ENTRY STATES WHAT IT REPLACES, the `SkyMobIsland` idempotence rule: `from` is what the scrape
// says today, so the day a re-scrape lands the correction upstream the audit fails rather than
// letting a row that has quietly stopped describing anything look like coverage.
//
// THE STAT BLOCK IS TRANSCRIBED, NOT INVENTED. `stats` is the committed `items.json` record for
// `Amulet of the Fae` written in posky's own one-line-per-row format — the renderer cannot read
// items.json (it is a main-process bundle), and leaving the old page's block would print AC 5 and a
// question about whether this item is an upgrade of itself under the corrected heading.
// `tests/skyQuestRewards.test.mts` derives every number in it from that committed record, so it
// cannot drift, and pins that it still reads as untradeable — the reward inference's whole gate.

/** One Sky quest whose scraped reward names a different item from the one the game hands out. */
export interface SkyQuestReward {
  /** Quest identity, the pair every posky surface keys on. */
  className: string
  questName: string
  /** What the scrape's reward cell says today, so a fixed re-scrape fails the audit. */
  from: string
  /** The item actually handed out — the name to display, to link, and to match an export against. */
  to: string
  /** The corrected stat block, in posky's `rewardStats` format. */
  stats: string
  /** ISO date the correction was last checked against the evidence below. */
  verified: string
  /** What was checked and what it said, in one line. */
  evidence: string
}

export const SKY_QUEST_REWARDS: readonly SkyQuestReward[] = [
  {
    className: 'Bard',
    questName: 'Bard Test of Wind',
    from: 'Fae Amulet',
    to: 'Amulet of the Fae',
    stats: [
      'MAGIC ITEM LORE ITEM NO DROP',
      'Slot: NECK',
      'Charges: 4',
      'AC: 8',
      'STR: +5 DEX: +4 STA: +4 HP: +50',
      'SV DISEASE: +10 SV POISON: +10',
      'Effect: Healing (Must Equip, Casting Time: Instant) at Level 45',
      'WT: 0.1 Size: TINY',
      'Class: BRD',
      'Race: ALL'
    ].join('\n'),
    verified: '2026-08-20',
    evidence:
      'Reported 01M0FH3XC4ST5Q3XXPJ0H3X75J (1.6.0), "The link Fae Amulet/name should be Amulet of ' +
      'the Fae"; the same report\'s inventory export holds Amulet of the Fae (id 27723, Bank7) and ' +
      'no Fae Amulet. items.json carries both pages: Fae Amulet AC 5 with questUses Bard Test of ' +
      'Wind, Amulet of the Fae AC 8 STR +5 with the identical NECK/BRD/4-charge-Healing profile, ' +
      'the same icon 1043, and no source of its own stated anywhere. Each page asks in its own ' +
      'summary whether the other is the upgraded version; the bag settles it.'
  }
]

/** The minimum a quest record must have for the overlay to key on it and rewrite it. */
interface CorrectableQuest {
  className: string
  name: string
  reward?: string
  rewardPage?: string
  rewardStats?: string
}

const questIdentity = (className: string, name: string): string =>
  `${className.toLowerCase()}${name.toLowerCase()}`

const BY_QUEST: ReadonlyMap<string, SkyQuestReward> = new Map(
  SKY_QUEST_REWARDS.map((e) => [questIdentity(e.className, e.questName), e])
)

/** The overlay row for one quest, or undefined. Exported for the audit test and the seam. */
export function skyQuestRewardFor(className: string, name: string): SkyQuestReward | undefined {
  return BY_QUEST.get(questIdentity(className, name))
}

/**
 * Does this quest's scraped reward still read the way the row says it does?
 *
 * The correction is applied ONLY to a quest whose reward is still the stale name — an idempotence
 * guard, and the thing that makes a landed re-scrape a no-op here rather than a second rewrite of
 * an already-correct row.
 */
export function needsRewardCorrection(q: CorrectableQuest): boolean {
  const hit = skyQuestRewardFor(q.className, q.name)
  return hit !== undefined && q.reward === hit.from
}

/**
 * One quest with its reward name, its wiki page link and its stat block corrected — or the SAME
 * object when the overlay has nothing to say about it, so a caller memoizing on identity keeps it.
 *
 * `rewardPage` is set rather than renamed: the page to open is the corrected item's own page, and
 * the scrape's `rewardPage` is only ever the anchor the wrong link pointed at.
 */
export function correctSkyQuestReward<T extends CorrectableQuest>(q: T): T {
  const hit = skyQuestRewardFor(q.className, q.name)
  if (!hit || q.reward !== hit.from) return q
  return { ...q, reward: hit.to, rewardPage: hit.to, rewardStats: hit.stats }
}
