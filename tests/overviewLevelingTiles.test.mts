// PURE unit tests for the Overview leveling PANEL's shapes — the stat tiles and the hour's
// sparkline (src/renderer/src/features/overview/overviewLevelingTiles.ts).
//
// Its sibling `overviewLeveling.test.mts` pins what is TRUE; this file pins what is DRAWN, and
// the two rules that decide it:
//
//   1. A TILE IS PRESENT ONLY WHEN THE LOG CAN STATE IT. No ding folded ⇒ no level tile; a
//      blocked projection ⇒ no ETA tile. The row's LENGTH is a fact about the evidence, and an
//      em-dash tile would spend a quarter of the panel saying "we don't know" twice (the card
//      already carries the refusal as a sentence, with its reason).
//   2. A FLAT SPARKLINE AND A REFUSED ONE ARE DIFFERENT ANSWERS. Twelve zero-height columns say
//      "measured, and quiet"; an hour whose every experience line stated no percentage (the
//      at-the-cap shape) is UNKNOWN and draws no columns at all. Collapsing the two would be
//      exactly the fabricated-zero this whole feature refuses (world-model law 1).
//
// Imported RELATIVELY: node tests run through tsx with no `@shared` / `@renderer` aliases.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SPARK_BUCKETS,
  levelingSpark,
  levelingTiles,
  sparkColor,
  splitRate
} from '../src/renderer/src/features/overview/overviewLevelingTiles'
import {
  levelingWindows,
  overviewLeveling
} from '../src/renderer/src/features/overview/overviewLevelingData'
import { zoneColor } from '../src/renderer/src/features/leveling/zoneBands'
import { rangeStats } from '../src/shared/progressionStats'
import type { ProgressionSnap } from '../src/shared/progressionTypes'
import type { RangeStats } from '../src/shared/progressionStats'

const MIN = 60_000
const HOUR = 60 * MIN
/** An arbitrary, readable anchor — deliberately not near `Date.now()`. */
const T0 = Date.parse('Sat Aug 01 12:00:00 2026')

function emptySnap(): ProgressionSnap {
  return {
    expTs: [], expPct: [], expFlag: [],
    killTs: [], killZone: [], killCredit: [],
    witnessTs: [], recentKills: [], lootTs: [],
    zoneStart: [], zoneEnd: [], zoneName: [],
    offlineStart: [], offlineEnd: [], offlineCamped: [],
    levelTs: [], levelValue: [], aaGainTs: [], aaGainAmount: [],
    lastTs: 0, windowStart: 0, dropped: 0
  }
}

/** One open zone plus an exp+kill sample every minute across the last hour of LOG time. */
function farming(opts: { pct: number; unstated?: boolean; zone?: string }): ProgressionSnap {
  const s = emptySnap()
  const start = T0 - HOUR
  for (let ts = start + MIN; ts < T0; ts += MIN) {
    s.expTs.push(ts)
    s.expPct.push(opts.unstated ? -1 : opts.pct)
    s.expFlag.push(opts.unstated ? 1 : 0)
    s.killTs.push(ts)
    s.killZone.push(0)
    s.killCredit.push(0)
  }
  s.zoneStart.push(start)
  s.zoneEnd.push(0)
  s.zoneName.push(opts.zone ?? 'Plane of Sky')
  s.lastTs = T0
  return s
}

function hourStats(snap: ProgressionSnap): RangeStats {
  const { hour } = levelingWindows(snap)
  assert.ok(hour, 'fixture must have a headline window')
  return rangeStats({ snap, range: hour })
}

// ── the value/unit split ───────────────────────────────────────────────────────────────

test('splitRate recovers the two halves of the ONE rate wording, the dash included', () => {
  assert.deepEqual(splitRate('1.42 lvl/hr'), { value: '1.42', unit: 'lvl/hr' })
  assert.deepEqual(splitRate('240 kills/hr'), { value: '240', unit: 'kills/hr' })
  // The unknown answer has no unit to split off, and must not gain one.
  assert.deepEqual(splitRate('-'), { value: '-', unit: '' })
})

// ── the tiles ──────────────────────────────────────────────────────────────────────────

test('a full hour states four tiles — level, pace, AA, next level — in that order', () => {
  const snap = farming({ pct: 1 })
  snap.levelTs.push(T0 - 30 * MIN)
  snap.levelValue.push(43)
  snap.aaGainTs.push(T0 - 10 * MIN)
  snap.aaGainAmount.push(3)
  const state = overviewLeveling(snap)
  assert.deepEqual(
    state.tiles.map((t) => t.id),
    ['level', 'rate', 'aa', 'eta']
  )
  assert.equal(state.tiles[0].value, '43')
  assert.equal(state.tiles[1].unit, 'lvl/hr')
  assert.equal(state.tiles[2].value, '3', 'the AA tile counts the gain LINES in the hour')
  assert.match(state.tiles[3].label, /^to level 44$/)
  assert.ok(
    state.tiles.every((t) => t.title.length > 0),
    'every tile answers "what window is this" on hover — a bare number is not a fact'
  )
})

test('no ding folded ⇒ NO level tile, never a guessed or em-dash one', () => {
  const state = overviewLeveling(farming({ pct: 1 }))
  assert.equal(state.level, null)
  assert.ok(!state.tiles.some((t) => t.id === 'level'))
  // …and the projection is blocked for the same missing anchor, so that tile is gone too.
  assert.ok(!state.tiles.some((t) => t.id === 'eta'))
  assert.deepEqual(
    state.tiles.map((t) => t.id),
    ['rate', 'aa'],
    'two measurable facts is the honest floor'
  )
})

test('at cap: the pace tile is a dash, and it is still a tile', () => {
  const snap = farming({ pct: 0, unstated: true })
  const state = overviewLeveling(snap)
  const rateTile = state.tiles.find((t) => t.id === 'rate')
  assert.ok(rateTile)
  assert.equal(rateTile.value, '-', 'unknown, never 0.00')
  assert.equal(rateTile.unit, 'lvl/hr', 'the unit survives the unknown — it says WHAT is unknown')
})

test('the AA tile reports a measured zero rather than disappearing', () => {
  const snap = farming({ pct: 1 })
  const aa = levelingTiles({
    level: null,
    hour: hourStats(snap),
    eta: { blocked: 'no-ding' },
    rateText: '1.00 lvl/hr'
  }).find((t) => t.id === 'aa')
  assert.ok(aa)
  assert.equal(aa.value, '0', 'zero gain LINES in the hour is a count, not an unknown')
})

test('an absurd horizon says so in the tile instead of pretending to minutes', () => {
  const tiles = levelingTiles({
    level: 43,
    hour: hourStats(farming({ pct: 1 })),
    eta: { blocked: null, ms: 50 * 60 * 60_000, toLevel: 44, progress: 0.1, offlineMs: 0 },
    rateText: '0.01 lvl/hr'
  })
  assert.equal(tiles.find((t) => t.id === 'eta')?.value, '>1 day')
})

// ── the sparkline ──────────────────────────────────────────────────────────────────────

test('the hour is twelve columns, and every stated percent lands in exactly one of them', () => {
  const snap = farming({ pct: 1 })
  const { hour } = levelingWindows(snap)
  assert.ok(hour)
  const spark = levelingSpark(snap, hour)
  assert.equal(spark.buckets.length, SPARK_BUCKETS)
  assert.equal(spark.stated, 59, '59 samples strictly inside the half-open hour')
  assert.equal(spark.unstated, 0)
  const total = spark.buckets.reduce((n, b) => n + b.value, 0)
  // Σ over the columns is Σ over the samples — the bucketing partitions, it never drops or
  // double-counts. (0.59 levels of progress; floating point, hence the epsilon.)
  assert.ok(Math.abs(total - 0.59) < 1e-9, `columns summed to ${String(total)}`)
  assert.ok(spark.peak > 0)
  assert.equal(spark.buckets[0].t0, hour.t0)
})

test('an at-cap hour draws NOTHING and says which unknown it is', () => {
  const snap = farming({ pct: 0, unstated: true })
  const { hour } = levelingWindows(snap)
  assert.ok(hour)
  const spark = levelingSpark(snap, hour)
  assert.equal(spark.stated, 0)
  assert.equal(spark.unstated, 59)
  assert.equal(spark.peak, 0)
  // The card keys the refusal on exactly this pair; a flat-but-measured hour has unstated 0.
  assert.ok(spark.stated === 0 && spark.unstated > 0)
})

test('a silent hour is a FLAT reading, not a refused one', () => {
  const snap = emptySnap()
  snap.zoneStart.push(T0 - HOUR)
  snap.zoneEnd.push(0)
  snap.zoneName.push('Plane of Sky')
  snap.lastTs = T0
  const { hour } = levelingWindows(snap)
  assert.ok(hour)
  const spark = levelingSpark(snap, hour)
  assert.equal(spark.stated, 0)
  assert.equal(spark.unstated, 0, 'nothing was gained — that is a measurement, not a hole')
  assert.ok(spark.buckets.every((b) => b.value === 0))
})

test('every column names the zone covering its midpoint, and takes that zone’s chart hue', () => {
  const snap = farming({ pct: 1, zone: 'Sebilis' })
  // A second camp for the back half of the hour: the first interval closes, the second is open.
  snap.zoneEnd[0] = T0 - 30 * MIN
  snap.zoneStart.push(T0 - 30 * MIN)
  snap.zoneEnd.push(0)
  snap.zoneName.push('Karnor’s Castle')
  const { hour } = levelingWindows(snap)
  assert.ok(hour)
  const spark = levelingSpark(snap, hour)
  assert.equal(spark.buckets[0].zone, 'Sebilis')
  assert.equal(spark.buckets[SPARK_BUCKETS - 1].zone, 'Karnor’s Castle')
  // THE HUE IS THE LEVELING CHART'S OWN — the same function its band strip and its per-zone
  // table read, so one camp is one colour everywhere in the app. (Deliberately NOT asserted as
  // "two zones differ": the palette is a 12-entry hash and collisions are a property of it, not
  // a defect — see zoneBands.ts.)
  assert.equal(sparkColor('Sebilis'), zoneColor('Sebilis'))
  assert.equal(sparkColor('Karnor’s Castle'), zoneColor('Karnor’s Castle'))
})

test('an hour reaching back before the first zone line claims no camp for those columns', () => {
  const snap = farming({ pct: 1 })
  // The log only names a zone from the half-hour mark on: the earlier columns have none.
  snap.zoneStart[0] = T0 - 30 * MIN
  const { hour } = levelingWindows(snap)
  assert.ok(hour)
  const spark = levelingSpark(snap, hour)
  assert.equal(spark.buckets[0].zone, '', 'no zone line covers this column — never a guessed one')
  assert.equal(spark.buckets[SPARK_BUCKETS - 1].zone, 'Plane of Sky')
  assert.notEqual(sparkColor(''), zoneColor('Plane of Sky'))
})

test('the empty snapshot draws no columns at all — there is no window to bucket', () => {
  const state = overviewLeveling(emptySnap())
  assert.equal(state.empty, true)
  assert.deepEqual(state.tiles, [])
  assert.deepEqual(state.spark, { buckets: [], peak: 0, stated: 0, unstated: 0 })
})
