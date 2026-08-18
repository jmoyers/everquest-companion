// gearplan/gearPlanSignals.ts — THE FOUR THINGS A PICKER ROW MUST SAY BEFORE YOU PICK IT.
//
// A planner that offers you a helm is making a suggestion, and four facts change whether the
// suggestion is any good:
//   * IS IT EVEN IN THE GAME YET (era),
//   * CAN THIS CHARACTER USE IT (class),
//   * DO I ALREADY HAVE ONE (ownership),
//   * DID I ALREADY ASK FOR ONE (the wish list).
// All four are already computed somewhere in this app. This file states them as ONE row-shaped
// verdict so both pickers draw the same answer, and so the answer is testable without a popover.
//
// ---------------------------------------------------------------------------------------------
// EVERY VERDICT IS BORROWED, NOT RE-DERIVED.
//   * ERA — `plannerData.eraChip`, which is `era.ts layeredVerdict`'s three witnesses (zone
//     provenance, the page's own banner, the acquisition-path derivation). Its `null` means IN ERA
//     AND NOTHING TO SAY, which is the common case and must stay silent.
//   * CLASS — the overlap between the item's own class list and the loadout this character is
//     actually running (`useGearClasses`, the same trio the Gear tab filters by).
//   * OWNERSHIP — `gearOwnership.ownershipFor`, the dump-plus-loot-history join the Gear tab's
//     Owned column already reads. Keyed by `itemKey`, so it answers for a donor exactly as well as
//     for a gear row: a donor IS an item.
//
// ---------------------------------------------------------------------------------------------
// THEY ARE WARNINGS FIRST, AND FILTERS ONLY WHEN ASKED.
//
// THIS FILE USED TO SAY "WARNINGS, NEVER FILTERS", and the argument was sound as far as it went: a
// picker that hides rows answers "why isn't it in the list" with nothing at all, and two of the
// three are cases a planner legitimately wants — gear that is not in era yet is exactly what a plan
// is FOR, and an item you already own is exactly what you want to socket.
//
// What that ruling got wrong is that it settled a question the USER is entitled to answer. Once a
// row can say four things about itself, "show me only the ones I can actually get" is a reasonable
// request, and refusing it on the grounds that someone might be confused is the paternalism the
// era chip's own tooltip diet warns about. The four rules that keep the original argument's force:
//
//   1. A FILTER IS OFF UNTIL IT IS TURNED ON. Nothing is hidden from anyone who has not asked.
//      (The one exception is era, and it is not this file's to make - see `hidesRow`.)
//   2. NOTHING IS EVER HIDDEN SILENTLY. `hidesRow` is a predicate, not a `filter` call, precisely
//      so the caller counts what it drops and says so. A picker that hides four rows and mentions
//      none of them is the surface the old ruling was actually afraid of.
//   3. UNKNOWN IS NOT EXCLUDED BY THE TWO FILTERS THAT ARE OURS TO DECIDE (law 1). `class?` is a
//      gap in the wiki, not a refusal, and a filter that treats our ignorance as your answer turns
//      a missing page into a missing item.
//   4. THE CHIPS DO NOT GO AWAY. A row that survives a filter still wears everything it had to say.
//
// AND UNKNOWN IS NOT A FAILURE (law 1). A page that stated no class list cannot be shown to
// exclude you, so it reads `class?` rather than a refusal — the same reading `socketCompatibility`
// gives it. An era our tables cannot place reads `era?`, which `eraChip` already spells that way
// because it is a fact about our data rather than about the item.
//
// PURE AND NODE-TESTED (`tests/gearPlanSignals.test.mts`); the hook that feeds it lives in the view.

import type { ClassAbbr } from '../../../../shared/classCombo'

/** Can the character this app is watching actually use this? */
export type ClassFit =
  /** the item names at least one class in the current loadout */
  | 'fits'
  /** the item names classes, and none of them is one of yours */
  | 'no'
  /** the item states no class list, or no loadout is known — law 1, never a refusal */
  | 'unknown'

/**
 * R2's class question, asked of the PLAYER rather than of a donor-host pair.
 *
 * TWO KINDS OF SILENCE, AND BOTH READ `unknown`. An item that states no classes cannot be shown to
 * exclude you; a character whose loadout the app has not inferred yet cannot be shown to be
 * excluded by anything. Reporting either as `no` would put a warning on a row for a fact nobody
 * established, which is the exact failure law 1 exists to prevent.
 */
export function classFitOf(
  itemClasses: readonly ClassAbbr[],
  loadout: readonly ClassAbbr[]
): ClassFit {
  if (itemClasses.length === 0 || loadout.length === 0) return 'unknown'
  return itemClasses.some((c) => loadout.includes(c)) ? 'fits' : 'no'
}

/** Where a copy of this is, in the fewest words that are still true. */
export interface OwnedSignal {
  /** `Bank +2`, `Equipped`, `Inventory x2` — `gearOwnership.factText`, already spelled */
  label: string
  /** the log saw it looted but the dump names no copy — you HAD one (rule 4) */
  lootedOnly: boolean
}

/** Everything a picker row says about itself beyond its own name. */
export interface RowSignals {
  /** `null` = in era and nothing to say; otherwise the chip `eraChip` already wrote */
  era: { label: string; unknown: boolean; tooltip: string } | null
  classFit: ClassFit
  /** `null` = this character has no copy and never looted one */
  owned: OwnedSignal | null
  /**
   * Already on the wish list.
   *
   * THE FOURTH SIGNAL, AND THE ONLY ONE ABOUT A DECISION YOU ALREADY MADE. The other three are
   * facts about the item or the character; this one is a fact about your own list, and it answers
   * the question a picker cannot otherwise answer — "did I already decide I wanted this?" Without
   * it the only way to know is to leave the board and go read the wish list.
   *
   * It is BORROWED like the rest: `wishlist.hasWish`, the same predicate the wish control writes
   * through, so a row cannot claim to be wished by a rule the list itself does not use.
   */
  wished: boolean
}

/**
 * IS THIS ROW WORTH WARNING ABOUT AT ALL? The picker uses this to decide whether to draw a chip
 * strip, because a row with nothing to say must not grow an empty one — a `fits`, in-era, unowned
 * item is the ordinary case and gets no decoration whatsoever.
 */
export function hasSignal(signals: RowSignals): boolean {
  return (
    signals.era !== null ||
    signals.classFit !== 'fits' ||
    signals.owned !== null ||
    signals.wished
  )
}

// ---- narrowing the pool ------------------------------------------------------------------------

/**
 * WHICH ROWS THE USER HAS ASKED TO SEE. Every field is "keep only", and every one is OFF by
 * default, so an untouched board offers the whole pool.
 *
 * ERA IS NOT IN HERE, and that is deliberate rather than an omission. The era toggle is
 * `plannerData.useEraOnly` — one control, one `eq.planner.era` key, already shared by the Effects
 * and Wish list tabs — so this tab reads it rather than growing a fourth opinion about what era
 * means. It is also the one filter that ships ON, which is the owner's ruling on that key and not
 * this tab's to override; `hidesRow` takes it as its own argument to keep that provenance visible.
 */
export interface GearPlanRowFilter {
  /** keep only rows your newest dump or your loot history can account for */
  ownedOnly: boolean
  /** keep only rows a class in the current loadout can actually wear */
  usableOnly: boolean
  /** keep only rows already on the wish list */
  wishedOnly: boolean
}

/** The shipped bar: nothing narrowed. These narrow the POOL a picker offers, never the board. */
export const NO_ROW_FILTER: GearPlanRowFilter = {
  ownedOnly: false,
  usableOnly: false,
  wishedOnly: false
}

/**
 * SHOULD THIS ROW BE HIDDEN? A PREDICATE, NOT A `filter` CALL — see rule 2 in the header. The
 * caller keeps both lists so it can say how many it dropped, which is the whole thing that makes
 * hiding rows honest.
 *
 * `eraOnly` rides separately because it is the shared control's value rather than one of ours.
 *
 * ERA HIDES ON UNKNOWN TOO, and that is BORROWED, not decided here: `plannerData.eraHides` states
 * the owner ruling of 2026-08-13 in full — a question mark under a filter called "Current era" is
 * a leak, not a courtesy, because the filter's promise is "what you can get" and "we cannot say"
 * fails that promise the same way "no" does. `era === null` is exactly `in-era`, so testing for
 * non-null reproduces that rule without restating it.
 *
 * THE OTHER TWO DO NOT, and the asymmetry is law 1 rather than an inconsistency. Era's unknowns
 * were MEASURED to be mostly real out-of-era items hiding behind pages the corpus lacks; a missing
 * class list is just a missing class list, and `class?` under "usable by my classes" would hide an
 * item nobody has shown you cannot wear.
 */
export function hidesRow(
  signals: RowSignals,
  filter: GearPlanRowFilter,
  eraOnly: boolean
): boolean {
  if (eraOnly && signals.era !== null) return true
  if (filter.ownedOnly && signals.owned === null) return true
  // `unknown` survives: a page that states no classes has not excluded you.
  if (filter.usableOnly && signals.classFit === 'no') return true
  if (filter.wishedOnly && !signals.wished) return true
  return false
}
