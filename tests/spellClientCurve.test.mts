// JOS-451 — THE CLIENT CORRECTS THE PAGE, not only fills in for it.
//
// A SIBLING OF tests/spellMetrics.test.mts, split off it because that file sits at the 400-line
// ceiling and because this is a different claim: R9-R13 over there pin the FALLBACK (the page says
// nothing at all, the client answers), and R17-R20 here pin the OVERRIDE (the page says something
// and one of its numbers is wrong). The end-to-end delivery half — the unlock row, the card, what
// travels across the wire — is C8-C10 in tests/clientHpFallback.test.mts.
//
// THE REPORT: `Ethereal Cleansing` reads `Increase Hitpoints by 10 per tick` on the wiki and
// `1|100|10|0|103|100` in the owner's client — base 10, two more a level, capped at 100 — so a
// paladin's only heal-over-time drew 40 total where the game heals 400.
//
// Both client rows below are transcribed VERBATIM from the owner's install on 2026-08-23, and the
// slot is EFFECT 100 (the heal-over-time spelling), which is why the effect-0-only reader could not
// even see it.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clientHpMagnitudeAt,
  resolveSpellMana,
  spellMetricsAt,
  type ClientHpFacts,
  type SpellMetrics,
  type SpellMetricsInput
} from '../src/shared/spellMetrics.ts'

/** The figures for a spell that MUST produce some. */
function metrics(spell: SpellMetricsInput, level: number): SpellMetrics {
  const out = spellMetricsAt(spell, level)
  assert.ok(out, 'expected figures')
  return out
}

/** Ethereal Cleansing, id 3683: `1|100|10|0|103|100`, duration formula 3 capped at 4 ticks. */
const ETHEREAL_CLIENT: ClientHpFacts = {
  hp: [{ base: 10, max: 100, calc: 103, perTick: true }],
  hpDuration: { formula: 3, value: 4 },
  recastMs: 30_000,
  mana: 150
}
/** And what the wiki states for it: one flat line, 24 seconds, 150 mana. */
const ETHEREAL_WIKI: SpellMetricsInput = {
  effects: ['Increase Hitpoints by 10 per tick'],
  mana: 150,
  castTimeMs: 1500,
  recastMs: 30_000,
  durationMs: 24_000
}

test('R17 THE TICKET: a flat wiki line over a curved client slot reads the CURVE', () => {
  // Before: 10 a tick x 4 ticks = 40, and 0.3 heal per mana on a 150-mana spell.
  assert.deepEqual(metrics(ETHEREAL_WIKI, 44), {
    heal: 40,
    healPerMana: 0.3,
    hps: 1.3,
    hot: true,
    overSec: 24,
    recastMs: 30_000
  })
  // After, at the level a paladin gains it: 10 + 2x44 = 98 a tick, four ticks, 392.
  assert.deepEqual(spellMetricsAt(ETHEREAL_WIKI, 44, ETHEREAL_CLIENT), {
    heal: 392,
    healPerMana: 2.6,
    hps: 12.4,
    hot: true,
    overSec: 24,
    recastMs: 30_000,
    clientCurve: true
  })
  // …and at 50 the cap binds, which is the acceptance the ticket names: about 400.
  assert.equal(spellMetricsAt(ETHEREAL_WIKI, 50, ETHEREAL_CLIENT)?.heal, 400)
  assert.equal(spellMetricsAt(ETHEREAL_WIKI, 60, ETHEREAL_CLIENT)?.heal, 400, 'capped at 100 a tick')
  // THE DURATION IS STILL THE PAGE'S. Only the magnitude moves; the four ticks are `durationMs`.
  assert.equal(spellMetricsAt(ETHEREAL_WIKI, 50, ETHEREAL_CLIENT)?.overSec, 24)
})

test('R18 the rule is a SHAPE, and every part of it is load-bearing', () => {
  const fire = (
    wiki: string,
    slot: { base: number; max: number; calc: number; perTick: boolean }
  ): boolean =>
    spellMetricsAt({ effects: [wiki], mana: 100, castTimeMs: 1000, durationMs: 24_000 }, 44, {
      hp: [slot]
    })?.clientCurve === true

  const curve = { base: 10, max: 100, calc: 103, perTick: true }
  assert.equal(fire('Increase Hitpoints by 10 per tick', curve), true)

  // A RAMP is the wiki stating the curve properly, and it always wins.
  assert.equal(fire('Increase Hitpoints by 10 (L44) to 20 (L50) per tick', curve), false)
  // A RANGE is not a flat line either.
  assert.equal(fire('Increase Hitpoints between 10 and 10 per tick', curve), false)
  // THE BASE HAS TO MATCH. A client slot stating a different base is a DISAGREEMENT, and the
  // standing law leaves those to the wiki (354 flat lines in the catalog are in that state).
  assert.equal(fire('Increase Hitpoints by 11 per tick', curve), false)
  // THE DIRECTION HAS TO MATCH: a heal is not a client damage slot that happens to share a number.
  assert.equal(fire('Decrease Hitpoints by 10 per tick', curve), false)
  // AND SO DOES THE PER-TICK VERDICT.
  assert.equal(fire('Increase Hitpoints by 10', curve), false)
  // A FLAT CLIENT SLOT IS NOT A CURVE, so nothing is overridden and the wiki's number stands.
  assert.equal(fire('Increase Hitpoints by 10 per tick', { ...curve, calc: 100 }), false)
  // NEITHER IS A CAP ON ITS OWN — and a cap equal to the base states the wiki's number back, so
  // the flag is not raised for a reading that moved nothing (the druid `... Heal` family).
  assert.equal(fire('Increase Hitpoints by 10 per tick', { ...curve, max: 10 }), false)
  // A `calc` THIS READER CANNOT READ is not a curve it may claim to know (Denon's Desperate
  // Dirge's 144, Force of Nature's 139).
  assert.equal(fire('Increase Hitpoints by 10 per tick', { ...curve, calc: 144 }), false)
  // TWO CANDIDATE SLOTS MEAN NOTHING STATES WHICH ONE the sentence is about.
  const two = spellMetricsAt(
    {
      effects: ['Increase Hitpoints by 10 per tick'],
      mana: 100,
      castTimeMs: 1000,
      durationMs: 24_000
    },
    44,
    { hp: [curve, { base: 10, max: 0, calc: 102, perTick: true }] }
  )
  assert.equal(two?.clientCurve, undefined)
  assert.equal(two?.heal, 40, 'and the wiki number stands')
})

test('R19 the calc codes JOS-451 measured off the catalog ramps', () => {
  // calc < 100: THE STEP IS THE CODE ITSELF. `Greater Healing` is calc 7, base 140, cap 350, and
  // its page states `by 280 (L20) to 350 (L30)`.
  const greater = { base: 140, max: 350, calc: 7, perTick: false }
  assert.equal(clientHpMagnitudeAt(greater, 20).amount, 280)
  assert.equal(clientHpMagnitudeAt(greater, 30).amount, 350)
  assert.equal(clientHpMagnitudeAt(greater, 60).amount, 350, 'capped')
  assert.equal(clientHpMagnitudeAt(greater, 20).formulaUnknown, false)
  // calc 109 is a quarter a level. `Brilliance` (base 1, cap 14) states `12 (L44) to 14 (L52)`.
  assert.equal(clientHpMagnitudeAt({ base: 1, max: 14, calc: 109, perTick: false }, 44).amount, 12)
  assert.equal(clientHpMagnitudeAt({ base: 1, max: 14, calc: 109, perTick: false }, 52).amount, 14)
  // calc 110 is a fifth. `Psalm of Warmth` (base 1) states `6 (L25) to 13 (L60)`.
  assert.equal(clientHpMagnitudeAt({ base: 1, max: 0, calc: 110, perTick: false }, 25).amount, 6)
  assert.equal(clientHpMagnitudeAt({ base: 1, max: 0, calc: 110, perTick: false }, 60).amount, 13)
  // calc 119 is an eighth. `Cassindra's Chorus of Clarity` (base 1, cap 7) states `5 (L32) to 7 (L48)`.
  assert.equal(clientHpMagnitudeAt({ base: 1, max: 7, calc: 119, perTick: false }, 32).amount, 5)
  assert.equal(clientHpMagnitudeAt({ base: 1, max: 7, calc: 119, perTick: false }, 48).amount, 7)
  // calc 121 is a third. `Echinacea Infusion` (base 5, cap 10) states `5 (L1) to 10 (L15)`.
  assert.equal(clientHpMagnitudeAt({ base: 5, max: 10, calc: 121, perTick: false }, 1).amount, 5)
  assert.equal(clientHpMagnitudeAt({ base: 5, max: 10, calc: 121, perTick: false }, 15).amount, 10)
  // AND EVERY CODE STILL WITHOUT AN INSTRUMENT ANSWERS WITH THE BASE AND SAYS SO.
  for (const calc of [123, 139, 144, 4005]) {
    assert.deepEqual(clientHpMagnitudeAt({ base: 60, max: 0, calc, perTick: false }, 50), {
      amount: 60,
      formulaUnknown: true
    })
  }
})

test('R20 the mana rule: the client answers a stated zero and nothing else', () => {
  // A page that states no mana at all, and a client row that does.
  assert.equal(resolveSpellMana(undefined, 245), 245)
  // A STATED ZERO is the page claiming the spell is free, and a spell the client charges for is not.
  assert.equal(resolveSpellMana(0, 65), 65)
  // TWO POSITIVE NUMBERS THAT DISAGREE go to the wiki - the standing law, and the client's column
  // disagrees with the page on 72 of the 1,234 catalog rows where both state one.
  assert.equal(resolveSpellMana(250, 334), 250)
  assert.equal(resolveSpellMana(150, 150), 150)
  // Neither source states one: the absence survives, and it is not a zero.
  assert.equal(resolveSpellMana(undefined, undefined), undefined)
  assert.equal(resolveSpellMana(0, 0), 0)
  assert.equal(resolveSpellMana(0, undefined), 0)

  // …and it reaches the figures. A free spell has no `dmg/mana` at all; the same spell with a
  // client-answered cost has one.
  const free: SpellMetricsInput = {
    effects: ['Decrease Hitpoints by 315'],
    mana: 0,
    castTimeMs: 3000
  }
  assert.equal(metrics(free, 43).damagePerMana, undefined)
  assert.equal(spellMetricsAt(free, 43, { mana: 800 })?.damagePerMana, 0.4)
  // A page that states its own cost is untouched by a client row that disagrees.
  assert.equal(spellMetricsAt({ ...free, mana: 400 }, 43, { mana: 800 })?.damagePerMana, 0.8)
})
