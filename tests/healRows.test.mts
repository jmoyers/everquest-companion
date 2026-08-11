// ONE HEALING BUILDER, TWO SURFACES — and every honest sentence it prints.
//
// P2 of docs/plans/combat-overlay-parity.md (owner ruling: "the combat panel lacks the overlay's
// HEAL functionality — parity", "panel and overlay share as much functionality as possible
// through shared components — drill-down included"). Before it, the floating heal overlays had
// all of the healing UI and the Combat tab had none — a total divergence, not a subtle one. Now
// both render from `healRows.healPanel`, exactly as both damage meters render from
// `petRows.meterPanel`, and the last block below is the pin that keeps it that way.
//
// The windows are synthetic on the same footing as tests/combatPetNesting.test.mts: these are
// pure derivations over already-aggregated data, so what is worth pinning is not a log span but
// the invariants that make the layout HONEST —
//
//   1. exactly TWO levels exist, because the model has exactly two (healer → flat lane list).
//      There is no third level to invent: a HealSpellView has no children, and HoT ticks are
//      indistinguishable from direct heals in the log (shared/combat.ts).
//   2. a stale drill renders LEVEL 1 without the stored value being touched — the same rule the
//      damage meter and the overlay drill already keep.
//   3. absorption is never dressed up as restored healing: no overheal is invented for a rune,
//      and the GRANTED-not-consumed caveat travels with every absorption number.
//   4. the count-only absorption families (absorbed swings, damage shields) carry no amount, so
//      they are never a bar and never in a total.
//   5. counter-healing (enemies healed) is an ANNOTATION and never enters the healer ranking.
//   6. an UNSTATED lane (JOS-86 — Mend, whose line carries no number) never prints a figure it
//      does not have. Its `total` is 0 because no amount exists, so every string that would
//      render that 0 as a measurement — a range, an average, "0 effective" — is replaced by the
//      reason there is no number. This is rule 3's twin: rule 3 stops a number meaning more than
//      it does, rule 6 stops an ABSENCE being read as a number.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ABSORB_NOTE,
  NO_AMOUNT_MARK,
  UNSTATED_AMOUNT,
  UNSTATED_NOTE,
  hasAbsorbCounts,
  healPanel,
  healRange,
  healTotalTitle,
  healerAmount,
  healerStat,
  healerTitle,
  isAbsorbLane,
  isUnstatedLane,
  laneAmount,
  spellStat,
  spellTitle
} from '../src/renderer/src/features/combat/healRows'
import type {
  HealSourceView,
  HealSpellView,
  HealingView,
  MitigationView
} from '../src/shared/combat'

function lane(name: string, over: Partial<HealSpellView> = {}): HealSpellView {
  return {
    name,
    total: 0,
    pct: 0,
    count: 0,
    crits: 0,
    max: 0,
    overheal: 0,
    fullOverheal: 0,
    classification: 'restored',
    ...over
  }
}

function healer(id: string, over: Partial<HealSourceView> = {}): HealSourceView {
  return {
    id,
    name: id,
    kind: 'you',
    total: 0,
    absorbedTotal: 0,
    hps: 0,
    pct: 0,
    count: 0,
    unstatedCount: 0,
    crits: 0,
    critPct: 0,
    max: 0,
    overheal: 0,
    overhealPct: 0,
    fullOverheal: 0,
    spells: [],
    ...over
  }
}

const MIT: MitigationView = {
  runeTotal: 0,
  runeCount: 0,
  runeMax: 0,
  absorbedSwings: 0,
  absorbedDamageShields: 0
}

function healing(over: Partial<HealingView> = {}): HealingView {
  return {
    healers: [],
    total: 0,
    hps: 0,
    restoredTotal: 0,
    absorbedTotal: 0,
    overheal: 0,
    enemyHealers: [],
    enemyTotal: 0,
    mitigation: MIT,
    ...over
  }
}

/** A realistic self row: heals plus a rune lane, i.e. the MIXED case the model warns about. */
const SELF = healer('you', {
  name: 'You',
  total: 1400,
  absorbedTotal: 400,
  hps: 23.3,
  pct: 100,
  count: 4,
  crits: 1,
  critPct: 25,
  max: 480,
  min: 90,
  overheal: 260,
  overhealPct: 20.6,
  fullOverheal: 1,
  spells: [
    lane('Lay on Hands VI', { total: 700, pct: 100, count: 2, crits: 1, max: 480, min: 220, overheal: 260, fullOverheal: 1 }),
    lane('Rune', { total: 400, pct: 57, count: 2, max: 250, min: 150, classification: 'absorbed' }),
    lane('Center', { total: 300, pct: 43, count: 2, max: 210, min: 90 })
  ]
})

const ALLY = healer('heal:kaelth', { name: 'Kaelth', kind: 'other', total: 620, hps: 10.3, pct: 44, count: 3, max: 260, min: 150 })

// ── levels ────────────────────────────────────────────────────────────────────────────

test('level 1 ranks the healers and carries what rides under them', () => {
  const mit: MitigationView = { ...MIT, absorbedSwings: 7, absorbedDamageShields: 2 }
  const p = healPanel(
    healing({ healers: [SELF, ALLY], mitigation: mit, enemyTotal: 350, enemyHealers: [healer('heal:mob', { name: 'a healer', kind: 'enemy', total: 350 })] }),
    null
  )
  assert.equal(p.level, 1)
  if (p.level !== 1) return
  assert.deepEqual(p.healers.map((h) => h.id), ['you', 'heal:kaelth'])
  assert.equal(p.empty, false)
  assert.equal(p.mitigation, mit)
  // Counter-healing is carried SEPARATELY — it is an annotation on your damage, so it must
  // never be reachable as one of the ranked rows above.
  assert.equal(p.enemy.total, 350)
  assert.deepEqual(p.healers.map((h) => h.kind).includes('enemy'), false)
})

test('EVERY healer is ranked — no surface caps this list any more', () => {
  // The overlay used to pass a 5-or-10 row budget and cap the level-1 list; owner feedback
  // 2026-08-05 retired it (the overlay's content pane scrolls instead), so the builder has no
  // limit to take and both healing surfaces see the same rows.
  const many = healing({ healers: [SELF, ALLY, healer('heal:c'), healer('heal:d')] })
  const panel = healPanel(many, null)
  assert.equal(panel.level === 1 && panel.healers.length, 4)
})

test('level 2 is ONE healer’s flat lane list — and there is no level 3', () => {
  const p = healPanel(healing({ healers: [SELF, ALLY] }), 'you')
  assert.equal(p.level, 2)
  if (p.level !== 2) return
  assert.equal(p.subject.id, 'you')
  // The lanes are the model's own list, verbatim: heal lanes and the absorption lane together,
  // ONE flat ranking. A grouping level here is exactly what hid the damage drill-down.
  assert.deepEqual(p.rows.map((r) => r.name), ['Lay on Hands VI', 'Rune', 'Center'])
  // The bottom of the model. Nothing in a lane can be drilled further, so nothing here offers it.
  for (const r of p.rows) {
    assert.equal('children' in r, false, `${r.name} grew a child list the log cannot support`)
  }
})

test('a stale drill renders level 1, and says nothing about clearing the stored value', () => {
  // A healer from a previous fight. The caller's persisted id is not this function's business —
  // it takes one in and hands back a level, exactly like petRows.meterPanel.
  const p = healPanel(healing({ healers: [ALLY] }), 'heal:someone-who-left')
  assert.equal(p.level, 1)
  assert.equal(p.level === 1 && p.empty, false)
})

test('a segment with no healing model at all is a quiet level 1, never a throw', () => {
  const p = healPanel(undefined, 'you')
  assert.equal(p.level, 1)
  if (p.level !== 1) return
  assert.deepEqual(p.healers, [])
  assert.equal(p.empty, true)
  assert.equal(p.mitigation, null)
  assert.equal(p.enemy.total, 0)
})

test('nothing to rank is EMPTY, not zeroed — and the count-only families still speak', () => {
  const mit: MitigationView = { ...MIT, absorbedSwings: 3 }
  const p = healPanel(healing({ mitigation: mit }), null)
  assert.equal(p.level === 1 && p.empty, true)
  assert.equal(p.level === 1 && p.mitigation, mit)
  assert.equal(hasAbsorbCounts(mit), true)
  // …and a mitigation block with nothing in it must not draw a line about nothing.
  assert.equal(hasAbsorbCounts(MIT), false)
  assert.equal(hasAbsorbCounts(null), false)
})

// ── the words (they are part of the shared seam, not decoration) ───────────────────────

test('absorption is labeled, never restored: no overheal is invented for a rune', () => {
  const rune = lane('Rune', { total: 400, count: 2, max: 250, min: 150, classification: 'absorbed' })
  assert.equal(isAbsorbLane(rune), true)
  const stat = spellStat(rune)
  assert.match(stat, /granted/, 'the absorption lane must say what the number IS')
  assert.doesNotMatch(stat, /over\b/, 'a rune reported an overheal the log never records')
  // The caveat travels with the number, on hover, as one line — never as a methodology caption.
  assert.match(spellTitle(rune), new RegExp(ABSORB_NOTE.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('a MIXED healer describes its RESTORED half and calls the absorbed share out separately', () => {
  const stat = healerStat(SELF)
  assert.match(stat, /4x/, 'the heal COUNT is heal lines only')
  assert.match(stat, /absorbed/, 'the absorbed share must be named, not averaged in')
  const title = healerTitle(SELF)
  // 1400 total − 400 absorbed = 1000 restored, printed k-scaled by the one shared formatter.
  assert.match(title, /1.0k restored/)
  assert.match(title, /4 heals/)
  assert.match(title, /overheal/)
})

test('a healer with no overheal recorded says so, rather than printing 0%', () => {
  assert.match(healerTitle(ALLY), /no overheal recorded/)
  assert.doesNotMatch(healerStat(ALLY), /over\b/)
})

test('a range collapses when every tick was the same size', () => {
  assert.equal(healRange(150, 250), '150 - 250')
  assert.equal(healRange(250, 250), '250')
  assert.equal(healRange(undefined, 0), '0')
})

test('the headline title states the restored/absorbed split only when there is one', () => {
  const mixed = healTotalTitle(healing({ total: 1400, restoredTotal: 1000, absorbedTotal: 400 }))
  assert.match(mixed, /1.0k restored/)
  assert.match(mixed, /400 absorbed/)
  const pure = healTotalTitle(healing({ total: 900, restoredTotal: 900 }))
  assert.match(pure, /900 healing restored/)
  assert.doesNotMatch(pure, /absorbed/)
  assert.equal(healTotalTitle(undefined), '')
})

test('a lane the log named no spell for is LABELED, never folded into a real spell', () => {
  assert.match(spellTitle(lane('Unspecified', { total: 12, count: 3, max: 5 })), /the log named no spell/)
})

// ── the UNSTATED lane (JOS-86 — Mend) ──────────────────────────────────────────────────
//
// The whole line is `You mend your wounds and heal some damage.` Hit points went back on the
// bar and the game will not say how many, so the lane's 0 is the ABSENCE of a measurement. Every
// assertion below exists to stop that 0 being rendered as one.

/** The lane the model builds for Mend: a count, and every size field at its empty value. */
const MEND = lane('Mend', { total: 0, count: 3, max: 0, classification: 'unstated' })

test('an unstated lane prints its COUNT and nothing else — never a 0', () => {
  assert.equal(isUnstatedLane(MEND), true)
  assert.equal(isAbsorbLane(MEND), false, 'unstated and absorbed are different claims')
  const stat = spellStat(MEND)
  assert.match(stat, /3x/, 'the count is the one real figure the lane has')
  // JOS-106: the REASON is no longer repeated here. It rides the `·no amount` tag the panel and
  // the overlay render immediately to the left of this string, and saying it twice on one row is
  // what made the row read like an error message.
  assert.doesNotMatch(stat, new RegExp(UNSTATED_AMOUNT), 'the tag is said once per row, not twice')
  // `healRange(undefined, 0)` is the string '0' — the exact rendering this lane must not produce,
  // because "Mend · 0" reads as a heal that restored nothing.
  assert.doesNotMatch(stat, /\b0\b/, 'an unstated lane printed a 0 as though it were an amount')
  assert.doesNotMatch(stat, /over\b/, 'an unstated heal cannot have an overheal')
  assert.doesNotMatch(stat, /granted/, 'an unstated heal is not absorption')
})

test('the lane tag says what the LOG did, in words a player does not file as a bug', () => {
  // JOS-106, from report 01KZGFH4QDTVG7XNW4G24TZYR4: 'unvalued' and 'amount not stated' both
  // describe OUR bookkeeping, and a v0.12.0 user read the by-design label as a defect within a
  // day. The replacement is pinned by shape, not just by value, so a future edit cannot drift
  // back toward jargon without this failing.
  assert.equal(UNSTATED_AMOUNT, 'no amount')
  assert.doesNotMatch(UNSTATED_AMOUNT, /unvalued|unstated|not stated/, 'the jargon came back')
  assert.ok(UNSTATED_AMOUNT.length <= 16, 'the tag sits inline beside a lane name; keep it short')
  // One source for all three surfaces: the lane tag, the healer row's stat run, the hover title.
  assert.match(healerStat(healer('you', { name: 'You', unstatedCount: 2, spells: [MEND] })), new RegExp(UNSTATED_AMOUNT))
  assert.match(spellTitle(MEND), new RegExp(UNSTATED_AMOUNT))
})

test('an unstated lane derives NOTHING — no average, no range, no "0 effective"', () => {
  const title = spellTitle(MEND)
  assert.match(title, /Mend/)
  assert.match(title, /used 3x/)
  assert.match(title, new RegExp(UNSTATED_NOTE.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(title, /avg/, 'an average over a number that does not exist')
  assert.doesNotMatch(title, /effective/, 'an unstated lane claimed an effective amount')
  assert.doesNotMatch(title, /range|always/, 'an unstated lane claimed a size range')
  assert.doesNotMatch(title, /overheal/, 'an unstated lane claimed an overheal')
})

test('an unvalued heal is counted BESIDE the row stats, never inside their denominator', () => {
  // A row whose only sustain was Mend: without `unstatedCount` this reads as a bare name with
  // nothing after it, which is how the meter looked in the report that opened JOS-86.
  const mendOnly = healer('you', { name: 'You', unstatedCount: 2, spells: [MEND] })
  // Asserted WHOLE, not by match: the bare `2x` this row must never print is a prefix of the
  // `2x no amount` it must, so only the exact string can tell the two apart.
  assert.equal(healerStat(mendOnly), '2x no amount')
  // …and the right end of the bar, which is the LAST place a 0 could still get through.
  assert.equal(healerAmount(mendOnly), NO_AMOUNT_MARK)
  assert.match(healerTitle(mendOnly), new RegExp(UNSTATED_NOTE.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  // …and on a MIXED row it never touches the figures beside it: SELF's 4 heals / 25% crit are
  // computed over VALUED lines only, and adding two Mends must not move either.
  const mixed = healer('you', { ...SELF, unstatedCount: 2 })
  const mixedStat = healerStat(mixed)
  assert.match(mixedStat, /4x/, 'the valued heal count moved when a Mend was added')
  assert.match(mixedStat, /25% crit/, 'the crit rate was diluted by a line that cannot crit')
  assert.match(mixedStat, /2x no amount/)
  // A row that DOES have valued sustain keeps printing it — the mark is for rows that have none.
  assert.match(healerAmount(mixed), /1.4k/)
})

test('the bar’s right end shows a MARK, not a 0, where the log printed no number', () => {
  assert.equal(laneAmount(MEND), NO_AMOUNT_MARK)
  assert.notEqual(NO_AMOUNT_MARK, '0')
  // Every other lane is unaffected — including a genuinely 0-total RESTORED lane (a heal that
  // landed entirely on a full health bar), which really did measure zero and must still say so.
  assert.equal(laneAmount(lane('Rune', { total: 400, classification: 'absorbed' })), '400')
  assert.equal(laneAmount(lane('Healing', { total: 0, count: 2, classification: 'restored' })), '0')
})

// ── the one-builder pin ────────────────────────────────────────────────────────────────

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('NO SECOND BUILDER: both healing surfaces call healPanel and neither re-folds the model', () => {
  const surfaces = {
    'the Combat tab': src('../src/renderer/src/features/combat/HealPanel.tsx'),
    'the floating heal overlay': src('../src/renderer/src/overlay/healBars.tsx')
  }
  for (const [who, text] of Object.entries(surfaces)) {
    assert.match(text, /\bhealPanel\s*\(/, `${who} does not call the shared heal builder`)
    // `healing.healers` is the raw model list — reaching for it here is exactly the seam that
    // would let the two surfaces disagree about levels, ranking or the stale-drill rule again.
    assert.doesNotMatch(text, /healing[?]?\.healers/, `${who} reaches past healPanel to the model`)
    assert.doesNotMatch(text, /\.spells\b/, `${who} builds its own lane list again`)
  }
})

test('NO SECOND PHRASING: neither surface re-implements the honesty sentences', () => {
  const surfaces = {
    'the Combat tab': src('../src/renderer/src/features/combat/HealPanel.tsx'),
    'the floating heal overlay': src('../src/renderer/src/overlay/healBars.tsx'),
    'the heal overlay chrome': src('../src/renderer/src/overlay/HealMeter.tsx'),
    'the panel header': src('../src/renderer/src/features/combat/SegmentHeader.tsx')
  }
  for (const [who, text] of Object.entries(surfaces)) {
    // The SENTENCE, not the phrase: a file header may name the caveat in prose, but no surface
    // may carry a second copy of the string the user actually reads.
    assert.doesNotMatch(text, /The log records absorption GRANTED/, `${who} restates the absorption caveat`)
    assert.doesNotMatch(text, /ABSORB_NOTEs*=/, `${who} defines its own absorption caveat`)
    // `of raw)` is the printed overheal phrasing; a file header may DISCUSS overheal in prose.
    assert.doesNotMatch(text, /of raw\)/, `${who} formats an overheal figure of its own`)
    assert.doesNotMatch(text, /Math\.round\(\s*\(?\s*[a-z]\.(overheal|crits)/i, `${who} recomputes a heal rate`)
  }
})
