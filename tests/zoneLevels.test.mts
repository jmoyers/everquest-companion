// WHAT LEVEL IS THIS ZONE FOR (owner ask, kaltinril 2026-09-11: "also to show the level range of
// the map area?").
//
// The whole design argument is one measured zone: Befallen's catalog rows run 4 to 61, and a
// caption reading "Befallen: 4-61" is useless to the level 20 it is for. The band below says 6-26.

import test from 'node:test'
import assert from 'node:assert/strict'
import { zoneFit, zoneLevelBand, REACH } from '../src/shared/zoneLevels'
import mobsJson from '../src/renderer/src/data/eqlegends/mobs.json'

test('one wandering named does not redefine the zone', () => {
  // Thirty level-25 mobs and one level-60 named IS a level-25 zone.
  const levels = [...Array<number>(30).fill(25), 60]
  const band = zoneLevelBand(levels)
  assert.ok(band)
  assert.deepEqual(band.typical, [25, 25], 'the band is what the zone is FOR')
  assert.equal(band.max, 60, '...and the extreme is still stated, because it can still kill you')
  assert.equal(band.n, 31)
})

test('a zone the catalog says nothing about answers nothing, never a zero', () => {
  assert.equal(zoneLevelBand([]), null)
  // Rows with an unusable level are not levels (law 1).
  assert.equal(zoneLevelBand([0, Number.NaN]), null)
})

test('the fit table is the one both the map and the mote advice read', () => {
  const band = zoneLevelBand([20, 22, 24, 26])
  assert.ok(band)
  assert.equal(zoneFit(band, 40), 'green', 'the zone is below you')
  assert.equal(zoneFit(band, 22), 'even', 'you are inside it')
  assert.equal(zoneFit(band, 19), 'even', 'one under the band still counts as even')
  assert.equal(zoneFit(band, 17), 'hard', 'above you, but within reach - the owner`s "not crazy higher"')
  assert.equal(zoneFit(band, 20 - REACH - 1), 'deadly', 'somebody else`s zone')
})

test('the committed bestiary answers for the zone the ask named', () => {
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
  // The census, so a rescrape that thins the bestiary is visible rather than silent.
  assert.ok(levels.size > 150, `expected a broad bestiary, saw ${String(levels.size)} zones`)

  const befallen = zoneLevelBand(levels.get('Befallen') ?? [])
  assert.ok(befallen, 'Befallen is in the catalog')
  // Measured 2026-09-11 by THIS module (nearest-rank percentiles - an exploratory script using
  // floor said 6-26, which is the same data read one index over; neither is wrong and the one the
  // code ships is the one pinned). The gap between these two lines IS why this module exists.
  assert.deepEqual(befallen.typical, [7, 25])
  assert.equal(befallen.min, 4)
  assert.equal(befallen.max, 61)
})
