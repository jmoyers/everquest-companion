// planner.ts — the slice of the main app's bridge that is about PLANNING GEAR: the exaltation
// planner (docs/plans/exaltation-planner.md §4.1, §6) and the Gear tab (JOS-283/JOS-285).
//
// A separate file for FILE MASS, not for scope — the roster.ts/windows.ts/perf.ts pattern, and the
// rule those files state: `src/preload/index.ts` sits at the measured 400-code-line ceiling and the
// answer is to SPLIT rather than to ratchet. Phase 4 needed one more method than that file had room
// for. This object is spread into the bridge, so every method below is an ordinary member of the
// one `window.eq` surface and no renderer call site changes.
//
// AND THE SPLIT PAYS A DEBT WHILE IT IS HERE: `gearIndex`'s payload type used to be spelled as an
// inline `import(...)` expression precisely because an import line was a code line index.ts could
// not spare. There is room here, so both gear payloads are imported like everything else.
//
// EVERY METHOD IS A READ OVER COMMITTED BYTES OR A FILE ON DISK, except the one write. Nothing
// here rejects: the corpus is compiled into the main bundle, and a missing `/outputfile inventory`
// dump is a `null`/empty answer that the surfaces render as their instructions card.

import { ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { EquipSlot, ExaltPlan, PlannerDonor, PlannerItemHit } from '../shared/planner/types'
import type { PlannerInventory } from '../shared/planner/inventorySlots'
import type { GearIndexPayload } from '../shared/planner/gear'
import type { GearSet } from '../shared/planner/gearSet'
import type { GearPlan } from '../shared/planner/gearPlan'
import type { OwnershipPayload } from '../shared/planner/ownership'
import type { WishList } from '../shared/planner/wishlist'

export const plannerApi = {
  // ---- exaltation planner (docs/plans/exaltation-planner.md §4.1, §6) ----

  /** Every effect the committed item corpus states, one row per (item, effect) — ~1.5k rows,
   *  built lazily in main and memoized there. Fetch ONCE and cache: it is derived from bytes
   *  compiled into the bundle, so it cannot change while the app runs. */
  plannerDonors: (): Promise<PlannerDonor[]> => ipcRenderer.invoke(IPC.plannerDonors),

  /** Substring search over item NAMES for the Board's host picker (prefix hits first, then the
   *  shortest name; capped at 50). An empty query resolves to no hits. */
  /** `slot` narrows to one equipment slot BEFORE the cap; `limit` is the "show more" page size. */
  plannerSearchItems: (query: string, slot?: EquipSlot, limit?: number): Promise<PlannerItemHit[]> =>
    ipcRenderer.invoke(IPC.plannerSearchItems, query, slot, limit),

  /** What the active character is WEARING, from their newest `/outputfile inventory` dump —
   *  `null` when no dump exists. Re-ask on `onInventoryReload` and the tab fills itself the
   *  moment the command is typed in game. */
  plannerInventory: (): Promise<PlannerInventory | null> => ipcRenderer.invoke(IPC.plannerInventory),

  /** The active character's saved exaltation sets — `[]` when it has none. */
  getExaltPlans: (): Promise<ExaltPlan[]> => ipcRenderer.invoke(IPC.plannerGetPlans),

  /** Replace the whole set list for the active character. Main re-validates every field against
   *  the closed slot/socket/class allowlists and silently drops what does not fit. */
  setExaltPlans: (plans: ExaltPlan[]): Promise<void> => ipcRenderer.invoke(IPC.plannerSetPlans, plans),

  // ---- gear planner (JOS-283 phase 2, JOS-285 phase 4) ----

  /** The gear CANDIDATE INDEX: one row per equippable item (~6,814), each carrying its NUMERIC
   *  base stat vector plus slots/classes/races/era/flags/effects and the weapon block. Built
   *  lazily in main and memoized there. Fetch ONCE and cache — it is derived from bytes compiled
   *  into the bundle, and every `+N` view of it is a pure map over the rows
   *  (`shared/planner/gearScale.ts scaleGearRow`), never another call. Check `version` against
   *  `GEAR_INDEX_VERSION` before reading: a payload from a version this build does not know is
   *  refused rather than mis-drawn. */
  gearIndex: (): Promise<GearIndexPayload> => ipcRenderer.invoke(IPC.gearIndex),

  /** THE OWNERSHIP INDEX (JOS-285): every thing the active character's newest `/outputfile
   *  inventory` dump names, keyed the way the gear index and the loot history are keyed, plus the
   *  dump's own path and mtime and the keyring categories the fold left out. `path: null` means
   *  the command has never been run — "nothing to read", never "you own nothing".
   *
   *  RE-ASK ON `onInventoryReload`, exactly like `plannerInventory`: main memoizes on the file's
   *  own identity (path + mtime), so an unchanged dump costs a stat and a rewritten one is
   *  re-folded without anything having to remember to invalidate a cache. */
  gearOwnership: (): Promise<OwnershipPayload> => ipcRenderer.invoke(IPC.gearOwnership),

  // ---- gear planner (JOS-286 phase 5) ----

  /** The active character's saved GEAR SETS — `[]` when it has none. Named virtual loadouts, one
   *  item per equipment cell, each assignment carrying its own tracked plus-state. */
  getGearSets: (): Promise<GearSet[]> => ipcRenderer.invoke(IPC.gearGetSets),

  /** Replace the whole gear-set list for the active character. Main re-validates every cell
   *  against the closed `PLAN_SLOTS` allowlist and clamps every plus-state to one the game's item
   *  window can actually be in, silently dropping what does not fit. */
  setGearSets: (sets: GearSet[]): Promise<void> => ipcRenderer.invoke(IPC.gearSetSets, sets),

  // ---- the flat wish list (JOS-326) ----

  /** The active character's WISH LIST — the empty document when it has none. One flat list of
   *  items they have decided they want, with no cell/socket/host structure at all, plus the done
   *  strip's dismissals and the one-time exaltation-plan seed flag. */
  getWishlist: (): Promise<WishList> => ipcRenderer.invoke(IPC.wishlistGet),

  /** Replace the whole wish list for the active character. Main re-validates every entry — the
   *  item key, the two kinds, the closed socket allowlist — and silently drops what does not fit.
   *  Whole-document, because the list and the two facts about it must move together. */
  setWishlist: (list: WishList): Promise<void> => ipcRenderer.invoke(IPC.wishlistSet, list),

  // ---- the gear plan board ----

  /** The active character's GEAR PLAN BOARD — the empty board when it has none. One item per
   *  equipment cell at its own planned `+N`, with that item's planned exaltations in its
   *  sockets. Singular: one board per character, so there is no id to ask for. */
  getGearPlan: (): Promise<GearPlan> => ipcRenderer.invoke(IPC.gearPlanGet),

  /** Replace the whole gear plan board for the active character. Main re-validates every cell
   *  against the same closed cell allowlist a gear set is checked against, every socket against
   *  the closed four, and clamps each plus-state to a state the game's item window can be in,
   *  silently dropping what does not fit. */
  setGearPlan: (gearPlan: GearPlan): Promise<void> => ipcRenderer.invoke(IPC.gearPlanSet, gearPlan)
}
