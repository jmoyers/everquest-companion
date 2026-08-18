// THE NIGHTLY S3 ARCHIVE (JOS-398) — the half that had to fit the restore path JOS-399 landed.
//
// `tests/analyticsExport.test.mts` covers the operator-side copy and the importer. This file
// covers the three things the AWS side adds, and each one is a way the pair could silently stop
// being a backup:
//
//   1. THE TABLE LIST IS PINNED TO THE REAL infra/schema.sql, in BOTH directions. A table added
//      to the schema and forgotten in `EXPORT_TABLES` is a table silently missing from every
//      backup — discovered during a restore, which is the worst possible time. A table listed
//      with no `CREATE TABLE` is a `42P01` at 3am. Main's export tests drive a SYNTHETIC schema
//      (correctly — they are testing paging and manifests), so nothing else reads the real file.
//   2. THE BACKLOG SPLIT IS A CLOSED, JUSTIFIED SET. `report` goes under its own S3 prefix so a
//      lifecycle rule can expire it, because SECURITY.md promises a deletion request is honoured
//      and an S3 lifecycle filter is a prefix with no wildcard. If that set ever grew silently,
//      a table would move retention class without anybody deciding to.
//   3. THE LAMBDA'S FILE FORMAT IS THE IMPORTER'S. The nightly job builds a directory in one
//      string; the operator's export streams it. The test builds one the Lambda's way and feeds
//      it to the REAL `importAll`, checksums and all — the only assertion that actually proves
//      "aws s3 sync then analytics import" works, rather than assuming it.
//
// No AWS, no cluster, no credentials; never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BACKLOG_TABLES,
  EXPORT_TABLES,
  MANIFEST_FILE,
  clusterIdOf,
  jsonArrayLines,
  schemaRevision,
  splitStatements,
  type ExportManifest,
} from '../src/shared/analyticsSchema'
import { importAll } from '../scripts/analyticsImport.mjs'
import type { Clients, Row } from '../src/main/triage/store'

const SCHEMA = readFileSync(join(import.meta.dirname, '..', 'infra', 'schema.sql'), 'utf8')

// ---- 1. the table list is pinned to the real schema -------------------------------------------

interface SchemaTable {
  columns: string[]
  primaryKey: string[]
}

/** Every `CREATE TABLE IF NOT EXISTS <name> ( … );` in the real file, parsed. */
function schemaTables(sql: string): Map<string, SchemaTable> {
  const out = new Map<string, SchemaTable>()
  const re = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g
  for (let m = re.exec(sql); m !== null; m = re.exec(sql)) {
    const columns: string[] = []
    let primaryKey: string[] = []
    // `/\r?\n/`, and the comment strip is UNANCHORED, both for the same CRLF reason: JS treats
    // `\r` as a line terminator, so `.` will not cross one and a `--.*$` on a CRLF line matches
    // nothing at all. This file is checked out with CRLF on Windows.
    for (const line of m[2].split(/\r?\n/)) {
      const body = line.replace(/--.*/, '').trim().replace(/,$/, '')
      if (body.length === 0) continue
      const key = /^PRIMARY KEY \((.+)\)$/.exec(body)
      if (key) primaryKey = key[1].split(',').map((s) => s.trim())
      else columns.push(body.split(/\s+/)[0])
    }
    out.set(m[1], { columns, primaryKey })
  }
  return out
}

test('every table in the real infra/schema.sql is exported, and every exported table exists', () => {
  const schema = schemaTables(SCHEMA)
  // Sanity on the parser itself before it is used as an oracle.
  assert.ok(schema.size >= 13, `parsed only ${String(schema.size)} CREATE TABLE blocks`)
  const listed = new Set(EXPORT_TABLES.map((t) => t.table))
  for (const name of schema.keys()) {
    assert.ok(listed.has(name), `${name} is in schema.sql and NOT exported — it would be lost`)
  }
  for (const name of listed) {
    assert.ok(schema.has(name), `${name} is exported and has no CREATE TABLE in schema.sql`)
  }
})

test('every exported key IS the table’s real PRIMARY KEY — it orders the read and targets the upsert', () => {
  const schema = schemaTables(SCHEMA)
  for (const t of EXPORT_TABLES) {
    const declared = schema.get(t.table)
    assert.ok(declared, `${t.table} is missing from schema.sql`)
    assert.deepEqual([...t.key], declared.primaryKey, t.table)
  }
})

test('the two MERGE VIEWS are not exported — exporting a view would copy every counter twice', () => {
  const listed = EXPORT_TABLES.map((t) => t.table)
  assert.equal(listed.includes('usage_daily_all'), false)
  assert.equal(listed.includes('perf_daily_all'), false)
  // …and both physical legs of each view ARE, which is what makes the view rebuildable.
  for (const leg of ['usage_daily', 'usage_daily_sharded', 'perf_daily', 'perf_daily_sharded']) {
    assert.ok(listed.includes(leg), leg)
  }
})

test('the schema revision is the statement count the last migrate applied', () => {
  assert.equal(schemaRevision(SCHEMA), splitStatements(SCHEMA).length)
  assert.ok(schemaRevision(SCHEMA) > 40, 'the real schema is dozens of statements')
})

// ---- 2. the backlog split ----------------------------------------------------------------------

test('the backlog prefix is a CLOSED subset of the exported tables, and it is the human-text one', () => {
  const listed = new Set(EXPORT_TABLES.map((t) => t.table))
  assert.deepEqual([...BACKLOG_TABLES], ['report'])
  for (const name of BACKLOG_TABLES) assert.ok(listed.has(name), name)
})

test('every other table stays in the KEPT prefix — the split moves retention, so it must be deliberate', () => {
  const kept = EXPORT_TABLES.filter((t) => !BACKLOG_TABLES.includes(t.table)).map((t) => t.table)
  // The counters and the install rows are the ones the ticket exists to never lose; a change that
  // quietly moved one of them under `backlog/` would give it a 90-day expiry.
  for (const name of [
    'usage_daily',
    'usage_daily_sharded',
    'usage_funnel_daily',
    'perf_daily',
    'perf_daily_sharded',
    'error_report',
    'analytics_install',
  ]) {
    assert.ok(kept.includes(name), `${name} must stay in the kept prefix`)
  }
})

// ---- 3. the Lambda's format is the importer's --------------------------------------------------

test('jsonArrayLines is a valid JSON array with ONE ROW PER LINE — what lets the import stream it', () => {
  const rows = [{ a: 1 }, { a: 2 }, { a: 3 }]
  const text = jsonArrayLines(rows)
  assert.deepEqual(JSON.parse(text), rows)
  const lines = text.trimEnd().split('\n')
  assert.equal(lines[0], '[')
  assert.equal(lines[lines.length - 1], ']')
  assert.equal(lines.length, rows.length + 2)
  // An empty table is still a valid, parseable array — a restore must be able to tell "no rows"
  // from "no file", and only a written file can say the first.
  assert.deepEqual(JSON.parse(jsonArrayLines([])), [])
})

test('the cluster id in a manifest is the endpoint label', () => {
  assert.equal(clusterIdOf('abc123.dsql.us-east-1.on.aws'), 'abc123')
})

/** Enough postgres for the one statement the importer issues. */
function fakeCluster(): { clients: Clients; tables: Map<string, Row[]>; sql: string[] } {
  const tables = new Map<string, Row[]>()
  const sql: string[] = []
  const run = (text: string, params: unknown[]): Row[] => {
    const one = text.replace(/\s+/g, ' ').trim()
    sql.push(one)
    const m = /^INSERT INTO (\w+) \(([^)]+)\) VALUES .* ON CONFLICT \(([^)]+)\) DO (?:UPDATE SET .+|NOTHING)$/.exec(one)
    if (!m) throw new Error(`the fake cluster does not implement: ${one}`)
    const columns = m[2].split(',').map((s) => s.trim())
    const keys = m[3].split(',').map((s) => s.trim())
    const dest = tables.get(m[1]) ?? []
    tables.set(m[1], dest)
    for (let i = 0; i < params.length; i += columns.length) {
      const row = Object.fromEntries(columns.map((c, k) => [c, params[i + k]]))
      const same = dest.find((d) => keys.every((c) => d[c] === row[c]))
      if (same) Object.assign(same, row)
      else dest.push(row)
    }
    return []
  }
  const clients = {
    query: (text: string, params: unknown[] = []) => Promise.resolve(run(text, params)),
    execute: (text: string, params: unknown[] = []) => Promise.resolve(run(text, params).length),
    s3: {},
    stack: {},
    close: () => Promise.resolve(),
  } as unknown as Clients
  return { clients, tables, sql }
}

/**
 * A directory built EXACTLY the way infra/lambda/export.ts builds an S3 prefix: `jsonArrayLines`,
 * gzip, and a manifest whose sha256 is taken over the compressed bytes. This is the interop
 * assertion — if the Lambda and the importer ever disagree about the format, this fails here
 * rather than during a restore.
 */
function lambdaStyleExport(tables: Record<string, Row[]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'eqc-archive-'))
  const entries = Object.entries(tables).map(([table, rows]) => {
    const file = `${table}.json.gz`
    const body = gzipSync(Buffer.from(jsonArrayLines(rows), 'utf8'), { level: 9 })
    writeFileSync(join(dir, file), body)
    return {
      table,
      file,
      rows: rows.length,
      bytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    }
  })
  const manifest: ExportManifest = {
    version: 1,
    createdAt: new Date(1_786_939_851_313).toISOString(),
    clusterId: clusterIdOf('sruag4muogppcljre5lmjsyu2q.dsql.us-east-1.on.aws'),
    schemaRevision: schemaRevision(SCHEMA),
    tables: entries,
    missing: [],
  }
  writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
  return dir
}

test('a directory built the LAMBDA’s way restores through the operator’s importer, checksums and all', async () => {
  const dir = lambdaStyleExport({
    usage_daily: [{ day: '2026-08-15', cohort: 'user', metric: 'sessionHeartbeat', dim: '-', n: 11 }],
    usage_daily_sharded: [
      { shard: 0, day: '2026-08-15', cohort: 'user', metric: 'sessionHeartbeat', dim: '-', n: 8 },
      { shard: 5, day: '2026-08-15', cohort: 'user', metric: 'sessionHeartbeat', dim: '-', n: 3 },
    ],
    analytics_install: [{ analytics_id: 'id-1', first_seen_day: '2026-08-04', days_seen: 7 }],
  })
  const f = fakeCluster()
  const out = await importAll(f.clients, dir)
  assert.deepEqual(
    out.map((r) => [r.table, r.target, r.rows]),
    [
      ['usage_daily', 'usage_daily', 1],
      ['usage_daily_sharded', 'usage_daily_sharded', 2],
      ['analytics_install', 'analytics_install', 1],
    ],
  )
  // TABLE FOR TABLE: the frozen table's row goes back to the frozen table, carrying its own
  // count, and the sharded rows keep the shards they were written under. `usage_daily_all` is
  // the two summed, so this is the only routing that cannot double a counter.
  assert.equal((f.tables.get('usage_daily') ?? []).length, 1)
  assert.deepEqual(
    (f.tables.get('usage_daily_sharded') ?? []).map((r) => [r.shard, r.n]),
    [
      [0, 8],
      [5, 3],
    ],
  )

  // And it is idempotent, which is what makes "it died halfway, run it again" a safe instruction.
  const before = JSON.stringify([...f.tables])
  await importAll(f.clients, dir)
  assert.equal(JSON.stringify([...f.tables]), before)
})

test('a truncated object is caught by its manifest checksum BEFORE the first write', async () => {
  const dir = lambdaStyleExport({
    usage_daily: [{ day: '2026-08-15', cohort: 'user', metric: 'm', dim: '-', n: 1 }],
  })
  // Exactly what a half-finished `aws s3 sync` leaves behind.
  writeFileSync(join(dir, 'usage_daily.json.gz'), gzipSync(Buffer.from('[\n]\n', 'utf8')))
  const f = fakeCluster()
  await assert.rejects(() => importAll(f.clients, dir), /does not match its manifest checksum/)
  assert.equal(f.sql.length, 0, 'NOTHING was written')
})
