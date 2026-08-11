// COMBAT VIEW PREFERENCES — the VOCABULARY, with no DOM and no React in it.
//
// `useCombatPrefs.ts` is the storage half (localStorage + the cross-window subscription); this is
// the half that decides what a stored string MEANS. Splitting them is what makes the rules below
// testable at all: a default, a guard and a degrade are exactly the things that break silently,
// and `tests/combatPrefs.test.mts` runs every one of them under plain node with no window object
// anywhere.
//
// MUI-FREE, JSX-FREE, REACT-FREE, and its value imports are RELATIVE — the meterScope.ts /
// useGlobalFight.ts rule, for the same two reasons: the overlay is a second renderer entry that
// reads these same keys, and the node tests resolve no `@shared/*` alias for values.
//
// THE ONE RULE BOTH HALVES SHARE: an absent or unreadable value is the DEFAULT, never an error and
// never an empty surface. Every reader here takes `string | null` (what `localStorage.getItem`
// actually returns) and answers with something a meter can render.

import { isMeterScope } from '../../../../shared/roster'
import type { MeterScope } from '@shared/roster'
import type { Drill } from './dashboardData'

// ── whose damage (JOS-115) ───────────────────────────────────────────────────────────────

/**
 * ONE KEY FOR EVERY COMBAT SURFACE. It used to take a per-surface suffix
 * (`eq.combat.meterScope.combat`, `.overlay.fight`, …) written by a chip on each surface; JOS-115
 * retired the chips and the suffix with them. The old keys are left INERT rather than migrated —
 * three stale answers give no honest way to pick the "real" one, and this is a preference a user
 * restates in one click.
 */
export const METER_SCOPE_KEY = 'eq.combat.meterScope'

/**
 * DEFAULT GROUP, for a fresh install and for an absent key alike (owner, JOS-115).
 *
 * Safe by construction: with no roster, Group resolves to Everyone and the surfaces label
 * themselves `Group (no roster yet)` (shared/roster.ts effectiveScope / chipLabel), so a solo
 * player sees what they always saw and a grouped player sees their group without hunting for a
 * control.
 */
export const DEFAULT_METER_SCOPE: MeterScope = 'group'

/** The stored scope, or the default — for absent, empty, misspelled or hand-edited values alike. */
export function readMeterScope(raw: string | null): MeterScope {
  return isMeterScope(raw) ? raw : DEFAULT_METER_SCOPE
}

// ── where you had drilled to (JOS-116) ───────────────────────────────────────────────────

/**
 * THE DRILL IS A PREFERENCE NOW, not component state (JOS-116, owner: "switching views resets
 * combat panels to fully drilled-out").
 *
 * The lifecycle bug is the one JOS-90 and JOS-97 already fixed twice elsewhere: `ViewContent`
 * mounts exactly ONE feature view at a time, so switching tabs UNMOUNTS the Combat tab and every
 * `useState` in it dies. The overlay never had the bug because its drill lives in its persisted
 * config (`OverlayDrill` in useOverlayChrome.ts) — this is that mechanism mirrored for the in-app
 * surfaces, in the storage they already use for view prefs, so it survives a restart as well.
 *
 * PER SURFACE, deliberately, and this is the one place a per-surface key earns itself: the glance
 * card and the Combat tab are two windows onto one fight that the user navigates independently,
 * and DpsCard has always promised that nothing on it may move the Combat tab's drill.
 */
export function drillKey(surface: string): string {
  return `eq.combat.drill.${surface}`
}

/**
 * WHERE A SURFACE HAD GOT TO: the drilled subject, and which of its abilities were expanded.
 *
 * `abilities` is the JOS-113 inline expansion — a stat-bearing ability's crit/double/triple/miss
 * opening beneath its own bar. It was `useState` inside each `SkillBar`, which is the same
 * unmount-and-forget as the drill one level up, so it is remembered here beside the drill it
 * belongs to. A SET rather than one id, because the bars never took turns: two abilities open at
 * once has always been legal and staying legal costs one array.
 *
 * The abilities belong TO the drilled subject, so changing the subject clears them (`withDrill`).
 * They are never scoped by fight: an ability list is rebuilt from whatever the current segment
 * holds, and a key that names nothing in it simply matches no bar.
 *
 * `abilities` WITHOUT a drill is a legal state, not a contradiction: the Incoming direction has no
 * drill at all and expands an enemy's flat skill list inline at level 1 (EntityRow), and those
 * bars are the same `SkillBar` and deserve the same memory. Un-drilling clears them, which is what
 * keeps a level-1 key from surviving into a level-2 list.
 */
export interface DrillMemory {
  drill: Drill | null
  /** expanded ability keys — `abilityKey(category, name)`, matching the bars' own React keys. */
  abilities: readonly string[]
}

/** Level 1, nothing expanded — what an absent, empty or unreadable value resolves to. */
export const NO_DRILL: DrillMemory = { drill: null, abilities: [] }

/** ONE ability bar's identity, `category|name` — the same string `EntityLanes` keys its rows by,
 *  so the memory and the list can never disagree about which bar is which. */
export function abilityKey(category: string, name: string): string {
  return `${category}|${name}`
}

/** The stored `Drill` union, or null. Anything not exactly one of the two documented arms — a
 *  future build's third kind, a hand-edited blob, a missing id — is no drill at all. */
function parseDrill(v: unknown): Drill | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (o.kind === 'entity' && typeof o.entityId === 'string' && o.entityId !== '') {
    return { kind: 'entity', entityId: o.entityId }
  }
  if (o.kind === 'target' && typeof o.target === 'string' && o.target !== '') {
    return { kind: 'target', target: o.target }
  }
  return null
}

/**
 * Parse a stored memory. TOTAL: every failure mode — absent key, empty string, malformed JSON, an
 * array where an object belongs, a drill arm this build does not know — lands on `NO_DRILL`, which
 * is level 1. That is the JOS-105 degrade rule applied one step earlier than usual: a drill this
 * build cannot even READ degrades exactly like a drill it reads and cannot RESOLVE (a source that
 * has since left the fight), and neither is ever an error the user has to clear.
 */
export function parseDrillMemory(raw: string | null): DrillMemory {
  if (raw === null || raw === '') return NO_DRILL
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return NO_DRILL
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return NO_DRILL
  const o = parsed as Record<string, unknown>
  const drill = parseDrill(o.d)
  const abilities = Array.isArray(o.a) ? o.a.filter((x): x is string => typeof x === 'string' && x !== '') : []
  // Nothing drilled AND nothing expanded is the default, and it has exactly one shape — see
  // `serializeDrillMemory`, which writes that state as an absent key.
  if (!drill && abilities.length === 0) return NO_DRILL
  return { drill, abilities }
}

/**
 * …and back to a string, or `null` for "store nothing at all".
 *
 * The default is stored as an ABSENT KEY, not as `{"d":null,"a":[]}`. Absence is what a fresh
 * install has, so making the two identical means there is exactly one shape of "level 1" and no
 * way for an explicit un-drill to leave behind something a future reader might treat differently.
 * Short keys (`d`/`a`) because this value is rewritten on every drill click.
 */
export function serializeDrillMemory(m: DrillMemory): string | null {
  if (!m.drill && m.abilities.length === 0) return null
  return JSON.stringify({ d: m.drill, a: m.abilities })
}

/** True when two drills name the same subject — the test that decides whether the expanded
 *  abilities still belong to what is on screen. */
function sameSubject(a: Drill | null, b: Drill | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind !== b.kind) return false
  return a.kind === 'entity' && b.kind === 'entity' ? a.entityId === b.entityId : JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Move to a new drill subject. Changing the subject DROPS the expanded abilities: they name bars
 * in the old subject's list, and carrying "Kick was open" from your breakdown into your pet's
 * would open whatever happened to share the name. Re-drilling the SAME subject keeps them, so a
 * click that lands where you already were is not a reset.
 *
 * UN-DRILLING IS ALWAYS A FULL RESET, which is the one asymmetry here and it is deliberate: `null`
 * is not a subject you can be "already on", and Back / All / Esc / a fight change all mean "put
 * this surface back the way it opens". It is also what keeps a level-1 expansion (the Incoming
 * direction's inline enemy list) from leaking into the next level-2 list.
 */
export function withDrill(m: DrillMemory, drill: Drill | null): DrillMemory {
  if (drill === null) return NO_DRILL
  if (sameSubject(m.drill, drill)) return m
  return { drill, abilities: [] }
}

/** Open or close ONE ability's inline stats. Idempotent in both directions, and it returns the
 *  SAME object when nothing changed so a no-op click writes nothing. */
export function withAbility(m: DrillMemory, key: string, open: boolean): DrillMemory {
  const has = m.abilities.includes(key)
  if (has === open) return m
  return { drill: m.drill, abilities: open ? [...m.abilities, key] : m.abilities.filter((k) => k !== key) }
}
