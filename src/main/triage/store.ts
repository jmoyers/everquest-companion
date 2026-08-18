/**
 * store.ts — the I/O half of triage: Aurora DSQL + S3, directly over IAM.
 *
 * RELOCATED from `scripts/triageStore.mts` (unchanged in substance) so that the SAME code
 * backs both readers: the `triage-feedback` CLI, which still imports it, and the dev-only
 * triage tab in the app. There is exactly one implementation of "read the backlog", and the
 * two front ends cannot drift apart.
 *
 * ===========================================================================================
 * WHO CAN USE THIS: whoever holds the owner's AWS credentials. Nobody else. That is the whole
 * access-control story and it is deliberate.
 *
 *   * NO PASSWORD EXISTS. DSQL authenticates with a short-lived IAM token that
 *     `@aws-sdk/dsql-signer` derives LOCALLY from whatever credentials the process is running
 *     under — read from the launching shell's `AWS_PROFILE` (default `eqc`), exactly like the
 *     CLI. Nothing is stored in the app, nothing is rotated, nothing can be copied out of a
 *     config file — the same reason the ingest Lambda needs no secret.
 *   * A build shipped to a user has no credentials, so every statement here would fail at the
 *     IAM boundary. It also has no `@aws-sdk/*` to load in the first place: those are
 *     devDependencies, which electron-builder never packages. The dev-flag guard in
 *     `src/main/index.ts` is the third, outermost lock, not the only one.
 *   * The CLI connects as `admin` (IAM action `dsql:DbConnectAdmin`, granted to the triage
 *     role in iam.tf) because it is the operator identity: it applies the schema and it is the
 *     deletion path for `forget` and `wipe`.
 * ===========================================================================================
 *
 * THERE IS NO SERVER-SIDE READ API (D4). The dev machine has an AWS profile; this module opens
 * a postgres connection to the DSQL cluster and talks to S3 with the SDK. Building a public,
 * authenticated read endpoint would be a second thing to secure for zero benefit.
 *
 * POLITENESS, the same discipline AGENTS.md's scraper law asks of every fetcher in this repo,
 * applied to a paid API instead of someone else's server:
 *   * CACHE FIRST — `terraform output -json` is shelled out ONCE and cached in
 *     .triage/stack.json; a downloaded slice is written to .triage/slices/ and a second read
 *     never re-downloads it. Re-runs are free, and the app shares the CLI's cache.
 *   * ONE ROUND TRIP — every read is a single indexed statement with a LIMIT.
 *   * BACK OFF — DSQL is optimistic: a write that raced is aborted at commit with SQLSTATE
 *     40001 and must be retried, not hammered. `withRetry` is bounded and jittered.
 *   * IDEMPOTENT — every mutation is keyed by primary key; re-running a command converges
 *     instead of duplicating.
 *
 * PHYSICAL NAMES ARE NEVER COMMITTED. Everything comes from the Terraform outputs at run time;
 * .triage/ is gitignored.
 */

import pg from 'pg'
import type { Client as PgClient, QueryResultRow } from 'pg'
import { DsqlSigner } from '@aws-sdk/dsql-signer'
import { S3Client } from '@aws-sdk/client-s3'
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { TriageReport } from '../../../scripts/triageCluster.mjs'
import type { AppChannelTag, FeedbackType, ReportStatus, Severity } from '../../shared/feedback'
import { sanitizeMultiline } from '../../shared/sanitizeText'
// `applySchema` below needs the binding, and the re-export further down is what keeps every
// existing `import { splitStatements } from '…/store'` working. A bare `export … from` creates no
// local binding, which is why both lines exist.
import { splitStatements } from '../../shared/analyticsSchema'
import { INFRA_DIR, TRIAGE_DIR } from './paths'
import type { InventoryDownload, SliceRescrub } from './rows'

export type { InventoryDownload, SliceRescrub }

// The S3 half — which objects a report owns, how they are downloaded and cleaned, and how they
// are deleted — lives in ./attachments.ts (see its header for why it is a half worth naming).
// Re-exported by NAME, never `export *`: the star form becomes a runtime property copy under
// tsx's CJS interop that cjs-module-lexer cannot see, and every named import through this file
// stops resolving (the lesson the analytics re-export block below records at length).
export {
  attachmentKeysOf,
  attachmentReports,
  deleteSlice,
  downloadInventory,
  downloadSlice,
  inventoryKeyOf,
  logKeyOf,
  logObjectExists,
  type AttachmentReport
} from './attachments'

const { Client, types } = pg

// Where things live moved to ./paths.ts when `attachments.ts` became a second consumer of
// TRIAGE_DIR (JOS-296) — a value import from here into a module this file re-exports would be a
// runtime cycle. Re-exported so every consumer keeps importing from the one store module.
export { SCHEMA_FILE, TRIAGE_DIR } from './paths'

const STACK_FILE = join(TRIAGE_DIR, 'stack.json')

/**
 * Same reasoning as the Lambda's db.ts: int8 comes back as a STRING by default,
 * and every bigint in this schema is an epoch-millisecond or a byte count that the
 * shared contract types as `number`.
 */
types.setTypeParser(20, (value: string): number => Number(value))

export interface Stack {
  region: string
  cluster_endpoint: string
  bucket_name: string
  triage_role_arn: string
  lambda_role_arn: string
  telemetry_lambda_role_arn: string
  /** JOS-398: the nightly export function's role, mapped to the read-only `analytics_export`. */
  export_lambda_role_arn: string
  api_url: string
}

export interface AccessOptions {
  profile?: string
  roleArn?: string
  /**
   * THE TEST SEAM, and the only one this module has. Everything below it — the IAM token, the
   * TLS handshake, the postgres wire — needs real credentials and a real cluster, so the
   * connection LIFECYCLE (retire a dead socket, never open two, classify a drop) could only be
   * exercised against production until this existed. `tests/triageConnection.test.mts` passes a
   * fake client and drives exactly the sequence that crashed the app.
   *
   * It is an override, never a default: absent, the real connector below runs.
   */
  open?: () => Promise<PgClient>
}

const STACK_KEYS = [
  'region',
  'cluster_endpoint',
  'bucket_name',
  'triage_role_arn',
  'lambda_role_arn',
  // Added by usage-analytics A2. A stack.json CACHED before that key existed will not have
  // it — the cache is read back without re-validating, deliberately (it is a cache, not a
  // contract), so `migrate` checks for an unsubstituted placeholder and says `--refresh`.
  'telemetry_lambda_role_arn',
  // Added by JOS-398, on the same terms as the key above it: a stack.json cached before this
  // output existed simply has no value for it, and `migrate` catches the unsubstituted
  // `${EXPORT_LAMBDA_ROLE_ARN}` and says `--refresh` rather than mapping a role to nothing.
  'export_lambda_role_arn',
  'api_url',
] as const

/**
 * Resolve every physical name from `terraform output -json`, ONCE, and cache it.
 * Delete .triage/stack.json (or pass refresh) after an apply that renamed anything.
 */
export function loadStack(refresh = false): Stack {
  if (!refresh && existsSync(STACK_FILE)) {
    return JSON.parse(readFileSync(STACK_FILE, 'utf8')) as Stack
  }
  const raw = execFileSync('terraform', ['output', '-json'], {
    cwd: INFRA_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const outputs = JSON.parse(raw) as Record<string, { value: unknown } | undefined>
  const stack = {} as Record<string, string>
  for (const key of STACK_KEYS) {
    const value = outputs[key]?.value
    if (typeof value !== 'string') {
      throw new Error(`terraform output is missing "${key}" - has the stack been applied?`)
    }
    stack[key] = value
  }
  mkdirSync(TRIAGE_DIR, { recursive: true })
  writeFileSync(STACK_FILE, `${JSON.stringify(stack, null, 2)}\n`)
  return stack as unknown as Stack
}

export type Row = Record<string, unknown>

export interface Clients {
  query: <R extends QueryResultRow = Row>(text: string, params?: unknown[]) => Promise<R[]>
  execute: (text: string, params?: unknown[]) => Promise<number>
  s3: S3Client
  stack: Stack
  close: () => Promise<void>
}

const RETRYABLE = new Set(['40001', '40P01'])
const MAX_ATTEMPTS = 4

/** Exported for usageStore.ts, the analytics half split from this file (see its header). */
export function sqlState(err: unknown): string | null {
  const code: unknown = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (err) {
      const code = sqlState(err)
      if (attempt >= MAX_ATTEMPTS || code === null || !RETRYABLE.has(code)) throw err
      await sleep(25 * attempt)
    }
  }
}

/**
 * `--profile` is usually all that is needed: the deploy profile itself performs the
 * role assumption (source_profile + role_arn in ~/.aws/config). `--role-arn` is for
 * the case where it does not — a second machine, or a future CI job. Whichever it
 * is, the same credentials sign the DSQL token AND the S3 requests.
 *
 * The connection is opened LAZILY on the first statement: `list --help` and a bad
 * argument must not cost a database round trip.
 */
export function makeClients(stack: Stack, options: AccessOptions): Clients {
  if (options.profile) process.env.AWS_PROFILE = options.profile
  const credentials = options.roleArn
    ? fromTemporaryCredentials({
        params: { RoleArn: options.roleArn, RoleSessionName: 'eq-companion-triage' },
      })
    : undefined
  const config = {
    region: stack.region,
    maxAttempts: 5,
    retryMode: 'adaptive',
    ...(credentials ? { credentials } : {}),
  }

  const openConnection =
    options.open ??
    (async (): Promise<PgClient> => {
      const signer = new DsqlSigner({
        hostname: stack.cluster_endpoint,
        region: stack.region,
        ...(credentials ? { credentials } : {}),
      })
      const fresh = new Client({
        host: stack.cluster_endpoint,
        port: 5432,
        database: 'postgres',
        user: 'admin',
        password: await signer.getDbConnectAdminAuthToken(),
        ssl: { rejectUnauthorized: true },
        application_name: 'eq-companion-triage',
      })
      await fresh.connect()
      return fresh
    })

  let client: PgClient | null = null
  /** The connect IN FLIGHT. See `connect` — this is what makes three parallel reads one socket. */
  let opening: Promise<PgClient> | null = null
  /**
   * ONE socket, opened once, RETIRED WHEN IT DIES. Two properties, both learned the hard way:
   *
   *   * THE ASYNC 'error' EVENT HAS A LISTENER. A dropped connection surfaces on the client as
   *     an `error` EVENT, not as a rejected query — and node's EventEmitter THROWS an unhandled
   *     'error', which in the main process is an uncaughtException. That is precisely the
   *     `[main:uncaughtException] Error: Connection terminated unexpectedly` this app wrote to
   *     errors.log four times in three seconds (2026-08-05). The Lambda's `infra/lambda/db.ts`
   *     has had this listener since it was written; this side did not. It swallows: the drop is
   *     reported to the OWNER through the next statement's named degrade (`unreachable`, which
   *     the Analytics tab renders as an unavailable state), not through a crash. Retiring the
   *     handle here is what makes that next statement reconnect instead of inheriting a corpse.
   *   * ONE CONNECT AT A TIME. The cached handle was only assigned AFTER the await, so the
   *     Analytics tab's `Promise.all` of three reads opened THREE sockets and orphaned two —
   *     which is also why one drop produced four crashes rather than one.
   */
  const connect = async (): Promise<PgClient> => {
    if (client) return client
    opening ??= openConnection().then(
      (fresh) => {
        fresh.on('error', () => {
          if (client === fresh) client = null
        })
        client = fresh
        opening = null
        return fresh
      },
      (err: unknown) => {
        opening = null
        throw err
      },
    )
    return opening
  }

  return {
    query: async <R extends QueryResultRow = Row>(text: string, params: unknown[] = []) => {
      const c = await connect()
      return withRetry(async () => (await c.query<R>(text, params)).rows)
    },
    execute: async (text: string, params: unknown[] = []) => {
      const c = await connect()
      return withRetry(async () => (await c.query(text, params)).rowCount ?? 0)
    },
    s3: new S3Client(config),
    stack,
    close: async () => {
      const open = client
      client = null
      if (open) await open.end()
    },
  }
}

// ---- schema ------------------------------------------------------------------------

/**
 * The statement splitter MOVED to `src/shared/analyticsSchema.ts` (JOS-398) and is re-exported
 * here BY NAME, so every existing import path is unchanged. It moved because a third caller
 * appeared that cannot reach this module: the nightly S3 export Lambda needs the same statement
 * count for its manifest, and importing this file into a Lambda would bundle S3 clients, IAM role
 * assumption and a `terraform` shell-out into a function that only reads rows. The rule it
 * implements — a statement ends at the first line whose last character is `;` — is unchanged and
 * is written down at the top of schema.sql.
 */
export { splitStatements } from '../../shared/analyticsSchema'

/**
 * Already-exists codes: duplicate_table (also index), duplicate_object (role/grant),
 * duplicate_schema — and duplicate_column, which is what an `ALTER TABLE … ADD COLUMN` reports
 * when it has already run.
 *
 * WHY THE ALTER IS NOT SPELLED `ADD COLUMN IF NOT EXISTS`: DSQL's supported ALTER TABLE grammar
 * is a documented subset and `IF NOT EXISTS` is not in it, so a statement that guards itself
 * would risk failing the whole migrate run on syntax. Treating 42701 the way 42P07 is already
 * treated makes the plain form idempotent, which is the property that matters.
 */
const ALREADY_EXISTS = new Set(['42P07', '42710', '42P06', '42701'])

/** undefined_table — the one error the analytics reader must tell apart from "no rows yet". */
export const UNDEFINED_TABLE = '42P01'

export interface MigrateStep {
  sql: string
  status: 'applied' | 'exists'
}

/**
 * Apply the schema, ONE STATEMENT PER TRANSACTION — a DSQL law (a transaction may
 * carry only one DDL statement, and may not mix DDL with DML). node-postgres runs
 * each `query` in its own implicit transaction, so obeying the law is simply a
 * matter of never batching.
 *
 * IDEMPOTENT: an "already exists" is reported, not thrown. Anything else IS thrown,
 * with the offending statement, because a half-applied schema is worth stopping on.
 */
export async function applySchema(c: Clients, sql: string): Promise<MigrateStep[]> {
  const steps: MigrateStep[] = []
  for (const statement of splitStatements(sql)) {
    try {
      await c.execute(statement)
      steps.push({ sql: statement, status: 'applied' })
    } catch (err) {
      const code = sqlState(err)
      if (code === null || !ALREADY_EXISTS.has(code)) {
        throw new Error(`${String(err)}\n\nwhile applying:\n${statement}`)
      }
      steps.push({ sql: statement, status: 'exists' })
    }
  }
  return steps
}

// ---- reads -------------------------------------------------------------------------

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback)

/**
 * A text column, SANITIZED — the CLI's half of the owner-side display hardening.
 *
 * These columns are client-supplied and they end up in the OWNER's terminal: `list` prints the
 * description, `digest` renders it into markdown, `issue` puts it in a title. The wire
 * validators now refuse control characters (src/shared/feedback.ts), but rows written before
 * that rule existed are still in the table, and a rule that only guards new rows is not a guard.
 * So every string leaving this mapper goes through the shared `sanitizeMultiline` first: ANSI
 * escape sequences whole, C0/DEL/C1 apart from tab and newline, and the invisible/BiDi class.
 *
 * `str()` was inlined into this — there is deliberately no un-sanitized way to read a client
 * text column out of this module.
 */
const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? sanitizeMultiline(v) : fallback

/** Report row -> the PII-free projection clustering and the digest work on. */
export function toTriageReport(row: Row): TriageReport {
  return {
    reportId: str(row.report_id),
    type: str(row.report_type, 'bug') as FeedbackType,
    description: str(row.description),
    appVersion: str(row.app_version, '?'),
    platform: str(row.platform, '?'),
    channel: str(row.channel, 'prod') as AppChannelTag,
    status: str(row.status, 'new') as ReportStatus,
    spamScore: num(row.spam_score),
    receivedAt: num(row.received_at),
    hasLog: row.log_json !== null && row.log_json !== undefined,
    // DECLARED, exactly like `hasLog` — whether the object actually landed costs a HeadObject
    // and is a separate question the list deliberately does not ask (rows.ts's tri-state note).
    // A row written before the column existed reads `undefined`, i.e. no dump, which is true.
    hasInventory: row.inventory_json !== null && row.inventory_json !== undefined,
  }
}

export interface ListFilter {
  channel: AppChannelTag | 'all'
  sinceMs: number
  limit: number
  status?: ReportStatus
  type?: FeedbackType
  minScore?: number
}

/**
 * ONE indexed statement. `--since` is `received_at >= :floor` against
 * `report_by_channel (channel, received_at)`, which is what gsi1 was for.
 *
 * DELIBERATE IMPROVEMENT over the DynamoDB version, which could only key on
 * channel + time and had to filter status/type/score in JS AFTER the page limit —
 * so `--status new --limit 100` really meant "of the last 100 reports, the new
 * ones". Here the predicates are in the WHERE and the LIMIT applies to the
 * ANSWER. Same flags, same meaning, no truncation artefact.
 */
const LIST_SQL = `SELECT * FROM report
 WHERE channel = ANY($1::text[])
   AND received_at >= $2
   AND ($3::text IS NULL OR status = $3)
   AND ($4::text IS NULL OR report_type = $4)
   AND spam_score >= $5
 ORDER BY received_at DESC
 LIMIT $6`

export function listReports(c: Clients, filter: ListFilter): Promise<Row[]> {
  const channels: AppChannelTag[] = filter.channel === 'all' ? ['prod', 'dev'] : [filter.channel]
  return c.query(LIST_SQL, [
    channels,
    filter.sinceMs,
    filter.status ?? null,
    filter.type ?? null,
    filter.minScore ?? 0,
    filter.limit,
  ])
}

export async function getReport(c: Clients, reportId: string): Promise<Row | null> {
  const rows = await c.query('SELECT * FROM report WHERE report_id = $1', [reportId])
  return rows[0] ?? null
}

/**
 * `wipe --install` only. There is deliberately NO index on install_id (the plan
 * refused a third GSI for the same reason), so this is a full table read; callers
 * print a loud warning before using it (§10.2).
 */
export function reportsForInstall(c: Clients, installId: string): Promise<Row[]> {
  return c.query('SELECT * FROM report WHERE install_id = $1', [installId])
}

/**
 * The kill-switch row (§9.6), keyed read. `setAccepting` upserts it and the CLI never needed
 * to read it back — an Ops PANEL does, because a toggle that cannot show its current position
 * is a button, not a switch. Null when the seed statement has not run against this cluster.
 */
export async function getFeedbackConfig(c: Clients): Promise<Row | null> {
  const rows = await c.query(`SELECT * FROM feedback_config WHERE id = 'FEEDBACK'`)
  return rows[0] ?? null
}

/**
 * The block list. Bounded by a LIMIT like every other read here: this table has one row per
 * install ever blocked OR unblocked (a `block` followed by an `unblock` leaves a row with
 * `blocked = false`), so "everything" is not a size the UI should promise to render.
 */
export function listInstallProfiles(c: Clients, limit = 200): Promise<Row[]> {
  return c.query('SELECT * FROM install_profile ORDER BY blocked_at DESC NULLS LAST LIMIT $1', [
    limit,
  ])
}

// ---- usage analytics (docs/plans/usage-analytics.md §4) -----------------------------
//
// The analytics half lives in usageStore.ts — split out when two independent waves composed
// this file past the 400-line ceiling. Re-exported here so every consumer keeps importing from
// the one store module; the split moved code, not import paths.
//
// IT HAS TO BE AN EXPLICIT LIST, AND THAT IS MEASURED, NOT STYLE. JOS-100 tried
// `export * from './usageStore'` here — one line instead of eighteen, when adding
// `readErrorReports` pushed this file back over the ceiling the split existed to get it under —
// and `tests/triageConnection.test.mts` went red with
// `does not provide an export named 'unreachable'`. Under tsx these modules link through CJS
// interop, and a star re-export becomes a RUNTIME property copy that cjs-module-lexer cannot
// see, so every named import through this file stops resolving. The names are therefore
// GROUPED rather than one-per-line: same explicitness, and the grouping says which half of the
// analytics store each name belongs to.
export {
  // failure classifiers, shared with the backend's degradation arms
  missingTable, missingColumn, unreachable,
  // read caps
  USAGE_ROW_LIMIT, INSTALL_ROW_LIMIT, OWNER_ROW_LIMIT,
  // reads
  readUsageDaily, readUsageFunnelDaily, readAnalyticsInstalls, readAnalyticsInstall,
  readReportVersions, readErrorReports, readOwnerInstalls, readPerfDaily,
  // writes
  setInstallCohort, deleteAnalyticsInstall, setTelemetryAccepting,
} from './usageStore'

// ---- writes ------------------------------------------------------------------------

export interface TriagePatch {
  status?: ReportStatus
  severity?: Severity
  cluster?: string
  dupeOf?: string
  note?: string
  issueUrl?: string
}

/** The triage-only columns, keyed by the patch field that writes them. */
const PATCH_COLUMN: Record<keyof TriagePatch, string> = {
  status: 'status',
  severity: 'severity',
  cluster: 'cluster_id',
  dupeOf: 'dupe_of',
  note: 'disposition',
  issueUrl: 'issue_url',
}

/** Idempotent by construction: a keyed UPDATE of exactly the fields provided. */
export async function setTriage(c: Clients, reportId: string, patch: TriagePatch): Promise<void> {
  const sets = ['triaged_at = $1']
  const values: unknown[] = [Date.now()]
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    values.push(value)
    sets.push(`${PATCH_COLUMN[key as keyof TriagePatch]} = $${String(values.length)}`)
  }
  values.push(reportId)
  const rows = await c.execute(
    `UPDATE report SET ${sets.join(', ')} WHERE report_id = $${String(values.length)}`,
    values,
  )
  // The DynamoDB version used `ConditionExpression: attribute_exists(pk)`; a typo'd
  // reportId must fail loudly rather than silently update nothing.
  if (rows === 0) throw new Error(`no such report: ${reportId}`)
}

export async function setBlocked(
  c: Clients,
  installId: string,
  blocked: boolean,
  reason: string,
): Promise<void> {
  await c.execute(
    `INSERT INTO install_profile (install_id, blocked, blocked_reason, blocked_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (install_id) DO UPDATE
        SET blocked = EXCLUDED.blocked,
            blocked_reason = EXCLUDED.blocked_reason,
            blocked_at = EXCLUDED.blocked_at`,
    [installId, blocked, reason, Date.now()],
  )
}

/**
 * The kill switch (§9.6). One statement — instant, no deploy, no release. Written
 * as an UPSERT so it works even against a cluster whose config row was never
 * seeded; `$2 IS NULL` keeps the existing message when `--message` is omitted.
 */
export async function setAccepting(c: Clients, accepting: boolean, message?: string): Promise<void> {
  await c.execute(
    `INSERT INTO feedback_config (id, accepting, closed_message, max_per_install_per_day)
     VALUES ('FEEDBACK', $1, COALESCE($2::text, 'Feedback is paused right now. Please try again later.'), 10)
     ON CONFLICT (id) DO UPDATE
        SET accepting = EXCLUDED.accepting,
            closed_message = COALESCE($2::text, feedback_config.closed_message)`,
    [accepting, message ?? null],
  )
}

/**
 * `forget` (§3.5): stamp the report as redacted. The caller has just deleted the log
 * slice object; this records on the row that it happened, so a later reader can tell a
 * report that never attached a slice from one whose slice was destroyed on request.
 *
 * IT NO LONGER CLEARS A CONTACT FIELD because there is no longer one to clear — `title`
 * and `contact` left the wire contract and then the schema. The description stays, as it
 * always did: it IS the bug report.
 */
export async function stampRedacted(c: Clients, reportId: string): Promise<void> {
  const rows = await c.execute('UPDATE report SET redacted_at = $1 WHERE report_id = $2', [
    Date.now(),
    reportId,
  ])
  if (rows === 0) throw new Error(`no such report: ${reportId}`)
}

export async function deleteReportRow(c: Clients, reportId: string): Promise<void> {
  await c.execute('DELETE FROM report WHERE report_id = $1', [reportId])
}
