// gear plan/useGearPlan.ts — the gear plan board in the renderer: load it, edit it, persist it.
//
// ONE DOCUMENT IN MODULE SCOPE, THE `useWishlist.ts` SHAPE (JOS-346). That file argues the case
// and it was learned the expensive way: a per-mount copy answers "what the store said the last
// time THIS view mounted, plus whatever I did since", never "what the document is", and every
// surface reading it then disagrees by one edit. The board has one reader today and this is still
// the right shape — a `useSyncExternalStore` snapshot costs nothing, `window.eq.onCharacter` is
// the signal that means "a different character's everything", and a second reader (a Gear-tab row
// that fills a cell) becomes free rather than becoming a bug.
//
// ONE STORAGE TIER, like the wish list and unlike the two documents before it. `usePlans.ts` and
// `useGearSets.ts` each split their state in two — the document in the electron-store, "which one
// is selected" in `localStorage` — because both were LISTS with a selection. There is ONE board
// per character and nothing to select, so there is no machine-class half at all.
//
// ---------------------------------------------------------------------------------------------
// WRITES ARE IMMEDIATE, EXCEPT THE ONE EDIT THAT IS A DRAG — and both halves are deliberate.
//
// The wish list writes on every edit and argues why: every edit there is a discrete click, so
// there is nothing to coalesce and a debounce buys nothing while costing a flush to remember and
// a window in which the store disagrees with the screen. Picking an item, clearing a cell and
// choosing an exaltation are exactly that kind of click, and they write immediately.
//
// A PLUS-STATE IS NOT A CLICK. It is a slider, and a slider fires per step: a fraction slider at
// tier 9 has 511 of them, so writing per step would be five hundred IPC round trips for one drag.
// That is the case `useGearSets.SAVE_DEBOUNCE_MS` existed for, and it comes back with the control
// that needs it — coalesced at 500 ms, with the two things a debounce owes anybody:
//   * A DISCRETE EDIT FLUSHES THE PENDING DRAG FIRST, so an item picked mid-coalesce can never
//     land in the store ahead of the tier the user set before picking it.
//   * `pagehide` FLUSHES, so quitting the app 200 ms after letting go of a slider does not throw
//     the drag away. The retired hook flushed on UNMOUNT, which was the same promise made at the
//     only boundary a per-mount copy had; the document outlives every mount now, so the boundary
//     that matters is the window's.
// ---------------------------------------------------------------------------------------------

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  EMPTY_GEAR_PLAN,
  assignToCell,
  clearCell,
  withCellState,
  withSocket,
  type GearPlan,
  type GearPlanCell,
  type GearPlanSocket
} from '@shared/planner/gearPlan'
import type { ItemUpgradeState } from '@shared/itemUpgrade'
import type { PlanSlotId, SocketType } from '@shared/planner/types'

/** How long a slider drag is coalesced before it reaches the store. */
const SAVE_DEBOUNCE_MS = 500

export interface GearPlanApi {
  gearPlan: GearPlan
  /** false until the first load settles — a data-availability flag, not an error */
  ready: boolean
  /** put an item in a cell; a different item clears that cell's sockets (the model's rule) */
  assign: (cell: PlanSlotId, item: GearPlanCell) => void
  /** empty a cell entirely - the one destructive control on the board */
  clear: (cell: PlanSlotId) => void
  /** move ONE cell's plus-state. Coalesced: this is the slider's write path */
  setState: (cell: PlanSlotId, state: ItemUpgradeState) => void
  /** plan (or clear, with `null`) one exaltation in one socket of one cell */
  setSocket: (cell: PlanSlotId, socket: SocketType, planned: GearPlanSocket | null) => void
  /**
   * Write a WHOLE board over the current one — the seed-from-equipped door, and the only edit that
   * is not a fold over one cell.
   *
   * It goes through the same `apply` as every other edit, so it dedupes on identity (a load that
   * changes nothing neither re-renders nor writes) and it is NOT coalesced: replacing the board is
   * a discrete decision somebody made in a menu, not a drag.
   */
  replace: (next: GearPlan) => void
}

/**
 * THE DOCUMENT AND ITS READINESS AS ONE OBJECT, replaced whole on every change. One object rather
 * than two stores because `useSyncExternalStore` compares snapshots by identity: two stores would
 * be two subscriptions per caller, and a snapshot rebuilt per render would loop.
 */
interface Snapshot {
  gearPlan: GearPlan
  ready: boolean
}

let snapshot: Snapshot = { gearPlan: EMPTY_GEAR_PLAN, ready: false }
const listeners = new Set<() => void>()

/**
 * Bumped by a character switch. A read still in flight under an older generation is answering a
 * question about somebody else's character, so it is discarded rather than applied.
 */
let generation = 0
let loading = false
/** A local edit has produced a document newer than any read in flight; the click is authoritative. */
let superseded = false
let watching = false

let pending: ReturnType<typeof setTimeout> | null = null

function emit(next: Snapshot): void {
  snapshot = next
  // A copy: a listener that unmounts in response would otherwise mutate the set mid-iteration.
  for (const listener of [...listeners]) listener()
}

/** Write the document this instant, cancelling any coalesced write it supersedes. */
function flush(): void {
  if (pending !== null) {
    clearTimeout(pending)
    pending = null
  }
  void window.eq.setGearPlan(snapshot.gearPlan)
}

/** The first load, and the only one until a character switch asks for another. */
function load(): void {
  if (loading || snapshot.ready) return
  loading = true
  const mine = generation
  void window.eq
    .getGearPlan()
    .then((loaded) => {
      if (mine !== generation || superseded) return
      emit({ gearPlan: loaded, ready: true })
    })
    .catch(() => {
      /* main never rejects; an unreadable store yields an empty board, not a crash */
    })
    .finally(() => {
      if (mine !== generation) return
      loading = false
      // READY EVEN WHEN THE ANSWER WAS DISCARDED: the flag says the first load has SETTLED, and a
      // superseded read settled — the document the caller would draw is the newer one either way.
      if (!snapshot.ready) emit({ gearPlan: snapshot.gearPlan, ready: true })
    })
}

/**
 * A DIFFERENT CHARACTER IS A DIFFERENT DOCUMENT, and a closing window is a pending drag's last
 * chance. Subscribed once for the life of the window and never torn down: the store outlives every
 * mount, so there is no mount whose unmount should stop it listening.
 */
function watch(): void {
  if (watching) return
  watching = true
  window.eq.onCharacter(() => {
    // A drag coalesced under the OUTGOING character must land on the outgoing character.
    if (pending !== null) flush()
    generation += 1
    loading = false
    superseded = false
    emit({ gearPlan: EMPTY_GEAR_PLAN, ready: false })
    load()
  })
  window.addEventListener('pagehide', () => {
    if (pending !== null) flush()
  })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): Snapshot {
  return snapshot
}

/**
 * ONE WRITE PATH. Every edit is a pure fold over the current document (shared/planner/gearPlan.ts
 * owns all four), and a fold that changed nothing returns the SAME OBJECT — so a state set to the
 * value it already held neither re-renders nor writes.
 *
 * The fold reads the module's document rather than a React state updater's `prev`, for the reason
 * `useWishlist` does: StrictMode double-invokes those, and an IPC write is not a thing to do twice.
 */
function apply(edit: (prev: GearPlan) => GearPlan, coalesce = false): void {
  const next = edit(snapshot.gearPlan)
  if (next === snapshot.gearPlan) return
  superseded = true
  emit({ gearPlan: next, ready: snapshot.ready })
  if (!coalesce) {
    flush()
    return
  }
  if (pending !== null) clearTimeout(pending)
  pending = setTimeout(() => {
    pending = null
    void window.eq.setGearPlan(snapshot.gearPlan)
  }, SAVE_DEBOUNCE_MS)
}

// THE FOUR DOORS, AT MODULE SCOPE, so their identity is fixed for the life of the window — a
// constant cannot be got wrong by a `memo`'d cell that depends on it.
function assign(cell: PlanSlotId, item: GearPlanCell): void {
  apply((prev) => assignToCell(prev, cell, item).gearPlan)
}

function clear(cell: PlanSlotId): void {
  apply((prev) => clearCell(prev, cell))
}

function setState(cell: PlanSlotId, state: ItemUpgradeState): void {
  apply((prev) => withCellState(prev, cell, state), true)
}

function setSocket(cell: PlanSlotId, socket: SocketType, planned: GearPlanSocket | null): void {
  apply((prev) => withSocket(prev, cell, socket, planned))
}

function replace(next: GearPlan): void {
  apply(() => next)
}

/** The character's gear plan board. */
export function useGearPlan(): GearPlanApi {
  const snap = useSyncExternalStore(subscribe, getSnapshot)
  useEffect(() => {
    watch()
    load()
  }, [])
  return useMemo(
    () => ({ gearPlan: snap.gearPlan, ready: snap.ready, assign, clear, setState, setSocket, replace }),
    [snap]
  )
}
