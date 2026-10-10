// Unit tests for the Where-to-level list's zone bands (src/renderer/src/features/maps/zoneBands.ts).
//
// Run against the committed bestiary, which is what the list itself reads. Two things are pinned:
// a level written "~19" is a level, and a zone the catalog spells several ways is one row, folded
// through the zone table (`zoneEntryFromCatalog`).

import test from 'node:test'
import assert from 'node:assert/strict'
import { wishedByZone, zoneBands } from '../src/renderer/src/features/maps/zoneBands'
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
    const levelled = MOB_CATALOG.filter(resolves(stem)).filter((m) => /\d/.test(m.level ?? ''))
    assert.equal(zoneBands().get(name)?.n, levelled.length, `${name}: one row, every levelled mob`)
  }
  // Where the catalog's spellings are all reached by the caption's join, the two agree exactly.
  const caption = mobsInZone('Cazic-Thule', MOB_CATALOG).filter((m) => /\d/.test(m.level ?? ''))
  assert.equal(zoneBands().get('Cazic-Thule')?.n, caption.length)
})

test('the wish-list count is keyed the same way as the bands', () => {
  const drop = MOB_CATALOG.find((m) => m.zones?.includes('Cazic Thule') && (m.drops?.length ?? 0) > 0)
  assert.ok(drop?.drops, 'some Cazic Thule mob drops something')
  const counts = wishedByZone(new Set(drop.drops.map(sourceItemKey)))
  assert.ok((counts.get('Cazic-Thule') ?? 0) > 0, 'counted under the row the bands use')
  assert.equal(counts.get('Cazic Thule'), undefined)
})
