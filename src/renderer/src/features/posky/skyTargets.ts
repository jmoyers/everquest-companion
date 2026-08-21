// ============================================================================
// skyTargets.ts — the Targets tab's whole model: "who do I still kill", cross-quest.
// ============================================================================
//
// GitHub issue #30, landed as JOS-417 from community PR #34 (johnsideserf) — this module and the
// tab it feeds are that contribution, integrated. The tracker says what each quest needs; the
// player's real question on the islands is the inversion — which mobs are still worth pulling,
// across every quest at once. This module is that inversion as a pure fold: no React, no data
// bundle, relative value imports, pinned by tests/skyTargets.test.mts (half against the committed
// catalog, the poskyDroppers precedent).
//
// THE NEED SET IS THE QUESTS THAT STILL WANT SOMETHING, and `firstTimeOnly` decides whether a
// quest you have already run is one of them — the JOS-155 shape, ported from the Ready tab rather
// than invented. Default ON, so the default reading is never-turned-in (`everTurnedIn`, the Ready
// tab's first-time predicate; a reward-inferred completion reads turnIns >= 1 through the same
// predicate and needs no special case). OFF is the refarmer's reading, and it is the reason this
// is a parameter rather than a constant: JOS-131 made a turn-in SUBTRACT what it consumed, so a
// quest you ran drops back to 0/N and is genuinely work again — hard-coding the first-time rule
// would empty this tab permanently for exactly the player deepest into the grind. Both readings
// run the identical fold below; the flag reaches nothing but which quests enter it.
//
// The CALLER supplies the visible (not-ignored) quest set; ignoring is the one flag that means
// "never show me this", and it is decided upstream in useQuestList exactly once — this module does
// not re-filter (the Ready tab's rule).
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
// THE ORDER IS THE WALK, THEN THE COUNT (JOS-423, owner directive 2026-08-19: the Targets tab
// should be SORTED BY ISLAND). A player works the Plane island by island, so the list reads in
// walk order: island ASCENDING first, and only inside one island does the counted order decide —
// mobs by distinct needed items covered, descending, then name, which is the previous ordering
// preserved intact as the tiebreak. Items inside a card and both special lists still read
// alphabetically: deterministic, explainable, nothing invented.
//
// THE ISLAND IS DERIVED, NEVER HAND-KEYED. Islands already rode per mob, from the items that mob
// is the target for (`islandOf` over posky's STATED `where` field — poskyDroppers' header measures
// its three shapes), and that same derivation is now the sort key: `island` is the LOWEST stated
// island of the mob's outstanding drops, because that is where you meet the mob first walking
// outward. No mob->island table is written down anywhere in this module, so a correction to the
// scrape's `where` moves the card by itself. (MEASURED 2026-08-19 over the committed data with
// every quest open: 14 of the 20 cards carry a stated island — 3..8.)
//
// THE ONE DISAGREEMENT JOS-423 LEFT OPEN IS NOW SETTLED, AND IN DATA (JOS-415). It read: "Protector
// of Sky reads Island 7 from posky while `bosses.json` calls it Island 2; the disagreement is
// DATA's to settle, and whichever way it lands this fold follows it." It landed on island 2 — the
// mob's own eqlwiki page opens "Location: 2nd Island" — and the settlement is
// `skyMobIslands.ts`, a one-row overlay applied to the per-mob islands BEFORE this sort, so the
// card moves to island 2's heading rather than only relabelling itself. Nothing about the
// derivation changed: the island is still the lowest island of the mob's outstanding drops
// EXCEPT where an item demonstrably drops in two places, which is exactly what Gem of Invigoration
// does and what made the join say 7 about a mob that lives on 2. That file's header is the
// argument and its audit proves no other card moved.
//
// A MOB WHOSE ISLAND THE DATA DOES NOT STATE SORTS LAST, under a heading that says so — never
// under a guessed number. That is the tab's own law for the no-known-source list applied one level
// up, and it is not a rare corner: six of today's twenty cards (Noble Dojorn, the Overseer of Air
// and the Hand of Veeshan among them) are sourced only by item rows whose `where` is empty.
//
// A CARD'S IDENTITY IS THE WIKI PAGE, NEVER THE NAME — and there is no era or difficulty variant
// hiding behind that today. MEASURED over the committed catalog (JOS-417, 2026-08-19): the 7,872
// mob rows carry NO era annotation at all (`MobEntry` is page/name/level/zones/drops/loc — the
// `eraTag` the item DB carries has no counterpart here), and of the 65 rows the Sky-zone gate
// admits, ZERO share a name with another. So page identity and name identity coincide, and the
// two are not being conflated by luck: `page` is what the dedupe keys on, which is the reading
// that stays correct the day the catalog does grow a second page for one name — it would draw two
// cards, each with its own level and its own drop list, rather than silently merging two mobs.
// The measurement is pinned in tests/skyTargets.test.mts so it cannot rot in silence.

import { itemCountKey, normalizeItemName } from '../../lib/itemName'
import { everTurnedIn } from './questCompletion'
import {
  dropperNameOrder,
  isRandomDropWho,
  islandNumber,
  islandOf,
  mergeDroppers,
  type DropperMob
} from './poskyDroppers'
// The mob-island overlay (JOS-415). It applies to the MOB card only — a `NeededItem`'s islands
// stay the items' own, because that list really is about where the item drops.
import { mobIslands } from './skyMobIslands'

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
  /** distinct needed items this mob drops — the tiebreak inside an island, always `items.length` */
  covers: number
  /** every island this mob's outstanding drops are stated to be on, island-number order */
  islands: string[]
  /**
   * THE PRIMARY SORT KEY: the lowest island `islands` states, or null when it states none. The
   * lowest rather than the whole list because the order is a WALK — a mob whose outstanding drops
   * span islands 3 and 5 is met on 3 — and null rather than a stand-in number because "the data
   * does not say" is an answer this tab prints out loud instead of guessing at (law 1).
   */
  island: string | null
  items: NeededItem[]
}

/** One island's worth of the list, in the order the pane draws it. */
export interface TargetIslandGroup {
  /** the island these cards share, or null for the ones the data places nowhere */
  island: string | null
  mobs: TargetMob[]
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

/** The ordering the tab had before JOS-423, kept EXACTLY as it was and demoted to the tiebreak:
 *  inside one island, the mob that closes the most of what is left still leads, ties by name. */
const countedOrder = (a: TargetMob, b: TargetMob): number =>
  a.covers === b.covers ? dropperNameOrder(a.mob, b.mob) : b.covers - a.covers

/** Where an unstated island sorts: after every real one, at any island number the data grows. */
const UNSTATED_ISLAND_RANK = Number.POSITIVE_INFINITY

const islandRank = (t: TargetMob): number =>
  t.island === null ? UNSTATED_ISLAND_RANK : islandNumber(t.island)

/** WALK ORDER: island ascending, unstated last, and the counted order inside each island. */
const byIslandThenCounted = (a: TargetMob, b: TargetMob): number => {
  const ai = islandRank(a)
  const bi = islandRank(b)
  return ai === bi ? countedOrder(a, b) : ai - bi
}

/**
 * The sorted card list cut into its islands, for a pane that draws a heading per island.
 *
 * A pure run-length split over an ALREADY-SORTED array rather than a second grouping pass with a
 * second opinion about order: the flat `mobs` array stays the one truth about sequence (it is also
 * what the tab label counts), and this can only ever agree with it. Feed it anything else and it
 * will happily emit two groups for one island — the input contract is `skyTargets().mobs`.
 */
export function groupTargetsByIsland(mobs: readonly TargetMob[]): TargetIslandGroup[] {
  const groups: TargetIslandGroup[] = []
  for (const t of mobs) {
    const last = groups.at(-1)
    if (last?.island === t.island) last.mobs.push(t)
    else groups.push({ island: t.island, mobs: [t] })
  }
  return groups
}

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
  // THE UNION, NOT THE FIRST ANSWER (JOS-417). Two quests wanting the same counting key resolve
  // droppers SEPARATELY, and `skyDroppersFor` reads each row's own `who` as its layer 1 — so the
  // two lists are only guaranteed equal while layer 1 stays silent, which is a measurement about
  // today's scrape (poskyDroppers' header: nine values, none of them a mob name) and not an
  // invariant. First-wins would make the card set depend on which quest folded first the day that
  // measurement changes. `mergeDroppers` is the module's own union, deduped by page.
  agg.droppers =
    agg.droppers.length === 0 ? it.droppers : mergeDroppers(agg.droppers, it.droppers)
  const island = islandOf(it.where)
  if (island !== undefined) agg.islands.add(island)
  agg.quests.push({ className: q.className, questName: q.name, need: it.need })
  byKey.set(key, agg)
}

/** Everything the need set says, per counting key. The one membership filter is HERE. */
function accumulateNeeds(
  quests: readonly TargetsQuest[],
  firstTimeOnly: boolean
): Map<string, ItemAgg> {
  const byKey = new Map<string, ItemAgg>()
  for (const q of quests) {
    if (firstTimeOnly && everTurnedIn(q)) continue
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

/**
 * The Targets model, from the quests the user can see.
 *
 * `firstTimeOnly` (default true — the header argues it) is the ONE knob and it reaches nothing but
 * which quests enter the fold: a quest you have already handed in still wants its items back, and
 * a refarmer unticking the box gets exactly the same arithmetic over a wider need set. It is the
 * Ready tab's toggle (JOS-155) with the same default and the same meaning, deliberately, so a
 * player only has to learn the rule once.
 */
export function skyTargets(
  quests: readonly TargetsQuest[],
  firstTimeOnly = true
): SkyTargetsModel {
  const mobsByPage = new Map<string, MobAcc>()
  const randomDrop: NeededItem[] = []
  const unsourced: NeededItem[] = []
  for (const agg of accumulateNeeds(quests, firstTimeOnly).values()) {
    const needed = toNeeded(agg)
    if (needed === null) continue
    if (agg.droppers.length > 0) foldIntoMobs(mobsByPage, needed, agg.droppers)
    else if (agg.isRandom) randomDrop.push(needed)
    else unsourced.push(needed)
  }
  const mobs: TargetMob[] = [...mobsByPage.values()]
    .map((e) => {
      // Through the mob-island overlay (JOS-415) BEFORE the sort, which is what makes the walk
      // order right as well as the caption: `island` is this list's head, so a card corrected to
      // island 2 has to move to island 2's heading, not merely relabel itself under island 7.
      const islands = sortIslands(new Set(mobIslands(e.mob.page, [...e.islands])))
      return {
        mob: e.mob,
        covers: e.items.length,
        islands,
        island: islands[0] ?? null,
        items: [...e.items].sort(byItemName)
      }
    })
    .sort(byIslandThenCounted)
  randomDrop.sort(byItemName)
  unsourced.sort(byItemName)
  return { mobs, randomDrop, unsourced }
}
