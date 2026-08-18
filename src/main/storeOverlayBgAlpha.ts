// storeOverlayBgAlpha.ts — the persisted half of "one overlay transparency, or twelve" (JOS-407).
//
// A SIXTH MODULE THROUGH THE `settingsStore` DOOR, beside storeOverlayTextSize.ts and for its
// reason: store.ts sits at the repo's 400-code-line factoring ceiling and the stated answer to that
// is a split rather than a widened threshold. It owes the same discipline every accessor in
// store.ts follows and pays it — read through `normalizeOverlayBgAlpha`, write back through the
// SAME normalizer.
//
// ADDITIVE + OPTIONAL ⇒ NO SCHEMA BUMP — the `lastSeenNotesVersion` / `overlaySnap` /
// `overlayTextSize` carve-out storeShape.ts documents. Like its text-size twin it carries a
// one-time DERIVATION: absent means "this store predates the switch", and the honest value for it
// is not a default but an answer read off what the store already holds.

import { setOverlayConfig, settingsStore } from './store'
import { OVERLAY_KINDS } from '../shared/types'
import {
  deriveBgAlphaPrefs,
  mergeOverlayBgAlpha,
  normalizeOverlayBgAlpha,
  storedSharedBgAlpha,
  type OverlayBgAlphaPrefs
} from '../shared/overlayBgAlpha'

/**
 * THE UPGRADE, DONE ONCE AND WRITTEN DOWN — AND IT ASKS EVERY KIND, INCLUDING THE ABSENT ONES.
 *
 * `OVERLAY_KINDS` rather than `Object.keys(overlays)` is the difference between this derivation and
 * its text-size twin, and it is load-bearing: a kind with no stored config is a window drawing at
 * 0.72, so it is a vote for 0.72. A store holding one deliberately faint respawn window and eleven
 * windows nobody has ever touched is the "they differ" case and must come up INDEPENDENT — asking
 * only the kinds that happen to have a row would call it unanimous and repaint eleven windows on
 * the first launch after the update, which is exactly the harm this ticket exists to avoid.
 *
 * `getOverlayConfig` is not used here on purpose: it MATERIALIZES a config (it merges over the
 * per-kind defaults), and the question being asked is what the store already says. The raw read
 * answers `undefined` for a kind nobody has written, and `clampBgAlpha` inside the derivation turns
 * that into the same 0.72 the window is painting.
 */
function deriveFromKinds(): OverlayBgAlphaPrefs {
  const all = settingsStore.get('overlays') ?? {}
  return deriveBgAlphaPrefs(OVERLAY_KINDS.map((kind) => all[kind]?.bgAlpha))
}

/**
 * The prefs blob, defaulted and — on the first read of an upgrading store — derived and persisted.
 * Never throws, never returns a partial.
 *
 * IT IS WRITTEN BACK, and that is what makes it a migration rather than a computation: the derived
 * answer becomes the stored one on the first read after the update, so the person who then drags
 * the slider is moving a value with a home. Every later launch takes the short path at the top.
 */
export function getOverlayBgAlpha(): OverlayBgAlphaPrefs {
  const raw = settingsStore.get('overlayBgAlpha')
  if (storedSharedBgAlpha(raw) !== null) return normalizeOverlayBgAlpha(raw)
  // `seeded` rides in from the derivation: an install that comes up independent is already opted
  // in, and its twelve values are the very thing the least-harm rule just decided to keep.
  const next = mergeOverlayBgAlpha(deriveFromKinds(), normalizeOverlayBgAlpha(raw))
  settingsStore.set('overlayBgAlpha', next)
  return next
}

/**
 * Merge-patch the blob; returns what the overlays will ACTUALLY do, so a Preferences control (or a
 * window's own `bg` slider, which routes here through `overlay:setConfig`) renders main's answer
 * rather than assuming its request landed.
 *
 * The patch is `unknown` because it arrives over IPC. The merge base is the CURRENT value read
 * through `getOverlayBgAlpha`, so a patch that names only `independent` cannot silently reset the
 * shared alpha — and so the derivation above happens before the very first write, not after it.
 */
export function setOverlayBgAlpha(patch: unknown): OverlayBgAlphaPrefs {
  const cur = getOverlayBgAlpha()
  const next = mergeOverlayBgAlpha(patch, cur)
  // OPTING IN CHANGES NOTHING ON SCREEN, once ever (see `seedOnFirstOptIn`).
  if (next.independent && cur.seeded !== true) {
    seedOnFirstOptIn(cur.shared)
    next.seeded = true
  }
  settingsStore.set('overlayBgAlpha', next)
  return next
}

/**
 * OPTING IN RE-PAINTS NOTHING — ONCE, EVER.
 *
 * `OverlayBgAlphaPrefs.seeded` (shared/overlayBgAlpha.ts) carries the argument; this is the
 * mechanism, and it keeps its twin's two rules: EVERY kind (a drag or a lock has already
 * materialized a `bgAlpha`, so a seed keyed on absence would skip exactly the windows somebody had
 * moved), and ONCE (the caller gates on `seeded`, so the second flip does nothing and a remembered
 * 40% survives every later trip through the switch — the JOS-168 rule, intact).
 *
 * IT IS ALSO WHY THE MIGRATION SETS `seeded` ITSELF: an upgrading store that came up independent
 * has twelve values that mean something, and flattening them to the shared alpha here would undo
 * the least-harm decision one read earlier.
 *
 * The writes go through the ordinary accessor, which fills the rest of each config from its own
 * defaults — assembling a config literal here would be a second opinion about what an overlay is.
 */
function seedOnFirstOptIn(shared: number): void {
  for (const kind of OVERLAY_KINDS) setOverlayConfig(kind, { bgAlpha: shared })
}
