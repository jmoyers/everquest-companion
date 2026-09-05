// PLANNER SOURCE-INDEX TESTS — the item→mob inversion of the committed catalog (design §4.2).
//
// The Farm rollup and every donor row's "where does this drop" line stand on this one index, so
// it is tested against the REAL `src/renderer/src/data/eqlegends/mobs.json` — no fixture, no
// hand-built catalog. Two layers:
//   1. FLOORS. The index must stay big. Counts are floors, never today's exact numbers
//      (AGENTS.md: frozen numbers rot) — a rescrape adds mobs, and that must never turn a test
//      red, but a build that quietly stops parsing `drops` must.
//   2. AN ANCHOR. One item, verified by hand against the catalog: Ghoulbane comes off "the
//      froglok shin lord" in Upper Guk. That pins the KEY (`+N` stripped, case folded — the same
//      spelling main serves as `PlannerDonor.key`) and the shape of the source record together.
//
// The lazy singleton is deliberately NOT exercised here: `buildSourceIndex` is exported as a pure
// function precisely so the test can call it with the catalog it read itself.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSourceIndex, sourceItemKey } from '../src/renderer/src/features/planner/sourceIndex'
// The pure half lives in shared/ since 2026-08-25 (main builds the gear index's drop columns from
// it); the planner's door above still resolves, which is the point of keeping the door.
import { dropDetails, mergeItemSources, type ItemSource } from '../src/shared/itemSources'
import mobsJson from '../src/renderer/src/data/eqlegends/mobs.json'
import type { MobData } from '../src/shared/types'

const catalog = mobsJson as unknown as MobData
const index = buildSourceIndex(catalog.mobs)

test('the committed catalog inverts into a large item -> mobs index', () => {
  const withDrops = catalog.mobs.filter((m) => (m.drops?.length ?? 0) > 0)
  let links = 0
  for (const sources of index.values()) links += sources.length

  // Measured 2026-08-04: 7,872 pages, 4,410 with a loot list, 5,357 distinct keys, 32,822 links.
  assert.ok(withDrops.length >= 4_000, `only ${String(withDrops.length)} mobs state drops`)
  assert.ok(index.size >= 5_000, `only ${String(index.size)} distinct item keys`)
  assert.ok(links >= 30_000, `only ${String(links)} item->mob links`)
})

test('keys are the donor key: `+N` stripped and case folded', () => {
  assert.equal(sourceItemKey('Ghoulbane'), 'ghoulbane')
  assert.equal(sourceItemKey('Ghoulbane +4'), 'ghoulbane')
  // Every key in the index is already canonical — nothing round-trips to something else.
  for (const key of index.keys()) assert.equal(sourceItemKey(key), key)
})

test('ANCHOR — Ghoulbane comes off the froglok shin lord, in Upper Guk', () => {
  const sources = index.get('ghoulbane')
  assert.ok(sources && sources.length > 0, 'no source for ghoulbane')
  const shinLord = sources.find((s) => s.mob === 'the froglok shin lord')
  assert.ok(shinLord, `ghoulbane sources were ${sources.map((s) => s.mob).join(', ')}`)
  assert.deepEqual(shinLord.zones, ['Upper Guk'])
  assert.equal(shinLord.mobPage, 'The froglok shin lord')
  // The level text is kept VERBATIM — a range as often as a number (law 1).
  assert.equal(shinLord.levelText, '30')
})

test('a mob is listed once per item even when its page lists +N variants', () => {
  for (const [key, sources] of index) {
    const seen = new Set(sources.map((s) => `${s.mobPage ?? ''}|${s.mob}`))
    assert.equal(seen.size, sources.length, `duplicate source rows under ${key}`)
  }
})

test('dropDetails folds the merged witnesses into ALIGNED columns, one mob name each, zones deduped', () => {
  // The two witnesses first: the catalog row wins whole over the page's spelling of the same mob
  // (case-folded), and a page-only mob arrives as a bare name with its heading as its one zone.
  const catalog: ItemSource[] = [
    { mob: 'a bandit', mobPage: 'A bandit (Lake Rathe)', levelText: '5-8', zones: ['Lake Rathe'] },
    { mob: 'a bandit', mobPage: 'A bandit (Rathe Mountains)', levelText: '10-12', zones: ['Rathe Mountains'] },
    { mob: 'Trooper Bargrik', mobPage: 'Trooper Bargrik', zones: ['Kael Drakkel', 'Various'] }
  ]
  const merged = mergeItemSources(catalog, [{ mob: 'A Bandit', zone: 'Lesser Faydark' }, { mob: 'Lord Nagafen', zone: "Nagafen's Lair" }])
  assert.equal(merged.length, 4, 'the page`s "A Bandit" is the catalog`s bandit; Nagafen is new')
  const drops = dropDetails(merged)
  // ONE "a bandit" - the catalog names it on two pages and the cell says it once, with the FIRST
  // page's level and link (measured 2026-08-25: 309 such repeats across 201 items, none case-only).
  assert.deepEqual(drops.dropMobs, ['a bandit', 'Trooper Bargrik', 'Lord Nagafen'])
  assert.deepEqual(drops.dropLevels, ['5-8', '', ''], 'level i is mob i`s; unstated is the empty string, never a guess')
  assert.deepEqual(drops.dropPages, ['A bandit (Lake Rathe)', 'Trooper Bargrik', ''], 'page i is mob i`s; a page-only witness has none')
  // Zones dedupe across every witness, INCLUDING the second bandit page's - a zone is a place the
  // item drops in, not a per-mob fact, and "Various" is a real value the catalog stated.
  assert.deepEqual(drops.dropZones, ['Lake Rathe', 'Rathe Mountains', 'Kael Drakkel', 'Various', "Nagafen's Lair"])
  // Nothing in: nothing out, and never a phantom row.
  assert.deepEqual(dropDetails([]), { dropMobs: [], dropZones: [], dropLevels: [], dropPages: [] })
  assert.deepEqual(dropDetails([{ mob: '  ', zones: ['X'] }]).dropMobs, [], 'a blank mob is skipped, zones and all')
})

test('an item nobody drops is absent, not an empty list', () => {
  assert.equal(index.has(sourceItemKey('a thing no mob has ever dropped')), false)
})
