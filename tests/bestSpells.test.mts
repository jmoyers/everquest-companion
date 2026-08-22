// THE BEST-SPELLS READOUT'S MODEL (JOS-445) — pinned twice, the way tests/levelUnlocks.test.mts is:
//   1. the RULES over hand-built data — the level ramp, the ownership window, the era split, the
//      null-last sort, the two sides;
//   2. the OWNER'S ACCEPTANCE CASE over the REAL committed corpus — a wizard at 35 must find
//      `Garrison's Mighty Mana Shock` (gained at 18) in the top three by dps.
//
// THE ACCEPTANCE PIN ASSERTS A RANK, NOT A NUMBER, and that is a coordination decision rather than
// a looseness: JOS-444 makes `dps`/`hps` recast-aware sustained figures under the same field names,
// so an assertion on 111.0 would go red the day the two branches meet while the thing the owner
// actually asked about ("i'd expect it to be near the top for damage") stayed true. The owner's own
// words carry the tolerance too: "maybe 1 or 2 recent spells could be more effective".
//
// No Electron, no network, no live log — this suite never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ClassAbbr, ComboInterval, ComboSlot } from '../src/shared/classCombo'
import {
  SIDE_COLUMNS,
  bestSpellsAt,
  columnValue,
  defaultSort,
  sortBestSpells,
  spellMetricsForLevel,
  type BestSpellRow,
  type BestSpellSort
} from '../src/shared/bestSpells'
import { comboClassesOf, type LevelUnlockData } from '../src/shared/levelUnlocks'
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

const comboOf = (classes: ClassAbbr[]): ReturnType<typeof comboClassesOf> =>
  comboClassesOf(interval(classes.map((c) => slot([c]))))

const BOTH = { damage: defaultSort('damage'), heal: defaultSort('heal') }

/**
 * A hand-built catalog with one of each shape this file has a rule for: a RAMPED nuke, a flat nuke,
 * a heal, an out-of-era heal, a spell with no hitpoint line at all, and one gained too late.
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
      name: 'Mend',
      at: [{ cls: 'CLR', level: 10 }],
      mana: 40,
      castTimeMs: 2000,
      hpLines: ['Increase Hitpoints by 200']
    },
    {
      name: 'Kunark Mend',
      at: [{ cls: 'CLR', level: 10 }],
      mana: 40,
      castTimeMs: 2000,
      outOfEra: true,
      hpLines: ['Increase Hitpoints by 999']
    },
    { name: 'Gate', at: [{ cls: 'WIZ', level: 12 }], mana: 30 },
    {
      name: 'Later Bolt',
      at: [{ cls: 'WIZ', level: 40 }],
      mana: 10,
      castTimeMs: 1000,
      hpLines: ['Decrease Hitpoints by 900']
    }
  ],
  skills: {}
}

/** The named row, which MUST be there — so an assertion reads about the row, not about a null. */
function rowOf(rows: readonly BestSpellRow[], name: string): BestSpellRow {
  const row = rows.find((r) => r.name === name)
  assert.ok(row, `no ${name} row in [${rows.map((r) => r.name).join(', ')}]`)
  return row
}

// ---- the rule the file exists for ---------------------------------------------------------

test('a RAMPED spell is read at the level being viewed, not at the level it was gained', () => {
  const wiz = comboOf(['WIZ'])
  const at18 = rowOf(bestSpellsAt(DATA, wiz, 18, BOTH).damage.shown, 'Ramp Bolt')
  const at35 = rowOf(bestSpellsAt(DATA, wiz, 35, BOTH).damage.shown, 'Ramp Bolt')
  assert.equal(at18.metrics.damage, 100)
  assert.equal(at35.metrics.damage, 300, 'the ramp tops out at L34 and the reader is 35')
  // The gain level is still stated on the row — it is what the table prints beside the name.
  assert.equal(at35.gainedAt, 18)
})

test('the corpus is what the loadout OWNS: gained at or below the level, nothing later', () => {
  const wiz = comboOf(['WIZ'])
  const at35 = bestSpellsAt(DATA, wiz, 35, BOTH).damage.shown.map((r) => r.name)
  assert.deepEqual(at35.includes('Later Bolt'), false, `L40 spell must not be owned at 35: ${at35.join(', ')}`)
  const at40 = bestSpellsAt(DATA, wiz, 40, BOTH).damage.shown.map((r) => r.name)
  assert.ok(at40.includes('Later Bolt'))
  // A spell with no hitpoint line has no figures and therefore no row on either side.
  assert.equal(at40.includes('Gate'), false)
})

test('the two sides answer separately, and a class contributes only its own spells', () => {
  const wiz = bestSpellsAt(DATA, comboOf(['WIZ']), 35, BOTH)
  assert.deepEqual(wiz.heal.shown, [], 'a wizard has nothing on the healing side')
  const clr = bestSpellsAt(DATA, comboOf(['CLR']), 35, BOTH)
  assert.deepEqual(clr.damage.shown, [])
  assert.deepEqual(clr.heal.shown.map((r) => r.name), ['Mend'])
  // Both classes at once is the union, still one row per spell.
  const both = bestSpellsAt(DATA, comboOf(['WIZ', 'CLR']), 35, BOTH)
  assert.equal(both.damage.shown.length, 2)
  assert.equal(both.heal.shown.length, 1)
})

test('the era verdict FOLDS the row, it never drops it - and silence is not a verdict', () => {
  const clr = bestSpellsAt(DATA, comboOf(['CLR']), 35, BOTH)
  assert.deepEqual(clr.heal.shown.map((r) => r.name), ['Mend'])
  assert.deepEqual(clr.heal.outOfEra.map((r) => r.name), ['Kunark Mend'])
  // The folded row is the STRONGER one — proof the split is by verdict and not by ranking.
  assert.ok((clr.heal.outOfEra[0].metrics.heal ?? 0) > (clr.heal.shown[0].metrics.heal ?? 0))
  // A spell the sidecar never answered for carries `false`, and stays shown.
  assert.equal(clr.heal.shown[0].outOfEra, false)
})

test('an unknown loadout ranks nothing rather than ranking the whole game', () => {
  const none = bestSpellsAt(DATA, comboClassesOf(null), 35, BOTH)
  assert.deepEqual(none.classes, [])
  assert.deepEqual(none.damage.shown, [])
  assert.deepEqual(none.heal.shown, [])
  assert.equal(none.ambiguous, true)
})

// ---- the sort ------------------------------------------------------------------------------

test('every column ranks, and flipping the direction reverses it', () => {
  const wiz = comboOf(['WIZ'])
  const by = (sort: BestSpellSort): string[] =>
    bestSpellsAt(DATA, wiz, 35, { ...BOTH, damage: sort }).damage.shown.map((r) => r.name)
  // At 35 Ramp Bolt is 300 over a 3s cast (100 dps) and Flat Bolt 150 over 1s (150 dps), so the
  // headline and the total disagree — which is exactly what a sortable table is for.
  assert.deepEqual(by({ column: 'dps', desc: true }), ['Flat Bolt', 'Ramp Bolt'])
  assert.deepEqual(by({ column: 'damage', desc: true }), ['Ramp Bolt', 'Flat Bolt'])
  assert.deepEqual(by({ column: 'damage', desc: false }), ['Flat Bolt', 'Ramp Bolt'])
  assert.deepEqual(by({ column: 'mana', desc: true }), ['Ramp Bolt', 'Flat Bolt'])
  assert.deepEqual(by({ column: 'damagePerMana', desc: true }), ['Flat Bolt', 'Ramp Bolt'])
})

test('an ABSENT figure sorts last in BOTH directions, and is never read as a zero', () => {
  const rows: BestSpellRow[] = [
    { name: 'Has none', gainedAt: 1, classes: ['WIZ'], mana: null, metrics: { damage: 10 }, outOfEra: false },
    { name: 'Has some', gainedAt: 1, classes: ['WIZ'], mana: 40, metrics: { damage: 10 }, outOfEra: false }
  ]
  assert.equal(columnValue(rows[0], 'mana'), null)
  assert.deepEqual(sortBestSpells(rows, { column: 'mana', desc: true }).map((r) => r.name), ['Has some', 'Has none'])
  assert.deepEqual(sortBestSpells(rows, { column: 'mana', desc: false }).map((r) => r.name), ['Has some', 'Has none'])
})

test('the sort is TOTAL - a tie falls back to the name, so a re-rank cannot shuffle', () => {
  const tie = (name: string): BestSpellRow => ({
    name,
    gainedAt: 1,
    classes: ['WIZ'],
    mana: 10,
    metrics: { damage: 10, dps: 5 },
    outOfEra: false
  })
  const rows = [tie('Zap'), tie('Arc'), tie('Mote')]
  const sorted = sortBestSpells(rows, { column: 'dps', desc: true }).map((r) => r.name)
  assert.deepEqual(sorted, ['Arc', 'Mote', 'Zap'])
  assert.deepEqual(sortBestSpells(sorted.map(tie), { column: 'dps', desc: false }).map((r) => r.name), sorted)
})

test('each side offers the four columns that mean something for it, and mana in both', () => {
  assert.deepEqual([...SIDE_COLUMNS.damage], ['dps', 'damage', 'mana', 'damagePerMana'])
  assert.deepEqual([...SIDE_COLUMNS.heal], ['hps', 'heal', 'mana', 'healPerMana'])
  // All seven of the owner's columns are reachable, and no column is on a side it cannot answer.
  const all = new Set([...SIDE_COLUMNS.damage, ...SIDE_COLUMNS.heal])
  assert.equal(all.size, 7)
})

// ---- the REAL committed corpus ---------------------------------------------------------------

const REAL = buildLevelUnlocks()

test('JOS-445 acceptance: a wizard at 35 finds Garrisons Mighty Mana Shock in the top three by dps', () => {
  // Owner, verbatim: "on my current loadout a level 18 spell called garrison's mighty mana shock
  // ... i'd expect it to be near the top for damage at this time - though maybe 1 or 2 recent
  // spells could be more effective (but i doubt it at 35ish)".
  //
  // It is a RANK assertion on purpose - see this file's header for the JOS-444 coordination.
  const wiz = comboOf(['WIZ'])
  const rows = bestSpellsAt(REAL, wiz, 35, BOTH).damage.shown
  assert.ok(rows.length >= 20, `a level-35 wizard should own plenty of damage spells: ${String(rows.length)}`)
  const rank = rows.findIndex((r) => r.name === "Garrison's Mighty Mana Shock") + 1
  assert.ok(rank >= 1 && rank <= 3, `Garrisons ranks ${String(rank)}: ${rows.slice(0, 5).map((r) => r.name).join(' | ')}`)
  // And it is there BECAUSE the ramp was read at 35: the gain-level snapshot main computed is 272.
  const row = rowOf(rows, "Garrison's Mighty Mana Shock")
  assert.equal(row.gainedAt, 18)
  assert.equal(row.metrics.damage, 333, 'the L34 end of the ramp, not the L18 end')
  // THE TWO READERS AGREE (the JOS-444 ∩ JOS-445 seam, closed at merge): the re-evaluation
  // divides by the same sustained cycle main's own fold does — 333 over 4.5s (3.0 cast + 1.5
  // recast), never the cast-only 111 a wire without `recastMs` would have produced.
  assert.equal(row.metrics.dps, 74, 'sustained dps, recast included, matching the unlock fold')
  assert.equal(row.metrics.recastMs, 1500)
})

test('the committed dataset carries the re-evaluation inputs the readout needs', () => {
  const withLines = REAL.spells.filter((s) => s.hpLines !== undefined)
  assert.ok(withLines.length > 300, `${String(withLines.length)} spells carry hitpoint lines`)
  // Every spell main computed figures FROM the wiki has the lines that produced them, and reading
  // them back at the gain level reproduces the snapshot byte for byte.
  let checked = 0
  for (const s of REAL.spells) {
    if (s.metrics === undefined || s.metrics.source === 'client') continue
    const gainLevel = Math.min(...s.at.map((p) => p.level))
    assert.deepEqual(spellMetricsForLevel(s, gainLevel), s.metrics, s.name)
    checked++
  }
  assert.ok(checked > 300, `${String(checked)} wiki-sourced spells re-read identically`)
})

test('a real cleric at 35 gets a healing table led by a real heal, ranked by hps', () => {
  const rows = bestSpellsAt(REAL, comboOf(['CLR']), 35, BOTH).heal.shown
  assert.ok(rows.length >= 5, `cleric healing rows at 35: ${String(rows.length)}`)
  assert.equal(rows[0].name, 'Superior Healing')
  // Descending, with no null slipping above a stated figure.
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].metrics.hps
    const cur = rows[i].metrics.hps
    assert.ok(prev !== undefined && cur !== undefined && prev >= cur, `${rows[i - 1].name} then ${rows[i].name}`)
  }
})

test('re-ranking on damage per mana answers a different question, and both answers are real', () => {
  const wiz = comboOf(['WIZ'])
  const byDps = bestSpellsAt(REAL, wiz, 35, BOTH).damage.shown
  const byEff = bestSpellsAt(REAL, wiz, 35, {
    ...BOTH,
    damage: { column: 'damagePerMana', desc: true }
  }).damage.shown
  assert.equal(byDps.length, byEff.length)
  assert.notEqual(byDps[0].name, byEff[0].name, 'the fastest nuke and the most mana-efficient one differ')
  for (const row of byEff) assert.ok(row.metrics.damagePerMana !== undefined || row.mana === null)
})
