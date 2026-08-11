// mobLookupParse.ts — the PURE half of "what does this mob drop" (Task #63).
//
// Split out from mobLookup.ts (which imports electron `app` for the userData cache) exactly the
// way itemLookupParse.ts is split from itemLookup.ts, so the wikitext classification and the
// own-loot index are importable in the node test runner with NO electron dependency. Unit-tested
// in tests/considerWindows.test.mts against VERBATIM real wikitext.
//
// ===========================================================================
// THE MOB PAGE, as it actually is (fetched read-only from eqlwiki.com on 2026-08-03:
// "A zol ghoul knight", "A Froglok Gaz Knight", "Baron Telyx V`Zher", "The Tenderizer",
// "A giant rat", "A hill giant", "An ashenbone drake", "Key Master")
//
// Mob pages use {{Namedmobpage}} — the same `|field = value` grammar {{Itempage}} uses, so
// `templateField` is REUSED rather than re-implemented. Fields we read:
//   |name          = a zol ghoul knight        (the page's own spelling — the identity check)
//   |level         = 36-40 | 18 | 2 - 4 | 28   (a RANGE as often as a number → kept as TEXT)
//   |zone          = [[Lower Guk]] | Various
//   |known_loot    = an HTML <ul> of {{:Item}} transclusions (four shapes, below)
//   |related_quests = * [[Quest Page]] bullets, or the literal `* None`
//
// KNOWN_LOOT — FOUR verbatim shapes observed across those pages. The ONE invariant across all
// of them is the `{{:Item Name}}` transclusion; the list markup and the rarity annotation vary,
// so the parse keys off the transclusion and treats everything else as optional decoration:
//
//   (1) a zol ghoul knight / a froglok gaz knight — one <li> per line, rarity WORD + a drop-rate
//       span the wiki renders from its own DB:
//         <ul><li>  {{:Fine Steel Short Sword}}  <span class='drare'>(Uncommon)</span> <span class='ddb'>[Overall: 25.0%]</span>
//         </li><li> {{:Amber}}                   <span class='drare'>(Rare)</span> <span class='ddb'>[Overall: 5.5%]</span>
//   (2) Baron Telyx V`Zher — hand-written, NO spans at all, rarity in bare parentheses:
//         <li>{{:Pristine Studded Leather Tunic}} (Common)</li>
//         <li>{{:The Baron's Blade}} (Rare)</li>
//   (3) The Tenderizer — the rarity span is present but EMPTY (rarity simply unknown):
//         <li> {{:Kitchen Toolbelt}}          <span class='drare'></span>
//   (4) a giant rat — unclosed <li>s, rarity as a bare PERCENTAGE, and trailing prose inside
//       the field ("Does not drop coin."):
//           <li> {{:A Piece of Rat Fur}}   <span class='drare'>(18.4%)</span>
//
// So `rarity` is whatever text the page put in parentheses right after the item, VERBATIM
// ("Uncommon", "Ultra Rare", "18.4%"), and absent when there was none. It is never mapped onto a
// scale of our own — the wiki uses at least two incompatible ones (law 1).
//
// NOT A DROP LIST: a MerchantPage (Key Master) has `|items_sold`, not `|known_loot`. Reading
// that as drops would claim a vendor's stock is loot, so nothing here looks at it — a merchant
// simply comes back with no `dropsWiki`.

import { templateField } from './itemLookupParse'
import type { MobDrop, MobLoc, MobQuestUse, MobSeenDrop } from '../shared/types'

/**
 * Canonical identity key for a MOB name. The same rule as parser.idKey (lowercase + trim) plus
 * two folds.
 *
 * QUOTE FOLD: the log writes ``Innoruuk`s Chosen`` with a backtick, the wiki writes it with a
 * typographic or straight apostrophe, and the quest catalog uses whatever its page did. Folding
 * all three to `'` is what lets one mob be one key across the three sources.
 *
 * COPY-NUMBER STRIP — a trailing ` (N)`. That suffix is OURS, not the game's: no log line ever
 * carries it (a full-log sweep of the live log finds `(N)` only in heal amounts and skill-up
 * levels). `WorldModel.label()` (combat/world.ts) appends the spawn GENERATION when more than
 * one instance of a name has been engaged — "an elemental capturer (14)" is the 14th capturer
 * this session, not a different creature — and that label rides
 * `Encounter.lastOutTarget` → `CurrentTarget.name` → the Overview tab's `lookupMob(name)`.
 * MEASURED consequence before this strip: the dev userData cache
 * (`%APPDATA%\everquest-companion-dev\mob-knowledge-cache.json`) held ELEVEN such keys —
 * 'an elemental capturer (14)', 'a rock golem (45)', 'an elemental crusader (28)',
 * 'an elemental channeler (19)', 'an elemental visier (12)', … — and every one of them was
 * `notFound`, while all eleven base names are catalog hits carrying real drop tables. Plane of
 * Sky is where it bites: the island trash comes in same-named packs, so gen counters run high.
 *
 * A copy number is not part of an identity — loot off "an elemental capturer (14)"'s corpse is
 * that mob's loot, and the wiki has exactly one page for it. Same canonicalize-at-a-boundary
 * family as the item ` +N` strip (itemLookupParse.normalizeItemName, world-model law 2), and
 * as there, DISPLAY stays raw: callers pass the untouched name to `knowledgeFromCatalog`, so
 * the card still reads "An elemental capturer (14)".
 *
 * Only DIGITS are stripped. A parenthesized WORD is part of the name (instance tiers like
 * "(Awakened)", wiki disambiguators), so `(\d+)` is the whole rule — and it is safe against the
 * committed catalog, where zero of the 7,866 entries end in a parenthesized number.
 *
 * The cache SHAPE is unchanged, so no CACHE_VERSION bump and no purge: the old ' (N)'-keyed
 * entries simply become unreachable, and being negatives they age out under NEG_TTL_MS anyway.
 *
 * Deliberately does NOT strip the leading article: "a giant rat" and "giant rat" are different
 * page titles on the wiki, and the log always prints the article, so keeping it is both honest
 * and lossless. Article-insensitive matching is a BOSS-matching rule (law 2), not this one.
 */
export function mobKey(name: string): string {
  return name
    .trim()
    .replace(/\s*\(\d+\)$/, '')
    .toLowerCase()
    .replace(/[`’´]/g, "'")
    .replace(/\s+/g, ' ')
}

/**
 * Reduce a short field value to plain text. Used for `|name`, `|level` and `|zone`, which are
 * mostly plain but carry three kinds of markup on real pages:
 *   - `[[Page|Label]]` / `[[Page]]` wiki links   → the label   (`|zone = [[Lower Guk]]`)
 *   - `[https://… Label]` EXTERNAL links         → the label, or nothing when bare. 59 mob
 *     `|name` fields and 7 `|level` fields end in a bare archive.org citation link, e.g.
 *     `A Gnoll Scout[https://web.archive.org/…?id=2964]`. Dropping only `[[…]]` left the whole
 *     URL glued to the mob's NAME, which then keys the catalog under a name nothing can look
 *     up. (Found by the dataset-integrity test, not by reading pages.)
 *   - stray HTML tags                            → removed
 * Wiki links are handled BEFORE external links so `[[…]]` is never mistaken for `[…]`.
 */
export function unlink(value: string): string {
  return value
    .replace(/\[\[([^\]]+?)\]\]/g, (_m, inner: string) => {
      const pipe = inner.indexOf('|')
      return (pipe >= 0 ? inner.slice(pipe + 1) : inner).trim()
    })
    .replace(/\[(?:https?|ftp):\/\/\S*(?:\s+([^\]]*))?\]/gi, (_m, label?: string) => (label ?? '').trim())
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Parse a mob page's `|known_loot` field into drops. Anchored on the `{{:Item}}` transclusion
 * (the one invariant across all four observed shapes); the rarity is the FIRST parenthesized
 * run that follows it, before the next transclusion — which covers the `<span class='drare'>`
 * wrapper, the bare-parenthesis form and the bare-percentage form alike, and yields nothing for
 * the empty-span form. `[Overall: 25.0%]` / `[3] 1x 55% (33%)` drop-rate spans sit AFTER the
 * rarity and are deliberately not read: they are square-bracketed DB dumps in three mutually
 * incompatible formats, and the rarity word is what a glanceable card wants.
 */
export function parseMobLoot(block: string): MobDrop[] {
  const drops: MobDrop[] = []
  const seen = new Set<string>()
  const re = /\{\{:\s*([^}|]+?)\s*\}\}/g
  const marks: { item: string; end: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(block)) !== null) marks.push({ item: m[1].trim(), end: re.lastIndex })
  for (let i = 0; i < marks.length; i++) {
    const item = marks[i].item
    if (!item) continue
    // Look only as far as the NEXT transclusion, so one item can never borrow another's rarity.
    const tail = block.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].end : undefined)
    // The rarity annotation, in any of its three spellings. `[^()]*` keeps it to a single
    // parenthesized run; the leading `[^[]*?` stops the scan at a `[Overall: …]` DB span.
    const r = /^[^([{]*?\(([^()]+)\)/.exec(tail.replace(/<\/?span[^>]*>/g, ''))
    const rarity = r ? r[1].trim() : undefined
    const key = item.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    drops.push(rarity ? { item, rarity } : { item })
  }
  return drops
}

/** `* [[Quest Page]]` bullets from `|related_quests`. The literal `* None` yields nothing. */
export function parseMobQuestLinks(block: string): MobQuestUse[] {
  const uses: MobQuestUse[] = []
  const re = /\[\[([^\]]+?)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(block)) !== null) {
    const inner = m[1].trim()
    const pipe = inner.indexOf('|')
    const page = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim()
    const label = (pipe >= 0 ? inner.slice(pipe + 1) : inner).trim()
    if (!label || /^none$/i.test(label)) continue
    if (!uses.some((u) => u.quest === label)) uses.push({ quest: label, page })
  }
  return uses
}

/**
 * `|location` — one or more SPAWN POINTS, in the page's own `/loc` order (see `MobLoc`).
 *
 * MEASURED across all 7,866 catalog pages (2026-08-04): 6,309 state numbers, and they do it in
 * these verbatim shapes, which is why the scan is shape-based rather than a single anchored
 * pattern:
 *
 *     (131, 342)                     2,349   the plain case
 *     60% @ (131, 342)               2,193   a spawn-point share, often repeated:
 *     50% @ (a, b), 50% @ (c, d)       182   …two, three, up to eight per page
 *     131, 342                         112   no parentheses at all
 *     @ (131, 342)                      79   the share elided
 *     (131, 342), (204, 88)             74   several points, no shares
 *     (131, 342, 4)                    120   with a height (all shapes combined)
 *     Basement 50% @ (a, b)             11   prose prefix
 *     50% @ (a, b) Level 2              22   prose suffix
 *     50% @ (a, b) at [[The Velium Keg]] No. 3 on map
 *
 * So: find every comma-separated NUMBER PAIR (optionally a triple, optionally parenthesised),
 * and attach the `NN%` that immediately precedes it when one does. Prose either side is ignored
 * rather than parsed — `Basement`/`Level 2`/`No. 3 on map` are notes for a human, and inventing
 * a floor from them would be exactly the silent inference law 1 forbids.
 *
 * WHAT IT REFUSES: everything with no comma-joined pair in it. `Various` (533 pages), `?` (273),
 * `''Need Info''` (79), `Wanders` (10) and `Droga Main` (11) yield nothing at all, and the
 * trailing `No. 3` of the last shape above is a lone number, so it cannot be mistaken for one
 * half of a coordinate.
 */
const LOC_RE =
  /(?:(\d{1,3})\s*%\s*@?\s*)?\(?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*(?:,\s*(-?\d+(?:\.\d+)?)\s*)?\)?/g

export function parseMobLocations(field: string): MobLoc[] {
  const out: MobLoc[] = []
  LOC_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LOC_RE.exec(field)) !== null) {
    const ns = Number(m[2])
    const ew = Number(m[3])
    if (!Number.isFinite(ns) || !Number.isFinite(ew)) continue
    const z = m[4] === undefined ? undefined : Number(m[4])
    const pct = m[1] === undefined ? undefined : Number(m[1])
    out.push({
      ns,
      ew,
      ...(z !== undefined && Number.isFinite(z) ? { z } : {}),
      ...(pct !== undefined && Number.isFinite(pct) ? { pct } : {})
    })
  }
  return out
}

/** What a mob page states. Every field is optional — absent means "the page didn't say". */
export interface MobPageFacts {
  /** the page's own `|name` value, for the identity check on a non-exact search hit */
  pageName?: string
  levelText?: string
  zone?: string
  dropsWiki?: MobDrop[]
  quests?: MobQuestUse[]
  /** `|location`'s spawn points, in page order. Absent when it stated no numbers. */
  locations?: MobLoc[]
}

/**
 * Classify a mob page's wikitext. Pure — no network, no cache, no electron.
 * A page with no `|known_loot` field (a MerchantPage, a stub) yields no `dropsWiki` at all,
 * which is the honest answer: we did not read a drop list, so we do not have one.
 */
export function parseMobWikitext(wikitext: string): MobPageFacts {
  const out: MobPageFacts = {}
  const name = templateField(wikitext, 'name')
  if (name) out.pageName = unlink(name)
  const level = templateField(wikitext, 'level')
  if (level) {
    const t = unlink(level)
    if (t) out.levelText = t
  }
  const zone = templateField(wikitext, 'zone')
  if (zone) {
    const t = unlink(zone)
    if (t) out.zone = t
  }
  const loot = templateField(wikitext, 'known_loot')
  if (loot) {
    const drops = parseMobLoot(loot)
    if (drops.length) out.dropsWiki = drops
  }
  const quests = templateField(wikitext, 'related_quests')
  if (quests) {
    const uses = parseMobQuestLinks(quests)
    if (uses.length) out.quests = uses
  }
  // Read from the RAW field, not `unlink()`ed: `50% @ (a, b) at [[The Velium Keg]] No. 3 on map`
  // is one of the observed shapes, and stripping the link would leave `No. 3` adjacent to the
  // pair — harmless here (a lone number is not a pair) but the scan wants the text as written.
  const location = templateField(wikitext, 'location')
  if (location) {
    const spawns = parseMobLocations(location)
    if (spawns.length) out.locations = spawns
  }
  return out
}

// ---- LOCAL 1: the own-loot index -----------------------------------------------

/**
 * mob → what WE have looted off it, folded from the parsed `loot` event family (whose `source`
 * is the corpse's mob name). This is the source no wiki can be: personal, offline, always
 * current, and countable.
 *
 * Deliberately a plain in-memory index owned by the caller rather than a persisted cache: it is
 * CHARACTER-SCOPED and EPOCH-SCOPED (a pre-launch character's loot is a dead character's — see
 * AGENTS.md), and the loot history it is derived from is already replayed on every start. So it
 * is rebuilt by the same replay that rebuilds the loot module and can never drift from it.
 *
 * Stacked loots add their `count` (a `--You have looted 2 Bone Chips …--` is two items, not
 * one). A loot line with NO source ("from <mob>'s corpse" absent) is skipped rather than filed
 * under an empty mob — there is no mob to attribute it to.
 */
export class MobLootIndex {
  private byMob = new Map<string, Map<string, MobSeenDrop>>()

  reset(): void {
    this.byMob.clear()
  }

  /** Fold one loot event. `source` is the corpse's mob name (parser strips the `'s`). */
  note(item: string, source: string | undefined, ts: number, count = 1): void {
    if (!item || !source) return
    const key = mobKey(source)
    let items = this.byMob.get(key)
    if (!items) {
      items = new Map()
      this.byMob.set(key, items)
    }
    const ik = item.trim().toLowerCase()
    const row = items.get(ik)
    if (row) {
      row.count += count
      if (ts > row.lastTs) row.lastTs = ts
    } else {
      items.set(ik, { item: item.trim(), count, lastTs: ts })
    }
  }

  /** What we've looted off this mob — most-looted first, ties broken by recency. Never null. */
  drops(mob: string): MobSeenDrop[] {
    const items = this.byMob.get(mobKey(mob))
    if (!items) return []
    return [...items.values()].sort((a, b) => b.count - a.count || b.lastTs - a.lastTs)
  }

  /**
   * The union of what we've looted off EVERY spelling of ONE creature (JOS-142).
   *
   * The index files loot under the raw LOG name, and a raid god the log spells `Cazic-Thule` is
   * the same creature the roster and the wiki call `Cazic Thule`. `main/mobAliases.ts` is the one
   * place that statement lives; this method just reads the key list it produces. `mobKey` is
   * idempotent, so the caller may pass either display names or already-canonical keys.
   *
   * Counts ADD and `lastTs` takes the later — two spellings of one corpse's owner are one mob's
   * history, and reporting them separately would be the same lie as dropping one of them. The
   * display spelling kept is the first one the index recorded for that item, exactly as `note()`
   * already decides it within a single key.
   *
   * ONE spelling short-circuits to `drops()` unchanged — the byte-identical path for the 30
   * roster targets and every one of the 7.9k catalog mobs (JOS-137 constraint 4).
   */
  dropsAcross(spellings: readonly string[]): MobSeenDrop[] {
    if (spellings.length <= 1) return this.drops(spellings[0] ?? '')
    const merged = new Map<string, MobSeenDrop>()
    for (const spelling of spellings) {
      const items = this.byMob.get(mobKey(spelling))
      if (!items) continue
      for (const [ik, row] of items) {
        const prev = merged.get(ik)
        if (!prev) {
          merged.set(ik, { ...row })
          continue
        }
        prev.count += row.count
        if (row.lastTs > prev.lastTs) prev.lastTs = row.lastTs
      }
    }
    return [...merged.values()].sort((a, b) => b.count - a.count || b.lastTs - a.lastTs)
  }

  /** How many distinct mobs we have loot for (test/diagnostic handle). */
  get size(): number {
    return this.byMob.size
  }
}
