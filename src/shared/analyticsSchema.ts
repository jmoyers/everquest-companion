/**
 * analyticsSchema.ts — THE SHAPE OF THE ANALYTICS STORE, spelled once (JOS-398/JOS-399).
 *
 * Three facts live here and nowhere else: WHICH TABLES the cluster has (with the primary key that
 * orders a read and targets an upsert), HOW `infra/schema.sql` splits into statements, and WHAT AN
 * EXPORT OF IT LOOKS LIKE on disk. Four consumers depend on all three agreeing:
 *
 *   * `scripts/analyticsExport.mts`  — the operator's pre-migration copy (JOS-399)
 *   * `scripts/analyticsImport.mts`  — the ONE restore path, shared by both tickets
 *   * `infra/lambda/export.ts`       — the nightly S3 archive (JOS-398)
 *   * `src/main/triage/store.ts`     — `migrate`, which applies the statements this file splits
 *
 * IT IS A `src/shared/` MODULE FOR A CONCRETE REASON, not for tidiness. The Lambda cannot import
 * from `scripts/`: `analyticsExport.mts` reaches `src/main/triage/store.ts`, which opens S3
 * clients, assumes IAM roles and shells out to `terraform` — an entire operator CLI, bundled into
 * a function that must only read rows and write objects, and re-deployed every time that CLI
 * changes. A leaf module with no imports of its own is the only thing all four can share.
 *
 * AN EXPORTER AND AN IMPORTER THAT DISAGREE ABOUT A TABLE ARE A BACKUP THAT CANNOT BE RESTORED,
 * which is why `infra/build.mjs` names this file as the export bundle's CONTRACT: the Lambda
 * refuses to build without it, and the failure says which promise broke.
 */

/**
 * EVERY TABLE IN infra/schema.sql, WITH ITS PRIMARY KEY — a CLOSED list, because each name
 * reaches SQL as an identifier (a table name cannot be a parameter) and the only thing that keeps
 * that safe is that no caller can add one. The key ORDERS the paged read, and the importer reuses
 * it as the `ON CONFLICT` target.
 *
 * THE VIEWS ARE NOT HERE ON PURPOSE. `usage_daily_all` / `perf_daily_all` are
 * `usage_daily UNION ALL usage_daily_sharded` summed back to the old key (JOS-394): exporting
 * them as well would write every counter TWICE into the same directory, and a restore of both
 * would double the fleet. The two physical tables under a view are the backup; the view is a
 * projection of them and is rebuilt by `migrate`.
 *
 * PINNED TO THE SCHEMA BY A TEST rather than by care — `tests/analyticsExportImport.test.mts`
 * parses every `CREATE TABLE` in the real file and fails in BOTH directions. A table added to
 * `schema.sql` and forgotten here is a table silently missing from every backup, and one listed
 * here with no `CREATE TABLE` is a `42P01` discovered at 3am.
 */
export const EXPORT_TABLES = [
  { table: 'feedback_config', key: ['id'] },
  { table: 'install_profile', key: ['install_id'] },
  { table: 'report', key: ['report_id'] },
  { table: 'install_quota', key: ['install_id', 'quota_day'] },
  { table: 'report_idempotency', key: ['install_id', 'client_report_id'] },
  { table: 'dedupe_probe', key: ['hash', 'probe_day'] },
  { table: 'usage_daily', key: ['day', 'cohort', 'metric', 'dim'] },
  { table: 'usage_daily_sharded', key: ['shard', 'day', 'cohort', 'metric', 'dim'] },
  {
    table: 'usage_funnel_daily',
    key: ['day', 'cohort', 'funnel', 'step', 'outcome', 'app_version'],
  },
  {
    table: 'perf_daily',
    key: ['day', 'cohort', 'window_mode', 'machine_class', 'locked', 'stall_bucket', 'tail_bucket'],
  },
  {
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
  },
  { table: 'error_report', key: ['day', 'cohort', 'version', 'fingerprint'] },
  { table: 'analytics_install', key: ['analytics_id'] },
] as const

export interface ExportTable {
  table: string
  key: readonly string[]
}

/**
 * THE ONE TABLE THAT HOLDS ANYTHING A PERSON WROTE, and the archive treats it differently
 * because of that. `report` carries free-text descriptions; every other table here is counters,
 * anonymous tokens and closed enums. The nightly S3 archive therefore writes it under its own
 * top-level prefix so that a lifecycle rule can EXPIRE it — SECURITY.md promises a deletion
 * request is honoured, and a versioned archive with no expiry would quietly make that untrue.
 * `infra/export.tf` carries the argument at the lifecycle rule; nothing else in the pipeline
 * treats this table specially.
 */
export const BACKLOG_TABLES: readonly string[] = ['report']

// ---- the schema file ------------------------------------------------------------------------

/**
 * Statement splitter for infra/schema.sql: a statement ends at the first line whose last
 * character is `;`. That is enough because the file is authored for it (no string literal ends a
 * line with a semicolon, and DSQL has no PL/pgSQL to dollar-quote) — the rule is written down at
 * the top of schema.sql.
 *
 * It lives HERE rather than beside `applySchema` because three unrelated things count on it: the
 * migrate runner that executes the statements, the operator export's `schemaRevision`, and the
 * nightly Lambda's — and the Lambda cannot reach the migrate runner's module (see the header).
 * `src/main/triage/store.ts` re-exports it, so every existing import path is unchanged.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let buffer: string[] = []
  for (const line of sql.split(/\r?\n/)) {
    const code = line.replace(/^\s*--.*$/, '')
    if (code.trim().length === 0) continue
    buffer.push(code)
    if (code.trimEnd().endsWith(';')) {
      out.push(buffer.join('\n').trimEnd().replace(/;$/, ''))
      buffer = []
    }
  }
  if (buffer.join('').trim().length > 0) throw new Error('schema.sql ends mid-statement')
  return out
}

/**
 * SCHEMA REVISION = the number of statements in infra/schema.sql, which is exactly the statement
 * count the last `migrate` applied (migrate walks the whole file and is idempotent, so "applied"
 * and "present in the file" are the same set). It is the number that answers "was this copy taken
 * from the shape the code expects" during a restore.
 */
export function schemaRevision(sql: string): number {
  return splitStatements(sql).length
}

// ---- what an export looks like on disk -------------------------------------------------------

export interface ManifestEntry {
  table: string
  file: string
  rows: number
  /** Bytes ON DISK, i.e. of the gzipped file — the number `sha256` is taken over. */
  bytes: number
  sha256: string
}

export interface ExportManifest {
  version: 1
  /** ISO 8601, UTC. THE FRESHNESS GUARD READS THIS FIELD and nothing else — never a file mtime,
   *  which a copy or a sync would reset without the data behind it having been re-read. */
  createdAt: string
  /** The cluster the rows came from: the first label of the DSQL endpoint. A restore into a
   *  DIFFERENT cluster is legitimate (that is what a restore usually is), so this is recorded
   *  and printed rather than enforced. */
  clusterId: string
  schemaRevision: number
  tables: ManifestEntry[]
  /** Tables schema.sql declares that this cluster does not have (42P01) — recorded so a restore
   *  can tell "empty" from "was never there", which a missing file alone cannot. */
  missing: string[]
}

export const MANIFEST_FILE = 'manifest.json'

/** The cluster id out of `<id>.dsql.<region>.on.aws`. Endpoint-shaped input only; anything else
 *  is passed through, because this is a label in a manifest and not a lookup key. */
export function clusterIdOf(endpoint: string): string {
  return endpoint.split('.')[0] ?? endpoint
}

/**
 * ONE ROW PER LINE INSIDE A VALID JSON ARRAY, and it is load-bearing rather than cosmetic: the
 * file is still a single JSON document that `jq .` reads whole, but because every row is its own
 * line the importer streams it back a line at a time instead of parsing megabytes into memory.
 * Both producers of this format emit exactly this shape — the operator export streams it, the
 * Lambda builds it in one string — so `analytics import` cannot tell them apart.
 */
export function jsonArrayLines(rows: readonly unknown[]): string {
  return `[\n${rows.map((row) => JSON.stringify(row)).join(',\n')}\n]\n`
}
