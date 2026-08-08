// QUEST-LIST SORT TEST: the Plane of Sky tab's six orders, and the two places absence has to
// behave as absence rather than as a low value.
//
// Pins:
//   - "most recent drop" (the DEFAULT) orders by the newest looted item among a quest's
//     requirements, newest first;
//   - LAW 1 CASE: a quest with NO drops has no recency — it sorts BELOW every quest that has
//     one, and the no-drop block orders by quest name. Never a fabricated timestamp, never 0;
//   - the same absence rule for "by island", whose primary island is DERIVED from the first
//     item whose `where` states Island N because no quest carries an island field;
//   - progress ("closest to done") leads with ready/turned-in quests, then ratio-descending —
//     completed quests remain visible unless "hide completed" is ticked;
//   - every order is total: ties fall through to quest name, so no order depends on input order;
//   - computeLastLootedAt's disposition rule (sold never dropped for you; combined did) and its
//     agreement with computeHeldCounts' counting key.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compareQuests,
  defaultSortDirection,
  questDropRecency,
  questIsland,
  questIslands,
  sortQuests,
  isSortDirection,
  isSortKey,
  DEFAULT_SORT,
  SORT_OPTIONS
} from '../src/renderer/src/features/posky/questSort'
import { computeLastLootedAt, computeHeldCounts } from '../src/renderer/src/features/posky/heldCounts'
import { itemCountKey } from '../src/renderer/src/lib/itemName'
import type { QuestProgress, ItemProgress } from '../src/renderer/src/features/posky/useProgress'
import type { LootEvent, PoskyQuest } from '../src/shared/types'
import poskyRaw from '../src/renderer/src/data/eqlegends/posky.json' with { type: 'json' }

// useProgress itself is a React hook module (and `@shared/*` value imports do not resolve
// outside the bundler), so this pins the PURE seam it calls — the sort keys and the orders.
const realQuests = (poskyRaw as { quests: PoskyQuest[] }).quests

function item(name: string, opts: Partial<ItemProgress> = {}): ItemProgress {
  return { name, who: [], where: '', droppers: [], need: 1, have: 0, ...opts }
}

function quest(name: string, opts: Partial<QuestProgress> = {}): QuestProgress {
  return {
    key: `${opts.className ?? 'Cleric'}::${name}`,
    className: 'Cleric',
    name,
    items: [],
    haveCount: 0,
    needCount: 1,
    ratio: 0,
    missing: [],
    completed: false,
    ...opts
  }
}

const names = (list: QuestProgress[]): string[] => list.map((q) => q.name)

test('most recent drop is the default order', () => {
  assert.equal(DEFAULT_SORT, 'recent')
  assert.equal(SORT_OPTIONS[0]?.value, 'recent')
  assert.equal(isSortKey('recent'), true)
  assert.equal(isSortKey('by-vibes'), false)
  assert.equal(isSortDirection('asc'), true)
  assert.equal(isSortDirection('desc'), true)
  assert.equal(isSortDirection('sideways'), false)
  assert.deepEqual(
    SORT_OPTIONS.map((o) => [o.value, defaultSortDirection(o.value)]),
    [
      ['recent', 'desc'],
      ['closest', 'desc'],
      ['least-missing', 'asc'],
      ['name', 'asc'],
      ['class', 'asc'],
      ['island', 'asc']
    ]
  )
})

test('recent: newest drop first', () => {
  const list = [
    quest('Older', { lastDropAt: 1_000 }),
    quest('Newest', { lastDropAt: 9_000 }),
    quest('Middle', { lastDropAt: 5_000 })
  ]
  assert.deepEqual(names(sortQuests(list, 'recent')), ['Newest', 'Middle', 'Older'])
  assert.deepEqual(names(sortQuests(list, 'recent', 'asc')), ['Older', 'Middle', 'Newest'])
})

test('LAW 1 — a quest with no drops sorts below every keyed quest, by name', () => {
  const list = [
    quest('Zeta never dropped'),
    quest('Alpha never dropped'),
    quest('Ancient drop', { lastDropAt: 1 }),
    quest('Mid never dropped')
  ]
  assert.deepEqual(names(sortQuests(list, 'recent')), [
    // a single drop from epoch+1ms still outranks EVERY quest with no drop at all…
    'Ancient drop',
    // …and the no-drop block is name-ordered, not input-ordered.
    'Alpha never dropped',
    'Mid never dropped',
    'Zeta never dropped'
  ])
  assert.deepEqual(names(sortQuests(list, 'recent', 'asc')), [
    'Ancient drop',
    // The unknown block reverses internally, but remains BELOW every real timestamp.
    'Zeta never dropped',
    'Mid never dropped',
    'Alpha never dropped'
  ])
})

test('recent: ties break by quest name', () => {
  const list = [quest('Beta', { lastDropAt: 7 }), quest('Alpha', { lastDropAt: 7 })]
  assert.deepEqual(names(sortQuests(list, 'recent')), ['Alpha', 'Beta'])
})

test('recent never treats a missing timestamp as 0', () => {
  const none = quest('None')
  assert.equal(none.lastDropAt, undefined)
  // 0 would compare as a real (1970) drop and beat nothing; undefined must lose to any number.
  assert.ok(compareQuests('recent')(none, quest('Epoch', { lastDropAt: 0 })) > 0)
})

test('name: A–Z, class only as the tiebreak for a repeated quest name', () => {
  const list = [
    quest('Test of Wind', { className: 'Ranger' }),
    quest('Test of Wind', { className: 'Cleric' }),
    quest('Test of Earth', { className: 'Shaman' })
  ]
  const sorted = sortQuests(list, 'name')
  assert.deepEqual(names(sorted), ['Test of Earth', 'Test of Wind', 'Test of Wind'])
  assert.deepEqual(
    sorted.map((q) => q.className),
    ['Shaman', 'Cleric', 'Ranger']
  )
  assert.deepEqual(names(sortQuests(list, 'name', 'desc')), ['Test of Wind', 'Test of Wind', 'Test of Earth'])
  assert.deepEqual(
    sortQuests(list, 'name', 'desc').map((q) => q.className),
    ['Ranger', 'Cleric', 'Shaman']
  )
})

test('class: grouped by class, name-ordered inside a class', () => {
  const list = [
    quest('Zeal', { className: 'Warrior' }),
    quest('Bravery', { className: 'Warrior' }),
    quest('Faith', { className: 'Cleric' })
  ]
  assert.deepEqual(names(sortQuests(list, 'class')), ['Faith', 'Bravery', 'Zeal'])
})

test('closest: completed quests stay on top even when recorded progress is lower', () => {
  const list = [
    quest('Barely started', { ratio: 0.1, missing: ['a', 'b'] }),
    quest('Turned in', { ratio: 0, missing: ['not recorded'], completed: true }),
    quest('Nearly there', { ratio: 0.9, missing: ['a'] })
  ]
  // Completion is not a filter here — 'hide completed' is a separate toggle and is untouched.
  assert.deepEqual(names(sortQuests(list, 'closest')), ['Turned in', 'Nearly there', 'Barely started'])
})

test('closest: every ready-to-turn-in quest leads every incomplete quest, ties by name', () => {
  const list = [
    quest('Nearly there', { ratio: 0.99, missing: ['last item'] }),
    quest('Zeta ready', { ratio: 1, missing: [], completed: false }),
    quest('Barely started', { ratio: 0.2, missing: ['a', 'b'] }),
    quest('Alpha ready', { ratio: 1, missing: [], completed: false }),
    quest('Middle ready', { ratio: 1, missing: [], completed: false })
  ]

  assert.deepEqual(names(sortQuests(list, 'closest')), [
    'Alpha ready',
    'Middle ready',
    'Zeta ready',
    'Nearly there',
    'Barely started'
  ])
})

test('closest: a noncompleted zero-item quest is ready even when its ratio is zero', () => {
  const list = [
    quest('Almost complete', { ratio: 0.99, missing: ['last item'] }),
    quest('Zero-item ready', {
      items: [],
      haveCount: 0,
      needCount: 0,
      ratio: 0,
      missing: [],
      completed: false
    })
  ]

  assert.deepEqual(names(sortQuests(list, 'closest')), ['Zero-item ready', 'Almost complete'])
  assert.deepEqual(names(sortQuests(list, 'closest', 'asc')), ['Almost complete', 'Zero-item ready'])
})

test('closest: equal ratio breaks on fewest missing, then name', () => {
  const list = [
    quest('Two missing', { ratio: 0.5, missing: ['a', 'b'] }),
    quest('One missing', { ratio: 0.5, missing: ['a'] }),
    quest('Another one missing', { ratio: 0.5, missing: ['a'] })
  ]
  assert.deepEqual(names(sortQuests(list, 'closest')), [
    'Another one missing',
    'One missing',
    'Two missing'
  ])
})

test('least-missing: fewest missing first, then ratio', () => {
  const list = [
    quest('Three', { ratio: 0.2, missing: ['a', 'b', 'c'] }),
    quest('None left', { ratio: 0.99, missing: [] }),
    quest('One', { ratio: 0.4, missing: ['a'] })
  ]
  assert.deepEqual(names(sortQuests(list, 'least-missing')), ['None left', 'One', 'Three'])
})

test('questIsland reads the FIRST explicitly-stated island in source order', () => {
  assert.equal(questIsland(quest('q', { items: [item('x', { where: 'Island 5' })] })), 5)
  assert.equal(
    questIsland(
      quest('q', {
        items: [item('x', { where: 'Island 7' }), item('y', { where: 'Island 3' })]
      })
    ),
    7
  )
  // A Wind Rune and an unlocated Efreeti-cycle item can lead the source list without becoming
  // the primary progression item. The first real island still wins.
  assert.equal(
    questIsland(
      quest('q', {
        items: [
          item('Wind Rune Kala', { where: 'Plane of Sky' }),
          item('Efreeti War Axe'),
          item('Blood Sky Ruby', { where: 'Island 8' })
        ]
      })
    ),
    8
  )
  // "Plane of Sky" and empty are not islands — no island named means no island, not island 0.
  assert.equal(
    questIsland(quest('q', { items: [item('x', { where: 'Plane of Sky' }), item('y')] })),
    undefined
  )
})

test('questIslands returns every explicit island, sorted and de-duplicated', () => {
  const q = quest('q', {
    items: [
      item('primary', { where: 'Island 8' }),
      item('Wind Rune Kala', { where: 'Plane of Sky' }),
      item('Efreeti War Axe'),
      item('earlier drop', { where: 'Island 5' }),
      item('same island again', { where: 'island 8' })
    ]
  })
  assert.deepEqual(questIslands(q), [5, 8])
  // The filter helper is comprehensive and sorted; it does not redefine the source-order
  // primary island used by the quest sort.
  assert.equal(questIsland(q), 8)
})

test('island: ascending, and a quest naming no island sorts below, by name', () => {
  const list = [
    quest('Seventh', { items: [item('a', { where: 'Island 7' })] }),
    quest('Unknown island', { items: [item('a', { where: 'Plane of Sky' })] }),
    quest('Second', { items: [item('a', { where: 'Island 2' })] }),
    quest('Also unknown', { items: [item('a')] })
  ]
  assert.deepEqual(names(sortQuests(list, 'island')), [
    'Second',
    'Seventh',
    'Also unknown',
    'Unknown island'
  ])
  assert.deepEqual(names(sortQuests(list, 'island', 'desc')), [
    'Seventh',
    'Second',
    // Unknowns stay below every stated island even when the keyed block reverses.
    'Unknown island',
    'Also unknown'
  ])
})

test('every order is total — no order depends on the input order', () => {
  const build = (): QuestProgress[] => [
    quest('Alpha', { className: 'Cleric', ratio: 0.5, missing: ['x'], lastDropAt: 5 }),
    quest('Beta', { className: 'Cleric', ratio: 0.5, missing: ['x'], lastDropAt: 5 }),
    quest('Gamma', { className: 'Cleric', ratio: 0.5, missing: ['x'], lastDropAt: 5 })
  ]
  for (const opt of SORT_OPTIONS) {
    for (const direction of ['asc', 'desc'] as const) {
      const forward = names(sortQuests(build(), opt.value, direction))
      const reversed = names(sortQuests([...build()].reverse(), opt.value, direction))
      assert.deepEqual(reversed, forward, `${opt.value}/${direction} is order-dependent`)
    }
  }
})

test('every order honors both directions while its natural direction remains the default', () => {
  const list = [
    quest('Alpha', {
      className: 'Cleric',
      ratio: 0.1,
      missing: ['a', 'b', 'c'],
      lastDropAt: 1,
      items: [item('a', { where: 'Island 2' })]
    }),
    quest('Beta', {
      className: 'Druid',
      ratio: 0.5,
      missing: ['a', 'b'],
      lastDropAt: 5,
      items: [item('b', { where: 'Island 5' })]
    }),
    quest('Gamma', {
      className: 'Warrior',
      ratio: 0.9,
      missing: ['a'],
      lastDropAt: 9,
      items: [item('c', { where: 'Island 8' })]
    })
  ]
  for (const opt of SORT_OPTIONS) {
    const natural = defaultSortDirection(opt.value)
    const opposite = natural === 'asc' ? 'desc' : 'asc'
    const expected = names(sortQuests(list, opt.value, natural))
    assert.deepEqual(names(sortQuests(list, opt.value)), expected, `${opt.value} default drifted`)
    assert.deepEqual(
      names(sortQuests(list, opt.value, opposite)),
      [...expected].reverse(),
      `${opt.value} did not reverse`
    )
  }
})

test('computeLastLootedAt: newest wins, sold skipped, combined counted, +N folded', () => {
  const loot: LootEvent[] = [
    { ts: 100, item: 'Sphinx Claw' },
    { ts: 300, item: 'Sphinx Claw +1' }, // same counting key — the +N variant is the same item
    { ts: 200, item: 'Sphinx Claw' },
    { ts: 900, item: 'Rusty Dagger', disposition: 'sold' }, // auto-vendored: it never helped
    { ts: 400, item: 'Wind Rune Geza', disposition: 'combined' }
  ]
  const t = computeLastLootedAt(loot)
  assert.equal(t['sphinx claw'], 300)
  assert.equal(t['rusty dagger'], undefined)
  assert.equal(t['wind rune geza'], 400)
  // Same key space as the held counts, so the quest join needs no translation.
  assert.deepEqual(Object.keys(computeHeldCounts(loot)).includes('sphinx claw'), true)
})

test('the quest key is the NEWEST of its items, and absent when none dropped', () => {
  assert.equal(questDropRecency([item('a', { lastLootedAt: 1_000 }), item('b', { lastLootedAt: 8_000 })]), 8_000)
  // One item with a drop is enough; the others being unlooted does not drag the key down.
  assert.equal(questDropRecency([item('a'), item('b', { lastLootedAt: 3 })]), 3)
  assert.equal(questDropRecency([item('a'), item('b')]), undefined)
  assert.equal(questDropRecency([]), undefined)
})

test('recency joins the real quest items on the loot counting key', () => {
  // The join useProgress performs: itemCountKey(requiredItem) against computeLastLootedAt's map.
  const q = realQuests.find((x) => x.items.length >= 2)
  assert.ok(q, 'expected a real quest with 2+ required items')
  const loot: LootEvent[] = [
    { ts: 1_000, item: q.items[0].name },
    { ts: 8_000, item: `${q.items[1].name} +1` } // a +N drop still credits the base requirement
  ]
  const map = computeLastLootedAt(loot)
  const items = q.items.map((it) => item(it.name, { lastLootedAt: map[itemCountKey(it.name)] }))
  assert.equal(items[0].lastLootedAt, 1_000)
  assert.equal(items[1].lastLootedAt, 8_000)
  assert.equal(questDropRecency(items), 8_000)
})

test('real primary-island anchors: Azarack 2 → Eagle 7 → Khyldorn 8 → unknown Efreeti-only', () => {
  const find = (name: string): PoskyQuest => {
    const q = realQuests.find((candidate) => candidate.name === name)
    assert.ok(q, `missing committed quest ${name}`)
    return q
  }
  const azarack = find('Beastlord Test of Azarack')
  const eagle = find('Druid Test of Eagle')
  const khyldorn = find('Shadow Knight Test of Necropotence')
  const unknown = find('Shadow Knight Test of Envenoming')

  assert.equal(questIsland(azarack), 2)
  // Source order, not minimum: Ethereal Ruby (7) is the primary item; the later Spiroc
  // Elder's Totem (5) remains available to the all-islands filter.
  assert.equal(questIsland(eagle), 7)
  assert.deepEqual(questIslands(eagle), [5, 7])
  assert.equal(khyldorn.reward, 'Khyldorn the Blood Drinker')
  assert.equal(questIsland(khyldorn), 8)
  assert.deepEqual(questIslands(khyldorn), [8])
  // Efreeti War Shield has no stated location and its Wind Rune says only Plane of Sky.
  assert.equal(questIsland(unknown), undefined)
  assert.deepEqual(questIslands(unknown), [])

  const asProgress = (q: PoskyQuest): QuestProgress =>
    quest(q.name, {
      className: q.className,
      items: q.items.map((it) => item(it.name, { where: it.where }))
    })
  const anchors = [unknown, khyldorn, eagle, azarack].map(asProgress)
  assert.deepEqual(names(sortQuests(anchors, 'island')), [
    'Beastlord Test of Azarack',
    'Druid Test of Eagle',
    'Shadow Knight Test of Necropotence',
    'Shadow Knight Test of Envenoming'
  ])
  assert.deepEqual(names(sortQuests(anchors, 'island', 'desc')), [
    'Shadow Knight Test of Necropotence',
    'Druid Test of Eagle',
    'Beastlord Test of Azarack',
    // Unknown remains last in descending order too.
    'Shadow Knight Test of Envenoming'
  ])
})

test('the island derivation holds over the real committed quest data', () => {
  const withIsland = realQuests.filter((q) => questIsland(q) !== undefined)
  // 94 of 95 name an island, so the order is real data rather than a guess; the one that
  // does not stays undefined and sorts with the unknowns.
  assert.ok(withIsland.length >= realQuests.length - 2, `only ${withIsland.length} islands found`)
  for (const q of withIsland) {
    const n = questIsland(q) ?? 0
    assert.ok(n >= 1 && n <= 8, `${q.name} derived island ${String(n)}`)
  }
})
