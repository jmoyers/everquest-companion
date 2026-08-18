// JOS-393 — THE WIKI'S ERA VERDICT REACHES THE SPELL CATALOG, AND STOPS AT THE RIGHT PLACES.
//
// THE REPORT. `Sloths Healing` was drawn as new at level 50 for a shaman. Its wiki page opens
// `{{Kunark Era}}`, states `Shaman - Level 50+`, and eqlwiki badges every link to it out of era —
// on a server that has not opened Kunark. The owner's ruling was to fix the CLASS through the
// scrape rather than to overlay one spell, so there are three seams to hold and this suite holds
// all three:
//
//   1. THE SIDECAR. `pageEra.json` carries a `spells` table written by `scripts/scrape-page-era.ts`
//      off `action=eqlmetadata` — the wiki's own predicate, at the same `eraRevision` the item and
//      mob tables were fetched at. Asserted by SANITY ROWS the ticket named (Sloths out, Snails in)
//      and by the Classic sub-eras staying IN (Sky, Paineel, Hate), because those are the rows a
//      too-eager verdict would take away from a player who can actually reach them.
//   2. THE JOIN. `applySpellEra` marks rows `outOfEra: true` and marks NOTHING else — no `false`,
//      no field on a name the table has no answer for. That is law 1 at this seam: the endpoint
//      answers `false` both for "the wiki files this as classic" and for "nobody has classified
//      this page", and only the positive claim is a claim.
//   3. THE FOLD. `unlocksAtLevel` moves those rows out of the level list into `outOfEraSpells`, the
//      drops precedent (`features/mobs/dropEra.ts`), and the headline count follows the SHOWN rows
//      so a toast cannot promise a spell the server does not have. The SEARCH projection keeps them
//      — a search is a question the player typed.
//
// FLOORS, NOT FROZEN COUNTS, wherever a number appears: the era tables are re-fetched when the wiki
// moves and an expansion opening on EQ Legends will move hundreds of rows at once. What must not
// move is the SHAPE — a positive-only field, a fold that never folds on silence, and a catalog
// whose out-of-era rows are exactly the ones the sidecar badges.
//
// No Electron, no network, no log: the committed JSON in the tree is what ships.
//
// Run: `npm test`.

import test from 'node:test'
import assert from 'node:assert/strict'
import { applySpellEra } from '../src/main/data/spellEra.ts'
import { loadSpellDb } from '../src/main/data/spellDb.ts'
import { buildSpellDetail } from '../src/main/data/spellDetail.ts'
import { buildLevelUnlocks } from '../src/main/data/levelUnlocks.ts'
import { unlockCounts, unlocksAtLevel, type ComboClasses } from '../src/shared/levelUnlocks.ts'
import type { ClassAbbr } from '../src/shared/classCombo.ts'
import { searchUnlockSpells } from '../src/shared/unlockSearch.ts'
import { tokenizeSpellQuery } from '../src/shared/spellSearch.ts'
import { pageEraKey, type PageEraFile } from '../src/main/pageEraDb.ts'
import type { SpellDbFile, SpellEntry } from '../src/shared/types.ts'
import pageEraJson from '../src/main/data/pageEra.json' with { type: 'json' }
import spellsJson from '../src/main/data/spells.json' with { type: 'json' }

const SIDECAR = pageEraJson as PageEraFile
const RAW: SpellEntry[] = (spellsJson as SpellDbFile).spells
const verdict = (name: string): boolean | undefined => SIDECAR.spells[pageEraKey(name)]

/** A loadout with exactly these classes resolved — the shape `unlocksAtLevel` joins over. */
const combo = (...resolved: ClassAbbr[]): ComboClasses => ({ resolved, candidates: [], ambiguous: false })

// ---------------------------------------------------------------------------------------------
// 1 — THE SIDECAR: what the wiki said, recorded
// ---------------------------------------------------------------------------------------------

test('the spells table is the same fetch as the pages and mobs beside it', () => {
  // One file, one `eraRevision` — the citation the item corpus already stands on. A spells table
  // fetched at a different revision of `Template:PageEra` would be a second opinion.
  assert.equal(SIDECAR.eraRevision, 156232)
  const size = Object.keys(SIDECAR.spells).length
  assert.ok(size >= 2000, `only ${size} spell pages carry a verdict`)
  // Every value is a BOOLEAN. The mobs table's shape, for the mobs table's reason: only the OUT
  // direction is ever read, so a record with an `outOfEra` key would be a field nothing reads.
  assert.equal(
    Object.values(SIDECAR.spells).every((v) => typeof v === 'boolean'),
    true
  )
  // And the keys are FOLDED — `pageEraKey`'s fold, so a lookup by the catalog's own spelling lands.
  assert.deepEqual(
    Object.keys(SIDECAR.spells).filter((k) => k !== pageEraKey(k)),
    []
  )
})

test('the ticket sanity rows: Sloths Healing out, Snails Healing in', () => {
  assert.equal(verdict('Sloths Healing'), true)
  assert.equal(verdict('Snails Healing'), false)
  // Its third sibling too — the three shaman heal-over-times differ ONLY in era, which is why the
  // report was about the panel rather than about one page.
  assert.equal(verdict('Slugs Healing'), false)
})

test('the CLASSIC SUB-ERAS stay in era — Sky, Paineel and Hate are content this server has', () => {
  // `shared/planner/era.ts` files sky/paineel/hate/fear as `in`, and the endpoint agrees: these are
  // the rows a fold that keyed off "has an era banner at all" would wrongly take away.
  for (const name of ['Abduction of Strength', 'Scareling Step', 'Ant Legs']) {
    assert.equal(verdict(name), false, `${name} came back out of era`)
  }
})

test('the catalog reaches the table: all but a handful of its names carry a verdict', () => {
  const missing = RAW.filter((s) => verdict(s.name) === undefined).map((s) => s.name)
  // MEASURED 2026-08-16: exactly one, and it is a malformed wiki page whose `spellname` field
  // parses as `Brass Resonance 14| spellicon = C` — a name no page has. A jump here means the spell
  // scrape ran without the era scrape following it, and the level rows have gone quiet again.
  assert.ok(missing.length <= 5, `${missing.length} catalog names have no verdict: ${missing.slice(0, 5).join(', ')}`)
})

// ---------------------------------------------------------------------------------------------
// 2 — THE JOIN: positive claims only
// ---------------------------------------------------------------------------------------------

test('applySpellEra marks the badged rows and says nothing about the rest', () => {
  const { spells, report } = applySpellEra(RAW)
  const by = new Map(spells.map((s) => [s.name, s]))
  assert.equal(by.get('Sloths Healing')?.outOfEra, true)
  // NOT `false` — absent. A `false` here is the field inviting a surface to write "in era" over a
  // page nobody has classified.
  assert.equal('outOfEra' in (by.get('Snails Healing') ?? {}), false)
  assert.ok(report.marked >= 200, `only ${report.marked} rows marked`)
  assert.ok(report.silent <= 5, `${report.silent} rows with no verdict`)
  assert.equal(report.table, Object.keys(SIDECAR.spells).length)
  // The marked set IS the badged set, name for name — the join invents nothing and drops nothing.
  const marked = spells.filter((s) => s.outOfEra === true).map((s) => s.name)
  assert.deepEqual(
    marked.filter((n) => verdict(n) !== true),
    []
  )
  assert.equal(marked.length, RAW.filter((s) => verdict(s.name) === true).length)
})

test('a table that is silent about a spell leaves the row untouched — silence is not a verdict', () => {
  const rows: SpellEntry[] = [
    { name: 'Asked And Badged', durationMs: null, illusion: false },
    { name: 'Asked And Cleared', durationMs: null, illusion: false },
    { name: 'Never Asked About', durationMs: null, illusion: false }
  ]
  const file = {
    ...SIDECAR,
    spells: { 'asked and badged': true, 'asked and cleared': false }
  } as PageEraFile
  const { spells, report } = applySpellEra(rows, file)
  assert.equal(spells[0].outOfEra, true)
  assert.equal('outOfEra' in spells[1], false)
  assert.equal('outOfEra' in spells[2], false)
  // Only the third is SILENT: an answered `false` is an answer, and the report counts them apart.
  assert.equal(report.silent, 1)
  assert.equal(report.marked, 1)
})

test('the join is non-mutating and idempotent, like the overlays it runs beside', () => {
  const before = JSON.stringify(RAW)
  const once = applySpellEra(RAW)
  assert.equal(JSON.stringify(RAW), before, 'the committed catalog was mutated')
  // Only the CHANGED rows are copied — spells.json is one shared object for the whole process.
  const untouched = once.spells.filter((s, i) => s === RAW[i]).length
  assert.equal(untouched, RAW.length - once.report.marked)
  const twice = applySpellEra(once.spells)
  assert.equal(twice.report.marked, once.report.marked)
  assert.deepEqual(
    twice.spells.filter((s, i) => s !== once.spells[i]),
    [],
    'a second pass copied rows it had already marked'
  )
})

test('the loaded DB and the spell card both carry the verdict', () => {
  const db = loadSpellDb()
  const sloths = db.spells.find((s) => s.name === 'Sloths Healing')
  assert.equal(sloths?.outOfEra, true)
  const snails = db.spells.find((s) => s.name === 'Snails Healing')
  assert.equal(snails?.outOfEra, undefined)
  // The card's record — positive-only across the IPC too, so the chip cannot be drawn on silence.
  assert.equal(buildSpellDetail(db, 'Sloths Healing').outOfEra, true)
  assert.equal('outOfEra' in buildSpellDetail(db, 'Snails Healing'), false)
})

// ---------------------------------------------------------------------------------------------
// 3 — THE FOLD: what a level says, and what a search says
// ---------------------------------------------------------------------------------------------

const data = buildLevelUnlocks()

test('the unlock dataset carries the verdict, positive-only', () => {
  const sloths = data.spells.find((s) => s.name === 'Sloths Healing')
  assert.equal(sloths?.outOfEra, true)
  assert.deepEqual(sloths?.at, [{ cls: 'SHM', level: 50 }])
  assert.equal('outOfEra' in (data.spells.find((s) => s.name === 'Snails Healing') ?? {}), false)
  const marked = data.spells.filter((s) => s.outOfEra === true).length
  assert.ok(marked >= 100, `only ${marked} rows of the unlock dataset are badged`)
})

test('THE REPORT: a shaman at 50 is not offered Sloths Healing, and is still told it exists', () => {
  const at50 = unlocksAtLevel(data, combo('SHM'), 50)
  const shown = at50.spells.map((r) => r.name)
  const folded = at50.outOfEraSpells.map((r) => r.name)
  assert.equal(shown.includes('Sloths Healing'), false, 'the level list still offers it')
  assert.equal(folded.includes('Sloths Healing'), true, 'the disclosure does not hold it either')
  // FOLDED, NOT DELETED — and the row behind the disclosure is the same row, card fields intact.
  const row = at50.outOfEraSpells.find((r) => r.name === 'Sloths Healing')
  assert.equal(row?.spell?.outOfEra, true)
  assert.deepEqual(row?.classes, ['SHM'])
  // The headline number is what the player can actually go and buy — the folded row is not in it.
  assert.equal(unlockCounts(at50).spells, at50.spells.length)
  assert.equal(shown.includes(folded[0]), false)
})

test('an in-era level is untouched: nothing folds, and no disclosure exists to draw', () => {
  // 27-28 cleric/shaman is the owner's own query band, and its rows are classic content.
  for (const level of [27, 28]) {
    const u = unlocksAtLevel(data, combo('CLR', 'SHM'), level)
    assert.ok(u.spells.length > 0, `no spells at all at ${level}`)
    assert.deepEqual(u.outOfEraSpells, [], `something folded at ${level}`)
  }
  // …and a loadout with no classes answers with both lists empty rather than with a missing field.
  const none = unlocksAtLevel(data, combo(), 50)
  assert.deepEqual(none.spells, [])
  assert.deepEqual(none.outOfEraSpells, [])
})

test('every folded row is one the sidecar BADGED — the fold never runs on silence', () => {
  let folded = 0
  for (let level = 1; level <= 65; level++) {
    const u = unlocksAtLevel(data, combo('CLR', 'DRU', 'SHM'), level)
    for (const row of u.outOfEraSpells) {
      folded += 1
      assert.equal(verdict(row.name), true, `${row.name} was folded without a verdict`)
    }
    for (const row of u.spells) assert.notEqual(row.spell?.outOfEra, true, `${row.name} was shown while badged`)
  }
  assert.ok(folded > 0, 'this trio folded nothing at any level — the join is not reaching the rows')
})

test('the SEARCH still answers for a badged spell, and marks it (JOS-392 rows, JOS-393 chip)', () => {
  const results = searchUnlockSpells(data.spells, tokenizeSpellQuery('sloths healing'), {
    classes: [],
    currentLevel: null
  })
  const row = results.rows.find((r) => r.name === 'Sloths Healing')
  assert.ok(row, 'a search for the spell by name does not find it')
  // The row the panel draws reads the flag off the spell it carries — the chip's whole input.
  assert.equal(row.spell?.outOfEra, true)
  // And an in-era neighbour in the same line carries nothing to chip.
  const snails = searchUnlockSpells(data.spells, tokenizeSpellQuery('snails healing'), {
    classes: [],
    currentLevel: null
  }).rows.find((r) => r.name === 'Snails Healing')
  assert.equal(snails?.spell?.outOfEra, undefined)
})
