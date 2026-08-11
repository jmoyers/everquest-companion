// ============================================================================
// errorNoise.test.mts — an error report should mean an error (JOS-133).
// ============================================================================
//
// THE READING THIS SUITE EXISTS FOR, and it is one number: over 14 days the error store's only
// recurring user-cohort issue was fingerprint f38d9cf19743f81b with 17,632 occurrences across
// 0.13.0 and 0.14.0 — roughly two thirds of every `mainErrorLogLines` the fleet has ever counted.
// It was not an error. An image the app wanted could not be downloaded, the renderer hid it, and
// the app carried on exactly as designed. A counter that large made of one handled condition does
// not describe this app's health; it hides it.
//
// TWO CHANGES, ONE ARGUMENT, and this file covers both because they only make sense together:
//
//   A. THE CACHE MISS BECOMES A COUNTER. The network leg of an image fetch bumps
//      `imageFetchFailures` and warns once per host per session, instead of filing an error. The
//      HTTP-STATUS branch beside it stays an error, and the difference is the whole point: a host
//      that never answered is somebody else's outage, a host that answered 404 means this app
//      asked for something that is not there.
//   B. IDENTICAL LINES ARE CAPPED. The first five copies of one line are written as always; after
//      that one notice replaces the next and the rest become `suppressedErrorLines`. The counter is
//      what makes the cap allowable at all — `mainErrorLogLines + suppressedErrorLines` is still
//      exactly how many times the thing happened, so a build that starts looping cannot look like a
//      build that got better.
//
// WHAT IS DRIVEN AND WHAT IS PINNED. `errorRepeat` and the image-cache warn gate are LEAVES (they
// import nothing, or nothing but other leaves), so this suite drives the real production code with
// no Electron in the process — `tests/errorCounterHygiene.test.mts`'s technique, for its reason.
// The WIRING inside `logError` needs `electron`, so it is pinned as source there and in
// `tests/healthCounters.test.mts`, which owns the counter half.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ERROR_KEY_CHARS,
  MAX_IDENTICAL_ERROR_LINES,
  MAX_TRACKED_ERROR_KEYS,
  errorRepeat,
  errorRepeatKey,
  errorRepeatTracked,
  resetErrorRepeat
} from '../src/main/errorRepeat'
import {
  describeFetchFailure,
  imageFetchHost,
  resetImageFetchWarnings,
  takeImageFetchWarning
} from '../src/main/imageCache'
import {
  noteImageFetchFailure,
  noteSuppressedErrorLine,
  resetHealth,
  takeHealth
} from '../src/main/telemetry/health'
import { HEALTH_NON_ERROR_FIELDS, isErrorHealthField } from '../src/shared/telemetryRollup'

const TEST_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string): string => readFileSync(join(TEST_ROOT, p), 'utf8')

/** The production sink, as `logError` runs it: count the suppression, then decide what to write.
 *  Returns the file lines that would have been appended. Pinned to the real source below. */
function drive(source: string, body: string, times: number): string[] {
  const written: string[] = []
  for (let i = 0; i < times; i++) {
    const r = errorRepeat(source, body)
    if (r.suppressed) noteSuppressedErrorLine()
    if (r.write) written.push(body)
    else if (r.notice !== null) written.push(r.notice)
  }
  return written
}

// ------------------------------------------------------------------------------------------ B

test('the first five copies are written, then one notice, then nothing — and every one is counted', () => {
  resetErrorRepeat()
  resetHealth()
  const lines = drive('main:uncaughtException', 'TypeError: x is not a function\n  at foo', 10_000)

  // FIVE payload lines plus ONE notice. Ten thousand occurrences cost six lines of a 1 MB file
  // instead of ten thousand — which is the file rotating away all of its context, twice over.
  assert.equal(lines.length, MAX_IDENTICAL_ERROR_LINES + 1)
  assert.equal(lines.filter((l) => l.startsWith('TypeError')).length, MAX_IDENTICAL_ERROR_LINES)
  assert.match(lines[MAX_IDENTICAL_ERROR_LINES], /errorRepeat.*written 5 times.*counted, not written/)

  // THE HONEST TOTAL. 10,000 occurrences = 5 written + 9,995 suppressed. The notice is not one of
  // the 9,995: it replaced the sixth occurrence, and that occurrence is counted as suppressed.
  const health = takeHealth()
  assert.equal(health.suppressedErrorLines, 10_000 - MAX_IDENTICAL_ERROR_LINES)
  resetHealth()
  resetErrorRepeat()
})

test('the notice is written EXACTLY once — a repeat cannot re-announce itself forever', () => {
  // The failure this pins is a cap that emits its own explanation every time, which would trade
  // one flood for a slightly cheaper flood.
  resetErrorRepeat()
  resetHealth()
  const lines = drive('main:x', 'boom', 500)
  assert.equal(lines.filter((l) => l.includes('errorRepeat')).length, 1)
  resetHealth()
  resetErrorRepeat()
})

test('"identical" means source AND payload — two different faults do not share a budget', () => {
  resetErrorRepeat()
  resetHealth()
  // The same message from two sources is two facts about where the app broke.
  assert.equal(drive('main:uncaughtException', 'boom', 5).length, 5)
  assert.equal(drive('renderer:ErrorBoundary', 'boom', 5).length, 5)
  // …and two messages from one source are two faults.
  assert.equal(drive('main:x', 'first', 5).length, 5)
  assert.equal(drive('main:x', 'second', 5).length, 5)
  assert.equal(takeHealth().suppressedErrorLines, 0, 'nothing was suppressed — none of them repeated')
  assert.equal(errorRepeatTracked(), 4)
  resetHealth()
  resetErrorRepeat()
})

test('the key ignores what differs between two copies and keeps what identifies them', () => {
  // The TIMESTAMP is the only thing two copies of one fault differ in, so it must not be in the
  // key — keying on the formatted line would defeat the cap completely. It never reaches here:
  // `logError` builds the line AFTER asking, from `source` and `body` alone (pinned below).
  assert.equal(errorRepeatKey('a', 'msg'), errorRepeatKey('a', 'msg'))
  assert.notEqual(errorRepeatKey('a', 'msg'), errorRepeatKey('b', 'msg'))
  // A long stack is truncated to a bounded key, so a Map entry cannot hold kilobytes…
  const long = `Error: same\n${'  at frame\n'.repeat(400)}`
  assert.equal(errorRepeatKey('a', long).length, 'a '.length + ERROR_KEY_CHARS)
  // …and two faults that agree for the first 300 characters DO collide. Said out loud rather than
  // hidden: the cost is that the second fault's later copies are counted instead of written, and
  // its error REPORT (a different fingerprint, a different dedupe) is unaffected either way.
  assert.equal(errorRepeatKey('a', `${long}A`), errorRepeatKey('a', `${long}B`))
})

test('past the key ceiling nothing is suppressed — the failure direction is MORE lines, never fewer', () => {
  // A pathological producer of DISTINCT lines must not be able to grow the map without bound. When
  // it is full, a new key is not tracked and is written every time: this module may cost the file
  // lines it did not have to, and may never cost it a line it cannot account for.
  resetErrorRepeat()
  resetHealth()
  for (let i = 0; i < MAX_TRACKED_ERROR_KEYS; i++) errorRepeat('main:x', `distinct ${String(i)}`)
  assert.equal(errorRepeatTracked(), MAX_TRACKED_ERROR_KEYS)
  // The 501st line, a thousand times over: written a thousand times, suppressed zero times.
  assert.equal(drive('main:x', 'the one that did not fit', 1_000).length, 1_000)
  assert.equal(takeHealth().suppressedErrorLines, 0)
  assert.equal(errorRepeatTracked(), MAX_TRACKED_ERROR_KEYS, 'and the map did not grow')
  // A key ALREADY tracked still caps normally when the map is full — the ceiling gates insertion,
  // not the rule.
  assert.equal(drive('main:x', 'distinct 0', 10).length, MAX_IDENTICAL_ERROR_LINES)
  resetHealth()
  resetErrorRepeat()
})

test('THE WIRING: logError asks the rule, counts the suppression, and never touches the report', () => {
  const src = read('src/main/errorLog.ts')
  // The report is taken FIRST, so a suppressed line still produces its error report — the fleet
  // loses no observation, only the local file gets shorter.
  //
  // THIS ASSERTION USED TO PASS VACUOUSLY (found while fixing JOS-197). `logError` has called
  // `noteError(source, payload, Date.now(), captureSite)` since JOS-111, so the literal it looked
  // for was absent, `indexOf` returned -1, and `-1 < anything` is true — it would have gone on
  // being green with the two calls in either order, or with `noteError` deleted outright. The
  // prefix is matched now, and BOTH orderings that matter are checked.
  assert.ok(src.includes('noteError(source, payload, Date.now(), captureSite)'))
  assert.ok(src.indexOf('noteError(source, payload,') < src.indexOf('const repeat = errorRepeat('))
  // Both sinks obey one verdict: a dev watching stdout reads the same flood errors.log does. Since
  // JOS-197 they obey it through ONE writer, which is also the only door to the console.
  assert.match(src, /if \(!repeat\.write && repeat\.notice === null\) return/)
  assert.match(src, /writeLine\(ts, \[PREFIX, repeat\.notice\]/)
  assert.match(src, /writeLine\(ts, \[PREFIX, `\[\$\{source\}\]`, body\]/)
  // The line is built from `source` + `body`, which is what keeps the timestamp out of the key.
  assert.match(src, /errorRepeat\(source, body\)/)
  // The rule is a LEAF — no imports at all — so it cannot close a cycle on the app's error path
  // (`telemetry/health.ts`'s argument, for its reason) and this suite can drive the real thing.
  assert.doesNotMatch(read('src/main/errorRepeat.ts'), /^\s*import\s/m)
})

// ------------------------------------------------------------------------------------------ A

test('a fetch failure warns ONCE PER HOST PER SESSION, however many images asked', () => {
  // Per host because that is the resolution the fact has: when a wiki is down it is down for every
  // icon, and the second line says nothing the first did not. Per session because the alternative
  // is a line per request, which is the noise this ticket removed.
  resetImageFetchWarnings()
  assert.equal(takeImageFetchWarning('eqlwiki.com'), true)
  for (let i = 0; i < 500; i++) assert.equal(takeImageFetchWarning('eqlwiki.com'), false)
  // A DIFFERENT host is a different outage and earns its own line.
  assert.equal(takeImageFetchWarning('wiki.project1999.com'), true)
  assert.equal(takeImageFetchWarning('wiki.project1999.com'), false)
  resetImageFetchWarnings()
  assert.equal(takeImageFetchWarning('eqlwiki.com'), true, 'a new session warns again')
  resetImageFetchWarnings()
})

test('the host gate and the failure description are TOTAL — they run inside a catch', () => {
  // Whatever these are handed, they must never become the throw they are describing.
  assert.equal(imageFetchHost('https://eqlwiki.com/index.php?title=X'), 'eqlwiki.com')
  assert.equal(imageFetchHost('https://wiki.project1999.com:443/a.png'), 'wiki.project1999.com')
  // Not a URL: the string itself, so the warn line still says something rather than nothing.
  assert.equal(imageFetchHost('not a url'), 'not a url')
  assert.equal(imageFetchHost(''), '')
  assert.equal(describeFetchFailure(new Error('offline')), 'Error')
  assert.equal(describeFetchFailure(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'TimeoutError')
  // Nothing that is not an Error can put text into the line — including a thrown string, which is
  // the one shape that could otherwise carry a URL or a path into dev stdout uninvited.
  for (const junk of [undefined, null, 'a string', 42, {}] as unknown[]) {
    assert.equal(describeFetchFailure(junk), 'unknown')
  }
})

test('the demoted branch counts, and the branch beside it is still an error', () => {
  // The COUNTER half, driven for real. The source pin for the two branches lives in
  // tests/healthCounters.test.mts (it is a counter-wiring assertion); what is asserted here is the
  // number that replaced the error, and that it is a plain count with nowhere to put a URL.
  resetHealth()
  for (let i = 0; i < 17_632; i++) noteImageFetchFailure()
  assert.equal(takeHealth().imageFetchFailures, 17_632)
  resetHealth()
  // The warn line is CONSOLE ONLY, and the option that carries it defaults to `logWarn` — which
  // writes to stdout and never to errors.log, so a demoted condition cannot re-enter the error
  // count through the back door.
  const img = read('src/main/imageCache.ts')
  assert.match(img, /const warn = opts\.warn \?\? \(\(m: string\) => logWarn\(m\)\)/)
  assert.equal(img.match(/logError\(/g), null, 'imageCache never writes errors.log directly')
  assert.equal(img.match(/from '\.\/errorLog'/g)?.length, 1)
  assert.match(img, /import \{ logConsoleError, logInfo, logWarn \} from '\.\/errorLog'/)
})

test('an image fetch failure is COUNTED but is not an ERROR — the release rate excludes it', () => {
  // The reading decision, pinned where it can be argued with. `errors / healthReports` per build
  // answers "did I release buggy code"; 17,632 failed downloads of somebody else's images would
  // swamp every real signal in it and would move with a wiki's uptime rather than with a release.
  assert.deepEqual([...HEALTH_NON_ERROR_FIELDS], ['imageFetchFailures'])
  assert.equal(isErrorHealthField('imageFetchFailures'), false)
  // A DENY LIST, so a field added later and forgotten counts as an error — noisy and visible,
  // rather than silently vanishing from the rate.
  assert.equal(isErrorHealthField('somethingAddedNextYear'), true)
  // And the one that must NOT be excluded, ever: suppressed lines are real errors that a cap
  // withheld from the file, so leaving them out would let the cap flatter a looping build.
  assert.equal(isErrorHealthField('suppressedErrorLines'), true)
  assert.equal(isErrorHealthField('mainErrorLogLines'), true)
  // The reader honors it in BOTH places it sums: the per-day series and the per-build total.
  const rh = read('src/main/triage/releaseHealth.ts')
  assert.match(rh, /!isErrorHealthField\(split\.field\)/)
  assert.match(rh, /byField\.filter\(\(f\) => isErrorHealthField\(f\.id\)\)/)
})

test('THE DOC says both new counters in the file users are pointed at', () => {
  // TELEMETRY.md is generated from the schema (tests/telemetryDoc.test.mts pins the parity), so the
  // promise about each field is asserted where a user would read it. The image row must not read
  // as a fault the user should do something about, and neither row may promise more than a count.
  const rows = read('TELEMETRY.md').split(/\r?\n/)
  const image = rows.find((l) => l.includes('`imageFetchFailures`'))
  assert.ok(image, 'TELEMETRY.md documents the image counter')
  assert.match(image, /hidden and the app carries on/)
  assert.match(image, /Never which picture/)
  const suppressed = rows.find((l) => l.includes('`suppressedErrorLines`'))
  assert.ok(suppressed, 'TELEMETRY.md documents the suppression counter')
  assert.match(suppressed, /A count only/)
})
