// storeChatCapture.ts — the persisted half of "the Chat tab also saves to a file" (chat capture).
//
// Another module through the `settingsStore` door (uiScale.ts was the first, storeCloseToTray.ts a
// sibling): store.ts sits at the 400-code-line factoring ceiling, so an accessor pair lives beside
// it rather than in it. A single boolean — there is no blob to normalize, so unlike closeToTray
// there is no shared normalizer; the default IS the normalization.
//
// ADDITIVE + OPTIONAL ⇒ NO SCHEMA BUMP, NO MIGRATION, and it DEFAULTS TO ON — the storeShape.ts
// key comments carry the full argument (the `closeToTray` carve-out: a default-on additive key
// needs no migration because nothing downstream must tell a stored default from an inherited one).

import { settingsStore } from './store'

/** Is the durable chat archive on? Absent ⇒ ON (the shipped behaviour of the feature). */
export function getChatCapture(): boolean {
  return settingsStore.get('chatCapture') ?? true
}

/** Persist the switch; returns what was stored, so the Preferences toggle renders main's answer
 *  rather than assuming its request landed. */
export function setChatCapture(enabled: boolean): boolean {
  settingsStore.set('chatCapture', enabled)
  return enabled
}
