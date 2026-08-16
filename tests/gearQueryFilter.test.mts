// GEAR TAB — the SEARCH-BOX QUERY and the SHIELD FILTER (both 2026-08-15). Split out of
// `gearFilter.test.mts`, which sits at the repo's 400-code-line factoring ceiling — the
// gearEffectiveHp.test.mts precedent, fixtures duplicated the same way and for the same reason.
//
// WHAT CAME BACK AND HOW. JOS-302 (owner ruling 2026-08-13) deleted the toolbar's numeric filters;
// the 2026-08-15 user ask — *filter by any of the columns* — brought numeric filtering back as
// SEARCH-BOX TOKENS, which honours what that ruling was actually about: toolbar real estate.
// gearFilter.ts's header carries the full argument. The claims pinned here:
//
//   1. THE PARSER lifts `key op number` tokens out and leaves the words as ONE substring needle —
//      and a token naming no known key stays a WORD, so a typo shows itself in an empty table
//      rather than silently filtering on nothing.
//   2. A THRESHOLD READS THE SCALED VECTOR through `sortValue` — `ratio>=0.9` under the slider
//      keeps the weapons that reach 0.9 AT that plus.
//   3. ABSENT FAILS EVERY OPERATOR, `<` included (law 1): an item that stated no HASTE line is not
//      an item with less than 41% haste.
//   4. SHIELDS ONLY is one exported heuristic (`isShieldLike`) — SECONDARY slot AND (a shield word
//      in the name OR a stated `Skill: Shield`) — so the view's precomputed flag and the pure
//      filter can never disagree.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GearRow } from '../src/shared/planner/gear'
import type { ItemUpgradeState } from '../src/shared/itemUpgrade'
import {
  DEFAULT_GEAR_FILTERS,
  filterGearRows,
  isShieldLike,
  parseGearQuery,
  scaleAll,
  type GearFilters
} from '../src/renderer/src/features/gear/gearFilter'

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

/** Thelvorn, Blade of Light — DMG 20, Atk Delay 26 (ratio ≈ 0.769), WIS +15, WT 3.0. */
const THELVORN = row({
  key: 'thelvorn, blade of light',
  name: 'Thelvorn, Blade of Light',
  slots: ['PRIMARY'],
  skill: '1H Slashing',
  stats: { WIS: 15, DMG: 20, DELAY: 26, WEIGHT: 3 }
})

/** A worse-ratio weapon that STATES a haste — the "stated number answers, silence does not" pair. */
const CLUB = row({
  key: 'wooden club',
  name: 'Wooden Club',
  slots: ['PRIMARY', 'SECONDARY'],
  skill: '1H Blunt',
  stats: { DMG: 5, DELAY: 30, HASTE: 10, HP_REGEN: 2, WEIGHT: 2 }
})

/** States neither a weapon block nor a haste — the absent case for every operator. */
const CROWN = row({
  key: 'crown of king tranix',
  name: 'Crown of King Tranix',
  slots: ['HEAD'],
  stats: { AC: 13, CHA: 15, SV_MAGIC: 20, WEIGHT: 1 }
})

const ALL = [THELVORN, CROWN, CLUB]

/** "Tier 2   3 / 4" — the owner screenshot every phase-0 number in this repo is verified against. */
const CHECKPOINT: ItemUpgradeState = { full: 2, fraction: 3 }

function filters(over: Partial<GearFilters> = {}): GearFilters {
  return { ...DEFAULT_GEAR_FILTERS, eraOnly: false, ...over }
}

const names = (rows: readonly GearRow[]): string[] => rows.map((r) => r.name)

test('parseGearQuery lifts threshold tokens out and leaves the words as ONE needle', () => {
  assert.deepEqual(parseGearQuery('blade of light'), { needle: 'blade of light', thresholds: [] })
  assert.deepEqual(parseGearQuery('ac>=20'), { needle: '', thresholds: [{ key: 'AC', op: '>=', value: 20 }] })
  assert.deepEqual(parseGearQuery('club haste>5'), {
    needle: 'club',
    thresholds: [{ key: 'HASTE', op: '>', value: 5 }]
  })
  // The underscore-free fold and the derived keys are both real spellings.
  assert.deepEqual(parseGearQuery('svmagic>=20').thresholds, [{ key: 'SV_MAGIC', op: '>=', value: 20 }])
  assert.deepEqual(parseGearQuery('sv_magic>=20').thresholds, [{ key: 'SV_MAGIC', op: '>=', value: 20 }])
  assert.deepEqual(parseGearQuery('ratio>=0.7 bis>1 eff_dmg>2 effhp>=10').thresholds, [
    { key: 'RATIO', op: '>=', value: 0.7 },
    { key: 'BIS', op: '>', value: 1 },
    { key: 'EFF_DMG', op: '>', value: 2 },
    { key: 'EFF_HP', op: '>=', value: 10 }
  ])
  // The displayed word is a spelling too: the header says BEST (columnLabel), so `best` parses.
  assert.deepEqual(parseGearQuery('best>1').thresholds, [{ key: 'BIS', op: '>', value: 1 }])
  // A token that LOOKS like a threshold but names no key stays a WORD.
  assert.deepEqual(parseGearQuery('foo>=3'), { needle: 'foo>=3', thresholds: [] })
  assert.deepEqual(parseGearQuery('weight<2.5').thresholds, [{ key: 'WEIGHT', op: '<', value: 2.5 }])
})

test('a threshold filters on the SCALED number, and absent fails every operator (law 1)', () => {
  // At base, Thelvorn's ratio is 20/26 ≈ 0.769 — `ratio>=0.75` keeps it and drops the Club's 5/30.
  assert.deepEqual(names(filterGearRows(ALL, filters({ text: 'ratio>=0.75' }))), ['Thelvorn, Blade of Light'])

  // Scaled at the checkpoint, DMG grows and DELAY does not, so a floor the base ratio misses is
  // reached — which is why the pipeline filters AFTER it scales.
  const scaled = scaleAll(ALL, CHECKPOINT)
  assert.ok(
    filterGearRows(scaled, filters({ text: 'ratio>=0.9' })).some((r) => r.name === 'Thelvorn, Blade of Light'),
    'the +N ratio answers the threshold'
  )

  // ABSENT FAILS `<` TOO: the Crown states no HASTE, and "less than 41% haste" is not a fact about
  // an item that said nothing. Only the Club, which STATES a haste, answers.
  assert.deepEqual(names(filterGearRows(ALL, filters({ text: 'haste<41' }))), ['Wooden Club'])

  // Words and thresholds compose in one box, ANDed.
  assert.deepEqual(names(filterGearRows(ALL, filters({ text: 'club haste>=10' }))), ['Wooden Club'])
  assert.deepEqual(names(filterGearRows(ALL, filters({ text: 'thelvorn haste>=10' }))), [])
})

test('SHIELD is a pick in the Weapon type control (2026-08-15 ruling), and it unions like one', () => {
  const SHIELD = row({
    key: 'polished steel shield',
    name: 'Polished Steel Shield',
    slots: ['SECONDARY'],
    stats: { AC: 15 }
  })
  // A "Shield of…" name OFF the secondary slot is not a shield — the slot gate half of the rule.
  const CLOAK = row({ key: 'shield of winter', name: 'Shield of Winter', slots: ['BACK'], stats: { AC: 5 } })
  assert.equal(isShieldLike(SHIELD), true)
  assert.equal(isShieldLike(CLOAK), false)
  assert.equal(isShieldLike(CLUB), false, 'a SECONDARY item with a plain name is not a shield')
  assert.equal(isShieldLike({ ...CLUB, skill: 'Shield' }), true, 'a stated Skill: Shield line is')

  const pool = [...ALL, SHIELD, CLOAK]
  assert.deepEqual(names(filterGearRows(pool, filters({ weaponTypes: ['shield'] }))), ['Polished Steel Shield'])
  // …and it UNIONS inside the control, exactly as the categories do: shields OR one-handers.
  assert.deepEqual(names(filterGearRows(pool, filters({ weaponTypes: ['ONE_HAND', 'shield'] }))).sort(), [
    'Polished Steel Shield',
    'Thelvorn, Blade of Light',
    'Wooden Club'
  ])
  // An empty pick list is no filter at all — the standing rule for every field.
  assert.equal(filterGearRows(pool, filters()).length, pool.length)
})

test('IGNORE HASTE drops the haste term from EFF DMG and BIS, and only that term', () => {
  // The Club states HASTE 10 — counted, its damage score clears the no-haste reading; ignored,
  // the two readings are exactly one weighted haste term apart, computed through the same door.
  const counted = filterGearRows(ALL, filters({ text: 'effdmg>3' }))
  assert.ok(names(counted).includes('Wooden Club'), 'haste counts by default')
  const ignored = filterGearRows(ALL, filters({ text: 'effdmg>3', ignoreHaste: true }))
  assert.ok(!names(ignored).includes('Wooden Club'), 'the ignore flag reaches the threshold too')
  assert.ok(names(ignored).includes('Thelvorn, Blade of Light'), 'a no-haste weapon is untouched')
})
