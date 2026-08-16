// gear/areaMemory.ts — WHAT THE GEAR AREA REMEMBERS ABOUT ITS OWN FORMS, and for how long
// (JOS-329, owner report 2026-08-13, verbatim: *we're losing everything right now*).
//
// ============================================================================
// THE BUG THIS FILE EXISTS FOR
// ============================================================================
// A VIEW UNMOUNTS ON EVERY TAB SWITCH, so `useState` in one is a promise you cannot keep — the
// standing law (JOS-90, JOS-97, JOS-116, AGENTS.md), now reported for a FOURTH time over a whole
// area at once. The gear area is four tabs (`appViews.GEAR_AREA_VIEWS`) and App renders exactly one
// view at a time, so leaving Gear for Loot — or drilling into Loot from a wish row and pressing
// Back — destroyed every filter, every pick and every search box on the way out. Only the JOS-297
// chips survived, because they were the only state anybody had written down.
//
// ============================================================================
// THE RULE, WRITTEN DOWN ONCE, FOR ALL FOUR TABS
// ============================================================================
//   WHAT YOU **TYPED** IS SESSION-SCOPED.   WHAT YOU **CHOSE** IS RESTART-SCOPED.
//
// Both tiers survive the thing the ticket is actually about — leaving the area and coming back —
// because both are STORAGE and the view re-reads them on mount. They differ only in how long they
// outlive the process:
//
//   * RESTART tier (`localStorage`) — every closed-vocabulary pick and toggle. Classes, slots,
//     weapon types, effect kind, era, owned, the sort, the simulate-upgrade slider, the socket tab,
//     the donor slot, "usable by these classes", the grouping axis, the wish list's era toggle.
//     These are a SHAPE you gave the corpus: you chose them deliberately, they are visible as chips
//     and lit controls whenever the tab is up, and wanting them back next launch is the whole
//     reason the JOS-297 columns picker was persisted in the first place.
//
//   * SESSION tier (`sessionStorage`) — every free-text search box, plus the two narrowings you
//     reach BY typing or by poking the list: the Exaltations item picker, and which effect groups
//     are expanded. A week-old search string greeting a fresh launch is a worse surface, not a
//     better one — which is not a new opinion here, it is the argument `CarryAll.tsx` has carried
//     since JOS-327 and this file only generalises it.
//
// AND THE SPLIT IS DATA, NOT DISCIPLINE. `AREA_FORM_TIER` below maps every key to its tier and
// `useRemembered` looks the tier up from the key it was handed, so a call site CANNOT accidentally
// park a search box on the restart tier. That is the difference between a rule and a convention:
// the only way to move a field between tiers is to edit the table, in one place, on purpose.
//
// WHY `sessionStorage` RATHER THAN A MODULE-LEVEL `Map` for the session tier (the ticket offered
// both): it makes the two tiers ONE code path with ONE parameter — same reader, same writer, same
// sanitizers, the tier chosen by a lookup — so "one pattern applied uniformly" is literally true
// rather than aspirational. It also survives a renderer reload, which an in-memory map does not,
// so an HMR save in dev does not silently reproduce the bug this ticket fixes.
//
// ============================================================================
// A STORED VALUE DEGRADES, IT NEVER ERRORS (JOS-105, gearPrefs.ts's rule)
// ============================================================================
// Storage is a string somebody else's build wrote, and on this machine it is a file the user can
// edit. Every sanitizer below takes `unknown`, drops what it does not recognise and returns the
// caller's default for anything unusable — truncated JSON, an object where a list was, a slot this
// version dropped, a class abbreviation that never existed, a tier the slider cannot reach. There
// is no throw path and no `as` cast that is not preceded by a membership test.
//
// PURE AND NODE-TESTABLE, the `gearPrefs.ts` / `gearFilter.ts` precedent: value imports are
// RELATIVE (the house law), nothing here touches React, `window`, storage or IPC. The hooks that
// DO are next door in `useAreaMemory.ts`, and `tests/areaMemory.test.mts` drives every branch of
// this file without a DOM.

import { CLASS_ABBRS, MAX_COMBO_SLOTS, type ClassAbbr } from '../../../../shared/classCombo'
import { ITEM_UPGRADE_BASE, normalizeUpgradeState, type ItemUpgradeState } from '../../../../shared/itemUpgrade'
import { EQUIP_SLOTS, type EquipSlot, type SocketType } from '../../../../shared/planner/types'
import { PICKABLE_COLUMNS } from './gearColumns'
import {
  DEFAULT_GEAR_FILTERS,
  DEFAULT_GEAR_SORT,
  GEAR_WEAPON_PICKS,
  type EffectFilter,
  type GearFilters,
  type GearSort,
  type GearSortKey,
  type GearWeaponPick
} from './gearFilter'

// ---- the tier table ---------------------------------------------------------------------------

/** Which storage a remembered field lives in — see THE RULE in the header. */
export type MemoryTier = 'restart' | 'session'

/**
 * EVERY FIELD THE GEAR AREA REMEMBERS, AND ITS TIER. This table IS the restart split.
 *
 * The keys keep the prefixes their surfaces already established, so a reader of `localStorage`
 * finds one namespace per tab rather than a new one per ticket: `eq.gear.*` (JOS-297's columns and
 * controls, JOS-324's tab), `eq.planner.*` (the era/non-equippable/group-by/classes keys the
 * browser has had since V4), `eq.wishlist.*` and `eq.character.*` (JOS-327's carry lane).
 *
 * WHAT IS DELIBERATELY NOT HERE, because it already persists and this ticket does not rebuild it:
 * `eq.gear.columns` / `eq.gear.controls` (JOS-297, useGearPrefs.ts), `eq.gear.tab` (JOS-324,
 * appViews.ts), `eq.planner.era` / `eq.planner.nonequip` / `eq.planner.groupBy.<socket>`
 * (plannerData.ts), `eq.planner.classes` / `eq.planner.classesFrom` (useBrowseClasses.ts) and
 * `eq.character.carryLane` (CarryAll.tsx). All nine are already on the restart tier and already
 * validated on load; re-homing them here would be churn that changes nothing a user can see.
 */
export const AREA_FORM_TIER = {
  // ---- the Gear tab ----
  /** slots, weapon types, effect kind, era, owned — the five structural fields of `GearFilters` */
  'eq.gear.filters': 'restart',
  'eq.gear.sort': 'restart',
  /** the PINNED class trio, or absent while the filter is still following detection */
  'eq.gear.classes': 'restart',
  /** the simulate-upgrade slider — persisted by owner ruling, see `sanitizeUpgrade` */
  'eq.gear.upgrade': 'restart',
  'eq.gear.search': 'session',
  // ---- the Exaltations tab ----
  /** socket tab, donor slot, "usable by these classes" — the three fields of `DonorFilters` */
  'eq.planner.filters': 'restart',
  'eq.planner.item': 'session',
  'eq.planner.open': 'session',
  'eq.planner.search': 'session',
  // ---- the Wish list tab ----
  'eq.wishlist.search': 'session',
  // ---- the Character tab ----
  'eq.character.search': 'session'
} as const satisfies Record<string, MemoryTier>

/** A key this area knows how to remember. Anything else is a typo, caught at compile time. */
export type AreaFormKey = keyof typeof AREA_FORM_TIER

/** Which storage this key lives in. The ONE place a field's lifetime is decided. */
export function tierOf(key: AreaFormKey): MemoryTier {
  return AREA_FORM_TIER[key]
}

// ---- the primitives every sanitizer is built from ----------------------------------------------

/**
 * The longest search string we will read back. Storage is user-editable and a search box is the one
 * field with no vocabulary to check against, so the only honest bound is a length — long enough
 * that no real query is ever clipped, short enough that a pathological value cannot reach the
 * filter memo.
 */
export const MAX_REMEMBERED_SEARCH = 120

/** A stored string, capped. Anything that is not a string is "nobody typed anything". */
export function sanitizeSearch(raw: unknown): string {
  return typeof raw === 'string' ? raw.slice(0, MAX_REMEMBERED_SEARCH) : ''
}

/** A stored boolean. Anything else is the caller's default — absent is NOT `false`. */
export function sanitizeFlag(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback
}

/**
 * A stored list, filtered to a closed vocabulary, deduped, capped, and IN THE ORDER IT WAS STORED —
 * the same degradation `gearPrefs.sanitizeColumns` performs and for the same reason: a vocabulary
 * change should shrink a list, never blank a tab.
 *
 * Returns `[]` for a non-array, which is every list field's inert value in this area.
 */
function sanitizeList<T extends string>(raw: unknown, vocab: readonly T[], max = Infinity): T[] {
  if (!Array.isArray(raw)) return []
  const out: T[] = []
  for (const value of raw as unknown[]) {
    if (typeof value !== 'string' || out.length >= max) continue
    const hit = vocab.find((v) => v === value)
    if (hit !== undefined && !out.includes(hit)) out.push(hit)
  }
  return out
}

/** A stored object, or `null` for anything that is not one (arrays included — those are lists). */
function asRecord(raw: unknown): Record<string, unknown> | null {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
}

/** One member of a closed vocabulary, or the caller's default. */
function sanitizeOne<T extends string>(raw: unknown, vocab: readonly T[], fallback: T): T {
  if (typeof raw !== 'string') return fallback
  return vocab.find((v) => v === raw) ?? fallback
}

/**
 * A slot, or `null` for "All slots" — the one field in this file whose vocabulary has a legal
 * non-string member, which is why it cannot go through `sanitizeOne`. A stored `null` SURVIVES as
 * `null` (it is an answer, not a failure to parse); anything unrecognised falls back.
 */
function sanitizeSlot(raw: unknown, fallback: EquipSlot | null): EquipSlot | null {
  if (raw === null) return null
  if (typeof raw !== 'string') return fallback
  return EQUIP_SLOTS.find((s) => s === raw) ?? fallback
}

// ---- the Gear tab ------------------------------------------------------------------------------

/**
 * THE FIVE STRUCTURAL FIELDS OF THE GEAR FILTER BAR — and note which two are NOT here.
 *
 * `text` is on the session tier under its own key, and `classes` is on the restart tier under its
 * own key because it carries a PROVENANCE the other fields do not have (following detection is not
 * the same statement as picking nobody — `sanitizeGearClasses`). Both are absent from this object
 * on purpose: `GearView` keeps its `own` filters as a whole `GearFilters` and re-derives those two
 * fields over it on every render, so writing them here would persist a value that is overwritten
 * before anything reads it.
 */
export type GearFormMemory = Pick<GearFilters, 'slots' | 'weaponTypes' | 'effect' | 'eraOnly' | 'ownedOnly' | 'ignoreHaste'>

/** What the bar opens on when nothing is stored — the shipped defaults, projected. */
export const DEFAULT_GEAR_FORM: GearFormMemory = {
  slots: DEFAULT_GEAR_FILTERS.slots,
  weaponTypes: DEFAULT_GEAR_FILTERS.weaponTypes,
  effect: DEFAULT_GEAR_FILTERS.effect,
  eraOnly: DEFAULT_GEAR_FILTERS.eraOnly,
  ownedOnly: DEFAULT_GEAR_FILTERS.ownedOnly,
  ignoreHaste: DEFAULT_GEAR_FILTERS.ignoreHaste
}

const EFFECT_FILTERS: readonly EffectFilter[] = ['any', 'has', 'proc', 'worn', 'focus', 'click']

/**
 * The stored gear form. FIELD BY FIELD, never wholesale: a stored object missing one key keeps its
 * four siblings rather than throwing the form away, which is what makes adding a sixth control a
 * non-event for anybody who already has a fifth stored.
 */
export function sanitizeGearForm(raw: unknown): GearFormMemory {
  const o = asRecord(raw)
  if (o === null) return DEFAULT_GEAR_FORM
  return {
    slots: sanitizeList<EquipSlot>(o.slots, EQUIP_SLOTS),
    weaponTypes: sanitizeList<GearWeaponPick>(o.weaponTypes, GEAR_WEAPON_PICKS),
    effect: sanitizeOne<EffectFilter>(o.effect, EFFECT_FILTERS, DEFAULT_GEAR_FORM.effect),
    // Era ships ON, so an unreadable value must come back ON — `sanitizeFlag`'s fallback, never a
    // bare `=== true`, which would silently turn the default filter off for a corrupted store.
    eraOnly: sanitizeFlag(o.eraOnly, DEFAULT_GEAR_FORM.eraOnly),
    ownedOnly: sanitizeFlag(o.ownedOnly, DEFAULT_GEAR_FORM.ownedOnly),
    ignoreHaste: sanitizeFlag(o.ignoreHaste, DEFAULT_GEAR_FORM.ignoreHaste)
  }
}

/** Every axis the table can sort on: the item column, plus every column the picker can draw. */
const SORT_KEYS: readonly GearSortKey[] = ['name', ...PICKABLE_COLUMNS]

/**
 * The stored sort. Both halves are checked independently, so a build that renamed a stat key gives
 * back the DEFAULT sort rather than a lit header on a column that no longer exists.
 */
export function sanitizeGearSort(raw: unknown): GearSort {
  const o = asRecord(raw)
  if (o === null) return DEFAULT_GEAR_SORT
  return {
    key: sanitizeOne<GearSortKey>(o.key, SORT_KEYS, DEFAULT_GEAR_SORT.key),
    dir: sanitizeOne<'asc' | 'desc'>(o.dir, ['asc', 'desc'], DEFAULT_GEAR_SORT.dir)
  }
}

/**
 * THE GEAR TAB'S CLASS FILTER, AND WHY IT IS ITS OWN KEY: `null` IS A THIRD ANSWER.
 *
 * `useGearClasses` has two states with the same shape and different meanings — FOLLOWING live
 * class-combo inference (a loadout switch rewrites the filter, silently and correctly, because
 * nobody has said otherwise yet) and PINNED (the user picked by hand; detection may only offer).
 * A pinned EMPTY trio is a real statement — "read the whole corpus, for every class" — and folding
 * it together with "nobody has said anything yet" would make it unexpressible, which is exactly the
 * absent-is-not-empty bug `gearPrefs.ts` is shaped to prevent.
 *
 * So: `null` here means FOLLOWING (the key is removed rather than written), and `{ classes: [...] }`
 * means PINNED to that list — including `{ classes: [] }`. The closed allowlist and the
 * `MAX_COMBO_SLOTS` cap are `useBrowseClasses`' own, applied here for the same reason it applies
 * them: `localStorage` is a file the user can edit and this build is the only thing checking it.
 */
export function sanitizeGearClasses(raw: unknown): ClassAbbr[] | null {
  const o = asRecord(raw)
  if (o === null || !Array.isArray(o.classes)) return null
  return sanitizeList<ClassAbbr>(o.classes, CLASS_ABBRS, MAX_COMBO_SLOTS)
}

/**
 * THE SIMULATE-UPGRADE SLIDER — AND THE LAW THIS OVERRULES.
 *
 * THE OLD LAW (JOS-284, `gearData.useUpgradeState`): the plus-state was the ONE gear preference
 * deliberately not persisted. Its argument was that every other preference is a way of READING the
 * corpus while this one changes what the corpus SAYS — at +5 the table states numbers no item in
 * your bags has — so "a tab that silently reopened at +5 would be lying quietly, and the lie would
 * be invisible precisely because the slider is the thing you stopped looking at."
 *
 * THE OWNER OVERRULED IT ON 2026-08-13 (JOS-329): the slider is named in the list of form state
 * that must survive, alongside the filters and the sort. The ruling stands on its own, but the old
 * argument is answerable rather than merely outvoted, and it is worth writing down which premise
 * failed: **the lie was never quiet.** `UpgradeSlider` draws a permanent label stating exactly what
 * is being simulated in the item window's own words — `Tier 2  3/4  +27.5%`, the string
 * `gear-upgrade-label` and the e2e both read — and that label is on screen from the first paint of
 * every mount. A restored plus-state announces itself; it does not hide. What the old law was
 * really protecting against was state you could not see, and this control is the opposite of that.
 *
 * THE VALIDATION IS `normalizeUpgradeState`, NOT A SECOND OPINION. That function already owns the
 * only legal spelling of a state (full 0..10, fraction 0..2^full - 1, forced to 0 at both ends) and
 * is pinned by `tests/itemUpgrade.test.mts` — so a stored `{full: 99, fraction: -3}` comes back as
 * the cap with nothing banked, and a stored `{full: 3, fraction: 900}` comes back at that tier's
 * real maximum. Non-numbers fall through to base, which is the state the data is actually in.
 */
export function sanitizeUpgrade(raw: unknown): ItemUpgradeState {
  const o = asRecord(raw)
  if (o === null || typeof o.full !== 'number' || typeof o.fraction !== 'number') return ITEM_UPGRADE_BASE
  if (!Number.isFinite(o.full) || !Number.isFinite(o.fraction)) return ITEM_UPGRADE_BASE
  return normalizeUpgradeState({ full: o.full, fraction: o.fraction })
}

// ---- the Exaltations tab -----------------------------------------------------------------------

/** The three fields of `DonorFilters` that are not the search text — the browser's own form. */
export interface BrowseFormMemory {
  socket: SocketType
  slot: EquipSlot | null
  trioOnly: boolean
}

const SOCKETS: readonly SocketType[] = ['proc', 'worn', 'focus', 'click']

/**
 * The stored browse form.
 *
 * IT TAKES ITS FALLBACK RATHER THAN IMPORTING ONE, and that is deliberate: the default lives in
 * `plannerData.DEFAULT_FILTERS`, which is a React/IPC module this node-tested file must not pull in
 * at runtime. Passing it keeps ONE copy of the default (the caller's) instead of a second spelling
 * of "proc leads" drifting quietly out of step with it.
 *
 * `slot` IS THREE-VALUED and the `null` arm is load-bearing: `null` means "All slots", which is not
 * the absence of an answer but the answer most people want. A stored `null` therefore survives as
 * `null` rather than being read as "unparseable, use the default".
 */
export function sanitizeBrowseForm(raw: unknown, fallback: BrowseFormMemory): BrowseFormMemory {
  const o = asRecord(raw)
  if (o === null) return fallback
  return {
    socket: sanitizeOne<SocketType>(o.socket, SOCKETS, fallback.socket),
    slot: sanitizeSlot(o.slot, fallback.slot),
    trioOnly: sanitizeFlag(o.trioOnly, fallback.trioOnly)
  }
}

/**
 * THE ITEM NARROWING (JOS-210's picker), on the SESSION tier — and this is the one classification
 * in the whole table that is a judgement call rather than a reading of the rule, so it is argued
 * here rather than asserted.
 *
 * It is a PICK, which would make it structural; but the vocabulary is eleven thousand items and the
 * only way to reach one is to TYPE into the picker's search box, which makes the gesture a search.
 * The tie is broken by what the value IS: every other restart-tier field describes a SHAPE you gave
 * the corpus ("one-handers a Paladin can wear"), and this one names a single item you were looking
 * at. "What can go in this helm" is a question you finish, not a lens you keep — the same reason
 * the search boxes are session-scoped.
 *
 * A SESSION-TIER PICK ALSO CANNOT GO STALE, which is a real safety property rather than a
 * convenience: `slots` and `classes` here are a SNAPSHOT of what the corpus said, and `itemFits`
 * filters on them. Within one run the corpus cannot change (it is compiled-in bytes fetched once
 * per window), so the snapshot is exact. Across a restart a rescrape could have moved it, and the
 * narrowing would quietly answer for an item the DB no longer describes that way.
 */
export interface ItemFocusMemory {
  key: string
  name: string
  slots: EquipSlot[]
  classes: ClassAbbr[]
}

export function sanitizeItemFocus(raw: unknown): ItemFocusMemory | null {
  const o = asRecord(raw)
  if (o === null || typeof o.key !== 'string' || typeof o.name !== 'string') return null
  if (o.key === '' || o.name === '') return null
  return {
    key: o.key.slice(0, MAX_REMEMBERED_SEARCH),
    name: o.name.slice(0, MAX_REMEMBERED_SEARCH),
    // Both empties are legal and mean "unknown, which filters nothing" (plannerPreset.ItemFocus) —
    // so an unrecognised slot or class DROPS OUT and the narrowing widens, never errors.
    slots: sanitizeList<EquipSlot>(o.slots, EQUIP_SLOTS),
    classes: sanitizeList<ClassAbbr>(o.classes, CLASS_ABBRS)
  }
}

/**
 * WHICH EFFECT GROUPS ARE EXPANDED — the ticket's "expanded state if cheap", and it is cheap
 * exactly because it is on the session tier.
 *
 * There is no vocabulary to validate a group id against: the ids are derived from whatever axis is
 * in force (`plannerGroups`), so the only honest checks are "is it a string" and "how many". A
 * restart-tier version would have to defend against ids from a build that grouped differently;
 * within one session the axis and the corpus are the same ones that produced them, so a stored id
 * either matches a group on screen or is silently ignored by `browserRows`, which is already how an
 * expanded set behaves when the axis changes.
 */
export const MAX_REMEMBERED_GROUPS = 400

export function sanitizeOpenGroups(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const value of raw as unknown[]) {
    if (typeof value !== 'string' || value === '' || out.length >= MAX_REMEMBERED_GROUPS) continue
    if (!out.includes(value)) out.push(value)
  }
  return out
}
