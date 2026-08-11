/**
 * Item-name normalization for COUNTING (Task #42).
 *
 * EQ Legends drops upgraded `+N` variants of items broadly — `Sphinx Claw +1`,
 * `Belt of Concordance +1`, `Golden Efreeti Chestplate +1`, etc. A quest that
 * requires `Sphinx Claw` matches item names by exact lowercase, so a looted
 * `Sphinx Claw +1` would count toward NOTHING ("duplicates only complete one
 * quest"). This strips a trailing ` +<digits>` so the variant folds onto its base
 * name at the COUNTING boundary only.
 *
 * Sibling precedent: `spellCanonKey()` (Task #33) strips a trailing Roman rank for
 * spell keys. Same shape: END-anchored, word-bounded, display name untouched.
 *
 * VERIFIED SAFE against the real log: every distinct looted name ending in ` +N`
 * is an upgrade variant of a real base item (weapons, armor, jewelry); no
 * legitimate EQ item is literally named "... +N". Stripping never merges two
 * distinct items.
 *
 * Apply ONLY where held/quest counts are derived (logCounts, reconcile base,
 * quest-item matching, turn-in offered-item comparison) — NEVER at display. Loot
 * history keeps showing `Sphinx Claw +1`.
 */
export function normalizeItemName(name: string): string {
  // Trailing " +<digits>" at end-of-string only (word boundary via the space).
  return name.replace(/ \+\d+$/, '')
}

/** Lowercased, `+N`-stripped counting key for an item name. */
export function itemCountKey(name: string): string {
  return normalizeItemName(name).toLowerCase()
}

/**
 * The upgrade level a display name carries: `0` for a base name, `N` for a ` +N` variant
 * (JOS-196, which folds a mob's variant loots into one drop line and orders the breakdown).
 *
 * Deliberately spelled in terms of `normalizeItemName` rather than a second ` +\d+$` regex:
 * the strip is a SUFFIX, so whatever the one regex above removed is exactly the tail this
 * reads back. One statement in the tree about what a `+N` suffix is — a second copy would be
 * free to disagree with the first about `Sword +1a`.
 */
export function itemVariantLevel(name: string): number {
  const suffix = name.slice(normalizeItemName(name).length)
  return suffix ? Number(suffix.trim().slice(1)) : 0
}
