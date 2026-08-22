// QUEST SEARCH — what the Plane of Sky search box matches (JOS-207).
//
// The box searched three fields (quest name, reward, required item names) and the owner asked for
// the two a player standing in the zone actually types: the BOSS he is about to pull and the
// ISLAND he is standing on. Those two were reachable only through the facet dropdowns, so typing
// "Gorgalosk" into a box that already knew which sixteen quests Gorgalosk stands in front of
// returned nothing at all.
//
// What this suite pins:
//   - THE HEADLINE, off the committed data: "Gorgalosk" finds sixteen quests, and NOT ONE of them
//     mentions him in a name, a reward or an item — so every one of those hits is reach the box
//     did not have before, rather than a coincidence of spelling;
//   - ONE TRUTH, NO SECOND MAPPING: for every boss and every island the pickers OFFER, searching
//     that name finds at least the quests the picker's own `filterByFacets` narrows to, and for a
//     name that appears nowhere else it finds EXACTLY them. The search and the dropdowns cannot
//     disagree about what a quest's bosses and islands are, because they are the same derivation;
//   - LAW 1 INHERITED: a quest whose items resolve no boss (the Azarack pair — see
//     questFacets.test.mts) is findable by NO boss name, because the data states none;
//   - the original three fields are untouched, and the rule over all five is the SAME one —
//     lowercased substring, OR across fields;
//   - an empty or whitespace-only query is NO filter and returns the caller's own array.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  filterByQuery,
  questMatchesQuery,
  type SearchQuest
} from '../src/renderer/src/features/posky/questSearch'
import {
  facetOptions,
  filterByFacets,
  questBosses,
  questIslands
} from '../src/renderer/src/features/posky/questFacets'
import { skyDroppersFor } from '../src/renderer/src/features/posky/poskyDroppers'
import poskyRaw from '../src/renderer/src/data/eqlegends/posky.json' with { type: 'json' }
import type { PoskyQuest } from '../src/shared/types'

const QUESTS = (poskyRaw as { quests: PoskyQuest[] }).quests

/** One committed quest as the search reads it — the same join the tab does (poskyDroppers). */
function searchQuest(q: PoskyQuest): SearchQuest & { className: string } {
  return {
    className: q.className,
    name: q.name,
    reward: q.reward,
    items: q.items.map((it) => ({
      name: it.name,
      where: it.where,
      droppers: skyDroppersFor(it.name, it.who)
    }))
  }
}

const ALL = QUESTS.map(searchQuest)
const OPTIONS = facetOptions(ALL)

/** The three fields the box matched BEFORE JOS-207, spelled out so "this hit is new" is provable. */
function matchedBefore(q: SearchQuest, needle: string): boolean {
  return (
    q.name.toLowerCase().includes(needle) ||
    (q.reward?.toLowerCase().includes(needle) ?? false) ||
    q.items.some((i) => i.name.toLowerCase().includes(needle))
  )
}

const keys = (list: readonly (SearchQuest & { className: string })[]): string[] =>
  list.map((q) => `${q.className}::${q.name}`).sort()

/** A hand-built quest: the name, then `[itemName, where, ...droppers]` per required item. */
function quest(name: string, ...items: [string, string, ...string[]][]): SearchQuest {
  return {
    name,
    items: items.map(([itemName, where, ...droppers]) => ({
      name: itemName,
      where,
      droppers: droppers.map((d) => ({ name: d }))
    }))
  }
}

// =============================================================================
// 1. The ask, against the committed data
// =============================================================================

test('JOS-207 — typing a boss name finds the quests he stands in front of', () => {
  const hits = filterByQuery(ALL, 'Gorgalosk')
  // MEASURED over the committed posky.json joined to mobs.json: sixteen class tests need
  // something Gorgalosk drops. A re-scrape that changes the join changes this number.
  assert.equal(hits.length, 16, keys(hits).join(', '))
  assert.ok(keys(hits).includes('Bard::Bard Test of Tone'), keys(hits).join(', '))

  // EVERY ONE OF THEM IS NEW REACH. Gorgalosk's name is in no quest name, no reward and no item
  // name in the whole file, so before this change the box answered "no quests" to the most
  // obvious question a player in front of him can ask.
  assert.equal(ALL.filter((q) => matchedBefore(q, 'gorgalosk')).length, 0)
})

test('JOS-207 — typing an island finds the quests that name it', () => {
  const hits = filterByQuery(ALL, 'Island 7')
  assert.equal(hits.length, 17, keys(hits).join(', '))
  // Same argument as the boss above: "Island 7" is stated by the item rows, never by a quest
  // name, a reward or an item name.
  assert.equal(ALL.filter((q) => matchedBefore(q, 'island 7')).length, 0)
  // And it is the island the FACET files them under, not a string that happens to be nearby.
  for (const q of hits) assert.ok(questIslands(q).includes('Island 7'), q.name)
})

// =============================================================================
// 2. One truth: the box and the dropdowns read the same derivation
// =============================================================================

test('searching a boss name finds AT LEAST what picking that boss does, for every boss offered', () => {
  assert.ok(OPTIONS.bosses.length >= 20, String(OPTIONS.bosses.length))
  for (const boss of OPTIONS.bosses) {
    const picked = keys(filterByFacets(ALL, { islands: [], bosses: [boss] }))
    const typed = new Set(keys(filterByQuery(ALL, boss)))
    assert.ok(picked.length > 0, boss)
    for (const k of picked) assert.ok(typed.has(k), `${boss}: picking finds ${k}, typing does not`)
  }
})

test('…and the same for every island offered', () => {
  assert.deepEqual(OPTIONS.islands, [
    'Island 2',
    'Island 3',
    'Island 4',
    'Island 5',
    'Island 6',
    'Island 7',
    'Island 8'
  ])
  for (const island of OPTIONS.islands) {
    const picked = keys(filterByFacets(ALL, { islands: [island], bosses: [] }))
    const typed = new Set(keys(filterByQuery(ALL, island)))
    assert.ok(picked.length > 0, island)
    for (const k of picked) assert.ok(typed.has(k), `${island}: picking finds ${k}, typing does not`)
  }
})

// AT LEAST rather than EXACTLY, because a boss name can legitimately also be a substring of an
// item name — and when it is, the box is right to return the union. "Spiroc" is that case in the
// committed data: The Spiroc Lord stands in front of eighteen quests, and eight quests name a
// Spiroc-something item. A search is an OR over five fields, so it answers with both.
test('a boss name that is ALSO an item word returns the union, not one of the two', () => {
  const byBoss = keys(ALL.filter((q) => questBosses(q).some((b) => b.toLowerCase().includes('spiroc'))))
  const byItem = keys(ALL.filter((q) => matchedBefore(q, 'spiroc')))
  assert.equal(byBoss.length, 18, byBoss.join(', '))
  assert.equal(byItem.length, 8, byItem.join(', '))
  const typed = new Set(keys(filterByQuery(ALL, 'Spiroc')))
  for (const k of [...byBoss, ...byItem]) assert.ok(typed.has(k), k)
  assert.equal(typed.size, new Set([...byBoss, ...byItem]).size)
})

// A name that resolves EXACTLY, which is the sharper version of the claim above: where the boss
// name appears in no other field, the search result IS the facet pick, quest for quest.
test('where a boss name appears nowhere else, typing it and picking it give the same list', () => {
  for (const boss of ['Gorgalosk', 'Noble Dojorn']) {
    assert.equal(ALL.filter((q) => matchedBefore(q, boss.toLowerCase())).length, 0, boss)
    assert.deepEqual(
      keys(filterByQuery(ALL, boss)),
      keys(filterByFacets(ALL, { islands: [], bosses: [boss] })),
      boss
    )
  }
})

// =============================================================================
// 3. Law 1 — the search inherits the facets' refusal to guess
// =============================================================================

test('LAW 1 — a quest that resolves no boss is found by no boss name', () => {
  // Re-measured 2026-08-22: the Azarack pair — the two quests this test used to name — gained a
  // real dropper when the Protector of Sky page began listing Azarack Skin/Blood, so NO committed
  // quest is boss-less any more (questFacets.test.mts measures the same zero and enforces the law
  // on a synthetic row). What this file can still assert over real data: the pair is now found BY
  // that boss's name, and still by the island it states.
  assert.deepEqual(ALL.filter((q) => questBosses(q).length === 0), [])
  const byBoss = keys(filterByQuery(ALL, 'Protector of Sky'))
  assert.ok(byBoss.includes('Beastlord::Beastlord Test of Azarack'), 'Azarack found by its new boss')
  assert.ok(byBoss.includes('Berserker::Berserker Test of Blood'), 'Blood found by its new boss')
  assert.ok(keys(filterByQuery(ALL, 'Island 2')).includes('Beastlord::Beastlord Test of Azarack'))
})

test('an island nobody is on matches nothing — no fuzzing, no nearest neighbour', () => {
  assert.equal(filterByQuery(ALL, 'Island 1').length, 0)
  assert.equal(filterByQuery(ALL, 'Island 9').length, 0)
})

// =============================================================================
// 4. The rule itself, on quests small enough to read
// =============================================================================

const TONE = quest('Bard Test of Tone', ['Light Woolen Mask', 'Island 3', 'Gorgalosk'])
const REWARDED: SearchQuest = { ...TONE, reward: 'Mask of Song' }

test('the same lowercased-substring rule over all five fields', () => {
  // The three that always worked…
  assert.equal(questMatchesQuery(REWARDED, 'test of tone'), true)
  assert.equal(questMatchesQuery(REWARDED, 'mask of song'), true)
  assert.equal(questMatchesQuery(REWARDED, 'woolen'), true)
  // …and the two JOS-207 adds, by the same rule: a fragment matches, and case is folded.
  assert.equal(questMatchesQuery(REWARDED, 'gorg'), true)
  assert.equal(questMatchesQuery(REWARDED, 'GORGALOSK'.toLowerCase()), true)
  assert.equal(questMatchesQuery(REWARDED, 'island 3'), true)
  assert.equal(questMatchesQuery(REWARDED, 'nothing here'), false)
})

test('a quest with no reward matches on the rest rather than throwing it away', () => {
  assert.equal(TONE.reward, undefined)
  assert.equal(questMatchesQuery(TONE, 'gorgalosk'), true)
  assert.equal(questMatchesQuery(TONE, 'mask of song'), false)
})

test('every island a quest names is searchable, not only the first', () => {
  const spread = quest(
    'Spread',
    ['Alpha', 'Island 2', 'Bzzzt'],
    ['Beta', 'Island 8', 'Protector of Sky']
  )
  assert.deepEqual(questIslands(spread), ['Island 2', 'Island 8'])
  assert.equal(questMatchesQuery(spread, 'island 8'), true)
  assert.equal(questMatchesQuery(spread, 'protector of sky'), true)
  assert.equal(questMatchesQuery(spread, 'island 5'), false)
})

test('EMPTY IS NO FILTER — and returns the caller’s own array', () => {
  assert.equal(filterByQuery(ALL, ''), ALL)
  assert.equal(filterByQuery(ALL, '   '), ALL)
  assert.equal(questMatchesQuery(TONE, ''), true)
})

test('the query is trimmed and folded once, by the filter rather than per quest', () => {
  assert.deepEqual(keys(filterByQuery(ALL, '  GoRgAlOsK  ')), keys(filterByQuery(ALL, 'Gorgalosk')))
})
