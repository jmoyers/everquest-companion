// THE FULL-DAMAGE REFERENCE, against the owner's own committed rows (JOS-385 defect 2, refined by
// JOS-387).
//
// TWO CLAIMS UNDER TEST, and the second was found by the first one's own guard.
//
//   1. The number a spell hits for is THE BASE OF ITS UPPER CLUSTER, never its maximum and no
//      longer merely its mode. Live spell-damage focus effects roll a random bonus per cast, so the
//      maximum is a lucky roll — and at the owner's own level 50 the focus is on, the base holds
//      6% of the histogram, and the mode rule declined to name a reference at all.
//   2. A SPELL THAT NEVER PRODUCES A PARTIAL is not a partial-capable spell. DoTs and procs land or
//      are refused; reading one as direct damage asks the fitter to explain zero partials beside a
//      75% resist rate, which no rc can do.
//
// HALF OF IT IS PINNED ON THE SHIPPED BASELINE, because that is real data with a known answer:
// Discordant Mind and Scorching Arrow are the two spells whose tiers and focus band the owner
// measured by hand, and the numbers below are his. The other half is synthetic, because a
// statistic's edges are easier to state than to find in a log.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BAND_MIN_SHARE,
  FOCUS_BAND_TOP,
  FULL_AT_LEAST,
  PARTIAL_FREE_AT,
  PARTIAL_FREE_MIN_HITS,
  clusterBase,
  damageKind,
  damageRefKey,
  fullDamageRefs,
  splitDamage
} from '../src/shared/resistDamage'
import type { ResistLedger, ResistRow, SpellResistInfo } from '../src/shared/resistTypes'

const PATH = join(import.meta.dirname, '..', 'src', 'main', 'data', 'resistBaseline.json')
const ROWS = (JSON.parse(readFileSync(PATH, 'utf8')) as ResistLedger).sources[0].rows
const REFS = fullDamageRefs(ROWS)

const refOf = (spell: string, level: number | null): number | undefined =>
  REFS.get(damageRefKey(spell, level))?.value

const NUKE: SpellResistInfo = { axis: 'magic', resistAdj: 0, castMs: 3000, targetType: 5, hpSlot: { base: -110, max: 394, calc: 103 } }
const PROC: SpellResistInfo = { axis: 'magic', resistAdj: -250, castMs: 0, targetType: 5 }

function row(spec: Partial<ResistRow> & Pick<ResistRow, 'spellKey'>): ResistRow {
  return {
    mobKey: 'a test mob',
    family: 'cast',
    casterKind: 'self',
    casterLevel: 50,
    mobLevel: 50,
    debuffs: '',
    rank: 0,
    overchannel: false,
    resist: 0,
    land: 0,
    dmg: {},
    firstTs: 0,
    lastTs: 0,
    ...spec
  }
}

test("Discordant Mind's full damage is 394 at every level that cast it, focus or no focus", () => {
  // 43 through 49 are the unfocused levels, where the base holds 78% to 93% of the histogram.
  // FIFTY IS THE ONE THAT MATTERS: the owner's damage focus spreads the same spell across 441-528
  // and leaves the base at 6%, which is exactly where the mode rule gave up and threw away the
  // three real princess partials with it. The upper-cluster rule reads it correctly.
  for (const level of [43, 44, 45, 46, 47, 48, 49, 50]) {
    assert.equal(refOf('discordant mind', level), 394, `level ${String(level)}`)
  }
})

test("Scorching Arrow's tiers are the game's own, and the caster level is what separates them", () => {
  // Three tiers in one log, and keying the reference by caster level is what keeps them apart. A
  // reference pooled over levels would call the level-46 tier a partial of the level-50 one.
  assert.equal(refOf('scorching arrow', 46), 214)
  assert.equal(refOf('scorching arrow', 47), 233)
  for (const level of [48, 49, 50]) {
    assert.equal(refOf('scorching arrow', level), 239, `level ${String(level)}`)
  }
})

test('THE ANCHOR IS THE TALLEST BAR OF ITS OWN BAND, which is what picks the base out of a focus', () => {
  // The ticket's first draft of this rule was "the largest v whose band [v, 1.35v] holds 60%", and
  // on Discordant Mind at 50 that answers 458 — a number the game never computes, because the focus
  // band is so much of that histogram that a window opened anywhere inside it still covers two
  // thirds. Requiring the anchor to be the most common value INSIDE its own band is the whole fix.
  const focused = new Map<number, number>([
    [394, 23],
    [441, 13],
    [449, 14],
    [458, 14],
    [502, 20],
    [519, 22],
    [528, 14]
  ])
  assert.equal(clusterBase(focused), 394)
  assert.equal(FOCUS_BAND_TOP, 1.35)
  assert.equal(BAND_MIN_SHARE, 0.6)
})

test('A FOCUSED HIT IS A FULL HIT, which is the whole defect', () => {
  // The princess's own numbers, as the owner read them off the log: three real partials and four
  // fulls, of which three were focused. The old rule took the largest value (524) as the reference
  // and called the other six partials.
  const princess = row({
    spellKey: 'discordant mind',
    dmg: { '80': 1, '165': 1, '168': 1, '453': 1, '471': 1, '476': 1, '524': 1 }
  })
  const split = splitDamage(princess, 394)
  assert.equal(split.total, 7)
  assert.equal(split.full, 4, '394 and everything above it, focus roll and all')
  assert.equal(split.partial, 3, '80, 165 and 168 - the only three that were actually reduced')

  // Against the OLD reference (the max) the same seven hits read as one full and six partials,
  // which is a mob resisting 86% of what it was hit by. That is the number the owner was shown.
  const naive = splitDamage(princess, 524)
  assert.equal(naive.full, 1)
  assert.equal(naive.partial, 6)
})

test('the full band starts just below the reference, and nothing else is in it', () => {
  assert.equal(FULL_AT_LEAST, 0.97)
  const r = row({ spellKey: 'test nuke', dmg: { '400': 1, '394': 1, '383': 1, '382': 1, '300': 1 } })
  const split = splitDamage(r, 394)
  // 400 (focused), 394 (base) and 383 (the rounding slack) are full; 382 is below the band.
  assert.equal(split.full, 3)
  assert.equal(split.partial, 2)
})

test('a histogram with no cluster names no reference at all', () => {
  // A proc's damage range: six values spread wide enough that no focus band covers 60% of them.
  const spread = row({ spellKey: 'test proc', dmg: { '100': 12, '160': 11, '220': 12, '300': 11, '400': 12, '540': 11 } })
  assert.equal(fullDamageRefs([spread]).get(damageRefKey('test proc', 50)), undefined)
  // …and a spell with no hitpoint slot in the client data is variable whatever its histogram says.
  assert.equal(
    damageKind(row({ spellKey: 'test proc', dmg: { '100': 99 } }), PROC, { value: 100, allOrNothing: false }),
    'ddVar'
  )
})

test('A DoT LANDS OR IS REFUSED: no partials anywhere means the hits are LANDINGS (JOS-387)', () => {
  // MEASURED, and it is the case that found the rule: a thunder spirit princess's magic is Choking,
  // 262 resists against 86 hits, every hit at exactly 20 and not one partial. Under direct damage
  // that is impossible — 25% full implies rc about 150, which implies half the casts should have
  // been silent partials and a quarter resisted. Under all-or-nothing it is an ordinary 75% resist
  // rate, and the pinned-fit guard stopped flagging the cell the moment this landed.
  assert.equal(PARTIAL_FREE_AT, 0.02)
  assert.equal(PARTIAL_FREE_MIN_HITS, 20)
  const choking = row({ spellKey: 'choking', resist: 262, dmg: { '20': 86 } })
  const ref = fullDamageRefs([choking]).get(damageRefKey('choking', 50))
  assert.deepEqual(ref, { value: 20, allOrNothing: true })
  assert.equal(damageKind(choking, NUKE, ref), 'aon')

  // A REAL NUKE IS UNTOUCHED. Its partials are 14% to 20% of its histogram on the owner's log,
  // nowhere near the line, so the ordinary three-outcome likelihood still applies.
  const nuke = row({ spellKey: 'test nuke', resist: 20, dmg: { '394': 60, '300': 8, '210': 6 } })
  const nukeRef = fullDamageRefs([nuke]).get(damageRefKey('test nuke', 50))
  assert.equal(nukeRef?.allOrNothing, false)
  assert.equal(damageKind(nuke, NUKE, nukeRef), 'ddFix')

  // AND A HANDFUL OF HITS CANNOT SAY. "No partials" off six casts is not a fact about the spell.
  const thin = row({ spellKey: 'test nuke', dmg: { '394': 6 } })
  assert.equal(fullDamageRefs([thin]).get(damageRefKey('test nuke', 50))?.allOrNothing, false)
})

test('the reference is POOLED OVER MOBS, so a four-hit cell inherits what the ledger knows', () => {
  // The argument for the scope, made in the units it matters in: one mob, four hits, no chance of
  // establishing anything on its own - and it does not have to, because the same nuke has hundreds
  // of hits elsewhere. Scoped per mob, the four hits below would name 300 as "full" and read the
  // other three as a mob eating three quarters of every cast.
  const many = row({ spellKey: 'test nuke', mobKey: 'a well known mob', dmg: { '394': 200, '300': 5 } })
  const few = row({ spellKey: 'test nuke', mobKey: 'a rare mob', dmg: { '300': 1, '250': 1, '200': 1, '150': 1 } })
  const pooled = fullDamageRefs([many, few])
  assert.equal(pooled.get(damageRefKey('test nuke', 50))?.value, 394)
  const split = splitDamage(few, pooled.get(damageRefKey('test nuke', 50))?.value)
  assert.equal(split.full, 0)
  assert.equal(split.partial, 4, 'every one of them really was reduced')
  // Alone, the same four hits spread too wide for any band to cover 60%.
  assert.equal(fullDamageRefs([few]).get(damageRefKey('test nuke', 50)), undefined)
})

test('the three ways a row is VARIABLE, which is the safe direction every time', () => {
  // Moved here from the estimator's own suite when the reference became a ledger-wide statistic:
  // this is a claim about reading a histogram, and that is this file's subject.
  const fixed = row({ spellKey: 'test nuke', dmg: { '150': 60, '120': 9, '90': 4 } })
  const fixedRef = fullDamageRefs([fixed]).get(damageRefKey('test nuke', 50))
  assert.equal(damageKind(fixed, NUKE, fixedRef), 'ddFix')
  // 1. No hitpoint slot in the client data: not a damage spell in the modelled sense.
  assert.equal(
    damageKind(row({ spellKey: 'test proc', dmg: { '392': 20, '388': 20 } }), PROC, { value: 392, allOrNothing: true }),
    'ddVar'
  )
  // 2. No reference (the case above this one).
  assert.equal(damageKind(fixed, NUKE, undefined), 'ddVar')
  // 3. The row gave up on its own histogram past MAX_DISTINCT_DAMAGE_VALUES, so there is nothing
  //    left to read partials out of.
  assert.equal(
    damageKind(row({ spellKey: 'test nuke', variable: true, land: 500 }), NUKE, { value: 150, allOrNothing: false }),
    'ddVar'
  )
})

test('a row with no damage at all splits into nothing, and never divides by a reference', () => {
  const aon = row({ spellKey: 'test hold', resist: 5, land: 5 })
  assert.deepEqual(splitDamage(aon, undefined), { total: 0, full: 0, partial: 0 })
  assert.deepEqual(splitDamage(aon, 394), { total: 0, full: 0, partial: 0 })
})
