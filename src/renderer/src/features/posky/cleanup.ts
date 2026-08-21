// ============================================================================
// posky/cleanup.ts — WHAT YOU COULD DESTROY, AND WHAT YOU WOULD BE GIVING UP (JOS-389).
// ============================================================================
//
// The owner's ask, 2026-08-16: a Sky player ends a long campaign carrying dozens of quest items
// in bags, bank, shared bank, personal depot and the Dragon Hoard for quests they turned in
// months ago. Nothing in the app has ever said which of those are safe to throw away — and
// nothing in the app should say "throw this away" either, because a Sky quest can be run AGAIN:
// handing it in a second time yields a second copy of the reward, and two copies merge into a +1
// (the ordinary Legends `+N` merge). So this module answers BOTH halves at once: the items no
// un-turned-in quest still wants, and the turn-in each of them feeds if you keep them instead.
//
// PURE, and no React and no data bundle, exactly like `questCompletion.ts` and `sharedItems.ts`:
// the rule below is the entire feature and it is pinned by a plain node test
// (tests/skyCleanup.test.mts) rather than by a browser. Everything the tab draws on a row is a
// field or a sentence produced here, so the words a player reads are testable without a DOM.
//
// ---------------------------------------------------------------------------
// THE RULE FOR "YOU COULD DESTROY THIS"
// ---------------------------------------------------------------------------
// An item X the character holds appears iff EVERY Sky quest whose `items[]` names X has been
// turned in at least once (`everTurnedIn`, i.e. the JOS-131 ledger's count >= 1, which already
// merges log-detected trades with the manual +/- statements). One un-turned-in claimant is
// enough to keep an item off this screen — the Wind Runes are the obvious case, since every class
// Test turns one in and almost nobody has run all 95.
//
// It is deliberately the WHOLE claimant set and not "the quests you have run": an item wanted by
// a quest you have never touched is not spare, however many other quests you have finished with
// it. `sharedItems.ts` is the map of that overlap; this module does not need it, because the
// quantifier here is over every quest that names the item and that is the same walk.
//
// THE QUANTITY IS THE TAB'S OWN NUMBER. It is the held count the Sky tab already shows for that
// item under the user's chosen count source, i.e. `reconcile`'s `net` after `questConsumption`
// (ItemProgress.held). There is deliberately no second count derived here: a Cleanup row saying
// you hold four of something the quest row beside it calls three would be the worst possible
// defect on a screen whose advice is destructive.
//
// ---------------------------------------------------------------------------
// AND THE ROW ARGUES THE OTHER WAY, ON PURPOSE
// ---------------------------------------------------------------------------
// Every row names the turn-in(s) it feeds, how many times you have already run each, and what it
// pays. Then the decision line, which is the only place this module takes a side:
//
//   * holding a FULL SET for at least one more turn-in → "keep them", with the reason spelled
//     out (another reward, and two of them merge into a +1) and how many more sets you hold.
//     `sets` is `min` over the quest's required items of `floor(held / needed)` — the same
//     arithmetic a turn-in performs, so a quest that would consume 5 claws needs 10 for two runs.
//   * short of a set → what you hold of what it asks, so the row states the gap instead of
//     implying the item is worthless.
//
// The reward's own upgrade level (`your <reward> is +N`) is NOT decided here: it comes from the
// itemTiers module, which is per-character observed evidence rather than a fact about the quest.
// `rewardTierLine` is the sentence, so the copy still lives in one place.
//
// `rewardStats` IS NEVER PARSED. 23 quests carry a `Previous version: <Old>` clause in their
// reward prose, which is upgrade LINEAGE from the wiki — what this reward replaced — and not a
// combine recipe. Reading it would have this screen assert a game mechanic nobody measured
// (law 1), and it would do it on the screen where being wrong costs the player an item.

import type { CarryRow } from '../../../../shared/carryAll'
import { SECTION_LANE_PREFIX, laneLabel } from '../../../../shared/carryAll'
import { parsePlace, splitLocationPath, type ContainerKind } from '../../../../shared/outputs/inventory'
import { itemCountKey, normalizeItemName } from '../../lib/itemName'
import type { QuestProgress } from './useProgress'

/**
 * The part of a Sky quest this module reads — structural, so a test needs no bundled data and the
 * tab can hand over its own `QuestProgress` through `cleanupRowsFor` below.
 */
export interface CleanupQuest {
  /** the canonical `Class::Name` key (posky/keys.ts) */
  key: string
  className: string
  name: string
  giver?: string
  reward?: string
  /** the required items, with the count each turn-in consumes */
  items: readonly { name: string; count: number }[]
}

/** quest key → how many times THIS character has handed it in (the JOS-131 ledger's count). */
export type TurnInCounts = Readonly<Record<string, number>>

/** counting key → what the app counts you as holding (reconcile's `net`). */
export type HeldByKey = Readonly<Record<string, number>>

/** One place the dump says copies of an item are sitting, and how many are there. */
export interface CleanupLocation {
  /** `Bank`, `General`, `Shared Bank`, `Personal Depot`, `Worn`, `Key ring`, or a dump lane's
   *  own name verbatim (a Dragon Hoard section calls itself whatever the client called it) */
  label: string
  count: number
}

/** counting key → where the loaded dump says that item sits. Absent = the dump never named it. */
export type DumpLocations = Readonly<Record<string, readonly CleanupLocation[]>>

/** One turn-in an item feeds: who takes it, what it pays, and whether you could run it again. */
export interface CleanupTurnIn {
  questKey: string
  className: string
  name: string
  giver?: string
  reward?: string
  /** how many times it has been handed in. Always >= 1 on a Cleanup row, by the rule above. */
  times: number
  /** how many MORE full sets the character is holding for it; 0 means not another set */
  sets: number
  /** toward ONE more turn-in: what you hold of what it asks, each item clamped to its need */
  have: number
  /** what one turn-in consumes, summed over the required items */
  need: number
}

/** One item you could destroy: how many, where they sit, and every turn-in they feed. */
export interface CleanupRow {
  /** the counting key (`itemCountKey`) — stable id, and what an override is written against */
  key: string
  /** the display name, `+N` stripped: the quest data's own spelling of the item */
  name: string
  /** the held count the Sky tab shows for it, uncapped */
  quantity: number
  /** compact places from the dump; EMPTY when no loaded dump names the item */
  locations: readonly CleanupLocation[]
  /** the quests it feeds, most-recently-useful first (most sets, then class, then name) */
  turnIns: readonly CleanupTurnIn[]
}

/** A quest's required items reduced to counting key → how many one turn-in eats. */
function questNeeds(q: CleanupQuest): Map<string, number> {
  const needs = new Map<string, number>()
  for (const it of q.items) {
    const key = itemCountKey(it.name)
    // A quest that lists the same base item twice wants the SUM, which is exactly what
    // `reconcile.questConsumption` subtracts for it. Two truths about one turn-in would be one
    // truth too many.
    needs.set(key, (needs.get(key) ?? 0) + (it.count > 0 ? it.count : 1))
  }
  return needs
}

/** How many more complete sets of this quest's items the character is holding. */
function setsHeld(needs: Map<string, number>, held: HeldByKey): number {
  let sets = Number.POSITIVE_INFINITY
  for (const [key, need] of needs) sets = Math.min(sets, Math.floor((held[key] ?? 0) / need))
  return Number.isFinite(sets) ? sets : 0
}

/** Toward ONE more turn-in: what you hold of what it asks, each item clamped to its own need. */
function progressToward(needs: Map<string, number>, held: HeldByKey): { have: number; need: number } {
  let have = 0
  let need = 0
  for (const [key, n] of needs) {
    have += Math.min(n, held[key] ?? 0)
    need += n
  }
  return { have, need }
}

/** Every quest that names an item, in listed order, with the quest's own needs precomputed. */
interface ItemClaim {
  /** the quest data's spelling of the item, `+N` stripped */
  name: string
  quests: { quest: CleanupQuest; needs: Map<string, number> }[]
}

function indexClaims(quests: readonly CleanupQuest[]): Map<string, ItemClaim> {
  const byItem = new Map<string, ItemClaim>()
  for (const q of quests) {
    const needs = questNeeds(q)
    for (const key of needs.keys()) {
      const spelling = q.items.find((it) => itemCountKey(it.name) === key)?.name ?? key
      let claim = byItem.get(key)
      if (!claim) {
        claim = { name: normalizeItemName(spelling), quests: [] }
        byItem.set(key, claim)
      }
      claim.quests.push({ quest: q, needs })
    }
  }
  return byItem
}

function turnInOf(
  entry: { quest: CleanupQuest; needs: Map<string, number> },
  times: number,
  held: HeldByKey
): CleanupTurnIn {
  const { quest, needs } = entry
  const { have, need } = progressToward(needs, held)
  return {
    questKey: quest.key,
    className: quest.className,
    name: quest.name,
    ...(quest.giver ? { giver: quest.giver } : {}),
    ...(quest.reward ? { reward: quest.reward } : {}),
    times,
    sets: setsHeld(needs, held),
    have,
    need
  }
}

/**
 * THE MODEL: every item the character holds that no un-turned-in Sky quest still wants.
 *
 * Sorted by quantity descending then name, because the reason to open this screen is bag space
 * and the biggest stack is the biggest win. Each row's turn-ins are ordered by how close they are
 * to being runnable again (sets desc), then class then name, so the "keep them" case is the first
 * thing read on a row that has one.
 */
export function cleanupRows(
  quests: readonly CleanupQuest[],
  progress: TurnInCounts,
  held: HeldByKey,
  dumpLocations: DumpLocations = {}
): CleanupRow[] {
  const rows: CleanupRow[] = []
  for (const [key, claim] of indexClaims(quests)) {
    const quantity = held[key] ?? 0
    // Nothing in hand is nothing to decide about — and this is also what makes a destroy remove
    // the row (JOS-401): the log's own `You successfully destroyed …` lines are subtracted from
    // the held count this tab reads, so destroying the last copy empties the row out of existence
    // with no statement from anybody. It is what the hand-stated 0 used to do, from evidence.
    if (quantity <= 0) continue
    const times = claim.quests.map((entry) => progress[entry.quest.key] ?? 0)
    // ONE un-turned-in claimant keeps the item off this screen. See the header.
    if (times.some((n) => n < 1)) continue
    const turnIns = claim.quests
      .map((entry, i) => turnInOf(entry, times[i], held))
      .sort((a, b) => b.sets - a.sets || a.className.localeCompare(b.className) || a.name.localeCompare(b.name))
    rows.push({ key, name: claim.name, quantity, locations: dumpLocations[key] ?? [], turnIns })
  }
  rows.sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name))
  return rows
}

/**
 * The tab's own `QuestProgress` list → the model above, so the view states the adaptation once.
 *
 * `held` is read straight off the items themselves (`ItemProgress.held`, the UNCAPPED net count),
 * which is the tab's number by construction rather than by agreement: it is the same value the
 * quest row's Have cell pre-fills its editor with.
 */
export function cleanupRowsFor(
  quests: readonly QuestProgress[],
  dumpLocations: DumpLocations = {}
): CleanupRow[] {
  const held: Record<string, number> = {}
  const progress: Record<string, number> = {}
  const shaped: CleanupQuest[] = quests.map((q) => {
    progress[q.key] = q.turnIns
    for (const it of q.items) held[itemCountKey(it.name)] = it.held
    return {
      key: q.key,
      className: q.className,
      name: q.name,
      ...(q.giver ? { giver: q.giver } : {}),
      ...(q.reward ? { reward: q.reward } : {}),
      items: q.items.map((it) => ({ name: it.name, count: it.need }))
    }
  })
  return cleanupRows(shaped, progress, held, dumpLocations)
}

// ---------------------------------------------------------------------------
// WHERE THE DUMP SAYS IT IS
// ---------------------------------------------------------------------------

/** What each numbered container is called on a Cleanup row — the player's words, not the file's. */
const CONTAINER_LABELS: Record<ContainerKind, string> = {
  general: 'General',
  bank: 'Bank',
  sharedBank: 'Shared Bank',
  personalDepot: 'Personal Depot'
}

/**
 * A carry row's place, named compactly.
 *
 * A row from a SECTION lane keeps the section's own name verbatim (`carryAll.laneLabel`) — the
 * day a dump carries a Dragon Hoard table, its rows read whatever the client called that table
 * and nothing here has to be edited. The owner's real dump today has two sections, `Location` and
 * `KeyRing`, and no hoard rows at all, so that lane is unexercised on this machine by design
 * rather than by omission.
 *
 * Everything else is the base token classified (`parsePlace`), which is a closed measured set;
 * an unclassifiable token is shown VERBATIM rather than folded into a guess.
 */
export function placeLabel(row: CarryRow): string {
  if (row.lane.startsWith(SECTION_LANE_PREFIX)) return laneLabel(row.lane)
  if (row.lane === 'keyring') return 'Key ring'
  const place = parsePlace(splitLocationPath(row.location).base)
  if (place.kind === 'container') return CONTAINER_LABELS[place.container]
  if (place.kind === 'equip') return 'Worn'
  return place.raw
}

/**
 * The dump's rows → counting key → the places that hold the item, in the file's own order.
 *
 * Counts are summed per place, so six claws across six General slots read `General 6` rather than
 * as six rows. The KEY is the counting key (law 2), which is what lets a `Sphinx Claw +1` sitting
 * in the bank answer for the `Sphinx Claw` a quest asked for — the same fold `reconcile` performs.
 */
export function dumpLocationsFrom(rows: readonly CarryRow[] | null | undefined): DumpLocations {
  const out: Record<string, CleanupLocation[]> = {}
  for (const row of rows ?? []) {
    const key = itemCountKey(row.name)
    const places = (out[key] ??= [])
    const label = placeLabel(row)
    const seen = places.find((p) => p.label === label)
    if (seen) seen.count += row.count
    else places.push({ label, count: row.count })
  }
  return out
}

// ---------------------------------------------------------------------------
// THE WORDS
// ---------------------------------------------------------------------------

/** The always-visible caveat, in the owner's own words. It is copy, so it is testable copy. */
export const CLEANUP_CAVEAT =
  'Cleanup lists items you could destroy because every Sky quest that needs them has been turned in. Destroying is permanent and happens in the game, not here. If you delete something you wanted, that is on you.'

/**
 * What a row says about where its copies are, or that the dump has never seen them.
 *
 * The absent case is a CELL in a table now (JOS-401), not a clause in a sentence, so it is four
 * words instead of six: the column header already says `Where`, and repeating "location" and
 * "inventory dump" inside it was the sentence apologising for a table that had not been built yet.
 */
export function locationsLine(locations: readonly CleanupLocation[]): string {
  if (locations.length === 0) return 'not in the export'
  return locations.map((l) => `${l.label} ${String(l.count)}`).join(', ')
}

/** `<Giver> - <Quest name> (<Class>)`, and the quest alone when the scrape had no giver. */
export function turnInHeading(t: CleanupTurnIn): string {
  return `${t.giver ? `${t.giver} - ` : ''}${t.name} (${t.className})`
}

/** How many times it has been run. A count, never a badge: this screen is about repeatability. */
export function timesLine(t: CleanupTurnIn): string {
  return `turned in ${String(t.times)} time${t.times === 1 ? '' : 's'}`
}

/**
 * THE DECISION, in one sentence.
 *
 * With a full set in hand it argues to KEEP, and says why in game terms the player already knows:
 * another turn-in is another copy of the reward, and two copies merge into a +1. With no reward
 * recorded for the quest it still argues to keep, without naming a prize the data does not have.
 * Short of a set it states the gap, so an item that is spare stays spare rather than reading as
 * an accusation.
 */
export function decisionLine(t: CleanupTurnIn): string {
  if (t.sets < 1) {
    return `you hold ${String(t.have)} of the ${String(t.need)} needed for another turn-in`
  }
  if (!t.reward) return 'keep them: you are holding enough for another turn-in'
  return `keep them: turning in again gives another ${t.reward}, two ${t.reward} merge into +1`
}

/** How many more runs the bags are good for, when they are good for any. */
export function setsLine(t: CleanupTurnIn): string | null {
  if (t.sets < 1) return null
  return `you hold enough for ${String(t.sets)} more turn-in${t.sets === 1 ? '' : 's'}`
}

/** The observed upgrade level of the reward this character already owns, when itemTiers saw one. */
export function rewardTierLine(reward: string | undefined, tier: number | undefined): string | null {
  if (!reward || tier === undefined) return null
  return `your ${reward} is +${String(tier)}`
}
