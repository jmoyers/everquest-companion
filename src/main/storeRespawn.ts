// storeRespawn.ts — the persisted RESPAWN WATCH LIST, main-process side (JOS-194).
//
// The settings-accessor half of the feature: read through `normalizeRespawnPrefs`, written through
// the SAME normalizer, over the one open store. It lives here rather than beside the other prefs
// accessors because `src/main/store.ts` is AT the repo's 400-code-line factoring ceiling and this
// feature is the addition that would have crossed it; the house answer to that is a split
// (windows.ts → windowErrors.ts, and uiScale.ts through this very door). What stayed behind is the
// only thing that could not move: `respawn`'s place in `StoreShape`, and the `settingsStore` handle
// this file reads it through — see the banner on that export.
//
// NO SCHEMA BUMP, AND NONE FOR THE RETIRED FLAG EITHER. The key is additive and optional, and an
// absent one reads as the shipped default: NO watches, because tracking is opt-in per mob (owner
// ruling — shared/respawn.ts). So a store written by an older build loads here unchanged, and one
// written here still opens in a build that predates the feature. The prototype's `autoWiki` flag
// needs no migration to disappear: `normalizeRespawnPrefs` drops unknown fields, so a store that
// still carries it reads as its watch list and is rewritten without it on the next set.
// The `lastSeenNotesVersion` / `uiScale` precedent, stated in StoreShape.
//
// TWO CALLERS, AND THEY WANT DIFFERENT MOMENTS. `src/main/pipeline.ts` reads it while CONSTRUCTING
// the module graph, so the first fold already knows what you watch; `src/main/ipc/respawn.ts`
// writes it and applies it to the running module in the same call, so a watch added mid-session
// produces its row from the death already in the model rather than from the next one.

import { settingsStore } from './store'
import { normalizeRespawnPrefs, type RespawnPrefs } from '../shared/respawn'

/** The respawn watch list, defaulted. Never throws, never returns a partial. */
export function getRespawnPrefs(): RespawnPrefs {
  return normalizeRespawnPrefs(settingsStore.get('respawn'))
}

/**
 * Store a watch list; returns what was ACTUALLY stored, so no caller has to assume its write landed
 * on the value it sent. VALIDATED HERE because the renderer supplies it (the `sounds:getData`
 * rule): a hand-edited file and an old renderer must not be able to give the module a shape it
 * then has to defend against.
 */
export function setRespawnPrefs(next: unknown): RespawnPrefs {
  const clean = normalizeRespawnPrefs(next)
  settingsStore.set('respawn', clean)
  return clean
}
