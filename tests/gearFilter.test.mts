// GEAR TAB — the filter, the sort, the columns and the plus-state wiring (JOS-284, phase 3). Pure
// model only: `src/renderer/src/features/gear/gearFilter.ts` and `gearColumns.ts` touch no React,
// no storage and no IPC, so they run under the node runner like `plannerGroups` and
// `plannerClasses` before them.
//
// THE FIXTURES ARE THE TWO ITEMS PHASE 0 IS PINNED ON, with their base vectors copied from
// `tests/gearIndex.test.mts` (which asserts them against the REAL corpus). That is the point of
// spelling them out here rather than building the index: if the corpus ever states different
// numbers for Thelvorn, gearIndex.test.mts goes red FIRST and names the corpus, instead of this
// file going red and blaming the filter.
//
// WHAT THIS FILE IS FOR, in one sentence: the gear table's answers must be the SCALED ones. The
// sort and every number the table draws read the vector AFTER `scaleAll`, so ranking by ratio under
// a `+5` slider ranks the weapons AS THEY WOULD BE at +5.
//
// THAT SENTENCE USED TO SAY "a threshold, a ratio floor and a sort", and JOS-302's fourth owner ask
// deleted the first two outright. The consequence is stated as its own test below — the plus-state
// can now move WHAT A ROW READS and never WHICH ROWS ARE SHOWN, because nothing that filters reads
// a number any more. That is a smaller claim than the one this file used to make, and writing the
// smaller one down is the point: the parser tests, the `meetsThresholds` tests and the ratio-floor
// test are GONE rather than weakened, because the code they described is gone.
//
// AND SINCE JOS-302 IT CARRIES THE THREE NARROWINGS THE OWNER ASKED FOR, each with its own claim:
//   * THE CLASS PICKS REMOVE ROWS. They used to chip them and enforce nothing; the owner overruled
//     that for this surface. The test below is the OLD test rewritten rather than deleted, and it
//     still pins the half that did NOT change — a page stating no class list survives, because
//     silence is not a refusal.
//   * SEVERAL SLOTS ARE A UNION, and the union ANDs with everything else.
//   * A WEAPON TYPE IS A FOLD OF THE CORPUS'S OWN `Skill:` SPELLINGS, and a category is nothing but
//     a union of types. The spelling census over the REAL corpus lives in tests/gearIndex.test.mts,
//     where the bytes are; what is pinned here is the vocabulary and the predicate.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GearRow } from '../src/shared/planner/gear'
import { scaleGearRow } from '../src/shared/planner/gearScale'
import type { ItemUpgradeState } from '../src/shared/itemUpgrade'
import {
  DEFAULT_GEAR_FILTERS,
  DEFAULT_GEAR_SORT,
  classMismatch,
  effectMatches,
  filterGearRows,
  gearTableRows,
  matchesGear,
  scaleAll,
  slotMatches,
  sortGearRows,
  sortValue,
  type GearFilters
} from '../src/renderer/src/features/gear/gearFilter'
import {
  WEAPON_CATEGORIES,
  WEAPON_PICKS,
  WEAPON_PICK_LABEL,
  WEAPON_TYPES,
  normalizeSkillToken,
  weaponPicksMatch,
  weaponTypeOf,
  weaponTypesFor
} from '../src/shared/planner/weaponType'
import {
  CORE_COLUMNS,
  MAX_DERIVED_COLUMNS,
  PICKABLE_COLUMNS,
  columnLabel,
  numericWidth,
  statText,
  visibleColumns
} from '../src/renderer/src/features/gear/gearColumns'

// =================================================================================
// FIXTURES
// =================================================================================

function row(over: Partial<GearRow> & Pick<GearRow, 'key' | 'name'>): GearRow {
  return {
    searchKey: over.name.toLowerCase(),
    slots: [],
    classes: [],
    races: ['ALL'],
    flags: [],
    quest: false,
    playerCrafted: false,
    stats: {},
    effects: [],
    ...over
  }
}

/** Thelvorn, Blade of Light — DMG 20, Atk Delay 26, WIS +15, WT 3.0 (tests/gearIndex.test.mts). */
const THELVORN = row({
  key: 'thelvorn, blade of light',
  name: 'Thelvorn, Blade of Light',
  slots: ['PRIMARY'],
  classes: ['PAL'],
  skill: '1H Slashing',
  stats: { WIS: 15, DMG: 20, DELAY: 26, WEIGHT: 3 },
  effects: [{ name: 'Dismiss Summoned', kind: 'combat', socket: 'proc', tierRequired: 4 }]
})

/** Crown of King Tranix — AC 13, CHA +15, SV MAGIC +20, WT 1.0, and the SV VOID synthesis case. */
const CROWN = row({
  key: 'crown of king tranix',
  name: 'Crown of King Tranix',
  slots: ['HEAD'],
  classes: ['CLR', 'ENC', 'MAG', 'NEC', 'WIZ'],
  stats: { AC: 13, CHA: 15, SV_MAGIC: 20, WEIGHT: 1 },
  voidSynth: true,
  effects: [{ name: 'Shielding', kind: 'worn', socket: 'worn', tierRequired: 3 }],
  eraTag: 'Classic'
})

/** A plain, effect-free, stat-free row — the "states none" case every rule has to survive. */
const PLAIN = row({ key: 'cloth cap', name: 'Cloth Cap', slots: ['HEAD'], classes: [], stats: { WEIGHT: 0.5 } })

/** A second weapon with a WORSE base ratio but a haste line, for the sort and threshold tests. */
const CLUB = row({
  key: 'wooden club',
  name: 'Wooden Club',
  slots: ['PRIMARY', 'SECONDARY'],
  classes: ['WAR', 'PAL'],
  skill: '1H Blunt',
  stats: { DMG: 5, DELAY: 30, HASTE: 10, HP_REGEN: 2, WEIGHT: 2 },
  effects: []
})

const ALL = [THELVORN, CROWN, PLAIN, CLUB]

/**
 * THE WEAPON-TYPE FIXTURES (JOS-302), and the four spellings are chosen from the corpus census in
 * `shared/planner/weaponType.ts` rather than invented: a clean `2H Slashing`, an `Archery`, the
 * bare `Piercing` that 322 pages state for the one-handed skill, and the stray `1H Slashing /` an
 * editor left a separator on. `PLAIN` (no `Skill:` at all) rides along as the not-a-weapon case.
 */
const GREATSWORD = row({
  key: 'greatsword',
  name: 'Greatsword',
  slots: ['PRIMARY'],
  skill: '2H Slashing',
  stats: { DMG: 30, DELAY: 45 }
})
const BOW = row({ key: 'short bow', name: 'Short Bow', slots: ['RANGE'], skill: 'Archery', stats: { DMG: 6, DELAY: 40 } })
const DAGGER = row({
  key: 'rusty dagger',
  name: 'Rusty Dagger',
  slots: ['PRIMARY', 'SECONDARY'],
  skill: 'Piercing',
  stats: { DMG: 3, DELAY: 22 }
})
const SLOPPY = row({
  key: 'faydark champions long sword',
  name: 'Faydark Champions Long Sword',
  slots: ['PRIMARY', 'SECONDARY'],
  skill: '1H Slashing /',
  stats: { DMG: 9, DELAY: 27 }
})

const ARMS = [THELVORN, CLUB, GREATSWORD, BOW, DAGGER, SLOPPY, PLAIN]

/** "Tier 2   3 / 4" — the owner screenshot every phase-0 number in this repo is verified against. */
const CHECKPOINT: ItemUpgradeState = { full: 2, fraction: 3 }
const BASE: ItemUpgradeState = { full: 0, fraction: 0 }

function filters(over: Partial<GearFilters> = {}): GearFilters {
  // Era OFF unless a test is about era: the default is ON, and the injected verdict is the one
  // thing this pure module cannot answer, so leaving it on would silently depend on the injection.
  return { ...DEFAULT_GEAR_FILTERS, eraOnly: false, ...over }
}

const names = (rows: readonly GearRow[]): string[] => rows.map((r) => r.name)

// =================================================================================
// THE PREDICATES — absent is not zero
// =================================================================================

test('the STRUCTURED filters are set memberships; the numbers ride the search box (2026-08-15)', () => {
  // JOS-302 deleted the toolbar's numeric filters; the 2026-08-15 user ask brought numeric
  // filtering back as SEARCH-BOX TOKENS (`parseGearQuery`), which honours what that ruling was
  // about — toolbar real estate. So the shape pinned here is: every structured field is still a
  // set membership or a flag (`ignoreHaste` is the 2026-08-15 addition — a knob on the DERIVED
  // scores, not a row filter), and the one place a number can filter is `text`.
  const keys = Object.keys(DEFAULT_GEAR_FILTERS).sort()
  assert.deepEqual(keys, ['classes', 'effect', 'eraOnly', 'ignoreHaste', 'ownedOnly', 'slots', 'text', 'weaponTypes'])
  // …and "absent is not zero" holds in the SORT and in a THRESHOLD alike (its own tests below).
  assert.equal(sortValue(THELVORN, 'HASTE'), undefined, 'no HASTE line is not 0% haste')
  assert.equal(sortValue(CLUB, 'HASTE'), 10)
})

// THE QUERY PARSER, THE THRESHOLD PREDICATE AND THE SHIELD FILTER (both 2026-08-15) ARE TESTED IN
// `tests/gearQueryFilter.test.mts` — this file sits at the repo's 400-code-line factoring ceiling,
// and the rule is to split, never to ratchet (the gearEffectiveHp.test.mts precedent).

test('a class list nobody stated is an unknown, and an unknown is never a mismatch', () => {
  assert.equal(classMismatch(['PAL'], ['WAR', 'ROG']), true)
  assert.equal(classMismatch(['PAL'], ['PAL', 'ROG']), false)
  assert.equal(classMismatch([], ['WAR']), false, 'the page stated no class list')
  assert.equal(classMismatch(['PAL'], []), false, 'an empty filter asks for no filter')
})

test('the effect filter speaks the donor vocabulary, plus "has one at all"', () => {
  assert.equal(effectMatches(PLAIN, 'any'), true)
  assert.equal(effectMatches(PLAIN, 'has'), false)
  assert.equal(effectMatches(THELVORN, 'has'), true)
  assert.equal(effectMatches(THELVORN, 'proc'), true)
  assert.equal(effectMatches(THELVORN, 'worn'), false)
  assert.equal(effectMatches(CROWN, 'worn'), true)
})

// =================================================================================
// THE COMBINED FILTER
// =================================================================================

test('every filter is ANDed, and each is inert at its empty value', () => {
  assert.deepEqual(names(filterGearRows(ALL, filters())), names(ALL), 'the empty filter filters nothing')

  assert.deepEqual(names(filterGearRows(ALL, filters({ slots: ['PRIMARY'] }))), ['Thelvorn, Blade of Light', 'Wooden Club'])
  assert.deepEqual(names(filterGearRows(ALL, filters({ text: 'blade' }))), ['Thelvorn, Blade of Light'])
  assert.deepEqual(names(filterGearRows(ALL, filters({ effect: 'proc' }))), ['Thelvorn, Blade of Light'])

  // Five at once: slot AND class AND weapon type AND effect kind AND search.
  const narrow = filters({
    slots: ['PRIMARY'],
    classes: ['PAL'],
    weaponTypes: ['1HS'],
    effect: 'proc',
    text: 'thelvorn'
  })
  assert.deepEqual(names(filterGearRows(ALL, narrow)), ['Thelvorn, Blade of Light'])
  // …and one contradiction empties it, without any of the others being wrong.
  assert.deepEqual(filterGearRows(ALL, { ...narrow, effect: 'worn' }), [])
  assert.deepEqual(filterGearRows(ALL, { ...narrow, weaponTypes: ['2HS'] }), [], 'and so does the wrong weapon type')
  assert.deepEqual(filterGearRows(ALL, { ...narrow, slots: ['SECONDARY'] }), [], 'and so does the wrong slot')
})

// =================================================================================
// THE CLASS PICKS — a NARROWING since JOS-302, and the owner's own words for why
// =================================================================================

test('the class picks REMOVE the rows they do not fit, and an unstated class list is never removed', () => {
  // THE OWNER'S RULING (2026-08-13): *gear that does not match the class filter is tagged with an
  // off-filter chip instead of being filtered out - obviously wrong, it should just be removed.*
  // This test is the OLD "hides only while it is on, and never enforces" test rewritten, not a new
  // one beside it: there is no toggle left to be off, and no chip left to point at a kept row.
  const rogue = filters({ classes: ['ROG'] })
  // The Cloth Cap states NO class list, so it survives — silence is not a refusal (law 1), and that
  // half of the rule did NOT change. Everything that named its classes and did not name ROG is gone.
  assert.deepEqual(names(filterGearRows(ALL, rogue)), ['Cloth Cap'])

  // A pick the rows DO fit keeps them, and several picks are the union a class list already means.
  assert.deepEqual(names(filterGearRows(ALL, filters({ classes: ['PAL'] }))), [
    'Thelvorn, Blade of Light',
    'Cloth Cap',
    'Wooden Club'
  ])
  assert.deepEqual(names(filterGearRows(ALL, filters({ classes: ['ROG', 'CLR'] }))), [
    'Crown of King Tranix',
    'Cloth Cap'
  ])
  // …and an EMPTY pick list is still no filter at all.
  assert.deepEqual(names(filterGearRows(ALL, filters({ classes: [] }))), names(ALL))
})

// =================================================================================
// THE SLOT PICKS — several at once, and they UNION (JOS-302's second ask)
// =================================================================================

test('several slots are a UNION, and the union still ANDs with everything else', () => {
  assert.equal(slotMatches(CLUB, []), true, 'no slot picked is no slot filter')
  assert.equal(slotMatches(CLUB, ['SECONDARY']), true)
  assert.equal(slotMatches(THELVORN, ['SECONDARY']), false)
  assert.equal(slotMatches(THELVORN, ['SECONDARY', 'PRIMARY']), true, 'ANY of them, never all of them')

  // PRIMARY + SECONDARY is the owner's own example, and it must not become an intersection: the
  // Crown (HEAD) drops out, both weapons stay, and the Cloth Cap (HEAD) drops out with the Crown.
  assert.deepEqual(names(filterGearRows(ALL, filters({ slots: ['PRIMARY', 'SECONDARY'] }))), [
    'Thelvorn, Blade of Light',
    'Wooden Club'
  ])
  assert.deepEqual(names(filterGearRows(ALL, filters({ slots: ['HEAD', 'PRIMARY'] }))), [
    'Thelvorn, Blade of Light',
    'Crown of King Tranix',
    'Cloth Cap',
    'Wooden Club'
  ])
  // …and clearing it returns the whole corpus, which is the acceptance line the ticket spells out.
  assert.deepEqual(names(filterGearRows(ALL, filters({ slots: [] }))), names(ALL))
  // AND it still ANDs: PRIMARY-or-SECONDARY, that a Paladin can use, that carries a proc.
  assert.deepEqual(
    names(filterGearRows(ALL, filters({ slots: ['PRIMARY', 'SECONDARY'], classes: ['PAL'], effect: 'proc' }))),
    ['Thelvorn, Blade of Light']
  )
})

// =================================================================================
// THE WEAPON TYPES — a fold of the corpus's own spellings, and categories that union
// =================================================================================

test('the corpus spells one skill several ways, and the fold reads them all as one type', () => {
  // Every spelling below is one the committed corpus actually states (the census in
  // shared/planner/weaponType.ts); the equality over that census lives in gearIndex.test.mts.
  assert.equal(weaponTypeOf('1H Slashing'), '1HS')
  assert.equal(weaponTypeOf('1H Slash'), '1HS', 'one editor abbreviated the skill')
  assert.equal(weaponTypeOf('1H Slashing /'), '1HS', 'and one left a separator on the end')
  assert.equal(weaponTypeOf('2H Slashing'), '2HS')
  assert.equal(weaponTypeOf('1H Blunt'), '1HB')
  assert.equal(weaponTypeOf('2H Blunt'), '2HB')
  // The classic one-handed skill is spelled BARE on 322 pages; `1H Piercing` is the same skill.
  assert.equal(weaponTypeOf('Piercing'), '1HP')
  assert.equal(weaponTypeOf('1H Piercing'), '1HP')
  assert.equal(weaponTypeOf('2H Piercing'), '2HP', 'and the two-handed one is its own skill')
  assert.equal(weaponTypeOf('Hand to Hand'), 'H2H')
  assert.equal(weaponTypeOf('Archery'), 'ARCHERY')
  // The wiki's template-version suffix is a spelling, not three skills.
  assert.equal(weaponTypeOf('Throwing'), 'THROWING')
  assert.equal(weaponTypeOf('Throwingv1'), 'THROWING')
  assert.equal(weaponTypeOf('Throwingv2'), 'THROWING')

  // NORMALIZED, NEVER REPAIRED. The token fold is case and punctuation; a string it does not
  // reduce to a known key stays unknown rather than being guessed at.
  assert.equal(normalizeSkillToken('  1h_slashing / '), '1H SLASHING')
  assert.equal(weaponTypeOf('SHIELD'), null, 'the one page stating a non-weapon skill is not a weapon')
  assert.equal(weaponTypeOf('Bashing'), null, 'a spelling the corpus has never printed is not invented')
  assert.equal(weaponTypeOf(undefined), null, 'and armour states no skill at all')
})

test('a category is nothing but the UNION of its member types', () => {
  assert.deepEqual(weaponTypesFor(['ONE_HAND']), ['1HS', '1HB', '1HP', 'H2H'])
  assert.deepEqual(weaponTypesFor(['TWO_HAND']), ['2HS', '2HB', '2HP'])
  assert.deepEqual(weaponTypesFor(['RANGED']), ['ARCHERY', 'THROWING'])
  // A category picked beside one of its own members is still just that category.
  assert.deepEqual(weaponTypesFor(['TWO_HAND', '2HB']), ['2HS', '2HB', '2HP'])
  // Two picks union, in vocabulary order rather than in click order.
  assert.deepEqual(weaponTypesFor(['ARCHERY', '1HS']), ['1HS', 'ARCHERY'])
  assert.deepEqual(weaponTypesFor([]), [], 'nothing picked stands for nothing')

  // Every type belongs to exactly one category — no type is unreachable from the category picks,
  // and none is double-counted.
  const covered = WEAPON_CATEGORIES.flatMap((c) => weaponTypesFor([c]))
  assert.deepEqual([...covered].sort(), [...WEAPON_TYPES].sort())
  assert.equal(new Set(covered).size, covered.length, 'a type may not sit in two categories')
  // …and the picker offers all twelve, each with words of its own.
  assert.equal(WEAPON_PICKS.length, WEAPON_TYPES.length + WEAPON_CATEGORIES.length)
  for (const pick of WEAPON_PICKS) assert.ok(WEAPON_PICK_LABEL[pick].length > 0, `${pick} has words`)
})

test('the weapon filter keeps the kinds asked for, and nothing that is not a weapon', () => {
  assert.equal(weaponPicksMatch('2H Slashing', []), true, 'nothing picked is no filter')
  assert.equal(weaponPicksMatch(undefined, []), true, '…including for armour')
  assert.equal(weaponPicksMatch(undefined, ['1HS']), false, 'but armour is not an answer to "1H slashers"')

  const only = (over: Partial<GearFilters>): string[] => names(filterGearRows(ARMS, filters(over)))
  assert.deepEqual(only({ weaponTypes: ['1HS'] }), ['Thelvorn, Blade of Light', 'Faydark Champions Long Sword'])
  assert.deepEqual(only({ weaponTypes: ['2HS'] }), ['Greatsword'])
  // THE CATEGORY, doing exactly what its members do — the club (1HB), the two 1HS and the dagger.
  assert.deepEqual(only({ weaponTypes: ['ONE_HAND'] }), [
    'Thelvorn, Blade of Light',
    'Wooden Club',
    'Rusty Dagger',
    'Faydark Champions Long Sword'
  ])
  assert.deepEqual(only({ weaponTypes: ['TWO_HAND'] }), ['Greatsword'])
  assert.deepEqual(only({ weaponTypes: ['RANGED'] }), ['Short Bow'])
  // A category and a type together are a union, not an intersection.
  assert.deepEqual(only({ weaponTypes: ['TWO_HAND', 'ARCHERY'] }), ['Greatsword', 'Short Bow'])
  // Nothing picked leaves even the Cloth Cap, which is not a weapon at all.
  assert.deepEqual(only({}), names(ARMS))
})

test('the weapon type ANDs with the slot and with the class picks', () => {
  // IN ADDITION TO THE SLOT, which is the ticket's own words — a one-hander that can go in the
  // off hand. The Thelvorn is PRIMARY only, so it drops out of this one.
  assert.deepEqual(
    names(filterGearRows(ARMS, filters({ weaponTypes: ['ONE_HAND'], slots: ['SECONDARY'] }))),
    ['Wooden Club', 'Rusty Dagger', 'Faydark Champions Long Sword']
  )
  // …and the class picks narrow it again, on the same AND. The Greatsword and the Bow are dropped
  // by the weapon type, not by the classes: every fixture but two states no class list at all.
  assert.deepEqual(
    names(filterGearRows(ARMS, filters({ weaponTypes: ['ONE_HAND'], classes: ['PAL'] }))),
    ['Thelvorn, Blade of Light', 'Wooden Club', 'Rusty Dagger', 'Faydark Champions Long Sword']
  )
  assert.deepEqual(
    names(filterGearRows(ARMS, filters({ weaponTypes: ['ONE_HAND'], classes: ['CLR'] }))),
    ['Rusty Dagger', 'Faydark Champions Long Sword']
  )
})

test('the era verdict is INJECTED, and only applies while the toggle is on', () => {
  const hidesCrown = { eraHidden: (r: GearRow) => r.key === CROWN.key }
  assert.equal(matchesGear(CROWN, filters({ eraOnly: true }), hidesCrown), false)
  assert.equal(matchesGear(CROWN, filters({ eraOnly: false }), hidesCrown), true)
  assert.equal(matchesGear(CROWN, filters({ eraOnly: true }), {}), true, 'no verdict hides nothing')
})

// =================================================================================
// THE SORT — where "absent is not zero" lives now that the numeric filters are gone
// =================================================================================

test('an absent stat sorts LAST in BOTH directions, and never as a zero', () => {
  for (const dir of ['asc', 'desc'] as const) {
    const sorted = sortGearRows(ALL, { key: 'HASTE', dir })
    assert.equal(sorted[0].name, 'Wooden Club', `${dir}: the only row stating HASTE leads`)
    assert.deepEqual(names(sorted).slice(1), ['Cloth Cap', 'Crown of King Tranix', 'Thelvorn, Blade of Light'])
  }
})

test('the sort is TOTAL — name is the tiebreak, so nothing re-shuffles under the scrollbar', () => {
  const a = row({ key: 'b ring', name: 'B Ring', slots: ['FINGER'], stats: { AC: 5 } })
  const b = row({ key: 'a ring', name: 'A Ring', slots: ['FINGER'], stats: { AC: 5 } })
  assert.deepEqual(names(sortGearRows([a, b], { key: 'AC', dir: 'desc' })), ['A Ring', 'B Ring'])
  assert.deepEqual(names(sortGearRows([b, a], { key: 'AC', dir: 'desc' })), ['A Ring', 'B Ring'])
  assert.deepEqual(names(sortGearRows([a, b], { key: 'name', dir: 'desc' })), ['B Ring', 'A Ring'])
})

test('ratio is a sort key of its own, and it is gearRatio - never a second opinion', () => {
  const sorted = sortGearRows(ALL, { key: 'RATIO', dir: 'desc' })
  assert.deepEqual(names(sorted).slice(0, 2), ['Thelvorn, Blade of Light', 'Wooden Club'])
  assert.equal(sortValue(THELVORN, 'RATIO')?.toFixed(2), '0.77')
  assert.equal(sortValue(CROWN, 'RATIO'), undefined, 'a crown has no damage ratio')
  assert.equal(sortValue(THELVORN, 'BACKSTAB'), undefined)
  assert.equal(sortValue(THELVORN, 'name'), undefined, 'the name is not a number')
})

// =================================================================================
// THE GLOBAL PLUS-STATE — the wiring this phase exists to add
// =================================================================================

test('scaleAll is a PURE MAP, and it is scaleGearRow s answer', () => {
  const scaled = scaleAll(ALL, CHECKPOINT)
  assert.equal(scaled.length, ALL.length)
  for (let i = 0; i < ALL.length; i++) {
    assert.deepEqual(scaled[i].stats, scaleGearRow(ALL[i], CHECKPOINT).stats, ALL[i].name)
    assert.equal(scaled[i].key, ALL[i].key, 'the row identity - and the ownership join key - survives')
  }
  // The bases are untouched, which is what makes dragging the slider reversible rather than
  // cumulative: the next state starts from the same numbers.
  assert.deepEqual(THELVORN.stats, { WIS: 15, DMG: 20, DELAY: 26, WEIGHT: 3 })
})

test('the table reproduces the owner screenshot at the checkpoint', () => {
  const [thelvorn] = scaleAll([THELVORN], CHECKPOINT)
  assert.equal(thelvorn.stats.DMG, 25)
  assert.equal(thelvorn.stats.WIS, 19) // floor(15 + round(4.125)), NOT 20
  assert.equal(thelvorn.stats.WEIGHT, 2.3) // ceil-to-one-decimal of 2.2420…
  assert.equal(thelvorn.stats.DELAY, 26) // delay never scales — which is why the ratio moves
  assert.equal(sortValue(thelvorn, 'RATIO')?.toFixed(2), '0.96')
  // The synthetic save is the one fact the vector cannot re-derive, so the row's cached answer has
  // to survive the scaling stage too — a COLUMN on SV VOID, and a sort by it, must see it.
  const [crown] = scaleAll([CROWN], CHECKPOINT)
  assert.equal(crown.stats.SV_VOID, 2)
  assert.equal(sortValue(crown, 'SV_VOID'), 2)
  assert.equal(sortValue(CROWN, 'SV_VOID'), undefined, 'at base the item states no SV VOID at all')
})

test('the plus-state moves WHAT A ROW READS, and since JOS-302 never WHICH ROWS are shown', () => {
  // THE LOAD-BEARING PROPERTY OF THE PHASE, restated at its true size. It used to be that filters
  // AND sorts read the scaled vector, so the selector could change the row SET ("ratio at least
  // 0.9" was met by nothing at base and by Thelvorn at the checkpoint). The fourth owner ask
  // deleted both numeric filters, so the row set is now a function of the pickers alone and the
  // selector is a pure restatement of the numbers on the rows that were already there.
  const wanted = filters({ slots: ['PRIMARY'] })
  assert.deepEqual(
    names(gearTableRows(ALL, BASE, { filters: wanted })),
    names(gearTableRows(ALL, CHECKPOINT, { filters: wanted })),
    'the same rows, in the same order, at both ends of the slider'
  )

  // …and the numbers on those same rows DID move, which is the half that survives and the reason
  // the scale still runs BEFORE the sort.
  const [atBase] = gearTableRows([THELVORN], BASE, { filters: filters() })
  const [atPlus] = gearTableRows([THELVORN], CHECKPOINT, { filters: filters() })
  assert.equal(sortValue(atBase, 'RATIO')?.toFixed(2), '0.77')
  assert.equal(sortValue(atPlus, 'RATIO')?.toFixed(2), '0.96')
  assert.equal(atPlus.stats.WIS, 19)
})

test('a sort reads the SCALED numbers, non-linear curve and float artifact included', () => {
  // WEIGHT is the one key whose curve is not linear in the tier (`scaleWeight` takes
  // `totalProgression` through a log2), and phase 0 deliberately REPLICATES the IEEE754 artifact
  // the wiki's own slider has — 3.0 at tier 10 ceils to 0.4 where exact decimal math says 0.3.
  // A sort that re-derived weights any other way would disagree with the item page it came from.
  const byWeight = { key: 'WEIGHT', dir: 'asc' } as const
  const order = ['Cloth Cap', 'Crown of King Tranix', 'Wooden Club', 'Thelvorn, Blade of Light']
  assert.deepEqual(names(gearTableRows(ALL, BASE, { filters: filters(), sort: byWeight })), order)
  assert.deepEqual(gearTableRows(ALL, BASE, { filters: filters(), sort: byWeight }).map((r) => r.stats.WEIGHT), [
    0.5, 1, 2, 3
  ])

  const at10 = gearTableRows(ALL, { full: 10, fraction: 0 }, { filters: filters(), sort: byWeight })
  assert.deepEqual(names(at10), order, 'the ranking survives — every weight shrinks by the same curve')
  assert.deepEqual(at10.map((r) => r.stats.WEIGHT), [0.1, 0.2, 0.3, 0.4])
})

// =================================================================================
// THE COLUMNS — ranking by a stat is saying you want to see it
// =================================================================================

test('the columns are the core, plus whatever is being SORTED on', () => {
  const base = visibleColumns(DEFAULT_GEAR_SORT)
  assert.deepEqual(base.map((c) => c.key), [...CORE_COLUMNS], 'the core, and only the core')

  // A sort key brings its own column — and one that is already core adds nothing. Stat THRESHOLDS
  // used to be the derivation's other source (`hp regen 2` conjured an HP REGEN column); JOS-302
  // deleted them, so the sort key is the whole of it and `visibleColumns` no longer takes filters.
  const byRegen = visibleColumns({ key: 'HP_REGEN', dir: 'desc' })
  assert.deepEqual(byRegen.map((c) => c.key), [...CORE_COLUMNS, 'HP_REGEN'])
  assert.equal(byRegen[byRegen.length - 1].label, 'HP REGEN')

  const byBackstab = visibleColumns({ key: 'BACKSTAB', dir: 'desc' })
  assert.deepEqual(byBackstab.map((c) => c.key), [...CORE_COLUMNS, 'BACKSTAB'])
  assert.deepEqual(visibleColumns({ key: 'AC', dir: 'asc' }).map((c) => c.key), [...CORE_COLUMNS])
  assert.deepEqual(visibleColumns({ key: 'name', dir: 'asc' }).map((c) => c.key), [...CORE_COLUMNS])
})

test('the derivation can add at most ONE column, and the widths always fit the pane', () => {
  // The cap became a CONSTANT with the thresholds (gearColumns.ts): a list whose only source is the
  // sort key cannot exceed core+1, so there is nothing left to cap. This asserts the new ceiling
  // over the WHOLE vocabulary rather than over one example — no sort key can widen it past five.
  for (const key of PICKABLE_COLUMNS) {
    const cols = visibleColumns({ key, dir: 'desc' })
    assert.ok(
      cols.length <= CORE_COLUMNS.length + MAX_DERIVED_COLUMNS,
      `sorting by ${key} derived ${String(cols.length)} columns`
    )
  }
  assert.equal(visibleColumns({ key: 'STR', dir: 'desc' }).length, CORE_COLUMNS.length + MAX_DERIVED_COLUMNS)
  assert.equal(MAX_DERIVED_COLUMNS, 1, 'the derivation adds the sort key and nothing else')

  const widest = CORE_COLUMNS.length + MAX_DERIVED_COLUMNS
  const pct = Number(numericWidth(widest).replace('%', ''))
  assert.ok(pct * widest <= 60, `${String(widest)} columns at ${String(pct)}% overflow the table`)
  // The ceiling: a small set never fattens its numeric columns - the item name takes the slack.
  assert.equal(numericWidth(4), '6.5%')
  assert.equal(numericWidth(1), '8%')
  assert.equal(numericWidth(10), '5%', 'past the floor the clamp holds - pixel mode owns that case')
})

test('a cell states what the item states - blank is "states none", never a zero', () => {
  assert.equal(statText(undefined, 'HP'), '')
  assert.equal(statText(0, 'HP'), '0', 'a stated zero IS a zero')
  assert.equal(statText(41, 'HASTE'), '41%')
  assert.equal(statText(2.3, 'WEIGHT'), '2.3')
  assert.equal(statText(0.9615, 'RATIO'), '0.96')
  assert.equal(columnLabel('RATIO'), 'Ratio')
  assert.equal(columnLabel('name'), 'Item')
  assert.equal(columnLabel('MANA_REGEN'), 'MANA REGEN')
  // EFFECTIVE HP (JOS-336): a PLAIN INTEGER, and a label short enough for the 8% column ceiling
  // (JOS-299). Both come from the defaults rather than from arms of their own — the sum of two
  // integer-valued primary stats is an integer, and the underscore rule already spells `EFF HP`.
  assert.equal(statText(66, 'EFF_HP'), '66', 'no decimal point, no unit')
  assert.equal(statText(0, 'EFF_HP'), '0', 'a stated zero IS a zero here too')
  assert.equal(statText(undefined, 'EFF_HP'), '', 'and states-neither is blank, like every other key')
  assert.equal(columnLabel('EFF_HP'), 'EFF HP')
  assert.ok(columnLabel('EFF_HP').length < columnLabel('SV_DISEASE').length, 'shorter than a header this table already draws')
})
