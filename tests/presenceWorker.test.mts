// THE WATCHER, RUN (JOS-182 — the other half of what tests/presenceWatcherScript.test.mts did).
//
// That suite spawned the real `powershell.exe` child with a doomed stand-in parent and watched it
// beat, then reap itself. This one starts the real worker thread and watches it beat — and the
// reason it exists is the same one: the watcher's loop is the part of this feature that has never
// been driven by anything except a user's machine, and the defect JOS-164 was raised for lived in
// exactly that gap for four releases.
//
// WHAT IS DIFFERENT, AND IT IS THE POINT OF THE TICKET. There is no parent to kill, because there
// is no child. A worker thread dies with the process that owns it, so the self-reap, the
// `X|parent-gone` line and the orphaned-PowerShell hazard they existed for are all gone; the
// half of the old suite that tested them has nothing left to test. What remains — does it start,
// does it look at the world, does it beat, does it say why when it stops — is here.
//
// IT RUNS THE COMPILED WORKER, NOT THE SOURCE. `new Worker()` loads a FILE, and the file the app
// loads is `out/main/presenceWorker.js` (electron.vite.config.ts's third main input). So this
// suite hands the worker a tsx loader for the TypeScript entry instead, which is the same program
// through the same module graph — and `tests/presence.test.mts` pins the protocol those lines
// have to satisfy either way.
//
// Windows-only: the worker's first act is to open user32/kernel32/psapi, and off Windows it
// correctly answers `X|native-unavailable` and stops. CI runs on `windows-latest`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WATCHER_STOP_MESSAGE,
  parsePresenceLine,
  watcherCadence,
  type PresenceWorkerInit
} from '../src/main/presenceProtocol'

const NOT_WINDOWS = process.platform !== 'win32' && 'the presence surface is user32/kernel32/psapi'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER_TS = join(HERE, '..', 'src', 'main', 'presenceWorker.ts')

/** A fast running-poll so the beat (and therefore a full pass of every call family) turns quickly.
 *  Everything else is what the app itself passes. */
const INIT: PresenceWorkerInit = {
  eqRootWithSep: 'C:\\Games\\EQ\\',
  runningPollMs: 300,
  tickMs: 1,
  foregroundEveryTicks: 10,
  // The RING-ON posture. Everything below except the JOS-193 test runs it, because it is the
  // watcher at its busiest — every call family, on the fast cadence.
  watchCursor: true
}

interface Run {
  lines: string[]
  /** The code the thread ended on, or -1 if it was still alive when the condition was met. */
  exitCode: number
  /** The code it ended on after being asked to stop. */
  stopCode: number
}

/**
 * Start the real worker, collect its lines until `done` says we have seen enough (or it exits on
 * its own), then ASK IT TO STOP and wait for it to go.
 *
 * WAIT FOR THE CONDITION, NEVER FOR THE CLOCK — the house rule, and here it is also the only way
 * to be honest about a loop whose whole contract is "speaks when something changes".
 *
 * AND NEVER `terminate()`. That is not tidiness, it is the crash this ticket found: terminating a
 * worker while it is inside a koffi call aborts the process with
 * `FATAL ERROR: Error::ThrowAsJavaScriptException`. A harness that reached for `terminate()` would
 * be flaky in the most alarming possible way AND would be modelling something the app must never
 * do — so it stops the way `presence.ts` stops, and every test in this file is therefore also a
 * regression test for that crash.
 */
async function runWorker(
  init: PresenceWorkerInit,
  done: (lines: string[]) => boolean,
  timeoutMs = 60_000
): Promise<Run> {
  const worker = new Worker(WORKER_TS, {
    workerData: init,
    // The worker entry is TypeScript, so the thread needs the same loader the suite runs under.
    execArgv: ['--import', 'tsx']
  })
  const lines: string[] = []
  let exitCode = -1
  const ended = new Promise<number>((resolve) => {
    worker.once('exit', (code) => {
      exitCode = code
      resolve(code)
    })
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`worker never satisfied the condition; saw:\n${lines.join('\n')}`))
    }, timeoutMs)
    const finish = (): void => {
      clearTimeout(timer)
      resolve()
    }
    worker.on('message', (line: unknown) => {
      if (typeof line === 'string') lines.push(line)
      if (done(lines)) finish()
    })
    worker.on('error', reject)
    void ended.then(finish)
  })
  worker.postMessage(WATCHER_STOP_MESSAGE)
  const stopCode = await withTimeout(ended, timeoutMs, 'the watcher never honoured a stop')
  return { lines, exitCode, stopCode }
}

async function withTimeout<T>(p: Promise<T>, ms: number, why: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(why))
        }, ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

test('THE WATCHER LOOKS AT THE WORLD ON ITS FIRST TICK, then keeps beating', {
  skip: NOT_WINDOWS
}, async () => {
  // Two beats is the proof that the loop is TURNING rather than that it started: everything except
  // the heartbeat is change-driven, so a watcher that emitted its first three observations and then
  // wedged would look identical on the channel without them.
  const { lines } = await runWorker(INIT, (l) => l.filter((x) => x === 'H').length >= 2)

  const records = lines.map(parsePresenceLine)
  assert.equal(records.includes(null), false, `every line decodes; got:\n${lines.join('\n')}`)

  // The first tick emits a cursor reading, a foreground reading and a running reading, IN THAT
  // ORDER — the cursor check leads because it is the one that runs on every tick (JOS-120), and
  // `presence.ts` relies on any of the three to set `observed` and let auto-hide start acting.
  const kinds = records.map((r) => r?.t)
  assert.equal(kinds[0], 'cursor', `the cursor check leads; got ${lines[0]}`)
  assert.ok(kinds.includes('fg'), 'the foreground window was reported')
  assert.ok(kinds.includes('run'), 'the running scan reported')
  assert.ok(kinds.includes('beat'), 'and the heartbeat is beating')

  // NOTHING IS SAID TWICE. The steady state of a healthy watcher is silence plus a heartbeat, and
  // that is the entire reason this design can poll at 69 Hz without costing anything downstream.
  const changes = lines.filter((l) => l !== 'H')
  assert.equal(
    new Set(changes).size,
    changes.length,
    `a record was repeated rather than suppressed:\n${changes.join('\n')}`
  )
  assert.equal(lines.some((l) => l.startsWith('X|')), false, 'no exit line from a healthy watcher')
})

test('STOPPING A RUNNING WATCHER ENDS IT CLEANLY, and does not take this process with it', {
  skip: NOT_WINDOWS
}, async () => {
  // THE CRASH, AS A TEST. `worker.terminate()` on a thread that happens to be inside a koffi call
  // aborts the entire process — reproduced 2/2 rounds at this cadence, while an idle worker
  // survived 40/40, which is what makes it a rare and unattributable crash rather than an obvious
  // one. Every session ends by stopping this watcher, so "rare" would still have meant a steady
  // trickle of crash reports at quit.
  //
  // So `presence.ts` asks, and this is the ask, against a watcher deliberately caught mid-stride:
  // the run below is stopped immediately after its first records, while the loop is turning at
  // ~69 Hz and the 300 ms scan is in flight.
  const { stopCode } = await runWorker({ ...INIT, runningPollMs: 1 }, (l) => l.length >= 3)
  assert.equal(stopCode, 0, 'the thread ended on its own, cleanly, having been asked')
})

test('the FOREGROUND line carries a pid, a rectangle, an image path and a title', {
  skip: NOT_WINDOWS
}, async () => {
  const { lines } = await runWorker(INIT, (l) => l.some((x) => x.startsWith('F|')))
  const raw = lines.find((l) => l.startsWith('F|'))
  assert.ok(raw !== undefined)
  const rec = parsePresenceLine(raw)
  assert.equal(rec?.t, 'fg', `the emitted line decodes: ${raw}`)
  if (rec?.t !== 'fg') return
  assert.ok(Number.isInteger(rec.pid))
  // The title is the last field precisely because it may contain anything — but it may NOT contain
  // a newline, or one record would arrive as two. The worker flattens them for that reason.
  assert.equal(/[\r\n]/.test(rec.title), false, `a title carried a line break: ${JSON.stringify(rec.title)}`)
})

test('A LAST WORD POSTED AS THE PORT CLOSES IS STILL DELIVERED — the exit path’s one assumption', async () => {
  // `presenceWorker.ts`'s `stop()` is two statements: post the reason, close the port. Everything
  // downstream of a machine that cannot load the Win32 surface depends on BOTH halves landing —
  // the reason is what turns 245 copies of "exited unexpectedly" into one sentence (JOS-164), and
  // the clean code-0 exit is the shape `watcherExitStep` recognises as a loop rather than a crash.
  //
  // It cannot be forced through the real worker on a machine where the surface DOES load, and
  // faking the failure would mean adding a test-only branch to shipped code. So what is pinned
  // here is the Node behaviour the two-line sequence rests on, in isolation and in the same order:
  // a message posted immediately before `close()` still arrives, and the thread then ends at 0.
  // If a future Node changes that, this fails here rather than silently on somebody's desktop.
  const worker = new Worker(
    "const { parentPort } = require('node:worker_threads');" +
      "parentPort.postMessage('X|native-unavailable');" +
      'parentPort.close();',
    { eval: true }
  )
  const seen: string[] = []
  const exitCode = await new Promise<number>((resolve, reject) => {
    worker.on('message', (line: unknown) => {
      if (typeof line === 'string') seen.push(line)
    })
    worker.on('error', reject)
    worker.on('exit', resolve)
  })
  assert.deepEqual(seen, ['X|native-unavailable'], 'the reason survived the close')
  assert.deepEqual(parsePresenceLine(seen[0]), { t: 'exit', reason: 'native-unavailable' })
  assert.equal(exitCode, 0, 'a closed port ends the thread cleanly, which is what the fold reads')
})

test('WITH THE RING OFF THE WATCHER NEVER LOOKS AT THE CURSOR — and still does everything else', {
  skip: NOT_WINDOWS
}, async () => {
  // JOS-193, and this is the assertion the ticket is actually about. `C` is emitted from the same
  // three lines that call `cursorShowing()`, which is the ONLY `GetCursorInfo` in the application
  // (presenceNative.ts declares it once) — so a run that produces no `C` is a run in which the app
  // never asked Windows about the cursor. It is a strong observation rather than a weak one
  // precisely because the record is CHANGE-DRIVEN and the very first reading always differs from
  // the `-1` the loop starts on: the ring-on test above pins `C` as literally the FIRST line the
  // watcher ever says, so its absence here cannot be "the cursor happened not to change".
  //
  // The rest of the watcher is asserted in the same breath, because "no cursor" must not have cost
  // auto-hide anything: the foreground window, the running scan and the heartbeat are all still
  // there, on the coarse cadence `watcherCadence(false)` asks for.
  const init: PresenceWorkerInit = {
    ...INIT,
    watchCursor: false,
    ...watcherCadence(false),
    // The coarse tick is ~160 ms, so a 300 ms running poll would take a while to beat twice.
    runningPollMs: 1
  }
  const { lines } = await runWorker(init, (l) => l.filter((x) => x === 'H').length >= 2)

  assert.deepEqual(
    lines.filter((l) => l.startsWith('C')),
    [],
    `the cursor was never read; got:\n${lines.join('\n')}`
  )
  assert.ok(lines.some((l) => l.startsWith('F|')), 'the foreground window is still reported')
  assert.ok(lines.some((l) => l.startsWith('R|')), 'the running scan still runs')
  assert.equal(lines.some((l) => l.startsWith('X|')), false, 'and nothing decided to stop')
  const records = lines.map(parsePresenceLine)
  assert.equal(records.includes(null), false, `every line still decodes:\n${lines.join('\n')}`)
})

test('AN UNREADABLE INSTALL ROOT CHANGES NOTHING — the watcher still reports', {
  skip: NOT_WINDOWS
}, async () => {
  // `eqRootPrefix('')` is what an app whose EverQuest directory could not be resolved passes, and
  // it is the posture a fresh install has before onboarding. The running scan then falls back to
  // the client's image NAME alone. It must still answer — an unresolvable root is a narrower
  // question, not a broken watcher.
  const { lines } = await runWorker({ ...INIT, eqRootWithSep: '' }, (l) => l.includes('H'))
  assert.ok(lines.some((l) => l.startsWith('R|')), `the running scan reported; got:\n${lines.join('\n')}`)
  assert.equal(lines.some((l) => l.startsWith('X|')), false, 'and nothing decided to stop')
})
