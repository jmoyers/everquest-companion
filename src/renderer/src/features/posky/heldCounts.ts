// THE one place held counts derive from loot history (Tasks #40/#42/#47). Both quest
// progress and inventory reconcile consume this map; the golden-window loot tests
// (tests/lootDispositionWindows.test.mts) import it directly so the asserted rule IS the
// production rule.
//
// Disposition rules:
//   undefined  — ordinary kept loot → held.
//   'currency' — stored in the currency tab (Wind Runes) → held (quest-countable).
//   'hoard'    — stored in the Dragon Hoard (bank-type storage) → held.
//   'depot'    — stored in the tradeskill depot (bank-type storage) → held.
//   'sold'     — auto-vendored the instant it dropped → GONE, never held; skipping it
//      here also keeps reconcile from ever subtracting a never-held item downstream.
//   'combined' — the looted copy merged with an ALREADY-HELD copy to create the upgraded
//      `created` item (`… to create a <item> +N`). Net-ZERO on the counting key: the
//      counting key strips ` +N` (Task #42), so consumed base, consumed held copy, and
//      created upgrade all share one key — loot +1, consume 2, create 1 nets 0, and the
//      held copy stays counted by its own earlier loot row. Skipping the row is exactly
//      that net-zero (verified: all 293 real combine lines create `<same base> +N`).
//
// Stack counts (Task #47): `--You have looted 2 Bone Chips …--` is TWO items — counted
// rows add `count`, not 1.

import type { LootEvent } from '@shared/types'
import { itemCountKey } from '../../lib/itemName'

/**
 * Fold loot history into held counts keyed by the normalized counting key.
 *
 * ALL TIME, ALWAYS (JOS-141). JOS-128 briefly gave this fold a `since` parameter that narrowed it
 * to loot after an inventory dump was generated — the accumulate half of a
 * baseline-then-accumulate rule. That rule is gone (owner ruling, 2026-08-09: a dump only covers
 * what was open when it was written, so resetting to it ate banked items), and with it the reason
 * for a window. The log is the record; it only grows.
 */
export function computeHeldCounts(lootHistory: readonly LootEvent[]): Record<string, number> {
  const c: Record<string, number> = {}
  for (const e of lootHistory) {
    if (e.disposition === 'sold' || e.disposition === 'combined') continue
    // Fold +N variants onto the base counting key (Task #42): `Sphinx Claw` and
    // `Sphinx Claw +1` are two of the same held item for quest purposes.
    const k = itemCountKey(e.item)
    c[k] = (c[k] ?? 0) + (e.count ?? 1)
  }
  return c
}

/**
 * Fold loot history into WHEN each item last dropped, epoch millis, same counting key.
 *
 * The disposition rule differs from held counts on exactly one row type, deliberately:
 *   'sold'     — SKIPPED. Auto-vendored the instant it dropped, so it never affected a quest;
 *      counting it would float a quest to the top of "most recent drop" for an item the user
 *      never held.
 *   'combined' — COUNTED, unlike in held counts. It is net-ZERO on the count (see above) but it
 *      is a real drop of a real item that is still held on this key, so its recency is true.
 *
 * Absent = never seen dropping. Never 0 — 0 renders as 1970 and sorts as an ancient drop, which
 * is a fabricated answer (law 1). Callers get `undefined` and must say "no drops", not guess.
 * Scope is the current character epoch: history is wiped and replayed per character.
 */
export function computeLastLootedAt(lootHistory: readonly LootEvent[]): Record<string, number> {
  const t: Record<string, number> = {}
  for (const e of lootHistory) {
    if (e.disposition === 'sold') continue
    const k = itemCountKey(e.item)
    const prev = t[k]
    if (prev === undefined || e.ts > prev) t[k] = e.ts
  }
  return t
}
