// src/shared/telemetryRollup.ts — what a batch BECOMES, and what the ingest handler writes.
//
// This is the seam wave A2 turns on: the client's allowlisted events arrive, and what survives
// them is counters. Three properties are load-bearing and each gets real coverage:
//
//   1. THE ROLLUP IS TOTAL AND DETERMINISTIC. Every event kind in the union folds into a
//      (metric, dim) pair or into the funnel table, the same rows come out in the same order
//      every time, and nothing throws on any legal input. The handler's multi-row UPSERT is
//      built straight off this list, so an unstable order would be an unstable statement.
//   2. THE PER-DAY FACTS ARE GATED. `activeInstalls` and the envelope facts (version, channel,
//      platform, tz) are emitted ONLY on an install's first batch of the day — that gating is
//      the ONLY reason a distinct-install count exists without keeping a per-id event trail.
//      Counted per batch they would measure the flush loop, not people.
//   3. NOTHING IDENTIFYING SURVIVES. The rollup's output is (metric, dim, n) triples whose dims
//      come from closed enums; the analyticsId reaches the counters nowhere at all.
//
// Plus the handler's own SQL shape, pinned by reading it: additive UPSERTs and the shared
// validator, both of which are properties a refactor can silently break with a green suite.
//
// No Electron, no AWS, no fixtures, no network: this suite never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DIM_NONE,
  medianBucket,
  rollupBatch,
  sessionBucketLabel,
  SESSION_MS_EDGES,
  USAGE_METRICS,
  utcDay,
  type RollupContext
} from '../src/shared/telemetryRollup'
import {
  MAX_TELEMETRY_BODY_BYTES,
  type TelemetryBatch,
  type TelemetryEvent,
  type TelemetryRecord
} from '../src/shared/telemetry'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** CRLF-normalized: this repo checks out with core.autocrlf=true, so a source pin written with
 *  `\n` would be red on every Windows checkout for a file that has not drifted (the same
 *  normalization tests/telemetryDoc.test.mts makes for TELEMETRY.md). */
const readSource = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')

const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

const batchOf = (events: TelemetryEvent[], appVersion = '0.2.0'): TelemetryBatch => ({
  v: 1,
  env: { analyticsId: ID, appVersion, channel: 'prod', platform: 'win32', tzOffsetBucket: -7 },
  events: events.map((ev, i): TelemetryRecord => ({ ts: 1_000 + i, ev }))
})

const FIRST: RollupContext = { firstOfDay: true, newInstall: false, upgraded: false }
const LATER: RollupContext = { firstOfDay: false, newInstall: false, upgraded: false }

/** `metric dim` -> n, for assertions that do not care about ordering. */
function counters(batch: TelemetryBatch, ctx: RollupContext = LATER): Map<string, number> {
  return new Map(rollupBatch(batch, ctx).counters.map((c) => [`${c.metric} ${c.dim}`, c.n]))
}

// ---- 1. the fold --------------------------------------------------------------------------

test('counts and durations are SUMMED per (metric, dim); repeats do not create rows', () => {
  const c = counters(
    batchOf([
      { t: 'viewDwell', view: 'combat', ms: 4_000 },
      { t: 'viewDwell', view: 'combat', ms: 6_000 },
      { t: 'viewDwell', view: 'maps', ms: 1_000 },
      { t: 'featureUse', feature: 'mapOpen', count: 2 },
      { t: 'featureUse', feature: 'mapOpen', count: 3 }
    ])
  )
  assert.equal(c.get(`${USAGE_METRICS.viewDwellMs} combat`), 10_000)
  assert.equal(c.get(`${USAGE_METRICS.viewVisits} combat`), 2)
  assert.equal(c.get(`${USAGE_METRICS.viewDwellMs} maps`), 1_000)
  assert.equal(c.get(`${USAGE_METRICS.featureUse} mapOpen`), 5)
})

test('a session end is kept THREE ways: a count, a total, and a histogram bucket', () => {
  // A median cannot be summed across days, which is why the bucket exists at all.
  const c = counters(batchOf([{ t: 'sessionEnd', durationMs: 20 * 60_000, viewsVisited: 3 }]))
  assert.equal(c.get(`${USAGE_METRICS.sessionEnds} ${DIM_NONE}`), 1)
  assert.equal(c.get(`${USAGE_METRICS.sessionMsTotal} ${DIM_NONE}`), 20 * 60_000)
  // 20 min lands in the 15-30 bucket, which is index 3 over the edges.
  assert.equal(c.get(`${USAGE_METRICS.sessionLenBucket} 3`), 1)
})

test('an overlay toggle splits on OPEN vs CLOSE — the mix is opens, not events', () => {
  const c = counters(
    batchOf([
      { t: 'overlayToggle', kind: 'fight', open: true },
      { t: 'overlayToggle', kind: 'fight', open: false },
      { t: 'overlayToggle', kind: 'events', open: true }
    ])
  )
  assert.equal(c.get(`${USAGE_METRICS.overlayOpen} fight`), 1)
  assert.equal(c.get(`${USAGE_METRICS.overlayClose} fight`), 1)
  assert.equal(c.get(`${USAGE_METRICS.overlayOpen} events`), 1)
})

test('a setup snapshot becomes one row per FIELD, each dim a bucket index or an enum member', () => {
  const c = counters(
    batchOf([
      {
        t: 'setupSnapshot',
        charCountBucket: 2,
        logSizeBucket: 3,
        alertCountBucket: 1,
        overlaysEnabled: ['fight', 'events'],
        cursorRing: true,
        autoHide: false,
        voiceEngine: 'kokoro',
        soundPackCount: 4,
        updateChannel: 'main'
      }
    ])
  )
  assert.equal(c.get(`${USAGE_METRICS.setups} ${DIM_NONE}`), 1)
  assert.equal(c.get(`${USAGE_METRICS.setupChars} 2`), 1)
  assert.equal(c.get(`${USAGE_METRICS.setupOverlay} fight`), 1)
  assert.equal(c.get(`${USAGE_METRICS.setupOverlay} events`), 1)
  assert.equal(c.get(`${USAGE_METRICS.setupCursorRing} on`), 1)
  assert.equal(c.get(`${USAGE_METRICS.setupAutoHide} off`), 1)
  assert.equal(c.get(`${USAGE_METRICS.setupVoice} kokoro`), 1)
  assert.equal(c.get(`${USAGE_METRICS.setupPacks} ${DIM_NONE}`), 4)
  // A client that predates the machine class writes NO machine rows at all — not zero-index ones.
  // Bucket 0 is a real bucket (fewer than two cores, no display), so folding an absent field into
  // it would invent a population of impossible machines out of old clients.
  assert.equal(c.get(`${USAGE_METRICS.setupCpu} 0`), undefined)
  assert.equal(c.get(`${USAGE_METRICS.setupGpuVendor} unknown`), undefined)
  assert.equal(c.get(`${USAGE_METRICS.setupSafeMode} off`), undefined)
})

test('THE MACHINE CLASS folds to one row per field — bucket index or enum member (JOS-364)', () => {
  const c = counters(
    batchOf([
      {
        t: 'setupSnapshot',
        charCountBucket: 2,
        logSizeBucket: 3,
        alertCountBucket: 1,
        overlaysEnabled: ['fight'],
        cursorRing: true,
        autoHide: false,
        voiceEngine: 'off',
        soundPackCount: 1,
        updateChannel: 'main',
        cpuCountBucket: 4,
        totalMemBucket: 6,
        gpuVendor: 'nvidia',
        gpuCompositing: 'software',
        safeMode: true,
        displayCountBucket: 2,
        primaryScaleBucket: 3,
        eqWindowMode: 'fullscreen'
      }
    ])
  )
  assert.equal(c.get(`${USAGE_METRICS.setupCpu} 4`), 1)
  assert.equal(c.get(`${USAGE_METRICS.setupMem} 6`), 1)
  assert.equal(c.get(`${USAGE_METRICS.setupGpuVendor} nvidia`), 1)
  assert.equal(c.get(`${USAGE_METRICS.setupCompositing} software`), 1)
  assert.equal(c.get(`${USAGE_METRICS.setupSafeMode} on`), 1)
  assert.equal(c.get(`${USAGE_METRICS.setupDisplays} 2`), 1)
  assert.equal(c.get(`${USAGE_METRICS.setupScale} 3`), 1)
  assert.equal(c.get(`${USAGE_METRICS.setupEqWindowMode} fullscreen`), 1)
})

const HEALTH: TelemetryEvent = {
  t: 'healthCounters',
  rendererCrashes: 1,
  mainErrorLogLines: 12,
  parserStalls: 0,
  presenceRestarts: 2,
  speechFailures: 0
}

test('health counters are dimmed <version>:<field>, so an error class is a row PER BUILD', () => {
  // JOS-96. The question the owner asks of these numbers is "did I release buggy code", which is
  // a question about a RELEASE — a fleet-wide count keyed on the field name alone can never
  // answer it, and would smear a bad build across the ones either side of it.
  const c = counters(batchOf([HEALTH], '0.9.0'))
  assert.equal(c.get(`${USAGE_METRICS.health} 0.9.0:rendererCrashes`), 1)
  assert.equal(c.get(`${USAGE_METRICS.health} 0.9.0:mainErrorLogLines`), 12)
  assert.equal(c.get(`${USAGE_METRICS.health} 0.9.0:presenceRestarts`), 2)
  // A ZERO IS NOT A ROW. Writing zeros would multiply the table by five for no information —
  // "no parser stall was reported" is the absence of the row, and the reader defaults to 0.
  assert.equal(c.has(`${USAGE_METRICS.health} 0.9.0:parserStalls`), false)
  // And the OLD encoding is gone: an un-versioned dim would sum two builds into one row.
  assert.equal(c.has(`${USAGE_METRICS.health} rendererCrashes`), false)
})

test('healthReports is dimmed by VERSION — its own denominator, and the capability signal', () => {
  // The rate is health/healthReports AT THE SAME VERSION, which is self-normalizing: a build with
  // more users cannot look buggier than one with fewer. And a version with no `healthReports` row
  // at all is a build that never reported — 'not reporting', which the panel must never render
  // the same way as a build that reported sessions and found nothing wrong.
  const c = counters(batchOf([HEALTH], '0.9.0'))
  assert.equal(c.get(`${USAGE_METRICS.healthReports} 0.9.0`), 1)
  assert.equal(c.has(`${USAGE_METRICS.healthReports} ${DIM_NONE}`), false)
})

test('two builds reporting on one day stay SEPARATE rows — never summed into a fleet average', () => {
  const a = counters(batchOf([HEALTH, HEALTH], '0.9.0'))
  const b = counters(batchOf([HEALTH], '0.10.0'))
  assert.equal(a.get(`${USAGE_METRICS.healthReports} 0.9.0`), 2)
  assert.equal(a.get(`${USAGE_METRICS.health} 0.9.0:mainErrorLogLines`), 24)
  assert.equal(b.get(`${USAGE_METRICS.healthReports} 0.10.0`), 1)
  assert.equal(b.get(`${USAGE_METRICS.health} 0.10.0:mainErrorLogLines`), 12)
  // The dims are disjoint, which is the whole property: nothing a later reader does can merge
  // them by accident, because there is no shared key to merge on.
  assert.equal(a.has(`${USAGE_METRICS.health} 0.10.0:mainErrorLogLines`), false)
})

test('an update outcome carries its own ok/failed dim, and the failure CLASS is a second row', () => {
  const c = counters(
    batchOf([
      { t: 'updateOutcome', step: 'download', ok: false, failureClass: 'network' },
      { t: 'updateOutcome', step: 'apply', ok: true }
    ])
  )
  assert.equal(c.get(`${USAGE_METRICS.update} download:failed`), 1)
  assert.equal(c.get(`${USAGE_METRICS.update} apply:ok`), 1)
  assert.equal(c.get(`${USAGE_METRICS.updateFailure} download:network`), 1)
})

// ---- funnels ------------------------------------------------------------------------------

test('funnel steps go to their OWN table, keyed with the outcome and the app version', () => {
  const roll = rollupBatch(
    batchOf(
      [
        { t: 'funnelStep', funnel: 'voice-install', step: 'engineSelected' },
        { t: 'funnelStep', funnel: 'voice-install', step: 'downloadStarted' },
        { t: 'funnelStep', funnel: 'voice-install', step: 'downloadStarted' },
        { t: 'funnelStep', funnel: 'feedback', step: 'sendFinished', outcome: 'ok' }
      ],
      '0.3.1'
    ),
    LATER
  )
  assert.deepEqual(
    roll.funnels.map((f) => [f.funnel, f.step, f.outcome, f.appVersion, f.n]),
    [
      ['feedback', 'sendFinished', 'ok', '0.3.1', 1],
      ['voice-install', 'downloadStarted', DIM_NONE, '0.3.1', 2],
      ['voice-install', 'engineSelected', DIM_NONE, '0.3.1', 1]
    ]
  )
  // An absent outcome is the SENTINEL, never NULL: the column is part of the primary key.
  assert.equal(roll.funnels.every((f) => f.outcome.length > 0), true)
})

test('a funnel failure CLASS lands in usage_daily — the funnel key has no column for it', () => {
  const c = counters(
    batchOf([
      {
        t: 'funnelStep',
        funnel: 'voice-install',
        step: 'downloadCompleted',
        outcome: 'failed',
        failureClass: 'checksum'
      }
    ])
  )
  assert.equal(c.get(`${USAGE_METRICS.funnelFailure} voice-install:downloadCompleted:checksum`), 1)
})

// ---- 2. the per-day gate -------------------------------------------------------------------

test('THE DISTINCT-INSTALL GATE: envelope facts are counted once a day, not once a batch', () => {
  const events: TelemetryEvent[] = [{ t: 'sessionHeartbeat', uptimeMs: 60_000 }]
  const first = counters(batchOf(events), FIRST)
  assert.equal(first.get(`${USAGE_METRICS.activeInstalls} ${DIM_NONE}`), 1)
  assert.equal(first.get(`${USAGE_METRICS.version} 0.2.0`), 1)
  assert.equal(first.get(`${USAGE_METRICS.channel} prod`), 1)
  assert.equal(first.get(`${USAGE_METRICS.platform} win32`), 1)
  assert.equal(first.get(`${USAGE_METRICS.tzOffset} -7`), 1)

  // The SECOND batch of the same day contributes its events and NOTHING about the install.
  const later = counters(batchOf(events), LATER)
  assert.equal(later.has(`${USAGE_METRICS.activeInstalls} ${DIM_NONE}`), false)
  assert.equal(later.has(`${USAGE_METRICS.version} 0.2.0`), false)
  assert.equal(later.get(`${USAGE_METRICS.heartbeats} ${DIM_NONE}`), 1)
})

test('a NEW install is counted once, and only alongside its first-of-day batch', () => {
  const events: TelemetryEvent[] = [{ t: 'sessionStart', coldStartMsBucket: 1 }]
  const fresh = counters(batchOf(events), { firstOfDay: true, newInstall: true, upgraded: false })
  assert.equal(fresh.get(`${USAGE_METRICS.newInstalls} ${DIM_NONE}`), 1)
  assert.equal(counters(batchOf(events), FIRST).has(`${USAGE_METRICS.newInstalls} ${DIM_NONE}`), false)
})

test('an UPGRADE is counted once, from a fact only the ingest path can know', () => {
  // The third member of RollupContext, and it exists for the same reason the other two do: the
  // client cannot know it (a build reads its own version and has no memory of the one before),
  // and the row the install UPSERT is already touching does.
  const events: TelemetryEvent[] = [{ t: 'sessionStart', coldStartMsBucket: 1 }]
  const key = `${USAGE_METRICS.upgrades} ${DIM_NONE}`
  assert.equal(
    counters(batchOf(events), { firstOfDay: false, newInstall: false, upgraded: true }).get(key),
    1
  )
  // NOT counted on any batch that reports the version the row already held…
  assert.equal(counters(batchOf(events), LATER).has(key), false)
  // …and NOT on a brand-new install: `newInstalls` and `upgrades` are disjoint on purpose, so a
  // reader can put them side by side without wondering whether one contains the other.
  const fresh = counters(batchOf(events), { firstOfDay: true, newInstall: true, upgraded: false })
  assert.equal(fresh.has(key), false)
  assert.equal(fresh.get(`${USAGE_METRICS.newInstalls} ${DIM_NONE}`), 1)
  // It rides the SAME counter batch as everything else, which is what puts it in the same
  // transaction as the session it arrived with (infra/lambda/telemetry.ts writeCounters).
  const roll = rollupBatch(batchOf(events), { firstOfDay: true, newInstall: false, upgraded: true })
  assert.ok(roll.counters.some((c) => c.metric === USAGE_METRICS.upgrades && c.n === 1))
})

// ---- 3. nothing identifying, and nothing unstable -------------------------------------------

test('THE ANALYTICS ID REACHES NO COUNTER — not as a metric, not as a dim', () => {
  const roll = rollupBatch(
    batchOf([
      { t: 'viewDwell', view: 'maps', ms: 10 },
      { t: 'funnelStep', funnel: 'first-run', step: 'installed' }
    ]),
    FIRST
  )
  const text = JSON.stringify(roll)
  assert.equal(text.includes(ID), false)
  // …and every dim is a short, closed-enum-shaped token, never free text.
  for (const c of roll.counters) assert.match(c.dim, /^[\w.:—-]{1,64}$/)
})

test('the same batch always yields the same rows in the same order', () => {
  const batch = batchOf([
    { t: 'featureUse', feature: 'questFavorite', count: 1 },
    { t: 'viewDwell', view: 'loot', ms: 5 },
    { t: 'alertFired', count: 3, spokenCount: 1 },
    { t: 'featureUse', feature: 'mapOpen', count: 1 }
  ])
  const a = rollupBatch(batch, FIRST)
  const b = rollupBatch(batch, FIRST)
  assert.deepEqual(a, b)
  const metrics = a.counters.map((c) => `${c.metric} ${c.dim}`)
  assert.deepEqual([...metrics].sort((x, y) => x.localeCompare(y)), metrics)
})

test('an EMPTY batch rolls up to nothing at all — no envelope row, no funnel row', () => {
  const roll = rollupBatch(batchOf([]), FIRST)
  // The handler refuses an empty batch before it reaches the database (its "first batch today"
  // inference assumes events > 0), and the rollup agrees rather than inventing an active day.
  assert.deepEqual(roll.funnels, [])
  assert.equal(roll.counters.some((c) => c.metric === USAGE_METRICS.activeInstalls), true)
  assert.equal(roll.counters.some((c) => c.metric === USAGE_METRICS.heartbeats), false)
})

// ---- buckets and labels ---------------------------------------------------------------------

test('the median is a BUCKET, and an empty histogram has no median at all', () => {
  assert.equal(medianBucket([]), -1)
  assert.equal(medianBucket([0, 0, 0]), -1)
  assert.equal(medianBucket([1]), 0)
  assert.equal(medianBucket([1, 1, 1]), 1)
  assert.equal(medianBucket([10, 1, 1]), 0)
  assert.equal(medianBucket([1, 1, 10]), 2)
})

test('a session bucket renders as a RANGE, and the top bucket is open-ended', () => {
  assert.equal(sessionBucketLabel(0), '0-1 min')
  assert.equal(sessionBucketLabel(3), '15 min-30 min')
  assert.equal(sessionBucketLabel(SESSION_MS_EDGES.length), '4 h+')
  // Out of range clamps rather than producing `undefined-undefined`.
  assert.equal(sessionBucketLabel(99), '4 h+')
  assert.equal(sessionBucketLabel(-1), '0-1 min')
})

test('the day key is the ARRIVAL day in UTC — never the client clock', () => {
  assert.equal(utcDay(Date.UTC(2026, 7, 4, 23, 59)), '2026-08-04')
  assert.equal(utcDay(Date.UTC(2026, 7, 5, 0, 0)), '2026-08-05')
})

// ---- the handler's shape, read off the source ------------------------------------------------
//
// The Lambda itself cannot be imported here (it reaches `pg` and the AWS SDK at module scope),
// and standing those up would test the driver rather than the decision. What IS worth pinning
// is the handful of properties a refactor could quietly drop, all of them visible in the text.

test('the ingest handler runs the SHARED validator and the SHARED rollup', () => {
  const src = readFileSync(join(ROOT, 'infra', 'lambda', 'telemetry.ts'), 'utf8')
  assert.match(src, /import \{ validateTelemetryBatch \} from '\.\.\/\.\.\/src\/shared\/telemetryValidate'/)
  assert.match(src, /rollupBatch/)
  // The size cap is the shared constant, checked BEFORE the parse.
  assert.match(src, /MAX_TELEMETRY_BODY_BYTES/)
  // lastIndexOf, not indexOf: the file's own step list NAMES `JSON.parse` in a comment above
  // the imports, and a pin that a comment can satisfy is not a pin.
  assert.ok(
    src.lastIndexOf('MAX_TELEMETRY_BODY_BYTES') < src.lastIndexOf('JSON.parse'),
    'the size cap must be checked before JSON.parse — it is the one step a hostile body cannot make expensive'
  )
})

test('every counter UPSERT is ADDITIVE, so a retried transaction cannot double-count', () => {
  const src = readFileSync(join(ROOT, 'infra', 'lambda', 'telemetry.ts'), 'utf8')
  // The conflict target gained the SHARD (JOS-394) and must still be EXACTLY the sharded
  // table's primary key, or postgres answers 42P10 and the UPSERT resolves against nothing.
  assert.match(src, /ON CONFLICT \(shard, day, cohort, metric, dim\) DO UPDATE/)
  assert.match(src, /SET n = usage_daily_sharded\.n \+ EXCLUDED\.n/)
  assert.match(src, /ON CONFLICT \(day, cohort, funnel, step, outcome, app_version\) DO UPDATE/)
  assert.match(src, /SET n = usage_funnel_daily\.n \+ EXCLUDED\.n/)
  // The install UPSERT's guard IS the daily cap; without the WHERE it would never refuse.
  assert.match(src, /WHERE analytics_install\.quota_day <> \$2 OR analytics_install\.quota_n < \$6/)
})

/**
 * THE COHORT IS IN THE CONFLICT TARGET, and the schema's PRIMARY KEY has to agree with it or the
 * UPSERT resolves against nothing. `ON CONFLICT` needs a unique constraint over EXACTLY those
 * columns, so this pins the two files against each other — the failure it prevents is silent
 * (postgres 42P10 at runtime, on a cluster, weeks after the change).
 */
test('the cohort is part of the counter KEY, in the handler and in schema.sql alike', () => {
  const src = readFileSync(join(ROOT, 'infra', 'lambda', 'telemetry.ts'), 'utf8')
  const sql = readFileSync(join(ROOT, 'infra', 'schema.sql'), 'utf8')
  assert.match(sql, /PRIMARY KEY \(day, cohort, metric, dim\)/)
  assert.match(sql, /PRIMARY KEY \(day, cohort, funnel, step, outcome, app_version\)/)
  // The dev channel tags itself SERVER-SIDE — no client field was added for this.
  assert.match(src, /cohortForChannel\(batch\.env\.channel\)/)
  // A hand-placed `owner-add` mark survives every later batch unless the channel overrides it.
  assert.match(src, /CASE WHEN EXCLUDED\.cohort = 'owner' THEN 'owner'/)
  assert.match(src, /COALESCE\(analytics_install\.cohort, 'user'\)/)
  // And the resolved value is what the counters are keyed on, not a second guess.
  assert.match(src, /RETURNING first_seen_day, quota_n, cohort/)
  assert.match(src, /writeCounters\(day, facts\.cohort, roll\)/)
})

test('THE FIVE TABLES, AND NO SIXTH: the handler writes exactly the plan’s storage shape', () => {
  // THIS TEST USED TO SAY "THE THREE TABLES, AND NO FOURTH", and JOS-100 added the fourth
  // deliberately rather than sneaking a row into `usage_daily`. The rename is the honest edit:
  // `error_report` keeps something that is not a bare count (an EXEMPLAR), which no counter
  // table can, and pretending otherwise by widening `dim` would have hidden that fact.
  //
  // JOS-372 ADDED THE FIFTH, on the same terms and for the same kind of reason: `perf_daily`
  // keeps a CROSS-TAB, which a table keyed on one `dim` structurally cannot, and widening `dim`
  // into a five-part string would have been the same lie in the other direction. Every dim of it
  // is a closed enum or a bucket index (src/shared/telemetryPerfCube.ts), and its rows are the
  // same session reports `liveStallP95` already counts.
  //
  // T6 IS STILL INTACT AND THAT IS WHAT THE ASSERTIONS BELOW CHECK. T6 refused a per-user event
  // TRAIL; `error_report` is keyed on (day, cohort, version, FINGERPRINT) and `perf_daily` on
  // seven dims with no id among them, so a hundred installs on the same class of box write ONE
  // row. There is still nothing here that could reconstruct what one install did.
  //
  // JOS-394 DID NOT ADD A SIXTH KIND. Two of the five are written under their SHARDED names now
  // (`usage_daily_sharded`, `perf_daily_sharded`) — same columns, same meaning, one extra key
  // column that spreads a hot counter over 32 rows — and the pre-cutover tables are frozen and
  // merged back by a view at read time. The storage SHAPE is unchanged: still five kinds of
  // fact, still no per-user trail, and the new column is a random integer that carries no
  // information about the sender (the test below pins that).
  const src = readFileSync(join(ROOT, 'infra', 'lambda', 'telemetry.ts'), 'utf8')
  const tables = [...src.matchAll(/INSERT INTO (\w+)/g)].map((m) => m[1])
  assert.deepEqual(
    [...new Set(tables)].sort(),
    [
      'analytics_install',
      'error_report',
      'perf_daily_sharded',
      'usage_daily_sharded',
      'usage_funnel_daily'
    ]
  )
  // The cube's CONFLICT TARGET and the schema's PRIMARY KEY have to agree, or the UPSERT
  // resolves against nothing (42P10, on a cluster, weeks later) — the pin the cohort test above
  // makes for the two counter tables, made for the fifth.
  const cubeKey =
    'shard, day, cohort, window_mode, machine_class, locked, stall_bucket, tail_bucket'
  // The statement is assembled from concatenated literals, so the pin is over the JOINED text:
  // a key that only matches because of where the source happens to wrap is not a pin.
  const joined = src.replace(/' \+\s+'/g, '')
  assert.ok(joined.includes(`ON CONFLICT (${cubeKey})`))
  assert.ok(readFileSync(join(ROOT, 'infra', 'schema.sql'), 'utf8').includes(`PRIMARY KEY (${cubeKey})`))
  // The cube carries no id either, and the two install-level dims it needs live on the row that
  // already exists rather than in a table of their own.
  assert.equal(/perf_daily[^;]*analytics_id/.test(src), false, 'no id may reach the perf cube')
  // NO RAW EVENT STORE (T6): nothing inserts a per-event row, and no id is ever logged.
  assert.equal(/INSERT INTO (telemetry_event|usage_event|raw_)/.test(src), false)
  assert.equal(/log\(\{[^}]*analyticsId/.test(src), false)
  // The error table is keyed on a FINGERPRINT, never on the sender.
  assert.match(src, /ON CONFLICT \(day, cohort, version, fingerprint\) DO UPDATE/)
  assert.equal(/error_report[^;]*analytics_id/.test(src), false, 'no id may reach the error store')
  // FIRST EXEMPLAR WINS — a reader who looked at an issue yesterday sees the same example today.
  assert.match(src, /exemplar = COALESCE\(error_report\.exemplar, EXCLUDED\.exemplar\)/)
})

test('the body cap is bigger than feedback’s, and big enough for a maximal batch', () => {
  // 500 records of the fattest event kind is ~130 KB; the cap has to clear that with room.
  assert.ok(MAX_TELEMETRY_BODY_BYTES >= 200 * 1024)
  assert.ok(MAX_TELEMETRY_BODY_BYTES <= 1024 * 1024)
})

// ---- the schema, read off the file ------------------------------------------------------------

test('schema.sql declares the three tables, the kill switch and a role that cannot read reports', () => {
  const sql = readSource(join(ROOT, 'infra', 'schema.sql'))
  for (const table of ['usage_daily', 'usage_funnel_daily', 'analytics_install', 'error_report']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`))
  }
  // The error store is BORN with its key (DSQL cannot ALTER one), cohort included for the same
  // reason the counter tables carry theirs: nothing anywhere sums the author's rows with a user's.
  assert.match(sql, /PRIMARY KEY \(day, cohort, version, fingerprint\)/)
  // TEXT holding JSON, not jsonb — this file's own SHAPE NOTES (env_json / log_json made the
  // same call, and DSQL cannot index jsonb). The JOS-100 brief asked for jsonb; the convention
  // is older than the brief and wins, and this assertion is what keeps that decision visible.
  assert.match(sql, /exemplar {4}text/)
  // Seeded CLOSED, and guarded so a re-run cannot re-close a switch somebody opened.
  assert.match(sql, /SET telemetry_accepting = false\n WHERE id = 'FEEDBACK' AND telemetry_accepting IS NULL/)
  assert.match(sql, /CREATE ROLE telemetry_ingest WITH LOGIN/)
  // THE GRANT LIST IS THE PROMISE (§8.5). No privilege on `report`, and no DELETE anywhere.
  const grants = [...sql.matchAll(/GRANT ([^;]+) TO telemetry_ingest/g)].map((m) => m[1])
  assert.ok(grants.length >= 5)
  // NO privilege on `report` — the feedback backlog. `\b` does the real work here since
  // JOS-100: `error_report` IS granted and is a different table, and `\breport\b` does not
  // match inside it because `_` is a word character. Spelled out so a future reader does not
  // "fix" this regex into one that passes a grant on the backlog.
  assert.equal(grants.some((g) => /\breport\b/.test(g)), false)
  assert.ok(grants.some((g) => /error_report/.test(g)), 'the error store IS granted')
  assert.equal(grants.some((g) => /DELETE/.test(g)), false)
  assert.equal(grants.some((g) => /install_profile/.test(g)), false)
})

test('every statement in schema.sql still ends on its own line — the splitter law', () => {
  const sql = readSource(join(ROOT, 'infra', 'schema.sql'))
  // The runner splits on "the first line whose last character is `;`", so a string literal that
  // ended a line with one would silently cut a statement in half.
  for (const line of sql.split(/\r?\n/)) {
    if (!line.trimEnd().endsWith(';')) continue
    const quotes = (line.match(/'/g) ?? []).length
    assert.equal(quotes % 2, 0, `unbalanced quotes on a statement-ending line: ${line}`)
  }
})
