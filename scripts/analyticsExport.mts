/**
 * analyticsExport.mts — AN OFFLINE COPY ON THE OPERATOR'S OWN MACHINE, BEFORE ANYTHING TOUCHES
 * THE TABLES (JOS-399).
 * ============================================================================================
 *
 * Owner ruling 2026-08-16: before a migration, a backfill, or any other script that rewrites or
 * swaps a physical table runs against the analytics cluster, the operator takes a copy of every
 * table to their own disk. The AWS-side layers (JOS-398: AWS Backup for the cluster, a nightly
 * S3 export) are the other half of the same ruling; this half needs no infrastructure at all,
 * which is exactly what makes it the one that is always available — including on the evening the
 * account itself is the problem.
 *
 * WHAT IT WRITES, and why in this shape:
 *
 *   <out>/<YYYY-MM-DDTHHMM>/<table>.json.gz   one gzipped JSON array per table, ONE ROW PER LINE
 *   <out>/<YYYY-MM-DDTHHMM>/manifest.json     row counts, sha256 per file, schema revision,
 *                                             cluster id, timestamp
 *
 * ONE ROW PER LINE IS LOAD-BEARING, not cosmetic. The file is still a single valid JSON array
 * (so `jq .` and any other tool reads it whole), but because every row is its own line the
 * IMPORTER can stream it back a line at a time instead of parsing megabytes into memory — see
 * analyticsImport.mts. Both directions of this feature are therefore bounded in memory, which is
 * the property that lets it stay honest as the tables grow.
 *
 * THE MANIFEST IS WRITTEN LAST, and that is the whole crash-safety story. The freshness guard
 * below only counts a directory that HAS a manifest, so an export killed halfway through leaves a
 * directory that can never be mistaken for a completed backup.
 *
 * PAGED READS, the same precedent every other reader in this repo follows (usageStore.ts's
 * LIMITs, analyticsBackfill.mts's LIMIT/OFFSET walk): a page at a time, ordered by the primary
 * key, so no statement and no buffer is proportional to the table.
 *
 * `SELECT *`, DELIBERATELY, and it is the one place in this repo that does. Every other read
 * names its columns because it is answering a QUESTION and a narrow projection is the answer.
 * This one is a BACKUP: a column added to a table next month must land in the copy without
 * anybody remembering to add it here, because the failure mode of forgetting is discovering it
 * during a restore. The importer derives its INSERT column list from the rows themselves for the
 * same reason.
 *
 * NOTHING NEW IS COLLECTED. This is a copy of rows that already exist, onto a disk the operator
 * already owns, inside `.triage/` — which .gitignore excludes wholesale (the same rule that keeps
 * a reporter's log slice out of git). TELEMETRY.md and SECURITY.md describe what these tables
 * hold; this file does not change that by one column.
 */

import { createHash } from 'node:crypto'
import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { SCHEMA_FILE, TRIAGE_DIR, type Clients, type Row } from '../src/main/triage/store'
// THE TABLE LIST, THE MANIFEST SHAPE AND THE FILE FORMAT MOVED TO src/shared (JOS-398) and are
// re-exported below, so nothing that imported them from here had to change. They moved because a
// THIRD consumer appeared that cannot reach this module: the nightly S3 export Lambda. Importing
// this file into a Lambda would drag `store.ts` in with it — S3 clients, IAM role assumption and
// a `terraform` shell-out, bundled into a function that must only read rows and write objects,
// and redeployed every time this CLI changes. A leaf module with no imports is what all three can
// share; the header of src/shared/analyticsSchema.ts carries the argument.
import {
  clusterIdOf,
  EXPORT_TABLES,
  MANIFEST_FILE,
  schemaRevision,
  type ExportManifest,
  type ExportTable,
  type ManifestEntry,
} from '../src/shared/analyticsSchema'
import type { AnalyticsCtx } from './triageAnalytics.mjs'

export {
  clusterIdOf,
  EXPORT_TABLES,
  MANIFEST_FILE,
  schemaRevision,
  type ExportManifest,
  type ExportTable,
  type ManifestEntry,
}

/** Rows per SELECT. Bigger than the backfill's 500 because nothing here MODIFIES a row, so
 *  DSQL's 3,000-modified-rows-per-transaction cap does not apply to the read side. */
export const EXPORT_PAGE = 1_000

/** A runaway guard, not a policy: every table here is keyed on a day or an install and the whole
 *  cluster is megabytes. A table past this is a fact worth stopping on, not paging through. */
const MAX_ROWS = 5_000_000

/** postgres 42P01 — the table is not on this cluster (a stack migrated before it existed). */
const UNDEFINED_TABLE = '42P01'

const codeOf = (err: unknown): string | null => {
  const code: unknown = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/** The default destination: `.triage/exports/`, inside the gitignored triage working dir. */
export const EXPORTS_DIR = join(TRIAGE_DIR, 'exports')

/** `2026-08-16T1432` — sortable, minute-grained, and legal on every filesystem (no colons). */
export function stampOf(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 16).replace(/:/g, '')
}

// ---- the paged read ---------------------------------------------------------------------------

/**
 * One table, a page at a time, ordered by its primary key. LIMIT/OFFSET rather than a keyset
 * walk, the same choice `analyticsBackfill.mts` made and for a stronger reason here: these keys
 * are composite and textual, a keyset predicate over seven columns is a statement nobody can read
 * at 3am, and the tables are megabytes.
 *
 * A CONCURRENT WRITER CAN SKEW A DEEP OFFSET. That is stated rather than defended: this is an
 * operator's pre-migration copy, the ingest path only ever UPSERTS counters (it never deletes),
 * and the runbook closes the telemetry switch before a backfill anyway. For a copy taken to be
 * restored, `analytics close` first is the strict form.
 */
async function* pagesOf(c: Clients, t: ExportTable, page: number): AsyncGenerator<Row[]> {
  const order = t.key.join(', ')
  for (let offset = 0; offset < MAX_ROWS; offset += page) {
    const rows = await c.query(
      `SELECT * FROM ${t.table} ORDER BY ${order} LIMIT $1 OFFSET $2`,
      [page, offset],
    )
    if (rows.length === 0) return
    yield rows
    if (rows.length < page) return
  }
  throw new Error(
    `${t.table} has more than ${String(MAX_ROWS)} rows — this export refuses to page further. ` +
      'That is a runaway guard, not a size limit: a counter table past it means something is ' +
      'writing rows nobody designed.',
  )
}

/** The file body: a JSON array with ONE ROW PER LINE (see the header). */
async function* jsonLines(
  c: Clients,
  t: ExportTable,
  page: number,
  count: { rows: number },
): AsyncGenerator<string> {
  yield '[\n'
  for await (const rows of pagesOf(c, t, page)) {
    for (const row of rows) {
      yield count.rows === 0 ? JSON.stringify(row) : `,\n${JSON.stringify(row)}`
      count.rows++
    }
  }
  yield '\n]\n'
}

/**
 * Write one table's file and return its manifest entry, or null when the table is not on this
 * cluster. The sha256 is taken over the COMPRESSED bytes as they are written — the bytes that
 * are actually on disk, which is what a later verification can re-read — through a tap in the
 * pipeline rather than a second pass over the file.
 */
async function writeTable(
  c: Clients,
  t: ExportTable,
  dir: string,
  page: number,
): Promise<ManifestEntry | null> {
  const file = `${t.table}.json.gz`
  const count = { rows: 0 }
  const hash = createHash('sha256')
  let bytes = 0
  const tap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk)
      bytes += chunk.length
      done(null, chunk)
    },
  })
  try {
    await pipeline(
      Readable.from(jsonLines(c, t, page, count)),
      createGzip({ level: 9 }),
      tap,
      createWriteStream(join(dir, file)),
    )
  } catch (err) {
    if (codeOf(err) !== UNDEFINED_TABLE) throw err
    // The stream had already opened the file (and written the opening bracket) before the first
    // page came back 42P01. Remove it: a zero-row file for a table that does not exist would be
    // indistinguishable, on a restore, from a table that exists and is empty.
    rmSync(join(dir, file), { force: true })
    return null
  }
  return { table: t.table, file, rows: count.rows, bytes, sha256: hash.digest('hex') }
}

export interface ExportOptions {
  /** Defaults to `.triage/exports/`. */
  out?: string
  nowMs: number
  /** Test seam only — the page size the paged read walks with. */
  page?: number
  /** Test seam only — the schema text whose statement count becomes `schemaRevision`. */
  schemaSql?: string
}

export interface ExportResult {
  dir: string
  manifest: ExportManifest
}

/**
 * EVERY TABLE, GZIPPED, MANIFESTED, ON THIS MACHINE. The manifest goes last (see the header):
 * until it exists, the directory is not an export as far as the guard below is concerned.
 */
export async function exportAll(c: Clients, options: ExportOptions): Promise<ExportResult> {
  const root = options.out ?? EXPORTS_DIR
  const dir = join(root, stampOf(options.nowMs))
  mkdirSync(dir, { recursive: true })
  const page = options.page ?? EXPORT_PAGE
  const tables: ManifestEntry[] = []
  const missing: string[] = []
  for (const t of EXPORT_TABLES) {
    const entry = await writeTable(c, t, dir, page)
    if (entry) tables.push(entry)
    else missing.push(t.table)
  }
  const manifest: ExportManifest = {
    version: 1,
    createdAt: new Date(options.nowMs).toISOString(),
    clusterId: clusterIdOf(c.stack.cluster_endpoint),
    schemaRevision: schemaRevision(options.schemaSql ?? readFileSync(SCHEMA_FILE, 'utf8')),
    tables,
    missing,
  }
  writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
  return { dir, manifest }
}

// ---- the guard --------------------------------------------------------------------------------
//
// `migrate` and the backfill REFUSE to run without a copy taken in the last six hours. Six hours
// because it is a working session: an operator who exported this morning and migrates after lunch
// is covered, and one who is about to swap a table on the strength of yesterday's copy is not.
// The refusal names the command that fixes it, and `--no-export-check` overrides it — LOUDLY, by
// printing the refusal anyway, because an override nobody sees is a guard nobody has.

export const EXPORT_MAX_AGE_MS = 6 * 60 * 60 * 1000

export interface ExportAge {
  dir: string
  createdAt: string
  ageMs: number
  manifest: ExportManifest
}

export function readManifest(dir: string): ExportManifest {
  const raw = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8')) as ExportManifest
  if (!Array.isArray(raw.tables) || typeof raw.createdAt !== 'string') {
    throw new Error(`${join(dir, MANIFEST_FILE)} is not an analytics export manifest`)
  }
  return raw
}

/**
 * The NEWEST completed export under `root`, or null. A directory without a readable manifest is
 * not an export and is skipped in silence — that is a half-written one, and the whole point of
 * writing the manifest last is that this function cannot be fooled by it.
 */
export function latestExport(root: string, nowMs: number): ExportAge | null {
  let best: ExportAge | null = null
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return null
  }
  for (const name of entries) {
    const dir = join(root, name)
    try {
      if (!statSync(dir).isDirectory()) continue
      const manifest = readManifest(dir)
      const at = Date.parse(manifest.createdAt)
      if (!Number.isFinite(at)) continue
      if (best === null || at > Date.parse(best.createdAt)) {
        best = { dir, createdAt: manifest.createdAt, ageMs: nowMs - at, manifest }
      }
    } catch {
      continue
    }
  }
  return best
}

export interface GuardOptions {
  /** What is about to run — printed in the refusal so it names the actual danger. */
  what: string
  nowMs: number
  /** `--no-export-check`. The refusal is printed either way. */
  override?: boolean
  /** Defaults to `.triage/exports/`. */
  root?: string
}

function refusal(what: string, latest: ExportAge | null): string {
  const age =
    latest === null
      ? 'there is no export in .triage/exports/ at all'
      : `the newest export is ${(latest.ageMs / 3_600_000).toFixed(1)} h old (${latest.createdAt})`
  return (
    `${what} refuses to run without a fresh offline copy: ${age}, and the rule is six hours.\n` +
    'Take one first — it is one read-only command and it costs nothing:\n' +
    '    npx tsx scripts/triage-feedback.mts analytics export --profile eqc\n' +
    'Override with --no-export-check if you know why you are doing that.'
  )
}

/**
 * THE GUARD ITSELF. Throws unless a completed export exists in the window; with `override` it
 * prints the same words to stderr and returns, so the override is on the record either way.
 */
export function assertFreshExport(options: GuardOptions): ExportAge | null {
  const latest = latestExport(options.root ?? EXPORTS_DIR, options.nowMs)
  // `Math.abs` because a clock that is AHEAD produces a negative age, and "the newest copy is
  // stamped in the future" is a reason to look at the machine, not a reason to pass.
  if (latest !== null && Math.abs(latest.ageMs) <= EXPORT_MAX_AGE_MS) return latest
  const message = refusal(options.what, latest)
  if (options.override !== true) throw new Error(message)
  console.warn(`OVERRIDDEN (--no-export-check):\n${message}\n`)
  return latest
}

/**
 * The guard as the CLI reaches it: the same three flags read the same way from `migrate` and from
 * the three backfill commands, in ONE place, because a guard spelled twice is a guard that can be
 * spelled differently twice.
 *
 * `--out` names the exports directory for BOTH halves: export somewhere else and the guard looks
 * there, so an operator who keeps copies off the repo disk is not silently unguarded.
 */
export function requireFreshExport(
  args: Record<string, string | boolean | undefined>,
  what: string,
  nowMs: number,
): void {
  assertFreshExport({
    what,
    nowMs,
    override: args['no-export-check'] === true,
    root: typeof args.out === 'string' ? args.out : undefined,
  })
}

// ---- the CLI command --------------------------------------------------------------------------

const mb = (bytes: number): string => `${(bytes / 1_048_576).toFixed(2)} MB`

/** `analytics export [--out <dir>]` — the read-only half, safe against production by definition. */
export async function cmdAnalyticsExport(ctx: AnalyticsCtx): Promise<void> {
  const out = typeof ctx.args.out === 'string' ? ctx.args.out : undefined
  const { dir, manifest } = await exportAll(ctx.clients(), {
    nowMs: ctx.nowMs,
    ...(out === undefined ? {} : { out }),
  })
  let bytes = 0
  let rows = 0
  for (const t of manifest.tables) {
    console.log(`${t.table.padEnd(20)} ${String(t.rows).padStart(8)} row(s)  ${mb(t.bytes).padStart(10)}  ${t.sha256.slice(0, 16)}`)
    bytes += t.bytes
    rows += t.rows
  }
  if (manifest.missing.length > 0) {
    console.log(`\nnot on this cluster: ${manifest.missing.join(', ')}`)
  }
  console.log(
    `\n${String(manifest.tables.length)} table(s), ${String(rows)} row(s), ${mb(bytes)} on disk.\n` +
      `cluster ${manifest.clusterId} · schema revision ${String(manifest.schemaRevision)} · ${manifest.createdAt}\n` +
      `${dir}\n\n` +
      'This copy is on THIS MACHINE and nowhere else. `.triage/` is gitignored; the rows in it ' +
      'are the same rows the cluster holds, so treat the directory the way you treat the cluster.',
  )
}
