/**
 * telemetryOptOut.test.mts — the opt-out notice, end to end without Electron (JOS-109).
 *
 * WHAT THIS SUITE IS FOR. The ticket's acceptance criteria are behavioural: "one event per flip,
 * then silence", "flip-flap does not double-count", "the validator accepts the kinds and refuses
 * payloads on them". None of those can be asserted against the running app cheaply, and all of
 * them are decidable from pure functions — which is exactly why the flip logic was factored into
 * `src/main/telemetry/optOut.ts` instead of living inline in `flush.ts` (which imports Electron
 * and the store, and so cannot be loaded here at all).
 *
 * THE FOUR LAYERS IT WALKS, in the order the data moves:
 *
 *   1. THE DECISION — `flipNoticeKind`: which notice, if any, a call of the switch owes. This
 *      function IS the "exactly once per flip" property.
 *   2. THE PAYLOAD — `flipNoticeBatch`: one record, one fieldless event, the envelope verbatim.
 *   3. THE GATE — `telemetryFlipNoticeEnabled`: the documented carve-out, pinned as a truth table
 *      so the three terms that DID survive it cannot be quietly dropped later.
 *   4. THE WIRE AND THE FOLD — the shared validator and `rollupBatch`, then `buildCoverage`, which
 *      is what the panel and the digest both read.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT: that `applyTelemetryEnabled` calls these in the right
 * order. That is `flush.ts`, it needs Electron, and `tests/e2e/telemetry.e2e.mts` drives the real
 * switch in the real app. What lives here is everything that can be wrong ARITHMETICALLY or
 * SEMANTICALLY — the split `telemetryProducers.test.mts` already makes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  flipNoticeBatch,
  flipNoticeKind,
  telemetryFlipNoticeEnabled
} from '../src/main/telemetry/optOut'
import { telemetryFlushEnabled } from '../src/main/telemetry/net'
import {
  DEFAULT_TELEMETRY_PREFS,
  TELEMETRY_API_VERSION,
  TELEMETRY_FLIP_KINDS,
  type TelemetryBatch,
  type TelemetryEnvelope,
  type TelemetryPrefs
} from '../src/shared/telemetry'
import { validateTelemetryBatch, validateTelemetryEvent } from '../src/shared/telemetryValidate'
import { DIM_NONE, rollupBatch, USAGE_METRICS } from '../src/shared/telemetryRollup'
import { buildCoverage } from '../src/main/triage/coverage'
import type { InstallRow, UsageRow } from '../src/main/triage/usageRows'

const ENV: TelemetryEnvelope = {
  analyticsId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  appVersion: '0.13.0',
  channel: 'prod',
  platform: 'win32',
  tzOffsetBucket: -5
}

const prefs = (patch: Partial<TelemetryPrefs> = {}): TelemetryPrefs => ({
  ...DEFAULT_TELEMETRY_PREFS,
  noticeShown: true,
  analyticsId: ENV.analyticsId,
  ...patch
})

const URL = 'https://example.invalid/v1/telemetry'

// ---- 1. the decision: exactly once per flip ------------------------------------------------

test('a FLIP emits one notice; writing the switch to the value it already holds emits none', () => {
  assert.equal(flipNoticeKind(true, false), 'optOut')
  assert.equal(flipNoticeKind(false, true), 'optIn')
  // THE NO-OP CASE IS THE ONE THAT MATTERS. Answering the first-run notice with "keep it" applies
  // `true` to an install that is already on, and the Preferences toggle can be re-asserted by any
  // future caller. Counting those would measure how often the switch is WRITTEN, not how many
  // people left.
  assert.equal(flipNoticeKind(true, true), null)
  assert.equal(flipNoticeKind(false, false), null)
})

test('FLIP OFF then silence: every further "off" owes nothing', () => {
  // The acceptance criterion, spelled as a sequence. One flip, one notice; the switch is then
  // asserted off twice more (a re-render, a second click, a resumed session) and nothing is owed.
  let on = true
  const emitted: string[] = []
  for (const want of [false, false, false]) {
    const kind = flipNoticeKind(on, want)
    if (kind !== null) emitted.push(kind)
    on = want
  }
  assert.deepEqual(emitted, ['optOut'])
})

test('FLIP-FLAP is counted honestly, not de-duplicated: off/on/off is two outs and one in', () => {
  // Deliberately NOT collapsed. Two people leaving once and one person leaving twice are
  // different facts about the switch, and this pipeline counts ACTIONS; guessing at intent would
  // be the invention. `telemetryRollup.ts` states the same rule at the metric.
  let on = true
  const emitted: string[] = []
  for (const want of [false, true, false]) {
    const kind = flipNoticeKind(on, want)
    if (kind !== null) emitted.push(kind)
    on = want
  }
  assert.deepEqual(emitted, ['optOut', 'optIn', 'optOut'])
})

// ---- 2. the payload: envelope facts only ---------------------------------------------------

test('the notice is ONE record carrying ONE fieldless event, and the envelope verbatim', () => {
  const batch = flipNoticeBatch('optOut', ENV, 1_700_000_000_000)
  assert.equal(batch.v, TELEMETRY_API_VERSION)
  assert.deepEqual(batch.env, ENV)
  assert.equal(batch.events.length, 1)
  assert.deepEqual(batch.events[0], { ts: 1_700_000_000_000, ev: { t: 'optOut' } })
  // THE PROMISE THE SHAPE KEEPS: "envelope facts only, no payload". Asserted on the KEYS rather
  // than by eye, so a future field on either event fails here before it can reach the wire.
  assert.deepEqual(Object.keys(batch.events[0].ev), ['t'])
})

test('the notice a real flush would send passes the SERVER validator unchanged', () => {
  for (const kind of TELEMETRY_FLIP_KINDS) {
    const batch = flipNoticeBatch(kind, ENV, 1_700_000_000_000)
    const res = validateTelemetryBatch(JSON.parse(JSON.stringify(batch)) as unknown)
    assert.equal(res.ok, true, kind)
    if (res.ok) assert.deepEqual(res.value, batch)
  }
})

// ---- 3. the gate: the carve-out, and the three terms that survived it -----------------------

test('THE CARVE-OUT: the notice may send while the switch is OFF, and only that term is waived', () => {
  const off = prefs({ enabled: false, analyticsId: null })
  // The whole reason this predicate exists: the flush gate refuses an opted-out install…
  assert.equal(telemetryFlushEnabled(false, URL, off), false)
  // …and the notice gate does not, because the message IS that the switch went off.
  assert.equal(telemetryFlipNoticeEnabled(false, URL, off), true)
})

test('…and the other three terms are all still fatal on their own', () => {
  const off = prefs({ enabled: false, analyticsId: null })
  // e2e: the headless harness never sends. Unchanged from the flush gate (plan T7).
  assert.equal(telemetryFlipNoticeEnabled(true, URL, off), false)
  // no endpoint: a dark build has nowhere to send a farewell either.
  assert.equal(telemetryFlipNoticeEnabled(false, '', off), false)
  // NOT BEFORE THE NOTICE HAS RENDERED, and this is the term that keeps "opt-out never means
  // sent before you were told" true even for this event. `answerNotice` marks the notice shown
  // BEFORE it applies the switch, so a first-run decline is countable; a switch flipped before
  // any notice rendered sends nothing at all.
  assert.equal(telemetryFlipNoticeEnabled(false, URL, prefs({ noticeShown: false })), false)
})

// ---- 4a. the wire: accepted, and payload-free by construction -------------------------------

test('the validator accepts both kinds and REFUSES A PAYLOAD ON THEM, by construction', () => {
  for (const kind of TELEMETRY_FLIP_KINDS) {
    const res = validateTelemetryEvent({
      t: kind,
      // Everything a caller might try to smuggle onto a flip: a session length, a count, and the
      // one thing this schema exists to keep out.
      durationMs: 90_000,
      count: 7,
      characterName: 'Primitive',
      reason: "didn't like it"
    })
    assert.equal(res.ok, true, kind)
    if (!res.ok) continue
    // NOT "stripped" — never constructed. The validators build a value field by field from the
    // schema, and these two have no fields, so there is nothing for a payload to be built into.
    assert.deepEqual(res.value, { t: kind })
    assert.deepEqual(Object.keys(res.value), ['t'])
  }
})

// ---- 4b. the fold: a flip counter, dimmed by the build it happened on ------------------------

const ctx = { firstOfDay: false, newInstall: false, upgraded: false }

const counter = (batch: TelemetryBatch, metric: string): { dim: string; n: number }[] =>
  rollupBatch(batch, ctx)
    .counters.filter((c) => c.metric === metric)
    .map((c) => ({ dim: c.dim, n: c.n }))

test('one optOut folds to ONE optOuts row, dimmed by the build that was running', () => {
  const batch = flipNoticeBatch('optOut', ENV, 1)
  assert.deepEqual(counter(batch, USAGE_METRICS.optOuts), [{ dim: '0.13.0', n: 1 }])
  assert.deepEqual(counter(batch, USAGE_METRICS.optIns), [])
  // …and NOTHING ELSE. A flip has no payload to fold, so a batch carrying one produces exactly
  // one row (the envelope facts ride only on `firstOfDay`, which is false here).
  assert.equal(rollupBatch(batch, ctx).counters.length, 1)
  assert.deepEqual(rollupBatch(batch, ctx).funnels, [])
  assert.deepEqual(rollupBatch(batch, ctx).errors, [])
})

test('optIn folds to its own metric and is never netted against optOut', () => {
  const batch = flipNoticeBatch('optIn', ENV, 1)
  assert.deepEqual(counter(batch, USAGE_METRICS.optIns), [{ dim: '0.13.0', n: 1 }])
  assert.deepEqual(counter(batch, USAGE_METRICS.optOuts), [])
})

test('two flips on two builds are two rows — the dim is the version, not a shared bucket', () => {
  const batch: TelemetryBatch = {
    v: TELEMETRY_API_VERSION,
    env: ENV,
    events: [
      { ts: 1, ev: { t: 'optOut' } },
      { ts: 2, ev: { t: 'optOut' } }
    ]
  }
  // Same envelope ⇒ same dim ⇒ ONE row of 2. The version is an envelope fact, so a batch cannot
  // carry flips from two builds; two builds means two batches, which is what the panel sees.
  assert.deepEqual(counter(batch, USAGE_METRICS.optOuts), [{ dim: '0.13.0', n: 2 }])
})

// ---- 4c. the readout ------------------------------------------------------------------------

const u = (metric: string, dim: string, n: number): UsageRow => ({
  day: '2026-08-08',
  cohort: 'user',
  metric,
  dim,
  n
})

const install = (appVersion = '0.13.0'): InstallRow => ({
  firstSeenDay: '2026-08-01',
  lastSeenDay: '2026-08-08',
  daysSeen: 3,
  appVersion,
  channel: 'prod',
  cohort: 'user'
})

test('buildCoverage totals the flips, splits them per build, and never nets them', () => {
  const c = buildCoverage(
    [
      u(USAGE_METRICS.optOuts, '0.13.0', 4),
      u(USAGE_METRICS.optOuts, '0.12.0', 1),
      u(USAGE_METRICS.optIns, '0.13.0', 2)
    ],
    [install(), install(), install('0.12.0')]
  )
  assert.equal(c.optOuts, 5)
  assert.equal(c.optIns, 2)
  assert.equal(c.reportingInstalls, 3)
  assert.equal(c.anyFlips, true)
  // Newest build first, and BOTH numbers on every row: there is no field on this shape that could
  // hold "net opt-outs", because that number does not describe anything.
  assert.deepEqual(c.byVersion, [
    { version: '0.13.0', optOuts: 4, optIns: 2 },
    { version: '0.12.0', optOuts: 1, optIns: 0 }
  ])
})

test('NO FLIPS is an ambiguous absence, and the shape says so rather than implying a zero', () => {
  // `anyFlips: false` is the flag the panel renders as a sentence. It cannot be strengthened:
  // nothing emits a per-version "this build could have told you" signal (there is no
  // `healthReports` equivalent for a flip), so "nobody left" and "no client new enough" are the
  // same absence and the readout must not pick one.
  const c = buildCoverage([u(USAGE_METRICS.sessions, DIM_NONE, 12)], [install()])
  assert.equal(c.anyFlips, false)
  assert.deepEqual(c.byVersion, [])
  assert.equal(c.optOuts, 0)
  // …and the reporting base is still real, which is what makes the estimate half renderable.
  assert.equal(c.reportingInstalls, 1)
})

test('an undimensioned flip row from a stale ingest is NOT rendered as a build called "-"', () => {
  // The deploy-skew guard `buildReleaseHealth` applies to `healthReports`, for the same reason: a
  // Lambda that wrote these metrics without the version dim must not produce a version row.
  const c = buildCoverage([u(USAGE_METRICS.optOuts, DIM_NONE, 3)], [install()])
  assert.deepEqual(c.byVersion, [])
  // The TOTAL still counts it — the flip happened, we just cannot attribute it to a build.
  assert.equal(c.optOuts, 3)
  assert.equal(c.anyFlips, true)
})

test('the per-build table is capped, so a year of releases is not a table nobody reads', () => {
  const rows = Array.from({ length: 12 }, (_, i) => u(USAGE_METRICS.optOuts, `0.${String(i)}.0`, 1))
  const c = buildCoverage(rows, [])
  assert.equal(c.byVersion.length, 8)
  assert.equal(c.byVersion[0].version, '0.11.0', 'newest first')
  // The cap is on the TABLE, never on the total: 12 flips are 12 flips.
  assert.equal(c.optOuts, 12)
})

test('an empty fleet renders zeros rather than throwing — every builder here is total', () => {
  const c = buildCoverage([], [])
  assert.deepEqual(c, {
    reportingInstalls: 0,
    optOuts: 0,
    optIns: 0,
    byVersion: [],
    anyFlips: false
  })
})
