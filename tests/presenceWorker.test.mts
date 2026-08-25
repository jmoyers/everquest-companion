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
  encodeHoverZones,
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
  timeoutMs = 60_000,
  /** What to say DOWNSTREAM, now that this channel runs both ways (JOS-370). */
  drive: {
    /** Lines to post the moment the thread exists — today, hot-zone sets. They are queued by
     *  `worker_threads`, so this cannot race the handler the worker installs. */
    send?: string[]
    /** Post something back in REACTION to a line. The only way to drive a sequence whose second
     *  step must land after the loop has sampled once — see the retraction test. */
    onLine?: (line: string, post: (l: string) => void) => void
  } = {}
): Promise<Run> {
  const { send = [], onLine } = drive
  const worker = new Worker(WORKER_TS, {
    workerData: init,
    // The worker entry is TypeScript, so the thread needs the same loader the suite runs under.
    execArgv: ['--import', 'tsx']
  })
  for (const line of send) worker.postMessage(line)
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
      if (typeof line === 'string') {
        lines.push(line)
        onLine?.(line, (l) => worker.postMessage(l))
      }
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

// ------------------------------------------------- the hot-zone hit test, RUN (JOS-370)
//
// This is the block that replaced a system-wide mouse hook, so it is worth driving on a real
// thread rather than only in the pure suite (tests/overlayHotZone.test.mts): the parts a unit test
// cannot see are that the downstream line is understood at all, that the loop re-arms itself onto
// the hover cadence when a rectangle arrives, and that a watcher holding NO rectangle says nothing.
//
// AND IT NEVER ASSUMED EVERQUEST WAS IN FRONT, which is worth saying now that nothing does: the
// 2026-08-24 ruling removed the game's foreground from the zone-publication gate (main's side, in
// overlayHotZone.ts), and the worker's side never had it — this loop hit-tests whatever rectangles
// it has been handed, on a machine where the game is almost certainly not running at all. That is
// why these assertions did not have to move.
//
// IT DOES NOT ASSERT WHERE THE OWNER'S CURSOR IS, because it cannot and must not: the machine
// running this suite has a real pointer somewhere, and EverQuest may be hiding it (the flake this
// file already carries a ledger row for). So the two claims are chosen to be true of any cursor —
// a rectangle covering every representable coordinate gets SOME answer, and a rectangle a million
// pixels off the desktop gets a definite NO.

/** A rectangle no cursor can be outside of, and one no cursor can be inside. */
const EVERYWHERE = [{ x: -500_000, y: -500_000, width: 1_000_000, height: 1_000_000 }]
const NOWHERE = [{ x: 1_000_000, y: 1_000_000, width: 10, height: 10 }]

test('A HOT ZONE IS ANSWERED, AND ONLY ON AN EDGE', { skip: NOT_WINDOWS }, async () => {
  const init: PresenceWorkerInit = {
    ...INIT,
    watchCursor: false,
    ...watcherCadence(false),
    runningPollMs: 1
  }
  const { lines } = await runWorker(
    init,
    (l) => l.some((x) => x.startsWith('V|fight|')) && l.includes('V|overall|0'),
    60_000,
    { send: [encodeHoverZones('fight', EVERYWHERE), encodeHoverZones('overall', NOWHERE)] }
  )

  // The definite half: a rectangle off the edge of every desktop contains no cursor, so the answer
  // is NO — and it ARRIVES, which is the first-sample rule (a key main has never been told about
  // gets its answer stated rather than assumed).
  assert.ok(lines.includes('V|overall|0'), `no answer for the far zone:\n${lines.join('\n')}`)
  // The any-cursor half: the all-covering rectangle gets an answer too. It is `1` for a visible
  // pointer and `0` for one EverQuest has hidden for mouselook, and BOTH are correct — a hidden
  // cursor is not a cursor over anything, which is what releases the capture during a camera turn.
  assert.ok(lines.some((l) => /^V\|fight\|[01]$/.test(l)), 'the hit test never ran')

  // ONLY ON AN EDGE. The loop samples ~31 times a second; a second copy of an unchanged answer
  // would mean main being told to re-open a door it is already holding open, every tick, forever.
  const fight = lines.filter((l) => l.startsWith('V|fight|'))
  assert.equal(fight.length, 1, `the answer was repeated:\n${fight.join('\n')}`)
  // And it did not cost the rest of the loop anything: auto-hide's foreground/running/heartbeat
  // lanes are all still there on the same ~160 ms they always had.
  assert.ok(lines.some((l) => l.startsWith('F|')), 'the foreground window is still reported')
  assert.ok(lines.some((l) => l.startsWith('R|')), 'the running scan still runs')
  // …and the JOS-193 promise survives: the ring is off, so no `C` line was ever emitted, even
  // though the hit test read the cursor for its own reason.
  assert.deepEqual(lines.filter((l) => l.startsWith('C')), [], 'a cursor line leaked')
})

test('A WATCHER WITH NO ZONES SAYS NOTHING ABOUT ANY OF THEM', { skip: NOT_WINDOWS }, async () => {
  // The zero-cost claim, as an observation. With no rectangle held there is no hit-test block in
  // the loop at all — this is what a session with nothing pinned, or a player who has alt-tabbed
  // out of the game, actually runs.
  const init: PresenceWorkerInit = {
    ...INIT,
    watchCursor: false,
    ...watcherCadence(false),
    runningPollMs: 1
  }
  const { lines } = await runWorker(init, (l) => l.filter((x) => x === 'H').length >= 3)
  assert.deepEqual(lines.filter((l) => l.startsWith('V')), [], `a hit test ran:\n${lines.join('\n')}`)
})

test('A RETRACTED ZONE TAKES ITS ANSWER WITH IT', { skip: NOT_WINDOWS }, async () => {
  // A key whose zones simply go away must not leave main holding a capture nothing will ever end —
  // the one case where the leave line is NOT redundant with the mouse mode main re-applies itself.
  const init: PresenceWorkerInit = {
    ...INIT,
    watchCursor: false,
    ...watcherCadence(false),
    runningPollMs: 1
  }
  let retracted = false
  const { lines } = await runWorker(
    init,
    // A heartbeat AFTER the first answer, so the retraction has had ticks to be applied in. Waiting
    // for a second `V` line would hang on a machine whose pointer EverQuest is hiding: there the
    // first answer is already `0` and a retraction has nothing to withdraw.
    (l) => l.some((x) => x.startsWith('V|fight|')) && l.filter((x) => x === 'H').length >= 2,
    60_000,
    {
      send: [encodeHoverZones('fight', EVERYWHERE)],
      onLine: (line, post) => {
        // Retract only once the loop has actually SAMPLED. Both lines posted up front would be
        // applied back to back between two ticks, and the hit test would never have run at all.
        if (!retracted && line.startsWith('V|fight|')) {
          retracted = true
          post(encodeHoverZones('fight', []))
        }
      }
    }
  )
  const fight = lines.filter((l) => l.startsWith('V|fight|'))
  // Either way the LAST word about this key is `0`: a visible pointer was inside and the retraction
  // withdrew it, a hidden one was never inside and said so. Main is never left holding a capture.
  assert.equal(fight.at(-1), 'V|fight|0', `the retraction left an answer standing:\n${fight.join('\n')}`)
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
