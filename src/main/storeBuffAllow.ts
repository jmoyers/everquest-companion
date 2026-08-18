// storeBuffAllow.ts — the persisted BUFF/DEBUFF ALLOW-LIST, main-process side (JOS-168).
//
// The settings-accessor half of the feature: read through `normalizeBuffAllowPrefs`, written
// through the SAME normalizer, over the one open store. It lives here rather than beside the other
// prefs accessors because `src/main/store.ts` is AT the repo's 400-code-line factoring ceiling and
// the house answer to that is a split, never a widened threshold (uiScale.ts and storeRespawn.ts
// took this same door). What stayed behind is the only thing that could not move: `buffAllow`'s
// place in `StoreShape`, and the `settingsStore` handle this file reads it through.
//
// WHY IT IS IN THE REAL STORE AND NOT localStorage, which is the one thing the ticket names as the
// piece of plumbing it adds. The Buffs TAB is the main window; the surfaces this preference
// filters are the buffs and debuffs OVERLAY WINDOWS, which are separate BrowserWindows with their
// own renderer processes and their own localStorage. The tab's `showPermanent` switch really is
// per-renderer state and lives in localStorage for that reason (BuffsView.tsx says so); this one
// cannot, because the window that must obey it is not the window that sets it.
//
// NO SCHEMA BUMP, NO MIGRATION. The key is additive and optional, and an absent one reads as the
// shipped behaviour — default mode, no verdicts, every spell drawn — so a store written by an
// older build loads here unchanged and one written here still opens in a build that predates the
// feature. The `buffTrust` / `respawn` precedent, stated in StoreShape.

import { settingsStore } from './store'
import { normalizeBuffAllowPrefs, type BuffAllowPrefs } from '../shared/buffAllow'

/** The allow-list, defaulted. Never throws, never returns a partial. */
export function getBuffAllowPrefs(): BuffAllowPrefs {
  return normalizeBuffAllowPrefs(settingsStore.get('buffAllow'))
}

/**
 * Store a whole allow-list; returns what was ACTUALLY stored, so no caller has to assume its write
 * landed on the value it sent. VALIDATED HERE because the renderer supplies it (the
 * `sounds:getData` rule): a hand-edited file and an old renderer must not be able to hand a timer
 * window a shape it would then have to defend against.
 */
export function setBuffAllowPrefs(next: unknown): BuffAllowPrefs {
  const clean = normalizeBuffAllowPrefs(next)
  settingsStore.set('buffAllow', clean)
  return clean
}
