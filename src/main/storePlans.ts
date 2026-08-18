// storePlans.ts — the two PLANNER DOCUMENTS' store accessors: exaltation sets (D4) and gear sets
// (JOS-286, phase 5).
//
// SPLIT OUT OF store.ts FOR FILE MASS, NOT FOR SCOPE — the roster.ts/windows.ts/perf.ts rule this
// repo already states in three places: `src/main/store.ts` sits at the measured 400-code-line
// ceiling, and the answer to that is a SPLIT rather than a widened threshold. Phase 5 needed one
// more read/write pair than that file had room for, and the two pairs belong together anyway:
// they are the same shape of promise over two per-character documents.
//
// WHAT MOVED IS CODE, NOT AUTHORITY. `setProgress` is still the one write path into `byCharacter`
// and it is imported from store.ts; both directions still run through the pure validators in
// ./planner/validate.ts, so "what a stored plan may contain" has exactly one definition and the
// round trip is a fixed point.
//
// NO SCHEMA BUMP AND NO MIGRATION FOR EITHER KEY, DELIBERATELY. `exaltPlans` and `gearSets` are
// ADDITIVE optional keys: nothing that already exists changes meaning, every reader defaults on a
// missing key, and electron-store rewrites the whole parsed object so the key survives a round
// trip through an older build. The store-migration law asks for a step when a persisted shape
// CHANGES; adding a key every reader already defaults is the case it explicitly does not cover.
// `tests/plannerStore.test.mts` and `tests/gearSetStore.test.mts` pin both halves of both.
//
// Per character, like every other key on `ProgressState`: a plan is built for one character's
// loadout. Whole-array writes — a list is small (tens of entries at most) and the renderer edits
// it as one document.

import {
  sanitizeExaltPlans,
  sanitizeGearSets,
  sanitizeGearPlan,
  sanitizeWishlist
} from './planner/validate'
import { getProgress, setProgress } from './store'
import type { ExaltPlan } from '../shared/planner/types'
import type { GearSet } from '../shared/planner/gearSet'
import type { GearPlan } from '../shared/planner/gearPlan'
import type { WishList } from '../shared/planner/wishlist'

/** This character's saved exaltation sets ([] when it has none, or the stored value is unusable). */
export function getExaltPlans(charId: string): ExaltPlan[] {
  return sanitizeExaltPlans(getProgress(charId).exaltPlans)
}

/** Replace the whole exaltation-set list for a character. Returns what was actually stored. */
export function setExaltPlans(charId: string, plans: ExaltPlan[]): ExaltPlan[] {
  const next = sanitizeExaltPlans(plans)
  setProgress(charId, { ...getProgress(charId), exaltPlans: next })
  return next
}

/** This character's saved GEAR sets ([] when it has none, or when the stored value is unusable). */
export function getGearSets(charId: string): GearSet[] {
  return sanitizeGearSets(getProgress(charId).gearSets)
}

/** Replace the whole gear-set list for a character. Returns what was actually stored. */
export function setGearSets(charId: string, sets: GearSet[]): GearSet[] {
  const next = sanitizeGearSets(sets)
  setProgress(charId, { ...getProgress(charId), gearSets: next })
  return next
}

/**
 * This character's FLAT WISH LIST (JOS-326) — the empty list when it has none, or when the stored
 * value is unusable. A THIRD document rather than a field on either of the two above; the
 * store-separation argument is stated once, at the key, in shared/progressState.ts.
 *
 * Whole-document reads and writes like the two above: the list is small (tens of lines), the
 * renderer edits it as one document, and the two remembered facts that hang off it (the done
 * strip's dismissals and the one-time seed flag) must move with it or not at all.
 */
export function getWishlist(charId: string): WishList {
  return sanitizeWishlist(getProgress(charId).wishlist)
}

/** Replace the whole wish list for a character. Returns what was actually stored. */
export function setWishlist(charId: string, list: WishList): WishList {
  const next = sanitizeWishlist(list)
  setProgress(charId, { ...getProgress(charId), wishlist: next })
  return next
}

/**
 * This character's GEAR PLAN BOARD — an empty board when it has none, or when the stored value is
 * unusable. A FOURTH document rather than a field on any of the three above; the store-separation
 * argument is stated once, at the key, in shared/progressState.ts.
 *
 * WHOLE-DOCUMENT, and SINGULAR where the two above are lists: there is one board per character, so
 * there is no id to select by and no list to splice. The renderer edits the whole thing and writes
 * it back debounced, exactly as the wish list does.
 */
export function getGearPlan(charId: string): GearPlan {
  return sanitizeGearPlan(getProgress(charId).gearPlan)
}

/** Replace the whole gear plan board for a character. Returns what was actually stored. */
export function setGearPlan(charId: string, gearPlan: GearPlan): GearPlan {
  const next = sanitizeGearPlan(gearPlan)
  setProgress(charId, { ...getProgress(charId), gearPlan: next })
  return next
}
