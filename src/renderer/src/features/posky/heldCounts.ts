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
//   'destroyed' — `You successfully destroyed <N> <Item>.` → SUBTRACTS `count` (JOS-401). The
//      only negative row on the lane, and the reason the log can now answer a question this
//      app spent two releases saying only a person could.
//
// Stack counts (Task #47): `--You have looted 2 Bone Chips …--` is TWO items — counted
// rows add `count`, not 1.
//
// ---------------------------------------------------------------------------
// A DESTROY IS CHRONOLOGICAL, AND IT FLOORS AT 0 (JOS-401)
// ---------------------------------------------------------------------------
// The subtraction happens WHERE THE ROW SITS in the history, not at the end of it, and the running
// count never goes below zero. Both halves are load-bearing:
//
//   * A destroy can only take what the log SAW you holding. Destroy a stack you looted before this
//     log began and the key would go negative — and a negative would then silently eat the next
//     copy you farm, which is the "count that is too low" failure the owner ruled against on
//     2026-08-09 (reconcile.ts carries that ruling).
//   * Because the floor is applied per row rather than to the total, `loot 1, destroy 3, loot 2`
//     reads 2 rather than 0: the second loot is a fresh copy and nothing owes the first destroy
//     anything. A max(0, sum) at the end would be the wrong arithmetic for exactly that history.

import type { LootEvent } from '@shared/types'
// Relative, per the repo's node-tested-module rule (this file is imported by the golden-window
// loot suites): a `@shared/*` VALUE import needs the renderer's bundler alias, a type-only one
// does not.
import { isDestroyed } from '../../../../shared/lootDisposition'
import { itemCountKey } from '../../lib/itemName'

/**
 * Fold loot history into held counts keyed by the normalized counting key.
 *
 * ALL TIME, ALWAYS (JOS-141). JOS-128 briefly gave this fold a `since` parameter that narrowed it
 * to loot after an inventory dump was generated — the accumulate half of a
 * baseline-then-accumulate rule. That rule is gone (owner ruling, 2026-08-09: a dump only covers
 * what was open when it was written, so resetting to it ate banked items), and with it the reason
 * for a window. The log is the record; it only grows.
 *
 * It only grows as a FILE, that is — the count it yields does not, since JOS-401: this is the
 * all-time log witness, so it is the one fold that nets every destroy the log has ever recorded,
 * with no instant to window them by.
 */
export function computeHeldCounts(lootHistory: readonly LootEvent[]): Record<string, number> {
  return foldHeld(lootHistory, () => true)
}

/**
 * The fold, with a window on it. ONE implementation so the disposition rule above cannot be stated
 * twice and drift: a windowed count is the same count over fewer rows, never a second opinion about
 * what "held" means.
 */
function foldHeld(
  lootHistory: readonly LootEvent[],
  keep: (e: LootEvent, key: string) => boolean
): Record<string, number> {
  const c: Record<string, number> = {}
  for (const e of lootHistory) {
    if (e.disposition === 'sold' || e.disposition === 'combined') continue
    // Fold +N variants onto the base counting key (Task #42): `Sphinx Claw` and
    // `Sphinx Claw +1` are two of the same held item for quest purposes.
    const k = itemCountKey(e.item)
    if (!keep(e, k)) continue
    const n = e.count ?? 1
    // The one negative row on the lane (JOS-401). Floored HERE, per row — see the header.
    c[k] = isDestroyed(e) ? Math.max(0, (c[k] ?? 0) - n) : (c[k] ?? 0) + n
  }
  return c
}

/**
 * HOW MANY OF EACH ITEM THE LOG SAYS YOU DESTROYED AFTER AN INSTANT (JOS-401) — the discount a
 * witness that spoke at that instant owes.
 *
 * It is a SEPARATE walk rather than a signed reading of `foldHeld`, and the reason is the floor
 * above. A windowed held-count fold starts at zero and clamps there, so a destroy with no loot
 * beside it inside the window vanishes from it — which is right for "what has the log seen drop
 * since the dump" and useless as a discount for the dump itself, which vouched for copies the
 * window never saw. reconcile.ts subtracts this from the witness's own base, in the same place and
 * the same way it subtracts the turn-ins made after that witness (JOS-186's rule).
 *
 * Sold/combined rows are irrelevant here by construction: only a destroy row is ever counted.
 */
function foldDestroyed(
  lootHistory: readonly LootEvent[],
  keep: (e: LootEvent, key: string) => boolean
): Record<string, number> {
  const c: Record<string, number> = {}
  for (const e of lootHistory) {
    if (!isDestroyed(e)) continue
    const k = itemCountKey(e.item)
    if (!keep(e, k)) continue
    c[k] = (c[k] ?? 0) + (e.count ?? 1)
  }
  return c
}

/** Destroys recorded strictly after one instant — the discount a DUMP owes (reconcile.ts). */
export function computeDestroyedAfter(
  lootHistory: readonly LootEvent[],
  after: number
): Record<string, number> {
  return foldDestroyed(lootHistory, (e) => e.ts > after)
}

/**
 * The same discount PER KEY — a hand-stated count is a statement about one item at one moment, so
 * each key is discounted only by the destroys recorded after ITS statement. A key nobody has
 * spoken about is absent from the window map and contributes nothing (`Infinity`, exactly as the
 * per-key loot window reads it).
 */
export function computeDestroyedAfterPerKey(
  lootHistory: readonly LootEvent[],
  afterByKey: Record<string, number>
): Record<string, number> {
  return foldDestroyed(lootHistory, (e, k) => e.ts > (afterByKey[k] ?? Infinity))
}

/**
 * WHAT THE LOG HAS SEEN DROP SINCE AN INSTANT (JOS-186) — the forward half of a baseline.
 *
 * The `rebaseline` count source reads this: an inventory dump is an OBSERVATION of what you were
 * holding when it was written, so the honest accumulation on top of it is the loot that arrived
 * afterwards, and the log older than the dump is discarded rather than added (reconcile.ts argues
 * the whole rule and states its cost). Strictly AFTER, because a dump's generation instant is
 * floored to the second and a drop stamped in the same second is as likely to be inside the file
 * as outside it — counting it would double an item the dump already reported.
 *
 * This is JOS-128's `since` window, returning as an OPT-IN mode rather than as the default it was
 * reverted for being.
 *
 * IT COUNTS DROPS, GROSS — DESTROYS ARE NOT IN IT (JOS-401), and that is the one place this file
 * departs from the ticket's letter. The obvious reading is that both windowed folds should net
 * destroys the way the all-time fold does; the arithmetic says otherwise. The windowed number is
 * ADDED to a witness (`dump + looted since`) that the same destroys are already discounted from in
 * reconcile.ts, so netting them here as well subtracts every destroy twice: dump 3, loot 4, destroy
 * 2 would read 3 where the truth is 5. And netting here INSTEAD of discounting the witness cannot
 * work either, because this fold floors at zero and a destroy with no loot beside it inside the
 * window then vanishes — which is exactly the case the ticket's acceptance criteria name ("a
 * destroy stamped after the dump lowers the count"). One subtraction per destroy, applied where the
 * witness is: `computeDestroyedAfter` above is the other half.
 */
export function computeHeldCountsAfter(
  lootHistory: readonly LootEvent[],
  after: number
): Record<string, number> {
  return foldHeld(lootHistory, (e) => !isDestroyed(e) && e.ts > after)
}

/**
 * The same window, PER KEY (JOS-186) — one instant for each item a hand-stated count speaks about.
 *
 * A hand-stated count is a statement about one item at one moment, so each key gets its own
 * window and a key nobody has stated anything about contributes NOTHING: an absent entry means
 * "no baseline here", which is why the default is `Infinity` rather than 0. The result therefore
 * only ever mentions keys that carry a statement.
 *
 * Gross drops, for the reason the instant-windowed fold above states at length: the statement is
 * discounted by `computeDestroyedAfterPerKey` in reconcile.ts, once.
 */
export function computeHeldCountsAfterPerKey(
  lootHistory: readonly LootEvent[],
  afterByKey: Record<string, number>
): Record<string, number> {
  return foldHeld(lootHistory, (e, k) => !isDestroyed(e) && e.ts > (afterByKey[k] ?? Infinity))
}

/**
 * Fold loot history into WHEN each item last dropped, epoch millis, same counting key.
 *
 * The disposition rule differs from held counts on exactly two row types, deliberately:
 *   'sold'     — SKIPPED. Auto-vendored the instant it dropped, so it never affected a quest;
 *      counting it would float a quest to the top of "most recent drop" for an item the user
 *      never held.
 *   'combined' — COUNTED, unlike in held counts. It is net-ZERO on the count (see above) but it
 *      is a real drop of a real item that is still held on this key, so its recency is true.
 *   'destroyed' — SKIPPED (JOS-401). This map answers "when did this last DROP", and a destroy is
 *      the opposite event: it names no mob and adds nothing to your bags. Letting one stamp the
 *      recency would sort a quest to the top of "most recent drop" because the player emptied a
 *      bag, which is the sharpest possible version of counting a subtraction as an acquisition.
 *
 * Absent = never seen dropping. Never 0 — 0 renders as 1970 and sorts as an ancient drop, which
 * is a fabricated answer (law 1). Callers get `undefined` and must say "no drops", not guess.
 * Scope is the current character epoch: history is wiped and replayed per character.
 */
export function computeLastLootedAt(lootHistory: readonly LootEvent[]): Record<string, number> {
  const t: Record<string, number> = {}
  for (const e of lootHistory) {
    if (e.disposition === 'sold' || isDestroyed(e)) continue
    const k = itemCountKey(e.item)
    const prev = t[k]
    if (prev === undefined || e.ts > prev) t[k] = e.ts
  }
  return t
}
