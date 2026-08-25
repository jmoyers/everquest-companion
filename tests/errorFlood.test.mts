// ============================================================================
// errorFlood.test.mts — no error may report itself seven million times (JOS-197).
// ============================================================================
//
// THE READING THIS SUITE EXISTS FOR, and it is one number: 7,272,196. That is how many occurrences
// of ONE fingerprint one 0.14.0 install filed in a single day — `Error: EPIPE: broken pipe, write`,
// frames `logError` ← `process.<anonymous>`. Those two frames are the whole bug: the app answered a
// failed console write by writing to the console, and the failed write of the answer was another
// uncaught exception. Nothing in the client was in a position to stop it, because nothing bounded
// how many times an issue may be reported.
//
// TWO FIXES, AND THEY ARE NOT THE SAME FIX:
//
//   A. THE LOOP, at its source. A pipe with no reader is not a fault in this app, so a write to it
//      fails silently and latches (`src/main/deadPipe.ts`), and the `'error'` listener that was
//      missing on `process.stdout` / `process.stderr` — the absence of which is what PROMOTED a
//      dead audience into an uncaught exception — is installed.
//   B. THE SHAPE, in general. A hard per-fingerprint per-session ceiling on every reporting path
//      (`src/main/errorBudget.ts`), because the next thing that learns to fail on a timer will not
//      be this one, and the client must not be able to report it without bound either.
//
// WHAT IS DRIVEN AND WHAT IS PINNED. Both new rules are LEAVES — they import nothing — so this
// suite runs the real production code with no Electron in the process, `tests/errorNoise.test.mts`'s
// technique for its reason. `noteError` is driven for real too (it imports only pure `shared/`
// code). The WIRING inside `logError` and `crashGuards` needs Electron, so it is pinned as source.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BROKEN_PIPE_CODES,
  isBrokenPipe,
  noteDeadStdio,
  resetDeadPipe,
  silenceStdioErrors,
  stdioIsDead
} from '../src/main/deadPipe'
import {
  MAX_BUDGETED_FINGERPRINTS,
  MAX_REPORTS_PER_FINGERPRINT,
  errorBudget,
  errorBudgetSpent,
  errorBudgetTracked,
  resetErrorBudget
} from '../src/main/errorBudget'
import {
  noteError,
  peekErrorReports,
  resetErrorReports,
  takeErrorReports
} from '../src/main/telemetry/errorReports'

const TEST_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** Source, with the carriage returns taken out. The tree is checked out CRLF on Windows and LF in
 *  CI (`core.autocrlf`), so a source pin that spans a line break has to be told which one it is
 *  looking at — or be handed text where the question does not arise. This is the latter. */
const read = (p: string): string => readFileSync(join(TEST_ROOT, p), 'utf8').replace(/\r/g, '')

// =========================================================================================
// A. THE DEAD PIPE
// =========================================================================================

test('a broken pipe is recognised by CODE, from whatever shape the failure arrives in', () => {
  // The message is libuv's and changes with Node; the code is the condition. Every listed code
  // means the same thing — this destination cannot be written to — and each is a different way the
  // runtime reports it depending on what kind of handle stdio turned out to be.
  for (const code of BROKEN_PIPE_CODES) {
    assert.equal(isBrokenPipe(Object.assign(new Error('write failed'), { code })), true, code)
    assert.equal(isBrokenPipe({ code }), true, `${code} as a plain object`)
  }
  assert.equal(isBrokenPipe(Object.assign(new Error('x'), { code: 'ENOENT' })), false)
  // TOTAL: it is handed whatever came out of a catch or off an 'error' event, and `throw 42` is
  // legal JavaScript. Nothing here may become the throw it is describing.
  for (const junk of [undefined, null, 'EPIPE', 42, {}, [], new Error('EPIPE: broken pipe, write')]) {
    assert.equal(isBrokenPipe(junk), false)
  }
})

test('the latch is one-way for the session: a pipe does not come back', () => {
  resetDeadPipe()
  assert.equal(stdioIsDead(), false)
  noteDeadStdio()
  assert.equal(stdioIsDead(), true)
  noteDeadStdio()
  assert.equal(stdioIsDead(), true, 'idempotent — it is a boolean, not a counter')
  resetDeadPipe()
  assert.equal(stdioIsDead(), false, 'a new session tries again')
})

test("THE MISSING LISTENER: an 'error' on stdout latches instead of crashing the process", () => {
  // THIS IS THE PROMOTION MECHANISM, and it is checked against the REAL streams. An EventEmitter
  // with no 'error' listener THROWS its payload — so before this listener existed, a failed write
  // to a closed console became an uncaught exception, which `crashGuards` answered by writing to
  // the console, which is the loop.
  silenceStdioErrors()
  for (const s of [process.stdout, process.stderr]) {
    assert.ok(s.listenerCount('error') > 0, 'the stream has somewhere to put a failure')
  }
  const installed = process.stdout.listenerCount('error')
  silenceStdioErrors()
  assert.equal(process.stdout.listenerCount('error'), installed, 'idempotent — no second listener')

  // The listener is then CALLED rather than emitted: `emit` on the real stdout would disturb the
  // channel this test's own results travel over (measured — the runner stops reporting per-test
  // names and a failure can only be seen at file granularity). Invoking the registered handler
  // drives exactly the same code with none of that.
  const sink = process.stdout.listeners('error').at(-1) as (err: unknown) => void
  resetDeadPipe()
  sink(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
  assert.equal(stdioIsDead(), true, 'and it latched, so nothing tries to write again')

  // ANYTHING THAT IS NOT A BROKEN PIPE IS LEFT ALONE — the sink stops a dead audience from
  // crashing the app; it does not make stream faults invisible in general.
  resetDeadPipe()
  sink(Object.assign(new Error('nope'), { code: 'ENOSPC' }))
  assert.equal(stdioIsDead(), false)
  resetDeadPipe()
})

// =========================================================================================
// B. THE BUDGET
// =========================================================================================

test('THE HEADLINE: 7,272,196 occurrences of one fingerprint report a hundred times and stop', () => {
  resetErrorBudget()
  const fp = '2fa08036e4e5290c' // the real one, off the error store
  let reported = 0
  let notices = 0
  // The number from the ticket, run for real. It is a Map get/set per occurrence, so the whole
  // flood costs this test a fraction of a second — which is itself the point: counting was never
  // the expensive part, and that is exactly why nobody bounded it.
  for (let i = 0; i < 7_272_196; i++) {
    const v = errorBudget(fp)
    if (v.report) reported += 1
    if (v.notice !== null) notices += 1
  }
  assert.equal(reported, MAX_REPORTS_PER_FINGERPRINT)
  assert.equal(notices, 1, 'ONE summary line, not one per occurrence — the cap must not flood too')
  assert.equal(errorBudgetSpent(fp), MAX_REPORTS_PER_FINGERPRINT + 1, 'and the counter itself stops')
  resetErrorBudget()
})

test('the notice lands on the LAST reported occurrence, names the fingerprint, and says why', () => {
  resetErrorBudget()
  for (let i = 1; i < MAX_REPORTS_PER_FINGERPRINT; i++) {
    assert.deepEqual(errorBudget('deadbeef'), { report: true, notice: null }, `occurrence ${String(i)}`)
  }
  const last = errorBudget('deadbeef')
  assert.equal(last.report, true, 'the occurrence that spends the budget is still reported')
  assert.ok(last.notice !== null)
  // It names the FINGERPRINT because that is the identity the error store groups by, so the line in
  // errors.log and the row in the store can be lined up by hand.
  assert.match(last.notice, /errorBudget.*deadbeef.*reported 100 times this session/)
  assert.match(last.notice, /counted, not reported/)
  assert.deepEqual(errorBudget('deadbeef'), { report: false, notice: null }, 'then silence')
  resetErrorBudget()
})

test('every fingerprint gets its OWN budget — one loop does not silence the app', () => {
  resetErrorBudget()
  for (let i = 0; i < MAX_REPORTS_PER_FINGERPRINT + 500; i++) errorBudget('the loop')
  assert.equal(errorBudget('the loop').report, false)
  assert.equal(errorBudget('a real bug').report, true, 'a different issue is untouched')
  assert.equal(errorBudgetTracked(), 2)
  resetErrorBudget()
  assert.equal(errorBudgetTracked(), 0)
  assert.equal(errorBudget('the loop').report, true, 'and a new session starts clean')
  resetErrorBudget()
})

test('PAST THE CEILING IT CLOSES — the failure direction is inverted from JOS-133 on purpose', () => {
  // `errorRepeat` fails OPEN past its key ceiling: "may cost the file lines it did not have to, and
  // may never cost it a line it cannot account for". That is right for a question about how long a
  // local file gets and WRONG for a hard ceiling — a budget that fails open is not a ceiling, and
  // having no ceiling is the entire ticket. So a fingerprint that cannot be tracked is silenced.
  resetErrorBudget()
  for (let i = 0; i < MAX_BUDGETED_FINGERPRINTS; i++) errorBudget(`fp${String(i)}`)
  assert.equal(errorBudgetTracked(), MAX_BUDGETED_FINGERPRINTS)

  const overflow = errorBudget('the one that did not fit')
  assert.equal(overflow.report, false)
  assert.ok(overflow.notice !== null, 'and errors.log is told the app has gone quiet')
  assert.match(overflow.notice, /200 distinct errors.*further NEW ones are counted, not reported/)
  // ONE such notice, ever, however many new fingerprints turn up afterwards.
  for (let i = 0; i < 1_000; i++) {
    assert.deepEqual(errorBudget(`late ${String(i)}`), { report: false, notice: null })
  }
  assert.equal(errorBudgetTracked(), MAX_BUDGETED_FINGERPRINTS, 'and the map did not grow')

  // A fingerprint ALREADY tracked still budgets normally when the map is full — the ceiling gates
  // insertion, not the rule.
  assert.equal(errorBudget('fp0').report, true)
  assert.equal(errorBudgetSpent('fp0'), 2)
  resetErrorBudget()
})

test('THE WORST CASE IS BOUNDED BY CONSTRUCTION, and here is the arithmetic', () => {
  // Two constants multiply to the ceiling on reportable occurrences per session. It is asserted
  // rather than merely stated so that raising either one is a decision somebody makes on purpose.
  assert.equal(MAX_REPORTS_PER_FINGERPRINT * MAX_BUDGETED_FINGERPRINTS, 20_000)
  // …against the 7,272,196 that produced the ticket: three orders of magnitude, from ONE session's
  // absolute worst case against ONE fingerprint's real single-day total.
  assert.ok(20_000 < 7_272_196 / 300)
})

// =========================================================================================
// C. THROUGH THE REAL REPORTER
// =========================================================================================

/** A thrown Error with a real V8-shaped stack under the bundle root — `errorReportProducer`'s. */
function thrown(message: string, fn = 'logError', line = 573): Error {
  const err = new Error(message)
  err.stack = [
    `Error: ${message}`,
    `    at ${fn} (C:\\Users\\jmoye\\eqc\\out\\main\\index.js:${String(line)}:11)`,
    '    at process.<anonymous> (C:\\Users\\jmoye\\eqc\\out\\main\\index.js:664:3)'
  ].join('\n')
  return err
}

test('the reporter obeys the budget: the EPIPE loop leaves the client capped, not counted', () => {
  // The exemplar's own two frames, reconstructed. 5,000 occurrences of it — the loop ran at roughly
  // eighty a second, so this is about a minute of it — and the client reports a hundred.
  resetErrorReports(1_000_000)
  const epipe = (): Error => Object.assign(thrown('EPIPE: broken pipe, write'), { code: 'EPIPE' })
  for (let i = 0; i < 5_000; i++) noteError('main:uncaughtException', epipe())

  const [ev] = takeErrorReports()
  assert.ok(ev, 'the issue is still reported — a cap that hid it would be worse than the noise')
  assert.equal(ev.count, MAX_REPORTS_PER_FINGERPRINT, 'and this is THE summary report, carrying it')
  assert.equal(ev.errorName, 'Error')
  assert.equal(ev.code, 'EPIPE')
  assert.equal(takeErrorReports().length, 0, 'then silence: later occurrences add nothing to drain')

  // …and it stays silent. Five thousand more do not restart the count after a drain.
  for (let i = 0; i < 5_000; i++) noteError('main:uncaughtException', epipe())
  assert.deepEqual(takeErrorReports(), [], 'the budget is per SESSION, not per drain window')
  resetErrorReports()
})

test('a NEW session reports it again — the budget resets where the exemplars do', () => {
  resetErrorReports(1_000_000)
  for (let i = 0; i < MAX_REPORTS_PER_FINGERPRINT + 50; i++) {
    noteError('main:uncaughtException', thrown('boom'))
  }
  assert.equal(peekErrorReports()[0].n, MAX_REPORTS_PER_FINGERPRINT)
  // `resetErrorReports` IS the session boundary in this process (the collector calls it), so the
  // two must reset together or a fresh session inherits the last one's silence.
  resetErrorReports(2_000_000)
  noteError('main:uncaughtException', thrown('boom'))
  assert.equal(peekErrorReports()[0].n, 1)
  resetErrorReports()
})

test('the two fail-open cases are named, and neither is the shape this ticket is about', () => {
  // A failure inside the error-log writer mints no report at all (JOS-100), so there is no
  // fingerprint to budget and `logError` writes it as it always did — bounded downstream by
  // `errorRepeat`'s five identical lines.
  resetErrorReports(1_000_000)
  const v = noteError('errorLog', thrown('failed to write errors.log'))
  assert.deepEqual(v, { report: true, notice: null })
  assert.deepEqual(peekErrorReports(), [], 'and nothing was recorded')
  resetErrorReports()
})

// =========================================================================================
// D. THE WIRING
// =========================================================================================

test('THE WIRING: logError has ONE door to the console, and every emitter goes through it', () => {
  const src = read('src/main/errorLog.ts')
  // The three real console calls live in one table; nothing else in the file may call console.
  const bare = src.match(/(?<!CONSOLE)\bconsole\.(log|warn|error)\(/g) ?? []
  assert.equal(bare.length, 3, 'exactly the three inside the CONSOLE table')
  assert.match(src, /const CONSOLE: Record<ConsoleMethod, \(\.\.\.args: unknown\[\]\) => void>/)
  // The guard: latched first, so a dead console costs one failed write per session and not one per
  // line; and a broken pipe latches rather than being reported, because reporting it would mean
  // writing to the thing that just refused.
  assert.match(src, /if \(stdioIsDead\(\)\) return/)
  assert.match(src, /if \(isBrokenPipe\(err\)\) noteDeadStdio\(\)/)
  // Every public emitter routes through it — the narration paths included. A packaged app narrates
  // on every launch, so `logInfo` would have met the closed pipe first whatever `logError` did.
  for (const call of ["toConsole('log', args)", "toConsole('warn', args)", "toConsole('error', args)"]) {
    assert.ok(src.includes(call), call)
  }
})

test('THE WIRING: the file sink is asynchronous, and the only sync writes left are the finals', () => {
  // JOS-371. `appendFileSync`/`statSync` per line were a main-thread stall on the app's error path
  // — and while an overlay holds the mouse, a main-thread stall is a system-wide one. The appender
  // is a QUEUE with ONE drain now, which is what still guarantees the order a sync call used to get
  // for free: nothing else may push bytes at the file.
  const src = read('src/main/errorLog.ts')
  assert.equal(src.match(/\bawait appendFile\(/g)?.length, 1, 'one async appender')
  assert.match(src, /let draining = false/)
  assert.match(src, /if \(draining\) return\r?\n {2}draining = true\r?\n {2}void drain\(\)/)
  // …and the 1 MB rule did not go anywhere: both writers ask it, both write the SAME notice, and
  // the notice is spelled once so they cannot drift apart.
  assert.equal(src.match(/MAX_LOG_BYTES/g)?.length, 3, 'the ceiling, and one test of it per writer')
  assert.equal(src.match(/truncationNotice\(/g)?.length, 2, 'spelled once, written by both writers')
  assert.match(src, /await truncateIfFull\(path, batch\[0\]\.ts\)/)

  // THE SYNC SURVIVORS, and there are exactly two calls, both inside the one exported final. Every
  // other line in this file reaches disk through the queue.
  const flush = src.slice(src.indexOf('export function flushErrorLogSync('))
  assert.equal(src.match(/\bappendFileSync\(/g)?.length, 1)
  assert.equal(src.match(/\bwriteFileSync\(/g)?.length, 1)
  assert.match(flush, /appendFileSync\(path, batch\.map/)
  assert.match(flush, /writeFileSync\(path, truncationNotice/)

  // …called from the two places where "later" may never arrive, and from nowhere else in src/main.
  const guards = read('src/main/crashGuards.ts')
  assert.match(guards, /logError\('main:uncaughtException', err\)\r?\n {2}flushErrorLogSync\(\)/)
  assert.match(guards, /logError\('main:unhandledRejection', reason\)\r?\n {2}flushErrorLogSync\(\)/)
  // The quit final is LAST in `before-quit`, so a teardown step's own error line is in the batch.
  const index = read('src/main/index.ts')
  const beforeQuit = index.slice(index.indexOf("app.on('before-quit'"))
  const body = beforeQuit.slice(0, beforeQuit.indexOf('\n})'))
  assert.match(body, /flushErrorLogSync\(\)/)
  assert.ok(body.indexOf('flushStoreForQuit()') < body.indexOf('flushErrorLogSync()'))
})

test("THE WIRING: crashGuards installs the stdio sink BEFORE it can answer an exception", () => {
  const src = read('src/main/crashGuards.ts')
  assert.ok(src.indexOf('silenceStdioErrors()\n') < src.indexOf("process.on('uncaughtException'"))
  // EPIPE IS NOT SPECIAL-CASED HERE, and that is deliberate: a broken pipe reaching this handler
  // came from somewhere that is not our own stdio (a child, a socket, the updater), and a blanket
  // rule would swallow real failures. Pinned so nobody "tidies" it in later.
  assert.doesNotMatch(src, /isBrokenPipe/)
})

test('THE WIRING: logError asks the budget FIRST, and the notice is never silenced by it', () => {
  const src = read('src/main/errorLog.ts')
  // Outermost gate: the verdict comes back from `noteError` (the only place the fingerprint is
  // known) and is obeyed before the identical-line cap is even consulted.
  assert.match(src, /const budget = noteError\(source, payload, Date\.now\(\), captureSite\)/)
  assert.ok(src.indexOf('if (!budget.report)') < src.indexOf('const repeat = errorRepeat('))
  // The line that EXPLAINS a silence is written before the silence is obeyed, or a reader of
  // errors.log would watch an error simply stop.
  assert.ok(src.indexOf('if (budget.notice !== null)') < src.indexOf('if (!budget.report)'))
})

test('THE WIRING: both new rules are LEAVES, so nothing on the error path can cycle', () => {
  // `errorRepeat.ts`'s argument, twice more: these are consulted from inside `logError`, which is
  // the app's last line of defense, and a module-init order bug found there is the worst one there
  // is. A leaf cannot participate in a cycle no matter who imports it — and it is also what lets
  // this suite drive the real production code with no Electron in the process.
  assert.doesNotMatch(read('src/main/errorBudget.ts'), /^\s*import\s/m)
  assert.doesNotMatch(read('src/main/deadPipe.ts'), /^\s*import\s/m)
  // …and the budget is reset from the collector's session boundary, beside the exemplars.
  assert.match(read('src/main/telemetry/errorReports.ts'), /\n {2}resetErrorBudget\(\)/)
})

test('THE HONEST LEDGER: the health counters are NOT behind the cap, and that is the point', () => {
  // JOS-133 built `suppressedErrorLines` so a cap could exist without deflating the fleet's error
  // rate — "a build that started looping" must not "look like a build that got better". A budget
  // that silenced the counters too would undo exactly that. The distinction is COST, not principle:
  // `healthCounters` emits eight integers per heartbeat whatever their magnitude, so there is
  // nothing there to flood and nothing to bypass.
  const health = read('src/main/telemetry/health.ts')
  assert.doesNotMatch(health, /errorBudget|MAX_REPORTS_PER_FINGERPRINT/)
  assert.doesNotMatch(read('src/main/errorBudget.ts'), /noteSuppressedErrorLine|noteErrorLogLine/)
  // And `logError` counts the budget's silences into that ledger, so the total still adds up.
  assert.match(read('src/main/errorLog.ts'), /if \(!budget\.report\) \{\s+noteSuppressedErrorLine\(\)/)
})
