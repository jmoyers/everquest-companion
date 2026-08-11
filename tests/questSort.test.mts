// QUEST-LIST SORT TEST: the Plane of Sky tab's six orders, and the two places absence has to
// behave as absence rather than as a low value.
//
// Pins:
//   - "most recent drop" (the DEFAULT) orders by the newest looted item among a quest's
//     requirements, newest first;
//   - LAW 1 CASE: a quest with NO drops has no recency — it sorts BELOW every quest that has
//     one, and the no-drop block orders by quest name. Never a fabricated timestamp, never 0;
//   - the same absence rule for "by island", whose island is DERIVED from item `where` strings
//     (lowest island named) because no quest carries an island field;
//   - progress ("closest to done") is ratio-descending, completed quests included — the list
//     shows them unless "hide completed" is ticked, and that is unchanged here;
//   - every order is total: ties fall through to quest name, so no order depends on input order;
//   - computeLastLootedAt's disposition rule (sold never dropped for you; combined did) and its
//     agreement with computeHeldCounts' counting key;
//   - JOS-146: the FAVORITE PIN is part of the order, and "most recently looted" is the one order
//     it may not override. The owner's live case is replayed at the bottom of this file, from his
//     own two log lines through the real parser.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compareQuests,
  orderQuests,
  pinsFavorites,
  questDropRecency,
  questIsland,
  sortQuests,
  isSortKey,
  DEFAULT_SORT,
  SORT_OPTIONS
} from '../src/renderer/src/features/posky/questSort'
import { computeLastLootedAt, computeHeldCounts } from '../src/renderer/src/features/posky/heldCounts'
import { itemCountKey } from '../src/renderer/src/lib/itemName'
import { parseEvent } from '../src/main/log/parser'
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
    // JOS-131: completion is a COUNT (`turnIns`), and `completed` is its one-bit reading. The
    // sorts below never read either — they are here because a QuestProgress has them.
    turnIns: 0,
    logTurnIns: 0,
    completed: false,
    ...opts
  }
}

const names = (list: QuestProgress[]): string[] => list.map((q) => q.name)

test('most recently looted is the default order', () => {
  assert.equal(DEFAULT_SORT, 'recent')
  assert.equal(SORT_OPTIONS[0]?.value, 'recent')
  // The stored key never changed with the JOS-146 relabel — an existing user's saved choice
  // still resolves.
  assert.equal(SORT_OPTIONS[0]?.label, 'Most recently looted')
  assert.equal(isSortKey('recent'), true)
  assert.equal(isSortKey('by-vibes'), false)
})

test('recent: newest drop first', () => {
  const list = [
    quest('Older', { lastDropAt: 1_000 }),
    quest('Newest', { lastDropAt: 9_000 }),
    quest('Middle', { lastDropAt: 5_000 })
  ]
  assert.deepEqual(names(sortQuests(list, 'recent')), ['Newest', 'Middle', 'Older'])
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
})

test('class: grouped by class, name-ordered inside a class', () => {
  const list = [
    quest('Zeal', { className: 'Warrior' }),
    quest('Bravery', { className: 'Warrior' }),
    quest('Faith', { className: 'Cleric' })
  ]
  assert.deepEqual(names(sortQuests(list, 'class')), ['Faith', 'Bravery', 'Zeal'])
})

test('closest: highest ratio first, completed quests included and on top', () => {
  const list = [
    quest('Barely started', { ratio: 0.1, missing: ['a', 'b'] }),
    quest('Turned in', { ratio: 1, turnIns: 1, completed: true }),
    quest('Nearly there', { ratio: 0.9, missing: ['a'] })
  ]
  // Completion is not a filter here — 'hide completed' is a separate toggle and is untouched.
  assert.deepEqual(names(sortQuests(list, 'closest')), ['Turned in', 'Nearly there', 'Barely started'])
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

test('questIsland reads the LOWEST island any required item names', () => {
  assert.equal(questIsland(quest('q', { items: [item('x', { where: 'Island 5' })] })), 5)
  assert.equal(
    questIsland(
      quest('q', {
        items: [item('x', { where: 'Island 7' }), item('y', { where: 'Island 3' })]
      })
    ),
    3
  )
  // "Plane of Sky" and empty are not islands — no island named means no island, not island 0.
  assert.equal(
    questIsland(quest('q', { items: [item('x', { where: 'Plane of Sky' }), item('y')] })),
    undefined
  )
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
})

test('every order is total — no order depends on the input order', () => {
  const build = (): QuestProgress[] => [
    quest('Alpha', { className: 'Cleric', ratio: 0.5, missing: ['x'], lastDropAt: 5 }),
    quest('Beta', { className: 'Cleric', ratio: 0.5, missing: ['x'], lastDropAt: 5 }),
    quest('Gamma', { className: 'Cleric', ratio: 0.5, missing: ['x'], lastDropAt: 5 })
  ]
  for (const opt of SORT_OPTIONS) {
    const forward = names(sortQuests(build(), opt.value))
    const reversed = names(sortQuests([...build()].reverse(), opt.value))
    assert.deepEqual(reversed, forward, `${opt.value} is order-dependent`)
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

// ---------------------------------------------------------------------------------------------
// JOS-146 — THE FAVORITE PIN, AND THE ONE ORDER IT MAY NOT OVERRIDE
// ---------------------------------------------------------------------------------------------

/** The pin rank useQuestList supplies: 2 for a starred quest, 1 for a starred item, 0 otherwise. */
const starred =
  (...names: string[]) =>
  (q: QuestProgress): number =>
    names.includes(q.name) ? 2 : 0

test('the pin applies to the five standing-property orders and not to recency', () => {
  for (const opt of SORT_OPTIONS) {
    assert.equal(pinsFavorites(opt.value), opt.value !== 'recent', `${opt.value} pin rule`)
  }
})

test('a starred quest is pinned above the sort in every standing-property order', () => {
  const list = [
    quest('Alpha', { ratio: 0.9, missing: [], lastDropAt: 9_000, items: [item('a', { where: 'Island 1' })] }),
    quest('Zulu', { ratio: 0.1, missing: ['x'], lastDropAt: 1_000, items: [item('a', { where: 'Island 8' })] })
  ]
  for (const opt of SORT_OPTIONS) {
    if (opt.value === 'recent') continue
    // Zulu loses every one of these orders on merit, so being first can only be the pin.
    assert.equal(orderQuests(list, opt.value, starred('Zulu'))[0]?.name, 'Zulu', `${opt.value} pin`)
  }
})

test('JOS-146 — a star may NOT outrank the loot you just made', () => {
  const list = [
    quest('Starred and stale', { lastDropAt: 1_000 }),
    quest('Just looted', { lastDropAt: 9_000 })
  ]
  assert.deepEqual(names(orderQuests(list, 'recent', starred('Starred and stale'))), [
    'Just looted',
    'Starred and stale'
  ])
  // …and the star is not merely being ignored: it still decides ties, because the order it is
  // layered onto is total and a tie is the only place a pin can act without lying.
  assert.equal(orderQuests(list, 'closest', starred('Starred and stale'))[0]?.name, 'Starred and stale')
})

test('orderQuests does not mutate the list it is handed', () => {
  const list = [quest('B', { lastDropAt: 1 }), quest('A', { lastDropAt: 9 })]
  const before = names(list)
  orderQuests(list, 'recent', starred('B'))
  assert.deepEqual(names(list), before)
})

/**
 * THE OWNER'S CASE, END TO END (JOS-146), from his own log rather than from an invented shape.
 *
 * Live-testing 2026-08-09: sorted by most recently looted, he looted a Hazy Opal and the list did
 * not move — a quest he had already gathered every item for stayed on top. The two lines below are
 * VERBATIM from `eqlog_Primitive_freeport.txt` (13:13:41 and 13:25:14 that afternoon), and the two
 * quests are the real committed ones they belong to:
 *   Warrior Test of Think          needs Wind Tablet, Efreeti Belt, Wind Rune Fana
 *   Magician Test of Gesticulation needs Hazy Opal, Efreeti Magi Staff, Wind Rune Jaka
 * `eq.questFavorites` in his dev app read ["rogue::rogue test of silence","warrior::warrior test
 * of think"], so the Warrior quest was STARRED — and that, not the recency key, is what held it in
 * place. Replaying his whole log proves the key was right the entire time: the Magician quest
 * takes first place the instant that opal lands. This test states both halves.
 *
 * Both lines are the "stored it in your <container>" shape, which is not a disposition
 * computeLastLootedAt skips — only an auto-vendored 'sold' row is, because that item never helped
 * a quest.
 */
test('JOS-146 — the Hazy Opal moves the Magician quest to the top, star or no star', () => {
  const LINES = [
    "[Sun Aug 09 13:13:41 2026] You looted a Wind Rune Fana from a soul harvester's corpse and stored it in your currency",
    "[Sun Aug 09 13:25:14 2026] You looted a Hazy Opal from Eye of Veeshan's corpse and stored it in your Dragon Hoard"
  ]
  const loot: LootEvent[] = []
  LINES.forEach((raw, i) => {
    const ev = parseEvent(raw, i)
    assert.equal(ev?.kind, 'loot', `the real parser reads line ${String(i)} as a loot event`)
    if (ev?.kind !== 'loot') return
    loot.push({ ts: ev.ts, item: ev.item, source: ev.source, disposition: ev.disposition, count: ev.count })
  })
  const lastLooted = computeLastLootedAt(loot)
  assert.ok(lastLooted['hazy opal'] > lastLooted['wind rune fana'], 'the opal is the newer loot')

  const build = (className: string, name: string): QuestProgress => {
    const real = realQuests.find((q) => q.className === className && q.name === name)
    assert.ok(real, `${className}::${name} is in the committed quest data`)
    const items = real.items.map((it) =>
      item(it.name, { lastLootedAt: lastLooted[itemCountKey(it.name)] })
    )
    return quest(name, { className, key: `${className}::${name}`, items, lastDropAt: questDropRecency(items) })
  }
  // The Warrior quest is the one he had every item for, so it carries no `missing` — which is what
  // put the "completed" badge on the row he was staring at.
  const warrior = build('Warrior', 'Warrior Test of Think')
  const magician = build('Magician', 'Magician Test of Gesticulation')
  assert.equal(warrior.lastDropAt, lastLooted['wind rune fana'])
  assert.equal(magician.lastDropAt, lastLooted['hazy opal'])

  const list = [warrior, magician]
  const star = starred('Warrior Test of Think')
  // WHAT HE SAW: the pin ran after the sort and the starred quest was first regardless.
  assert.deepEqual(sortQuests(list, 'recent').concat().sort((a, b) => star(b) - star(a))[0]?.name,
    'Warrior Test of Think')
  // WHAT HE GETS NOW: the loot he just made is the answer the order was asked for.
  assert.deepEqual(names(orderQuests(list, 'recent', star)), [
    'Magician Test of Gesticulation',
    'Warrior Test of Think'
  ])
  // And with nothing starred at all the order was ALREADY this — the recency key was never wrong.
  assert.deepEqual(names(orderQuests(list, 'recent', () => 0)), [
    'Magician Test of Gesticulation',
    'Warrior Test of Think'
  ])
})

/**
 * RECENCY IS KEYED ON THE LOOT LEDGER, AND NOTHING ELSE CAN HIDE A LOOT (JOS-146's other half).
 *
 * The suspicion the ticket carried was that recency might be derived from COUNT deltas, which the
 * JOS-141 additive rule could suppress: an inventory dump that already covers an item leaves the
 * held count unchanged, so a count-derived recency would show no loot at all. It is not — the key
 * is the loot event's own timestamp. This pins that independence so a future "derive it from the
 * counts, they are right there" cannot quietly reintroduce it.
 */
test('JOS-146 — a loot dates the quest even when it moves no count', () => {
  const loot: LootEvent[] = [
    { ts: 1_000, item: 'Hazy Opal' },
    // The SAME item again. Held counts go 1 -> 2, but even a fold that saw no change (a dump
    // already covering it, a turn-in subtracting it back off) must not lose the instant.
    { ts: 9_000, item: 'Hazy Opal' }
  ]
  assert.equal(computeLastLootedAt(loot)['hazy opal'], 9_000)
  // Recency does not consult holdings: a quest with none of its items in hand still dates.
  const held = computeHeldCounts(loot)
  assert.equal(held['hazy opal'], 2)
  const items = [item('Hazy Opal', { lastLootedAt: 9_000, have: 0, need: 1 })]
  assert.equal(questDropRecency(items), 9_000)
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
