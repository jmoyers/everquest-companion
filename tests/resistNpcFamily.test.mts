// THE npc SWITCH, at the one place it is read (JOS-385).
//
// A companion to `resistModel.test.mts`, split off for the reason the storeMigrations tests are
// split: that file is at the repo's 400-code-line ceiling and the answer to that is a split rather
// than a widened threshold. The seam is honest as well as convenient — the calibration suite next
// door is about whether the estimator can recover a number it generated; this is about whether a
// PREFERENCE changes which observations reach it.
//
// THE DESIGN THESE TESTS PIN, in one sentence: the ledger folds a charmed pet's casts whatever the
// preference says, and `estimate()` has exactly one line that decides whether such a row becomes a
// likelihood term. So flipping the switch re-draws every number and never costs a re-fold, and a
// family that is switched off is DECLINED rather than deleted — its counts are still on the card.
//
// The rows are hand-built rather than simulated, because nothing here is a claim about the game's
// formula: what is under test is which rows the estimator picks up.

import test from 'node:test'
import assert from 'node:assert/strict'
import { estimate, lowSamples } from '../src/shared/resistModel'
import type { ResistRow, SpellResistTable } from '../src/shared/resistTypes'

/** One all-or-nothing spell on magic, unadjusted, and one proc that nothing can resist. */
const SPELLS: SpellResistTable = {
  'test hold': { axis: 'magic', resistAdj: 0, castMs: 3000, targetType: 5 },
  'test proc': { axis: 'magic', resistAdj: -250, castMs: 0, targetType: 5 }
}

/**
 * The whole-ledger blindness verdict, said out loud: these spells DO land elsewhere. A single
 * hand-built cell where one population never landed looks exactly like a spell this app cannot see
 * land, and that guard has its own tests one file over.
 */
const LANDS_ELSEWHERE: ReadonlySet<string> = new Set<string>()

function blank(spec: Partial<ResistRow> & Pick<ResistRow, 'spellKey' | 'family'>): ResistRow {
  return {
    mobKey: 'a test mob',
    casterKind: 'self',
    casterLevel: 50,
    mobLevel: 50,
    debuffs: '',
    resist: 0,
    land: 0,
    dmg: {},
    firstTs: 0,
    lastTs: 0,
    ...spec
  }
}

/** A cell where the two populations disagree outright: players resisted, the pet not at all. */
const SPLIT_CELL: ResistRow[] = [
  blank({ spellKey: 'test hold', family: 'cast', resist: 90, land: 30 }),
  blank({ spellKey: 'test hold', family: 'cast', casterKind: 'npc', resist: 5, land: 115 })
]

test('the npc family is WEIGHED or not, and that is the whole switch', () => {
  const on = estimate(SPLIT_CELL, SPELLS, { axis: 'magic', mobLevel: 50, unobservable: LANDS_ELSEWHERE })
  const off = estimate(SPLIT_CELL, SPELLS, {
    axis: 'magic',
    mobLevel: 50,
    unobservable: LANDS_ELSEWHERE,
    includeNpcCasters: false
  })

  // Off, the number is the players' own 90-of-120: three quarters resisted, so R lands high.
  assert.equal(off.n, 120)
  assert.ok(off.R > 120, `R=${String(off.R)}`)
  // On, the pet's 115 landings are half the evidence and drag it a long way down. THIS is the
  // owner's worry made numeric, and the reason the control exists rather than a hard-wired answer.
  assert.equal(on.n, 240)
  assert.ok(on.R < off.R - 40, `on=${String(on.R)} off=${String(off.R)}`)

  // ON IS THE DEFAULT when nothing says otherwise, matching the shipped preference: a script or a
  // test that stays silent gets the app's own behaviour rather than a third one.
  assert.equal(on.npcIncluded, true)
  assert.equal(off.npcIncluded, false)
})

test('a switched-off family is still COUNTED - it is declined, not deleted', () => {
  const off = estimate(SPLIT_CELL, SPELLS, {
    axis: 'magic',
    mobLevel: 50,
    unobservable: LANDS_ELSEWHERE,
    includeNpcCasters: false
  })
  // The mob page prints this as `Pets and other creatures: 120 casts, 5 resisted (not included)`.
  // A count that vanished with the switch would make the preference look like it deleted evidence.
  assert.deepEqual(off.byCaster.npc, { n: 120, resist: 5, land: 115 })
  assert.deepEqual(off.byCaster.self, { n: 120, resist: 90, land: 30 })
  assert.deepEqual(off.byCaster.pc, { n: 0, resist: 0, land: 0 })
  // …and the per-spell drilldown still shows every observation, because both populations cast the
  // same spell and an evidence line is about the SPELL.
  assert.equal(off.perSpell.find((e) => e.spellKey === 'test hold')?.casts, 240)
  // The FIT is what changed, and only the fit.
  assert.equal(off.n, 120)
})

test('an npc row with no caster level drops out of the fit exactly as another player’s does', () => {
  // The catalog does not know every creature, and a `/con` is a thing the player has to type. A
  // level-less npc row is evidence with no rc, which is the same nothing a `pc` row always is.
  const rows: ResistRow[] = [
    blank({ spellKey: 'test hold', family: 'cast', resist: 20, land: 20 }),
    blank({ spellKey: 'test hold', family: 'cast', casterKind: 'npc', casterLevel: null, resist: 60, land: 0 })
  ]
  const est = estimate(rows, SPELLS, { axis: 'magic', mobLevel: 50, unobservable: LANDS_ELSEWHERE })
  assert.equal(est.n, 40, 'only the rows that could reach an rc are in the number')
  assert.equal(est.droppedNoLevel, 60)
  // Counted all the same, on the line that says where the evidence came from.
  assert.equal(est.byCaster.npc.n, 60)
})

// ---------------------------------------------------------------------------------------------
// WHAT THE COUNT MEANS (JOS-385, defect 1). The owner's thunder spirit princess read
// `R 58 (36-102) n=83 resistant` with no caveat, and 75 of those 83 were casts of -150/-200/-250
// procs: spells whose resist adjust puts them out of reach of any roll. Eight observations were
// wearing an eighty-three-observation number.

test('THE COUNT SEPARATES WHAT COULD HAVE GONE EITHER WAY from what could not', () => {
  const cell: ResistRow[] = [
    // The princess's shape: a proc cast eighty-seven times and never resisted, beside eight casts
    // of a spell that actually tested the mob.
    blank({ spellKey: 'test proc', family: 'cast', land: 87 }),
    blank({ spellKey: 'test hold', family: 'cast', resist: 3, land: 5 })
  ]
  const est = estimate(cell, SPELLS, { axis: 'magic', mobLevel: 50, unobservable: LANDS_ELSEWHERE })

  assert.equal(est.n, 95, 'everything the fit saw is still counted')
  assert.equal(est.nInformative, 8, 'and only what could have been resisted is called evidence')
  // THE CONSEQUENCE THE OWNER ASKED FOR: this row wears the caveat, and the old one did not.
  assert.equal(lowSamples(est.nInformative), true)
  assert.equal(lowSamples(est.n), false, 'which is exactly what the count used to say instead')

  // The proc is still IN the fit, because "R is not enormous" is true and worth having. What it is
  // out of is the number a person reads as this cell's evidence.
  const withoutProc = estimate([cell[1]], SPELLS, { axis: 'magic', mobLevel: 50, unobservable: LANDS_ELSEWHERE })
  assert.equal(withoutProc.nInformative, est.nInformative)
})

test('the evidence list puts the spells that tested the mob FIRST', () => {
  const cell: ResistRow[] = [
    blank({ spellKey: 'test proc', family: 'cast', land: 87 }),
    blank({ spellKey: 'test hold', family: 'cast', resist: 3, land: 5 })
  ]
  const est = estimate(cell, SPELLS, { axis: 'magic', mobLevel: 50, unobservable: LANDS_ELSEWHERE })
  // By volume alone the proc would head the list at 87 casts against 8, which is how a reader was
  // being told the mob barely resists magic by the one spell that could not have told them.
  assert.deepEqual(est.perSpell.map((e) => e.spellKey), ['test hold', 'test proc'])
  assert.equal(est.perSpell[0].informative, true)
  assert.equal(est.perSpell[1].informative, false)
  assert.equal(est.perSpell[1].resistAdj, -250, 'and the line carries the reason')
  // Nothing is hidden: the proc's own casts are all still on its line.
  assert.equal(est.perSpell[1].casts, 87)
})

test('THE DEFAULT IS THE SHIPPED ONE, and the store says so in one place', async () => {
  // The compiled-in default and the estimator's silent default have to be the same answer, or a
  // card drawn before the store is read would disagree with itself. One import each, one claim.
  const { DEFAULT_RESIST_PREFS, normalizeResistPrefs } = await import('../src/shared/resistPrefs')
  assert.equal(DEFAULT_RESIST_PREFS.includeNpcCasters, true)
  const silent = estimate(SPLIT_CELL, SPELLS, { axis: 'magic', mobLevel: 50, unobservable: LANDS_ELSEWHERE })
  assert.equal(silent.npcIncluded, DEFAULT_RESIST_PREFS.includeNpcCasters)
  // A malformed stored value is replaced by the documented default, never coerced into an intent.
  assert.deepEqual(normalizeResistPrefs({ includeNpcCasters: 'yes' }), DEFAULT_RESIST_PREFS)
  assert.deepEqual(normalizeResistPrefs(null), DEFAULT_RESIST_PREFS)
  assert.deepEqual(normalizeResistPrefs({ includeNpcCasters: false }), { includeNpcCasters: false })
})
