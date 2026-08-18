// pageEraDb.ts — the COMMITTED ERA VERDICTS FOR THE PAGES THAT ARE NOT ITEMS: the record shape,
// its ONE key function, and nothing else. The `itemsDb.ts` posture exactly — Electron-free, loads
// no JSON of its own — so `scripts/scrape-page-era.ts` (which WRITES the file) and
// `main/planner/eraDerive.ts` (which READS it) share one definition and cannot drift.
//
// WHY THERE IS A SECOND CORPUS AT ALL. The item corpus enumerates `embeddedin Template:Itempage`,
// so it holds ITEM pages and only item pages — 11,213 of them. eqlwiki's era pill is drawn on
// LINKS, and the links that decide an era? item's fate are frequently NOT items: the nine
// `Cultural Tradeskills: <Race>` armour-set hubs, the banded/patchwork/silk set pages, a handful of
// quest indexes. JOS-333 could see the pill in the owner's screenshot and could not reach the page
// it sat on; this file is the reach (JOS-341).
//
// TWO TABLES, and they are two because they answer different questions:
//   `pages` — what the WIKI says about a link target. The authority is the wiki's own
//             `action=eqlmetadata` predicate (`outOfEra`), the same endpoint its skin asks before
//             drawing the pill, plus the page's own era TOKEN when it states one. The token is not
//             decoration: it is the difference between "the wiki classifies this page as classic
//             content" and "this page carries no era information at all", and `outOfEra: false`
//             is returned for BOTH. Only the first of those is evidence (law 1).
//   `refs`  — which era? item names which of those pages, from its `|notes` prose. The item corpus
//             stores `|notes` markup-STRIPPED (`cleanSummary`), so the link targets exist nowhere
//             in the shipped bytes; this is where they are kept.
//
// SCOPE, stated so a reader does not mistake it for a whole-wiki table: `refs` covers exactly the
// corpus pages that layers 1-2 leave silent (no resolvable drop zone AND no era claim of their
// own). That set is era-INDEPENDENT — it is defined by an absence of evidence, not by a comparison
// against `CURRENT_ERA` — so opening Kunark does not change which pages belong in it.

/** One non-item page's era verdict, as the wiki states it. */
export interface PageEraEntry {
  /** the title the wiki resolved the link to (a redirect's destination, when it redirected) */
  title: string
  /** `action=eqlmetadata`'s own answer: does the skin draw the out-of-era pill on links here? */
  outOfEra: boolean
  /**
   * The era this page CLAIMS, verbatim — `Kunark`, `Classic`, `Chardok Revamp` — from its `{{X
   * Era}}` banner or its `[[Category:X Era]]`, read by the same parsers the item corpus uses.
   * ABSENT when the page states no era, which is the case `outOfEra: false` cannot distinguish
   * itself: a page nobody has classified is silence, not a claim of being in era.
   */
  eraTag?: string
  /** `true` when the wiki has no such page (a red link in someone's notes) */
  missing?: boolean
  /** which read produced `outOfEra` — the endpoint, or the documented category fallback */
  by: 'eqlmetadata' | 'categories'
}

/** The committed file: `src/main/data/pageEra.json`. */
export interface PageEraFile {
  /** ISO stamp of the fetch that produced this file */
  scrapedAt: string
  /** human-readable provenance (which enumeration and which endpoint produced this) */
  source: string
  /** number of DISTINCT non-item page keys asked about (`pages` is keyed, so this is its size) */
  count: number
  /**
   * `action=eqlmetadata`'s own `eraRevision`, echoed here because it is the CITATION: 156232 is the
   * `Template:PageEra` revid `shared/planner/era.ts` already names for its mirrored register, so a
   * fetch that comes back on a different revision means the wiki moved its era switch under us and
   * the mirror needs re-reading. Absent when the documented category fallback answered instead.
   */
  eraRevision?: number
  /** `pageEraKey(link target as the notes spell it)` → the wiki's verdict for it */
  pages: Record<string, PageEraEntry>
  /** `itemKey(item page title)` → the non-item titles its `|notes` name, spelled as written */
  refs: Record<string, string[]>
  /**
   * THE DROPPERS (the owner's Life's Guard addition, JOS-341): `pageEraKey(mob name)` →
   * `action=eqlmetadata`'s `outOfEra` for that MOB's page.
   *
   * A BOOLEAN AND NOT A RECORD, because only one direction is used. A dropper the wiki badges out
   * is a positive claim about content — the pill the owner is looking at sits on that very link —
   * while `false` covers both "classified as classic" and "nobody has classified this mob", and
   * neither of those is evidence that an item is REACHABLE. The zone table answers that question
   * and answers it better, so the mob's own era token is not fetched at all: 5,006 names cost 12
   * POSTs this way and 112 GETs the other way, for a field nothing would read.
   *
   * PRESENT MEANS ASKED. A mob absent from this table was never put to the endpoint, and law 1
   * makes that silence, not a `false` — the derivation requires every dropper to be present AND
   * true before it will speak.
   */
  mobs: Record<string, boolean>
  /**
   * THE SPELL PAGES (JOS-393): `pageEraKey(spell page title)` → `action=eqlmetadata`'s `outOfEra`
   * for that page.
   *
   * WHY SPELLS ARE HERE AT ALL. The wiki draws its era pill on the link to a SPELL page exactly the
   * way it draws one on a link to an item or a mob, and the committed spell catalog
   * (`spells.json`, `embeddedin Template:Spellpage`) records everything on those pages EXCEPT that
   * verdict. So `Sloths Healing` — `{{Kunark Era}}`, `Shaman - Level 50+` — was offered to a level
   * 50 shaman as a spell newly available to him, on a server that has not opened Kunark.
   *
   * A BOOLEAN AND NOT A RECORD, the `mobs` reasoning applied unchanged: only the OUT direction is
   * read. A spell page the wiki badges is a positive claim about content; `false` covers both "the
   * wiki files this as classic" and "nobody has classified this page", and neither of those is a
   * reason to say anything to the player. The page's own `{{X Era}}` token would be free to keep
   * (the spell scrape's wikitext cache is committed) and is deliberately NOT kept: a field no
   * reader reads is a field that rots.
   *
   * PRESENT MEANS ASKED, and the keys asked are the spell scrape's own enumeration UNION the names
   * `spells.json` carries — the two differ on 53 rows (the wiki's `spellname` field spells a few
   * pages with a backtick, and a few catalog names are redirects that embed no template), and the
   * catalog's name is the only handle the loader has. A spell absent from this table was never put
   * to the endpoint, and law 1 makes that silence: `spellEra.ts` marks nothing for it.
   */
  spells: Record<string, boolean>
}

/**
 * The canonical key for a link target. Case-folded and whitespace-collapsed, underscores folded to
 * spaces — MediaWiki's own title rules for everything but the first letter, which the wiki
 * capitalizes and we simply do not depend on.
 *
 * NOT `itemKey`: that one strips a trailing ` +N` item-level suffix (law 2), which is right for a
 * loot line and wrong for a page title — there is no such thing as "Cultural Tradeskills: Human +3".
 */
export function pageEraKey(title: string): string {
  return title.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}
