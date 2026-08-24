// THE MOTE-RANK DAMAGE FIT (JOS-447) — the log measurements the rule was fitted to, kept as
// fixtures so the fit can be re-argued rather than trusted.
//
// ── THE METHOD, NAMED ─────────────────────────────────────────────────────────────────────────
//
// Source: the owner's own combat log, `eqlog_Primitive_freeport.txt`, 2,406,300 lines covering
// 2026-07-19 to 2026-08-23. Mined by a throwaway `scripts/_mineSpellRanks.mts` (deleted with the
// ticket, per the repo's diagnose-then-delete rule), which:
//
//   1. streamed the file IN ORDER, tracking the character level off
//      `You have gained a level! Welcome to level N!` — 193 of them over an 11..50 span, because
//      the loadout system re-levels, so LEVEL is part of every bucket key and not a constant;
//   2. tracked the rank of the LAST CAST of each spell line — `You begin casting <Name> VIII.` puts
//      the next hit at rank 8 and an UNSUFFIXED cast line puts it at base. Attribution is the cast
//      and never the merge: the owner merged a `Discordant Mind II` on 2026-07-30 and went on
//      casting the base for a week, and a merge-attributed miner reads that as "rank II does
//      nothing";
//   3. bucketed every `You hit X for N points of <type> damage by <Spell>.` by
//      (spell line, rank, level), keeping `(Critical)` hits apart, and kept the MAXIMUM. Partial
//      resists only ever subtract, so the maximum of a well-sampled bucket is the unresisted hit.
//
// ── WHY THE FIT IS ON RATIOS ──────────────────────────────────────────────────────────────────
//
// A logged hit is not a base figure: the owner's worn gear multiplies it, and the factor MOVES.
// Measured on BASE-RANK casts against the client's own `|base| + step x level` capped at `|max|`
// (spells_us.txt effect-0 slot), it is ~1.017 in the July windows and ~1.2216 in the August ones —
// Chaos Flux 178/175 and Anarchy 280/275 on 2026-07-29, against Shock of Lightning, Lightning Bolt,
// Flame Shock, Spirit Tap and base-rank Garrison's all reading 1.219..1.222 on 2026-08-06 and
// 2026-08-21. This app models none of that and says so (spellMetrics.ts: no crits, focus, AA,
// spell-damage bonus or resist).
//
// So the rule is read off the RATIO between two ranks of ONE spell in windows whose worn factor is
// the same, where the factor cancels. That is what `RANK_PAIRS` below is.
//
// ── AND WHAT IT OVERTURNED ────────────────────────────────────────────────────────────────────
//
// The ticket's hypothesis was the item engine's damage rule — ten percent a rank. The pairs put the
// rank-VIII multiplier at 1.4787, which is `1 + 8 x 0.06`, and every one of the six is the FLOOR of
// that product rather than the ceiling. Ten percent is not close: it predicts 599 or 600 for the
// owner's Garrison's where the fit predicts 492, and the 600 he reads in his own log is
// `floor(492 x 1.2216)` — the fitted figure wearing the same worn factor his base-rank casts wear.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SPELL_DAMAGE_RANK_PERCENT,
  SPELL_MAX_RANK,
  effectiveSpellRank,
  normalizeSpellRank,
  scaleSpellDamage,
  scaleSpellHeal
} from '../src/shared/spellScale'

// ---- the mined table -------------------------------------------------------------------------

/**
 * THE FIT. Six same-level pairs of ONE spell across two windows with the same worn factor, plus a
 * second spell at a second rank. `low`/`high` are maximum non-critical hits; `n` counts the
 * non-critical hits in the bucket.
 *
 * Garrison's Mighty Mana Shock: cast at BASE on 2026-08-06 while a fresh loadout climbed 19..24,
 * and at VIII on 2026-08-21 while another climbed the same levels. Both windows read 1.219..1.222
 * of the client's own magnitude on base-rank spells, so the worn factor cancels in the ratio.
 *
 * Discordant Mind: base on 2026-07-30 at level 43 (472 over 47 hits, 1.2196 of the client's 387)
 * and II from 2026-08-01 (528 over 272 hits) — the same worn factor, two ranks apart.
 */
const RANK_PAIRS: readonly {
  spell: string
  level: number
  lowRank: number
  low: number
  lowN: number
  highRank: number
  high: number
  highN: number
}[] = [
  { spell: "Garrison's Mighty Mana Shock", level: 19, lowRank: 0, low: 337, lowN: 31, highRank: 8, high: 498, highN: 55 },
  { spell: "Garrison's Mighty Mana Shock", level: 20, lowRank: 0, low: 342, lowN: 50, highRank: 8, high: 506, highN: 50 },
  { spell: "Garrison's Mighty Mana Shock", level: 21, lowRank: 0, low: 346, lowN: 34, highRank: 8, high: 512, highN: 66 },
  { spell: "Garrison's Mighty Mana Shock", level: 22, lowRank: 0, low: 351, lowN: 54, highRank: 8, high: 519, highN: 71 },
  { spell: "Garrison's Mighty Mana Shock", level: 23, lowRank: 0, low: 356, lowN: 31, highRank: 8, high: 526, highN: 72 },
  { spell: "Garrison's Mighty Mana Shock", level: 24, lowRank: 0, low: 361, lowN: 75, highRank: 8, high: 534, highN: 57 },
  { spell: 'Discordant Mind', level: 43, lowRank: 0, low: 472, lowN: 47, highRank: 2, high: 528, highN: 272 }
]

/**
 * The rounding candidates the fit had to choose between. `floor` is `scaleSpellDamage`'s; the other
 * two are the two the ticket named, kept here so the test states what was rejected and by how much.
 */
const ROUNDINGS: readonly { name: string; f: (x: number) => number }[] = [
  { name: 'floor', f: Math.floor },
  { name: 'ceil', f: Math.ceil },
  { name: 'round', f: Math.round }
]

/** `amount + f(amount * pct * rank / 100)` for an arbitrary rate and rounding — the shape under test. */
function candidate(amount: number, rank: number, pct: number, f: (x: number) => number): number {
  return amount + f((amount * pct * rank) / 100)
}

// ---- the rule --------------------------------------------------------------------------------

test('the fitted rate is SIX percent a rank, and the log rejects every other whole rate', () => {
  // Every whole percentage from 1 to 15, scored on how many of the seven pairs it reproduces
  // exactly under the best rounding available to it. Only one rate reproduces them all.
  const winners: number[] = []
  for (let pct = 1; pct <= 15; pct++) {
    const best = Math.max(
      ...ROUNDINGS.map(
        (r) => RANK_PAIRS.filter((p) => candidate(p.low, p.highRank, pct, r.f) === p.high).length
      )
    )
    if (best === RANK_PAIRS.length) winners.push(pct)
  }
  assert.deepEqual(winners, [SPELL_DAMAGE_RANK_PERCENT], `whole rates that fit all seven pairs: ${winners.join(',')}`)
})

test('the rounding is a FLOOR, and it is six for six against the ceiling`s zero', () => {
  const score = (f: (x: number) => number): number =>
    RANK_PAIRS.filter((p) => candidate(p.low, p.highRank, SPELL_DAMAGE_RANK_PERCENT, f) === p.high).length
  assert.equal(score(Math.floor), RANK_PAIRS.length, 'floor reproduces every mined pair')
  assert.equal(score(Math.ceil), 0, 'the ceiling reproduces none of them')
  // Not a tie broken by taste: the ceiling is one point high on every pair whose product is
  // fractional, which is all seven.
  for (const p of RANK_PAIRS) {
    const ceil = candidate(p.low, p.highRank, SPELL_DAMAGE_RANK_PERCENT, Math.ceil)
    assert.equal(ceil, p.high + 1, `${p.spell} L${String(p.level)}`)
  }
})

test('scaleSpellDamage reproduces the mined table', () => {
  for (const p of RANK_PAIRS) {
    assert.equal(scaleSpellDamage(p.low, p.lowRank), p.low, `${p.spell} at base`)
    assert.equal(
      scaleSpellDamage(p.low, p.highRank),
      p.high,
      `${p.spell} L${String(p.level)} +${String(p.highRank)}: ${String(p.highN)} hits`
    )
  }
})

/**
 * THE OWNER'S OWN SPELL, END TO END — and the one number a reader may be surprised by.
 *
 * `Garrison's Mighty Mana Shock` caps at 333 damage from level 34 (the wiki's ramp endpoint and the
 * client's `max`, which agree). At the VIII the owner holds, this engine says 492.
 *
 * HIS LOG SAYS 600, and the two are the same claim. Over 1,280 non-critical hits across nine
 * separate level buckets on 2026-08-22 (levels 34..42, 150/261/104/156/149/112/110/170/41 hits) the
 * maximum is exactly 600 every single time, with 596, 592, 586 and 581 below it as partial resists.
 * The worn factor is bounded from the base-rank casts themselves: the six 2026-08-06 buckets pin it
 * to [1.22143, 1.22183) (`floor(280g) = 342` binds from below, `floor(284g) = 346` from above, over
 * client bases of 280 and 284) and Spirit Tap in the 2026-08-21/22 sessions agrees at
 * [1.21905, 1.22381) over its own base of 210. Anywhere in
 * that band `floor(492 x g)` is 600, and 493 — the ceiling — would need g below 1.21907, which the
 * base-rank casts exclude. The ten-percent rule would have printed 599 and looked right by accident.
 */
test('acceptance: the owner`s Garrisons at VIII is 492 base damage, which is his logged 600 less his gear', () => {
  const CAP = 333
  const WORN = 1.2215
  const LOGGED_MAX = 600
  assert.equal(scaleSpellDamage(CAP, 8), 492)
  assert.equal(Math.floor(scaleSpellDamage(CAP, 8) * WORN), LOGGED_MAX, 'the fit, wearing his gear')
  // The CEILING would need a worn factor the base-rank casts of the same spell rule out.
  assert.equal(Math.floor(493 * WORN), 602, 'the ceiling overshoots the logged maximum by two')
  // The rejected hypothesis, kept so the difference is visible rather than remembered.
  assert.equal(CAP + Math.floor((CAP * 8) / 10), 599, 'the item engine`s damage rule at +8')
  assert.notEqual(Math.floor(599 * WORN), LOGGED_MAX, 'which does not reproduce the log at all')
})

// ---- the healing measurement, SHIPPED one merge after the damage rule -------------------------

/**
 * THE HEALING RATE IS THREE PERCENT, HALF THE DAMAGE RATE — measured the same way, over
 * `You healed <target> for N hit points by <Spell>.` lines. Recorded here first as evidence-only
 * (a second stat class is a second modelling decision), then shipped on the owner's ruling of
 * 2026-08-23 ("we are fine with healing estimates for now") as `scaleSpellHeal`.
 *
 * The measurement, so losing it never means mining 197 MB again: Slugs Healing at level 50 reads
 * 204 at base and 222 / 228 / 235 / 241 at III / IV / V / VI (435, 380, 8 and 645 hits), and
 * Superior Healing at level 50 reads 892 / 943 / 968 at II / IV / V (754, 330 and 50 hits) off a
 * base of 842. Heals are not resisted, so these need no worn correction at all beyond the
 * target's missing hitpoints capping a heal from above.
 */
const HEAL_ROWS: readonly { spell: string; rank: number; observed: number; base: number }[] = [
  { spell: 'Slugs Healing', rank: 3, observed: 222, base: 204 },
  { spell: 'Slugs Healing', rank: 4, observed: 228, base: 204 },
  { spell: 'Superior Healing', rank: 2, observed: 892, base: 842 },
  { spell: 'Superior Healing', rank: 4, observed: 943, base: 842 },
  { spell: 'Superior Healing', rank: 5, observed: 968, base: 842 }
]

test('the measured HEALING rate is three percent a rank, and scaleSpellHeal applies exactly it', () => {
  for (const r of HEAL_ROWS) {
    assert.equal(candidate(r.base, r.rank, 3, Math.floor), r.observed, `${r.spell} +${String(r.rank)}`)
    assert.equal(scaleSpellHeal(r.base, r.rank), r.observed, `${r.spell} +${String(r.rank)} via the engine`)
    // The damage rate would be twice as far out, which is why one rule for both would be wrong.
    assert.notEqual(candidate(r.base, r.rank, SPELL_DAMAGE_RANK_PERCENT, Math.floor), r.observed, r.spell)
  }
  // The same guards the damage rule carries: base at rank nothing, nothing out of nothing.
  assert.equal(scaleSpellHeal(842, 1), 842)
  assert.equal(scaleSpellHeal(0, 5), 0)
})

// ---- the plain arithmetic --------------------------------------------------------------------

test('a rank of nothing, one, or nonsense is the base spell', () => {
  for (const r of [undefined, null, 0, 1, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(normalizeSpellRank(r), 0, String(r))
    assert.equal(scaleSpellDamage(333, r), 333, String(r))
  }
  // ONE IS BASE ON PURPOSE: the observed-rank fold cannot tell `Clarity I` from `Clarity`, and the
  // chip beside it already refuses to draw at rank 1 for the same reason. Erring downward.
  assert.equal(scaleSpellDamage(333, 1), 333)
  assert.equal(scaleSpellDamage(333, 2), 372)
})

test('the ladder stops at ten, and a fraction of a rank is not a rank', () => {
  assert.equal(normalizeSpellRank(11), SPELL_MAX_RANK)
  assert.equal(normalizeSpellRank(99), SPELL_MAX_RANK)
  assert.equal(normalizeSpellRank(4.9), 4)
  assert.equal(scaleSpellDamage(100, SPELL_MAX_RANK), 160)
})

test('nothing is scaled up out of nothing', () => {
  assert.equal(scaleSpellDamage(0, 8), 0)
  assert.equal(scaleSpellDamage(-5, 8), -5)
  // Sub-integer magnitudes survive the multiply-before-divide: 8.5 at +2 is 8.5 + floor(1.02).
  assert.equal(scaleSpellDamage(8.5, 2), 9.5)
})

test('the effective rank is the HIGHER of observed and simulated, never the slider alone', () => {
  assert.equal(effectiveSpellRank(8, 4), 8, 'a slider below what you own must not pull you down')
  assert.equal(effectiveSpellRank(2, 6), 6)
  assert.equal(effectiveSpellRank(undefined, 5), 5)
  assert.equal(effectiveSpellRank(7, undefined), 7)
  assert.equal(effectiveSpellRank(null, null), 0)
  assert.equal(effectiveSpellRank(1, 0), 0, 'rank 1 is base at both ends of the max')
})

test('the rate is stated once and the two constants are the ones the header argues for', () => {
  assert.equal(SPELL_DAMAGE_RANK_PERCENT, 6)
  assert.equal(SPELL_MAX_RANK, 10)
})
