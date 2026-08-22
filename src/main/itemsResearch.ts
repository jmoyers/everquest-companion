// itemsResearch.ts — the ADDITIVE item-knowledge layer: hand-curated facts about items that the
// wiki scrape can never produce, merged OVER the scraped record and never back into it
// (docs/plans/planner-v2.md §4).
//
// WHY IT EXISTS. The corpus keeps proving the same shape of gap — facts that exist in the world
// but in no parseable wiki field: whether an item is mage-conjured, whether it only ever came out
// of a GM event, which instrument family a bard item counts as, focus percentages. `items.json` is
// a machine scrape and must stay one: a rescrape overwrites it wholesale, so anything hand-known
// written into it is lost on the next run. This file is the other layer. `itemsDb.ts` restores the
// scrape's own defaults (`knowledgeFromDb`); THIS module lays the curated fields on top of that
// result, in that order, so the two layers can never fight and a rescrape stays idempotent.
//
// THE FILE FORMAT (`src/main/data/itemsResearch.json`): a flat object keyed by `itemKey()` — the
// same key items.json, the userData cache and the planner already use — whose values are
// `ItemResearch`. Every entry carries its OWN provenance (`source`, `checkedAt`) because an entry
// with no stated source is indistinguishable from a guess, and a guess in this file would be
// invisible: it reads exactly like scraped fact to every consumer above it.
//
// HOW IT IS WRITTEN: BY HAND, or generated and then reviewed by a human before it lands — never
// machine-written unattended. That is the same shape as the zone table (world-model law 12): the
// V9 scrape-time pass may FLAG candidates (GM-event prose lives in the item's notes, e.g. the 12
// pages the committed corpus phrases as "GM Event Item." / "Obtained during a GM event"), but a
// candidate becomes an entry only when someone admits it. Hedged prose ("Possibly a GM Event
// item?") is exactly what the review is for, and stays out.
//
// WHAT CONSUMES IT TODAY: `planner/effectIndex.ts` only, and only to EXCLUDE donors (V9) — an
// excluded item stays in item lookup and stays a searchable host, because "you cannot pull an
// effect off this" is not "this item does not exist". `instrument` has NO consumer yet: V11's
// grouping axis is what will read it, and the table is filed ahead of it so commissioning that
// axis stays a UI decision rather than a data one.
//
// THE FOUR TABLES THE FILE CARRIES TODAY (JOS-25 + JOS-64 + JOS-67, the non-gated halves of
// planner-v2 §4):
//
//   * gmEvent × 9 — swept out of the item corpus's own `|notes` prose (`summary`) and the
//     `|gmitem` template param. Every one states a GM hand-out AND names no drop source, quest
//     or recipe anywhere on its page, so "unfarmable" is the page's whole story. (Was × 10:
//     `essence of gukta` was RETIRED by the 2026-08-22 rescrape — the wiki rebuilt the page as
//     "Essence of Gukta (Wormwood)", player-crafted, in the Protectors of Gukta content wave,
//     and the GM-event prose is gone, so the entry had stopped describing anything.)
//     Five pages whose prose is hedged or contradicted were DELIBERATELY ABSENT at JOS-25 —
//     the loudest is `Dabner's Staff of Recall`, which carries `|gmitem` and a real `|dropsfrom`
//     mob in the same template. A GM hand-out beside a live drop is not "unfarmable", and
//     flagging it would have deleted a farmable donor. It is still a donor today.
//   * gmOnly × 3 — the OWNER RULING of 2026-08-06 (JOS-64): *GM-only and GM-event both mean
//     unfarmable.* Three of those five refusals were never hedged at all — they were refused only
//     for saying GM *item* where the sweep's phrasings say GM *event* (`Da Oogly Stick`:
//     "This item is a GM item."; `Gnome Sandwich`: "GM item occasionally handed out.";
//     `Stone of Gnoming`: "GM Only item." — the wiki page adds that it is sold in Sunset Home,
//     which is the GM zone and not a player vendor). A player cannot execute a plan to obtain any
//     of the three, which is the only thing the planner's exclusion has ever been about, so they
//     are filed with the same treatment: verbatim source line, no farm route anywhere on the page,
//     excluded from the donor index.
//
//     WHY A SECOND BOOLEAN RATHER THAN ONE `unfarmable` FLAG. The fields of this file are FACTS AS
//     A PAGE STATES THEM, never a verdict computed from them (law 1) — "handed out at a GM event"
//     and "GM-only, never obtainable" are two different sentences from two different pages, and the
//     tripwire in `tests/itemsResearchLayer.test.mts` re-derives each from its OWN anchored prose.
//     Collapsing them into one flag would have rewritten ten filed entries to say something their
//     pages do not, and left the derivation unable to say which shape it matched. The VERDICT lives
//     in one function instead — `isUnfarmable()` below — so a consumer asks one question, and a
//     third unfarmable provenance is a change to this file and nowhere else. The merge stays
//     additive: no existing entry changed, only new keys were added.
//
//     `Shield of Hatred` STAYS UNFILED under the same ruling: "Possibly a GM Event item?" is a
//     question, and the layer files no guesses.
//   * slots × 3 — JOS-67, and the first table that repairs a PARSE gap rather than adding knowledge
//     the wiki never carried. `shared/itemStats.ts applySlot` fills `stats.slot` only from a
//     `Slot:` KEY, and three committed pages write their slot line with NO key at all
//     ("…Race: ALL\n\nPrimary Secondary"), so the scrape files that line under `flags` and the item
//     reaches the planner with `slots: []`. An empty slot list is "no legal donation" under R2
//     (plannerData `isNonEquippable`), so the Golem Metal Wand's click was hidden from the effect
//     browser by default and refused by `socketCompatibility` when it was found — reported live
//     against v0.6.3 (feedback 01KZCGXY8WC6YCD8W44W7EAS5H, *"can't find golem metal wand click
//     exaltation to add to shield of rainbow hues"*; the Shield of Rainbow Hues is SECONDARY, and
//     the wand really is Primary/Secondary, so that transfer is legal and the planner was refusing
//     it over a missing field).
//     FILED HERE RATHER THAN FIXED IN THE PARSER for the reason at the top of this file — the
//     corpus is a machine scrape a rescrape overwrites wholesale — and NOT as a matcher over
//     unkeyed stats-block lines: three pages are three facts, and a rule that reads any
//     slot-shaped flag as a slot is exactly the fuzzy join law 12 refuses (the same corpus files
//     a bare `MNK BRD ROG SHM` class line under `flags` too). `tests/itemsResearchLayer.test.mts`
//     re-derives each entry from its own page AND sweeps the corpus for a fourth page of the same
//     shape, so a rescrape that fixes the scrape, or one that adds another unkeyed slot line,
//     turns the suite red instead of silently hiding a donor.
//   * instrument × 47 — the bard family every instrument page states for itself, in one of two
//     places: 42 say it in the stats block (`Wind Resonance: 12`, and the older spelling
//     `Stringed Instrument`), 5 say it in `|focus_effect` (`Brass Resonance 14`, which the scrape
//     already folds in as a focus effect — see normalize.ts's focus-rank note). NORMALIZED here
//     and nowhere else: the wiki spells one family four ways, and a consumer should not have to
//     know that. `tests/itemsResearchLayer.test.mts` re-derives the whole table from the committed
//     corpus and fails on ANY disagreement, so a rescrape that moves a family cannot leave a stale
//     curated answer winning the merge — which is the one real hazard of restating scraped fact
//     in a layer that overlays it.

import itemsResearchJson from './data/itemsResearch.json'
import { itemKey, knowledgeFromDb, type ItemDbEntry } from './itemsDb'
import type { ItemKnowledge } from '../shared/types'
import type { EquipSlot } from '../shared/planner/types'

/**
 * The bard instrument families, as the game groups a bard's songs. `all` is one item's own claim
 * ("All Instrument Types" on the Singing Short Sword), not a wildcard the code assigns.
 *
 * A CLOSED union rather than a string: the wiki writes one family four ways (`Wind Resonance`,
 * `Wind Instrument`, `Stringed Instrument`, `String Resonance`), and the whole point of filing
 * the table is that no consumer above this file ever meets that spelling problem again.
 */
export const INSTRUMENT_FAMILIES = ['wind', 'string', 'brass', 'percussion', 'all'] as const

export type InstrumentFamily = (typeof INSTRUMENT_FAMILIES)[number]

/**
 * One curated entry. Every field is OPTIONAL knowledge except the provenance pair, which is not:
 * absent means unresearched, never false (law 1).
 */
export interface ItemResearch {
  /** mage-conjured — R7, cannot donate an exaltation (docs/plans/exaltation-planner.md §1) */
  summoned?: boolean
  /** only ever handed out in a GM event: real, unfarmable, and not a plan a player can execute */
  gmEvent?: boolean
  /** a GM-only item — no event named, no route at all: same unfarmability, different sentence */
  gmOnly?: boolean
  /** bard instrument family, for the grouping axis V11 defers until this layer carries it */
  instrument?: InstrumentFamily
  /**
   * The equipment slots this item occupies — filed ONLY where the page states them in a line the
   * scrape cannot key (JOS-67, see the header). Curated slots REPLACE the scraped list rather than
   * merging with it: an entry here is a reading of the whole slot line, and a union would be this
   * file guessing that the scrape got half of one right.
   */
  slots?: EquipSlot[]
  /** why this entry says what it says, in one sentence — for the next reader, not for code */
  note?: string
  /** where the claim came from: a URL, a page name, or the observation that produced it */
  source: string
  /** ISO date the claim was last checked against that source */
  checkedAt: string
}

/** The committed file: `itemKey()` → entry. */
export type ItemResearchFile = Record<string, ItemResearch>

/** The committed layer. Tiny (hand-authored), so unlike items.json it is imported freely. */
export const ITEMS_RESEARCH = itemsResearchJson as ItemResearchFile

/**
 * Is there NO plan a player can execute to obtain this item? The one verdict read off the curated
 * provenance flags, and the only thing a consumer should ask (owner ruling, JOS-64: GM-only and
 * GM-event both mean unfarmable).
 *
 * It lives here rather than at the consumer because the flags are a growing vocabulary and the
 * verdict is not: `effectIndex.ts` asking `gmEvent === true || gmOnly === true` inline would need
 * editing again the day a third GM phrasing is admitted, and an exclusion that silently forgets a
 * flag is exactly the failure the planner cannot see (an unfarmable row in a farm plan).
 *
 * NOT the same question as "can this donate": `summoned` items are perfectly farmable and still
 * cannot donate (R7). `excludedDonor` is the union; this is one half of it.
 */
export function isUnfarmable(research: ItemResearch | undefined): boolean {
  return research?.gmEvent === true || research?.gmOnly === true
}

/**
 * The scraped record with its curated layer attached — the view every consumer should read.
 *
 * The layer is a SIBLING field, not a spread over the knowledge record: a curated `summoned` is a
 * different kind of claim from a scraped `quest`, and a reader that cannot tell them apart cannot
 * report provenance. Absent `research` means nobody has looked, which is not the same as "nothing
 * to say" (law 1).
 */
export interface ResearchedKnowledge extends Omit<ItemKnowledge, 'cached'> {
  research?: ItemResearch
}

/**
 * One stored record → the merged view. `knowledgeFromDb` FIRST (it restores the scrape's omitted
 * defaults), the curated entry after, keyed by the same `itemKey` the rest of the app uses — so
 * the lookup follows the item's `|itemname` when the page states one, exactly like the planner's
 * own keys do.
 *
 * `research` is injectable so a test can prove the merge with a fixture instead of depending on
 * whichever entries the committed layer happens to carry today.
 */
export function knowledgeWithResearch(
  entry: ItemDbEntry,
  research: ItemResearchFile = ITEMS_RESEARCH
): ResearchedKnowledge {
  const k = knowledgeFromDb(entry)
  const found = research[itemKey(k.name)]
  return found ? { ...k, research: found } : k
}
