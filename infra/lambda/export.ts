/**
 * export.ts — the nightly logical export of every analytics table to S3 (JOS-398).
 *
 * A THIRD LAMBDA, on an EventBridge schedule, with no HTTP surface at all. Owner ruling
 * 2026-08-16: the analytics data must never be lost. Aurora DSQL's own durability answers a disk
 * dying; it does not answer a bad migration, `scripts/analyticsBackfill.mts` swapping the wrong
 * table, a fat-fingered DROP, or an account-level event. AWS Backup (infra/backup.tf) answers
 * those at the cluster level; this answers them at the ROW level, in a format anybody can read
 * with `gunzip` and no code from this repo.
 *
 * ---------------------------------------------------------------------------------------------
 * IT WRITES JOS-399's FORMAT, EXACTLY, SO THERE IS ONE RESTORE PATH AND NOT TWO
 * ---------------------------------------------------------------------------------------------
 * `<prefix>/<YYYY-MM-DD>/<table>.json.gz` — a gzipped JSON array with ONE ROW PER LINE — plus a
 * `manifest.json` carrying row counts, a sha256 per file, the cluster id and the schema revision.
 * That is byte-for-byte the shape `triage-feedback analytics export` writes to the operator's own
 * disk, which means `aws s3 sync` of one night into a directory and then
 * `triage-feedback analytics import <dir>` restores it with no S3-specific code anywhere:
 * checksums verified before the first INSERT, then the same idempotent keyed upsert. Both tickets
 * agreed on ONE importer and JOS-399 landed it first; this is the half that bends to it, and the
 * shape they share lives in `src/shared/analyticsSchema.ts`.
 *
 * ---------------------------------------------------------------------------------------------
 * TWO PREFIXES, AND THE SPLIT IS A PROMISE RATHER THAN A FILING SYSTEM
 * ---------------------------------------------------------------------------------------------
 * `exports/<day>/` holds the counters, the install rows, the config and the ops tables — anonymous
 * sums, closed enums and anonymous tokens. They are KEPT: "the series starts 2026-08-04 and there
 * will never be earlier data" is exactly what makes an old copy valuable.
 *
 * `backlog/<day>/` holds `report`, the ONE table carrying anything a person wrote. It is a
 * separate top-level prefix for one reason: an S3 lifecycle filter is a PREFIX and cannot pick a
 * file out of a shared directory, and SECURITY.md promises that asking for a report to be deleted
 * deletes it. A versioned archive with no expiry would have quietly turned that into "the live row
 * goes and a copy of your words stays forever". Under its own prefix it can expire (90 days —
 * infra/export.tf argues it at the rule), and SECURITY.md states the window instead of implying
 * instant erasure. Each prefix gets its OWN manifest, so each is a complete, independently
 * restorable export.
 *
 * ---------------------------------------------------------------------------------------------
 * IT CONNECTS AS `analytics_export`, WHICH HOLDS SELECT AND NOTHING ELSE
 * ---------------------------------------------------------------------------------------------
 * A third DATABASE role (infra/schema.sql), for the reason `telemetry_ingest` is a second one:
 * what a function may do should be readable as a GRANT list. This one's is SELECT on every table
 * and no INSERT, no UPDATE, no DELETE, anywhere — VERIFIED against a real cluster, which answered
 * `42501 permission denied` to all three. It is the only role that can read both the counters and
 * the backlog, which is why it is also the only one with no public trigger: EventBridge invokes
 * it, its IAM policy is `dsql:DbConnect` plus `s3:PutObject` under two prefixes, and nothing
 * answers HTTP.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY IT DOES NOT USE ./db.ts
 * ---------------------------------------------------------------------------------------------
 * That module is shaped for a 30 ms invocation behind a public endpoint: a client cached across
 * warm invokes, a 3 s client-side statement bound, and a full-jitter OCC retry ladder. This
 * function runs once a day, holds one connection for one pass, retries nothing (a SELECT cannot
 * lose a write race), and needs statements measured in seconds. Making db.ts configurable enough
 * to serve both would also move `source_code_hash` on BOTH ingest functions for a change neither
 * needs — an avoidable redeploy of the two things users actually talk to.
 */

import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import pg from 'pg'
import type { Client as PgClient } from 'pg'
import { DsqlSigner } from '@aws-sdk/dsql-signer'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { emit } from './emf'
import {
  BACKLOG_TABLES,
  EXPORT_TABLES,
  MANIFEST_FILE,
  clusterIdOf,
  jsonArrayLines,
  schemaRevision,
  type ExportManifest,
  type ExportTable,
  type ManifestEntry,
} from '../../src/shared/analyticsSchema'
// The schema file itself, bundled as TEXT by infra/build.mjs. It is what `schemaRevision` counts,
// and reading it at run time is not an option in a Lambda — so the number in the manifest is a
// fact about the bundle that was deployed, which is exactly the question a restore asks.
import SCHEMA_SQL from '../schema.sql'

const { Client, types } = pg

const HOST = process.env.DSQL_ENDPOINT ?? ''
const DB_USER = process.env.DSQL_USER ?? 'analytics_export'
const REGION = process.env.AWS_REGION ?? 'us-east-1'
const BUCKET = process.env.ARCHIVE_BUCKET ?? ''
const APPLICATION = process.env.DSQL_APPLICATION ?? 'eqc-analytics-export'

/** Rows per SELECT. Small enough that one page is never a slow statement, large enough that a
 *  table of a few hundred thousand rows is a few hundred round trips. */
const PAGE = 2_000
/** A runaway guard, not a size limit — the same number and the same argument as the operator-side
 *  export's: a counter table past this means something is writing rows nobody designed. */
const MAX_ROWS = 5_000_000
/** A cold connect that has not landed in 10 s is not going to save this run. */
const CONNECT_TIMEOUT_MS = 10_000
/** One page, client-side. `SET statement_timeout` is unsupported on DSQL (db.ts records the live
 *  finding), so a socket timer is the only statement bound available. */
const STATEMENT_TIMEOUT_MS = 30_000
/** postgres 42P01 — the table is not on this cluster, which is a different fact from "empty". */
const UNDEFINED_TABLE = '42P01'

/** Same reasoning as db.ts: int8 arrives as a STRING and every bigint here is exactly a double. */
types.setTypeParser(20, (value: string): number => Number(value))

/** Structured stdout, the same shape both ingest handlers use. */
function log(fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(fields)}\n`)
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const codeOf = (err: unknown): string | null => {
  const code: unknown = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/** `YYYY-MM-DD` in UTC — the same day key every counter table is written with. */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10)
}

async function open(): Promise<PgClient> {
  const signer = new DsqlSigner({ hostname: HOST, region: REGION })
  // The NON-admin token, exactly as the ingest path takes it: this role is granted
  // `dsql:DbConnect`, so asking for the admin token would fail at the IAM boundary anyway.
  const client = new Client({
    host: HOST,
    port: 5432,
    database: 'postgres',
    user: DB_USER,
    password: await signer.getDbConnectAuthToken(),
    ssl: { rejectUnauthorized: true },
    application_name: APPLICATION,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS,
  })
  // Without a listener a dropped socket is an unhandled 'error' event, i.e. a dead container
  // rather than a failed run — the lesson infra/lambda/db.ts records at length.
  client.on('error', (err: Error) => {
    log({ msg: 'export.socket', error: err.message })
  })
  await client.connect()
  return client
}

type SqlRow = Record<string, unknown>

/**
 * One table, whole, ordered by its primary key. LIMIT/OFFSET paging, the same choice the
 * operator-side export and `analyticsBackfill.mts` both made: these keys are composite and
 * textual, a keyset predicate over seven columns is a statement nobody can read at 3am, and the
 * tables are megabytes.
 *
 * `SELECT *`, deliberately, and for the reason JOS-399 states where it does the same: this is a
 * BACKUP, so a column added next month has to land in the copy without anybody remembering. A
 * narrow projection is the right answer to a question and the wrong answer to "keep everything".
 *
 * Returns null for `42P01` — a table this cluster does not have. That is a genuinely different
 * fact from an empty one, and the manifest records it under `missing` so a restore can tell them
 * apart, which a missing file alone cannot.
 */
async function readTable(client: PgClient, table: ExportTable): Promise<SqlRow[] | null> {
  const order = table.key.join(', ')
  const rows: SqlRow[] = []
  try {
    for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
      const sql = `SELECT * FROM ${table.table} ORDER BY ${order} LIMIT $1 OFFSET $2`
      const page = await client.query<SqlRow>(sql, [PAGE, offset])
      rows.push(...page.rows)
      if (page.rows.length < PAGE) return rows
    }
  } catch (err) {
    if (codeOf(err) !== UNDEFINED_TABLE) throw err
    return null
  }
  throw new Error(`${table.table} has more than ${String(MAX_ROWS)} rows — refusing to page further`)
}

/**
 * Every PutObject names `ServerSideEncryption` explicitly rather than leaning on the bucket
 * default, because the bucket POLICY denies a put that does not carry the header (infra/export.tf
 * spells out both statements). Default encryption satisfies the bucket and not the policy — the
 * header is what a condition can see. VERIFIED: a put without it is refused with "explicit deny in
 * a resource-based policy".
 */
async function put(s3: S3Client, key: string, body: Buffer, type: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: type,
      ServerSideEncryption: 'AES256',
    }),
  )
}

/** What one run carries from table to table. A record rather than five positionals — the repo's
 *  `max-params` cap is 4, and "the run" is a real thing rather than a bag made to satisfy it. */
interface RunContext {
  client: PgClient
  s3: S3Client
  day: string
  nowMs: number
}

/** One table's file, and its manifest entry. Null when the cluster does not have the table. */
async function exportTable(
  run: RunContext,
  table: ExportTable,
  prefix: string,
): Promise<ManifestEntry | null> {
  const rows = await readTable(run.client, table)
  if (rows === null) {
    log({ msg: 'export.missing', table: table.table })
    return null
  }
  const file = `${table.table}.json.gz`
  const body = gzipSync(Buffer.from(jsonArrayLines(rows), 'utf8'), { level: 9 })
  await put(run.s3, `${prefix}/${run.day}/${file}`, body, 'application/gzip')
  // ONE dimensioned document per table. `Table` is a value from the closed registry, never
  // anything a client sent, so it cannot mint an unbounded number of billed metrics — the rule
  // emf.ts states, applied.
  emit({ Table: table.table }, [{ name: 'ExportRows', value: rows.length }], run.nowMs)
  log({ msg: 'export.table', table: table.table, rows: rows.length, bytes: body.length })
  return {
    table: table.table,
    file,
    rows: rows.length,
    bytes: body.length,
    // The sha256 of the COMPRESSED bytes — the bytes that land in the object, which is what
    // `analytics import` re-reads and re-hashes before it writes anything.
    sha256: createHash('sha256').update(body).digest('hex'),
  }
}

/**
 * ONE PREFIX'S WHOLE EXPORT: every table it owns, then its manifest. THE MANIFEST GOES LAST, and
 * that is the crash-safety story on this side exactly as it is on the operator's — `analytics
 * import` reads the manifest first, so a run killed halfway leaves something that can never be
 * mistaken for a complete backup.
 */
async function exportPrefix(
  run: RunContext,
  prefix: string,
  tables: readonly ExportTable[],
): Promise<ExportManifest> {
  const entries: ManifestEntry[] = []
  const missing: string[] = []
  for (const table of tables) {
    const entry = await exportTable(run, table, prefix)
    if (entry) entries.push(entry)
    else missing.push(table.table)
  }
  const manifest: ExportManifest = {
    version: 1,
    createdAt: new Date(run.nowMs).toISOString(),
    clusterId: clusterIdOf(HOST),
    schemaRevision: schemaRevision(SCHEMA_SQL),
    tables: entries,
    missing,
  }
  await put(
    run.s3,
    `${prefix}/${run.day}/${MANIFEST_FILE}`,
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    'application/json',
  )
  return manifest
}

export interface RunResult {
  day: string
  tables: number
  rows: number
  missing: string[]
}

const isBacklog = (t: ExportTable): boolean => BACKLOG_TABLES.includes(t.table)

/**
 * THE RUN — the two prefixes, in order. It is deliberately ALL-OR-NOTHING in its reporting: one
 * table failing raises `ExportFailed` and the invocation throws, because a partial night that
 * reported success is a backup nobody would check.
 */
export async function runExport(nowMs: number): Promise<RunResult> {
  if (BUCKET === '') throw new Error('ARCHIVE_BUCKET is not set')
  const client = await open()
  try {
    const run: RunContext = {
      client,
      s3: new S3Client({ region: REGION }),
      day: utcDay(nowMs),
      nowMs,
    }
    const analytics = await exportPrefix(run, 'exports', EXPORT_TABLES.filter((t) => !isBacklog(t)))
    const backlog = await exportPrefix(run, 'backlog', EXPORT_TABLES.filter(isBacklog))
    const both = [...analytics.tables, ...backlog.tables]
    return {
      day: run.day,
      tables: both.length,
      rows: both.reduce((sum, t) => sum + t.rows, 0),
      missing: [...analytics.missing, ...backlog.missing],
    }
  } finally {
    await client.end().catch(() => undefined)
  }
}

/**
 * EventBridge invokes this with a scheduled-event payload nothing here reads. The return value is
 * for a human running a manual invoke; the metrics are what the alarms watch.
 *
 * `ExportRows` is emitted a SECOND time with no dimensions, and that is not duplication: an EMF
 * document creates only the dimension sets it names, so a per-table metric cannot answer "did an
 * export happen at all last night". The un-dimensioned one is what the missing-data alarm in
 * infra/export.tf watches.
 */
export async function handler(): Promise<RunResult> {
  const started = Date.now()
  try {
    const out = await runExport(started)
    emit(
      {},
      [
        { name: 'ExportRows', value: out.rows },
        { name: 'ExportDurationMs', value: Date.now() - started, unit: 'Milliseconds' },
      ],
      started,
    )
    log({ msg: 'export.ok', day: out.day, tables: out.tables, rows: out.rows, missing: out.missing })
    return out
  } catch (err) {
    // The loss signal. `ExportFailed >= 1` alarms immediately: a missed night is a night whose
    // rows exist only in the cluster, which is the state this whole ticket exists to end.
    emit({}, [{ name: 'ExportFailed', value: 1 }], started)
    log({ msg: 'export.failed', error: errorMessage(err) })
    throw err
  }
}
