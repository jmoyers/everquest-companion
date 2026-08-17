// gearplan/gearPlanRules.ts — WHICH DONORS MAY GO IN THIS CELL, and in what order the picker
// offers them.
//
// PURE, and node-tested (`tests/gearPlanRules.test.mts`) — the `gearFilter.ts` / `gearCompare.ts`
// precedent. Relative value imports so the node runner drives it with no bundler, and every
// decision about legality made HERE rather than inside a popover.
//
// ---------------------------------------------------------------------------------------------
// IT RESTATES NO RULE. R2 and R3 already live in `shared/planner/rules.ts` and this file asks
// them; `hostSlotsOf` already answers "which equip slots does a thing in this cell occupy" and
// this file asks that. What is left here is the one question neither of them is shaped to answer:
// given a CELL of this board and a SOCKET of the item in it, which rows of the donor corpus are
// offerable — plus the order to offer them in.
//
// THE ONE DELIBERATE CHANGE FROM THE RETIRED `HostPicker.hostFits`. It asked R2's class half
// against the SET's target trio, because at host-pick time the cell had no host to ask about. This
// board's cell HAS one — you are standing on the item — so the class list passed is the planned
// item's own `GearRow.classes`. That is the sharper reading of R2 (donor and host must share a
// class, not donor and player), and it is what lets the document carry no class trio at all, which
// in turn deletes the whole staleness problem `ExaltPlan.classesProvenance` existed to manage.
//
// AN EMPTY CLASS LIST STILL PASSES, and that is `socketCompatibility`'s own documented exception
// rather than a hole here: a page that stated no classes is UNKNOWN, never "nobody" (law 1).

import type { ClassAbbr } from '../../../../shared/classCombo'
import { socketCompatibility } from '../../../../shared/planner/rules'
import {
  hostSlotsOf,
  type EquipSlot,
  type PlanSlotId,
  type PlannerDonor,
  type SocketType
} from '../../../../shared/planner/types'

/** What a caller must know about the cell before a donor can be judged against it. */
export interface CellContext {
  cell: PlanSlotId
  socket: SocketType
  /** the PLANNED item's own class list; `[]` is UNKNOWN and filters nothing */
  itemClasses: readonly ClassAbbr[]
  /** the PLANNED item's own slot list; `[]` is UNKNOWN and falls back to the cell's */
  itemSlots: readonly EquipSlot[]
}

/**
 * May this donor's effect be socketed into this cell's item, in this socket?
 *
 * Three refusals, none of them restated here:
 *   * WRONG SOCKET — a focus effect cannot go in a proc socket. The corpus row states which one it
 *     occupies, so this is identity rather than a rule.
 *   * R3, HASTE — `socketCompatibility`'s first check, and it is checked first there for the same
 *     reason it is named first here: haste never travels, and that is a property of the effect
 *     itself rather than of the pairing.
 *   * R2, SLOT and CLASS — both asked of the PLANNED ITEM rather than of the cell.
 *
 * THE SLOT AXIS ASKS THE ITEM, AND THAT WAS A REPORTED BUG BEFORE IT DID. It used to ask
 * `hostSlotsOf(cell)`, which answers about the CELL: one slot for an ordinary cell, and all
 * EIGHTEEN for an any-cell, because an any-cell constrains nothing about what you may put in it.
 * That is the right answer to the question it asks and the wrong question to be asking — an
 * any-cell holding a ring is still holding a RING, and R2 is about the host item. So an any-cell
 * offered every donor in the corpus while every other cell filtered properly.
 *
 * This is the same correction the CLASS axis already had: judge the planned item, not the hole it
 * sits in. The cell's slots survive only as the fallback for an item the corpus does not carry,
 * where refusing on a slot list nobody stated would be inventing a fact (law 1).
 */
/**
 * The item picker's page size, and the ceiling "show more" walks it to.
 *
 * They mirror main's `PLANNER_SEARCH_LIMIT` / `PLANNER_SEARCH_MAX` and are stated here rather than
 * imported because main is not importable from the renderer - the pair is pinned instead by
 * `tests/gearPlanRules.test.mts`, so the two halves cannot drift apart in silence.
 */
export const PLANNER_PAGE = 50
export const PLANNER_PAGE_MAX = 400

export function donorFitsCell(donor: PlannerDonor, ctx: CellContext): boolean {
  if (donor.socket !== ctx.socket) return false
  const slots = ctx.itemSlots.length > 0 ? ctx.itemSlots : hostSlotsOf(ctx.cell)
  return socketCompatibility(donor, slots, ctx.itemClasses).ok
}

/** One offerable donor, with the score the list is ordered by. */
export interface DonorPick {
  donor: PlannerDonor
  score: number
}

/**
 * The rows this picker offers, ranked.
 *
 * AN EMPTY QUERY LISTS rather than returning nothing, and that is the difference from the item
 * picker next door: the legal set for ONE socket of ONE cell is small and closed (a few dozen
 * rows), so opening the picker and seeing what fits is the whole "open an item and fill it"
 * direction JOS-210 asked for. The item picker has since taken the same direction for the same
 * reason — main narrows it by SLOT first, which closes its set too — and keeps a minimum only for
 * an any-cell, whose haystack really is eleven thousand rows.
 *
 * Ties break by effect name length then locale, so a shorter exact-ish match wins and the order is
 * stable across renders — a list that reshuffles under the cursor is its own bug.
 */
export function donorPickerRows(
  donors: readonly PlannerDonor[],
  ctx: CellContext,
  query: string,
  limit: number
): DonorPick[] {
  const needle = query.trim().toLowerCase()
  const out: DonorPick[] = []
  for (const donor of donors) {
    if (!donorFitsCell(donor, ctx)) continue
    if (needle === '') {
      out.push({ donor, score: 0 })
      continue
    }
    const score = scoreOf(donor, needle)
    if (score !== null) out.push({ donor, score })
  }
  out.sort(
    (a, b) =>
      a.score - b.score ||
      a.donor.effect.length - b.donor.effect.length ||
      a.donor.effect.localeCompare(b.donor.effect)
  )
  return out.slice(0, limit)
}

/**
 * THE THREE HONEST READINGS OF A SUBSTRING MATCH, over the two fields a row here has:
 *   0 — the EFFECT name starts with it. Someone typing "improved" meant the Improved line.
 *   1 — the effect name contains it.
 *   2 — only the DONOR's name contains it. The row is a real answer to "what would that sword give
 *       me", and it is not what an effect search meant, so it sorts under both of the above.
 *
 * The ladder is `wishSearch.nameScore`'s, deliberately — two pickers that rank one query two ways
 * is exactly the drift the "two copies of one sentence" rule is about. It is not a CALL to that
 * function because this row has two searchable fields and that one takes a single name; sharing
 * the shape without sharing a signature is the honest amount of reuse available here.
 *
 * `null` = no match at all.
 */
function scoreOf(donor: PlannerDonor, needle: string): number | null {
  const effect = donor.effect.toLowerCase()
  if (effect.startsWith(needle)) return 0
  if (effect.includes(needle)) return 1
  return donor.name.toLowerCase().includes(needle) ? 2 : null
}
