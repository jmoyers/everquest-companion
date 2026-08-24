// THE BEST-SPELLS READOUT'S MODEL (JOS-445, four-way since JOS-448) — pinned twice, the way
// tests/levelUnlocks.test.mts is:
//   1. the RULES over hand-built data — the level ramp, the ownership window, the era split, the
//      null-last sort, the four tabs;
//   2. the OWNER'S ACCEPTANCE CASE over the REAL committed corpus — a wizard at 35 must find
//      `Garrison's Mighty Mana Shock` (gained at 18) in the top three by dps, now in the DD tab
//      because the spell is instant.
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
  TAB_LABEL,
  TAB_ORDER,
  bestSpellsAt,
  columnValue,
  defaultSort,
  defaultSorts,
  sortBestSpells,
  spellMetricsForLevel,
  tabColumns,
  type BestSpellRow,
  type BestSpellSort,
  type BestSpellTab,
  type BestSpellsView
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

/**
 * THE DEFAULT VIEW: all four tables on their own rank column, and no rank assumptions at all.
 *
 * A `BestSpellsView` since JOS-447 rather than a bare sorts record — the rank options ride the same
 * object, and a view with neither of them is byte-identical to the reading this suite pinned
 * before that ticket. `tests/bestSpellsRank.test.mts` is where the rank half is exercised.
 */
const BOTH: BestSpellsView = { sorts: defaultSorts() }

/**
 * A hand-built catalog with one of each shape this file has a rule for: a RAMPED nuke, a flat nuke,
 * a heal, an out-of-era heal, a spell with no hitpoint line at all, one gained too late, a DoT, a
 * HoT, and the awkward one JOS-448 needs — a spell whose two sides disagree about ticking.
 */
const DATA: LevelUnlockData = {
  spells: [
    {
      // Ticks: five of them over 30s, so 20 a tick totals 100 damage and the row is a DoT.
      name: 'Creeping Bolt',
      at: [{ cls: 'WIZ', level: 15 }],
      mana: 60,
      castTimeMs: 2000,
      durationMs: 30_000,
      hpLines: ['Decrease Hitpoints by 20 per tick']
    },
    {
      name: 'Slow Mend',
      at: [{ cls: 'CLR', level: 8 }],
      mana: 30,
      castTimeMs: 2000,
      durationMs: 30_000,
      hpLines: ['Increase Hitpoints by 15 per tick']
    },
    {
      // ONE SPELL, TWO SIDES THAT TICK DIFFERENTLY: an instant hit plus a heal over the duration.
      // It belongs in DD and in HoT, which is the case a per-SPELL flag could not express.
      name: 'Splitting Word',
      at: [{ cls: 'CLR', level: 14 }],
      mana: 80,
      castTimeMs: 2000,
      durationMs: 30_000,
      hpLines: ['Decrease Hitpoints by 60', 'Increase Hitpoints by 15 per tick']
    },
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
  const at18 = rowOf(bestSpellsAt(DATA, wiz, 18, BOTH).tabs.dd.shown, 'Ramp Bolt')
  const at35 = rowOf(bestSpellsAt(DATA, wiz, 35, BOTH).tabs.dd.shown, 'Ramp Bolt')
  assert.equal(at18.metrics.damage, 100)
  assert.equal(at35.metrics.damage, 300, 'the ramp tops out at L34 and the reader is 35')
  // The gain level is still stated on the row — it is what the table prints beside the name.
  assert.equal(at35.gainedAt, 18)
})

test('the corpus is what the loadout OWNS: gained at or below the level, nothing later', () => {
  const wiz = comboOf(['WIZ'])
  const at35 = bestSpellsAt(DATA, wiz, 35, BOTH).tabs.dd.shown.map((r) => r.name)
  assert.deepEqual(at35.includes('Later Bolt'), false, `L40 spell must not be owned at 35: ${at35.join(', ')}`)
  const best40 = bestSpellsAt(DATA, wiz, 40, BOTH)
  assert.ok(best40.tabs.dd.shown.map((r) => r.name).includes('Later Bolt'))
  // A spell with no hitpoint line has no figures and therefore no row in any of the four.
  const all40 = TAB_ORDER.flatMap((t) => best40.tabs[t].shown.map((r) => r.name))
  assert.equal(all40.includes('Gate'), false)
})

test('the four tabs answer separately, and a class contributes only its own spells', () => {
  const wiz = bestSpellsAt(DATA, comboOf(['WIZ']), 35, BOTH)
  assert.deepEqual(wiz.tabs.heal.shown, [], 'a wizard has nothing to heal with')
  assert.deepEqual(wiz.tabs.hot.shown, [])
  const clr = bestSpellsAt(DATA, comboOf(['CLR']), 35, BOTH)
  assert.deepEqual(clr.tabs.dot.shown, [], 'this cleric owns no damage over time')
  assert.deepEqual(clr.tabs.heal.shown.map((r) => r.name), ['Mend'])
  // Both classes at once is the union, still one row per spell per tab.
  const both = bestSpellsAt(DATA, comboOf(['WIZ', 'CLR']), 35, BOTH)
  assert.deepEqual(both.tabs.dd.shown.map((r) => r.name), ['Flat Bolt', 'Ramp Bolt', 'Splitting Word'])
  assert.deepEqual(both.tabs.dot.shown.map((r) => r.name), ['Creeping Bolt'])
  assert.deepEqual(both.tabs.heal.shown.map((r) => r.name), ['Mend'])
  assert.deepEqual(both.tabs.hot.shown.map((r) => r.name), ['Slow Mend', 'Splitting Word'])
})

test('the era verdict FOLDS the row, it never drops it - and silence is not a verdict', () => {
  const clr = bestSpellsAt(DATA, comboOf(['CLR']), 35, BOTH)
  assert.deepEqual(clr.tabs.heal.shown.map((r) => r.name), ['Mend'])
  assert.deepEqual(clr.tabs.heal.outOfEra.map((r) => r.name), ['Kunark Mend'])
  // The folded row is the STRONGER one — proof the split is by verdict and not by ranking.
  assert.ok((clr.tabs.heal.outOfEra[0].metrics.heal ?? 0) > (clr.tabs.heal.shown[0].metrics.heal ?? 0))
  // A spell the sidecar never answered for carries `false`, and stays shown.
  assert.equal(clr.tabs.heal.shown[0].outOfEra, false)
})

test('an unknown loadout ranks nothing rather than ranking the whole game', () => {
  const none = bestSpellsAt(DATA, comboClassesOf(null), 35, BOTH)
  assert.deepEqual(none.classes, [])
  for (const tab of TAB_ORDER) {
    assert.deepEqual(none.tabs[tab].shown, [], tab)
    assert.deepEqual(none.tabs[tab].outOfEra, [], tab)
  }
  assert.equal(none.ambiguous, true)
})

// ---- the four-way split (JOS-448) ------------------------------------------------------------

test('a spell is placed by the OVER-TIME FLAG OF THE SIDE, not of the spell', () => {
  const clr = bestSpellsAt(DATA, comboOf(['CLR']), 35, BOTH)
  // `Splitting Word` hits once and heals every tick, so it is a DD and a HoT at the same time.
  const dd = rowOf(clr.tabs.dd.shown, 'Splitting Word')
  const hot = rowOf(clr.tabs.hot.shown, 'Splitting Word')
  assert.equal(dd, hot, 'the same row object, filed twice - not two derivations')
  assert.equal(dd.metrics.dot, undefined, 'the damage arrives at once')
  assert.equal(dd.metrics.hot, true)
  // …and it is in neither of the tabs those two flags rule out.
  assert.equal(clr.tabs.dot.shown.some((r) => r.name === 'Splitting Word'), false)
  assert.equal(clr.tabs.heal.shown.some((r) => r.name === 'Splitting Word'), false)
})

test('the four tabs PARTITION each side: a DoT is never in DD, a HoT never in Heal', () => {
  const best = bestSpellsAt(DATA, comboOf(['WIZ', 'CLR']), 35, BOTH)
  const names = (tab: BestSpellTab): Set<string> => new Set(best.tabs[tab].shown.map((r) => r.name))
  for (const [a, b] of [
    ['dd', 'dot'],
    ['heal', 'hot']
  ] as [BestSpellTab, BestSpellTab][]) {
    for (const name of names(a)) assert.equal(names(b).has(name), false, `${name} is in ${a} and ${b}`)
  }
  // Every row on a side is in exactly one of that side's two tabs - nothing falls between them.
  const damageRows = best.tabs.dd.shown.length + best.tabs.dot.shown.length
  const healRows = best.tabs.heal.shown.length + best.tabs.hot.shown.length
  assert.equal(damageRows, 4, 'Ramp Bolt, Flat Bolt, Splitting Word, Creeping Bolt')
  assert.equal(healRows, 3, 'Mend, Slow Mend, Splitting Word - Kunark Mend is behind the era fold')
  assert.equal(best.tabs.heal.outOfEra.length, 1, 'and the fold is on the tab its side put it in')
})

test('the three damage tabs open on dps and the two healing tabs on hps', () => {
  // AOE (JOS-449) sits with the other damage tabs and last of the three, so the two single-target
  // answers stay adjacent. `tests/bestSpellsAoe.test.mts` is where the tab's own rules are pinned.
  assert.deepEqual([...TAB_ORDER], ['dd', 'dot', 'aoe', 'heal', 'hot'])
  assert.deepEqual(TAB_ORDER.map((t) => TAB_LABEL[t]), ['DD', 'DoT', 'AOE', 'Heal', 'HoT'])
  assert.deepEqual(TAB_ORDER.map((t) => defaultSort(t).column), ['dps', 'dps', 'dps', 'hps', 'hps'])
  for (const tab of TAB_ORDER) assert.equal(defaultSort(tab).desc, true)
  const sorts = defaultSorts()
  assert.deepEqual(TAB_ORDER.map((t) => sorts[t]), TAB_ORDER.map((t) => defaultSort(t)))
})

test('a DoT ranks by its SUSTAINED dps, which is the whole reason it gets its own tab', () => {
  // 100 damage over a 30s duration reads 3.1 dps; the flat nuke beside it reads 150. Ranked in one
  // table the DoT is last by a factor of fifty and the reader learns nothing about which DoT to use.
  const wiz = bestSpellsAt(DATA, comboOf(['WIZ']), 35, BOTH)
  const rot = rowOf(wiz.tabs.dot.shown, 'Creeping Bolt')
  assert.equal(rot.metrics.damage, 100)
  assert.equal(rot.metrics.dot, true)
  assert.equal(rot.metrics.overSec, 30)
  assert.equal(rot.metrics.dps, 3.1)
  assert.deepEqual(wiz.tabs.dd.shown.map((r) => r.name), ['Flat Bolt', 'Ramp Bolt'])
})

// ---- the sort ------------------------------------------------------------------------------

test('every column ranks, and flipping the direction reverses it', () => {
  const wiz = comboOf(['WIZ'])
  const by = (sort: BestSpellSort): string[] =>
    bestSpellsAt(DATA, wiz, 35, { sorts: { ...BOTH.sorts, dd: sort } }).tabs.dd.shown.map((r) => r.name)
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
  // The single-target tabs of a side draw the SAME four: the tab separates them, the columns do
  // not need to. The AOE tab alone adds `hits` (owner ask 2026-08-23), beside `dmg` because it is
  // the number `dmg` was multiplied by.
  assert.deepEqual([...tabColumns('dd')], [...tabColumns('dot')])
  assert.deepEqual([...tabColumns('aoe')], ['dps', 'damage', 'hits', 'mana', 'damagePerMana'])
  assert.deepEqual([...tabColumns('heal')], [...tabColumns('hot')])
  assert.deepEqual([...tabColumns('dd')], [...SIDE_COLUMNS.damage])
  assert.deepEqual([...tabColumns('hot')], [...SIDE_COLUMNS.heal])
})

// ---- the REAL committed corpus ---------------------------------------------------------------

const REAL = buildLevelUnlocks()

test('JOS-445 acceptance, now in the DD tab: a wizard at 35 finds Garrisons in the top three by dps', () => {
  // Owner, verbatim: "on my current loadout a level 18 spell called garrison's mighty mana shock
  // ... i'd expect it to be near the top for damage at this time - though maybe 1 or 2 recent
  // spells could be more effective (but i doubt it at 35ish)".
  //
  // It is a RANK assertion on purpose - see this file's header for the JOS-444 coordination.
  //
  // JOS-448 moved the pin from the damage SIDE to the DD TAB, and the spell decides which: Garrison's
  // is an instant nuke, so `dot` is absent and it is a DD row. The claim is unchanged in substance -
  // the wizard's damage side has no over-time rows at all at 35, so DD is the whole side for him.
  const wiz = comboOf(['WIZ'])
  const best = bestSpellsAt(REAL, wiz, 35, BOTH)
  const rows = best.tabs.dd.shown
  assert.ok(rows.length >= 20, `a level-35 wizard should own plenty of damage spells: ${String(rows.length)}`)
  assert.deepEqual(best.tabs.dot.shown, [], 'no wizard DoTs in this era, so the DD tab IS the damage side')
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
  const rows = bestSpellsAt(REAL, comboOf(['CLR']), 35, BOTH).tabs.heal.shown
  assert.ok(rows.length >= 5, `cleric direct-heal rows at 35: ${String(rows.length)}`)
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
  const byDps = bestSpellsAt(REAL, wiz, 35, BOTH).tabs.dd.shown
  const byEff = bestSpellsAt(REAL, wiz, 35, {
    sorts: { ...BOTH.sorts, dd: { column: 'damagePerMana', desc: true } }
  }).tabs.dd.shown
  assert.equal(byDps.length, byEff.length)
  assert.notEqual(byDps[0].name, byEff[0].name, 'the fastest nuke and the most mana-efficient one differ')
  for (const row of byEff) assert.ok(row.metrics.damagePerMana !== undefined || row.mana === null)
})

test('JOS-448 over the real corpus: a necromancer at 35 has a DoT tab, and it is not his DD tab', () => {
  // THE CLASS THE SPLIT WAS ASKED FOR. A necro at 35 owns both kinds in quantity, and before the
  // split his DoTs sat at the bottom of one damage table ranked on a sustained dps that spreads a
  // whole duration's ticks across the duration - true, and useless for choosing between two DoTs.
  const best = bestSpellsAt(REAL, comboOf(['NEC']), 35, BOTH)
  const dot = best.tabs.dot.shown
  const dd = best.tabs.dd.shown
  assert.ok(dot.length >= 10, `necro DoT rows at 35: ${String(dot.length)}`)
  assert.ok(dd.length >= 10, `necro DD rows at 35: ${String(dd.length)}`)
  // Every DoT row really ticks, and states the window it ticks over - the number the tab is about.
  for (const row of dot) {
    assert.equal(row.metrics.dot, true, row.name)
    assert.ok((row.metrics.overSec ?? 0) > 0, `${row.name} states no duration`)
  }
  // …and no DD row does. The two tabs are disjoint by construction; this says so over real data.
  const dotNames = new Set(dot.map((r) => r.name))
  for (const row of dd) {
    assert.equal(row.metrics.dot, undefined, row.name)
    assert.equal(dotNames.has(row.name), false, `${row.name} is in both damage tabs`)
  }
  // The headline row is the era's signature necro DoT, and it is ranked by the same sustained dps.
  assert.equal(dot[0].name, 'Venom of the Snake')
  assert.ok((dot[0].metrics.dps ?? 0) > 0)
})
