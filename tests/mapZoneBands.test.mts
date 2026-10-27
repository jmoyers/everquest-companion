// Unit tests for the Where-to-level list's zone bands (src/renderer/src/features/maps/zoneBands.ts).
//
// Run against the committed bestiary, which is what the list itself reads. Two things are pinned:
// a level written "~19" is a level, and a zone the catalog spells several ways is one row, folded
// through the zone table (`zoneEntryFromCatalog`).

import test from 'node:test'
import assert from 'node:assert/strict'
import { wishedByZone, zoneBandOf, zoneBands, zoneBandsOf } from '../src/renderer/src/features/maps/zoneBands'
import { mobRows } from '../src/renderer/src/features/maps/mobPins'
import { metVersion, setMet } from '../src/shared/metInLog'
import { mobOutOfEra } from '../src/shared/mobEra'
import { rankZones } from '../src/shared/zoneAdvice'
import { MOB_CATALOG } from '../src/renderer/src/features/mobs/mobSearch'
import { mobsInZone } from '../src/renderer/src/features/mobs/mobZone'
import { sourceItemKey } from '../src/renderer/src/lib/itemSources'
import { zoneShortNameFromCatalog } from '../src/shared/zones'
import type { MobEntry } from '../src/shared/types'

test('a zone the catalog spells several ways is one row, under the zone table`s name', () => {
  const zones = [...zoneBands().keys()]
  for (const name of ['Cazic Thule', 'Runnyeye Citadel', 'RunnyEye Citadel', 'Feerrott', 'Estate of Unrest']) {
    assert.ok(!zones.includes(name), `${name} is not a row of its own`)
  }
  for (const name of ['Cazic-Thule', 'Clan RunnyEye', 'The Feerrott', 'The Estate of Unrest']) {
    assert.ok(zones.includes(name), `${name} is a row`)
  }
})

test('a row counts every levelled mob of the zone, "~19" included', () => {
  const resolves = (stem: string) => (m: MobEntry) => m.zones?.some((z) => zoneShortNameFromCatalog(z) === stem)
  // Bloodgurgler ~19, Bonefire ~18 and Chokehold ~20 were dropped by parseInt; "??" has no level.
  const crushbone = MOB_CATALOG.filter(resolves('crushbone'))
  for (const level of ['~19', '~18', '~20']) assert.ok(crushbone.some((m) => m.level === level), level)
  for (const [name, stem] of [['Clan Crushbone', 'crushbone'], ['Clan RunnyEye', 'runnyeye']] as const) {
    // The bands count only in-era mobs while Current era only is on (the default).
    const levelled = MOB_CATALOG.filter(resolves(stem)).filter((m) => /\d/.test(m.level ?? '') && !mobOutOfEra(m))
    assert.equal(zoneBands().get(name)?.n, levelled.length, `${name}: one row, every levelled mob`)
  }
  // Where the catalog's spellings are all reached by the caption's join, the two agree exactly.
  const caption = mobsInZone('Cazic-Thule', MOB_CATALOG).filter((m) => /\d/.test(m.level ?? '') && !mobOutOfEra(m))
  assert.equal(zoneBands().get('Cazic-Thule')?.n, caption.length)
})

test('the wish-list count is keyed the same way as the bands', () => {
  const drop = MOB_CATALOG.find((m) => m.zones?.includes('Cazic Thule') && (m.drops?.length ?? 0) > 0)
  assert.ok(drop?.drops, 'some Cazic Thule mob drops something')
  const counts = wishedByZone(new Set(drop.drops.map(sourceItemKey)))
  assert.ok((counts.get('Cazic-Thule') ?? 0) > 0, 'counted under the row the bands use')
  assert.equal(counts.get('Cazic Thule'), undefined)
})

// ---- the era flag on the mobs a zone is judged by (shared/mobEra.mobOutOfEra) -------------------
// Synthetic fixtures: the Plane of Hate as the catalog documents it, the classic page list and the
// Fear/Hate revamp's level 60-63 pages side by side. Only the mobs the data build flagged
// `outOfEra` are out; a banner alone decides nothing.

interface HateFixture {
  eraTag?: string
  outOfEra?: true
  drops?: string[]
}

function hateMob(name: string, level: string, more: HateFixture = {}): MobEntry {
  return { page: name, name, level, zones: ['Plane of Hate'], ...more }
}

const HATE: MobEntry[] = [
  hateMob('Maestro of Rancor', '52', { eraTag: 'Classic', drops: ['Sword of Rancor'] }),
  hateMob('Master of Spite', '50', { eraTag: 'Hate' }),
  hateMob('an avatar of hate', '48'),
  hateMob('Innoruuk, the Revamped', '63', {
    eraTag: 'FearHateRevamp',
    outOfEra: true,
    drops: ['Revamp Blade', 'Sword of Rancor']
  }),
  hateMob('a revamp lieutenant', '60', { eraTag: 'FearHateRevamp', outOfEra: true })
]

test('a mob flagged outOfEra in a classic zone is left out of the band; unflagged mobs stay', () => {
  const band = zoneBandsOf(HATE, true).get('The Plane of Hate')
  assert.equal(band?.n, 3, 'Classic, Hate and the untagged mob')
  assert.equal(band?.max, 52, 'no level 60-63 revamp mob stretches it')
  const lifted = zoneBandsOf(HATE, false).get('The Plane of Hate')
  assert.equal(lifted?.n, 5, 'lifting the era switch counts every documented mob again')
  assert.equal(lifted?.max, 63)
  const bat = zoneBandsOf([hateMob('a cave bat', '20', { eraTag: 'Velious' })], true)
  assert.equal(bat.get('The Plane of Hate')?.n, 1, 'a banner alone hides nothing')
})

test('a wished drop counts only from a mob in era', () => {
  const wished = new Set(['Revamp Blade', 'Sword of Rancor'].map(sourceItemKey))
  assert.equal(wishedByZone(wished, true, HATE).get('The Plane of Hate'), 1, 'only the classic sword')
  assert.equal(wishedByZone(new Set([sourceItemKey('Revamp Blade')]), true, HATE).size, 0)
  assert.equal(wishedByZone(wished, false, HATE).get('The Plane of Hate'), 2)
})

test('the zone advice rests on the in-era mobs alone', () => {
  const [row] = rankZones(zoneBandsOf(HATE, true), 50, { eraOnly: true })
  assert.equal(row?.zone, 'The Plane of Hate')
  assert.equal(row?.n, 3)
  assert.equal(row?.band.max, 52)
})

test('with no mob flagged, the bands are what they were', () => {
  const unflagged = HATE.map(({ outOfEra: _drop, ...rest }) => rest)
  assert.deepEqual(zoneBandsOf(unflagged, true), zoneBandsOf(unflagged, false))
})

// ---- the player's log outranks the flag (owner ruling, 2026-10-17) ------------------------------
// A flagged mob the log met (killed, conned, looted from) is in era for this player. The evidence
// is module state (`shared/metInLog`), empty unless a test fills it; each test empties it again.

const SWORDS = new Set(['Revamp Blade', 'Sword of Rancor'].map(sourceItemKey))

test('a flagged mob the log met counts in the band and as a source of a wished drop; unmet stays out', () => {
  try {
    setMet('mobs', ['Innoruuk, the Revamped'])
    const band = zoneBandsOf(HATE, true).get('The Plane of Hate')
    assert.equal(band?.n, 4, 'the met revamp mob is back; the unmet lieutenant is still out')
    assert.equal(band?.max, 63)
    assert.equal(wishedByZone(SWORDS, true, HATE).get('The Plane of Hate'), 2, 'its Revamp Blade counts')
  } finally {
    setMet('mobs', [])
  }
  assert.equal(zoneBandsOf(HATE, true).get('The Plane of Hate')?.n, 3, 'evidence gone: the flag decides')
})

test("the map's zone caption leaves out a flagged mob under the era switch, unless the log met it", () => {
  assert.equal(zoneBandOf('Plane of Hate', true, HATE)?.n, 3)
  assert.equal(zoneBandOf('Plane of Hate', true, HATE)?.max, 52, 'no revamp level stretches the caption')
  assert.equal(zoneBandOf('Plane of Hate', false, HATE)?.n, 5, 'the switch off counts every mob')
  try {
    setMet('mobs', ['a revamp lieutenant'])
    assert.equal(zoneBandOf('Plane of Hate', true, HATE)?.n, 4)
  } finally {
    setMet('mobs', [])
  }
})

test('the mob list beside the map, and its wished pins, leave out a flagged mob under the era switch', () => {
  const names = (eraOnly: boolean): string[] => mobRows('Plane of Hate', HATE, SWORDS, eraOnly).map((r) => r.name)
  assert.deepEqual(names(true), ['Master of Spite', 'Maestro of Rancor'], 'no revamp named; the common stays out')
  assert.deepEqual(names(false), ['Master of Spite', 'Maestro of Rancor', 'Innoruuk, the Revamped'])
  try {
    setMet('mobs', ['Innoruuk, the Revamped'])
    assert.ok(names(true).includes('Innoruuk, the Revamped'), 'met in the log: listed, and its drops pin')
  } finally {
    setMet('mobs', [])
  }
})

test("Where to level's cached bands are taken again when the log's evidence moves", () => {
  const before = zoneBands(true)
  assert.equal(zoneBands(true), before, 'held while nothing changes')
  const v = metVersion()
  try {
    setMet('mobs', ['Innoruuk, the Revamped'])
    assert.notEqual(metVersion(), v)
    const after = zoneBands(true)
    assert.notEqual(after, before, 'a new walk under the new evidence')
    assert.equal(zoneBands(true), after, 'and held again')
  } finally {
    setMet('mobs', [])
  }
})
