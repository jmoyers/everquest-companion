// The perf timeline a bug report carries (src/shared/feedbackPerf.ts, JOS-369).
//
// WHAT THIS SUITE IS FOR. The block is folded on the reporter's machine, in the seconds after
// something froze, out of two rings that cannot be re-run. Every claim it makes is therefore
// unfalsifiable AFTER the fact — which is exactly why the ARITHMETIC has to be pinned here, on
// injected samples, rather than inferred from a session nobody can replay. The same argument
// `noteLiveProbeSamples` makes for the probe's own tests, one fold further along.
//
// The four properties it exists to hold:
//
//   1. THE GRID IS FIXED. Sixty rows, ten seconds each, `t` marching 0…590 — so any reader can
//      address a row by time without carrying a cursor, and so a hitch has a POSITION and not
//      just a size.
//   2. AN EMPTY BLOCK IS NOT A BLOCK. Rings with nothing in them fold to `null`, and the report
//      then has no `perf` key at all (feedback/slice.ts:238's spirit).
//   3. IT FITS. The block rides `env_json`, which shares MAX_BODY_BYTES with the user's 4,000
//      characters of prose; the size guard is measured here at the WORST case, not asserted.
//   4. WHOLE NUMBERS AND CLOSED ENUMS ONLY. The validator reconstructs the block field by field,
//      so nothing the shape does not name can ride along into the database.
//
// No Electron, no network, no fixtures — this suite never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_PERF_BYTES,
  PERF_INTERVAL_MS,
  PERF_ROWS,
  foldFeedbackPerf,
  formatPerfBlock,
  formatPerfSummary,
  perfBytes,
  perfSparkline,
  validatePerf,
  type FeedbackPerf,
  type FeedbackPerfState,
  type PerfFoldInput
} from '../src/shared/feedbackPerf'
import { LIVE_TIMELINE_MS } from '../src/shared/perfLive'
import { PERF_SEAMS } from '../src/shared/perfSeams'
import { ENGINE_BUDGETS } from '../src/shared/feedbackPerfEngine'
import { validateEnv, validateSubmit } from '../src/shared/feedback'

const NOW = 1_800_000_000_000

const STATE: FeedbackPerfState = {
  overlaysOpen: 3,
  overlaysLocked: 1,
  presenceOn: true,
  ringOn: false,
  freeMemMb: 9_014,
  workingSetMb: 412,
  cpuCount: 16,
  totalMemGb: 32,
  gpuVendor: 'nvidia',
  gpuCompositing: 'hardware',
  eqWindowMode: 'fullscreen'
}

/** Wall clock for the START of bucket `i` — the fold's own grid, restated so a test that
 *  disagrees with it is a test about the arithmetic and not about arithmetic in the test. */
const atRow = (i: number): number => NOW - PERF_ROWS * PERF_INTERVAL_MS + i * PERF_INTERVAL_MS + 1

const input = (over: Partial<PerfFoldInput> = {}): PerfFoldInput => ({
  main: [],
  worker: [],
  tail: [],
  state: STATE,
  ...over
})

/** A block from one late tick — the smallest thing that is still a block. */
function oneTick(lateMs = 900, row = 30): FeedbackPerf {
  const perf = foldFeedbackPerf(input({ main: [{ at: atRow(row), lateMs }] }), NOW)
  assert.ok(perf !== null)
  return perf
}

// ---- 1. the grid ------------------------------------------------------------------------

test('the row width and the row count between them cover the whole ring', () => {
  // If either constant moves without the other, the block silently describes a shorter window
  // than the ring it was folded from — and nothing else in the system would notice.
  assert.equal(PERF_ROWS * PERF_INTERVAL_MS, LIVE_TIMELINE_MS)
  assert.equal(PERF_ROWS, 60)
})

test('sixty rows come back on a fixed grid, whatever landed in them', () => {
  const perf = oneTick()
  assert.equal(perf.rows.length, PERF_ROWS)
  assert.equal(perf.intervalMs, PERF_INTERVAL_MS)
  perf.rows.forEach((r, i) => {
    assert.equal(r.t, i * 10)
  })
})

test('a sample lands in the bucket its wall clock falls in, and only that one', () => {
  const perf = oneTick(742, 17)
  assert.equal(perf.rows[17].mainMaxLateMs, 742)
  assert.equal(
    perf.rows.filter((r) => r.mainMaxLateMs > 0).length,
    1,
    'one late tick must not smear across the timeline'
  )
})

test('a bucket keeps the WORST tick in it, never an average', () => {
  const perf = foldFeedbackPerf(
    input({
      main: [
        { at: atRow(5), lateMs: 30 },
        { at: atRow(5) + 4_000, lateMs: 1_200 },
        { at: atRow(5) + 8_000, lateMs: 40 }
      ]
    }),
    NOW
  )
  assert.equal(perf?.rows[5].mainMaxLateMs, 1_200)
})

test('samples older than the window are DROPPED, not piled onto row 0', () => {
  const perf = foldFeedbackPerf(
    input({
      main: [
        { at: NOW - LIVE_TIMELINE_MS - 60_000, lateMs: 5_000 }, // a minute before the window
        { at: atRow(0), lateMs: 40 }
      ]
    }),
    NOW
  )
  assert.equal(perf?.rows[0].mainMaxLateMs, 40, 'the old spike must not appear at the left edge')
  assert.equal(perf?.summary.maxMainMs, 40)
})

// ---- 2. an empty block is not a block ---------------------------------------------------

test('empty rings fold to null — there is nothing to attach', () => {
  assert.equal(foldFeedbackPerf(input(), NOW), null)
})

test('a state reading alone is not a timeline', () => {
  // The state group always answers (the store and the OS are always there). It must not be able
  // to keep a block alive on its own, or every pre-replayDone report would carry sixty zero rows.
  assert.equal(foldFeedbackPerf(input({ state: STATE }), NOW), null)
})

test('a tail read with no stall at all is still a block', () => {
  // The reverse case, and it is deliberate: "the log read stalled and nothing else did" is one
  // of the three answers this whole feature exists to distinguish.
  const perf = foldFeedbackPerf(
    input({ tail: [{ at: atRow(2), readMs: 640, reopened: true }] }),
    NOW
  )
  assert.equal(perf?.rows[2].tailMaxMs, 640)
  assert.equal(perf?.rows[2].tailReads, 1)
  assert.equal(perf?.rows[2].tailReopens, 1)
  assert.equal(perf?.summary.maxMainMs, 0)
})

test('an env with no perf block has no perf KEY', () => {
  const env = {
    appVersion: '0.28.0',
    channel: 'dev',
    updateChannel: 'main',
    platform: 'win32',
    osRelease: '10.0.22631',
    arch: 'x64',
    electron: '31.0.0',
    chrome: '126.0.0',
    node: '20.14.0'
  }
  const res = validateEnv(env)
  assert.equal(res.ok, true)
  assert.ok(res.ok && !('perf' in res.value), 'absent must stay absent, never become null')
  // …and an old client that literally sends null is not rejected for it.
  assert.equal(validateEnv({ ...env, perf: null }).ok, true)
  assert.equal(validateSubmit(submitWith(env)).ok, true)
})

/** A whole request around an env — the Lambda's own entry point, so the perf field is exercised
 *  through the function that actually runs in production rather than only through its half. */
function submitWith(env: unknown): unknown {
  return {
    v: 1,
    draft: { type: 'bug', description: 'It hitches every minute or so.' },
    env,
    installId: '4f8a4a1e-2c1a-4b2a-8a1e-2c1a4b2a8a1e',
    clientReportId: '5f8a4a1e-2c1a-4b2a-8a1e-2c1a4b2a8a1f',
    clientTs: NOW,
    log: null,
    inventory: null
  }
}

// ---- 3. the summary ---------------------------------------------------------------------

test('the summary counts freezes, peaks and the coincidence verdict', () => {
  const main = [
    { at: atRow(1), lateMs: 30 },
    { at: atRow(10), lateMs: 620 },
    { at: atRow(20), lateMs: 1_400 },
    { at: atRow(30), lateMs: 500 }
  ]
  // The worker was late at the same instant as ONE of those — the machine stalled once.
  const perf = foldFeedbackPerf(
    input({ main, worker: [{ at: atRow(20) + 100, lateMs: 1_380 }] }),
    NOW
  )
  assert.equal(perf?.summary.maxMainMs, 1_400)
  assert.equal(perf?.summary.over500, 3, '620, 1400 and 500 are all at or over the freeze line')
  assert.equal(perf?.summary.coincident, 1)
  assert.equal(perf?.summary.p95MainMs, 1_400)
})

test('coincident is 0, not absent, when a second clock ran and never agreed', () => {
  const perf = foldFeedbackPerf(
    input({ main: [{ at: atRow(4), lateMs: 900 }], worker: [{ at: atRow(40), lateMs: 900 }] }),
    NOW
  )
  assert.equal(perf?.summary.coincident, 0)
})

// ---- 4. it fits -------------------------------------------------------------------------

/** Every field at the ceiling the validator permits — the biggest block that can ever be
 *  shape-valid. Not a machine's output; the corner of the shape. */
function ceilingBlock(): FeedbackPerf {
  const perf = oneTick()
  return {
    ...perf,
    rows: perf.rows.map((r) => ({
      ...r,
      mainMaxLateMs: 3_599_999,
      workerMaxLateMs: 3_599_999,
      tailMaxMs: 3_599_999,
      tailReads: 999_999,
      tailReopens: 999_999
    })),
    summary: { p95MainMs: 3_599_999, maxMainMs: 3_599_999, coincident: 999_999, over500: 999_999 },
    state: { ...perf.state, freeMemMb: 999_999, workingSetMb: 999_999, cpuCount: 999_999 },
    // JOS-458's two groups at THEIR ceilings too: every seam present (the validator's own cap on
    // the list) with every number at its bound, and the GC object likewise. Without these the size
    // guard below would be measuring a block the wire can no longer produce.
    seams: PERF_SEAMS.map((seam) => ({
      seam,
      lateCalls: 999_999,
      maxMs: 3_599_999,
      t: 590
    })),
    gc: {
      pauses: 999_999,
      majorPauses: 999_999,
      maxMs: 3_599_999,
      totalMs: 3_599_999,
      t: 590,
      // Every member of GC_KINDS is five characters, so any of them is the widest this can be.
      worstKind: 'major' as const
    },
    // …and JOS-502's engine block at ITS ceiling: every optional field present and every number at
    // its bound, both budgets named (the validator's own cap on that list), and the state member
    // that spells longest. Same argument as the two groups above — without this the size guard
    // would be measuring a block the wire can no longer produce.
    engine: {
      state: 'attaching' as const,
      upMs: 31_536_000_000,
      events: 999_999,
      // `behindMs` takes the UPTIME ceiling, not the one-hour duration ceiling — a freshness lag
      // is a distance from now, not a cost, and a log untouched for a fortnight has a real one.
      behindMs: 31_536_000_000,
      spellDbMs: 3_599_999,
      scanMs: 3_599_999,
      scanKb: 999_999_999,
      frames: 999_999,
      servedKb: 999_999_999,
      worstServeUs: 3_599_999_999,
      windows: 999_999,
      busiestFrames: 999_999,
      quietWindows: 999_999,
      budgets: ENGINE_BUDGETS.map((id) => ({ id, verdict: 'unmeasured' as const }))
    }
  }
}

test('a real block, and the biggest possible one, both fit inside the size guard', () => {
  // THE MEASUREMENT, not an assertion of an intention. The grid is fixed, so these three barely
  // differ — which is the whole reason the cap can be a tripwire rather than a budget.
  const quiet = perfBytes(oneTick())
  const busyMain = Array.from({ length: 200 }, (_v, i) => ({
    at: atRow(i % PERF_ROWS) + i,
    lateMs: 30 + (i % 9) * 40
  }))
  const busy = foldFeedbackPerf(
    input({
      main: busyMain,
      worker: busyMain.map((s) => ({ ...s, lateMs: s.lateMs - 5 })),
      tail: Array.from({ length: 600 }, (_v, i) => ({
        at: atRow(i % PERF_ROWS) + i,
        readMs: 2 + (i % 40),
        reopened: i % 97 === 0
      }))
    }),
    NOW
  )
  assert.ok(busy !== null)
  const ceiling = perfBytes(ceilingBlock())
  assert.ok(quiet <= MAX_PERF_BYTES, `quiet window is ${quiet} bytes`)
  assert.ok(perfBytes(busy) <= MAX_PERF_BYTES, `busy window is ${perfBytes(busy)} bytes`)
  assert.ok(ceiling <= MAX_PERF_BYTES, `the ceiling block is ${ceiling} bytes`)
})

test('THE SIZE GUARD: no shape-valid block can trip it, and this is what keeps that true', () => {
  // The guard is a tripwire on the CONSTANTS, not a runtime filter: because the row count is
  // fixed and every field is bounded, the largest block the validator would otherwise accept is
  // still under the cap — so a report can never be rejected for a size the client chose. Add a
  // seventh column or widen a ceiling and this assertion goes red BEFORE anyone ships a 400.
  const ceiling = ceilingBlock()
  assert.equal(validatePerf(ceiling).ok, true)
  assert.ok(
    perfBytes(ceiling) <= MAX_PERF_BYTES,
    `the largest shape-valid block is ${perfBytes(ceiling)} bytes and the cap is ${MAX_PERF_BYTES}`
  )
  // …and the guard itself still refuses something genuinely over the line, so the arm is live
  // rather than dead code: sixty rows is the shape, and a block that also carries a megabyte of
  // anything else is not one this wire has a spelling for.
  const forged = { ...ceiling, rows: [...ceiling.rows, ...ceiling.rows] }
  assert.equal(validatePerf(forged).ok, false)
})

// ---- 5. the validator -------------------------------------------------------------------

test('a folded block round-trips through its own validator unchanged', () => {
  const perf = oneTick()
  const res = validatePerf(JSON.parse(JSON.stringify(perf)) as unknown)
  assert.deepEqual(res.ok && res.value, perf)
})

test('absent and null are the same answer', () => {
  assert.deepEqual(validatePerf(undefined), { ok: true, value: null })
  assert.deepEqual(validatePerf(null), { ok: true, value: null })
})

test('a malformed block is a NAMED 400, never a silently dropped field', () => {
  const perf = oneTick()
  const cases: [string, unknown][] = [
    ['env.perf', 'not an object'],
    ['env.perf.intervalMs', { ...perf, intervalMs: 5_000 }],
    ['env.perf.rows', { ...perf, rows: perf.rows.slice(0, 59) }],
    ['env.perf.rows[0].t', { ...perf, rows: [{ ...perf.rows[0], t: 7 }, ...perf.rows.slice(1)] }],
    [
      'env.perf.rows[0].mainMaxLateMs',
      { ...perf, rows: [{ ...perf.rows[0], mainMaxLateMs: 12.7 }, ...perf.rows.slice(1)] }
    ],
    [
      'env.perf.rows[1].tailReads',
      { ...perf, rows: [perf.rows[0], { ...perf.rows[1], tailReads: -1 }, ...perf.rows.slice(2)] }
    ],
    ['env.perf.summary.maxMainMs', { ...perf, summary: { ...perf.summary, maxMainMs: 'lots' } }],
    ['env.perf.state.cpuCount', { ...perf, state: { ...perf.state, cpuCount: null } }],
    ['env.perf.state.presenceOn', { ...perf, state: { ...perf.state, presenceOn: 'yes' } }],
    ['env.perf.state.gpuVendor', { ...perf, state: { ...perf.state, gpuVendor: 'matrox' } }],
    ['env.perf.state.eqWindowMode', { ...perf, state: { ...perf.state, eqWindowMode: 'borderless' } }]
  ]
  for (const [field, value] of cases) {
    const res = validatePerf(value)
    assert.equal(res.ok, false, `${field} should have been rejected`)
    assert.equal(res.ok === false && res.field, field)
    assert.equal(res.ok === false && res.error, 'invalid_payload')
  }
})

test('the validator RECONSTRUCTS the block — a smuggled key does not survive', () => {
  const perf = oneTick()
  const res = validatePerf({
    ...perf,
    logPath: 'C:\\Users\\somebody\\Logs\\eqlog_Bob_firiona.txt',
    rows: [{ ...perf.rows[0], selfName: 'Bob' }, ...perf.rows.slice(1)],
    state: { ...perf.state, machineName: 'BOBS-PC' }
  })
  assert.equal(res.ok, true)
  assert.equal(JSON.stringify(res.ok && res.value).includes('Bob'), false)
  assert.equal(JSON.stringify(res.ok && res.value).includes('machineName'), false)
})

test('a report carrying a real block survives the whole-request validator', () => {
  const env = {
    appVersion: '0.28.0',
    channel: 'dev',
    updateChannel: 'main',
    platform: 'win32',
    osRelease: '10.0.22631',
    arch: 'x64',
    electron: '31.0.0',
    chrome: '126.0.0',
    node: '20.14.0',
    perf: oneTick()
  }
  const res = validateSubmit(submitWith(env))
  assert.equal(res.ok, true)
  assert.equal(res.ok && res.value.env.perf?.summary.maxMainMs, 900)
  // …and a malformed one fails the REQUEST with the perf field named, not the env.
  const bad = validateSubmit(submitWith({ ...env, perf: { ...env.perf, intervalMs: 1 } }))
  assert.equal(bad.ok === false && bad.field, 'env.perf.intervalMs')
})

// ---- 6. one renderer, three surfaces ----------------------------------------------------

test('the sparkline is sixty ASCII characters, positioned where the hitch was', () => {
  const line = perfSparkline(oneTick(900, 30))
  assert.equal(line.length, PERF_ROWS)
  assert.equal(line[30], '@', 'the only late bucket is the peak, so it draws the top of the ramp')
  assert.equal(line[29], ' ')
  // ASCII only: this string is printed into a terminal, pasted into issues and rendered in a
  // browser, and exactly one of those three will turn a box-drawing character into a square.
  assert.match(line, /^[ -~]+$/)
})

test('a quiet window draws a blank sparkline rather than a false floor', () => {
  const perf = foldFeedbackPerf(input({ tail: [{ at: atRow(3), readMs: 4, reopened: false }] }), NOW)
  assert.ok(perf !== null)
  assert.equal(perfSparkline(perf).trim(), '')
})

test('the summary line states the numbers and the block prints five lines', () => {
  const perf = oneTick()
  const summary = formatPerfSummary(perf)
  assert.match(summary, /late p95 900ms/)
  assert.match(summary, /max 900ms/)
  assert.match(summary, /1 freeze \(>=500ms\)/)
  const block = formatPerfBlock(perf)
  // FOUR since JOS-458 and FIVE since JOS-502. The fourth is the CONCLUSION — which seam or which
  // collection owned the spike the three above it establish — and the fifth is the ENGINE, the one
  // process in this app that `app.getAppMetrics()` structurally cannot see. Both are printed even
  // when they have nothing to report, because "nothing reached the threshold" / "no engine
  // answered" and "this build never looked" are different reports and the reader must be able to
  // tell them apart.
  assert.equal(block.split('\n').length, 5)
  assert.match(block, /last 10 min, 10s rows/)
  assert.match(block, /nvidia\/hardware/)
  assert.match(block, /owner: no instrumented seam and no gc pause reached/)
  assert.match(block, /engine: no engine answered/)
})
