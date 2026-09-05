// shared/itemSources.ts — "where does this item come from?", the PURE half: the catalog inversion,
// the two-witness merge, and the fold that turns both into a gear row's drop columns.
//
// PROMOTED FROM `renderer/lib/itemSources.ts` (fork decision, kaltinril 2026-08-25) the moment MAIN
// became a consumer: the gear index builder (`src/main/planner/gearIndex.ts`) now carries each
// row's drop mobs, zones and levels on the wire, which is data-server ruling 4 (docs/plans/
// data-server.md - *the renderer never munges domain data*; views arrive render-ready). Until then
// the Gear tab folded 6,814 rows through this merge on every window, once per fetch - a derivation
// the renderer had no business owning and main could not share, because the merge lived behind
// `@shared` type aliases and a bundled-JSON singleton only the renderer could load.
//
// WHAT STAYS IN THE RENDERER is the SINGLETON: `renderer/lib/itemSources.ts` keeps `sourceIndex()`
// and `sourcesFor()` over the bundled catalog for the surfaces that ask per item (the Loot
// drill-down, the wish list's camp lines), and re-exports everything here so no call site moved.
// Main builds its own index from the same committed JSON (`eraDerive.ts` already imports it).
//
// RELATIVE value imports and no JSON import (the shared/planner house rule): this file is loaded by
// the node runner, by main and by the renderer, and states nothing about where the catalog lives.
//
// It says only what the catalog says (law 1): a mob, its page, the level text VERBATIM (a range as
// often as a number) and its zones. No rarity - the compact catalog carries item names only - and
// no invented drop rate.

import type { ItemDropSource } from './types'
import type { MobEntry } from './mobTypes'
import { itemBaseName } from './itemStats'

/** One place an item is known to come from. Exactly what the mob page stated, nothing more. */
export interface ItemSource {
  /** the mob's in-game name, as the page writes it ("the froglok shin lord") */
  mob: string
  /** wiki page title — present whenever the catalog row has one (it always does today) */
  mobPage?: string
  /** level EXACTLY as stated: a RANGE ("36-40") as often as a number ("30") */
  levelText?: string
  /** home zone(s) from the page; `[]` when it stated none ("Various" is a real value, not a gap) */
  zones: string[]
}

export type SourceIndex = ReadonlyMap<string, ItemSource[]>

/**
 * The index key for an item NAME — main's `itemsDb.ts itemKey`, re-applied. Kept as one exported
 * function so the join has exactly one spelling to be wrong about: `+N` stripped, case folded,
 * which is what the ~1,900 catalog drop names carrying an upgrade suffix need to land.
 */
export function sourceItemKey(name: string): string {
  return itemBaseName(name).toLowerCase()
}

/**
 * The PURE builder: catalog rows → `itemKey → sources`. MEASURED over the committed catalog
 * (2026-08-04, node, warm): 7,872 pages, 4,410 of them with a loot list, 32,822 item→mob links
 * folding onto 5,357 distinct item keys.
 *
 * Sources keep the CATALOG'S OWN ORDER (the wiki's enumeration) rather than being sorted: there
 * is no rarity or drop-rate signal here to rank by, and inventing one (alphabetical, level) would
 * dress an arbitrary pick up as "the best camp". A mob is listed ONCE per key even when its page
 * lists both "Ghoulbane" and "Ghoulbane +1" — those are one item (law 2).
 */
export function buildSourceIndex(mobs: readonly MobEntry[]): Map<string, ItemSource[]> {
  const index = new Map<string, ItemSource[]>()
  for (const mob of mobs) {
    if (!mob.drops?.length) continue
    const source: ItemSource = { mob: mob.name, zones: mob.zones ?? [] }
    if (mob.page) source.mobPage = mob.page
    if (mob.level) source.levelText = mob.level
    for (const drop of mob.drops) {
      const key = sourceItemKey(drop)
      if (key === '') continue
      const list = index.get(key)
      if (!list) index.set(key, [source])
      else if (!list.some((s) => s.mobPage === source.mobPage && s.mob === source.mob)) list.push(source)
    }
  }
  return index
}

/**
 * BOTH WITNESSES TO "WHO DROPS THIS", AS ONE LIST.
 *
 * The mob catalog (`|known_loot`, inverted above) and the item page (`|dropsfrom`, which arrives
 * on a `PlannerDonor` row, a `GearRow` or an `ItemKnowledge` record) are the two halves of the
 * same wiki, and they omit different things — measured 2026-08-04, 126 effect-bearing donors have
 * NO catalog source at all while their own page names a mob for a third of them. A surface that
 * read only the catalog answered those with "No known source" while the page it was scraped from
 * said otherwise.
 *
 * WHEN BOTH NAME THE SAME MOB THE CATALOG ROW WINS WHOLE (matched case-folded — the two sides of
 * the wiki disagree about capitalisation constantly). It is the EQL-specific witness and the only
 * one carrying level text; folding the page's zone into it as well would split one camp across two
 * spellings of one place ("Lower Guk" and "The City of Guk" as separate headings) to learn
 * nothing. A page-only mob contributes a row with no level text, which renders as a bare name.
 */
export function mergeItemSources(
  catalogSources: readonly ItemSource[],
  wiki: readonly ItemDropSource[] | undefined
): ItemSource[] {
  const out = [...catalogSources]
  const seen = new Set(catalogSources.map((s) => s.mob.trim().toLowerCase()))
  for (const w of wiki ?? []) {
    const id = w.mob.trim().toLowerCase()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push({ mob: w.mob, zones: w.zone === undefined ? [] : [w.zone] })
  }
  return out
}

/** A gear row's drop columns, as the index carries them (`GearRow`'s four optional arrays). */
export interface DropDetails {
  dropMobs: string[]
  dropZones: string[]
  /** `dropMobs[i]`'s stated level, `''` when the catalog stated none */
  dropLevels: string[]
  /** `dropMobs[i]`'s catalog page title, `''` when the witness stated none — the link's pin */
  dropPages: string[]
}

/**
 * WHERE THIS ITEM COMES FROM, folded for a table cell. `dropLevels[i]` and `dropPages[i]` ARE
 * `dropMobs[i]`'s — the arrays stay ALIGNED, never independently deduplicated, because a cell that
 * showed mob A beside mob B's level would be a fabricated claim. `''` marks a fact the catalog
 * never stated (absent is not a value). Zones dedupe across all sources — a zone is a place, not
 * a per-mob fact.
 *
 * A MOB NAME IS LISTED ONCE, first page wins, and that dedupe is NOT redundant with the merge
 * above: the merge folds the PAGE witness into the CATALOG witness, but the catalog itself names
 * "a bandit" on four pages (Lake Rathe, Lesser Faydark, Rathe Mountains, Western Karana) and
 * `buildSourceIndex` keeps all four because they are four mobs. MEASURED 2026-08-25 over the
 * committed corpus: 309 such repeats across 201 items, and none of them case-only. A Mob cell
 * reading `a bandit +3` is the honest one-line summary; `a bandit, a bandit, a bandit` is not.
 * The first page's level and link are the ones the cell shows, which is what "first wins" means.
 */
export function dropDetails(sources: readonly ItemSource[]): DropDetails {
  const dropMobs: string[] = []
  const dropLevels: string[] = []
  const dropZones: string[] = []
  const dropPages: string[] = []
  const seen = new Set<string>()
  for (const s of sources) {
    const mob = s.mob.trim()
    const id = mob.toLowerCase()
    if (id === '') continue
    // The ZONES of a repeated name still count — the second "a bandit" page is a second place the
    // item drops in, and the cell that says `a bandit +3` owes its reader Rathe Mountains too.
    for (const zone of s.zones) {
      const z = zone.trim()
      if (z !== '' && !dropZones.includes(z)) dropZones.push(z)
    }
    if (seen.has(id)) continue
    seen.add(id)
    dropMobs.push(mob)
    dropLevels.push(s.levelText?.trim() ?? '')
    dropPages.push(s.mobPage ?? '')
  }
  return { dropMobs, dropZones, dropLevels, dropPages }
}
