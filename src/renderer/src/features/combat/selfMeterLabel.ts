// selfMeterLabel.ts — WHAT THE SELF ROW OF A DPS METER IS CALLED, with no React, no DOM, no storage.
//
// The engine folds `you`/`your`/`yourself` to the canonical `"You"` and emits the self combatant
// as `{ id: 'you', kind: 'you', name: 'You', … }`. This module lets the renderer show that row as
// the tailed character's own name instead — `Primitive (You)` — when the user has asked for it.
// The row's IDENTITY (`id`, `kind`) is never touched; only the displayed `name` is re-projected,
// the way `VIEW_LABELS` / `SCOPE_LABEL` map an internal token to display text.
//
// The ` (You)` tag is deliberate: a real group-mate could be named `Primitive` too, and the tag is
// what keeps the self row distinguishable at a glance.

import type { SourceView } from '@shared/combat'

/** Machine-class renderer pref: '1' ⇒ show the character name, absent/'0' ⇒ show "You".
 *  Same class as `eq.combat.petRow` and `eq.combat.scope` — never crosses IPC. */
export const SELF_METER_NAME_KEY = 'eq.combat.selfMeterName'

/**
 * The self row's display name, or `null` to leave it exactly as the engine sent it (`"You"`).
 *
 * `null` — not `"You"` — is the "no change" answer on purpose: `withSelfLabel` treats `null` as
 * "return the input untouched", so the pref-off path and the name-not-known-yet path both cost
 * nothing.
 */
export function selfMeterLabel(charName: string | null | undefined, show: boolean): string | null {
  const name = (charName ?? '').trim()
  return show && name ? `${name} (You)` : null
}

/**
 * Re-project the self `SourceView`'s `name`. Returns `rows` BY REFERENCE when there is nothing to
 * do — `label` is null, or no row is the self row — so a solo session with the feature off (the
 * default) allocates nothing and no downstream memo churns.
 */
export function withSelfLabel(rows: SourceView[], label: string | null): SourceView[] {
  if (label === null || !rows.some((r) => r.kind === 'you')) return rows
  return rows.map((r) => (r.kind === 'you' ? { ...r, name: label } : r))
}
