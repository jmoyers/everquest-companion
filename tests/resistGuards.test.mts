// THE FOUR GUARDS THE OWNER'S 2026-08-16 REVIEW ASKED FOR (JOS-387).
//
// Two live rows were wrong on the mob page, in opposite directions, and neither was a coding
// mistake — both were the fitter answering honestly a question that had been put to it badly. The
// four claims below are the answers, and every one of them is stated in the NUMBERS of the row that
// produced it, so a future change that breaks one breaks it out loud:
//
//   THE POSTERIOR MEDIAN, because a saturating likelihood has plateaux and the old argmax reported
//   the weakest edge of one (a dracoliche's disease: thirty observations, all resists, read
//   `R 60 (46-600) resistant`).
//   THE HARD DATA RULE, because "it resisted 118 of the 120 casts we watched" is a fact no level
//   term, prior or grid may talk a player out of.
//   THE PINNED-FIT GUARD, because a fit that does not explain the observations must print the
//   observations instead of a number (the Eye of Veeshan: 31 of 59 refused at a twenty-level gap,
//   displayed as `R 0 (0-0)` and tagged WEAK).
//   THE npc-ONLY CAVEAT, because a cell standing entirely on catalog-levelled casters is the one
//   whose level term is least trustworthy, and the reader is entitled to know.
//
// The synthetic world these run in is tests/resistFixtures.mts, shared with the calibration suite
// next door — one definition of "be the server for a moment", so the two cannot drift.

import test from 'node:test'
import assert from 'node:assert/strict'
import { ALL_RESISTED_MIN_N, ALL_RESISTED_SHARE, damageRefKey, estimate } from '../src/shared/resistModel'
import { OVERCHANNEL_PER_CASTER_CLASS, OVERCHANNEL_RESIST_ADJ, RANK_RESIST_ADJ, levelMod } from '../src/shared/resistFormula'
import { FULL_DAMAGE, LANDS_ELSEWHERE, SPELLS, blank, playAon, rng } from './resistFixtures.mts'
import type { ResistRow } from '../src/shared/resistTypes'


test('THE POINT IS THE POSTERIOR MEDIAN, so a PLATEAU reports its middle and not its weakest edge', () => {
  // CASE B, a dracoliche's disease. Thirty observations, every one of them a resist, at a caster
  // nineteen levels below the mob (levelMod +180). Every R at or above about 20 predicts "resisted"
  // with certainty, so the likelihood is FLAT from there to the top of the grid — and the old
  // argmax sat at the bottom edge of that plateau and reported the weakest resistance the evidence
  // allowed as though it were the estimate (`R 60 (46-600) resistant`).
  const mobLevel = 58
  const est = estimate(
    [blank({ spellKey: 'test hold', family: 'cast', casterLevel: 39, mobLevel, resist: 30, land: 0 })],
    SPELLS,
    { axis: 'magic', mobLevel, unobservable: LANDS_ELSEWHERE }
  )
  assert.equal(est.n, 30)
  assert.equal(levelMod(39, mobLevel), 180)
  assert.ok(est.R > 40, `R=${String(est.R)} sits inside the plateau, not on its lowest edge`)
  assert.ok(est.hi - est.lo > 100, 'and the interval says the plateau is a plateau')

  // A PEAKED LIKELIHOOD IS UNCHANGED, which is the other half of the claim: the median only differs
  // from the maximum where the maximum was an artifact.
  const next = rng(90210)
  const played = playAon(120, 0, 800, next)
  const peaked = estimate([blank({ spellKey: 'test hold', family: 'cast', ...played })], SPELLS, {
    axis: 'magic',
    mobLevel: 50,
    unobservable: LANDS_ELSEWHERE,
  })
  assert.ok(Math.abs(peaked.R - 120) <= 8, `R=${String(peaked.R)} for a true 120`)
})

test('THE HARD DATA RULE: 90% resisted is the top band whatever the fitter says', () => {
  assert.equal(ALL_RESISTED_MIN_N, 10)
  assert.equal(ALL_RESISTED_SHARE, 0.9)
  const opts = { axis: 'magic' as const, mobLevel: 50, unobservable: LANDS_ELSEWHERE }
  const allResisted = estimate([blank({ spellKey: 'test hold', family: 'cast', resist: 30, land: 0 })], SPELLS, opts)
  assert.equal(allResisted.resistsAlmostEverything, true)
  assert.deepEqual(allResisted.empirical, { total: 30, resisted: 30 })

  // Nine in ten is the line, and it is a line about the OBSERVATIONS: a cell that fell just short
  // of it is left to the model.
  const mostly = estimate([blank({ spellKey: 'test hold', family: 'cast', resist: 27, land: 3 })], SPELLS, opts)
  assert.equal(mostly.resistsAlmostEverything, true, '27 of 30 is exactly 90%')
  const short = estimate([blank({ spellKey: 'test hold', family: 'cast', resist: 26, land: 4 })], SPELLS, opts)
  assert.equal(short.resistsAlmostEverything, false)

  // THIN EVIDENCE NEVER TRIGGERS IT. Nine resists out of nine is not a fact about a creature.
  const thin = estimate([blank({ spellKey: 'test hold', family: 'cast', resist: 9, land: 0 })], SPELLS, opts)
  assert.equal(thin.resistsAlmostEverything, false)

  // AND A DAMAGE SPELL COUNTS ITS PARTIALS AS RESISTS for this rule: a silently reduced hit is the
  // roll going against you on a spell that cannot be refused outright. The reference comes from the
  // whole ledger, so it is stated here rather than re-derived from a cell that is almost all
  // partials (which is exactly the shape `fullDamageRefs` must not read a base out of).
  const refs = new Map([[damageRefKey('test nuke', 50), { value: FULL_DAMAGE, allOrNothing: false }]])
  const dd = estimate(
    [blank({ spellKey: 'test nuke', family: 'cast', resist: 10, dmg: { '150': 2, '40': 20, '30': 8 } })],
    SPELLS,
    { ...opts, modes: refs }
  )
  assert.equal(dd.resistsAlmostEverything, true, '10 resists and 28 partials out of 40')
})

test('THE PINNED-FIT GUARD: the Eye of Veeshan does not fit, and a weak mob still does', () => {
  // CASE A, the owner's row. A level-50 charmed pet throws a poison DoT at a level-70 creature and
  // is refused 31 times out of 59. `levelMod` alone is +200, so the model predicts 100% resisted at
  // every resistance a creature can have; the fitter slides R below zero and STILL predicts the
  // wrong rate, and the display used to clamp that to `R 0 (0-0)` and call it weak.
  const eye = estimate(
    [
      blank({
        spellKey: 'test hold',
        family: 'cast',
        casterKind: 'npc',
        casterLevel: 50,
        mobLevel: 70,
        resist: 31,
        land: 28,
      }),
    ],
    SPELLS,
    { axis: 'magic', mobLevel: 70, unobservable: LANDS_ELSEWHERE }
  )
  assert.equal(eye.pinned, true, 'no resistance this game can express explains 31 of 59 at that gap')
  assert.deepEqual(eye.empirical, { total: 59, resisted: 31 })
  // …and the cell is npc-only, which is the caveat the row wears beside the sentence.
  assert.equal(eye.npcOnly, true)

  // A MOB THAT SIMPLY NEVER RESISTS ANYTHING IS NOT A FAILURE. Its fit is negative too — that is how
  // the model spells "nothing you cast is ever refused" — and refusing to print a number for it
  // would blank twenty-one cells of the shipped baseline that are answering correctly.
  const weak = estimate([blank({ spellKey: 'test hold', family: 'cast', resist: 0, land: 40 })], SPELLS, {
    axis: 'magic',
    mobLevel: 50,
    unobservable: LANDS_ELSEWHERE,
  })
  assert.equal(weak.pinned, false)
  assert.deepEqual(weak.empirical, { total: 40, resisted: 0 })

  // AND AN ORDINARY WELL-POPULATED CELL IS NEVER REFUSED, which is what the rate gap buys: four
  // sigma alone fires on any large cell the model is a few points off on.
  const next = rng(24680)
  const played = playAon(90, 0, 400, next)
  const ordinary = estimate([blank({ spellKey: 'test hold', family: 'cast', ...played })], SPELLS, {
    axis: 'magic',
    mobLevel: 50,
    unobservable: LANDS_ELSEWHERE,
  })
  assert.equal(ordinary.pinned, false)
})

test('a cell standing only on pets and other creatures says so', () => {
  const opts = { axis: 'magic' as const, mobLevel: 50, unobservable: LANDS_ELSEWHERE }
  const npcOnly = estimate(
    [blank({ spellKey: 'test hold', family: 'cast', casterKind: 'npc', resist: 20, land: 30 })],
    SPELLS,
    opts
  )
  assert.equal(npcOnly.npcOnly, true)
  // One of your own casts is enough to make it no longer true: the caveat is about the whole cell.
  const mixed = estimate(
    [
      blank({ spellKey: 'test hold', family: 'cast', casterKind: 'npc', resist: 20, land: 30 }),
      blank({ spellKey: 'test hold', family: 'cast', casterKind: 'self', resist: 1, land: 1 }),
    ],
    SPELLS,
    opts
  )
  assert.equal(mixed.npcOnly, false)
})

test('SYNTHETIC ROLLS: the same mob hit at rank 0 and rank 6, in and out of overchannel', () => {
  // THE TICKET'S OWN ACCEPTANCE, played out. Four populations of the same creature, each made under
  // a different resist adjust — the base spell, the same spell at rank 6 (-90), the base spell in
  // overchannel with two caster classes (-180), and rank 6 in overchannel (-270). If the estimator
  // did NOT model the two terms, the four raw resist rates would describe four different mobs.
  const next = rng(387387)
  const R = 150
  const oc = OVERCHANNEL_RESIST_ADJ + OVERCHANNEL_PER_CASTER_CLASS * 2
  const plain = playAon(R, 0, 400, next)
  const ranked = playAon(R, RANK_RESIST_ADJ * 6, 400, next)
  const over = playAon(R, oc, 400, next)
  const both = playAon(R, RANK_RESIST_ADJ * 6 + oc, 400, next)

  // The raw rates really do disagree, which is the whole reason the terms have to be modelled.
  assert.ok(plain.resist / 400 - both.resist / 400 > 0.5, 'the four populations look nothing alike')

  const rows: ResistRow[] = [
    blank({ spellKey: 'test hold', family: 'cast', ...plain }),
    blank({ spellKey: 'test hold', family: 'cast', rank: 6, ...ranked }),
    blank({ spellKey: 'test hold', family: 'cast', overchannel: true, casterClasses: 2, ...over }),
    blank({ spellKey: 'test hold', family: 'cast', rank: 6, overchannel: true, casterClasses: 2, ...both }),
  ]
  const est = estimate(rows, SPELLS, { axis: 'magic', mobLevel: 50, unobservable: LANDS_ELSEWHERE })
  assert.equal(est.n, 1600)
  assert.ok(R >= est.lo && R <= est.hi, `interval [${String(est.lo)},${String(est.hi)}] must contain ${String(R)}`)
  assert.ok(Math.abs(est.R - R) <= 12, `R=${String(est.R)} for a true ${String(R)}`)

  // AND THE DRILLDOWN SAYS SO, which is the acceptance the ticket words as "visible in the evidence
  // detail": the rank and the invocation are on the spell's own evidence line.
  const ev = est.perSpell.find((e) => e.spellKey === 'test hold')
  assert.ok(ev)
  assert.deepEqual(ev.ranks, [6])
  assert.equal(ev.overchannel?.adj, -180)
  assert.equal(ev.overchannel?.casterClasses, 2)
  assert.equal(ev.unknownInvocation, 0)
})

test('an unknown invocation is COUNTED and never weighed', () => {
  // Your own casts from before the log's first invocation line: real casts with an unknown -150 on
  // them, which is not something a number can be fitted through.
  const rows: ResistRow[] = [
    blank({ spellKey: 'test hold', family: 'cast', resist: 10, land: 10 }),
    blank({ spellKey: 'test hold', family: 'cast', overchannel: null, resist: 40, land: 0 }),
  ]
  const est = estimate(rows, SPELLS, { axis: 'magic', mobLevel: 50, unobservable: LANDS_ELSEWHERE })
  assert.equal(est.n, 20, 'only the casts whose invocation the log stated are in the number')
  assert.equal(est.droppedUnknownInvocation, 40)
  const ev = est.perSpell.find((e) => e.spellKey === 'test hold')
  assert.equal(ev?.casts, 60, 'and all sixty are still shown')
  assert.equal(ev?.unknownInvocation, 40)

  // A CREATURE'S NULL IS A DIFFERENT NULL and must not delete the npc family: nothing states an
  // NPC's invocation and nothing ever will, so those rows are weighed exactly as JOS-385 shipped.
  const npc = estimate(
    [blank({ spellKey: 'test hold', family: 'cast', casterKind: 'npc', overchannel: null, resist: 20, land: 20 })],
    SPELLS,
    { axis: 'magic', mobLevel: 50, unobservable: LANDS_ELSEWHERE }
  )
  assert.equal(npc.n, 40)
  assert.equal(npc.droppedUnknownInvocation, 0)
})
