// THE SPELL FINDER behind the "New at this level" box (JOS-392) — the projection, not the grammar.
//
// `tests/spellSearch.test.mts` pins WHICH spells a query admits. This pins what the panel then
// draws about each of them, which is a different set of claims and the one a reader actually sees:
//
//   (U1) THE ROW: per-class chips WITH levels, the loadout-scoped classes behind the context
//        lines, and `already yours` read against the CHARACTER'S level rather than a level on
//        screen (there is none here).
//   (U2) THE ORDER AND THE CAP: lowest MATCHING level then name, capped with an honest count of
//        what is not shown.
//   (U3) THE QUIET `also`: a search row's chips already state every class and its level, so the
//        sentence that would restate them is silent — while `already yours` still prints.
//   (U4) THE REAL COMMITTED DATASET: the owner's own query, over the shipped rows, with the
//        figures and the line research the row draws already attached.
//
// No Electron, no live log, never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ownershipPhrase, type UnlockSpell } from '../src/shared/levelUnlocks'
import { tokenizeSpellQuery } from '../src/shared/spellSearch'
import { UNLOCK_SEARCH_CAP, classLevelLabel, searchUnlockSpells } from '../src/shared/unlockSearch'
import { buildLevelUnlocks } from '../src/main/data/levelUnlocks'

/** A hand-built dataset row. `searchText` is spelled out so each case says what it tests. */
function spell(over: Partial<UnlockSpell> & { name: string }): UnlockSpell {
  return { at: [], searchText: over.name.toLowerCase(), ...over }
}

const SPELLS: UnlockSpell[] = [
  spell({
    name: 'Superior Healing',
    at: [
      { cls: 'CLR', level: 27 },
      { cls: 'SHM', level: 34 },
      { cls: 'PAL', level: 45 }
    ],
    mana: 100,
    searchText: 'superior healing you feel much better.',
    replaces: [
      { name: 'Greater Healing', cls: 'CLR' },
      { name: 'Spirit Salve', cls: 'SHM' }
    ]
  }),
  spell({
    name: 'Celestial Healing',
    at: [{ cls: 'CLR', level: 28 }],
    searchText: 'celestial healing you feel a healing wave.'
  }),
  spell({
    name: 'Aura of Battle',
    at: [{ cls: 'PAL', level: 27 }],
    searchText: 'aura of battle'
  }),
  spell({
    name: 'Frost Bolt',
    at: [{ cls: 'WIZ', level: 12 }],
    searchText: 'frost bolt'
  })
]

/** The trio the fixtures are read for: a cleric/paladin/enchanter at 30. */
const TRIO = { classes: ['CLR', 'ENC', 'PAL'] as const, currentLevel: 30 }

const search = (q: string, ctx = TRIO, cap = UNLOCK_SEARCH_CAP): ReturnType<typeof searchUnlockSpells> =>
  searchUnlockSpells(SPELLS, tokenizeSpellQuery(q), { classes: [...ctx.classes], currentLevel: ctx.currentLevel }, cap)

// ─────────────────────────────────────────────────────────────────────────────
// (U1) THE ROW.

test('U1 a result row carries EVERY class with the level it gets the spell at', () => {
  const [row] = search('superior healing').rows
  assert.equal(row.name, 'Superior Healing')
  // Ascending by level, and it is the whole game's answer — not the loadout's.
  assert.deepEqual(row.levels?.map(classLevelLabel), ['CLR 27', 'SHM 34', 'PAL 45'])
  // …while the classes the CONTEXT lines are scoped to are the loadout's, and only those.
  assert.deepEqual(row.classes, ['CLR', 'PAL'], 'ENC does not get it; SHM is not in the loadout')
})

test('U1b `already yours` is read against the CHARACTER level, because no level is on screen', () => {
  // The cleric has it at 27 and this character is 30, so it is already theirs. The paladin gets it
  // at 45, which is a thing to look forward to and not a claim this row makes.
  const [row] = search('superior healing').rows
  assert.deepEqual(row.earlier, [{ cls: 'CLR', level: 27 }])
  assert.equal(ownershipPhrase(row, new Set(['CLR', 'ENC', 'PAL'])), 'already yours (CLR 27)')

  // A character who has not got there yet is told nothing rather than told a lie.
  const younger = search('superior healing', { classes: TRIO.classes, currentLevel: 20 }).rows[0]
  assert.equal(younger.earlier, undefined)
  assert.equal(ownershipPhrase(younger, new Set(['CLR'])), null)

  // An unknown loadout makes no claim at all — and still finds the spell.
  const noTrio = search('superior healing', { classes: [], currentLevel: 30 }).rows[0]
  assert.deepEqual(noTrio.classes, [])
  assert.equal(noTrio.earlier, undefined)
})

test('U1c a search row still carries the spell, so the figures and `replaces` are the row`s own', () => {
  const [row] = search('superior healing').rows
  assert.equal(row.spell?.name, 'Superior Healing')
  // `replaces` is scoped by `row.classes` (shared/levelUnlocks.ts), so the shaman's rung is not
  // printed to a cleric/paladin trio.
  assert.deepEqual(
    (row.spell?.replaces ?? []).filter((r) => row.classes.includes(r.cls)),
    [{ name: 'Greater Healing', cls: 'CLR' }]
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// (U2) THE ORDER AND THE CAP.

test('U2 rows sort by the LOWEST MATCHING level, then name', () => {
  // `27-28 cleric shaman` admits Superior Healing (CLR 27) and Celestial Healing (CLR 28) and
  // refuses Aura of Battle (PAL 27 — a paladin is not a cleric or a shaman).
  const { rows, matched } = search('27-28 cleric shaman')
  assert.deepEqual(rows.map((r) => r.name), ['Superior Healing', 'Celestial Healing'])
  assert.deepEqual(rows.map((r) => r.level), [27, 28])
  assert.equal(matched, 2)

  // THE MATCHING level, not the lowest one: with no class said, Superior Healing sorts on CLR 27;
  // asked about the SHAMAN it sorts on 34 and falls below the wizard's 12.
  const shm = searchUnlockSpells(SPELLS, tokenizeSpellQuery('shaman 30-40'), {
    classes: [],
    currentLevel: null
  })
  assert.deepEqual(shm.rows.map((r) => r.level), [34])
})

test('U2b the cap is honest about what it is not showing', () => {
  const capped = search('healing', TRIO, 1)
  assert.equal(capped.rows.length, 1)
  assert.equal(capped.matched, 2, 'the count is what MATCHED, never what was mounted')
  assert.equal(capped.hidden, 1)
  assert.equal(search('healing').hidden, 0, 'a query the cap does not bite hides nothing')
})

test('U2c a name the wiki carries twice is ONE row — a bookkeeping artefact never doubles a result', () => {
  const dupes: UnlockSpell[] = [
    spell({ name: 'Imbue Emerald', at: [{ cls: 'CLR', level: 29 }], searchText: 'imbue emerald' }),
    spell({ name: 'Imbue Emerald', at: [{ cls: 'PAL', level: 39 }], searchText: 'imbue emerald' })
  ]
  const { rows, matched } = searchUnlockSpells(dupes, tokenizeSpellQuery('imbue'), {
    classes: [],
    currentLevel: null
  })
  assert.equal(matched, 1)
  assert.deepEqual(rows[0].levels?.map(classLevelLabel), ['CLR 29', 'PAL 39'], 'both statements survive the fold')
})

// ─────────────────────────────────────────────────────────────────────────────
// (U3) THE QUIET `also`.

test('U3 a search row does not restate its own chips in words', () => {
  // Two loadout classes gain Superior Healing, so a LEVEL row would print `also PAL 45`. A search
  // row's chips already say `CLR 27 · SHM 34 · PAL 45`, so the sentence is silent — and this is
  // asserted on a row whose `already yours` arm is empty, which is where the `also` arm lives.
  const row = search('superior healing', { classes: TRIO.classes, currentLevel: 20 }).rows[0]
  assert.equal(row.classes.length, 2)
  assert.equal(ownershipPhrase(row, new Set(['CLR', 'PAL'])), null)
  // The same row WITHOUT the per-class chips is a level row again, and says it.
  const asLevelRow = { ...row, levels: undefined, level: 27 }
  assert.equal(ownershipPhrase(asLevelRow, new Set(['CLR', 'PAL'])), 'also PAL 27')
})

// ─────────────────────────────────────────────────────────────────────────────
// (U4) THE REAL COMMITTED DATASET.

test('U4 the owner query answers over the shipped dataset, and every row earns its place', () => {
  const data = buildLevelUnlocks()
  const { rows, matched } = searchUnlockSpells(data.spells, tokenizeSpellQuery('27-28 cleric shaman'), {
    classes: ['CLR', 'PAL', 'ENC'],
    currentLevel: 30
  })
  assert.ok(matched > 5, `the shipped dataset answers the owner query (${String(matched)} spells)`)
  for (const r of rows) {
    const chips = r.levels ?? []
    assert.ok(chips.length > 0, `${r.name}: a result row states at least one class level`)
    assert.ok(
      chips.some((c) => (c.cls === 'CLR' || c.cls === 'SHM') && c.level >= 27 && c.level <= 28),
      `${r.name}: every row is a cleric or shaman row inside the band`
    )
    assert.ok(r.level >= 27 && r.level <= 28, `${r.name}: it sorts on the level that matched`)
  }
  // Ascending, and stable by name inside a level.
  const keys = rows.map((r) => `${String(r.level)}|${r.name}`)
  assert.deepEqual(keys, [...keys].sort((a, b) => a.localeCompare(b)))
})

test('U4b a NAME finds its spell with every class level on it, and the rows keep their worth', () => {
  const data = buildLevelUnlocks()
  // The ticket's own pin, and it is a partial name on purpose: the DB spells the cleric 39 heal
  // `Complete Healing`, a player says `Complete Heal`, and a substring is what closes that gap.
  const { rows } = searchUnlockSpells(data.spells, tokenizeSpellQuery('Complete Heal'), {
    classes: ['CLR'],
    currentLevel: 60
  })
  const row = rows.find((r) => r.name === 'Complete Healing')
  assert.ok(row, 'the cleric 39 heal is in the shipped dataset')
  assert.deepEqual(row.levels?.map(classLevelLabel), ['CLR 39'], 'it states the level the DB places it at')
  assert.deepEqual(row.classes, ['CLR'], 'and a cleric in the loadout owns it')
  assert.deepEqual(row.earlier, [{ cls: 'CLR', level: 39 }], 'a level-60 cleric already has it')

  // AND THE FIGURES RIDE ALONG (JOS-391's row content, on a search result): the shipped dataset
  // carries real metrics, so a heal query reaches rows that state what they are worth.
  const healing = searchUnlockSpells(data.spells, tokenizeSpellQuery('healing'), {
    classes: [],
    currentLevel: null
  })
  assert.ok(
    healing.rows.some((r) => r.spell?.metrics?.heal !== undefined),
    'a search result states what the spell is worth, exactly as the level row does'
  )
})

test('U4c every shipped row carries the search surface the filter reads', () => {
  const data = buildLevelUnlocks()
  assert.ok(data.spells.length > 1000, 'the dataset is the real one')
  for (const s of data.spells) {
    assert.ok(s.searchText !== undefined && s.searchText.length > 0, `${s.name}: no search surface`)
    assert.equal(s.searchText, s.searchText.toLowerCase(), `${s.name}: the surface must be lowercased`)
    assert.ok(
      searchUnlockSpells([s], tokenizeSpellQuery(s.name), { classes: [], currentLevel: null }).matched === 1,
      `${s.name}: a spell must be findable by its own name`
    )
  }
})
