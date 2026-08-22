// QUEST FACETS — the Sky tab's boss/island filter (JOS-124).
//
// The filter is two derivations plus a predicate, all pure, so this suite is where its RULES
// live. Everything measured below is read off the COMMITTED data (`data/eqlegends/posky.json`
// joined to `data/eqlegends/mobs.json` through poskyDroppers), so a re-scrape that changes the
// join changes this suite; the synthetic quests are only for the ordering and semantics cases
// that real data cannot state cleanly.
//
// What it pins:
//   - a quest names EVERY island its items state and EVERY boss they resolve, deduped;
//   - law 1: a wind-rune quest names NO boss and NO island rather than a guessed one, and so is
//     never swept into a boss pick;
//   - the facets read every required item, NOT only the still-needed ones — a filter must not
//     drop a quest the moment its drop lands (the caption's rule and the filter's differ, on
//     purpose; the header of questFacets.ts argues it);
//   - OR inside a dimension, AND across the two;
//   - empty is NO FILTER, and returns the caller's own array;
//   - the picker options: islands ascending, bosses by how many quests they stand in front of;
//   - `withPicked` keeps a stored pick the data no longer offers visible and removable.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  facetOptions,
  filterByFacets,
  matchesFacets,
  questBosses,
  questIslands,
  withPicked,
  type FacetQuest
} from '../src/renderer/src/features/posky/questFacets'
import { skyDroppersFor } from '../src/renderer/src/features/posky/poskyDroppers'
import poskyRaw from '../src/renderer/src/data/eqlegends/posky.json' with { type: 'json' }
import type { PoskyQuest } from '../src/shared/types'

const QUESTS = (poskyRaw as { quests: PoskyQuest[] }).quests

/** One committed quest as the tracker computes it, minus the progress the facets never read. */
function facetQuest(q: PoskyQuest): FacetQuest {
  return { items: q.items.map((it) => ({ where: it.where, droppers: skyDroppersFor(it.name, it.who) })) }
}

const byName = (className: string, name: string): FacetQuest => {
  const q = QUESTS.find((x) => x.className === className && x.name === name)
  assert.ok(q, `quest not found: ${className} / ${name}`)
  return facetQuest(q)
}

/** A hand-built quest: `[where, ...droppers]` per required item. */
const quest = (...items: [string, ...string[]][]): FacetQuest => ({
  items: items.map(([where, ...names]) => ({ where, droppers: names.map((name) => ({ name })) }))
})

const ALL = QUESTS.map(facetQuest)

// =============================================================================
// 1. The derivations, over the real committed data
// =============================================================================

test('a real quest names the island it states and the boss its item resolves', () => {
  // Bard Test of Tone: Light Woolen Mask (Gorgalosk, Island 3) + Wind Rune Meda (random drop).
  const tone = byName('Bard', 'Bard Test of Tone')
  assert.deepEqual(questIslands(tone), ['Island 3'])
  assert.deepEqual(questBosses(tone), ['Gorgalosk'])
})

// JOS-129 — a bard reported the Bard Test of Brass turn-in MISSING from the Sky data. It is not:
// the committed posky.json carries the row in full, all three item names resolve in the item DB
// with era Sky, and the facets below already file the quest under its island and its bosses. So
// there was nothing to add, and what the ticket earns instead is this guard: the row a reporter
// went looking for is now pinned by NAME, so a re-scrape cannot drop it silently the way the
// report claimed one had.
//
// It also records the one place the repo's own data DISAGREES with the report, which is why the
// app says what it says. The report names the Glowing Diamond dropper "Spiroc of the Skies"; no
// mob by that name exists in the 7,872-row catalog. The catalog says Sister of the Spire, and so
// does posky's own "SotS" abbreviation (poskyDroppers.ts measures SotS -> Sister of the Spire
// across 17 rows). Two independent sources agree, the reported name is in neither, and the
// assertion below is written against the sources rather than the report.
//
// Efreeti War Horn is the second half of the shape and is deliberately NOT an oversight: posky
// states no island and no dropper for it, and the reverse index over the catalog answers with the
// three efreeti-loot bosses anyway. That is the two layers working, and it is why the quest's
// boss list is longer than its island list.
test('JOS-129 — Bard Test of Brass is in the data, and the facets file it under Island 7', () => {
  const brass = QUESTS.find((q) => q.className === 'Bard' && q.name === 'Bard Test of Brass')
  assert.ok(brass, 'Bard Test of Brass is missing from posky.json')
  assert.equal(brass.reward, "Denon's Horn of Disaster")
  const required = brass.items.map((it) => it.name)
  assert.ok(required.includes('Glowing Diamond'), `items: ${required.join(', ')}`)
  assert.ok(required.includes('Efreeti War Horn'), `items: ${required.join(', ')}`)

  // Island 7 comes from Glowing Diamond's STATED where; Efreeti War Horn states none and the
  // wind rune's "Plane of Sky" is not an island, so exactly one island is right.
  const facets = facetQuest(brass)
  assert.deepEqual(questIslands(facets), ['Island 7'])
  // The catalog's answer, not the report's. Sister of the Spire drops the diamond; the other
  // three are the Efreeti War Horn droppers the reverse index resolves.
  assert.deepEqual(questBosses(facets), [
    'Noble Dojorn',
    'Overseer of Air',
    'Sister of the Spire',
    'the Hand of Veeshan'
  ])
  assert.equal(questBosses(facets).includes('Spiroc of the Skies'), false)

  // And the filter a player standing on island 7 would actually set keeps it.
  assert.equal(matchesFacets(facets, { islands: ['Island 7'], bosses: ['Sister of the Spire'] }), true)
  // Both pickers OFFER what this quest is filed under, so the chips exist to be clicked.
  const opts = facetOptions(ALL)
  assert.ok(opts.islands.includes('Island 7'))
  assert.ok(opts.bosses.includes('Sister of the Spire'))
})

test('LAW 1 — a quest with no resolvable dropper names NO boss, and keeps the island it states', () => {
  // MEASURED over the committed files, re-measured 2026-08-22: ZERO quests resolve no boss now.
  // The old two — the Azarack pair — gained a real dropper when the Protector of Sky page began
  // listing Azarack Skin/Blood (wiki edit 2026-08-21), so the case that proved the two axes are
  // independent has left the committed data. The LAW is still enforced on a synthetic row below;
  // this count is the tripwire that says which world the suite is measuring.
  const bossless = ALL.filter((q) => questBosses(q).length === 0)
  assert.equal(bossless.length, 0, `boss-less quests: ${bossless.length}`)
  // The synthetic no-dropper quest: an island stated in words, an item no catalog page lists.
  const synthetic = {
    items: [{ where: 'Island 2', droppers: skyDroppersFor('Large Sky Lapis') }]
  }
  assert.deepEqual(questBosses(synthetic), [])
  assert.deepEqual(questIslands(synthetic), ['Island 2'])
  assert.equal(matchesFacets(synthetic, { islands: ['Island 2'], bosses: [] }), true)
  assert.equal(matchesFacets(synthetic, { islands: ['Island 3'], bosses: [] }), false)
  // No boss pick can reach it, not even the zone's biggest.
  for (const boss of facetOptions(ALL).bosses)
    assert.equal(matchesFacets(synthetic, { islands: [], bosses: [boss] }), false, boss)
  // …but no pick at all still shows it. Absence of a facet is not absence of the quest.
  assert.equal(matchesFacets(synthetic, { islands: [], bosses: [] }), true)
})

test('a wind rune contributes neither facet: "Plane of Sky" is not an island and has no dropper', () => {
  // Every quest carries one, so this is the shape both derivations must ignore rather than
  // round into a chip. (posky itself calls it a random drop - there IS no kill target.)
  const rune = { items: [{ where: 'Plane of Sky', droppers: skyDroppersFor('Wind Rune Meda') }] }
  assert.deepEqual(questIslands(rune), [])
  assert.deepEqual(questBosses(rune), [])
})

test('every derived island and boss is one the committed data STATES for that quest', () => {
  for (const q of ALL) {
    const wheres = new Set(q.items.map((it) => it.where))
    for (const i of questIslands(q)) assert.ok(wheres.has(i), `${i} is stated by no item`)
    const named = new Set(q.items.flatMap((it) => it.droppers.map((d) => d.name)))
    for (const b of questBosses(q)) assert.ok(named.has(b), `${b} drops nothing this quest needs`)
  }
})

// =============================================================================
// 2. The derivations' shape: dedupe, order, and multi-island quests
// =============================================================================

test('islands dedupe and sort by NUMBER, bosses dedupe and sort case-folded', () => {
  const q = quest(
    ['Island 10', 'Zeta', 'Alpha'],
    ['Island 2', 'alpha'],
    ['Island 10', 'Zeta']
  )
  assert.deepEqual(questIslands(q), ['Island 2', 'Island 10'])
  // 'alpha' and 'Alpha' are different catalog spellings and stay distinct rows (law 2: display
  // raw); the ORDER is case-folded so the article-led names do not sort by their capital.
  assert.deepEqual(questBosses(q), ['Alpha', 'alpha', 'Zeta'])
})

test('"Plane of Sky" and a blank where are not islands', () => {
  assert.deepEqual(questIslands(quest(['Plane of Sky'], [''], ['Island 4'])), ['Island 4'])
  assert.deepEqual(questIslands(quest(['Plane of Sky'], [''])), [])
})

// =============================================================================
// 3. A FACET IS A PROPERTY OF THE QUEST, NOT OF YOUR PROGRESS
// =============================================================================

test('the facets read EVERY required item, so a quest cannot leave its boss by being looted', () => {
  // `KillTargetItem` carries have/need and questKillTargets drops what you hold; a FacetItem
  // carries neither, by construction. Standing in front of Gorgalosk with the mask already in
  // the bag, the quest is still one of Gorgalosk's.
  const tone = byName('Bard', 'Bard Test of Tone')
  assert.equal(matchesFacets(tone, { islands: [], bosses: ['Gorgalosk'] }), true)
  assert.equal(Object.keys(tone.items[0]).includes('have'), false)
})

// =============================================================================
// 4. The predicate: OR within, AND across, empty is no filter
// =============================================================================

const three = quest(['Island 3', 'Gorgalosk'])
const five = quest(['Island 5', 'Bazzt Zzzt'])
const both = quest(['Island 3', 'Gorgalosk'], ['Island 5', 'Bazzt Zzzt'])

test('OR inside a dimension: any picked island matches', () => {
  assert.equal(matchesFacets(three, { islands: ['Island 3', 'Island 7'], bosses: [] }), true)
  assert.equal(matchesFacets(five, { islands: ['Island 3', 'Island 7'], bosses: [] }), false)
  assert.equal(matchesFacets(five, { islands: [], bosses: ['Gorgalosk', 'Bazzt Zzzt'] }), true)
})

test('AND across the dimensions: one more chip always narrows', () => {
  assert.equal(matchesFacets(both, { islands: ['Island 3'], bosses: ['Bazzt Zzzt'] }), true)
  // Island 3 AND a boss this quest never drops for: no match, even though each half would pass.
  assert.equal(matchesFacets(three, { islands: ['Island 3'], bosses: ['Bazzt Zzzt'] }), false)
})

test('empty is NO FILTER, and hands back the caller\'s own array untouched', () => {
  const list = [three, five, both]
  assert.equal(filterByFacets(list, { islands: [], bosses: [] }), list)
  assert.deepEqual(filterByFacets(list, { islands: ['Island 5'], bosses: [] }), [five, both])
  assert.deepEqual(filterByFacets(list, { islands: [], bosses: ['Gorgalosk'] }), [three, both])
  assert.deepEqual(filterByFacets(list, { islands: ['Island 7'], bosses: [] }), [])
})

test('a real island pick narrows the real list, and clearing restores every quest', () => {
  const island7 = filterByFacets(ALL, { islands: ['Island 7'], bosses: [] })
  assert.ok(island7.length > 0 && island7.length < ALL.length, `island 7: ${island7.length}`)
  const lord = filterByFacets(ALL, { islands: [], bosses: ['The Spiroc Lord'] })
  assert.ok(lord.length > 0 && lord.length < ALL.length, `Spiroc Lord: ${lord.length}`)
  // Intersecting the two can only shrink, and never below the empty set.
  const both7 = filterByFacets(ALL, { islands: ['Island 7'], bosses: ['The Spiroc Lord'] })
  assert.ok(both7.length <= Math.min(island7.length, lord.length))
  assert.equal(filterByFacets(ALL, { islands: [], bosses: [] }).length, ALL.length)
})

// =============================================================================
// 5. The picker options
// =============================================================================

test('the real data offers a short closed list on both axes', () => {
  const opts = facetOptions(ALL)
  // MEASURED 2026-08-08 over the committed files: islands 2-8 (there is no island 1 quest) and
  // 20 distinct bosses. Floors and a ceiling, not frozen equality — a re-scrape may add rows.
  assert.deepEqual(opts.islands, [
    'Island 2',
    'Island 3',
    'Island 4',
    'Island 5',
    'Island 6',
    'Island 7',
    'Island 8'
  ])
  assert.ok(opts.bosses.length >= 15 && opts.bosses.length <= 40, `bosses: ${opts.bosses.length}`)
  // Ordered by coverage, so the zone's headline bosses lead rather than the one-off drakes.
  assert.equal(opts.bosses[0], 'Noble Dojorn')
  assert.ok(opts.bosses.slice(0, 6).includes('The Spiroc Lord'))
  // Every option actually selects something — an option that filters to nothing is a trap.
  for (const i of opts.islands)
    assert.ok(filterByFacets(ALL, { islands: [i], bosses: [] }).length > 0, `${i} matches nothing`)
  for (const b of opts.bosses)
    assert.ok(filterByFacets(ALL, { islands: [], bosses: [b] }).length > 0, `${b} matches nothing`)
})

test('options are counted, not guessed: coverage leads, name breaks the tie', () => {
  const opts = facetOptions([
    quest(['Island 5', 'Zeta']),
    quest(['Island 2', 'Zeta']),
    quest(['Island 10', 'Alpha']),
    quest(['Island 2', 'omega'])
  ])
  assert.deepEqual(opts.islands, ['Island 2', 'Island 5', 'Island 10'])
  assert.deepEqual(opts.bosses, ['Zeta', 'Alpha', 'omega'])
})

test('options over no quests are empty, never a placeholder', () => {
  assert.deepEqual(facetOptions([]), { islands: [], bosses: [] })
})

// =============================================================================
// 6. A stored pick the data no longer offers
// =============================================================================

test('withPicked appends an unknown pick so the chip stays visible and removable', () => {
  assert.deepEqual(withPicked(['Island 2', 'Island 3'], []), ['Island 2', 'Island 3'])
  assert.deepEqual(withPicked(['Island 2'], ['Island 2']), ['Island 2'])
  // The case it exists for: a persisted boss the re-scrape renamed away.
  assert.deepEqual(withPicked(['Gorgalosk'], ['Gorgalosck']), ['Gorgalosk', 'Gorgalosck'])
  // A repeated pick is added once.
  assert.deepEqual(withPicked([], ['A', 'A', 'B']), ['A', 'B'])
})
