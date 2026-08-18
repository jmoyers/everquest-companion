/**
 * POST /v1/telemetry — usage analytics ingest (docs/plans/usage-analytics.md wave A2).
 *
 * A SECOND FUNCTION, NOT A SECOND ROUTE ON THE FIRST. The two handlers share this repo, this
 * bundler and ./db.ts, and share nothing else — different IAM role, different DATABASE role,
 * different log group, different alarms. The reason is the one that shaped `feedback_ingest`:
 * what a public write endpoint may do should be readable as a GRANT list. Folding telemetry
 * into `submit` would have given the telemetry path `INSERT ON report` and an S3 presign
 * permission it has no use for, and given the feedback path write access to the counters — for
 * the saving of one 3 MB zip. (`infra/README.md` states the choice; `iam.tf` enforces it.)
 *
 * ONE VALIDATOR, CLIENT AND SERVER, exactly as feedback does it: `validateTelemetryBatch` is
 * IMPORTED from src/shared/telemetryValidate.ts — the same pure function the renderer's
 * `track()` shim and the main-process IPC handler already run. It does not sanitize an object,
 * it CONSTRUCTS one field by field from the schema, so a field the schema has no room for
 * cannot survive the boundary however it was smuggled in.
 *
 * STEPS, CHEAPEST FIRST, and every one is a place to stop before touching state:
 *
 *   1. size            -> 413 too_large        (BEFORE JSON.parse)
 *   1.5 NUL byte       -> 400 invalid_event    (also BEFORE JSON.parse)
 *   2. json            -> 400 invalid_event
 *   3. shape           -> 400 invalid_event    (the shared validator; {field})
 *   4. empty batch     -> 202 accepted:0       (legal, and costs no round trip)
 *   5. config          -> 503 closed           (kill switch `telemetry_accepting`, seeded FALSE)
 *   6. install UPSERT  -> 429 quota_exceeded   (guarded; also mints the per-day facts)
 *   7. AGGREGATE       -> counter + error-report UPSERTs, ONE transaction
 *   8. EMF             -> the near-real-time view
 *   9. 202
 *
 * THERE IS NO RAW EVENT STORE (T6). The batch exists in this process for the length of one
 * invocation and is then garbage; what persists is counters. Nothing here logs an analyticsId,
 * and the function's own CloudWatch log (14 days) carries counts only.
 *
 * THE COUNTER TABLES ARE SHARDED SINCE JOS-394, AND THE SHARD IS RANDOM. `usage_daily_sharded`
 * and `perf_daily_sharded` carry a `shard` column drawn from `Math.random()` once per request,
 * which spreads a hot counter over 32 rows so that DSQL's optimistic writers stop racing each
 * other on one. It is NOT a hash of the analyticsId and must never become one — a hash is a
 * function of the install id, and a stable per-install shard would partition a day's counters
 * into per-install buckets, rebuilding in the counter tables the very trail this file refuses
 * to keep. Readers never see the column: they read the merged views.
 *
 * ONE BOUNDED EXCEPTION SINCE JOS-100, and it is bounded by the KEY rather than by a promise:
 * `error_report` keeps at most one EXEMPLAR per (day, cohort, version, fingerprint), first
 * wins. That is a per-ISSUE store, not a per-user one — the row a hundred installs write is one
 * row — and the exemplar it holds is a validated `errorReport` event, which means a redacted
 * message (re-redacted HERE, and refused if it changes), `out/…` frames, and parser event
 * KINDS. No analyticsId reaches it, so no row can be traced back to an install.
 */

import { Buffer } from 'node:buffer'
import process from 'node:process'
import { errorMessage, log, query, resetClient, sqlState, transaction, withRetry } from './db'
import { emit } from './emf'
import { MAX_TELEMETRY_BODY_BYTES } from '../../src/shared/telemetry'
import type { TelemetryBatch } from '../../src/shared/telemetry'
import { validateTelemetryBatch } from '../../src/shared/telemetryValidate'
import { hasNulByte } from '../../src/shared/sanitizeText'
import {
  cohortForChannel,
  cohortOf,
  rollupBatch,
  utcDay,
  USAGE_METRICS,
  type ErrorReportRow,
  type FunnelCounter,
  type RollupResult,
  type UsageCohort,
  type UsageCounter
} from '../../src/shared/telemetryRollup'
import {
  perfDimsFromEvents,
  perfDimsOf,
  type PerfCubeRow,
  type PerfInstallDims
} from '../../src/shared/telemetryPerfCube'

/** Warm invocations reuse the CONFIG row for this long instead of re-reading it. */
const CONFIG_CACHE_MS = 60_000
/** Cold-start fallback for the daily per-id event cap when the config column is NULL. */
const FALLBACK_MAX_EVENTS_PER_DAY = Number(process.env.MAX_EVENTS_PER_DAY ?? '20000')
/**
 * Rows per UPSERT statement. A maximal batch collapses to a few dozen distinct (metric, dim)
 * pairs, so this is a ceiling nothing normally reaches — it exists because DSQL caps a
 * transaction at 3,000 MODIFIED ROWS and an unbounded multi-row VALUES list would eventually
 * FAIL rather than merely be slow. Same reasoning as db.ts's sweep bound.
 */
const UPSERT_CHUNK = 100
/** Funnel-step EMF documents per invocation. A dimension value is a billed metric. */
const MAX_FUNNEL_EMF = 20

/**
 * COUNTER SHARDS (JOS-394) — how many rows one hot counter is spread across.
 *
 * THE PROBLEM, MEASURED on the live stack 2026-08-16: every install increments the SAME rows —
 * `usage_daily`'s (day, cohort, 'sessionHeartbeat', '-') and the small closed set of `perf_daily`
 * buckets — so at ~1,350 requests per 5 minutes (4.5 RPS, 3-4 concurrent Lambdas) about 5% of
 * writes lost a commit-time race and came back 40001. DSQL takes no locks, so that rate is a
 * function of how many writers meet on one ROW, and it only grows with the install base.
 *
 * THE ARITHMETIC. Two concurrent writers collide when they pick the same counter AND the same
 * shard, so the conflict rate falls roughly linearly in the shard count: 32 shards turn a ~5%
 * conflict rate into ~0.2%, which is comfortably inside "the system working" and leaves the
 * retry ladder for genuine bursts. Why not 4 (too little headroom for a fleet twice this size),
 * and why not 512: a shard costs a ROW PER DAY PER COUNTER — 32 keeps a day's counters in the
 * hundreds of rows, where a read is still one bounded scan, and the merge view sums them anyway.
 * At 3-4 concurrent Lambdas, 32 is ample by an order of magnitude.
 *
 * THE SHARD IS RANDOM PER REQUEST, AND IT MAY NEVER BE A FUNCTION OF THE analyticsId. That is
 * this file's oldest law (see the header, and the long note over `usage_daily` in
 * infra/schema.sql): NO function of the install id reaches a counter table, because a stable
 * per-install shard would let anyone holding these rows partition a day's counters into per-
 * install buckets — the per-user trail the aggregate-on-arrival design exists to not keep.
 * `Math.random()` spreads writes exactly as well and carries no information about the sender.
 * It is drawn ONCE per invocation, not once per row: one batch's rows then land in one shard,
 * which is fewer distinct rows for one transaction to hold and no worse for spreading.
 */
const SHARD_COUNT = 32

/** A shard for THIS request. Random, never derived from anything the client sent. */
function pickShard(): number {
  return Math.floor(Math.random() * SHARD_COUNT)
}

type TelemetryErrorCode =
  | 'too_large'
  | 'invalid_event'
  | 'closed'
  | 'quota_exceeded'
  | 'internal'

interface HttpEvent {
  body?: string
  isBase64Encoded?: boolean
}

interface HttpResult {
  statusCode: number
  headers: Record<string, string>
  body: string
}

interface TelemetryConfig {
  accepting: boolean
  maxEventsPerIdPerDay: number
}

/**
 * CLOSED IS THE DEFAULT, and it is the default in three independent places: the seed statement
 * writes false, the column is nullable and a NULL reads as false HERE, and a missing config row
 * reads as false too. A telemetry endpoint that fails OPEN would collect from users whose
 * server-side switch nobody has ever set.
 */
const DEFAULT_CONFIG: TelemetryConfig = {
  accepting: false,
  maxEventsPerIdPerDay: FALLBACK_MAX_EVENTS_PER_DAY
}

let configCache: { at: number; value: TelemetryConfig } | null = null

interface ConfigRow {
  telemetry_accepting?: boolean | null
  max_events_per_id_per_day?: number | null
}

/** Field by field, with a typed fallback: an operator-written row can hold anything. */
function toConfig(row: ConfigRow | undefined): TelemetryConfig {
  const accepting = row?.telemetry_accepting
  const max = row?.max_events_per_id_per_day
  return {
    accepting: accepting === true,
    maxEventsPerIdPerDay:
      typeof max === 'number' && max > 0 ? max : DEFAULT_CONFIG.maxEventsPerIdPerDay
  }
}

function json(statusCode: number, body: unknown): HttpResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }
}

function fail(
  statusCode: number,
  error: TelemetryErrorCode,
  message: string,
  extra?: { field?: string }
): HttpResult {
  return json(statusCode, { ok: false, error, message, ...extra })
}

// ---- step 5: the kill switch --------------------------------------------------------

const CONFIG_SQL = `SELECT telemetry_accepting, max_events_per_id_per_day
  FROM feedback_config WHERE id = 'FEEDBACK'`

async function loadConfig(now: number): Promise<TelemetryConfig> {
  if (configCache && now - configCache.at < CONFIG_CACHE_MS) return configCache.value
  const rows = await query<ConfigRow>(CONFIG_SQL)
  const value = toConfig(rows[0])
  configCache = { at: now, value }
  return value
}

// ---- step 6: the install row, the day facts and the cap, in ONE statement ------------

/**
 * The per-id row IS the quota counter (schema.sql says why), so one guarded UPSERT does four
 * jobs: create-or-touch the row, advance `days_seen` on a new day, consume the daily event cap,
 * and REPORT BACK the two facts the rollup cannot know for itself.
 *
 * WHY THE CAP CANNOT BE EXCEEDED under DSQL's fixed Repeatable Read + optimistic concurrency —
 * the same two-case argument submit.ts makes for `install_quota`:
 *   1. THEY SERIALIZE. The second transaction sees the first's increment, evaluates the guard
 *      against the real count, and is refused at the cap.
 *   2. THEY CONFLICT. Both read one snapshot; DSQL detects the write-write conflict AT COMMIT
 *      and aborts one with SQLSTATE 40001. The loser never committed, so nothing double-counted.
 * `withRetry` exists for the CALLER's sake in case 2, not for the cap's: on retry the racer
 * lands in case 1 and gets the honest answer.
 *
 * The cap is a FLOOR, not a ceiling: the guard reads the count BEFORE this batch, so an id at
 * 19,999 events may still land one full batch. Bounding it exactly would mean rejecting a
 * partially-counted batch, which is a worse answer than an overshoot of at most MAX_BATCH_EVENTS.
 *
 * IT ALSO RESOLVES THE COHORT, and that is why this one statement grew a fifth job rather than a
 * SELECT beside it: the cohort has to come from the SAME row-read the guard already performs, or
 * two concurrent batches could disagree about which side of the split they belong on.
 *
 *   * `$7` is the cohort the CHANNEL implies — 'owner' for a dev build, 'user' otherwise. It is
 *     derived server-side from a field the envelope has always carried; the client sends nothing
 *     new for this feature (src/shared/telemetryRollup.ts says why that is the whole point).
 *   * ON INSERT it is simply stored. ON UPDATE the stored value WINS unless the channel forces
 *     'owner': that is what makes a hand-placed `owner-add` mark STICK across every later batch
 *     from a prod install, while a dev build re-asserts itself even if somebody `owner-rm`'d it.
 *   * `RETURNING cohort` hands back the RESOLVED value (postgres returns the post-update row),
 *     so the counter UPSERTs below key on the same answer this statement committed.
 *
 * IT ALSO CARRIES THE PERF CUBE'S TWO SETUP DIMS (JOS-372), for a sixth job and the same reason
 * as the fifth: `machine_class` and `window_mode` are per-INSTALL facts that arrive once per
 * launch on a `setupSnapshot`, while the stall readings they slice arrive on every session report
 * for hours. `$8`/`$9` are what THIS batch's snapshot said, or NULL when it carried none, and
 * `COALESCE(EXCLUDED.…, analytics_install.…)` is the whole resolution: a snapshot overwrites,
 * anything else keeps what the row holds. `RETURNING` then hands back the resolved pair, so a
 * batch with no snapshot of its own still folds its cube rows against the install's known box.
 *
 * THESE TWO COLUMNS MUST EXIST BEFORE THIS BUNDLE IS DEPLOYED. The statement names them
 * unconditionally, and naming a column that does not exist is `42703` on EVERY batch — the trap
 * infra/README.md's "adding a column is schema-first" section documents. Order: `migrate`, then
 * `terraform apply`.
 */
const INSTALL_SQL = `INSERT INTO analytics_install (
  analytics_id, first_seen_day, last_seen_day, days_seen, app_version, channel, cohort,
  quota_day, quota_n, machine_class, window_mode)
VALUES ($1, $2, $2, 1, $3, $4, $7, $2, $5, $8, $9)
ON CONFLICT (analytics_id) DO UPDATE
   SET last_seen_day = GREATEST(analytics_install.last_seen_day, $2),
       days_seen     = analytics_install.days_seen
                     + (CASE WHEN analytics_install.last_seen_day < $2 THEN 1 ELSE 0 END),
       app_version   = EXCLUDED.app_version,
       channel       = EXCLUDED.channel,
       cohort        = (CASE WHEN EXCLUDED.cohort = 'owner' THEN 'owner'
                             ELSE COALESCE(analytics_install.cohort, 'user') END),
       machine_class = COALESCE(EXCLUDED.machine_class, analytics_install.machine_class),
       window_mode   = COALESCE(EXCLUDED.window_mode, analytics_install.window_mode),
       quota_day     = $2,
       quota_n       = (CASE WHEN analytics_install.quota_day = $2
                             THEN analytics_install.quota_n ELSE 0 END) + $5
 WHERE analytics_install.quota_day <> $2 OR analytics_install.quota_n < $6
RETURNING first_seen_day, quota_n, cohort, machine_class, window_mode`

interface InstallRow {
  first_seen_day: string
  quota_n: number
  cohort: string | null
  machine_class: string | null
  window_mode: string | null
}

export interface InstallFacts {
  firstOfDay: boolean
  newInstall: boolean
  /** Did this batch arrive on a different build than the row was holding? (`upgrades`.) */
  upgraded: boolean
  /** Which side of the split every counter this batch produces is keyed on. */
  cohort: UsageCohort
  /** The perf cube's two setup dims, RESOLVED (JOS-372): this batch's snapshot if it carried
   *  one, else whatever the install row was already holding, else `unknown`. */
  perf: PerfInstallDims
}

/**
 * THE VERSION THIS INSTALL WAS ON BEFORE THIS BATCH — the `upgrades` counter's whole input.
 *
 * IT IS A SEPARATE READ, AND THAT IS A DECIDED TRADE. The obvious move is to fold it into
 * INSTALL_SQL, which is already reading the stored version in order to overwrite it — but
 * postgres's `RETURNING` on an `ON CONFLICT DO UPDATE` yields the UPDATED row, and `excluded` is
 * not addressable there, so the old value cannot come back out of that statement without either a
 * CTE or a column to smuggle it in. A CTE is the elegant answer and is exactly the kind of thing
 * that is not worth betting a live ingest endpoint on when the cluster is Aurora DSQL (a
 * documented SUBSET of postgres) and the only way to find out is to deploy it. One indexed
 * primary-key lookup, once per batch — i.e. once every five minutes per active install since
 * JOS-269, and it was once a minute before that — is the cheap, boring, verifiable option, and
 * five times cheaper than the figure this paragraph was written against.
 *
 * THE RACE IS BENIGN AND BOUNDED. Two batches from one id could both read the old version and
 * both count an upgrade; that needs one client to have two flushes in flight, which a serial
 * flush loop does not do at any period (and a longer one only widens the gap), and the cost if it
 * ever happened is one extra count in an additive counter. The alternative — a value read inside the guarded UPSERT — is not available
 * without the CTE this deliberately avoids.
 *
 * NULL means "no row yet", i.e. a first-ever batch: a new install is not an upgrade.
 */
const PRIOR_VERSION_SQL = 'SELECT app_version FROM analytics_install WHERE analytics_id = $1'

async function priorVersion(analyticsId: string): Promise<string | null> {
  const rows = await withRetry('priorVersion', () =>
    query<{ app_version: string | null }>(PRIOR_VERSION_SQL, [analyticsId])
  )
  const version = rows[0]?.app_version
  return typeof version === 'string' ? version : null
}

/**
 * Null means the cap is spent (zero rows can only be the DO UPDATE's guard being false).
 *
 * THE INFERENCE, spelled out because it is doing real work with no extra column: `quota_n` is
 * reset to this batch's event count on the first batch of a day and accumulates thereafter, so
 * `quota_n === events` IS "first batch today" — and an empty batch, which would make that
 * reasoning false, is refused before this statement ever runs (step 4).
 */
async function touchInstall(
  batch: TelemetryBatch,
  config: TelemetryConfig,
  day: string,
  prior: string | null
): Promise<InstallFacts | null> {
  const events = batch.events.length
  // NULL when this batch carried no `setupSnapshot`, which is most of them — the UPSERT's
  // `COALESCE` then keeps whatever the install row already knows about this box.
  const stated = perfDimsFromEvents(batch.events)
  const rows = await withRetry('install', () =>
    query<InstallRow>(INSTALL_SQL, [
      batch.env.analyticsId,
      day,
      batch.env.appVersion,
      batch.env.channel,
      events,
      config.maxEventsPerIdPerDay,
      cohortForChannel(batch.env.channel),
      stated?.machineClass ?? null,
      stated?.windowMode ?? null
    ])
  )
  const row = rows[0]
  if (row === undefined) return null
  const firstOfDay = row.quota_n === events
  return {
    firstOfDay,
    newInstall: firstOfDay && row.first_seen_day === day,
    // A DOWNGRADE IS AN UPGRADE HERE, deliberately: the fact worth counting is "this install
    // changed build", and a rollback is the version of that fact most worth seeing. `prior ===
    // null` is a first-ever batch, which is a new install and not a change.
    upgraded: prior !== null && prior !== batch.env.appVersion,
    cohort: cohortOf(row.cohort),
    // The POST-UPDATE row, so this is the same answer the statement just committed — the
    // `cohort` argument above, applied to the two dims beside it.
    perf: perfDimsOf(row.machine_class, row.window_mode)
  }
}

// ---- step 7: the aggregate UPSERTs ---------------------------------------------------

/**
 * `($1,$2,$3,$4,$5),($1,$2,$6,$7,$8)…` — the first `shared` parameters (the day and the cohort)
 * are the same for every tuple in the statement, because a batch belongs to exactly one day and
 * exactly one install. Repeating them per row would be `MAX_BATCH_EVENTS` copies of two strings.
 */
function tuples(rows: number, columns: number, shared: number): string {
  const head = Array.from({ length: shared }, (_, i) => `$${String(i + 1)}`)
  const out: string[] = []
  for (let r = 0; r < rows; r++) {
    const cells = [...head]
    for (let c = 0; c < columns; c++) cells.push(`$${String(shared + 1 + r * columns + c)}`)
    out.push(`(${cells.join(',')})`)
  }
  return out.join(',')
}

/** The day and the cohort, in that order — `tuples`'s `shared` count and these must agree. */
const SHARED_PARAMS = 2

/**
 * The day, the cohort AND THE SHARD, for the two sharded tables (JOS-394). A third shared
 * parameter rather than a per-row one because the shard is drawn once per request, and it is a
 * SEPARATE constant from `SHARED_PARAMS` because the funnel and error statements below are NOT
 * sharded: their rows are rare (a funnel step is a user action, an error row is a distinct
 * fingerprint) and were not in the measured contention. They ride in the same transaction, so
 * if either ever becomes hot it gets exactly this treatment rather than a wider retry budget.
 */
const SHARDED_PARAMS = 3

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * THE COUNTERS GO TO THE SHARDED TABLE (JOS-394), and the column order is not cosmetic: the
 * first three columns are `tuples`'s SHARED parameters, so (day, cohort, shard) must lead
 * whatever order the table was declared in. The conflict target is the sharded PRIMARY KEY —
 * it has to be exactly the key or postgres answers 42P10 and the UPSERT resolves against
 * nothing.
 *
 * `usage_daily` IS NOT WRITTEN ANY MORE and is not dropped either: it freezes at cutover and
 * `usage_daily_all` adds it back to every read. infra/schema.sql carries the whole argument.
 */
const COUNTER_HEAD =
  'INSERT INTO usage_daily_sharded (day, cohort, shard, metric, dim, n) VALUES '
const COUNTER_TAIL =
  ' ON CONFLICT (shard, day, cohort, metric, dim) DO UPDATE' +
  ' SET n = usage_daily_sharded.n + EXCLUDED.n'

const FUNNEL_HEAD =
  'INSERT INTO usage_funnel_daily (day, cohort, funnel, step, outcome, app_version, n) VALUES '
const FUNNEL_TAIL =
  ' ON CONFLICT (day, cohort, funnel, step, outcome, app_version) DO UPDATE' +
  ' SET n = usage_funnel_daily.n + EXCLUDED.n'

/**
 * The error store (JOS-100). Two behaviours in one statement, and they are deliberately
 * different from each other:
 *
 *   * `count` ACCUMULATES, like every other counter here — additive, so a retried transaction
 *     after a commit-time abort re-adds nothing (the aborted attempt never committed).
 *   * `exemplar` is FIRST WINS, via `COALESCE(error_report.exemplar, EXCLUDED.exemplar)`. The
 *     row keeps the example it already has; a later batch can only FILL a NULL. So a hundred
 *     installs hitting one bug store one stack, and the stack that is stored is stable — a
 *     reader who looked at this issue yesterday is looking at the same example today.
 */
const ERROR_HEAD =
  'INSERT INTO error_report (day, cohort, version, fingerprint, count, exemplar) VALUES '
const ERROR_TAIL =
  ' ON CONFLICT (day, cohort, version, fingerprint) DO UPDATE' +
  ' SET count = error_report.count + EXCLUDED.count,' +
  ' exemplar = COALESCE(error_report.exemplar, EXCLUDED.exemplar)'

/**
 * THE PERF CUBE (JOS-372, sharded by JOS-394). Additive like every counter here, and keyed on
 * all five dims plus the day, the cohort and now the shard — the whole row IS the primary key,
 * which is what makes the `ON CONFLICT` target legal and what stops one day's fullscreen rows
 * colliding with its windowed ones. `src/shared/telemetryPerfCube.ts` holds the vocabulary and
 * the cardinality argument; the shard multiplies that ceiling by 32 and the merge view sums it
 * back down, which is the trade the OCC-conflict measurement bought.
 */
const PERF_HEAD =
  'INSERT INTO perf_daily_sharded (day, cohort, shard, window_mode, machine_class, locked,' +
  ' stall_bucket, tail_bucket, n) VALUES '
const PERF_TAIL =
  ' ON CONFLICT (shard, day, cohort, window_mode, machine_class, locked, stall_bucket,' +
  ' tail_bucket) DO UPDATE SET n = perf_daily_sharded.n + EXCLUDED.n'

/**
 * Every counter for this batch, in ONE transaction so a batch is counted completely or not at
 * all — a half-applied batch would put a funnel step in the table with no session beside it and
 * quietly bend a conversion rate.
 *
 * The UPSERTs are additive (`n = existing + EXCLUDED.n`), so a retried transaction after a
 * commit-time abort re-adds nothing: the aborted attempt never committed. That is the only
 * at-most-once property this path needs, and it is the database's, not a flag's.
 *
 * ONE SHARD FOR THE WHOLE TRANSACTION (JOS-394), drawn here rather than per row or per chunk:
 * this is the unit that either commits or aborts, so spreading its rows over several shards
 * would widen the set of rows a racer could collide with for no gain. A retry re-runs this
 * function's body with the SAME shard — the retry lives in `withRetry` one level up — which is
 * what keeps the UPSERT additive rather than scattering a re-added count across shards.
 */
async function writeCounters(day: string, cohort: UsageCohort, roll: RollupResult): Promise<void> {
  const shard = pickShard()
  const counterChunks = chunk<UsageCounter>(roll.counters, UPSERT_CHUNK)
  const funnelChunks = chunk<FunnelCounter>(roll.funnels, UPSERT_CHUNK)
  const errorChunks = chunk<ErrorReportRow>(roll.errors, UPSERT_CHUNK)
  const perfChunks = chunk<PerfCubeRow>(roll.perf, UPSERT_CHUNK)
  if (
    counterChunks.length === 0 &&
    funnelChunks.length === 0 &&
    errorChunks.length === 0 &&
    perfChunks.length === 0
  ) {
    return
  }
  await withRetry('counters', () =>
    transaction(async (c) => {
      for (const rows of counterChunks) {
        const params: unknown[] = [day, cohort, shard]
        for (const r of rows) params.push(r.metric, r.dim, r.n)
        await c.query(
          `${COUNTER_HEAD}${tuples(rows.length, 3, SHARDED_PARAMS)}${COUNTER_TAIL}`,
          params
        )
      }
      for (const rows of funnelChunks) {
        const params: unknown[] = [day, cohort]
        for (const r of rows) params.push(r.funnel, r.step, r.outcome, r.appVersion, r.n)
        await c.query(
          `${FUNNEL_HEAD}${tuples(rows.length, 5, SHARED_PARAMS)}${FUNNEL_TAIL}`,
          params
        )
      }
      // IN THE SAME TRANSACTION as the counters, for the reason the header gives: a batch is
      // counted completely or not at all, and an error row with no `errors` counter beside it
      // would make the panel's per-build rate disagree with its own issue list.
      for (const rows of errorChunks) {
        const params: unknown[] = [day, cohort]
        for (const r of rows) {
          params.push(r.appVersion, r.fingerprint, r.n, JSON.stringify(r.exemplar))
        }
        await c.query(`${ERROR_HEAD}${tuples(rows.length, 4, SHARED_PARAMS)}${ERROR_TAIL}`, params)
      }
      // …and the cube, in the SAME transaction for the same reason: its rows are a slice of the
      // very `liveStallP95` histogram the counters above carry, so a batch that landed one and
      // not the other would make the panel's cross-tab disagree with its own fleet-wide totals.
      for (const rows of perfChunks) {
        const params: unknown[] = [day, cohort, shard]
        for (const r of rows) {
          params.push(r.windowMode, r.machineClass, r.locked, r.stallBucket, r.tailBucket, r.n)
        }
        await c.query(`${PERF_HEAD}${tuples(rows.length, 6, SHARDED_PARAMS)}${PERF_TAIL}`, params)
      }
    })
  )
}

// ---- step 8: the near-real-time view --------------------------------------------------

const counterOf = (roll: RollupResult, metric: string): number =>
  roll.counters.filter((c) => c.metric === metric).reduce((sum, c) => sum + c.n, 0)

/**
 * Two shapes of document, and the dimensions are the reason for the split: the pulse metrics
 * are per-channel, the funnel counters are per (funnel, step). CloudWatch aggregates a metric
 * across a dimension set it is not given, so this is exactly what makes the dashboard able to
 * show "events/min" overall and "conversion at step N" separately.
 *
 * DELIBERATELY NOT COHORT-SPLIT. A CloudWatch metric's identity IS its full dimension set, so
 * adding `Cohort` here would orphan every widget in `dashboard.tf` and bill a new dimension
 * value on every metric — to re-answer a question `Channel` already half answers (a dev build
 * is always the owner). The near-real-time view is "is anyone in the app right now"; the SPLIT
 * lives in the stored counters, where the digest and the tab read it.
 */
function emitMetrics(batch: TelemetryBatch, roll: RollupResult, now: number): void {
  emit(
    { Channel: batch.env.channel },
    [
      { name: 'Batches', value: 1 },
      { name: 'EventsAccepted', value: batch.events.length },
      // Heartbeats are the "is anyone in the app RIGHT NOW" signal: one per session per HEARTBEAT
      // PERIOD, which the client sets and this Lambda only counts (10 min since JOS-269). Anything
      // reading this as a concurrency figure must bucket it at that same period - see
      // src/main/triage/liveSessions.ts, which is the reader that does.
      { name: 'Heartbeats', value: counterOf(roll, USAGE_METRICS.heartbeats) },
      { name: 'SessionsStarted', value: counterOf(roll, USAGE_METRICS.sessions) },
      { name: 'ActiveInstalls', value: counterOf(roll, USAGE_METRICS.activeInstalls) },
      // JOS-100. A NEW METRIC NAME on the dimension set that already exists — adding one is
      // free, and it is adding a DIMENSION that would orphan the dashboard's widgets (the note
      // below about the cohort split). It is the "is the fleet on fire right now" signal the
      // stored per-fingerprint rows cannot be, because those are keyed on a DAY.
      { name: 'ErrorsReported', value: counterOf(roll, USAGE_METRICS.errors) }
    ],
    now
  )
  for (const f of roll.funnels.slice(0, MAX_FUNNEL_EMF)) {
    emit({ Funnel: f.funnel, Step: f.step, Outcome: f.outcome }, [{ name: 'FunnelStep', value: f.n }], now)
  }
}

/** Refusals are metrics too — a dashboard that only counts successes cannot show a kill switch
 *  doing its job, or a client stuck in a 400 loop. `Reason` is a closed set of five strings. */
function emitRejected(reason: TelemetryErrorCode, now: number): void {
  emit({ Reason: reason }, [{ name: 'Rejected', value: 1 }], now)
}

// ---- the handler ----------------------------------------------------------------------

async function accept(batch: TelemetryBatch, now: number): Promise<HttpResult> {
  const config = await loadConfig(now)
  if (!config.accepting) {
    emitRejected('closed', now)
    return fail(503, 'closed', 'Usage analytics is not being collected right now.')
  }
  const day = utcDay(now)
  // READ BEFORE THE UPSERT WRITES IT — the ordering is the whole correctness argument, so it is
  // its own statement rather than a member of a `Promise.all` that a later edit could reorder.
  const prior = await priorVersion(batch.env.analyticsId)
  const facts = await touchInstall(batch, config, day, prior)
  if (facts === null) {
    emitRejected('quota_exceeded', now)
    return fail(429, 'quota_exceeded', 'Daily event limit reached for this analytics id.')
  }
  const roll = rollupBatch(batch, facts)
  await writeCounters(day, facts.cohort, roll)
  emitMetrics(batch, roll, now)
  // COUNTS ONLY. No analyticsId, no dims, nothing that could reconstruct a batch from the log.
  // `cohort` is a two-valued population label, not an identifier: 'owner' says "one of at most a
  // handful of rows the operator marked themselves", which is a fact the operator already holds.
  log({
    msg: 'telemetry.accepted',
    channel: batch.env.channel,
    cohort: facts.cohort,
    events: batch.events.length,
    counters: roll.counters.length,
    funnels: roll.funnels.length,
    // A COUNT OF CUBE ROWS, never their dims: a machine class plus a timestamp in a log line is a
    // narrower description of one install than this log is allowed to carry.
    perf: roll.perf.length,
    // A COUNT OF ISSUES, never a fingerprint: a fingerprint plus a timestamp in a log line is
    // a join key back to one install's crash, which is the thing this log does not carry.
    errors: roll.errors.length,
    firstOfDay: facts.firstOfDay,
    // A BOOLEAN, never the two versions: this log is counts only, and a version pair plus a
    // timestamp is a good deal more identifying than a count.
    upgraded: facts.upgraded
  })
  return json(202, { ok: true, accepted: batch.events.length })
}

export async function handler(event: HttpEvent): Promise<HttpResult> {
  const now = Date.now()
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : (event.body ?? '')
    if (Buffer.byteLength(raw, 'utf8') > MAX_TELEMETRY_BODY_BYTES) {
      emitRejected('too_large', now)
      return fail(413, 'too_large', 'Telemetry batch is too large.')
    }
    // STEP 1.5, the twin of submit.ts's: a NUL in the RAW body, refused before the parser sees
    // it. This schema has no free text in it at all (every string field is enum- or
    // regex-bound, which `tests/wireSanitize.test.mts` pins by walking the schema), so a NUL
    // here cannot even be a mistake — but the check is one scan of a string already measured,
    // and both public endpoints answering the same way is worth more than the microseconds.
    if (hasNulByte(raw)) {
      emitRejected('invalid_event', now)
      return fail(400, 'invalid_event', 'Body contains a NUL byte.')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      emitRejected('invalid_event', now)
      return fail(400, 'invalid_event', 'Body is not valid JSON.')
    }

    const v = validateTelemetryBatch(parsed)
    if (!v.ok) {
      emitRejected('invalid_event', now)
      return fail(400, 'invalid_event', v.message, { field: v.field })
    }
    // An EMPTY batch is legal (the validator says so) and is answered without a round trip.
    // The flush loop never sends one; a server that 400'd it would be asserting something it
    // does not need to, and step 6's "first batch today" inference assumes events > 0.
    if (v.value.events.length === 0) return json(202, { ok: true, accepted: 0 })
    return await accept(v.value, now)
  } catch (err) {
    // An unclassified failure may well be the CONNECTION. Retiring it costs one handshake on
    // the next invoke and stops a dead socket poisoning a warm container for its whole life.
    if (sqlState(err) === null) resetClient()
    log({ msg: 'unhandled', error: errorMessage(err) })
    emitRejected('internal', now)
    return fail(500, 'internal', 'Something went wrong on our side.')
  }
}

