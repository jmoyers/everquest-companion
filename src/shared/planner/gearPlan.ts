// planner/gearPlan.ts — THE GEAR PLAN BOARD'S DOCUMENT: one item per equipment cell, and that
// item's exaltations in its sockets.
//
// WHAT THIS ANSWERS, AND WHY IT IS A FOURTH DOCUMENT. The gear area has four surfaces and none of
// them said what a finished gear plan looks like. Gear searches the corpus, Exaltations searches the
// donor corpus, Character reads out the dump, and the wish list is deliberately flat — its own
// header says it "names no equipment cell, no socket and no host", and progressState.ts states the
// ruling behind that: host targeting is an explicitly later addition, and a wish list that grew a
// cell map would be the plan board again under a friendlier name. This is that later addition,
// built where it belongs: its own surface, its own store key, and nothing of the wish list's shape
// touched.
//
// WHAT IT IS NOT. JOS-325 retired gear SETS and JOS-326 retired the exaltation plan BOARD, and
// both retirements were about the same thing — a LIST of documents with a selection, the
// create/rename/delete/select machinery that JOS-325's message named explicitly. None of that is
// here. There is ONE gear plan per character, so this document carries no `id`, no `name` and no
// `createdAt`, and there is no fold in this file that could serve a switcher. That is
// `useWishlist.ts`'s argument, applied to the fourth document: one document per character has no
// machine-class half at all.
//
// WHAT IS REVIVED, AND SAID SO OUT LOUD. The cell folds below are `gearSet.ts`'s, as JOS-286 wrote
// them and JOS-325 removed them — `cellsForItem`, `cellIsFree`, `cellForItem`, `clearCell`,
// `gearPlanCells`, `filledCells`, `assignedCount` — plus `withSocket` from `usePlans.ts`, which was
// a renderer hook's private fold and belongs in shared now that a shared document has sockets.
// Reviving them beats re-deriving them: each one carries an argument that was paid for once.
//
// THE ONE COUPLING THAT IS NEW, AND IT IS THE WHOLE FEATURE. A cell's plus-state is a PLAN, not a
// reading off a dump, so `unlockedSockets` is a function of the number the user just dragged:
// move a cell from +2 to +4 and the Worn and Proc sockets become fillable. `PlanCell` could not do
// this — it read the unlock tier off the inventory dump, because the item under it was somebody
// else's business. Here the item and its sockets are one cell, which is why they are one document.
//
// PURE (types + folds, relative value imports, no React/IPC/fs), so both tsconfigs see it and the
// node runner drives `tests/gear plan.test.mts` — the `gearSet.ts` / `inventorySlots.ts` precedent.
// The arithmetic lives next door in `gearPlanTotals.ts`; this file owns the SHAPE and the edits.

import { ITEM_UPGRADE_BASE, normalizeUpgradeState, type ItemUpgradeState } from '../itemUpgrade'
import { extractionTier } from './rules'
import {
  ANY_CELLS,
  PLAN_SLOTS,
  SOCKET_TYPES,
  cellsForSlot,
  type EquipSlot,
  type PlanSlotId,
  type SocketType
} from './types'

// ---- the shape ------------------------------------------------------------------------------

/**
 * ONE PLANNED EXALTATION: the effect the user wants in this socket, and the donor item they mean
 * to farm for it.
 *
 * `donorName` IS CARRIED, and that is the one addition to `PlanSocket`'s shape. The retired
 * `PlanSocket` stored only `donorKey`, and `PlanCell` then had to render a raw corpus key on any
 * machine whose corpus no longer had the row. `wishlist.ts` learned this and states the rule — a
 * stored document must still read as itself when the index behind it has moved. Third document,
 * same rule.
 */
export interface GearPlanSocket {
  /** the effect name as the corpus writes it ("Improved Healing III") */
  effect: string
  /** `PlannerDonor.key` — which donor item supplies it (an effect can have many donors) */
  donorKey: string
  /** the donor's display name, so a cell reads as a plan without the corpus */
  donorName: string
}

/**
 * ONE CELL OF THE BOARD: the item planned there, at the plus-state planned for it, with whatever
 * has been planned into its sockets.
 *
 * `key` is `itemKey(name)` — the corpus join key every index in this app shares — so a cell
 * resolves to its numbers with a map lookup and nothing else. `name` rides beside it for the same
 * reason `donorName` does above.
 *
 * `state` IS THE PLAN'S NUMBER, NOT AN OBSERVATION. It is what makes this board able to do the
 * arithmetic `characterSheet.sumGear` refuses: that file declines the ` +N` uplift because a dump
 * names an item and only a ` +N` suffix says which state it is in, and its header names the Gear
 * planner as where that evidence exists. Here it exists because the user stated it.
 */
export interface GearPlanCell {
  /** `itemKey(name)` — the corpus join key */
  key: string
  /** the item's display name, as the corpus spells it */
  name: string
  /** always stored normalized, so no reader defends against a fraction its denominator cannot hold */
  state: ItemUpgradeState
  /** up to one planned exaltation per socket type; a socket the tier has not unlocked can still hold one */
  sockets: Partial<Record<SocketType, GearPlanSocket>>
}

/**
 * THE BOARD. Persisted per character under `ProgressState.gearPlan` — SINGULAR, unlike the three
 * planner documents beside it, because one board per character is the feature statement and the
 * type is where that is said once.
 */
export interface GearPlan {
  /** one item per cell, keyed by `PlanSlotId` — the twenty-three `PLAN_SLOTS` cells */
  cells: Partial<Record<PlanSlotId, GearPlanCell>>
  updatedAt: number
}

/** A board with nothing on it — what a character who has never opened the tab reads as. */
export const EMPTY_GEAR_PLAN: GearPlan = { cells: {}, updatedAt: 0 }

/**
 * The cells the board draws, in board order — `PLAN_SLOTS` itself, re-exported rather than copied.
 * A second list would be a second opinion about how many ears a character has.
 */
export const GEAR_PLAN_CELLS: readonly PlanSlotId[] = PLAN_SLOTS

// ---- where an item goes ----------------------------------------------------------------------

/**
 * The cells an item COULD occupy, in board order: the cells of every slot its page states, then
 * the two any-slots.
 *
 * THE ANY-CELLS COME LAST, and that is the same judgement `cellsForSlot` makes by leaving them out
 * entirely: they are the extra places, not the natural home for a breastplate. Offering them at
 * all is JOS-104's point — the game gives you two places that constrain nothing — so a ring whose
 * two finger cells are full can still be planned into one, but only after the fingers.
 *
 * An item whose page states NO slot cannot happen in the gear index (a row exists BECAUSE it has
 * one), so the empty-slots arm is the honest fallback rather than a live path: it offers the two
 * places that constrain nothing, which is all anyone could say about it.
 */
export function cellsForItem(slots: readonly EquipSlot[]): PlanSlotId[] {
  const out: PlanSlotId[] = []
  for (const slot of slots) {
    for (const cell of cellsForSlot(slot)) if (!out.includes(cell)) out.push(cell)
  }
  for (const cell of ANY_CELLS) out.push(cell)
  return out
}

/** Is this cell empty on this board? */
export function cellIsFree(gearPlan: GearPlan, cell: PlanSlotId): boolean {
  return gearPlan.cells[cell] === undefined
}

/**
 * WHERE AN ITEM LANDS when the user picks one without naming a cell: the first FREE cell it can
 * occupy, and — when every one of them is taken — the FIRST, which is the cell whose occupant is
 * then displaced.
 *
 * Falling back to the first rather than refusing is the gesture the user made: they picked a ring
 * while planning two, and "nothing happened" is the one answer that leaves them wondering whether
 * the control works. The displaced item is RETURNED by `assignToCell`, so the surface can say
 * whose place was taken.
 */
export function cellForItem(gearPlan: GearPlan, slots: readonly EquipSlot[]): PlanSlotId {
  const cells = cellsForItem(slots)
  return cells.find((c) => cellIsFree(gearPlan, c)) ?? cells[0]
}

// ---- the edits -------------------------------------------------------------------------------

/** A fresh cell at base, with nothing socketed — the state an item you have not merged is in. */
export function cellAt(
  item: { key: string; name: string },
  state: ItemUpgradeState = ITEM_UPGRADE_BASE
): GearPlanCell {
  return { key: item.key, name: item.name, state: normalizeUpgradeState(state), sockets: {} }
}

/**
 * Put an item in a cell. Returns the new board AND whoever was there — assigning DISPLACES, and
 * the caller is expected to say so rather than lose an item silently.
 *
 * A DIFFERENT ITEM CLEARS THE SOCKETS; THE SAME ITEM KEEPS THEM. This deliberately inverts
 * `usePlans.withHost`, which kept the sockets when the host changed and argued it well: the
 * effects you want in your head slot are still the effects you want when you change your mind
 * about which helm carries them. The roles have inverted, so the rule does too. There the host was
 * optional decoration over a socket plan; here the item IS the cell, and R2 is asked against the
 * item's own class list, so a PAL-only proc carried onto a robe you just swapped in is a plan
 * `socketCompatibility` refuses on the very next render. Better not to create it. Re-assigning the
 * SAME key is a plus-state or a re-pick of what is already there, and touches nothing.
 *
 * Rebuilt rather than mutated: the previous object is a React memo another render still holds.
 */
export function assignToCell(
  gearPlan: GearPlan,
  cell: PlanSlotId,
  item: GearPlanCell
): { gearPlan: GearPlan; displaced: GearPlanCell | null } {
  const displaced = gearPlan.cells[cell] ?? null
  const sockets = displaced !== null && displaced.key === item.key ? displaced.sockets : item.sockets
  const next: GearPlanCell = {
    key: item.key,
    name: item.name,
    state: normalizeUpgradeState(item.state),
    sockets
  }
  return { gearPlan: { ...gearPlan, cells: { ...gearPlan.cells, [cell]: next } }, displaced }
}

/**
 * Empty a cell. Rebuilt key by key rather than spread-and-`delete`: a computed `delete` is banned
 * by the lint config, and an explicit rebuild is what "this cell is empty now" means anyway
 * (`usePlans.withSocket`'s precedent, below).
 */
export function clearCell(gearPlan: GearPlan, cell: PlanSlotId): GearPlan {
  const cells: Partial<Record<PlanSlotId, GearPlanCell>> = {}
  for (const [id, planned] of Object.entries(gearPlan.cells)) {
    if (planned && id !== cell) cells[id as PlanSlotId] = planned
  }
  return { ...gearPlan, cells }
}

/**
 * Move ONE cell's plus-state. The per-item slider's whole write path — nothing else changes, which
 * is what makes "this helm at +3 and that sword at +7" expressible at all.
 *
 * IT DOES NOT PRUNE SOCKETS THE NEW TIER NO LONGER UNLOCKS, and that is a deliberate refusal. A
 * slider is a continuous control and a drag passes through every value on the way; pruning would
 * make dragging from +4 to +1 and back destroy three picks, silently, in the time it takes to
 * change your mind. The socket stays and the cell says `+3 to unlock` instead — the plan is
 * allowed to be ahead of the merge, which is the point of planning it.
 *
 * A cell with nothing in it answers with the board unchanged: there is no state without an item.
 */
export function withCellState(
  gearPlan: GearPlan,
  cell: PlanSlotId,
  state: ItemUpgradeState
): GearPlan {
  const planned = gearPlan.cells[cell]
  if (planned === undefined) return gearPlan
  return {
    ...gearPlan,
    cells: { ...gearPlan.cells, [cell]: { ...planned, state: normalizeUpgradeState(state) } }
  }
}

/**
 * Set (or clear, with `null`) ONE socket of one cell, keeping the rest of the cell exactly as it
 * is. `usePlans.withSocket`'s body, moved into shared with the document it now edits.
 *
 * A cell with no item answers with the board unchanged: a socket belongs to an item, and there is
 * no host-less cell on this board to hang one on (that WAS expressible on the retired plan board,
 * where a cell could carry sockets with no host at all — here the item is the cell).
 */
export function withSocket(
  gearPlan: GearPlan,
  cell: PlanSlotId,
  socket: SocketType,
  planned: GearPlanSocket | null
): GearPlan {
  const existing = gearPlan.cells[cell]
  if (existing === undefined) return gearPlan
  const sockets: Partial<Record<SocketType, GearPlanSocket>> = {}
  for (const [kind, value] of Object.entries(existing.sockets)) {
    if (value && kind !== socket) sockets[kind as SocketType] = value
  }
  if (planned !== null) sockets[socket] = planned
  return { ...gearPlan, cells: { ...gearPlan.cells, [cell]: { ...existing, sockets } } }
}

// ---- what the tier says --------------------------------------------------------------------

/**
 * Which sockets an item at this plus-state has UNLOCKED (R1).
 *
 * DERIVED, never restated: `extractionTier` reads `EXALTATION_SLOT_TYPES` in itemStats.ts, which
 * is the one place the game's unlock ladder is written down, and `tests/gear plan.test.mts` pins
 * this against `unlockedExaltationSlots` at every tier so the two derivations cannot drift. Only
 * the banked-whole tier counts — a fraction is exp toward the next merge, not a merge.
 *
 * Ornamentation is absent because `SOCKET_TYPES` is: it is cosmetic, token-gated and not in game.
 */
export function unlockedSockets(state: ItemUpgradeState): SocketType[] {
  return SOCKET_TYPES.filter((socket) => state.full >= extractionTier(socket))
}

/**
 * THE PLUS-STATE OF AN ITEM YOU ARE ACTUALLY WEARING, from the tier its dump line stated.
 *
 * A FLOOR, AND SAID SO. The client prints ` +5` on the name and never the exp banked toward +6, so
 * a worn copy reads at that whole tier with nothing banked. It is the most the dump supports and
 * the least the item can be.
 *
 * ABSENT MEANS THE NAME STATED NO TIER, WHICH IS NOT TIER 0 — but base is what a reader can do
 * with it, so this returns base and the surfaces COUNT those items separately
 * (`gearPlanTotals.equippedRead`'s `unstated`) rather than pretending the dump said something.
 */
export function wornState(tier?: number): ItemUpgradeState {
  if (tier === undefined) return ITEM_UPGRADE_BASE
  return normalizeUpgradeState({ full: tier, fraction: 0 })
}

// ---- walking the board -----------------------------------------------------------------------

/** One cell of the board, for a caller walking it. */
export interface GearPlanCellView {
  cell: PlanSlotId
  planned: GearPlanCell | null
}

/** Every cell in board order, filled or not — the board draws all twenty-three. */
export function gearPlanCells(gearPlan: GearPlan): GearPlanCellView[] {
  return GEAR_PLAN_CELLS.map((cell) => ({ cell, planned: gearPlan.cells[cell] ?? null }))
}

/** Only the filled cells, in board order — what the totals fold and the diff walk. */
export function filledCells(gearPlan: GearPlan): { cell: PlanSlotId; planned: GearPlanCell }[] {
  return gearPlanCells(gearPlan).flatMap((c) =>
    c.planned === null ? [] : [{ cell: c.cell, planned: c.planned }]
  )
}

/** How many cells the board has an item in. The header's one number. */
export function assignedCount(gearPlan: GearPlan): number {
  return filledCells(gearPlan).length
}

/**
 * Every planned exaltation on the board, flat and in board order — what the totals panel LISTS and
 * never adds.
 *
 * IT EXISTS BECAUSE AN EXALTATION MOVES AN EFFECT AND THE TOTALS SUM STATS. A planned proc
 * contributes exactly nothing to any number on this surface, and a board that showed four socketed
 * effects beside a stat total would be read as having counted them. Naming them in their own block
 * is `GearTotals.unsummed`'s honesty applied to a second class of thing.
 */
export function plannedSockets(
  gearPlan: GearPlan
): { cell: PlanSlotId; socket: SocketType; planned: GearPlanSocket }[] {
  return filledCells(gearPlan).flatMap(({ cell, planned }) =>
    SOCKET_TYPES.flatMap((socket) => {
      const value = planned.sockets[socket]
      return value === undefined ? [] : [{ cell, socket, planned: value }]
    })
  )
}

// ---- starting from what you are wearing ------------------------------------------------------

/** How much of the board a load from the dump is allowed to touch. */
export type LoadMode = 'fill' | 'replace'

/**
 * SEED THE BOARD FROM WHAT THE CHARACTER IS ACTUALLY WEARING — "give me a starting point".
 *
 * `equipped` is `gearPlanTotals.equippedRead(...).gearPlan`: the same fold the comparison already
 * runs on, so a load and the diff it then produces cannot disagree about what is worn.
 *
 * TWO MODES, BECAUSE ONLY ONE OF THEM IS SAFE AND BOTH ARE WANTED:
 *   * `fill`    — writes only into cells the plan leaves EMPTY. Nothing you planned is touched, so
 *                 it needs no confirmation and has nothing to undo. On a fresh board it is a full
 *                 load; on a half-built one it tops up the rest, which is the case the button is
 *                 actually for.
 *   * `replace` — writes every worn cell over whatever was there. It is destructive and there is
 *                 no undo in this app, so the SURFACE must state what it would discard before
 *                 running it; this function does not ask, it obeys.
 *
 * SOCKETS ARRIVE EXACTLY AS FAR AS THE EVIDENCE REACHES. The worn cell is copied WHOLE, and this
 * function resolves nothing itself — `equippedRead` already did, and did it conservatively: the
 * dump names a DONOR item and never an effect or a socket number worth trusting, so a socket is
 * filled only where the corpus makes that pair determined, and every other donor is counted in
 * `unresolved` and left EMPTY. So an empty socket on a loaded cell means "this app could not say",
 * NOT "there is nothing there" (law 1) — which is the difference the toolbar states after a load.
 *
 * Nothing is pruned on the way in either. A socket the loaded `+N` does not unlock still arrives
 * and the cell draws it as `+3 to unlock`, rather than deleting a fact the dump stated.
 *
 * A cell the plan already fills is left ALONE in `fill` mode even when the worn item is the same
 * one, so a planned `+7` is never quietly reset to the `+5` on your body.
 */
export function fromEquipped(plan: GearPlan, equipped: GearPlan, mode: LoadMode, now = 0): GearPlan {
  const cells: Partial<Record<PlanSlotId, GearPlanCell>> = { ...plan.cells }
  let wrote = 0
  for (const cell of GEAR_PLAN_CELLS) {
    const worn = equipped.cells[cell]
    if (worn === undefined) continue
    if (mode === 'fill' && cells[cell] !== undefined) continue
    cells[cell] = { ...worn, sockets: { ...worn.sockets } }
    wrote += 1
  }
  return wrote === 0 ? plan : { cells, updatedAt: now }
}

/** How many cells a `replace` would overwrite — the number its control must state before running. */
export function overwriteCount(plan: GearPlan, equipped: GearPlan): number {
  return GEAR_PLAN_CELLS.filter(
    (cell) => equipped.cells[cell] !== undefined && plan.cells[cell] !== undefined
  ).length
}
