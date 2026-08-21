/**
 * analyticsImport.mts — THE OTHER HALF OF A BACKUP: putting it back (JOS-399 item 2, shared with
 * JOS-398).
 * ============================================================================================
 *
 * A backup that cannot be restored is not a backup, so `analytics import <dir>` exists ONCE and
 * both backup tickets use it: the local pre-migration copy (`analytics export`, the module beside
 * this one) and the AWS-side nightly S3 export (JOS-398) produce the same per-table
 * `<table>.json.gz` + `manifest.json` shape, and this command reloads either. Building two
 * importers would mean two things to be wrong about the restore path on the one night it matters.
 *
 * THREE PROPERTIES, and each is why a line here looks the way it does:
 *
 *   1. IT VERIFIES BEFORE IT WRITES. Every file's sha256 is re-computed and checked against the
 *      manifest BEFORE the first INSERT of the run. A restore from a truncated download that got
 *      halfway through the counter tables is worse than no restore, because it looks like it
 *      worked.
 *   2. IT IS IDEMPOTENT. Every write is `INSERT … ON CONFLICT (<primary key>) DO UPDATE SET
 *      <every non-key column> = EXCLUDED.<column>` — ASSIGNMENT, never the ingest path's
 *      addition. Running the same import twice leaves the cluster identical rather than doubled,
 *      which is what makes "run it again, it died halfway" a safe instruction.
 *   3. IT STREAMS. The export writes one row per line inside a valid JSON array, so this reads a
 *      line at a time and upserts in batches — no table is ever fully in memory, in either
 *      direction.
 *
 * WHERE THE COUNTER ROWS LAND, and the one judgment call in this file. A per-table export is
 * restored TABLE FOR TABLE: `usage_daily`'s rows go back to `usage_daily` (the frozen pre-shard
 * table), `usage_daily_sharded`'s rows go back to `usage_daily_sharded` carrying the shard they
 * were written under. That is exact, and — because `usage_daily_all` is the two summed — it is
 * also the only routing that cannot double a counter.
 *
 * SHARD 0 IS FOR THE OTHER SHAPE. An export taken from the MERGED VIEW (`usage_daily_all` /
 * `perf_daily_all`) has no shard column at all, because the view sums it away; those rows are
 * upserted into the sharded table under SHARD 0, which is deterministic (so a re-run is still a
 * no-op) and correct (the shard is random noise with no meaning — infra/schema.sql says so at
 * length; nothing may ever join on it). Both spellings are accepted here so that whichever shape
 * JOS-398's nightly job writes, this command restores it.
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { createGunzip } from 'node:zlib'
import type { Clients, Row } from '../src/main/triage/store'
import { EXPORT_TABLES, readManifest, type ExportTable, type ManifestEntry } from './analyticsExport.mjs'
import type { AnalyticsCtx } from './triageAnalytics.mjs'

/**
 * Rows per INSERT. DSQL caps a TRANSACTION at 3,000 MODIFIED ROWS and node-postgres gives every
 * statement its own implicit transaction, so 500 keeps a wide margin — the same number, for the
 * same reason, as the ingest handler's UPSERT_CHUNK and the backfill's PAGE.
 */
export const IMPORT_CHUNK = 500

/** A restore target: the physical table, its `ON CONFLICT` key, and any column the source shape
 *  does not carry and this side has to supply. */
export interface ImportTarget {
  table: string
  key: readonly string[]
  /** Columns filled in when the row does not have them — the merged view's missing `shard`. */
  fill?: Readonly<Record<string, unknown>>
}

const SHARDED: Record<string, ImportTarget> = {
  usage_daily_all: {
    table: 'usage_daily_sharded',
    key: ['shard', 'day', 'cohort', 'metric', 'dim'],
    fill: { shard: 0 },
  },
  perf_daily_all: {
    table: 'perf_daily_sharded',
    key: [
      'shard',
      'day',
      'cohort',
      'window_mode',
      'machine_class',
      'locked',
      'stall_bucket',
      'tail_bucket',
    ],
    fill: { shard: 0 },
  },
}

/** The CLOSED set of names this command will write to — every one of them reaches SQL as an
 *  identifier, so a manifest cannot name a table nobody designed for. */
export const IMPORT_TARGETS: Readonly<Record<string, ImportTarget>> = {
  ...Object.fromEntries(EXPORT_TABLES.map((t: ExportTable) => [t.table, { table: t.table, key: t.key }])),
  ...SHARDED,
}

/** A column name has to look like one: it is spliced into SQL and it comes out of a file. */
const COLUMN = /^[a-z_][a-z0-9_]*$/

// ---- reading the files ------------------------------------------------------------------------

/** The sha256 of a file as it sits on disk, streamed. */
export async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * The rows of one `<table>.json.gz`, streamed. The export writes a valid JSON array with one row
 * per line, so a line is either structural (`[`, `]`) or one row with an optional trailing comma.
 */
async function* rowsOf(path: string): AsyncGenerator<Row> {
  const lines = createInterface({ input: createReadStream(path).pipe(createGunzip()) })
  for await (const raw of lines) {
    const line = raw.trim().replace(/,$/, '')
    if (line === '' || line === '[' || line === ']') continue
    yield JSON.parse(line) as Row
  }
}

// ---- the upsert -------------------------------------------------------------------------------

/** `($1,$2),($3,$4)` — one placeholder per value, in the order the params are pushed. */
function tuples(rows: number, columns: number): string {
  const out: string[] = []
  for (let r = 0; r < rows; r++) {
    const cells: string[] = []
    for (let c = 0; c < columns; c++) cells.push(`$${String(r * columns + c + 1)}`)
    out.push(`(${cells.join(',')})`)
  }
  return out.join(',')
}

/**
 * THE COLUMN LIST COMES FROM THE ROWS, not from a list in this file. The export is `SELECT *` so
 * that a column added to a table lands in the copy without anybody remembering; deriving the
 * INSERT from the row's own keys is the same argument on the way back. Every name is checked
 * against `COLUMN` and every key column must be present, so a hand-edited file cannot smuggle an
 * identifier in.
 */
export function upsertSql(target: ImportTarget, columns: readonly string[], rows: number): string {
  for (const col of columns) {
    if (!COLUMN.test(col)) throw new Error(`refusing to import a column named "${col}"`)
  }
  for (const col of target.key) {
    if (!columns.includes(col)) {
      throw new Error(`${target.table}: the export is missing key column "${col}"`)
    }
  }
  const updates = columns.filter((c) => !target.key.includes(c))
  const conflict =
    updates.length === 0
      ? 'DO NOTHING'
      : `DO UPDATE SET ${updates.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`
  return (
    `INSERT INTO ${target.table} (${columns.join(', ')})` +
    ` VALUES ${tuples(rows, columns.length)} ON CONFLICT (${target.key.join(', ')}) ${conflict}`
  )
}

/** One row, with anything the source shape omits filled in (the merged view's `shard`). */
function filled(row: Row, target: ImportTarget): Row {
  return target.fill === undefined ? row : { ...target.fill, ...row }
}

async function writeChunk(c: Clients, target: ImportTarget, chunk: Row[]): Promise<number> {
  const columns = Object.keys(chunk[0])
  const params: unknown[] = []
  for (const row of chunk) {
    for (const col of columns) params.push(row[col] ?? null)
  }
  await c.execute(upsertSql(target, columns, chunk.length), params)
  return chunk.length
}

export interface ImportReport {
  table: string
  target: string
  rows: number
}

export interface ImportOptions {
  /** Verify and count, write nothing. */
  dryRun?: boolean
  /** Test seam only. */
  chunk?: number
}

/**
 * VERIFY EVERY FILE FIRST, then write. Two passes over the directory on purpose: the checksum
 * pass must finish before the first INSERT, or a corrupt fourth file is discovered with three
 * tables already restored.
 */
async function verifyAll(dir: string, entries: ManifestEntry[]): Promise<void> {
  for (const entry of entries) {
    const path = join(dir, entry.file)
    if (!existsSync(path)) throw new Error(`${entry.file} is named in the manifest and missing`)
    const actual = await sha256Of(path)
    if (actual !== entry.sha256) {
      throw new Error(
        `${entry.file} does not match its manifest checksum (expected ${entry.sha256.slice(0, 16)}…, ` +
          `read ${actual.slice(0, 16)}…). NOTHING HAS BEEN WRITTEN — re-download the export.`,
      )
    }
  }
}

export async function importAll(
  c: Clients,
  dir: string,
  options: ImportOptions = {},
): Promise<ImportReport[]> {
  const manifest = readManifest(dir)
  for (const entry of manifest.tables) {
    if (!(entry.table in IMPORT_TARGETS)) {
      throw new Error(`refusing to import an unlisted table: ${entry.table}`)
    }
  }
  await verifyAll(dir, manifest.tables)
  const chunkSize = options.chunk ?? IMPORT_CHUNK
  const out: ImportReport[] = []
  for (const entry of manifest.tables) {
    const target = IMPORT_TARGETS[entry.table]
    let written = 0
    let chunk: Row[] = []
    for await (const row of rowsOf(join(dir, entry.file))) {
      chunk.push(filled(row, target))
      if (chunk.length < chunkSize) continue
      written += options.dryRun === true ? chunk.length : await writeChunk(c, target, chunk)
      chunk = []
    }
    if (chunk.length > 0) {
      written += options.dryRun === true ? chunk.length : await writeChunk(c, target, chunk)
    }
    out.push({ table: entry.table, target: target.table, rows: written })
  }
  return out
}

// ---- the CLI command --------------------------------------------------------------------------

/** `analytics import <dir> [--dry-run]`. */
export async function cmdAnalyticsImport(ctx: AnalyticsCtx): Promise<void> {
  const dir = ctx.rest[1] ?? ''
  if (!dir) throw new Error('analytics import: <dir> (an export directory) is required')
  const dryRun = ctx.args['dry-run'] === true
  const manifest = readManifest(dir)
  console.log(
    `export of cluster ${manifest.clusterId}, schema revision ${String(manifest.schemaRevision)}, ` +
      `taken ${manifest.createdAt}`,
  )
  const rows = await importAll(ctx.clients(), dir, { dryRun })
  for (const r of rows) {
    const via = r.target === r.table ? '' : `  -> ${r.target}`
    console.log(`${r.table.padEnd(20)} ${String(r.rows).padStart(8)} row(s)${via}`)
  }
  console.log(
    dryRun
      ? '\n--dry-run: every file verified against its checksum, NOTHING written.'
      : '\nRestored. Every write was an idempotent keyed upsert, so running this again is a no-op.',
  )
}
