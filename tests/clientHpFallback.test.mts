// JOS-396 — THE CLIENT'S HITPOINT SLOTS REACHING THE ROW, end to end.
//
// THE REPORT: a shaman hits 43, the Leveling panel offers Odium, and the row shows no damage. The
// cause is not a bug in the reader — the wiki's slot table for Odium lists `Increase Curse Counter
// by 8` and no hitpoint line at all, so `spellMetrics` correctly answered "no figures" about a
// page that states none. The client's own `spells_us.txt` has the number the game prints.
//
// THE CLAIMS PINNED HERE are the DELIVERY ones; the arithmetic belongs to tests/spellMetrics.test.mts
// (R9-R13) and the field map to tests/spellsUsParse.test.mts:
//
//   1. THE JOIN IS THE CANONICAL KEY. A miss here fails SILENTLY — the row simply keeps showing
//      nothing, which is the exact defect the ticket exists to fix — so it is asserted rather than
//      assumed (law 2: names are dirty, canonicalised at boundaries).
//   2. THE ROW AND THE CARD SHOW THE SAME NUMBERS, because one function computes them.
//   3. A FOLD THAT HAPPENED BEFORE THE CLIENT TABLE LANDED IS REBUILT WHEN IT DOES. The table is
//      parsed on a worker and takes a moment on a cold launch; the unlock dataset is cached for the
//      life of the process, so without this a player who opened the Leveling tab in that window
//      would keep the empty row for the rest of the run.
//   4. NOTHING THAT ALREADY HAD WIKI FIGURES MOVES. The wiki stays primary — acceptance 3.
//
// No Electron, no filesystem: the client table below is ONE hand-written entry, transcribed from
// spell 4093 of the owner's install on 2026-08-16 (the same row tests/spellsUsParse.test.mts pins).
// Both call sites take the table as an ARGUMENT precisely so this suite never needs the 38 MB file.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SpellResistTable } from '../src/shared/resistTypes'
import { spellMetricsAt, spellMetricsParts } from '../src/shared/spellMetrics'
import { spellMetricsForLevel } from '../src/shared/bestSpells'
import { clientHpFor } from '../src/main/data/clientSpellHp'
import { buildLevelUnlocks, resetLevelUnlocksCache } from '../src/main/data/levelUnlocks'
import { buildSpellDetail } from '../src/main/data/spellDetail'
import { loadSpellDb } from '../src/main/data/spellDb'

const CLIENT: SpellResistTable = {
  odium: {
    axis: 'magic',
    resistAdj: 0,
    castMs: 3000,
    // Field 10, transcribed with the rest of the row (JOS-444, re-read 2026-08-22): 6000, the same
    // number the wiki's own `recast_time` states. Never consulted for Odium, because the page
    // speaks — it is here so the row is the row.
    recastMs: 6000,
    targetType: 5,
    hpSlot: { base: -217, max: 325, calc: 103 },
    hp: [{ base: -217, max: 325, calc: 103, perTick: true }],
    hpDuration: { formula: 7, value: 5 }
  }
}

/**
 * 303 a tick at shaman 43, five ticks, 409 mana, a 3s cast plus 30s of ticks.
 *
 * `recastMs` is the WIKI'S (JOS-444) — Odium's page states a 6s re-use timer, and it changes no
 * figure here because the ticks are the longer wait. The client row below states one too and never
 * gets asked, which is the fallback's own rule.
 */
const ODIUM_FIGURES = {
  damage: 1515,
  damagePerMana: 3.7,
  dps: 45.9,
  dot: true,
  overSec: 30,
  recastMs: 6000,
  source: 'client'
}

/** What the panel and the card both print, in order. */
const ODIUM_PARTS = ['dmg 1515', 'dps 46', '3.7 dmg/mana', 'over 30s', 'recast 6s']

test('C1 the join is the CANONICAL key, because a miss here fails silently', () => {
  assert.ok(clientHpFor(CLIENT, 'Odium'))
  assert.ok(clientHpFor(CLIENT, 'odium'), 'case-folded')
  assert.ok(clientHpFor(CLIENT, ' Odium II '), 'a rank suffix folds onto the line, law 2')
  // Three ways of having nothing to add, all ONE answer to the caller — the fallback simply does
  // not fire, and no surface is invited to say something about a file the user may not have.
  assert.equal(clientHpFor(null, 'Odium'), undefined, 'no client install')
  assert.equal(clientHpFor(CLIENT, 'Anarchy'), undefined, 'no row for this name')
  assert.equal(
    clientHpFor({ tashani: { axis: null, resistAdj: 0, castMs: 0, targetType: 5 } }, 'Tashani'),
    undefined,
    'a row with no effect-0 slot'
  )
})

test('C2 the Odium ROW carries the damage the client states, and the panel prints it', () => {
  resetLevelUnlocksCache()
  try {
    const before = buildLevelUnlocks(null).spells.find((s) => s.name === 'Odium')
    assert.ok(before, 'the committed dataset carries Odium')
    assert.equal(before.metrics, undefined, "the wiki's slot table states no hitpoint line")

    resetLevelUnlocksCache()
    const after = buildLevelUnlocks(CLIENT).spells.find((s) => s.name === 'Odium')
    assert.deepEqual(after?.metrics, ODIUM_FIGURES)
    assert.deepEqual(spellMetricsParts(after?.metrics ?? {}), ODIUM_PARTS)
  } finally {
    resetLevelUnlocksCache()
  }
})

test('C3 the CARD is the same numbers, from the same function, at the same level', () => {
  const db = loadSpellDb()
  assert.equal(buildSpellDetail(db, 'Odium').metrics, undefined, 'the report, on the card')

  const card = buildSpellDetail(db, 'Odium', [], { client: CLIENT })
  assert.equal(card.metricsLevel, 43, 'shaman 43 — the level the line becomes yours')
  assert.deepEqual(card.metrics, ODIUM_FIGURES)
  assert.deepEqual(spellMetricsParts(card.metrics ?? {}), ODIUM_PARTS)

  const entry = db.spells.find((s) => s.name === 'Odium')
  assert.ok(entry)
  assert.deepEqual(card.metrics, spellMetricsAt(entry, 43, CLIENT.odium))
})

test('C4 a dataset folded before the client table lands is rebuilt when it does', () => {
  resetLevelUnlocksCache()
  try {
    const cold = buildLevelUnlocks(null)
    assert.equal(cold.spells.find((s) => s.name === 'Odium')?.metrics, undefined)
    const warm = buildLevelUnlocks(CLIENT)
    assert.equal(warm.spells.find((s) => s.name === 'Odium')?.metrics?.damage, 1515)
    // …and once folded WITH the table it is cached for good: the same object comes back, and a
    // later read with no table never discards the better fold.
    assert.equal(buildLevelUnlocks(CLIENT), warm)
    assert.equal(buildLevelUnlocks(null), warm)
  } finally {
    resetLevelUnlocksCache()
  }
})

test('C5 no spell that already had wiki figures moves — the wiki stays primary', () => {
  resetLevelUnlocksCache()
  try {
    const plain = buildLevelUnlocks(null).spells.map((s) => JSON.stringify(s.metrics ?? null))
    resetLevelUnlocksCache()
    const withClient = buildLevelUnlocks(CLIENT).spells
    assert.equal(plain.length, withClient.length)
    let changed = 0
    for (let i = 0; i < withClient.length; i++) {
      const now = JSON.stringify(withClient[i].metrics ?? null)
      if (plain[i] === now) continue
      changed++
      assert.equal(plain[i], 'null', `${withClient[i].name} HAD figures and they moved: ${plain[i]}`)
    }
    assert.equal(changed, 1, 'the one-entry table adds Odium and nothing else')
  } finally {
    resetLevelUnlocksCache()
  }
})

test('C6 the card is unchanged for every spell whose page states its own hitpoint line', () => {
  const db = loadSpellDb()
  for (const name of ['Superior Healing', 'Ice Comet', 'Anarchy', 'Clarity', 'Siphon']) {
    assert.deepEqual(buildSpellDetail(db, name, [], { client: CLIENT }), buildSpellDetail(db, name), `${name} moved`)
  }
})

// ── JOS-444 — THE SECOND FALLBACK ON THE SAME JOIN: the re-use timer ──────────────────────────
//
// `clientHpFor` used to answer only for a row with an effect-0 slot, because the hitpoint slots
// were the only thing anyone read off it. The re-use timer is a fact about a spell whose WIKI page
// may well have stated its damage, so the gate grew a second arm and the row now reaches the reader
// on either fact.
//
// AND THE HONEST STATUS OF THE FALLBACK ITSELF, measured rather than assumed (2026-08-22): NO row
// of the committed catalog needs it today. Exactly two spells whose page omits `recast_time` carry
// a hitpoint line at all — `Call of Sky Strike` and `Call of Fire Strike`, both ranger procs — and
// the owner's own `spells_us.txt` states 0 in field 10 for both of them, which is the same answer
// as silence. So this is STRUCTURALLY covered and unobserved on today's data (the awaiting-sample
// law), and the row below is hand-authored to say so out loud rather than transcribed.

test('C7 a client row reaches the reader on its recast alone, and the page still wins', () => {
  const recastOnly: SpellResistTable = {
    'made up spell': { axis: null, resistAdj: 0, castMs: 0, recastMs: 9000, targetType: 5 }
  }
  const facts = clientHpFor(recastOnly, 'Made Up Spell')
  assert.equal(facts?.recastMs, 9000, 'no effect-0 slot, and it is still worth answering')
  assert.equal(facts?.hp, undefined)

  // A page with a damage line and NO recast_time: the client supplies the denominator.
  const page = { effects: ['Decrease Hitpoints by 300'], mana: 100, castTimeMs: 3000 }
  assert.equal(spellMetricsAt(page, 50, facts)?.dps, 25, '300 / (3 + 9)')
  assert.equal(spellMetricsAt(page, 50)?.dps, 100, 'and without an install, the cast alone')
  // A page that states its own is untouched by the row beside it.
  assert.equal(spellMetricsAt({ ...page, recastMs: 1500 }, 50, facts)?.dps, 66.7)
})

// ── JOS-451 — THE THIRD READING ON THE SAME JOIN: the page's number was WRONG ──────────────────
//
// THE REPORT (owner, 2026-08-23): "HOTs seem broken, like ethereal cleansing". The paladin row read
// `heal 40`. The wiki's page for the spell states `Increase Hitpoints by 10 per tick` and the
// client's row 3683 states `1|100|10|0|103|100` — the same 10, plus two a level, capped at 100. The
// page transcribed the BASE of a level curve and dropped the curve, so the app faithfully drew a
// tenth of the spell.
//
// TWO DELIVERY CLAIMS ARE NEW HERE and neither is arithmetic (that is spellMetrics R17-R20):
//
//   5. THE CLIENT ROW HAS TO TRAVEL. A wiki-lined spell did not carry `clientHp` across the wire,
//      because the only reason to carry it was a page that said nothing. The best-spells readout
//      re-evaluates at the level being VIEWED, so without the row a paladin browsing at 50 would
//      get the broken 40 back from the same dataset that shows 392 on the unlock card.
//   6. THE ROW'S MANA COLUMN AND ITS `dmg/mana` COME FROM ONE RESOLUTION, main-side.
//
// The client row below is transcribed from spell 3683 of the owner's install on 2026-08-23.

const ETHEREAL: SpellResistTable = {
  'ethereal cleansing': {
    axis: null,
    resistAdj: 0,
    castMs: 1500,
    recastMs: 30_000,
    mana: 150,
    targetType: 51,
    hp: [{ base: 10, max: 100, calc: 103, perTick: true }],
    hpDuration: { formula: 3, value: 4 }
  }
}

/** 10 + 2x44 = 98 a tick at the level a paladin gains it, four ticks, 150 mana, a 30s re-use timer. */
const ETHEREAL_FIGURES = {
  heal: 392,
  healPerMana: 2.6,
  hps: 12.4,
  hot: true,
  overSec: 24,
  recastMs: 30_000,
  clientCurve: true
}

test('C8 THE REPORT: the paladin heal-over-time reads the client curve, on the row and the card', () => {
  resetLevelUnlocksCache()
  try {
    const before = buildLevelUnlocks(null).spells.find((s) => s.name === 'Ethereal Cleansing')
    assert.equal(before?.metrics?.heal, 40, 'the defect, as the owner saw it')

    resetLevelUnlocksCache()
    const after = buildLevelUnlocks(ETHEREAL).spells.find((s) => s.name === 'Ethereal Cleansing')
    assert.deepEqual(after?.metrics, ETHEREAL_FIGURES)
    // CLAIM 5: the client row rides along even though the page states a hitpoint line, so a reader
    // asking at ANOTHER level gets the curve rather than the transcribed base.
    assert.deepEqual(after?.clientHp, ETHEREAL['ethereal cleansing'])
    assert.deepEqual(after?.hpLines, ['Increase Hitpoints by 10 per tick'])
    assert.ok(after)
    // …and the re-evaluation the best-spells readout performs agrees: at 50 the cap binds at 100 a
    // tick, which is the acceptance the ticket names. Without the row it would read 40 here.
    assert.equal(spellMetricsForLevel(after, 50)?.heal, 400)
    assert.equal(spellMetricsForLevel(after, 50)?.healPerMana, 2.7)

    // The card is the same numbers from the same function, at the level the spell becomes yours.
    const card = buildSpellDetail(loadSpellDb(), 'Ethereal Cleansing', [], { client: ETHEREAL })
    assert.equal(card.metricsLevel, 44)
    assert.deepEqual(card.metrics, ETHEREAL_FIGURES)
    assert.deepEqual(spellMetricsParts(card.metrics ?? {}), [
      'heal 392',
      'hps 12',
      '2.6 heal/mana',
      'over 24s',
      'recast 30s'
    ])
  } finally {
    resetLevelUnlocksCache()
  }
})

test('C9 and every other spell in the dataset is byte-identical', () => {
  resetLevelUnlocksCache()
  try {
    const plain = buildLevelUnlocks(null).spells.map((s) => JSON.stringify(s))
    resetLevelUnlocksCache()
    const withClient = buildLevelUnlocks(ETHEREAL).spells
    const moved = withClient.filter((s, i) => plain[i] !== JSON.stringify(s)).map((s) => s.name)
    assert.deepEqual(moved, ['Ethereal Cleansing'])
  } finally {
    resetLevelUnlocksCache()
  }
})

test('C10 the mana column is resolved main-side, once, and only over a stated zero', () => {
  // `mana` is ABSENT on the song, not 0 — the parser writes the field only when the column is
  // positive (`manaField`, spellsUsParse.ts), so a free spell reaches this table with no field at
  // all and these rows are what the real parse produces for those two ids.
  const zeroMana: SpellResistTable = {
    'chords of dissonance': { axis: 'magic', resistAdj: -100, castMs: 3000, targetType: 4 },
    'denon`s desperate dirge': { axis: 'magic', resistAdj: 0, castMs: 3000, mana: 800, targetType: 8 }
  }
  // CENSUS (2026-08-23): NO catalog spell placed at a level is in the wiki-silent/client-positive
  // shape — the eight rows that are, are all NPC-only or unlearnable. So the mana rule moves nothing
  // on today's data, and that is asserted rather than left to be discovered by a re-scrape.
  resetLevelUnlocksCache()
  try {
    const plain = buildLevelUnlocks(null).spells.map((s) => `${s.name}:${String(s.mana ?? '')}`)
    resetLevelUnlocksCache()
    const withClient = buildLevelUnlocks(zeroMana).spells.map((s) => `${s.name}:${String(s.mana ?? '')}`)
    assert.deepEqual(withClient, plain)
  } finally {
    resetLevelUnlocksCache()
  }
  // The client charges 0 for every bard song the catalog charges 0 for, which is why nothing moved:
  // the only mana-costing bard rows in the owner's file are `Denon's Desperate Dirge` (800, which
  // the catalog already states) and the level-75-and-up `Denon's Dirge of ...` line.
  assert.equal(clientHpFor(zeroMana, 'Chords of Dissonance'), undefined, 'a stated 0 is not a fact to carry')
  assert.equal(clientHpFor(zeroMana, "Denon`s Desperate Dirge")?.mana, 800)
})
