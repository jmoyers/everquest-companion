// IPC: the EXALTATION PLANNER's door (docs/plans/exaltation-planner.md §4.1, §6).
//
// Two reads over the committed item corpus and one per-character read/write pair. Nothing here
// touches the network, and nothing rejects: the corpus is compiled into this bundle.
//
// LAZY + MEMOIZED. `items.json` is already an ES import in `itemLookup.ts` (electron-vite inlines
// it), so importing the same module here costs no extra bytes — but WALKING it does, so the index
// is built on the first call and kept for the life of the process. An install that never opens
// the Planner never pays for it; one that opens it twice pays once. Same shape as itemLookup's
// module-scope index, just deferred.
//
// The renderer is UNTRUSTED, here as everywhere: the search query must be a string, and a set
// list is re-validated field by field against the closed slot/socket/class allowlists
// (../planner/validate.ts) before a byte of it reaches the store.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { equippedHosts, type PlannerInventory } from '../../shared/planner/inventorySlots'
import {
  buildPlannerIndex,
  PLANNER_SEARCH_LIMIT,
  PLANNER_SEARCH_MAX,
  searchPlannerItems,
  type PlannerIndex
} from '../planner/effectIndex'
import { EQUIP_SLOTS } from '../../shared/planner/types'
import { buildGearIndex } from '../planner/gearIndex'
import type { GearIndexPayload } from '../../shared/planner/gear'
import { NO_OWNERSHIP, ownershipPayload, type OwnershipPayload } from '../../shared/planner/ownership'
import {
  sanitizeExaltPlans,
  sanitizeGearSets,
  sanitizeGearPlan,
  sanitizeWishlist
} from '../planner/validate'
import { loadInventoryDump, outputStatus } from '../outputs'
import { activeCharId, getActiveCharacter } from '../session'
// The two planner documents' store accessors live in their own module since JOS-286 — store.ts
// was at its 400-code-line ceiling, and this repo splits rather than ratchets.
import {
  getExaltPlans,
  getGearSets,
  getGearPlan,
  getWishlist,
  setExaltPlans,
  setGearSets,
  setGearPlan,
  setWishlist
} from '../storePlans'
import { itemKey, type ItemDbFile } from '../itemsDb'
// The COMMITTED wiki item database — the same module itemLookup.ts imports, so the JSON is
// inlined into the main bundle exactly once.
import itemsJson from '../data/items.json'

let index: PlannerIndex | null = null
let gear: GearIndexPayload | null = null

/** The donor + item indices, built on first use. */
function plannerIndex(): PlannerIndex {
  index ??= buildPlannerIndex(itemsJson as unknown as ItemDbFile)
  return index
}

/**
 * The GEAR candidate index (JOS-283), memoized the same way and for the same reason. It lives in
 * THIS file rather than a gear-only handler module because the memoization is per-import of a
 * committed corpus: two handler modules would each hold their own walk of the same 8.6 MB.
 */
function gearIndex(): GearIndexPayload {
  gear ??= buildGearIndex(itemsJson as unknown as ItemDbFile)
  return gear
}

/**
 * THE OWNERSHIP INDEX (JOS-285, phase 4), MEMOIZED ON THE DUMP'S OWN IDENTITY.
 *
 * The two caches above are memoized for the life of the process because their input is committed
 * bytes. This one's input is a file the player rewrites mid-session on purpose, so "memoized" has
 * to mean something narrower — and the narrow thing is exactly what `plannerInventory` above
 * declines to cache at all, because IT is one parse per ask and this is a parse plus a fold that
 * every keystroke in the Gear tab would otherwise re-run.
 *
 * SO THE CACHE KEY IS THE FILE, NOT A FLAG. `outputStatus` is one readdir + one stat (the
 * registry caches nothing, deliberately — see its header), and path + mtime identify the dump
 * completely: a rewrite moves the mtime, a character switch moves the path, and a deleted dump
 * moves both to null. Nothing has to remember to invalidate this, which is the failure mode an
 * explicit `invalidateOwnership()` called from the auto-load path would have been one refactor
 * away from at all times. The renderer re-asks on `inventory:autoReloaded`; that push is what
 * makes the answer TIMELY, and this key is what makes it CORRECT.
 */
let owned: { path: string; loadedAt: string; payload: OwnershipPayload } | null = null

function gearOwnership(): OwnershipPayload {
  const character = getActiveCharacter()
  const status = outputStatus('inventory', { name: character?.name, server: character?.server })
  if (status.path === null || status.updatedAt === null) {
    owned = null
    return NO_OWNERSHIP
  }
  if (owned !== null && owned.path === status.path && owned.loadedAt === status.updatedAt) {
    return owned.payload
  }
  // `loadInventoryDump` re-resolves the same status, so the two can never disagree about WHICH
  // file was folded — and a dump that vanished between the stat and the read is simply no dump.
  const payload = ownershipPayload(loadInventoryDump(character?.name, character?.server))
  owned = payload.path === null ? null : { path: payload.path, loadedAt: payload.loadedAt ?? '', payload }
  return payload
}

export function registerPlannerIpc(): void {
  // Every effect the corpus states, one row per (item, effect). The renderer fetches this once
  // and keeps it — it is derived from committed bytes and cannot change while the app runs.
  ipcMain.handle(IPC.plannerDonors, () => plannerIndex().donors)

  // Every equippable item, described in numbers (JOS-283). One versioned payload, fetched once —
  // the renderer scales it to any plus-state itself (shared/planner/gearScale.ts), so no upgrade
  // slider ever comes back here.
  ipcMain.handle(IPC.gearIndex, (): GearIndexPayload => gearIndex())

  // What the active character OWNS, keyed the way the gear index is (JOS-285). Re-asked by the
  // renderer on every `inventory:autoReloaded`; re-folded here only when the file itself moved.
  ipcMain.handle(IPC.gearOwnership, (): OwnershipPayload => gearOwnership())

  // Host picking: substring over item names, capped. A non-string query is not an error the UI
  // should have to render — it is simply no hits.
  // The optional SLOT is validated exactly as strictly as the query, and against the closed
  // vocabulary rather than a string test: an unknown token narrows to nothing rather than being
  // ignored, because silently answering the un-narrowed question would hand a HEAD cell a list of
  // rings. `undefined` is the honest "no cell in mind" and keeps the whole-corpus behaviour.
  ipcMain.handle(IPC.plannerSearchItems, (_e, query: unknown, slot: unknown, limit: unknown) => {
    if (typeof query !== 'string') return []
    const wanted = EQUIP_SLOTS.find((s) => s === slot)
    if (slot !== undefined && wanted === undefined) return []
    // A renderer asking for MORE is the "show more" control; it may not ask for everything. The
    // ceiling is main's, because an unbounded list is main's cost to serve and the renderer's to
    // draw — and a number arriving over IPC is never trusted to be either finite or sane.
    const asked = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : 0
    const cap = Math.min(Math.max(asked, PLANNER_SEARCH_LIMIT), PLANNER_SEARCH_MAX)
    return searchPlannerItems(plannerIndex().items, query, cap, wanted)
  })

  // V7 — what the character is WEARING, from their newest `/outputfile inventory` dump. Read on
  // demand (the dump is a file already on disk and parses in milliseconds; nothing is persisted —
  // outputs/index.ts states why) and never cached here, because the renderer re-asks on the
  // auto-reload push and a cache would hand it the answer from before the player typed the
  // command. No dump ⇒ null, which is the Inventory tab's instructions card, not an error.
  ipcMain.handle(IPC.plannerInventory, (): PlannerInventory | null => {
    const character = getActiveCharacter()
    const loaded = loadInventoryDump(character?.name, character?.server)
    if (!loaded) return null
    return {
      path: loaded.path,
      loadedAt: loaded.loadedAt,
      // `itemKey` is applied HERE and not in the shared join: the key is main's definition
      // (itemsDb.ts, law 2) and shared/planner/inventorySlots.ts must stay dependency-free.
      hosts: equippedHosts(loaded.dump).map((h) => ({
        ...h,
        key: itemKey(h.name),
        exaltationKeys: h.exaltations.map(itemKey)
      }))
    }
  })

  // The active character's GEAR SETS (JOS-286). Same shape of promise as the exaltation sets
  // below, over a different document and its own additive store key: validated at the handler and
  // again in the store, which is also the read path's normalizer.
  ipcMain.handle(IPC.gearGetSets, () => getGearSets(activeCharId()))
  ipcMain.handle(IPC.gearSetSets, (_e, sets: unknown) => {
    setGearSets(activeCharId(), sanitizeGearSets(sets))
  })

  // The active character's FLAT WISH LIST (JOS-326). Same shape of promise again, over the third
  // planner document and its own additive store key. Whole-document both ways: the entries and the
  // two facts that hang off them (the done strip's dismissals, the one-time seed flag) are one
  // thing, and a partial write would leave them disagreeing.
  ipcMain.handle(IPC.wishlistGet, () => getWishlist(activeCharId()))
  ipcMain.handle(IPC.wishlistSet, (_e, list: unknown) => {
    setWishlist(activeCharId(), sanitizeWishlist(list))
  })

  // The active character's GEAR PLAN BOARD. Same shape of promise a fourth time, over the fourth
  // planner document and its own additive store key. Whole-document both ways: a cell's item, its
  // planned plus-state and its sockets are one statement, and a partial write would leave a socket
  // attached to an item the board no longer plans there.
  ipcMain.handle(IPC.gearPlanGet, () => getGearPlan(activeCharId()))
  ipcMain.handle(IPC.gearPlanSet, (_e, gearPlan: unknown) => {
    setGearPlan(activeCharId(), sanitizeGearPlan(gearPlan))
  })

  // The active character's sets. Both directions run through the same validator (see store.ts).
  ipcMain.handle(IPC.plannerGetPlans, () => getExaltPlans(activeCharId()))
  // Validated AT THE HANDLER (and again in the store, where it is also the READ path's
  // normalizer — sanitizing is a fixed point, so the second pass costs nothing and the store can
  // never be reached by an unvalidated route).
  ipcMain.handle(IPC.plannerSetPlans, (_e, plans: unknown) => {
    setExaltPlans(activeCharId(), sanitizeExaltPlans(plans))
  })
}
