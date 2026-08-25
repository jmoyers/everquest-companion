// The committed data-weight ledger (src/shared/dataWeight.ts, JOS-458).
//
// WHAT THIS SUITE IS FOR, and it is the entire reason a GENERATED ledger is allowed to exist here.
// The per-file numbers are measured by `scripts/gen-data-weight.mts` on a reference box and
// committed, because every corpus is an ES import inlined into the bundle (there is no file at
// runtime) and re-parsing 11 MB to price it would cost ~250 ms of blocked main — the exact defect
// JOS-458's G2 forbids. That trade is only honest if a stale ledger CANNOT SHIP. This file is what
// makes that true, the same contract `telemetryDoc.test.mts` has with its generator:
//
//   1. EVERY LISTED FILE STILL EXISTS AND IS STILL THAT SIZE. A data change that skips the
//      generator turns this red rather than shipping a ledger that lies about the release.
//   2. EVERY CORPUS OVER THE FLOOR IS LISTED. A NEW 8 MB file dropped into `src/main/data` is
//      caught here, not noticed a year later.
//   3. THE GAP IS NAMED. Corpora over the floor that main does not load are in `rendererOnly`
//      rather than silently absent — a ledger that covered half the shipped data and said so
//      is a measurement; one that covered half and didn't is a wrong answer.
//
// It reads real files (a few megabytes of `stat`, no parsing), so it is fast and never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DATA_WEIGHT_MIN_BYTES,
  foldDataWeight,
  formatBytes,
  formatDataWeight,
  type DataWeightRow
} from '../src/shared/dataWeight'
import ledger from '../src/main/data/dataWeight.generated.json'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const rows: DataWeightRow[] = ledger.rows
const rendererOnly: string[] = ledger.rendererOnly

/** Every `.json` in `dir` at or over the floor, repo-relative with forward slashes — the same walk
 *  the generator does, restated here so the two are checked against each other rather than against
 *  a shared helper that could be wrong in both. */
function bigJsonIn(dir: string): string[] {
  return readdirSync(join(ROOT, dir))
    .filter((n) => n.endsWith('.json') && n !== 'dataWeight.generated.json')
    .map((n) => `${dir}/${n}`)
    .filter((f) => statSync(join(ROOT, f)).size >= DATA_WEIGHT_MIN_BYTES)
}

// ---- 1. the ledger describes the tree that is actually committed -------------------------------

test('EVERY LISTED FILE still exists and is still exactly that many bytes', () => {
  assert.ok(rows.length > 0, 'the ledger is empty — run npm run gen:data-weight')
  for (const row of rows) {
    // NORMALIZED bytes, exactly as the generator measures (see its `price`): these are one-line
    // minified files, so on-disk size differs by one byte between an LF and a CRLF checkout of the
    // SAME commit — CI proved it on the ledger's first day. The canonical size is the LF one.
    const size = Buffer.byteLength(readFileSync(join(ROOT, row.file), 'utf8').replace(/\r\n/g, '\n'), 'utf8')
    assert.equal(
      size,
      row.bytes,
      `${row.file} is ${String(size)} normalized bytes, the ledger says ${String(row.bytes)} — run npm run gen:data-weight`
    )
  }
})

test('every row carries a parse time and a retained figure, so no column is quietly empty', () => {
  for (const row of rows) {
    assert.ok(row.parseMs > 0, `${row.file} has no parse measurement`)
    assert.ok(row.heapMb > 0, `${row.file} has no retained measurement`)
    assert.ok(row.file.startsWith('src/'), `${row.file} is not a repo-relative source path`)
    assert.ok(!row.file.includes('\\'), `${row.file} uses backslashes — the wire spelling is /`)
  }
})

// ---- 2. nothing over the floor is missing ------------------------------------------------------

test('EVERY main-side corpus over the floor is in the ledger', () => {
  const listed = new Set(rows.map((r) => r.file))
  for (const file of bigJsonIn('src/main/data')) {
    assert.ok(
      listed.has(file),
      `${file} is over ${formatBytes(DATA_WEIGHT_MIN_BYTES)} and is not in the ledger — run npm run gen:data-weight`
    )
  }
})

test('the ONE cross-directory import main pays for is counted', () => {
  // `src/main/mobLookupLocal.ts` reaches into the renderer's catalog, so its 3.2 MB parse is
  // charged to main's `dataLoaded`. A directory walk of `src/main/data` would miss it entirely,
  // which is why the generator carries it as an explicit entry and this pins that it stayed.
  const listed = new Set(rows.map((r) => r.file))
  assert.ok(listed.has('src/renderer/src/data/eqlegends/mobs.json'))
})

// ---- 3. the gap is named rather than omitted ---------------------------------------------------

test('THE RENDERER GAP IS STATED — a corpus main does not load is named, never dropped', () => {
  const listed = new Set(rows.map((r) => r.file))
  const named = new Set(rendererOnly)
  for (const file of bigJsonIn('src/renderer/src/data/eqlegends')) {
    assert.ok(
      listed.has(file) || named.has(file),
      `${file} is over the floor and appears in neither rows nor rendererOnly`
    )
  }
  // …and nothing is in both lists, which would double-count it in a reader's head.
  for (const file of rendererOnly) assert.ok(!listed.has(file), `${file} is in both lists`)
})

// ---- the fold and the line ---------------------------------------------------------------------

test('the totals are DERIVED, so a hand-edited row cannot leave a total that disagrees', () => {
  const folded = foldDataWeight(rows, rendererOnly)
  assert.equal(
    folded.totalBytes,
    rows.reduce((n, r) => n + r.bytes, 0)
  )
  assert.equal(folded.rows.length, rows.length)
  // Sorted by BYTES descending: the question is always "what is the big one".
  for (let i = 1; i < folded.rows.length; i++) {
    assert.ok(folded.rows[i - 1].bytes >= folded.rows[i].bytes)
  }
  assert.equal(folded.heapAfterDataMb, undefined, 'absent when the launch took no reading')
})

test('the startup line names the heavy three, the totals, and the gap', () => {
  const line = formatDataWeight(foldDataWeight(rows, rendererOnly, 71.3))
  assert.match(line, /^data \d+(\.\d)? MB in \d+ files/)
  assert.match(line, /items\.json/)
  assert.match(line, /ref parse \d+(\.\d)?ms \/ retained \d+(\.\d)? MB/)
  assert.match(line, /heap after dataLoaded 71\.3 MB \(this launch\)/)
  assert.match(line, /renderer-only, not counted: /)
})

test('a ledger with nothing to say about the renderer says nothing about it', () => {
  const line = formatDataWeight(foldDataWeight(rows, []))
  assert.equal(/renderer-only/.test(line), false)
  assert.equal(/this launch/.test(line), false)
})
