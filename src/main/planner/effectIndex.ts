// planner/effectIndex.ts — the committed item corpus → the two indices the Exaltation Planner
// serves over IPC (docs/plans/exaltation-planner.md §4.1):
//
//   * DONORS — one row per (item, effect): "Ghoulbane carries Nullify Undead, it is a proc, and
//     the item must be merged to +4 before that proc can be extracted."
//   * ITEMS  — one searchable row per item, effect-bearing or not, for the Board's HOST picker
//     ("which sword am I socketing this into"), with the precomputed lowercase `searchKey` the
//     standing search law asks for.
//
// PURE and ELECTRON-FREE on purpose (the mobSearch precedent, now repo-wide): value imports are
// RELATIVE, nothing here reads a file, and `tests/plannerEffectIndex.test.mts` runs the shipped
// builder over the REAL committed bytes. The ITEM corpus is imported by the IPC handler rather
// than here, so a test pays for its 8.6 MB only when it wants it; the SPELL corpus (0.8 MB, V6's
// one-liners) is imported here, because unlike the items it has no other caller to pass it in and
// a builder that only describes its rows when someone remembers to hand it the DB would ship a
// silent, untestable regression.
//
// D1 — why MAIN: items.json is already inlined into main's bundle for itemLookup. Importing it
// into the renderer as well would double it; the effect-bearing subset is ~1.5k rows, which is a
// few hundred KB over IPC, fetched once.
//
// TWO DEDUPES, MEASURED 2026-08-04 against the committed corpus (11,351 keys / 11,155 pages):
//   1. ALIAS KEYS. A page contributes up to two keys — its title and its `|itemname` when they
//      differ (196 of them). Walking `items` naively would emit every effect on those pages
//      twice. Skipped by PAGE identity.
//   2. DUPLICATE PAGES FOR ONE ITEM — which the brief did not predict and the data does. Six
//      effect-bearing item names are written up on more than one page: apostrophe variants
//      ("10 Dose Ethiras Poison Antidote" beside "10 Dose Ethira's Poison Antidote",
//      "Packmasters Lash"), the four elemental "Holgresh Mojo Stick (Air/Earth/Fire/Water)"
//      pages, and a guide page whose `|itemname` IS an item ("Nyrod's Guide to Thurgadin Gate
//      Pots" → Vial of Velium Vapors). Three of those produce a genuinely duplicate
//      (key, effect, socket) row. The row identity is that triple, so the second one is dropped
//      — and when the pages disagree (they do: Casting Time 2.0 vs 4.0, a `Req Level` on one
//      side only), the ITEM'S OWN PAGE wins over the variant, decided by `canonical` below and
//      never by which key the JSON happened to list first.
//
// Everything the rows say about slots, classes, sockets, tiers and haste is read out of the
// shared planner modules — this file measures the corpus, it never re-states a rule.
//
// WIKI DROP SOURCES ride along on every donor row (`wikiSources`, from the item page's own
// `|dropsfrom`). They are the SECOND witness to "where does this drop": the renderer already
// inverts the mob catalog's `|known_loot`, and the two sides of the wiki omit different things —
// measured 2026-08-04, 126 effect-bearing donors are neither quest nor crafted and have no
// catalog source at all, and 43 of those name a zone on their own page. Serving both and joining
// them at the consumer is the honest arrangement; this file never merges or ranks them.
//
// THE PAGE'S ERA BANNER rides along the same way (`eraTag`, the `{{Velious Era}}` token). It is
// the last-resort witness for the donors neither source places — 94 of those 126 carry one — and
// like `wikiSources` it is carried VERBATIM: `shared/planner/era.ts` is the only file that decides
// what a token means, and the renderer is the only place the two witnesses are folded together.
//
// EVERY DONOR ROW ALSO STATES WHAT ITS EFFECT DOES (V6): the committed spell DB joined by
// case-folded effect name, three fields (`spellType` / `spellTarget` / `spellDuration`) carried
// VERBATIM and composed into one line by the renderer. Measured 2026-08-05 over the shipped
// corpus: 94.2% of effect rows match. The rest carry nothing — no placeholder and no fuzzy second
// pass (law 12), because the misses are mostly the client's own annotated spellings
// (`Healing  as Level 30`) and a matcher that stripped those would eventually state the wrong
// spell's duration as fact. `buildSpellFacts` below is the whole join.
//
// THE CURATED LAYER ALSO REPAIRS THE ONE PARSE GAP THE CORPUS HAS (JOS-67): three pages state
// their equip slot on an unkeyed stats-block line, which the scrape files under `flags`, and a
// slotless donor can never be socketed anywhere (R2). `slotsOf` below is the whole seam — see
// itemsResearch.ts's `slots` table for why it is a filed fact per page and not a matcher.
//
// TWO KINDS OF ITEM ARE DROPPED FROM THE DONOR INDEX AND ONLY FROM IT (V9, docs/plans/planner-v2
// .md): the mage-conjured `Summoned:` family and whatever the curated layer flags `summoned` or
// calls unfarmable (`gmEvent` / `gmOnly`). They stay in the ITEM index — a summoned item is a perfectly real thing to look up,
// and "you cannot pull an effect off this" is not "this does not exist". See `excludedDonor`.

import { itemKey, type ItemDbEntry, type ItemDbFile } from '../itemsDb'
import { renamedItems } from '../../shared/itemRenames'
// The committed spell DB, for V6's one-liners. Imported here rather than injected from the
// handler for the same reason the curated research layer is (below): it is committed data with
// one right answer, and a builder that only gets its facts when a caller remembers to pass them
// would ship a browser whose rows say nothing and no test that could tell.
import spellsJson from '../data/spells.json'
import {
  ITEMS_RESEARCH,
  isUnfarmable,
  knowledgeWithResearch,
  type ItemResearchFile,
  type ResearchedKnowledge
} from '../itemsResearch'
import {
  isHasteEffect,
  normalizeClasses,
  normalizeSlotTokens,
  parseFocusEffect,
  socketTypeOf
} from '../../shared/planner/normalize'
import { extractionTier } from '../../shared/planner/rules'
import type { EffectFacts } from '../../shared/planner/effectText'
import type { ClassAbbr } from '../../shared/classCombo'
import type { ItemEffect } from '../../shared/itemStats'
import type { ItemDropSource, SpellDbFile, SpellEntry } from '../../shared/types'
import type {
  EquipSlot,
  PlannerDonor,
  PlannerItemHit,
  SocketType
} from '../../shared/planner/types'

/** A host-picker row plus its precomputed lowercase name — computed once per build, not per keystroke. */
export interface PlannerItemRow extends PlannerItemHit {
  searchKey: string
}

/**
 * What the build SAW. Kept because the corpus is the thing under test: the floors in
 * `tests/plannerEffectIndex.test.mts` are assertions about these numbers, and `unknownSlotTokens`
 * must stay empty — a rescrape that invents a slot spelling turns the suite red instead of
 * silently dropping items out of the planner (law 1).
 */
export interface PlannerBuildStats {
  /** distinct item PAGES walked */
  pages: number
  /** `|itemname` alias keys skipped because their page was already read */
  aliasKeys: number
  /** pages whose stats block stated at least one effect */
  effectPages: number
  /** effect lines read across those pages */
  effectRows: number
  /** effect lines whose socket the wiki did not state (a bare `Effect:` — excluded, D2/§3.2) */
  socketless: number
  /** rows dropped because another page already stated the same (key, effect, socket) */
  duplicateRows: number
  /** effect-bearing pages whose effects were not emitted at all (V9 — see `excludedDonor`) */
  excludedPages: number
  /** V6 — emitted donor rows whose effect name matched a spell page (the one-liner join) */
  spellJoined: number
  /** slot tokens `normalizeSlotTokens` did not recognize, verbatim */
  unknownSlotTokens: string[]
}

export interface PlannerIndex {
  donors: PlannerDonor[]
  items: PlannerItemRow[]
  stats: PlannerBuildStats
}

/** Everything about one item page that every effect on it shares. */
interface PageCtx {
  key: string
  name: string
  iconId?: number
  slots: EquipSlot[]
  classes: ClassAbbr[]
  quest: boolean
  playerCrafted: boolean
  /** what the item page's `|dropsfrom` stated; absent when it carried none */
  wikiSources?: ItemDropSource[]
  /** the page-top `{{X Era}}` banner's token; absent when the page opened with none */
  eraTag?: string
  /** the page TITLE keys to the item name — this is the item's own page, not a variant of it */
  canonical: boolean
  /** nothing on this item can be donated (V9) — its effects are counted and never emitted */
  excluded: boolean
}

interface Acc {
  seenPages: Set<string>
  /** `${key}\0${effect}\0${socket}` → row */
  donors: Map<string, PlannerDonor>
  donorFromCanonical: Set<string>
  items: Map<string, PlannerItemRow>
  itemFromCanonical: Set<string>
  unknownSlots: Set<string>
  stats: Omit<PlannerBuildStats, 'unknownSlotTokens'>
}

function newAcc(): Acc {
  return {
    seenPages: new Set(),
    donors: new Map(),
    donorFromCanonical: new Set(),
    items: new Map(),
    itemFromCanonical: new Set(),
    unknownSlots: new Set(),
    stats: {
      pages: 0,
      aliasKeys: 0,
      effectPages: 0,
      effectRows: 0,
      socketless: 0,
      duplicateRows: 0,
      excludedPages: 0,
      spellJoined: 0
    }
  }
}

// ---- V6: the effect one-liner join ---------------------------------------------------

/** The spell-DB facts an effect row can borrow, keyed by CASE-FOLDED spell name. */
export type SpellFactsIndex = ReadonlyMap<string, EffectFacts>

/**
 * `spells.json` → the one-liner lookup. Case-folded exact names, FIRST entry wins.
 *
 * First-wins matters because rank siblings ("Rune II"…"Rune V") are separate spell pages with
 * separate names — they do not collide — but a handful of pages genuinely repeat a name, and the
 * corpus order is the scrape order, which is the wiki's. Picking by anything else would be
 * inventing a preference between two pages that state the same thing.
 *
 * Rank suffixes are NOT stripped, unlike the parser's `canonKey`: an item's `Effect:` line names
 * the exact spell it carries, so "Improved Healing III" must join "Improved Healing III" or miss.
 * Folding ranks together here would let a I row claim a III row's duration.
 */
export function buildSpellFacts(spells: readonly SpellEntry[]): SpellFactsIndex {
  const out = new Map<string, EffectFacts>()
  for (const s of spells) {
    const key = s.name.trim().toLowerCase()
    if (key === '' || out.has(key)) continue
    out.set(key, { spellType: s.spellType, spellTarget: s.targetType, spellDuration: s.durationText })
  }
  return out
}

/**
 * The committed join, built once for this process (the corpus cannot change while it runs).
 *
 * EXPORTED because the gear index (JOS-283, `gearIndex.ts`) states the same one-liners on its own
 * effect rows, and a second `buildSpellFacts` call there would be a second answer to "which spell
 * page does this effect name join" — one home, one first-wins ordering.
 */
export const COMMITTED_SPELL_FACTS: SpellFactsIndex = buildSpellFacts(
  (spellsJson as SpellDbFile).spells
)
const SPELL_FACTS = COMMITTED_SPELL_FACTS

/**
 * The `Summoned:` NAME PREFIX — the one automatic exclusion rule (V9), and it is not an inference:
 * it is the item's own name, the same string the wiki titles the page with and the game prints in
 * a loot line. 90 pages in the committed corpus carry it, 39 of them effect-bearing.
 */
const SUMMONED_PREFIX = /^summoned:/i

/**
 * Can anything on this item be donated at all?
 *
 * TWO WITNESSES, no heuristics between them: the name prefix above, and the curated layer
 * (`itemsResearch.ts`) — its `summoned` flag, plus `isUnfarmable()`, which is that file's own
 * verdict over its GM-provenance flags (`gmEvent`, and since JOS-64 `gmOnly`; the owner ruled the
 * two mean the same thing to a planner). Neither witness is a guess about an item's stats, and the
 * GM half is asked as ONE question so a flag added there can never be forgotten here.
 *
 * R7 — summoned items cannot donate — is OWNER-OBSERVED and unverified in any published source:
 * integrator research 2026-08-05 found the eqlwiki Exaltations page, the 7/14 patch notes and the
 * eqlegends.wiki guide all silent on it, in both directions. Excluding them anyway is the
 * conservative error: wrongly hiding a handful of donors is recoverable the moment R7 is settled,
 * wrongly listing them puts unfarmable rows in a farm plan and costs the browser its trust. The
 * decisive test is in-game and takes 30 seconds (attempt a merge of two identical summoned items).
 */
function excludedDonor(name: string, research: ResearchedKnowledge['research']): boolean {
  if (SUMMONED_PREFIX.test(name)) return true
  return research?.summoned === true || isUnfarmable(research)
}

/**
 * WHICH SLOTS THIS ITEM OCCUPIES — the scrape's answer, or the curated one where the layer speaks.
 *
 * JOS-67. `shared/itemStats.ts applySlot` only fills `stats.slot` from a `Slot:` KEY, and three
 * committed pages write their slot line unkeyed ("…Race: ALL\n\nPrimary Secondary"), so the line
 * lands in `flags` and the item arrives here slotless. Slotless means "can never donate" under R2,
 * which is how the Golem Metal Wand's click went missing from the browser (feedback
 * 01KZCGXY8WC6YCD8W44W7EAS5H). `itemsResearch.ts` files those three by hand, with the page's own
 * words as the source, and the entry REPLACES the scraped list rather than merging with it — see
 * the field's doc. Nothing here matches on a flag: the layer is the only thing entitled to say a
 * page states a slot the parser could not key.
 *
 * EXPORTED for the gear index (JOS-283), which decides what "equippable" means by asking exactly
 * this question. Two callers, one seam — a second copy of this precedence would let the two
 * indices disagree about which items exist.
 */
export function slotsOf(k: ResearchedKnowledge, scraped: readonly EquipSlot[]): EquipSlot[] {
  const curated = k.research?.slots
  return curated === undefined ? [...scraped] : [...curated]
}

/**
 * One stored record → the page context. `knowledgeWithResearch` restores the fields the compact
 * record omits and lays the curated layer over the result, so the name (and therefore the key) is
 * the in-game `|itemname` when the page states one — which is what a loot line spells, and what
 * the rest of the app already keys items by.
 */
function pageContext(
  entry: ItemDbEntry,
  research: ItemResearchFile
): {
  ctx: PageCtx
  effects: ItemEffect[]
  unknown: string[]
} {
  const k = knowledgeWithResearch(entry, research)
  const slot = normalizeSlotTokens(k.stats?.slot)
  const key = itemKey(k.name)
  return {
    ctx: {
      key,
      name: k.name,
      iconId: k.iconId,
      slots: slotsOf(k, slot.slots),
      classes: normalizeClasses(k.stats?.classes),
      quest: k.quest,
      playerCrafted: k.playerCrafted ?? false,
      // Carried through verbatim, not merged with the renderer's catalog index: the two are
      // independent witnesses and the join belongs where both are in hand (design §4.2).
      wikiSources: k.dropsFrom,
      eraTag: k.eraTag,
      canonical: itemKey(entry.page) === key,
      excluded: excludedDonor(k.name, k.research)
    },
    effects: k.stats?.effects ?? [],
    unknown: slot.unknown
  }
}

function donorRow(
  ctx: PageCtx,
  effect: ItemEffect,
  socket: SocketType,
  spells: SpellFactsIndex
): PlannerDonor {
  // V5 — split once, here, and only for focus: the browser groups the focus tab by family and
  // sorts tier-desc inside it, and re-parsing the name per render per row would be the same answer
  // computed a thousand times. A non-focus row carries neither field (law 1: no family stated).
  const rank = socket === 'focus' ? parseFocusEffect(effect.name) : null
  // V6 — spread wholesale: a miss contributes NOTHING (the three keys stay absent), which is what
  // makes "the row simply says less" the shape of the failure rather than a placeholder.
  const facts = spells.get(effect.name.trim().toLowerCase()) ?? {}
  return {
    ...facts,
    key: ctx.key,
    name: ctx.name,
    iconId: ctx.iconId,
    slots: [...ctx.slots],
    classes: [...ctx.classes],
    effect: effect.name,
    detail: effect.detail,
    family: rank?.family,
    familyTier: rank?.tier,
    socket,
    tierRequired: extractionTier(socket),
    hasteLocked: isHasteEffect(effect.name, effect.detail),
    quest: ctx.quest,
    playerCrafted: ctx.playerCrafted,
    reqLevel: effect.reqLevel,
    // Copied per row (donors are denormalized by effect) so a consumer never has to hold a
    // second index to answer "where does this one drop".
    wikiSources: ctx.wikiSources ? ctx.wikiSources.map((s) => ({ ...s })) : undefined,
    eraTag: ctx.eraTag
  }
}

/**
 * Keep at most one row per (key, effect, socket). A later duplicate wins ONLY when it comes from
 * the item's own page and the row already held does not — see dedupe 2 in the header.
 */
function rememberDonor(acc: Acc, ctx: PageCtx, row: PlannerDonor): void {
  // NUL-joined: effect names contain spaces, so a printable separator would let two different
  // (key, effect) pairs share one identity.
  const id = `${row.key}\u0000${row.effect}\u0000${row.socket}`
  if (acc.donors.has(id)) {
    acc.stats.duplicateRows++
    if (!ctx.canonical || acc.donorFromCanonical.has(id)) return
  }
  acc.donors.set(id, row)
  if (ctx.canonical) acc.donorFromCanonical.add(id)
}

/** Same rule for the host-picker index: one row per item key, the item's own page preferred. */
function rememberItem(acc: Acc, ctx: PageCtx): void {
  if (acc.items.has(ctx.key) && (!ctx.canonical || acc.itemFromCanonical.has(ctx.key))) return
  acc.items.set(ctx.key, {
    key: ctx.key,
    name: ctx.name,
    iconId: ctx.iconId,
    slots: [...ctx.slots],
    classes: [...ctx.classes],
    searchKey: ctx.name.toLowerCase()
  })
  if (ctx.canonical) acc.itemFromCanonical.add(ctx.key)
}

function addPage(
  acc: Acc,
  entry: ItemDbEntry,
  research: ItemResearchFile,
  spells: SpellFactsIndex
): void {
  if (acc.seenPages.has(entry.page)) {
    acc.stats.aliasKeys++
    return
  }
  acc.seenPages.add(entry.page)
  acc.stats.pages++

  const { ctx, effects, unknown } = pageContext(entry, research)
  for (const token of unknown) acc.unknownSlots.add(token)
  // The ITEM index takes every page, excluded or not: the host picker and the lookup are asking a
  // different question than the donor list is.
  rememberItem(acc, ctx)
  if (effects.length === 0) return
  if (ctx.excluded) {
    acc.stats.excludedPages++
    return
  }

  acc.stats.effectPages++
  for (const effect of effects) {
    acc.stats.effectRows++
    const socket = socketTypeOf(effect.kind)
    // A bare `Effect:` whose parenthetical named no socket: the wiki did not say where it goes,
    // and guessing would put an unextractable effect on a farm list. Counted, never emitted.
    if (socket === null) acc.stats.socketless++
    else rememberDonor(acc, ctx, donorRow(ctx, effect, socket, spells))
  }
}

/**
 * The committed file → both indices in ONE pass. The curated layer defaults to the committed one
 * and is injectable so a test can drive the exclusion path from a fixture.
 */
export function buildPlannerIndex(
  file: ItemDbFile,
  research: ItemResearchFile = ITEMS_RESEARCH,
  spells: SpellFactsIndex = SPELL_FACTS
): PlannerIndex {
  const acc = newAcc()
  // Through the rename overlay (JOS-415), so a donor's row carries the name the wiki uses now.
  // The alias key it adds costs nothing here: `addPage` already dedupes by `entry.page`, which is
  // exactly the mechanism items.json's own two-keys-per-page shape relies on.
  for (const entry of Object.values(renamedItems(file.items ?? {}))) addPage(acc, entry, research, spells)
  const donors = [...acc.donors.values()]
  return {
    donors,
    items: [...acc.items.values()],
    stats: {
      ...acc.stats,
      // Counted on the EMITTED rows, after both dedupes: the join's usefulness is how many rows
      // the browser can actually describe, not how many times the lookup was consulted.
      spellJoined: donors.filter((d) => d.spellType !== undefined || d.spellDuration !== undefined).length,
      unknownSlotTokens: [...acc.unknownSlots]
    }
  }
}

/** The donor rows alone — the shape `IPC.plannerDonors` serves. */
export function buildPlannerDonors(file: ItemDbFile): PlannerDonor[] {
  return buildPlannerIndex(file).donors
}

/** How many host-picker hits one search may return. Named so the handler and the UI agree. */
export const PLANNER_SEARCH_LIMIT = 50

/**
 * Substring search over item names for the host picker.
 *
 * Ranking, in order: names that START with the query first (typing "ghoul" wants Ghoulbane before
 * "Amulet of the Ghoul"), then the SHORTEST name (the plain item before its variants), then
 * alphabetical so the list never reshuffles between two equally-good hits. Capped at `limit`.
 *
 * Deliberately substring, not fuzzy (law 12): this picks a real item by the name the user is
 * typing; a fuzzy matcher would happily offer a different item that reads nearly the same.
 */
export function searchPlannerItems(
  index: readonly PlannerItemRow[],
  query: string,
  limit: number = PLANNER_SEARCH_LIMIT
): PlannerItemHit[] {
  const q = query.trim().toLowerCase()
  if (q === '') return []
  const hits: { row: PlannerItemRow; rank: number }[] = []
  for (const row of index) {
    const at = row.searchKey.indexOf(q)
    if (at >= 0) hits.push({ row, rank: at === 0 ? 0 : 1 })
  }
  hits.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.row.name.length - b.row.name.length ||
      a.row.searchKey.localeCompare(b.row.searchKey)
  )
  return hits.slice(0, Math.max(0, limit)).map(({ row }) => ({
    key: row.key,
    name: row.name,
    iconId: row.iconId,
    slots: row.slots,
    classes: row.classes
  }))
}
