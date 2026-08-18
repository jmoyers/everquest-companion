// itemLookupParse.ts — the PURE wikitext → ItemKnowledge parsing for Task #53.
//
// Split out from itemLookup.ts (which imports electron `app` for the userData cache) so
// the classification core is importable in the node test runner with NO electron
// dependency. Unit-tested in tests/itemLookup.test.mts against verbatim real wikitext.
//
// The wiki's item pages use a {{Itempage}} template. Fields ACTUALLY present (verified
// 2026-08-02 against Template:Itempage plus a dozen real pages — Red Dragonscale Armor,
// Djarn's Amethyst Ring, Thelvorn Blade of Light, Ghoulbane, Fiery Avenger, Earthshaker,
// Cloak of Flames, Golden Efreeti Boots, Boots of the Long Road, Skycleaver, Sharp Claws,
// Sabertooth Short Bow):
//   |itemname      = display name
//   |lucy_img_ID   = icon id → File:Item <id>.png on the wiki
//   |statsblock    = the in-game item window's text, <br>-separated (flags, Slot,
//                    Class/Race, AC/HP/attributes, SV *, WT/Size, Skill/Atk Delay/DMG,
//                    `Effect:` / `Combat Effect:` / `Click Effect:` lines)
//   |focus_effect  = a focus effect name, OUTSIDE the stats block ("Spell Haste II")
//   |relatedquests = * [[Quest Page|Label]] …   (bulleted link list)
//   |dropsfrom     = zone heading + * [[mob]] bullets (PARSED — see the census below)
//   |notes         = freeform prose (lore, quirks) — our one-line summary
//   |recipes       = recipes that CONSUME this item (see shapes below)
//   |playercrafted = how this item is itself made (see shapes below)
//   |merchant_value, |soldby, |bookcontents, |foraged,
//   |second_image / |third_image  (present in the template; not consumed here)
//
// One piece of knowledge lives OUTSIDE the template: the page-top `{{Velious Era}}` banner that
// 7,448 of the 11,288 item pages open with. It is read too (`parseEraTag`, censused there), and so
// are the two places the other 44 era-stating pages put it instead — a banner in the page BODY and
// a hand-written `[[Category:X Era]]` (`parseEraBodyTag` / `parseEraCategory`, JOS-328, whose
// census also records what the owner's out-of-era badge report actually turned out to be).
//
// TRADESKILL FIELDS — the "QUEST ITEM flag but no quest anywhere" gap. Plenty of items
// carry `QUEST ITEM` in their stats block yet appear in NO quest on the whole wiki: they
// are tradeskill INGREDIENTS, and the item page says so in `|recipes`. Shapes verified
// 2026-08-02 against Gnome Meat, Troll Parts, Spider Legs, Skewers (the one page carrying
// BOTH fields), Gnome Kabobs, Pickled Troll, Fine Steel Long Sword (neither field):
//
//   |recipes  — a TWO-LEVEL bullet list, `*` tradeskill heading / `**` recipe entry, the
//               trivial stated on the recipe line. Spider Legs, verbatim:
//                   * [[Brewing]]
//                   ** [[Gnomish Spirits]] (Trivial: 102)
//                   ** [[Halas Heater]] (Trivial: 135)
//                   * [[Baking]]
//                   ** [[Wooly Spider Crunchies]] (Trivial: 46)
//               → recipes[] = {recipe, tradeskill, trivial, page when the link was piped}.
//
//   |playercrafted — one `*` block PER RECIPE (Skewers has two: Blacksmithing 38 and
//               Pottery 17), the trivial on the TRADESKILL line, then `**` yield + `**` In
//               <container>, then `::` ingredient rows. Gnome Kabobs, verbatim:
//                   * [[Baking]] (Trivial: 56)
//                   ** '''Yield: Gnome Kabobs''' x2
//                   ** In [[Oven]]:
//                   :: {{SmIcon|817}} 1 x [[Gnome Meat]] - Dropped
//                   :: {{SmIcon|1012}} 1 x [[Skewers]] - Crafted, Returned on Failure, …
//               → craftedBy[] = {tradeskill, trivial, container, yieldItem, yieldQty,
//                 ingredients[{name, qty, sources}]}; `{{SmIcon|nnn}}` is dropped.
//
// A bullet WITHOUT a [[link]] is the freeform shape and is never structured — Coin of Tash
// writes `|playercrafted = * Non-Tradeskill (Quest)`, which means "not a tradeskill at all".
// Those fall through to the `cleanSummary` prose fallback (`recipesNote`/`craftedNote`) and
// deliberately leave `playerCrafted` unset: claiming a craft we didn't read would be
// inventing (world-model law 1).
// NOT present anywhere on item pages: tier/item-level state, exaltation socket contents,
// or upgrade progress. Those are per-INSTANCE and the wiki only documents base items.
// (One stray exception: Boots of the Long Road hand-writes `Slot: Ornamentation: empty`
// inside its stats block; the parser understands that shape when a page has it.)
//
// ===========================================================================
// RESEARCH — the item upgrade (tier) + exaltation mechanic
// Sources: eqlwiki.com pages "Item Upgrade System", "Exaltations", "Mote Guide",
// "Marketplace", "Patch Notes" (read 2026-08-02), PLUS — for the stat arithmetic, and
// overruling the prose pages on it — the wiki's own ItemLevelSlider ResourceLoader module
// (`load.php?modules=ext.itemLevelSlider`, extracted 2026-08-13). Everything below is
// quoted mechanics, not inference; anything the wiki doesn't say is deliberately absent.
//
// TIERS ("item level"). All gear starts at tier 0 and can reach tier 10. You raise it by
// MERGING: consume another copy of the same item, or a Mote of Potential, to add item
// EXP. Merged gear at tier T is worth 2^T exp (tier 0 = 1, tier 7 = 128); reaching tier
// T+1 costs 2^T exp, so total exp for tier T is 2^T − 1. The in-game window's
// "Tier N   x / y" row is exactly (exp banked toward the next tier) / (2^N) — which is
// why the screenshots read "Tier 1  0 / 2" and "Tier 7  3 / 128".
//
//   STAT EFFECT — CORRECTED 2026-08-13 (JOS-281). What stood here was read off the wiki's
//   PROSE pages and was wrong three ways: it claimed one flat "+10% per tier, rounded DOWN"
//   for every stat, a separate "+1 minimum increase per tier" floor rule, and "+5%/tier" for
//   weapon DAMAGE. The authority is not the prose — it is the wiki's OWN CALCULATOR, the
//   ItemLevelSlider module every item page runs when a reader drags the level slider. That
//   algorithm is ported exactly (rounding, branches and all) in `src/shared/itemUpgrade.ts`;
//   read that file's header for the rules and tests/itemUpgrade.test.mts for the numbers.
//   In brief:
//     - the state is a `full` tier plus a `fraction` out of 2^full, so a mid-tier item
//       scales by a FRACTIONAL level — there is no separate "partial bonus" term;
//     - a PRIMARY stat (AC, the seven attributes, HP/MP/END, every SV) at base > 10 is
//       floor(base + round(base * effective / 10)): the increment rounds HALF-AWAY-FROM-ZERO
//       BEFORE it is added and the SUM is floored (WIS 15 at tier 2+3/4 is 19, not 20). At
//       base 1..10 it is simply base + tier with the FRACTION IGNORED — that branch is what
//       the old "+1 minimum" note was actually describing, and it is a branch, never a floor
//       laid over a percentage. A NEGATIVE stat shrinks toward zero by the tier and stops at 0;
//     - weapon DAMAGE is base + floor(base * effective / 10) — +10% per level, NOT +5%
//       (Thelvorn at tier 2+3/4 reads DMG 25; +5%/tier would say 22, and the screenshot
//       says 25). Weapon DELAY never scales, which is where the ratio gain comes from;
//     - WEIGHT shrinks on a log curve in total progression and is CEILED to one decimal.
//       The old "never below 0.1" was an ENTRY GUARD misread as an output clamp: an item
//       already at or under 0.1 is not touched at all, and the output clamps at 0;
//     - an upgraded item with two or more attribute/save fields also gains a synthetic
//       `SV VOID: +tier` line.
//   `tierBonusPct` (shared/itemStats.ts) survives all of this as the window's LABEL only —
//   the "+N% stats" headline — and is not arithmetic any individual stat goes through.
//   The upgraded item's DISPLAY NAME carries the tier as a ` +N` suffix ("Cloak of
//   Flames +4"), which is the only tier signal that ever reaches the log.
//
//   DEAD DATA: the wiki page `MediaWiki:ItemLevelMultipliers` ({1:1.3, 2:1.6, …}) is loaded
//   by nothing, contradicts the real progression, and must not be ported.
//
// EXALTATIONS (the "slot rows" that vary between screenshots). Every item has exaltation
// SOCKETS whose count is set by its item level, unlocking progressively:
//   +0 Ornamentation · +1 Focus · +2 Click · +3 Worn · +4 Proc
// so a base item shows one socket row and a +4-or-better item shows all five — that is
// the whole reason the Tier 1 window has 2 rows and the Tier 7 window has 5.
// An exaltation is a transferable effect: level an item to the tier that unlocks its
// effect type, and that effect becomes a removable object (named "<Source Item>
// (Exaltation)") which can be pulled out and socketed into a different item. The source
// item LOSES the effect while it's moved. Ornamentation is the odd one out — it is
// cosmetic and is created with an Armor/Weapon Ornamentation Token from the Marketplace
// rather than by leveling. Exaltations carry their source item's CLASS and SLOT
// restrictions and intersect them onto the host item (a 2H proc makes the host
// primary-only; a WAR/PAL/RNG/SHD proc removes ROG/BRD from a 6-class sword).
// Sockets survive loadout swaps (the exact exaltation is restored per loadout).
//
// WHAT THIS MEANS FOR US (law 1 — never invent): the wiki gives BASE item data only. We
// therefore render the tier row ONLY when the observed item NAME carries ` +N`, we never
// draw an exp progress bar (x is unobservable — no log line reports item exp), and we
// never emit "Ornamentation: empty" style socket rows for an item whose sockets we have
// not actually read. What a +N name DOES justify is listing which socket TYPES are
// unlocked at that level, since that is a documented rule of the level, not a claim
// about the instance.
//
// LOG REALITY (full-log sweep, read-only). The complete merge/upgrade/mote/exaltation line
// inventory now lives beside the regexes in main/log/parser.ts; in summary:
//   `You have successfully merged two items together to create a new item: <Name>` (236×)
//        — the upgrade event itself. PARSED (Task #60) as `itemMerge`; 159 name a ` +N`
//        item level, 77 name a Roman SPELL rank instead (the same line covers scroll
//        merges) and claim no tier.
//   `Your request to merge <A> with <B> failed. …` (4×) — PARSED as `itemMergeFailed`
//        ('mismatch'); the only failure shape that names items, and `<A>` carries its tier.
//   `The item you are trying to add will not work, this mote is not sufficiently powerful
//        to upgrade this item.` (9×) / `… you cannot fuse an item to itself.` (4×, the one
//        line in the family that never says "merge") / `… you cannot merge two different
//        types of items.` (1×) / `Request to merge items canceled, both items remain
//        unmodified.` (1×) — PARSED as `itemMergeFailed` with no item named.
//   `You looted <item> … to create a <item> +N` (302×) — auto-merge on pickup, already a
//        loot event (disposition 'combined' + `created`); the tier module folds it.
//   `Your <Item> (Exaltation) shimmers briefly.` (+3 sibling emotes, 6433× total)
//        — a socketed click/proc exaltation FIRING; names the SOURCE item, not the host,
//        and carries no tier. NOT parsed: it identifies nothing we can attribute.
//   `You successfully destroyed <N> <Item>[ +N].` (356×) — the item is gone. PARSED since
//        JOS-401 as a loot event with disposition 'destroyed', which is how held counts learn
//        about it; it still retires NO tier evidence, because a tier is a fact about an item
//        that was observed once and never a claim about current inventory.
// Nothing reports item exp, socket contents, or the tier of an item we merely hold — so
// the ItemWindow still draws tier POSITION only, never an exp fill, and observed tiers come
// exclusively from merge evidence (main/modules/itemTiers.ts).
// ===========================================================================

import type {
  ItemCraftRecipe,
  ItemDropSource,
  ItemKnowledge,
  ItemQuestUse,
  ItemRecipeUse
} from '../shared/types'
import { itemBaseName, parseStatsBlock, type ItemStatBlock } from '../shared/itemStats'
// The ONE question this parser asks the era tables: "is this a token you name?" — the guard on the
// category reader below. What a token MEANS is still decided only in shared/planner/era.ts.
import { namesEra } from '../shared/planner/era'

/** Strip a trailing ` +N` upgrade suffix. Applied before lookup + as the cache key. ONE
 *  definition of the rule for every main-side caller — see shared/itemStats.itemBaseName. */
export function normalizeItemName(name: string): string {
  return itemBaseName(name)
}

/** Extract a named `{{Itempage}}` template field's raw value (`|field = …`). */
export function templateField(wikitext: string, field: string): string | null {
  // Match `|field = <value>` up to the next top-level `|field2 =` or the template close.
  // Values can contain newlines and bullet lists.
  const re = new RegExp(
    `\\|\\s*${field}\\s*=([\\s\\S]*?)(?=\\n\\s*\\|\\s*[a-zA-Z_]+\\s*=|\\n\\s*\\}\\})`,
    'i'
  )
  const m = re.exec(wikitext)
  return m ? m[1].trim() : null
}

/** Parse the `* [[Page|Label]]` / `* [[Page]]` bullet links out of a relatedquests block. */
export function parseQuestLinks(block: string): ItemQuestUse[] {
  const uses: ItemQuestUse[] = []
  const linkRe = /\[\[([^\]]+?)\]\]/g
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(block)) !== null) {
    const inner = m[1].trim()
    const pipe = inner.indexOf('|')
    const page = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim()
    const label = (pipe >= 0 ? inner.slice(pipe + 1) : inner).trim()
    if (!label) continue
    if (!uses.some((u) => u.quest === label)) uses.push({ quest: label, page, source: 'wiki' })
  }
  return uses
}

// ---- tradeskill fields (`|recipes` / `|playercrafted`) -------------------------

/** First `[[Page]]` / `[[Page|Label]]` in a line, split into page + display label. */
function firstLink(s: string): { page: string; label: string } | null {
  const m = /\[\[([^\]]+?)\]\]/.exec(s)
  if (!m) return null
  const inner = m[1].trim()
  const pipe = inner.indexOf('|')
  const page = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim()
  const label = (pipe >= 0 ? inner.slice(pipe + 1) : inner).trim()
  return label ? { page, label } : null
}

/** `(Trivial: 56)` — stated on the recipe line in `|recipes`, on the tradeskill line in
 *  `|playercrafted`. Absent on plenty of pages, so it stays optional everywhere. */
const TRIVIAL_RE = /\(\s*Trivial:\s*(\d+)\s*\)/i

/** Split a field into trimmed, non-empty lines (the bullet lists are line-oriented). */
function bulletLines(block: string): string[] {
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/** The shared tail of both tradeskill parsers: the prose fallback fires ONLY when nothing
 *  structured was read, and `note` is left OFF the object rather than set to undefined. */
function withNote<T>(recipes: T[], leftovers: string[]): { recipes: T[]; note?: string } {
  const note = recipes.length === 0 && leftovers.length > 0 ? cleanSummary(leftovers.join(' ')) : undefined
  return note ? { recipes, note } : { recipes }
}

/** The tradeskill a `*` heading names. Usually a link ([[Baking]]); a bare word is accepted
 *  too, and a heading with neither leaves the current tradeskill unnamed. */
function headingTradeskill(body: string, link: { page: string; label: string } | null): string | undefined {
  return link?.label ?? (body.replace(TRIVIAL_RE, '').trim() || undefined)
}

/** One `**` recipe entry of `|recipes`: the linked recipe, its tradeskill heading and the
 *  trivial stated on the line. `page` only when the link was piped. */
function recipeFromLine(
  body: string,
  link: { page: string; label: string },
  tradeskill: string | undefined
): ItemRecipeUse {
  const trivialM = TRIVIAL_RE.exec(body)
  const use: ItemRecipeUse = { recipe: link.label }
  if (link.page !== link.label) use.page = link.page
  if (tradeskill) use.tradeskill = tradeskill
  if (trivialM) use.trivial = Number(trivialM[1])
  return use
}

/**
 * Parse `|recipes` — the recipes that CONSUME this item. Two-level bullets: `*` names the
 * tradeskill, `**` a recipe (`[[Name]] (Trivial: N)`). A flat single-level list (no `**`
 * anywhere) is read as bare recipes with no tradeskill. Anything that isn't a link falls
 * through to `note`, the prose fallback — we never invent a recipe name.
 */
export function parseRecipeUses(block: string): { recipes: ItemRecipeUse[]; note?: string } {
  const lines = bulletLines(block)
  const nested = lines.some((l) => l.startsWith('**'))
  const recipes: ItemRecipeUse[] = []
  const leftovers: string[] = []
  let tradeskill: string | undefined

  for (const line of lines) {
    if (!line.startsWith('*')) {
      leftovers.push(line)
      continue
    }
    const sub = line.startsWith('**')
    const body = line.replace(/^\*+\s*/, '')
    const link = firstLink(body)
    if (!sub && nested) {
      // A tradeskill heading. Usually a link ([[Baking]]); a bare word is accepted too.
      tradeskill = headingTradeskill(body, link)
      continue
    }
    if (!link) {
      leftovers.push(body)
      continue
    }
    const use = recipeFromLine(body, link, tradeskill)
    if (!recipes.some((r) => r.recipe === use.recipe && r.tradeskill === use.tradeskill)) {
      recipes.push(use)
    }
  }

  return withNote(recipes, leftovers)
}

/** One `::` ingredient row's item, quantity and source list. Null when the row names no
 *  item — we never invent an ingredient. */
function parseIngredientRow(body: string): { name: string; qty?: number; sources?: string[] } | null {
  const link = firstLink(body)
  if (!link) return null
  const ing: { name: string; qty?: number; sources?: string[] } = { name: link.label }
  const qty = /(\d+)\s*x\s*\[\[/.exec(body)
  if (qty) ing.qty = Number(qty[1])
  // " - Bought, Dropped" trails the link; read it only AFTER the link so an item name
  // containing a dash can't be mistaken for the source list.
  const close = body.indexOf(']]')
  const tail = close >= 0 ? /^\s*-\s*(.+)$/.exec(body.slice(close + 2)) : null
  const sources = tail ? tail[1].split(',').map((s) => s.trim()).filter(Boolean) : []
  if (sources.length > 0) ing.sources = sources
  return ing
}

/** Attach a `::` ingredient row to the open recipe. With no recipe open the row's text is
 *  kept as prose instead (it is not an ingredient of anything we read). */
function readIngredientRow(line: string, cur: ItemCraftRecipe | null, leftovers: string[]): void {
  const body = line.replace(/^:+\s*/, '').replace(/\{\{[^}]*\}\}/g, '').trim()
  if (!cur) {
    if (body) leftovers.push(body)
    return
  }
  const ing = parseIngredientRow(body)
  if (ing) cur.ingredients.push(ing)
}

/** A `**` detail line of the open recipe: `'''Yield: X''' xN` or `In [[Container]]:`.
 *  Anything else — or any such line with no recipe open — is prose. */
function readCraftDetail(body: string, cur: ItemCraftRecipe | null, leftovers: string[]): void {
  const y = /^'''\s*Yield:\s*(.+?)\s*'''(?:\s*x\s*(\d+))?/i.exec(body)
  if (y && cur) {
    cur.yieldItem = y[1]
    if (y[2]) cur.yieldQty = Number(y[2])
    return
  }
  const inCont = /^In\s+(.+?):?\s*$/i.exec(body)
  if (inCont && cur) {
    cur.container = firstLink(inCont[1])?.label ?? inCont[1].replace(/:$/, '').trim()
    return
  }
  if (!cur && body) leftovers.push(body)
}

/**
 * Parse `|playercrafted` — how this item is itself made. One `*` block per recipe (the
 * tradeskill + its trivial), `** '''Yield: X''' xN`, `** In [[Container]]:`, then `::`
 * ingredient rows (`{{SmIcon|nnn}} 1 x [[Item]] - Bought, Dropped`). A `*` bullet with no
 * link is NOT a tradeskill (Coin of Tash's `Non-Tradeskill (Quest)`) — it becomes `note`.
 */
export function parseCraftRecipes(block: string): { recipes: ItemCraftRecipe[]; note?: string } {
  const recipes: ItemCraftRecipe[] = []
  const leftovers: string[] = []
  let cur: ItemCraftRecipe | null = null

  for (const line of bulletLines(block)) {
    // Ingredient row.
    if (line.startsWith('::')) {
      readIngredientRow(line, cur, leftovers)
      continue
    }
    if (!line.startsWith('*')) {
      leftovers.push(line)
      continue
    }
    const body = line.replace(/^\*+\s*/, '')
    if (line.startsWith('**')) {
      readCraftDetail(body, cur, leftovers)
      continue
    }
    // Top-level bullet = a new recipe, but ONLY when it names a tradeskill by link.
    const link = firstLink(body)
    if (!link) {
      cur = null
      if (body) leftovers.push(body)
      continue
    }
    cur = { tradeskill: link.label, ingredients: [] }
    const tm = TRIVIAL_RE.exec(body)
    if (tm) cur.trivial = Number(tm[1])
    recipes.push(cur)
  }

  return withNote(recipes, leftovers)
}

// ---- drop sources (`|dropsfrom`) -----------------------------------------------
//
// CENSUS, measured 2026-08-04 over the full scrape cache (369 batch files, 11,247 item pages):
// 5,769 pages carry the field, 71 of them empty — 5,698 with content, 10,699 heading lines and
// 25,955 `*` bullets. The shapes, in the order this parser handles them:
//
//   ZONE-HEADED (the norm, ~4.4k pages) — a bare `[[Zone]]` line, then `*` mob bullets:
//       [[Upper Guk]]
//
//       * [[a froglok gaz squire]]
//   SEVERAL ZONES on one page (1,017): the heading/bullets pair simply repeats, so the zone is
//       the NEAREST PRECEDING heading and nothing more.
//   MOB-ONLY (36): bullets with no heading at all → entries with no zone.
//   PIPED headings (229): `[[Freeport|East Freeport]]` — the DISPLAY text is what the page calls
//       the zone, so that is what is kept.
//   PROSE headings (235): `Various Zones`, `'''Pre-Revamp'''`, a revamp caption. They name no
//       page, so they CLEAR the zone rather than letting the mobs below inherit the section
//       above — an unknown zone, never a borrowed one (law 1).
//   BULLETS NAMING NO PAGE (452): `* Newbie mobs.`, `* ?`, `* Ground Spawn`. Dropped: a mob we
//       cannot name is not a mob we may invent.
//   `**` SUB-ROWS (69): `{{Loc|…}}` ground-spawn coordinates under a bullet — detail of the row
//       above, not a second mob.
//   WRAPPER TEMPLATES (176 bullets, a handful of headings): `{{VeliousGray| [[a cold shade]] }}`
//       wraps the row for styling; it is unwrapped, not dropped.
//   HTML (8 lines): a trailing `<br>`, an `<s>` strikeout, one comment. Stripped like everywhere.
//   `:`-INDENTED BULLETS (10) and `'''bold'''` rows (a handful): decoration around a normal row.
//
// The link is taken from ANYWHERE in the line, not just its start — MEASURED, 14 lines in the
// whole corpus put words first ("Confirmed drop from [[Retseth Tretse]]", "various [[Chetari]]"),
// and 4 of the 6 such bullets name a real mob. Demanding a leading link would lose those to spare
// two ("Random mobs in [[Plane of Growth]]" reads a zone as a mob), which is the worse trade.
//
// Yield in the committed DB: 25,494 sources on 5,439 item pages (+1.31 MB of items.json).

/** Wiki decoration that is never part of a name: HTML, bold markers, the `:` indent a few pages
 *  bullet with, and the `{{Wrapper|…}}` a row may sit in ({{VeliousGray}}, {{Loc}}). Templates are
 *  UNWRAPPED — the link inside is the answer — rather than cut. */
function cleanDropLine(line: string): string {
  return line
    .replace(/<[^>]*>/g, ' ')
    .replace(/\{\{[^|{}]*\|/g, ' ')
    .replace(/\}\}/g, ' ')
    .replace(/'''?/g, '')
    .replace(/^:+\s*/, '')
    .trim()
}

/** One `*` bullet → the mob it links. Null for a `**` sub-row (detail of the bullet above) and
 *  for a bullet naming no page ("* Newbie mobs.") — we never invent a mob name. */
function dropMob(line: string): string | null {
  if (line.startsWith('**')) return null
  return firstLink(line.replace(/^\*+\s*/, ''))?.label ?? null
}

/**
 * Parse `|dropsfrom` — where the ITEM PAGE says this item comes from. Line-oriented: a non-bullet
 * line sets (or, naming no page, clears) the current zone; each `*` bullet under it is one mob in
 * that zone. Shapes and their counts are censused above; anything unrecognized yields FEWER
 * entries and never throws, which is this file's standing contract.
 *
 * `(mob, zone)` is the entry identity — a page that lists the same mob under two zones states two
 * real facts, while the same pair twice states one.
 */
export function parseDropSources(block: string): ItemDropSource[] {
  const out: ItemDropSource[] = []
  const seen = new Set<string>()
  let zone: string | undefined
  for (const raw of bulletLines(block)) {
    const line = cleanDropLine(raw)
    if (!line) continue
    if (!line.startsWith('*')) {
      zone = firstLink(line)?.label
      continue
    }
    const mob = dropMob(line)
    if (mob === null) continue
    // NUL-joined (the effectIndex precedent): mob and zone names both contain spaces, so a
    // printable separator would let two different pairs share one identity.
    const id = `${mob}\u0000${zone ?? ''}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(zone === undefined ? { mob } : { mob, zone })
  }
  return out
}

/** The `|dropsfrom` half of the result: the sources, or `undefined` when the page stated none.
 *  Never an empty list — "drops from nobody" is a claim no item page ever made. */
function dropSourcesField(raw: string | null): ItemDropSource[] | undefined {
  const sources = raw ? parseDropSources(raw) : []
  return sources.length > 0 ? sources : undefined
}

// ---- the page-top era tag (`{{Velious Era}}`) -----------------------------------
//
// The one era signal the wiki actually carries, and it is NOT an {{Itempage}} field: it is a
// bare template invoked at the TOP of the page, above `<onlyinclude>{{Itempage`, that renders the
// coloured "Velious Era" banner. Zone provenance is still the better witness (a zone is where you
// physically go), so this is LAYER 2 — consulted only when no source zone resolves.
//
// CENSUS, first measured 2026-08-04 and RE-MEASURED 2026-08-13 (JOS-328) over a fresh `--refresh`
// cache — 369 batch files, 18,433 pages enumerated, 11,288 of them item pages:
//   7,448 carry a banner in the HEAD (3,840 do not). Velious 2,757 · Classic 2,549 · Kunark 1,224 ·
//   Sky 365 · Chardok Revamp 136 · Epics 110 · Temple 96 · EpicQuests 76 · FearHateRevamp 53 ·
//   Fear 27 · Luclin 24 · Paineel 22 · Hate 5 · Unknown 2 · `Chardok` 1 · `kunark` 1.
// THE WIKI IS STILL BANNER-TAGGING, and at a pace worth knowing before anyone reads a bannerless
// page as evidence of anything: 7,315 of 11,247 on 2026-08-04, 7,448 of 11,288 nine days later, and
// a page-by-page diff of the two caches shows 108 banners ADDED upstream in that window with none
// removed — the `Classic` column is where nearly all of the growth landed.
// The token is the template NAME minus its ` Era` suffix, and the dirt in it is exactly three pages
// deep: `{{Velious  Era}}` (double space, 2), `{{Kunark_Era}}` (underscore, 1) and `{{kunark Era}}`
// (lowercase, 1) — hence the whitespace/underscore fold here, and the case fold in the mapping
// table (`shared/planner/era.ts`, which is the only place a token becomes an expansion).
//
// WHAT IS DELIBERATELY NOT READ:
//   * `{{Era}}` (1), `{{Era|Velious}}` / `{{Era | Hole}}` (6) — a DIFFERENT template with the
//     name in an argument, and all but one of them sit inline in prose or a drop list rather than
//     at the page top. Six occurrences is not a shape, it is a typo; a name we can't read is
//     `undefined`, never a guess (law 1). Note the pattern below cannot match them anyway: it
//     demands `}}` straight after ` Era`, so an argument disqualifies the whole shape.
//   * `{{P99 Era Header| Nov | 2000 }}` (16) — a date banner, not an era claim; it does not end
//     in ` Era` so the pattern never sees it. (Its CATEGORY does look like one — see below.)
const ERA_TAG_RE = /\{\{\s*([A-Za-z][A-Za-z0-9 _'`-]*?)[ _]+Era\s*\}\}/

/** `{{Velious  Era}}` / `{{Kunark_Era}}` → `Velious` / `Kunark`. Whitespace and underscores fold to
 *  single spaces; CASE IS PRESERVED, because these readers report what the page SAID and the
 *  mapping table is the place that decides what a spelling means. */
function eraToken(match: RegExpExecArray | RegExpMatchArray): string | undefined {
  return match[1].replace(/[_\s]+/g, ' ').trim() || undefined
}

/**
 * The page-top era template's token — `{{Velious Era}}` → `Velious` — or `undefined` when the
 * page carries none in its head (3,840 of the 11,288 item pages don't).
 *
 * HEAD-ANCHORED, and it stays that way: `parseItemWikitext` layers the two weaker readers below
 * behind it rather than widening this one, so "what the page opens with" remains a question with
 * exactly one answer.
 */
export function parseEraTag(wikitext: string): string | undefined {
  const at = wikitext.search(/\{\{\s*Itempage\b/i)
  if (at < 0) return undefined
  const m = ERA_TAG_RE.exec(wikitext.slice(0, at))
  return m ? eraToken(m) : undefined
}

// ---- LAYER 2b: the era claims that are not in the page HEAD (JOS-328, 2026-08-13) --------------
//
// THE REPORT THIS ANSWERS, and the answer it did not get. The owner's spot checks said every gear
// row we chip `era?` carries a red `Out of Era` badge on its wiki page — a THIRD signal above and
// beyond the zones and the banner. It does not reproduce, and the negative is worth as much as the
// fix, so it is recorded here rather than in a ticket that will scroll away. MEASURED 2026-08-13:
//   * `Template:Itempage` contains no era logic whatever — no `PageEra` call, no badge, no
//     category. The red box comes only from `Template:PageEra`, and only a `{{X Era}}` wrapper ever
//     reaches it, so a page with no banner renders no badge. `MediaWiki:Common.js` / `Common.css`
//     inject nothing era-related either. (The live PageEra switch was re-read the same day and is
//     byte-identical to the register mirrored in `shared/planner/era.ts`.)
//   * The 24 era? gear rows at the TOP of the table by AC and by DMG — the rows a spot check
//     actually lands on — carry no banner in their CURRENT wikitext, and rendering three of them
//     through `action=parse` returns no `Out of Era` box, while Breastplate of the Righteous (the
//     JOS-298 control) returns one. The badge machinery works; those pages do not have it.
//   * Authoritative version of the same question: `PageEra` emits `[[Category:{{{2}}}]]` on every
//     banner, so the wiki's era CATEGORIES are its own complete list of era-claiming pages. All 696
//     categories were enumerated, the 15 era ones' ns0 members pulled, and intersected with our
//     1,166 era?-chipped gear rows: THIRTY-EIGHT, of which 36 are `Classic Era` (in-era, no badge)
//     and 2 are `Kunark Era`. Two, not 1,166.
// If a badge was really on screen it was on another wiki (P99 keeps its own era markers, and 16
// eqlwiki pages still carry a `{{P99 Era Header}}` date banner from that lineage). Changing data
// source is not a parser change and was not done.
//
// WHAT IS REAL is that intersection: 52 corpus pages state an era somewhere other than the head,
// in exactly two shapes, and each gets its own reader below.
//
//   SHAPE 1 — THE BANNER IN THE BODY. `{{Classic Era}}` pasted inside `|playercrafted`, below the
//   `{{Itempage` open: 36 pages, the Fine Plate / Large Fine Plate / Small Fine Plate crafted-armour
//   family, and the census above used to list them as a known, accepted loss. It renders: the
//   template outputs `{{{playercrafted}}}` verbatim, so the coloured banner really is drawn on the
//   page and `PageEra` really does file it in `Category:Classic Era` — which is how the category
//   sweep found them. The old reason for not reading it was that scanning past `{{Itempage` would
//   also start reading inline `{{Era|Kunark}}` notes; that reason was WRONG about its own pattern
//   (`ERA_TAG_RE` demands `}}` straight after ` Era`, so an argument form can never match it). So
//   the honest guard is not position, it is AGREEMENT: measured over today's whole cache, the pages
//   with no head banner and a bare `{{X Era}}` in the body are exactly 36, exactly that family, and
//   every one of them states exactly ONE token, `Classic`. A page whose body banners disagree is
//   `undefined`, which is what keeps this from becoming a scan for the loudest match.
//
//   SHAPE 2 — THE HAND-WRITTEN CATEGORY. `[[Category:Kunark Era]]` at the page foot with no banner
//   template anywhere: 16 pages, of which 8 are read — 7 Kunark (Flowing Red Silk Sash, Leech Husk
//   Tunic, Mantle of Fire, Mucilaginous Girdle, Sash of the Dragonborn, Scaled Prowler Belt, Scaled
//   Wolf Hide Belt) and 1 Velious (Fist of Lightning). The other 8 are `Nov 2000 Era` filings left
//   behind by `{{P99 Era Header}}` and are refused by the law-1 clause below. A category
//   is PAGE-LEVEL by MediaWiki semantics wherever it sits — there is no such thing as a category
//   that applies to a drop list — so position is meaningless for it and only agreement matters.
//
// BOTH ARE LAYER 2b: consulted only when the HEAD is silent, in that order (a rendered banner
// outranks a filing), and both stay strictly weaker than the drop zones the way layer 2 always was.
//
// THE LAW-1 CLAUSE, and it applies to the CATEGORY only: `namesEra`. An unknown BANNER key is
// allowed to mean `out`, because `Template:PageEra`'s `#default` really does draw the red box for it
// and mirroring a rendered page is reporting. An unknown CATEGORY renders nothing at all, so
// `Nov 2000` / `Mar 2000` / `May 1999` — the date filings — are not era claims and must not become
// them. Those 8 Illegible Note pages stay `undefined`, which is the whole point of the guard.
const ERA_CATEGORY_RE = /\[\[\s*Category\s*:\s*([A-Za-z][A-Za-z0-9 _'`-]*?)[ _]+Era\s*(?:\||\]\])/gi
const ERA_BODY_RE = /\{\{\s*([A-Za-z][A-Za-z0-9 _'`-]*?)[ _]+Era\s*\}\}/g

/** Fold a list of stated tokens to THE token, or `undefined` when they do not agree (or there are
 *  none). Keyed by the register's own fold so `Kunark` and `kunark_` are one claim, valued by the
 *  page's spelling so the mapping table still sees what was written. */
function soleToken(tokens: readonly string[]): string | undefined {
  const byKey = new Map<string, string>()
  for (const t of tokens) byKey.set(t.toLowerCase().replace(/[\s_]+/g, ''), t)
  return byKey.size === 1 ? [...byKey.values()][0] : undefined
}

/**
 * The era token a `{{X Era}}` banner states BELOW the `{{Itempage` open — `undefined` unless the
 * page's body banners all agree, and `undefined` for a page with no `{{Itempage}}` at all (there is
 * no "body" to speak of then, and `parseEraTag` has already declined it).
 */
export function parseEraBodyTag(wikitext: string): string | undefined {
  const at = wikitext.search(/\{\{\s*Itempage\b/i)
  if (at < 0) return undefined
  const found: string[] = []
  for (const m of wikitext.slice(at).matchAll(ERA_BODY_RE)) {
    const token = eraToken(m)
    if (token !== undefined) found.push(token)
  }
  return soleToken(found)
}

/**
 * The era token the page's own CATEGORY states — `[[Category:Kunark Era]]` → `Kunark` — or
 * `undefined`. Same ` Era`-suffix rule and same whitespace fold as `parseEraTag`, so a category and
 * a banner produce the identical spelling and the mapping table needs no second set of rows.
 *
 * Refuses a token the era register does not name (the `{{P99 Era Header}}` date filings), and
 * refuses a page that files itself under two different eras.
 */
export function parseEraCategory(wikitext: string): string | undefined {
  const found: string[] = []
  for (const m of wikitext.matchAll(ERA_CATEGORY_RE)) {
    const token = eraToken(m)
    if (token !== undefined && namesEra(token)) found.push(token)
  }
  return soleToken(found)
}

/**
 * THE PAGE'S ERA CLAIM — the three readers in strength order, each speaking only into the previous
 * one's silence: what the page OPENS with, then what it renders anywhere, then how it is FILED.
 * `undefined` when the page says none of the three, which is 3,796 of the 11,288 item pages.
 */
function pageEraTag(wikitext: string): string | undefined {
  return parseEraTag(wikitext) ?? parseEraBodyTag(wikitext) ?? parseEraCategory(wikitext)
}

// ---- the same two questions, asked of a page that is NOT an item (JOS-341) ---------------------
//
// LAYER 3 GREW A PAGE EDGE, and the pages it reads are armour-set hubs and quest indexes rather
// than `{{Itempage}}` transclusions. Those two readers live HERE, beside the item ones, for the
// reason this file's header already states about the live fallback: there must be no second parser
// to drift. `scripts/scrape-page-era.ts` is their only caller today, and it commits the answer.

/**
 * A NON-ITEM page's era claim: the `{{X Era}}` banner it renders, else how it is FILED.
 *
 * The item readers above are anchored on `{{Itempage}}` — head means "before the item template" —
 * and an armour-set page has no such anchor, so neither of them can answer for one (both return
 * `undefined` on the very first line). This asks the same two questions without the anchor, using
 * the SAME `ERA_TAG_RE` / `ERA_CATEGORY_RE` and the same `soleToken` agreement rule, so a set page
 * and an item page that both open `{{Kunark Era}}` produce the identical token.
 *
 * AGREEMENT, NOT FIRST-MATCH, for the banner too. On an item page the banner is a page-top header
 * and there is one; a hub page can render a banner per SECTION (a set page listing a classic and a
 * Kunark tier), and "the first one wins" would be a coin toss decided by section order. Disagreeing
 * banners are `undefined` — the page did not make one claim — which is law 1 and is also what
 * `parseEraBodyTag` already does for the item body.
 */
export function parsePageEraTag(wikitext: string): string | undefined {
  const banners: string[] = []
  for (const m of wikitext.matchAll(ERA_BODY_RE)) {
    const token = eraToken(m)
    if (token !== undefined) banners.push(token)
  }
  return soleToken(banners) ?? parseEraCategory(wikitext)
}

/**
 * The internal link targets an item page's `|notes` prose names — the LINKS the era pill is drawn
 * on, kept as titles instead of thrown away.
 *
 * `cleanSummary` reduces the same field to one line of prose and DISCARDS the targets (`[[Cultural
 * Tradeskills: Human|the human cultural set]]` becomes four words), which is why the corpus row of
 * a set-page member does not even carry the title of the page that decides its era (JOS-333's named
 * refusal). This reader keeps them, and nothing else about `|notes` changes.
 *
 * WHY `|notes` AND NOT THE WHOLE PAGE. eqlwiki's own era filter walks every anchor on the rendered
 * page, so a whole-page scan would be the more literal mirror — and measured over the 2,292 corpus
 * pages layers 1-2 leave silent, it finds 1,504 distinct non-item targets against `|notes`'s 151.
 * The difference is class pages, deity pages, spell pages and infobox furniture: links that say
 * nothing about how you GET the item, and that would speak loudest in the one direction (IN era)
 * where being wrong shows a player content that is not there. Every other field of the template is
 * already parsed into a structured edge — components, yields, quests, drop zones — so `|notes` is
 * exactly the acquisition prose no other reader sees, and it is the field the owner's screenshots
 * are of. A whole-page scan is a widening that needs its own evidence, not a default.
 *
 * SECTION ANCHORS and PIPED LABELS are folded to the bare title (`[[Kaladim#Smithing|here]]` →
 * `Kaladim`), underscores to spaces, and the wiki's own excluded namespaces are dropped — the same
 * `File:`/`Category:`/`Template:`/`Special:` skip list the skin module documents. Order is the
 * page's, duplicates removed.
 */
/** The namespaces eqlwiki's own `eraFilter` skips before it asks about a link target. */
const EXCLUDED_NS = /^(File|Image|Category|Template|Special|Help|MediaWiki|User|Talk|Media|Portal)\s*:/i

export function notesLinkTargets(wikitext: string): string[] {
  const notes = templateField(wikitext, 'notes')
  if (notes === null) return []
  const out: string[] = []
  for (const m of notes.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    const title = m[1].replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
    if (title === '' || EXCLUDED_NS.test(title) || out.includes(title)) continue
    out.push(title)
  }
  return out
}

/** Collapse a `notes` field to a single trimmed prose line (strips wiki markup, caps length). */
export function cleanSummary(notes: string): string | undefined {
  const text = notes
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1') // [[Page|Label]] -> Label
    .replace(/\[\[([^\]]*)\]\]/g, '$1') // [[Page]] -> Page
    .replace(/<[^>]+>/g, ' ') // strip HTML tags
    .replace(/'''?/g, '') // bold/italic markers
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return undefined
  // First sentence / first 200 chars, whichever is shorter — a one-liner, not an essay.
  const firstSentence = text.split(/(?<=\.)\s/)[0]
  const s = (firstSentence.length <= 200 ? firstSentence : text.slice(0, 200)).trim()
  return s || undefined
}

/** The game item WINDOW's structure for a stats block, with `|focus_effect` folded in. */
function buildStats(statsBlock: string, focusRaw: string | null): ItemStatBlock {
  const stats = parseStatsBlock(statsBlock)
  // `|focus_effect` lives OUTSIDE the stats block (Djarn's Amethyst Ring, Golden
  // Efreeti Boots) but the game window shows it as just another effect line.
  const focus = focusRaw ? cleanSummary(focusRaw) : undefined
  if (focus && !stats.effects.some((e) => e.kind === 'focus')) {
    stats.effects.push({ kind: 'focus', name: focus })
  }
  return stats
}

/** `|lucy_img_ID` → File:Item <id>.png. A bare integer or nothing at all. */
function parseIconId(iconRaw: string | null): number | undefined {
  return iconRaw && /^\d+$/.test(iconRaw.trim()) ? Number(iconRaw.trim()) : undefined
}

/**
 * The tradeskill half of the result. Every field is `undefined` — never an empty list, never
 * a bare `false` — unless the page actually carried a STRUCTURED recipe: `playerCrafted` in
 * particular is asserted only from a parsed craft recipe, and prose-only `|playercrafted`
 * ("Non-Tradeskill (Quest)") is reported as `craftedNote` and nothing more.
 */
function tradeskillFields(
  recipeParse: { recipes: ItemRecipeUse[]; note?: string } | null,
  craftParse: { recipes: ItemCraftRecipe[]; note?: string } | null
): Pick<ItemKnowledge, 'recipes' | 'recipesNote' | 'playerCrafted' | 'craftedBy' | 'craftedNote'> {
  return {
    recipes: recipeParse && recipeParse.recipes.length > 0 ? recipeParse.recipes : undefined,
    recipesNote: recipeParse?.note,
    playerCrafted: craftParse && craftParse.recipes.length > 0 ? true : undefined,
    craftedBy: craftParse && craftParse.recipes.length > 0 ? craftParse.recipes : undefined,
    craftedNote: craftParse?.note
  }
}

/**
 * PURE: turn item-page wikitext into the knowledge fields. `|statsblock` carries the
 * LORE/QUEST text flags, `|relatedquests` a bulleted [[link]] list, `|notes` prose,
 * `|recipes` the tradeskill recipes that CONSUME this item, `|playercrafted` how the
 * item is itself made and `|dropsfrom` where the page says it drops (shapes documented in the
 * file header + the census above `parseDropSources`). The page's era claim — the one piece of
 * knowledge that is not a template field at all — comes through as `eraTag`: the page-top
 * `{{X Era}}` banner, or the `[[Category:X Era]]` filing when the head carried no banner.
 *
 * `stats` is the same block parsed into the game item WINDOW's structure (see
 * shared/itemStats.ts) so the UI can draw it with the game's hierarchy and colors
 * instead of dumping monospace text. The raw `statsBlock` string is still returned —
 * it stays the fallback for anything the structured parse doesn't recognize.
 */
export function parseItemWikitext(
  _name: string,
  wikitext: string
): Pick<
  ItemKnowledge,
  | 'lore'
  | 'quest'
  | 'questUses'
  | 'dropsFrom'
  | 'summary'
  | 'statsBlock'
  | 'stats'
  | 'iconId'
  | 'recipes'
  | 'recipesNote'
  | 'playerCrafted'
  | 'craftedBy'
  | 'craftedNote'
  | 'eraTag'
> {
  const statsBlock = templateField(wikitext, 'statsblock') ?? undefined
  const relatedRaw = templateField(wikitext, 'relatedquests')
  const notesRaw = templateField(wikitext, 'notes')
  const focusRaw = templateField(wikitext, 'focus_effect')
  const iconRaw = templateField(wikitext, 'lucy_img_ID')
  const recipesRaw = templateField(wikitext, 'recipes')
  const craftedRaw = templateField(wikitext, 'playercrafted')
  const dropsFrom = dropSourcesField(templateField(wikitext, 'dropsfrom'))

  const flags = (statsBlock ?? '').toUpperCase()
  const lore = /\bLORE ITEM\b/.test(flags) || /\bLORE EQUIPPED\b/.test(flags)
  const questFlag = /\bQUEST ITEM\b/.test(flags)

  const questUses = relatedRaw ? parseQuestLinks(relatedRaw) : []
  const quest = questFlag || questUses.length > 0
  const summary = notesRaw ? cleanSummary(notesRaw) : undefined

  const stats: ItemStatBlock | undefined = statsBlock ? buildStats(statsBlock, focusRaw) : undefined

  const iconId = parseIconId(iconRaw)

  // Tradeskill knowledge. `playerCrafted` is asserted only from a STRUCTURED craft recipe;
  // a prose-only `|playercrafted` ("Non-Tradeskill (Quest)") is reported as craftedNote and
  // nothing more.
  const recipeParse = recipesRaw ? parseRecipeUses(recipesRaw) : null
  const craftParse = craftedRaw ? parseCraftRecipes(craftedRaw) : null

  return {
    lore,
    quest,
    questUses,
    dropsFrom,
    summary,
    stats,
    iconId,
    eraTag: pageEraTag(wikitext),
    ...tradeskillFields(recipeParse, craftParse),
    statsBlock: statsBlock
      ? statsBlock.replace(/<br\s*\/?>/gi, '\n').replace(/[ \t]{2,}/g, ' ').trim()
      : undefined
  }
}
