// gear/gearPrefs.ts — WHAT THE USER CHOSE about the Gear tab's shape, and how a stored choice
// degrades (JOS-297).
//
// TWO CHOICES, ONE SHAPE. Which numeric COLUMNS the table draws, and which FILTER CONTROLS the
// toolbar shows. Both are machine-class view preferences — they say how you like to READ the
// corpus, not anything about your character — so both live in raw `localStorage` under `eq.gear.*`
// and neither ever crosses IPC. (They shared that namespace with the sets pane's own two keys,
// `eq.gear.set` / `eq.gear.setsOpen`, until JOS-325 retired the pane; nothing reads those now.)
//
// ABSENT IS NOT EMPTY, and every function here exists to keep those two apart. `null` means the
// user has never expressed a preference, so the app's own default answers: the derived column seed
// (`gearColumns.visibleColumns`), and the full toolbar. An ARRAY — including `[]` — is a statement,
// and it wins outright. Folding the two together is the bug this file is shaped to prevent: it
// would make "I want no stat columns" unexpressible and would silently re-derive columns under
// somebody who had removed them.
//
// A STORED VALUE DEGRADES, IT NEVER ERRORS (JOS-105). Storage is a string somebody else's build
// wrote: it can be truncated JSON, an object, a key this version dropped, or the same key twice.
// The sanitizers take `unknown`, drop what they do not recognise and preserve the order of what
// they do — so a vocabulary change is a shrinking list rather than a blank tab.
//
// AND A HIDDEN CONTROL MAY NEVER BE FILTERING. `inertFilters` is the other half of a configurable
// toolbar and the half that is easy to skip: hiding "Current era" while it is ON would leave 3,000
// rows held back by a control that is not on screen to explain it, which is the exact failure the
// JOS-67 law names (a filter that can hide everything must be able to admit it). So a control that
// is hidden has its field forced to its INERT value — not its DEFAULT value, which for era is ON.
// The user's own value survives in state, so re-showing the control brings it back unchanged.
//
// PURE AND NODE-TESTABLE (relative value imports, the house law) — `tests/gearColumnPrefs.test.mts`
// drives every branch without a DOM, a React tree or a `localStorage`.

import { PICKABLE_COLUMNS, gearColumnIds } from './gearColumns'
import { sanitizeFlag } from './areaMemory'
import { DEFAULT_GEAR_FILTERS, type GearFilters, type GearSortKey } from './gearFilter'

// ---- the column choice ---------------------------------------------------------------------

const PICKABLE: ReadonlySet<string> = new Set<string>(PICKABLE_COLUMNS)

/**
 * A stored column choice, or `null` when there is none to read. Unknown keys and repeats are
 * dropped; the surviving order is the one that was stored, because the user's column order is
 * something they can see.
 */
export function sanitizeColumns(raw: unknown): GearSortKey[] | null {
  if (!Array.isArray(raw)) return null
  const out: GearSortKey[] = []
  for (const value of raw) {
    if (typeof value !== 'string' || !PICKABLE.has(value)) continue
    const key = value as GearSortKey
    if (!out.includes(key)) out.push(key)
  }
  return out
}

/**
 * Add or remove one key, ALWAYS IN VOCABULARY ORDER. Clicking a checkbox is saying "show me this
 * stat", never "and put it here" — an order that followed click history would re-arrange the table
 * under the eye every time somebody added a column, and there is no second gesture (a drag) that
 * would let them fix it. `base` is what the checkboxes were showing, which is the derived seed
 * while nothing is chosen — so the first click PROMOTES the seed to an explicit list.
 */
export function toggleColumn(base: readonly GearSortKey[], key: GearSortKey): GearSortKey[] {
  const on = new Set<string>(base)
  if (on.has(key)) on.delete(key)
  else on.add(key)
  return PICKABLE_COLUMNS.filter((k) => on.has(k))
}

// ---- the column widths (user ask, 2026-08-15: *resize and have the sizes stick*) -----------

/** The drag clamp: narrower than 48 has no legible content, wider than 1200 is a typo. */
export const GEAR_WIDTH_MIN = 48
export const GEAR_WIDTH_MAX = 1200

/** The ONE spelling of a legal column width — the drag, the double-click fit and the sanitizer all
 *  answer through it, so the three paths cannot round or bound differently. */
export function clampGearWidth(value: number): number {
  return Math.round(Math.min(GEAR_WIDTH_MAX, Math.max(GEAR_WIDTH_MIN, value)))
}

/**
 * The user's dragged column widths in px, keyed by column id — the identity columns and `owned` by
 * their fixed names, every numeric column by its `GearSortKey`. ABSENT (null) means never resized,
 * and the automatic layout (`gearTableLayout`) answers; PRESENT switches the whole table to stated
 * pixels, because a hand-set width beside percentage columns would reflow under every pane resize —
 * the opposite of "stick".
 */
export type GearColumnWidths = Record<string, number>

// The identity-column ids, DERIVED from the roster (`gearColumnIds` with no numeric columns and
// every flag on) rather than restated — a column added to the table is accepted here by construction.
const FIXED_WIDTH_IDS: ReadonlySet<string> = new Set(gearColumnIds([], true, true))

/**
 * A stored width map, or `null` when nothing usable is stored. Unknown ids drop (a column this
 * build no longer draws is not an error), non-numbers drop, and every survivor is clamped — a
 * corrupted store degrades to the automatic layout rather than to a broken table (JOS-105).
 */
export function sanitizeWidths(raw: unknown): GearColumnWidths | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const out: GearColumnWidths = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    if (!FIXED_WIDTH_IDS.has(key) && !PICKABLE.has(key)) continue
    out[key] = clampGearWidth(value)
  }
  return Object.keys(out).length === 0 ? null : out
}

// ---- the drop columns choice ---------------------------------------------------------------

/**
 * Are the Zone / Level / Mob columns drawn (user ask, 2026-08-15: *make zone/level/mob an optional
 * toggle*)? ON unless a stored `false` says otherwise — the columns shipped on, and an unreadable
 * store must come back ON (`sanitizeFlag`'s fallback, the same degradation `eraOnly` states). One
 * flag for the trio: they are one answer ("where does it drop"), and three toggles would invite a
 * mob column with no zone to anchor it.
 */
export function sanitizeDropCols(raw: unknown): boolean {
  return sanitizeFlag(raw, true)
}

// ---- the toolbar choice --------------------------------------------------------------------

/**
 * The filter bar's configurable controls, in the order the bar draws them: the WHICH ITEMS row
 * first, then the WHAT THEY READ row (GearFilterBar states that split).
 *
 * SEARCH IS NOT IN THE LIST, on purpose. Search is the tab's default surface (the owner's ruling
 * that shaped phase 3) — it is the one control that is not a narrowing of the corpus but the way
 * into it, and a Gear tab you cannot type into is not a configuration anyone meant to reach.
 */
// `shield` was a control for two hours on 2026-08-15 and is NOT legacy vocabulary: it shipped in a
// test build only, and the user ruled it into the Weapon type dropdown (`GearWeaponPick`) before a
// release carried the toggle. `haste` (same day) draws on the identity row, after the Owned chip.
export const GEAR_CONTROLS = ['slot', 'weapon', 'effect', 'classes', 'era', 'owned', 'haste', 'upgrade'] as const

export type GearControl = (typeof GEAR_CONTROLS)[number]

/** The picker's words for each control — the control's own label, so the list reads as the bar does. */
export const GEAR_CONTROL_LABEL: Record<GearControl, string> = {
  slot: 'Slots',
  weapon: 'Weapon type',
  effect: 'Effect',
  classes: 'Classes',
  era: 'Current era',
  owned: 'Owned or looted',
  upgrade: 'Upgrade state',
  haste: 'Ignore haste'
}

const CONTROLS: ReadonlySet<string> = new Set<string>(GEAR_CONTROLS)

/**
 * EVERY CONTROL A BARE-ARRAY CHOICE COULD HAVE BEEN CHOOSING FROM — the JOS-297 vocabulary, kept
 * verbatim after JOS-302 changed it. This list is HISTORY and must never be "tidied up".
 *
 * It exists because of a bug the owner reported on 2026-08-13 and a fix that was not what the
 * report asked for. The ask was *ALL filter controls on the equipment tab are ENABLED by default*,
 * on the belief that the picker "derives a default subset". IT DOES NOT, and never did:
 * `controlsVisible(null)` has always returned the whole of `GEAR_CONTROLS`, so a user who has never
 * touched the picker has always had every control. The DEFAULT was never the problem.
 *
 * THE ACTUAL DEFECT IS THAT A STORED CHOICE CANNOT SPEAK FOR A CONTROL THAT DID NOT EXIST YET.
 * The choice is stored as the list of controls to SHOW, so it is a closed statement about a
 * vocabulary frozen at the moment it was written. JOS-302 then changed that vocabulary: it deleted
 * `classOnly`, `ratio` and `thresholds` and ADDED `weapon`. Anyone who had used the picker before
 * JOS-302 — which includes the owner — therefore has a stored list that cannot contain `weapon`,
 * and no amount of re-reading it will ever draw the Weapon type picker for them. It is not hidden
 * because they hid it; it is hidden because they were never asked.
 *
 * SO THE RULE IS: A CONTROL THE USER NEVER HAD THE CHANCE TO RULE ON IS ON. That is the owner's
 * ruling, applied to the mechanism that was actually broken, and it satisfies both halves of it at
 * once — every control draws unless the user explicitly hid it, and a user with a stored choice
 * keeps the hides they actually made.
 */
export const LEGACY_GEAR_CONTROLS: readonly string[] = [
  'slot',
  'effect',
  'classes',
  'classOnly',
  'era',
  'owned',
  'upgrade',
  'ratio',
  'thresholds'
  // `weapon` is not here and neither is `haste` (added 2026-08-15), for the same reason: a control
  // that did not exist when a legacy bare-array choice was written is a control that choice never
  // ruled on, so `resolveChoice` must turn it ON — which it does exactly BECAUSE it is absent here.
]

/**
 * A stored toolbar choice as `{shown, vocab}` — what the user picked, and what they picked it FROM.
 *
 * The second field is the whole fix (see `LEGACY_GEAR_CONTROLS`): recording the vocabulary is what
 * lets a later build tell "they hid this" apart from "this did not exist yet". `useGearPrefs`
 * writes this shape; a bare array is the pre-2026-08-13 spelling and still reads.
 */
export interface StoredControlChoice {
  shown: readonly string[]
  vocab: readonly string[]
}

/** The stored list, dropping unknown keys and repeats and preserving the stored order. */
function knownControls(raw: unknown): GearControl[] {
  if (!Array.isArray(raw)) return []
  const out: GearControl[] = []
  for (const value of raw as unknown[]) {
    if (typeof value !== 'string' || !CONTROLS.has(value)) continue
    const key = value as GearControl
    if (!out.includes(key)) out.push(key)
  }
  return out
}

/**
 * A stored toolbar choice, RESOLVED AGAINST TODAY'S VOCABULARY, or `null` when there is none.
 *
 * The return type is unchanged — the effective list of controls to draw — so `controlsVisible`,
 * `toggleControl`, the picker and the view are all untouched by this. What changed is what the
 * list MEANS on the way out: it is the user's own picks PLUS every control that has been added
 * since they made them, in the bar's own order.
 *
 * A BARE ARRAY IS THE LEGACY SPELLING and is read against `LEGACY_GEAR_CONTROLS`, which is why the
 * Weapon type picker comes back for everybody who chose before JOS-302. The `{shown, vocab}` shape
 * needs no such guess, and the moment anybody touches the picker their key is rewritten into it —
 * so this migration heals itself and the next control the bar grows is on for everyone by
 * construction rather than by anybody remembering this file.
 *
 * `[]` IS STILL A STATEMENT (the header's absent-is-not-empty law): a NEW-shape choice with an
 * empty `shown` and today's vocabulary resolves to an empty toolbar, exactly as it always did.
 */
export function sanitizeControls(raw: unknown): GearControl[] | null {
  if (Array.isArray(raw)) return resolveChoice(knownControls(raw), LEGACY_GEAR_CONTROLS)
  if (typeof raw !== 'object' || raw === null) return null
  const stored = raw as Partial<StoredControlChoice>
  if (!Array.isArray(stored.shown)) return null
  const vocab = Array.isArray(stored.vocab) ? stored.vocab.filter((v): v is string => typeof v === 'string') : []
  return resolveChoice(knownControls(stored.shown), vocab)
}

/** The picks, plus everything today's bar offers that the chooser was never shown. */
function resolveChoice(shown: readonly GearControl[], vocab: readonly string[]): GearControl[] {
  const on = new Set<string>(shown)
  for (const control of GEAR_CONTROLS) if (!vocab.includes(control)) on.add(control)
  return GEAR_CONTROLS.filter((c) => on.has(c))
}

/**
 * Which controls the bar draws: the user's resolved list, or ALL OF THEM when they have not said.
 *
 * The `?? GEAR_CONTROLS` arm is the "enabled by default" the owner asked for and has been here
 * since JOS-297; `sanitizeControls` above is where the ruling actually bit.
 */
export function controlsVisible(chosen: readonly GearControl[] | null): ReadonlySet<GearControl> {
  return new Set<GearControl>(chosen ?? GEAR_CONTROLS)
}

/** Add or remove one control, in the bar's own order — `toggleColumn`'s argument, same reason. */
export function toggleControl(base: readonly GearControl[], key: GearControl): GearControl[] {
  const on = new Set<string>(base)
  if (on.has(key)) on.delete(key)
  else on.add(key)
  return GEAR_CONTROLS.filter((k) => on.has(k))
}

/**
 * THE FILTERS AS A HIDDEN TOOLBAR LEAVES THEM: every field whose control is off screen forced to
 * the value that does not filter. See the header on why this is inert-not-default, and on why the
 * caller keeps its own unforced copy.
 *
 * `classes` GOING EMPTY IS THE LOAD-BEARING ONE NOW (JOS-302). The class list narrows the corpus on
 * this surface, and the view fills it from DETECTION rather than from a click — so a hidden Classes
 * control would otherwise hold rows back on the strength of an inference the user never made and
 * cannot see. Empty is the only honest value for a picker that is not on screen.
 */
export function inertFilters(filters: GearFilters, visible: ReadonlySet<GearControl>): GearFilters {
  const d = DEFAULT_GEAR_FILTERS
  return {
    ...filters,
    slots: visible.has('slot') ? filters.slots : d.slots,
    weaponTypes: visible.has('weapon') ? filters.weaponTypes : d.weaponTypes,
    effect: visible.has('effect') ? filters.effect : d.effect,
    classes: visible.has('classes') ? filters.classes : [],
    // NOT `d.eraOnly` — that is `true`. Inert is the value that hides nothing.
    eraOnly: visible.has('era') ? filters.eraOnly : false,
    ownedOnly: visible.has('owned') ? filters.ownedOnly : false,
    // Inert = haste COUNTS: the score's default reading, and the one that drops no term silently.
    ignoreHaste: visible.has('haste') ? filters.ignoreHaste : false
  }
}
