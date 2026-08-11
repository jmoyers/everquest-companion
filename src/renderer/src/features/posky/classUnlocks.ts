// ============================================================================
// classUnlocks.ts — the Classes tab's whole model (JOS-148), pure.
// ============================================================================
//
// One row per class: how many of that class's Sky tests you have turned in, out of how many
// exist, and whether the class is UNLOCKED as a primary. No React and no data bundle, so a plain
// node test pins every decision below (tests/classUnlocks.test.mts).
//
// THE TWO SOURCES, AND WHY THERE HAVE TO BE TWO.
//
// The tempting model is one source: all M tests turned in, therefore unlocked. It is incomplete,
// and the owner's own log is the counterexample. RESEARCH, measured 2026-08-09 against his
// 1,461,881-line log and posted to JOS-148 before this was written:
//
//   * A full Sky turn-in circuit (26 completed trades across 14 of the 16 givers, 13:38 to 14:08)
//     printed NOTHING but `You gain experience!`. No achievement, no reward line. A turn-in is
//     SILENT about unlocks.
//   * The one first-person unlock line in the whole log fired for PALADIN at
//     `Welcome to level 11!`, in a dungeon, on a character that had never handed a Sky giver
//     anything. A class also unlocks from the free level-50 token and from a bought token
//     (eqlwiki Newbie Guide, external claim), and none of those leaves a turn-in behind.
//
// So turn-ins are evidence of PROGRESS and the achievement line is evidence of the ANSWER, and a
// derived-only tab would have told the owner his Paladin was locked. OBSERVED WINS: a class the
// log has SEEN unlocked reads unlocked at any turn-in count, and every row states which source it
// used, because a reader who cannot tell "the game said so" from "we worked it out" cannot tell
// which rows to trust.
//
// WHAT THE DERIVED READING IS WORTH, honestly. The owner's log has never witnessed a Sky-DRIVEN
// unlock (his best class sits at 3 of 7), so "the last turn-in prints the achievement" is a WIKI
// claim this repo has not verified. That is exactly why `derived` is a labelled source rather
// than a silent equal: at M of M with no achievement seen, the tab says every test is turned in
// and attributes the unlock reading to the derivation, so if the wiki is wrong about some class
// the row is still a true sentence about turn-ins.
//
// A CLASS WITH NO TESTS IN THE DATA never derives unlocked. Zero required quests is missing data
// about a class, not a finished one — the same refusal `hasEveryItem` makes for a quest with no
// required items (law 1).

import type { ClassUnlockRecord } from '@shared/types'
import type { QuestProgress } from './useProgress'
import { everTurnedIn } from './questCompletion'

/** Where a row's unlock reading came from. Absent on a row that is not unlocked. */
export type UnlockSource = 'observed' | 'derived'

export interface ClassUnlockRow {
  /** the class, spelled as the bundled Sky data spells it (the display name) */
  className: string
  /** how many of this class's tests have been turned in at least once (JOS-145's reading) */
  turnedIn: number
  /** how many tests the class has. NOT a constant: Paladin has 4, Magician and Shadow Knight 7. */
  total: number
  /** tests never turned in. The sort key, and the number the row leads with. */
  remaining: number
  /** can this character run the class as a primary? */
  unlocked: boolean
  /** which source said so; absent when `unlocked` is false */
  source?: UnlockSource
  /** epoch ms the LOG stated the unlock. Only ever set on an `observed` row. */
  unlockedAt?: number
}

/**
 * Fold the quest list into one row per class, then apply the two sources.
 *
 * `observed` is the classUnlocks module's ledger, matched to the catalog's class names
 * CASE-INSENSITIVELY (law 2: names are dirty, canonicalize at the boundary, display raw). The
 * client's spelling is what the log carried; the row displays the catalog's. An observed class
 * the catalog has never heard of is DROPPED rather than given a row of its own: this tab is a
 * reading of the Sky data, and a row with no tests behind it would have nothing to say.
 */
export function classUnlockRows(
  quests: readonly QuestProgress[],
  observed: readonly ClassUnlockRecord[]
): ClassUnlockRow[] {
  const byClass = new Map<string, { turnedIn: number; total: number }>()
  for (const q of quests) {
    const row = byClass.get(q.className) ?? { turnedIn: 0, total: 0 }
    row.total += 1
    if (everTurnedIn(q)) row.turnedIn += 1
    byClass.set(q.className, row)
  }

  // First sighting per class wins, matching the module's own dedupe — a re-scan re-reading the
  // same line must not re-date an unlock that already happened.
  const seenAt = new Map<string, number>()
  for (const rec of observed) {
    const key = rec.className.toLowerCase()
    if (!seenAt.has(key)) seenAt.set(key, rec.ts)
  }

  const rows: ClassUnlockRow[] = []
  for (const [className, { turnedIn, total }] of byClass) {
    const at = seenAt.get(className.toLowerCase())
    const row: ClassUnlockRow = {
      className,
      turnedIn,
      total,
      remaining: total - turnedIn,
      unlocked: false
    }
    if (at !== undefined) {
      row.unlocked = true
      row.source = 'observed'
      row.unlockedAt = at
    } else if (total > 0 && turnedIn === total) {
      row.unlocked = true
      row.source = 'derived'
    }
    rows.push(row)
  }
  return rows
}

/**
 * How high a class is pinned above the order: 1 for a starred class, 0 for everything else.
 * The caller supplies it because the star lives in a renderer-local store this module knows
 * nothing about — the same seam `questSort.PinRank` uses.
 */
export type ClassPinRank = (row: ClassUnlockRow) => number

/**
 * THE ORDER: fewest tests remaining first, then the class name.
 *
 * Closest-to-done is the whole point of the tab — the class you could finish next is the one
 * worth seeing — and it is TOTAL, bottoming out in the name, so the list never shuffles on a
 * re-render. Ties break on name rather than on how many tests the class has, because "3 left" is
 * the same amount of work whether it is 3 of 4 or 3 of 7 and inventing a second criterion would
 * be inventing a preference nobody expressed.
 *
 * AN UNLOCKED CLASS IS NOT SUNK, and that is deliberate. Its tests still have rewards (every Sky
 * test hands over a class-restricted item), so a class you unlocked at level 11 with 2 of 4 turned
 * in is still 2 tests of real work — the owner's Paladin is exactly that row. The lock is a
 * PROPERTY of the row, not its subject.
 *
 * THE STAR PIN COMPOSES, legitimately, under JOS-146's own rule: a pin may jump the queue on an
 * order whose subject is a STANDING PROPERTY of the row, and may not on one whose subject is an
 * EVENT. "Tests remaining" is as standing as it gets — it is a count of quests, not a thing that
 * just happened — so floating the classes you starred above it costs the reader nothing: the
 * order still holds inside each group and nothing has been hidden. The single order this tab has
 * is on the permitted side of that line, so unlike `orderQuests` there is no condition to test.
 */
export function orderClassUnlockRows(
  rows: readonly ClassUnlockRow[],
  rank: ClassPinRank
): ClassUnlockRow[] {
  const sorted = [...rows].sort(
    (a, b) => a.remaining - b.remaining || a.className.localeCompare(b.className)
  )
  // A SECOND pass, like the quest list's: Array#sort is stable, so ties keep the first pass's
  // order and a starred class arrives at the top carrying the same closest-first order inside.
  sorted.sort((a, b) => rank(b) - rank(a))
  return sorted
}
