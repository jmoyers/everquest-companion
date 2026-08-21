/**
 * db.ts — the Aurora DSQL access layer for the submit handler.
 *
 * Split out of submit.ts for the same reason triageStore.mts is split out of
 * triage-feedback.mts: the handler should read as the §8.3 step list, not as
 * connection lifecycle. Everything DSQL-specific lives here.
 *
 * ---------------------------------------------------------------------------
 * NO SECRETS. THE PASSWORD IS AN IAM SIGNATURE.
 * ---------------------------------------------------------------------------
 * `@aws-sdk/dsql-signer` mints a short-lived auth token by SigV4-signing the
 * cluster hostname with the Lambda's own execution-role credentials — LOCALLY,
 * with no network call. That token is handed to postgres as the password. There
 * is no Secrets Manager entry, no SSM parameter, no rotation job and nothing to
 * leak: the credential is derived from the role at the moment it is needed, and
 * the role can only mint it because iam.tf grants `dsql:DbConnect`.
 *
 * It logs in as `feedback_ingest`, NOT `admin`. That database role holds INSERT
 * on `report` and nothing else — no SELECT, no UPDATE, no DELETE on the backlog
 * (schema.sql spells out every grant). §8.5's "the ingest path can create and
 * count; it cannot read the corpus or destroy anything" is enforced there.
 *
 * ---------------------------------------------------------------------------
 * ONE CLIENT, CACHED ACROSS WARM INVOKES
 * ---------------------------------------------------------------------------
 * Lambda runs one invocation per execution environment at a time, so there is no
 * connection race to guard and no pool to size: one `Client`, opened lazily on
 * the first request a container serves and reused by every later one. Only cold
 * requests pay for the token + TLS handshake, which is what keeps the function's
 * 10s timeout comfortable.
 *
 * The connection is retired after 45 minutes because DSQL closes connections at
 * 60. A socket-level error retires it immediately, so the next invoke reconnects
 * instead of inheriting a dead handle.
 *
 * ---------------------------------------------------------------------------
 * OPTIMISTIC CONCURRENCY: RETRY IS PART OF THE CONTRACT
 * ---------------------------------------------------------------------------
 * DSQL takes no locks. Two transactions that touch the same row both proceed,
 * and the second to commit is ABORTED with a serialization error (SQLSTATE
 * 40001). That is not an outage, it is how the database says "you raced" — so
 * every write here runs through `withRetry`, which is bounded, FULL-JITTERED,
 * and gives up rather than hammering.
 *
 * AND A CONFLICT COUNT ALONE IS NOT A HEALTH SIGNAL (JOS-394). The raw
 * `OccConflicts` alarm fired all day at a 5% conflict rate that lost nothing,
 * because the number that matters is the RATIO of conflicts to writes and the
 * fact of a retry ladder RUNNING OUT. So `alarms.tf` now watches two things:
 * conflicts per telemetry invocation (pathology), and the `DbRetryExhausted`
 * metric this module emits when it gives up (actual loss).
 */

import pg from 'pg'
import type { Client as PgClient, QueryResultRow } from 'pg'
import { DsqlSigner } from '@aws-sdk/dsql-signer'
// The ONE thing this module emits: `DbRetryExhausted`, when a bounded retry gives up. Both
// handlers bundle this file, so both can raise it, and the namespace is the product's single
// EMF namespace rather than a second one nobody would think to look in.
import { emit } from './emf'
// Explicit builtin imports, not ambient globals: infra/ is outside the repo's two
// tsconfigs and outside eslint's node-globals patterns, so `process` would be an
// undeclared identifier here. Importing it is also just more honest.
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'

const { Client, types } = pg

const HOST = process.env.DSQL_ENDPOINT ?? ''
const DB_USER = process.env.DSQL_USER ?? 'feedback_ingest'
const REGION = process.env.AWS_REGION ?? 'us-east-1'
/**
 * `application_name` is what a DSQL-side session listing calls this connection, so it must say
 * WHICH handler is holding it now that there are two of them (submit and telemetry) sharing
 * this module. It comes from the environment for the same reason `DSQL_USER` does: the two
 * functions differ only in their env, so one bundle-shaped default would be a lie in one of
 * them. Terraform sets it; the fallback is the older of the two callers.
 */
const APPLICATION = process.env.DSQL_APPLICATION ?? 'eqc-feedback-submit'

/** DSQL hangs up at 60 minutes. Retire well before, so we never race the hangup. */
const MAX_CONNECTION_AGE_MS = 45 * 60_000
/** A cold connect that has not landed in 4s is not going to save this request. */
const CONNECT_TIMEOUT_MS = 4_000
/** Four sequential statements at 3s each still fits inside the 10s function timeout. */
const STATEMENT_TIMEOUT_MS = 3_000

/**
 * FIVE ATTEMPTS AND FULL JITTER (JOS-394), and both numbers are bounded by the function's own
 * 10 s timeout rather than chosen for elegance.
 *
 * THE OLD LADDER was four attempts of `25 * attempt + random(0, 25)` — i.e. a barely-jittered
 * step. That is the shape that SYNCHRONISES retriers: two Lambdas that collided at t=0 both
 * wake within a 25 ms window and collide again. FULL JITTER — `sleep(random(0, BASE * 2^n))` —
 * is the documented AWS answer (the "Exponential Backoff and Jitter" article's measured
 * winner): the wake times of two racers are drawn from a widening interval, so the second
 * collision is already unlikely and the third is rare.
 *
 * THE BUDGET. Worst case is 50 + 100 + 200 + 400 = 750 ms of sleeping across four waits, plus
 * five attempts at a 3 s statement timeout — but the statements this wraps are single-digit
 * milliseconds and a 40001 is reported at COMMIT, not after a hang, so the realistic worst case
 * is under a second. The retries are also what the fifth attempt is FOR: with the counters
 * sharded 32 ways the conflict rate is ~0.2%, so reaching attempt five at all means something
 * unusual, and that is the case worth spending an extra 400 ms on before giving up.
 */
const MAX_ATTEMPTS = 5
const BACKOFF_MS = 25

/**
 * node-postgres returns int8 as a STRING to avoid precision loss. Every bigint in
 * this schema is an epoch-millisecond or a byte count — both exactly a double —
 * and `src/shared/feedback.ts` types all of them `number`. Convert once, here,
 * instead of casting at twenty call sites.
 */
types.setTypeParser(20, (value: string): number => Number(value))

/** CloudWatch gets structured lines; `no-console` is on repo-wide and stdout is the sink anyway. */
export function log(fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(fields)}\n`)
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** postgres puts the five-character SQLSTATE on `err.code`. */
export function sqlState(err: unknown): string | null {
  const code: unknown = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/** Serialization failure / deadlock: the caller raced and should simply try again. */
const RETRYABLE = new Set(['40001', '40P01'])

/** Full jitter: a wait drawn uniformly from [0, BASE * 2^attempt). Never a fixed step. */
function backoffMs(attempt: number): number {
  return Math.floor(Math.random() * BACKOFF_MS * 2 ** attempt)
}

export async function withRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (err) {
      const code = sqlState(err)
      if (code === null || !RETRYABLE.has(code)) throw err
      if (attempt >= MAX_ATTEMPTS) {
        // GIVING UP IS A METRIC, NOT JUST A LOG LINE (JOS-394). A conflict is normal and a
        // retry is the contract; an EXHAUSTED ladder means a write was LOST — the caller gets a
        // 500 and the client's batch is buffered for a later flush, so nothing surfaces to a
        // user and nothing would surface to us either without this. `alarms.tf` alarms on it at
        // >= 1, because one lost aggregate write is already worth a look.
        //
        // NO DIMENSIONS, on purpose: an empty dimension set is the aggregate-only document (see
        // emf.ts), which is what makes ONE alarm cover both handlers, and a `Label` dimension
        // would mint a billed metric per statement name to re-answer what the log line beside
        // it already says. Nothing identifying can reach here — `label` is a compile-time
        // constant from the call site and is not in the document at all.
        emit({}, [{ name: 'DbRetryExhausted', value: 1 }], Date.now())
        log({ msg: 'db.retry.exhausted', label, attempts: attempt, code })
        throw err
      }
      log({ msg: 'db.conflict', label, attempt, code })
      await sleep(backoffMs(attempt))
    }
  }
}

// ---- connection ---------------------------------------------------------------------

let client: PgClient | null = null
let connectedAt = 0

/** Drop the cached connection. The next call opens a fresh one. */
export function resetClient(): void {
  const dead = client
  client = null
  if (dead) void dead.end().catch(() => undefined)
}

async function open(): Promise<PgClient> {
  const signer = new DsqlSigner({ hostname: HOST, region: REGION })
  // getDbConnectAuthToken (not ...AdminAuthToken) — this is the non-admin path,
  // and asking for the admin token would fail against `dsql:DbConnect` anyway.
  const token = await signer.getDbConnectAuthToken()
  const fresh = new Client({
    host: HOST,
    port: 5432,
    // DSQL gives exactly one database per cluster and it is always called this.
    database: 'postgres',
    user: DB_USER,
    password: token,
    ssl: { rejectUnauthorized: true },
    application_name: APPLICATION,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    // DSQL rejects SET statement_timeout ("setting configuration parameter not
    // supported", live 2026-08-04) — node-postgres sends it on connect when the
    // option is present. query_timeout is CLIENT-side (a socket timer, no SET
    // on the wire) and stays: it is the only statement bound we get.
    query_timeout: STATEMENT_TIMEOUT_MS,
  })
  // A dropped socket surfaces here, NOT at the next query. Without this listener
  // it would be an unhandled 'error' event and the container would die.
  fresh.on('error', (err: Error) => {
    log({ msg: 'db.socket', error: err.message })
    if (client === fresh) client = null
  })
  await fresh.connect()
  client = fresh
  connectedAt = Date.now()
  return fresh
}

export async function connect(): Promise<PgClient> {
  if (client && Date.now() - connectedAt < MAX_CONNECTION_AGE_MS) return client
  if (client) resetClient()
  return open()
}

export async function query<R extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const c = await connect()
  const res = await c.query<R>(text, params)
  return res.rows
}

export async function execute(text: string, params: unknown[] = []): Promise<number> {
  const c = await connect()
  const res = await c.query(text, params)
  return res.rowCount ?? 0
}

/**
 * The report and its idempotency row land together or not at all. In DynamoDB
 * that took a TransactWriteItems; here it is what a transaction is for.
 */
export async function transaction<T>(run: (c: PgClient) => Promise<T>): Promise<T> {
  const c = await connect()
  await c.query('BEGIN')
  try {
    const out = await run(c)
    await c.query('COMMIT')
    return out
  } catch (err) {
    try {
      await c.query('ROLLBACK')
    } catch {
      // The rollback itself failed, which means the connection is unusable.
      resetClient()
    }
    throw err
  }
}

// ---- retention ----------------------------------------------------------------------
//
// DYNAMODB HAD TTL. DSQL HAS NOTHING. So the three counter tables — quota (3d),
// idempotency (7d), dedupe probe (2d) — are swept by the ingest path itself,
// right after a submit has cleared the quota gate.
//
// THE RULES THAT MAKE THAT SAFE:
//   * TIME-GATED — at most once per 10 minutes per warm container, so it is not
//     on the critical path of a typical request.
//   * BOUNDED — 200 rows per table per pass, via a subquery LIMIT. DSQL caps a
//     transaction at 3,000 modified rows, so an unbounded DELETE would not just
//     be slow, it would FAIL once enough rows expired. The bound is correctness.
//   * BEST EFFORT — every failure is logged and swallowed. A janitor must never
//     be able to turn a good report into a 500.
//
// Rows therefore expire *lazily*: they go away as traffic flows, not on a clock.
// If ingest goes idle they linger, which costs a few kilobytes and leaks nothing
// (an installId is an anonymous token, §9.3). That is the honest trade for not
// standing up an EventBridge rule and a second Lambda to delete six rows a week.

const SWEEP_INTERVAL_MS = 10 * 60_000
const SWEEP_LIMIT = 200

const SWEEP_TABLES = [
  { table: 'install_quota', keys: 'install_id, quota_day' },
  { table: 'report_idempotency', keys: 'install_id, client_report_id' },
  { table: 'dedupe_probe', keys: 'hash, probe_day' },
]

let lastSweepAt = 0

export async function sweepExpired(now: number): Promise<void> {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return
  lastSweepAt = now
  for (const { table, keys } of SWEEP_TABLES) {
    // Table and key names are compile-time constants from the list above; the
    // only value that crosses is the parameterised cutoff.
    const sql =
      `DELETE FROM ${table} WHERE (${keys}) IN ` +
      `(SELECT ${keys} FROM ${table} WHERE expires_at < $1 LIMIT ${SWEEP_LIMIT})`
    try {
      const rows = await execute(sql, [now])
      if (rows > 0) log({ msg: 'retention.swept', table, rows })
    } catch (err) {
      log({ msg: 'retention.failed', table, error: errorMessage(err) })
    }
  }
}
