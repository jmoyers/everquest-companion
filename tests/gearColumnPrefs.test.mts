// GEAR TAB — the column picker, the configurable filter bar, and the width law that holds when a
// chosen set is wider than the pane (JOS-297). Pure model only: `gearColumns.ts` and `gearPrefs.ts`
// touch no React, no storage and no IPC, so they run under the node runner like `gearFilter` before
// them.
//
// WHAT THIS FILE IS FOR, in one sentence per claim the ticket makes:
//
//   1. THE PICKER PERSISTS, AND EXPLICIT BEATS DERIVED. A stored choice wins outright, an absent
//      key falls back to the derived seed, and a stored EMPTY list is a choice rather than an
//      absence — the one distinction a naive `?? []` would erase.
//   2. EVERY EXPOSED KEY SORTS. The picker offers thirty-three keys and every one of them is a
//      working sort axis in BOTH directions, with an absent value LAST either way — which is the
//      property that makes "expose it on every header" safe rather than a promise.
//   3. THE WIDTHS FIT OR THE TABLE SCROLLS. Percentages while they can serve the set at a legible
//      floor, stated pixels plus a table minimum past that — and the pixel total is what the pane
//      scrolls sideways INSIDE itself. The e2e measures the scrolling; this measures the numbers.
//   4. A HIDDEN CONTROL IS NOT FILTERING. `inertFilters` is asserted field by field, including the
//      one whose inert value is NOT its default (era ships ON).
//
// The row fixtures here are SYNTHETIC, unlike `gearFilter.test.mts`'s: nothing below asserts a
// number the corpus states, only that the model treats every key in the vocabulary alike. Using
// two real items would have meant hand-writing thirty-three stats twice for no extra proof.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GEAR_STAT_KEYS, type GearRow, type GearStats } from '../src/shared/planner/gear'
import {
  CORE_COLUMNS,
  MAX_PERCENT_COLUMNS,
  PICKABLE_COLUMNS,
  columnsFor,
  gearTableLayout,
  sortWithin,
  visibleColumns
} from '../src/renderer/src/features/gear/gearColumns'
import {
  DEFAULT_GEAR_FILTERS,
  DEFAULT_GEAR_SORT,
  sortGearRows,
  sortValue,
  type GearFilters,
  type GearSort,
  type GearSortKey
} from '../src/renderer/src/features/gear/gearFilter'
import {
  GEAR_CONTROLS,
  GEAR_CONTROL_LABEL,
  controlsVisible,
  inertFilters,
  sanitizeColumns,
  sanitizeControls,
  toggleColumn,
  toggleControl
} from '../src/renderer/src/features/gear/gearPrefs'

// =================================================================================
// FIXTURES
// =================================================================================

function row(name: string, stats: GearStats): GearRow {
  return {
    key: name.toLowerCase(),
    name,
    searchKey: name.toLowerCase(),
    slots: [],
    classes: [],
    races: ['ALL'],
    flags: [],
    quest: false,
    playerCrafted: false,
    stats,
    effects: []
  }
}

/**
 * Every indexed key at `n`, with DELAY forced so the derived RATIO moves the same way DMG does.
 * The other derived key needs no such help: HP and STA are both in the list, so `EFF_HP` reads `2n`
 * on any row this builds and `undefined` on the row that states nothing.
 */
function everyStat(n: number, delay: number): GearStats {
  const out: GearStats = {}
  for (const key of GEAR_STAT_KEYS) out[key] = n
  out.DELAY = delay
  return out
}

/** High (ratio 2.0), low (ratio 0.25), and a row that states nothing at all. */
const HIGH = row('High', everyStat(20, 10))
const LOW = row('Low', everyStat(5, 20))
const NONE = row('None', {})
const ROWS: readonly GearRow[] = [NONE, HIGH, LOW]

function filters(over: Partial<GearFilters> = {}): GearFilters {
  return { ...DEFAULT_GEAR_FILTERS, ...over }
}

// =================================================================================
// 1. THE PICKER: EXPLICIT BEATS DERIVED, AND ABSENT IS NOT EMPTY
// =================================================================================

test('no stored choice means the columns are DERIVED, exactly as the shipped tab derived them', () => {
  const byRegen: GearSort = { key: 'HP_REGEN', dir: 'desc' }
  const derived = columnsFor(null, byRegen)
  assert.deepEqual(
    derived.map((c) => c.key),
    visibleColumns(byRegen).map((c) => c.key),
    'the seed is the same function the tab already used'
  )
  assert.deepEqual(derived.map((c) => c.key), [...CORE_COLUMNS, 'HP_REGEN'])
})

test('an explicit choice WINS - it is not re-seeded with the core or with the sort key', () => {
  const chosen: GearSortKey[] = ['STR', 'CHA']
  // A sort on HP_REGEN: under the derivation that column AND the whole core would be drawn.
  const columns = columnsFor(chosen, { key: 'HP_REGEN', dir: 'desc' })
  assert.deepEqual(columns.map((c) => c.key), chosen, 'exactly what was asked for, in that order')
  assert.ok(!columns.some((c) => c.key === 'AC'), 'a core column the user removed stays removed')
  assert.ok(!columns.some((c) => c.key === 'HP_REGEN'), 'and the sort key cannot conjure one back')
})

test('a stored EMPTY list is a CHOICE, and never the same thing as no choice at all', () => {
  assert.deepEqual(sanitizeColumns([]), [], 'an empty array survives as an empty array')
  assert.equal(sanitizeColumns(null), null, 'nothing stored stays nothing stored')
  assert.equal(sanitizeColumns(undefined), null)
  assert.deepEqual(columnsFor([], DEFAULT_GEAR_SORT), [], 'chosen-none draws no numeric columns')
  assert.ok(
    columnsFor(null, DEFAULT_GEAR_SORT).length > 0,
    'while stored-nothing still draws the derived core - the two must never fold together'
  )
})

test('a stored choice DEGRADES rather than erroring, whatever another build wrote', () => {
  assert.equal(sanitizeColumns('AC,HP'), null, 'a string is not a choice')
  assert.equal(sanitizeColumns({ AC: true }), null, 'nor is an object')
  assert.deepEqual(sanitizeColumns(['AC', 'NOT_A_STAT', 'name', 42, 'HP']), ['AC', 'HP'], 'unknown keys drop out')
  assert.deepEqual(sanitizeColumns(['HP', 'AC', 'HP']), ['HP', 'AC'], 'repeats collapse, stored order survives')
  assert.deepEqual(sanitizeColumns(['RATIO']), ['RATIO'], 'the derived ratio is a pickable column')
  assert.deepEqual(sanitizeColumns(['EFF_HP']), ['EFF_HP'], '…and so is the derived effective HP')
})

test('the picker offers the WHOLE vocabulary - every indexed stat, all four derived keys, never the name', () => {
  // FOUR DERIVED KEYS: `RATIO`, `EFF_HP` (JOS-336), and since 2026-08-15 `EFF_DMG` and `BIS`. None
  // is a field of `GearStats`, all are computed off the SCALED vector at read time, and all are
  // offered exactly like a stat.
  assert.equal(PICKABLE_COLUMNS.length, GEAR_STAT_KEYS.length + 4)
  for (const key of GEAR_STAT_KEYS) assert.ok(PICKABLE_COLUMNS.includes(key), `${key} is offered`)
  assert.ok(PICKABLE_COLUMNS.includes('RATIO'))
  assert.ok(PICKABLE_COLUMNS.includes('EFF_HP'))
  assert.ok(PICKABLE_COLUMNS.includes('EFF_DMG'))
  assert.ok(PICKABLE_COLUMNS.includes('BIS'))
  assert.ok(!PICKABLE_COLUMNS.includes('name' as GearSortKey), 'the item column is not optional')
  // A DERIVED KEY STANDS BESIDE THE NUMBERS IT IS MADE OF — the only documentation a flat checkbox
  // list can carry (gearColumns.ts). Ratio follows DELAY, the damage score follows the ratio that
  // is its largest input; effective HP follows HP, one row under the STA it is summed with; and
  // BIS — made of ALL of them — closes the list, having no one neighbour that documents it.
  assert.equal(PICKABLE_COLUMNS[PICKABLE_COLUMNS.indexOf('DELAY') + 1], 'RATIO')
  assert.equal(PICKABLE_COLUMNS[PICKABLE_COLUMNS.indexOf('RATIO') + 1], 'EFF_DMG')
  assert.equal(PICKABLE_COLUMNS[PICKABLE_COLUMNS.indexOf('HP') + 1], 'EFF_HP')
  assert.ok(PICKABLE_COLUMNS.indexOf('STA') < PICKABLE_COLUMNS.indexOf('EFF_HP'), 'both halves come first')
  assert.equal(PICKABLE_COLUMNS[PICKABLE_COLUMNS.length - 1], 'BIS')
  // The seven attributes the owner named by hand. Since JOS-302 this list is the ONLY way to put a
  // stat on the table that the sort has not already put there - which is exactly the trade the
  // owner priced when the stat-threshold box went: the picker names it, the header ranks it.
  for (const key of ['STR', 'STA', 'AGI', 'DEX', 'WIS', 'INT', 'CHA'] as const) {
    assert.ok(PICKABLE_COLUMNS.includes(key), `${key} is one click away`)
  }
})

test('a toggle keeps VOCABULARY order, and the first click promotes the seed unchanged but for it', () => {
  const seed: GearSortKey[] = [...CORE_COLUMNS]
  const added = toggleColumn(seed, 'STR')
  assert.ok(added.includes('STR'))
  for (const key of seed) assert.ok(added.includes(key), `${key} survived the promotion`)
  // STR comes before HP and MP in the corpus's order, so the result is re-ordered, not appended.
  assert.deepEqual(added, PICKABLE_COLUMNS.filter((k) => added.includes(k)))
  assert.deepEqual(toggleColumn(added, 'STR'), seed.slice().sort((a, b) => order(a) - order(b)))
})

function order(key: GearSortKey): number {
  return PICKABLE_COLUMNS.indexOf(key)
}

// =================================================================================
// 2. EVERY EXPOSED KEY SORTS, IN BOTH DIRECTIONS, WITH ABSENT LAST
// =================================================================================

test('every key the picker offers is a working sort axis - the exposure IS the sortability', () => {
  for (const key of PICKABLE_COLUMNS) {
    assert.notEqual(sortValue(HIGH, key), undefined, `${key} reads a number off a row that states it`)
    assert.equal(sortValue(NONE, key), undefined, `${key} reads nothing off a row that states none`)
  }
})

test('every exposed key ranks BOTH ways, and an absent value sorts LAST either way', () => {
  for (const key of PICKABLE_COLUMNS) {
    for (const dir of ['desc', 'asc'] as const) {
      const sort: GearSort = { key, dir }
      const values = sortGearRows(ROWS, sort).map((r) => sortValue(r, key))
      const firstAbsent = values.findIndex((v) => v === undefined)
      assert.ok(
        firstAbsent !== -1 && values.slice(firstAbsent).every((v) => v === undefined),
        `${key} ${dir}: a row stating none must never outrank one that states a number`
      )
      const stated = values.slice(0, firstAbsent) as number[]
      assert.equal(stated.length, 2, `${key} ${dir}: both stating rows survived`)
      const ranked = dir === 'desc' ? stated[0] >= stated[1] : stated[0] <= stated[1]
      assert.ok(ranked, `${key} ${dir}: ${String(stated[0])} then ${String(stated[1])}`)
    }
  }
})

test('the sort is confined to what is DRAWN - removing the sorted column moves the lit header', () => {
  const shown = columnsFor(['STR', 'CHA'], filters(), DEFAULT_GEAR_SORT)
  const kept: GearSort = { key: 'STR', dir: 'asc' }
  assert.equal(sortWithin(kept, shown), kept, 'a sort on a drawn column is returned UNCHANGED - same object')
  assert.deepEqual(sortWithin({ key: 'AC', dir: 'desc' }, shown), { key: 'STR', dir: 'desc' }, 'it falls to the first drawn column')
  assert.deepEqual(sortWithin({ key: 'AC', dir: 'desc' }, []), { key: 'name', dir: 'asc' }, 'no numeric columns leaves the item name')
  const byName: GearSort = { key: 'name', dir: 'asc' }
  assert.equal(sortWithin(byName, []), byName, 'the item column is always drawn, so a name sort always holds')
})

// =================================================================================
// 3. THE WIDTHS: PERCENTAGES WHILE THEY FIT, PIXELS WHEN THEY DO NOT
// =================================================================================

test('NOTHING THE DERIVATION CAN PRODUCE crosses into pixel mode - over the whole vocabulary', () => {
  // The two numbers used to be equal on purpose: the derived cap WAS the percentage floor, so no
  // derived set could overflow. JOS-302 cut the derivation to core+1, which WIDENS that guarantee
  // rather than breaking it - so the claim is asserted over every sort key there is, not over one
  // hand-built worst case that no longer exists.
  for (const key of PICKABLE_COLUMNS) {
    const derived = columnsFor(null, { key, dir: 'desc' })
    assert.ok(derived.length <= MAX_PERCENT_COLUMNS, `sorting by ${key} draws ${String(derived.length)} columns`)
    assert.equal(gearTableLayout(derived.length, true).mode, 'percent', `sorting by ${key} left percentage mode`)
  }
})

test('percentage mode states percentages that FIT the pane, with the item column absorbing the slack', () => {
  // 7 left this list on 2026-08-15: the drop columns shrank the numeric budget, so seven numeric
  // columns are past the floor now and pixel mode (the next test) is what serves them.
  for (const count of [1, 2, 4, MAX_PERCENT_COLUMNS]) {
    const layout = gearTableLayout(count, true)
    assert.equal(layout.mode, 'percent')
    assert.equal(layout.minWidth, 0, 'nothing can overflow a table that IS the pane')
    assert.equal(layout.name, undefined, 'the item column states no width - it takes what is left')
    // EVERY stated column is in this sum — the 2026-08-15 lesson, learned in production: this test
    // used to omit columns it did not know about, so the drop columns overflowed the real table to
    // 123% while it stayed green, and `tableLayout: fixed` paid for the overflow by squeezing the
    // one UNSTATED column — the item name, its click-through and the wish control — to zero width.
    const stated =
      count * Number(layout.numeric.replace('%', '')) +
      Number(layout.wish.replace('%', '')) +
      Number(layout.slot.replace('%', '')) +
      Number(layout.classes.replace('%', '')) +
      Number(layout.zone.replace('%', '')) +
      Number(layout.zoneLevel.replace('%', '')) +
      Number(layout.mob.replace('%', '')) +
      Number(layout.owned.replace('%', ''))
    assert.ok(stated <= 100, `${String(count)} columns state ${String(stated)}% - the name column needs the rest`)
    assert.ok(stated <= 85, 'and the item column always keeps a legible share, never merely a sliver')
  }
})

test('past the floor the layout switches to PIXELS and states a table minimum - which is what scrolls', () => {
  const narrow = gearTableLayout(MAX_PERCENT_COLUMNS, false)
  const wide = gearTableLayout(MAX_PERCENT_COLUMNS + 1, false)
  assert.equal(narrow.mode, 'percent')
  assert.equal(wide.mode, 'pixel')
  assert.ok(wide.minWidth > 0, 'the table now has a floor of its own')
  assert.notEqual(wide.name, undefined, 'and every column states a width, because the SUM is the point')

  // The floor GROWS with the set: that is the whole mechanism by which a wide choice overflows.
  const wider = gearTableLayout(MAX_PERCENT_COLUMNS + 10, false)
  assert.ok(wider.minWidth > wide.minWidth)
  // …and the Owned column, which is not a numeric and not in the shared budget, pays its own way.
  assert.ok(gearTableLayout(20, true).minWidth > gearTableLayout(20, false).minWidth)

  // A full-vocabulary pick is wider than any window this app runs in - the case the ticket names.
  // The count is read off `PICKABLE_COLUMNS` rather than typed, so a key added to the vocabulary
  // (JOS-336 added the thirty-fourth) widens this claim instead of stale-ing it.
  const everything = gearTableLayout(PICKABLE_COLUMNS.length, true)
  assert.equal(everything.mode, 'pixel')
  assert.ok(everything.minWidth > 2500, `all ${String(PICKABLE_COLUMNS.length)} columns state ${String(everything.minWidth)}px`)
})

// =================================================================================
// 4. THE CONFIGURABLE TOOLBAR: A HIDDEN CONTROL IS NOT FILTERING
// =================================================================================

test('no stored toolbar choice shows every control, and a stored EMPTY one shows none', () => {
  assert.equal(controlsVisible(null).size, GEAR_CONTROLS.length)
  assert.equal(controlsVisible([]).size, 0, 'an empty choice is a choice')
  assert.equal(controlsVisible(['era']).size, 1)
})

test('a stored toolbar choice degrades the same way a column choice does', () => {
  assert.equal(sanitizeControls('era'), null)
  assert.equal(sanitizeControls(42), null)
  assert.equal(sanitizeControls({ vocab: [...GEAR_CONTROLS] }), null, 'an object with no `shown` has said nothing')
  // A KEY THIS VERSION DROPPED degrades rather than erroring, and JOS-302 dropped three for real:
  // `classOnly` was the "Usable by these" toggle (the class picks narrow on their own now), and
  // `ratio`/`thresholds` were the two numeric filters the fourth owner ask deleted outright. A
  // toolbar choice stored by an older build simply loses those entries and keeps the rest.
  //
  // THE EXPECTATIONS ON THIS TEST CHANGED ON 2026-08-13 and the old ones are worth stating, because
  // they were the bug rather than the contract: `['slot','classOnly','classes']` used to resolve to
  // exactly `['slot','classes']`, and it now resolves to `['slot','weapon','classes']`. See the next
  // test and `gearPrefs.LEGACY_GEAR_CONTROLS` — a legacy list cannot have hidden a control that did
  // not exist when it was written, so `weapon` joins every one of these — AND SO DOES `haste`
  // (added 2026-08-15), by exactly the same rule. The DEGRADATION claim these lines were written
  // for is untouched: unknown keys still drop out, repeats still collapse.
  assert.deepEqual(sanitizeControls(['slot', 'classOnly', 'classes']), ['slot', 'weapon', 'classes', 'haste'])
  assert.deepEqual(sanitizeControls(['upgrade', 'ratio', 'thresholds', 'era']), ['weapon', 'era', 'haste', 'upgrade'])
  assert.deepEqual(sanitizeControls(['era', 'nope', 'era', 7, 'slot']), ['slot', 'weapon', 'era', 'haste'])
  // ORDER IS THE BAR'S, not the store's — and that is not a loss. A control list is turned into a
  // Set by `controlsVisible` and `GearFilterBar` draws in its own fixed order, so unlike the COLUMN
  // list (which the user can see the order of) this one has no order anybody can observe.
  assert.deepEqual(toggleControl(['era'], 'slot'), ['slot', 'era'], 'the bar draws slot before era, so the list does too')
  assert.deepEqual(toggleControl(['slot', 'era'], 'era'), ['slot'])
  for (const control of GEAR_CONTROLS) {
    assert.ok(GEAR_CONTROL_LABEL[control].length > 0, `${control} has words in the picker`)
  }
})

// ---------------------------------------------------------------------------------
// EVERY FILTER CONTROL IS ENABLED BY DEFAULT (owner ruling 2026-08-13, folded into JOS-329)
// ---------------------------------------------------------------------------------
//
// The ask was "all filter controls on the equipment tab are ENABLED by default", on the belief that
// the picker derived a default subset. IT NEVER DID — the first test below has always passed — and
// finding that out is what located the real defect: a stored choice is a closed statement about the
// vocabulary that existed when it was written, so every control added AFTERWARDS read as one the
// user had hidden. JOS-302 added `weapon`, which is why the owner's own Gear tab has been missing
// the Weapon type picker with nothing in the UI to explain it.
//
// The rule these four tests pin: A CONTROL THE USER NEVER HAD THE CHANCE TO RULE ON IS ON, and a
// control they DID rule on keeps their ruling.

test('THE DEFAULT IS EVERY CONTROL - an untouched install has the whole toolbar', () => {
  assert.equal(controlsVisible(sanitizeControls(null)).size, GEAR_CONTROLS.length)
  for (const control of GEAR_CONTROLS) {
    assert.ok(controlsVisible(null).has(control), `${control} draws with no stored choice`)
  }
})

test('a LEGACY choice gains the controls it was never offered, and keeps the hides it made', () => {
  // The owner's shape: a pre-JOS-302 list. `weapon` did not exist to be hidden, so it comes back…
  const resolved = sanitizeControls(['slot', 'classes', 'era', 'owned', 'upgrade', 'classOnly'])
  assert.ok(resolved !== null && resolved.includes('weapon'), 'the control added after the choice is ON')
  // …while `effect`, which DID exist and was left out, stays hidden. That is the half the owner's
  // "existing users keep their choice" clause protects, and the half a blanket reset would destroy.
  assert.ok(resolved !== null && !resolved.includes('effect'), 'a control they really did hide stays hidden')
})

test('a NEW-shape choice is taken at its word — hiding weapon deliberately keeps it hidden', () => {
  // Once the picker has been touched, the vocabulary travels with the choice and there is nothing
  // left to guess: every control is accounted for, so `shown` means exactly what it says.
  const deliberate = sanitizeControls({ shown: ['slot', 'era'], vocab: [...GEAR_CONTROLS] })
  assert.deepEqual(deliberate, ['slot', 'era'])
  assert.ok(deliberate !== null && !deliberate.includes('weapon'), 'this user really did hide it')
  // …and an empty toolbar is still expressible, which is the absent-is-not-empty law (gearPrefs.ts).
  assert.deepEqual(sanitizeControls({ shown: [], vocab: [...GEAR_CONTROLS] }), [])
  assert.equal(controlsVisible(sanitizeControls({ shown: [], vocab: [...GEAR_CONTROLS] })).size, 0)
})

test('…and the migration heals itself: a stale vocab only widens, never narrows', () => {
  // A choice recorded against a vocabulary MISSING two of today's controls gets both of them, and
  // this is what makes the rule future-proof rather than a one-off patch for `weapon`: the next
  // control the bar grows is on for everybody without anyone editing this file again.
  const stale = sanitizeControls({ shown: ['slot'], vocab: ['slot', 'effect', 'classes'] })
  assert.ok(stale !== null)
  for (const grown of ['weapon', 'era', 'owned', 'upgrade'] as const) {
    assert.ok(stale.includes(grown), `${grown} was not in the recorded vocabulary, so it is ON`)
  }
  assert.ok(!stale.includes('effect'), 'while a control that WAS in it and was not picked stays off')
})

test('a control that is not on screen is not filtering either - every field goes INERT', () => {
  const busy = filters({
    slots: ['PRIMARY'],
    weaponTypes: ['ONE_HAND'],
    effect: 'proc',
    classes: ['PAL'],
    eraOnly: true,
    ownedOnly: true,
    text: 'thelvorn'
  })
  const hidden = inertFilters(busy, controlsVisible([]))
  assert.deepEqual(hidden.slots, [])
  assert.deepEqual(hidden.weaponTypes, [])
  assert.equal(hidden.effect, 'any')
  // THE ONE THAT BECAME LOAD-BEARING IN JOS-302: the class picks NARROW the corpus now, and the
  // view fills them from DETECTION rather than from a click - so a hidden Classes control that
  // kept filtering would hold rows back on an inference nobody made and nobody can see.
  assert.deepEqual(hidden.classes, [])
  assert.equal(hidden.ownedOnly, false)
  // INERT, NOT DEFAULT. The era filter SHIPS ON, so its default would still be hiding rows behind a
  // control nobody can see - which is the exact failure this function exists to prevent.
  assert.equal(DEFAULT_GEAR_FILTERS.eraOnly, true, 'era is on by default')
  assert.equal(hidden.eraOnly, false, 'and inert when its chip is gone')
  // SEARCH IS NEVER HIDDEN, so the text is never touched.
  assert.equal(hidden.text, 'thelvorn')
})

test('a control that IS on screen keeps its value untouched, one at a time', () => {
  const busy = filters({
    slots: ['PRIMARY'],
    weaponTypes: ['TWO_HAND'],
    classes: ['PAL'],
    effect: 'proc',
    eraOnly: true,
    ownedOnly: true
  })
  assert.deepEqual(inertFilters(busy, controlsVisible(['slot'])).slots, ['PRIMARY'])
  assert.deepEqual(inertFilters(busy, controlsVisible(['weapon'])).weaponTypes, ['TWO_HAND'])
  assert.deepEqual(inertFilters(busy, controlsVisible(['classes'])).classes, ['PAL'])
  assert.equal(inertFilters(busy, controlsVisible(['effect'])).effect, 'proc')
  assert.equal(inertFilters(busy, controlsVisible(['era'])).eraOnly, true)
  assert.equal(inertFilters(busy, controlsVisible(['owned'])).ownedOnly, true)
  // The whole bar visible is the identity the shipped tab has always had.
  const all = inertFilters(busy, controlsVisible(null))
  assert.deepEqual(all, busy)
})

test('HIDING A CONTROL CANNOT MOVE A COLUMN any more - the two choices stopped being coupled', () => {
  // There used to be a coupling worth its own test: hiding the thresholds control made its
  // thresholds inert, and an inert threshold took the column it had been deriving with it. JOS-302
  // deleted the thresholds, so the derivation reads ONLY the sort - and the sort is not a toolbar
  // control at all. That is the honest replacement claim: whatever the toolbar is showing, the
  // derived columns are the same, because the two choices no longer touch.
  const busy = filters({ slots: ['PRIMARY'], weaponTypes: ['ONE_HAND'], classes: ['PAL'], eraOnly: true })
  const sort: GearSort = { key: 'HP_REGEN', dir: 'desc' }
  const whole = columnsFor(null, sort).map((c) => c.key)
  assert.deepEqual(whole, [...CORE_COLUMNS, 'HP_REGEN'])
  for (const shown of [controlsVisible([]), controlsVisible(['slot']), controlsVisible(null)]) {
    // `inertFilters` still runs - it is what keeps a hidden control from FILTERING - and the
    // columns simply do not depend on its answer.
    void inertFilters(busy, shown)
    assert.deepEqual(columnsFor(null, sort).map((c) => c.key), whole)
  }
})
