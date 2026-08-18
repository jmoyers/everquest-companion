// The Resists card's arithmetic and its sentences (JOS-382).
//
// This repo has no jsdom and no React test renderer, so the split is the one `windowedRows` uses:
// the DERIVATION is pure and is tested here, the JSX is asserted by the e2e harness against the
// real app. What is being pinned is the COPY as much as the maths - every string below is
// something a player reads, and the honesty rules apply to all of it.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AT_MOB_LEVEL_NOTE,
  BAR_MAX,
  DIFFERS_NOTE,
  FROM_RESIST_RATE_NOTE,
  NPC_ONLY_NOTE,
  bandFraction,
  barFraction,
  benchmarkRangeText,
  benchmarkText,
  doesNotFitText,
  pct,
  resistRateText,
  NOT_OBSERVABLE_NOTE,
  countText,
  estimateText,
  evidenceByFamily,
  evidenceText,
  LOW_SAMPLE_NOTE,
  NO_DATA_TEXT,
  NPC_NOT_INCLUDED_NOTE,
  cannotBeResistedNote,
  npcCasterSummary,
  songSummary,
  spellDisplayName,
  splitText
} from '../src/renderer/src/features/resists/resistRow'
import { RESIST_AXIS_COLORS } from '../src/renderer/src/features/resists/resistColors'
import { hasAnswer, lowSamples } from '../src/shared/resistModel'
import {
  LOW_SAMPLE_BELOW,
  RESIST_AXES,
  RESIST_AXIS_WORDS,
  type ResistEstimate,
  type ResistSpellEvidence
} from '../src/shared/resistTypes'

function est(spec: Partial<ResistEstimate> = {}): ResistEstimate {
  return {
    R: 126,
    lo: 110,
    hi: 144,
    n: 600,
    nInformative: 600,
    fromBaseline: 480,
    fromYou: 120,
    droppedNoLevel: 0,
    byFamily: { cast: { n: 600, resist: 40, land: 560 }, song: { n: 0, resist: 0, land: 0 } },
    byCaster: {
      self: { n: 600, resist: 40, land: 560 },
      pc: { n: 0, resist: 0, land: 0 },
      npc: { n: 0, resist: 0, land: 0 }
    },
    npcIncluded: true,
    perSpell: [],
    baselineWeight: 0,
    userOnly: false,
    droppedUnobservable: 0,
    baselineFit: null,
    userFit: null,
    differsFromShipped: false,
    nearlyImmune: false,
    ...spec
  }
}

test('the bar runs 0 to 200 because that is the whole range of the roll', () => {
  assert.equal(BAR_MAX, 200)
  assert.equal(barFraction(0), 0)
  assert.equal(barFraction(-40), 0)
  assert.equal(barFraction(100), 0.5)
  assert.equal(barFraction(200), 1)
  // Past 200 the bar pins full and the NUMBER carries the rest: an all-or-nothing spell already
  // never lands, and the partial-only band above it is not something a bar can say.
  assert.equal(barFraction(600), 1)
})

test('the interval draws as a band behind the number', () => {
  assert.deepEqual(bandFraction(100, 150), { left: 0.5, width: 0.25 })
  // A point estimate with no width is a zero-width band, not a negative one.
  assert.deepEqual(bandFraction(150, 150), { left: 0.75, width: 0 })
  assert.deepEqual(bandFraction(220, 400), { left: 1, width: 0 })
})

test('THE NUMBER NEVER APPEARS WITHOUT ITS INTERVAL AND ITS COUNT', () => {
  assert.equal(estimateText(est()), 'R 126 (110-144)')
  assert.equal(countText(600), 'n=600')
})

test('the count says how much of it could have gone either way, when that differs (JOS-385)', () => {
  // The owner's thunder spirit princess: 83 observations, 8 of which were of spells that could
  // actually have been resisted. One number was a claim about how much this app knew, and it was
  // wrong by an order of magnitude.
  assert.equal(countText(8, 83), 'n=8 informative · 83 total')
  // Where nothing is uninformative - which is most cells - the sentence stays the short one.
  assert.equal(countText(83, 83), 'n=83')
  assert.equal(countText(0, 0), 'n=0')
  // BOTH numbers, never one: the procs did land, and that they landed is real work worth seeing.
  assert.match(countText(8, 83), /83/)
  // Copy rules: no acronym, no em dash, and the middle dot is the separator every other row uses.
  assert.ok(!/[–—]/.test(countText(8, 83)))
})

test('ALWAYS SHOW THE RESULT: a thin cell is qualified, never replaced (owner, 2026-08-16)', () => {
  // The words themselves, because they are the whole of the ruling as a player meets it: the
  // caveat is a SECOND thing beside the answer, and the only withheld case is the empty one.
  assert.equal(LOW_SAMPLE_NOTE, 'low samples')
  assert.equal(NO_DATA_TEXT, 'no data')
  // It carries no count of its own — every surface prints `n=3` within a few pixels of it.
  assert.ok(!/\d/.test(LOW_SAMPLE_NOTE), 'the caveat never repeats the count')
  // No em dash, no acronym: the copy rules apply to a caveat as much as to a row.
  for (const s of [LOW_SAMPLE_NOTE, NO_DATA_TEXT]) assert.ok(!/[–—]/.test(s), s)
})

test('the threshold the ruling replaced is gone: an answer exists from one observation', () => {
  assert.equal(hasAnswer(0), false, 'nothing observed is the only case with nothing to say')
  assert.equal(hasAnswer(1), true)
  assert.equal(hasAnswer(4), true, 'the old n >= 5 floor no longer withholds anything')
  // …and the caveat rides the band under LOW_SAMPLE_BELOW, counted in INFORMATIVE observations
  // (JOS-385). It is the caller that never asks about an empty cell: a cell with no tag has
  // nothing to qualify, and both surfaces check the tag before they draw the caveat.
  assert.equal(lowSamples(1), true)
  assert.equal(lowSamples(LOW_SAMPLE_BELOW - 1), true)
  assert.equal(lowSamples(LOW_SAMPLE_BELOW), false)
  // A cell whose casts were ALL of spells that could not be resisted is as thin as a cell gets,
  // however many of them there were - which is the whole defect this argument came out of.
  assert.equal(lowSamples(0), true)
})

test('the row states where its evidence came from, per axis', () => {
  assert.equal(splitText(est()), 'baseline 480 + you 120')
  // One-sided is said one-sidedly: "baseline 480 + you 0" is noise.
  assert.equal(splitText(est({ fromYou: 0 })), 'baseline 480')
  assert.equal(splitText(est({ fromBaseline: 0 })), 'you 120')
  assert.equal(splitText(est({ fromBaseline: 0, fromYou: 0 })), null)
})

test('the patch-detector note is a plain sentence with no em dash and no acronym', () => {
  assert.equal(DIFFERS_NOTE, 'differs from shipped data')
  assert.ok(!/[–—]/.test(DIFFERS_NOTE))
})

/** One evidence line's fields, with the informative defaults a plain nuke has. */
function ev(spec: Partial<ResistSpellEvidence> & Pick<ResistSpellEvidence, 'spellKey'>): ResistSpellEvidence {
  return {
    family: 'cast',
    casts: 0,
    resisted: 0,
    partial: 0,
    full: 0,
    land: 0,
    fromBaseline: 0,
    fromYou: 0,
    resistAdj: 0,
    informative: true,
    ranks: [],
    overchannel: null,
    unknownInvocation: 0,
    ...spec
  }
}

test('an evidence line prints only the clauses that have a number', () => {
  assert.equal(
    evidenceText(ev({ spellKey: 'chaos flux', casts: 155, resisted: 17, partial: 61, full: 77, fromBaseline: 155 })),
    'Chaos Flux: 155 casts, 17 resisted, 61 partial'
  )
  // Zero partials and NO partial information are different things, and only one is worth a word.
  assert.equal(
    evidenceText(ev({ spellKey: 'condemnation of nife', casts: 1, land: 1, fromBaseline: 1 })),
    'Condemnation of Nife: 1 cast'
  )
})

test('a spell that could never have been resisted says so, on its own line (JOS-385)', () => {
  // THE LINE THE OWNER'S PRINCESS ROW NEEDED. Eighty-seven casts of a -250 proc, none of them
  // resisted, heading the evidence list and reading as eighty-seven pieces of good news about the
  // mob's magic resistance. They are one piece of news, and the line now says which.
  assert.equal(
    evidenceText(ev({ spellKey: 'smiting strike', casts: 87, land: 87, resistAdj: -250, informative: false })),
    'Smiting Strike: 87 casts, cannot be resisted at this level: -250 adjust'
  )
  assert.equal(cannotBeResistedNote(-250), 'cannot be resisted at this level: -250 adjust')
  // Copy rules: no em dash, no acronym, and the number is the game's own.
  assert.ok(!/[–—]/.test(cannotBeResistedNote(-1000)))
  assert.doesNotMatch(cannotBeResistedNote(-200), /\b(rc|MR|FR)\b/)
  // An ordinary nuke says nothing of the sort.
  assert.equal(
    evidenceText(ev({ spellKey: 'chaos flux', casts: 10, resisted: 2, full: 8 })),
    'Chaos Flux: 10 casts, 2 resisted'
  )
})

test("a canonical key reads back as a name, apostrophes and small words and all", () => {
  assert.equal(spellDisplayName('chaos flux'), 'Chaos Flux')
  assert.equal(spellDisplayName("denon's disruptive discord"), "Denon's Disruptive Discord")
  assert.equal(spellDisplayName("largo's absonant binding"), "Largo's Absonant Binding")
  // EQ writes "Condemnation of Nife", never "Condemnation Of Nife".
  assert.equal(spellDisplayName('condemnation of nife'), 'Condemnation of Nife')
  assert.equal(spellDisplayName('strength of stone'), 'Strength of Stone')
  // …unless the small word leads, where it is still the start of the name.
  assert.equal(spellDisplayName('of the sky'), 'Of the Sky')
})

test('an evidence line says WHY a spell is not in the number', () => {
  assert.equal(
    evidenceText(
      ev({
        spellKey: "largo's melodic binding",
        family: 'song',
        casts: 400,
        resisted: 400,
        fromBaseline: 400,
        landingsNotObservable: true
      })
    ),
    "Largo's Melodic Binding: 400 casts, 400 resisted, landings not observable"
  )
  assert.equal(NOT_OBSERVABLE_NOTE, 'landings not observable')
  assert.ok(!/[–—]/.test(NOT_OBSERVABLE_NOTE))
})

test('songs get their own line, and only when there are any', () => {
  assert.equal(songSummary(est()), null)
  assert.equal(
    songSummary(est({ byFamily: { cast: { n: 10, resist: 1, land: 9 }, song: { n: 42, resist: 7, land: 35 } } })),
    'Songs: 42 pulses, 7 resisted'
  )
})

test('the evidence list separates the two families', () => {
  const split = evidenceByFamily(
    est({
      perSpell: [
        { spellKey: 'chaos flux', family: 'cast', casts: 100, resisted: 4, partial: 20, full: 76, land: 0, fromBaseline: 100, fromYou: 0 },
        { spellKey: 'chords of dissonance', family: 'song', casts: 40, resisted: 6, partial: 0, full: 0, land: 34, fromBaseline: 0, fromYou: 40 }
      ]
    })
  )
  assert.deepEqual(
    split.casts.map((e) => e.spellKey),
    ['chaos flux']
  )
  assert.deepEqual(
    split.songs.map((e) => e.spellKey),
    ['chords of dissonance']
  )
})

test('NO ACRONYMS: every axis label is the word, and every axis has a colour', () => {
  for (const axis of RESIST_AXES) {
    assert.equal(RESIST_AXIS_WORDS[axis], axis, 'the label is the word itself')
    assert.match(RESIST_AXIS_COLORS[axis], /^#[0-9a-f]{6}$/, 'and a colour travels with it')
  }
  // Five axes, five distinct colours: a repeated hue would say two axes are one thing.
  assert.equal(new Set(Object.values(RESIST_AXIS_COLORS)).size, RESIST_AXES.length)
})

test('the pets-and-creatures line says the same count whether or not it counted (JOS-385)', () => {
  const npc = { n: 98, resist: 41, land: 57 }
  const on = est({ byCaster: { self: { n: 0, resist: 0, land: 0 }, pc: { n: 0, resist: 0, land: 0 }, npc } })
  assert.equal(npcCasterSummary(on), 'Pets and other creatures: 98 casts, 41 resisted')

  // Switched off, the SAME sentence with the parenthesis carrying the difference. A line that
  // disappeared would make the preference look like it deleted evidence rather than declining to
  // weigh it - and the count is exactly what a user wants to see before deciding to flip it back.
  const off = est({
    byCaster: { self: { n: 0, resist: 0, land: 0 }, pc: { n: 0, resist: 0, land: 0 }, npc },
    npcIncluded: false
  })
  assert.equal(npcCasterSummary(off), `Pets and other creatures: 98 casts, 41 resisted (${NPC_NOT_INCLUDED_NOTE})`)

  // NO LINE AT ALL when nothing was cast by one, which is most mobs. "No pet ever cast on this" is
  // not a fact anybody came to the page for, and a zero on an evidence line reads as a measurement.
  assert.equal(npcCasterSummary(est()), null)
  assert.equal(npcCasterSummary(est({ npcIncluded: false })), null)

  // Copy rules, on a string a player reads: no acronyms and no jargon for the thing being counted.
  const text = npcCasterSummary(off) ?? ''
  assert.doesNotMatch(text, /\bNPC\b|estimate|ledger|fold/i)
})

test('the five axis colours clear WCAG AA against the app paper background', () => {
  // The app is dark-only (`theme/theme.ts` builds one theme and there is no light variant), so
  // this is the ONE ground that has to work. Re-measure, do not re-pick, if a light theme lands.
  const paper = [0x17, 0x1a, 0x21]
  const lin = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const lum = (rgb: number[]): number => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
  for (const axis of RESIST_AXES) {
    const hex = RESIST_AXIS_COLORS[axis]
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    const [hi, lo] = [lum(rgb), lum(paper)].sort((a, b) => b - a)
    const ratio = (hi + 0.05) / (lo + 0.05)
    assert.ok(ratio >= 4.5, `${axis} ${hex} contrast ${ratio.toFixed(2)} against the paper background`)
  }
})

// ---------------------------------------------------------------------------------------------
// JOS-387: the two percentages, the guidance sentence, and what a row says when the model does not
// fit. Every string here is copy a player reads, so the honesty rules apply to all of it.

const BENCH_END = {
  level: 50,
  mobLevel: 55,
  atMobLevel: false,
  tag: 'resistant' as const,
  guidance: 'needs overchannel' as const
}

test('THE TWO PERCENTAGES PRINT BESIDE THE BAND, on every row and every chip', () => {
  const bench = {
    ...BENCH_END,
    pPlain: 0.34,
    pOver: 0.96,
    atLo: { ...BENCH_END, pPlain: 0.49, pOver: 1 },
    atHi: { ...BENCH_END, pPlain: 0.21, pOver: 0.9 }
  }
  assert.equal(benchmarkText(bench), 'lands 34% · with overchannel 96%')
  // THE INTERVAL IN THE READER'S OWN UNITS. The ends CROSS when they are mapped — a LOW resistance
  // is the optimistic case — so the range is re-ordered here and never at a call site.
  assert.equal(benchmarkRangeText(bench), 'lands 21% to 49%')
  assert.equal(pct(0), '0%')
  assert.equal(pct(1), '100%')
  // No acronyms, no em dashes, and nothing about our own bookkeeping.
  for (const text of [benchmarkText(bench), benchmarkRangeText(bench), AT_MOB_LEVEL_NOTE, NPC_ONLY_NOTE]) {
    assert.doesNotMatch(text, /[–—]/)
    assert.doesNotMatch(text, /\b(MR|FR|CR|DR|PR)\b/)
  }
})

test('WHAT A ROW SAYS WHEN THE MODEL DOES NOT FIT: the observations, and no number', () => {
  // The Eye of Veeshan's own numbers as the owner read them off the live page.
  assert.equal(doesNotFitText({ total: 118, resisted: 62 }), 'does not fit the model: 62 of 118 resisted')
  // The con card has no room for the sentence, so it prints the rate and says where it came from.
  assert.equal(resistRateText({ total: 118, resisted: 62 }), 'resists 53% of casts')
  assert.equal(resistRateText({ total: 0, resisted: 0 }), 'no resist rate yet')
  assert.equal(FROM_RESIST_RATE_NOTE, 'from resist rate')
})

test('the evidence line carries the rank and the invocation (JOS-387 acceptance)', () => {
  // A rank-IV cast modelled at -60, and overchannel casts at -150 plus -15 per non-hybrid caster
  // class. This is the drilldown line the ticket's acceptance names.
  const line = evidenceText(
    ev({
      spellKey: 'scorching arrow',
      casts: 804,
      resisted: 96,
      ranks: [4],
      overchannel: { casts: 210, adj: -195, casterClasses: 3 }
    })
  )
  assert.match(line, /rank 4 at -60 adjust/)
  assert.match(line, /210 in overchannel at -195 adjust \(3 caster classes\)/)

  // AND WHEN THE LOADOUT WAS NEVER STATED IT SAYS SO, because the -150 is certain and the rest is
  // not: a zero there is a thing we do not know rather than a thing that is zero.
  const unknownClasses = evidenceText(
    ev({ spellKey: 'scorching arrow', casts: 10, overchannel: { casts: 10, adj: -150, casterClasses: 0 } })
  )
  assert.match(unknownClasses, /never stated/)

  // AND THE CASTS THAT PREDATE THE FIRST INVOCATION LINE ARE SHOWN, and said to be out of the fit.
  const unknownInvocation = evidenceText(ev({ spellKey: 'scorching arrow', casts: 13, unknownInvocation: 13 }))
  assert.match(unknownInvocation, /13 before the log said which invocation was up - counted, not in the number/)

  // A spell with neither says neither: no line grows a clause it has no number for.
  const plain = evidenceText(ev({ spellKey: 'scorching arrow', casts: 5 }))
  assert.equal(plain, 'Scorching Arrow: 5 casts')
})
