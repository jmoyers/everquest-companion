// ============================================================================
// healthCounters.test.mts — the client half of JOS-96: what the app COUNTS.
// ============================================================================
//
// `EvHealthCounters` had been in the contract since wave A2 with NO PRODUCER — the schema, the
// validator, the fold and TELEMETRY.md all described five counters that nothing ever incremented.
// This suite covers the code that finally does.
//
// ITS PARTNER IS `tests/releaseHealth.test.mts`, which covers the readout these counts feed, and
// the two halves are one argument: the drain's "report even a clean session" decision below exists
// SOLELY to make that panel's "not reporting" state possible. They are two files only because both
// halves together are past the repo's 400-code-line ceiling — a split, not a widened threshold.
//
// `src/main/telemetry/health.ts` imports NOTHING (see its header: `errorLog.ts` is one of the five
// sources and `collector.ts` imports `errorLog.ts`, so a counter living in the collector would
// close a cycle on the app's error path). The happy consequence is that this suite drives the REAL
// production counters with no Electron in the process — no mocks, no fixtures, no clock.
//
// WHAT CAN GO WRONG HERE, and each gets a test: the delta could double-count across the two drain
// points; a clean session could report nothing and so make a healthy build look like a build that
// predates this code; a burst could be clamped into a lie; an opt-out could leave counts waiting;
// and a call site could drift away from the place the design argument put it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAX_COUNT, type TelemetryBatch, type TelemetryEvent } from '../src/shared/telemetry'
import { validateTelemetryEvent } from '../src/shared/telemetryValidate'
import { rollupBatch, USAGE_METRICS } from '../src/shared/telemetryRollup'
import {
  noteErrorLogLine,
  noteImageFetchFailure,
  noteParserStall,
  notePresenceRestart,
  noteRendererCrash,
  noteSpeechFailure,
  noteSuppressedErrorLine,
  peekHealth,
  resetHealth,
  takeHealth
} from '../src/main/telemetry/health'

const TEST_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ID = '2b1b5c33-6a1a-4d3e-8f0b-2c9a5d1e7f40'

const batchOf = (events: TelemetryEvent[]): TelemetryBatch => ({
  v: 1,
  env: { analyticsId: ID, appVersion: '0.6.0', channel: 'prod', platform: 'win32', tzOffsetBucket: -5 },
  events: events.map((ev) => ({ ts: 1_754_000_000_000, ev }))
})

const NO_HEALTH = {
  rendererCrashes: 0,
  mainErrorLogLines: 0,
  parserStalls: 0,
  presenceRestarts: 0,
  speechFailures: 0,
  // JOS-133's two. They are OPTIONAL on the wire and always present in the DELTA, and this literal
  // is the delta's shape — a `deepEqual` against it is what fails the day a field is added without
  // being thought about.
  imageFetchFailures: 0,
  suppressedErrorLines: 0
}

test('the health drain is a DELTA — a drain zeroes what it took, so nothing counts twice', () => {
  // The exact `linesPending` contract, and the reason the heartbeat may drain at all: a session
  // that heartbeats at 5 min and then ends at 7 must report each error ONCE across the two.
  resetHealth()
  noteErrorLogLine()
  noteErrorLogLine()
  noteRendererCrash()
  const first = takeHealth()
  assert.equal(first.mainErrorLogLines, 2)
  assert.equal(first.rendererCrashes, 1)
  // The heartbeat took them; the pending counters are empty behind it.
  assert.deepEqual(peekHealth(), NO_HEALTH)
  // Two more errors arrive in the window between that heartbeat and the close.
  noteErrorLogLine()
  noteSpeechFailure()
  const second = takeHealth()
  assert.equal(second.mainErrorLogLines, 1)
  assert.equal(second.speechFailures, 1)
  // THE PROPERTY: the two reports SUM to what really happened. Three log lines, not five.
  assert.equal(first.mainErrorLogLines + second.mainErrorLogLines, 3)
  assert.equal(first.rendererCrashes + second.rendererCrashes, 1)
  resetHealth()
})

test('a drain with nothing pending still returns a REPORT — all zeros, never null', () => {
  // The load-bearing one. `healthReports` is dimmed by VERSION in the rollup, so the report is
  // what proves a build CAN report; skipping it on a clean session would make a healthy build
  // indistinguishable from one that predates this code, and the panel's "not reporting" state
  // would have nothing to stand on.
  resetHealth()
  const clean = takeHealth()
  assert.deepEqual(clean, NO_HEALTH)
  // It survives validation as a real event, so `recordEvent` can put it straight in the ring.
  const validated = validateTelemetryEvent({ t: 'healthCounters', ...clean })
  assert.ok(validated.ok && validated.value.t === 'healthCounters')
  // …and folds to a `healthReports` row and NO error rows: a true, cheap zero.
  const rolled = rollupBatch(batchOf([{ t: 'healthCounters', ...clean }]), {
    firstOfDay: false,
    newInstall: false,
    upgraded: false
  })
  assert.equal(rolled.counters.filter((c) => c.metric === USAGE_METRICS.healthReports).length, 1)
  assert.equal(rolled.counters.filter((c) => c.metric === USAGE_METRICS.health).length, 0)
  resetHealth()
})

test('resetHealth DISCARDS the pending deltas — "off" means the counts do not come back', () => {
  // `endSession()` calls it, and `pauseTelemetry` goes through `endSession` — so errors counted
  // before the user flipped the switch must not sit in memory waiting for them to flip it back.
  // The same argument `linesPending` makes for itself in collector.ts.
  resetHealth()
  noteErrorLogLine(5)
  notePresenceRestart(2)
  assert.equal(peekHealth().mainErrorLogLines, 5)
  resetHealth()
  assert.deepEqual(takeHealth(), NO_HEALTH)
})

test('a health count is clamped at the DRAIN and the remainder is kept, never thrown away', () => {
  // `MAX_COUNT` is the wire's ceiling, so an implausible burst is split across reports rather
  // than truncated — `takeLinesParsed`'s rule, for its reason: clamping would quietly undercount
  // exactly the worst-behaved installs, which are the interesting ones.
  resetHealth()
  noteErrorLogLine(MAX_COUNT + 7)
  const first = takeHealth()
  assert.equal(first.mainErrorLogLines, MAX_COUNT)
  assert.equal(peekHealth().mainErrorLogLines, 7)
  assert.equal(takeHealth().mainErrorLogLines, 7)
  // A clamped value is still a legal event — the validator's ceiling is the same number.
  assert.ok(validateTelemetryEvent({ t: 'healthCounters', ...first }).ok)
  resetHealth()
})

test('a health note refuses nonsense rather than poisoning the counter with a NaN', () => {
  resetHealth()
  noteErrorLogLine(Number.NaN)
  noteErrorLogLine(-4)
  noteErrorLogLine(Number.POSITIVE_INFINITY)
  assert.equal(peekHealth().mainErrorLogLines, 0)
  noteErrorLogLine(3)
  assert.equal(peekHealth().mainErrorLogLines, 3)
  resetHealth()
})

test('parserStalls is NOT WIRED and reports 0 — "not measured", and it is said out loud', () => {
  // JOS-96 shipped four of the five sources. There is no stall detector in this app: the Tailer
  // keeps no last-line clock and nothing compares one to the wall, so a zero here means NOBODY
  // LOOKED, not "it never happened". Inventing a detector to fill the field would have put a
  // number on the wire with no measurement behind it (the awaiting-sample law). The counter
  // exists and is reachable; the day a detector lands, this test is what changes.
  resetHealth()
  noteErrorLogLine()
  noteRendererCrash()
  notePresenceRestart()
  noteSpeechFailure()
  assert.equal(takeHealth().parserStalls, 0)
  // The function is real and works — it simply has no caller in src/main today.
  noteParserStall(2)
  assert.equal(takeHealth().parserStalls, 2)
  resetHealth()
})

test('THE WIRING: both session reports drain the health counters, and only those two', () => {
  // A SOURCE PIN, in the style of tests/telemetryNet.test.mts's single-fetch-site pin. The drain
  // MOMENT is the whole no-double-count argument, and it lives in flush.ts's timers, which cannot
  // be driven from here without Electron — so what is asserted is that the call sites are where
  // the argument says they are, and that nothing else in the directory drains.
  const flush = readFileSync(join(TEST_ROOT, 'src/main/telemetry/flush.ts'), 'utf8')
  // One definition + exactly two call sites: the heartbeat, and `stopTelemetry`.
  assert.equal(flush.match(/reportHealth\(\)/g)?.length, 3)
  assert.match(flush, /t: 'healthCounters', \.\.\.takeHealth\(\)/)
  // The `sessionEnd` drain is INSIDE the uptime guard: a process that never collected has no
  // session to report the health of, and a bare denominator row from it would skew every rate.
  const end = flush.slice(flush.indexOf('export function stopTelemetry'))
  assert.ok(end.indexOf('reportHealth()') < end.indexOf('clearTimers()'))
  // And nothing else drains — two drains is how one of them silently double-counts.
  for (const file of ['collector.ts', 'ring.ts', 'net.ts', 'funnels.ts']) {
    const src = readFileSync(join(TEST_ROOT, 'src/main/telemetry', file), 'utf8')
    assert.ok(!src.includes('takeHealth('), `${file} must not drain the health counters`)
  }
})

test('THE FOUR WIRED SOURCES are wired where the report says, and the fifth is not', () => {
  // Counts only, and the SHAPE is what guarantees it: every note function takes a number and
  // nothing else, so no call site can attach a stack, a message or a path even by accident.
  const read = (p: string): string => readFileSync(join(TEST_ROOT, p), 'utf8')
  // 1. errors.log — counted AFTER the append, so a write that threw is not counted as a line.
  const errorLog = read('src/main/errorLog.ts')
  assert.ok(errorLog.indexOf('appendFileSync(path, line)') < errorLog.indexOf('noteErrorLogLine()'))
  // 2. renderer crash — at the EVENT, not off `logError` (that handler logs twice per crash), so
  //    the increment sits inside the listener and before its first log line.
  const windows = read('src/main/windowErrors.ts')
  const gone = windows.slice(windows.indexOf("wc.on('render-process-gone'"))
  assert.ok(gone.indexOf('noteRendererCrash()') < gone.indexOf("logError('main:render-process-gone'"))
  // 3. presence restarts — after `scheduleRestart`'s guard, so a refused restart does not count.
  const presence = read('src/main/presence.ts')
  const sched = presence.slice(presence.indexOf('function scheduleRestart'))
  assert.ok(sched.indexOf('listeners.size === 0) return') < sched.indexOf('notePresenceRestart()'))
  // 4. speech — the `!result.ok` arm of the one handler every main-side utterance passes through,
  //    which is the ELSE of the funnel's success mark: one branch each, no third state.
  const speech = read('src/main/ipc/speech.ts')
  const say = speech.slice(speech.indexOf('ipcMain.handle(IPC.speechSay'))
  assert.ok(say.indexOf("markFunnelStep('voice-install'") < say.indexOf('else noteSpeechFailure()'))
  // 5. parser stalls — NO caller anywhere in src/main. This assertion is the honest label.
  for (const file of ['src/main/log/Tailer.ts', 'src/main/session.ts']) {
    assert.ok(!read(file).includes('noteParserStall'), `${file} has no stall detector to wire`)
  }
})

test('JOS-133 wired two more, and BOTH are counts on paths that used to log an error', () => {
  const read = (p: string): string => readFileSync(join(TEST_ROOT, p), 'utf8')
  // 6. image fetch — the NETWORK catch, which no longer reaches `onError` at all. The whole point
  //    of the ticket is that this branch and the HTTP-status branch stopped being one decision.
  const img = read('src/main/imageCache.ts')
  const netCatch = img.slice(img.indexOf('} catch (err) {', img.indexOf('res = await doFetch')), img.indexOf('if (!res.ok)'))
  assert.match(netCatch, /noteImageFetchFailure\(\)/, 'the network leg counts')
  assert.doesNotMatch(netCatch, /onError\(/, 'and it no longer files an error')
  // …while the branch beside it, where a host ANSWERED, still does.
  const statusBranch = img.slice(img.indexOf('if (!res.ok)'), img.indexOf('const bytes = new Uint8Array'))
  assert.match(statusBranch, /onError\(/, 'an HTTP status is still ours to fix, and still an error')

  // 7. suppressed lines — bumped in `logError` from a leaf rule's verdict, and from NOWHERE ELSE
  //    in the tree: a caller outside this funnel is how the honest total quietly stops adding up.
  const errorLog = read('src/main/errorLog.ts')
  assert.match(errorLog, /const repeat = errorRepeat\(source, body\)/)
  assert.match(errorLog, /if \(repeat\.suppressed\) noteSuppressedErrorLine\(\)/)
  // TWO call sites since JOS-197, one per cap, and that is the whole point of the counter: an
  // occurrence the per-fingerprint BUDGET silenced is withheld exactly as an occurrence the
  // identical-line cap withheld, so `mainErrorLogLines + suppressedErrorLines` still adds up to
  // what really happened whichever rule stopped it.
  assert.equal(errorLog.match(/noteSuppressedErrorLine\(\)/g)?.length, 2)
  assert.match(errorLog, /if \(!budget\.report\) \{\s+noteSuppressedErrorLine\(\)/)
  // …and still only from here. The counter has one funnel, in src/main and in the tests alike.
  // A CALL, not a mention: both cap modules NAME the counter in their headers (that is where the
  // argument for it lives) and neither may reach it — the funnel bumps it, from the verdict.
  const callers = ['src/main/crashGuards.ts', 'src/main/errorBudget.ts', 'src/main/errorRepeat.ts']
  for (const f of callers) assert.ok(!read(f).includes('noteSuppressedErrorLine('), `${f} does not count`)
  // The report is taken BEFORE both caps, so suppressing a LINE never suppresses an observation.
  assert.ok(errorLog.indexOf('noteError(source, payload,') < errorLog.indexOf('const repeat ='))
  assert.ok(errorLog.indexOf('noteError(source, payload,') < errorLog.indexOf('if (!budget.report)'))
})

test('the two new fields are OPTIONAL on the wire — an old client must not fail a batch', () => {
  // THE DEPLOY-SKEW HALF (the additive-field rule, shared/telemetry.ts). This validator also runs
  // in the ingest Lambda, which reads events from clients both newer and older than itself. If the
  // fields were required, a client predating them would be told 400 for the whole batch, and
  // `telemetryPermanentRefusal` would class that as permanent and DROP every counter it holds.
  const old = { t: 'healthCounters', ...NO_HEALTH } as Record<string, unknown>
  delete old.imageFetchFailures
  delete old.suppressedErrorLines
  const v = validateTelemetryEvent(old)
  assert.ok(v.ok && v.value.t === 'healthCounters')
  // Absent means ABSENT, not zero: the value is constructed field by field, so an older client's
  // event round-trips to exactly itself (which is what tests/telemetryContract.test.mts pins).
  assert.deepEqual(v.value, old)
  // …and a NEW client's event carries them through, still counted per build by the rollup.
  const fresh = takeHealth()
  noteImageFetchFailure(3)
  noteSuppressedErrorLine(9)
  const now = { t: 'healthCounters', ...takeHealth() } as const
  const rolled = rollupBatch(batchOf([now]), { firstOfDay: false, newInstall: false, upgraded: false })
  const row = (dim: string): number =>
    rolled.counters.find((c) => c.metric === USAGE_METRICS.health && c.dim === dim)?.n ?? 0
  assert.equal(row('0.6.0:imageFetchFailures'), 3)
  assert.equal(row('0.6.0:suppressedErrorLines'), 9)
  assert.deepEqual(fresh, NO_HEALTH, 'the drain before them was clean')
  resetHealth()
})
