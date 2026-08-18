// storeOverlayTextSize.ts — the persisted half of "one overlay size, or twelve" (JOS-405).
//
// A FIFTH MODULE THROUGH THE `settingsStore` DOOR (uiScale.ts was the first, storeRespawn.ts the
// second, storeSoundPacks.ts the third, storeOverlaySnap.ts the fourth, storeCloseToTray.ts the
// fifth-and-a-half): store.ts sits at the repo's 400-code-line factoring ceiling and the stated
// answer to that is a split rather than a widened threshold. It owes the same discipline every
// accessor in store.ts follows and pays it — read through `normalizeOverlayTextSize`, write back
// through the SAME normalizer.
//
// ADDITIVE + OPTIONAL ⇒ NO SCHEMA BUMP — the `lastSeenNotesVersion` / `eqDiscoveredRoot` /
// `buffTrust` / `soundPacks` / `overlaySnap` carve-out storeShape.ts documents. What it DOES have,
// and the reason this file is longer than storeOverlaySnap.ts, is a one-time DERIVATION: absent
// means "this store predates the switch", and the honest value for it is not a default but an
// answer read off what the store already holds.

import { setOverlayConfig, settingsStore } from './store'
import { OVERLAY_KINDS } from '../shared/types'
import {
  deriveSharedTextScale,
  mergeOverlayTextSize,
  normalizeOverlayTextSize,
  storedSharedTextScale,
  type OverlayTextSizePrefs
} from '../shared/overlayTextScale'

/**
 * THE UPGRADE, DONE ONCE AND WRITTEN DOWN.
 *
 * Every install through 1.4.0 holds twelve EQUAL `overlays.<kind>.textScale` values, because the
 * old setter fanned every press out to all of them. So the shared size an upgrading store should
 * come up at is exactly that number, and `deriveSharedTextScale` (shared/overlayTextScale.ts)
 * states the general rule for a store that is not so tidy — most common, ties to the larger,
 * nothing stored ⇒ the default.
 *
 * IT IS WRITTEN BACK, and that is what makes it a migration rather than a computation: the derived
 * answer becomes the stored one on the first read after the update, so the person who then presses
 * A− is moving a value with a home rather than re-deriving it against a per-kind field nothing
 * writes any more. Every later launch takes the short path at the top of `getOverlayTextSize`.
 *
 * ACCEPTANCE, in one sentence: nothing changes size on the first launch after the upgrade.
 */
function deriveFromKinds(): number {
  const all = settingsStore.get('overlays') ?? {}
  return deriveSharedTextScale(Object.values(all).map((cfg) => cfg?.textScale))
}

/**
 * The prefs blob, defaulted and — on the first read of an upgrading store — derived and persisted.
 * Never throws, never returns a partial.
 */
export function getOverlayTextSize(): OverlayTextSizePrefs {
  const raw = settingsStore.get('overlayTextSize')
  if (storedSharedTextScale(raw) !== null) return normalizeOverlayTextSize(raw)
  const next = mergeOverlayTextSize({ shared: deriveFromKinds() }, normalizeOverlayTextSize(raw))
  settingsStore.set('overlayTextSize', next)
  return next
}

/**
 * Merge-patch the blob; returns what the overlays will ACTUALLY do, so a Preferences control (or a
 * window's own A− / A+, which routes here through `overlay:setConfig`) renders main's answer rather
 * than assuming its request landed.
 *
 * The patch is `unknown` because it arrives over IPC. The merge base is the CURRENT value read
 * through `getOverlayTextSize`, so a patch that names only `independent` cannot silently reset the
 * shared size — and so the derivation above happens before the very first write, not after it.
 */
export function setOverlayTextSize(patch: unknown): OverlayTextSizePrefs {
  const cur = getOverlayTextSize()
  const next = mergeOverlayTextSize(patch, cur)
  // OPTING IN CHANGES NOTHING ON SCREEN, once ever (see `seedOnFirstOptIn`).
  if (next.independent && cur.seeded !== true) {
    seedOnFirstOptIn(cur.shared)
    next.seeded = true
  }
  settingsStore.set('overlayTextSize', next)
  return next
}

/**
 * OPTING IN RESIZES NOTHING — ONCE, EVER.
 *
 * The argument for why this exists at all is on `OverlayTextSizePrefs.seeded`
 * (shared/overlayTextScale.ts), together with the measurement that produced it. What lives here is
 * the mechanism, and its two rules:
 *
 *   - EVERY kind, not "the ones with no value". `setOverlayConfig` merges over `getOverlayConfig`,
 *     which clamps an absent scale to the default — so any drag or lock has already materialized a
 *     `textScale` of 1, and a seed keyed on absence would skip exactly the windows somebody had
 *     moved. Seeding all twelve from what they are all currently drawing at is the same answer for
 *     every one of them anyway: while synced, that is the shared size by definition.
 *   - ONCE. The caller gates on `seeded`, so the SECOND flip does nothing and a remembered 150%
 *     survives every later trip through the switch. That is the JOS-168 rule, intact.
 *
 * This is not the retired fan-out coming back: that wrote twelve kinds on EVERY PRESS, which is
 * what flattened the twelve values and left nothing to unsync to. This writes them on a single
 * opt-in, from the value every one of them is already showing.
 *
 * The writes go through the ordinary accessor, which fills the rest of each config from its own
 * defaults — assembling a config literal here would be a second opinion about what an overlay is.
 */
function seedOnFirstOptIn(shared: number): void {
  for (const kind of OVERLAY_KINDS) setOverlayConfig(kind, { textScale: shared })
}
