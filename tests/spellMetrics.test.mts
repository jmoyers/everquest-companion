// JOS-391 — WHAT A SPELL IS WORTH, pinned shape by shape.
//
// THE CLAIM UNDER TEST: every hitpoint line the committed catalog prints can be read into a
// number at a stated level, and the arithmetic on top of those numbers (per mana, per second,
// ticks) is the one the Leveling rows draw.
//
// THE NINE SHAPES IN R1 ARE NOT A SAMPLE. They are the nine the ticket named, each of them lifted
// verbatim out of `src/main/data/spells.json` with the spell it came from written beside it — a
// constant, a two-point ramp, a per-tick constant, a per-tick ramp, a THREE-point non-monotonic
// ramp, and the four increase-side twins including the two families that count their own ticks.
// A re-scrape that changes one of these strings fails here by name rather than drifting a figure
// on screen by a factor of the tick count.
//
// R6 IS THE EXCLUSION HALF and it matters as much as the inclusions: a max-HP buff is not a heal,
// and `HP when cast` is the same magnitude written twice (Armor of Protection states 202→225 as
// both). Reading either would inflate every figure it touched.
//
// R7 sweeps the WHOLE committed catalog, which is what makes "measured" mean measured: no line
// this reader accepts may produce a NaN, a negative or an infinity, and the shapes it declines
// are counted so a re-scrape that introduces a new one is visible.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import spellsJson from '../src/main/data/spells.json' with { type: 'json' }
import type { SpellDbFile } from '../src/shared/types.ts'
import {
  clientDurationTicks,
  clientHpMagnitudeAt,
  parseHpLine,
  spellMetricsAt,
  spellMetricsParts,
  ticksOf,
  type ClientHpFacts,
  type HpLine,
  type SpellMetrics,
  type SpellMetricsInput
} from '../src/shared/spellMetrics.ts'

const FILE = spellsJson as unknown as SpellDbFile

/** The catalog row by name, so a shape test can be checked against the real entry beside it. */
function entry(name: string): SpellMetricsInput {
  const s = FILE.spells.find((x) => x.name === name)
  assert.ok(s, `spells.json carries ${name}`)
  return s
}

/** A line that MUST read, so the assertions below can be about the number rather than the null. */
function read(line: string, level: number): HpLine {
  const out = parseHpLine(line, level)
  assert.ok(out, `unread: ${line}`)
  return out
}

/** Its magnitude, rounded to two places where a ramp lands between two integers. */
function amount(line: string, level: number): number {
  return Math.round(read(line, level).amount * 100) / 100
}

/** The figures for a spell that MUST produce some. */
function metrics(spell: SpellMetricsInput, level: number): SpellMetrics {
  const out = spellMetricsAt(spell, level)
  assert.ok(out, 'expected figures')
  return out
}

test('R1 the nine pinned shapes read to the right magnitude at a stated level', () => {
  // 1. the bare constant (160 rows; Asp Venom Strike states exactly this)
  assert.deepEqual(parseHpLine('Decrease Hitpoints by 100', 1), {
    amount: 100,
    direction: 'down',
    perTick: false
  })

  // 2. the two-point ramp (161 rows) — linear inside, clamped outside
  const ramp = 'Decrease Hitpoints by 1 (L1) to 51 (L100)'
  assert.equal(amount(ramp, 1), 1)
  assert.equal(amount(ramp, 100), 51)
  assert.equal(amount(ramp, 199), 51, 'clamped above the last breakpoint')
  assert.equal(amount(ramp, 0), 1, 'clamped below the first')
  // (100-1) levels carry (51-1) points, so L50 is 1 + 49*(50/99)
  assert.equal(amount(ramp, 50), 25.75)

  // 3. the per-tick constant (116 rows; Acid Jet)
  assert.deepEqual(parseHpLine('Decrease Hitpoints by 10 per tick', 40), {
    amount: 10,
    direction: 'down',
    perTick: true
  })

  // 4. the per-tick ramp with the marker OUTSIDE the range clause (17 rows; Blood of Pain)
  const dotRamp = 'Decrease Hitpoints by 10 (L1) to 22 (L50) per tick'
  assert.equal(amount(dotRamp, 50), 22)
  assert.equal(read(dotRamp, 50).perTick, true)

  // 5. THREE breakpoints, NON-MONOTONIC (Stone Spider Stun) — the value falls to 0 at 70 and
  //    climbs again to 110, so the reader may not assume the values ascend, only the levels.
  const three = 'Decrease Hitpoints by 10 (L1) to 0 (L70) to 65 (L110)'
  assert.equal(amount(three, 1), 10)
  assert.equal(amount(three, 70), 0)
  assert.equal(amount(three, 110), 65)
  // L36 is 35/69 of the way down the first leg: 10 - 10*(35/69)
  assert.equal(amount(three, 36), 4.93)
  assert.equal(amount(three, 90), 32.5, 'halfway up the second leg')

  // 6. the increase-side per-tick constant (37 rows; Aura of Battle)
  assert.deepEqual(parseHpLine('Increase Hitpoints by 1 per tick', 10), {
    amount: 1,
    direction: 'up',
    perTick: true
  })

  // 7. the increase-side per-tick ramp (Chloroplast)
  const hotRamp = 'Increase Hitpoints by 10 (L39) to 16 (L50) per tick'
  assert.equal(amount(hotRamp, 39), 10)
  assert.equal(amount(hotRamp, 50), 16)
  assert.equal(read(hotRamp, 39).direction, 'up')

  // 8. per-tick INSIDE the range clause, with a trailing parenthetical (Sebilite Pox)
  const inside = 'Increase Hitpoints by 1 per tick (L1) to 22 per tick (L65) (effect decreases over time)'
  assert.equal(amount(inside, 65), 22)
  assert.equal(read(inside, 65).perTick, true)

  // 9. the cleric Echo tail — a RANGE read at its midpoint, and a line that counts its own ticks
  assert.deepEqual(read('Increase Hitpoints between 165 and 190 for two additional ticks.', 50), {
    amount: 177.5,
    direction: 'up',
    perTick: true,
    statedTicks: 2
  })
})

test('R2 the casing and spelling variants the thirteen scrape passes left behind', () => {
  assert.equal(amount('Increase Current Hit Points by 60 per Tick', 1), 60)
  assert.equal(read('Increase Hitpoints v2 by 175 per tick', 1).direction, 'up')
  assert.equal(read('Increases hitpoints by 4 per tick', 1).perTick, true)
  assert.equal(amount('Decrease Hit Points by 154', 1), 154)
  assert.equal(amount('Decrease hitpoints by 20 per tick', 1), 20)
  // `@L` is the same statement as `(L…)`
  assert.equal(amount('Decrease Hitpoints by 6 @L1 to 70 @L60', 60), 70)
  // a bare range (Lifespike) reads at its midpoint, like `between … and …`
  assert.equal(amount('Decrease Hitpoints by 7 to 12', 1), 9.5)
  // `after N ticks` is a DELAY, not a rate: Blooming Heal heals 300 once
  assert.deepEqual(read('Increase Hitpoints by 300 after 4 ticks', 1), {
    amount: 300,
    direction: 'up',
    perTick: false,
    statedTicks: 4
  })
  assert.equal(read('Increase Hitpoints by 5000 after three ticks.', 1).perTick, false)
})

test('R3 ticks come from the duration, and a rate with no duration states no total', () => {
  assert.equal(ticksOf(null), 0)
  assert.equal(ticksOf(undefined), 0)
  assert.equal(ticksOf(0), 0)
  assert.equal(ticksOf(126_000), 21)
  assert.equal(ticksOf(20_000), 3, 'rounded, not floored')

  // A per-tick line on an instant spell contributes nothing: the catalog stated a rate and not
  // how long it runs, and multiplying by a guess would invent the total.
  const rateOnly = spellMetricsAt(
    { effects: ['Decrease Hitpoints by 10 per tick'], mana: 50, castTimeMs: 2000, durationMs: null },
    30
  )
  assert.equal(rateOnly, undefined)
})

test('R4 the metrics arithmetic — damage, dps and per mana, on the real rows', () => {
  // Anarchy: 273 (L34) to 288 (L39), 99 mana, 3.5s cast, instant. 288/99 = 2.909…, 288/3.5 = 82.3
  assert.deepEqual(metrics(entry('Anarchy'), 39), { damage: 288, damagePerMana: 2.9, dps: 82.3 })

  // Blood of Pain: 56 (L41) to 65 (L50) per tick over its stated duration. 650 / (3 + 60) = 10.3
  const dot = metrics(
    { effects: ['Decrease Hitpoints by 56 (L41) to 65 (L50) per tick'], mana: 100, castTimeMs: 3000, durationMs: 60_000 },
    50
  )
  assert.deepEqual(dot, { damage: 650, damagePerMana: 6.5, dps: 10.3, dot: true, overSec: 60 })

  // Chloroplast: a pure HoT — 16 per tick at L50 over 16 minutes (160 ticks), 200 mana, 6s cast.
  const hot = metrics(entry('Chloroplast'), 50)
  // hps is over cast PLUS the whole duration: 2560 / (6 + 960) = 2.65
  assert.deepEqual(hot, { heal: 2560, healPerMana: 12.8, hps: 2.7, hot: true, overSec: 960 })
})

test('R5 the Echo family sums its direct heal and its self-counted tail', () => {
  // Celestial Echo: `Increase Hitpoints by 262 (L34) to 310 (L50)` then
  // `Increase Hitpoints between 165 and 190 for two additional ticks.` — 310 + 177.5*2.
  const echo = metrics(entry('Celestial Echo'), 50)
  assert.equal(echo.heal, 665)
  assert.equal(echo.hot, true)
  assert.equal(echo.healPerMana, 2.7) // 245 mana
})

test('R6 a lifetap is damage, and max-HP / HP-when-cast lines are not hit points arriving', () => {
  // Siphon: `Decrease Hitpoints by 80` + `Increase Hitpoints by 80 (Self)`, targetType Lifetap.
  const siphon = metrics(entry('Siphon'), 30)
  assert.equal(siphon.damage, 80)
  assert.equal(siphon.heal, undefined, 'the increase side is the same 80 written from the other end')

  // The same two lines WITHOUT the Lifetap target type still read as both — the exclusion is a
  // claim about the catalog's own filing, not a guess from the strings.
  const notATap = metrics(
    { effects: ['Decrease Hitpoints by 80', 'Increase Hitpoints by 80'], mana: 40, castTimeMs: 1000 },
    30
  )
  assert.equal(notATap.damage, 80)
  assert.equal(notATap.heal, 80)

  // A MAX-HP buff is not a heal, however it is spelled.
  assert.equal(parseHpLine('Increase Max Hitpoints by 202 (L34) to 225 (L42)', 42), null)
  assert.equal(parseHpLine('Increase Max Hit Points by 251', 42), null)
  assert.equal(parseHpLine('Increase Max HP by 800', 42), null)
  // `HP when cast` is the SAME magnitude written a second way (Armor of Protection states
  // 202→225 as both a Max Hitpoints line and an HP-when-cast line) — reading it would double.
  assert.equal(parseHpLine('Increase HP when cast by 202 (L34) to 225 (L42)', 42), null)
  assert.equal(parseHpLine('Decrease HP when cast by 50', 42), null)
  // Neither of these is an effect magnitude at all.
  assert.equal(parseHpLine("Stacking: Block new spell if slot 3 is effect 'Max Hitpoints' and < 1100", 1), null)
  assert.equal(parseHpLine('UNKNOWN CALC 118 base 406 max 446 attrib Max Hitpoints', 1), null)
  assert.equal(parseHpLine('Charm (up to L37)', 1), null)
})

/** Every figure a SpellMetrics can carry, for the sweep's "no number nobody can hold" check. */
function figuresOf(m: SpellMetrics | undefined): (number | undefined)[] {
  return m === undefined ? [] : [m.damage, m.heal, m.dps, m.hps, m.damagePerMana, m.healPerMana]
}

test('R7 the whole committed catalog reads without producing a number nobody can hold', () => {
  let withMetrics = 0
  let hpLinesRead = 0
  let hpLinesDeclined = 0
  const declined = new Set<string>()
  for (const s of FILE.spells) {
    const m = spellMetricsAt(s, 50)
    if (m) withMetrics++
    for (const raw of s.effects ?? []) {
      const line = parseHpLine(raw, 50)
      if (line) {
        hpLinesRead++
        assert.ok(Number.isFinite(line.amount) && line.amount >= 0, `${s.name}: ${raw}`)
      } else if (/hit\s?points?/i.test(raw)) {
        hpLinesDeclined++
        declined.add(raw.replace(/-?\d+(\.\d+)?/g, 'N'))
      }
    }
    for (const v of figuresOf(m)) {
      if (v !== undefined) assert.ok(Number.isFinite(v) && v > 0, `${s.name}: ${String(v)}`)
    }
  }
  // FLOORS, not exact counts — a re-scrape may add spells. The declined SHAPES are pinned
  // exactly, because a new unread shape is the thing worth noticing.
  assert.ok(hpLinesRead > 500, `read ${String(hpLinesRead)} hitpoint lines`)
  assert.ok(withMetrics > 300, `${String(withMetrics)} spells carry figures`)
  assert.ok(hpLinesDeclined > 0, 'the max-HP family is declined rather than silently absent')
  // Every declined shape is a max-HP statement, a stacking blocker or an uncomputed calc.
  for (const shape of declined) {
    assert.match(
      shape,
      /max\s+hit\s?points?|Stacking:|UNKNOWN CALC|\(pet_level\)/i,
      `unread hitpoint shape: ${shape}`
    )
  }
})

test('R8 the row parts read the way the panel prints them, with no em dash', () => {
  const dmg = spellMetricsParts({ damage: 143, dps: 48, damagePerMana: 2.1 })
  assert.deepEqual(dmg, ['dmg 143', 'dps 48', '2.1 dmg/mana'])
  const heal = spellMetricsParts({ heal: 250, hps: 83, healPerMana: 3.6 })
  assert.deepEqual(heal, ['heal 250', 'hps 83', '3.6 heal/mana'])
  const dot = spellMetricsParts({ damage: 650, dps: 10.3, damagePerMana: 6.5, dot: true, overSec: 60 })
  assert.equal(dot[dot.length - 1], 'over 60s')
  for (const p of [...dmg, ...heal, ...dot]) assert.ok(!/[—–]/.test(p), p)
  // Nothing at all for a spell with no hitpoint line.
  assert.deepEqual(spellMetricsParts({}), [])
})

// ── JOS-396 — THE CLIENT'S SLOTS, WHERE THE WIKI'S SLOT TABLE IS MISSING A LINE ────────────────
//
// Every client row below is transcribed VERBATIM from the owner's `spells_us.txt` on 2026-08-16,
// with the spell it came from named beside it, for the reason tests/spellsUsParse.test.mts states:
// the file is Daybreak's and is never committed here, so a transcription with a name on it is the
// only honest way to pin a reader against it.

/** Odium, id 4093: slot 2 is `0|-217|0|103|325`, duration formula 7 capped at 5 ticks. */
const ODIUM_CLIENT: ClientHpFacts = {
  hp: [{ base: -217, max: 325, calc: 103, perTick: true }],
  hpDuration: { formula: 7, value: 5 }
}
/** What the wiki page states for Odium — one curse-counter line and no hitpoint line at all. */
const ODIUM_WIKI: SpellMetricsInput = {
  effects: ['Increase Curse Counter by 8'],
  mana: 409,
  castTimeMs: 3000,
  durationMs: 30_000
}

test('R9 a client magnitude is |base| + step x level, capped — and Odium is the pin', () => {
  const odium = ODIUM_CLIENT.hp?.[0]
  assert.ok(odium)
  // calc 103 is two points a level ON THE MAGNITUDE. Reading `base + 2L` off a negative base would
  // give 43 -> -131, which is the wrong number and the wrong sign.
  assert.deepEqual(clientHpMagnitudeAt(odium, 43), { amount: 303, formulaUnknown: false })
  assert.deepEqual(clientHpMagnitudeAt(odium, 50), { amount: 317, formulaUnknown: false })
  assert.deepEqual(clientHpMagnitudeAt(odium, 54), { amount: 325, formulaUnknown: false })
  assert.deepEqual(clientHpMagnitudeAt(odium, 60), { amount: 325, formulaUnknown: false }, 'capped at max')

  // calc 100 is flat at every level (Bolt of Karana, `1|0|-200|0|100|200`).
  const flat = { base: -200, max: 200, calc: 100, perTick: false }
  assert.equal(clientHpMagnitudeAt(flat, 1).amount, 200)
  assert.equal(clientHpMagnitudeAt(flat, 60).amount, 200)

  // calc 101 is HALF a point a level, and the division is the client's — integer (Monkey Stun,
  // `2|0|-200|0|101|0`; max 0 means no cap at all).
  const half = { base: -200, max: 0, calc: 101, perTick: false }
  assert.equal(clientHpMagnitudeAt(half, 40).amount, 220)
  assert.equal(clientHpMagnitudeAt(half, 43).amount, 221, 'floored, not 221.5')

  // A calc this reader does not model answers the BASE and says so, rather than guessing a curve
  // (Soul Bond, `3|0|1|0|4005|0` — the one such spell in the committed catalog).
  assert.deepEqual(clientHpMagnitudeAt({ base: 1, max: 0, calc: 4005, perTick: true }, 60), {
    amount: 1,
    formulaUnknown: true
  })
})

test('R10 a client duration is a formula and a cap, and the permanent kinds answer null', () => {
  // Odium: formula 7 is `level`, capped at 5. Five ticks at every level a shaman has it.
  assert.equal(clientDurationTicks({ formula: 7, value: 5 }, 43), 5)
  assert.equal(clientDurationTicks({ formula: 7, value: 5 }, 60), 5)
  // …and BELOW the cap the formula wins (`Cancelling of Life`, formula 7 capped at 10).
  assert.equal(clientDurationTicks({ formula: 7, value: 10 }, 8), 8)

  // Illusion: Iksar, formula 3 (`level x 30`) capped at 360 — 600 at L20, so the cap answers.
  assert.equal(clientDurationTicks({ formula: 3, value: 360 }, 20), 360)
  // Assiduous Vision, formula 3 capped at 1950: uncapped at L36.
  assert.equal(clientDurationTicks({ formula: 3, value: 1950 }, 36), 1080)

  // PERMANENT (50 and 51), instant (0) and every code this reader does not name answer null, which
  // the fold reads as "a rate with no length".
  assert.equal(clientDurationTicks({ formula: 50, value: 0 }, 49), null)
  assert.equal(clientDurationTicks({ formula: 51, value: 0 }, 49), null)
  assert.equal(clientDurationTicks({ formula: 0, value: 0 }, 49), null)
  assert.equal(clientDurationTicks({ formula: 99_999, value: 0 }, 49), null)
})

test('R11 THE TICKET: Odium reads off the client and prints the way the row does', () => {
  // Before: the page states no hitpoint line, so there are no figures — the owner's report.
  assert.equal(spellMetricsAt(ODIUM_WIKI, 43), undefined)

  // After: 303 a tick x 5 ticks = 1515, over 409 mana, over a 3s cast plus 30s of ticks.
  const m = spellMetricsAt(ODIUM_WIKI, 43, ODIUM_CLIENT)
  assert.deepEqual(m, {
    damage: 1515,
    damagePerMana: 3.7,
    dps: 45.9,
    dot: true,
    overSec: 30,
    source: 'client'
  })
  assert.deepEqual(spellMetricsParts(m ?? {}), [
    'dmg 1515',
    'dps 46',
    '3.7 dmg/mana',
    'over 30s'
  ])
  // The ramp is read at the evaluation level like every other figure in this file.
  assert.equal(spellMetricsAt(ODIUM_WIKI, 50, ODIUM_CLIENT)?.damage, 1585)
  assert.equal(spellMetricsAt(ODIUM_WIKI, 54, ODIUM_CLIENT)?.damage, 1625)
})

test('R12 the wiki stays primary — the client is consulted only when the page yields nothing', () => {
  // Anarchy states its own ramp. Handing the reader a client row that disagrees changes NOTHING,
  // which is the whole of acceptance 3: no spell that had figures moves.
  const loud: ClientHpFacts = { hp: [{ base: -9999, max: 0, calc: 100, perTick: false }] }
  assert.deepEqual(metrics(entry('Anarchy'), 39), spellMetricsAt(entry('Anarchy'), 39, loud))
  assert.equal(spellMetricsAt(entry('Anarchy'), 39, loud)?.source, undefined)

  // No client facts at all is the pre-ticket behaviour, unchanged.
  assert.equal(spellMetricsAt(ODIUM_WIKI, 43, undefined), undefined)
  assert.equal(spellMetricsAt(ODIUM_WIKI, 43, {}), undefined)
  assert.equal(spellMetricsAt(ODIUM_WIKI, 43, { hp: [] }), undefined)
})

test('R13 the client fold: a flat nuke, a heal, an unknown formula, and a rate with no length', () => {
  // A FLAT NUKE — Bolt of Karana, `1|0|-200|0|100|200`, formula 0. One hit, no ticks, no `over`.
  const bolt = spellMetricsAt(
    { effects: ['Decrease HP when cast by 200'], mana: 0, castTimeMs: 15_000 },
    1,
    { hp: [{ base: -200, max: 200, calc: 100, perTick: false }] }
  )
  assert.deepEqual(bolt, { damage: 200, dps: 13.3, source: 'client' })

  // A HEAL — Envenomed Heal, `2|0|173|0|100|0`. A POSITIVE base lands on the heal side.
  const heal = spellMetricsAt({ effects: ['Increase HP when cast by 150'] }, 1, {
    hp: [{ base: 173, max: 0, calc: 100, perTick: false }]
  })
  assert.deepEqual(heal, { heal: 173, source: 'client' })

  // AN UNKNOWN FORMULA still produces a figure — the base — and flags itself (Soul Bond).
  const bond = spellMetricsAt(
    { effects: ['Ticks in order 5,10,15,20,25,30 (total 105)'], mana: 360, castTimeMs: 7000, targetType: 'Lifetap' },
    1,
    { hp: [{ base: 1, max: 0, calc: 4005, perTick: true }], hpDuration: { formula: 2, value: 5 } }
  )
  assert.equal(bond?.formulaUnknown, true)
  assert.equal(bond?.damage, 5, 'base 1 a tick over the five ticks the client states')
  // …AND A LIFETAP'S CLIENT SLOT IS DAMAGE WHATEVER ITS SIGN. The wiki path drops a lifetap's
  // increase line because the page states the transfer twice; the client states it once, so
  // dropping it would throw away the only statement there is.
  assert.equal(bond?.heal, undefined)

  // A RATE WITH NO LENGTH — Lich, `1|0|-22|0|100|0` with duration formula 50 (permanent). The
  // client says 22 a tick and never says how many ticks, so there is no total to state. This is
  // what keeps the twelve shapeshift self-buffs out of the fifteen.
  const lich = spellMetricsAt({ effects: ['Increase Mana by 10'], mana: 0, castTimeMs: 6000 }, 49, {
    hp: [{ base: -22, max: 0, calc: 100, perTick: true }],
    hpDuration: { formula: 50, value: 0 }
  })
  assert.equal(lich, undefined)
})
