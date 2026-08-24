// RAINS IN THE DD TAB, AND THE FIFTH TAB THAT POINTS AT A PACK (JOS-449) — pinned twice, the way
// tests/bestSpells.test.mts is:
//   1. the RULES over hand-built data — the hit arithmetic, the membership rule, the mote-rank
//      interaction, and the visible assumption over a MIXED table;
//   2. the OWNER'S ACCEPTANCE CASE over the REAL committed corpus — `Frost Storm` at BASE RANK, at
//      level 50, in a wizard's DD tab.
//
// THE ACCEPTANCE PINS EXACT NUMBERS HERE, unlike JOS-445's rank-only pin next door, and the reason
// is that this readout is a BUYING DECISION about a spell the owner does not own. He asked whether
// Frost Storm is worth 271 mana at 50; the answer is three numbers, and a test that only said "it
// is somewhere in the top ten" would not notice the day the wave count silently went back to one.
// The rank is pinned too, loosely, because "not buried behind +N more" is the defect that was
// reported and the panel draws ten rows.
//
// BASE RANK IS THE WHOLE POINT of the acceptance: the owner has no Frost Storm to have observed a
// rank on, so every figure below is `rank 0`, which is also what any reader sees before touching
// the simulate slider.
//
// No Electron, no network, no live log — this suite never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ClassAbbr, ComboInterval, ComboSlot } from '../src/shared/classCombo'
import {
  bestSpellsAt,
  columnValue,
  defaultSorts,
  type BestSpellRow,
  type BestSpellsView
} from '../src/shared/bestSpells'
import { comboClassesOf, type LevelUnlockData } from '../src/shared/levelUnlocks'
import { buildLevelUnlocks } from '../src/main/data/levelUnlocks'

// ---- fixtures ---------------------------------------------------------------------------

const slot = (candidates: ClassAbbr[]): ComboSlot => ({
  candidates,
  confidence: 1,
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

const BOTH: BestSpellsView = { sorts: defaultSorts() }

/**
 * Four spells, one of each thing this file has a rule for.
 *
 * The magnitudes and timings are round so the arithmetic can be read off the page: a rain at 100 a
 * wave, a plain targeted AE at 100, a PB AE at 100 with the client's own cap of 8 on it, and a
 * single-target nuke that must never appear in the AOE tab at all. All four cost 100 mana and cast
 * in 1s with no recast, so a difference between two rows is a difference in HITS and nothing else.
 */
const DATA: LevelUnlockData = {
  spells: [
    {
      name: 'Test Rain',
      at: [{ cls: 'WIZ', level: 10 }],
      mana: 100,
      castTimeMs: 1000,
      targetType: 'Targeted AE',
      waves: 3,
      hpLines: ['Decrease Hitpoints by 100']
    },
    {
      name: 'Test Column',
      at: [{ cls: 'WIZ', level: 10 }],
      mana: 100,
      castTimeMs: 1000,
      targetType: 'Targeted AE',
      hpLines: ['Decrease Hitpoints by 100']
    },
    {
      // The client stated this one its own cap, which is what a PB AE really reads (field 143 = 8).
      name: 'Test Nova',
      at: [{ cls: 'WIZ', level: 10 }],
      mana: 100,
      castTimeMs: 1000,
      targetType: 'PB AE',
      aeMaxTargets: 8,
      hpLines: ['Decrease Hitpoints by 100']
    },
    {
      name: 'Test Bolt',
      at: [{ cls: 'WIZ', level: 10 }],
      mana: 100,
      castTimeMs: 1000,
      targetType: 'Single',
      hpLines: ['Decrease Hitpoints by 100']
    },
    {
      // An area DoT: 20 a tick over five ticks. It is in the DoT tab AND in AOE, because the AOE
      // tab is a re-reading of the corpus rather than a partition of it.
      name: 'Test Cloud',
      at: [{ cls: 'WIZ', level: 10 }],
      mana: 100,
      castTimeMs: 1000,
      durationMs: 30_000,
      targetType: 'Targeted AE',
      hpLines: ['Decrease Hitpoints by 20 per tick']
    }
  ],
  skills: {}
}

const WIZ = comboOf(['WIZ'])

function rowOf(rows: readonly BestSpellRow[], name: string): BestSpellRow {
  const row = rows.find((r) => r.name === name)
  assert.ok(row, `no ${name} row in [${rows.map((r) => r.name).join(', ')}]`)
  return row
}

// ---- the DD tab reads a rain at its wave total ------------------------------------------------

test('THE DEFECT, FIXED: a rain in the DD tab is per-wave x waves, not the wiki line', () => {
  const dd = bestSpellsAt(DATA, WIZ, 20, BOTH).tabs.dd
  const rain = rowOf(dd.shown, 'Test Rain')
  const plain = rowOf(dd.shown, 'Test Column')
  assert.equal(rain.metrics.damage, 300, 'three waves of the stated 100')
  assert.equal(plain.metrics.damage, 100, 'and a targeted AE with no waves is untouched')
  // The per-mana and per-second figures are derived from the same total, not bolted on after.
  assert.equal(rain.metrics.damagePerMana, 3)
  assert.equal(rain.metrics.dps, 300, '300 over a 1s cast with no recast')
  // …and the row still says it is ONE target's worth. The AOE tab is where the pack lives.
  assert.equal(rain.targets, 1)
  assert.equal(plain.targets, 1)
})

test('a rain is an instant spell, so it stays in DD and never becomes a DoT', () => {
  const best = bestSpellsAt(DATA, WIZ, 20, BOTH)
  assert.equal(rowOf(best.tabs.dd.shown, 'Test Rain').metrics.dot, undefined)
  assert.equal(best.tabs.dot.shown.some((r) => r.name === 'Test Rain'), false)
  // The waves are waves of ONE cast, not ticks of a duration — the JOS-414 ruling, restated where
  // the figures are computed.
  assert.equal(rowOf(best.tabs.dd.shown, 'Test Rain').metrics.overSec, undefined)
})

// ---- the fifth tab -----------------------------------------------------------------------------

test('MEMBERSHIP: the AOE tab is the AE-shaped spells, and only those', () => {
  const aoe = bestSpellsAt(DATA, WIZ, 20, BOTH).tabs.aoe
  assert.deepEqual(
    aoe.shown.map((r) => r.name).sort(),
    ['Test Cloud', 'Test Column', 'Test Nova', 'Test Rain']
  )
  assert.equal(aoe.shown.some((r) => r.name === 'Test Bolt'), false, 'a single-target nuke has no area figure')
})

test('ARITHMETIC: a rain is capped at four HITS, a plain AE is per-target, a PB AE uses its own cap', () => {
  const aoe = bestSpellsAt(DATA, WIZ, 20, BOTH).tabs.aoe
  // THE ODDITY, in the readout: three waves on four targets is FOUR hits, never twelve.
  assert.equal(rowOf(aoe.shown, 'Test Rain').metrics.damage, 400)
  assert.equal(rowOf(aoe.shown, 'Test Rain').targets, 4)
  // A plain targeted AE lands once on each of the four.
  assert.equal(rowOf(aoe.shown, 'Test Column').metrics.damage, 400)
  // …and where the client stated a cap of its own, that is the number used.
  assert.equal(rowOf(aoe.shown, 'Test Nova').metrics.damage, 800)
  assert.equal(rowOf(aoe.shown, 'Test Nova').targets, 8)
  // The over-time row multiplies its whole total, ticks included: 20 x 5 ticks x 4 targets.
  assert.equal(rowOf(aoe.shown, 'Test Cloud').metrics.damage, 400)
  assert.equal(rowOf(aoe.shown, 'Test Cloud').metrics.dot, true, 'an area DoT is still a DoT')
  // THE `hits` COLUMN PRINTS THE MULTIPLIER THE FIGURES USED (owner ask 2026-08-23: "8 for
  // supernova, 4 for rain") — and it is `columnValue`'s answer, so the sort reads the same number.
  assert.equal(rowOf(aoe.shown, 'Test Rain').hits, 4, 'a rain at the cap')
  assert.equal(rowOf(aoe.shown, 'Test Nova').hits, 8, 'a PB AE at its own cap')
  assert.equal(rowOf(aoe.shown, 'Test Column').hits, 4, 'a plain AE once per target')
  assert.equal(columnValue(rowOf(aoe.shown, 'Test Nova'), 'hits'), 8)
})

test('the single-target readings carry their hit counts too: three for a rain, one for a nuke', () => {
  const best = bestSpellsAt(DATA, WIZ, 20, BOTH)
  assert.equal(rowOf(best.tabs.dd.shown, 'Test Rain').hits, 3, 'one mob eats all three waves')
  assert.equal(rowOf(best.tabs.dd.shown, 'Test Bolt').hits, 1)
})

test('A SPELL CAN BE IN THREE TABS, and that is two questions rather than double counting', () => {
  const best = bestSpellsAt(DATA, WIZ, 20, BOTH)
  const dd = rowOf(best.tabs.dd.shown, 'Test Rain')
  const aoe = rowOf(best.tabs.aoe.shown, 'Test Rain')
  assert.equal(dd.metrics.damage, 300)
  assert.equal(aoe.metrics.damage, 400)
  assert.notEqual(dd, aoe, 'two readings of one spell, so two row objects rather than one shared')
  // The DoT tab and the AOE tab really do share a spell, which is the case the AOE tab is NOT a
  // partition of: `Test Cloud` is a candidate for both answers.
  assert.ok(best.tabs.dot.shown.some((r) => r.name === 'Test Cloud'))
  assert.ok(best.tabs.aoe.shown.some((r) => r.name === 'Test Cloud'))
})

test('THE ASSUMPTION IS VISIBLE, and it states what the table used rather than the constant', () => {
  // The mixed table this dataset really produces: three rows at the default 4 and one at the
  // client's 8. A marker reading `x4 targets` over it would be a caption that lies.
  assert.equal(bestSpellsAt(DATA, WIZ, 20, BOTH).aoeTargets, 'x4 to x8 targets')
  // Drop the PB AE and the marker collapses to the one count in force.
  const noPbAe: LevelUnlockData = { ...DATA, spells: DATA.spells.filter((s) => s.name !== 'Test Nova') }
  assert.equal(bestSpellsAt(noPbAe, WIZ, 20, BOTH).aoeTargets, 'x4 targets')
  // An unknown loadout ranks nothing, and the marker still answers rather than being empty.
  assert.equal(bestSpellsAt(DATA, comboClassesOf(null), 20, BOTH).aoeTargets, 'x4 targets')
})

test('the AOE tab ranks on sustained dps, best first, like the other damage tabs', () => {
  const aoe = bestSpellsAt(DATA, WIZ, 20, BOTH).tabs.aoe.shown
  assert.equal(aoe[0].name, 'Test Nova', '800 over 1s leads')
  for (let i = 1; i < aoe.length; i++) {
    const prev = aoe[i - 1].metrics.dps ?? 0
    assert.ok(prev >= (aoe[i].metrics.dps ?? 0), `${aoe[i - 1].name} then ${aoe[i].name}`)
  }
})

// ---- the mote rank scales the WAVE, not the total ----------------------------------------------

test('a rank scales the PER-WAVE magnitude and the waves multiply what comes out', () => {
  // Six percent a rank, floored, on the WAVE (`spellScale.ts`'s measured rule), then x3. At rank 10
  // that is 100 + floor(100 x 60/100) = 160 a wave, so 480 - which is NOT floor(300 x 1.6) = 480
  // here only because the numbers are round; the order is what the assertion is about, and the AOE
  // reading below is where the two orders would disagree.
  const at10 = bestSpellsAt(DATA, WIZ, 20, { ...BOTH, simulate: 10 })
  assert.equal(rowOf(at10.tabs.dd.shown, 'Test Rain').metrics.damage, 480)
  assert.equal(rowOf(at10.tabs.aoe.shown, 'Test Rain').metrics.damage, 640, 'four hits of 160')
  // The plain AE moves by the same six percent a rank, which is the "no special case" ruling.
  assert.equal(rowOf(at10.tabs.dd.shown, 'Test Column').metrics.damage, 160)
  assert.equal(rowOf(at10.tabs.aoe.shown, 'Test Column').metrics.damage, 640)
  // …and a rank is not a filter: the same rows, re-read.
  const base = bestSpellsAt(DATA, WIZ, 20, BOTH)
  assert.equal(at10.tabs.aoe.shown.length, base.tabs.aoe.shown.length)
})

// ---- the REAL committed corpus -----------------------------------------------------------------

const REAL = buildLevelUnlocks()

test('JOS-449 ACCEPTANCE: Frost Storm at 50, base rank, in a wizard DD tab', () => {
  // Owner, verbatim: "it looks like we're missing rain spells - apparently frost storm ends up
  // being very efficient at level 50 and its not showing up."
  //
  // The wiki states one line, `Decrease Hitpoints by 512`, and the page says the storm "falls in
  // three waves". Before this ticket the row read 512 damage / 30 dps and sat ~30th, behind the
  // panel's `+N more` disclosure. The three numbers below are the answer to his buying question.
  const best = bestSpellsAt(REAL, comboOf(['WIZ']), 50, BOTH)
  const rows = best.tabs.dd.shown
  const row = rowOf(rows, 'Frost Storm')
  assert.equal(row.rank, 0, 'BASE RANK: he does not own it, so there is no observed rank to lean on')
  assert.equal(row.metrics.damage, 1536, '512 a wave, three waves')
  assert.equal(row.metrics.dps, 90.4, '1536 over the 17s cycle: a 5s cast plus the 12s re-use timer')
  assert.equal(row.metrics.damagePerMana, 5.7, '1536 for 271 mana')
  assert.equal(row.metrics.recastMs, 12_000)
  assert.equal(row.gainedAt, 41)

  // AND IT IS NOT BURIED. The panel draws ten rows before the disclosure, and the reported defect
  // was that this spell was not among them.
  const rank = rows.findIndex((r) => r.name === 'Frost Storm') + 1
  assert.ok(rank >= 1 && rank <= 10, `Frost Storm ranks ${String(rank)} of ${String(rows.length)}`)
  // It is the biggest single cast in the table and the most mana-efficient one in it, which is the
  // "very efficient" the owner had heard about, now stated by the app.
  const best2 = (pick: (r: BestSpellRow) => number) => Math.max(...rows.map(pick))
  assert.equal(best2((r) => r.metrics.damage ?? 0), 1536)
  assert.equal(best2((r) => r.metrics.damagePerMana ?? 0), 5.7)
})

test('JOS-449 acceptance, the other half: Frost Storm on a pack, with the assumption stated', () => {
  const best = bestSpellsAt(REAL, comboOf(['WIZ']), 50, BOTH)
  const row = rowOf(best.tabs.aoe.shown, 'Frost Storm')
  // FOUR HITS, not twelve — the four-page quote, over the real catalog.
  assert.equal(row.metrics.damage, 2048, '512 x the four-hit cap')
  assert.equal(row.targets, 4)
  assert.equal(best.aoeTargets, 'x4 targets', 'and the tab says so, over a table with no client file')
  assert.ok(best.tabs.aoe.shown.length >= 15, `wizard AOE rows at 50: ${String(best.tabs.aoe.shown.length)}`)
})

test('the AOE tab over the real corpus is AE-shaped throughout, and never a superset of DD', () => {
  const best = bestSpellsAt(REAL, comboOf(['WIZ']), 50, BOTH)
  const shapes = new Set(
    best.tabs.aoe.shown.map(
      (r) => REAL.spells.find((s) => s.name === r.name)?.targetType ?? '(none)'
    )
  )
  for (const shape of shapes) {
    assert.ok(['Targeted AE', 'PB AE', 'PBAOE', 'AE'].includes(shape), `${shape} is not an area shape`)
  }
  // Every AOE row is at least as big as its DD row: a max-target reading can never state less.
  for (const row of best.tabs.aoe.shown) {
    const dd = best.tabs.dd.shown.find((r) => r.name === row.name)
    const dot = best.tabs.dot.shown.find((r) => r.name === row.name)
    const single = dd ?? dot
    if (!single) continue
    assert.ok(
      (row.metrics.damage ?? 0) >= (single.metrics.damage ?? 0),
      `${row.name}: aoe ${String(row.metrics.damage)} < single ${String(single.metrics.damage)}`
    )
  }
})

test('nothing outside the rain roster moved: a plain nuke reads what it always read', () => {
  // THE TRIPWIRE (law 8). `Ice Comet` is a Single-target wizard nuke with no waves and no area
  // shape, so JOS-449 must not have touched a point of it — and it must not be in the AOE tab.
  const best = bestSpellsAt(REAL, comboOf(['WIZ']), 50, BOTH)
  const comet = rowOf(best.tabs.dd.shown, 'Ice Comet')
  assert.equal(comet.metrics.damage, 808)
  assert.equal(comet.targets, 1)
  assert.equal(best.tabs.aoe.shown.some((r) => r.name === 'Ice Comet'), false)
})
