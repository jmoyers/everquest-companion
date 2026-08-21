// ============================================================================
// updaterSignatureBlocked.test.mts — the update that this PC's PowerShell killed (JOS-421).
// ============================================================================
//
// THE READING THIS SUITE EXISTS FOR, and it is the fleet's single biggest error family rather than
// a theory. Fingerprint 72bdb3d77ddbc71d:
//
//   SyntaxError: update download failed (final, parse): Unexpected end of JSON input
//     at parseOut (node_modules/electron-updater/out/windowsExecutableCodeSignatureVerifier.js:104:23)
//     at <anonymous> (…/windowsExecutableCodeSignatureVerifier.js:55:30)
//     at ChildProcess.exithandler (node:child_process:410:7)
//
// ~330 occurrences across EVERY version since 0.28.0, on many installs — plus the cousins
// d877b63662b64f60 / 104857fabb237b44 / 4edfdc6aa1bdd13c / c4d4d4fa63f2ac0c reading
// `update download failed (final, other): Command failed: set <str> & chcp <n> >NUL &
// powershell.exe …`. Both come from ONE call site: electron-updater verifies the downloaded
// installer's Authenticode signature by shelling out to PowerShell, and on a machine whose security
// software guts that call it gets nothing back. `src/shared/update.ts`'s JOS-421 block reads the
// library source and shows why the download then fails HARD rather than falling through.
//
// WHY IT IS ITS OWN SUITE. The first shape's MESSAGE is character-for-character the JOS-211 feed
// failure — the same `SyntaxError` from the same `JSON.parse('')` — so its STACK is the only thing
// that tells the two apart. Pinning that discrimination, in both directions, is what these tests
// are for, and it is a different question from `updateFailureLog.test.mts`'s "where does a failure
// go", which is why it does not live there.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SIGNATURE_BLOCKED_MESSAGE,
  SIGNATURE_BLOCKED_PAUSED_MESSAGE,
  classifyUpdateFailure,
  describeUpdateFailure,
  isSignatureCheckBlocked
} from '../src/shared/update'
import {
  UPDATE_DOWNLOAD_SOURCE,
  logUpdateFailure,
  resetUpdateLogWarnings,
  updateFailureLine,
  type UpdateLogSinks
} from '../src/main/updateLog'

const TEST_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string): string => readFileSync(join(TEST_ROOT, p), 'utf8')

/** Recording sinks, in `logError`/`logWarn`'s exact shapes (updateFailureLog.test.mts's). */
interface Recorder extends UpdateLogSinks {
  readonly filed: { source: string; payload: unknown }[]
  readonly warned: unknown[][]
}
function recorder(): Recorder {
  const filed: { source: string; payload: unknown }[] = []
  const warned: unknown[][] = []
  return {
    filed,
    warned,
    error: (source, payload) => filed.push({ source, payload }),
    warn: (...args) => warned.push(args)
  }
}

/** A REAL `JSON.parse` failure — never a hand-written message, because the whole point is that this
 *  sentence is V8's and is identical on both sides of the discrimination. */
function parseFailure(body: string): Error {
  try {
    JSON.parse(body)
  } catch (e) {
    return e as Error
  }
  throw new Error('the fixture must throw')
}

/** The verifier frames, in the shape the fleet's reports carry (paths shortened). */
const VERIFIER_FRAMES =
  '    at parseOut (C:\\Users\\u\\AppData\\Local\\Programs\\eqc\\resources\\app.asar\\node_modules\\' +
  'electron-updater\\out\\windowsExecutableCodeSignatureVerifier.js:104:23)\n' +
  '    at C:\\a\\node_modules\\electron-updater\\out\\windowsExecutableCodeSignatureVerifier.js:55:30\n' +
  '    at ChildProcess.exithandler (node:child_process:410:7)'

/** SHAPE ONE — PowerShell exited 0 having printed nothing. `ChildProcess.exithandler` is in the
 *  frames because that is the clean-exit callback, which is how we know `error == null && !stderr`
 *  and that `parseOut` really did run over an empty stdout. */
function blockedParseFailure(): Error {
  const err = parseFailure('')
  err.stack = `${err.name}: ${err.message}\n${VERIFIER_FRAMES}`
  return err
}

/** SHAPE TWO — PowerShell exited non-zero, or was killed at the verifier's own 20s timeout.
 *  `child_process` builds `Command failed: <cmd>` and sets `cmd` beside it. */
function blockedCommandFailure(): Error {
  const cmd =
    'set "PSModulePath=" & chcp 65001 >NUL & powershell.exe -NoProfile -NonInteractive ' +
    '-InputFormat None -Command "Get-AuthenticodeSignature -LiteralPath \'C:\\x\\installer.exe\'' +
    ' | ConvertTo-Json -Compress"'
  return Object.assign(new Error(`Command failed: ${cmd}\n`), { cmd, code: 1 })
}

test('A BLOCKED POWERSHELL IS ITS OWN KIND, and it is asked before the parse arm', () => {
  for (const err of [blockedParseFailure(), blockedCommandFailure()]) {
    assert.ok(isSignatureCheckBlocked(err))
    assert.equal(classifyUpdateFailure(err), 'blocked')
    assert.equal(describeUpdateFailure(err), SIGNATURE_BLOCKED_MESSAGE)
  }
  // THE DISCRIMINATION, which is the whole risk: the SAME message, arriving from the feed, is still
  // a feed parse failure and still gets the feed's sentence. Widening either predicate goes red
  // here rather than quietly reclassifying the other family.
  const feed = parseFailure('')
  assert.equal(isSignatureCheckBlocked(feed), false)
  assert.equal(classifyUpdateFailure(feed), 'parse')
  assert.equal(isSignatureCheckBlocked(null), false)
  assert.equal(isSignatureCheckBlocked(new Error('getaddrinfo ENOTFOUND github.com')), false)
  // The line an operator reads names the new class, not `parse` or `other`.
  assert.match(
    updateFailureLine('download', 'final', 'blocked', blockedParseFailure()),
    /^update download failed \(final, blocked\): /
  )
})

test('A BLOCKED POWERSHELL NEVER REACHES THE ERROR STORE — one console line per session', () => {
  resetUpdateLogWarnings()
  const r = recorder()
  // Up to three download attempts per session, every session, on every install with this antivirus.
  for (let i = 0; i < 2_000; i++) logUpdateFailure('download', 'final', blockedParseFailure(), r)
  assert.equal(r.filed.length, 0, '~330 fleet-wide reports becomes none')
  assert.equal(r.warned.length, 1)
  assert.match(String(r.warned[0][1]), /code-signature check \(SIGNATURE_CHECK_BLOCKED\)/)
  assert.match(String(r.warned[0][1]), /security software or policy/)
  // BOTH SHAPES ARE ONE CONDITION, so the cousin family does not buy a second line.
  logUpdateFailure('download', 'final', blockedCommandFailure(), r)
  assert.equal(r.warned.length, 1)
  assert.equal(r.filed.length, 0)
  // A NEW SESSION says it once more — the machine may not be the machine it was.
  resetUpdateLogWarnings()
  logUpdateFailure('download', 'final', blockedCommandFailure(), r)
  assert.equal(r.warned.length, 2)
  // …and the demotion is one kind wide: a real download failure still lands, every time.
  logUpdateFailure('download', 'final', new Error('sha512 checksum mismatch'), r)
  assert.equal(r.filed.length, 1)
  assert.equal(r.filed[0].source, UPDATE_DOWNLOAD_SOURCE)
  resetUpdateLogWarnings()
})

test('THE INSTALLED VERIFIER still fails the way this classification assumes', () => {
  // The source read the whole ticket rests on, checked rather than remembered — and it IS the
  // finding: an empty stdout is not a skipped signature check, it is a HARD download failure, and
  // it is hard precisely because `handleError`'s fallback probe SUCCEEDS on a PowerShell that
  // answers nothing. RESOLVED, not joined: this suite also runs from a worktree with no
  // `node_modules` of its own (AGENTS.md).
  const src = readFileSync(
    createRequire(import.meta.url).resolve(
      'electron-updater/out/windowsExecutableCodeSignatureVerifier.js'
    ),
    'utf8'
  )
  // The command line shape two quotes verbatim.
  assert.ok(src.includes('set "PSModulePath=" & chcp 65001 >NUL & powershell.exe'))
  assert.ok(src.includes('Get-AuthenticodeSignature -LiteralPath'))
  // `parseOut` is `JSON.parse` over stdout, and it runs ONLY on the clean-exit path.
  assert.match(src, /function parseOut\(out\) \{\s*const data = JSON\.parse\(out\);/)
  assert.match(src, /if \(error != null \|\| stderr\) \{\s*handleError/)
  // THE TRAP: the fallback probes PowerShell with a SECOND call and only skips verification when
  // that probe THROWS. A PowerShell that exits 0 silently passes the probe, so `reject(error)` is
  // reached and the download dies. If an upgrade ever reworks this, the demotion should be
  // re-argued — so it goes red here.
  const handleError = src.slice(src.indexOf('function handleError('))
  assert.ok(handleError.indexOf('execFileSync') > 0)
  assert.ok(handleError.indexOf('execFileSync') < handleError.indexOf('reject(error)'))
})

test('THE WIRING: a blocked PowerShell walks no backoff and names its cause', () => {
  const src = read('src/main/updater.ts')
  const handler = src.slice(src.indexOf("autoUpdater.on('error'"), src.indexOf('/**\n * Initialize'))
  // The routing decision is READ BACK — `logUpdateFailure` returns the kind, so there is exactly
  // one classifier and the wiring cannot form a second opinion about the same error.
  assert.match(handler, /const kind = logUpdateFailure\(step, 'final', err, LOG_SINKS\)/)
  // The check itself SUCCEEDED; the failure happened afterwards, in a child process on this PC.
  // Ticking `consecutiveFailures` would back the FEED off for four hours over the antivirus.
  assert.match(
    handler,
    /if \(kind === 'blocked'\) downloadBlocked = true\s*\n\s*else consecutiveFailures\+\+/
  )
  // The bounded telemetry outcome is NOT skipped: a frozen cohort has to stay countable somewhere,
  // and `updateOutcome` is the honest home the demotion leaves the count in (JOS-310's rule).
  assert.ok(handler.indexOf('noteUpdate(step,') > handler.indexOf("if (kind === 'blocked')"))
  // …and the sentence a stuck user sits with once the bounded retries are spent names the cause
  // rather than the symptom.
  const available = src.slice(src.indexOf("autoUpdater.on('update-available'"))
  assert.match(available, /downloadBlocked\s*\n?\s*\? SIGNATURE_BLOCKED_PAUSED_MESSAGE/)
  assert.ok(SIGNATURE_BLOCKED_PAUSED_MESSAGE.length > 0)
  // The flag states something about NOW, so both ways out of the state clear it: a download that
  // landed, and a user who allowed PowerShell and pressed the button.
  assert.ok(src.split('downloadBlocked = false').length - 1 >= 2)
})
