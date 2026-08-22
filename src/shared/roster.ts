// THE GROUP ROSTER — who you are with, and how confident the app is about each name.
// docs/plans/group-model.md. Shared because three surfaces read it: the main-process module
// that builds it, the combat engine that consults it, and both renderer bundles that filter
// meters by it.
//
// THE ONE RULE THAT PROTECTS EVERYTHING ELSE (design doc §0): THE ROSTER NEVER TOUCHES THE
// PARSER. Every entity's damage is parsed and recorded exactly as before. The roster decides
// two things and no more:
//
//   1. ENGAGEMENT LICENCE — whether a combatant's TARGET counts as a mob YOUR fight is engaged
//      with. A roster member's target does (the mob your group-mate is fighting is the mob you are
//      fighting); a stranger's does not.
//   2. THE VIEW ALLOWLIST — which recorded rows the Group scope shows.
//
// IT NO LONGER DECIDES WHETHER DAMAGE IS RECORDED AT ALL (JOS-430, owner ruling 2026-08-20). It
// used to: `classify()` booked a name only if the roster had admitted it, so an empty roster
// recorded nobody and "Everyone" could not show what nothing had recorded. Every player-vs-mob row
// is recorded now, whatever the roster says (src/main/combat/otherCombatants.ts).
//
// So the promise below is TRUE now rather than aspirational: a WRONG roster can hide a row; it can
// never corrupt a number. Removing a member in the UI re-filters rows that are still recorded and
// still visible under Everyone; switching scope re-filters the same recorded truth. That is what
// "must not interfere with parser accuracy" means structurally, rather than as a promise.
//
// This module is PURE: zero imports, no `node:`, no Electron, no DOM. It compiles under both
// tsconfigs.

/**
 * WHERE A MEMBER CAME FROM, strongest first — the same provenance ladder the class-combo model
 * uses (user > stated > inferred). Rank, not just a label: a weaker signal never overwrites a
 * stronger one's provenance, so a member the user added by hand keeps saying so even after the
 * log confirms them.
 *
 *   'user'      you added them yourself in the roster popover. Outranks everything.
 *   'joined'    `<Name> has joined the group.` — the game said it outright.
 *   'stated'    `<Name> is now the leader of your group.` — the game named them in a role that
 *               only a member can hold. A fact, but about the role, not the join.
 *   'confirmed' `<Name> tells the group, '…'` — they are talking to your group, so they are in
 *               it. The FIRST recovery path: EQ prints the join line once, so a group formed
 *               before the app opened has no join line left to replay.
 *   'buffed'    your one Quick Buff burst landed on them while the log was paying you PARTY
 *               experience (JOS-85). THE SECOND RECOVERY PATH, and the weakest rung on purpose:
 *               `confirmed` needs somebody to TALK, which a quiet group never does and which
 *               shared/logScrub.ts strips from every artifact anyway, so a session could carry
 *               a whole group and name nobody. See src/main/modules/buffFanOut.ts for what is
 *               measured and src/main/modules/roster.ts for the party-experience gate that
 *               makes it precise. Any real membership line outranks it instantly.
 */
export type RosterSource = 'user' | 'joined' | 'stated' | 'confirmed' | 'buffed'

const SOURCE_RANK: Record<RosterSource, number> = {
  user: 4,
  joined: 3,
  stated: 2,
  confirmed: 1,
  buffed: 0
}

/** True when `next` is at least as authoritative as `cur` (see RosterSource). */
export function outranks(next: RosterSource, cur: RosterSource): boolean {
  return SOURCE_RANK[next] >= SOURCE_RANK[cur]
}

/** Human wording for a member's provenance — the roster popover's second line. */
export const SOURCE_LABEL: Record<RosterSource, string> = {
  user: 'added by you',
  joined: 'joined',
  stated: 'group leader',
  confirmed: 'confirmed',
  buffed: 'group buff'
}

export interface RosterMember {
  /** Canonical (lowercased) identity key — `idKey(name)`. */
  key: string
  /** Display name, spelled the way the log spelled it (world-model law 2). */
  name: string
  source: RosterSource
  /** When this name first entered the roster. */
  sinceTs: number
  /** When any signal last re-asserted them. */
  lastConfirmedTs: number
  /**
   * An offline gap has passed with no signal since. EQ drops groups SILENTLY on camp, so the
   * post-login roster may describe a group that no longer exists — but hiding a real member is
   * the worse error (it is literally the bug that started this), so a stale member is rendered
   * dimmed and STILL PASSES the allowlist until a fresh signal either confirms or replaces them.
   */
  stale: boolean
}

/** The roster module's snapshot — small enough (a group is at most five other players) that
 *  the delta is the whole state. */
export interface RosterSnap {
  members: RosterMember[]
  /**
   * Whether ANY group signal has been observed since the last epoch. THE DIFFERENCE BETWEEN
   * "NO ROSTER" AND "SOLO", and the reason the Group scope has a fallback: an empty roster
   * means UNKNOWN, and unknown must not hide people (design doc §2). With `seen: false` the
   * Group scope renders as Everyone and says so on the chip.
   */
  seen: boolean
  /** ts of the most recent membership signal of any kind; 0 when there has been none. */
  lastSignalTs: number
}

export const EMPTY_ROSTER: RosterSnap = { members: [], seen: false, lastSignalTs: 0 }

/**
 * THE LIVE view the combat engine consults — main-process only, never serialized (it carries a
 * method, and the engine reads it thousands of times per replay second, so it must not be a
 * copy). Declared here beside the wire types because the two must never disagree about what a
 * "member" is.
 */
export interface RosterView {
  /** Canonical keys CURRENTLY in the roster: the Group allowlist, and the set nothing may treat
   *  as a hostile. */
  readonly members: ReadonlySet<string>
  /**
   * Canonical keys the engine treats as GROUP MEMBERS for attribution — every name that has been
   * in the roster since the last epoch or self-leave, INCLUDING ones since removed.
   *
   * Wider than `members` on purpose: a member who left an hour ago is still the person whose row
   * carries that fight's damage, and a user REMOVING someone in the popover must only ever hide a
   * row. It never shrinks, which is also what lets a recorded row's `SourceKind` upgrade from
   * `'other'` to `'member'` MONOTONICALLY when the roster finally learns a name (shared/combat.ts).
   *
   * SINCE JOS-430 IT NO LONGER GATES RECORDING. A name outside this set is still recorded — as
   * `'other'`, aggregate-only, engaging nothing. What this set buys is the engagement licence and
   * the Group scope, not the row's existence.
   */
  readonly admitted: ReadonlySet<string>
  /** The log's own spelling for an admitted key, for the meter row's label. */
  nameOf(key: string): string | undefined
}

/** The view a session with no group model has — every default, so nothing changes for a solo
 *  player and every pre-existing caller of `classify()` behaves exactly as before. */
export const EMPTY_ROSTER_VIEW: RosterView = {
  members: new Set<string>(),
  admitted: new Set<string>(),
  nameOf: () => undefined
}

// ----- Meter scope (design doc §2) -----

/**
 * WHOSE DAMAGE THE METER SHOWS. A filter over recorded SOURCES, never over targets — "what you
 * are battling" is already segmented by the fight model and scope must not touch it.
 *
 *   'you'      you + your pets. Today's behavior, unchanged, and still what a solo player sees.
 *   'group'    you + your pets + the current roster.
 *   'everyone' EVERY combatant the log named — members who have since left, and (since JOS-430)
 *              everyone the roster never knew about at all. THE DEFAULT (JOS-229) — an inferred
 *              roster can be incomplete as easily as empty, and the only scope that can hide
 *              nobody is the one that filters nobody. The constant itself lives in renderer
 *              features/combat/combatPrefs.ts, which argues it.
 */
export type MeterScope = 'you' | 'group' | 'everyone'

export const METER_SCOPES: readonly MeterScope[] = ['you', 'group', 'everyone']

/** True when `v` is one of the three scopes — the guard every persisted read goes through, so
 *  a hand-edited store or a stale localStorage value degrades to the default instead of
 *  rendering an empty meter. */
export function isMeterScope(v: unknown): v is MeterScope {
  return v === 'you' || v === 'group' || v === 'everyone'
}

/**
 * THE EFFECTIVE scope — what the three-state control actually resolves to right now.
 *
 * Group with no roster is NOT silently wrong: it falls back to Everyone, because an empty
 * roster means "we have not been told", and law 1 says unknown must never hide people. The
 * chip renders the fallback (`chipLabel` below) so the user can see why they are looking at
 * everybody. The moment any signal lands, the allowlist engages by itself.
 */
export function effectiveScope(scope: MeterScope, roster: Pick<RosterSnap, 'seen'>): MeterScope {
  return scope === 'group' && !roster.seen ? 'everyone' : scope
}

export const SCOPE_LABEL: Record<MeterScope, string> = {
  you: 'You',
  group: 'Group',
  everyone: 'Everyone'
}

/**
 * The one sentence each scope means. HERE rather than in either renderer, for the reason
 * healRows.ts states about its own strings: two surfaces phrasing the same rule differently is
 * how one of them ends up saying something the model cannot support. One phrasing, three
 * renderers (the Combat tab, the damage overlay, the heal overlay).
 */
export const SCOPE_HINT: Record<MeterScope, string> = {
  you: 'You and your pets only',
  group: 'You, your pets and everyone on your group roster',
  everyone: 'Every combatant the log named, including people your group roster never knew about'
}

/** The scope chip's text: the chosen scope, plus the fallback reason when Group has nothing to
 *  filter by. */
export function chipLabel(scope: MeterScope, roster: Pick<RosterSnap, 'seen'>): string {
  if (scope === 'group' && !roster.seen) return 'Group (no roster yet)'
  return SCOPE_LABEL[scope]
}

/** Next scope in the You → Group → Everyone cycle (the overlay's one-click control). */
export function nextScope(scope: MeterScope): MeterScope {
  return scope === 'you' ? 'group' : scope === 'group' ? 'everyone' : 'you'
}

/**
 * The source kinds this filter knows about. Spelled out rather than imported from
 * `shared/combat.ts`: this module is PURE (zero imports, see the header) so that the roster module,
 * the engine and both renderer bundles can all compile against it, and `combat.ts` already imports
 * `RosterSnap` from here — the one-way edge is worth keeping one-way.
 * `tests/meterScope.test.mts` pins the two unions together so they cannot drift.
 */
export type ScopeKind = 'you' | 'pet' | 'member' | 'enemy' | 'allyPet' | 'other'

/** The three kinds whose rows belong to somebody OTHER than you — the ones scope filters. A
 *  `'member'` and an `'other'` row are the same shape of thing (a combatant with a canonical key
 *  in its id); the kind only says whether the roster has learned the name yet, and Group has to
 *  ask the roster either way. */
export function isScopedKind(kind: ScopeKind): boolean {
  return kind === 'member' || kind === 'allyPet' || kind === 'other'
}

/**
 * THE ROW FILTER. `kind` is the recorded source kind and `key` is the canonical member key for
 * a 'member'/'other' row (ignored otherwise).
 *
 * Incoming rows ('enemy') are never filtered — scope is about WHOSE DAMAGE, and the incoming
 * meter is always about what is hitting YOU. Mobs hitting your group are deliberately out of
 * the model (design doc §3.5); nothing here pretends otherwise.
 *
 * `'other'` (JOS-430) filters exactly like `'member'` and NOT by its kind: a name the roster
 * has not learned is not on the roster, so Group hides it and Everyone shows it — which is the
 * whole ruling ("Everyone means any fight the log can see"). Asking the ROSTER rather than the
 * kind is what keeps the two answers from being able to disagree while a name is being upgraded.
 */
export function scopeAllows(
  scope: MeterScope,
  roster: RosterSnap,
  kind: ScopeKind,
  key?: string
): boolean {
  if (kind === 'enemy') return true
  const eff = effectiveScope(scope, roster)
  // AN ALLY'S CHARM PET FILTERS LIKE ITS CHARMER (JOS-250), which is what `key` carries for one:
  // the row belongs to a person, so "show me my group" must mean the same thing whether that
  // person is swinging themselves or their charmed giant is doing it for them. Under the You scope
  // it is hidden for the same reason a group-mate's row is — it is not yours.
  if (!isScopedKind(kind)) return true // you + your pets are in every scope
  if (eff === 'you') return false
  if (eff === 'everyone') return true
  return key !== undefined && roster.members.some((m) => m.key === key)
}
