// THE PLAN FOLD'S ADMISSION RULE AND ITS ZONE-FIRST SHAPE — the two changes the owner's live testing
// forced on 2026-08-15 (docs/plans/gear-progression-planner.md §1; the module is
// src/shared/planner/progressionPlan.ts, rules 7-9 in its header).
//
// A SEPARATE FILE FROM `progressionPlan.test.mts`, on the `gearEffectiveHp.test.mts` precedent: that
// file owns the ROUTE model (brackets, the con gate, era, the +N rules, the horizon) and is at this
// tree's 400-code-line factoring ceiling. What is here is a subject of its own — WHICH ITEMS GET IN,
// and HOW THEY ARE GROUPED — and it carries its own smaller corpus rather than reaching into that
// file's, so each claim is pinned against fixtures shaped for it alone.
//
// WHAT IS PINNED:
//   1. ADMISSION IS AN UPGRADE GAP. An absent slot bar is a GAP and admits anything wearable; an
//      item that does not STRICTLY beat its slot's bar is out however high it scores; a multi-slot
//      item is judged on its best home.
//   2. A WISHED ITEM IS FLAGGED, NOT FILTERED — it bypasses the gap test and sorts first.
//   3. RUNS. A +N run groups separately from its base zone; THE BURIAL CASE (a low-scoring Refined
//      run still gets its line beside raid loot — the bug this shape exists for); the two caps; run
//      ordering; and that `targets` and `runs` are two views of one admitted pool.
//
// SYNTHETIC, like its sibling: the con table is written here, the zone NAMES are real spellings
// because the era layer is real code, and every level, membership and witness is invented.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConBand } from '../src/shared/conBands'
import type { GearRow } from '../src/shared/planner/gear'
import {
  buildProgressionPlan,
  roleValue,
  type PlanBracket,
  type PlanCorpora,
  type PlanInputs
} from '../src/shared/planner/progressionPlan'
import { zoneLevelKey, type ZoneLevels } from '../src/shared/planner/zoneLevels'

// =================================================================================================
// FIXTURES — synthetic, see the header
// =================================================================================================

/**
 * The same five-band table its sibling suite uses, written out rather than shared: one file, one
 * corpus, and a reader never has to open another test to learn what `safe` means here.
 */
function con(myLevel: number, mobLevel: number): ConBand {
  const diff = mobLevel - myLevel
  if (diff <= -6) return 'trivial'
  if (diff <= -1) return 'safe'
  if (diff <= 1) return 'even'
  if (diff <= 4) return 'risky'
  return 'deadly'
}

function profiles(...rows: ZoneLevels[]): ReadonlyMap<string, ZoneLevels> {
  return new Map(rows.map((r) => [zoneLevelKey(r.zone), r]))
}

/** Three real zone spellings, all of them classic so nothing here is accidentally an era test. */
const PROFILES = profiles(
  { zone: 'Crushbone', low: 8, median: 12, sampled: 40 },
  { zone: 'Befallen', low: 12, median: 20, sampled: 30 },
  { zone: 'Najena', low: 20, median: 26, sampled: 25 }
)

const MOB_LEVELS = new Map<string, number>([
  ['a young kobold', 14],
  ['a deep guardian', 21],
  ['a shadowed one', 60],
  ['Ixiblat Fer', 55]
])
const mobLevel = (name: string): number | null => MOB_LEVELS.get(name) ?? null

function row(over: Partial<GearRow> & Pick<GearRow, 'key' | 'name'>): GearRow {
  return {
    searchKey: over.name.toLowerCase(),
    slots: ['CHEST'],
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

/** The high scorer, and the one whose CHEST bar the gap tests raise. */
const PLATE = row({
  key: 'plate of the sentinel',
  name: 'Plate of the Sentinel',
  classes: ['WAR', 'PAL'],
  stats: { AC: 30, HP: 60, STA: 10 },
  wikiSources: [{ mob: 'a young kobold', zone: 'Crushbone' }]
})
const BLADE = row({
  key: 'blade of haste',
  name: 'Blade of Haste',
  slots: ['PRIMARY'],
  classes: ['WAR', 'ROG'],
  skill: '1H Slashing',
  stats: { DMG: 20, DELAY: 24, STR: 8, DEX: 6 },
  wikiSources: [{ mob: 'a young kobold', zone: 'Crushbone' }]
})
/** Its page states NO classes — UNKNOWN, never "nobody" — and it is a feeble FINGER row besides. */
const ORPHAN = row({
  key: 'nameless band',
  name: 'Nameless Band',
  slots: ['FINGER'],
  classes: [],
  stats: { AC: 5 },
  wikiSources: [{ mob: 'a young kobold', zone: 'Crushbone' }]
})
/** A weak NECK row, so "a gap admits anything wearable" has something feeble to admit. */
const GREY = row({
  key: 'tarnished bauble',
  name: 'Tarnished Bauble',
  slots: ['NECK'],
  classes: ['WAR'],
  stats: { AC: 6 },
  wikiSources: [{ mob: 'a young kobold', zone: 'Crushbone' }]
})
/** Level 21 dropper — lands in the SECOND bracket, which is where the base-run band is read. */
const DEEP = row({
  key: 'deep guard shield',
  name: 'Deep Guard Shield',
  slots: ['SECONDARY'],
  classes: ['WAR'],
  stats: { AC: 12 },
  wikiSources: [{ mob: 'a deep guardian', zone: 'Befallen' }]
})
/** THE TIER ON THE ZONE, and THE TIER ON THE MOB — two Najena runs, and neither of them is base. */
const TIER_CLOAK = row({
  key: 'refined cloak',
  name: 'Refined Cloak',
  slots: ['BACK'],
  classes: ['WAR'],
  stats: { AC: 14 },
  wikiSources: [{ mob: 'a shadowed one', zone: 'Najena +4' }]
})
const TIER_RING = row({
  key: 'fused ring',
  name: 'Fused Ring',
  slots: ['FINGER'],
  classes: ['WAR'],
  stats: { AC: 9 },
  wikiSources: [{ mob: 'Ixiblat Fer +5', zone: 'Najena' }]
})
/**
 * DELIBERATELY WORTHLESS. It fails any upgrade bar you set, and it is the fixture the wish-list flag
 * is proved on: the user asked for it, so the route takes them there anyway.
 */
const WISHED_LOW = row({
  key: 'chipped talisman',
  name: 'Chipped Talisman',
  slots: ['NECK'],
  classes: ['WAR'],
  stats: { AC: 1 },
  wikiSources: [{ mob: 'a young kobold', zone: 'Crushbone' }]
})
/** Two slots, so "beats the bar in AT LEAST ONE of them" has something to be tested on. */
const TWO_SLOT = row({
  key: 'band of two homes',
  name: 'Band of Two Homes',
  slots: ['FINGER', 'NECK'],
  classes: ['WAR'],
  stats: { AC: 10 },
  wikiSources: [{ mob: 'a young kobold', zone: 'Crushbone' }]
})

const GEAR = [PLATE, BLADE, ORPHAN, GREY, DEEP, TIER_CLOAK, TIER_RING]

function corpora(over: Partial<PlanCorpora> = {}): PlanCorpora {
  return {
    gear: GEAR,
    profiles: PROFILES,
    mobLevel,
    con,
    owned: new Set(),
    wished: new Set(),
    // EVERY SLOT A GAP by default — the baseline, so a claim about runs is never quietly also a
    // claim about the upgrade gate.
    ownedBestBySlot: new Map(),
    ...over
  }
}

function inputs(over: Partial<PlanInputs> = {}): PlanInputs {
  return { level: 13, classes: ['WAR', 'PAL', 'ROG'], role: 'balanced', reach: 'solo', eraOnly: false, ...over }
}

const names = (b: PlanBracket): string[] => b.targets.map((t) => t.name)

// =================================================================================================
// 1. ADMISSION IS AN UPGRADE GAP, NOT A RANKING (owner, 2026-08-15)
// =================================================================================================

test('an EMPTY slot bar is a GAP, and a gap admits anything the trio can wear', () => {
  // Nothing owned anywhere, so even the weakest rows are upgrades. Absent is the ownership data
  // declining to name an item, not a claim that an item worth 0 is sitting in the slot.
  const route = buildProgressionPlan(inputs(), corpora())
  const keys = route.flatMap((b) => b.targets.map((t) => t.key))
  assert.equal(keys.includes('nameless band'), true, 'AC 5 in an empty FINGER is still an upgrade')
  assert.equal(keys.includes('tarnished bauble'), true, 'AC 6 in an empty NECK likewise')

  // AND AN ABSENT MAP IS EVERY SLOT ABSENT — the optional field's default, which is what lets a
  // caller that has not built its ownership fold yet keep getting the pre-rule answer.
  const noMap = corpora()
  delete (noMap as { ownedBestBySlot?: unknown }).ownedBestBySlot
  assert.deepEqual(
    buildProgressionPlan(inputs(), noMap).flatMap(names),
    route.flatMap(names),
    'no bars at all reads exactly like all-gaps'
  )
})

test('an item that does not STRICTLY beat its slot bar is OUT, whatever it scores', () => {
  assert.equal(roleValue(PLATE.stats, 'balanced'), 95, 'the Plate tops its bracket on score')

  // A better CHEST is already worn: the top-scoring item in the whole corpus is not an upgrade, so
  // it is not a target. This is the entire point of the gap rule.
  const covered = buildProgressionPlan(inputs(), corpora({ ownedBestBySlot: new Map([['CHEST', 1000]]) }))
  assert.equal(covered.flatMap(names).includes('Plate of the Sentinel'), false)
  // …and its bracket-mates, whose slots are still gaps, are untouched.
  assert.equal(names(covered[0]).includes('Blade of Haste'), true)

  // STRICTLY: a tie is not an upgrade. 95 against a bar of 95 is out; against 94 it is in.
  const tied = buildProgressionPlan(inputs(), corpora({ ownedBestBySlot: new Map([['CHEST', 95]]) }))
  assert.equal(tied.flatMap(names).includes('Plate of the Sentinel'), false)
  const beaten = buildProgressionPlan(inputs(), corpora({ ownedBestBySlot: new Map([['CHEST', 94]]) }))
  assert.equal(names(beaten[0]).includes('Plate of the Sentinel'), true)
})

test('AT LEAST ONE slot has to have room — a two-slot item is judged on its best home', () => {
  // FINGER is covered, NECK is not: still an upgrade, because you would wear it on the neck.
  const oneOpen = buildProgressionPlan(
    inputs(),
    corpora({ gear: [TWO_SLOT], ownedBestBySlot: new Map([['FINGER', 1000]]) })
  )
  assert.deepEqual(names(oneOpen[0]), ['Band of Two Homes'])

  // BOTH covered: there is nowhere it improves anything, so it is not a target.
  const bothShut = buildProgressionPlan(
    inputs(),
    corpora({
      gear: [TWO_SLOT],
      ownedBestBySlot: new Map([
        ['FINGER', 1000],
        ['NECK', 1000]
      ])
    })
  )
  assert.deepEqual(bothShut.flatMap(names), [])
})

test('a WISHED item bypasses the gap, is FLAGGED, and sorts FIRST', () => {
  const wishing = corpora({
    gear: [PLATE, WISHED_LOW],
    wished: new Set(['chipped talisman']),
    // Every slot is covered by something enormous — nothing on earth passes the gap test here.
    ownedBestBySlot: new Map([
      ['CHEST', 9999],
      ['NECK', 9999]
    ])
  })
  const route = buildProgressionPlan(inputs(), wishing)

  // The Plate (95) is gone, as the gap rule says it must be. The Talisman (2) is NOT — the user
  // declared they want it, and that outranks a score the fold's own header calls invented.
  assert.deepEqual(names(route[0]), ['Chipped Talisman'])
  assert.equal(route[0].targets[0].wished, true)

  // AND IT SORTS FIRST even against something that beats it on every number, in the flat list and
  // inside its run alike — one comparator, no second opinion.
  const both = buildProgressionPlan(
    inputs(),
    corpora({ gear: [PLATE, WISHED_LOW], wished: new Set(['chipped talisman']) })
  )
  assert.deepEqual(names(both[0]), ['Chipped Talisman', 'Plate of the Sentinel'])
  assert.deepEqual(
    both[0].runs[0].targets.map((t) => t.name),
    ['Chipped Talisman', 'Plate of the Sentinel']
  )
  // Everything NOT on the list says so explicitly — `wished` is a boolean on every target, never an
  // absence a reader has to interpret.
  assert.deepEqual(both[0].targets.map((t) => t.wished), [true, false])
})

// =================================================================================================
// 2. RUNS — the zone-first shape the ask asked for
// =================================================================================================

test('a +N run groups SEPARATELY from its base zone — different trip, different band', () => {
  const route = buildProgressionPlan(inputs(), corpora())
  const najena = route[2].runs
  assert.deepEqual(
    najena.map((r) => [r.zone, r.plus]),
    [
      ['Najena', 4],
      ['Najena', 5]
    ],
    'one run per (zone, tier) — the +4 cloak and the +5 ring are different trips'
  )

  // BAND COHERENCE: a +N run states no band (rule 2 — nothing states how hard a tiered mob is), and
  // `plus` is what tells that silence apart from a base zone we simply have no profile for.
  assert.deepEqual(najena.map((r) => r.band), [null, null])
  for (const run of najena) {
    for (const target of run.targets) {
      assert.equal(target.plus, run.plus, 'every member carries its run’s tier')
      assert.equal(target.band, null)
      assert.equal(zoneLevelKey(target.zone), zoneLevelKey(run.zone))
    }
  }

  // A BASE run carries the zone-median band — the same reading `expZones` prints for that zone.
  const base = route[1].runs.find((r) => r.plus === null)!
  assert.equal(base.zone, 'Befallen')
  assert.equal(base.band, con(21, 20), 'the median at the bracket midpoint, and nothing invented')
})

test('THE BURIAL CASE: a low-scoring run still gets its line beside a rich one', () => {
  // The reported bug, in miniature (owner at 44, wearing a Splitpaw Refined axe): the Refined runs
  // he actually farms never crack a bracket-wide top eight against planes loot, so the feature's own
  // subject never rendered. A run earns its line by CONTAINING an upgrade, not by out-scoring one.
  const planes = row({
    key: 'breastplate of the raid',
    name: 'Breastplate of the Raid',
    classes: ['WAR'],
    stats: { AC: 200, HP: 300 },
    wikiSources: [{ mob: 'a young kobold', zone: 'Crushbone' }]
  })
  const junk = Array.from({ length: 9 }, (_, i) =>
    row({
      key: `planar trinket ${i}`,
      name: `Planar Trinket ${i}`,
      slots: ['FINGER'],
      classes: ['WAR'],
      stats: { AC: 150 - i },
      wikiSources: [{ mob: 'a young kobold', zone: 'Crushbone' }]
    })
  )
  const scraps = row({
    key: 'splitpaw axe',
    name: 'Splitpaw Axe',
    slots: ['PRIMARY'],
    classes: ['WAR'],
    stats: { AC: 3 },
    wikiSources: [{ mob: 'a gnoll pup', zone: 'Crushbone +4' }]
  })
  const route = buildProgressionPlan(inputs(), corpora({ gear: [planes, ...junk, scraps] }))

  // THE FLAT LIST BURIES IT — ten Crushbone rows outscore the axe and the cap-8 cuts it. That is the
  // bug, reproduced, and it is why `targets` alone could never answer the ask.
  assert.equal(names(route[0]).includes('Splitpaw Axe'), false)

  // THE RUNS DO NOT. Crushbone +4 is its own trip and gets its own line, whatever it scores.
  const tiered = route[0].runs.find((r) => r.plus === 4)
  assert.notEqual(tiered, undefined)
  assert.equal(tiered?.zone, 'Crushbone')
  assert.deepEqual(tiered?.targets.map((t) => t.name), ['Splitpaw Axe'])
})

test('runs cap their members at three and the bracket at six, and rank by their best member', () => {
  // Six rows in one zone: the run keeps the top three by the one comparator, and says so.
  const many = Array.from({ length: 6 }, (_, i) =>
    row({
      key: `crushbone relic ${i}`,
      name: `Crushbone Relic ${i}`,
      slots: ['FINGER'],
      classes: ['WAR'],
      stats: { AC: 10 + i },
      wikiSources: [{ mob: 'a young kobold', zone: 'Crushbone' }]
    })
  )
  const route = buildProgressionPlan(inputs(), corpora({ gear: many }))
  assert.equal(route[0].runs.length, 1)
  assert.deepEqual(
    route[0].runs[0].targets.map((t) => t.name),
    ['Crushbone Relic 5', 'Crushbone Relic 4', 'Crushbone Relic 3'],
    'top three by score; the rest are in the flat list and in no run'
  )

  // SEVEN zones, one item each: six runs render and the seventh does not.
  const spread = Array.from({ length: 7 }, (_, i) =>
    row({
      key: `relic of place ${i}`,
      name: `Relic of Place ${i}`,
      slots: ['FINGER'],
      classes: ['WAR'],
      stats: { AC: 10 + i },
      wikiSources: [{ mob: 'a young kobold', zone: `Place ${i}` }]
    })
  )
  const spreadRoute = buildProgressionPlan(inputs(), corpora({ gear: spread }))
  assert.equal(spreadRoute[0].runs.length, 6)
  // RANKED BY BEST MEMBER, not by a sum — the richest single item leads.
  assert.deepEqual(
    spreadRoute[0].runs.map((r) => r.zone),
    ['Place 6', 'Place 5', 'Place 4', 'Place 3', 'Place 2', 'Place 1']
  )
  // A zone with no profile states no band, and `plus: null` is what says that silence is a BASE
  // zone we cannot profile rather than a tier whose difficulty nobody states.
  assert.deepEqual(spreadRoute[0].runs.map((r) => [r.plus, r.band])[0], [null, null])
})

test('the flat `targets` list and `runs` are two views of ONE admitted pool', () => {
  const route = buildProgressionPlan(inputs(), corpora())
  for (const bracket of route) {
    const grouped = bracket.runs.flatMap((r) => r.targets.map((t) => t.key))

    // THE FLAT FIELD IS UNCHANGED IN RULE: still the bracket's top `TARGET_CAP`, still in the one
    // order (`byWorth`), still capped the same way.
    assert.equal(bracket.targets.length <= 8, true)
    const worth = bracket.targets.map((t) => [Number(t.wished), t.score] as const)
    assert.deepEqual(worth, [...worth].sort((a, b) => b[0] - a[0] || b[1] - a[1]))

    // THE CAPS, both of them.
    assert.equal(bracket.runs.length <= 6, true)
    for (const run of bracket.runs) assert.equal(run.targets.length <= 3, true)

    // ONE POOL: an item is in exactly one run, a bracket with no targets has no runs, and every flat
    // row's (zone, tier) is a run heading the reader can actually see.
    assert.equal(new Set(grouped).size, grouped.length)
    assert.equal(bracket.targets.length === 0, bracket.runs.length === 0)
    for (const target of bracket.targets) {
      assert.equal(
        bracket.runs.some(
          (r) => zoneLevelKey(r.zone) === zoneLevelKey(target.zone) && r.plus === target.plus
        ),
        true,
        `${target.name} has a run heading`
      )
    }
  }
})
