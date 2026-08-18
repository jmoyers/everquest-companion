// storeResists.ts — the persisted half of "does NPC-on-NPC evidence count?" (JOS-385).
//
// A MODULE THROUGH THE `settingsStore` DOOR, like `storeProcessPriority.ts`, `storeCloseToTray.ts`
// and the four before them: store.ts sits at the repo's 400-code-line factoring ceiling and the
// stated answer to that is a split rather than a widened threshold. It owes the same discipline
// every accessor in store.ts follows and pays it — read through `normalizeResistPrefs`, write back
// through the SAME normalizer.
//
// AND IT CARRIES A SCHEMA BUMP (13 -> 14, storeMigrations.ts), for the reason `processPriority`
// did and `closeToTray` did not: the default is ON, so an absent key means the OPPOSITE of a
// stored `false`, and a v14 store states the answer rather than leaving every future reader to
// infer which one it is looking at.
//
// WHAT the setting means, and why it is read at estimate time rather than at fold time, is in
// shared/resistPrefs.ts. This file is storage and nothing else.

import { settingsStore } from './store'
import { normalizeResistPrefs, type ResistPrefs } from '../shared/resistPrefs'

/** The stored blob, defaulted. Never throws, never returns a partial. */
export function getResistPrefs(): ResistPrefs {
  return normalizeResistPrefs(settingsStore.get('resists'))
}

/**
 * Merge-patch the blob; returns the stored (re-normalized) value, so no caller has to assume its
 * write landed on the value it sent. VALIDATED HERE because the renderer supplies it (the
 * `sounds:getData` rule).
 */
export function setResistPrefs(patch: Partial<ResistPrefs>): ResistPrefs {
  const next = normalizeResistPrefs({ ...getResistPrefs(), ...patch })
  settingsStore.set('resists', next)
  return next
}
