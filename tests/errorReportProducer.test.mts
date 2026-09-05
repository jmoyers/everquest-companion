// ============================================================================
// THE CLIENT HALF of the error report (JOS-100) — the ring, the dedupe, the capture.
// ============================================================================
//
// `tests/errorReportContract.test.mts` pins the SHAPE (what the wire will accept).
// This pins the PRODUCER: that the breadcrumb ring says what happened, that one error twice in
// one session is one exemplar and two counts, and that a report built from a real thrown Error
// carries nothing from the game.
//
// It drives the real leaf modules directly. They import no Electron and no store — that is the
// whole point of their being leaves (see their headers) — so this suite NEVER SKIPS.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  currentMode,
  noteEngineEdge,
  noteEventKind,
  noteReplaying,
  readBreadcrumbs,
  resetBreadcrumbs
} from '../src/main/telemetry/breadcrumbs'
import {
  noteCurrentView,
  noteError,
  peekErrorReports,
  resetErrorReports,
  takeErrorReports
} from '../src/main/telemetry/errorReports'
import { errorFingerprint } from '../src/shared/errorReport'
import { MAX_SESSION_FINGERPRINTS, SESSION_AGE_MS_EDGES } from '../src/shared/telemetry'
import { validateTelemetryEvent } from '../src/shared/telemetryValidate'

/** Every test starts from a clean session; the modules are process-global by design. */
function fresh(now = 1_000_000): void {
  resetErrorReports(now)
}

// =========================================================================================
// 1. THE BREADCRUMB RING
// =========================================================================================

test('the ring reports the last ten kinds NEWEST FIRST, with offsets back from the newest', () => {
  resetBreadcrumbs()
  assert.deepEqual(readBreadcrumbs(), [], 'nothing parsed yet is an empty list, not a fake one')

  noteEventKind('zone', 10_000)
  noteEventKind('damage', 11_200)
  noteEventKind('loot', 11_500)
  assert.deepEqual(readBreadcrumbs(), [
    { kind: 'loot', offsetMs: 0 },
    { kind: 'damage', offsetMs: 300 },
    { kind: 'zone', offsetMs: 1_500 }
  ])
})

test('the ring is a RING: eleven events keep the last ten', () => {
  resetBreadcrumbs()
  for (let i = 0; i < 11; i++) noteEventKind(i === 0 ? 'zone' : 'damage', 1_000 + i * 100)
  const crumbs = readBreadcrumbs()
  assert.equal(crumbs.length, 10)
  // The `zone` at index 0 has been pushed out; every survivor is a damage line.
  assert.equal(crumbs.some((c) => c.kind === 'zone'), false)
  assert.equal(crumbs[0].offsetMs, 0)
  assert.equal(crumbs[9].offsetMs, 900)
})

test('offsets are COARSE, capped, and never negative', () => {
  resetBreadcrumbs()
  noteEventKind('damage', 0)
  noteEventKind('heal', 60 * 60_000) // an hour later — past the 10-minute cap
  noteEventKind('loot', 60 * 60_000 + 40) // 40 ms later — rounds to 0
  const crumbs = readBreadcrumbs()
  assert.equal(crumbs[0].offsetMs, 0)
  assert.equal(crumbs[1].offsetMs, 0, '40 ms rounds down to nothing — the question is coarse')
  assert.equal(crumbs[2].offsetMs, 10 * 60_000, 'capped, never a raw hour')

  // A NON-MONOTONIC STAMP READS AS ZERO, never as a negative. Log timestamps have one-second
  // resolution and a derived event inherits its parent's `ts`, so out-of-order pairs are
  // ordinary — and a negative offset would be REFUSED by the wire validator, costing a real
  // crash report over a rounding artefact.
  resetBreadcrumbs()
  noteEventKind('damage', 5_000)
  noteEventKind('buffExpired', 1_000)
  assert.deepEqual(readBreadcrumbs(), [
    { kind: 'buffExpired', offsetMs: 0 },
    { kind: 'damage', offsetMs: 0 }
  ])
})

test('mode comes from the REPLAY BRACKET, not from a per-event flag', () => {
  resetBreadcrumbs()
  assert.equal(currentMode(), 'live', 'a process that never replayed is live')
  noteReplaying(true)
  assert.equal(currentMode(), 'replay')
  noteReplaying(false)
  assert.equal(currentMode(), 'live')
})

test('THE ENGINE FILLS THE BOOT WINDOW, which had no producer at all (JOS-501)', () => {
  // THE GAP THIS CLOSES. JOS-499 took the parser out of this process, and the ring's one
  // surviving producer became the engine's module CURSORS — which cannot fire until an engine is
  // connected, attached and LIVE. On the owner's real log that is the better part of a minute
  // after launch, so every crash in the boot window produced a report with an EMPTY ring, and the
  // boot window is where the supervisor, the connect flow and the first attach all live.
  resetBreadcrumbs()
  assert.deepEqual(readBreadcrumbs(), [], 'nothing has happened yet')

  noteEngineEdge('engine:spawned')
  noteEngineEdge('engine:ready')
  noteEngineEdge('engine:live')
  const crumbs = readBreadcrumbs()
  assert.deepEqual(
    crumbs.map((c) => c.kind),
    // NEWEST FIRST, like every other reading of this ring — a report is read backwards from the
    // crash, so the launch reads bottom-up: spawned, then ready, then live.
    ['engine:live', 'engine:ready', 'engine:spawned'],
    'the launch is legible, newest first'
  )

  // A KIND IS NOT CONTENT, and here the type system is what enforces it: `noteEngineEdge` takes a
  // union of four literals, so there is no expression a caller could pass that carries a name, a
  // path, a port or a pid. This asserts the OUTPUT half of that — nothing but the edge survives.
  assert.ok(
    crumbs.every((c) => Object.keys(c).length === 2 && typeof c.offsetMs === 'number'),
    'a breadcrumb is a kind and an offset, and never grew a third field'
  )

  // THE RING STILL FAVOURS THE RECENT, which is the right trade rather than a loss: a live session
  // spends all ten slots on module cursors within a beat or two, and boot crumbs only ever mattered
  // for a crash that happened before those existed.
  for (let i = 0; i < 10; i++) noteEventKind('damage', 1_000 + i)
  assert.ok(
    readBreadcrumbs().every((c) => c.kind === 'damage'),
    'ten later events evict the launch, because ten later events means the launch went fine'
  )
})

// =========================================================================================
// 2. THE DEDUPE — the acceptance criterion, stated as a test
// =========================================================================================

/** A thrown Error with a real V8-shaped stack under the bundle root. */
function thrown(message: string, fn = 'foldEvent', line = 120): Error {
  const err = new TypeError(message)
  err.stack = [
    `TypeError: ${message}`,
    `    at ${fn} (C:\\Users\\jmoye\\eqc\\out\\main\\pipeline.js:${String(line)}:15)`,
    '    at LogBus.emit (C:\\Users\\jmoye\\eqc\\out\\main\\log\\bus.js:78:20)'
  ].join('\n')
  return err
}

test('THE SAME ERROR TWICE IN ONE SESSION IS ONE EXEMPLAR AND TWO COUNTS', () => {
  fresh()
  noteError('main:uncaughtException', thrown('x is not a function'))
  noteError('main:uncaughtException', thrown('x is not a function'))

  const held = peekErrorReports()
  assert.equal(held.length, 1, 'one fingerprint')
  assert.equal(held[0].n, 2, 'two occurrences')

  const drained = takeErrorReports()
  assert.equal(drained.length, 1, 'ONE exemplar leaves the client, not two')
  assert.equal(drained[0].count, 2)
  assert.equal(validateTelemetryEvent(drained[0]).ok, true, 'and it is a legal event')
})

test('the drain is a DELTA: a second drain with nothing new reports nothing', () => {
  fresh()
  noteError('main:uncaughtException', thrown('boom'))
  assert.equal(takeErrorReports().length, 1)
  assert.equal(takeErrorReports().length, 0, 'a heartbeat with nothing to say says nothing')

  // …and a recurrence AFTER a drain re-sends the same exemplar with the NEW count only. The
  // server's UPSERT is first-wins on the exemplar, so re-sending it is free and idempotent.
  noteError('main:uncaughtException', thrown('boom'))
  noteError('main:uncaughtException', thrown('boom'))
  const again = takeErrorReports()
  assert.equal(again.length, 1)
  assert.equal(again[0].count, 2, 'the count is since the last drain, never a running total')
})

test('different errors are different issues', () => {
  fresh()
  noteError('main:uncaughtException', thrown('a', 'foldEvent', 120))
  noteError('main:uncaughtException', thrown('b', 'otherFn', 400))
  const drained = takeErrorReports()
  assert.equal(drained.length, 2)
  assert.notEqual(drained[0].fingerprint, drained[1].fingerprint)

  // …but the MESSAGE alone does not split an issue. A message carries the varying part, so
  // folding it into the fingerprint would shatter one bug into a hundred singletons — which is
  // the failure mode that makes an error dashboard useless.
  fresh()
  noteError('main:uncaughtException', thrown("open 'C:\\a\\1.json'"))
  noteError('main:uncaughtException', thrown("open 'C:\\b\\2.json'"))
  assert.equal(takeErrorReports().length, 1, 'same name, same frames, one issue')
})

test('THE STORM BOUND: a session cannot mint unbounded distinct exemplars', () => {
  fresh()
  for (let i = 0; i < MAX_SESSION_FINGERPRINTS + 5; i++) {
    noteError('main:uncaughtException', thrown('x', `fn${String(i)}`, i + 1))
  }
  assert.equal(peekErrorReports().length, MAX_SESSION_FINGERPRINTS)
  // …and repeats of an issue ALREADY held still count. The cap limits distinct exemplars, never
  // the totals of what is being tracked.
  noteError('main:uncaughtException', thrown('x', 'fn0', 1))
  const held = peekErrorReports().find((h) => h.n === 2)
  assert.ok(held, 'a repeat of a tracked fingerprint still increments')
})

// =========================================================================================
// 3. WHAT A REPORT ACTUALLY CARRIES
// =========================================================================================

test('a captured error is a legal event carrying frames, crumbs, view, age and mode', () => {
  fresh(1_000_000)
  resetBreadcrumbs()
  noteEventKind('zone', 500)
  noteEventKind('damage', 1_000)
  noteCurrentView('combat')
  noteReplaying(true)

  const err = thrown('cannot read length of undefined')
  ;(err as unknown as { code?: string }).code = 'ERR_INVALID_ARG'
  // 40 minutes into the session — bucket 3 of SESSION_AGE_MS_EDGES (1m/5m/30m/2h).
  noteError('renderer:ErrorBoundary', err, 1_000_000 + 40 * 60_000)

  const [ev] = takeErrorReports()
  const res = validateTelemetryEvent(ev)
  assert.equal(res.ok, true, res.ok ? '' : res.message)
  assert.equal(ev.errorName, 'TypeError')
  assert.equal(ev.code, 'ERR_INVALID_ARG')
  assert.equal(ev.view, 'combat')
  assert.equal(ev.mode, 'replay')
  assert.equal(ev.sessionAgeBucket, 3)
  assert.equal(ev.sessionAgeBucket <= SESSION_AGE_MS_EDGES.length, true)
  assert.deepEqual(ev.breadcrumbs, [
    { kind: 'damage', offsetMs: 0 },
    { kind: 'zone', offsetMs: 500 }
  ])
  // THE FRAMES ARE BUNDLE-RELATIVE. The account name in the stack does not survive.
  assert.deepEqual(
    ev.frames.map((f) => f.file),
    ['out/main/pipeline.js', 'out/main/log/bus.js']
  )
  assert.equal(JSON.stringify(ev).includes('jmoye'), false, 'no account name anywhere in it')
  noteReplaying(false)
})

test('THE BRIGHT LINE: a thrown LOG LINE reaches the wire with no gameplay in it', () => {
  fresh()
  // The plausible accident: a parser that throws with the line it choked on. This is the exact
  // shape `tests/e2e/telemetry.e2e.mts` asserts against a log-line-bearing fixture.
  const line = "[Sat Aug 01 13:00:28 2026] Kahaptra Z`Taj hits Primitive for 412 points of damage."
  noteError('main:uncaughtException', thrown(`parseDamage failed on ${line}`))
  const [ev] = takeErrorReports()
  assert.equal(validateTelemetryEvent(ev).ok, true)
  const wire = JSON.stringify(ev)
  for (const leak of ['Kahaptra', 'Primitive', '412', 'points of damage', 'Aug 01']) {
    assert.equal(wire.includes(leak), false, `${leak} survived into: ${ev.redactedMessage}`)
  }
  assert.match(ev.redactedMessage, /^parseDamage failed on <logline>$/)
})

test('a view the enum does not carry is `unknown`, never a guess', () => {
  fresh()
  // A well-formed view id the schema has never heard of. It used to be `character`, which was a
  // REAL one held out of the enum while the tab was UNRELEASED (JOS-45) — JOS-327 released it, both
  // halves at once, so the case now needs a name no build can produce. The claim is unchanged and
  // the reason it matters is unchanged: the next surface to land behind a gate will look like this.
  noteCurrentView('nosuchview')
  noteError('renderer:onerror', thrown('boom'))
  assert.equal(takeErrorReports()[0].view, 'unknown')

  fresh()
  noteCurrentView({ evil: true })
  noteCurrentView('Plane of Sky')
  noteError('renderer:onerror', thrown('boom'))
  assert.equal(takeErrorReports()[0].view, 'unknown', 'untrusted input never sticks')
})

test('the producer is TOTAL: anything at all can be thrown at it', () => {
  fresh()
  for (const junk of [undefined, null, 42, 'a bare string', {}, [], new Error()]) {
    noteError('main:unhandledRejection', junk)
  }
  for (const ev of takeErrorReports()) {
    assert.equal(validateTelemetryEvent(ev).ok, true, `${JSON.stringify(ev)} must be legal`)
  }
})

test('a failure INSIDE the error logger does not mint a report about the error logger', () => {
  // `logError` tags its own last-resort line `[errorLog]`. Reporting on that source would be a
  // report about the path that is already failing to write, produced by the writer that failed.
  fresh()
  noteError('errorLog', thrown('failed to write errors.log'))
  assert.deepEqual(peekErrorReports(), [])
})

// =========================================================================================
// 4. THE FRAMELESS CASE (JOS-111) — the two loudest live issues had no in-bundle stack
// =========================================================================================

/** What `errorLog.ts` hands over as the capture-site thunk, with a stack we can state. `logError`
 *  uses `Error.captureStackTrace(holder, logError)` so the top frame really is the caller; here
 *  the caller is spelled out, which is the same thing without a bundle to build. */
const site = (fn: string, line: number) => (): string =>
  [
    '[object Object]',
    `    at ${fn} (C:\\Users\\jmoye\\eqc\\out\\main\\index.js:${String(line)}:9)`,
    '    at EventEmitter.emit (node:events:518:28)'
  ].join('\n')

/** The console forwarder's payload, verbatim: no stack, no name, and never had either. */
const forwarded = (message: string) => ({ level: 3, message, source: 'index.html:1' })

test('TWO FRAMELESS ERRORS FROM DIFFERENT PLACES ARE TWO ISSUES, not one', () => {
  // THE HEADLINE DEFECT. Before JOS-111 both of these hashed `Error` and nothing else, so every
  // frameless failure in the app — a forwarded console error, a failed load, a rejected string —
  // collapsed into ONE row that could only be read by squinting at its one stored message.
  fresh()
  noteError('renderer:console', forwarded('Failed to load resource'), 1, site('forwardConsole', 5178))
  noteError('main:did-fail-load', { errorCode: -105, isMainFrame: true }, 1, site('onDidFailLoad', 5310))
  const drained = takeErrorReports()
  assert.equal(drained.length, 2, 'two capture sites are two issues')
  assert.notEqual(drained[0].fingerprint, drained[1].fingerprint)
  for (const ev of drained) {
    assert.equal(validateTelemetryEvent(ev).ok, true)
    assert.equal(ev.frameOrigin, 'capture', 'and each says the frames are the CATCH site')
    assert.deepEqual(ev.frames.map((f) => f.file), ['out/main/index.js'])
  }
  assert.equal(JSON.stringify(drained).includes('jmoye'), false, 'no account name anywhere in it')
})

test('a report WITH frames keeps the fingerprint it has always had', () => {
  // The property that lets this ship without re-minting every issue in the store: a fingerprint
  // change is indistinguishable, from the outside, from an old bug ending and a new one starting.
  fresh()
  noteError('main:uncaughtException', thrown('boom'), 1, site('shouldNotBeUsed', 1))
  const [ev] = takeErrorReports()
  assert.equal(ev.frameOrigin, 'thrown', 'the capture site is not consulted when there is a stack')
  assert.equal(
    ev.fingerprint,
    errorFingerprint('TypeError', [
      { file: 'out/main/pipeline.js', line: 120, col: 15, func: 'foldEvent' },
      { file: 'out/main/log/bus.js', line: 78, col: 20, func: 'LogBus.emit' }
    ]),
    'name + top frames, exactly as before this ticket'
  )
})

test('a NESTED error is unwrapped: `{ preloadPath, error }` reports the real stack', () => {
  // The `main:preload-error` shape, verbatim. The outer object has no message, no name and no
  // stack; the whole error is one property down, and the old read gave up at the top level.
  fresh()
  const inner = thrown('preload blew up')
  noteError('main:preload-error', { preloadPath: 'C:\\Users\\jmoye\\eqc\\out\\preload\\index.js', error: inner })
  const [ev] = takeErrorReports()
  assert.equal(ev.errorName, 'TypeError', 'the inner error names it')
  assert.equal(ev.frameOrigin, 'thrown', 'a real stack, not a capture site')
  assert.deepEqual(ev.frames.map((f) => f.file), ['out/main/pipeline.js', 'out/main/log/bus.js'])
  assert.equal(validateTelemetryEvent(ev).ok, true)
  assert.equal(JSON.stringify(ev).includes('jmoye'), false, 'and the wrapper path does not ride')
})

test('EXTERNAL frames ride along, and they are what the fingerprint falls back on', () => {
  fresh()
  const enoent = new Error('ENOENT: no such file or directory, open <path>')
  ;(enoent as unknown as { code: string }).code = 'ENOENT'
  enoent.stack = [
    'Error: ENOENT',
    '    at Object.readFileSync (node:fs:452:20)',
    '    at FSWatcher._handle (C:\\Users\\jmoye\\eqc\\node_modules\\chokidar\\lib\\handler.js:88:9)'
  ].join('\n')
  const other = new Error('ENOENT: no such file or directory, open <path>')
  other.stack = 'Error: ENOENT\n    at Object.statSync (node:fs:1600:3)'

  noteError('main:uncaughtException', enoent)
  noteError('main:uncaughtException', other)
  const drained = takeErrorReports()
  assert.equal(drained.length, 2, 'same name, same message, different module — two issues')
  const [first] = drained
  assert.equal(validateTelemetryEvent(first).ok, true)
  assert.deepEqual(first.frames, [], 'nothing of ours in the stack')
  assert.deepEqual(
    (first.externalFrames ?? []).map((f) => f.file),
    ['node:fs', 'node_modules/chokidar']
  )
  assert.equal('frameOrigin' in first, false, 'no frames means nothing to say about their origin')
  assert.equal(first.code, 'ENOENT')
  assert.equal(JSON.stringify(drained).includes('jmoye'), false)
})

test('with no location at all, the MESSAGE SHAPE is what stops the collision', () => {
  fresh()
  noteError('renderer:unhandledrejection', { message: 'the network went away' })
  noteError('renderer:unhandledrejection', { message: 'the disk went away' })
  // …and two occurrences of the SAME failure are still one issue, because the skeleton is coarse.
  noteError('renderer:unhandledrejection', { message: 'the network went away' })
  const drained = takeErrorReports()
  assert.equal(drained.length, 2, 'two shapes, two issues')
  assert.equal(drained.reduce((n, ev) => n + ev.count, 0), 3)
  for (const ev of drained) {
    assert.equal(validateTelemetryEvent(ev).ok, true)
    assert.deepEqual(ev.frames, [])
    // THE SKELETON ITSELF IS NEVER SENT — it lives inside the hash and nowhere else.
    assert.equal(Object.keys(ev).includes('skeleton'), false)
  }
})

test('a React componentStack rides as a bounded componentPath, on BOTH carriers', () => {
  const componentStack =
    '\n    at Tooltip (http://localhost:5173/src/Tooltip.tsx:5:11)\n    at div\n    at InventoryRow'

  // 1. THE IPC REPORT (`error:report`), where the boundary appends the marked stack to `stack`.
  fresh()
  const err = thrown('cannot read anchorEl of null')
  err.stack = `${err.stack ?? ''}\n\nComponent stack:${componentStack}`
  noteError('renderer:ErrorBoundary', err)
  const [viaIpc] = takeErrorReports()
  assert.equal(viaIpc.componentPath, 'Tooltip>InventoryRow')
  assert.equal(validateTelemetryEvent(viaIpc).ok, true)

  // 2. THE CONSOLE FORWARDER, whose payload has no `stack` field at all — the whole console line
  //    arrives as `message`, so the same marker has to be read from there or that path silently
  //    does not work.
  fresh()
  noteError(
    'renderer:console',
    forwarded(`[everquest-companion] ErrorBoundary caught: TypeError\n\nComponent stack:${componentStack}`),
    1,
    site('forwardConsole', 5178)
  )
  const [viaConsole] = takeErrorReports()
  assert.equal(viaConsole.componentPath, 'Tooltip>InventoryRow')
  assert.equal(validateTelemetryEvent(viaConsole).ok, true)
  // …and the localhost URL in the component stack is not a frame and is not in the message.
  assert.equal(JSON.stringify(viaConsole).includes('localhost'), false)
})

test('resetting a session drops the pending reports AND the crumbs behind them', () => {
  fresh()
  noteEventKind('damage', 1)
  noteError('main:uncaughtException', thrown('boom'))
  assert.equal(peekErrorReports().length, 1)
  // This is what `endSession` does when the user turns the switch off: counted-but-unreported
  // errors must not be waiting to ride the next report if it is turned back on.
  resetErrorReports(0)
  assert.deepEqual(peekErrorReports(), [])
  assert.deepEqual(readBreadcrumbs(), [])
})
