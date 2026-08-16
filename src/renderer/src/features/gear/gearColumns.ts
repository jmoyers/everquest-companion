// gear/gearColumns.ts — WHICH numeric columns the table draws, and how wide they are.
//
// THE PROBLEM THIS SOLVES. `GEAR_STAT_KEYS` is 32 keys wide and the ticket asks to sort by ANY of
// them, regens and backstab included. Thirty-two columns is not a table anyone can read, so the
// column list is DERIVED: a small always-on core, plus a column for whatever the table is sorted
// by. Sort by `BACKSTAB` and the backstab column appears; sort by something else and it goes.
//
// THE DERIVATION USED TO HAVE A SECOND SOURCE — every stat a THRESHOLD was filtering on — and
// JOS-302 removed it with the thresholds themselves (owner ruling 2026-08-13: sorting services that
// need without spending toolbar real estate). What is left is the honest remainder of the same
// sentence: a stat you are RANKING by is a stat you are looking at, so it gets a column. That is a
// derivation of at most ONE column now, which is why there is no cap on it any more — the old
// `MAX_DERIVED_COLUMNS` capped a list that could grow with every chip typed, and a list that can
// never exceed core+1 caps itself.
//
// AND SINCE JOS-297 THE DERIVATION IS THE SEED, NOT THE ANSWER (owner feedback on the shipped
// tab: *ALL stats should be there*). The derivation was a bet that asking about a stat is the only
// way anyone says they want to see it, and the bet was wrong: a player comparing two breastplates
// wants the seven attributes on screen without inventing seven thresholds to conjure them. So the
// picker offers the WHOLE vocabulary (`PICKABLE_COLUMNS` — every `GearStatKey`, plus the DERIVED
// `RATIO` and, since JOS-336, `EFF_HP`) and
// an explicit choice WINS; absent a choice the derivation still runs, which is what keeps the tab's
// first screen what it was. The distinction the storage layer has to preserve is therefore ABSENT
// vs EMPTY: no stored key means "derive", a stored `[]` means "the user asked for no numeric
// columns at all", and the two must never fold together. THE PICKER IS ALSO WHERE A THRESHOLD'S
// OTHER JOB WENT: you name the column you want and then you sort it.
//
// EVERY DRAWN NUMERIC COLUMN IS SORTABLE, and that has always been true of the machinery
// (`sortGearRows` takes any `GearSortKey`) — the gap the owner hit was EXPOSURE: a key with no
// column had no header to click. The picker closes it by construction, so there is no second list
// of "sortable keys" here to drift from the drawn ones.
//
// WIDTHS: PERCENTAGES WHILE THEY FIT, PIXELS WHEN THEY DO NOT — and both halves are JOS-260's law
// rather than a preference. The table is `tableLayout: fixed` (a windowed table whose columns
// re-measure per slice moves its row heights under a hook whose every index assumes they cannot —
// LootTables.tsx states the full argument). Under percentages the numeric columns SHARE a fixed
// budget: N columns each take `NUMERIC_BUDGET / N`, the identity columns take a constant, and the
// NAME column states no width at all so it absorbs the slack. Each share is CLAMPED both ways —
// a CEILING (`MAX_NUMERIC_WIDTH`) because a stat cell holds at most `-12345` and handing four
// columns 13% apiece starves the one column that actually ellipsises, the item name; and a FLOOR
// (`MIN_NUMERIC_WIDTH`), which is what used to cap the derived count — past ten numeric
// columns a percentage can only be bought by making every column illegible, because percentages
// cannot make a fixed table wider than its box. So past ten the layout switches to STATED PIXELS
// plus a `minWidth` on the table: the table becomes wider than the pane and the pane, which is
// already `overflow: auto`, scrolls it SIDEWAYS INSIDE ITSELF. The page never scrolls sideways —
// that is the whole point of the switch, and `tests/e2e/gearColumnSteps.mts` measures both.
//
// PURE AND NODE-TESTABLE (relative value imports, the house law): this file decides the shape of
// the table, so `tests/gearFilter.test.mts` can assert that a sort key brings its column with it
// and `tests/gearColumnPrefs.test.mts` that a chosen set of thirty overflows on purpose.

import { GEAR_PERCENT_STAT_KEYS, GEAR_STAT_KEYS, isGearStatKey, type GearStatKey } from '../../../../shared/planner/gear'
import type { GearSort, GearSortKey } from './gearFilter'

/**
 * The columns that are always there: armour, the two pools every class reads, and the weapon
 * ratio. Ratio earns its permanent place because it is the one number the plus-state selector
 * MOVES for a reason that is not obvious (DELAY never scales — phase 0), and watching it move is
 * half of what the selector is for.
 */
export const CORE_COLUMNS: readonly GearSortKey[] = ['AC', 'HP', 'MP', 'RATIO']

/**
 * THE MOST THE DERIVATION CAN ADD: one column, for the stat being sorted by (and zero when that is
 * already a core column, or the item name).
 *
 * IT IS A CONSTANT RATHER THAN A CAP NOW (JOS-302). It used to be `MAX_DERIVED_COLUMNS = 6`, a real
 * ceiling on a list that grew with every stat threshold typed — past six the extra thresholds still
 * filtered, they just stopped drawing columns. With the thresholds gone the only derived source is
 * the sort key, so the list cannot exceed core+1 and there is nothing left to cap. The number stays
 * exported because the width law below is stated against it, and because it is what makes
 * `MAX_PERCENT_COLUMNS` a fact about the derivation rather than a coincidence.
 */
export const MAX_DERIVED_COLUMNS = 1

/**
 * Percent of the table the numeric columns share between them.
 *
 * RE-BUDGETED 2026-08-15, when the three drop columns joined the identity set, and the arithmetic
 * is the whole story: every stated width below plus this budget must leave the ITEM column — the
 * one column that states NO width and absorbs the slack — a legible share. It was 52 when the
 * identity columns cost 24% + 15% owned (leaving the name ≥ 9%); with zone/level/mob the identity
 * set costs 44% + 13%, so 28 is what keeps the worst percent-mode case at 85% and the name at 15%.
 * OVERFLOWING THIS SUM DOES NOT SCROLL — `tableLayout: fixed` squeezes the unstated column to
 * ZERO, which deletes the item name, its click-through and the wish control from the screen (found
 * the hard way, 2026-08-15). The percentage-fit test in gearColumnPrefs.test.mts now sums every
 * stated column so it cannot happen quietly again.
 */
const NUMERIC_BUDGET = 26
/** …and the floor one column may shrink to, which is what caps the derived count above. */
const MIN_NUMERIC_WIDTH = 5
/**
 * …and the CEILING one column may grow to. A numeric cell holds at most `-12345` or `41%`; every
 * point of budget a small set does not need belongs to the item name, the only column whose
 * content actually runs out of room. The number is bounded from BELOW by the header, not the
 * cell: a sortable header is its label plus the arrow (~60px for `Ratio`), and a label wider
 * than its sticky cell slides under the NEXT header, which then eats the click aimed at it —
 * measured in gear.e2e.mts at 6.5%. 8% of the narrowest pane the 900px window minimum can
 * produce clears that with the tightened numeric padding GearTable pairs with this ceiling.
 */
const MAX_NUMERIC_WIDTH = 8

/**
 * The widest numeric set percentages can still serve at that floor — FIVE since 2026-08-15, when
 * the drop columns shrank the numeric budget (see it, above).
 *
 * It is exactly the core plus `MAX_DERIVED_COLUMNS` again, the way it was before JOS-302 — so
 * nothing the tab can DERIVE ever crosses into pixel mode, and the untouched default keeps its
 * percentage layout. A PICKED set of six or more crosses the line and the table scrolls sideways
 * inside its own pane, which is the design absorbing a wide choice rather than starving the item
 * column to pay for it.
 */
export const MAX_PERCENT_COLUMNS = Math.floor(NUMERIC_BUDGET / MIN_NUMERIC_WIDTH)

/**
 * The pixel widths the table states once percentages cannot serve the set. Each is a legible
 * minimum rather than a taste: a numeric cell holds at most `-12345` or `41%`, an identity cell
 * holds a name that ellipsises. Their SUM is what makes the table wider than the pane, which is
 * what makes the pane scroll it.
 */
const PX = { name: 280, wish: 90, slot: 110, classes: 100, zone: 130, zoneLevel: 90, mob: 180, numeric: 78, owned: 150 } as const

/**
 * The numeric cells' shared padding — the other half of `MAX_NUMERIC_WIDTH`'s bargain above. The
 * ceiling only holds if a sortable header (label + arrow, ~60px for `Ratio`) fits the cell it
 * states: a label wider than its sticky cell slides under the NEXT header, which then intercepts
 * the click aimed at it — gear.e2e.mts measured exactly that. MUI's default 16px a side spends
 * 32px of a ~60px cell on air; 8px keeps the header its own. It lives HERE, the layout-constants
 * module, because the header (GearTableHead) and the body cells (GearTable) must state ONE padding
 * or the columns shear — neither component may own the number the other must match.
 */
export const NUMERIC_PAD = { px: 1 } as const

/**
 * EVERY COLUMN THE TABLE DRAWS, IN DRAW ORDER — the one statement of the roster, so the header's
 * render order, the body's colspan, the pixel-mode width sum and the width sanitizer's allowlist
 * cannot drift apart (the same quiet-drift class the `NUMERIC_BUDGET` re-budget was bitten by).
 * The identity trio's presence follows the same two flags the layout reads.
 */
export function gearColumnIds(columns: readonly GearColumn[], showDrops: boolean, hasOwned: boolean): string[] {
  return [
    'name',
    'wish',
    'slot',
    'classes',
    ...(showDrops ? ['zone', 'zoneLevel', 'mob'] : []),
    ...columns.map((c) => c.key),
    ...(hasOwned ? ['owned'] : [])
  ]
}

/** The wish column (2026-08-15): the control left the Item cell so the name keeps its room. 6% is
 *  what keeps the compact "Remove" clickable at the 900px window minimum — a button clipped past
 *  its cell edge hit-tests as the NEIGHBOUR cell (caught by gearCompareSteps' reachability pass). */
export const WISH_COLUMN_WIDTH = '6%'
export const SLOT_COLUMN_WIDTH = '11%'
export const CLASS_COLUMN_WIDTH = '9%'
export const ZONE_COLUMN_WIDTH = '7%'
export const ZONE_LEVEL_COLUMN_WIDTH = '5%'
export const MOB_COLUMN_WIDTH = '9%'

/**
 * THE OWNERSHIP COLUMN (JOS-285, phase 4) — appended AFTER `visibleColumns`' numerics, and only
 * when the character has a dump to answer from.
 *
 * IT IS ONE COLUMN, not three. "Do you own it", "where" and "at what +N" are one sentence about
 * one item (`ownedCellText`: `Equipped · Bank +2`), and splitting them into three columns would
 * put three blank cells on every one of the ~6,700 rows a player does not own. It is also NOT a
 * `GearColumn`: those keys are `GearSortKey`s and every one of them is a number the plus-state
 * scaler moves. Ownership is text off a live file, so it lives beside the numeric list rather than
 * inside it — which is exactly why it needs no entry in the shared numeric budget below.
 *
 * NOTHING TO ANSWER FROM ⇒ NO COLUMN. On a machine with no dump AND no loot history, an empty
 * ownership cell would be indistinguishable from "you do not own this" — and the app cannot tell
 * the difference either. So the column is absent and the `/outputfile` freshness line beside the
 * count says why (GearView). Either witness alone is enough to draw it.
 */
export const OWNED_COLUMN_WIDTH = '11%'

export interface GearColumn {
  key: GearSortKey
  /** the header's words — `SV MAGIC`, `HP REGEN`, `Ratio` */
  label: string
  /** rendered with a trailing `%` (HASTE, and the census says only HASTE) */
  percent: boolean
}

const PERCENT_KEYS: ReadonlySet<string> = new Set<string>(GEAR_PERCENT_STAT_KEYS)

/**
 * `HP_REGEN` → `HP REGEN`, `RATIO` → `Ratio`. The underscore is a key's spelling, not a word.
 *
 * `EFF_HP` DELIBERATELY HAS NO ARM OF ITS OWN (JOS-336): the underscore rule already spells it
 * `EFF HP`, which is the label the ticket asked for and the same shouted-abbreviation voice
 * `SV MAGIC` and `HP REGEN` already speak. Adding a special case to produce a string the default
 * already produces would be a second place to keep the same word. Six characters also clears the
 * `MAX_NUMERIC_WIDTH` ceiling by a wide margin — it is shorter than the ten-character `SV DISEASE`
 * this table has drawn since JOS-297, and the 8% ceiling was measured against a header that fits.
 */
export function columnLabel(key: GearSortKey): string {
  if (key === 'RATIO') return 'Ratio'
  // `BEST`, not the key's own spelling (user ruling, 2026-08-15: *people won't know what BIS
  // means*). The KEY stays `BIS` so stored column choices and search tokens survive the rename.
  if (key === 'BIS') return 'BEST'
  // `EFF_DMG` deliberately has no arm, the same argument as `EFF_HP` above: the underscore rule
  // already spells `EFF DMG`.
  if (key === 'name') return 'Item'
  return key.replace(/_/g, ' ')
}

function column(key: GearSortKey): GearColumn {
  return { key, label: columnLabel(key), percent: PERCENT_KEYS.has(key) }
}

/**
 * EVERY KEY THE PICKER OFFERS, in the corpus's own order with each DERIVED key standing beside the
 * numbers it is made of. Thirty-four: the thirty-two indexed stats — the seven attributes, the
 * pools, the regens, Attack, Haste, the ten saves, the weapon block and weight — plus the derived
 * ratio (after DELAY, the second of its two inputs) and the derived effective HP (after HP, likewise
 * the second of its two — STA leads the attribute run and HP closes the gap to the pools, so `EFF HP`
 * lands directly under both halves of its own sum). `name` is NOT in it: the item column is not
 * optional, it is what a row IS.
 *
 * PLACEMENT IS THE ONLY DOCUMENTATION A CHECKBOX LIST GETS. A picker is a flat column of labels with
 * no room to explain that `EFF HP` is not a stat the wiki prints, so sitting it against `STA` and
 * `HP` is how a reader is told what it is made of — the same argument that put `Ratio` after `DELAY`
 * rather than at the end of the list, and the reason both toggles and both column orders follow
 * this array (`toggleColumn` filters through it).
 *
 * DERIVED FROM `GEAR_STAT_KEYS`, never re-typed. A rescrape that widens the vector widens the
 * picker in the same commit, which is the only way "all stats" can stay true.
 */
export const PICKABLE_COLUMNS: readonly GearSortKey[] = [
  ...GEAR_STAT_KEYS.flatMap<GearSortKey>((key) => {
    // EFF DMG stands after RATIO for the same placement-is-documentation reason RATIO stands after
    // DELAY: the ratio is its largest input, so the reader meets the score beside what it is made of.
    if (key === 'DELAY') return [key, 'RATIO', 'EFF_DMG']
    if (key === 'HP') return [key, 'EFF_HP']
    return [key]
  }),
  // BIS closes the list rather than standing anywhere inside it: it is the one key made of ALL of
  // the others, so there is no neighbour that documents it — last is the honest placement.
  'BIS'
]

/**
 * The numeric columns for this sort: the core, then the sort key if it is not already one of them.
 *
 * ORDER IS STABLE ON PURPOSE. The core never moves, so ranking by a new stat APPENDS a column
 * instead of re-arranging the four the eye has already learned; and a sort key that is already a
 * core column adds nothing at all, which is why `AC desc` (the default) draws exactly the core.
 *
 * IT TOOK `filters` UNTIL JOS-302, to read the stat thresholds. They are gone, and a parameter that
 * would now be ignored is worse than no parameter: it would invite the next reader to believe the
 * columns still follow the filter bar. `sortWithin` is the other half of the pairing and is
 * unchanged — removing the sorted column moves the lit header, whatever put the column there.
 *
 * THIS IS THE SEED THE PICKER STARTS FROM (JOS-297), and it still runs whenever no explicit choice
 * is stored — see `columnsFor`.
 */
export function visibleColumns(sort: GearSort): GearColumn[] {
  const keys: GearSortKey[] = [...CORE_COLUMNS]
  if (sort.key !== 'name' && !keys.includes(sort.key)) keys.push(sort.key)
  return keys.map(column)
}

/**
 * THE COLUMNS ON SCREEN. `null` means nothing has been chosen, so the derivation above answers;
 * anything else — INCLUDING an empty array — is the user's own list and wins outright.
 *
 * An explicit list is NOT re-seeded with the core or with the sort key. That is the whole meaning
 * of "explicit": a player who removed AC removed AC, and an app that quietly put it back whenever
 * something mentioned it would be arguing with a checkbox it drew itself. (`sortWithin` handles the
 * consequence — a sort on a column the user removed falls to one that is drawn.)
 */
export function columnsFor(chosen: readonly GearSortKey[] | null, sort: GearSort): GearColumn[] {
  return chosen === null ? visibleColumns(sort) : chosen.map(column)
}

/**
 * THE SORT, CONFINED TO WHAT IS ON SCREEN. Removing the column you were sorting by must not leave
 * the table ordered by an invisible number with no lit header to explain it — so the sort falls to
 * the first remaining column, or to the item name when the user asked for no numeric columns.
 *
 * IDENTITY-PRESERVING when the sort is already on a drawn column, so the memo chain downstream
 * re-runs when the sort MOVES and never merely because it rendered.
 */
export function sortWithin(sort: GearSort, columns: readonly GearColumn[]): GearSort {
  if (sort.key === 'name' || columns.some((c) => c.key === sort.key)) return sort
  const first = columns[0]
  return first === undefined ? { key: 'name', dir: 'asc' } : { key: first.key, dir: 'desc' }
}

/**
 * The pixel a column measures when the user resizes with nothing stored for it (user ask,
 * 2026-08-15) — the same `PX` table pixel mode states, so the first drag starts from a familiar
 * shape. Numeric columns share one default; identity columns each state their own.
 */
export function defaultColumnPx(id: string): number {
  // The `PX` table answers by key — an identity column states its own width, every numeric column
  // (whose id is its `GearSortKey`, never a `PX` key) shares one. Indexing the table instead of
  // enumerating its keys again is what keeps this and `PX` one statement.
  return id in PX ? PX[id as keyof typeof PX] : PX.numeric
}

/** One numeric column's width, as the percentage string the header cell states. */
export function numericWidth(count: number): string {
  const each = count > 0 ? NUMERIC_BUDGET / count : NUMERIC_BUDGET
  const clamped = Math.min(MAX_NUMERIC_WIDTH, Math.max(MIN_NUMERIC_WIDTH, each))
  return `${String(Math.round(clamped * 10) / 10)}%`
}

/**
 * WHAT EVERY COLUMN STATES AS ITS WIDTH, and whether the table has a floor of its own.
 *
 * `minWidth` is 0 in percentage mode — the table IS the pane, and nothing can overflow it. Past
 * `MAX_PERCENT_COLUMNS` it is the summed pixel width, which the table states as a MINIMUM (never a
 * width): a pane wider than the set still fills, a pane narrower than it scrolls horizontally
 * INSIDE its own box. `tableLayout: fixed` and the fixed row height are untouched by either mode —
 * the windowing hook's contract does not know widths exist.
 */
export interface GearTableLayout {
  mode: 'percent' | 'pixel'
  /** the table's own floor in px, or 0 when percentages are doing the work */
  minWidth: number
  /** `undefined` in percentage mode: the item column takes whatever the stated ones leave */
  name: string | undefined
  wish: string
  slot: string
  classes: string
  zone: string
  zoneLevel: string
  mob: string
  numeric: string
  owned: string
}

export function gearTableLayout(count: number, hasOwned: boolean, hasDrops = true): GearTableLayout {
  if (count <= MAX_PERCENT_COLUMNS) {
    return {
      mode: 'percent',
      minWidth: 0,
      name: undefined,
      wish: WISH_COLUMN_WIDTH,
      slot: SLOT_COLUMN_WIDTH,
      classes: CLASS_COLUMN_WIDTH,
      zone: ZONE_COLUMN_WIDTH,
      zoneLevel: ZONE_LEVEL_COLUMN_WIDTH,
      mob: MOB_COLUMN_WIDTH,
      numeric: numericWidth(count),
      owned: OWNED_COLUMN_WIDTH
    }
  }
  return {
    mode: 'pixel',
    minWidth:
      PX.name +
      PX.wish +
      PX.slot +
      PX.classes +
      (hasDrops ? PX.zone + PX.zoneLevel + PX.mob : 0) +
      count * PX.numeric +
      (hasOwned ? PX.owned : 0),
    name: `${String(PX.name)}px`,
    wish: `${String(PX.wish)}px`,
    slot: `${String(PX.slot)}px`,
    classes: `${String(PX.classes)}px`,
    zone: `${String(PX.zone)}px`,
    zoneLevel: `${String(PX.zoneLevel)}px`,
    mob: `${String(PX.mob)}px`,
    numeric: `${String(PX.numeric)}px`,
    owned: `${String(PX.owned)}px`
  }
}

/**
 * A cell's text. ABSENT RENDERS BLANK, never `0` and never a dash: the vector omits a key the item
 * never stated (law 1), and printing `0` would be this table inventing a stat line the wiki does
 * not have. A blank cell in a dense numeric grid reads as "states none", which is what it means.
 *
 * `EFF_HP` TAKES THE PLAIN-INTEGER DEFAULT ON PURPOSE (JOS-336) — no arm, no rounding, no unit. Both
 * of its inputs are `primary`-class stats whose scaled values are whole numbers by construction
 * (`scalePrimary` ends in a `Math.floor`), so their sum is a whole number too and a `toFixed` would
 * only add a decimal point nothing behind it can move. The two arms that DO exist are the two keys
 * whose values are not integers at all: a ratio is a quotient and a weight is stated to a tenth.
 */
export function statText(value: number | undefined, key: GearSortKey): string {
  if (value === undefined) return ''
  if (key === 'RATIO') return value.toFixed(2)
  if (key === 'EFF_DMG' || key === 'BIS') return value.toFixed(1)
  if (key === 'WEIGHT') return value.toFixed(1)
  if (PERCENT_KEYS.has(key)) return `${String(value)}%`
  return String(value)
}

/**
 * The stat keys a column list draws, for a caller that only needs the vector keys.
 *
 * EVERY DERIVED KEY DROPS OUT, and the compiler is what enforces it: `GearSortKey` carries `RATIO`
 * and `EFF_HP` alongside the vector's own keys, neither of them is a field of `GearStats`, and the
 * return type is `GearStatKey[]` — so a derived key added to the vocabulary without a line here
 * fails to typecheck rather than quietly asking the vector for a field it does not have.
 */
export function statKeysOf(columns: readonly GearColumn[]): GearStatKey[] {
  // `isGearStatKey` rather than an enumeration of the derived keys: a derived key added to the
  // vocabulary drops out here BY CONSTRUCTION instead of by somebody remembering this line.
  return columns.flatMap((c) => (isGearStatKey(c.key) ? [c.key] : []))
}
