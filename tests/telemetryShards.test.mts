// infra/schema.sql + infra/lambda/{telemetry,db}.ts + infra/alarms.tf — the SHARDED counters.
//
// Split out of tests/telemetryRollup.test.mts because that file is at the repo's 400-code-line
// ceiling and a split is the answer to that, not a widened threshold. What lives here is the
// JOS-394 seam: a hot counter is written 32 ways, the readers read one merged view, the retry
// ladder is full-jittered and reports its own exhaustion, and the alarm that used to fire all
// day measures a RATIO.
//
// EVERY TEST HERE IS A CROSS-FILE PIN, which is the whole reason they are worth writing: the
// failures they prevent are silent and land on a live cluster weeks later — a conflict target
// that is not exactly a primary key (42P10), a reader still on a frozen table (a fleet that
// looks quiet), an uncast SUM (every counter reads 0), a shard derived from the install id (a
// per-user trail rebuilt inside the anonymous counters).
//
// The MEASURED numbers behind the design, from an ephemeral DSQL cluster stood up for the
// ticket: 8 concurrent writers x 12 upserts produced 64 conflicts on ONE hot row and 8 across
// 32 random shards; the merge view returned 11 frozen + 8 sharded = 19, as a JS number.
//
// No Electron, no AWS, no network: this suite never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toUsageRows } from '../src/main/triage/usageRows'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** CRLF-normalized, for the same reason the rollup suite normalizes: this repo checks out with
 *  core.autocrlf=true and a `\n` pin would be red on every Windows checkout for a file that has
 *  not drifted. */
const readSource = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')

// ---- the privacy law comes first --------------------------------------------------------------
//
// A shard column is a new column on the counter tables, and the ONE way it could become a
// problem is by being derived from the sender. It is drawn from `Math.random()` per request; a
// hash of the analyticsId would spread writes equally well and would ALSO partition every day's
// counters into per-install buckets, which is the per-user trail the whole aggregate-on-arrival
// design refuses to keep.

test('the shard is RANDOM, and no function of the analyticsId reaches a counter table', () => {
  const src = readFileSync(join(ROOT, 'infra', 'lambda', 'telemetry.ts'), 'utf8')
  assert.match(src, /function pickShard\(\): number \{\s*return Math\.floor\(Math\.random\(\) \* SHARD_COUNT\)/)
  // The shard reaches SQL as a bound parameter of writeCounters and nowhere else, and the only
  // value that produces it is the call above.
  assert.equal((src.match(/pickShard\(\)/g) ?? []).length, 2, 'declared once, called once')
  // NOTHING in this file may hash, digest or otherwise fold an id into a shard.
  assert.equal(/createHash|sha256|md5|hashCode/.test(src), false, 'no hashing primitive at all')
  const shardLines = src.split('\n').filter((l) => /shard/i.test(l) && !l.trimStart().startsWith('*'))
  for (const line of shardLines) {
    assert.equal(
      /analyticsId|analytics_id|installId/.test(line),
      false,
      `the shard may never be derived from an id: ${line}`
    )
  }
})

test('SHARD_COUNT is 32, and the sharded key is the conflict target in both files', () => {
  const src = readFileSync(join(ROOT, 'infra', 'lambda', 'telemetry.ts'), 'utf8')
  const sql = readSource(join(ROOT, 'infra', 'schema.sql'))
  assert.match(src, /const SHARD_COUNT = 32/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS usage_daily_sharded/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS perf_daily_sharded/)
  assert.match(sql, /PRIMARY KEY \(shard, day, cohort, metric, dim\)/)
  // The frozen originals are NOT dropped: they still carry every counter written before cutover
  // and the views add them back. A schema.sql that dropped one would fail here.
  assert.match(sql, /CREATE TABLE IF NOT EXISTS usage_daily \(/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS perf_daily \(/)
  assert.equal(/DROP TABLE/.test(sql), false, 'this file drops nothing, ever')
  // The Lambda writes the sharded tables and no longer writes the frozen ones.
  assert.equal(/INSERT INTO usage_daily \(/.test(src), false)
  assert.equal(/INSERT INTO perf_daily \(/.test(src), false)
})

test('the merge views exist, sum both legs, and CAST the sum back to bigint', () => {
  const sql = readSource(join(ROOT, 'infra', 'schema.sql'))
  for (const view of ['usage_daily_all', 'perf_daily_all']) {
    assert.match(sql, new RegExp(`CREATE VIEW ${view} AS`))
  }
  // THE CAST IS LOAD-BEARING AND MEASURED (JOS-394): an uncast SUM(bigint) is NUMERIC (OID
  // 1700), which no type parser covers, so the counter arrives as a STRING and the readouts'
  // `num()` would have turned it into a silent zero. Two occurrences, one per view.
  assert.equal((sql.match(/SUM\(n\)::bigint AS n/g) ?? []).length, 2)
  // Both legs, and the frozen one first — the view is what makes the cutover DAY, whose counters
  // live half in each table, invisible to every reader.
  assert.match(sql, /FROM usage_daily\n\s*UNION ALL\n\s*SELECT day, cohort, metric, dim, n FROM usage_daily_sharded/)
  assert.match(sql, /FROM perf_daily\n\s*UNION ALL/)
})

test('every reader outside the Lambda reads the merged VIEW, never the frozen table', () => {
  const store = readFileSync(join(ROOT, 'src', 'main', 'triage', 'usageStore.ts'), 'utf8')
  assert.match(store, /FROM usage_daily_all WHERE day >= \$1/)
  assert.match(store, /FROM perf_daily_all WHERE day >= \$1/)
  // No SELECT in the app's read surface may still name the frozen tables: that read would report
  // the fleet as it was at cutover and nothing since, which looks like a quiet week rather than
  // like a bug. Every other reader (the CLI digest, the Analytics tab, the release smoke test)
  // goes through these two functions.
  assert.equal(/FROM usage_daily\b/.test(store), false)
  assert.equal(/FROM perf_daily\b/.test(store), false)
})

/**
 * THE SILENT-ZERO GUARD, and it is here rather than beside the other row-mapping tests because
 * the view is what made it necessary. A counter that arrives as `'12'` must read as 12 — the
 * measurement that forced this is in the view's note in infra/schema.sql — and anything that is
 * not a number written as text must still be 0, because the rule reads a number, it does not
 * coerce whatever turns up. tests/usageAnalytics.test.mts pins the positive case.
 */
test('a counter written as text is a number; anything else is still 0', () => {
  assert.equal(toUsageRows([{ n: '12' }])[0].n, 12)
  assert.equal(toUsageRows([{ n: 'lots' }])[0].n, 0)
  assert.equal(toUsageRows([{ n: '' }])[0].n, 0)
  assert.equal(toUsageRows([{ n: Number.NaN }])[0].n, 0)
  assert.equal(toUsageRows([{}])[0].n, 0)
})

test('the retry ladder is FULL JITTER and says so when it gives up', () => {
  const db = readFileSync(join(ROOT, 'infra', 'lambda', 'db.ts'), 'utf8')
  assert.match(db, /const MAX_ATTEMPTS = 5/)
  // Full jitter: uniform over [0, BASE * 2^attempt). A fixed step (`BACKOFF_MS * attempt`) is
  // the shape that RE-SYNCHRONISES two racers, which is what this replaced.
  assert.match(db, /Math\.floor\(Math\.random\(\) \* BACKOFF_MS \* 2 \*\* attempt\)/)
  assert.equal(/BACKOFF_MS \* attempt/.test(db), false, 'no fixed-step backoff may come back')
  // Exhaustion is a METRIC, not just a log line — `alarms.tf` alarms on it at >= 1 because it is
  // the only place a LOST aggregate write is ever reported.
  assert.match(db, /emit\(\{\}, \[\{ name: 'DbRetryExhausted', value: 1 \}\]/)
  const tf = readFileSync(join(ROOT, 'infra', 'alarms.tf'), 'utf8')
  assert.match(tf, /metric_name\s*=\s*"DbRetryExhausted"/)
  // And the conflict alarm is a RATIO now: a raw count fired all day at a 5% conflict rate that
  // lost nothing, which is how an alarm stops being read.
  assert.match(tf, /expression\s*=\s*"IF\(invocations > 0, conflicts \/ invocations, 0\)"/)
})
