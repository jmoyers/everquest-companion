// storeCloseToTray.ts — the persisted half of "the X keeps the companion running" (JOS-139).
//
// A FIFTH MODULE THROUGH THE `settingsStore` DOOR (uiScale.ts was the first, storeRespawn.ts the
// second, storeSoundPacks.ts the third, storeOverlaySnap.ts the fourth): store.ts sits at the
// repo's 400-code-line factoring ceiling and the stated answer to that is a split rather than a
// widened threshold. It owes the same discipline every accessor in store.ts follows and pays it —
// read through `normalizeCloseToTray`, write back through the SAME normalizer.
//
// ADDITIVE + OPTIONAL ⇒ NO SCHEMA BUMP, NO MIGRATION — the `lastSeenNotesVersion` /
// `eqDiscoveredRoot` / `buffTrust` / `soundPacks` / `overlaySnap` carve-out storeShape.ts
// documents. AND THIS ONE DEFAULTS TO **ON**, which is worth stating because `processPriority`
// (also on by default) took a migration instead: the difference is what an absent key means. A
// missing `processPriority` had to be distinguishable from a stored `false` for a LATER step to
// reason about. Nothing downstream of this key ever needs to know whether the user chose the
// default or inherited it: every reader defaults, an absent key is the shipped behaviour of the
// feature, and a store written here still opens in a build that predates it (where the extra key
// is simply carried through untouched). The owner's design says so directly.
//
// THE MEANING of the preference, the close policy it feeds and the notice's own state all live in
// shared/closeToTray.ts beside the pure functions. This file is storage and nothing else.

import { settingsStore } from './store'
import {
  mergeCloseToTray,
  normalizeCloseToTray,
  type CloseToTrayPrefs
} from '../shared/closeToTray'

/** The stored blob, defaulted. Never throws, never returns a partial. */
export function getCloseToTray(): CloseToTrayPrefs {
  return normalizeCloseToTray(settingsStore.get('closeToTray'))
}

/**
 * Merge-patch the blob; returns what was ACTUALLY stored, so the Preferences switch and the tray
 * menu's checkbox both render main's answer rather than assuming their request landed.
 *
 * The patch is `unknown` because it arrives over IPC. The second argument is the merge: fields the
 * patch does not name (or names with the wrong type) fall back to what is stored right now — which
 * is what lets the popover's `Always quit instead` write `{ enabled: false, noticeAcknowledged:
 * true }` and the tray checkbox write `{ enabled }` alone, through one door.
 */
export function setCloseToTray(patch: unknown): CloseToTrayPrefs {
  const next = mergeCloseToTray(patch, mergeCloseToTray(settingsStore.get('closeToTray')))
  settingsStore.set('closeToTray', next)
  return normalizeCloseToTray(next)
}
