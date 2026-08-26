// ============================================================================
// feedbackPerfEngine.test.mts — THE ENGINE'S NUMBERS ON A BUG REPORT (ruling 19, JOS-502).
// ============================================================================
//
// Four things are proved here and they are the four the block can get wrong:
//
//   1. THE BRIGHT LINE, held by SHAPE. The engine's `perf.snapshot` carries an absolute path to the
//      user's game log and the log's own clock. Neither can reach a report, and the test that says
//      so serializes the whole folded block and searches it — not the fields it remembered to
//      check, the BYTES. That is the only form of this assertion that survives somebody adding a
//      field later.
//   2. ABSENT, NEVER ZERO. A scan still running, a session whose every frame was an owed reset, an
//      engine that has not sampled its ring — each of those has no measurement, and a zero would be
//      a measurement somebody took.
//   3. THE CLOSED SETS ARE CLOSED at both ends. An engine ahead of the app cannot open a string
//      channel through `id`, `verdict` or `state`: the fold drops what it does not recognise and
//      the validator refuses it.
//   4. THE CEILINGS AGREE with the ones `feedbackPerf.ts` states, which is the pin that keeps a
//      by-value restatement honest — the same pin `feedbackPerfSeams.test.mts` carries.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ENGINE_BUDGETS,
  ENGINE_STATES,
  ENGINE_VERDICTS,
  MAX_ENGINE_COUNT,
  MAX_ENGINE_MS,
  foldPerfEngine,
  formatPerfEngine,
  validatePerfEngine,
  type EngineFoldInput,
  type FeedbackPerfEngine
} from '../src/shared/feedbackPerfEngine'
import { MAX_PERF_COUNT, MAX_PERF_MS } from '../src/shared/feedbackPerf'

const NOW = 1_787_000_000_000

/** The path the engine really does put on `perf.snapshot.mark.log`, in the shape the product
 *  produces. It must not survive the fold — see claim 1. */
const A_REAL_LOG_PATH =
  'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends\\Logs\\eqlog_Primitive_freeport.txt'

/** A live engine mid-session, with everything measured. The fold's input is structural, so this is
 *  the shape the three ops actually answer with — plus the two fields that must NOT get through. */
function live(over: Partial<EngineFoldInput> = {}): EngineFoldInput {
  return {
    snapshot: {
      status: 'live',
      uptimeMs: 412_004,
      events: 139_864,
      lastEventTs: NOW - 1_400,
      // The absolute path and the log clock ride the op. They must not ride the report.
      ...({ mark: { log: A_REAL_LOG_PATH, offset: 219_000_000 } } as object),
      ingest: { spellDbMs: 386, scanMs: 52_500, scanBytes: 219_000_000 },
      serve: [
        { frames: 46, payloadWeight: 21_714, foldToFrameUsMax: 29 },
        { frames: 112, payloadWeight: 58_390, foldToFrameUsMax: 56_012 }
      ]
    },
    budgets: {
      budgets: [
        { id: 'foldRate', verdict: 'pass' },
        { id: 'serveLatency', verdict: 'fail' }
      ]
    },
    timeline: { timeline: [{ frames: 46 }, { frames: 112 }, { frames: 0 }] },
    now: NOW,
    ...over
  }
}

// ---- 1. the bright line ------------------------------------------------------------------------

test('THE BRIGHT LINE: no path and no log clock survives the fold, checked over the bytes', () => {
  // Serialized and SEARCHED, rather than field-by-field: a later hand adding a field cannot
  // accidentally reopen the channel, because this assertion does not know which fields exist.
  const block = foldPerfEngine(live())
  assert.ok(block !== null)
  const json = JSON.stringify(block)
  assert.ok(!json.includes('eqlog_'), `a log file name reached the report: ${json}`)
  assert.ok(!json.includes('EverQuest'), `an install path reached the report: ${json}`)
  assert.ok(!json.includes('Primitive'), `a character name reached the report: ${json}`)
  assert.ok(!json.includes(String(NOW - 1_400)), `the log's own clock reached the report: ${json}`)
  // …and what DID survive is the diagnostic half of the same reading: how far behind the fold was.
  assert.equal(block.behindMs, 1_400)
})

test('THE BRIGHT LINE: every value on the block is a number or a member of a closed set', () => {
  // The shape argument, asserted rather than trusted. If this ever fails, a free-text channel has
  // been opened into a stored report and the validator downstream cannot tell prose from a name.
  const block = foldPerfEngine(live())
  assert.ok(block !== null)
  for (const [key, value] of Object.entries(block)) {
    if (key === 'budgets') continue
    if (key === 'state') {
      assert.ok((ENGINE_STATES as readonly string[]).includes(value as string), key)
      continue
    }
    assert.equal(typeof value, 'number', `${key} is not a number`)
  }
  for (const budget of block.budgets) {
    assert.ok((ENGINE_BUDGETS as readonly string[]).includes(budget.id))
    assert.ok((ENGINE_VERDICTS as readonly string[]).includes(budget.verdict))
  }
})

// ---- 2. absent, never zero ---------------------------------------------------------------------

test('no engine answered is `null`, and it is a reading rather than a gap', () => {
  const block = foldPerfEngine({ snapshot: null, budgets: null, timeline: null, now: NOW })
  assert.equal(block, null)
  // …and it says so in words, so a reader can tell it from a client too old to have looked.
  assert.equal(formatPerfEngine(null), 'no engine answered')
  assert.equal(formatPerfEngine(undefined), 'no engine answered')
})

test('an idle engine reports its state and its uptime and claims nothing else', () => {
  // The state a report composed seconds after launch finds. Every measurement is ABSENT.
  const block = foldPerfEngine({
    snapshot: { status: 'idle', uptimeMs: 41, ingest: {}, serve: [] },
    budgets: { budgets: ENGINE_BUDGETS.map((id) => ({ id, verdict: 'unmeasured' })) },
    timeline: { timeline: [] },
    now: NOW
  })
  assert.ok(block !== null)
  assert.equal(block.state, 'idle')
  assert.equal(block.upMs, 41)
  for (const key of [
    'events',
    'behindMs',
    'spellDbMs',
    'scanMs',
    'scanKb',
    'frames',
    'servedKb',
    'worstServeUs',
    'windows',
    'busiestFrames',
    'quietWindows'
  ] as const) {
    assert.equal(block[key], undefined, `${key} is claimed on an idle engine`)
    assert.ok(!(key in block), `${key} is present as a key on an idle engine`)
  }
  // The budgets are still there, all three of them saying they judged nothing.
  assert.equal(block.budgets.length, ENGINE_BUDGETS.length)
  assert.ok(block.budgets.every((b) => b.verdict === 'unmeasured'))
})

test('a scan still running has no scan figures, and untimed frames have no latency', () => {
  const block = foldPerfEngine({
    snapshot: {
      status: 'folding',
      uptimeMs: 1_204,
      ingest: { spellDbMs: 386 },
      // A window that has been served its owed reset and nothing else: counted, never timed.
      serve: [{ frames: 1, payloadWeight: 200 }]
    },
    budgets: null,
    timeline: null,
    now: NOW
  })
  assert.ok(block !== null)
  assert.equal(block.spellDbMs, 386)
  assert.ok(!('scanMs' in block), 'a running scan has no duration')
  assert.ok(!('scanKb' in block), '…and no byte count')
  assert.equal(block.frames, 1, 'the frame is counted')
  assert.ok(!('worstServeUs' in block), '…and reports no latency rather than zero')
})

test('a fold DAYS behind the log still reports the lag, because a lag is not a cost', () => {
  // FOUND BY READING THE E2E'S OWN OUTPUT: the committed fixture makes the panel say "23.4 days
  // behind", and under an hour's ceiling — the bound every other duration on this block uses —
  // `whole` would have dropped that reading entirely rather than clamp it. Correct behaviour from
  // the helper, wrong bound for the field. "The engine is three days behind the log" is one of the
  // strongest sentences a stalled-app report can carry, so it gets the uptime ceiling instead.
  // Twenty-three whole days. Written as a product of integers rather than as `23.4 * …`, because
  // 23.4 has no exact binary form and the fold ROUNDS — the assertion would then be comparing a
  // rounded reading against an unrounded expectation and failing for a reason that has nothing to
  // do with the ceiling under test.
  const days = 23 * 24 * 60 * 60 * 1000
  const block = foldPerfEngine(
    live({
      snapshot: {
        status: 'live',
        uptimeMs: 5_000,
        events: 941,
        lastEventTs: NOW - days,
        ingest: {},
        serve: []
      }
    })
  )
  assert.ok(block !== null)
  assert.equal(block.behindMs, days, 'reported, not dropped and not clamped')
  // …and it survives the validator, which is the half that would have turned it into a 400.
  const res = validatePerfEngine(JSON.parse(JSON.stringify(block)) as unknown)
  assert.equal(res.ok, true)
})

// ---- 3. the closed sets are closed -------------------------------------------------------------

test('a budget this build has never heard of is dropped rather than passed through', () => {
  // An engine ahead of the app. The fold must not become a string channel just because the two
  // halves shipped out of step — and the app must not lose the budgets it DOES understand.
  const block = foldPerfEngine(
    live({
      budgets: {
        budgets: [
          { id: 'foldRate', verdict: 'pass' },
          { id: 'somethingLater', verdict: 'pass' },
          { id: 'serveLatency', verdict: 'not a verdict' }
        ]
      }
    })
  )
  assert.ok(block !== null)
  assert.deepEqual(block.budgets, [{ id: 'foldRate', verdict: 'pass' }])
})

test('a state this build has never heard of folds to null rather than to a guess', () => {
  const block = foldPerfEngine(
    live({ snapshot: { status: 'hibernating', uptimeMs: 10, ingest: {}, serve: [] } })
  )
  assert.equal(block, null, 'an unreadable state is no reading at all')
})

// ---- 4. the ring summary -----------------------------------------------------------------------

test('the ring is summarized into three numbers, and a quiet window counts as quiet', () => {
  const block = foldPerfEngine(live())
  assert.ok(block !== null)
  assert.equal(block.windows, 3)
  assert.equal(block.busiestFrames, 112)
  assert.equal(block.quietWindows, 1, 'silence is a reading')
  // The thirty moments themselves never ride — a report wants one number per question.
  assert.ok(!JSON.stringify(block).includes('spanMs'))
})

test('the serve table is summed rather than tabled, and names no source', () => {
  const block = foldPerfEngine(live())
  assert.ok(block !== null)
  assert.equal(block.frames, 158, '46 + 112')
  assert.equal(block.servedKb, 78, 'floor((21714 + 58390) / 1024)')
  assert.equal(block.worstServeUs, 56_012, 'the worst across every source')
})

// ---- 5. the validator --------------------------------------------------------------------------

test('a folded block round-trips through its own validator unchanged', () => {
  const block = foldPerfEngine(live())
  assert.ok(block !== null)
  const res = validatePerfEngine(JSON.parse(JSON.stringify(block)) as unknown)
  assert.equal(res.ok, true)
  assert.deepEqual(res.ok ? res.value : null, block)
})

test('absent and null are the same answer, which is what makes the field additive', () => {
  for (const raw of [undefined, null]) {
    const res = validatePerfEngine(raw)
    assert.equal(res.ok, true)
    assert.equal(res.ok ? res.value : 'x', undefined)
  }
})

test('a malformed engine block is a NAMED 400, never a silently dropped field', () => {
  const good = foldPerfEngine(live())
  assert.ok(good !== null)
  const cases: [string, unknown][] = [
    ['env.perf.engine', 'not an object'],
    ['env.perf.engine.state', { ...good, state: 'hibernating' }],
    ['env.perf.engine.upMs', { ...good, upMs: -1 }],
    ['env.perf.engine.upMs', { ...good, upMs: 12.7 }],
    ['env.perf.engine.events', { ...good, events: MAX_ENGINE_COUNT + 1 }],
    ['env.perf.engine.budgets', { ...good, budgets: 'nope' }],
    ['env.perf.engine.budgets[0].id', { ...good, budgets: [{ id: 'x', verdict: 'pass' }] }],
    [
      'env.perf.engine.budgets[0].verdict',
      { ...good, budgets: [{ id: 'foldRate', verdict: 'maybe' }] }
    ],
    [
      'env.perf.engine.budgets[1].id',
      {
        ...good,
        budgets: [
          { id: 'foldRate', verdict: 'pass' },
          { id: 'foldRate', verdict: 'fail' }
        ]
      }
    ]
  ]
  for (const [field, raw] of cases) {
    const res = validatePerfEngine(raw)
    assert.equal(res.ok, false, `${field} was accepted: ${JSON.stringify(raw)}`)
    assert.equal(res.ok ? '' : res.field, field)
  }
})

test('the validator RECONSTRUCTS the block — a smuggled key does not survive', () => {
  // The same posture every validator on this wire has, and the reason the bright line holds even
  // if a forged client sends whatever it likes.
  const good = foldPerfEngine(live())
  assert.ok(good !== null)
  const res = validatePerfEngine({
    ...good,
    logPath: A_REAL_LOG_PATH,
    character: 'Primitive',
    note: 'anything at all'
  })
  assert.equal(res.ok, true)
  const json = JSON.stringify(res.ok ? res.value : {})
  assert.ok(!json.includes('logPath'))
  assert.ok(!json.includes('Primitive'))
  assert.ok(!json.includes('anything at all'))
})

test('a forged budget list cannot be longer than the number of budgets that exist', () => {
  const good = foldPerfEngine(live())
  assert.ok(good !== null)
  const forged = {
    ...good,
    budgets: Array.from({ length: ENGINE_BUDGETS.length + 1 }, () => ({
      id: 'foldRate',
      verdict: 'pass'
    }))
  }
  assert.equal(validatePerfEngine(forged).ok, false)
})

// ---- 6. the ceilings and the printed line ------------------------------------------------------

test('the ceilings restated here are the ones feedbackPerf.ts states', () => {
  // The by-value restatement exists because an import back would be a cycle inside the Lambda
  // bundle. This is what keeps it honest — the same pin feedbackPerfSeams.test.mts carries.
  assert.equal(MAX_ENGINE_MS, MAX_PERF_MS)
  assert.equal(MAX_ENGINE_COUNT, MAX_PERF_COUNT)
})

test('the line reads as a sentence and states the verdicts last', () => {
  const block = foldPerfEngine(live())
  assert.ok(block !== null)
  const line = formatPerfEngine(block)
  assert.match(line, /^live up 412s/)
  assert.match(line, /139,864 events/)
  assert.match(line, /1400ms behind/)
  assert.match(line, /scan 52500ms of 213867kB/)
  assert.match(line, /158 frames \/ 78kB worst 56012us/)
  assert.match(line, /3 windows \(1 quiet\)/)
  assert.match(line, /foldRate pass, serveLatency fail$/)
})

test('an engine that answered but reported no budgets says so rather than printing nothing', () => {
  const block: FeedbackPerfEngine = { state: 'starting', upMs: 20, budgets: [] }
  assert.equal(formatPerfEngine(block), 'starting up 0s · no budgets reported')
})
