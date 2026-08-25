// WHO OWNED THE HITCH, on a bug report (src/shared/feedbackPerfSeams.ts — JOS-458).
//
// WHAT THIS SUITE IS FOR. `feedbackPerf.test.mts` pins the SHAPE half of the block — sixty rows on
// a fixed grid, so a reporter's freeze has a position and a size. Two field reports arrived
// carrying exactly that shape and it was not enough: it said we stalled, and did not say on what.
// This file pins the half that answers that, and it is a separate file for the reason its subject
// is a separate file — `feedbackPerf.ts` and its own suite are both at the repo's 400-code-line
// ceiling, and the cut is by subject.
//
// The four properties it exists to hold:
//
//   1. THE CULPRIT IS FIRST, so the dialog, the CLI and the triage panel name the same one without
//      each deciding for itself which number is the headline.
//   2. A `t` ADDRESSES A ROW of the same block. That is the entire mechanism by which the block
//      stops being a shape and becomes a diagnosis.
//   3. ABSENCE IS A FINDING. A window with lateness in it and no seam named clears all six
//      instrumented places at once, and the reader must be able to tell that from a build that
//      never looked.
//   4. THE SEAM NAME IS CHECKED AGAINST THE ENUM at the fold AND at the validator. That validator
//      runs inside the ingest Lambda over bytes a client chose; an unchecked name would be a
//      free-text channel into a stored report.
//
// No Electron, no network, no fixtures — this suite never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_PERF_COUNT,
  MAX_PERF_MS,
  PERF_INTERVAL_MS,
  PERF_ROWS,
  foldFeedbackPerf,
  formatPerfBlock,
  validatePerf,
  type FeedbackPerfState
} from '../src/shared/feedbackPerf'
import {
  MAX_SEAM_COUNT,
  MAX_SEAM_MS,
  MAX_SEAM_T_S,
  foldPerfGc,
  foldPerfSeams,
  type FeedbackPerfSeam,
  type PerfSeamSample,
  type PerfWindow
} from '../src/shared/feedbackPerfSeams'

const NOW = 1_800_000_000_000

/** A machine reading for the folds below — this suite is about the ATTRIBUTION half, so the state
 *  group is a constant rather than a subject. */
const BLOCK_STATE: FeedbackPerfState = {
  overlaysOpen: 3,
  overlaysLocked: 1,
  presenceOn: true,
  ringOn: false,
  freeMemMb: 9_014,
  workingSetMb: 1_680,
  cpuCount: 16,
  totalMemGb: 32,
  gpuVendor: 'nvidia',
  gpuCompositing: 'hardware',
  eqWindowMode: 'fullscreen'
}

/** Wall clock for the start of row `i` of a ten-minute, sixty-row block ending at NOW. */
const atRow = (i: number): number => NOW - 60 * PERF_INTERVAL_MS + i * PERF_INTERVAL_MS + 1
const WINDOW: PerfWindow = {
  start: NOW - 60 * PERF_INTERVAL_MS,
  spanMs: 60 * PERF_INTERVAL_MS,
  rowMs: PERF_INTERVAL_MS
}
const fold = (samples: PerfSeamSample[]): FeedbackPerfSeam[] => foldPerfSeams(samples, WINDOW)

/** A block with whatever attribution the case is about, over the same window. */
function block(over: Partial<Parameters<typeof foldFeedbackPerf>[0]> = {}): NonNullable<
  ReturnType<typeof foldFeedbackPerf>
> {
  const perf = foldFeedbackPerf(
    {
      main: [{ at: atRow(54), lateMs: 1_190 }],
      worker: [],
      tail: [],
      state: BLOCK_STATE,
      ...over
    },
    NOW
  )
  assert.ok(perf !== null)
  return perf
}

test('the block window constants are the ones this file restates by value', () => {
  // Restated rather than imported, because feedbackPerf.ts imports feedbackPerfSeams.ts and an
  // import back would be a cycle inside the Lambda bundle. So the pin lives here.
  assert.equal(MAX_SEAM_T_S, (PERF_ROWS * PERF_INTERVAL_MS) / 1000)
  assert.equal(MAX_SEAM_MS, MAX_PERF_MS)
  assert.equal(MAX_SEAM_COUNT, MAX_PERF_COUNT)
})

// ---- 1. the culprit is first ------------------------------------------------------------------

test('THE CULPRIT IS FIRST — seams come back worst-first, so every reader names the same one', () => {
  const seams = fold([
    { at: atRow(10), seam: 'combatSnapshot', ms: 140 },
    { at: atRow(54), seam: 'worldRebuilt', ms: 1_186 },
    { at: atRow(20), seam: 'registryFlush', ms: 300 }
  ])
  assert.deepEqual(
    seams.map((s) => s.seam),
    ['worldRebuilt', 'registryFlush', 'combatSnapshot']
  )
  assert.equal(seams[0].maxMs, 1_186)
})

// ---- 2. a `t` addresses a row -----------------------------------------------------------------

test('a seam `t` ADDRESSES A ROW — the worst call lands on the block grid, not on a wall clock', () => {
  // This is the entire mechanism by which the block stops being a shape and becomes a diagnosis:
  // a reader who sees the spike in row 54 looks here and finds what was running in row 54.
  const seams = fold([
    { at: atRow(54) + 3_000, seam: 'worldRebuilt', ms: 900 },
    { at: atRow(12), seam: 'worldRebuilt', ms: 40 }
  ])
  assert.equal(seams[0].t, 540)
  assert.equal(seams[0].lateCalls, 2)
  assert.ok(seams[0].t <= MAX_SEAM_T_S)
})

test('samples outside the window are dropped rather than piled onto row 0', () => {
  const seams = fold([
    { at: WINDOW.start - 60_000, seam: 'worldRebuilt', ms: 5_000 },
    { at: atRow(0), seam: 'worldRebuilt', ms: 40 }
  ])
  assert.equal(seams[0].maxMs, 40)
})

// ---- 4. the enum is checked at the fold, before any wire --------------------------------------

test('a sample naming a seam the enum does not have is dropped by the FOLD, before any wire', () => {
  const seams = fold([{ at: atRow(3), seam: 'eqlog_Primitive_freeport' as never, ms: 900 }])
  assert.deepEqual(seams, [])
})

test('the GC fold answers null when nothing was recorded — a report is about a MOMENT', () => {
  assert.equal(foldPerfGc([], WINDOW), null)
  const gc = foldPerfGc(
    [
      { at: atRow(30), ms: 640, kind: 'major' },
      { at: atRow(31), ms: 30, kind: 'minor' }
    ],
    WINDOW
  )
  assert.equal(gc?.pauses, 2)
  assert.equal(gc?.majorPauses, 1)
  assert.equal(gc?.maxMs, 640)
  assert.equal(gc?.totalMs, 670)
  assert.equal(gc?.t, 300)
  assert.equal(gc?.worstKind, 'major')
})

// ---- the rendered line, which is what a person actually reads ---------------------------------

test('THE OWNER LINE names the seam, its cost and where in the window it happened', () => {
  const perf = block({
    seams: [{ at: atRow(54), seam: 'worldRebuilt', ms: 1_186 }],
    gc: [{ at: atRow(54), ms: 40, kind: 'minor' }]
  })
  const owner = formatPerfBlock(perf).split('\n')[3]
  assert.match(owner, /owner: worldRebuilt 1186ms @t=540s \(1 over 25ms\)/)
  assert.match(owner, /gc 1 pause \(0 major\) max 40ms minor @t=540s/)
})

// ---- 3. absence is a finding ------------------------------------------------------------------

test('AN UNOWNED WINDOW SAYS SO — absence is a finding, not a missing line', () => {
  // A main-lateness reading with no seam named clears all six instrumented places at once, and a
  // reader has to be able to tell that from a build that never looked.
  const perf = block()
  assert.equal(perf.seams, undefined)
  assert.equal(perf.gc, undefined)
  assert.match(formatPerfBlock(perf), /owner: no instrumented seam and no gc pause reached 25ms/)
})

// ---- the validator, which runs inside the ingest Lambda ---------------------------------------

test('the block round-trips its two new groups through its own validator unchanged', () => {
  const perf = block({
    seams: [{ at: atRow(54), seam: 'worldRebuilt', ms: 1_186 }],
    gc: [{ at: atRow(54), ms: 640, kind: 'major' }]
  })
  const back = validatePerf(perf)
  assert.equal(back.ok, true)
  assert.deepEqual((back as { value: typeof perf }).value, perf)
})

test('A FORGED SEAM NAME IS A NAMED 400 at the validator, not a stored free-text field', () => {
  const forged = {
    ...block(),
    seams: [{ seam: 'C:/Users/someone/Logs/eqlog.txt', lateCalls: 1, maxMs: 40, t: 0 }]
  }
  const res = validatePerf(forged)
  assert.equal(res.ok, false)
  assert.equal((res as { field: string }).field, 'env.perf.seams[0].seam')
})

test('a `t` outside the block\u2019s own window is refused — it names no row that exists', () => {
  const res = validatePerf({
    ...block(),
    seams: [{ seam: 'worldRebuilt', lateCalls: 1, maxMs: 40, t: MAX_SEAM_T_S + 1 }]
  })
  assert.equal(res.ok, false)
  assert.equal((res as { field: string }).field, 'env.perf.seams[0].t')
})

test('a seam named twice is refused — a forged list cannot repeat one to bloat the block', () => {
  const twice = { seam: 'worldRebuilt', lateCalls: 1, maxMs: 40, t: 0 }
  const res = validatePerf({ ...block(), seams: [twice, { ...twice }] })
  assert.equal(res.ok, false)
  assert.equal((res as { field: string }).field, 'env.perf.seams[1].seam')
})
