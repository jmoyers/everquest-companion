// ZONE LEVEL PROFILE — "how high does this zone read", folded from stated mob levels
// (docs/plans/gear-progression-planner.md §2.2, §3; the module is src/shared/planner/zoneLevels.ts).
//
// TWO SUBJECTS, and they are in one file because they are one rule apiece and both are about the
// SPELLINGS a name arrives in:
//
//   1. `plusSuffix` — the tier suffix, in the two spellings this machine has actually seen. The game
//      prints `<base> <N> (<TierWord>)` and the wiki writes `<base> +N` for the same place (plan
//      §0.2/§0.3). What is pinned hardest here is what the function REFUSES: a bare trailing number
//      is not a tier, a numeric parenthetical is the catalog's page disambiguator, and `+0` is the
//      base zone.
//   2. `zoneLevelProfile` — the fold itself: plural zones, the median/low/sampled arithmetic, and
//      the two law-1 arms (a digitless level is not level 0, and a zone with no readable level gets
//      NO entry rather than a zero one).
//
// EVERY FIXTURE HERE IS SYNTHETIC AND SAYS SO. Nothing below asserts a number the committed catalog
// states — the zone names are real spellings so the shapes read honestly, but the levels, the zone
// membership and the counts are invented for this file. The claim meets the real 7,872 rows through
// the renderer, not here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MobEntry } from '../src/shared/mobTypes'
import { metVersion, setMet } from '../src/shared/metInLog'
import { eraCached } from '../src/shared/planner/eraCache'
import { mobLevelIndex, plusSuffix, statedLevel, zoneLevelKey, zoneLevelProfile } from '../src/shared/planner/zoneLevels'

// =================================================================================================
// FIXTURES — synthetic, see the header
// =================================================================================================

function mob(name: string, level: string | undefined, zones: string[] | undefined): MobEntry {
  const entry: MobEntry = { page: name, name }
  if (level !== undefined) entry.level = level
  if (zones !== undefined) entry.zones = zones
  return entry
}

/**
 * The corpus, one zone per claim:
 *   Befallen    — the ordinary fold, plus the PLURAL-zones case (the skeleton is in two places).
 *   Najena      — reached only through that skeleton's second zone.
 *   Kerra Isle  — the key rule: three spellings, one profile, the FIRST one carried for display.
 *   Tiny Cave   — the even-sample median, on the half (3 and 4 → 4).
 *   Merchant Row— every mob digitless: NO ENTRY AT ALL.
 *   (no zone)   — a levelled mob the catalog places nowhere contributes to nothing.
 */
const CATALOG: MobEntry[] = [
  mob('a decaying skeleton', '5', ['Befallen']),
  mob('a skeleton', '7', ['Befallen', 'Najena']),
  mob('a large bat', '3', ['Befallen']),
  mob('Fright', '30-34', ['Befallen']),
  mob('a lost soul', 'Unknown', ['Befallen']),
  mob('a kerran fisherman', '12', ['Kerra Isle']),
  mob('a kerran warrior', '18', ['kerra isle']),
  mob('Rarn', '20', ['  Kerra   Isle  ']),
  mob('a small rat', '3', ['Tiny Cave']),
  mob('a small snake', '4', ['Tiny Cave']),
  mob('Merchant Kro', 'Unknown', ['Merchant Row']),
  mob('Merchant Vel', undefined, ['Merchant Row']),
  mob("Guard Ton", "You can't consider that.", ['Merchant Row']),
  mob('a wandering nobody', '44', undefined)
]

// =================================================================================================
// 1. `plusSuffix` — the two spellings, and the three refusals
// =================================================================================================

test('plusSuffix reads BOTH spellings of a tiered name, and nothing else', () => {
  // THE WIKI'S SPELLING, on a zone heading and on a dropper (plan §0.2).
  assert.deepEqual(plusSuffix('Timorous Deep +4'), { base: 'Timorous Deep', plus: 4 })
  assert.deepEqual(plusSuffix('Ixiblat Fer +5'), { base: 'Ixiblat Fer', plus: 5 })
  assert.deepEqual(plusSuffix('Timorous Deep+4'), { base: 'Timorous Deep', plus: 4 }, 'the wiki spells it tight too')

  // THE GAME'S SPELLING, measured off the real log 2026-08-15 — all four zone lines it printed.
  assert.deepEqual(plusSuffix('Temple of Cazic-Thule 4 (Refined)'), { base: 'Temple of Cazic-Thule', plus: 4 })
  assert.deepEqual(plusSuffix('The Ruins of Old Guk 3 (Fused)'), { base: 'The Ruins of Old Guk', plus: 3 })
  assert.deepEqual(plusSuffix('Kerra Isle 4 (Refined)'), { base: 'Kerra Isle', plus: 4 })
  assert.deepEqual(plusSuffix('Toxxulia Forest 1 (Awakened)'), { base: 'Toxxulia Forest', plus: 1 })

  // THE TIER WORD IS NOT A CLOSED LIST. Tier 2's word is unstated anywhere on this machine, so a
  // word the log has never printed must still parse — that is the whole reason the rule is a shape.
  assert.deepEqual(plusSuffix('Kerra Isle 2 (Tempered)'), { base: 'Kerra Isle', plus: 2 })

  // A BASE NAME IS `null`, which is what makes `plusSuffix(x) === null` read as "is this the plain
  // zone" at every call site.
  assert.equal(plusSuffix('Kerra Isle'), null)
  assert.equal(plusSuffix('Clan Crushbone'), null)
  assert.equal(plusSuffix(''), null)
  assert.equal(plusSuffix('+4'), null, 'a suffix with no name in front of it names nothing')
})

test('plusSuffix REFUSES a bare trailing number, a numeric parenthetical, and +0', () => {
  // A BARE TRAILING NUMBER IS NOT A TIER. Only the two spellings above are attested; a rule that ate
  // any trailing digit run would invent a tier for every name that happens to end in one.
  assert.equal(plusSuffix('Kerra Isle 3'), null)
  assert.equal(plusSuffix('a skeleton 2'), null)

  // A NUMERIC PARENTHETICAL IS THE CATALOG'S PAGE DISAMBIGUATOR (`Northern Karana (35)`), never a
  // tier word — which is the one discrimination the corpus forces on the generic match.
  assert.equal(plusSuffix('Northern Karana (35)'), null)
  assert.equal(plusSuffix('Northern Karana 3 (35)'), null)

  // `+0` IS THE BASE ZONE — the fork user's own vocabulary in the ask ("grind +0 for exp").
  assert.equal(plusSuffix('Timorous Deep +0'), null)

  // AND IT DOES NOT STRIP INSTANCE SELECTION: `- Solo` / `- Group N` is `zoneKey`'s job, so the base
  // comes back carrying it rather than this function quietly taking a second decision.
  assert.deepEqual(plusSuffix('The Ruins of Old Paineel - Solo 4 (Refined)'), {
    base: 'The Ruins of Old Paineel - Solo',
    plus: 4
  })
})

// =================================================================================================
// 2. `statedLevel` — `sortLevel`'s rule, promoted, with its caveat stated
// =================================================================================================

test('statedLevel reads the FIRST DIGIT RUN, and a digitless string is null and never 0', () => {
  assert.equal(statedLevel('56'), 56)
  assert.equal(statedLevel('9-12'), 9, 'a range reads its low end')
  assert.equal(statedLevel('2 - 4'), 2)
  assert.equal(statedLevel('~53'), 53)
  assert.equal(statedLevel('35?'), 35)

  // THE DOCUMENTED CAVEAT, pinned so it cannot be "fixed" silently: the rule is "first digit run",
  // not "true low end", so BOTH hedges read 50. `<50` states no floor at all, which is why the
  // module's header discloses this rather than inventing one.
  assert.equal(statedLevel('<50'), 50)
  assert.equal(statedLevel('50+'), 50)

  // NO DIGITS = null. Not 0 — a level-0 mob would sink to the front of every ranking this feeds.
  assert.equal(statedLevel('Unknown'), null)
  assert.equal(statedLevel("You can't consider that."), null)
  assert.equal(statedLevel(''), null)
  assert.equal(statedLevel(undefined), null)
})

// =================================================================================================
// 3. `zoneLevelProfile` — the fold
// =================================================================================================

test('a mob folds into EVERY zone it states, and low/median/sampled read the stated levels', () => {
  const profiles = zoneLevelProfile(CATALOG)

  // Befallen states 3, 5, 7 and 30 (the "30-34" row reads 30). The digitless "a lost soul" is not
  // counted anywhere — `sampled` is 4, not 5, because an unreadable level is not evidence.
  const befallen = profiles.get('befallen')!
  assert.deepEqual(befallen, { zone: 'Befallen', low: 3, median: 6, sampled: 4 })

  // PLURAL ZONES: `a skeleton` is in Befallen AND Najena, and it counts once in each. Najena's whole
  // profile is that one mob, which is exactly what `sampled: 1` is carried to disclose.
  assert.deepEqual(profiles.get('najena'), { zone: 'Najena', low: 7, median: 7, sampled: 1 })

  // THE EVEN-SAMPLE MEDIAN lands on the half and rounds to a WHOLE LEVEL, because the con model this
  // feeds is stated in whole levels on both sides.
  assert.deepEqual(profiles.get('tiny cave'), { zone: 'Tiny Cave', low: 3, median: 4, sampled: 2 })
})

test('a zone with no readable level gets NO ENTRY — absent, never a zero profile', () => {
  const profiles = zoneLevelProfile(CATALOG)

  // Three mobs, none of them levelled. The zone is not in the map at all: a level-0 profile would
  // put a merchant row at the top of a route for a level-1 character.
  assert.equal(profiles.has('merchant row'), false)
  assert.equal(profiles.get('merchant row'), undefined)

  // And a levelled mob the catalog places NOWHERE contributes to nothing — there is no zone to
  // credit it to, and no bucket is invented for it.
  assert.equal(profiles.size, 4, 'Befallen, Najena, Kerra Isle, Tiny Cave — and nothing else')
})

test('the key is a trim + case-fold + whitespace collapse, and the DISPLAY spelling rides along', () => {
  const profiles = zoneLevelProfile(CATALOG)

  // Three spellings of one zone fold to one entry…
  const kerra = profiles.get('kerra isle')!
  assert.deepEqual(kerra, { zone: 'Kerra Isle', low: 12, median: 18, sampled: 3 })
  // …and the FIRST spelling the catalog stated is what a surface draws. The folded key is never
  // shown at a reader.
  assert.equal(kerra.zone, 'Kerra Isle')

  // The key function is exported so a caller holding a zone name from anywhere else folds it the
  // same way — which is what makes the plan fold's profile lookups land.
  assert.equal(zoneLevelKey('  KERRA   isle '), 'kerra isle')
  assert.equal(zoneLevelKey('Befallen'), 'befallen')
  assert.equal(zoneLevelKey('   '), '')

  // WHAT THE KEY DELIBERATELY DOES NOT DO: it is not `shared/zones.ts zoneKey`. No leading article
  // fold, no hyphen collapse, no tier strip — this map folds the catalog against ITSELF, and
  // claiming two catalog spellings are the same place is the alias table's job, not a string rule's.
  assert.notEqual(zoneLevelKey('The Feerrott'), zoneLevelKey('Feerrott'))
  assert.notEqual(zoneLevelKey('Kerra Isle 4 (Refined)'), zoneLevelKey('Kerra Isle'))
})

test('the fold never mutates the catalog it was handed', () => {
  const before = CATALOG.map((m) => m.zones?.join('|') ?? '')
  zoneLevelProfile(CATALOG)
  assert.deepEqual(
    CATALOG.map((m) => m.zones?.join('|') ?? ''),
    before
  )
  assert.equal(zoneLevelProfile([]).size, 0, 'an empty catalog profiles nothing, and does not throw')
})

// =================================================================================================
// 3. the era flag (`mobEra.mobOutOfEra`, the data build's `outOfEra`): an out-of-era mob is no
//    evidence about its zone
// =================================================================================================

test('a mob flagged outOfEra in a classic zone is left out of the profile; unflagged mobs stay, whatever their banner', () => {
  const hate = (name: string, level: string, eraTag?: string, outOfEra?: true): MobEntry => {
    const entry = mob(name, level, ['Plane of Hate'])
    if (eraTag !== undefined) entry.eraTag = eraTag
    if (outOfEra !== undefined) entry.outOfEra = outOfEra
    return entry
  }
  const corpus = [
    hate('Maestro of Rancor', '52', 'Classic'),
    hate('Master of Spite', '50', 'Hate'),
    hate('an avatar of hate', '48'),
    hate('a revamp lieutenant', '60', 'FearHateRevamp', true),
    hate('a revamp general', '62', 'FearHateRevamp', true),
    hate('the revamped Innoruuk', '63', 'FearHateRevamp', true)
  ]
  assert.deepEqual(zoneLevelProfile(corpus).get('plane of hate'), {
    zone: 'Plane of Hate',
    low: 48,
    median: 50,
    sampled: 3
  })
  // The era chip lifted, every documented mob is evidence again.
  assert.deepEqual(zoneLevelProfile(corpus, false).get('plane of hate'), {
    zone: 'Plane of Hate',
    low: 48,
    median: 56,
    sampled: 6
  })
  // A banner alone hides nothing: only the data build's flag does (a cave bat is bannered Velious).
  assert.equal(zoneLevelProfile([hate('a cave bat', '20', 'Velious')]).get('plane of hate')?.sampled, 1)
  // A zone whose every levelled mob is out of era gets no entry, as one with no readable level.
  assert.equal(zoneLevelProfile([hate('a revamp lieutenant', '60', 'FearHateRevamp', true)]).size, 0)
  // Unflagged, the chip changes nothing: the committed catalog today.
  assert.deepEqual(zoneLevelProfile(CATALOG), zoneLevelProfile(CATALOG, false))
})

// =================================================================================================
// 4. the player's log outranks the flag (owner ruling, 2026-10-17), and the route's mob-level join
//    reads the same predicate. The log's evidence is module state (`shared/metInLog`), empty unless
//    a test fills it; each test empties it again.
// =================================================================================================

const flagged = (name: string, level: string): MobEntry => ({ ...mob(name, level, ['Plane of Hate']), outOfEra: true })

const HATE = [
  mob('Maestro of Rancor', '52', ['Plane of Hate']),
  mob('Master of Spite', '50', ['Plane of Hate']),
  flagged('a revamp lieutenant', '60'),
  flagged('the revamped Innoruuk', '63'),
  // One name on two pages: the classic row and a flagged revamp row.
  mob('an avatar of hate', '48', ['Plane of Hate']),
  flagged('An Avatar of Hate', '61')
]

test("the route's mob-level join leaves out a flagged mob under the era chip, and keeps the higher level otherwise", () => {
  const on = mobLevelIndex(HATE)
  assert.equal(on.get('maestro of rancor'), 52)
  assert.equal(on.get('a revamp lieutenant'), undefined, 'out of era: no level, so no target')
  assert.equal(on.get('an avatar of hate'), 48, "the classic row's level, not the revamp's")
  const off = mobLevelIndex(HATE, false)
  assert.equal(off.get('a revamp lieutenant'), 60, 'the chip off: every mob lends its level')
  assert.equal(off.get('an avatar of hate'), 61, 'the higher of the two, the cautious read')
})

test('a flagged mob the log met is evidence again, in the profile and in the level join; unmet stays out', () => {
  try {
    setMet('mobs', ['The Revamped Innoruuk'])
    assert.equal(mobLevelIndex(HATE).get('the revamped innoruuk'), 63)
    assert.equal(mobLevelIndex(HATE).get('a revamp lieutenant'), undefined, 'not met: still out')
    assert.equal(zoneLevelProfile(HATE).get('plane of hate')?.sampled, 4)
  } finally {
    setMet('mobs', [])
  }
  assert.equal(zoneLevelProfile(HATE).get('plane of hate')?.sampled, 3, 'evidence gone: the flag decides')
})

test("the Recommended tab's folds are taken again when the log's evidence moves, and only then", () => {
  let builds = 0
  const profiles = eraCached((eraOnly) => {
    builds++
    return zoneLevelProfile(HATE, eraOnly)
  })
  const first = profiles(true)
  assert.equal(profiles(true), first, 'held while nothing changes')
  assert.notEqual(profiles(false), first, 'one answer per chip state')
  assert.equal(builds, 2)
  const v = metVersion()
  try {
    setMet('mobs', ['a revamp lieutenant'])
    assert.notEqual(metVersion(), v)
    const after = profiles(true)
    assert.notEqual(after, first, 'a new fold under the new evidence')
    assert.equal(after.get('plane of hate')?.sampled, 4, 'and the met mob counts in it')
    assert.equal(profiles(true), after)
    assert.equal(builds, 3)
  } finally {
    setMet('mobs', [])
  }
})
