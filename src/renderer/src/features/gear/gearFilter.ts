// gear/gearFilter.ts — THE GEAR TABLE'S MODEL: scale, then filter, then sort (JOS-284, phase 3).
//
// THE ORDER IS THE WHOLE DESIGN, and it is not negotiable. The global plus-state selector changes
// what every row IS — a weapon's ratio improves with every tier because DMG scales and DELAY does
// not (phase 0's rule, `gearScale.ts`'s header) — so a sort that ran on BASE numbers under a `+5`
// slider would be answering a question nobody asked. Everything below reads the SCALED vector:
//
//     scaleAll(rows, state) → filterGearRows(…) → sortGearRows(…)
//
// `scaleAll` is measured at ~18 ms for the whole 6,814-row index (tests/gearIndex.test.mts prints
// it every run), which is what lets the selector be a live slider rather than an Apply button.
//
// PURE AND NODE-TESTABLE (`tests/gearFilter.test.mts`), the plannerGroups/plannerClasses precedent:
// value imports are RELATIVE, nothing here touches React, storage, IPC or the corpus. The one rule
// this file does NOT own is the ERA verdict — that lives in `plannerData.eraHides`, which reaches
// the renderer's mob-catalog inversion and cannot be imported under the node runner. So it arrives
// as an injected predicate (`GearFilterDeps.eraHidden`) rather than being restated here, which is
// also what keeps the gear table and the exaltation browser from ever disagreeing about an era.
//
// ABSENT IS NOT ZERO, AND THE SORT IS WHERE THAT NOW LIVES. `GearStats` omits a key the item never
// stated (gear.ts, law 1), so a SORT puts absent LAST in both directions — ascending by haste must
// not rank six thousand plain items above the sixty-four that state one, and descending must not
// either. `gearRatio` is `undefined` for anything that is not a weapon, so a ratio sort never ranks
// 5,000 non-weapons at zero. `gearEffectiveHp` (JOS-336) obeys the same rule from the other side: a
// row stating NEITHER HP nor STA reads `undefined`, while a row stating just one reads that one —
// silence is not a zero, and a stated number is not silence.
//
// THE NUMERIC FILTER LEFT THIS FILE ONCE AND CAME BACK BY A DIFFERENT DOOR. JOS-302 (owner ruling
// 2026-08-13, fourth ask: *drop the min-ratio and stat-at-least filters completely - sorting
// services that need without spending toolbar real estate*) deleted the toolbar's stat-threshold
// chips and `minRatio` box outright. On 2026-08-15 the user asked to be able to FILTER BY ANY
// COLUMN, which partially overrules that — and the shape of the return honours what the ruling was
// actually about, which was TOOLBAR REAL ESTATE: thresholds now ride the search box as tokens
// (`ac>=20`, `str>5`, `ratio>=1`, `bis>40` — `parseGearQuery` below), so they cost no toolbar
// control at all. They read the SCALED vector through `sortValue`, the same derivation every cell
// and every sort reads, so "ratio>=1 at +5" means at +5. A word that is not a threshold token is
// search text exactly as before, and the two compose in one box. The threshold's OLD other job —
// conjuring the stat's column — stays with the columns picker (JOS-297, gearColumns.ts).
//
// THE STRUCTURED FILTERS ARE STILL CLOSED QUESTIONS ABOUT WHO A ROW IS — its name, its slots, its
// weapon kind, its classes, its effect kind, and (2026-08-15) whether it reads as a shield — plus
// the two injected verdicts (era, ownership). Every one of them is a set membership rather than a
// number; the numbers live in the search text.

import type { ClassAbbr } from '../../../../shared/classCombo'
import type { ItemUpgradeState } from '../../../../shared/itemUpgrade'
import { GEAR_STAT_KEYS, type GearRow, type GearStatKey } from '../../../../shared/planner/gear'
import {
  gearBisValue,
  gearEffectiveDamage,
  gearEffectiveHp,
  gearRatio,
  scaleGearRow,
  type GearDerivedOpts
} from '../../../../shared/planner/gearScale'
import { WEAPON_PICKS, normalizeSkillToken, weaponPicksMatch, type WeaponPick } from '../../../../shared/planner/weaponType'
import type { EquipSlot, SocketType } from '../../../../shared/planner/types'

// ---- the filter model ---------------------------------------------------------------------

/**
 * The effect filter, in the DONOR vocabulary (`SocketType`) plus the two answers a socket cannot
 * give. `any` does not filter; `has` is "states any effect line at all", which is the question a
 * player asks before they know which kind they want.
 */
export type EffectFilter = 'any' | 'has' | SocketType

/**
 * Everything the table filters on, combinable — every field is ANDed, and each is INERT at its
 * empty value (`''`, `[]`, `'any'`, `false`). That is what makes "a slot, and a weapon kind, and a
 * class combo, and an effect kind, and an era" one object rather than five modes.
 *
 * THE LIST-VALUED FIELDS ARE UNIONS INSIDE AND AN AND BETWEEN (JOS-302). `slots` and `weaponTypes`
 * each keep a row that matches ANY of their entries, and the two narrowings then AND with each
 * other and with everything else — "a PRIMARY or SECONDARY, that is a one-hander, that a Paladin
 * can wear" is one question, not three modes.
 */
export interface GearFilters {
  /**
   * The DEFERRED search text (the standing search law — the view owns the `useDeferredValue`).
   * Since 2026-08-15 it carries the numeric filter too: threshold tokens (`ac>=20`) are lifted out
   * by `parseGearQuery` and the rest matches the search key as it always did.
   */
  text: string
  /**
   * The equip slots asked for. `[]` = every slot; several = the UNION (JOS-302, the owner's second
   * ask: *multiple slots can be chosen at once, e.g. PRIMARY + SECONDARY*). A row occupies several
   * slots of its own, so the test is "do the two lists intersect", never "is this THE slot".
   */
  slots: EquipSlot[]
  /**
   * THE CLASS COMBO THE TABLE IS READING FOR — AND ON THIS SURFACE IT NARROWS THE CORPUS
   * (owner ruling 2026-08-13, JOS-302, verbatim: *gear that does not match the class filter is
   * tagged with an off-filter chip instead of being filtered out - obviously wrong, it should just
   * be removed*).
   *
   * That OVERRULES the V2 "a filter and never a rule" law FOR THE GEAR SEARCH TABLE, and only for
   * it. The rest of V2 stands and is untouched: the planner build pane still CHIPS a donor whose
   * class list has drifted out of the plan's trio (`PlannerChips.MismatchChip`, drawn by PlanCell
   * and FarmList), because there the row is work you already planned and removing it would delete
   * a decision. Here the row is a candidate you have not chosen yet, and a candidate your character
   * cannot equip is not a candidate.
   *
   * TWO EMPTIES ARE STILL UNKNOWNS, and neither is a mismatch (`classMismatch`): an empty filter
   * asks for no class filter at all, and a page that stated NO class list is KEPT — silence is not
   * a refusal (law 1).
   */
  classes: ClassAbbr[]
  /**
   * Weapon skills, the categories that union several of them (JOS-302, the owner's third ask), and
   * — since 2026-08-15, the user's ruling — `'shield'` as one more pick in the same dropdown: a
   * shield is a kind of held item, so it lives beside the weapon kinds rather than as its own
   * toggle. `[]` = every kind, non-weapons included; anything picked keeps only rows matching ANY
   * pick — the skill fold for weapon picks (`shared/planner/weaponType.ts`), `isShieldLike` for the
   * shield pick, ORed inside the one control exactly as the categories already union.
   */
  weaponTypes: GearWeaponPick[]
  effect: EffectFilter
  /** hide rows the era join places outside the current expansion */
  eraOnly: boolean
  /**
   * LEAVE WORN HASTE OUT OF THE DERIVED SCORES (user ruling, 2026-08-15): haste items do not stack
   * in this game, so for a player who already wears one, a second haste item's EFF DMG credit is a
   * lie. When true, `sortValue` computes EFF DMG and BIS with the HASTE term dropped — the HASTE
   * column itself still shows the stated number, because the item does state it (law 1).
   */
  ignoreHaste: boolean
  /**
   * THE OWNER'S CHECKBOX (JOS-285): keep only what this character owns or has looted.
   *
   * "Or looted" is not a softening — it is the second witness. The dump is one instant and the log
   * is a history, and an item you looted last week and put in a bag the dump does not cover is
   * still an item you have handled. `gearOwnership.ts` decides what qualifies (a wearable copy, an
   * exaltation made from one, or a loot line); this flag only says whether to apply it.
   */
  ownedOnly: boolean
}

export const DEFAULT_GEAR_FILTERS: GearFilters = {
  text: '',
  slots: [],
  // EMPTY, and it stays empty until something says otherwise — but note that the VIEW merges the
  // detected class combo into this field (`useGearClasses`), so an untouched Gear tab opens reading
  // for the character the app believes you are running. Since JOS-302 that is a NARROWING rather
  // than a decoration, which is why `GearView.emptyText` names the class picks when they are the
  // reason the table is empty, and why the picker's own chips sit in the toolbar saying so.
  classes: [],
  weaponTypes: [],
  effect: 'any',
  // ON by default — the same argument the exaltation browser's era toggle carries: more than half
  // the corpus drops in expansions this server has not opened, and a plan built on them is a wish
  // list. `plannerData.eraHides` is the one verdict; this flag only says whether to apply it.
  eraOnly: true,
  // OFF by default: the first haste item IS a real upgrade, so the score credits haste until the
  // player says they already have one.
  ignoreHaste: false,
  // OFF by default, and that is the search-first ruling again: the tab opens on the CORPUS, which
  // is the question a planner asks first ("what is out there"). "What do I already have" is the
  // second question and it is one click away.
  ownedOnly: false
}

/** The name spellings that read as a shield. A closed list, so a false positive is one word away. */
const SHIELD_WORDS = ['shield', 'buckler', 'aegis', 'targe', 'bulwark'] as const

/**
 * DOES THIS ROW READ AS A SHIELD? (user ask, 2026-08-15: *filter by shields specifically*.)
 *
 * The corpus states no item-type field, so the answer is a heuristic over what the page DOES state,
 * and it says so: a SECONDARY-slot item whose name speaks one of the shield words, or whose
 * `Skill:` line reads SHIELD. The slot gate is what keeps a "Shield of…" cloak or a held tome out;
 * the word list is what a miss or a false positive gets corrected in. ONE function, exported, so
 * the search word `gearData.toRow` folds into the haystack and the pure filter below can never
 * disagree about what a shield is. The skill read goes through `normalizeSkillToken` — the same
 * fold every other `Skill:` comparison uses — so editor residue on the page cannot slip past it.
 */
export function isShieldLike(row: Pick<GearRow, 'slots' | 'name' | 'skill'>): boolean {
  if (!row.slots.includes('SECONDARY')) return false
  const name = row.name.toLowerCase()
  if (SHIELD_WORDS.some((w) => name.includes(w))) return true
  return normalizeSkillToken(row.skill ?? '') === 'SHIELD'
}

/**
 * The Weapon type control's pick vocabulary ON THIS SURFACE: the shared weapon picks, plus
 * `'shield'` (user ruling, 2026-08-15 — a shield belongs in the held-kind dropdown, not its own
 * toggle). It is a GEAR type rather than a widening of `WeaponPick` because the shared fold cannot
 * answer it: a shield is read off the slot and the name (`isShieldLike`), not off a `Skill:` line —
 * the corpus states `SHIELD` as a skill on exactly ONE page (weaponType.ts's census, point 4).
 */
export type GearWeaponPick = WeaponPick | 'shield'

/**
 * The whole pick vocabulary, stated ONCE beside the type it enumerates: the dropdown's options
 * (GearFilterBar) and the sanitizer's allowlist (areaMemory) both read this list, so a future pick
 * cannot be offered by one and silently dropped on load by the other.
 */
export const GEAR_WEAPON_PICKS: readonly GearWeaponPick[] = [...WEAPON_PICKS, 'shield']

/** Does the row match ANY pick — the control's union, with the shield pick answered its own way. */
export function matchesHeldKind(row: GearRow, picks: readonly GearWeaponPick[]): boolean {
  if (picks.length === 0) return true
  const weapon = picks.filter((p): p is WeaponPick => p !== 'shield')
  if (weapon.length > 0 && weaponPicksMatch(row.skill, weapon)) return true
  return picks.includes('shield') && isShieldLike(row)
}

/** What the pure model cannot answer for itself — see the header. */
export interface GearFilterDeps {
  /** `plannerData.eraHides(row, true)`, injected. Default: nothing is ever hidden by era. */
  eraHidden?: (row: GearRow) => boolean
  /**
   * Does this character own or have they looted this row (`gearOwnership.ts`)? Injected for the
   * same reason `eraHidden` is: the answer comes from a live dump and the loot module, neither of
   * which a pure filter may reach.
   *
   * DEFAULT: NOTHING QUALIFIES — so a caller that turns `ownedOnly` on without supplying an
   * answer gets an EMPTY table rather than a filter that silently did nothing. An empty table is
   * visible and the view names the toggle responsible for it (the JOS-67 law); a no-op filter is
   * a control that lies about being on.
   */
  ownedOrLooted?: (row: GearRow) => boolean
}

// ---- the search text, parsed (the 2026-08-15 numeric-filter return — see the header) --------

export interface StatThreshold {
  key: GearSortKey
  op: '>=' | '<=' | '>' | '<' | '='
  value: number
}

/** The search box's text, split into its two jobs: words to match, and numbers to reach. */
export interface GearQuery {
  /** what is left after the threshold tokens are lifted out, matched as ONE substring as before */
  needle: string
  thresholds: StatThreshold[]
}

/**
 * Every spelling a threshold token may name a key by: the key itself and its underscore-free
 * fold (`sv_magic` and `svmagic`), case-insensitive, plus the derived keys — a threshold may ask
 * for a ratio, an effective HP, the damage score or the BIS score exactly as it asks for a stat.
 */
const THRESHOLD_KEYS: ReadonlyMap<string, GearSortKey> = new Map([
  ...(['RATIO', 'EFF_HP', 'EFF_DMG', 'BIS', ...GEAR_STAT_KEYS] as const).flatMap(
    (key): [string, GearSortKey][] => [
      [key.toLowerCase(), key],
      [key.toLowerCase().replace(/_/g, ''), key]
    ]
  ),
  // The column's DISPLAYED word (columnLabel spells `BIS` as `BEST` — user ruling, 2026-08-15), so
  // the token a reader types off the header they can see is a real spelling too.
  ['best', 'BIS']
])

/** `key op number`, NO SPACES — `ac>=20`, `str>5`, `weight<2.5`. The search hint states the shape. */
const THRESHOLD_TOKEN = /^([a-z_]+)(>=|<=|>|<|=)(-?\d+(?:\.\d+)?)$/

/**
 * Split the search text into words and thresholds. A token that LOOKS like a threshold but names
 * no known key stays a WORD — `foo>=3` searches for the string `foo>=3` rather than silently
 * filtering on nothing, so a typo shows an empty table with the typo visible in the box.
 */
export function parseGearQuery(text: string): GearQuery {
  const thresholds: StatThreshold[] = []
  const words: string[] = []
  for (const token of text.trim().toLowerCase().split(/\s+/)) {
    if (token === '') continue
    const m = THRESHOLD_TOKEN.exec(token)
    const key = m === null ? undefined : THRESHOLD_KEYS.get(m[1])
    if (m !== null && key !== undefined) {
      thresholds.push({ key, op: m[2] as StatThreshold['op'], value: Number(m[3]) })
    } else {
      words.push(token)
    }
  }
  return { needle: words.join(' '), thresholds }
}

// ONE-ENTRY CACHE, not a memo library: the filter asks the same question 6,814 times per keystroke
// and the text only changes between keystrokes. Pure in effect — same text, same answer. Exported
// for the view's per-render reads (the haste-chip gate), which want the cache for the same reason.
let lastQueryText: string | null = null
let lastQuery: GearQuery = { needle: '', thresholds: [] }
export function queryOf(text: string): GearQuery {
  if (text !== lastQueryText) {
    lastQueryText = text
    lastQuery = parseGearQuery(text)
  }
  return lastQuery
}

/**
 * Does the row's number reach the threshold? Reads `sortValue`, so a threshold on a derived key
 * and a threshold on a vector key are the same code path — and reads the SCALED vector, because
 * the pipeline filters after it scales. ABSENT FAILS EVERY OPERATOR, `<` included: an item that
 * states no HASTE line is not an item with less than 41% haste, it is an item that said nothing
 * (law 1), and a filter question about a number it never stated has no yes in it.
 */
function meetsThreshold(row: GearRow, t: StatThreshold, opts: GearDerivedOpts): boolean {
  const v = sortValue(row, t.key, opts)
  if (v === undefined) return false
  if (t.op === '>=') return v >= t.value
  if (t.op === '<=') return v <= t.value
  if (t.op === '>') return v > t.value
  if (t.op === '<') return v < t.value
  return v === t.value
}

// ONE-ENTRY CACHE, the `queryOf` shape: the filter asks per row, the inputs change per click. The
// IDENTITY is stable while the filters are, which is also what lets React trees depend on it.
let lastOptsHaste: boolean | null = null
let lastOptsClasses: readonly ClassAbbr[] | null = null
let lastOpts: GearDerivedOpts = {}

/** The derived-score knobs a filter object implies: the haste knob, and WHO is asking (the class
 *  picks — gearScale's BEST reads them so a casting stat nobody picked can use scores nothing). */
export function derivedOpts(filters: Pick<GearFilters, 'ignoreHaste' | 'classes'>): GearDerivedOpts {
  if (filters.ignoreHaste !== lastOptsHaste || filters.classes !== lastOptsClasses) {
    lastOptsHaste = filters.ignoreHaste
    lastOptsClasses = filters.classes
    lastOpts = {}
    if (filters.ignoreHaste) lastOpts.ignoreHaste = true
    if (filters.classes.length > 0) lastOpts.classes = filters.classes
  }
  return lastOpts
}

// ---- the predicates ------------------------------------------------------------------------

/**
 * R2's class half, three-valued — the SAME rule `plannerData.classFit` reads, restated here in the
 * one direction this table needs. Both empties are unknowns and neither is a mismatch: an empty
 * filter asks for no filter, and a page that stated no class list stayed silent (law 1).
 *
 * SINCE JOS-302 THIS IS WHAT REMOVES A ROW rather than what chips one — see `GearFilters.classes`.
 * The three-valued shape is unchanged and is the reason the change is safe to make: the only rows
 * it can remove are rows that STATED a class list and stated one that excludes every class asked
 * for. A page the wiki left silent about is never removed by a guess.
 */
export function classMismatch(rowClasses: readonly ClassAbbr[], filter: readonly ClassAbbr[]): boolean {
  if (rowClasses.length === 0 || filter.length === 0) return false
  return !rowClasses.some((c) => filter.includes(c))
}

/**
 * Does this row sit in ANY of the slots asked for? Empty asks for no slot filter (JOS-302).
 *
 * Two lists meet here — the slots the item can occupy and the slots the player asked about — so the
 * question is an intersection, and a two-handed sword that the corpus places in PRIMARY answers
 * "PRIMARY or SECONDARY" the same way a dagger does.
 */
export function slotMatches(row: GearRow, slots: readonly EquipSlot[]): boolean {
  if (slots.length === 0) return true
  return slots.some((s) => row.slots.includes(s))
}

/** Does this row state an effect of the kind asked for? */
export function effectMatches(row: GearRow, effect: EffectFilter): boolean {
  if (effect === 'any') return true
  if (effect === 'has') return row.effects.length > 0
  return row.effects.some((e) => e.socket === effect)
}

/**
 * WHO THIS ROW IS — the local half of the filter: the search words, the thresholds those words
 * carried (2026-08-15 — see the header), the slots, the kind of weapon, the class combo and the
 * effect kind.
 *
 * Everything ANDs, and everything is inert while empty — see `GearFilters`. Two are UNIONS inside
 * (slots, weapon types), which is the JOS-302 shape: several answers to one question, ANDed against
 * the answers to the others.
 *
 * THE THRESHOLDS ARE THE ONE PART THAT READS THE SCALED VECTOR — the pipeline scales before it
 * filters, so `ratio>=1` under a +5 slider keeps the weapons that reach 1.0 AT +5, which is the
 * question the token exists to ask. The word half still never reads a number.
 */
function matchesIdentity(row: GearRow, filters: GearFilters): boolean {
  const query = queryOf(filters.text)
  if (query.needle !== '' && !row.searchKey.includes(query.needle)) return false
  const opts = derivedOpts(filters)
  if (!query.thresholds.every((t) => meetsThreshold(row, t, opts))) return false
  if (!slotMatches(row, filters.slots)) return false
  if (!matchesHeldKind(row, filters.weaponTypes)) return false
  if (!effectMatches(row, filters.effect)) return false
  return !classMismatch(row.classes, filters.classes)
}

/**
 * The whole filter for one row — the local predicates above, ANDed, and the two injected verdicts.
 *
 * The two injected ones are LAST on purpose: both reach data outside this module (the mob-catalog
 * inversion, a parsed dump), and a row rejected by a cheap local predicate never pays for them.
 */
export function matchesGear(row: GearRow, filters: GearFilters, deps: GearFilterDeps = {}): boolean {
  if (!matchesIdentity(row, filters)) return false
  if (filters.ownedOnly && !(deps.ownedOrLooted?.(row) ?? false)) return false
  return !(filters.eraOnly && (deps.eraHidden?.(row) ?? false))
}

/** The filtered rows, in the input's order — SORTING is the next stage's job, never this one's. */
export function filterGearRows<T extends GearRow>(
  rows: readonly T[],
  filters: GearFilters,
  deps: GearFilterDeps = {}
): T[] {
  return rows.filter((r) => matchesGear(r, filters, deps))
}

// ---- the sort ------------------------------------------------------------------------------

/**
 * Any numeric column, plus the DERIVED ones. `RATIO` is `gearRatio` (never a second opinion on
 * DMG/DELAY), `EFF_HP` is `gearEffectiveHp` (JOS-336 — raw HP plus raw STA, likewise never a second
 * opinion), and `name` is the only non-numeric axis.
 *
 * A DERIVED KEY IS NOT A VECTOR KEY, and the union says so: `GearStats` has no `EFF_HP` field and
 * never will. Nothing indexes it, nothing scales it, and nothing stores it — it is computed from the
 * vector at the moment somebody asks, which is exactly why the plus-state moves it for free.
 */
export type GearSortKey = 'name' | 'RATIO' | 'EFF_HP' | 'EFF_DMG' | 'BIS' | GearStatKey

export interface GearSort {
  key: GearSortKey
  dir: 'asc' | 'desc'
}

/** The table opens on the highest AC — a ranking, so the first screen says something. */
export const DEFAULT_GEAR_SORT: GearSort = { key: 'AC', dir: 'desc' }

/**
 * The number a sort reads, or `undefined` when the row states none (which sorts LAST, both ways).
 *
 * THE DERIVED ARMS COME FIRST AND EACH DELEGATES. `gearRatio` and `gearEffectiveHp` both live in
 * `shared/planner/gearScale.ts` beside the scaler, so the cell the table DRAWS and the number the
 * sort RANKS by are one function call rather than two agreeing implementations — which is the
 * property that lets `GearTable` render every column with `statText(sortValue(row, key), key)` and
 * never learn that two of the keys are not vector fields.
 */
export function sortValue(row: GearRow, key: GearSortKey, opts: GearDerivedOpts = {}): number | undefined {
  if (key === 'name') return undefined
  if (key === 'RATIO') return gearRatio(row.stats)
  if (key === 'EFF_HP') return gearEffectiveHp(row.stats)
  if (key === 'EFF_DMG') return gearEffectiveDamage(row.stats, opts)
  if (key === 'BIS') return gearBisValue(row.stats, opts)
  return row.stats[key]
}

/**
 * Does this key READ the derived-score knobs — is it one of the two arms above that take `opts`?
 * Exported so the view's "is anything on screen reading the scores" question (the Ignore-haste
 * chip's honest-hide gate) states the set HERE, beside the dispatch that makes it true, instead of
 * restating the two keys as literals a third arm would silently miss.
 */
export function readsDerivedOpts(key: GearSortKey): boolean {
  return key === 'EFF_DMG' || key === 'BIS'
}

/**
 * A new, sorted array — never a mutation of the caller's, because the filtered array is a memo
 * another render still holds.
 *
 * NAME IS THE TIEBREAK EVERYWHERE, so the order is TOTAL: four hundred rows sharing `AC 20` would
 * otherwise re-shuffle on every re-sort (`Array.prototype.sort` is stable, but the array reaching
 * it is a fresh filter each time), and a windowed list whose rows swap under the scrollbar is the
 * bug that looks like a rendering fault.
 *
 * THE VALUE IS COMPUTED ONCE PER ROW, NEVER PER COMPARISON. A vector key is a field read, but the
 * derived keys are not: BIS walks the whole stat vector (gearScale.ts), and a comparator that
 * called it n·log n times paid ~25 evaluations per row per keystroke on the 6,814-row corpus.
 * Decorating first makes every key one evaluation per row, and the comparator a number compare.
 */
export function sortGearRows<T extends GearRow>(rows: readonly T[], sort: GearSort, opts: GearDerivedOpts = {}): T[] {
  const sign = sort.dir === 'asc' ? 1 : -1
  if (sort.key === 'name') return [...rows].sort((a, b) => sign * a.name.localeCompare(b.name))
  const decorated = rows.map((row) => ({ row, value: sortValue(row, sort.key, opts) }))
  decorated.sort(({ row: a, value: av }, { row: b, value: bv }) => {
    if (av === undefined || bv === undefined) {
      if (av === bv) return a.name.localeCompare(b.name)
      return av === undefined ? 1 : -1
    }
    return av === bv ? a.name.localeCompare(b.name) : sign * (av - bv)
  })
  return decorated.map(({ row }) => row)
}

// ---- the plus-state stage -------------------------------------------------------------------

/**
 * Every row at `state`, as a PURE MAP — `scaleGearRow`'s own answer, kept in the caller's row type
 * so a renderer row that carries extra fields (the widened `searchKey`, and the ownership join
 * phase 4 will hang off `row.key`) survives the scaling.
 *
 * The base rows are never mutated: the next slider position starts from the same numbers, which is
 * what makes dragging the selector reversible rather than cumulative.
 */
export function scaleAll<T extends GearRow>(rows: readonly T[], state: ItemUpgradeState): T[] {
  return rows.map((r) => ({ ...r, stats: scaleGearRow(r, state).stats }))
}

/**
 * The three stages composed, for callers that want the answer in one call (the unit test, and any
 * future consumer that is not a React tree). THE VIEW DOES NOT USE THIS: it runs the stages in
 * separate memos so a keystroke re-filters without re-scaling 6,814 rows, and a header click
 * re-sorts without re-filtering them.
 */
export function gearTableRows<T extends GearRow>(
  rows: readonly T[],
  state: ItemUpgradeState,
  opts: { filters: GearFilters; sort?: GearSort; deps?: GearFilterDeps }
): T[] {
  const scaled = scaleAll(rows, state)
  return sortGearRows(filterGearRows(scaled, opts.filters, opts.deps), opts.sort ?? DEFAULT_GEAR_SORT, derivedOpts(opts.filters))
}
