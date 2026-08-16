// THE PROGRESSION PLAN FOLD — "where should I be, and what am I there for", per level bracket
// (docs/plans/gear-progression-planner.md §1, §2.4, §3, §6; the module is
// src/shared/planner/progressionPlan.ts).
//
// EVERY CORPUS HERE IS SYNTHETIC, INCLUDING THE CON MODEL, and that is the design rather than a
// convenience. The real band table is LEARNED from one machine's consider history
// (`shared/conBands.ts`), so a fold that called it directly could only ever be tested against
// whatever that log happened to contain; `PlanCorpora.con` is a parameter precisely so the table
// under a test is one the test wrote. Nothing below reads the mob catalog, the item corpus or the
// log. The zone NAMES are real spellings — the era layer is real code and has to be asked a real
// question — but the levels, the memberships, the counts and the drop witnesses are all invented.
//
// WHAT IS PINNED, in the order the plan doc §6 lists it:
//   1. bracket cutting from an ODD start level, and the shape of a whole default route;
//   2. the con gate BOTH WAYS — solo excludes what group admits;
//   3. era exclusion, including the unknown-HIDES rule the gear surfaces already follow;
//   4. a +N target: `band: null`, gated by its BASE zone's profile and by nothing else;
//   5. ownership exclusion, and best-bracket dedupe;
//   6. role re-ranking — a tank plan and a dps plan order the same two items oppositely;
//   7. an item whose page states NO classes is KEPT (law 1: unknown, never "nobody");
//   8. the horizon stops itself, and trailing silence is trimmed.
//
// THE OTHER HALF OF THE FOLD IS `tests/progressionPlanRuns.test.mts`: which items are ADMITTED (the
// upgrade-gap rule and the wish-list flag) and how a bracket GROUPS them into zone runs. Two files
// because this one sits at the 400-code-line factoring ceiling and that is a subject of its own,
// not more of this one's — the `gearEffectiveHp.test.mts` precedent.

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
 * THE SYNTHETIC CON TABLE. Deliberately simple and deliberately NOT the shipped seed: five bands off
 * the level difference, so every assertion below can be read off the arithmetic rather than off a
 * table that is still being derived from the log.
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

/**
 * Five zones with invented profiles. The era answers are the ones `shared/zones.ts` really gives:
 * Crushbone / Befallen / Najena are classic (in era), Timorous Deep is Kunark and Kael Drakkel is
 * Velious (both out), and "Nowhere Hollow" is a name that table has never heard of (unknown).
 */
const PROFILES = profiles(
  { zone: 'Crushbone', low: 8, median: 12, sampled: 40 },
  { zone: 'Nowhere Hollow', low: 10, median: 13, sampled: 5 },
  { zone: 'Kael Drakkel', low: 10, median: 14, sampled: 300 },
  { zone: 'Befallen', low: 12, median: 20, sampled: 30 },
  { zone: 'Najena', low: 20, median: 26, sampled: 25 },
  { zone: 'Timorous Deep', low: 25, median: 32, sampled: 50 }
)

/** The catalog lookup, injected. A mob it does not name states no level — `null`, never 0. */
const MOB_LEVELS = new Map<string, number>([
  ['a rat', 4],
  ['a young kobold', 14],
  ['a kromrif', 14],
  ['a lurker', 16],
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

/** The tank/dps re-rank pair: armour that a tank wants and a weapon that a rogue does. */
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
/** THE LAW-1 ROW: its page stated no classes at all, which is UNKNOWN and not "nobody". */
const ORPHAN = row({
  key: 'nameless band',
  name: 'Nameless Band',
  slots: ['FINGER'],
  classes: [],
  stats: { AC: 5 },
  wikiSources: [{ mob: 'a young kobold', zone: 'Crushbone' }]
})
/** A row the trio genuinely cannot wear — the gate has to do SOMETHING or the row above proves nothing. */
const WIZ_ONLY = row({
  key: 'staff of the wizard',
  name: 'Staff of the Wizard',
  slots: ['PRIMARY'],
  classes: ['WIZ'],
  stats: { INT: 10 },
  wikiSources: [{ mob: 'a young kobold', zone: 'Crushbone' }]
})
const OWNED = row({
  key: 'rusty dagger',
  name: 'Rusty Dagger',
  slots: ['PRIMARY'],
  classes: ['ROG'],
  stats: { AC: 100 },
  wikiSources: [{ mob: 'a young kobold', zone: 'Crushbone' }]
})
/** Drops in Velious — a POSITIVE out-of-era verdict off its own drop zone. */
const KAEL = row({
  key: 'ry`gorr chain',
  name: 'Ry`Gorr Chain',
  classes: ['WAR'],
  stats: { AC: 20 },
  wikiSources: [{ mob: 'a kromrif', zone: 'Kael Drakkel' }]
})
/** Its page listed the dropper under NO heading, so no zone resolves and no banner speaks: `era?`. */
const HOMELESS = row({
  key: "lurker's eye",
  name: "Lurker's Eye",
  slots: ['FACE'],
  classes: ['WAR'],
  stats: { AC: 8 },
  wikiSources: [{ mob: 'a lurker' }]
})
/**
 * A GREY DROPPER — level 4 against a level-13 character, `trivial` at every level in every bracket.
 * The gate is a CEILING and not a window (the 2026-08-15 correction), so this is a target from the
 * FIRST bracket: the easiest farm in the game is not a reason to hide an item.
 */
const GREY = row({
  key: 'tarnished bauble',
  name: 'Tarnished Bauble',
  slots: ['NECK'],
  classes: ['WAR'],
  stats: { AC: 6 },
  wikiSources: [{ mob: 'a rat', zone: 'Crushbone' }]
})
/** Level 21 dropper: RISKY at the top of 13-18 and never better — the solo/group discriminator. */
const DEEP = row({
  key: 'deep guard shield',
  name: 'Deep Guard Shield',
  slots: ['SECONDARY'],
  classes: ['WAR'],
  stats: { AC: 12 },
  wikiSources: [{ mob: 'a deep guardian', zone: 'Befallen' }]
})
/** THE TIER ON THE ZONE. The dropper is level 60 — deadly in every bracket the plan reaches. */
const TIER_CLOAK = row({
  key: 'refined cloak',
  name: 'Refined Cloak',
  slots: ['BACK'],
  classes: ['WAR'],
  stats: { AC: 14 },
  wikiSources: [{ mob: 'a shadowed one', zone: 'Najena +4' }]
})
/** THE TIER ON THE MOB — a creature the catalog has no row for, whatever its base name states. */
const TIER_RING = row({
  key: 'fused ring',
  name: 'Fused Ring',
  slots: ['FINGER'],
  classes: ['WAR'],
  stats: { AC: 9 },
  wikiSources: [{ mob: 'Ixiblat Fer +5', zone: 'Najena' }]
})

const GEAR = [PLATE, BLADE, ORPHAN, WIZ_ONLY, OWNED, KAEL, HOMELESS, GREY, DEEP, TIER_CLOAK, TIER_RING]

function corpora(over: Partial<PlanCorpora> = {}): PlanCorpora {
  return {
    gear: GEAR,
    profiles: PROFILES,
    mobLevel,
    con,
    owned: new Set(['rusty dagger']),
    wished: new Set(),
    // EVERY SLOT A GAP by default — the baseline most of this file's claims want, so an assertion
    // about the con gate is never quietly also an assertion about the upgrade gate.
    ownedBestBySlot: new Map(),
    ...over
  }
}

function inputs(over: Partial<PlanInputs> = {}): PlanInputs {
  return { level: 13, classes: ['WAR', 'PAL', 'ROG'], role: 'balanced', reach: 'solo', eraOnly: false, ...over }
}

const names = (b: PlanBracket): string[] => b.targets.map((t) => t.name)
const zones = (b: PlanBracket): string[] => b.expZones.map((z) => z.zone)
const bounds = (route: PlanBracket[]): string[] => route.map((b) => `${b.from}-${b.to}`)

// =================================================================================================
// 1. BRACKET CUTTING, and the shape of a whole route
// =================================================================================================

test('brackets are cut from the CURRENT level, odd start and all, six levels at a time', () => {
  const route = buildProgressionPlan(inputs(), corpora())

  // 13 is not a multiple of anything. The route opens where the character IS, never at a rounded
  // level — the plan is advice for tonight, not a table of canonical tiers.
  assert.deepEqual(bounds(route), ['13-18', '19-24', '25-30', '31-36'])

  // …and the width is an INPUT (plan §8 calls 6 a first guess), so tuning it is a constant.
  const wide = buildProgressionPlan(inputs({ bracketSize: 10 }), corpora())
  assert.deepEqual(bounds(wide), ['13-22', '23-32', '33-42'])
  const narrow = buildProgressionPlan(inputs({ bracketSize: 3 }), corpora())
  assert.deepEqual(bounds(narrow).slice(0, 3), ['13-15', '16-18', '19-21'])
})

test('a bracket carries WHERE TO GRIND, ranked by how close the zone median sits to the midpoint', () => {
  const route = buildProgressionPlan(inputs(), corpora())

  // Bracket 13-18, midpoint 15. Three zones' medians con safe/even against 15 under the synthetic
  // table (14, 13, 12); Befallen at 20 is deadly there and Najena at 26 is further still.
  assert.deepEqual(zones(route[0]), ['Kael Drakkel', 'Nowhere Hollow', 'Crushbone'])
  assert.deepEqual(
    route[0].expZones.map((z) => [z.median, z.band]),
    [
      [14, 'safe'],
      [13, 'safe'],
      [12, 'safe']
    ]
  )
  // `low` and `sampled` ride along on every pick so a surface can say "from N stated mob levels"
  // and show the spread, rather than the median pretending to be a range.
  assert.equal(route[0].expZones[0].low, 10)
  assert.equal(route[0].expZones[0].sampled, 300)

  // And the route MOVES: each later bracket picks up the zone that has come into reach.
  assert.deepEqual(zones(route[1]), ['Befallen'])
  assert.deepEqual(zones(route[2]), ['Najena'])
  assert.deepEqual(zones(route[3]), ['Timorous Deep'])
})

// =================================================================================================
// 2. THE CON GATE, both ways
// =================================================================================================

test('the gate is a CEILING: a GREY drop mob is a target, from the very first bracket', () => {
  // THE BUG THIS PINS (owner, live, 2026-08-15): the first cut read "blue and white solo" as a
  // two-sided window and dropped every item whose dropper had been outlevelled. A grey mob is the
  // EASIEST farm there is, and the route's answer for one is "go and grab it now".
  assert.equal(con(13, 4), 'trivial', 'the rat really is grey at the opening level')

  const solo = buildProgressionPlan(inputs(), corpora())
  const bauble = solo[0].targets.find((t) => t.key === 'tarnished bauble')
  assert.notEqual(bauble, undefined, 'a trivial-source item is a target under the SOLO reach')
  assert.equal(bauble?.band, 'trivial', 'and it says so — the band is reported, not laundered')
  assert.equal(bauble?.mobLevel, 4)

  // FIRST BRACKET, not some later one: `bandInBracket` reads the lowest level in the range, and a
  // mob already grey at the bottom qualifies there.
  assert.equal(
    solo.findIndex((b) => b.targets.some((t) => t.key === 'tarnished bauble')),
    0
  )
  // Group reaches at least as far as solo — the ceiling only ever rises.
  const group = buildProgressionPlan(inputs({ reach: 'group' }), corpora())
  assert.equal(group[0].targets.some((t) => t.key === 'tarnished bauble'), true)

  // AND THE EXP HALF IS UNCHANGED: a grey zone pays no experience, so `trivial` is still out THERE.
  // Crushbone profiles at 12 and is safe (not trivial) at midpoint 15, which is why it is listed;
  // by 31-36 it has gone grey and it is gone from the route.
  assert.equal(zones(solo[0]).includes('Crushbone'), true)
  assert.equal(solo.slice(1).some((b) => zones(b).includes('Crushbone')), false)
})

test('SOLO excludes what GROUP admits — the ask’s "blue and white" CEILING, raised by one band', () => {
  // `a deep guardian` is level 21. Across 13-18 the best it ever cons is RISKY (at 17), so a solo
  // plan will not send you there — it puts the shield in the bracket where the fight goes even.
  const solo = buildProgressionPlan(inputs(), corpora())
  assert.equal(names(solo[0]).includes('Deep Guard Shield'), false)
  assert.deepEqual(names(solo[1]), ['Deep Guard Shield'])
  assert.equal(solo[1].targets[0].band, 'even', 'the band is read at the LOWEST level in the bracket that qualifies')
  assert.equal(solo[1].targets[0].mobLevel, 21)

  // A GROUP loosens the gate by exactly one band, so the same witness lands six levels earlier and
  // says so: risky, at 17, which is the first level in 13-18 where it is inside the gate.
  const group = buildProgressionPlan(inputs({ reach: 'group' }), corpora())
  assert.equal(names(group[0]).includes('Deep Guard Shield'), true)
  assert.equal(group[0].targets.find((t) => t.key === 'deep guard shield')?.band, 'risky')
  // …and having landed there it does NOT come back in the next bracket (see the dedupe test).
  assert.equal(names(group[1]).includes('Deep Guard Shield'), false)
})

test('a witness whose mob states NO level is not a target — an unlevelled mob is never conned', () => {
  const nothingKnown = corpora({ mobLevel: () => null })
  const route = buildProgressionPlan(inputs(), nothingKnown)
  // Every base-zone target is gone. What survives is exactly the +N pair, which never asked the
  // catalog for a mob level in the first place.
  const targets = route.flatMap((b) => b.targets.map((t) => t.key))
  assert.deepEqual(targets.sort(), ['fused ring', 'refined cloak'])
})

// =================================================================================================
// 3. ERA — and the unknown-HIDES rule
// =================================================================================================

test('with eraOnly ON, only in-era targets survive — and `era?` hides exactly like a positive out', () => {
  const off = buildProgressionPlan(inputs(), corpora())
  assert.equal(names(off[0]).includes('Ry`Gorr Chain'), true, 'filter off: a Velious drop is still listed')
  assert.equal(names(off[0]).includes("Lurker's Eye"), true, 'filter off: so is an item nothing places')

  const on = buildProgressionPlan(inputs({ eraOnly: true }), corpora())
  // A POSITIVE out-of-era: Kael Drakkel is Velious in the shared zone table.
  assert.equal(names(on[0]).includes('Ry`Gorr Chain'), false)
  // AND UNCERTAINTY: the Lurker's page listed its dropper under no heading, so nothing resolves and
  // no banner speaks. `unknown` hides too — the JOS-333 ruling the gear surfaces already follow,
  // because a question mark under a filter called "Current era" is a leak, not a courtesy.
  assert.equal(names(on[0]).includes("Lurker's Eye"), false)
  // The in-era rows are untouched.
  assert.deepEqual(names(on[0]), [
    'Plate of the Sentinel',
    'Blade of Haste',
    'Tarnished Bauble',
    'Nameless Band'
  ])
})

test('the era gate on EXP ZONES drops a positive out-of-era and keeps a zone the table never named', () => {
  const on = buildProgressionPlan(inputs({ eraOnly: true }), corpora())

  // Kael Drakkel (Velious) goes. "Nowhere Hollow" STAYS: for a zone the only witness is the
  // hand-authored table, whose unresolved names are dirt and EQL-new places, so hiding everything it
  // has not heard of would delete the route's exp half rather than tighten it.
  assert.deepEqual(zones(on[0]), ['Nowhere Hollow', 'Crushbone'])

  // Timorous Deep is Kunark, so the fourth bracket loses its only zone — and having lost its only
  // content it is trimmed off the end of the route entirely.
  assert.deepEqual(bounds(on), ['13-18', '19-24', '25-30'])
})

// =================================================================================================
// 4. THE +N TARGETS — plan §3
// =================================================================================================

test('a +N target carries NO BAND, and rides straight past the con gate that would bury it', () => {
  const route = buildProgressionPlan(inputs(), corpora())
  const tiered = route[2].targets
  assert.deepEqual(
    tiered.map((t) => t.name),
    ['Refined Cloak', 'Fused Ring'],
    'both tiered witnesses land in the bracket their BASE zone profiles into'
  )

  // THE BAND IS NULL ON BOTH. Nothing on this machine states how hard a +4 creature is (plan §3), so
  // "difficulty unstated" is the answer and a fabricated "blue at 25" is not.
  assert.deepEqual(tiered.map((t) => t.band), [null, null])
  assert.deepEqual(tiered.map((t) => t.plus), [4, 5])

  // THE ZONE IS THE BASE ZONE, tier suffix stripped, so the renderer can join it to anything.
  assert.deepEqual(tiered.map((t) => t.zone), ['Najena', 'Najena'])

  // THE TIER-ON-ZONE CASE keeps the mob's STATED level (it is a mob the catalog knows) even though
  // that level — 60 — cons DEADLY at every level in this bracket. That is the point: the con gate is
  // not applied to a tiered witness at all.
  assert.equal(tiered[0].mob, 'a shadowed one')
  assert.equal(tiered[0].mobLevel, 60)
  assert.equal(con(25, 60), 'deadly')

  // THE TIER-ON-MOB CASE states NO level: `Ixiblat Fer +5` is a creature the catalog has no row for,
  // and handing back the base mob's 55 would be stating a number about a different creature.
  assert.equal(tiered[1].mob, 'Ixiblat Fer')
  assert.equal(tiered[1].mobLevel, null)
})

test('a +N witness is gated by its BASE zone profile — the one gate that can be stated', () => {
  // Najena profiles at median 26, which is only in reach from bracket 25-30. Neither tiered item
  // appears before then, so the plan cannot send a level-13 character on a +4 run.
  const route = buildProgressionPlan(inputs(), corpora())
  assert.equal(names(route[0]).some((n) => n.includes('Refined') || n.includes('Fused')), false)
  assert.equal(names(route[1]).some((n) => n.includes('Refined') || n.includes('Fused')), false)

  // And with NO profile for the base zone there is nothing left to gate on, so the target is dropped
  // rather than admitted ungated.
  const blind = corpora({ profiles: profiles({ zone: 'Crushbone', low: 8, median: 12, sampled: 40 }) })
  const route2 = buildProgressionPlan(inputs(), blind)
  const keys = route2.flatMap((b) => b.targets.map((t) => t.key))
  assert.equal(keys.includes('refined cloak'), false)
  assert.equal(keys.includes('fused ring'), false)
})

// =================================================================================================
// 5. DEDUPE — ownership, the wish list, and one bracket per item
// =================================================================================================

test('OWNED items never appear — you do not farm what you have', () => {
  const route = buildProgressionPlan(inputs(), corpora())
  const keys = route.flatMap((b) => b.targets.map((t) => t.key))
  // It would otherwise top its bracket on the role score (AC 100 against the Plate's 95), so its
  // absence is not an accident of ranking.
  assert.equal(keys.includes('rusty dagger'), false)

  // Hand back an empty ownership set and it walks straight in, which is what proves the filter is
  // the thing doing the work.
  const open = buildProgressionPlan(inputs(), corpora({ owned: new Set() }))
  assert.equal(names(open[0])[0], 'Rusty Dagger')
})

test('an item lands in ONE bracket only — the earliest one that had room for it', () => {
  const route = buildProgressionPlan(inputs(), corpora())

  // The kobold is level 14, which cons inside the solo gate in 13-18 AND in 19-24 (safe). The Plate
  // appears once, in the first of them.
  assert.equal(con(19, 14), 'safe', 'it really does still qualify later')
  const appearances = route.flatMap((b) => b.targets.filter((t) => t.key === 'plate of the sentinel'))
  assert.equal(appearances.length, 1)
  assert.equal(route[0].targets[0].key, 'plate of the sentinel')

  // The whole route holds no key twice, which is the invariant the wish-list seeding depends on.
  const keys = route.flatMap((b) => b.targets.map((t) => t.key))
  assert.equal(new Set(keys).size, keys.length)
})

// =================================================================================================
// 6. ROLE RE-RANKING — the same two items, ordered oppositely
// =================================================================================================

test('roleValue reads ABSENT as nothing, and never returns NaN', () => {
  // An item that states no relevant stat scores exactly 0 — law 1, and the arithmetic stays total.
  assert.equal(roleValue({}, 'tank'), 0)
  assert.equal(roleValue({ WEIGHT: 12 }, 'dps'), 0, 'weight is a cost, and this table prices no costs')
  // A STATED penalty is a stated number, in both directions.
  assert.equal(roleValue({ AC: -4 }, 'tank'), -24)
  for (const role of ['balanced', 'tank', 'dps', 'healer'] as const) {
    assert.equal(Number.isFinite(roleValue(PLATE.stats, role)), true)
    assert.equal(Number.isFinite(roleValue(BLADE.stats, role)), true)
  }
})

test('a TANK plan and a DPS plan order the same two items OPPOSITELY', () => {
  const two = corpora({ gear: [PLATE, BLADE], owned: new Set(), wished: new Set() })

  const tank = buildProgressionPlan(inputs({ role: 'tank' }), two)
  assert.deepEqual(names(tank[0]), ['Plate of the Sentinel', 'Blade of Haste'])

  const dps = buildProgressionPlan(inputs({ role: 'dps' }), two)
  assert.deepEqual(names(dps[0]), ['Blade of Haste', 'Plate of the Sentinel'])

  // The scores that produced the flip, so the weights table cannot drift without this going red.
  assert.equal(roleValue(PLATE.stats, 'tank') > roleValue(BLADE.stats, 'tank'), true)
  assert.equal(roleValue(BLADE.stats, 'dps') > roleValue(PLATE.stats, 'dps'), true)

  // HEALER is a third opinion, not a synonym for either: mana and WIS outrank both of the above.
  const wand = { MP: 60, WIS: 12, MANA_REGEN: 2 }
  assert.equal(roleValue(wand, 'healer') > roleValue(wand, 'tank'), true)
  assert.equal(roleValue(wand, 'healer') > roleValue(wand, 'dps'), true)
})

// =================================================================================================
// 7. THE CLASS GATE — and the row that has no classes to gate on
// =================================================================================================

test('an EMPTY class list is UNKNOWN and is KEPT; a stated mismatch is excluded', () => {
  const route = buildProgressionPlan(inputs(), corpora())
  // The Nameless Band's page stated no classes at all. Excluding it would delete real gear on the
  // strength of a wiki omission (`gear.ts`: UNKNOWN, never "nobody").
  assert.equal(names(route[0]).includes('Nameless Band'), true)
  // The Staff states WIZ, and the trio is WAR/PAL/ROG. THAT is an exclusion the data supports.
  assert.equal(route.flatMap(names).includes('Staff of the Wizard'), false)

  // And an EMPTY INPUT trio gates nothing rather than everything — a surface with no class detection
  // yet must not render an empty plan.
  const noTrio = buildProgressionPlan(inputs({ classes: [] }), corpora())
  assert.equal(noTrio[0].targets.some((t) => t.key === 'staff of the wizard'), true)
})

// =================================================================================================
// 8. THE HORIZON
// =================================================================================================

test('the route stops when the corpus runs out of things to state, and trims trailing silence', () => {
  // The richest corpus here still has nothing to say past 36, and the route ends there rather than
  // marching to a level cap this repo does not hold.
  assert.deepEqual(bounds(buildProgressionPlan(inputs(), corpora())), ['13-18', '19-24', '25-30', '31-36'])

  // An EMPTY corpus is an empty route — no brackets full of nothing, and no exception.
  const empty = buildProgressionPlan(inputs(), corpora({ gear: [], profiles: new Map() }))
  assert.deepEqual(empty, [])

  // A GAP in the middle is information ("nothing here, keep going") and survives; only the tail is
  // trimmed. Two zones fourteen levels apart leave the bracket between them silent — and that is
  // exactly why the horizon needs TWO consecutive silent brackets before it gives up.
  const gapped = corpora({
    gear: [],
    profiles: profiles(
      { zone: 'Crushbone', low: 8, median: 12, sampled: 40 },
      { zone: 'Najena', low: 20, median: 26, sampled: 25 }
    )
  })
  const route1 = buildProgressionPlan(inputs({ bracketSize: 6 }), gapped)
  assert.deepEqual(bounds(route1), ['13-18', '19-24', '25-30'])
  assert.deepEqual(zones(route1[1]), [], 'the middle bracket is silent and is KEPT')
  assert.deepEqual(zones(route1[2]), ['Najena'], 'because the route picks up again after it')

  // AND THE HARD BACKSTOP holds even when every bracket keeps answering: a corpus whose one zone
  // cons in reach forever cannot make the loop run past level + 36.
  const forever = corpora({ gear: [], profiles: PROFILES, con: () => 'even' })
  const route = buildProgressionPlan(inputs({ level: 1, bracketSize: 6 }), forever)
  assert.equal(route[route.length - 1].to <= 1 + 36 + 6, true)
  assert.equal(route.length <= 7, true)
})
