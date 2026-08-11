/**
 * usageStartup.test.mts — the READ half of the startup-replay reading (JOS-57), and only that.
 *
 * A SEPARATE FILE for the reason `usagePulse.test.mts` beside it is one: tests/usageAnalytics.test.mts
 * sits at the repo's 400-line ceiling, and a split is the answer to that here, not a widened
 * threshold. The cut is by SUBJECT: that file owns the sections as they were, this one owns the
 * question "does the startup throttle work on machines we do not own".
 *
 * WHAT THE PRODUCER AND THE ROLLUP DO with the same reading is pinned in
 * tests/telemetryProducers.test.mts — the event's shape, its ceilings, the bucket edges, and the
 * counters one launch writes. This file starts from those counters, authored by hand, and asserts
 * only what a READER may conclude from them.
 *
 * THE HONESTY QUESTIONS IT ASKS:
 *   * is a percentile a bucket RANGE, never a number the histogram never held?
 *   * is "nobody measured this" distinguishable from "every launch was instant"? (A dash, not a
 *     bottom bucket — the same rule `rateLabel`'s `—` follows.)
 *   * does one build's histogram stay out of another's, so the comparison the section exists for
 *     is a comparison and not a smear?
 *
 * Pure, like its parent: no AWS, no Electron, no clock.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAnalytics } from '../src/main/triage/analytics'
import type { FunnelRow, InstallRow, UsageRow } from '../src/main/triage/usageRows'
import { USAGE_METRICS } from '../src/shared/telemetryRollup'
import { renderAnalyticsDigest } from '../scripts/analyticsDigest.mjs'

/** A fixed "now", so every day key here is stable — the same anchor its parent file uses. */
const NOW = Date.UTC(2026, 7, 10, 12, 0, 0)
const TODAY = '2026-08-10'

const u = (d: string, metric: string, dim: string, n: number): UsageRow => ({
  day: d,
  cohort: 'user',
  metric,
  dim,
  n
})

const build = (
  usage: UsageRow[] = [],
  funnels: FunnelRow[] = [],
  installs: InstallRow[] = [],
  days = 30
) => buildAnalytics({ usage, funnels, installs, windowDays: days, nowMs: NOW })

/** Every counter one launch writes, at one version — the rollup's own output, authored by hand. */
function startupRows(version: string, r: {
  replayBucket: number
  blockBucket: number
  dutyPct: number
  events: number
  stalls: number
  logBucket: number
  n?: number
}): UsageRow[] {
  const n = r.n ?? 1
  return [
    u(TODAY, USAGE_METRICS.startupReplays, version, n),
    u(TODAY, USAGE_METRICS.startupReplayMs, `${version}:${String(r.replayBucket)}`, n),
    u(TODAY, USAGE_METRICS.startupBlockMs, `${version}:${String(r.blockBucket)}`, n),
    u(TODAY, USAGE_METRICS.startupDutyPct, version, r.dutyPct * n),
    u(TODAY, USAGE_METRICS.startupEventsReplayed, version, r.events * n),
    u(TODAY, USAGE_METRICS.startupBlocksOver50, version, r.stalls * n),
    u(TODAY, USAGE_METRICS.startupLogSize, String(r.logBucket), n)
  ]
}

test('startup percentiles are BUCKET RANGES per build, and the sums are means over launches', () => {
  // 0.6.0: eighteen ordinary launches in the 1-2.5 s bucket and two miserable ones at 10-30 s.
  // That is exactly the shape a p95 exists for — a mean would hide it entirely. TWO rather than
  // one because the percentile is NEAREST-BUCKET over 20 samples: one slow launch in twenty is
  // the 20th value and sits ABOVE the 95th, so a p95 that reported it would be the wrong answer,
  // not a more alarming one.
  const d = build([
    ...startupRows('0.6.0', {
      replayBucket: 2, blockBucket: 2, dutyPct: 70, events: 400_000, stalls: 1, logBucket: 2, n: 18
    }),
    ...startupRows('0.6.0', {
      replayBucket: 5, blockBucket: 5, dutyPct: 90, events: 900_000, stalls: 40, logBucket: 3, n: 2
    }),
    ...startupRows('0.5.0', {
      replayBucket: 6, blockBucket: 6, dutyPct: 99, events: 400_000, stalls: 60, logBucket: 2, n: 4
    })
  ]).startup

  // Newest build first — the comparison a reader is making reads top-down.
  assert.deepEqual(d.byVersion.map((r) => r.version), ['0.6.0', '0.5.0'])
  const [now, before] = d.byVersion
  assert.equal(now.launches, 20)
  assert.equal(now.p50ReplayLabel, '1 s-2.5 s')
  assert.equal(now.p95ReplayLabel, '10 s-30 s')
  assert.equal(now.p50BlockLabel, '25 ms-50 ms')
  assert.equal(now.p95BlockLabel, '250 ms-500 ms')
  // (18 × 70 + 2 × 90) / 20 = 72%, as a FRACTION here — the counter sums whole percents.
  assert.equal(now.dutyAchieved, 0.72)
  assert.equal(now.meanEventsReplayed, (18 * 400_000 + 2 * 900_000) / 20)
  assert.equal(now.blocksOver50, 18 + 2 * 40)

  // THE COMPARISON IS THE POINT: the older build's launches were slower and blocked harder, and
  // the two rows say so side by side without anything ever being averaged across builds.
  assert.equal(before.p95ReplayLabel, '30 s-60 s')
  assert.equal(before.blocksOver50, 240)

  // Log size is fleet-wide and rendered as a RANGE, never a byte count.
  assert.deepEqual(d.logSizes, [
    { id: '10 MB-100 MB', n: 22 },
    { id: '100 MB-512 MB', n: 2 }
  ])
})

test('a build that reported no replay has NO row, and an unmeasured percentile is null', () => {
  // A version with a launch counter but no histogram at all: it launched, the reading arrived
  // without a replay to describe (no log on the machine), and the percentiles must be dashes
  // rather than the bottom bucket — "not measured" is not "instant".
  const d = build([u(TODAY, USAGE_METRICS.startupReplays, '0.6.0', 3)]).startup
  assert.deepEqual(d.byVersion, [
    {
      version: '0.6.0',
      launches: 3,
      p50ReplayLabel: null,
      p95ReplayLabel: null,
      p50BlockLabel: null,
      p95BlockLabel: null,
      dutyAchieved: 0,
      meanEventsReplayed: 0,
      blocksOver50: 0
    }
  ])
  // …and a fleet that has never reported one at all is an EMPTY list, which both surfaces say
  // out loud rather than rendering as a build with zeros.
  const none = build().startup
  assert.deepEqual(none.byVersion, [])
  assert.deepEqual(none.logSizes, [])
})

test('the digest prints the SAME reading as the tab — one computation, two renderings', () => {
  const text = renderAnalyticsDigest(
    build(
      startupRows('0.6.0', {
        replayBucket: 2, blockBucket: 2, dutyPct: 70, events: 400_000, stalls: 1, logBucket: 2, n: 4
      })
    )
  )
  assert.match(text, /0\.6\.0\s+4 launches · replay p50\s+1 s-2\.5 s/)
  assert.match(text, /duty 70\.0% · 400000 events\/launch · 4 stalls >50ms/)
  assert.match(text, /log size of measured launches/)
})

test('one build’s histogram never leaks into another’s — the dim is split at the LAST colon', () => {
  const d = build([
    ...startupRows('0.6.0', {
      replayBucket: 1, blockBucket: 1, dutyPct: 50, events: 10, stalls: 0, logBucket: 0
    }),
    ...startupRows('0.6.0-beta.1', {
      replayBucket: 6, blockBucket: 6, dutyPct: 99, events: 99, stalls: 9, logBucket: 5
    })
  ]).startup
  const beta = d.byVersion.find((r) => r.version === '0.6.0-beta.1')
  const stable = d.byVersion.find((r) => r.version === '0.6.0')
  assert.equal(stable?.p95ReplayLabel, '250 ms-1 s')
  assert.equal(beta?.p95ReplayLabel, '30 s-60 s')
  assert.equal(stable?.blocksOver50, 0)
  assert.equal(beta?.blocksOver50, 9)
})
