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
//   * EVERY `hoverEveryTicks` TICKS (~32 ms), AND ONLY WHILE MAIN HAS HANDED IT A RECTANGLE
//     (JOS-370): the hot-zone hit test that replaced the WH_MOUSE_LL mouse hook. It shares the
//     cursor read above rather than making its own — one `GetCursorInfo` per tick answers both —
//     and it says something only when a key's answer CHANGES, like every other line here. With no
//     zones held there is no hit-test block in the loop at all and the clock goes back to whatever
//     main asked for at start, so a session with no pinned overlay pays nothing for any of it.
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
import {
  loadPresenceNative,
  type ForegroundWindow,
  type MutablePoint,
  type PresenceNative
} from './presenceNative'
import {
  WATCHER_STOP_MESSAGE,
  encodeHoverTransition,
  parseHoverZones,
  pointInHoverZone,
  watcherCadence,
  type HoverZone,
  type PresenceWorkerInit
} from './presenceProtocol'

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

/**
 * THE HOT-ZONE HIT TEST (JOS-370), as a closure of its own so the loop below stays readable.
 *
 * It is the whole of what replaced the WH_MOUSE_LL mouse hook: main publishes the rectangles a
 * pinned overlay still wants the mouse in, this holds them, and one cursor point per sample decides
 * whether each key's answer moved. It owns no timer — the loop calls it — and it says something
 * only on an EDGE, like every other block in this file.
 */
function makeHover(): {
  /** The cursor, written by the loop's ONE read per tick and shared with the ring's own block. */
  readonly point: MutablePoint
  /** Is anything being watched at all? False means there is no hit test in the loop. */
  active: () => boolean
  /** One sample against every held rectangle. */
  test: (showing: boolean) => void
  /** Apply one downstream line; true when the on/off state changed and the clock must be re-armed. */
  apply: (line: string) => boolean
} {
  /** key -> the rectangles main wants watched, in physical px. EMPTY is the whole off switch. */
  const zones = new Map<string, HoverZone[]>()
  /** key -> what main was last told. Only a CHANGE crosses the wire. */
  const insideNow = new Map<string, boolean>()
  const point: MutablePoint = { x: Number.NaN, y: Number.NaN }

  function setInside(key: string, inside: boolean): void {
    if (insideNow.get(key) === inside) return
    insideNow.set(key, inside)
    say(encodeHoverTransition(key, inside))
  }

  /**
   * A HIDDEN CURSOR IS NOT A CURSOR OVER ANYTHING, and that is `cursorRingActive`'s rule arriving
   * one feature over. EverQuest hides the pointer for the duration of mouselook and re-centers it
   * every frame underneath — so a locked meter sitting anywhere near the middle of the screen would
   * otherwise take the mouse for the whole of a camera turn and stop being click-through at exactly
   * the wrong moment. Hidden reads as OUTSIDE every zone, which releases the capture.
   *
   * A cursor that could not be READ at all is the other case and gets the opposite answer: nothing
   * is said and every key keeps what it had (pointerWatch.ts's rule — an unreadable cursor is not a
   * cursor that left).
   */
  function test(showing: boolean): void {
    if (!Number.isFinite(point.x)) return
    for (const [key, rects] of zones) {
      setInside(key, showing && rects.some((z) => pointInHoverZone(point.x, point.y, z)))
    }
  }

  /**
   * A KEY THAT STOPS BEING WATCHED WHILE THE CURSOR IS INSIDE IT GETS ITS LEAVE. Main clears a
   * key's zones when its overlay unlocks, closes or parks — and in each of those main re-applies
   * the window's own mouse mode anyway, so the line is redundant there. It is sent regardless,
   * because the one case it is NOT redundant in is the one that would be invisible: a key whose
   * zones simply went away leaves main holding a capture nothing left in this loop will ever end.
   */
  function apply(line: string): boolean {
    const update = parseHoverZones(line)
    if (!update) return false
    const had = zones.size > 0
    for (const key of update.key === null ? [...zones.keys()] : [update.key]) {
      if (update.key !== null && update.zones.length > 0) {
        zones.set(key, update.zones)
        continue
      }
      zones.delete(key)
      if (insideNow.get(key) === true) setInside(key, false)
      insideNow.delete(key)
    }
    return had !== (zones.size > 0)
  }

  return { point, active: () => zones.size > 0, test, apply }
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

  /** The hot-zone hit test (JOS-370) — see `makeHover`. Inert until main sends a rectangle. */
  const hover = makeHover()
  let hoverEveryTicks = 0
  let hoverCountdown = 0

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
  function cursorBlock(showing: boolean): void {
    const cur = showing ? 1 : 0
    if (cur === lastCur) return
    lastCur = cur
    say(`C|${String(cur)}`)
  }

  function tick(): void {
    try {
      // ONE cursor read per tick, whoever wants it. The hit test rides the ring's `GetCursorInfo`
      // when the ring is on, and makes the same single call itself when it is not.
      const hoverOn = hoverEveryTicks > 0 && hover.active()
      const showing = watchCursor || hoverOn ? native.cursorShowing(hover.point) : true
      if (watchCursor) cursorBlock(showing)
      if (hoverOn) {
        hoverCountdown -= 1
        if (hoverCountdown <= 0) {
          hoverCountdown = hoverEveryTicks
          hover.test(showing)
        }
      }
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

  /**
   * (Re-)arm the loop for what it is currently watching.
   *
   * WITH NO ZONES THE CLOCK IS EXACTLY WHAT MAIN ASKED FOR AT START, untouched — `init` stays
   * authoritative, so a caller (a test, a future setting) that hands this thread a cadence keeps
   * it. With zones it is `watcherCadence(watchCursor, true)`, which is the same clock when the ring
   * is on and the middle rung when it is not (presenceProtocol.ts states both, and their costs).
   *
   * IT IS AN EDGE, NOT A PER-MESSAGE CALL. Zone rectangles are re-published whenever an overlay
   * locks, opens, parks or the game takes the foreground, and tearing down a timer for each of
   * those would be churn for a clock that did not change — so only the on/off transition re-arms.
   */
  function arm(): void {
    const c = hover.active() ? watcherCadence(watchCursor, true) : null
    hoverEveryTicks = c?.hoverEveryTicks ?? 0
    hoverCountdown = 0
    // The foreground block runs on the next tick whatever the clock just became. It is
    // change-driven, so an extra look costs one `GetForegroundWindow` and says nothing.
    fgCountdown = 0
    if (timer) clearInterval(timer)
    timer = setInterval(tick, c?.tickMs ?? tickMs)
  }

  timer = setInterval(tick, tickMs)

  // THE DELIBERATE STOP (see `WATCHER_STOP_MESSAGE` for the crash that made this a message rather
  // than a `terminate()` from main). This handler runs on the event loop, which means it runs
  // BETWEEN ticks and never inside a native call — that is the entire safety property. Clearing
  // the interval and closing the port leaves nothing holding the thread, so it ends at 0 on its
  // own. No exit line: a stop main asked for is not a failure and needs no explanation.
  //
  // …AND IT IS NOW ALSO THE DOWNSTREAM DOOR (JOS-370). Every other message on this port is a
  // hot-zone line, decoded by the same rules the upstream codec keeps: a message that is not a
  // string, or a string that is not a well-formed record, moves nothing at all.
  port?.on('message', (msg: unknown) => {
    if (msg === WATCHER_STOP_MESSAGE) {
      if (timer) clearInterval(timer)
      timer = null
      port.close()
      return
    }
    if (typeof msg === 'string' && hover.apply(msg)) arm()
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
