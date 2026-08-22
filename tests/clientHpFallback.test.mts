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

  const card = buildSpellDetail(db, 'Odium', [], CLIENT)
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
    assert.deepEqual(buildSpellDetail(db, name, [], CLIENT), buildSpellDetail(db, name), `${name} moved`)
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
