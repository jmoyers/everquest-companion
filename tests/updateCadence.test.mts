// Auto-update pure logic (Task #60) — cadence/jitter, version precedence, the
// status -> chip-state mapping, and the relative-age formatting behind the
// left-nav "checked 2h ago" line.
//
// No log, no fixture, no Electron: every function under test is deliberately
// side-effect free (src/shared/update.ts) precisely so the update flow — which
// CANNOT be exercised end-to-end in dev (electron-updater is guarded on
// app.isPackaged) — still has a real regression net.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BACKOFF_BASE_MS,
  CHECK_INTERVAL_MS,
  FEED_PARSE_MESSAGE,
  JITTER_FRACTION,
  MAX_UPDATE_MESSAGE_CHARS,
  RESUME_DELAY_MS,
  SIGNATURE_BLOCKED_MESSAGE,
  SIGNATURE_BLOCKED_PAUSED_MESSAGE,
  RESUME_JITTER_MS,
  STARTUP_DELAY_MS,
  STARTUP_JITTER_MS,
  MAX_DOWNLOAD_ATTEMPTS,
  compareVersions,
  describeUpdateFailure,
  isFeedParseError,
  isNewerVersion,
  isStaleVersion,
  nextCheckDelayMs,
  shouldRetryCheck,
  updateChipLine,
  updateChipState
} from '../src/shared/update'
import type { UpdateStatus } from '../src/shared/types'
import { formatAge } from '../src/renderer/src/lib/formatDate'

/** Deterministic rand() cycling through the given values. */
const seq = (...vals: number[]): (() => number) => {
  let i = 0
  return () => vals[i++ % vals.length]
}

// ------------------------------------------------------------------ cadence

test('startup check lands in idle time, never during the log replay', () => {
  assert.equal(nextCheckDelayMs({ phase: 'startup' }, seq(0)), STARTUP_DELAY_MS)
  assert.equal(
    nextCheckDelayMs({ phase: 'startup' }, seq(1)),
    STARTUP_DELAY_MS + STARTUP_JITTER_MS
  )
  // The whole point of moving off the old 10s: the startup replay (~6s of
  // `hydrating` on the real log) plus paint must be long past.
  assert.ok(STARTUP_DELAY_MS >= 30_000, 'startup delay must clear the hydration window')
})

test('periodic cadence is "somewhat infrequent" — hours, not minutes', () => {
  assert.ok(CHECK_INTERVAL_MS >= 60 * 60 * 1000, 'at least hourly spacing')
  const perDay = (24 * 60 * 60 * 1000) / CHECK_INTERVAL_MS
  assert.ok(perDay <= 12, `${perDay} feed hits/day is not infrequent`)
})

test('jitter spreads periodic checks +/- JITTER_FRACTION and never inverts', () => {
  const lo = nextCheckDelayMs({ phase: 'periodic' }, seq(0))
  const mid = nextCheckDelayMs({ phase: 'periodic' }, seq(0.5))
  const hi = nextCheckDelayMs({ phase: 'periodic' }, seq(1))
  assert.equal(lo, Math.round(CHECK_INTERVAL_MS * (1 - JITTER_FRACTION)))
  assert.equal(mid, CHECK_INTERVAL_MS)
  assert.equal(hi, Math.round(CHECK_INTERVAL_MS * (1 + JITTER_FRACTION)))
  assert.ok(lo < mid && mid < hi)
  // A thundering herd is the failure this exists to prevent: identical launches
  // must not produce identical delays.
  const rand = seq(0.1, 0.9, 0.4)
  const three = [0, 1, 2].map(() => nextCheckDelayMs({ phase: 'periodic' }, rand))
  assert.equal(new Set(three).size, 3, 'jittered delays must differ')
})

test('failed checks back off exponentially and CAP at the healthy interval', () => {
  const at = (fails: number): number => nextCheckDelayMs({ phase: 'periodic', consecutiveFailures: fails }, seq(0.5))
  assert.equal(at(0), CHECK_INTERVAL_MS)
  assert.equal(at(1), BACKOFF_BASE_MS)
  assert.equal(at(2), BACKOFF_BASE_MS * 2)
  assert.equal(at(3), BACKOFF_BASE_MS * 4)
  // Monotonic non-decreasing, and it never runs away past the normal cadence —
  // an outage decays TO the cadence, it does not spiral into days of silence.
  let prev = 0
  for (let f = 1; f <= 20; f++) {
    const d = at(f)
    assert.ok(d >= prev, `backoff must not decrease at ${f} failures`)
    assert.ok(d <= CHECK_INTERVAL_MS, `backoff must cap at the interval (${f} failures)`)
    prev = d
  }
  // …and a failure always retries SOONER than a healthy cycle would (that's the
  // point of a backoff floor), never faster than the base.
  assert.ok(at(1) < CHECK_INTERVAL_MS)
})

test('every delay is positive, for any rand() and any failure count', () => {
  for (const r of [0, 0.0001, 0.5, 0.9999, 1]) {
    for (const f of [0, 1, 5, 50]) {
      const d = nextCheckDelayMs({ phase: 'periodic', consecutiveFailures: f }, seq(r))
      assert.ok(d > 0, `delay ${d} must be positive (rand=${r}, fails=${f})`)
      assert.ok(d <= CHECK_INTERVAL_MS * (1 + JITTER_FRACTION) + 1)
    }
    assert.ok(nextCheckDelayMs({ phase: 'startup' }, seq(r)) > 0)
  }
})

// -------------------------------------------------------- version precedence

test('CI prerelease build numbers compare NUMERICALLY (main.9 < main.10)', () => {
  // The bug a plain string compare would ship: '1.4.0-main.9' > '1.4.0-main.10'
  // lexically, so every install would sit on run 9 forever.
  assert.equal(compareVersions('1.4.0-main.9', '1.4.0-main.10'), -1)
  assert.ok(isNewerVersion('1.4.0-main.10', '1.4.0-main.9'))
  assert.ok(!isNewerVersion('1.4.0-main.9', '1.4.0-main.10'))
})

test('semver precedence: numbers, then prerelease below its release', () => {
  assert.equal(compareVersions('1.4.1', '1.4.0'), 1)
  assert.equal(compareVersions('1.4.0', '2.0.0'), -1)
  assert.equal(compareVersions('1.4.0', '1.4.0'), 0)
  assert.equal(compareVersions('1.4.0-main.1', '1.4.0'), -1, 'prerelease sorts below release')
  assert.equal(compareVersions('1.4.0', '1.4.0-main.1'), 1)
  assert.equal(compareVersions('v1.4.0', '1.4.0'), 0, 'a leading v is tolerated')
})

test('an unknown or unparseable version is never treated as newer', () => {
  assert.equal(compareVersions(undefined, '1.0.0'), 0)
  assert.equal(compareVersions('not-a-version', '1.0.0'), 0)
  assert.ok(!isNewerVersion(undefined, '1.0.0'))
  assert.ok(!isNewerVersion('1.1.0', undefined))
})

test('isStaleVersion never SUPPRESSES on an unknown comparison (never guess)', () => {
  assert.ok(isStaleVersion('1.4.0', '1.4.0'), 'the same build is stale')
  assert.ok(isStaleVersion('1.3.0', '1.4.0'), 'an older build is stale')
  assert.ok(!isStaleVersion('1.5.0', '1.4.0'))
  // The dangerous direction: an unparseable pair must NOT be called stale, or a
  // real update would be silently swallowed.
  assert.ok(!isStaleVersion('weird-build', '1.4.0'))
  assert.ok(!isStaleVersion('1.4.0', 'weird-build'))
  assert.ok(!isStaleVersion(undefined, '1.4.0'))
  assert.ok(!isStaleVersion('1.4.0', undefined))
})

// ------------------------------------------------------- status -> UI state

const CURRENT = '1.4.0-main.100'

test('ready is the ONE loud state', () => {
  const s = updateChipState({ state: 'ready', version: '1.4.0-main.101', checkedAt: 5 }, CURRENT)
  assert.equal(s.kind, 'ready')
  assert.equal(s.kind === 'ready' && s.version, '1.4.0-main.101')
  assert.equal(s.checkedAt, 5)
})

test('UPDATED-AWAY: a ready/downloading status naming the version we RUN is demoted to quiet', () => {
  // apply-on-quit installed .101 and relaunched us as .101; a status pushed just
  // before the relaunch (or a feed still listing .101) must not beg for another
  // pointless restart. Same for an equal version and an older one.
  for (const v of ['1.4.0-main.100', '1.4.0-main.99', '1.3.0']) {
    const ready = updateChipState({ state: 'ready', version: v }, CURRENT)
    assert.equal(ready.kind, 'quiet', `ready @ ${v} must be quiet on ${CURRENT}`)
    assert.equal(ready.kind === 'quiet' && ready.failed, false, 'stale is not an error')
    assert.equal(updateChipState({ state: 'downloading', version: v, percent: 50 }, CURRENT).kind, 'quiet')
    assert.equal(updateChipState({ state: 'available', version: v }, CURRENT).kind, 'quiet')
  }
})

test('with no current version known we trust the status as-is (never guess)', () => {
  assert.equal(updateChipState({ state: 'ready', version: '1.0.0' }, undefined).kind, 'ready')
  assert.equal(updateChipState({ state: 'ready' }, CURRENT).kind, 'ready')
  // An unparseable version on either side must not swallow a real update.
  assert.equal(updateChipState({ state: 'ready', version: 'nightly' }, CURRENT).kind, 'ready')
  assert.equal(updateChipState({ state: 'ready', version: '1.0.0' }, 'nightly').kind, 'ready')
})

test('the download anti-loop guard retries, but a bounded number of times', () => {
  // The failure this bounds: a corrupt asset re-downloaded on every cycle
  // forever. It must still retry at least once (transient truncation is common)
  // and must stay small enough that a broken release costs a few MB, not GBs.
  assert.ok(MAX_DOWNLOAD_ATTEMPTS >= 2, 'a single transient failure must not give up')
  assert.ok(MAX_DOWNLOAD_ATTEMPTS <= 5, 'never an unbounded retry loop')
})

test('downloading clamps + rounds percent into a renderable 0..100', () => {
  const at = (percent?: number): number => {
    const s = updateChipState({ state: 'downloading', version: '1.4.0-main.101', percent }, CURRENT)
    assert.equal(s.kind, 'downloading')
    return s.kind === 'downloading' ? s.percent : -1
  }
  assert.equal(at(61.7), 62)
  assert.equal(at(undefined), 0)
  assert.equal(at(-5), 0)
  assert.equal(at(1000), 100)
})

test('an ERROR is quiet, never loud — the message survives for Preferences', () => {
  const s = updateChipState({ state: 'error', message: 'getaddrinfo ENOTFOUND', checkedAt: 9 }, CURRENT)
  assert.equal(s.kind, 'quiet')
  assert.equal(s.kind === 'quiet' && s.failed, true)
  assert.equal(s.kind === 'quiet' && s.message, 'getaddrinfo ENOTFOUND')
  assert.equal(s.checkedAt, 9, 'a failed check still counts as a check')
})

test('checking + available are transient "working" one-liners; idle is quiet', () => {
  assert.equal(updateChipState({ state: 'checking' }, CURRENT).kind, 'working')
  assert.equal(updateChipState({ state: 'available', version: '9.9.9' }, CURRENT).kind, 'working')
  const idle = updateChipState({ state: 'idle', checkedAt: 42 }, CURRENT)
  assert.equal(idle.kind, 'quiet')
  assert.equal(idle.kind === 'quiet' && idle.failed, false)
  assert.equal(idle.checkedAt, 42)
})

test('checkedAt rides through EVERY state (the chip line never blanks mid-download)', () => {
  const states: UpdateStatus['state'][] = ['idle', 'checking', 'available', 'downloading', 'ready', 'error']
  for (const state of states) {
    const s = updateChipState({ state, version: '9.9.9', percent: 10, checkedAt: 1234 }, CURRENT)
    assert.equal(s.checkedAt, 1234, `${state} must carry checkedAt`)
  }
})

// ------------------------------------------------------ malformed feed bodies
//
// JOS-211. The reported failure was the literal sentence `Unexpected end of JSON
// input` in Preferences. Nothing in this repo calls JSON.parse on a feed — the
// call is builder-util-runtime's, inside the code that FORMATS an HTTP error:
//
//     if (statusCode >= 400) {
//       const isJson = contentType?.includes("json")
//       reject(createHttpError(response, `… Data: ${isJson ? safeStringifyJson(JSON.parse(data)) : data}`))
//     }                                                        ^^^^^^^^^^^^^^^^
//
// so on a >= 400 response advertising json with an empty/short body, the parse
// error REPLACES the HttpError and arrives at us naked.
//
// `bodyFailure` below is that exact move — JSON.parse over a real response body,
// with whatever the running Node version throws handed straight to our classifier.
// Pinning the MESSAGES those bodies produce would be pinning V8's wording (it
// changed in Node 20); pinning that they are HANDLED is the contract.

/** What builder-util-runtime throws when it formats an error over `body`. */
const bodyFailure = (body: string): unknown => {
  try {
    JSON.parse(body)
  } catch (e) {
    return e
  }
  throw new Error('body parsed cleanly — not a failure case')
}

/** The three response bodies a feed hiccup actually produces. */
const BAD_BODIES: Record<string, string> = {
  // An edge/proxy that answers 429 or 503 with no body at all. THE reported case.
  'empty body': '',
  // A connection closed mid-body: valid JSON as far as it goes, and it stops.
  'truncated JSON body': '{"tag_name":"v0.22.0","assets":[{"name":"latest.y',
  // A CDN/captive-portal error page served under a json content-type.
  'non-JSON body (HTML error page)':
    '<!DOCTYPE html><html><head><title>503 Service Unavailable</title></head><body><h1>Error</h1></body></html>'
}

for (const [label, body] of Object.entries(BAD_BODIES)) {
  test(`${label}: recognised as a feed parse failure, never shown raw`, () => {
    const err = bodyFailure(body)
    assert.ok(isFeedParseError(err), `${label} must classify as a feed parse failure`)

    const message = describeUpdateFailure(err)
    assert.equal(message, FEED_PARSE_MESSAGE)
    // The whole point: not one word of the parser survives into the UI.
    assert.ok(!/JSON|token|position/i.test(message), `parser wording leaked: ${message}`)
    // It must say what happened AND that it is worth trying again.
    assert.match(message, /update/i)
    assert.match(message, /later|again/i)
  })

  test(`${label}: earns exactly ONE retry`, () => {
    const err = bodyFailure(body)
    assert.equal(shouldRetryCheck(err, 0), true, 'the first unreadable body is retried')
    assert.equal(shouldRetryCheck(err, 1), false, 'a second one gives up — never a loop')
    assert.equal(shouldRetryCheck(err, 2), false)
  })
}

test('electron-updater WRAPS some parse failures — those are the same failure', () => {
  // The wrapped shapes, verbatim from electron-updater@6.8.9. Their messages embed a
  // whole atom feed / a stack trace, so even when they parse they must never be the
  // caption: a Preferences line is not a place to print 7 kB of XML.
  const feed = Object.assign(new Error('Cannot parse releases feed: SyntaxError: x,\nXML:\n<feed>…</feed>'), {
    code: 'ERR_UPDATER_INVALID_RELEASE_FEED'
  })
  const info = Object.assign(new Error('Cannot parse update info from latest.yml …: rawData: null'), {
    code: 'ERR_UPDATER_INVALID_UPDATE_INFO'
  })
  for (const err of [feed, info]) {
    assert.ok(isFeedParseError(err))
    assert.equal(describeUpdateFailure(err), FEED_PARSE_MESSAGE)
  }
  // getLatestTagName's wrapper covers BOTH a parse failure and a repo with no release,
  // so the code alone cannot decide — the interpolated text does.
  const parsed = Object.assign(
    new Error('Unable to find latest version on GitHub (…): SyntaxError: Unexpected end of JSON input'),
    { code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' }
  )
  const missing = Object.assign(
    new Error('Unable to find latest version on GitHub (…): HttpError: 404 Not Found'),
    { code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' }
  )
  assert.ok(isFeedParseError(parsed), 'a parse failure inside the wrapper is still a parse failure')
  assert.ok(!isFeedParseError(missing), 'a genuine 404 must keep its own message')
})

// ------------------------------------------- the PowerShell signature check (JOS-421)
//
// The fleet's biggest error family is not a feed failure at all: electron-updater verifies the
// downloaded installer by shelling out to PowerShell, and on a machine whose security software
// guts that call it gets EMPTY STDOUT and `JSON.parse('')` throws — the same `SyntaxError`, to the
// character, as the JOS-211 case above. shared/update.ts's JOS-421 block reads the library source.
//
// The two fixtures are the two shapes the error store actually carries (fingerprints
// 72bdb3d77ddbc71d and d877b63662b64f60). The FIRST one's message is indistinguishable from a feed
// failure and its STACK is the only thing that tells them apart, which is why it is set here.

/** The stack the fleet's reports carry, with the module path electron-updater is loaded from. */
const VERIFIER_FRAMES =
  '    at parseOut (C:\\Users\\u\\AppData\\Local\\Programs\\eqc\\resources\\app.asar\\node_modules\\' +
  'electron-updater\\out\\windowsExecutableCodeSignatureVerifier.js:104:23)\n' +
  '    at C:\\a\\node_modules\\electron-updater\\out\\windowsExecutableCodeSignatureVerifier.js:55:30\n' +
  '    at ChildProcess.exithandler (node:child_process:410:7)'

/** PowerShell exited 0 and said nothing: a REAL `JSON.parse('')`, carrying the verifier's frames. */
const blockedParseFailure = (): unknown => {
  const err = bodyFailure('') as Error
  err.stack = `${err.name}: ${err.message}\n${VERIFIER_FRAMES}`
  return err
}

/** PowerShell exited non-zero (or was killed at the 20s timeout): `child_process`'s own shape —
 *  `Command failed: <cmd>` plus the `cmd` property it sets beside it. */
const blockedCommandFailure = (): unknown => {
  const cmd =
    'set "PSModulePath=" & chcp 65001 >NUL & powershell.exe -NoProfile -NonInteractive ' +
    '-InputFormat None -Command "Get-AuthenticodeSignature -LiteralPath \'C:\\x\\installer.exe\'' +
    ' | ConvertTo-Json -Compress"'
  return Object.assign(new Error(`Command failed: ${cmd}\n`), { cmd, code: 1 })
}

test('a blocked PowerShell says SECURITY SOFTWARE, never "GitHub sent an unreadable response"', () => {
  for (const err of [blockedParseFailure(), blockedCommandFailure()]) {
    const message = describeUpdateFailure(err)
    assert.equal(message, SIGNATURE_BLOCKED_MESSAGE)
    assert.notEqual(message, FEED_PARSE_MESSAGE, 'blaming the feed for this PC is the whole bug')
    // Actionable: it names the thing on the machine, and not one word of the parser or the feed.
    assert.match(message, /security software/i)
    assert.match(message, /powershell/i)
    assert.ok(!/JSON|token|position|GitHub/i.test(message), `leaked: ${message}`)
    assert.ok(message.length <= MAX_UPDATE_MESSAGE_CHARS, `${message.length} chars`)
  }
  assert.ok(SIGNATURE_BLOCKED_PAUSED_MESSAGE.length <= MAX_UPDATE_MESSAGE_CHARS)
  assert.match(SIGNATURE_BLOCKED_PAUSED_MESSAGE, /security software/i)
  // The paused sentence is the one a stuck user sits with, so it has to say what to DO.
  assert.match(SIGNATURE_BLOCKED_PAUSED_MESSAGE, /allow PowerShell|by hand/i)
})

test('a blocked PowerShell is NEVER given the feed retry — a re-check re-downloads for nothing', () => {
  for (const err of [blockedParseFailure(), blockedCommandFailure()]) {
    assert.equal(shouldRetryCheck(err, 0), false)
    assert.equal(shouldRetryCheck(err, 1), false)
  }
  // …and the feed's own empty body still earns its one retry: the discriminator is the stack, and
  // widening one of these two must never quietly swallow the other.
  assert.equal(shouldRetryCheck(bodyFailure(''), 0), true)
  assert.equal(describeUpdateFailure(bodyFailure('')), FEED_PARSE_MESSAGE)
})

test('a blocked PowerShell still renders as the QUIET chip state (product rule)', () => {
  const s = updateChipState({ state: 'error', message: SIGNATURE_BLOCKED_MESSAGE, checkedAt: 7 }, CURRENT)
  assert.equal(s.kind, 'quiet')
  assert.equal(s.kind === 'quiet' && s.failed, true)
  assert.equal(s.kind === 'quiet' && s.message, SIGNATURE_BLOCKED_MESSAGE)
})

test('a failure that NAMES something actionable keeps its own words', () => {
  // The counterpart risk: hiding every error behind one soothing sentence. A user
  // (or a triage report) is better off seeing these, and they are never retried
  // here — the exponential backoff already owns them.
  for (const text of [
    'getaddrinfo ENOTFOUND github.com',
    'net::ERR_INTERNET_DISCONNECTED',
    'sha512 checksum mismatch'
  ]) {
    const err = new Error(text)
    assert.equal(isFeedParseError(err), false, `${text} is not a parse failure`)
    assert.equal(describeUpdateFailure(err), text)
    assert.equal(shouldRetryCheck(err, 0), false, 'only unreadable bodies get the extra attempt')
  }
})

test('every message is ONE bounded line — no stacks, no feed dumps in a caption', () => {
  const stacky = new Error(`Cannot check for updates: boom\n    at doCheckForUpdates (AppUpdater.js:1:1)`)
  assert.equal(describeUpdateFailure(stacky), 'Cannot check for updates: boom')

  const huge = new Error(`HttpError: 503 ${'x'.repeat(5_000)}`)
  const message = describeUpdateFailure(huge)
  assert.ok(message.length <= MAX_UPDATE_MESSAGE_CHARS, `${message.length} chars is a wall of text`)
  assert.ok(message.startsWith('HttpError: 503'), 'the informative head survives the truncation')
  assert.ok(FEED_PARSE_MESSAGE.length <= MAX_UPDATE_MESSAGE_CHARS)

  // Absent / shapeless failures still produce a sentence rather than "undefined".
  assert.equal(describeUpdateFailure(undefined), 'unknown error')
  assert.equal(describeUpdateFailure(null), 'unknown error')
  assert.equal(describeUpdateFailure(new Error('   \n  ')), 'unknown error')
  assert.equal(describeUpdateFailure('plain string failure'), 'plain string failure')
  assert.equal(isFeedParseError(null), false)
})

test('the readable failure still renders as the QUIET chip state (product rule)', () => {
  // Hardening the message must not promote a failed check into a loud one: the only
  // loud state is 'ready'. The message survives for Preferences and nowhere else.
  const s = updateChipState({ state: 'error', message: FEED_PARSE_MESSAGE, checkedAt: 7 }, CURRENT)
  assert.equal(s.kind, 'quiet')
  assert.equal(s.kind === 'quiet' && s.failed, true)
  assert.equal(s.kind === 'quiet' && s.message, FEED_PARSE_MESSAGE)
})

// --------------------------------------------------- lastCheckedAt formatting

test('formatAge is COARSE and user-local, and "never" is the absent case', () => {
  const now = Date.parse('2026-08-02T12:00:00')
  assert.equal(formatAge(undefined, now), '', 'no stamp ⇒ empty (caller renders "never")')
  assert.equal(formatAge(0, now), '')
  assert.equal(formatAge(now - 5_000, now), 'just now')
  assert.equal(formatAge(now - 89_000, now), 'just now')
  assert.equal(formatAge(now - 12 * 60_000, now), '12m ago')
  assert.equal(formatAge(now - 2 * 3_600_000, now), '2h ago')
  assert.equal(formatAge(now - 35 * 3_600_000, now), '35h ago')
  assert.equal(formatAge(now - 3 * 86_400_000, now), '3d ago')
  // Clock skew (a persisted stamp from the future) must not print a negative age.
  assert.equal(formatAge(now + 60_000, now), 'just now')
})

// ------------------------------------------------------- waking up (JOS-307)

test('a WAKE re-anchors the cadence, short and jittered', () => {
  assert.equal(nextCheckDelayMs({ phase: 'resume' }, seq(0)), RESUME_DELAY_MS)
  assert.equal(nextCheckDelayMs({ phase: 'resume' }, seq(1)), RESUME_DELAY_MS + RESUME_JITTER_MS)
  // Short enough that the user who just sat down gets an answer in the same sitting, and far
  // shorter than the periodic spacing it is replacing — that IS the fix: a frozen setTimeout can
  // otherwise leave the remainder of a four-hour wait measured in a clock that stopped.
  assert.ok(RESUME_DELAY_MS < 60_000, 'a wake check must land in the same sitting')
  assert.ok(nextCheckDelayMs({ phase: 'resume' }, seq(1)) < CHECK_INTERVAL_MS / 4)
  // Still jittered: laptops in the same timezone open their lids at the same time of day, which
  // is the same thundering-herd argument the periodic jitter exists for.
  const rand = seq(0.1, 0.9, 0.4)
  const three = [0, 1, 2].map(() => nextCheckDelayMs({ phase: 'resume' }, rand))
  assert.equal(new Set(three).size, 3)
})

test('a WAKE IGNORES the backoff, and does not clear it either', () => {
  // The failures that walked the backoff out were made by a machine that is no longer the machine
  // we have. But the backoff is not RESET here — if the feed really is unhappy, the short check
  // fails and the ordinary exponential spacing re-forms from `consecutiveFailures`.
  for (const fails of [0, 1, 5, 50]) {
    assert.equal(nextCheckDelayMs({ phase: 'resume', consecutiveFailures: fails }, seq(0)), RESUME_DELAY_MS)
  }
  assert.equal(
    nextCheckDelayMs({ phase: 'periodic', consecutiveFailures: 3 }, seq(0.5)),
    BACKOFF_BASE_MS * 4,
    'the periodic phase still reads the same counter'
  )
})

// ------------------------------------------- what the chip SAYS out loud (JOS-307)

/** The chip line for a status, at a fixed clock. */
const line = (
  status: UpdateStatus,
  ctx?: Partial<{ version: string; age: string | null; busy: boolean; cooldown: boolean }>
): { label: string; tip: string; failed: boolean } =>
  updateChipLine(updateChipState(status, CURRENT), {
    version: ctx?.version ?? CURRENT,
    age: ctx?.age === undefined ? '2h ago' : ctx.age,
    busy: ctx?.busy ?? false,
    cooldown: ctx?.cooldown ?? false
  })

test('A FAILED CHECK SAYS SO — the sentence, not just the tooltip', () => {
  // THE REGRESSION THIS PINS. GitHub issue 29: every check failed on six consecutive versions and
  // the chip read `v0.23.0 · checked 2h ago` throughout, because errors rendered character for
  // character like successes. The caption was the only artefact anyone could ever get from that
  // user, and it was a lie.
  const failed = line({ state: 'error', message: FEED_PARSE_MESSAGE, checkedAt: 7 })
  assert.equal(failed.failed, true)
  assert.equal(failed.label, `v${CURRENT} · update check failed`)
  assert.doesNotMatch(failed.label, /checked \d|up to date/, 'never a claim that a check completed')
  // The installed version stays in the line: this chip is the bottom-left "what am I running"
  // spot in every state, and a failed check does not change what is running.
  assert.ok(failed.label.startsWith(`v${CURRENT}`))
  // The detail is still in the title, and it still says the click is worth making.
  assert.match(failed.tip, /didn't complete/)
  assert.ok(failed.tip.includes(FEED_PARSE_MESSAGE))
  assert.match(failed.tip, /try again/)
})

test('THE COOLDOWN LINE cannot claim a check that failed', () => {
  // The worst shape of the old bug, and the one a user would actually notice: click the chip, the
  // check fails, and for ten seconds the line reads "checked just now".
  const after = line({ state: 'error', message: 'boom', checkedAt: 7 }, { cooldown: true, age: 'just now' })
  assert.equal(after.label, `v${CURRENT} · update check failed`)
  // A successful manual check still gets its answer — that behaviour is unchanged.
  const ok = line({ state: 'idle', checkedAt: 7 }, { cooldown: true, age: 'just now' })
  assert.equal(ok.label, `v${CURRENT} · up to date`)
  assert.equal(ok.failed, false)
})

test('a check IN FLIGHT outranks the failure it is retrying', () => {
  const busy = line({ state: 'error', message: 'boom', checkedAt: 7 }, { busy: true })
  assert.equal(busy.label, 'Checking for updates…')
  assert.equal(busy.failed, false, 'no failure styling while the retry is running')
  // …and the transient working states speak for themselves.
  assert.equal(line({ state: 'checking' }).label, 'Checking for updates…')
  assert.equal(line({ state: 'available', version: '9.9.9' }).label, 'Update found…')
})

test('the resting line is unchanged for everything that did NOT fail', () => {
  assert.equal(line({ state: 'idle', checkedAt: 7 }).label, `v${CURRENT} · checked 2h ago`)
  assert.equal(line({ state: 'idle' }, { age: null }).label, `v${CURRENT} · not checked yet`)
  // Before `getAppVersion()` answers there is no version to lead with, and the line still reads.
  assert.equal(line({ state: 'idle', checkedAt: 7 }, { version: '' }).label, 'checked 2h ago')
  assert.equal(line({ state: 'idle', checkedAt: 7 }).failed, false)
  assert.equal(line({ state: 'idle', checkedAt: 7 }).tip, 'Click to check for updates')
})

test('THE JSON-PARSE FAMILY reaches the user as a READABLE TRANSIENT, never the parser', () => {
  // In-app report 01KZYN843T99R2JHYDTF9TS8AK (0.20.0) is the corroboration the owner folded into
  // this ticket, and it quotes what the user was looking at, verbatim:
  //     App updates / check failed / Last checked: 8/13/2026, 5:50:25 PM / Unexpected end of JSON
  // GitHub issue 29 is the same failure mode on a different install. Two claims are pinned here,
  // and it takes both to make that screen honest: the parser's words never reach a surface, AND
  // the sentence that replaces them says it is transient rather than something the user broke.
  const err = bodyFailure('')
  const status: UpdateStatus = { state: 'error', message: describeUpdateFailure(err), checkedAt: 7 }
  const rendered = line(status)
  for (const text of [rendered.label, rendered.tip]) {
    assert.doesNotMatch(text, /JSON|SyntaxError|token|position/i, `parser wording leaked: ${text}`)
  }
  assert.equal(rendered.failed, true, 'the chip states it rather than swallowing it')
  assert.ok(rendered.tip.includes(FEED_PARSE_MESSAGE))
  // "transient" has to be IN the sentence: nothing is wrong with the install, and it is worth
  // trying again. That is the difference between a shrug and an answer.
  assert.match(FEED_PARSE_MESSAGE, /Nothing is wrong with your install/i)
  assert.match(FEED_PARSE_MESSAGE, /again later/i)
  // And it is the message Preferences renders too — `describeUpdateFailure` is the ONE producer of
  // `UpdateStatus.message`, so both surfaces read the same sentence by construction.
  assert.equal(status.message, FEED_PARSE_MESSAGE)
})

test('STILL QUIET: stating the failure did not promote it to a loud state', () => {
  // The product rule this ticket deliberately does NOT move: the only loud state is 'ready'. What
  // changed is the words; `updateChipState` — which is what decides whether the gold chip renders
  // — must be untouched by any of it.
  const ui = updateChipState({ state: 'error', message: 'boom', checkedAt: 7 }, CURRENT)
  assert.equal(ui.kind, 'quiet')
  assert.notEqual(ui.kind, 'ready')
})

test('a PERSISTED lastCheckedAt reads truthfully right after a relaunch', () => {
  // The regression this guards: an in-memory-only stamp made every launch show
  // "never" until the first check landed — with a 4h cadence that is a lie for
  // up to 45s+ on every single start, and forever if the user quits sooner.
  const now = Date.parse('2026-08-02T12:00:00')
  const persisted = now - 2 * 3_600_000
  const s = updateChipState({ state: 'idle', checkedAt: persisted }, CURRENT)
  assert.equal(s.kind, 'quiet')
  assert.equal(formatAge(s.checkedAt, now), '2h ago')
})
