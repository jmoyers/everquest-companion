// ============================================================================
// releaseHealth.test.mts — the READOUT half of JOS-96: "did I release buggy code".
// ============================================================================
//
// Three tables of counter rows plus the feedback table's per-build bug counts become an error
// rate per build, over time, read against adoption, release dates and reporting coverage.
//
// ITS PARTNER IS `tests/healthCounters.test.mts`, which covers the client that produces those
// counts, and the two halves are one argument: that suite's "report even a clean session" drain
// exists SOLELY to make this suite's "not reporting" state possible. They are two files only
// because both together are past the repo's 400-code-line ceiling — a split, not a widened
// threshold.
//
// Everything under test is pure — `src/main/triage/releaseHealth.ts`, `usageRows.ts` and the
// panel's `releaseChart.ts` — so a whole fleet is authored by hand here and the arithmetic
// asserted exactly. No AWS, no Electron, no fixtures, no clock: this suite never skips.
//
// THE ONE CLAIM IT EXISTS TO DEFEND, restated because everything below is a way of failing it:
//
//     A BUILD THAT NEVER REPORTED MUST NEVER BE READABLE AS A CLEAN ONE.
//
// Health reporting arrives in a build; every build before it sends nothing. To a SUM, "sent
// nothing" and "sent reports and found no errors" are the same absent row — so the naive version
// of this feature would render the entire back catalogue as flawless, which is the exact inverse
// of what is known about it. The fold, the builder and the chart each keep those two apart by a
// different mechanism, and each mechanism is pinned below.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAnalytics } from '../src/main/triage/analytics'
import {
  addDays,
  toBugReportRows,
  windowDays,
  type BugReportRow,
  type UsageRow
} from '../src/main/triage/usageRows'
import { USAGE_METRICS } from '../src/shared/telemetryRollup'
import { rateLabel } from '../src/renderer/src/features/triage/analyticsRows'
import {
  CHART_W,
  coverageNote,
  dayX,
  gappedPath,
  rateAxisMax,
  releaseChart
} from '../src/renderer/src/features/triage/releaseChart'
import { RELEASE_NOTES } from '../src/shared/releaseNotes'

/** A fixed "now" so every day key in this suite is stable. */
const NOW = Date.UTC(2026, 7, 10, 12, 0, 0)
const TODAY = '2026-08-10'
const day = (back: number): string => addDays(TODAY, -back)

/** A counter row. Every fixture here is the USER cohort — the readout the panel shows by default. */
const u = (d: string, metric: string, dim: string, n: number): UsageRow => ({
  day: d,
  cohort: 'user',
  metric,
  dim,
  n
})

/** A feedback bug-report count for one build. */
const bug = (appVersion: string, n: number): BugReportRow => ({ appVersion, cohort: 'user', n })

/** `buildAnalytics` over just the two sources this section needs. An options object rather than
 *  positionals: the repo's max-params is 4, and this would want five. */
const buildWith = (o: { usage?: UsageRow[]; bugReports?: BugReportRow[]; days?: number }) =>
  buildAnalytics({
    usage: o.usage ?? [],
    funnels: [],
    installs: [],
    bugReports: o.bugReports ?? [],
    windowDays: o.days ?? 30,
    nowMs: NOW
  })

test('NOT REPORTING and ZERO ERRORS are structurally different, not two renderings of one row', () => {
  // Two builds, both with users, and the difference between them is the entire feature:
  //   0.11.0 filed 20 health reports and found NOTHING wrong  -> a true, earned zero
  //   0.8.0  filed nothing at all (it predates the emitter)   -> unknown, and it must say so
  const d = buildWith({
    usage: [
      u(TODAY, USAGE_METRICS.activeInstalls, '-', 30),
      u(TODAY, USAGE_METRICS.version, '0.11.0', 20),
      u(TODAY, USAGE_METRICS.version, '0.8.0', 10),
      u(TODAY, USAGE_METRICS.healthReports, '0.11.0', 20)
    ]
  }).releaseHealth
  const clean = d.versions.find((v) => v.version === '0.11.0')
  const quiet = d.versions.find((v) => v.version === '0.8.0')
  // The clean build: reporting, a real denominator, and a rate of exactly 0.
  assert.equal(clean?.reporting, true)
  assert.equal(clean?.reports, 20)
  assert.equal(clean?.errors, 0)
  assert.equal(clean?.rate, 0)
  // The quiet build: NOT reporting, and its rate is NULL — never 0, which would read as clean.
  assert.equal(quiet?.reporting, false)
  assert.equal(quiet?.reports, 0)
  assert.equal(quiet?.rate, null)
  // And the panel's own honesty rules turn those into different glyphs: `0%` vs `—`.
  assert.equal(rateLabel(clean?.rate ?? null), '0%')
  assert.equal(rateLabel(quiet?.rate ?? null), '-')
})

test('the rate is SELF-NORMALIZING — a build with more users cannot look buggier for it', () => {
  // The whole reason `healthReports` is dimmed by version. 0.11.0 has ten times the sessions and
  // ten times the errors; the two builds are equally buggy and the rate has to say so.
  const d = buildWith({
    usage: [
      u(TODAY, USAGE_METRICS.healthReports, '0.11.0', 1_000),
      u(TODAY, USAGE_METRICS.health, '0.11.0:mainErrorLogLines', 50),
      u(TODAY, USAGE_METRICS.healthReports, '0.10.0', 100),
      u(TODAY, USAGE_METRICS.health, '0.10.0:mainErrorLogLines', 5)
    ]
  }).releaseHealth
  assert.equal(d.versions.find((v) => v.version === '0.11.0')?.rate, 0.05)
  assert.equal(d.versions.find((v) => v.version === '0.10.0')?.rate, 0.05)
  // The RAW counts still differ tenfold, which is why the raw counts are not the headline.
  assert.equal(d.versions.find((v) => v.version === '0.11.0')?.errors, 50)
})

test('the error mix per build strips its own version prefix and keeps the fields apart', () => {
  const d = buildWith({
    usage: [
      u(TODAY, USAGE_METRICS.healthReports, '0.11.0', 8),
      u(TODAY, USAGE_METRICS.health, '0.11.0:rendererCrashes', 1),
      u(TODAY, USAGE_METRICS.health, '0.11.0:mainErrorLogLines', 6),
      // Another build's rows must not leak into this one's mix.
      u(TODAY, USAGE_METRICS.health, '0.10.0:rendererCrashes', 99)
    ]
  }).releaseHealth
  const v = d.versions.find((x) => x.version === '0.11.0')
  assert.deepEqual(v?.byField, [
    { id: 'mainErrorLogLines', n: 6 },
    { id: 'rendererCrashes', n: 1 }
  ])
  assert.equal(v?.errors, 7)
})

test('a HANDLED condition is counted but never enters the rate — that number is for real faults', () => {
  // JOS-133, and the owner's decision in one assertion (2026-08-09): "real code failures in that
  // number". `imageFetchFailures` is a wiki that did not answer — 17,632 of them in 14 days,
  // roughly two thirds of every error line the fleet has ever reported — and summed into
  // `errors / healthReports` it would swamp every real signal and would move with somebody else's
  // uptime rather than with anything a release changed.
  const d = buildWith({
    usage: [
      u(TODAY, USAGE_METRICS.healthReports, '0.11.0', 100),
      u(TODAY, USAGE_METRICS.health, '0.11.0:mainErrorLogLines', 4),
      u(TODAY, USAGE_METRICS.health, '0.11.0:imageFetchFailures', 17_632),
      // …and suppressed lines DO count. They are real errors a cap withheld from the local file,
      // so excluding them would let the cap flatter a build that had started looping.
      u(TODAY, USAGE_METRICS.health, '0.11.0:suppressedErrorLines', 6)
    ]
  }).releaseHealth
  const v = d.versions.find((x) => x.version === '0.11.0')
  assert.equal(v?.errors, 10, '4 written + 6 suppressed; the 17,632 downloads are not errors')
  assert.equal(v?.rate, 0.1)
  // COUNTED, NOT HIDDEN: the mix still shows it, because an operator reading a big number and a
  // small rate on one screen is exactly who needs to be told they are different questions.
  assert.deepEqual(v?.byField, [
    { id: 'imageFetchFailures', n: 17_632 },
    { id: 'suppressedErrorLines', n: 6 },
    { id: 'mainErrorLogLines', n: 4 }
  ])
  // The per-DAY series obeys the same rule as the per-build total — two sums, one list.
  assert.equal(v?.days.find((day) => day.day === TODAY)?.errors, 10)
  assert.equal(v?.days.find((day) => day.day === TODAY)?.rate, 0.1)
})

test('release dates come from the COMMITTED notes, and an unreleased build gets null not a guess', () => {
  const d = buildWith({
    usage: [
      u(TODAY, USAGE_METRICS.version, '0.9.0', 3),
      // A build with no entry in RELEASE_NOTES — a dev build, or one newer than this copy.
      u(TODAY, USAGE_METRICS.version, '99.0.0', 1)
    ]
  }).releaseHealth
  // Pinned against the real committed table, so a note that loses its date fails here.
  assert.equal(
    d.versions.find((v) => v.version === '0.9.0')?.releaseDate,
    RELEASE_NOTES.find((n) => n.version === '0.9.0')?.date
  )
  assert.equal(d.versions.find((v) => v.version === '99.0.0')?.releaseDate, null)
})

test('COVERAGE says how much of the fleet could have told us, and is null-safe on a dead day', () => {
  // 30 actives, 20 of them on a build that reports. Coverage is 2/3 — and the reader needs that
  // number BEFORE they read the error curve, because an error curve at low coverage is a rumour.
  const d = buildWith({
    usage: [
      u(TODAY, USAGE_METRICS.activeInstalls, '-', 30),
      u(TODAY, USAGE_METRICS.version, '0.11.0', 20),
      u(TODAY, USAGE_METRICS.version, '0.8.0', 10),
      u(TODAY, USAGE_METRICS.healthReports, '0.11.0', 20)
    ]
  }).releaseHealth
  const today = d.coverage.find((c) => c.day === TODAY)
  assert.equal(today?.active, 30)
  assert.equal(today?.covered, 20)
  assert.equal(today?.share, 20 / 30)
  assert.equal(d.coverageShare, 20 / 30)
  assert.equal(d.anyReporting, true)
  // A day nobody was active is share NULL, not 0 — 0 would read as "nobody could report",
  // which is a claim about the fleet's builds rather than about an empty day.
  assert.equal(d.coverage.find((c) => c.day === day(5))?.share, null)
})

test('coverage counts a capable build on a day it filed nothing — capability is a property of the code', () => {
  // 0.11.0 reports on day 0 and nothing on day 1, but it is the same build with the same code in
  // it. Counting it as uncovered on the quiet day would say the INSTRUMENT had degraded when only
  // the traffic had, and would make coverage dip every quiet Tuesday.
  const d = buildWith({
    usage: [
      u(day(1), USAGE_METRICS.activeInstalls, '-', 10),
      u(day(1), USAGE_METRICS.version, '0.11.0', 10),
      u(TODAY, USAGE_METRICS.activeInstalls, '-', 10),
      u(TODAY, USAGE_METRICS.version, '0.11.0', 10),
      u(TODAY, USAGE_METRICS.healthReports, '0.11.0', 10)
    ]
  }).releaseHealth
  assert.equal(d.coverage.find((c) => c.day === day(1))?.share, 1)
  // …and that quiet day is still an UNKNOWN rate on the curve, which is the other half of it.
  const v = d.versions.find((x) => x.version === '0.11.0')
  assert.equal(v?.days.find((x) => x.day === day(1))?.rate, null)
  assert.equal(v?.days.find((x) => x.day === TODAY)?.rate, 0)
})

test('nothing reporting at all is its own state — an empty curve is MISSING, not flat', () => {
  const d = buildWith({
    usage: [
      u(TODAY, USAGE_METRICS.activeInstalls, '-', 12),
      u(TODAY, USAGE_METRICS.version, '0.8.0', 12)
    ]
  }).releaseHealth
  assert.equal(d.anyReporting, false)
  assert.equal(d.coverageShare, 0)
  assert.equal(d.versions[0].reporting, false)
  // The sentence the panel leads with must SAY it rather than leave the picture to imply health.
  assert.match(coverageNote(d), /MISSING, not flat/)
})

test('bug reports are their own column, count BUGS only, and are never added to the errors', () => {
  const d = buildWith({
    usage: [
      u(TODAY, USAGE_METRICS.healthReports, '0.11.0', 10),
      u(TODAY, USAGE_METRICS.health, '0.11.0:rendererCrashes', 2),
      u(TODAY, USAGE_METRICS.version, '0.8.0', 5)
    ],
    bugReports: [bug('0.11.0', 4), bug('0.8.0', 7)]
  }).releaseHealth
  const shipped = d.versions.find((v) => v.version === '0.11.0')
  assert.equal(shipped?.bugReports, 4)
  // The error count is untouched by the bug count — two different measurements, never summed.
  assert.equal(shipped?.errors, 2)
  // AND THE POINT OF THE OVERLAY: a build with NO health data still has evidence about it. Seven
  // people filed bugs from 0.8.0, which is the only thing anyone will ever know about that build.
  const quiet = d.versions.find((v) => v.version === '0.8.0')
  assert.equal(quiet?.reporting, false)
  assert.equal(quiet?.bugReports, 7)
})

test('a build known ONLY to the feedback table still gets a row — history is not shortened', () => {
  const d = buildWith({ bugReports: [bug('0.4.0', 2)] }).releaseHealth
  assert.equal(d.versions.length, 1)
  assert.equal(d.versions[0].version, '0.4.0')
  assert.equal(d.versions[0].reporting, false)
})

test('feature requests are NOT bugs, and the cohort comes from the channel like every other row', () => {
  assert.deepEqual(
    toBugReportRows([
      { app_version: '0.11.0', report_type: 'bug', channel: 'prod', n: 3 },
      // A wishlist entry is not a defect and must never be plotted as one.
      { app_version: '0.11.0', report_type: 'feature', channel: 'prod', n: 9 },
      // A dev-channel report is the author's own — `cohortForChannel`, the same rule the ingest
      // path applies to a counter row, so `ofCohort` partitions these beside the counters.
      { app_version: '0.11.0', report_type: 'bug', channel: 'dev', n: 5 }
    ]),
    [
      { appVersion: '0.11.0', cohort: 'user', n: 3 },
      { appVersion: '0.11.0', cohort: 'owner', n: 5 }
    ]
  )
  // TOTAL, like every mapper there: an unknown build groups under '?' rather than being attached
  // to a real release, and a missing type defaults to 'bug' (the table's own default — see
  // `toRow` in rows.ts).
  assert.deepEqual(toBugReportRows([{ n: 1 }]), [{ appVersion: '?', cohort: 'user', n: 1 }])
})

test('DEPLOY SKEW: an un-dimensioned healthReports row never becomes a version named "-"', () => {
  // The realistic bad case, not a hypothetical: this client ships before the ingest Lambda is
  // redeployed, so the OLD fold writes `healthReports` with dim `-`. Left in the version universe
  // that row would render as a build literally named `-` claiming to report — a fictional version
  // sitting in the coverage numerator, which is the single worst thing this section could invent.
  const d = buildWith({
    usage: [
      u(TODAY, USAGE_METRICS.activeInstalls, '-', 10),
      u(TODAY, USAGE_METRICS.version, '0.11.0', 10),
      u(TODAY, USAGE_METRICS.healthReports, '-', 10),
      u(TODAY, USAGE_METRICS.health, 'rendererCrashes', 3)
    ]
  }).releaseHealth
  assert.deepEqual(d.versions.map((v) => v.version), ['0.11.0'])
  // And the skew degrades the HONEST way: nothing it can attribute means nothing reporting, and
  // the real build shows as not-reporting until the deploy lands rather than as mysteriously fine.
  assert.equal(d.anyReporting, false)
  assert.equal(d.versions[0].reporting, false)
  assert.equal(d.versions[0].rate, null)
  assert.equal(d.coverageShare, 0)
})

test('an OLD-encoding health row is not attributed to a build it cannot name', () => {
  // A row folded by an ingest Lambda that has not yet been redeployed carries a bare field name.
  // Guessing a version for it would be an invention; it is skipped here and counted in the
  // fleet-wide Health section instead, which needs no version. Both halves asserted.
  const d = buildWith({
    usage: [
      u(TODAY, USAGE_METRICS.health, 'rendererCrashes', 5),
      u(TODAY, USAGE_METRICS.healthReports, '0.11.0', 10)
    ]
  })
  assert.equal(d.releaseHealth.versions.find((v) => v.version === '0.11.0')?.errors, 0)
  assert.deepEqual(d.health.errors, [{ id: 'rendererCrashes', n: 5 }])
})

test('empty input builds an empty section rather than throwing or omitting it', () => {
  const d = buildWith({}).releaseHealth
  assert.deepEqual(d.versions, [])
  assert.equal(d.anyReporting, false)
  assert.equal(d.coverageShare, null)
  // Coverage is still DENSE over the window — the x-axis is time even when nothing happened.
  assert.equal(d.coverage.length, 30)
})

// ---- the chart's geometry ---------------------------------------------------------------------

test('ONE TIME BASE: curves, adoption and release markers all map through the DAY INDEX', () => {
  const days = windowDays(NOW, 5)
  const d = buildWith({
    usage: [
      u(days[2], USAGE_METRICS.activeInstalls, '-', 10),
      u(days[2], USAGE_METRICS.version, '0.9.0', 10),
      u(days[2], USAGE_METRICS.healthReports, '0.9.0', 10),
      u(days[2], USAGE_METRICS.health, '0.9.0:rendererCrashes', 5)
    ],
    days: 5
  }).releaseHealth
  const geo = releaseChart(d, days)
  assert.equal(geo.days.length, 5)
  // The x for a day index is the same function the markers use — that identity IS law 9 here.
  assert.equal(dayX(0, 5), 0)
  assert.equal(dayX(4, 5), CHART_W)
  assert.equal(dayX(2, 5), CHART_W / 2)
})

test('A GAP IS NOT A ZERO: an unreported day BREAKS the path instead of drawing a floor', () => {
  // Three days: measured, unknown, measured. A polyline could only draw the middle day at SOME
  // height, and every height is a claim about a day nobody reported. So the path opens a new
  // subpath after the null — two `M`s, which is a visible hole.
  const path = gappedPath([0.5, null, 0.5], 1, 100)
  assert.equal(path.match(/M/g)?.length, 2)
  // A measured ZERO still draws — on the floor of the axis, which is the whole point: a clean
  // build must be visibly present, not absent like a build that said nothing.
  assert.ok(gappedPath([0], 1, 100).includes('M'))
  // Nothing measured at all is an EMPTY path: no line, and the legend says "not reporting".
  assert.equal(gappedPath([null, null], 1, 100), '')
})

test('a NON-REPORTING build gets no rate curve at all — the house rule, made geometric', () => {
  const days = windowDays(NOW, 3)
  const d = buildWith({
    usage: [
      u(days[1], USAGE_METRICS.activeInstalls, '-', 10),
      u(days[1], USAGE_METRICS.version, '0.8.0', 10)
    ],
    days: 3
  }).releaseHealth
  const geo = releaseChart(d, days)
  const s = geo.series.find((x) => x.version === '0.8.0')
  assert.equal(s?.reporting, false)
  assert.equal(s?.ratePath, '')
  // …but its ADOPTION curve is drawn in full, because every client has always sent `version`.
  // The two curves being different lengths IS the coverage story, drawn rather than described.
  assert.ok((s?.sharePath.length ?? 0) > 0)
})

test('a release marker outside the window is DROPPED, never clamped to an edge', () => {
  // A marker pinned to day zero reads as "this shipped at the start of the window", which for a
  // release from three months ago is a lie the chart tells confidently.
  const days = windowDays(NOW, 3)
  const d = buildWith({
    usage: [u(TODAY, USAGE_METRICS.version, '0.9.0', 1)],
    days: 3
  }).releaseHealth
  // 0.9.0's committed date is nowhere near this synthetic window.
  assert.ok(!days.includes(RELEASE_NOTES.find((n) => n.version === '0.9.0')?.date ?? ''))
  assert.deepEqual(releaseChart(d, days).markers, [])
})

test('the rate axis rounds UP to a readable ceiling and never sits below 1', () => {
  // A fleet whose worst build averages 0.2 errors per session must not get a chart where 0.2
  // looks like the top of the scale.
  assert.equal(rateAxisMax(0.2), 1)
  assert.equal(rateAxisMax(0), 1)
  assert.equal(rateAxisMax(1.4), 2)
  assert.equal(rateAxisMax(3), 5)
  assert.equal(rateAxisMax(7), 10)
  assert.equal(rateAxisMax(42), 50)
})

test('the coverage sentence leads with the WORST case and names the quiet builds', () => {
  const d = buildWith({
    usage: [
      u(TODAY, USAGE_METRICS.activeInstalls, '-', 10),
      u(TODAY, USAGE_METRICS.version, '0.11.0', 4),
      u(TODAY, USAGE_METRICS.version, '0.8.0', 6),
      u(TODAY, USAGE_METRICS.healthReports, '0.11.0', 4)
    ]
  }).releaseHealth
  const note = coverageNote(d)
  assert.match(note, /40% of install-days/)
  // It COUNTS the builds that cannot report rather than leaving the reader to spot them.
  assert.match(note, /1 build shown cannot report/)
  assert.match(note, /never zero/)
})
