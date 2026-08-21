// ============================================================================
// packInstallRateLimit.test.mts — a 429 is "later", not "broken" (JOS-420).
// ============================================================================
//
// THE READING THIS SUITE EXISTS FOR, from the fleet's own error store (2026-08-19 triage):
//
//   60f5821abd26c594  1.4.0 ×26, 1.5.0 ×1
//   install <pack> failed (attempt 3/3, http 429): GET https://<str> → 429
//
// JOS-307 made that row legible — it names the pack, the attempt and the status, which is why this
// ticket exists at all. What it made legible is a schedule that cannot work: 429 was in the
// transient set from the day it was written, and the schedule it inherited was three attempts at
// 1.5 s and 3 s. Four and a half seconds of "backoff" against a rate limiter whose window is
// minutes, and then a generic install failure for a pack that is perfectly fine.
//
// Two things are wrong in that sentence and this suite is in two halves for exactly that reason:
// the SCHEDULE (its own clock, its own budget, its own horizon) and the WORD "failed" (its own
// kind, its own severity, its own sentence for the person who clicked Install).
//
// Nothing here waits: the loop takes its install, its sleep and its randomness from the caller, so
// a fifteen-minute run is stated in a millisecond and the assertions are on the numbers passed to
// the fake sleep. `tests/packInstallRetry.test.mts` remains the suite for everything a 429 is not.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assetPath, provisionKokoro } from '../src/main/speech/provision'
import type { SpeechInstallProgress } from '../src/shared/alertTypes'
import {
  INSTALL_RETRY_BASE_MS,
  MAX_INSTALL_ATTEMPTS,
  MAX_INSTALL_MESSAGE_CHARS,
  MAX_RATE_LIMITED_ATTEMPTS,
  MIN_RATE_LIMIT_DELAY_MS,
  RATE_LIMITED_MESSAGE,
  RATE_LIMIT_BASE_MS,
  RATE_LIMIT_BUDGET_MS,
  RATE_LIMIT_MAX_DELAY_MS,
  describePackInstallFailure,
  packInstallHttpError,
  packInstallRetryAfterMs,
  packInstallUserMessage,
  parseRetryAfterMs,
  planPackInstallRetry,
  rateLimitDelayMs,
  runPackInstallAttempts
} from '../src/shared/packInstall'
import {
  RATE_LIMITED_WARN_CODE,
  logPackInstallFailure,
  resetPackInstallWarnings,
  type PackInstallLogSinks
} from '../src/main/packInstallLog'

const TEST_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string): string => readFileSync(join(TEST_ROOT, p), 'utf8')

const TARBALL = 'https://github.com/peonping/alan-rickman/archive/refs/tags/v1.0.1.tar.gz'

/** EXACTLY what a refused response becomes — built by the real constructor, so a header the
 *  installer stops parsing takes these tests red with it. */
function statusError(status: number, retryAfter?: string): Error {
  return packInstallHttpError(TARBALL, status, retryAfter)
}
/** A 429 that carried the server's own clock. */
function rateLimitError(retryAfterSecs: number): Error {
  return statusError(429, String(retryAfterSecs))
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

// ------------------------------------------------------------------------------- the server's clock

test('THE SERVER’S OWN CLOCK IS READ, in both spellings RFC 9110 allows', () => {
  const now = Date.parse('2026-08-19T12:00:00Z')
  assert.equal(parseRetryAfterMs('120', now), 120_000, 'delta-seconds - GitHub’s spelling')
  assert.equal(parseRetryAfterMs(' 45 ', now), 45_000, 'whitespace is not a parse failure')
  assert.equal(parseRetryAfterMs('Wed, 19 Aug 2026 12:03:00 GMT', now), 180_000, 'HTTP-date')
  // A date already past means the window reopened, which is 0 — not null, and not "an hour ago".
  assert.equal(parseRetryAfterMs('Wed, 19 Aug 2026 11:59:00 GMT', now), 0)
  // UNPARSEABLE FALLS THROUGH TO OUR OWN BACKOFF, never to "retry immediately" — which is the one
  // behaviour the header exists to prevent.
  for (const bad of ['soon', '', '   ', null, undefined, {}, -5]) {
    assert.equal(parseRetryAfterMs(bad, now), null, JSON.stringify(bad) ?? 'undefined')
  }
  assert.equal(parseRetryAfterMs(90, now), 90_000, 'a number is seconds too')
  // …and the property the constructor hangs off the error is read back the same way.
  assert.equal(packInstallRetryAfterMs(rateLimitError(60)), 60_000)
  assert.equal(packInstallRetryAfterMs(statusError(429)), null, 'no header, no number')
  assert.equal(packInstallRetryAfterMs(null), null)
})

test('RETRY-AFTER WINS WHEN IT EXISTS, and is never shortened', () => {
  const never = (): number => {
    throw new Error('randomness must not be consulted when the server named a time')
  }
  assert.equal(rateLimitDelayMs(1, { retryAfterMs: 120_000, random: never }), 120_000)
  assert.equal(rateLimitDelayMs(4, { retryAfterMs: 90_000, random: never }), 90_000)
  // Longer than our OWN ceiling is still honoured: the server knows when its window reopens and we
  // do not. Whether the run can AFFORD it is the budget's question, asked in planPackInstallRetry.
  assert.ok(rateLimitDelayMs(1, { retryAfterMs: 10 * 60_000, random: never }) > RATE_LIMIT_MAX_DELAY_MS)
  // `Retry-After: 0` is still a "not yet".
  assert.equal(rateLimitDelayMs(1, { retryAfterMs: 0, random: never }), MIN_RATE_LIMIT_DELAY_MS)
})

test('WITHOUT A HEADER THE BACKOFF IS JITTERED, and it is measured in minutes', () => {
  // EQUAL JITTER: uniform in [ceiling/2, ceiling), the ceiling doubling to a cap. Half the window
  // is guaranteed wait; half is spread, so a fleet that hit the limit in one second does not come
  // back in one second (telemetry/schedule.ts argues the herd point at length).
  for (const attempt of [1, 2, 3, 4, 5]) {
    const ceiling = Math.min(RATE_LIMIT_BASE_MS * 2 ** (attempt - 1), RATE_LIMIT_MAX_DELAY_MS)
    const low = rateLimitDelayMs(attempt, { random: () => 0 })
    const high = rateLimitDelayMs(attempt, { random: () => 0.999_999 })
    assert.equal(low, ceiling / 2, `attempt ${String(attempt)} floor is half the ceiling`)
    assert.ok(high < ceiling && high > ceiling * 0.9, `attempt ${String(attempt)} spreads to the ceiling`)
  }
  // THE SCHEDULE THE TICKET IS ABOUT: the OLD one spent 4.5 s over three attempts. This one starts
  // where that one ended and grows to minutes, and never past its cap.
  assert.ok(rateLimitDelayMs(1, { random: () => 0 }) >= 15_000, 'the first wait is a real wait')
  assert.ok(rateLimitDelayMs(3, { random: () => 0 }) >= 60_000, 'by the third it is minutes')
  assert.ok(rateLimitDelayMs(9, { random: () => 0.999_999 }) <= RATE_LIMIT_MAX_DELAY_MS)
  // Two clients that failed in the same second do not return in the same second.
  assert.notEqual(rateLimitDelayMs(2, { random: () => 0.1 }), rateLimitDelayMs(2, { random: () => 0.9 }))
})

// ------------------------------------------------------------------------------------- the budget

test('A 429 WIDENS THE BUDGET AND NOTHING NARROWS IT', () => {
  const plan = planPackInstallRetry({
    err: rateLimitError(30),
    attempt: 1,
    waitedMs: 0,
    attempts: MAX_INSTALL_ATTEMPTS
  })
  assert.equal(plan.retry, true)
  assert.equal(plan.rateLimited, true)
  assert.equal(plan.attempts, MAX_RATE_LIMITED_ATTEMPTS, 'six, not three')
  assert.equal(plan.delayMs, 30_000)
  // A run already widened to six does not snap back to three when a later attempt fails for some
  // other transient reason — `attempt 4/3` is not a sentence anybody should have to read.
  const after = planPackInstallRetry({
    err: statusError(503),
    attempt: 4,
    waitedMs: 60_000,
    attempts: MAX_RATE_LIMITED_ATTEMPTS
  })
  assert.equal(after.attempts, MAX_RATE_LIMITED_ATTEMPTS)
  assert.equal(after.retry, true)
  // The general path is UNCHANGED: same budget, same doubling, no jitter, no rate-limit flag.
  const plain = planPackInstallRetry({ err: statusError(503), attempt: 1, waitedMs: 0, attempts: 3 })
  assert.deepEqual(plain, { retry: true, delayMs: INSTALL_RETRY_BASE_MS, attempts: 3, rateLimited: false })
  const dead = planPackInstallRetry({ err: statusError(404), attempt: 1, waitedMs: 0, attempts: 3 })
  assert.equal(dead.retry, false)
  assert.equal(dead.stop, 'not-transient')
})

test('THE HORIZON IS THE REAL BOUND — an unaffordable wait ends the run instead of parking it', () => {
  // An honest `Retry-After: 1h` is still an hour, and a click does not get parked for an hour.
  const parked = planPackInstallRetry({
    err: rateLimitError(60 * 60),
    attempt: 1,
    waitedMs: 0,
    attempts: MAX_INSTALL_ATTEMPTS
  })
  assert.equal(parked.retry, false)
  assert.equal(parked.stop, 'budget')
  assert.equal(parked.rateLimited, true, 'still a rate limit — the row must not read as broken')
  // …and the same bound applies to what we scheduled ourselves, once enough of it is spent.
  const spent = planPackInstallRetry({
    err: statusError(429),
    attempt: 2,
    waitedMs: RATE_LIMIT_BUDGET_MS - 1_000,
    attempts: MAX_RATE_LIMITED_ATTEMPTS,
    random: () => 0.5
  })
  assert.equal(spent.retry, false)
  assert.equal(spent.stop, 'budget')
})

// ---------------------------------------------------------------------------------------- the loop

/** A fake install that fails with each queued error in turn, then succeeds. */
function scriptedInstall(errs: unknown[]): { install: () => Promise<void>; calls: () => number } {
  let n = 0
  return {
    install: () => {
      const err = errs[n++]
      return err === undefined ? Promise.resolve() : Promise.reject(err as Error)
    },
    calls: () => n
  }
}

test('ACCEPTANCE: a 429 with Retry-After waits exactly that long and succeeds on a later attempt', async () => {
  const waits: number[] = []
  const script = scriptedInstall([rateLimitError(45), rateLimitError(90)])
  const res = await runPackInstallAttempts({
    install: script.install,
    sleep: (ms) => {
      waits.push(ms)
      return Promise.resolve()
    },
    random: () => {
      throw new Error('the server named the time; nothing here is random')
    }
  })
  assert.deepEqual(waits, [45_000, 90_000], 'the server’s numbers, honoured verbatim')
  assert.equal(script.calls(), 3)
  assert.deepEqual(res, { ok: true, attempts: 3 })
})

test('ACCEPTANCE: a 429 with NO header uses the jittered backoff, over minutes, six attempts deep', async () => {
  const waits: number[] = []
  const rolls = [0, 0.25, 0.5, 0.75, 0.999]
  let roll = 0
  const script = scriptedInstall(Array.from({ length: 5 }, () => statusError(429)))
  const res = await runPackInstallAttempts({
    install: script.install,
    sleep: (ms) => {
      waits.push(ms)
      return Promise.resolve()
    },
    random: () => rolls[roll++ % rolls.length]
  })
  assert.equal(res.ok, true)
  assert.equal(res.attempts, 6, 'the rate-limited budget, not the general three')
  assert.equal(waits.length, 5)
  for (const [i, ms] of waits.entries()) {
    const ceiling = Math.min(RATE_LIMIT_BASE_MS * 2 ** i, RATE_LIMIT_MAX_DELAY_MS)
    assert.ok(ms >= ceiling / 2 && ms < ceiling, `wait ${String(i)}: ${String(ms)} outside its window`)
  }
  // The whole point, in one number: the old schedule spent 4.5 SECONDS on this.
  const total = waits.reduce((a, b) => a + b, 0)
  assert.ok(total > 5 * 60_000, `${String(total)}ms is not a minutes-scale horizon`)
  assert.ok(total <= RATE_LIMIT_BUDGET_MS, 'and it stays inside the horizon')
})

test('ACCEPTANCE: a NON-429 failure keeps the old behaviour exactly', async () => {
  // The regression gate for the whole ticket: nothing about a 503, a dead socket or a 404 moved.
  const waits: number[] = []
  const script = scriptedInstall([statusError(503), new Error('socket hang up')])
  const res = await runPackInstallAttempts({
    install: script.install,
    sleep: (ms) => {
      waits.push(ms)
      return Promise.resolve()
    }
  })
  assert.deepEqual(waits, [INSTALL_RETRY_BASE_MS, INSTALL_RETRY_BASE_MS * 2], 'unchanged 1.5s / 3s')
  assert.deepEqual(res, { ok: true, attempts: 3 })

  // Three attempts and no more, and the failure is reported as it always was.
  const doomed = scriptedInstall([statusError(503), statusError(503), statusError(503)])
  const gaveUp = await runPackInstallAttempts({ install: doomed.install, sleep: () => Promise.resolve() })
  assert.equal(doomed.calls(), MAX_INSTALL_ATTEMPTS)
  assert.equal(gaveUp.ok, false)
  assert.equal(gaveUp.rateLimited, false)
  assert.match(gaveUp.error ?? '', /→ 503$/, 'the raw cause, exactly as before')

  // And a 404 is still ONE request.
  const gone = scriptedInstall([statusError(404), statusError(404)])
  const dead = await runPackInstallAttempts({
    install: gone.install,
    sleep: () => {
      throw new Error('a 404 must never sleep')
    }
  })
  assert.equal(gone.calls(), 1)
  assert.equal(dead.attempts, 1)
})

test('OUT OF BUDGET, THE SENTENCE IS THE TRUE ONE — and the install is still just a click away', async () => {
  const script = scriptedInstall(Array.from({ length: 20 }, () => statusError(429)))
  const res = await runPackInstallAttempts({
    install: script.install,
    sleep: () => Promise.resolve(),
    random: () => 0.999
  })
  assert.equal(res.ok, false)
  assert.equal(res.attempts, MAX_RATE_LIMITED_ATTEMPTS)
  assert.equal(res.rateLimited, true)
  // NOT "install failed", and not `GET https://… → 429`: the pack is fine and the sentence says so
  // before it says anything else, then says what to do.
  assert.equal(res.error, RATE_LIMITED_MESSAGE)
  assert.match(res.error ?? '', /pack is fine/i)
  assert.match(res.error ?? '', /try again/i)
  assert.ok((res.error ?? '').length <= MAX_INSTALL_MESSAGE_CHARS)
  // Every other failure keeps saying exactly what it said before.
  assert.equal(packInstallUserMessage(statusError(404)), describePackInstallFailure(statusError(404)))
})

test('EVERY ATTEMPT IS ANNOUNCED, retried or not — the wait is what the row renders', async () => {
  const seen: { attempt: number; attempts: number; final: boolean; rateLimited: boolean; delayMs: number }[] = []
  const script = scriptedInstall([rateLimitError(20), statusError(404)])
  await runPackInstallAttempts({
    install: script.install,
    sleep: () => Promise.resolve(),
    onFailure: ({ attempt, attempts, final, rateLimited, delayMs, err }) => {
      assert.ok(err instanceof Error)
      seen.push({ attempt, attempts, final, rateLimited, delayMs })
    }
  })
  assert.deepEqual(seen, [
    { attempt: 1, attempts: 6, final: false, rateLimited: true, delayMs: 20_000 },
    // The budget the 429 widened does not narrow when the next answer is a 404 — and a 404 is
    // final on the attempt it happened, whatever the budget says.
    { attempt: 2, attempts: 6, final: true, rateLimited: false, delayMs: 0 }
  ])
})

// ------------------------------------------------------------------------------- what is reported

test('A RATE LIMIT IS NOT AN INSTALL FAILURE — the downgrade', () => {
  // The 27 rows were a condition nobody can act on: not the pack (a 404 is), not this machine (an
  // ENOTFOUND is) — a shared host at a moment, which the app has now already waited out over
  // minutes before giving up. So it lands where somebody else's network lands: console, once per
  // session. JOS-266's severity downgrade, third application.
  resetPackInstallWarnings()
  const r = recorder()
  for (let i = 0; i < 50; i++) {
    logPackInstallFailure({ pack: 'p', attempt: 6, attempts: 6, final: true, err: rateLimitError(60) }, r)
  }
  assert.equal(r.filed.length, 0, 'not one rate-limit report reaches the store')
  assert.equal(r.warned.length, 1, 'and the console hears it once')
  assert.match(String(r.warned[0][1]), /rate limited \(http 429\)/)
  assert.match(String(r.warned[0][1]), /not logged$/)
  // The gate is its OWN code: a rate limit and a dead DNS must not silence each other.
  assert.notEqual(RATE_LIMITED_WARN_CODE, 'unreachable')
  logPackInstallFailure({ pack: 'p', attempt: 3, attempts: 3, final: true, err: offlineError('ENOTFOUND') }, r)
  assert.equal(r.warned.length, 2)
  // A 404 in the same session is STILL filed — the downgrade is one status wide.
  logPackInstallFailure({ pack: 'p', attempt: 1, attempts: 3, final: true, err: statusError(404) }, r)
  assert.equal(r.filed.length, 1)
  resetPackInstallWarnings()
})

// -------------------------------------------------------------------------- the second downloader
//
// The voice model is the other thing this app fetches from a GitHub release, 92 MB at a time, and
// it had the same defect in smaller print: three attempts at 2s and 4s, whatever the answer was.
// It borrows the policy above rather than growing a second copy of it — and NOTHING ELSE about it
// moves (`tests/speechEngine.test.mts` still proves the 404 case is three attempts at [2000, 4000],
// and the resume/digest/atomicity behaviour is untouched).

const BODY = Buffer.from('the model, in spirit'.repeat(40))
const ASSET = {
  name: 'model.onnx',
  url: 'https://github.com/x/y/releases/download/model-files-v1.0/model.onnx',
  sha256: createHash('sha256').update(BODY).digest('hex'),
  bytes: BODY.length
}

/** A fetch that answers 429 for the first `count` requests, then serves the real body. */
function rateLimitedFetch(opts: { count: number; retryAfter?: string; onCall: () => void }) {
  let served = 0
  return ((): Promise<Response> => {
    opts.onCall()
    if (served++ < opts.count) {
      const headers = opts.retryAfter === undefined ? undefined : { 'Retry-After': opts.retryAfter }
      return Promise.resolve(new Response(null, { status: 429, headers }))
    }
    return Promise.resolve(new Response(new Uint8Array(BODY), { status: 200 }))
  }) as unknown as typeof fetch
}

test('THE VOICE MODEL DOWNLOAD HONOURS THE SAME CLOCK — four refusals and it still lands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eqc-speech-429-'))
  const waits: number[] = []
  const phases: SpeechInstallProgress[] = []
  let calls = 0
  const result = await provisionKokoro({
    userData: root,
    assets: [ASSET],
    fetchImpl: rateLimitedFetch({ count: 4, retryAfter: '90', onCall: () => calls++ }),
    onProgress: (p) => phases.push(p),
    sleep: (ms) => {
      waits.push(ms)
      return Promise.resolve()
    }
  })
  // The old budget of three would have given up on the third refusal, six seconds in.
  assert.deepEqual(result, { ok: true })
  assert.equal(calls, 5)
  assert.deepEqual(waits, [90_000, 90_000, 90_000, 90_000], 'Retry-After, verbatim, every time')
  assert.deepEqual(readFileSync(assetPath(root, ASSET)), BODY)
  // AND THE WAIT IS ANNOUNCED: 92 MB behind a bar somebody is watching, and a bar that is waiting
  // looks exactly like a bar that is stuck.
  const waiting = phases.filter((p) => p.phase === 'waiting')
  assert.equal(waiting.length, 4)
  assert.match(String(waiting[0].message), /retrying in 90s/)
})

test('…and with no header it backs off over minutes, then says the true thing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eqc-speech-429-'))
  const waits: number[] = []
  let calls = 0
  const result = await provisionKokoro({
    userData: root,
    assets: [ASSET],
    fetchImpl: rateLimitedFetch({ count: 99, onCall: () => calls++ }), // never lets up
    sleep: (ms) => {
      waits.push(ms)
      return Promise.resolve()
    }
  })
  assert.equal(result.ok, false)
  assert.equal(calls, MAX_RATE_LIMITED_ATTEMPTS, 'the rate-limited budget, not the general three')
  assert.equal(waits.length, MAX_RATE_LIMITED_ATTEMPTS - 1)
  assert.ok(waits.every((ms) => ms >= 15_000), 'every wait is a real wait, not 2 seconds')
  assert.ok(waits.reduce((a, b) => a + b, 0) > 5 * 60_000, 'a minutes-scale horizon')
  // NOT `HTTP 429 for model.onnx`: the download is fine and the bytes fetched are kept.
  assert.match(result.message ?? '', /rate limiting/i)
  assert.match(result.message ?? '', /try again/i)
})

test('THE WIRING: the header is parsed where it exists, and the wait is said out loud', () => {
  // `Retry-After` lives on the response and NOWHERE downstream, so a missed parse here is a lost
  // clock — and the constructor that reads it is shared so a second downloader cannot re-spell it.
  const registry = read('src/main/packRegistry.ts')
  assert.match(registry, /reject\(packInstallHttpError\(url, status, res\.headers\['retry-after'\]\)\)/)

  // A stopped progress bar and a bar waiting out a rate limit look identical; one of them says so.
  const runner = read('src/main/packInstallRun.ts')
  assert.match(runner, /phase: 'waiting'/)
  assert.match(runner, /Download host is busy/)

  // …and the "later" reaches the row, so the caption and the store's severity agree.
  const ipc = read('src/main/ipc/sounds.ts')
  assert.match(ipc, /retryable: res\.rateLimited/)
  const row = read('src/renderer/src/features/alerts/SoundPackRow.tsx')
  assert.match(row, /case 'waiting'/)
  assert.match(row, /p\.retryable \?/)
})
