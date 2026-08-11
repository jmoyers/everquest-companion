// THE PROCS CELL'S ROW SHAPING — and the text it serializes to.
//
// `procRows.ts` is the pure half of the Procs cell: it turns the engine's `ProcLaneView` payload
// into the three columns the panel draws AND the three columns `procsCopy.ts` pastes, so the two
// can never disagree. Both are asserted here for exactly that reason — the panel's numbers and
// the clipboard's numbers come out of one call.
//
// JOS-37 shrank the surface this file describes. The Procs tab used to carry a slow headline, a
// rolling time-to-slow, the coat roster, two rate denominators, Tier-A contribution, the span
// ledger with per-edge evidence chips and the Tier-B effects report; the owner's ask was a
// glanceable list — name, PPM, count — with the deeper attribution left to the damage breakdown,
// where a drilled skill row still wears its `proc · N ppm` tag. So the shapers for the retired
// sections are gone with them, and what remains is asserted below.
//
// The window is SYNTHETIC (the same territory as combatCopyText: pure arithmetic and layout over
// already-aggregated data, no log line to hand-read), but it carries every dimension the list
// still has: an ambiguous poison lane, a big spell lane, the slay lane, and a lane whose rate the
// engine withheld.
//
// THE LAWS UNDER TEST:
//   law 5 — an absent rate renders a DASH (a normal one since JOS-106). Never 0, never blank.
//   law 2 — the ambiguity `~` marks the NAME while the count beside it stays exact.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ABSENT,
  MIN_ACTIVE_SEC,
  ppmCell,
  procListRows,
  procSummary
} from '../src/renderer/src/features/combat/procRows'
import { formatProcsText } from '../src/renderer/src/features/combat/procsCopy'
import { MAX_WIDTH } from '../src/renderer/src/features/combat/copyText'
import type { SegmentView } from '../src/shared/combat'
import type { ProcLaneView, ProcRateView } from '../src/shared/procAnalytics'

// ── fixtures ────────────────────────────────────────────────────────────────────────

/** `count` and `swings` are always present and always exact — they are counts of lines the game
 *  printed. Only the three RATES can be missing, so `over` carries exactly those. */
function rate(count: number, swings: number, over: Partial<ProcRateView> = {}): ProcRateView {
  return { count, swings, ...over }
}

const LANES: ProcLaneView[] = [
  {
    name: 'Asp Venom Strike / Cobra Venom Strike',
    count: 15,
    origin: 'poison',
    ambiguous: true,
    rate: rate(15, 420, { ppmActive: 12.857, ppmWall: 10.843, per100Swings: 3.571 }),
    directDamage: 795,
    directHeal: 0,
    pctOfOut: 1.758,
    dpsContribution: 11.357,
    linked: []
  },
  {
    name: 'Smiting Strike',
    count: 214,
    origin: 'spell',
    rate: rate(214, 420, { ppmActive: 183.4, ppmWall: 154.7, per100Swings: 50.95 }),
    directDamage: 31900,
    directHeal: 0,
    pctOfOut: 70.5,
    dpsContribution: 455.7,
    linked: []
  },
  {
    name: 'Lifetap Strike',
    count: 4,
    origin: 'spell',
    rate: rate(4, 420, { ppmActive: 3.43, ppmWall: 2.89, per100Swings: 0.952 }),
    directDamage: 458,
    directHeal: 474,
    pctOfOut: 1.01,
    dpsContribution: 6.54,
    linked: []
  },
  {
    name: 'Slay Undead',
    count: 45,
    origin: 'slay',
    rate: rate(45, 420, { ppmActive: 38.57, ppmWall: 32.53, per100Swings: 10.71 }),
    directDamage: 6000,
    directHeal: 0,
    pctOfOut: 13.26,
    dpsContribution: 85.7,
    marginalDamage: 1455,
    linked: []
  }
]

const SEG: SegmentView = {
  id: 'zone',
  kind: 'zone',
  name: 'The Plane of Sky - overall',
  durationSec: 83,
  active: false,
  activeSec: 70,
  outTotal: 45230,
  outDps: 545,
  activeDps: 646,
  entities: [],
  inTotal: 0,
  inDps: 0,
  incoming: [],
  enemyHealTotal: 0,
  incomingHealTotal: 0,
  incomingHealers: [],
  healing: { total: 0, restoredTotal: 0, absorbedTotal: 0 } as unknown as SegmentView['healing'],
  procs: {
    combatAtEngage: [],
    slowExpected: false,
    coats: [],
    strikes: [],
    strikeCount: 0,
    slowLands: 0,
    poisonDamage: [{ name: 'Asp Venom Strike', count: 15, total: 795 }],
    poisonDamageTotal: 795,
    dispels: [],
    dispelCount: 0,
    stanceSwitches: 1,
    invocationSwitches: 2,
    lanes: LANES,
    overall: rate(278, 420, { ppmActive: 238.29, ppmWall: 200.96, per100Swings: 66.19 })
  }
}

// ── the ppm cell: absence is a FIRST-CLASS value (it still backs the drill's proc tag) ──

test('a rate below its sample floor is a DASH that states the floor — never 0', () => {
  // The engine withholds `ppmActive` below MIN_ACTIVE_SEC of active time. A 2-second pull with
  // one proc is not "30 ppm", and a meter that prints it once prints it forever.
  const short = ppmCell(rate(1, 6), 2)
  assert.equal(short.text, ABSENT)
  assert.equal(short.absent, true)
  assert.ok(short.hint.includes(`${MIN_ACTIVE_SEC}s of active combat time`), short.hint)
  assert.ok(short.hint.includes('has 2s'), short.hint)
  // The COUNT is never withheld — only the division is. The hover says so.
  assert.ok(short.hint.includes('1 proc counted'), short.hint)
})

test('a rate above its floor renders with the app’s ONE spelling and carries the caveat', () => {
  const cell = ppmCell(rate(214, 420, { ppmActive: 183.4, ppmWall: 154.7, per100Swings: 50.95 }), 70)
  assert.equal(cell.text, '183 ppm')
  assert.equal(cell.absent, false)
  // The active-time definition is STATED, not silently redefined: incoming damage extends it,
  // because that is what the shipped `activeDps` already means.
  assert.ok(cell.hint.includes('incoming damage included'), cell.hint)
  assert.ok(cell.hint.includes('155 ppm of wall clock'), cell.hint)
})

// ── the list ────────────────────────────────────────────────────────────────────────

test('the list is ranked by COUNT, marks the ambiguous NAME, and states each lane’s ppm', () => {
  const rows = procListRows(SEG.procs)
  assert.deepEqual(
    rows.map((r) => r.name),
    ['Smiting Strike', 'Slay Undead', 'Asp Venom Strike / Cobra Venom Strike', 'Lifetap Strike'],
    'count desc — the engine’s poison/spell/slay grouping is NOT the reading order here'
  )
  assert.deepEqual(
    rows.map((r) => r.ppm),
    ['183 ppm', '38.6 ppm', '12.9 ppm', '3.43 ppm']
  )
  // `ambiguous` is about the LABEL. The count beside it is exact either way.
  const venom = rows.find((r) => r.origin === 'poison')
  assert.equal(venom?.ambiguous, true)
  assert.equal(venom?.count, 15)
  assert.equal(rows[0].ambiguous, false)
})

test('a lane whose rate the engine withheld shows an em dash, never a zero', () => {
  const tiny: ProcLaneView[] = [
    { name: 'Smiting Strike', count: 1, origin: 'spell', rate: rate(1, 4), directDamage: 0, directHeal: 0, pctOfOut: 0, dpsContribution: 0, linked: [] }
  ]
  const rows = procListRows({ ...SEG.procs, lanes: tiny, overall: rate(1, 4) })
  assert.equal(rows[0].ppm, ABSENT)
  assert.equal(rows[0].count, 1, 'the count is exact; only the division is withheld')
})

test('an older payload with no unified lanes still lists its poison Strikes', () => {
  // The shipped poison-only shape predates the rate machinery, so those rows have no PPM to
  // state and say so with the same em dash rather than borrowing one.
  const legacy = {
    ...SEG.procs,
    lanes: undefined,
    overall: undefined,
    strikes: [{ name: 'Weakening Strike', count: 2 }, { name: 'Smiting Strike', count: 9 }],
    strikeCount: 11
  }
  const rows = procListRows(legacy)
  assert.deepEqual(
    rows.map((r) => `${r.name} ${r.ppm} ×${r.count}`),
    ['Smiting Strike - ×9', 'Weakening Strike - ×2']
  )
})

test('the header readout is READ from the same view the rows are, never recomputed', () => {
  assert.equal(procSummary(SEG.procs).header, '278 procs · 238 ppm')
  // A selection with procs but too short to divide states the count alone — the honest shape,
  // and not a rate of zero.
  assert.equal(procSummary({ ...SEG.procs, overall: rate(3, 12) }).header, '3 procs')
  assert.equal(procSummary({ ...SEG.procs, lanes: undefined, overall: undefined }).header, '0 procs')
})

// ── the same rows, as pasted text ───────────────────────────────────────────────────

test('formatProcsText is the panel’s three columns, and it fits the paste width', () => {
  const text = formatProcsText(SEG)
  assert.equal(
    text,
    [
      'Procs - The Plane of Sky - overall · 1:23',
      '278 procs · 238 ppm',
      '',
      'Proc                                          PPM  Count',
      'Smiting Strike                            183 ppm    214',
      'Slay Undead                              38.6 ppm     45',
      // The `~` marks the NAME the game left ambiguous; the count beside it is exact.
      '~ Asp Venom Strike / Cobra Venom Strike  12.9 ppm     15',
      'Lifetap Strike                           3.43 ppm      4'
    ].join('\n')
  )
  assert.ok(text.split('\n').every((l) => l.length <= MAX_WIDTH), text)
  // Same law as every other copy block: no markdown for a destination to re-render.
  assert.ok(!/[*_`|#]/.test(text), text)
})

test('a selection with no procs pastes one honest line, never an empty table', () => {
  const bare = { ...SEG, procs: { ...SEG.procs, lanes: [], overall: undefined } }
  assert.equal(
    formatProcsText(bare),
    ['Procs - The Plane of Sky - overall · 1:23', 'No procs in this selection.'].join('\n')
  )
})

test('a rate-less selection pastes dashes, never zeroes', () => {
  const tiny: ProcLaneView[] = [
    { name: 'Smiting Strike', count: 1, origin: 'spell', rate: rate(1, 4), directDamage: 0, directHeal: 0, pctOfOut: 0, dpsContribution: 0, linked: [] }
  ]
  const text = formatProcsText({ ...SEG, activeSec: 3, procs: { ...SEG.procs, lanes: tiny, overall: rate(1, 4) } })
  assert.equal(
    text,
    [
      'Procs - The Plane of Sky - overall · 1:23',
      '1 proc',
      '',
      'Proc            PPM  Count',
      `Smiting Strike    ${ABSENT}      1`
    ].join('\n')
  )
  // Not one zero rate anywhere: `1 proc in a 3-second pull` is not `20 ppm`, and it is not
  // `0 ppm` either.
  assert.ok(!/[\d.]+ ppm/.test(text), text)
})
