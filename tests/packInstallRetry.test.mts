// ============================================================================
// packInstallRetry.test.mts — the `install <str> failed` family, answered (JOS-307).
// ============================================================================
//
// THE READING THIS SUITE EXISTS FOR, taken from the fleet's own error store rather than imagined
// (`triage-feedback.mts errors list --days 30 --cohort all`, 2026-08-14):
//
//   6e42033dce2bdd33  0.25.0  x26   Error: install <str> failed
//   ed2cfb95cdc785ab  0.26.0  x21   Error: install <str> failed
//   a44e783b19836df5  0.21.0  x10   …and the same sentence on six further builds
//
// Sixty-odd occurrences across eight versions, and not one of them says WHAT WENT WRONG. The cause
// was thrown away by a rule that is right in general: `caughtFields` gives the OUTER layer every
// field it has, and the outer layer here was `{ message: "install '<name>' failed", err }`. So a
// 404 on a deleted tag, a 429, a truncated tarball and a pack with no audio in it all arrive in the
// store as the same six words.
//
// The exemplars' one in-bundle frame is `ClientRequest.<anonymous>` under `parserOnIncomingClient`
// — the RESPONSE callback of `packRegistry.ts httpGetBuffer`. These are ANSWERS, and an answer has
// a number. Everything below drives the real rule that now reads it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAX_INSTALL_ATTEMPTS,
  MAX_INSTALL_MESSAGE_CHARS,
  classifyPackInstallFailure,
  describePackInstallFailure,
  isTransientPackInstallFailure,
  packInstallFailureLine,
  packInstallHttpStatus,
  packInstallRetryDelayMs
} from '../src/shared/packInstall'
import {
  MAX_WARNED_PACK_CODES,
  PACK_INSTALL_SOURCE,
  logPackInstallFailure,
  resetPackInstallWarnings,
  type PackInstallLogSinks
} from '../src/main/packInstallLog'
import { caughtFields } from '../src/shared/errorReportLocation'
import { redactMessage } from '../src/shared/errorReport'

const TEST_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string): string => readFileSync(join(TEST_ROOT, p), 'utf8')

const TARBALL = 'https://github.com/peonping/alan-rickman/archive/refs/tags/v1.0.1.tar.gz'

/** EXACTLY what `httpGetBuffer` throws now — the sentence AND the property. */
function statusError(status: number): Error {
  return Object.assign(new Error(`GET ${TARBALL} → ${status}`), { statusCode: status })
}
/** The same failure after a round trip through a log line: the property is gone, the words remain. */
function stringifiedStatusError(status: number): Error {
  return new Error(`GET ${TARBALL} → ${status}`)
}
/** Node's errno shape, for the socket that never connected. */
function offlineError(code: string): Error {
  return Object.assign(new Error(`getaddrinfo ${code} github.com`), { code })
}

/** Recording sinks in `logError`/`logWarn`'s exact shapes. */
interface Recorder extends PackInstallLogSinks {
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

// ------------------------------------------------------------------------------- the classifier

test('AN ANSWER HAS A NUMBER, and both spellings of it are readable', () => {
  for (const status of [403, 404, 408, 429, 500, 502, 503]) {
    assert.equal(packInstallHttpStatus(statusError(status)), status, `property: ${String(status)}`)
    assert.equal(packInstallHttpStatus(stringifiedStatusError(status)), status, `text: ${String(status)}`)
    // 429 is an answer with a number like any other — and its own KIND (JOS-420), because it is
    // the only status that is a statement about the clock rather than about the pack.
    assert.equal(
      classifyPackInstallFailure(statusError(status)),
      status === 429 ? 'rate-limited' : 'http',
      String(status)
    )
  }
  // …and it reads the same when the properties were lost in a log line.
  assert.equal(classifyPackInstallFailure(stringifiedStatusError(429)), 'rate-limited')
  // builder-util-runtime's spelling reads too, so one function covers both downloaders.
  assert.equal(packInstallHttpStatus(new Error('HttpError: HTTP_ERROR_429 rate limited')), 429)
  // A redirect is not a failure status, and a number that is not a status is not one either.
  assert.equal(packInstallHttpStatus(stringifiedStatusError(302)), null)
  assert.equal(packInstallHttpStatus(new Error('wrote 404 files')), null)
  assert.equal(packInstallHttpStatus(null), null)
})

test('OUR OWN REFUSALS are their own kind, and are asked FIRST', () => {
  // Every sentence below is a literal thrown by packRegistry.ts. They are the only messages in this
  // classifier whose words we wrote, so nothing else may claim them.
  for (const text of [
    'pack name is not a valid identifier',
    'pack source fields are not valid',
    "'my-sounds' is reserved for your imported sounds",
    'archive contained no files',
    'unsafe archive path: repo-1.0.1/../evil.wav',
    'pack has no openpeon.json',
    'pack contained no audio files',
    'openpeon.json is not valid JSON',
    'no sounds after conversion',
    'download exceeded size cap',
    `too many redirects (${TARBALL})`
  ]) {
    assert.equal(classifyPackInstallFailure(new Error(text)), 'rejected', text)
    assert.equal(isTransientPackInstallFailure(new Error(text)), false, text)
  }
  // AND THE LIST IS REAL: each entry has to still appear in the file that throws it, or the
  // classification silently degrades to 'other' the next time somebody rewords one.
  const src = read('src/main/packRegistry.ts')
  for (const text of [
    'pack name is not a valid identifier',
    'archive contained no files',
    'pack has no openpeon.json',
    'no sounds after conversion',
    'download exceeded size cap'
  ]) {
    assert.ok(src.includes(text), `packRegistry.ts no longer throws: ${text}`)
  }
})

test('a BROKEN DOWNLOAD is its own kind — zlib and the dead socket both', () => {
  for (const text of [
    'incorrect header check',
    'unexpected end of file',
    'invalid distance too far back',
    'socket hang up',
    'aborted',
    'Premature close'
  ]) {
    assert.equal(classifyPackInstallFailure(new Error(text)), 'truncated', text)
  }
  assert.equal(classifyPackInstallFailure(offlineError('ENOTFOUND')), 'unreachable')
  assert.equal(classifyPackInstallFailure(new Error('something nobody has seen yet')), 'other')
  assert.equal(classifyPackInstallFailure(null), 'other')
})

// -------------------------------------------------------------------------------- what is retried

test('THE DEFAULT IS NO, and the exceptions are the ones a retry could fix', () => {
  // A 4xx is an ANSWER ABOUT THE PACK — 404 means the tag is gone, 403 means the repo went private
  // — and a second identical request gets a second identical answer while spending a stranger's
  // bandwidth again. The two exceptions are the 4xx that are about TIMING, not the resource.
  assert.equal(isTransientPackInstallFailure(statusError(404)), false)
  assert.equal(isTransientPackInstallFailure(statusError(403)), false)
  assert.equal(isTransientPackInstallFailure(statusError(451)), false)
  assert.equal(isTransientPackInstallFailure(statusError(408)), true)
  assert.equal(isTransientPackInstallFailure(statusError(429)), true)
  for (const status of [500, 502, 503, 504]) {
    assert.equal(isTransientPackInstallFailure(statusError(status)), true, String(status))
  }
  assert.equal(isTransientPackInstallFailure(offlineError('ECONNRESET')), true)
  assert.equal(isTransientPackInstallFailure(new Error('incorrect header check')), true)
  // AND AN UNKNOWN FAILURE IS NOT RETRIED. This is the OPPOSITE direction from the update
  // classifier's, on purpose: report what you do not understand, but do not re-request it.
  assert.equal(isTransientPackInstallFailure(new Error('something nobody has seen yet')), false)
  assert.equal(isTransientPackInstallFailure(null), false)
})

test('the retry budget is bounded and backs off', () => {
  assert.equal(MAX_INSTALL_ATTEMPTS, 3)
  const delays = [1, 2, 3].map((n) => packInstallRetryDelayMs(n))
  assert.ok(delays[0] < delays[1] && delays[1] < delays[2], 'exponential')
  assert.ok(delays[0] > 0)
  // A person is watching the registry browser's install: the whole retry budget has to fit inside
  // the patience of somebody who just clicked a button.
  assert.ok(delays[0] + delays[1] < 10_000, `${delays[0] + delays[1]}ms of waiting is too long`)
})

// ------------------------------------------------------------------------------- what is written

test('THE STORE ROW FINALLY SAYS WHY', () => {
  // The whole ticket, in one assertion pair: the old row said `install <str> failed` and stopped.
  const line = packInstallFailureLine('alan-rickman', 3, 3, statusError(404))
  assert.match(line, /^install 'alan-rickman' failed \(attempt 3\/3, http 404\): GET https:\/\//)
  assert.match(line, /→ 404$/)
  // Our own refusal names itself rather than a status it does not have.
  assert.match(
    packInstallFailureLine('alan-rickman', 1, 3, new Error('pack has no openpeon.json')),
    /\(attempt 1\/3, rejected\): pack has no openpeon\.json$/
  )
  // ONE bounded line, whatever the error carries — a stack must not become a paragraph in a row.
  const fat = new Error(`first line\n${'  at frame\n'.repeat(200)}`)
  assert.equal(packInstallFailureLine('p', 1, 3, fat).split('\n').length, 1)
  const huge = new Error('x'.repeat(5_000))
  assert.ok(describePackInstallFailure(huge).length <= MAX_INSTALL_MESSAGE_CHARS)
  assert.equal(describePackInstallFailure(null), 'unknown error')
  assert.equal(describePackInstallFailure(new Error('  \n ')), 'unknown error')
})

test('THE ROW READS THROUGH THE REAL REPORT PRODUCER', () => {
  // "Legible in the store" is a claim about what `caughtFields` + the redactor make of the payload,
  // not about what the object looks like in a debugger. This is the assertion that would have gone
  // red for every one of those sixty occurrences.
  resetPackInstallWarnings()
  const r = recorder()
  const err = statusError(404)
  logPackInstallFailure({ pack: 'alan-rickman', attempt: 1, attempts: 3, final: true, err }, r)
  const fields = caughtFields(r.filed[0].payload)
  const message = redactMessage(fields.message)
  assert.match(message, /^install <str> failed \(attempt 1\/3, http 404\)/)
  assert.match(message, /404/, 'the status survives the redactor - three digits are diagnostic')
  // The NESTED error still supplies the stack, exactly as if the raw error had been filed bare.
  assert.ok(typeof fields.stack === 'string' && fields.stack.includes('Error'))
  // …and the RAW error is filed by identity: nothing was pre-formatted on the way in.
  assert.equal((r.filed[0].payload as { error?: unknown }).error, err)
  assert.equal(r.filed[0].source, PACK_INSTALL_SOURCE)
  // THE BRIGHT LINE HOLDS: the redactor still collapses our own release URL to a placeholder.
  assert.ok(!redactMessage(fields.message, 400).includes('github.com'))
  resetPackInstallWarnings()
})

test('AN ATTEMPT THAT WILL BE RETRIED IS NOT A FAILURE YET', () => {
  // provisionPacks used to `logError` every attempt, so ONE failed provisioning was THREE store
  // rows, at every startup, forever.
  resetPackInstallWarnings()
  const r = recorder()
  logPackInstallFailure({ pack: 'p', attempt: 1, attempts: 3, final: false, err: statusError(503) }, r)
  logPackInstallFailure({ pack: 'p', attempt: 2, attempts: 3, final: false, err: statusError(503) }, r)
  assert.equal(r.filed.length, 0)
  assert.equal(r.warned.length, 2)
  assert.match(String(r.warned[0][1]), /- retrying$/)
  logPackInstallFailure({ pack: 'p', attempt: 3, attempts: 3, final: true, err: statusError(503) }, r)
  assert.equal(r.filed.length, 1, 'the one that gave up IS filed')
  resetPackInstallWarnings()
})

test('AN ANSWER IS FILED EVERY TIME; SOMEBODY ELSE’S NETWORK IS NOT', () => {
  resetPackInstallWarnings()
  const r = recorder()
  // The thing the ticket is about must always land. Bounding it is errorRepeat/errorBudget's job.
  for (let i = 0; i < 200; i++) {
    logPackInstallFailure({ pack: 'p', attempt: 1, attempts: 3, final: true, err: statusError(404) }, r)
  }
  assert.equal(r.filed.length, 200)
  assert.equal(r.warned.length, 0)
  // …and our own refusal is ours to know about, not the user's network.
  logPackInstallFailure(
    { pack: 'p', attempt: 1, attempts: 3, final: true, err: new Error('pack has no openpeon.json') },
    r
  )
  assert.equal(r.filed.length, 201)
  // An install that can never reach GitHub runs at EVERY startup (provisionDefaultPacks). One line
  // per code per session, console only - JOS-266's rule, applied to the second producer.
  for (let i = 0; i < 5_000; i++) {
    logPackInstallFailure({ pack: 'p', attempt: 3, attempts: 3, final: true, err: offlineError('ENOTFOUND') }, r)
  }
  assert.equal(r.filed.length, 201, 'not one offline report')
  assert.equal(r.warned.length, 1)
  logPackInstallFailure({ pack: 'p', attempt: 3, attempts: 3, final: true, err: offlineError('ECONNREFUSED') }, r)
  assert.equal(r.warned.length, 2, 'a different code is a different story about the machine')
  resetPackInstallWarnings()
})

test('the warn gate is bounded - a pathological machine cannot grow it', () => {
  resetPackInstallWarnings()
  const r = recorder()
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE']) {
    logPackInstallFailure({ pack: 'p', attempt: 1, attempts: 1, final: true, err: offlineError(code) }, r)
  }
  assert.equal(r.warned.length, MAX_WARNED_PACK_CODES)
  assert.equal(r.filed.length, 0)
  resetPackInstallWarnings()
})

// -------------------------------------------------------------------------------------- the wiring

test('THE WIRING: ONE retry loop, and BOTH callers take it', () => {
  // The asymmetry this ticket deletes: startup provisioning retried and the registry browser did
  // not, and they logged differently about the same failure.
  const runner = read('src/main/packInstallRun.ts')
  // The loop itself is the pure one this file drives (JOS-420) — the runner is the I/O around it.
  assert.match(runner, /runPackInstallAttempts\(\{/)
  assert.match(runner, /install: \(\) => installPack\(pack, onProgress/)
  assert.match(runner, /logPackInstallFailure\(/)
  assert.match(runner, /final: info\.final/)

  const ipc = read('src/main/ipc/sounds.ts')
  assert.match(ipc, /await installPackWithRetry\(pack, emit\)/)
  // The old private handling is GONE from the call site — one rule, one place.
  assert.doesNotMatch(ipc, /install '\$\{name\}' failed/)
  assert.doesNotMatch(ipc, /\bimport \{[^}]*\binstallPack\b[^}]*\} from '\.\.\/packRegistry'/s)

  const provision = read('src/main/provisionPacks.ts')
  assert.match(provision, /installPackWithRetry\(pack, swallowProgress, \{ targetRoot: packsRoot \}\)/)
  assert.doesNotMatch(provision, /for \(let attempt = 1; attempt <= MAX_ATTEMPTS/)
  assert.doesNotMatch(provision, /provisioning '\$\{pack\.name\}' failed/)
})

test('THE WIRING: the status rides on the error as a PROPERTY, not just in the words', () => {
  // The construction moved into `shared/packInstall.ts` (JOS-420) — beside the readers, and shared
  // so a second downloader cannot spell it differently — but the fact is the same one: the number
  // is a PROPERTY, and the sentence is the fallback for a copy that lost it.
  assert.match(read('src/main/packRegistry.ts'), /reject\(packInstallHttpError\(url, status/)
  const shared = read('src/shared/packInstall.ts')
  assert.match(shared, /statusCode: status,/)
  assert.match(shared, /new Error\(`GET \$\{url\} → \$\{String\(status\)\}`\)/)
})
