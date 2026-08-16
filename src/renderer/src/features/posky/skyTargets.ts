// ============================================================================
// skyTargets.ts — the Targets tab's whole model: "who do I still kill", cross-quest.
// ============================================================================
//
// Issue #30. The tracker says what each quest needs; the player's real question on the islands
// is the inversion — which mobs are still worth pulling, across every quest at once. This module
// is that inversion as a pure fold: no React, no data bundle, relative value imports, pinned by
// tests/skyTargets.test.mts (half against the committed catalog, the poskyDroppers precedent).
//
// THE NEED SET is never-turned-in and nothing else (`everTurnedIn` — the Ready tab's first-time
// reading). A reward-inferred completion reads turnIns >= 1 through the same predicate, so the
// inference needs no special case here. The CALLER supplies the visible (not-ignored) quest set;
// ignoring is the one flag that means "never show me this", and it is decided upstream in
// useQuestList exactly once — this module does not re-filter (the Ready tab's rule).
//
// SHORTFALL AGGREGATES PER COUNTING KEY, NEVER PER QUEST. `computeQuestProgress` clamps `have`
// per quest and allocates nothing across quests, so a per-quest `have < need` filter would read
// two quests each "satisfied" by the same single held copy — and Sky quests contend for items
// heavily (sharedItems.ts). The rule: totalNeed summed over the need set, minus the UNCAPPED
// `held` (same counting key ⇒ same held number on every occurrence), floored at zero. There is
// deliberately NO per-quest allocation of the held copies — any split (first-wins, proportional)
// would be invented semantics; the aggregate is the only number the data can vouch for, so the
// aggregate is the only number shown.
//
// CLASSIFICATION IS THE SCRAPE'S OWN WORDS (law 1, never a guess):
//   * resolved `droppers` fold into mob cards — dedupe by `page` per item so a twice-listed
//     mob cannot inflate its coverage (the questKillTargets rule, cross-quest);
//   * an unresolved item whose `who` starts with "random drop" (case-insensitive PREFIX — the
//     literal sentinel carries an em dash, and copyNoEmDash.test.mts rejects that character in
//     any src/renderer string literal) is the collective random-drop entry;
//   * anything else unresolved goes to the no-known-source list — shown as missing data, never
//     dropped and never guessed at.
//
// THE ORDER IS COUNTED, NOT GUESSED: mobs by distinct needed items covered, descending, then
// name — killing the top row closes the most of what is left. Items inside a card and both
// special lists read alphabetically: deterministic, explainable, nothing invented. Islands ride
// per mob from the items that mob is the target for, in island-number order.

import { itemCountKey, normalizeItemName } from '../../lib/itemName'
import { everTurnedIn } from './questCompletion'
import {
  dropperNameOrder,
  isRandomDropWho,
  islandNumber,
  islandOf,
  type DropperMob
} from './poskyDroppers'

/** One quest item as the fold reads it — the `ItemProgress` fields it consumes, structural. */
export interface TargetsQuestItem {
  name: string
  need: number
  /** UNCAPPED held count (`ItemProgress.held`) — the per-quest clamped `have` is never read. */
  held: number
  droppers: readonly DropperMob[]
  where: string
  who: readonly string[]
}

/** One quest as the fold reads it — `QuestProgress`, structurally. */
export interface TargetsQuest {
  className: string
  name: string
  turnIns: number
  items: readonly TargetsQuestItem[]
}

/** One still-needed item: the aggregate shortfall and every need-set quest that wants it. */
export interface NeededItem {
  name: string
  /** summed required count across the need set, minus held, floored at zero — always > 0 here */
  shortfall: number
  quests: { className: string; questName: string; need: number }[]
  /** where it drops, island-number order; empty when posky states no island */
  islands: string[]
}

/** One mob still worth killing, with everything it can still yield. */
export interface TargetMob {
  mob: DropperMob
  /** distinct needed items this mob drops — the sort key, always `items.length` */
  covers: number
  islands: string[]
  items: NeededItem[]
}

export interface SkyTargetsModel {
  mobs: TargetMob[]
  /** needed items with no kill target that posky calls a random drop (the Wind Runes) */
  randomDrop: NeededItem[]
  /** needed items nothing committed can source — missing data, stated rather than hidden */
  unsourced: NeededItem[]
}

/** Per counting key, everything the need set says about one item, accumulated before deciding. */
interface ItemAgg {
  name: string
  totalNeed: number
  held: number
  droppers: readonly DropperMob[]
  /** true the moment ANY contributing quest's `who` states the random-drop sentinel — a flag
   *  rather than a frozen `who` array, so classification can never depend on fold order. */
  isRandom: boolean
  islands: Set<string>
  quests: { className: string; questName: string; need: number }[]
}

/** Item lines and both remainder lists read alphabetically — local to this pane, no counterpart
 *  elsewhere to drift from. Mob order is `dropperNameOrder`, the one comparator the Quests tab's
 *  own kill targets use, imported rather than copied so the two tabs can never disagree about
 *  which mob leads a tie. */
const byItemName = (a: NeededItem, b: NeededItem): number =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase())

const sortIslands = (islands: Set<string>): string[] =>
  [...islands].sort((a, b) => islandNumber(a) - islandNumber(b))

/** Fold one quest item into its counting key's aggregate. */
function recordItem(byKey: Map<string, ItemAgg>, q: TargetsQuest, it: TargetsQuestItem): void {
  const key = itemCountKey(it.name)
  const agg = byKey.get(key) ?? {
    name: it.name,
    totalNeed: 0,
    held: it.held,
    droppers: it.droppers,
    isRandom: false,
    islands: new Set<string>(),
    quests: []
  }
  agg.totalNeed += it.need
  agg.isRandom = agg.isRandom || isRandomDropWho(it.who)
  // Prefer the BASE display name over a `+N` variant, the deriveLootNames rule.
  if (agg.name !== normalizeItemName(agg.name) && it.name === normalizeItemName(it.name)) {
    agg.name = it.name
  }
  // Same counting key ⇒ same resolved droppers; keep the first non-empty answer.
  if (agg.droppers.length === 0 && it.droppers.length > 0) agg.droppers = it.droppers
  const island = islandOf(it.where)
  if (island !== undefined) agg.islands.add(island)
  agg.quests.push({ className: q.className, questName: q.name, need: it.need })
  byKey.set(key, agg)
}

/** Everything the need set says, per counting key. The never-turned-in filter is HERE. */
function accumulateNeeds(quests: readonly TargetsQuest[]): Map<string, ItemAgg> {
  const byKey = new Map<string, ItemAgg>()
  for (const q of quests) {
    if (everTurnedIn(q)) continue
    for (const it of q.items) recordItem(byKey, q, it)
  }
  return byKey
}

/** One aggregate as the pane's item line — or nothing, when the holdings already cover it. */
function toNeeded(agg: ItemAgg): NeededItem | null {
  const shortfall = Math.max(0, agg.totalNeed - agg.held)
  if (shortfall === 0) return null
  return { name: agg.name, shortfall, quests: agg.quests, islands: sortIslands(agg.islands) }
}

interface MobAcc {
  mob: DropperMob
  islands: Set<string>
  items: NeededItem[]
}

/** Fold one needed item onto every mob that drops it — per ITEM dedupe by page, so a page listed
 *  twice on one item cannot inflate its coverage (the questKillTargets rule). */
function foldIntoMobs(mobsByPage: Map<string, MobAcc>, needed: NeededItem, droppers: readonly DropperMob[]): void {
  const seen = new Set<string>()
  for (const m of droppers) {
    if (seen.has(m.page)) continue
    seen.add(m.page)
    const hit = mobsByPage.get(m.page) ?? { mob: m, islands: new Set<string>(), items: [] }
    hit.items.push(needed)
    for (const island of needed.islands) hit.islands.add(island)
    mobsByPage.set(m.page, hit)
  }
}

/** The Targets model, from the quests the user can see. Membership is the fold, nothing else. */
export function skyTargets(quests: readonly TargetsQuest[]): SkyTargetsModel {
  const mobsByPage = new Map<string, MobAcc>()
  const randomDrop: NeededItem[] = []
  const unsourced: NeededItem[] = []
  for (const agg of accumulateNeeds(quests).values()) {
    const needed = toNeeded(agg)
    if (needed === null) continue
    if (agg.droppers.length > 0) foldIntoMobs(mobsByPage, needed, agg.droppers)
    else if (agg.isRandom) randomDrop.push(needed)
    else unsourced.push(needed)
  }
  const mobs: TargetMob[] = [...mobsByPage.values()]
    .map((e) => ({
      mob: e.mob,
      covers: e.items.length,
      islands: sortIslands(e.islands),
      items: [...e.items].sort(byItemName)
    }))
    .sort((a, b) => (a.covers === b.covers ? dropperNameOrder(a.mob, b.mob) : b.covers - a.covers))
  randomDrop.sort(byItemName)
  unsourced.sort(byItemName)
  return { mobs, randomDrop, unsourced }
}
