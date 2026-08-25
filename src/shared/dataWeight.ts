// ============================================================================
// dataWeight.ts — WHAT THE COMMITTED DATA COSTS, per file (JOS-458).
// ============================================================================
//
// The launch profile has always had a `dataLoaded` phase and it has always been ONE NUMBER. Every
// committed corpus this app ships — 8.5 MB of items, 1.0 MB of spells, a 0.95 MB resist baseline,
// a 0.4 MB message-overlay baseline, a 3.2 MB mob catalog main reaches across for — is parsed
// inside it, at module evaluation, before Electron is even ready. So "the launch got 200 ms
// slower" has never been answerable with "because the items corpus grew", and a data change that
// moved a number has been invisible in the release it landed in.
//
// This is the ledger that makes it visible. It rides `StartupProfile.data`, prints one line at
// startup, and lands as one field on the bench's per-run ledger.
//
// ============================ WHY IT IS GENERATED, AND WHAT THAT COSTS ============================
// THE HONEST ANSWER FIRST: the per-file numbers below are NOT measured on the user's launch. They
// are measured by `scripts/gen-data-weight.mts` on a reference box and committed. Three facts
// force that, and the trade is worth stating rather than hiding:
//
//   1. THE FILES DO NOT EXIST AT RUNTIME. Every one is an ES import, which electron-vite INLINES
//      into `out/main/index.js` (AGENTS.md's measured law: a path-relative readFile would miss).
//      There is nothing on disk to `stat` in a packaged app.
//   2. RE-MEASURING WOULD COST MORE THAN THE GOALS ALLOW. Re-parsing 11 MB of JSON to price it is
//      ~250 ms of blocked main — which is not a diagnostic, it is the exact defect G2 forbids
//      ("zero stalls at or over 250 ms in the first post-fold minute"). An instrument that costs
//      something is a bug (main/perf.ts's performance contract, rule 1).
//   3. THE QUESTION IS A REPO QUESTION. "Did a data change move a number" is asked of a DIFF, not
//      of a machine. A committed table answers it exactly, and a stale one is caught by
//      `tests/dataWeight.test.mts`, which re-reads every listed file's real size and fails when
//      the ledger and the tree disagree — so the generator cannot be skipped.
//
// WHAT IS STILL MEASURED PER LAUNCH: `heapAfterDataMb`, this process's own heap once module
// evaluation is done. It is one `process.memoryUsage()` read, it costs microseconds, and it is the
// number that moves on THIS machine — the per-file table beside it is the attribution.
//
// PURE. No Electron, no `node:` — main/dataWeight.ts does the reading and the bench prints it.

/**
 * The floor for inclusion. A hundred kilobytes is where a corpus starts being worth a row of its
 * own; below it the parse is under a millisecond and the ledger would become a directory listing.
 * `tests/dataWeight.test.mts` walks the tree against this number, so a NEW corpus over it is a
 * red test rather than a silent omission.
 */
export const DATA_WEIGHT_MIN_BYTES = 100_000

/** One corpus's bill. */
export interface DataWeightRow {
  /**
   * Repo-relative path, forward slashes. It is a COMPILE-TIME CONSTANT out of the generator's own
   * walk of the source tree — never a path from the user's machine — which is what lets it sit in
   * a profile file at all. The profile is local and never sent; even so, nothing here describes
   * the reader's disk.
   */
  file: string
  bytes: number
  /** Milliseconds to `JSON.parse` it, on the generator's box. A REFERENCE figure: it says which
   *  corpus dominates the parse, not what this launch spent. */
  parseMs: number
  /** Megabytes of heap the parsed value retains, same measurement, same caveat. */
  heapMb: number
}

/** The whole ledger, as it rides `StartupProfile.data`. */
export interface DataWeightLedger {
  rows: DataWeightRow[]
  totalBytes: number
  totalHeapMb: number
  totalParseMs: number
  /**
   * THE STATED GAP. Corpora over the floor that MAIN does not load — today the renderer's own
   * quest catalog. They are named rather than omitted, because a ledger that silently covered
   * only half the shipped data would answer "did the data get bigger" wrongly and confidently.
   */
  rendererOnly: string[]
  /** THIS launch's own heap once module evaluation finished, MB. Measured here, not generated —
   *  absent when the reading failed, never a fabricated zero. */
  heapAfterDataMb?: number
}

const round1 = (n: number): number => Math.round(n * 10) / 10

/** Rows → the ledger, totals computed rather than stored, so a row added by hand cannot leave a
 *  total that disagrees with it. Sorted by BYTES descending: the question is always "what is the
 *  big one", and a table sorted by name buries the answer. */
export function foldDataWeight(
  rows: readonly DataWeightRow[],
  rendererOnly: readonly string[],
  heapAfterDataMb?: number
): DataWeightLedger {
  const sorted = [...rows].sort((a, b) => b.bytes - a.bytes)
  return {
    rows: sorted,
    totalBytes: sorted.reduce((n, r) => n + r.bytes, 0),
    totalHeapMb: round1(sorted.reduce((n, r) => n + r.heapMb, 0)),
    totalParseMs: round1(sorted.reduce((n, r) => n + r.parseMs, 0)),
    rendererOnly: [...rendererOnly].sort(),
    ...(heapAfterDataMb === undefined ? {} : { heapAfterDataMb: round1(heapAfterDataMb) })
  }
}

/** `8.3 MB` / `410 kB`. Whole units, because a ledger read at a glance does not want three
 *  decimals — the exact byte count is in the row beside it. */
export function formatBytes(bytes: number): string {
  const b = Math.max(0, bytes)
  return b >= 1_048_576 ? `${String(round1(b / 1_048_576))} MB` : `${String(Math.round(b / 1024))} kB`
}

/**
 * The one line startup logs, and the one the bench prints.
 *
 * It names the THREE heaviest and then totals the rest, because a line naming nine corpora is a
 * line nobody reads — and the three are 90% of the weight. `heapAfterDataMb` leads when it is
 * present: it is the only number on the line measured on the machine reading it.
 */
export function formatDataWeight(ledger: DataWeightLedger): string {
  const top = ledger.rows
    .slice(0, 3)
    .map((r) => `${basename(r.file)} ${formatBytes(r.bytes)}`)
    .join(' · ')
  const rest = ledger.rows.length - 3
  const parts = [
    `data ${formatBytes(ledger.totalBytes)} in ${String(ledger.rows.length)} files`,
    top + (rest > 0 ? ` · +${String(rest)} more` : ''),
    `ref parse ${String(ledger.totalParseMs)}ms / retained ${String(ledger.totalHeapMb)} MB`
  ]
  if (ledger.heapAfterDataMb !== undefined) {
    parts.push(`heap after dataLoaded ${String(ledger.heapAfterDataMb)} MB (this launch)`)
  }
  if (ledger.rendererOnly.length > 0) {
    parts.push(`renderer-only, not counted: ${ledger.rendererOnly.map(basename).join(', ')}`)
  }
  return parts.join(' · ')
}

/** Last path segment. The rows carry the full repo-relative path; the LINE does not need it. */
function basename(file: string): string {
  const cut = file.lastIndexOf('/')
  return cut < 0 ? file : file.slice(cut + 1)
}
