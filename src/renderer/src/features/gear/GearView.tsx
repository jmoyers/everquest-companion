// gear/GearView.tsx — THE GEAR TAB (JOS-284, phase 3 of the gear planner).
//
// WHAT IT IS. A searchable, sortable, filterable table over the whole candidate index — 6,766
// equippable items, every one of them described in numbers (`GearRow`, phase 2). SEARCH IS THE
// WHOLE SURFACE (owner ruling, JOS-325): no plan and no selection is needed to use it. You open
// the tab and you are looking at the corpus.
//
// THE PIPELINE IS THREE MEMOS, IN THIS ORDER, AND THE ORDER IS THE FEATURE:
//
//     scaleAll(rows, plusState)  →  filterGearRows(…)  →  sortGearRows(…)
//
// The global plus-state selector changes what every row IS, so filtering and sorting run on the
// SCALED numbers — ask for "ratio at least 1.0" under a +5 slider and you get the weapons that
// reach 1.0 AT +5, which is the question the control exists to ask. Splitting it into three memos
// is what keeps each keystroke cheap: a search keystroke re-runs the filter and the sort but never
// re-scales 6,766 rows, and a header click re-runs only the sort.
//
// TWO DEFERRALS, ONE LAW. The search box echoes instantly and the FILTER runs on
// `useDeferredValue(text)` — the standing search law, with the lowercase key precomputed once in
// `gearData.toRow`. The plus-state slider obeys the SAME law for the same reason, and the state is
// deferred as a STRING (`"2:3"`) rather than as the `{full, fraction}` object: `useDeferredValue`
// compares by identity, so deferring a fresh object every render would defer nothing at all, and
// deferring the two numbers separately could tear into a combination neither slider was ever in.
// One primitive, parsed back on the other side.
//
// THE LIST IS WINDOWED AND THE BOX IS BOUNDED. `useWindowedRows` keeps the mounted DOM at about a
// screenful whether the filter matches 12 rows or 6,766, and the table lives inside its own
// fixed-height scroller so a growing list never grows the page (the standing UI law).
//
// AND SINCE JOS-285 (phase 4) IT SAYS WHAT YOU ALREADY HAVE. The ownership join hangs off exactly
// the seam phase 3 left — `row.key` is `itemKey(name)` is `ownershipKey` — so the OWNED column is
// one map lookup per rendered row and the "Owned or looted" filter is one injected predicate,
// beside the era one. Two things are deliberately NOT restated here: the dump's age (the
// `/outputfile` freshness line owns both instants — JOS-253/268) and the keyring exclusion (the
// fold owns the roster; this tab only reports what the fold left out of the player's own file).
//
// THE SETS ARE GONE, AND SEARCH IS NOW THE WHOLE TAB (JOS-325, owner ruling 2026-08-13). JOS-286
// hung a second document off this view — named virtual loadouts in a pane beside the table, a `+`
// on every row to fill them, a totals block, a diff against the body. It is all removed: the pane,
// the chip that opened it, the per-row `+` and the `onAssign` plumbing that carried it into
// `GearTable`. ACQUISITION PLANNING IS THE WISH LIST'S JOB NOW (JOS-326), one tab over in the same
// gear area, and this view answers exactly one question again — what is out there, and what of it
// do I already have.
//
// NOTHING ABOVE THIS PARAGRAPH CHANGED FOR IT, and that is the shape of the removal rather than a
// happy accident: the sets were additive from the day they shipped (the tab always mounted with no
// set, no plan and no selection), so taking them out is a deletion and never a rewrite. The three
// memos, both deferrals, the windowing, the columns picker, the controls picker, the era/owned/
// class/slot/weapon filters and the global plus-state slider are byte-for-byte the surface JOS-302
// and JOS-297 left. THE STORED SETS ARE UNTOUCHED TOO — `ProgressState.gearSets` is retired from
// the UI and kept on disk (progressState.ts holds the ruling); this view simply no longer asks for
// it.
//
// AND SINCE JOS-297 YOU CHOOSE WHAT IS ON SCREEN — the columns and the filter controls both, each
// remembered in `localStorage` (`useGearPrefs`). The two choices meet the pipeline above at two
// different points, and which point is the whole design:
//
//   * the CONTROLS choice meets it FIRST. `inertFilters` forces every hidden control's field to the
//     value that does not filter, BEFORE the filter memo sees it — so a control that is not on
//     screen cannot be holding rows back, and the empty state can never name a toggle nobody can
//     find. The user's own value is kept in `own` and comes back untouched when the control does.
//   * the COLUMNS choice meets it LAST, at `columnsFor`, which draws either the user's list or the
//     derived seed. It changes what is DISPLAYED and nothing that is computed — the same rows, in
//     the same order, at the same plus-state.
//
// The plus-state is the one control on both sides of that line: hiding it does not merely remove a
// slider, it puts the corpus back at base, because a simulation nobody can see or cancel is a quiet
// lie. THAT CLAUSE USED TO END "…the quiet lie `useUpgradeState` refuses to persist for exactly the
// same reason", and the second half of it is retired: JOS-329's owner ruling persists the slider.
// The clamp above is untouched and is now the whole of that defence — a plus-state you cannot see
// is put back to base, and a plus-state you CAN see says what it is (`gearData.useUpgradeState`
// carries the overruled law and the argument that answers it).
//
// AND SINCE JOS-329 NOTHING ON THIS TAB IS LOST TO A TAB SWITCH (owner report 2026-08-13: *we're
// losing everything right now*). A view unmounts on every switch, and until this ticket only the
// two JOS-297 chips were written down — the filters, the search box, the class pin, the sort and
// the slider were all `useState`, so a glance at the Loot tab reset the whole form. All five go
// through `useAreaMemory` now, on the tier `areaMemory.AREA_FORM_TIER` assigns them: the structural
// picks survive a restart, the search box lasts the session. THE PIPELINE ABOVE DID NOT CHANGE FOR
// IT — the three memos, both deferrals and both JOS-297 meeting points are byte-for-byte what they
// were, because where a field is STORED is not a question the filter model has ever asked.
//
// AND SINCE JOS-335 A SEARCH ROW CAN BE WANTED. The sentence three paragraphs up — "ACQUISITION
// PLANNING IS THE WISH LIST'S JOB NOW" — was true and only half wired: the Exaltations donor rows
// could write a wish (JOS-326) and the 6,766 rows of this table could not, so the tab that IS the
// item corpus was the one surface with no way to say "I want that". The gesture is per row and the
// door is the one every other writer uses (`useWishlist` → `addWish` → the same character-scoped
// document), so there is no second model, no second dedupe and nothing here that knows how a wish
// is stored. The pipeline above is untouched again: a wish is not a filter, so the three memos
// never see it — `wished` is read straight off the loaded document and joined to the rows in the
// TABLE, by `row.key`, which is `itemKey(name)`, which is `WishEntry.itemKey` (phase 3's seam, for
// the third time).
//
// AND SINCE JOS-343 THE GESTURE GOES BOTH WAYS, AND IT IS THE EXALTATIONS CONTROL (owner ruling
// 2026-08-13, one day after JOS-335 shipped a heart). The row's control is the donor row's — the
// same component, `features/wishlist/WishToggle.tsx` — and a second click on a row already on the
// list REMOVES the wish through `useWishlist.remove`, the Wish list tab's own deletion. Everything
// the paragraph above says is still true; what changed is that this table now writes the document
// in both directions instead of one, and `useGearWishes` is where both doors are.
//
// AND SINCE JOS-338 A ROW SAYS WHAT IT WOULD REPLACE. Phase 4 taught the table whether you OWN a
// candidate; hovering one now opens a card with the item's numbers, what is in each CELL that item
// would occupy (`useGearCompare`, over the `plannerInventory` seam — gearData.ts argues the choice),
// and how old the dump making that claim is. It is outside the three-memo pipeline for the same
// reason the wish list is: what you are wearing is not a filter. The JOS-143 law the table has
// carried since it shipped is narrowed rather than broken, and GearTable.tsx's header states how.
//
// MOUNTED HERE, AND WHAT MAKES THAT SAFE IS THE HOOK RATHER THAN THE ROUTER (JOS-346). This used
// to read: the three tabs are siblings, App renders one view at a time, so two `useWishlist` mounts
// never coexist and the remount is what re-reads a wish removed on another tab. The premise held
// and the promise did not — a per-mount copy made the refresh depend on view lifecycle and on a
// fire-and-forget write beating the next view's read. `useWishlist` holds ONE document for the
// window now, so this table's controls are reading the same object the Wish list tab edits, and
// they were correct before this view was ever rebuilt.
//
// AND SINCE JOS-302 THE FIRST TOOLBAR ROW NARROWS HARDER, in three ways the pipeline above did not
// change one line for. The CLASS picks remove rows instead of chipping them (the owner's ruling —
// gearFilter.ts `GearFilters.classes` holds the argument, GearTable.tsx holds the deleted chip's
// tombstone); the SLOT picker is a multi-select whose picks UNION; and a WEAPON TYPE picker joins
// it, unioning over the nine skills the corpus states plus the three categories that span them.
// All three are ordinary fields of `GearFilters`, so they AND with era, owned, effect, ratio and
// the thresholds exactly as everything else does — the only thing this file had to learn is that a
// third filter can now be the reason the table is empty (`emptyText`, and the pass that counts it).

import { type JSX, useCallback, useDeferredValue, useMemo, useRef } from 'react'
import { Box, Chip, Stack, Typography } from '@mui/material'
import { ITEM_UPGRADE_BASE, type ItemUpgradeState } from '@shared/itemUpgrade'
import OutputKindLine from '../../components/OutputKindLine'
import { useWindowedRows } from '../../lib/useWindowedRows'
import GearFilterBar from './GearFilterBar'
import GearPicker from './GearPickers'
import GearTable, { ROW_HEIGHT } from './GearTable'
import { useWishlist } from '../wishlist/useWishlist'
import { wishFromGear } from '../wishlist/wishSearch'
import { useGearPrefs, type GearPrefs } from './useGearPrefs'
import { sanitizeGearForm, sanitizeGearSort, type GearFormMemory } from './areaMemory'
import { useRemembered, useRememberedSearch } from './useAreaMemory'
import {
  GEAR_CONTROLS,
  GEAR_CONTROL_LABEL,
  controlsVisible,
  inertFilters,
  toggleColumn,
  toggleControl
} from './gearPrefs'
import { PICKABLE_COLUMNS, columnLabel, columnsFor, sortWithin, type GearColumn } from './gearColumns'
import {
  useEraHidden,
  type GearViewRow,
  useGearClasses,
  useGearCompare,
  useGearIndex,
  useGearOwnership,
  useOwnedOrLooted,
  useUpgradeState
} from './gearData'
import { uncountedNote, type GearOwnershipMap } from './gearOwnership'
import {
  DEFAULT_GEAR_FILTERS,
  derivedOpts,
  filterGearRows,
  queryOf,
  readsDerivedOpts,
  scaleAll,
  sortGearRows,
  type GearFilterDeps,
  type GearFilters,
  type GearSort,
  type GearSortKey
} from './gearFilter'

/** The plus-state as one primitive, so `useDeferredValue` has something it can actually compare. */
function stateKey(state: ItemUpgradeState): string {
  return `${String(state.full)}:${String(state.fraction)}`
}

function parseStateKey(key: string): ItemUpgradeState {
  const [full, fraction] = key.split(':')
  return { full: Number(full), fraction: Number(fraction) }
}

/** Flip the direction when the same column is clicked again; a new column opens on its natural end. */
function nextSort(sort: GearSort, key: GearSortKey): GearSort {
  if (sort.key === key) return { key, dir: sort.dir === 'desc' ? 'asc' : 'desc' }
  // Names read A→Z; every number reads best-first, which for WEIGHT and DELAY is still "most" —
  // this table states what an item HAS, and inverting two columns' defaults would be a preference
  // the user can express in one click anyway.
  return { key, dir: key === 'name' ? 'asc' : 'desc' }
}

interface TableState {
  rows: GearViewRow[]
  columns: GearColumn[]
  /**
   * The sort actually in force — the requested one, unless the column it names is no longer drawn
   * (`sortWithin`). The table reads THIS so the lit header and the row order can never disagree.
   */
  sort: GearSort
  /** how many rows the era filter alone is holding back — only computed when the table is EMPTY */
  hiddenByEra: number
  /** …and the same question for the Owned toggle, which can hide 6,693 of 6,766 rows in one click */
  hiddenByOwned: number
  /** …and for the class picks, which since JOS-302 REMOVE rows instead of chipping them */
  hiddenByClasses: number
}

/**
 * The three stages, as three memos (see the header). Split out of the component so the view stays
 * inside the function-length ceiling and so the ORDER is readable in one place.
 *
 * THE COLUMNS ARE RESOLVED BEFORE THE SORT IS, and never the other way round: the derived seed
 * reads the REQUESTED sort key (asking for a ranking is asking to see the number), and the sort is
 * then confined to what came out. Reversing them would be a cycle.
 */
function useTableRows(
  rows: readonly GearViewRow[],
  state: ItemUpgradeState,
  filters: GearFilters,
  opts: { sort: GearSort; deps: GearFilterDeps; chosen: GearSortKey[] | null }
): TableState {
  const { sort, deps, chosen } = opts
  const scaled = useMemo(() => scaleAll(rows, state), [rows, state])
  const filtered = useMemo(() => filterGearRows(scaled, filters, deps), [scaled, filters, deps])
  const columns = useMemo(() => columnsFor(chosen, sort), [chosen, sort])
  const inForce = useMemo(() => sortWithin(sort, columns), [sort, columns])
  // `derivedOpts` returns one of two constants, so this memo moves only when the flag actually flips.
  const sorted = useMemo(() => sortGearRows(filtered, inForce, derivedOpts(filters)), [filtered, inForce, filters])
  // WHY THE LIST IS EMPTY, when it is (the JOS-67 law: a filter that can hide everything must be
  // able to admit it). THREE filters can do it without the user having chosen them in the moment:
  // the era one, which is on by DEFAULT rather than by choice; the Owned one, which is one click
  // and removes 99% of the corpus by design; and — since JOS-302 — the CLASS picks, which the view
  // fills from DETECTION and which now remove rows rather than chipping them. The slot and weapon
  // pickers are deliberately NOT in this list: both are empty until somebody picks, and both wear
  // their picks as chips in the toolbar, so an empty table under them already explains itself.
  // Each costs one extra pass, and only at the moment there is nothing else to draw.
  const hidden = useMemo(() => {
    if (sorted.length > 0) return { hiddenByEra: 0, hiddenByOwned: 0, hiddenByClasses: 0 }
    const count = (over: Partial<GearFilters>): number => filterGearRows(scaled, { ...filters, ...over }, deps).length
    return {
      hiddenByEra: filters.eraOnly ? count({ eraOnly: false }) : 0,
      hiddenByOwned: filters.ownedOnly ? count({ ownedOnly: false }) : 0,
      hiddenByClasses: filters.classes.length > 0 ? count({ classes: [] }) : 0
    }
  }, [sorted.length, scaled, filters, deps])
  return { rows: sorted, columns, sort: inForce, ...hidden }
}

/**
 * The one sentence an empty table says, naming the filter responsible when there is one.
 *
 * OWNED IS NAMED FIRST when several are holding rows back, because it is the one the user just
 * clicked — and because it is the one whose effect is total rather than partial. THE CLASS LINE IS
 * LAST for the opposite reason (JOS-302): the class picks are usually the app's own detection
 * rather than a click, so naming them first would explain an empty table with something the user
 * did not do while a toggle they DID flip sits unmentioned. Same voice as the other two: the count
 * that would come back, and the control that is holding it.
 */
function emptyText(ready: boolean, refused: boolean, table: TableState): string {
  if (refused) return 'This build cannot read the gear index it was served - it states a newer version.'
  if (!ready) return 'Reading the item database…'
  if (table.hiddenByOwned > 0) {
    return `Nothing here is owned or looted - ${String(table.hiddenByOwned)} items match the other filters. Ownership is read from your newest /outputfile inventory dump plus this character's loot history.`
  }
  if (table.hiddenByEra > 0) {
    return `No gear matches these filters - but ${String(table.hiddenByEra)} items are hidden by the Current era toggle above.`
  }
  if (table.hiddenByClasses > 0) {
    return `No gear matches these filters - but ${String(table.hiddenByClasses)} items match once the Classes picker is cleared. An item whose page states no class list is never hidden by it.`
  }
  return 'No gear matches these filters.'
}

/**
 * The Owned header's own explanation: the two rules a reader of that column has to know, plus the
 * uncounted-keyring note when the player's dump actually has rows in one (`uncountedNote` — the
 * exclusion is stated over THEIR file, not as a fact about EverQuest).
 */
function ownedHint(map: GearOwnershipMap | null, uncounted: string | null): string {
  if (map === null) return ''
  const base =
    'Where your newest /outputfile inventory dump names a copy, and at what +N. Each +N is its own copy, never a total. Looted means the log saw it and the dump names none.'
  return uncounted === null ? base : `${base} ${uncounted}`
}

/**
 * THE TWO PICKERS (JOS-297), on the count line — GearPickers.tsx states why they live here rather
 * than in the toolbar they configure.
 *
 * The columns picker's FALLBACK is the derived seed as it stands right now, so opening it while
 * nothing is chosen shows exactly the columns on screen ticked, and the first click promotes that
 * list rather than replacing it.
 */
function ShapePickers({ prefs, columns }: { prefs: GearPrefs; columns: readonly GearColumn[] }): JSX.Element {
  const seed = useMemo(() => columns.map((c) => c.key), [columns])
  return (
    <>
      <GearPicker
        label="Columns"
        testId="gear-columns"
        hint="Which stat columns the table draws. Every one of them sorts."
        options={PICKABLE_COLUMNS}
        optionLabel={columnLabel}
        chosen={prefs.columns}
        fallback={seed}
        resetLabel="Follow the filters and the sort"
        toggle={toggleColumn}
        onChange={prefs.setColumns}
      />
      <GearPicker
        label="Filters"
        testId="gear-filters"
        hint="Which filter controls the toolbar shows. A hidden control stops filtering."
        options={GEAR_CONTROLS}
        optionLabel={(c) => GEAR_CONTROL_LABEL[c]}
        chosen={prefs.controls}
        fallback={GEAR_CONTROLS}
        resetLabel="Show every filter"
        toggle={toggleControl}
        onChange={prefs.setControls}
      />
      {/* The Zone / Level / Mob trio's switch (user ask, 2026-08-15) — beside the other two shape
          chips because it is a shape choice too: it narrows nothing, it only draws or does not. */}
      <Chip
        size="small"
        label="Drop columns"
        data-testid="gear-drops-toggle"
        title="Show where each item drops - the Zone, Level and Mob columns. The item's own page (click its name) always has the full story."
        color={prefs.dropCols ? 'primary' : 'default'}
        variant={prefs.dropCols ? 'filled' : 'outlined'}
        onClick={() => prefs.setDropCols(!prefs.dropCols)}
        sx={{ flexShrink: 0 }}
      />
    </>
  )
}

/**
 * THE LINE UNDER THE TOOLBAR: how much of the index is on screen, when the data is from, when the
 * dump was, and the two chips that are NOT filters — columns and controls.
 *
 * IT USED TO CARRY A THIRD (JOS-286's Sets toggle, with the loadout count on it), and JOS-325
 * removed it with the surface it opened. The reason the other two belong here is unchanged: both
 * toolbar rows are `nowrap` and full, and neither of these narrows the corpus.
 */
function CountLine({
  counts,
  scrapedAt,
  ownership,
  prefs,
  columns
}: {
  counts: { shown: number; total: number }
  scrapedAt: string | null
  ownership: { readAt: number | null }
  prefs: GearPrefs
  columns: readonly GearColumn[]
}): JSX.Element {
  return (
    <Stack direction="row" spacing={1} alignItems="baseline" sx={{ mb: 0.5, flexShrink: 0 }}>
      <Typography variant="caption" color="text.secondary" data-testid="gear-count">
        {counts.shown.toLocaleString()} of {counts.total.toLocaleString()} items
      </Typography>
      {/* WHEN the data is from, never when the index was built — the corpus's own `scrapedAt`. */}
      {scrapedAt !== null && (
        <Typography variant="caption" color="text.secondary">
          · wiki data from {scrapedAt.slice(0, 10)}
        </Typography>
      )}
      {/* THE DUMP'S AGE, SAID ONCE, BY THE THING THAT OWNS IT (JOS-253/268). The Owned column rests
          on a file the player rewrites, and "when did they write it" / "when did we read it" is
          exactly what this line answers — so nothing in this feature restates an age, and the
          looted-not-in-dump wording points here instead of guessing. `loadedAt` is THIS window's
          own read instant, which is the fact the prop is documented to want. */}
      <OutputKindLine kind="inventory" quiet loadedAt={ownership.readAt} testId="gear-dump-line" />

      <ShapePickers prefs={prefs} columns={columns} />
    </Stack>
  )
}

/**
 * THE WISH JOIN (JOS-335, made a toggle by JOS-343), and every half of it is one line because the
 * seam was already there.
 *
 * `wished` is keyed on `WishEntry.itemKey`, which is `row.key`; the ADD half builds the entry
 * through `wishFromGear` — the SAME builder the wish list's own add control uses for a gear hit
 * (wishSearch.ts) — so a wish written from this table and one written from that popover are the
 * same bytes, `source: 'user'` included.
 *
 * AND THE REMOVE HALF IS `wishlist.remove`, WHICH IS NOT A SECOND DELETION (owner ruling
 * 2026-08-13). It is the identical call `WishlistView` hands its per-row remove button — one
 * `removeWish` fold over the character's document, one IPC write, one shape. A row that came off
 * here is off there the moment that tab is opened, for the reason the header states: the tabs are
 * siblings, so entering one re-reads the store.
 *
 * THE HANDLER TAKES THE ROW'S DRAWN STATE rather than consulting `wished`, and that is what keeps
 * it a STABLE callback: `add` and `remove` are stable, `wished` is a fresh Set on every edit, and a
 * handler depending on the set would re-render the whole mounted screenful on every click.
 *
 * IT IS UNDEFINED UNTIL THE DOCUMENT HAS LOADED, which is the absent-not-disabled rule arriving at
 * its one real case here (`GearTableProps.onToggleWish` argues it): before `ready` the empty list is
 * a default rather than an answer, and a control drawn unadded over an item that IS wished would be
 * the app contradicting its own store — and now it would also offer the wrong ACTION.
 *
 * A HOOK RATHER THAN FIVE LINES IN THE VIEW, for the ordinary reason: the component is at the
 * measured 100-code-line function ceiling and this is a self-contained join with one output.
 */
function useGearWishes(): {
  wished: ReadonlySet<string>
  onToggleWish?: (row: GearViewRow, wished: boolean) => void
} {
  const wishlist = useWishlist()
  const entries = wishlist.list.entries
  const wished = useMemo(() => new Set(entries.map((e) => e.itemKey)), [entries])
  const { add, remove } = wishlist
  const onToggleWish = useCallback(
    (row: GearViewRow, wasWished: boolean) => {
      if (wasWished) remove(row.key)
      else add(wishFromGear(row, Date.now()))
    },
    [add, remove]
  )
  return { wished, onToggleWish: wishlist.ready ? onToggleWish : undefined }
}

/**
 * Is anything on screen reading the derived scores? Drawn columns, or a search threshold naming
 * one — the token half is what keeps hiding the chip honest (GearFilterBarProps.hasteRelevant).
 * WHICH keys read the knobs is `gearFilter.readsDerivedOpts`'s to say, beside the dispatch that
 * makes it true — a third opts-reading key added there is counted here without a second edit. The
 * text goes through `queryOf`'s cache, so the per-render call never re-parses an unchanged query
 * (the view renders on every scroll tick).
 */
function readsDerivedScores(columns: readonly GearColumn[], text: string): boolean {
  return columns.some((c) => readsDerivedOpts(c.key)) || queryOf(text).thresholds.some((t) => readsDerivedOpts(t.key))
}

export interface GearViewProps {
  /**
   * Deep-link an item name into the Loot tab's drill-down (App's `openLoot`) — where the ItemWindow
   * already draws the per-item tier block. That is the per-item half of the upgrade sim: the table
   * answers "what does the whole corpus read at +N", the drill answers "and what about this one".
   */
  onOpenLoot?: (item: string) => void
}

export default function GearView({ onOpenLoot }: GearViewProps = {}): JSX.Element {
  const { rows, ready, refused, scrapedAt } = useGearIndex()
  const classes = useGearClasses()
  const upgrade = useUpgradeState()
  const ownership = useGearOwnership()
  // JOS-335. The wish list, mounted here so a search row can write to it and so every row knows
  // whether it is already wanted — see the header for why one mount is the whole story.
  const wishes = useGearWishes()
  // JOS-297. A view unmounts on every tab switch, so both choices are localStorage-backed.
  const prefs = useGearPrefs()
  // JOS-329, and the same law one level up: EVERY field of this form outlives the tab now. The five
  // structural filters and the sort are on the RESTART tier, the search box is on the SESSION tier
  // — `areaMemory.ts` states the rule and owns both sanitizers.
  const [form, setForm] = useRemembered<GearFormMemory>('eq.gear.filters', sanitizeGearForm)
  const [text, setText] = useRememberedSearch('eq.gear.search')
  const [sort, setSort] = useRemembered<GearSort>('eq.gear.sort', sanitizeGearSort)
  const scrollRef = useRef<HTMLDivElement>(null)

  /**
   * THE BAR'S OWN `GearFilters`, REBUILT FROM THE STORED FORM.
   *
   * `GearFilters` has seven fields and only five of them belong to this key: `text` and `classes`
   * are remembered separately (different tier, and a provenance respectively) and are merged in
   * below, exactly as they always were. Keeping the bar's prop a whole `GearFilters` is what lets
   * `GearFilterBar` stay unchanged — it writes back a whole object and `setOwn` projects the five
   * fields worth storing out of it, which is also what stops the deferred text and the detected
   * trio from being written into a key that would only overwrite them on the next render.
   */
  const own = useMemo<GearFilters>(() => ({ ...DEFAULT_GEAR_FILTERS, ...form }), [form])
  const setOwn = useCallback(
    ({ slots, weaponTypes, effect, eraOnly, ownedOnly, ignoreHaste }: GearFilters) => {
      setForm({ slots, weaponTypes, effect, eraOnly, ownedOnly, ignoreHaste })
    },
    [setForm]
  )

  // Both deferrals, and nothing else deferred: the two controls whose every movement re-derives
  // six thousand rows (see the header).
  const deferredText = useDeferredValue(text)
  const deferredState = useDeferredValue(stateKey(upgrade.state))
  const visible = useMemo(() => controlsVisible(prefs.controls), [prefs.controls])
  // NO SLIDER, NO SIMULATION: the corpus reads at base when the control that moves it is hidden.
  const state = useMemo(
    () => (visible.has('upgrade') ? parseStateKey(deferredState) : ITEM_UPGRADE_BASE),
    [deferredState, visible]
  )

  // The class trio lives in its own hook (it FOLLOWS detection until pinned), so it is merged in
  // here rather than stored twice — one answer to "which classes", however it was arrived at.
  // `inertFilters` is LAST, so a hidden control's field cannot survive into the filter memo.
  const filters = useMemo(
    () => inertFilters({ ...own, text: deferredText, classes: classes.classes }, visible),
    [own, deferredText, classes.classes, visible]
  )
  // The two injected verdicts the pure filter cannot answer for itself, merged into one stable
  // object so `filterGearRows`' memo re-runs when either MOVES and never merely because it rendered.
  const era = useEraHidden()
  const owned = useOwnedOrLooted(ownership.map)
  const deps = useMemo(() => ({ ...era, ...owned }), [era, owned])
  const table = useTableRows(rows, state, filters, { sort, deps, chosen: prefs.columns })
  // JOS-338. The hover card's data, and it is deliberately OUTSIDE the three-memo pipeline above:
  // what you are wearing is not a filter, not a sort and not a scale, so no keystroke and no slider
  // tick can reach it. It takes the UNSCALED corpus (the card joins an equipped item by key and
  // scales it at ITS OWN `+N`) and the state IN FORCE, which is what lets the card admit that its
  // item half is a simulation while the equipped half is a fact off the player's dump.
  const compare = useGearCompare(rows, state)
  const win = useWindowedRows({ count: table.rows.length, rowHeight: ROW_HEIGHT, scrollRef })
  const hint = useMemo(
    () => ownedHint(ownership.map, uncountedNote(ownership.payload.uncounted)),
    [ownership.map, ownership.payload.uncounted]
  )
  // STABLE while the sort is, so `GearHead`'s memo holds across scroll ticks — an inline arrow
  // would hand the header a fresh identity every frame. The base is the sort IN FORCE, not the
  // requested one: after a picker removed the sorted column, clicking the header that took over
  // must FLIP it rather than re-open it.
  const onSort = useCallback((key: GearSortKey) => setSort(nextSort(table.sort, key)), [table.sort, setSort])

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }} data-testid="gear-view">
      <GearFilterBar
        filters={filters}
        setFilters={setOwn}
        text={text}
        setText={setText}
        classes={classes}
        upgrade={upgrade}
        visible={visible}
        hasteRelevant={readsDerivedScores(table.columns, deferredText)}
      />

      <CountLine
        counts={{ shown: table.rows.length, total: rows.length }}
        scrapedAt={scrapedAt}
        ownership={ownership}
        prefs={prefs}
        columns={table.columns}
      />

      {/* THE TABLE IS THE WHOLE BODY NOW. Until JOS-325 this was a `nowrap` ROW — the list on the
          left, the sets pane as a fixed column on the right — and with the pane retired the row has
          nothing left to lay out. What survives is the part that was never about the pane: the list
          is its own bounded scroller, so a filter that matches 6,766 rows grows this box's scroll
          height and never the page (the standing UI law, measured in gear.e2e.mts). */}
      <Box
        ref={scrollRef}
        data-testid="gear-list"
        sx={{
          flexGrow: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: 'auto',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1
        }}
      >
        <GearTable
          rows={table.rows}
          columns={table.columns}
          win={win}
          sort={table.sort}
          ownership={ownership.map}
          ownedHint={hint}
          onSort={onSort}
          onOpenLoot={onOpenLoot}
          // JOS-335, JOS-343 — the per-row wish gesture (add, and click again to remove) and the
          // added state it reads. UNDEFINED until the document has loaded (`useGearWishes`), which
          // is what draws no control at all rather than one lying about what is already on the list.
          onToggleWish={wishes.onToggleWish}
          wished={wishes.wished}
          // The dragged column widths (2026-08-15) — a view choice like the columns themselves.
          widths={prefs.widths}
          onWidths={prefs.setWidths}
          // The derived-score knobs (2026-08-15): the drawn EFF DMG / BEST cells read the same
          // options the sort just ranked by — the haste opt-out AND the class picks, so a casting
          // stat nobody picked can use scores nothing (the 1000-INT-warrior case).
          derived={derivedOpts(filters)}
          showDrops={prefs.dropCols}
          // JOS-338 — hovering a row opens the comparison card. Passed always: the card is useful
          // with no dump at all (the item half plus the command that fills the other half), and
          // `GearCompareData.ready` is what keeps it from claiming anything before the first read.
          compare={compare}
        />
        {table.rows.length === 0 && (
          <Typography variant="body2" color="text.secondary" data-testid="gear-empty" sx={{ p: 2 }}>
            {emptyText(ready, refused, table)}
          </Typography>
        )}
      </Box>
    </Box>
  )
}
