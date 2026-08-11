// ============================================================================
// presenceWorker.ts — the watcher's ENTIRE program, on a worker thread.
// ============================================================================
//
// This is the file JOS-164 cut `presenceWatcherScript.ts` out of the tree to create, one
// language later. That module held the loop below as a PowerShell STRING, so that a node test
// could at least read it; this one is ordinary TypeScript that a node test can IMPORT and a
// debugger can step through, and the whole class of defect that ticket existed for — a bug
// living in a template literal for four releases because nothing in the suite could execute a
// line of it — is gone rather than mitigated.
//
// WHY A THREAD AND NOT A TIMER ON MAIN. The measurement is in presenceProtocol.ts's cadence
// section and it is one number: the running scan costs 8.4 ms, because `EnumProcesses` walks the
// machine's whole process table. Main is the thread that tails the log, folds combat, answers
// IPC and runs the ring's 8 ms cursor sampler. It does not get to stall for 8 ms every five
// seconds. The old `powershell.exe` child had this property for free by being a process at all,
// and it is the only property of that child worth keeping.
//
// WHAT IT SAYS AND WHEN — the protocol is `presenceProtocol.ts`'s, unchanged from the pipe:
//
//   * EVERY TICK (~14 ms): the cursor check, alone. One `GetCursorInfo`, no allocation, no
//     string work. This gates main's 8 ms cursor sampler, so its latency is the ring's honesty
//     (JOS-120) — see that ticket's note on why it does not ride the slower block. IT IS ALSO
//     CONDITIONAL (JOS-193): with `watchCursor:false` there is no cursor block at all, and this
//     loop then runs on ONE coarse cadence (`watcherCadence`) because the fast tick existed for
//     that call and nothing else.
//   * EVERY `foregroundEveryTicks` TICKS (~150 ms): the foreground window, with its image path
//     memoized per pid.
//   * EVERY `runningPollMs` (5 s): the process scan, and the heartbeat.
//
// Every line is printed ONLY when it differs from the last one of its kind — except the
// heartbeat, which is unconditional and is the only thing separating a healthy idle watcher from
// a wedged one.
//
// NOTHING HERE THROWS ITS WAY OUT OF THE LOOP unless it has to. The native calls answer in a
// failure direction rather than raising (presenceNative.ts's header spells each one out), which
// is the same posture the PowerShell had with `$ErrorActionPreference = 'SilentlyContinue'`:
// this watcher's job is a best-effort answer about a machine it does not own, not to be right
// about every process on it. The two things it will not paper over are stated at the bottom.

import { parentPort, workerData } from 'node:worker_threads'
import { loadPresenceNative, type ForegroundWindow, type PresenceNative } from './presenceNative'
import { WATCHER_STOP_MESSAGE, type PresenceWorkerInit } from './presenceProtocol'

const init = workerData as PresenceWorkerInit
const port = parentPort

/**
 * How many consecutive ticks may throw before the watcher gives up and says so.
 *
 * It is not zero, because one throw can be a transient — a window that vanished between two
 * calls, a driver that was reloading. It is not large either: a surface that has started raising
 * is not going to be talked out of it, and a watcher that raises on every tick and swallows it is
 * a loop burning a core to learn nothing. Five ticks is under a tenth of a second, which is short
 * enough that the failure reaches the error log as a fact rather than as a mystery.
 */
const MAX_CONSECUTIVE_FAULTS = 5

function say(line: string): void {
  port?.postMessage(line)
}

/** The whole loop, once the surface is known to work. */
function run(native: PresenceNative): void {
  const { eqRootWithSep, runningPollMs, tickMs, foregroundEveryTicks, watchCursor } = init
  /** pid -> image path, for the ~31 foreground scans between beats. */
  let paths = new Map<number, string>()
  let lastFg = ''
  let lastRun = -1
  let lastCur = -1
  let nextRun = 0
  let fgCountdown = 0
  let faults = 0
  let timer: NodeJS.Timeout | null = null

  /** No foreground window at all (a locked session, a switch in flight) reads as pid 0 with an
   *  empty rectangle rather than being withheld: `isEqWindow` declines that, which is the right
   *  answer, and withholding it would leave `eqFocused` stuck on whatever was in front before the
   *  screen locked. */
  const NO_WINDOW: ForegroundWindow = { pid: 0, x: 0, y: 0, width: 0, height: 0, title: '' }

  function foregroundBlock(): void {
    const fg = native.foreground() ?? NO_WINDOW
    if (!paths.has(fg.pid)) {
      // Bounded so a machine churning through pids cannot grow this without limit between beats.
      if (paths.size > 256) paths = new Map()
      paths.set(fg.pid, native.imagePath(fg.pid))
    }
    const line = [
      'F',
      fg.pid,
      fg.x,
      fg.y,
      fg.width,
      fg.height,
      paths.get(fg.pid) ?? '',
      // The title is LAST because it is the only field that may contain anything, `|` included —
      // but NOT a line break, which would split one record into two on the way through the codec.
      fg.title.replace(/[\r\n]/g, ' ')
    ].join('|')
    if (line !== lastFg) {
      lastFg = line
      say(line)
    }
  }

  function runningBlock(): void {
    // The pid -> image-path memo is dropped on every beat rather than only when it grows past 256
    // entries. Windows RECYCLES pids, and an entry that outlives its process is not stale data, it
    // is WRONG data: the browser that inherits a departed eqgame.exe's pid would be handed
    // eqgame's path and classified as the game. Five seconds bounds that window.
    paths = new Map()
    // -1 means the enumeration failed, which is not the same fact as "the game is not running":
    // hold the last answer rather than announcing a disappearance nobody observed.
    const running = native.eqRunning(eqRootWithSep)
    if (running >= 0 && running !== lastRun) {
      lastRun = running
      say(`R|${String(running)}`)
    }
    // THE HEARTBEAT, and the only line sent unconditionally. Everything else is change-driven, so
    // a healthy idle watcher is indistinguishable from a wedged one on the channel alone — see
    // presenceProtocol.ts's note. One line per beat is what buys main that distinction.
    say('H')
  }

  /**
   * The cursor block. EVERY TICK, and deliberately alone up at the top of `tick` (JOS-120).
   *
   * THE ONE `GetCursorInfo` IN THE APPLICATION, and therefore the one place the guard has to be
   * (JOS-193). `watchCursor` is a constant for the life of this thread, so the branch is decided
   * once by the caller rather than re-asked 69 times a second — with the ring off there is no
   * cursor block in the loop at all, which is a stronger statement than "the call is skipped": the
   * app is not in the cursor's message flow, and a tool like Yolomouse has nothing to share it
   * with. `presence.ts` replaces the whole thread when the setting moves.
   */
  function cursorBlock(): void {
    const cur = native.cursorShowing() ? 1 : 0
    if (cur === lastCur) return
    lastCur = cur
    say(`C|${String(cur)}`)
  }

  function tick(): void {
    try {
      if (watchCursor) cursorBlock()
      fgCountdown -= 1
      if (fgCountdown <= 0) {
        fgCountdown = foregroundEveryTicks
        // ---- everything below runs on the ORIGINAL ~150 ms cadence, not the fast tick ----
        foregroundBlock()
        const now = Date.now()
        if (now >= nextRun) {
          nextRun = now + runningPollMs
          runningBlock()
        }
      }
      faults = 0
    } catch {
      faults += 1
      if (faults < MAX_CONSECUTIVE_FAULTS) return
      // A surface that raises on every call is not a surface. Say why, stop the loop, and let
      // main's backoff decide when to try again — and let its exit-loop fold decide whether this
      // machine has been telling us the same thing for the last five minutes.
      if (timer) clearInterval(timer)
      timer = null
      stop('native-failing')
    }
  }

  timer = setInterval(tick, tickMs)

  // THE DELIBERATE STOP (see `WATCHER_STOP_MESSAGE` for the crash that made this a message rather
  // than a `terminate()` from main). This handler runs on the event loop, which means it runs
  // BETWEEN ticks and never inside a native call — that is the entire safety property. Clearing
  // the interval and closing the port leaves nothing holding the thread, so it ends at 0 on its
  // own. No exit line: a stop main asked for is not a failure and needs no explanation.
  port?.on('message', (msg: unknown) => {
    if (msg !== WATCHER_STOP_MESSAGE) return
    if (timer) clearInterval(timer)
    timer = null
    port.close()
  })
}

/**
 * The watcher's last word, and then nothing.
 *
 * `close()` AFTER `postMessage()` still delivers what was posted — the message is already in
 * main's queue by then — and closing the port is what lets the thread's event loop drain and the
 * worker exit cleanly with code 0. That is the exit shape `watcherExitStep` recognises, which is
 * how a permanent condition becomes one error-store entry instead of one per restart.
 * `tests/presenceWorker.test.mts` runs the real worker to prove the reason arrives before the
 * exit does.
 */
function stop(reason: string): void {
  say(`X|${reason}`)
  port?.close()
}

// ---- the one failure that is not a tick ----------------------------------------------------
//
// THE SURFACE EITHER LOADS OR IT DOES NOT, and it is decided once, here. A missing `psapi.dll`, a
// Wine prefix without an export, a koffi binary this machine will not map: all of them raise out
// of `loadPresenceNative()`, and every one of them is PERMANENT for this session. So the watcher
// says which and stops, instead of pretending a retry could help. Main will restart it on the
// backoff anyway — it cannot know the condition is permanent — and the exit-loop fold in
// presenceProtocol.ts is what turns that unavoidable repetition into ONE error-store entry
// instead of one every thirty seconds for the rest of the day (JOS-164's lesson, re-earned).
try {
  run(loadPresenceNative())
} catch {
  stop('native-unavailable')
}
