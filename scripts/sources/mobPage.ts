/**
 * PURE mob-page wikitext parser (no network) — the parsing half of `scripts/scrape-mobs.ts`.
 * Sibling of ./questPage.ts, and unit-tested against verbatim wikitext in
 * tests/considerWindows.test.mts.
 *
 * IT DELIBERATELY DOES NOT RE-IMPLEMENT THE WIKITEXT READING. `parseMobWikitext` in
 * src/main/mobLookupParse.ts is the SHIPPED definition of "what a mob page says" (it backs the
 * app's live-wiki fallback), and it is electron-free by construction, so the scraper imports it
 * instead of growing a second definition that could drift. What lives here is the scraper's own
 * two concerns:
 *
 *   1. IS THIS A MOB PAGE AT ALL. The enumeration is deliberately over-broad (see
 *      scrape-mobs.ts), and MediaWiki's `embeddedin` reports INDIRECT transclusions — a quest
 *      page that shows a mob box (`{{:A zol ghoul knight}}`) is listed as embedding
 *      Template:Namedmobpage. Only a page whose OWN wikitext opens the template counts.
 *   2. THE COMPACT PROJECTION. The committed catalog is names only (see MobEntry) — no drop
 *      rates, no wikitext — because it is inlined into the main bundle.
 */
import { parsePageEraTag, templateField } from '../../src/main/itemLookupParse'
import { CURRENT_ERA, eraBadgeOverrides } from '../../src/shared/planner/era'
import { parseMobLoot, parseMobWikitext } from '../../src/main/mobLookupParse'
import { factionNames } from './mobFaction'
import { encodeFactionAmount, type MobFactionHit } from '../../src/shared/mobFactionAmounts'
import type { MobEntry } from '../../src/shared/types'
import { pageNotices, type PageNotice } from '../../src/shared/pageNotices'
import { stripFormatChars } from '../../src/shared/wikiTitle'

/**
 * The page templates that MAKE a page a mob page, verified against the live wiki (2026-08-03):
 *   {{Namedmobpage}}  6,516 pages report embedding it (incl. indirect) — the mob/NPC template,
 *                     carrying |level, |zone, |known_loot, |related_quests.
 *   {{MerchantPage}}  1,361 — a vendor NPC. SAME header fields, but `|items_sold` instead of
 *                     `|known_loot`. Kept in the catalog (a merchant is a thing you can `/con`,
 *                     and its level/zone are real) with NO drops — a vendor's stock is not loot.
 *
 * DELIBERATELY UNANCHORED. The obvious `^\s*\{\{Namedmobpage` is WRONG and was measured to be:
 * most pages open with an ERA tag on the SAME LINE — `{{Classic Era}}{{Namedmobpage`, and also
 * Kunark/Velious/Fear/Hate/Chardok Revamp/Paineel/Temple/Luclin/Epics Era — so a start-of-line
 * anchor rejected 660 of the first 2,145 real mob pages (30%). Matching anywhere is SAFE
 * because the transclusion form a non-mob page carries is `{{:A zol ghoul knight}}` (the colon
 * makes it a page transclusion, not a template call): the indirect-transclusion candidates the
 * enumeration drags in — "Druid Epic Quest" and friends — contain zero occurrences of this
 * literal, verified against the live page.
 */
const MOB_TEMPLATE_RE = /\{\{\s*(Namedmobpage|MerchantPage)\b/i

/** True when the page's OWN wikitext opens a mob template (not merely transcludes a mob box). */
export function isMobPage(wikitext: string): boolean {
  return MOB_TEMPLATE_RE.test(wikitext)
}

/**
 * Split a `|zone` field into zone names. Verified shapes: a single link (`[[Lower Guk]]`), the
 * bare word `Various`, and multi-zone pages that separate with `<br>` or a comma. Zone names in
 * this game contain no commas, so both separators are safe; anything else is left as one value
 * rather than guessed apart.
 */
export function splitZones(zone: string | undefined): string[] {
  if (!zone) return []
  const zones = zone
    .split(/\s*(?:<br\s*\/?>|,|\/)\s*/i)
    .map((z) => z.trim())
    .filter((z) => z.length > 0)
  // A long "zone" is usually prose or a glued list: kept, but said out loud for the next refresh.
  for (const z of zones) if (z.length >= 60) console.warn(`[mobs] long |zone value kept: ${z}`)
  return zones
}

/** A stated amount, `(-10)` or `(-5?)`; a `?` after the number marks a guess. */
const AMOUNT_RE = /\(\s*([+-]?\d+)\s*(\?*)\s*\)/g
/** An amount alone after the name without brackets: `<span class='profac'>-15</span>`, `+7`. */
const BARE_AMOUNT_RE = /^\s*([+-]?\d+)\s*(\?*)\s*$/

/** The faction one bullet names, exactly as `factionNames` names it (mobFaction.ts stays byte-identical with slayer-tab). */
function bulletFaction(line: string): string | undefined {
  return factionNames(`|factions=\n${line}\n}}`)[0]
}

/** What follows the faction's name on its bullet, comments, markup and bold dropped: `(-10) to (-30) (unconfirmed)`. */
function afterName(line: string, faction: string): string {
  const link = line.indexOf(']]')
  const from = link >= 0 ? link + 2 : line.indexOf(faction) + faction.length
  return line.slice(from).replace(/<!--.*?(?:-->|$)|<[^>]*>|'{2,}/g, ' ')
}

/** Lowered or raised: by the stated sign when there is one (an unsigned number raises), else by the field. */
function hitSide(rest: string, field: string): MobFactionHit['side'] {
  const amount = new RegExp(AMOUNT_RE.source).exec(rest) ?? BARE_AMOUNT_RE.exec(rest)
  const sign = amount !== null ? (amount[1].startsWith('-') ? '-' : '+') : /\(\s*([+-])|([+-])\s*$/.exec(rest)?.slice(1).find(Boolean)
  if (sign !== undefined) return sign === '-' ? 'lowers' : 'raises'
  return field === 'factions' ? 'lowers' : 'raises'
}

/** One amount or an `(a) to (b)` range, signed as written; none for `(?)`, `(-0)`, `(~5)`, `(<5)` or a choice. */
function hitAmount(rest: string): Pick<MobFactionHit, 'min' | 'max' | 'unconfirmed'> {
  const bare = BARE_AMOUNT_RE.exec(rest)
  const nums = bare !== null ? [bare] : [...rest.matchAll(AMOUNT_RE)]
  if (!(nums.length === 1 || (nums.length === 2 && /\)\s*to\s*\(/i.test(rest)))) return {}
  const values = nums.map((m) => Number(m[1]))
  // `(-0)` is a listed hit of unstated size (owner, 2026-10-10).
  if (values.includes(0)) return {}
  const guess = nums.some((m) => m[2] !== '') || /unconfirmed|unverified|\)\s*\?/i.test(rest)
  return { min: Math.min(...values), max: Math.max(...values), ...(guess ? { unconfirmed: true as const } : {}) }
}

/**
 * What each faction `factionNames` lists says about the hit, in its order (owner, 2026-10-20: Gaps
 * flags a listed faction whose amount the log contradicts). Stored encoded: `factionAmountList`.
 */
export function factionHitList(wikitext: string): MobFactionHit[] {
  const named: string[] = []
  const hits: MobFactionHit[] = []
  for (const field of ['factions', 'opposing_factions']) {
    for (const line of (templateField(wikitext, field) ?? '').split('\n')) {
      const faction = bulletFaction(line)
      if (faction === undefined || named.includes(faction)) continue
      const rest = afterName(line, faction)
      named.push(faction)
      hits.push({ side: hitSide(rest, field), ...hitAmount(rest) })
    }
  }
  return hits
}

/** `MobEntry.factionAmounts`: `factionHitList` as the short strings mobs.json stores. */
export function factionAmountList(wikitext: string): string[] {
  return factionHitList(wikitext).map(encodeFactionAmount)
}

/** For the Gaps tab (owner ask, 2026-10-18): whether the page is a vendor's, and the factions a kill moves. */
function gapsFacts(wikitext: string): Pick<MobEntry, 'merchant' | 'factions' | 'factionAmounts' | 'image' | 'commonDrops'> & { notices?: PageNotice[] } {
  // `{{DNE}}` / `{{delete}}`: the page says the mob may not be in Legends (owner, 2026-10-22).
  const notices = pageNotices(wikitext)
  const factions = factionNames(wikitext)
  // `|common_loot` lists drops as surely as `|known_loot`: on 195 pages, mostly shared tables (Classic
  // Raid Tier Treasures) and a zone's set loot (owner, 2026-10-19: Gaps read them as missing).
  const common = [...new Set(parseMobLoot(templateField(wikitext, 'common_loot') ?? '').map((d) => d.item))]
  // A bidi mark pasted after the name is not part of it: the wiki drops it from the title.
  const image = stripFormatChars(/\|\s*imagefilename\s*=\s*([^\n|}]*)/i.exec(wikitext)?.[1] ?? '')
  return {
    ...(/\{\{\s*MerchantPage\b/i.test(wikitext) ? { merchant: true } : {}),
    ...(factions.length ? { factions, factionAmounts: factionAmountList(wikitext) } : {}),
    ...(image !== '' ? { image } : {}),
    ...(common.length ? { commonDrops: common } : {}),
    ...(notices === undefined ? {} : { notices })
  }
}

/**
 * Project one mob page into a catalog entry, or null when the page is not a mob page.
 * `title` is the wiki page title; `wikitext` is its raw source.
 *
 * The entry's `name` is the page's OWN `|name` when it states one (the in-game name, with the
 * lowercase article EQ actually prints) and the page title otherwise — never a name we made up.
 */
export function parseMobPage(title: string, wikitext: string): MobEntry | null {
  if (!isMobPage(wikitext)) return null
  const facts = parseMobWikitext(wikitext)
  // `|name` can be present-but-empty (or unlink to nothing), and an EMPTY name is "the page
  // does not state one" — so the fallback is on emptiness, not merely on absence.
  const stated = facts.pageName ?? ''
  // The era banner (`{{FearHateRevamp Era}}`), read by the ONE non-item page reader so a mob and
  // an armour-set page that open the same banner get the same token. Keyed right after `page` so
  // the committed catalog keeps one field order; absent when the page states no era.
  const eraTag = parsePageEraTag(wikitext)
  const entry: MobEntry = { page: title, ...(eraTag !== undefined && { eraTag }), name: stated.length > 0 ? stated : title }
  if (facts.levelText) entry.level = facts.levelText
  const zones = splitZones(facts.zone)
  if (zones.length) entry.zones = zones
  const drops = (facts.dropsWiki ?? []).map((d) => d.item)
  if (drops.length) entry.drops = drops
  // Spawn points, when the page states numbers. 6,309 of 7,866 pages do (see MobLoc) — enough
  // for the map viewer to pin a zone's named mobs, and the ~20% that only say "Various" stay
  // absent rather than acquiring a guessed one.
  if (facts.locations?.length) entry.loc = facts.locations
  if (mobOutOfEra(eraTag)) entry.outOfEra = true
  return { ...entry, ...gapsFacts(wikitext) }
}

/**
 * THE WIKI ERA RULE FOR A MOB (owner rulings, 2026-10-17): the page's own banner decides, exactly as
 * the wiki's "Out of Era" box does. An earlier version let a later-expansion banner give way to a
 * classic zone; that let in Kunark additions to classic zones (Eejag, `{{Kunark Era}}`, in
 * Lavastorm) and was removed. What the player's own log shows they met outranks this at runtime
 * (src/shared/metInLog.ts), so a banner the game contradicts never hides a mob the player fights.
 */
export function mobOutOfEra(eraTag: string | undefined): boolean {
  return eraTag !== undefined && eraBadgeOverrides(eraTag, CURRENT_ERA)
}
