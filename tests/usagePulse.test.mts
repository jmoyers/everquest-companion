/**
 * usagePulse.test.mts — the pulse numbers JOS-39 added, and only those.
 *
 * A SEPARATE FILE because tests/usageAnalytics.test.mts was at the 400-line ceiling and a split
 * is the answer to that in this repo, not a widened threshold. The cut is by SUBJECT rather than
 * by size: that file owns the six sections as they were, this one owns the five numbers the owner
 * asked for at a glance — installs today, upgrades today, fleet lines parsed, and the two live
 * ones that come from CloudWatch instead of from the counter tables.
 *
 * THE HONESTY QUESTIONS THESE ASK:
 *   * does "today" mean TODAY, or the last day anything happened? (The former, and DAU is
 *     deliberately the latter — a tile that quietly did the wrong one would read live and be
 *     stale.)
 *   * is an unavailable live read distinguishable from an empty one? (Yes: a reason, not a zero.)
 *   * does the age estimate wear its one word of caveat? (`est.`, plus a ≥ when truncated.)
 *
 * Pure, like its parent: no AWS, no Electron, no clock.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAnalytics } from '../src/main/triage/analytics'
import { addDays, type FunnelRow, type InstallRow, type UsageRow } from '../src/main/triage/usageRows'
import { USAGE_METRICS } from '../src/shared/telemetryRollup'
import { liveTiles } from '../src/renderer/src/features/triage/analyticsRows'
import { renderAnalyticsDigest } from '../scripts/analyticsDigest.mjs'

/** A fixed "now", so every day key here is stable — the same anchor its parent file uses. */
const NOW = Date.UTC(2026, 7, 10, 12, 0, 0)
const TODAY = '2026-08-10'
const day = (back: number): string => addDays(TODAY, -back)

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

test('the LIVE tiles are the only ones that say "now", and they degrade to a reason', () => {
  // Unavailable is a TILE, not an omission: "CloudWatch did not answer" and "nobody is in the
  // app" are opposite facts and an absent tile would let them share a rendering.
  const dark = liveTiles({ available: false, reason: 'no credentials' })
  assert.deepEqual(dark.map((t) => [t.label, t.value]), [['Live now', '-']])
  assert.match(dark[0].note, /no credentials/)

  // Nobody alive: a zero and NO age tile. An empty fleet has no age, and a 0 there would read as
  // "everyone just arrived".
  const quiet = liveTiles({
    available: true,
    activeNow: 0,
    asOfMs: 0,
    avgAgeMs: null,
    ageIsFloor: false,
    lookbackMs: 3_600_000
  })
  assert.deepEqual(quiet.map((t) => t.value), ['0'])

  // Alive, with an age the lookback truncated: ONE word of caveat plus the ≥ that says floor.
  const busy = liveTiles({
    available: true,
    activeNow: 7,
    asOfMs: 0,
    avgAgeMs: 45 * 60_000,
    ageIsFloor: true,
    lookbackMs: 12 * 3_600_000
  })
  assert.deepEqual(busy.map((t) => t.value), ['7', '≥45 min'])
  assert.match(busy[1].note, /est\./)
  // …and no ≥ when the derivation finished inside the window.
  const settled = liveTiles({
    available: true,
    activeNow: 7,
    asOfMs: 0,
    avgAgeMs: 45 * 60_000,
    ageIsFloor: false,
    lookbackMs: 12 * 3_600_000
  })
  assert.equal(settled[1].value, '45 min')
  assert.deepEqual(liveTiles(undefined), [], 'no live read was made ⇒ no tiles at all')
})

//
// Three of the five come from the counter tables and are asserted here; the two live ones come
// from CloudWatch and are asserted in tests/liveSessions.test.mts, against the derivation.

test("'today' means the CLOCK's UTC day, not the last day with data", () => {
  // The distinction matters exactly when ingest is quiet: DAU deliberately anchors on the last
  // day anything arrived (so a backlog still reads), and an "installs today" that did the same
  // would look live and be stale. A true zero is the honest answer to a quiet morning.
  const busyYesterday = build([
    u(day(1), USAGE_METRICS.newInstalls, '-', 4),
    u(day(1), USAGE_METRICS.upgrades, '-', 9),
    u(day(1), USAGE_METRICS.activeInstalls, '-', 20)
  ]).pulse
  assert.equal(busyYesterday.dau, 20, 'DAU still reads the last day with data')
  assert.equal(busyYesterday.installsToday, 0)
  assert.equal(busyYesterday.upgradesToday, 0)

  const today = build([
    u(TODAY, USAGE_METRICS.newInstalls, '-', 2),
    u(day(1), USAGE_METRICS.newInstalls, '-', 4),
    u(TODAY, USAGE_METRICS.upgrades, '-', 7)
  ]).pulse
  assert.equal(today.installsToday, 2, 'only today, never the window')
  assert.equal(today.upgradesToday, 7)
})

test('lines parsed is a WINDOW sum, and the digest labels the re-reads', () => {
  const d = build([
    u(TODAY, USAGE_METRICS.linesParsed, '-', 120_000),
    u(day(2), USAGE_METRICS.linesParsed, '-', 30_000),
    u(day(1), USAGE_METRICS.sessions, '-', 3)
  ])
  assert.equal(d.pulse.linesParsed, 150_000)
  const text = renderAnalyticsDigest(d)
  assert.match(text, /log lines parsed 150000 in the window \(re-reads included\)/)
  assert.match(text, /today \(UTC\): 0 new install\(s\) · 0 upgrade\(s\)/)
})

test('the digest LIVE line is absent, a reason, or a number — never a silent zero', () => {
  const d = build()
  assert.equal(renderAnalyticsDigest(d).includes('live sessions'), false, 'no read ⇒ no line')
  assert.match(
    renderAnalyticsDigest(d, 'user', undefined, { available: false, reason: 'no credentials' }),
    /live sessions: \(unavailable: no credentials\)/
  )
  assert.match(
    renderAnalyticsDigest(d, 'user', undefined, {
      available: true,
      activeNow: 4,
      asOfMs: NOW,
      avgAgeMs: 40 * 60_000,
      ageIsFloor: true,
      lookbackMs: 12 * 3_600_000
    }),
    /live sessions 4 right now · avg age ≥40\.0 min est\./
  )
  // Alive but ageless cannot come out of the derivation; if it ever did, the line degrades to the
  // count alone rather than printing a fabricated zero.
  assert.match(
    renderAnalyticsDigest(d, 'user', undefined, {
      available: true,
      activeNow: 4,
      asOfMs: NOW,
      avgAgeMs: null,
      ageIsFloor: false,
      lookbackMs: 3_600_000
    }),
    /live sessions 4 right now\n/
  )
})
