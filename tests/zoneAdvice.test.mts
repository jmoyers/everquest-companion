// WHERE TO LEVEL, WHERE TO FARM MOTES, WHERE YOUR WISH LIST DROPS (owner asks, kaltinril
// 2026-09-11 and -12: "recommendation for where to level, where to get motes (should be equal or
// higher level but not crazy higher)" and then "different level ranges for different stuff - D4
// mote farming, or best EXP or best gear, or most wishlist items in a single zone").
//
// The design claim under test is that the first two are ONE ranking read two ways, and it rests on
// this project's own measurement: white/yellow/red cons drop 7-10 motes per 100 kills against 4.2
// blue and 3.1 green, and the grade floor rises with difficulty. `shared/zoneAdvice.ts` carries
// the figures, their provenance, and why "best gear" is not here yet.

import test from 'node:test'
import assert from 'node:assert/strict'
import { MOTES_PER_100, moteGradeCap, nextAdviceSort, rankZones, sortAdvice } from '../src/shared/zoneAdvice'
import { zoneLevelBand, type ZoneLevelBand } from '../src/shared/zoneLevels'
import mobsJson from '../src/renderer/src/data/eqlegends/mobs.json'

function band(low: number, high: number): ZoneLevelBand {
  const levels: number[] = []
  for (let l = low; l <= high; l++) for (let i = 0; i < 10; i++) levels.push(l)
  const made = zoneLevelBand(levels)
  assert.ok(made)
  return made
}

const FEAR = band(48, 58)
const BEFALLEN = band(6, 26)

test('experience: a zone you cannot survive is not advice, however good its motes would be', () => {
  const bands = new Map([['Plane of Fear', FEAR], ['Befallen', BEFALLEN]])
  assert.deepEqual(rankZones(bands, 20).map((r) => r.zone), ['Befallen'], '"not crazy higher" is a bound')
})

test('experience: even and a reach lead, and green is last rather than absent', () => {
  const bands = new Map([['easy', band(5, 10)], ['even', band(18, 24)], ['reach', band(23, 28)]])
  const ranked = rankZones(bands, 22)
  assert.deepEqual(ranked.map((r) => r.zone), ['reach', 'even', 'easy'])
  // The harder of two equally-fitting bands leads: the measured GRADE floor rises with difficulty
  // even where the per-kill rate does not separate them.
  assert.equal(ranked[0].fit, 'even')
  assert.ok(ranked[0].band.typical[0] > ranked[1].band.typical[0])
  // A green zone is still listed - it is slower, not useless.
  assert.equal(ranked[2].fit, 'green')
  assert.equal(ranked[2].motesPer100, MOTES_PER_100.green)
  assert.ok(MOTES_PER_100.even > MOTES_PER_100.green * 2, 'the measured rate roughly doubles')
})

test('motes: the reach leads and green is gone - 3.1 per hundred is not a mote plan', () => {
  // `reach` starts TWO above: one above still counts as even (`zoneFit`), and this test wants a
  // genuinely hard band leading, not an even one that happens to start higher.
  const bands = new Map([['easy', band(5, 10)], ['even', band(18, 24)], ['reach', band(24, 29)]])
  const ranked = rankZones(bands, 22, { goal: 'motes' })
  assert.deepEqual(ranked.map((r) => r.zone), ['reach', 'even'], 'green dropped, reach first')
  assert.equal(ranked[0].fit, 'hard', 'where the grade floor is higher')
  // ...and still nothing deadly: the mote goal is not a licence to die.
  assert.deepEqual(rankZones(new Map([['Plane of Fear', FEAR]]), 20, { goal: 'motes' }), [])
})

test('wish list: ranked by distinct wished drops, and the one goal that keeps a deadly zone', () => {
  // Nagafen's Lair rather than Fear: Fear is LOCKED below 45 (below), and a locked door is not deadly.
  const bands = new Map([["Nagafen's Lair", FEAR], ['Befallen', BEFALLEN], ['Nowhere', band(19, 23)]])
  const wished = new Map([["Nagafen's Lair", 3], ['Befallen', 1]])
  const ranked = rankZones(bands, 20, { goal: 'wish', wished })
  // Most wished items first, even though Sol B is deadly at 20: the item is where it is.
  assert.deepEqual(ranked.map((r) => r.zone), ["Nagafen's Lair", 'Befallen'])
  assert.equal(ranked[0].fit, 'deadly', 'and the chip still says what the trip costs')
  assert.equal(ranked[0].wished, 3)
  // A zone with nothing you want is not on this list, however well it fits.
  assert.ok(!ranked.some((r) => r.zone === 'Nowhere'))
  // No wish list at all is no list at all - never every zone at zero.
  assert.deepEqual(rankZones(bands, 20, { goal: 'wish' }), [])
})

test('a thinly documented zone can be held back, and every row says how thin it is', () => {
  const thin = zoneLevelBand([20, 21])
  assert.ok(thin)
  const bands = new Map([['thin', thin], ['thick', band(19, 23)]])
  assert.deepEqual(rankZones(bands, 20).map((r) => r.zone).sort(), ['thick', 'thin'])
  assert.deepEqual(rankZones(bands, 20, { min: 10 }).map((r) => r.zone), ['thick'], 'min n drops the thin one')
  for (const row of rankZones(bands, 20)) assert.equal(row.n, row.band.n, 'the weight rides on the row')
})

test('your own level caps the grade you can bank', () => {
  // ~1 tier per 5 levels, 50 reaching 10 (measured).
  assert.equal(moteGradeCap(50), 10)
  assert.equal(moteGradeCap(25), 5)
  assert.equal(moteGradeCap(1), 1, 'never zero - a level 1 banks SOMETHING')
  assert.equal(moteGradeCap(60), 10, 'and never past the ceiling')
})

/** The committed bestiary's bands, keyed by the catalog's own zone spellings - what the app ranks. */
function realBands(): Map<string, ZoneLevelBand> {
  const levels = new Map<string, number[]>()
  for (const mob of mobsJson.mobs) {
    const level = Number.parseInt(String(mob.level), 10)
    if (!Number.isFinite(level)) continue
    for (const zone of mob.zones ?? []) {
      const held = levels.get(zone) ?? []
      held.push(level)
      levels.set(zone, held)
    }
  }
  const bands = new Map<string, ZoneLevelBand>()
  for (const [zone, ls] of levels) {
    const made = zoneLevelBand(ls)
    if (made !== null) bands.set(zone, made)
  }
  return bands
}

test('the committed bestiary yields real advice for a real level, for both con goals', () => {
  const bands = realBands()
  for (const goal of ['exp', 'motes'] as const) {
    const ranked = rankZones(bands, 20, { goal, min: 8 })
    assert.ok(ranked.length >= 5, `${goal}: expected real advice, got ${String(ranked.length)} zones`)
    for (const row of ranked) assert.notEqual(row.fit, 'deadly', `${goal}: nothing deadly survives the cut`)
    // A level 20's best zones are not level 50 zones.
    assert.ok(ranked[0].band.typical[0] <= 25, `${goal}: led with ${ranked[0].zone} ${String(ranked[0].band.typical)}`)
  }
})

// ---- never advice, whatever the band says (owner, 2026-09-14) ---------------------------------
//
// The level-44 screenshot: Siren's Grotto, Velketor's and Chardok led ("not in the current era"),
// Neriak Commons and the Felwithes were listed as hunting grounds ("we don't want to kill npcs like
// that"), and the Plane of Fear was offered to a character the door would not open for ("locked
// to level 45"). All three answers live in `shared/zones.ts`; the ranker reads them, band or no band.

test('era: a zone EQ Legends does not have yet is not advice - unless the era switch is lifted', () => {
  // Real catalog spellings, invented bands: the rule under test is the table's, not the bestiary's.
  const bands = new Map([['Old Sebilis', band(46, 56)], ['The Hole', band(40, 55)], ['New Sebilis Expedition', band(43, 50)]])
  const kept = rankZones(bands, 44, { goal: 'motes' }).map((r) => r.zone)
  assert.ok(!kept.includes('Old Sebilis'), 'Kunark is not open')
  assert.ok(kept.includes('The Hole'), 'classic is')
  assert.ok(kept.includes('New Sebilis Expedition'), 'EQL-new content claims no era, and it is in the game')
  assert.ok(rankZones(bands, 44, { goal: 'motes', eraOnly: false }).some((r) => r.zone === 'Old Sebilis'), 'lifted: the pack`s whole world')
  // A spelling the table cannot place is unknown, and unknown is kept - never read as out of era.
  assert.equal(rankZones(new Map([['nowhere-known', band(42, 48)]]), 44).length, 1)
})

test('a home city is never advice, on any goal, however well its guards con', () => {
  const bands = new Map([['Neriak Commons', band(40, 61)], ['Southern Felwithe', band(40, 60)], ['The Hole', band(40, 55)]])
  for (const goal of ['exp', 'motes'] as const) {
    assert.deepEqual(rankZones(bands, 44, { goal }).map((r) => r.zone), ['The Hole'], goal)
  }
  const wished = new Map([['Neriak Commons', 5], ['The Hole', 1]])
  assert.deepEqual(rankZones(bands, 44, { goal: 'wish', wished }).map((r) => r.zone), ['The Hole'], 'not even for the wish list')
})

test('a zone locked below your level is absent, not deadly - the wish list included', () => {
  const bands = new Map([['Plane of Fear', FEAR]])
  const wished = new Map([['Plane of Fear', 3]])
  assert.deepEqual(rankZones(bands, 44, { goal: 'wish', wished }), [], 'the door does not open at 44')
  assert.equal(rankZones(bands, 45, { goal: 'motes' }).length, 1, 'and it does at 45')
  assert.equal(rankZones(bands, 45, { goal: 'motes' })[0].fit, 'hard')
})

test('the committed bestiary at 44, for motes: The Hole is on the list, no city and nothing out of era is', () => {
  const ranked = rankZones(realBands(), 44, { goal: 'motes', min: 8 })
  const zones = ranked.map((r) => r.zone)
  assert.ok(zones.includes('The Hole'), zones.join(', '))
  for (const gone of ["Siren's Grotto", "Velketor's Labyrinth", 'Chardok', 'Old Sebilis', 'Icewell Keep', 'Neriak Commons', 'Southern Felwithe', 'Northern Felwithe', 'South Kaladim']) {
    assert.ok(!zones.includes(gone), `${gone} listed`)
  }
  assert.ok(!zones.includes('Plane of Fear'), 'locked at 44')
  assert.ok(rankZones(realBands(), 45, { goal: 'motes', min: 8 }).some((r) => r.zone === 'Plane of Fear'), 'open at 45')
})

// ---- search, fit filter, column sort (owner, 2026-09-12: "need filters/search/sort") -----------

test('search and the fit filter narrow the list, and both are the ranker`s to do', () => {
  const bands = new Map([['easy', band(5, 10)], ['even', band(18, 24)], ['reach', band(24, 29)]])
  assert.deepEqual(rankZones(bands, 22, { search: 'EA' }).map((r) => r.zone), ['reach', 'easy'], 'case-folded substring')
  assert.deepEqual(rankZones(bands, 22, { fits: new Set(['green']) }).map((r) => r.zone), ['easy'])
  assert.equal(rankZones(bands, 22, { fits: new Set() }).length, 3, 'an empty filter is no filter')
})

test('a column sort runs over the goal`s rows and flips on a second click', () => {
  const bands = new Map([['easy', band(5, 10)], ['even', band(18, 24)], ['reach', band(24, 29)]])
  const rows = rankZones(bands, 22)
  const byLow = sortAdvice(rows, { key: 'low', dir: 'asc' })
  assert.deepEqual(byLow.map((r) => r.zone), ['easy', 'even', 'reach'])
  assert.deepEqual(sortAdvice(rows, { key: 'zone', dir: 'asc' }).map((r) => r.zone), ['easy', 'even', 'reach'])
  // First click on a number descends, on a name ascends; the same column again flips.
  assert.deepEqual(nextAdviceSort(null, 'n'), { key: 'n', dir: 'desc' })
  assert.deepEqual(nextAdviceSort(null, 'zone'), { key: 'zone', dir: 'asc' })
  assert.deepEqual(nextAdviceSort({ key: 'n', dir: 'desc' }, 'n'), { key: 'n', dir: 'asc' })
})
