// seenVariants.ts (JOS-196) — the ONE fold that turns your own loot history for a mob into
// DROP LINES, plus the perceived rate those lines carry.
//
// THE PROBLEM IT SOLVES. `MobLootIndex` (src/main/mobLookupParse.ts) files your loot under the
// RAW item name, exactly as the log spelled it — which is correct, because that index is a
// record of what happened and `Sphinx Claw +1` is what the line said. But EQ Legends drops
// upgraded `+N` variants of nearly everything, so one item's history off one mob arrives as
// three rows saying `1×`, `1×`, `1×` where the honest reading is `3×`. Every count on the page
// was quietly divided by however many upgrade tiers the mob had rolled for you, and a drop rate
// derived from any one of those rows understates the item by the same factor.
//
// ONE DERIVATION, NO SECOND PARSER (repo law 2, and JOS-66's `itemCountKey` is that derivation).
// This module folds on `itemCountKey` — the same key the quest/held/reconcile counting boundaries
// use — and `itemVariantLevel`, which is spelled in terms of `normalizeItemName` rather than a
// second ` +N` regex. There is exactly one statement in the tree about what a `+N` suffix is.
//
// FOLDING IS A DISPLAY DECISION, AND THE VARIANTS ARE NEVER THROWN AWAY. The group keeps every
// row it folded, in upgrade order, so the page can collapse by default and still hand over the
// individual `+1` / `+2` the moment the reader asks (law 2: canonicalize at boundaries, display
// raw — the raw names are one click away, never deleted).

// The TYPE may keep the alias (it is erased); the counting keys are VALUE imports and are
// spelled relatively, so the node test suite can import this module directly — mobSearch.ts's
// precedent, now repo law.
import type { MobSeenDrop } from '@shared/types'
import { itemCountKey, itemVariantLevel, normalizeItemName } from '../../lib/itemName'

/** One DROP LINE: every `+N` variant of one item you have looted off one mob, folded together. */
export interface SeenVariantGroup {
  /** the counting key every member shares (`itemCountKey`) — the join key for the wiki row */
  key: string
  /**
   * What the line calls itself. The BASE-named row's own spelling when you have looted the base
   * item (the game's casing beats ours), otherwise the base name derived from a variant — and
   * when the group is a single unvarianted row, that row's name untouched.
   */
  item: string
  /** every variant's counts added — stacked loots already counted their stack size */
  count: number
  /** the most recent loot across every variant */
  lastTs: number
  /** the rows that folded in, base first then ascending `+N`. Never empty. */
  variants: MobSeenDrop[]
  /**
   * Whether this line is hiding anything — true when ANY member carries a `+N` suffix, which
   * includes the one-row group whose only row is a `+1`. That case looks unfolded and is not:
   * the line says `Sphinx Claw` because it joins the wiki's `Sphinx Claw` row, and the reader
   * is owed the affordance that says which claw it actually was.
   */
  hasVariants: boolean
}

/**
 * Fold a mob's `dropsSeen` into drop lines.
 *
 * Ordering mirrors `MobLootIndex.drops()` exactly — most-looted first, ties broken by recency —
 * applied to the COMBINED counts, because a fold that left the rows in their pre-fold positions
 * could seat a 6× line below a 2× one.
 */
export function foldSeenVariants(seen: readonly MobSeenDrop[]): SeenVariantGroup[] {
  const byKey = new Map<string, MobSeenDrop[]>()
  for (const row of seen) {
    const key = itemCountKey(row.item)
    const rows = byKey.get(key)
    if (rows) rows.push(row)
    else byKey.set(key, [row])
  }

  const groups: SeenVariantGroup[] = []
  for (const [key, rows] of byKey) {
    // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 8: MobSeenDrop comes from a corpus still bundled in the renderer (mobs/posky/bosses JSON). Moves behind knowledge queries when that surface cuts over.
    const variants = [...rows].sort(
      (a, b) => itemVariantLevel(a.item) - itemVariantLevel(b.item) || b.count - a.count
    )
    const base = variants.find((v) => itemVariantLevel(v.item) === 0)
    const hasVariants = variants.some((v) => itemVariantLevel(v.item) > 0)
    groups.push({
      key,
      item: base?.item ?? (hasVariants ? normalizeItemName(variants[0].item) : variants[0].item),
      // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 8: MobSeenDrop comes from a corpus still bundled in the renderer (mobs/posky/bosses JSON). Moves behind knowledge queries when that surface cuts over.
      count: variants.reduce((n, v) => n + v.count, 0),
      // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 8: MobSeenDrop comes from a corpus still bundled in the renderer (mobs/posky/bosses JSON). Moves behind knowledge queries when that surface cuts over.
      lastTs: variants.reduce((t, v) => Math.max(t, v.lastTs), 0),
      variants,
      hasVariants
    })
  }
  return groups.sort((a, b) => b.count - a.count || b.lastTs - a.lastTs)
}

/**
 * The PERCEIVED drop rate: how many of this item you have looted per kill of this mob, out of
 * YOUR OWN observed history and nothing else.
 *
 * It is "perceived" and not "the drop rate", and the difference is not pedantry: the denominator
 * is the kills this character has RECORDED, so a mob you killed before you ran the app, or killed
 * in a group where somebody else looted the corpse, is a kill with no drop attached and drags the
 * number down. The numerator counts ITEMS (a stack of 2 Bone Chips is two), so a stacking item can
 * legitimately read above one per kill. Both facts belong to the same honest measurement; the
 * display states the denominator so the reader can judge it.
 *
 * NULL, NEVER ZERO (JOS-78's rule): with no recorded kills there is nothing to divide by, and
 * `0.00 per kill` would be a claim rather than an absence of one.
 */
export function perceivedDropRate(count: number, kills: number | undefined): number | null {
  if (!kills || kills <= 0 || count <= 0) return null
  return count / kills
}
