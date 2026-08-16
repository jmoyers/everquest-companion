// THE GEAR AREA'S FORM MEMORY — the restart split, and what every stored key does when the value
// it reads back is rubbish (JOS-329).
//
// WHY THIS FILE EXISTS. The ticket persists eleven new fields across four tabs — thirteen now that
// the progression planner's Plan tab keeps a role and a reach — and every one of them reads from a
// store the user can edit, a previous build can have written, and a crash can have truncated.
// `gearPrefs.ts` set the rule the whole area now follows — A STORED VALUE DEGRADES, IT NEVER ERRORS
// (JOS-105) — and the only way that rule stays true across thirteen keys is if each one is driven
// through its garbage cases by something that runs in a millisecond.
//
// WHAT IS ASSERTED, in one sentence per claim:
//
//   1. THE SPLIT IS DATA. `AREA_FORM_TIER` is the ONE statement of which fields survive a restart,
//      so the test reads it as a table rather than re-asserting the rule per call site: every
//      search key is `session`, every structural key is `restart`, and there is no third tier.
//   2. GARBAGE IN, DEFAULTS OUT — for every stored key, over one shared corpus of hostile values
//      (`GARBAGE`), so the NEXT key added without a sanitizer cannot quietly pass by being
//      forgotten: it has to be added to a table here to be covered.
//   3. A GOOD VALUE SURVIVES INTACT, which is the half a "never throws" test can accidentally
//      satisfy by returning the default for everything.
//   4. THE THREE DISTINCTIONS THAT ARE EASY TO ERASE, each of which is a real bug if it goes:
//      absent-vs-pinned-empty on the gear class filter, `null`-as-"All slots" on the browse form,
//      and era's default being ON rather than the `false` a naive `=== true` would produce.
//   5. THE SLIDER IS VALIDATED BY `normalizeUpgradeState` AND NOTHING ELSE — the overridden law
//      (gearData.ts) persists a control whose vocabulary is 1,024 states, so an out-of-range store
//      has to come back as a REACHABLE state rather than as a number the scaler will believe.
//
// Pure model only: `areaMemory.ts` touches no React, no storage and no IPC, so it runs under the
// node runner like `gearPrefs` and `gearFilter` before it. Nothing here mounts a component — the
// away-and-back behaviour those keys exist FOR is an e2e claim (gear/planner/character specs), and
// a unit test of the read passing while the feature stays broken is exactly what the JOS-90 law
// warns about.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLASS_ABBRS, MAX_COMBO_SLOTS } from '../src/shared/classCombo'
import { ITEM_UPGRADE_BASE, normalizeUpgradeState } from '../src/shared/itemUpgrade'
import { ITEM_MAX_TIER } from '../src/shared/itemStats'
import { EQUIP_SLOTS } from '../src/shared/planner/types'
import { WEAPON_PICKS } from '../src/shared/planner/weaponType'
import { DEFAULT_GEAR_FILTERS, DEFAULT_GEAR_SORT } from '../src/renderer/src/features/gear/gearFilter'
import { PICKABLE_COLUMNS } from '../src/renderer/src/features/gear/gearColumns'
import {
  AREA_FORM_TIER,
  DEFAULT_GEAR_FORM,
  MAX_REMEMBERED_GROUPS,
  MAX_REMEMBERED_SEARCH,
  sanitizeBrowseForm,
  sanitizeFlag,
  sanitizeGearClasses,
  sanitizeGearForm,
  sanitizeGearSort,
  sanitizeItemFocus,
  sanitizeOpenGroups,
  sanitizePlanReach,
  sanitizePlanRole,
  sanitizeSearch,
  sanitizeUpgrade,
  tierOf,
  PLAN_REACHES,
  PLAN_ROLES,
  type AreaFormKey,
  type BrowseFormMemory
} from '../src/renderer/src/features/gear/areaMemory'

/**
 * EVERY SHAPE A STORE CAN HAND BACK THAT IS NOT WHAT WAS ASKED FOR.
 *
 * `undefined` and `null` are the absent cases (a missing key parses to `null` in `useAreaMemory`);
 * the rest are what a hand-edited file, a schema change or a half-written value looks like. The
 * numbers include the two that break naive arithmetic, because the slider's sanitizer does some.
 */
const GARBAGE: readonly unknown[] = [
  undefined,
  null,
  0,
  1,
  -1,
  NaN,
  Infinity,
  '',
  'nonsense',
  '{}',
  true,
  false,
  [],
  [1, 2, 3],
  ['nope'],
  {},
  { unrelated: 'key' },
  { length: 3 },
  [[]],
  [{}]
]

/** The browse form's fallback, spelled here rather than imported: `plannerData` is a React module. */
const BROWSE_FALLBACK: BrowseFormMemory = { socket: 'proc', slot: null, trioOnly: true }

// ============================================================================================
// 1. THE SPLIT IS DATA
// ============================================================================================

test('the restart split is a table, and every key in it is on one of exactly two tiers', () => {
  const keys = Object.keys(AREA_FORM_TIER) as AreaFormKey[]
  // Eleven fields arrived with JOS-329; the progression planner's two picks (`eq.plan.role`,
  // `eq.plan.reach`) make thirteen. The number is here so a key added without a row in `READERS`
  // below fails TWICE — once on the count, once on the coverage sweep.
  assert.equal(keys.length, 13, 'thirteen fields are stored — update this test when a fourteenth is')
  for (const key of keys) {
    const tier = tierOf(key)
    assert.ok(tier === 'restart' || tier === 'session', `${key} is on an unknown tier ${tier}`)
  }
})

test('WHAT YOU TYPED IS SESSION-SCOPED — every search box, on all four tabs', () => {
  const typed: AreaFormKey[] = [
    'eq.gear.search',
    'eq.planner.search',
    'eq.wishlist.search',
    'eq.character.search'
  ]
  for (const key of typed) assert.equal(tierOf(key), 'session', `${key} must not outlive the session`)
  // …and the two narrowings that are reached BY typing ride with them (areaMemory's header argues
  // the item picker; the expanded set is ephemeral navigation state).
  assert.equal(tierOf('eq.planner.item'), 'session')
  assert.equal(tierOf('eq.planner.open'), 'session')
})

test('WHAT YOU CHOSE IS RESTART-SCOPED — including the slider, whose old law said otherwise', () => {
  const chosen: AreaFormKey[] = [
    'eq.gear.filters',
    'eq.gear.sort',
    'eq.gear.classes',
    'eq.gear.upgrade',
    'eq.planner.filters',
    // The Plan tab's two picks. Neither is typed and neither is poked out of a list — they are the
    // shape you gave the route, so they come back next launch like every other closed-vocabulary
    // pick in this area.
    'eq.plan.role',
    'eq.plan.reach'
  ]
  for (const key of chosen) assert.equal(tierOf(key), 'restart', `${key} must survive a restart`)
})

// ============================================================================================
// 2. GARBAGE IN, DEFAULTS OUT — every key, over the same hostile corpus
// ============================================================================================

/**
 * One row per stored key: how to read it, what an unusable value must produce, and — for the two
 * kinds of field that HAVE no vocabulary — which members of `GARBAGE` are not actually garbage
 * for them.
 *
 * `legal` is an admission rather than an escape hatch, and it is why the corpus can stay shared. A
 * search box stores free text, so `'nonsense'` is a perfectly good stored search and reading it
 * back verbatim is the correct behaviour, not a validation failure; the same is true of a list of
 * opaque group ids. Every OTHER reader has a closed vocabulary and no exemptions at all, which is
 * exactly the property this table makes visible.
 *
 * Driving the table rather than writing thirteen near-identical tests is what makes "a new key must
 * be covered" a mechanical requirement instead of a habit.
 */
interface Reader {
  key: AreaFormKey
  read: (raw: unknown) => unknown
  fallback: unknown
  /** raw values that are VALID input for this reader, so the fallback assertion does not apply */
  legal?: (raw: unknown) => boolean
}

/** Free text: any string is a search somebody could have typed. */
const anyString = (raw: unknown): boolean => typeof raw === 'string'

/** Opaque ids: any array holding at least one non-empty string is a real expanded set. */
const anyIdList = (raw: unknown): boolean =>
  Array.isArray(raw) && (raw as unknown[]).some((v) => typeof v === 'string' && v !== '')

const READERS: Reader[] = [
  { key: 'eq.gear.filters', read: sanitizeGearForm, fallback: DEFAULT_GEAR_FORM },
  { key: 'eq.gear.sort', read: sanitizeGearSort, fallback: DEFAULT_GEAR_SORT },
  { key: 'eq.gear.classes', read: sanitizeGearClasses, fallback: null },
  { key: 'eq.gear.upgrade', read: sanitizeUpgrade, fallback: ITEM_UPGRADE_BASE },
  { key: 'eq.gear.search', read: sanitizeSearch, fallback: '', legal: anyString },
  { key: 'eq.planner.filters', read: (r) => sanitizeBrowseForm(r, BROWSE_FALLBACK), fallback: BROWSE_FALLBACK },
  { key: 'eq.planner.item', read: sanitizeItemFocus, fallback: null },
  { key: 'eq.planner.open', read: sanitizeOpenGroups, fallback: [], legal: anyIdList },
  { key: 'eq.planner.search', read: sanitizeSearch, fallback: '', legal: anyString },
  { key: 'eq.wishlist.search', read: sanitizeSearch, fallback: '', legal: anyString },
  { key: 'eq.character.search', read: sanitizeSearch, fallback: '', legal: anyString },
  // The Plan tab's two picks. Both are closed vocabularies, so both take NO `legal` exemption:
  // 'nonsense' is not a role, and the fallback is the fold's own default in each case.
  { key: 'eq.plan.role', read: sanitizePlanRole, fallback: 'balanced' },
  { key: 'eq.plan.reach', read: sanitizePlanReach, fallback: 'solo' }
]

test('every stored key has a reader in this file — a new key cannot be covered by being forgotten', () => {
  const covered = new Set(READERS.map((r) => r.key))
  for (const key of Object.keys(AREA_FORM_TIER)) {
    assert.ok(covered.has(key as AreaFormKey), `${key} has no load-validation test`)
  }
})

test('garbage in localStorage falls back to the default, for every key, and never throws', () => {
  for (const { key, read, fallback, legal } of READERS) {
    for (const bad of GARBAGE) {
      const label = `${key} on ${typeof bad === 'undefined' ? 'undefined' : JSON.stringify(bad)}`
      let got: unknown
      assert.doesNotThrow(() => {
        got = read(bad)
      }, `${label} threw`)
      if (legal?.(bad) === true) continue
      assert.deepEqual(got, fallback, `${label} did not default`)
    }
  }
})

test('…and the readers with a closed vocabulary take NO exemptions from that sweep', () => {
  // The counterweight to `legal`: if somebody adds an exemption to a structural key to make a red
  // test green, this fails. Only free-text and opaque-id fields may be exempt, and there are five.
  const exempt = READERS.filter((r) => r.legal !== undefined).map((r) => r.key)
  assert.deepEqual(exempt.sort(), [
    'eq.character.search',
    'eq.gear.search',
    'eq.planner.open',
    'eq.planner.search',
    'eq.wishlist.search'
  ])
})

// ============================================================================================
// 3. A GOOD VALUE SURVIVES INTACT
// ============================================================================================

test('a well-formed gear form round-trips, and unknown members drop out rather than blanking it', () => {
  const stored = {
    slots: ['PRIMARY', 'SECONDARY', 'NOT_A_SLOT', 'PRIMARY'],
    weaponTypes: [WEAPON_PICKS[0], 'imaginary'],
    effect: 'proc',
    eraOnly: false,
    ownedOnly: true
  }
  const got = sanitizeGearForm(stored)
  assert.deepEqual(got.slots, ['PRIMARY', 'SECONDARY'], 'unknown slot dropped, duplicate dropped, order kept')
  assert.deepEqual(got.weaponTypes, [WEAPON_PICKS[0]])
  assert.equal(got.effect, 'proc')
  assert.equal(got.eraOnly, false)
  assert.equal(got.ownedOnly, true)
})

test('a partial gear form keeps its siblings — one bad field is not a bad form', () => {
  const got = sanitizeGearForm({ slots: ['HEAD'], effect: 'made up', ownedOnly: 'yes please' })
  assert.deepEqual(got.slots, ['HEAD'], 'the readable field survived')
  assert.equal(got.effect, DEFAULT_GEAR_FORM.effect, 'the unreadable one defaulted')
  assert.equal(got.ownedOnly, DEFAULT_GEAR_FORM.ownedOnly)
  assert.equal(got.eraOnly, DEFAULT_GEAR_FORM.eraOnly, 'and an absent one defaulted too')
})

test('a stored sort round-trips, and each half defaults independently of the other', () => {
  const key = PICKABLE_COLUMNS[0]
  assert.deepEqual(sanitizeGearSort({ key, dir: 'asc' }), { key, dir: 'asc' })
  assert.deepEqual(sanitizeGearSort({ key: 'name', dir: 'asc' }), { key: 'name', dir: 'asc' })
  // A key this build dropped must not leave a lit header on a column that is not drawn.
  assert.deepEqual(sanitizeGearSort({ key: 'RETIRED_STAT', dir: 'asc' }), {
    key: DEFAULT_GEAR_SORT.key,
    dir: 'asc'
  })
  assert.deepEqual(sanitizeGearSort({ key, dir: 'sideways' }), { key, dir: DEFAULT_GEAR_SORT.dir })
})

test('a stored browse form round-trips, including the socket tab and the trio toggle', () => {
  const got = sanitizeBrowseForm({ socket: 'focus', slot: 'HEAD', trioOnly: false }, BROWSE_FALLBACK)
  assert.deepEqual(got, { socket: 'focus', slot: 'HEAD', trioOnly: false })
})

test('a stored item narrowing round-trips, and unknown slots or classes widen it rather than break it', () => {
  const got = sanitizeItemFocus({
    key: 'batfang headband',
    name: 'Batfang Headband',
    slots: ['HEAD', 'NOT_A_SLOT'],
    classes: [CLASS_ABBRS[0], 'XYZ']
  })
  assert.deepEqual(got, {
    key: 'batfang headband',
    name: 'Batfang Headband',
    slots: ['HEAD'],
    classes: [CLASS_ABBRS[0]]
  })
  // A focus with no key or no name is not a narrowing anybody can see or clear — it is dropped.
  assert.equal(sanitizeItemFocus({ key: '', name: 'x' }), null)
  assert.equal(sanitizeItemFocus({ key: 'x', name: '' }), null)
  assert.equal(sanitizeItemFocus({ name: 'no key' }), null)
})

test('the expanded-group set keeps its ids, deduped, and is bounded', () => {
  assert.deepEqual(sanitizeOpenGroups(['a', 'b', 'a', '', 7, 'c']), ['a', 'b', 'c'])
  const many = Array.from({ length: MAX_REMEMBERED_GROUPS + 50 }, (_, i) => `g${String(i)}`)
  assert.equal(sanitizeOpenGroups(many).length, MAX_REMEMBERED_GROUPS)
})

test('a search string survives and is bounded — the one field with no vocabulary to check', () => {
  assert.equal(sanitizeSearch('thelvorn'), 'thelvorn')
  // Whitespace is NOT trimmed: the box echoes what was typed, and the filter does its own trimming.
  assert.equal(sanitizeSearch('  spaced  '), '  spaced  ')
  assert.equal(sanitizeSearch('x'.repeat(MAX_REMEMBERED_SEARCH + 500)).length, MAX_REMEMBERED_SEARCH)
})

// ============================================================================================
// 4. THE THREE DISTINCTIONS THAT ARE EASY TO ERASE
// ============================================================================================

test('ABSENT IS NOT PINNED-EMPTY on the gear class filter — the whole reason it has its own key', () => {
  // Absent ⇒ FOLLOWING detection. The Gear tab opens narrowed to whatever the app infers.
  assert.equal(sanitizeGearClasses(null), null)
  assert.equal(sanitizeGearClasses({}), null, 'an object with no `classes` has said nothing')
  // Present-but-empty ⇒ PINNED to nothing, i.e. "read the whole corpus". A different statement, and
  // one a `?? []` or a truthiness test would silently turn back into "follow detection".
  assert.deepEqual(sanitizeGearClasses({ classes: [] }), [])
  assert.notEqual(sanitizeGearClasses({ classes: [] }), null)
})

test('…and a pinned trio is filtered to the closed allowlist and capped at the combo width', () => {
  const tooMany = [...CLASS_ABBRS].slice(0, MAX_COMBO_SLOTS + 2)
  assert.equal(sanitizeGearClasses({ classes: tooMany })?.length, MAX_COMBO_SLOTS)
  assert.deepEqual(sanitizeGearClasses({ classes: ['PAL', 'NOPE', 'PAL'] }), ['PAL'])
})

test('`null` IS AN ANSWER on the browse slot — "All slots", not a failure to parse', () => {
  const withSlot: BrowseFormMemory = { socket: 'proc', slot: 'HEAD', trioOnly: true }
  assert.equal(sanitizeBrowseForm({ socket: 'proc', slot: null, trioOnly: true }, withSlot).slot, null)
  // …while an unrecognised slot falls back to whatever the caller had, rather than to `null`.
  assert.equal(sanitizeBrowseForm({ socket: 'proc', slot: 'ELBOW', trioOnly: true }, withSlot).slot, 'HEAD')
  assert.ok(EQUIP_SLOTS.includes('HEAD'), 'the fixture slot is a real one')
})

test('ERA DEFAULTS ON — an unreadable toggle must not silently unfilter the corpus', () => {
  assert.equal(DEFAULT_GEAR_FILTERS.eraOnly, true, 'the shipped default this claim rests on')
  assert.equal(sanitizeGearForm({ eraOnly: 'true' }).eraOnly, true, 'a string is not a boolean, so: default')
  assert.equal(sanitizeGearForm({ eraOnly: 1 }).eraOnly, true)
  assert.equal(sanitizeGearForm({ eraOnly: false }).eraOnly, false, 'and a real `false` is still honoured')
  // The primitive itself, both directions — `sanitizeFlag` is the only reason era and owned can
  // have opposite defaults and share one reader.
  assert.equal(sanitizeFlag(undefined, true), true)
  assert.equal(sanitizeFlag(undefined, false), false)
})

// ============================================================================================
// 5. THE SLIDER — validated by normalizeUpgradeState and nothing else (the overridden law)
// ============================================================================================

test('a stored plus-state comes back as a REACHABLE state, whatever the store says', () => {
  // The owner's checkpoint, the state every phase-0 number in this repo is verified against.
  assert.deepEqual(sanitizeUpgrade({ full: 2, fraction: 3 }), { full: 2, fraction: 3 })

  // Past the cap in both directions. `full` clamps to the tier range; `fraction` clamps to that
  // tier's own denominator, which is 2^full - 1 and is why a fixed bound would be wrong.
  assert.deepEqual(sanitizeUpgrade({ full: 99, fraction: 5 }), { full: ITEM_MAX_TIER, fraction: 0 })
  assert.deepEqual(sanitizeUpgrade({ full: -4, fraction: 9 }), ITEM_UPGRADE_BASE)
  assert.deepEqual(sanitizeUpgrade({ full: 3, fraction: 900 }), { full: 3, fraction: 2 ** 3 - 1 })
  assert.deepEqual(sanitizeUpgrade({ full: 3, fraction: -9 }), { full: 3, fraction: 0 })

  // Non-finite numbers are the case that reaches the scaler as a NaN vector if it is not caught
  // here — `normalizeUpgradeState`'s `|| 0` handles NaN but not Infinity, so this file handles it.
  assert.deepEqual(sanitizeUpgrade({ full: Infinity, fraction: 0 }), ITEM_UPGRADE_BASE)
  assert.deepEqual(sanitizeUpgrade({ full: 2, fraction: NaN }), ITEM_UPGRADE_BASE)
  assert.deepEqual(sanitizeUpgrade({ full: '2', fraction: '3' }), ITEM_UPGRADE_BASE, 'strings are not a state')
})

test('…and the sanitizer is `normalizeUpgradeState` rather than a second opinion about tiers', () => {
  // Asserted as an IDENTITY over the whole reachable range plus its edges, so this file can never
  // drift from the one function that owns the rule (tests/itemUpgrade.test.mts pins THAT).
  for (let full = 0; full <= ITEM_MAX_TIER; full++) {
    for (const fraction of [0, 1, 2 ** full - 1, 2 ** full, 5000]) {
      assert.deepEqual(
        sanitizeUpgrade({ full, fraction }),
        normalizeUpgradeState({ full, fraction }),
        `tier ${String(full)} + ${String(fraction)}`
      )
    }
  }
})

test('the Plan tab`s two picks round-trip, and their vocabularies come from the fold`s own unions', () => {
  // EVERY member of each vocabulary survives, which is the half a "garbage defaults" sweep cannot
  // see: a sanitizer that returned its fallback for everything would pass that test and silently
  // pin every player to a balanced solo route.
  for (const role of PLAN_ROLES) assert.equal(sanitizePlanRole(role), role)
  for (const reach of PLAN_REACHES) assert.equal(sanitizePlanReach(reach), reach)

  // The vocabularies themselves are the fold`s, not a second list: `progressionPlan.ts` exports no
  // runtime spelling of `GearRole`, so `areaMemory.ts` derives one from a `Record` the compiler
  // checks. Pinned here so a role added to the union and forgotten in that record goes red.
  assert.deepEqual(
    [...PLAN_ROLES].sort(),
    ['balanced', 'dd', 'dot', 'dps', 'dps1h', 'dps2h', 'dualwield', 'healer', 'tank']
  )
  assert.deepEqual([...PLAN_REACHES].sort(), ['group', 'solo'])

  // A value from a build that spelled it differently DEGRADES to the shipped default rather than
  // reaching the fold, which would read it as a role with no weights table (JOS-105).
  assert.equal(sanitizePlanRole('TANK'), 'balanced', 'the vocabulary is case-sensitive')
  assert.equal(sanitizePlanReach('duo'), 'solo', 'a reach nobody measured is not a reach')
})

test('the 2026-08-15 role widening did not evict a pick anybody already had stored', () => {
  // THE COMPATIBILITY CLAIM, pinned rather than asserted in a comment. `dps` was in the shipped
  // vocabulary before the widening and is in this machine`s `eq.plan.role` right now; renaming it to
  // something tidier (`dpsAny`) would have had the sanitizer answer `balanced` for the owner`s own
  // stored pick the first time he opened the tab. The four pre-widening spellings still round-trip.
  for (const stored of ['balanced', 'tank', 'dps', 'healer']) {
    assert.equal(sanitizePlanRole(stored), stored, `a stored ${stored} still reads as itself`)
  }

  // …and every NEW spelling round-trips too, which is the half that proves the widening reached the
  // sanitizer rather than only the union.
  for (const added of ['dps1h', 'dps2h', 'dualwield', 'dd', 'dot']) {
    assert.equal(sanitizePlanRole(added), added)
  }

  // Near-misses are still not roles. The vocabulary grew; it did not become fuzzy.
  assert.equal(sanitizePlanRole('1h'), 'balanced')
  assert.equal(sanitizePlanRole('dual-wield'), 'balanced')
  assert.equal(sanitizePlanRole('DoT'), 'balanced')
})
