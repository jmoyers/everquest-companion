// EVERY ROW AT max(OBSERVED RANK, SIMULATED RANK) — the readout's mote-rank half (JOS-447).
//
// Its own file for the reason `tests/e2e/bestSpellsSteps.mts` is its own file: `bestSpells.test.mts`
// sits at the repo's 400-line ceiling and the rule here is to SPLIT, never ratchet. That suite owns
// the ranking, the era fold and the four tabs; this one owns the rank.
//
// THE ARITHMETIC IS NOT RE-DERIVED HERE. `tests/spellScale.test.mts` carries the fit, the mined
// table it was fitted to and the method that mined it. What this file pins is everything BETWEEN
// that rule and a drawn row: which rank each row is evaluated at, that the observed map joins by
// spell LINE, that a slider lifts a whole table without pulling an owned rank down, that only the
// damage side moves in v1, and the owner's own acceptance case over the real committed corpus.
//
// Same fixture shape as its sibling, deliberately: a hand-built catalog for the rules and the REAL
// committed corpus for the acceptance. No Electron, no network, no live log.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ClassAbbr, ComboInterval, ComboSlot } from '../src/shared/classCombo'
import {
  bestSpellsAt,
  defaultSorts,
  type BestSpellRow,
  type BestSpellsView
} from '../src/shared/bestSpells'
import { comboClassesOf, type LevelUnlockData } from '../src/shared/levelUnlocks'
import { spellLineKey } from '../src/shared/spellLines'
import type { ObservedSpellRanksSnap } from '../src/shared/spellRanks'
import { buildLevelUnlocks } from '../src/main/data/levelUnlocks'

// ---- fixtures ---------------------------------------------------------------------------------

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

const BOTH: BestSpellsView = { sorts: defaultSorts() }

/** A view at the default sorts plus whatever this test is asking about ranks. */
const view = (ranks: Omit<BestSpellsView, 'sorts'>): BestSpellsView => ({ ...BOTH, ...ranks })

/** A RAMPED nuke, a flat nuke, a heal, and the two-sided spell that proves damage moves alone. */
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
      // ONE SPELL, TWO SIDES: an instant hit plus a heal over five ticks. Its damage must move with
      // the rank and its healing must not, which no per-SPELL rule could express.
      name: 'Splitting Word',
      at: [{ cls: 'CLR', level: 14 }],
      mana: 80,
      castTimeMs: 2000,
      durationMs: 30_000,
      hpLines: ['Decrease Hitpoints by 60', 'Increase Hitpoints by 15 per tick']
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

/** A JOS-446 snapshot with one line in it. Keyed the way the fold keys it: line key, numeral off. */
function ranksOf(entries: Record<string, number>): ObservedSpellRanksSnap {
  const out: ObservedSpellRanksSnap = {}
  for (const [name, rank] of Object.entries(entries)) {
    const key = spellLineKey(name)
    out[key] = { key, name, rank, merges: 1, firstAt: 0, lastAt: 0 }
  }
  return out
}

// ---- the join ----------------------------------------------------------------------------------

test('a row with no observed rank and no slider is the base spell, exactly as before the ticket', () => {
  const wiz = comboOf(['WIZ'])
  const plain = rowOf(bestSpellsAt(DATA, wiz, 35, BOTH).tabs.dd.shown, 'Flat Bolt')
  const nulled = rowOf(bestSpellsAt(DATA, wiz, 35, view({ observed: null })).tabs.dd.shown, 'Flat Bolt')
  assert.equal(plain.metrics.damage, 150)
  assert.equal(plain.rank, 0)
  assert.equal(plain.observedRank, 0)
  assert.deepEqual(nulled.metrics, plain.metrics)
})

test('an OBSERVED rank lifts that row and leaves every other row alone', () => {
  const wiz = comboOf(['WIZ'])
  const best = bestSpellsAt(DATA, wiz, 35, view({ observed: ranksOf({ 'Flat Bolt': 8 }) }))
  const lifted = rowOf(best.tabs.dd.shown, 'Flat Bolt')
  const untouched = rowOf(best.tabs.dd.shown, 'Ramp Bolt')
  assert.equal(lifted.observedRank, 8)
  assert.equal(lifted.rank, 8)
  assert.equal(lifted.metrics.damage, 222, '150 + floor(150 * 48 / 100)')
  assert.equal(untouched.rank, 0)
  assert.equal(untouched.metrics.damage, 300, 'the ramp at 35, unscaled')
})

test('the JOIN is by spell LINE, so a numeral on either side finds the same row', () => {
  const wiz = comboOf(['WIZ'])
  // The fold stores `flat bolt`; a catalog name with a numeral and a snapshot key without one are
  // the same line, which is the only join that works against a catalog that mostly omits numerals.
  const snap = ranksOf({ 'Flat Bolt III': 4 })
  assert.deepEqual(Object.keys(snap), ['flat bolt'])
  const row = rowOf(bestSpellsAt(DATA, wiz, 35, view({ observed: snap })).tabs.dd.shown, 'Flat Bolt')
  assert.equal(row.rank, 4)
  assert.equal(row.metrics.damage, 186, '150 + floor(150 * 24 / 100)')
})

test('rank 1 is base at the join, because the fold cannot tell `X I` from `X`', () => {
  const wiz = comboOf(['WIZ'])
  const row = rowOf(
    bestSpellsAt(DATA, wiz, 35, view({ observed: ranksOf({ 'Flat Bolt': 1 }) })).tabs.dd.shown,
    'Flat Bolt'
  )
  assert.equal(row.observedRank, 0)
  assert.equal(row.metrics.damage, 150)
})

// ---- the max -------------------------------------------------------------------------------

test('the SLIDER lifts every row, and MAX keeps a better observed rank where there is one', () => {
  const wiz = comboOf(['WIZ'])
  const best = bestSpellsAt(
    DATA,
    wiz,
    35,
    view({ observed: ranksOf({ 'Flat Bolt': 8 }), simulate: 4 })
  )
  const owned = rowOf(best.tabs.dd.shown, 'Flat Bolt')
  const simulated = rowOf(best.tabs.dd.shown, 'Ramp Bolt')
  assert.equal(owned.rank, 8, 'the slider must never pull an owned rank down')
  assert.equal(owned.metrics.damage, 222)
  assert.equal(simulated.rank, 4)
  assert.equal(simulated.observedRank, 0, 'simulated is not observed, and the row says which')
  assert.equal(simulated.metrics.damage, 372, '300 + floor(300 * 24 / 100)')
})

test('a rank lifts the row`s own derived figures, not only its total', () => {
  const wiz = comboOf(['WIZ'])
  const base = bestSpellsAt(DATA, wiz, 35, BOTH).tabs.dd.shown
  const lifted = bestSpellsAt(DATA, wiz, 35, view({ observed: ranksOf({ 'Flat Bolt': 10 }) })).tabs.dd.shown
  assert.equal(rowOf(lifted, 'Flat Bolt').metrics.damage, 240, '150 + floor(150 * 60 / 100)')
  assert.ok(
    (rowOf(lifted, 'Flat Bolt').metrics.dps ?? 0) > (rowOf(base, 'Flat Bolt').metrics.dps ?? 0),
    'the sustained figure moves with it, since the casting cycle did not change'
  )
  // dmg/mana moves too, because the mana is still the BASE cost in v1 - spellScale.ts's header
  // states that this makes the ratio read LOW for a levelled spell rather than high.
  assert.equal(rowOf(lifted, 'Flat Bolt').metrics.damagePerMana, 4.8, '240 over the base 50 mana')
})

// ---- the scope -----------------------------------------------------------------------------

test('each side moves at ITS measured rate: six percent for damage, three for healing', () => {
  // Healing shipped one merge after damage (owner ruling 2026-08-23) at the half rate the log
  // measured — spellScale.ts holds both fits and tests/spellScale.test.mts the healing evidence.
  const clr = comboOf(['CLR'])
  const at = bestSpellsAt(DATA, clr, 35, view({ observed: ranksOf({ Mend: 8 }), simulate: 6 }))
  const mend = rowOf(at.tabs.heal.shown, 'Mend')
  assert.equal(mend.rank, 8, 'observed 8 beats the simulated 6')
  assert.equal(mend.metrics.heal, 248, '200 + floor(200 * 24/100) at three percent a rank')
  // The two-sided spell proves the split inside ONE row: each side scales by its own rate.
  assert.equal(rowOf(at.tabs.dd.shown, 'Splitting Word').metrics.damage, 81, '60 + floor(60 * 36/100)')
  assert.equal(
    rowOf(at.tabs.hot.shown, 'Splitting Word').metrics.heal,
    85,
    'five ticks of 17: each tick is 15 + floor(15 * 18/100)'
  )
})

// ---- the REAL committed corpus ---------------------------------------------------------------

const REAL = buildLevelUnlocks()
const GARRISONS = "Garrison's Mighty Mana Shock"

test('JOS-447 acceptance: the owner`s Garrisons at VIII reads 492 and tops his damage table', () => {
  // The owner's case, verbatim: "in the table its showing 333 damage rather than the upgraded
  // damage. to decide whether im going to use a different spell, i want to compare upgraded damage
  // to the max i have of a different spell."
  //
  // 492 AND NOT 600 IS THE POINT, and tests/spellScale.test.mts carries the whole argument: the 600
  // his log shows is this 492 wearing the ~1.2216 worn factor his base-rank casts of the same spell
  // wear, and these figures have never included worn anything (spellMetrics.ts's header).
  const wiz = comboOf(['WIZ'])
  const flat = rowOf(bestSpellsAt(REAL, wiz, 35, BOTH).tabs.dd.shown, GARRISONS)
  assert.equal(flat.metrics.damage, 333, 'base, which is what the owner was shown before this ticket')
  assert.equal(flat.observedRank, 0)

  const at = bestSpellsAt(REAL, wiz, 35, view({ observed: ranksOf({ [GARRISONS]: 8 }) }))
  const row = rowOf(at.tabs.dd.shown, GARRISONS)
  assert.equal(row.observedRank, 8)
  assert.equal(row.metrics.damage, 492)
  assert.equal(
    at.tabs.dd.shown[0].name,
    GARRISONS,
    `it should lead by dps: ${at.tabs.dd.shown.slice(0, 3).map((r) => r.name).join(' | ')}`
  )

  // AND THE TABLE REALLY RE-RANKS, which is the whole reason the rank is in the model. On the
  // damage column his spell climbs THREE PLACES, past the three single-cast nukes above it.
  //
  // JOS-449 MOVED THESE TWO INDICES AND THE MOVE IS THE FIX, not a regression. This pin used to
  // read 3 -> 0, with `Lava Storm 401` named as one of the three nukes he was behind. A rain's wiki
  // line states ONE WAVE, so `Lava Storm` is really 1,203 and `Energy Storm` 714, and both now sit
  // above a 492 that no rank can lift past them. The dps assertion above is untouched by the same
  // change, and that is the honest reading of it: a rain totals more per cast and arrives on a 12s
  // re-use timer, so it leads on `dmg` and loses on `dps`. Two columns, two answers.
  const byDamage: BestSpellsView = { sorts: { ...BOTH.sorts, dd: { column: 'damage', desc: true } } }
  const was = bestSpellsAt(REAL, wiz, 35, byDamage).tabs.dd.shown
  const now = bestSpellsAt(REAL, wiz, 35, {
    ...byDamage,
    observed: ranksOf({ [GARRISONS]: 8 })
  }).tabs.dd.shown
  assert.equal(was.findIndex((r) => r.name === GARRISONS), 5, was.slice(0, 6).map((r) => r.name).join(' | '))
  assert.equal(now.findIndex((r) => r.name === GARRISONS), 2, now.slice(0, 3).map((r) => r.name).join(' | '))
  // The two rains he cannot out-rank on the total, named so the next reader of this pin knows why
  // it is not 0: they are the same spell measured per cast rather than per second.
  assert.deepEqual(now.slice(0, 2).map((r) => r.name), ['Lava Storm', 'Energy Storm'])
})

test('JOS-447: simulating a rank lifts the WHOLE real table without disturbing its membership', () => {
  const wiz = comboOf(['WIZ'])
  const base = bestSpellsAt(REAL, wiz, 35, BOTH).tabs.dd.shown
  const sim = bestSpellsAt(REAL, wiz, 35, view({ simulate: 8 })).tabs.dd.shown
  assert.equal(sim.length, base.length, 'the same rows: a rank changes figures, never membership')
  for (const row of sim) {
    const was = rowOf(base, row.name)
    assert.equal(row.rank, 8, row.name)
    assert.ok((row.metrics.damage ?? 0) >= (was.metrics.damage ?? 0), row.name)
  }
  // A uniform lift is still a real re-read: the top row's damage moved by the fitted 48 percent.
  const wasTop = base[0]
  const want = (wasTop.metrics.damage ?? 0) + Math.floor(((wasTop.metrics.damage ?? 0) * 48) / 100)
  assert.equal(rowOf(sim, wasTop.name).metrics.damage, want)
})

test('JOS-447: a simulated rank lifts the healing tabs at the half rate, membership untouched', () => {
  const clr = comboOf(['CLR'])
  const base = bestSpellsAt(REAL, clr, 35, BOTH)
  const sim = bestSpellsAt(REAL, clr, 35, view({ simulate: 10 }))
  assert.ok(base.tabs.heal.shown.length >= 5)
  assert.equal(sim.tabs.heal.shown.length, base.tabs.heal.shown.length, 'figures move, membership never')
  for (const row of sim.tabs.heal.shown) {
    const was = rowOf(base.tabs.heal.shown, row.name)
    assert.equal(row.rank, 10, row.name)
    assert.ok((row.metrics.heal ?? 0) >= (was.metrics.heal ?? 0), row.name)
  }
  // The lift is the HEALING rate, not the damage one: +30 percent at X, floored per magnitude.
  // (Asserted on an instant heal — a single magnitude — so the floor arithmetic is exact; a HoT
  // floors per tick and a whole-total prediction would drift by the per-tick remainders.)
  const instant = base.tabs.heal.shown.find((r) => !r.metrics.hot)
  assert.ok(instant, 'a CLR at 35 owns an instant heal')
  const want = (instant.metrics.heal ?? 0) + Math.floor(((instant.metrics.heal ?? 0) * 30) / 100)
  assert.equal(rowOf(sim.tabs.heal.shown, instant.name).metrics.heal, want)
})
