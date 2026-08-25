// dataWeight.ts — the committed ledger, plus the one number this launch measures for itself.
//
// The argument for a generated table rather than a live measurement is at the top of
// `src/shared/dataWeight.ts` and is not repeated. What is HERE is the reading:
//
//   * the committed rows, imported like every other corpus in this app (electron-vite inlines it,
//     so it costs a JSON.parse of a few hundred bytes at module evaluation and nothing after);
//   * `heapAfterDataMb`, one `process.memoryUsage()` read captured at `dataLoaded` — the only
//     figure in the ledger measured on the machine that will read it.
//
// A LEAF. It imports the pure fold and a JSON file, so it can be read from `perf.ts` (which writes
// the profile) and from `index.ts` (which takes the heap reading) without either becoming a cycle.

import ledgerJson from './data/dataWeight.generated.json'
import { foldDataWeight, type DataWeightLedger, type DataWeightRow } from '../shared/dataWeight'

/**
 * This launch's heap once module evaluation finished, in MEGABYTES.
 *
 * `undefined` until `noteHeapAfterData()` is called, and absent from the profile while it is —
 * never a fabricated zero, which would claim the corpora cost nothing.
 */
let heapAfterDataMb: number | undefined

/**
 * Take the reading. Called from the composition root at the same instant `dataLoaded` is marked,
 * which is the first moment after every corpus has been parsed and the last moment before the app
 * starts allocating anything of its own — so the number describes the DATA and not the session.
 *
 * It is a single `process.memoryUsage()` call (microseconds) and it is unconditional, for
 * `markStartupPhase`'s stated reason: the launch you wish you had profiled is always the one that
 * already happened.
 */
export function noteHeapAfterData(): void {
  try {
    heapAfterDataMb = process.memoryUsage().heapUsed / 1_048_576
  } catch {
    heapAfterDataMb = undefined
  }
}

/** The ledger for the profile being written. The rows are compile-time constants; only the heap
 *  figure varies between launches. */
export function dataWeightLedger(): DataWeightLedger {
  const raw: { rows: DataWeightRow[]; rendererOnly: string[] } = ledgerJson
  return foldDataWeight(raw.rows, raw.rendererOnly, heapAfterDataMb)
}

/** Test seam: forget the reading. Never called by the app. */
export function resetDataWeight(): void {
  heapAfterDataMb = undefined
}
