// uiScale.ts — the persisted MAIN WINDOW text size, main-process side (JOS-123).
//
// The settings-accessor half of the feature: read through `normalizeUiScale`, written through the
// SAME normalizer, over the one open store. It lives here rather than beside the other prefs
// accessors because `src/main/store.ts` is AT the repo's 400-code-line factoring ceiling, and the
// house answer to that is a split (windows.ts → windowErrors.ts). What stayed behind is the only
// thing that could not move: `uiScale`'s place in `StoreShape`, and the `settingsStore` handle
// this file reads it through — see the banner on that export.
//
// NO SCHEMA BUMP. The key is additive and optional, and an absent one reads as 1 — which is the
// size every store written before this feature existed was already being drawn at, so an upgrade
// resizes nobody. The `lastSeenNotesVersion` / `eqDiscoveredRoot` precedent, stated in StoreShape.
//
// TWO CALLERS, AND THEY WANT DIFFERENT MOMENTS. `src/main/windows.ts` reads the value while it is
// BUILDING the main window (`webPreferences.zoomFactor`), so a launch paints at the chosen size
// instead of jumping to it; `src/main/ipc/uiScale.ts` writes it and zooms the live window in the
// same call. Reading from a window factory is safe for the reason `getGraphicsPrefs()` is safe in
// the composition root: store.ts has opened and migrated the file before any other module body
// runs.

import { settingsStore } from './store'
import { normalizeUiScale } from '../shared/uiScale'

/** The main window's zoom factor, snapped to the ladder. Never throws, never returns a partial. */
export function getUiScale(): number {
  return normalizeUiScale(settingsStore.get('uiScale'))
}

/**
 * Store a scale; returns what was ACTUALLY stored, so no caller has to assume its write landed on
 * the value it sent. VALIDATED HERE because the renderer supplies it (the `sounds:getData` rule):
 * a window at a size Preferences has no button for is a window nobody can put back.
 */
export function setUiScale(value: unknown): number {
  const next = normalizeUiScale(value)
  settingsStore.set('uiScale', next)
  return next
}
