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
    targetType: 5,
    hpSlot: { base: -217, max: 325, calc: 103 },
    hp: [{ base: -217, max: 325, calc: 103, perTick: true }],
    hpDuration: { formula: 7, value: 5 }
  }
}

/** 303 a tick at shaman 43, five ticks, 409 mana, a 3s cast plus 30s of ticks. */
const ODIUM_FIGURES = {
  damage: 1515,
  damagePerMana: 3.7,
  dps: 45.9,
  dot: true,
  overSec: 30,
  source: 'client'
}

/** What the panel and the card both print, in order. */
const ODIUM_PARTS = ['dmg 1515', 'dps 46', '3.7 dmg/mana', 'over 30s']

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
