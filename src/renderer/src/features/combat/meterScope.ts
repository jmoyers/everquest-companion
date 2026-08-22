// METER SCOPE — whose damage (and whose healing) the meter is showing.
// docs/plans/group-model.md §2.
//
// The sibling of petRows.ts, and the same contract: MUI-FREE AND JSX-FREE ON PURPOSE, because
// the overlay is its own renderer entry with no theme and no component library, and both bundles
// have to reach the one answer. Scope is a FILTER over rows the engine already recorded — it
// re-ranks and re-bases, it never re-attributes and never asks the engine for a different fold.
// That is what makes "a wrong roster can hide a row, never corrupt a number" (design doc §0)
// true of the UI as well as of the engine.
//
// THE ONE SUBTLETY, and the reason this file exists rather than a `.filter()` at each call site:
// a filtered list needs its HEADLINE recomputed. `SegmentView.outTotal` is you + pets + members,
// so a You-scoped list of rows under a group-scoped total would show a header that no visible
// row accounts for — the exact "aggregates lie" failure (law 5). Everything the header states is
// derived here from the rows that survived, from identities.
//
// AND THE INVARIANT THAT KEEPS SOLO PLAY EXACTLY AS IT WAS: when nothing is filtered out — every
// session with no group, which is most of them — the SAME array and the SAME numbers come back
// by reference. No re-ranking, no new objects, no memo churn, and no possibility of a rounding
// difference appearing in a meter that has no members in it.

// `effectiveScope` is a VALUE, so it is imported RELATIVELY — the same rule useGlobalFight.ts and
// dashboardData.ts state in their own headers. The node tests run without the renderer's
// `@shared/*` alias, and this module has its own test file (tests/meterScope.test.mts).
import { effectiveScope, isScopedKind } from '../../../../shared/roster'
import type { MeterScope, RosterSnap } from '@shared/roster'
import type { HealSourceView, SourceView } from '@shared/combat'

/** The canonical roster key behind a `member:<key>` source id, or null for any other row. Both the
 *  `'member'` and the `'other'` kind carry this id shape (JOS-430) — one person, one row, whether
 *  or not the roster has learned their name yet. */
export function memberKeyOf(id: string): string | null {
  return id.startsWith('member:') ? id.slice('member:'.length) : null
}

/**
 * The CHARMER's canonical key behind an ally-pet row id (JOS-250). The id is
 * `allypet:<charmerKey>:<petKey>` — the charmer sits in the middle because the pet's own key may
 * itself contain a colon-free but space-bearing mob name, and because the ROW is about the person.
 */
export function charmerKeyOf(id: string): string | null {
  if (!id.startsWith('allypet:')) return null
  const rest = id.slice('allypet:'.length)
  const cut = rest.indexOf(':')
  return cut <= 0 ? null : rest.slice(0, cut)
}

/** The canonical key behind a healer id (`heal:<key>`, or 'you' for your own row). */
function healerKeyOf(id: string): string | null {
  return id.startsWith('heal:') ? id.slice('heal:'.length) : null
}

/** Is this member on the roster right now? */
function onRoster(roster: RosterSnap, key: string): boolean {
  return roster.members.some((m) => m.key === key)
}

/**
 * DAMAGE rows for one scope. `pct` is re-based against the surviving maximum, because it is a
 * BAR WIDTH: leaving the engine's segment-relative percentages in place after filtering would
 * draw a list whose longest bar stops short for no visible reason.
 */
export function scopeSources(rows: SourceView[], scope: MeterScope, roster: RosterSnap): SourceView[] {
  const eff = effectiveScope(scope, roster)
  if (eff === 'everyone') return rows
  const kept = rows.filter((r) => {
    // An ally's charm pet filters like the person who charmed it (shared/roster.ts scopeAllows
    // carries the argument); the key it filters on is the CHARMER's, off the row id.
    if (!isScopedKind(r.kind)) return true
    if (eff === 'you') return false
    // `'other'` (JOS-430) reads its key exactly where `'member'` does — same id namespace — and is
    // then asked the same question of the ROSTER, which is what makes Group an allowlist rather
    // than a statement about the kind a row happened to be recorded under.
    const key = r.kind === 'allyPet' ? charmerKeyOf(r.id) : memberKeyOf(r.id)
    return key !== null && onRoster(roster, key)
  })
  if (kept.length === rows.length) return rows
  const max = Math.max(1, ...kept.map((r) => r.total))
  return kept.map((r) => ({ ...r, pct: (r.total / max) * 100 }))
}

/** The headline figures for a scoped damage list — summed from the visible rows, never carried
 *  over from the unfiltered segment. `dps` scales with the total because the two share one
 *  denominator (the segment's own elapsed time), so the ratio is exact rather than re-derived. */
export function scopeTotals(
  rows: SourceView[],
  scoped: SourceView[],
  total: number,
  dps: number
): { total: number; dps: number } {
  if (scoped === rows) return { total, dps }
  const kept = scoped.reduce((n, r) => n + r.total, 0)
  return { total: kept, dps: total > 0 ? (dps * kept) / total : 0 }
}

/**
 * HEALING rows for one scope. The healing model already had the ally lane the damage model
 * lacked — `HealSourceKind` has carried `'other'` (any non-you, non-pet healer) since Task #59 —
 * so scoping healers needed no engine change at all: You keeps you and your pets, Group keeps
 * the ones the roster names, Everyone keeps every healer the segment saw.
 *
 * A healer who is NOT on the roster is still real and still healed you; Everyone is where they
 * live, exactly like an ex-member's damage row.
 */
export function scopeHealers(rows: HealSourceView[], scope: MeterScope, roster: RosterSnap): HealSourceView[] {
  const eff = effectiveScope(scope, roster)
  if (eff === 'everyone') return rows
  const kept = rows.filter((h) => {
    if (h.kind !== 'other') return true
    if (eff === 'you') return false
    const key = healerKeyOf(h.id)
    return key !== null && onRoster(roster, key)
  })
  return kept.length === rows.length ? rows : kept
}

/**
 * The scoped HEALING MODEL — the one call both heal surfaces make before handing the model to
 * `healRows.healPanel`.
 *
 * HERE rather than at the two call sites, and healRows.test.mts's one-builder pin is what says
 * why: the Combat tab's Healing dimension and the floating heal overlay must never each reach
 * into `healing.healers` on their own, because that is the seam that lets two surfaces drift
 * into disagreeing about the same fight. Scoping is a filter over the model, so it belongs
 * beside the damage filter and in front of the shared builder — one filter, one builder, two
 * renderers.
 *
 * The model comes back BY REFERENCE when the scope removed nothing, so an ungrouped session
 * builds exactly the object it built before.
 */
export function scopeHealing<T extends { healers: HealSourceView[] }>(
  healing: T | undefined,
  scope: MeterScope,
  roster: RosterSnap
): T | undefined {
  if (healing === undefined) return undefined
  const healers = scopeHealers(healing.healers, scope, roster)
  return healers === healing.healers ? healing : { ...healing, healers }
}
