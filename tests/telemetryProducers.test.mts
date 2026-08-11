/**
 * telemetryProducers.test.mts — the half of usage analytics that JOS-39 built: the code that
 * DECIDES what a producer reports, pinned without Electron and without a cluster.
 *
 * The producers themselves (src/main/session.ts, src/main/updater.ts, src/main/ipc/speech.ts) are
 * wiring: they call one of these functions at a moment in their own lifecycle, and the moment is
 * what tests/e2e/telemetry.e2e.mts asserts against the running app. What lives here is everything
 * that can be wrong ARITHMETICALLY or SEMANTICALLY:
 *
 *   * `classifyFailure` — an error message reduced to one of five words, against the REAL strings
 *     the two failure producers emit (copied from speech/provision.ts and electron-updater);
 *   * the once-ever funnel ledger's data model (`allFunnelStepMarks` + the prefs normalizer);
 *   * `linesParsed` — that the optional field survives validation, is dropped when absent, and
 *     folds into the `linesParsed` counter from BOTH events that carry it.
 *
 * Why the failure classifier gets a test of its own: it is the one place in this feature where a
 * STRING is read, and its whole job is to make sure no part of that string can leave. A wrong
 * class is also actively misleading — "12 checksum failures" sends an operator to look at a CDN —
 * so each arm is pinned against a message that really occurs, not against an invented one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyFailure, failureTextOf } from '../src/main/telemetry/failureClass'
// THE FIFTH PRODUCER — the five health counters (JOS-96) — is tested in
// `tests/releaseHealth.test.mts`, beside the readout it exists to feed, because the producer's
// "report even a clean session" decision and the panel's "not reporting" state are one argument.
// This file was also at the 400-code-line ceiling: a split, not a widened threshold.
import {
  allFunnelStepMarks,
  bucketOf,
  funnelStepMark,
  normalizeTelemetryPrefs,
  startupReplayStats,
  LOG_SIZE_BYTES_EDGES,
  MAX_COUNT,
  TELEMETRY_FUNNEL_STEPS,
  type TelemetryEvent
} from '../src/shared/telemetry'
import { validateTelemetryEvent } from '../src/shared/telemetryValidate'
import {
  blockMsBucketLabel,
  medianBucket,
  percentileBucket,
  replayMsBucketLabel,
  rollupBatch,
  BLOCK_MS_EDGES,
  DIM_NONE,
  REPLAY_MS_EDGES,
  USAGE_METRICS
} from '../src/shared/telemetryRollup'
import type { TelemetryBatch } from '../src/shared/telemetry'

// ---- the failure classifier ------------------------------------------------------------

test('every failure class is reached by a message a real producer actually emits', () => {
  // LEFT COLUMN: verbatim from src/main/speech/provision.ts and from electron-updater's own
  // failure paths (updater.ts research §6 enumerates them). RIGHT: the word the schema allows.
  const cases: [string, string][] = [
    ['kokoro-v1.0.onnx: sha256 mismatch (got abc123)', 'checksum'],
    ['sha512 checksum mismatch, expected …', 'checksum'],
    ['voices-v1.0.bin: short read, got 91234 of 92000 bytes', 'network'],
    ['HTTP 403 for kokoro-v1.0.onnx', 'network'],
    ['empty body for voices-v1.0.bin', 'network'],
    ['getaddrinfo ENOTFOUND github.com', 'network'],
    ['read ECONNRESET', 'network'],
    ['net::ERR_CERT_AUTHORITY_INVALID certificate', 'network'],
    ['could not create C:\\Users\\x\\speech\\kokoro: Error: EACCES: permission denied', 'disk'],
    ['ENOSPC: no space left on device', 'disk'],
    ['The operation was aborted due to timeout', 'timeout'],
    ['connect ETIMEDOUT 140.82.121.4:443', 'timeout'],
    ['Cannot find channel "main"', 'other'],
    ['', 'other']
  ]
  for (const [message, expected] of cases) {
    assert.equal(classifyFailure(message), expected, message)
  }
})

test('the classifier takes anything and NEVER hands the message back', () => {
  // Its return type is a five-member union, so this is a property of the signature — the test is
  // here to pin that no arm was ever "helpfully" widened to pass the text through.
  const classes = ['network', 'checksum', 'disk', 'timeout', 'other']
  for (const raw of [null, undefined, 42, {}, new Error('Primitive@Vox: ENOSPC'), ['x']]) {
    assert.ok(classes.includes(classifyFailure(raw)), JSON.stringify(raw))
  }
  // The text helper is the only thing that reads a message, and it stays on the main side.
  assert.equal(failureTextOf(new Error('boom')), 'boom')
  assert.equal(failureTextOf({ message: 'wrapped' }), 'wrapped')
  assert.equal(failureTextOf(7), '7')
})

// ---- the once-ever ledger --------------------------------------------------------------

test('the ledger can express every step of the two install funnels, and only real pairs', () => {
  // The first-run and voice-install funnels are once-ever per install; the feedback funnel is
  // per-REPORT and is deliberately NOT marked (src/main/telemetry/funnels.ts says why), but its
  // marks are still legal spellings — nothing in the ledger is funnel-specific.
  const marks = allFunnelStepMarks()
  for (const funnel of ['first-run', 'voice-install'] as const) {
    for (const step of TELEMETRY_FUNNEL_STEPS[funnel]) {
      assert.ok(marks.includes(funnelStepMark(funnel, step)), `${funnel}:${step}`)
    }
  }
  // A step of one funnel is not a step of another — the pair is what is marked, exactly as the
  // validator checks the pair rather than the step alone.
  assert.ok(!marks.includes('first-run:engineSelected'))
  assert.ok(!marks.includes('voice-install:installed'))
})

test('a mark, once written, is idempotent under the normalizer — a step cannot be re-earned', () => {
  const once = normalizeTelemetryPrefs({ funnelsDone: ['first-run:installed'] })
  const twice = normalizeTelemetryPrefs(once)
  assert.deepEqual(twice.funnelsDone, ['first-run:installed'])
  // …and the ledger is the ONLY thing that grows: enabling/disabling does not touch it, which is
  // what stops `installed` firing again after an opt-out and opt-in (collector.ts drops the id
  // and the ring on the way out; the marks are deliberately not in either).
  assert.equal(twice.analyticsId, null)
})

// ---- linesParsed -----------------------------------------------------------------------

const ID = '2b1b5c33-6a1a-4d3e-8f0b-2c9a5d1e7f40'

function batchOf(events: TelemetryEvent[]): TelemetryBatch {
  return {
    v: 1,
    env: { analyticsId: ID, appVersion: '0.6.0', channel: 'prod', platform: 'win32', tzOffsetBucket: -5 },
    events: events.map((ev) => ({ ts: 1_754_000_000_000, ev }))
  }
}

function counterOf(batch: TelemetryBatch, metric: string): number {
  return rollupBatch(batch, { firstOfDay: false, newInstall: false })
    .counters.filter((c) => c.metric === metric)
    .reduce((sum, c) => sum + c.n, 0)
}

test('linesParsed is OPTIONAL on both session reports — absent survives, present is bounded', () => {
  // ABSENT IS THE OLD CLIENT AND THE OLD SERVER AT ONCE. The field is optional precisely so that
  // a build without it validates, and so that a server whose copy of the schema predates it drops
  // the field and accepts the batch (src/shared/telemetry.ts, THE ADDITIVE-FIELD RULE) instead of
  // answering 400 — which main/telemetry/net.ts treats as permanent and would DROP the batch.
  const bare = validateTelemetryEvent({ t: 'sessionHeartbeat', uptimeMs: 300_000 })
  assert.ok(bare.ok && !('linesParsed' in bare.value))

  const carried = validateTelemetryEvent({ t: 'sessionHeartbeat', uptimeMs: 300_000, linesParsed: 4_212 })
  assert.ok(carried.ok && carried.value.t === 'sessionHeartbeat' && carried.value.linesParsed === 4_212)

  const ended = validateTelemetryEvent({
    t: 'sessionEnd',
    durationMs: 60_000,
    viewsVisited: 2,
    linesParsed: 9
  })
  assert.ok(ended.ok && ended.value.t === 'sessionEnd' && ended.value.linesParsed === 9)

  // Same ceiling as every other count, and the same refusals: negative, fractional, over-cap.
  for (const bad of [-1, 1.5, MAX_COUNT + 1, '900', Number.NaN]) {
    const out = validateTelemetryEvent({ t: 'sessionHeartbeat', uptimeMs: 1, linesParsed: bad })
    assert.ok(!out.ok && out.field === 'linesParsed', JSON.stringify(bad))
  }
  // `null` is "nothing to add", not junk — the same reading `failureClass` gives it.
  const nulled = validateTelemetryEvent({ t: 'sessionHeartbeat', uptimeMs: 1, linesParsed: null })
  assert.ok(nulled.ok && !('linesParsed' in nulled.value))
})

test('the fleet counter is a SUM OF DELTAS from both events, and an absent field adds nothing', () => {
  const rolled = batchOf([
    { t: 'sessionHeartbeat', uptimeMs: 300_000, linesParsed: 1_000 },
    { t: 'sessionHeartbeat', uptimeMs: 600_000, linesParsed: 250 },
    // A heartbeat from a session that parsed nothing (an idle log) — legal, and adds nothing.
    { t: 'sessionHeartbeat', uptimeMs: 900_000 },
    { t: 'sessionEnd', durationMs: 950_000, viewsVisited: 3, linesParsed: 17 }
  ])
  assert.equal(counterOf(rolled, USAGE_METRICS.linesParsed), 1_267)
  // The heartbeat count is untouched by the passenger field: three heartbeats, three heartbeats.
  assert.equal(counterOf(rolled, USAGE_METRICS.heartbeats), 3)
  const counters = rollupBatch(rolled, { firstOfDay: false, newInstall: false }).counters
  const lines = counters.filter((c) => c.metric === USAGE_METRICS.linesParsed)
  assert.equal(lines.length, 1, 'one dimensionless row — a per-line dimension would be a log')
  assert.equal(lines[0].dim, DIM_NONE)
})

// ---- the startup replay reading (JOS-57) -----------------------------------------------

test('the reading is BUILT, not hand-assembled: duty is computed, sizes become buckets', () => {
  // The owner's own launch, near enough: a 68 MB log, a few seconds of folding, a duty cycle that
  // rested about a third of the wall clock. Every number below is what the producer holds; the
  // constructor is the only thing that decides what any of them becomes on the wire.
  const s = startupReplayStats({
    replayMs: 6_240.7,
    eventsReplayed: 412_003,
    workMs: 4_000,
    restMs: 2_000,
    maxBlockMs: 88.6,
    blocksOver50: 3,
    logBytes: 71_000_000
  })
  assert.deepEqual(s, {
    replayMs: 6_241,
    eventsReplayed: 412_003,
    // 4000 / 6000 — the ACHIEVED duty, whole percent. Never the setting the slicer aimed at.
    dutyPct: 67,
    maxBlockMs: 89,
    blocksOver50: 3,
    // 71 MB: past the 10 MB edge, below the 100 MB one.
    logSizeBucket: 2
  })
  // A launch that folded nothing has no duty — it had no work — so 0, never a division by zero.
  assert.equal(
    startupReplayStats({
      replayMs: 4,
      eventsReplayed: 0,
      workMs: 0,
      restMs: 0,
      maxBlockMs: 0,
      blocksOver50: 0,
      logBytes: 0
    }).dutyPct,
    0
  )
})

test('THE BUCKET EDGES: a log size lands in the bucket its own edge opens, and 0 is bucket 0', () => {
  const sizeOf = (logBytes: number): number =>
    startupReplayStats({
      replayMs: 1,
      eventsReplayed: 1,
      workMs: 1,
      restMs: 0,
      maxBlockMs: 0,
      blocksOver50: 0,
      logBytes
    }).logSizeBucket
  // Half-open `[lo, hi)`: the edge value itself belongs to the bucket ABOVE it, which is what
  // `bucketOf` promises and what TELEMETRY.md prints. One assertion per edge, plus both ends.
  assert.equal(sizeOf(0), 0)
  assert.equal(sizeOf(1_048_575), 0)
  for (const [i, edge] of LOG_SIZE_BYTES_EDGES.entries()) {
    assert.equal(sizeOf(edge), i + 1, `${String(edge)} opens bucket ${String(i + 1)}`)
    assert.equal(sizeOf(edge - 1), i, `${String(edge - 1)} is still bucket ${String(i)}`)
  }
  // Past the last edge is the open top, and stays there however big the log gets.
  assert.equal(sizeOf(9_000_000_000), LOG_SIZE_BYTES_EDGES.length)
})

test('a 1.35M-line replay is reported IN FULL — MAX_COUNT is not this field’s ceiling', () => {
  // The measurement that forced `MAX_REPLAY_EVENTS`: the owner's log is already past MAX_COUNT,
  // so clamping there would report every big log as exactly one million — capping the number
  // precisely where it gets interesting.
  const s = startupReplayStats({
    replayMs: 40_000,
    eventsReplayed: 1_352_119,
    workMs: 30_000,
    restMs: 10_000,
    maxBlockMs: 120,
    blocksOver50: 41,
    logBytes: 600_000_000
  })
  assert.equal(s.eventsReplayed, 1_352_119)
  assert.ok(s.eventsReplayed > MAX_COUNT)
  // …and the wire agrees: the validator that guards the IPC boundary accepts what the producer
  // built. A producer whose own events are refused would look exactly like a fleet with no slow
  // launches, which is the failure this assertion exists to make impossible.
  const ev = validateTelemetryEvent({ t: 'sessionEnd', durationMs: 1, viewsVisited: 0, startup: s })
  assert.ok(ev.ok && ev.value.t === 'sessionEnd' && ev.value.startup?.eventsReplayed === 1_352_119)
})

test('the reading is ALL SIX FIELDS OR NONE, and absent survives an older schema', () => {
  const full = {
    replayMs: 5_000,
    eventsReplayed: 100,
    dutyPct: 80,
    maxBlockMs: 60,
    blocksOver50: 1,
    logSizeBucket: 1
  }
  const carried = validateTelemetryEvent({ t: 'sessionHeartbeat', uptimeMs: 1, startup: full })
  assert.ok(carried.ok && carried.value.t === 'sessionHeartbeat')
  assert.deepEqual(carried.value.startup, full)

  // ABSENT IS THE OLD CLIENT AND THE OLD SERVER AT ONCE — the same argument `linesParsed` makes.
  const bare = validateTelemetryEvent({ t: 'sessionHeartbeat', uptimeMs: 1 })
  assert.ok(bare.ok && !('startup' in bare.value))
  const nulled = validateTelemetryEvent({ t: 'sessionEnd', durationMs: 1, viewsVisited: 0, startup: null })
  assert.ok(nulled.ok && !('startup' in nulled.value))

  // A PARTIAL reading is refused rather than repaired: every field describes the same seconds,
  // and a duty with no wall clock beside it is uninterpretable, not merely smaller.
  for (const field of Object.keys(full)) {
    const { [field]: _dropped, ...rest } = full
    const out = validateTelemetryEvent({ t: 'sessionHeartbeat', uptimeMs: 1, startup: rest })
    assert.ok(!out.ok && out.field === `startup.${field}`, `missing ${field}`)
  }
  // …and nothing outside the schema survives the trip, however it is spelled.
  const extra = validateTelemetryEvent({
    t: 'sessionHeartbeat',
    uptimeMs: 1,
    startup: { ...full, logPath: 'C:/Users/x/eqlog_Primitive_freeport.txt' }
  })
  assert.ok(extra.ok && extra.value.t === 'sessionHeartbeat')
  assert.ok(!('logPath' in (extra.value.startup ?? {})))
  // A duty over 100% is a broken clock, not a fast fold.
  const silly = validateTelemetryEvent({
    t: 'sessionHeartbeat',
    uptimeMs: 1,
    startup: { ...full, dutyPct: 101 }
  })
  assert.ok(!silly.ok && silly.field === 'startup.dutyPct')
})

test('the fleet rollup keys the reading BY BUILD, and the launch count is its denominator', () => {
  const reading = (over: Partial<TelemetryEvent & { startup: unknown }> = {}): TelemetryEvent => ({
    t: 'sessionEnd',
    durationMs: 60_000,
    viewsVisited: 1,
    startup: {
      replayMs: 6_000,
      eventsReplayed: 400_000,
      dutyPct: 70,
      maxBlockMs: 60,
      blocksOver50: 2,
      logSizeBucket: 2
    },
    ...over
  })
  const rolled = rollupBatch(batchOf([reading(), reading()]), {
    firstOfDay: false,
    newInstall: false,
    upgraded: false
  })
  const rowOf = (metric: string, dim: string): number =>
    rolled.counters.find((c) => c.metric === metric && c.dim === dim)?.n ?? 0

  // The version comes from the ENVELOPE — no event carries one — and `batchOf` sends 0.6.0.
  assert.equal(rowOf(USAGE_METRICS.startupReplays, '0.6.0'), 2)
  // 6 s: past the 5 s edge, below 10 s ⇒ the 5-10 s bucket. 60 ms ⇒ the 50-100 ms one.
  assert.equal(rowOf(USAGE_METRICS.startupReplayMs, `0.6.0:${String(bucketOf(6_000, REPLAY_MS_EDGES))}`), 2)
  assert.equal(rowOf(USAGE_METRICS.startupBlockMs, `0.6.0:${String(bucketOf(60, BLOCK_MS_EDGES))}`), 2)
  // The sums, whose divisor is `startupReplays` at read time.
  assert.equal(rowOf(USAGE_METRICS.startupDutyPct, '0.6.0'), 140)
  assert.equal(rowOf(USAGE_METRICS.startupEventsReplayed, '0.6.0'), 800_000)
  assert.equal(rowOf(USAGE_METRICS.startupBlocksOver50, '0.6.0'), 4)
  // Log size is NOT versioned: how big a log is, is a fact about the player.
  assert.equal(rowOf(USAGE_METRICS.startupLogSize, '2'), 2)

  // BOTH carriers fold identically — which is what makes "whichever report drains it" safe.
  const viaHeartbeat = rollupBatch(
    batchOf([reading({ t: 'sessionHeartbeat', uptimeMs: 300_000 } as never)]),
    { firstOfDay: false, newInstall: false, upgraded: false }
  )
  assert.equal(
    viaHeartbeat.counters.find((c) => c.metric === USAGE_METRICS.startupReplays)?.n,
    1
  )
  // A session report with NO reading writes no startup row at all — an absent row and a zero one
  // read the same to a SUM, and "nobody measured" must not look like "everybody launched fast".
  const none = rollupBatch(batchOf([{ t: 'sessionEnd', durationMs: 1, viewsVisited: 0 }]), {
    firstOfDay: false,
    newInstall: false,
    upgraded: false
  })
  assert.ok(!none.counters.some((c) => c.metric.startsWith('startup')))
})

test('a percentile over a histogram is a BUCKET, and the median is the same function at p50', () => {
  // Ten launches: nine in bucket 2, one miserable one in bucket 6. That is exactly the shape the
  // p95 exists for — the mean would hide it and the median must not report it.
  const counts = [0, 0, 9, 0, 0, 0, 1]
  assert.equal(percentileBucket(counts, 50), 2)
  assert.equal(percentileBucket(counts, 95), 6)
  assert.equal(medianBucket(counts), percentileBucket(counts, 50))
  // An empty histogram is -1 — "nothing was measured", which every reader renders as a dash
  // rather than as a fast launch.
  assert.equal(percentileBucket([], 95), -1)
  assert.equal(percentileBucket([0, 0], 50), -1)
  // The labels are ranges, never numbers the storage never had.
  // Bucket `i` covers `[edges[i-1], edges[i])`, so bucket 4 is the 5-10 s band a slow launch on a
  // big log lands in — and the one the chunked-replay work was about.
  assert.equal(replayMsBucketLabel(0), '<250 ms')
  assert.equal(replayMsBucketLabel(4), '5 s-10 s')
  assert.equal(replayMsBucketLabel(5), '10 s-30 s')
  assert.equal(replayMsBucketLabel(REPLAY_MS_EDGES.length), '60 s+')
  assert.equal(blockMsBucketLabel(3), '50 ms-100 ms')
  assert.equal(blockMsBucketLabel(BLOCK_MS_EDGES.length), '1 s+')
})

test('a batch with no line counts at all produces NO linesParsed row, rather than a zero', () => {
  // `add()` refuses non-positive numbers, so "nobody reported any" is an ABSENT row. That is the
  // difference between a day the fleet parsed nothing and a day nobody sent anything, and the
  // read path (a SUM over rows) reads them the same way — which is correct for a counter.
  const rolled = batchOf([{ t: 'sessionHeartbeat', uptimeMs: 1 }])
  assert.equal(counterOf(rolled, USAGE_METRICS.linesParsed), 0)
  assert.ok(
    !rollupBatch(rolled, { firstOfDay: false, newInstall: false }).counters.some(
      (c) => c.metric === USAGE_METRICS.linesParsed
    )
  )
})

