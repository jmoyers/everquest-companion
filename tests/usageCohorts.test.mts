// The USER/OWNER SPLIT of usage analytics — the owner's own use, separated rather than deleted.
//
// A sibling of tests/usageAnalytics.test.mts (which owns the arithmetic of ONE readout) rather
// than more tests inside it: that file was at the repo's 400-code-line ceiling and a split is
// the answer to that here, as everywhere else. This one owns exactly one claim.
//
// THE CLAIM: the owner's rows are PARTITIONED OUT, not subtracted and not dropped.
//
//   * PARTITIONED, NOT SUBTRACTED. Each cohort's readout is built from its own rows, so neither
//     cohort's sessions can become the other's denominator. That is the specific way "just
//     filter mine out" goes wrong when it is implemented as an adjustment at the end: the counts
//     move and the RATES do not.
//   * NOT DROPPED. Both halves together are the whole. The owner drives this build harder than
//     anyone and that data is worth reading — it is simply worth reading SEPARATELY.
//   * NEVER SUMMED. There is no code path anywhere that adds two cohorts together, and the
//     digest names its cohort in the header of every single render so a reader cannot mistake
//     one for the total.
//
// Pure, like its sibling: authored rows in, asserted numbers out. No AWS, no clock, no skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAnalytics } from '../src/main/triage/analytics'
import {
  addDays,
  anyOwner,
  ofCohort,
  type InstallRow,
  type UsageRow
} from '../src/main/triage/usageRows'
import { USAGE_METRICS, type UsageCohort } from '../src/shared/telemetryRollup'
import { renderAnalyticsDigest } from '../scripts/analyticsDigest.mjs'

const NOW = Date.UTC(2026, 7, 10, 12, 0, 0)
const TODAY = '2026-08-10'
const day = (back: number): string => addDays(TODAY, -back)

const row = (cohort: UsageCohort, metric: string, dim: string, n: number): UsageRow => ({
  day: TODAY,
  cohort,
  metric,
  dim,
  n
})

const install = (cohort: UsageCohort): InstallRow => ({
  firstSeenDay: day(3),
  lastSeenDay: TODAY,
  daysSeen: 1,
  appVersion: '0.2.0',
  channel: cohort === 'owner' ? 'dev' : 'prod',
  cohort
})

const build = (usage: UsageRow[] = [], installs: InstallRow[] = []): ReturnType<typeof buildAnalytics> =>
  buildAnalytics({ usage, funnels: [], installs, windowDays: 30, nowMs: NOW })

test('ofCohort PARTITIONS: neither side sees the other’s rows, and nothing is dropped', () => {
  const rows = [
    row('user', USAGE_METRICS.sessions, '-', 3),
    row('owner', USAGE_METRICS.sessions, '-', 40)
  ]
  assert.deepEqual(ofCohort(rows, 'user'), [rows[0]])
  assert.deepEqual(ofCohort(rows, 'owner'), [rows[1]])
  // Both halves together are the whole — the owner's rows are KEPT, just not counted here.
  assert.equal(ofCohort(rows, 'user').length + ofCohort(rows, 'owner').length, rows.length)
  assert.equal(anyOwner(rows), true)
  assert.equal(anyOwner(ofCohort(rows, 'user')), false)
})

test('a cohort’s rates use ITS OWN denominators — the owner is not in the user’s per-session', () => {
  // The owner plays hard: 40 sessions, 400 map opens. The users: 4 sessions, 4 map opens.
  const all = [
    row('user', USAGE_METRICS.sessions, '-', 4),
    row('user', USAGE_METRICS.featureUse, 'mapOpen', 4),
    row('owner', USAGE_METRICS.sessions, '-', 40),
    row('owner', USAGE_METRICS.featureUse, 'mapOpen', 400)
  ]
  const users = build(ofCohort(all, 'user'))
  const owner = build(ofCohort(all, 'owner'))
  assert.equal(users.pulse.sessions, 4)
  assert.equal(users.adoption.features[0]?.perSession, 1, 'users open one map per session')
  assert.equal(owner.pulse.sessions, 40)
  assert.equal(owner.adoption.features[0]?.perSession, 10, 'the owner opens ten')
  // Summed, this population reports 10 maps per session — one person's habit wearing the
  // fleet's name. That number appears nowhere, and this is the assertion that says so.
  assert.notEqual(users.adoption.features[0]?.perSession, (4 + 400) / (4 + 40))
})

test('the population splits too — an owner install is not in the user cohort’s WAU or cohorts', () => {
  const installs = [install('user'), install('owner')]
  assert.equal(build([], ofCohort(installs, 'user')).pulse.installsTotal, 1)
  assert.equal(build([], ofCohort(installs, 'owner')).pulse.installsTotal, 1)
  assert.equal(build([], ofCohort(installs, 'user')).retention[0]?.installs, 1)
})

test('an empty owner cohort is honest zeros, exactly like an empty window — never a crash', () => {
  const owner = build(ofCohort([row('user', USAGE_METRICS.sessions, '-', 3)], 'owner'))
  assert.equal(owner.empty, true)
  assert.equal(owner.pulse.sessions, 0)
  assert.equal(owner.pulse.medianSessionLabel, null)
})

test('every digest NAMES its cohort, and says the split is from-marking-onward', () => {
  const user = renderAnalyticsDigest(build(), 'user')
  assert.match(user, /COHORT: user - your own use is EXCLUDED/)
  assert.match(user, /from-marking-onward/i)
  const owner = renderAnalyticsDigest(build(), 'owner')
  assert.match(owner, /COHORT: owner - YOUR OWN USE/)
  assert.match(owner, /never added/)
  // The DEFAULT is the population question: a bare call must not silently include the owner.
  assert.equal(renderAnalyticsDigest(build()), user)
})
