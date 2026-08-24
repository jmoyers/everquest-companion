// THE READOUT'S WHOLE-CATALOG SEARCH (JOS-450) — pinned twice, the way tests/bestSpells.test.mts is:
//   1. the RULES over hand-built data — the corpus, the out-of-class row, the level reading, the
//      tab's membership, the era mark, the rank, the cap;
//   2. the OWNER'S ACCEPTANCE CASE over the REAL committed corpus — a WIZARD searches a spell only a
//      DRUID can learn and gets a row, wearing `DRU 40`, read at the level he is viewing.
//
// WHAT THIS PINS THAT `tests/bestSpells.test.mts` DOES NOT: that file's corpus is what a loadout
// OWNS, and every rule in it is about ranking that slice. Everything here is about the slice being
// gone — a result may be a spell no class in the loadout has, at a level the character has not
// reached, and it must still be a readout row rather than a different kind of row that happens to
// sit in the same panel.
//
// SHAPES AND ORDERINGS OVER THE REAL DATA, never today's figures: the committed catalog is a scrape
// and a re-scrape is a data change (AGENTS.md). The hand-built half is where exact numbers live.
//
// No Electron, no network, no live log — this suite never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ClassAbbr, ComboInterval, ComboSlot } from '../src/shared/classCombo'
import { defaultSort, type BestSpellSort, type BestSpellTab } from '../src/shared/bestSpells'
import {
  BEST_SPELL_SEARCH_CAP,
  EMPTY_BEST_SPELL_SEARCH,
  elsewhereLabel,
  searchBestSpells,
  type BestSpellSearchAsk,
  type BestSpellSearchRow
} from '../src/shared/bestSpellsSearch'
import { comboClassesOf, comboClassSet, type LevelUnlockData } from '../src/shared/levelUnlocks'
import { tokenizeSpellQuery } from '../src/shared/spellSearch'
import { buildLevelUnlocks } from '../src/main/data/levelUnlocks'

// ---- fixtures ---------------------------------------------------------------------------

const slot = (candidates: ClassAbbr[]): ComboSlot => ({
  candidates,
  confidence: candidates.length === 1 ? 1 : 0.4,
  provenance: 'inferred',
  because: []
})

function interval(slots: ComboSlot[]): ComboInterval {
  return {
    id: 'ci0',
    startTs: 0,
    endTs: null,
    startLo: 0,
    startHi: 0,
    endLo: null,
    endHi: null,
    startReason: 'logStart',
    expectedSlots: slots.length,
    slots,
    levelLo: null,
    levelHi: null,
    evidenceCount: slots.length,
    userLocked: false
  }
}

/** The loadout classes, exactly as the panel computes them before handing them to the fold. */
const classesOf = (classes: ClassAbbr[]): ClassAbbr[] =>
  comboClassSet(comboClassesOf(interval(classes.map((c) => slot([c])))))

/**
 * A hand-built catalog with one of each shape this file has a rule for: a spell the wizard owns, a
 * spell only a druid can ever learn, one the wizard reaches LATER, an out-of-era one, one with no
 * hitpoint line at all, a heal, a ramp, and an area spell.
 */
const DATA: LevelUnlockData = {
  spells: [
    {
      name: 'Ramp Bolt',
      at: [{ cls: 'WIZ', level: 18 }],
      mana: 100,
      castTimeMs: 3000,
      hpLines: ['Decrease Hitpoints by 100 (L18) to 300 (L34)']
    },
    {
      name: 'Flat Bolt',
      at: [{ cls: 'WIZ', level: 20 }],
      mana: 50,
      castTimeMs: 1000,
      hpLines: ['Decrease Hitpoints by 150']
    },
    {
      name: 'Later Bolt',
      at: [{ cls: 'WIZ', level: 40 }],
      mana: 10,
      castTimeMs: 1000,
      hpLines: ['Decrease Hitpoints by 900']
    },
    {
      // THE OUT-OF-CLASS ROW this ticket exists for: no wizard can ever learn it.
      name: 'Bolt of Bark',
      at: [{ cls: 'DRU', level: 44 }],
      mana: 90,
      castTimeMs: 2000,
      hpLines: ['Decrease Hitpoints by 400']
    },
    {
      // The same spell on two class pages at two levels — the chips must carry both.
      name: 'Shared Bolt',
      at: [
        { cls: 'DRU', level: 30 },
        { cls: 'SHM', level: 35 }
      ],
      mana: 70,
      castTimeMs: 2000,
      hpLines: ['Decrease Hitpoints by 200']
    },
    {
      name: 'Kunark Bolt',
      at: [{ cls: 'DRU', level: 25 }],
      mana: 40,
      castTimeMs: 1000,
      outOfEra: true,
      hpLines: ['Decrease Hitpoints by 500']
    },
    {
      name: 'Bolt Mend',
      at: [{ cls: 'CLR', level: 10 }],
      mana: 40,
      castTimeMs: 2000,
      hpLines: ['Increase Hitpoints by 200']
    },
    { name: 'Bolt Gate', at: [{ cls: 'WIZ', level: 12 }], mana: 30 },
    {
      name: 'Bolt Storm',
      at: [{ cls: 'WIZ', level: 22 }],
      mana: 120,
      castTimeMs: 3000,
      targetType: 'Targeted AE',
      hpLines: ['Decrease Hitpoints by 100']
    }
  ],
  skills: {}
}

/** The ask a wizard's panel makes: his loadout, his viewed level, the tab on screen, its own sort. */
function ask(
  tab: BestSpellTab,
  level: number,
  classes: ClassAbbr[] = ['WIZ'],
  extra: Partial<BestSpellSearchAsk> = {}
): BestSpellSearchAsk {
  return { classes: classesOf(classes), level, tab, sort: defaultSort(tab), ...extra }
}

/** Search `DATA` and hand back the rows, which is what almost every assertion here is about. */
function find(query: string, a: BestSpellSearchAsk): BestSpellSearchRow[] {
  return searchBestSpells(DATA, tokenizeSpellQuery(query), a).rows
}

/** The named row, which MUST be there — so an assertion reads about the row, not about a null. */
function rowOf(rows: readonly BestSpellSearchRow[], name: string): BestSpellSearchRow {
  const row = rows.find((r) => r.name === name)
  assert.ok(row, `no ${name} row in [${rows.map((r) => r.name).join(', ')}]`)
  return row
}

// ---- the rule the file exists for ---------------------------------------------------------

test('the corpus is the WHOLE catalog: a wizard finds the druid spell, wearing its class level', () => {
  const rows = find('bolt of bark', ask('dd', 35))
  const row = rowOf(rows, 'Bolt of Bark')
  assert.equal(row.owned, false, 'no wizard can learn it')
  assert.deepEqual(row.classes, [], 'the loadout owns none of it, so it claims no loadout class')
  assert.deepEqual(row.levels, [{ cls: 'DRU', level: 44 }], 'the chip is DRU 44')
  // The figures are real ones, read at the level on screen — this is a readout row, not a stub.
  assert.equal(row.metrics.damage, 400)
})

test('an in-class row is the row the ranked table would have drawn', () => {
  const row = rowOf(find('ramp bolt', ask('dd', 35)), 'Ramp Bolt')
  assert.equal(row.owned, true)
  assert.deepEqual(row.classes, ['WIZ'])
  assert.deepEqual(row.levels, [{ cls: 'WIZ', level: 18 }])
  assert.equal(row.gainedAt, 18, 'the level it became YOURS')
  assert.equal(row.metrics.damage, 300, 'the ramp is read at 35, the level being viewed')
})

test('a spell above the viewed level still answers - the reader is window shopping', () => {
  // Both of these are out of reach at 35: the wizard reaches his own at 40, and the druid spell is
  // never his at all. The ranked table has neither; the search has both, with their own levels on.
  const rows = find('bolt', ask('dd', 35))
  const later = rowOf(rows, 'Later Bolt')
  assert.equal(later.owned, false, 'a WIZ 40 spell is not owned at 35')
  assert.equal(later.gainedAt, 40, 'and the row says when it will be')
  assert.equal(rowOf(rows, 'Bolt of Bark').gainedAt, 44)
})

test('a ramp read below its own band is CLAMPED, never extrapolated', () => {
  // `Decrease Hitpoints by 100 (L18) to 300 (L34)` viewed at 5 is the page's own low end. A number
  // the wiki never claimed would be worse than no number at all.
  assert.equal(rowOf(find('ramp bolt', ask('dd', 5)), 'Ramp Bolt').metrics.damage, 100)
})

test('the gain level a result prints is the LOADOUT`s when it has one, and the spell`s otherwise', () => {
  const shared = rowOf(find('shared bolt', ask('dd', 50)), 'Shared Bolt')
  assert.equal(shared.owned, false, 'neither DRU nor SHM is in this wizard loadout')
  assert.equal(shared.gainedAt, 30, 'the lowest level anyone in the game gets it at')
  assert.deepEqual(shared.levels, [
    { cls: 'DRU', level: 30 },
    { cls: 'SHM', level: 35 }
  ])
  // The same spell asked about by a SHAMAN: now it is his, and the row says so at HIS level.
  const mine = rowOf(find('shared bolt', ask('dd', 50, ['SHM'])), 'Shared Bolt')
  assert.equal(mine.owned, true)
  assert.equal(mine.gainedAt, 35)
  assert.deepEqual(mine.classes, ['SHM'])
  assert.deepEqual(mine.levels, shared.levels, 'the chips are a fact about the game, not about you')
})

test('a result answers on the TAB in front of the reader, and the rest are counted out loud', () => {
  const dd = searchBestSpells(DATA, tokenizeSpellQuery('bolt'), ask('dd', 60))
  const names = dd.rows.map((r) => r.name)
  assert.equal(names.includes('Bolt Mend'), false, 'a heal is not a DD row')
  assert.equal(names.includes('Bolt Gate'), false, 'a spell with no hitpoint line has no figures')
  assert.equal(dd.elsewhere, 2, 'the heal and the spell with no figures at all')
  // Every one of the nine fixture spells has `bolt` in its name, so the two numbers must add up.
  assert.equal(dd.rows.length + dd.elsewhere, 9, 'every `bolt` match is either drawn or counted')

  // The same query on the healing tab finds the one heal and counts everything else.
  const heal = searchBestSpells(DATA, tokenizeSpellQuery('bolt'), ask('heal', 60))
  assert.deepEqual(heal.rows.map((r) => r.name), ['Bolt Mend'])
  assert.equal(heal.rows.length + heal.elsewhere, 9)
})

test('the AOE tab keeps its own corpus and its own assumption', () => {
  const aoe = searchBestSpells(DATA, tokenizeSpellQuery('bolt'), ask('aoe', 60))
  assert.deepEqual(aoe.rows.map((r) => r.name), ['Bolt Storm'], 'only the area-shaped spell')
  const row = aoe.rows[0]
  assert.equal(row.targets, 4, 'the default cap, the same one the ranked AOE table assumes')
  assert.equal(row.hits, 4)
  assert.equal(row.metrics.damage, 400, '100 a hit, four hits')
  // …and the SAME spell on the DD tab is the single-target reading, unchanged.
  assert.equal(rowOf(find('bolt storm', ask('dd', 60)), 'Bolt Storm').metrics.damage, 100)
})

test('the era verdict is MARKED on a result, never folded away', () => {
  // The ranked tables put these behind a disclosure; a search answers the question that was typed.
  const row = rowOf(find('kunark bolt', ask('dd', 60)), 'Kunark Bolt')
  assert.equal(row.outOfEra, true)
  assert.equal(row.metrics.damage, 500, 'and it is a real row with real figures')
})

test('every row is read at max(observed, simulated) rank, out-of-class rows included', () => {
  const base = rowOf(find('bolt of bark', ask('dd', 44)), 'Bolt of Bark')
  const lifted = rowOf(find('bolt of bark', ask('dd', 44, ['WIZ'], { simulate: 6 })), 'Bolt of Bark')
  assert.equal(base.rank, 0)
  assert.equal(lifted.rank, 6)
  assert.ok(
    (lifted.metrics.damage ?? 0) > (base.metrics.damage ?? 0),
    `${String(lifted.metrics.damage)} vs ${String(base.metrics.damage)}`
  )
})

test('the results carry the tab`s own sort, and flipping it flips them', () => {
  // The DD tab opens on `dps`, best first — the same default the ranked table opens on.
  const desc = find('bolt', ask('dd', 60)).map((r) => r.metrics.dps ?? 0)
  assert.deepEqual([...desc].sort((a, b) => b - a), desc, `not descending: ${desc.join(',')}`)
  const asc: BestSpellSort = { column: 'damage', desc: false }
  const up = find('bolt', ask('dd', 60, ['WIZ'], { sort: asc })).map((r) => r.metrics.damage ?? 0)
  assert.deepEqual([...up].sort((a, b) => a - b), up, `not ascending: ${up.join(',')}`)
})

test('an empty query is not a question here - the ranked tabs are the answer to it', () => {
  assert.deepEqual(searchBestSpells(DATA, tokenizeSpellQuery('   '), ask('dd', 35)), EMPTY_BEST_SPELL_SEARCH)
  assert.deepEqual(searchBestSpells(DATA, [], ask('dd', 35)), EMPTY_BEST_SPELL_SEARCH)
})

test('the cap states what it is not showing', () => {
  const capped = searchBestSpells(DATA, tokenizeSpellQuery('bolt'), ask('dd', 60, ['WIZ'], { cap: 2 }))
  assert.equal(capped.rows.length, 2)
  assert.ok(capped.matched > 2)
  assert.equal(capped.hidden, capped.matched - 2)
})

test('the `elsewhere` sentence names the tab rather than blaming the spells', () => {
  assert.equal(elsewhereLabel(0, 'DD'), null)
  assert.equal(elsewhereLabel(3, 'DD'), '3 more match with no DD reading')
  assert.equal(elsewhereLabel(1, 'HoT'), '1 more match with no HoT reading')
})

// ---- the same matcher as the unlock search --------------------------------------------------

test('the grammar is the shared one: a class word, a level and a band all narrow the results', () => {
  // `class:` scopes to the class pages, which is the whole reason an out-of-class search is usable.
  assert.deepEqual(find('class:dru bolt', ask('dd', 60)).map((r) => r.name).sort(), [
    'Bolt of Bark',
    'Kunark Bolt',
    'Shared Bolt'
  ])
  // A band is scoped to the classes the query named — `27-28 cleric shaman`'s rule, one file over.
  assert.deepEqual(find('class:dru level:40-50 bolt', ask('dd', 60)).map((r) => r.name), ['Bolt of Bark'])
  // A `class:` prefix naming nothing we know narrows to zero rather than widening to everything.
  assert.deepEqual(find('class:jedi bolt', ask('dd', 60)), [])
})

// ---- the acceptance case, over the REAL committed corpus ------------------------------------

const REAL = buildLevelUnlocks()

test('JOS-450 acceptance: a WIZARD at 35 can look up a spell only a DRUID learns, and compare it', () => {
  // The owner's ask, read literally: "i want to be able to search for things outside my class to
  // compare". `Blossoming Heal` is DRU 40, druid-only, in era, and a wizard will never own it. Its
  // healing arrives per tick, so the tab that reads it is HoT — the membership test the ranked
  // tables use is applied to an out-of-class row exactly as it is to one of yours.
  const found = searchBestSpells(REAL, tokenizeSpellQuery('blossoming heal'), ask('hot', 35, ['WIZ']))
  const row = rowOf(found.rows, 'Blossoming Heal')
  assert.equal(row.owned, false)
  assert.deepEqual(row.classes, [])
  assert.deepEqual(row.levels, [{ cls: 'DRU', level: 40 }], 'the chip the owner asked for')
  assert.equal(row.gainedAt, 40, 'stated above the 35 he is viewing, which is what marks it a preview')
  assert.ok((row.metrics.heal ?? 0) > 0, 'and it is a readout row: a real figure in the heal column')
  // …and the SAME query on the instant-heal tab draws nothing, and says why rather than going blank.
  const wrongTab = searchBestSpells(REAL, tokenizeSpellQuery('blossoming heal'), ask('heal', 35, ['WIZ']))
  assert.deepEqual(wrongTab.rows, [])
  assert.equal(wrongTab.elsewhere, 1)
})

test('JOS-450 acceptance: the chips carry EVERY class the DB places a spell for, at its own level', () => {
  // `Superior Healing` is the brief's own shape: four classes, four different levels, DRU at 44.
  const row = rowOf(
    searchBestSpells(REAL, tokenizeSpellQuery('superior healing'), ask('heal', 35, ['WIZ'])).rows,
    'Superior Healing'
  )
  const chips = row.levels.map((p) => `${p.cls} ${String(p.level)}`)
  assert.deepEqual(chips, ['CLR 30', 'DRU 44', 'SHM 45', 'PAL 46'], chips.join(' · '))
  // Ascending by level then class code, which is the order the chips are drawn in.
  assert.deepEqual([...row.levels].sort((x, y) => x.level - y.level), row.levels)
})

test('JOS-450 over the real corpus: the loadout still decides what is YOURS', () => {
  // The same spell, asked by a cleric who has it and by a cleric who has not reached it.
  const at35 = rowOf(
    searchBestSpells(REAL, tokenizeSpellQuery('superior healing'), ask('heal', 35, ['CLR'])).rows,
    'Superior Healing'
  )
  assert.equal(at35.owned, true)
  assert.deepEqual(at35.classes, ['CLR'])
  assert.equal(at35.gainedAt, 30)
  const at20 = rowOf(
    searchBestSpells(REAL, tokenizeSpellQuery('superior healing'), ask('heal', 20, ['CLR'])).rows,
    'Superior Healing'
  )
  assert.equal(at20.owned, false, 'a CLR 30 spell is not his at 20')
  assert.equal(at20.gainedAt, 30, 'and the row says when it will be')
})

test('JOS-450 over the real corpus: a broad query is capped and says how much it is holding back', () => {
  // A bare class word matches hundreds of rows. The cap bites, and the count behind it is honest.
  const found = searchBestSpells(REAL, tokenizeSpellQuery('class:wiz'), ask('dd', 60, ['WIZ']))
  assert.equal(found.rows.length, Math.min(found.matched, BEST_SPELL_SEARCH_CAP))
  assert.equal(found.hidden, Math.max(0, found.matched - BEST_SPELL_SEARCH_CAP))
  assert.ok(found.matched > 0, 'a wizard has DD spells')
  // Every drawn row really is a wizard row, and really has a DD figure.
  for (const row of found.rows) {
    assert.ok(row.levels.some((p) => p.cls === 'WIZ'), row.name)
    assert.ok(row.metrics.damage !== undefined, row.name)
    assert.notEqual(row.metrics.dot, true, `${row.name} ticks and belongs in the DoT tab`)
  }
})
