// itemRenames.ts — OUR-SIDE RENAMES OVER THE SCRAPED ITEM NAMES (JOS-415).
//
// THE SAME ARRANGEMENT `spellCorrections.ts` MAKES FOR THE SPELL DB, and for the same reason:
// `items.json`, `posky.json` and `quests.json` are SCRAPES their generators rewrite wholesale, so
// a hand-edit into any of them is lost on the next run and makes that run's diff unreadable. What
// we know that a committed scrape does not lives HERE, applied at load.
//
// AND A NAME IS A JOIN KEY — the fifth drift class of the spell overlay, restated for items and
// with the same consequence spelled out there: HALF A RENAME IS WORSE THAN NONE. Three committed
// scrapes spell this item, and every one of them agrees with the others today; renaming one and
// not the rest would split the join between the Sky reward, the item card and the quest index into
// two spellings that no longer meet. So the table is applied at EVERY seam that keys or displays
// an item name from a scrape, and each application is stated where it happens.
//
// TWO RULES FALL OUT OF "a name is a join key", and both are implemented below:
//
//   THE OLD SPELLING STAYS ADDRESSABLE. A rename changes what we DISPLAY; it cannot change what a
//   player's log, a stale share bundle or a wiki mirror already says. So an index built through
//   `renamedItems` keeps the old key pointing at the renamed record — a lookup by either spelling
//   answers, and both answer with the CURRENT name. Dropping the old key would turn a rename into
//   a regression for anyone whose data predates it.
//
//   THE ` +N` SUFFIX RIDES ALONG. Item level suffixes are stripped at COUNTING boundaries only
//   (world-model law 2), so a rename must map `Scintillating Bracer of Protection +2` onto
//   `Shimmering Bracer of Protection +2` rather than eating the +2 or refusing the name.
//
// THE ENTRY STATES ITS EVIDENCE AND THE DATE IT WAS CHECKED, the `itemsResearch.ts` bar: an entry
// with no stated source is indistinguishable from a guess, and a guess here is invisible because it
// reads exactly like scraped fact to every consumer above it.

import { itemBaseName } from './itemStats'

/** One item the wiki (and the game) now spell differently from the committed scrapes. */
export interface ItemRename {
  /** The name every committed scrape carries today, exactly as they spell it. */
  from: string
  /** The name to display and link, exactly as the wiki page titles it. */
  to: string
  /** ISO date the rename was last checked against that source. */
  verified: string
  /** What was checked and what it said, in one line. */
  evidence: string
}

export const ITEM_RENAMES: readonly ItemRename[] = [
  // EMPTY TODAY, AND THAT IS THE TABLE WORKING. Its one row — `Scintillating Bracer of
  // Protection` → `Shimmering Bracer of Protection` (verified 2026-08-19, reported BQ25B2) —
  // RETIRED 2026-08-22 when the full rescrape landed the rename upstream in every committed
  // scrape (items.json carries only the new page; posky.json's Rogue Test of Stealth reward says
  // Shimmering; quests.json no longer carries the item at all, its class-test page having become
  // a pure transclusion). The old spelling in a player's log resolves through the wiki's own
  // redirect via itemLookup's live fallback — which is the arrangement this overlay was bridging
  // until the scrapes caught up. `tests/itemRenames.test.mts` keeps the machinery proven on
  // fixtures while the table is empty.
]

/** Lowercased, `+N`-stripped — the same fold `itemKey`/`itemCountKey` use, restated for matching. */
const foldKey = (name: string): string => itemBaseName(name).toLowerCase()

const BY_KEY: ReadonlyMap<string, ItemRename> = new Map(
  ITEM_RENAMES.map((r) => [foldKey(r.from), r])
)

/**
 * The current spelling of an item name, with any ` +N` suffix preserved. Identity for everything
 * the table does not name — never a guess, and never a partial match.
 */
export function renameItemName(name: string): string {
  const hit = BY_KEY.get(foldKey(name))
  if (!hit) return name
  const suffix = / \+\d+$/.exec(name)
  return suffix ? `${hit.to}${suffix[0]}` : hit.to
}

/** Does the table rename this name? For the audit test and for callers that must not double-apply. */
export function isRenamedItem(name: string): boolean {
  return BY_KEY.has(foldKey(name))
}

/** The minimum an item-DB record must have for `renamedItems` to rewrite it. */
interface RenameableEntry {
  page: string
  name?: string
}

/**
 * An item-DB record map with every renamed entry rewritten, and the OLD key kept as an alias onto
 * the same rewritten record (see THE OLD SPELLING STAYS ADDRESSABLE above).
 *
 * NON-MUTATING, the `applySpellCorrections` rule and for the same reason: `items.json` is an
 * ES-imported module object shared by the whole process, and several call sites read it raw.
 * Returns the SAME object when nothing matched, so the common case costs one map miss per entry
 * in the table rather than a copy of 11k records.
 */
export function renamedItems<T extends RenameableEntry>(items: Record<string, T>): Record<string, T> {
  const wanted = ITEM_RENAMES.filter((r) => foldKey(r.from) in items)
  if (wanted.length === 0) return items
  const out: Record<string, T> = { ...items }
  for (const r of wanted) {
    const oldKey = foldKey(r.from)
    const entry = out[oldKey]
    const renamed: T = { ...entry, page: r.to, name: r.to }
    out[foldKey(r.to)] = renamed
    // The old key survives, pointing at the RENAMED record: a log line or a share bundle spelling
    // the old name still resolves, and resolves to the current name.
    out[oldKey] = renamed
  }
  return out
}
