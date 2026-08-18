// THE OFFLINE COPY AND THE RESTORE (scripts/analyticsExport.mts + scripts/analyticsImport.mts,
// JOS-399) — "before anything touches the tables, take a copy to your own machine".
//
// The properties under test are the ones that make a backup worth calling one:
//
//   1. THE COPY IS COMPLETE AND SELF-DESCRIBING. Every table in schema.sql is written, gzipped,
//      one row per line inside a valid JSON array, with a manifest carrying the row count, the
//      sha256 of the bytes on disk, the schema revision, the cluster id and the timestamp.
//   2. IT DOES NOT HOLD A TABLE IN MEMORY. The read is paged — the test drives it with a page
//      size of 2 over three pages, so the paging really runs rather than being asserted about.
//   3. THE GUARD IS A GUARD. `migrate` and the backfill refuse without a copy from the last six
//      hours; the override prints the refusal anyway.
//   4. THE RESTORE IS VERIFIED-THEN-IDEMPOTENT. A checksum that does not match stops the run
//      BEFORE the first write, and importing the same directory twice leaves the destination
//      identical rather than doubled.
//   5. A MERGED-VIEW EXPORT LANDS UNDER SHARD 0 — the shape JOS-398's S3 job may write, restored
//      into the sharded table by the same one command.
//
// Driven by an in-memory fake of `Clients` (the same technique as tests/analyticsBackfill.test.mts)
// and a temp directory. No AWS, no cluster, no credentials; never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertFreshExport,
  clusterIdOf,
  EXPORT_TABLES,
  EXPORT_MAX_AGE_MS,
  exportAll,
  latestExport,
  schemaRevision,
  stampOf,
  type ExportManifest,
} from '../scripts/analyticsExport.mjs'
import { importAll, upsertSql } from '../scripts/analyticsImport.mjs'
import { runAnalytics } from '../scripts/triageAnalytics.mjs'
import type { Clients, Row } from '../src/main/triage/store'

const NOW = Date.parse('2026-08-16T14:32:10.000Z')

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'eqc-export-'))
}

// ---- the in-memory cluster ---------------------------------------------------------------

interface Fake {
  clients: Clients
  tables: Map<string, Row[]>
  /** Every statement the module issued, in order — the SQL itself is under test. */
  sql: string[]
}

/**
 * Enough postgres for the two statements these modules issue: the paged `SELECT *` and the
 * multi-row keyed upsert. A table that was not seeded answers `42P01`, which is how "this cluster
 * predates that migration" is told apart from "that table is empty".
 */
function fakeCluster(seed: Record<string, Row[]>): Fake {
  const tables = new Map<string, Row[]>(
    Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]),
  )
  const sql: string[] = []
  const rowsOf = (name: string): Row[] => {
    const t = tables.get(name)
    if (!t) throw Object.assign(new Error(`relation "${name}" does not exist`), { code: '42P01' })
    return t
  }

  const runRead = (text: string, params: unknown[]): Row[] | null => {
    const m = /^SELECT \* FROM (\w+) ORDER BY (.+) LIMIT \$1 OFFSET \$2$/.exec(text)
    if (!m) return null
    const key = m[2].split(',').map((s) => s.trim())
    const all = [...rowsOf(m[1])].sort((a, b) =>
      key.map((k) => String(a[k])).join('|').localeCompare(key.map((k) => String(b[k])).join('|')),
    )
    const from = Number(params[1])
    return all.slice(from, from + Number(params[0])).map((r) => ({ ...r }))
  }

  const runWrite = (text: string, params: unknown[]): Row[] | null => {
    const m = /^INSERT INTO (\w+) \(([^)]+)\) VALUES .* ON CONFLICT \(([^)]+)\) (DO .*)$/.exec(text)
    if (!m) return null
    const cols = m[2].split(',').map((s) => s.trim())
    const key = m[3].split(',').map((s) => s.trim())
    const assign = m[4].startsWith('DO UPDATE')
    const dest = tables.get(m[1]) ?? []
    tables.set(m[1], dest)
    const written: Row[] = []
    for (let i = 0; i < params.length; i += cols.length) {
      const row = Object.fromEntries(cols.map((c, k) => [c, params[i + k]]))
      const same = dest.find((d) => key.every((c) => d[c] === row[c]))
      if (!same) dest.push(row)
      else if (assign) Object.assign(same, row)
      written.push(row)
    }
    return written
  }

  const run = (text: string, params: unknown[]): Row[] => {
    const one = text.replace(/\s+/g, ' ').trim()
    sql.push(one)
    const out = runRead(one, params) ?? runWrite(one, params)
    if (out === null) throw new Error(`the fake cluster does not implement: ${one}`)
    return out
  }
  const clients = {
    query: (text: string, params: unknown[] = []) => Promise.resolve(run(text, params)),
    execute: (text: string, params: unknown[] = []) => Promise.resolve(run(text, params).length),
    s3: {},
    stack: { cluster_endpoint: 'abcdefg1234567.dsql.us-east-1.on.aws' },
    close: () => Promise.resolve(),
  } as unknown as Clients
  return { clients, tables, sql }
}

const counter = (day: string, metric: string, n: number): Row => ({
  day,
  cohort: 'user',
  metric,
  dim: '-',
  n,
})

/** Six counters (three pages at page size 2), a sharded counter, one install, one config row. */
function seeded(): Fake {
  return fakeCluster({
    feedback_config: [
      { id: 'FEEDBACK', accepting: true, closed_message: 'x', max_per_install_per_day: 10 },
    ],
    usage_daily: [
      counter('2026-08-10', 'sessions', 3),
      counter('2026-08-11', 'sessions', 5),
      counter('2026-08-12', 'sessions', 7),
      counter('2026-08-13', 'sessions', 11),
      counter('2026-08-14', 'sessions', 13),
      counter('2026-08-15', 'sessions', 17),
    ],
    usage_daily_sharded: [{ shard: 7, ...counter('2026-08-15', 'featureUse', 2) }],
    analytics_install: [
      {
        analytics_id: 'id-1',
        first_seen_day: '2026-08-10',
        last_seen_day: '2026-08-15',
        days_seen: 4,
        app_version: '1.2.0',
        channel: 'prod',
        cohort: null,
        quota_day: '2026-08-15',
        quota_n: 12,
        machine_class: 'mid-dgpu',
        window_mode: 'exclusive',
      },
    ],
  })
}

const SCHEMA = 'CREATE TABLE a (x text);\nCREATE TABLE b (y text);\n'

function run(fake: Fake, out: string, page = 2): Promise<{ dir: string; manifest: ExportManifest }> {
  return exportAll(fake.clients, { out, nowMs: NOW, page, schemaSql: SCHEMA })
}

// ---- 1. the copy is complete and self-describing ------------------------------------------

test('export writes a gzipped file and a manifest entry per table, and nothing for a table this cluster does not have', async () => {
  const fake = seeded()
  const out = tmp()
  const { dir, manifest } = await run(fake, out)

  assert.equal(dir, join(out, '2026-08-16T1432'), 'the directory is the minute-grained stamp')
  assert.equal(manifest.version, 1)
  assert.equal(manifest.createdAt, '2026-08-16T14:32:10.000Z')
  assert.equal(manifest.clusterId, 'abcdefg1234567', 'the cluster id, not the whole endpoint')
  assert.equal(manifest.schemaRevision, 2, 'the statement count of the schema it was taken under')

  const named = manifest.tables.map((t) => t.table).sort()
  assert.deepEqual(named, ['analytics_install', 'feedback_config', 'usage_daily', 'usage_daily_sharded'])
  // Every OTHER table in schema.sql is recorded as absent rather than silently skipped.
  const missing = EXPORT_TABLES.map((t) => t.table).filter((t) => !named.includes(t))
  assert.deepEqual([...manifest.missing].sort(), [...missing].sort())
  assert.deepEqual(
    readdirSync(dir).sort(),
    ['analytics_install.json.gz', 'feedback_config.json.gz', 'manifest.json', 'usage_daily.json.gz', 'usage_daily_sharded.json.gz'],
    'an absent table leaves no file behind — a zero-row file would read as "empty" on a restore',
  )
})

test('every file round trips through gzip to the rows the cluster held, and its manifest checksum is the bytes on disk', async () => {
  const fake = seeded()
  const { dir, manifest } = await run(fake, tmp())

  for (const entry of manifest.tables) {
    const bytes = readFileSync(join(dir, entry.file))
    assert.equal(bytes.length, entry.bytes, `${entry.table}: manifest bytes are the file's`)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${entry.table}: sha256`)
    const rows = JSON.parse(gunzipSync(bytes).toString('utf8')) as Row[]
    assert.equal(rows.length, entry.rows, `${entry.table}: manifest row count`)
    assert.deepEqual(rows, fake.tables.get(entry.table), `${entry.table}: same rows, every column`)
  }
  const usage = manifest.tables.find((t) => t.table === 'usage_daily')
  assert.equal(usage?.rows, 6)
})

test('the file is a JSON array with ONE ROW PER LINE — what lets the import stream it back', async () => {
  const { dir } = await run(seeded(), tmp())
  const text = gunzipSync(readFileSync(join(dir, 'usage_daily.json.gz'))).toString('utf8')
  const lines = text.trim().split('\n')
  assert.equal(lines[0], '[')
  assert.equal(lines.at(-1), ']')
  assert.equal(lines.length, 8, 'six rows plus the two brackets')
  for (const line of lines.slice(1, -1)) {
    JSON.parse(line.replace(/,$/, '')) as Row
  }
})

// ---- 2. paged reads ------------------------------------------------------------------------

test('the read is paged — six rows at a page size of two is four statements, the last one short', async () => {
  const fake = seeded()
  await run(fake, tmp(), 2)
  const pages = fake.sql.filter((s) => s.startsWith('SELECT * FROM usage_daily ORDER BY'))
  assert.equal(pages.length, 4, 'three full pages and the short one that ends the walk')
  assert.match(pages[0], /ORDER BY day, cohort, metric, dim LIMIT \$1 OFFSET \$2$/)
})

// ---- 3. the guard --------------------------------------------------------------------------

function stamp(root: string, at: number, extra: Partial<ExportManifest> = {}): string {
  const dir = join(root, stampOf(at))
  mkdirSync(dir, { recursive: true })
  const manifest = { version: 1, createdAt: new Date(at).toISOString(), clusterId: 'c', schemaRevision: 1, tables: [], missing: [], ...extra }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  return dir
}

test('the guard passes on a copy from within six hours and refuses outside it', () => {
  const root = tmp()
  stamp(root, NOW - 7 * 3_600_000)
  assert.throws(
    () => assertFreshExport({ what: 'migrate', nowMs: NOW, root }),
    /refuses to run without a fresh offline copy.*7\.0 h old/s,
  )
  const fresh = stamp(root, NOW - 60_000)
  const ok = assertFreshExport({ what: 'migrate', nowMs: NOW, root })
  assert.equal(ok?.dir, fresh, 'the NEWEST manifest is the one that answers, not the first found')
  assert.ok(ok!.ageMs < EXPORT_MAX_AGE_MS)
})

test('the guard refuses when there is no export at all, and names the command that fixes it', () => {
  assert.throws(
    () => assertFreshExport({ what: 'analytics backfill-swap', nowMs: NOW, root: join(tmp(), 'nope') }),
    /no export in .triage.exports. at all[\s\S]*analytics export/,
  )
})

test('a directory whose manifest was never written does not count as an export', () => {
  const root = tmp()
  mkdirSync(join(root, '2026-08-16T1400'), { recursive: true })
  writeFileSync(join(root, '2026-08-16T1400', 'usage_daily.json.gz'), 'half a file')
  assert.equal(latestExport(root, NOW), null, 'the manifest is written LAST — that is the whole point')
})

test('--no-export-check overrides, and prints the refusal anyway', () => {
  const root = tmp()
  const said: string[] = []
  const warn = console.warn
  console.warn = (msg: unknown): void => void said.push(String(msg))
  try {
    assert.equal(assertFreshExport({ what: 'migrate', nowMs: NOW, root, override: true }), null)
  } finally {
    console.warn = warn
  }
  assert.equal(said.length, 1)
  assert.match(said[0], /OVERRIDDEN \(--no-export-check\)[\s\S]*refuses to run without a fresh offline copy/)
})

/**
 * THE WIRING, not just the guard. A guard nothing calls is a function with tests.
 *
 * `clients()` THROWS in this ctx, so the assertion is sharp in both directions: the refusal proves
 * the guard ran, and it proves it ran BEFORE anything opened a socket or minted an IAM token —
 * which is the property that makes a refusal cost nothing. (`migrate`'s own call site is the same
 * one-line helper; scripts/triage-feedback.mts is a top-level-await entry point and cannot be
 * imported, so its wiring is checked by running the command — see the JOS-399 report.)
 */
test('every backfill subcommand refuses on a stale exports directory before it opens a connection', async () => {
  const root = tmp()
  stamp(root, NOW - 9 * 3_600_000)
  for (const name of ['backfill-cohort', 'backfill-verify', 'backfill-swap']) {
    const ctx = {
      args: { out: root },
      rest: [name],
      nowMs: NOW,
      clients: (): never => {
        throw new Error('the command opened a connection before the guard ran')
      },
    }
    await assert.rejects(
      () => runAnalytics(ctx as unknown as Parameters<typeof runAnalytics>[0]),
      new RegExp(`${name} refuses to run without a fresh offline copy`),
      name,
    )
  }
})

// ---- 4. the restore ------------------------------------------------------------------------

test('import puts every row back, table for table, and running it twice changes nothing', async () => {
  const source = seeded()
  const { dir } = await run(source, tmp())

  const target = fakeCluster({})
  const first = await importAll(target.clients, dir, { chunk: 4 })
  assert.deepEqual(
    first.map((r) => [r.table, r.target, r.rows]).sort(),
    [
      ['analytics_install', 'analytics_install', 1],
      ['feedback_config', 'feedback_config', 1],
      ['usage_daily', 'usage_daily', 6],
      ['usage_daily_sharded', 'usage_daily_sharded', 1],
    ].sort(),
  )
  for (const [name, rows] of source.tables) {
    assert.deepEqual(target.tables.get(name), rows, `${name}: restored row for row`)
  }
  // The shard the row was written under is the shard it comes back under — it is not re-drawn
  // and it is not flattened to 0. Only a MERGED-VIEW export needs shard 0 (below).
  assert.equal(target.tables.get('usage_daily_sharded')?.[0].shard, 7)

  await importAll(target.clients, dir, { chunk: 4 })
  for (const [name, rows] of source.tables) {
    assert.deepEqual(target.tables.get(name), rows, `${name}: a second import is a no-op`)
  }
})

test('the upsert is ASSIGNMENT on every non-key column, keyed on the primary key', () => {
  const sql = upsertSql({ table: 'usage_daily', key: ['day', 'cohort', 'metric', 'dim'] }, ['day', 'cohort', 'metric', 'dim', 'n'], 2)
  assert.equal(
    sql,
    'INSERT INTO usage_daily (day, cohort, metric, dim, n) VALUES ($1,$2,$3,$4,$5),($6,$7,$8,$9,$10)' +
      ' ON CONFLICT (day, cohort, metric, dim) DO UPDATE SET n = EXCLUDED.n',
  )
})

test('an export whose file does not match its checksum is refused BEFORE the first write', async () => {
  const { dir } = await run(seeded(), tmp())
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ExportManifest
  const entry = manifest.tables.find((t) => t.table === 'usage_daily')!
  entry.sha256 = 'f'.repeat(64)
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))

  const target = fakeCluster({})
  await assert.rejects(
    () => importAll(target.clients, dir),
    /usage_daily.json.gz does not match its manifest checksum[\s\S]*NOTHING HAS BEEN WRITTEN/,
  )
  assert.equal(target.sql.length, 0, 'not one statement ran')
})

test('a manifest naming a table nobody designed for is refused', async () => {
  const dir = tmp()
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ version: 1, createdAt: new Date(NOW).toISOString(), clusterId: 'c', schemaRevision: 1, missing: [], tables: [{ table: 'pg_authid', file: 'pg_authid.json.gz', rows: 1, bytes: 1, sha256: 'x' }] }),
  )
  await assert.rejects(() => importAll(fakeCluster({}).clients, dir), /refusing to import an unlisted table: pg_authid/)
})

// ---- 5. the merged-view shape (JOS-398's nightly S3 export) --------------------------------

test('rows exported from the MERGED VIEW carry no shard and land under shard 0, idempotently', async () => {
  const dir = tmp()
  const rows: Row[] = [
    { day: '2026-08-15', cohort: 'user', metric: 'sessions', dim: '-', n: 9 },
    { day: '2026-08-15', cohort: 'owner', metric: 'sessions', dim: '-', n: 1 },
  ]
  const body = gzipSync(`[\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n]\n`)
  writeFileSync(join(dir, 'usage_daily_all.json.gz'), body)
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      createdAt: new Date(NOW).toISOString(),
      clusterId: 'c',
      schemaRevision: 1,
      missing: [],
      tables: [
        {
          table: 'usage_daily_all',
          file: 'usage_daily_all.json.gz',
          rows: 2,
          bytes: body.length,
          sha256: createHash('sha256').update(body).digest('hex'),
        },
      ],
    }),
  )

  const target = fakeCluster({})
  const report = await importAll(target.clients, dir)
  assert.deepEqual(report, [{ table: 'usage_daily_all', target: 'usage_daily_sharded', rows: 2 }])
  assert.deepEqual(
    target.tables.get('usage_daily_sharded'),
    rows.map((r) => ({ shard: 0, ...r })),
    'the view has no shard column, so the restore picks the one deterministic shard',
  )
  await importAll(target.clients, dir)
  assert.equal(target.tables.get('usage_daily_sharded')?.length, 2, 'still two rows, not four')
})

test('--dry-run verifies and counts without issuing a statement', async () => {
  const { dir } = await run(seeded(), tmp())
  const target = fakeCluster({})
  const report = await importAll(target.clients, dir, { dryRun: true })
  assert.equal(report.reduce((n, r) => n + r.rows, 0), 9)
  assert.equal(target.sql.length, 0)
})

// ---- the small pieces ----------------------------------------------------------------------

test('the stamp is sortable, minute-grained and legal on a filesystem', () => {
  assert.equal(stampOf(Date.parse('2026-01-02T03:04:05.000Z')), '2026-01-02T0304')
})

test('the cluster id is the endpoint label, and a schema revision is its statement count', () => {
  assert.equal(clusterIdOf('abc123.dsql.us-east-1.on.aws'), 'abc123')
  assert.equal(schemaRevision('CREATE TABLE a (x text);\n-- a comment\nCREATE TABLE b (y text);\n'), 2)
})
