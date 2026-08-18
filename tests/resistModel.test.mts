// THE ESTIMATOR, AGAINST ROLLS IT DID NOT MAKE (JOS-382).
//
// Everything this feature shows a player rests on one claim: that `estimate()` recovers a mob's
// resist stat from what the log prints. The only way to check that claim without a second
// implementation of EverQuest is to BE the server for a moment — simulate the Live formula for a
// known R, print what the game would have printed, feed those lines' counts back through the
// estimator, and ask whether the number it hands back contains the number we started from.
//
// So these tests are not "does the code run". They are a calibration: over a grid of true R
// values, level gaps, resist adjusts and debuff amounts, the reported 95% interval has to cover
// the truth at least 90% of the time, and the two independent evidence families (all-or-nothing
// landings, and full-versus-partial damage) have to agree with each other. The random stream is a
// fixed-seed linear congruential generator, so a failure is reproducible and a regression cannot
// hide behind "it was unlucky".

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BASELINE_K,
  DIFFERS_MIN_N,
  USER_ONLY_AT,
  debuffAmount,
  estimate,
  unobservableSpells,
} from '../src/shared/resistModel'
// The FORWARD half moved to its own module when JOS-385 pushed the pair past the line ceiling.
// The tests below still read as one subject, because the calibration claim spans both.
import {
  BENCHMARK_LANDS_AT,
  IMMUNE_LEVEL_MOD,
  OVERCHANNEL_PER_CASTER_CLASS,
  OVERCHANNEL_RESIST_ADJ,
  RANK_RESIST_ADJ,
  benchmarkGuidance,
  benchmarkTag,
  WEAK_BELOW,
  casterClassCount,
  effectiveResistAdj,
  expectedDamageFraction,
  levelMod,
  predict,
  priorResist,
  resistBenchmark,
} from '../src/shared/resistFormula'
// The synthetic world moved to its own module when JOS-387 split this suite at the line ceiling;
// tests/resistGuards.test.mts drives the same one, so "be the server for a moment" has one meaning.
import { LANDS_ELSEWHERE, SPELLS, blank, playAon, playDd, rng } from './resistFixtures.mts'
import type { ResistRow } from '../src/shared/resistTypes'


test('levelMod is the server formula, including both of its cliffs', () => {
  assert.equal(levelMod(50, 50), 0)
  // d = 3 -> +4 (integer division, as the server does it), d = -3 -> -4.
  assert.equal(levelMod(50, 53), 4)
  assert.equal(levelMod(53, 50), -4)
  // Below -9 the difference stops helping: a level 1 rat is not infinitely easy to land on.
  assert.equal(levelMod(50, 41), -40)
  assert.equal(levelMod(50, 20), levelMod(50, 41))
  // 21 levels above the caster is immunity, whatever the mob's resist stat says.
  assert.equal(levelMod(50, 71), IMMUNE_LEVEL_MOD)
  assert.equal(levelMod(50, 70), 200)
})

test('the prior is Torven, and it is the only place a number is assumed', () => {
  assert.equal(priorResist('magic', 20), 25)
  assert.equal(priorResist('magic', 25), 35)
  assert.equal(priorResist('fire', 50), 35)
  assert.equal(priorResist('poison', 50), 15)
  assert.equal(priorResist('disease', 10), 15)
})

test('THE GUIDANCE IS THREE BANDS, drawn at 60% of a plain cast (JOS-387)', () => {
  assert.equal(BENCHMARK_LANDS_AT, 0.6)
  // The boundary belongs to the more optimistic band, in both places it is drawn.
  assert.equal(benchmarkGuidance(0.6, 1), 'should land')
  assert.equal(benchmarkGuidance(0.59, 1), 'needs overchannel')
  assert.equal(benchmarkGuidance(0.59, 0.6), 'needs overchannel')
  assert.equal(benchmarkGuidance(0.59, 0.59), 'may not land even with overchannel')
  assert.equal(benchmarkGuidance(0, 0), 'may not land even with overchannel')

  // AND THE SCANNABLE WORD IS THE OTHER READING OF THE SAME BAND (owner ruling, 2026-08-16): the
  // chip carries the word, the sub-line carries the sentence, and `weak` is the one split still
  // drawn on R itself.
  assert.equal(WEAK_BELOW, 10)
  assert.equal(benchmarkTag(40, 'should land'), 'normal')
  assert.equal(benchmarkTag(9, 'should land'), 'weak')
  assert.equal(benchmarkTag(9, 'needs overchannel'), 'resistant', 'weak never survives a harder band')
  assert.equal(benchmarkTag(200, 'may not land even with overchannel'), 'very resistant')
})

test('THE BENCHMARK IS EVALUATED AT THE VIEWER LEVEL, and the level term alone can decide it', () => {
  // An even-level cast against an ordinary creature: R 40 means rc 40, so 80% of casts land.
  const even = resistBenchmark(40, 50, 50)
  assert.equal(even.pPlain, 0.8)
  assert.equal(even.pOver, 1)
  assert.equal(even.guidance, 'should land')
  assert.equal(even.tag, 'normal')
  assert.equal(even.atMobLevel, false)

  // THE OWNER'S CALIBRATION CASE. The player cap is 50 and the Eye of Veeshan is 70, so levelMod
  // alone is +200 before the creature's own resistance is counted — which is why his tashed,
  // maloed, overchannelled slows still fail. This is correct and intended, not a symptom. R 182 is
  // what the shipped baseline fits for its magic.
  assert.equal(levelMod(50, 70), 200)
  const eye = resistBenchmark(182, 50, 70)
  assert.equal(eye.pPlain, 0)
  assert.equal(eye.pOver, 0)
  assert.equal(eye.guidance, 'may not land even with overchannel')
  assert.equal(eye.tag, 'very resistant')
  // The level term ALONE, on an unremarkable creature, is already most of the way there: at +200 a
  // plain cast never lands whatever R is, and only overchannel can bring it back.
  assert.equal(resistBenchmark(0, 50, 70).pPlain, 0)
  assert.equal(resistBenchmark(0, 50, 70).guidance, 'needs overchannel')

  // The middle band is exactly "overchannel is what makes this work".
  const middle = resistBenchmark(120, 50, 53)
  assert.ok(middle.pPlain < BENCHMARK_LANDS_AT && middle.pOver >= BENCHMARK_LANDS_AT)
  assert.equal(middle.guidance, 'needs overchannel')
  assert.equal(middle.tag, 'resistant')

  // No viewer level: an even-level reading, and the surfaces say `at the mob's level`.
  const unknown = resistBenchmark(40, null, 53)
  assert.equal(unknown.atMobLevel, true)
  assert.equal(unknown.pPlain, 0.8, 'levelMod is zero when the two levels are the same')
})

test('A RANK IS -15 AND OVERCHANNEL IS -150 PLUS -15 A CASTER CLASS (JOS-387)', () => {
  assert.equal(RANK_RESIST_ADJ, -15)
  assert.equal(OVERCHANNEL_RESIST_ADJ, -150)
  assert.equal(OVERCHANNEL_PER_CASTER_CLASS, -15)
  // The ticket's own worked examples: Scorching Arrow IV is -60, Frost Shard VI is -90, and a
  // Siphon Life at -215 reads -260 at rank III.
  assert.equal(effectiveResistAdj(0, { rank: 4 }), -60)
  assert.equal(effectiveResistAdj(0, { rank: 6 }), -90)
  assert.equal(effectiveResistAdj(-215, { rank: 3 }), -260)
  // Overchannel, with and without a stated loadout. Zero classes is the honest floor: the -150 is
  // certain and the rest is not.
  assert.equal(effectiveResistAdj(0, { overchannel: true }), -150)
  assert.equal(effectiveResistAdj(0, { overchannel: true, casterClasses: 3 }), -195)
  assert.equal(effectiveResistAdj(0, { overchannel: false, casterClasses: 3 }), 0)
  assert.equal(effectiveResistAdj(0, { overchannel: null, casterClasses: 3 }), 0)
  // And the two stack, which is the case the estimator meets most.
  assert.equal(effectiveResistAdj(0, { rank: 4, overchannel: true, casterClasses: 2 }), -240)
  // The class count is the non-hybrid casters of a `/who` row, and nothing else.
  assert.equal(casterClassCount(['CLR', 'WIZ', 'ENC']), 3)
  assert.equal(casterClassCount(['PAL', 'MNK', 'BRD']), 0, 'hybrids and the bard do not count')
  assert.equal(casterClassCount(['pal', 'nec', 'shd']), 1, 'case does not matter')
  assert.equal(casterClassCount(undefined), 0)
})

test('predict() carries the rank and the invocation into rc', () => {
  const base = { R: 100, casterLevel: 50, mobLevel: 50, resistAdj: 0, kind: 'aon' as const }
  // rc = 100: half the casts land.
  assert.equal(predict(base).pLand, 0.5)
  // Rank 4 takes 60 off rc, so 80% land.
  assert.equal(predict({ ...base, rank: 4 }).pLand, 0.8)
  // Overchannel takes rc below zero entirely.
  assert.equal(predict({ ...base, overchannel: true }).pLand, 1)
  assert.equal(predict({ ...base, overchannel: null }).pLand, 0.5, 'unknown is never assumed')
})

test('SYNTHETIC ROLLS: the interval covers the true R at least 90% of the time', () => {
  const next = rng(20260816)
  const truths = [-40, -10, 0, 10, 25, 40, 60, 90, 120, 160, 200, 240]
  const gaps = [0, 3, -3, 8]
  let trials = 0
  let covered = 0
  for (const R of truths) {
    for (const gap of gaps) {
      const casterLevel = 50
      const mobLevel = 50 + gap
      const offset = levelMod(casterLevel, mobLevel)
      const aon = playAon(R, offset, 300, next)
      const dd = playDd(R, offset, 300, next)
      const rows: ResistRow[] = [
        blank({ spellKey: 'test hold', family: 'cast', mobLevel, ...aon }),
        blank({ spellKey: 'test nuke', family: 'cast', mobLevel, resist: dd.resist, dmg: dd.dmg }),
      ]
      const est = estimate(rows, SPELLS, { axis: 'magic', mobLevel, unobservable: LANDS_ELSEWHERE })
      trials++
      if (R >= est.lo && R <= est.hi) covered++
      assert.equal(est.n, 600, 'every simulated cast is counted')
    }
  }
  const rate = covered / trials
  assert.ok(rate >= 0.9, `coverage ${String(covered)}/${String(trials)} = ${rate.toFixed(2)}, want >= 0.90`)
})

test('SYNTHETIC ROLLS: the two evidence families agree with each other', () => {
  const next = rng(4242)
  for (const R of [10, 40, 90, 150]) {
    const aon = playAon(R, 0, 800, next)
    const dd = playDd(R, 0, 800, next)
    const aonFit = estimate([blank({ spellKey: 'test hold', family: 'cast', ...aon })], SPELLS, {
      axis: 'magic',
      mobLevel: 50,
    })
    const ddFit = estimate(
      [blank({ spellKey: 'test nuke', family: 'cast', resist: dd.resist, dmg: dd.dmg })],
      SPELLS,
      { axis: 'magic', mobLevel: 50 }
    )
    const overlap = aonFit.lo <= ddFit.hi && ddFit.lo <= aonFit.hi
    assert.ok(
      overlap,
      `R=${String(R)}: all-or-nothing [${String(aonFit.lo)},${String(aonFit.hi)}] vs damage [${String(ddFit.lo)},${String(ddFit.hi)}]`
    )
  }
})

test('SYNTHETIC ROLLS: a resist adjust is modelled out, not absorbed into R', () => {
  const next = rng(99)
  const R = 140
  // THE WHOLE ARGUMENT FOR MODELLING resistAdj, in one test. A -250 proc lands on this mob every
  // single time while a plain nuke of the same axis is half-resisted; the raw resist RATE of the
  // two spells therefore disagrees by 60 points and says nothing about the mob. Subtract each
  // spell's own adjust and both arms describe one creature.
  const proc = playAon(R, -250, 900, next)
  const plain = playAon(R, 0, 900, next)
  const spells: SpellResistTable = {
    'test proc': { axis: 'fire', resistAdj: -250, castMs: 0, targetType: 5 },
    'test plain': { axis: 'fire', resistAdj: 0, castMs: 3000, targetType: 5 },
  }
  assert.equal(proc.resist, 0, 'the proc is never resisted, which a raw rate would read as R = 0')
  const est = estimate(
    [
      blank({ spellKey: 'test proc', family: 'cast', ...proc }),
      blank({ spellKey: 'test plain', family: 'cast', ...plain }),
    ],
    spells,
    { axis: 'fire', mobLevel: 50 }
  )
  assert.ok(est.R >= R - 20 && est.R <= R + 20, `R=${String(est.R)} for a true ${String(R)}`)
  assert.ok(R >= est.lo && R <= est.hi, `interval [${String(est.lo)},${String(est.hi)}]`)
})

test('a debuff the row names is joined back to an amount from the client table', () => {
  // Malaisement: base 20, formula 101 (base + level/2), capped at 40. A level-60 caster gets 40.
  assert.equal(debuffAmount('test malo', 'magic', 60, SPELLS), 40)
  assert.equal(debuffAmount('test malo', 'fire', 40, SPELLS), 40)
  // A level-20 caster: 20 + 10 = 30, under the cap.
  assert.equal(debuffAmount('test malo', 'cold', 20, SPELLS), 30)
  assert.equal(debuffAmount('', 'magic', 60, SPELLS), 0)
  assert.equal(debuffAmount('not a spell', 'magic', 60, SPELLS), 0)
})

test('SYNTHETIC ROLLS: a debuffed cell and an undebuffed one describe the same mob', () => {
  const next = rng(7)
  const R = 140
  const clean = playAon(R, 0, 600, next)
  const maloed = playAon(R, -40, 600, next)
  const est = estimate(
    [
      blank({ spellKey: 'test hold', family: 'cast', ...clean }),
      blank({ spellKey: 'test hold', family: 'cast', debuffs: 'test malo', casterLevel: 60, ...maloed }),
    ],
    SPELLS,
    { axis: 'magic', mobLevel: 50 }
  )
  assert.ok(est.R >= R - 25 && est.R <= R + 25, `R=${String(est.R)} for a true ${String(R)}`)
})

test('YOUR OWN LOG WINS: 50 of your observations beat 500 contradicting shipped ones', () => {
  const next = rng(1234)
  const userTruth = 30
  const baselineTruth = 190
  const user = playAon(userTruth, 0, USER_ONLY_AT, next)
  const base = playAon(baselineTruth, 0, 500, next)
  const rows: ResistRow[] = [
    blank({ spellKey: 'test hold', family: 'cast', ...user }),
    blank({ spellKey: 'test hold', family: 'cast', source: 'baseline', ...base }),
  ]
  const est = estimate(rows, SPELLS, { axis: 'magic', mobLevel: 50 })
  assert.equal(est.userOnly, true, 'at 50 own observations the baseline stops counting')
  assert.equal(est.baselineWeight, 0)
  assert.ok(
    Math.abs(est.R - userTruth) < Math.abs(est.R - baselineTruth),
    `R=${String(est.R)} should sit on the user's ${String(userTruth)}, not the baseline's ${String(baselineTruth)}`
  )
  assert.ok(est.R < 90, `R=${String(est.R)} is not the shipped answer`)
  assert.equal(est.differsFromShipped, true, 'and it says so')
  assert.equal(est.fromYou, USER_ONLY_AT)
  assert.equal(est.fromBaseline, 500)
})

test('below the user-only threshold the baseline still counts, at exactly K/(K+n)', () => {
  const next = rng(555)
  const user = playAon(30, 0, 20, next)
  const base = playAon(190, 0, 500, next)
  const est = estimate(
    [
      blank({ spellKey: 'test hold', family: 'cast', ...user }),
      blank({ spellKey: 'test hold', family: 'cast', source: 'baseline', ...base }),
    ],
    SPELLS,
    { axis: 'magic', mobLevel: 50 }
  )
  assert.equal(est.userOnly, false)
  assert.ok(Math.abs(est.baselineWeight - BASELINE_K / (BASELINE_K + 20)) < 1e-9)
  assert.ok(est.R > 60, 'twenty observations do not yet overturn five hundred')
})

test('the patch detector needs BOTH sides well populated before it says anything', () => {
  const next = rng(31337)
  const thinUser = playAon(30, 0, DIFFERS_MIN_N - 1, next)
  const base = playAon(190, 0, 500, next)
  const est = estimate(
    [
      blank({ spellKey: 'test hold', family: 'cast', ...thinUser }),
      blank({ spellKey: 'test hold', family: 'cast', source: 'baseline', ...base }),
    ],
    SPELLS,
    { axis: 'magic', mobLevel: 50 }
  )
  assert.equal(est.differsFromShipped, false)
})

test('a mez resist above the spell level cap is filed nowhere', () => {
  const rows: ResistRow[] = [
    // The mob is level 60; Mesmerization says "up to level 55". Every one of these resists is the
    // level cap talking, and none of them is evidence about magic resistance.
    blank({ spellKey: 'test mez', family: 'cast', mobLevel: 60, resist: 40, land: 0 }),
    blank({ spellKey: 'test hold', family: 'cast', mobLevel: 60, resist: 5, land: 45 }),
  ]
  const est = estimate(rows, SPELLS, { axis: 'magic', mobLevel: 60 })
  assert.equal(est.n, 50, 'only the uncapped spell counts')
  assert.equal(est.perSpell.length, 1)
  assert.equal(est.perSpell[0].spellKey, 'test hold')
  assert.ok(est.R < 60, `R=${String(est.R)} — the capped mez must not make it look resistant`)
})

test('a spell with no resist axis says nothing about any axis', () => {
  const est = estimate([blank({ spellKey: 'test malo', family: 'cast', resist: 20, land: 0 })], SPELLS, {
    axis: 'magic',
  })
  assert.equal(est.n, 0)
  assert.equal(est.perSpell.length, 0)
})

test('an observation with no level on one side cannot enter the likelihood, and says so', () => {
  const est = estimate(
    [blank({ spellKey: 'test hold', family: 'cast', casterLevel: null, resist: 9, land: 11 })],
    SPELLS,
    { axis: 'magic', mobLevel: 50 }
  )
  assert.equal(est.n, 0)
  assert.equal(est.droppedNoLevel, 20)
  assert.equal(est.perSpell[0].casts, 20, 'it is still evidence, and the drilldown still shows it')
})

test('a mob 21 levels above the caster teaches nothing about its resist stat', () => {
  const est = estimate(
    [blank({ spellKey: 'test hold', family: 'cast', mobLevel: 75, resist: 60, land: 0 })],
    SPELLS,
    { axis: 'magic', mobLevel: 75 }
  )
  assert.equal(est.n, 0, 'immune-by-level resists are not resist-stat evidence')
})

test('songs are their own family and can be excluded in one place', () => {
  const rows: ResistRow[] = [
    blank({ spellKey: 'test hold', family: 'cast', resist: 10, land: 90 }),
    blank({ spellKey: 'test hold', family: 'song', resist: 80, land: 20 }),
  ]
  const both = estimate(rows, SPELLS, { axis: 'magic', mobLevel: 50 })
  const castsOnly = estimate(rows, SPELLS, { axis: 'magic', mobLevel: 50, includeSongs: false })
  assert.equal(both.byFamily.song.n, 100)
  assert.equal(both.byFamily.cast.n, 100)
  assert.equal(castsOnly.byFamily.song.n, 100, 'the evidence line still reports them')
  assert.equal(castsOnly.n, 100, 'but they are out of the fit')
  assert.ok(castsOnly.R < both.R, 'and dropping a resistant family lowers the estimate')
})

test('predict inverts the same model the estimator fits', () => {
  const even = predict({ R: 100, casterLevel: 50, mobLevel: 50, resistAdj: 0, kind: 'aon' })
  assert.ok(Math.abs(even.pResistMsg - 0.5) < 1e-9)
  assert.ok(Math.abs(even.pLand - 0.5) < 1e-9)
  const nuke = predict({ R: 100, casterLevel: 50, mobLevel: 50, resistAdj: 0, kind: 'dd' })
  assert.ok(Math.abs((nuke.pFull ?? 0) - 0.5) < 1e-9)
  assert.ok(Math.abs(nuke.pResistMsg - 100 / 600) < 1e-9)
  // The lure's adjust is what makes it land: rc drops to -100, so nothing is resisted at all.
  const lure = predict({ R: 100, casterLevel: 50, mobLevel: 50, resistAdj: -200, kind: 'dd' })
  assert.equal(lure.pFull, 1)
  assert.equal(lure.pResistMsg, 0)
  // A debuff moves it the same way an adjust does.
  const maloed = predict({ R: 100, casterLevel: 50, mobLevel: 50, resistAdj: 0, debuff: 40, kind: 'aon' })
  assert.ok(Math.abs(maloed.pLand - 0.7) < 1e-9)
  // Immune by level, from both directions.
  const overLevelled = predict({ R: 0, casterLevel: 30, mobLevel: 60, resistAdj: -1000, kind: 'aon' })
  assert.equal(overLevelled.pLand, 0)
})

test('expected damage fraction falls off the way the partial formula says it does', () => {
  assert.equal(expectedDamageFraction(0), 1)
  assert.ok(expectedDamageFraction(600) < expectedDamageFraction(200))
  assert.ok(expectedDamageFraction(200) < expectedDamageFraction(50))
  assert.ok(expectedDamageFraction(50) < 1)
})

test('EVIDENCE SYMMETRY: a spell we never see land is not a mob that resists everything', () => {
  // THE GENERAL FORM OF THE BUG THAT SHIPPED. A binomial needs both outcomes; a spell whose every
  // observation is a resist has a maximum-likelihood rc at the top of the grid, and one such spell
  // drags a whole axis to "nearly immune" however much honest evidence sits beside it. Two real
  // causes, one shape: a bard song under the Symphonic Aura whose landing emote nothing joined to
  // (400 resists, 0 landings), and a proc whose landing prints no line at all (37 resists, 0).
  const rows: ResistRow[] = [
    blank({ spellKey: 'test hold', family: 'cast', resist: 200, land: 0 }),
    blank({ spellKey: 'test hold b', family: 'cast', resist: 10, land: 90 }),
  ]
  const blind = unobservableSpells(rows)
  assert.deepEqual([...blind], ['test hold'])

  const guarded = estimate(rows, SPELLS, { axis: 'magic', mobLevel: 50, unobservable: blind })
  assert.equal(guarded.n, 100, 'only the spell we can see both halves of is in the number')
  assert.equal(guarded.droppedUnobservable, 200)
  assert.ok(guarded.R < 50, `R=${String(guarded.R)} - the blind spell must not decide this`)

  // …and the rows are still THERE, saying why they are not counted.
  const ev = guarded.perSpell.find((e) => e.spellKey === 'test hold')
  assert.ok(ev)
  assert.equal(ev.casts, 200)
  assert.equal(ev.landingsNotObservable, true)
  const seen = guarded.perSpell.find((e) => e.spellKey === 'test hold b')
  assert.equal(seen?.landingsNotObservable, undefined)

  // Unguarded, the SAME evidence describes a different creature. That is the defect, reproduced,
  // and stated in the units a player reads it in: the word beside the bar changes.
  const naive = estimate(rows, SPELLS, { axis: 'magic', mobLevel: 50, unobservable: new Set() })
  assert.ok(naive.R > 100, `R=${String(naive.R)} - without the guard one blind spell decides it`)
  // Stated in the units a player reads it in: the guidance beside the bar changes band.
  assert.equal(resistBenchmark(guarded.R, 50, 50).guidance, 'should land')
  assert.equal(resistBenchmark(naive.R, 50, 50).guidance, 'needs overchannel')
})

test('the verdict is about the SPELL, and the caller decides the scope', () => {
  // A mob that resisted every cast of a spell that lands elsewhere is REAL evidence, and scoping
  // the verdict to one mob's rows would throw it away with the blindness it is meant to catch.
  const everywhere: ResistRow[] = [
    blank({ mobKey: 'a stubborn mob', spellKey: 'test hold', family: 'cast', resist: 40, land: 0 }),
    blank({ mobKey: 'an ordinary mob', spellKey: 'test hold', family: 'cast', resist: 5, land: 95 }),
  ]
  // Over the WHOLE ledger the spell plainly lands, so nothing is held out…
  assert.equal(unobservableSpells(everywhere).size, 0)
  const stubborn = everywhere.filter((r) => r.mobKey === 'a stubborn mob')
  const est = estimate(stubborn, SPELLS, {
    axis: 'magic',
    mobLevel: 50,
    unobservable: unobservableSpells(everywhere),
  })
  assert.equal(est.n, 40, 'the stubborn mob keeps its evidence')
  assert.ok(est.R > 150, 'and is allowed to be as resistant as it demonstrably is')
  // …where the same rows judged alone would have been discarded.
  assert.deepEqual([...unobservableSpells(stubborn)], ['test hold'])
})

test('a thin cell does not scream immune', () => {
  // Five resists out of five. The maximum-likelihood answer is 200 and that is a confident lie.
  const est = estimate([blank({ spellKey: 'test hold', family: 'cast', resist: 5, land: 0 })], SPELLS, {
    axis: 'magic',
    mobLevel: 50,
    unobservable: LANDS_ELSEWHERE,
  })
  assert.equal(est.n, 5)
  assert.ok(est.R < 200, `R=${String(est.R)} — the prior has to pull this down`)
  // And the interval has to admit how little it rules out: five resists cannot distinguish
  // "resistant" from "immune", so it runs far above the point estimate. (Its top is now finite
  // because the interval is the central 95% of a posterior with a broad prior on it rather than a
  // likelihood cut — JOS-387 — so the claim is about WIDTH, which is the honest one.)
  assert.ok(est.hi >= 250, `hi=${String(est.hi)} — the evidence rules out very little above`)
  assert.ok(est.hi - est.lo > 200, `interval width ${String(est.hi - est.lo)} — five casts know nothing`)
  assert.equal(est.nearlyImmune, false)
})
