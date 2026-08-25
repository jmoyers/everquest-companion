// gen-data-weight.mts — writes the committed data-weight ledger. `npm run gen:data-weight`.
//
// WHY IT IS GENERATED AND NOT MEASURED ON A LAUNCH: stated in full at the top of
// `src/shared/dataWeight.ts`. The short form is that every corpus is an ES import inlined into the
// bundle, so there is no file at runtime, and re-parsing 11 MB to price it would cost ~250 ms of
// blocked main — the exact defect JOS-458's G2 forbids.
//
// WHAT MAKES IT HONEST is `tests/dataWeight.test.mts`, which re-walks the tree and fails when a
// listed file's real size disagrees with the ledger, or when a corpus over the floor is missing
// from it. So a data change that skips this script turns the suite red rather than shipping a
// ledger that lies. Same contract `gen-telemetry-doc.mts` has with `tests/telemetryDoc.test.mts`.
//
// RUN IT WITH `--expose-gc`. Without it the retained-heap column is noise: the measurement is a
// `heapUsed` delta across a parse, and an un-forced collection between the two reads makes the
// number meaningless. The script refuses rather than reporting a figure it cannot stand behind.
//
// IT PARSES; IT DOES NOT SCRAPE. Nothing here touches a wiki, a network or a game log — it reads
// files already committed to this repo and reports their size and what parsing them costs.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_WEIGHT_MIN_BYTES, type DataWeightRow } from '../src/shared/dataWeight'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src', 'main', 'data', 'dataWeight.generated.json')

const maybeGc = (globalThis as { gc?: () => void }).gc
if (maybeGc === undefined) {
  console.error('gen:data-weight: run with --expose-gc (see this script’s header for why)')
  process.exit(1)
}
const forceGc: () => void = maybeGc

/**
 * WHERE THE CORPORA ARE. `src/main/data` is the whole main-side story except for ONE
 * cross-directory import: `src/main/mobLookupLocal.ts` reaches into the renderer's catalog, which
 * is a 3.2 MB parse charged to main's `dataLoaded` and would be missed by a directory walk.
 *
 * It is an explicit list rather than an import-graph crawl on purpose: a crawl would be a second
 * thing to keep correct, and the test that guards this ledger checks the DIRECTORY walk against it
 * — so a new corpus dropped into `src/main/data` is caught automatically, and a new cross-import
 * is caught by a human reading a diff, which is the only place that one can be caught anyway.
 */
const EXTRA_MAIN_FILES = ['src/renderer/src/data/eqlegends/mobs.json']

/** …and the corpora over the floor that main does NOT load. Named in the ledger rather than
 *  omitted from it — `DataWeightLedger.rendererOnly` says why. */
const RENDERER_DIR = 'src/renderer/src/data/eqlegends'

function bigJsonIn(dir: string): string[] {
  const abs = join(ROOT, dir)
  let names: string[] = []
  try {
    names = readdirSync(abs)
  } catch {
    return []
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => `${dir}/${n}`)
    .filter((f) => statSync(join(ROOT, f)).size >= DATA_WEIGHT_MIN_BYTES)
    // The ledger itself lives in `src/main/data` and must never describe itself.
    .filter((f) => !f.endsWith('dataWeight.generated.json'))
}

const mainFiles = [...bigJsonIn('src/main/data'), ...EXTRA_MAIN_FILES].sort()
const rendererOnly = bigJsonIn(RENDERER_DIR).filter((f) => !mainFiles.includes(f))

/**
 * One corpus, priced. The retained figure is a `heapUsed` DELTA across the parse with a forced
 * collection either side, and the parsed value is kept alive in `retained` for the duration of the
 * run — a value the collector could take before the second read would report a corpus that costs
 * nothing, which is the failure mode this whole column exists to avoid.
 */
const retained: unknown[] = []

function price(file: string): DataWeightRow {
  const text = readFileSync(join(ROOT, file), 'utf8')
  // NORMALIZED bytes, not on-disk bytes (JOS-458 follow-up, caught by CI on the ledger's first
  // day): these corpora are single-line minified JSON, so their one newline is LF or CRLF
  // depending on the CHECKOUT's autocrlf — the same commit measured 410455 on the dev box and
  // 410456 on the CI runner. The ledger records the canonical (LF) size, which every checkout
  // agrees on; a one-byte line ending is not a data-weight change and must not be able to redden
  // a build. The tripwire measures the same way.
  const bytes = Buffer.byteLength(text.replace(/\r\n/g, '\n'), 'utf8')
  forceGc()
  const heap0 = process.memoryUsage().heapUsed
  const t0 = performance.now()
  const value: unknown = JSON.parse(text)
  const parseMs = performance.now() - t0
  retained.push(value)
  forceGc()
  const heapMb = (process.memoryUsage().heapUsed - heap0) / 1_048_576
  return {
    file,
    bytes,
    parseMs: Math.round(parseMs * 10) / 10,
    heapMb: Math.round(Math.max(0, heapMb) * 10) / 10
  }
}

const rows = mainFiles.map(price)

const next = `${JSON.stringify({ rows, rendererOnly }, null, 2)}\n`
let before = ''
try {
  before = readFileSync(OUT, 'utf8')
} catch {
  before = ''
}
writeFileSync(OUT, next, 'utf8')

for (const r of rows) {
  console.log(
    `  ${relative(ROOT, join(ROOT, r.file)).padEnd(48)} ${String(r.bytes).padStart(9)} B  parse ${r.parseMs.toFixed(1).padStart(6)} ms  retained ${r.heapMb.toFixed(1).padStart(6)} MB`
  )
}
console.log(`  renderer-only, not counted: ${rendererOnly.join(', ') || '(none)'}`)
console.log(
  before === next
    ? 'gen:data-weight: dataWeight.generated.json is already current'
    : `gen:data-weight: wrote dataWeight.generated.json (${String(rows.length)} rows)`
)
