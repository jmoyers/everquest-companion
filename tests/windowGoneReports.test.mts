// ============================================================================
// windowGoneReports.test.mts — JOS-418: no capture site ships a blank report.
// ============================================================================
//
// THE BUG THIS PINS AGAINST is a family, not an incident. Three fingerprints in the live error
// store — 348550db (21× on 1.5.0 + 14× on 1.4.0), bc8e5df6 (the SAME site at the 1.1.0/1.2.0
// bundle lines) and 75c31a27 (9× on 1.5.0) — carried the literal text `Error: ` and nothing else,
// because their capture sites handed `logError` a bare Electron details object. `caughtFields`
// reads `name`, `message`, `stack` and `code` off a payload; `{ reason, exitCode }` has none of
// them, so every fact the app had just been told went unread.
//
// It drives three real leaf modules — `src/main/windowGone.ts`, `src/shared/errorReportLocation.ts`
// and `src/main/telemetry/errorReports.ts` — none of which imports Electron, so this suite NEVER
// SKIPS. The child-process-gone half of the same ticket is pinned in `setupSnapshot.test.mts`,
// beside the counters it shares an event with.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DID_FAIL_LOAD_ERROR_NAME,
  RENDER_GONE_ERROR_NAME,
  didFailLoadMessage,
  numericOr,
  renderGoneReport
} from '../src/main/windowGone'
import { GPU_LOSS_ERROR_NAME } from '../src/main/childProcessGone'
import { NO_MESSAGE, stampedMessage } from '../src/shared/errorReportLocation'
import {
  MAX_REDACTED_MESSAGE,
  errorFingerprint,
  errorNameOf,
  redactMessage
} from '../src/shared/errorReport'
import { REDACTED_MESSAGE_RE } from '../src/shared/telemetry'
import { noteError, resetErrorReports, takeErrorReports } from '../src/main/telemetry/errorReports'
import { validateTelemetryEvent } from '../src/shared/telemetryValidate'

// =========================================================================================
// 1. THE TWO webContents SITES
// =========================================================================================

test('A DEAD RENDERER STATES WHAT IT KNOWS — and never a blank message', () => {
  const real = renderGoneReport({ reason: 'crashed', exitCode: 3_221_225_477 })
  assert.equal(real.name, RENDER_GONE_ERROR_NAME, 'the name is what gives it its own row')
  assert.equal(real.message, 'render process gone: reason=crashed, exitCode=3221225477')
  // The ten-digit access-violation code, whole, in the field that survives the redactor.
  assert.equal(real.code, 3_221_225_477)

  // Every degenerate payload Electron could hand this handler, and none of them is blank.
  for (const details of [undefined, null, {}, 42, 'crashed', { reason: 7, exitCode: 'x' }]) {
    const r = renderGoneReport(details)
    assert.notEqual(r.message.trim(), '', `blank for ${JSON.stringify(details)}`)
    assert.equal(r.name, RENDER_GONE_ERROR_NAME)
  }
  assert.equal(renderGoneReport({}).message, 'render process gone: reason=unknown, exitCode=-1')
})

test('THE SHAPE GATE: a reason that is not one of Chromium’s words does not ride', () => {
  // The bright line, held by shape rather than by trusting the source. Anything that could spell a
  // path, a character name or a line of the game's log is refused ENTIRELY, not trimmed.
  const nasty = renderGoneReport({
    reason: "C:\\Users\\jmoye\\Logs\\eqlog_Primitive_freeport.txt says 'a rat'",
    exitCode: 1
  })
  assert.equal(nasty.message, 'render process gone: reason=unknown, exitCode=1')
  assert.equal(nasty.message.includes('Primitive'), false)
  assert.equal(nasty.message.includes('rat'), false)
  // …and a plausible-but-new lower-kebab word from a future Electron still reads through, which is
  // why this is a pattern and not a frozen list.
  assert.equal(
    renderGoneReport({ reason: 'memory-eviction', exitCode: 0 }).message,
    'render process gone: reason=memory-eviction, exitCode=0'
  )
})

test('A FAILED LOAD names the net error, and leaves the URL out of the message', () => {
  assert.equal(
    didFailLoadMessage('ERR_FILE_NOT_FOUND', -6, true),
    'load failed: ERR_FILE_NOT_FOUND (errorCode=-6, mainFrame=true)'
  )
  assert.equal(
    didFailLoadMessage(undefined, undefined, undefined),
    'load failed: unknown (errorCode=-1, mainFrame=false)'
  )
  // The URL is a `file:///C:/Users/<the user's name>/…` in a packaged install. It stays in the
  // payload for `errors.log`; it is not in the sentence the fleet receives.
  const msg = didFailLoadMessage('ERR_FILE_NOT_FOUND', -6, true)
  assert.equal(msg.includes('file:'), false)
  assert.equal(msg.includes('Users'), false)
})

test('EVERY NEW ERROR NAME SURVIVES errorNameOf — otherwise the row it earns is not its own', () => {
  // `errorNameOf` folds anything that is not identifier-shaped back to `Error`. A name it refused
  // would degrade in silence, putting the diagnosis straight back into the undifferentiated row
  // this whole ticket exists to get it out of.
  for (const name of [RENDER_GONE_ERROR_NAME, DID_FAIL_LOAD_ERROR_NAME, GPU_LOSS_ERROR_NAME]) {
    assert.equal(errorNameOf(name), name, name)
  }
})

test('numericOr refuses NaN and Infinity, which would print as words in a message', () => {
  assert.equal(numericOr(0), 0)
  assert.equal(numericOr(NaN), -1)
  assert.equal(numericOr(Infinity), -1)
  assert.equal(numericOr(undefined), -1)
})

// =========================================================================================
// 2. THE BELT — what a report says when the site said nothing
// =========================================================================================

test('AN EMPTY MESSAGE IS STAMPED WITH THE CAPTURE SITE, never sent blank', () => {
  assert.equal(stampedMessage('', 'main:render-process-gone'), `${NO_MESSAGE} [main:render-process-gone]`)
  // Whitespace is empty. `redactMessage` already trims, but the belt must not depend on that.
  assert.equal(stampedMessage('   ', 'renderer:ErrorBoundary'), `${NO_MESSAGE} [renderer:ErrorBoundary]`)
  // A message that says anything at all is returned untouched — the belt is a last resort and
  // must never edit a real message.
  assert.equal(stampedMessage('x is not a function', 'main:uncaughtException'), 'x is not a function')
})

test('THE TAG IS HELD TO A SHAPE, because one logError source is renderer-supplied', () => {
  // `ipc/windowControls.ts` builds `renderer:${report.source}` out of the `error:report` IPC, so
  // "every call site passes a literal" is FALSE and the shape is the actual control.
  const hostile = [
    "renderer:C:\\Users\\jmoye\\Logs\\eqlog_Primitive.txt",
    'renderer:a rat says hello',
    "renderer:'Primitive'",
    'renderer:[Sat Aug 01 13:00:28 2026] You slash a rat',
    'no-colon-at-all',
    `renderer:${'x'.repeat(200)}`,
    42,
    null,
    undefined
  ]
  for (const source of hostile) {
    assert.equal(stampedMessage('', source), NO_MESSAGE, `let through: ${String(source)}`)
  }
  // The real tags in this app all pass.
  for (const source of [
    'main:uncaughtException',
    'main:unhandledRejection',
    'main:gpu-process-gone',
    'main:render-process-gone',
    'main:did-fail-load',
    'main:preload-error',
    'main:stopTelemetry',
    'renderer:ErrorBoundary',
    'renderer:console',
    'cursorRing:preload-error',
    'trayNotice:preload-error'
  ]) {
    assert.equal(stampedMessage('', source), `${NO_MESSAGE} [${source}]`, source)
  }
})

test('EVERY STAMP IS A FIXED POINT OF redactMessage — the server re-runs it and refuses drift', () => {
  // `telemetryValidateError.ts` re-redacts the message a client sent and rejects the whole report
  // if the output differs. A stamp applied AFTER the redaction has to survive that, or the belt
  // would silently delete the reports it was built to rescue.
  for (const source of [
    'main:render-process-gone',
    'renderer:ErrorBoundary',
    'trayNotice:preload-error',
    'nope not a tag'
  ]) {
    const stamp = stampedMessage('', source)
    assert.equal(redactMessage(stamp), stamp, `not a fixed point: ${stamp}`)
    assert.equal(REDACTED_MESSAGE_RE.test(stamp), true, `wire refuses: ${stamp}`)
    assert.ok(stamp.length <= MAX_REDACTED_MESSAGE)
  }
})

// =========================================================================================
// 3. END TO END, through the real producer
// =========================================================================================

/** A stack with two bundle frames, so `locate` reports `thrown` and the fingerprint has frames. */
function withFrames(message: string): Record<string, unknown> {
  return {
    message,
    stack: [
      `Error: ${message}`,
      '    at WebContents.<anonymous> (C:\\Users\\jmoye\\eqc\\out\\main\\index.js:10455:5)'
    ].join('\n')
  }
}

test('THE OLD BLANK FAMILY BECOMES A NAMED ONE, and the belt catches whatever is left', () => {
  resetErrorReports(1_000_000)
  // What 1.5.0 actually sent from `main:render-process-gone`: an object with no message on it.
  noteError('main:render-process-gone', withFrames(''), 1_000_100)
  const [blank] = takeErrorReports()
  assert.equal(blank.redactedMessage, `${NO_MESSAGE} [main:render-process-gone]`)
  assert.equal(validateTelemetryEvent(blank).ok, true, 'the stamp must survive the wire')

  // What it sends now.
  resetErrorReports(1_000_000)
  const report = renderGoneReport({ reason: 'oom', exitCode: 5 })
  noteError('main:render-process-gone', { ...withFrames(report.message), ...report }, 1_000_100)
  const [named] = takeErrorReports()
  assert.equal(named.errorName, RENDER_GONE_ERROR_NAME)
  assert.equal(named.redactedMessage, 'render process gone: reason=oom, exitCode=5')
  assert.equal(named.code, '5', 'the exit code rides in the machine-readable field too')
  assert.equal(validateTelemetryEvent(named).ok, true)
  // And nothing from the game came along for the ride.
  const json = JSON.stringify(named)
  for (const leak of ['Users', 'jmoye', 'Primitive', 'freeport']) {
    assert.equal(json.includes(leak), false, `leaked ${leak}`)
  }
})

test('THE BELT CANNOT MOVE A FINGERPRINT THAT ALREADY HAS FRAMES', () => {
  // The provable half of the design: `errorFingerprint` reads its `fallback` ONLY when `frames` is
  // empty, and every report in this app has frames (`errorLog` hands over a capture site precisely
  // so the frameless ones are not all one row). So a family the error store already tracks keeps
  // its identity across this change, and only its MESSAGE improves.
  resetErrorReports(1_000_000)
  noteError('main:render-process-gone', withFrames(''), 1_000_100)
  const [stamped] = takeErrorReports()
  const frames = [{ file: 'out/main/index.js', line: 10_455, col: 5, func: 'WebContents.<anonymous>' }]
  assert.equal(
    stamped.fingerprint,
    errorFingerprint('Error', frames),
    'the fingerprint is the name and the frames — the stamped message is not in it'
  )
})

test('two BLANK frameless reports from different sites stop being one row', () => {
  // The other half, and the one case where the belt DOES move a fingerprint — on purpose. With no
  // frames of any kind, `fingerprintFallback` folds the message skeleton, and before this ticket
  // both of these hashed `Error` plus the empty string: one row for every silent failure in the
  // app. That is the JOS-111 collapse, in the corner JOS-111 could not reach because there was no
  // message to make a skeleton out of.
  resetErrorReports(1_000_000)
  noteError('main:did-fail-load', { message: '' }, 1_000_100)
  noteError('main:gpu-process-gone', { message: '' }, 1_000_200)
  const out = takeErrorReports()
  assert.equal(out.length, 2, 'two silent sites are two issues')
  assert.notEqual(out[0].fingerprint, out[1].fingerprint)
  for (const ev of out) assert.equal(validateTelemetryEvent(ev).ok, true)
})
