// ============================================================================
// presence.ts — the WATCHER: one long-running thread, and the state it maintains.
// ============================================================================
//
// Two features need the same four facts — is EQ running, is EQ the foreground window, where is
// that window, and is the system cursor being drawn — so they are answered ONCE, here:
//
//   * overlay AUTO-HIDE (hide the floating meters when the game isn't running / isn't focused)
//   * the CURSOR RING (a halo drawn only over the EQ window, only while it is focused)
//
// THE COST MODEL IS THE DESIGN. Windows has no cross-process "foreground window changed" event
// an Electron main process can subscribe to without native code, so somebody has to poll. The
// naive shape — a `setInterval` on this thread — is not free either: the running scan is 8.4 ms
// of `EnumProcesses` (measured; see presenceProtocol.ts's cadence section), and main is the
// thread that tails the log and runs the ring's 8 ms sampler. So the polling happens SOMEWHERE
// ELSE and main only folds what it is told.
//
// IT USED TO BE A `powershell.exe` CHILD, AND THAT IS WHAT JOS-182 REMOVED. The old watcher was
// spawned with `-ExecutionPolicy Bypass -EncodedCommand <base64>` and compiled a C# P/Invoke
// surface at runtime with `Add-Type`. Two things were wrong with it and only one of them was
// visible from here:
//
//   * to a behavioural antivirus engine that is a textbook infostealer (hidden PowerShell,
//     encoded command, policy bypass, runtime compile, process enumeration, window-title reads),
//     and this app was the most-flagged thing its author had ever shipped;
//   * 578 `spawn powershell.exe ENOENT` errors across two cohorts — installs where PowerShell is
//     absent, renamed or blocked, and where these two features therefore never worked at all.
//
// The replacement is a WORKER THREAD (`presenceWorker.ts`) calling user32/kernel32/psapi through
// koffi (`presenceNative.ts`). No process is spawned, nothing is compiled, and nothing about the
// contract below changed: it is still started lazily (only when a feature that needs it is
// switched on — see `presenceNeeded` in shared/presencePrefs.ts), it still polls at ~150 ms and
// still speaks ONLY when something CHANGES, and it is still stopped the moment the last consumer
// goes away. Never started in e2e (`EQ_E2E=1`) or off Windows.
//
// THE PURE HALF — the line protocol, the EQ-window predicate, the alt-tab debounce and the
// gating matrix — lives in `presenceProtocol.ts` (the security.ts ↔ windows.ts split), which is
// what `tests/presence.test.mts` drives with no Electron in sight. `presenceEffects.ts` is what
// ACTS on any of it; this file only knows facts.

import { join } from 'path'
import { Worker } from 'node:worker_threads'
import { E2E } from './e2e'
import { logError, logInfo } from './errorLog'
import { notePresenceRestart } from './telemetry'
import { effectiveEqRoot } from './log/config'
import {
  type PresenceRecord,
  type PresenceWorkerInit,
  type WatcherExitTrail,
  NEW_WATCHER_EXIT_TRAIL,
  WATCHER_HEARTBEAT_MS,
  WATCHER_STALE_MS,
  WATCHER_STOP_MESSAGE,
  eqRootPrefix,
  focusCountsAsEq,
  focusDebounceStep,
  foregroundSide,
  newFocusDebounce,
  parsePresenceLine,
  watcherCadence,
  watcherExitStep,
  watcherIsStale,
  watcherRestartDelayMs
} from './presenceProtocol'
import { INITIAL_PRESENCE } from '../shared/presencePrefs'
import type { PresenceState, ScreenRect } from '../shared/presencePrefs'
// THE ONE QUESTION THIS FILE CANNOT ANSWER FROM A WATCHER LINE (JOS-199): which of OUR windows is
// in front. Every window this process owns reports the same pid and the same image path, so the
// accessory/app split has to come from Electron. It is a QUERY — the only thing imported from the
// window module here, and nothing in this file's dependency closure reaches back into presence.
import { mainWindowFocused } from './windows'

// ------------------------------------------------------------------ the watcher thread itself

/** Process-existence cadence. "Is the game running" changes twice a session. */
const RUNNING_POLL_MS = 5000

/**
 * The built worker bundle, beside this one. electron-vite emits `out/main/presenceWorker.js` from
 * a second rollup input (electron.vite.config.ts), which is what makes `__dirname` resolve it in
 * `npm run dev` AND inside the packaged asar — the same arrangement `speechWorker.js` has used
 * since voice alerts shipped.
 */
const WORKER_PATH = join(__dirname, 'presenceWorker.js')

type Listener = (state: PresenceState) => void

const listeners = new Set<Listener>()
let watcher: Worker | null = null
let focus = newFocusDebounce(false)
let focusTimer: NodeJS.Timeout | null = null
let lastObservedFocus = false

/**
 * May the watcher look at the cursor at all? (JOS-193 — see `setCursorWatch`.)
 *
 * FALSE by default, which is the default install: the ring ships off, and this flag is only ever
 * raised by `presenceEffects.refreshPresenceEffects` reading a stored `cursorRing.enabled` of true.
 * A watcher started before anybody said otherwise therefore never calls `GetCursorInfo`.
 */
let watchCursor = false

// ---- watcher health (see presenceProtocol.ts's "watcher health" section for the WHY) --------
/** When the current watcher last said ANYTHING — seeded at start, so the library loading it does
 *  before it can speak is inside the first staleness window rather than a false positive. */
let lastSignalAt = 0
/** When the current watcher was started. Only one that has outlived a full staleness window is
 *  allowed to forgive its predecessors' failures — see `noteSignal`. */
let watcherStartedAt = 0
/** Consecutive start/exit/wedge failures; indexes the backoff schedule. */
let restartFailures = 0
let restartTimer: NodeJS.Timeout | null = null
let staleTimer: NodeJS.Timeout | null = null
/** The current watcher's last word, if it managed one (`X|native-unavailable`). Cleared at every
 *  start, so it can only ever describe the watcher whose exit is being handled. */
let lastExitReason: string | null = null
/** How many immediate-exit-shaped exits in a row, and whether the diagnosis has been written —
 *  the whole reason 245 identical error reports become three (presenceProtocol.ts, JOS-164). */
let exitTrail: WatcherExitTrail = NEW_WATCHER_EXIT_TRAIL

/**
 * How many watcher threads are wedged RIGHT NOW — asked to stop and not yet gone.
 *
 * It exists because the only safe way to end a watcher is to ask it (`WATCHER_STOP_MESSAGE`), and
 * a thread that has stopped advancing may never get around to reading the question. That is fine
 * once. The thing it must not become is a leak: the watchdog fires every 30 s and the backoff
 * ceiling is 30 s, so a machine where every watcher wedges would accumulate a thread a minute for
 * as long as the app is open.
 */
let lostWatchers = 0

/**
 * How many lost threads it takes to stop replacing them.
 *
 * THREE, for the same reason `WATCHER_QUICK_EXIT_STREAK` is three: one is an incident, and three
 * is a machine that is going to keep doing this. Past it the feature is surrendered for the
 * session — auto-hide and the ring stay in their fail-open posture, which is exactly where a
 * watcher that cannot run leaves them anyway — rather than spending a thread a minute proving it.
 */
const LOST_WATCHER_LIMIT = 3

/** Set once when `LOST_WATCHER_LIMIT` is reached, so the surrender is reported once and not on
 *  every subsequent restart attempt. */
let surrendered = false

let state: PresenceState = INITIAL_PRESENCE

/** The presence facts as of the last watcher line. Defaults are "nothing seen yet". */
export function presenceSnapshot(): PresenceState {
  return state
}

function emit(): void {
  for (const cb of listeners) {
    try {
      cb(state)
    } catch (err) {
      // One bad subscriber must not stop the others (or kill the message pump).
      logError('main:presence', err)
    }
  }
}

/** Commit a new state object and notify, but ONLY when something actually differs. */
function update(next: Partial<PresenceState>): void {
  const merged: PresenceState = { ...state, ...next }
  const same =
    merged.observed === state.observed &&
    merged.eqRunning === state.eqRunning &&
    merged.eqFocused === state.eqFocused &&
    merged.cursorVisible === state.cursorVisible &&
    sameRect(merged.eqBounds, state.eqBounds)
  if (same) return
  state = merged
  emit()
}

function sameRect(a: ScreenRect | null, b: ScreenRect | null): boolean {
  if (a === null || b === null) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * Run the debounce for the current raw observation and schedule the wake-up that will commit it
 * if the signal holds. Called on every foreground line and from the timer it sets.
 */
function applyFocus(observed: boolean): void {
  lastObservedFocus = observed
  if (focusTimer) {
    clearTimeout(focusTimer)
    focusTimer = null
  }
  const step = focusDebounceStep(focus, observed, Date.now())
  focus = step.state
  if (step.changed) update({ eqFocused: focus.committed })
  else if (step.waitMs !== null) {
    focusTimer = setTimeout(() => {
      focusTimer = null
      applyFocus(lastObservedFocus)
    }, step.waitMs)
    // A watcher timer must never be the reason the app stays alive at quit.
    focusTimer.unref?.()
  }
}

/**
 * Fold one decoded record into the state.
 *
 * THE OWN-WINDOWS RULE lives here, and since JOS-199 it has TWO answers rather than one. A
 * foreground window belonging to THIS process is still identified by `pid === process.pid` — every
 * window this app creates is owned by the main process, and the watcher is now a thread of that
 * very process, so the pid it reports for our own windows is the pid it is running under. What
 * changed is what that identification BUYS: an ACCESSORY window (an unlocked overlay being
 * dragged, the ring) is EQ-side, so "clicking your own overlay must not hide it" is still true by
 * construction; the COMPANION WINDOW is not, because a player who brings the app to the front has
 * said with a click that they are looking at something other than the game. `foregroundSide`
 * (presenceProtocol.ts) is that policy, and `mainWindowFocused()` is the only fact it needs which
 * a watcher line cannot carry.
 *
 * Bounds are updated ONLY for a genuine EQ window: our own windows can be EQ-side for the FOCUS
 * question but they are not where the game is, and the ring must not jump onto them.
 */
function applyRecord(rec: PresenceRecord): void {
  // The heartbeat is LIVENESS, not an observation. It says the loop is turning, which is exactly
  // what `noteSignal` already recorded; it deliberately does not set `observed`, because a beat
  // is not a look at the world and must never be the reason auto-hide starts acting.
  if (rec.t === 'beat') return
  // Neither is the exit line: it is a note for the log the `'exit'` handler is about to write
  // (`pumpMessage` has already kept it) and says nothing about the world.
  if (rec.t === 'exit') return
  // ANY record means we have actually looked (the watcher emits a `C`, an `F` and an `R` on its
  // very first tick, in that order — the cursor check leads because it is the one that runs on
  // every tick, JOS-120). Until then `observed:false` keeps auto-hide from acting on a default
  // that only looks like a fact — see `overlaysShouldHide`.
  if (rec.t === 'run') {
    update({ observed: true, eqRunning: rec.running })
    return
  }
  if (rec.t === 'cursor') {
    update({ observed: true, cursorVisible: rec.visible })
    return
  }
  const side = foregroundSide(
    rec,
    { pid: process.pid, appWindowFocused: mainWindowFocused() },
    effectiveEqRoot()
  )
  update(side === 'eq' ? { observed: true, eqBounds: rec.rect } : { observed: true })
  applyFocus(focusCountsAsEq(side))
}

/**
 * Note that the watcher is alive and talking. Any well-formed record counts, including a bare
 * heartbeat — the watchdog's question is "is the loop turning", not "did the world change".
 *
 * IT IS ALSO WHERE THE BACKOFF DEBT IS FORGIVEN, and the condition is the load-bearing part: a
 * watcher clears the counter only once it has run a FULL staleness window without going quiet.
 * Resetting on the first record instead would make one that dies right after its first line
 * retry at 1 s forever — a restart storm dressed up as a recovery.
 */
function noteSignal(): void {
  const now = Date.now()
  lastSignalAt = now
  if (restartFailures > 0 && now - watcherStartedAt >= WATCHER_STALE_MS) restartFailures = 0
}

/**
 * Decode one message from the watcher.
 *
 * IT IS A BOUNDARY, SO IT IS VALIDATED LIKE ONE — twice over. A `postMessage` payload is typed
 * `any` by construction, so the string check is not defensive dressing; and what is inside the
 * string still goes through `parsePresenceLine`, which is the same decoder the pipe used and has
 * the same rule: anything malformed decodes to null and moves nothing.
 *
 * A message is one record. The split survives from the pipe era because it costs nothing and a
 * future batched send needs no change here — but there are no partial lines to carry across
 * messages any more, which is one whole class of framing bug that left with the child process.
 */
function pumpMessage(chunk: unknown): void {
  if (typeof chunk !== 'string') return
  for (const line of chunk.split('\n')) {
    const rec = parsePresenceLine(line)
    if (!rec) continue
    // KEPT, NOT LOGGED HERE. The thread ends a moment later and the `'exit'` handler is the one
    // place that knows the code and the lifetime, so the reason waits there for its sentence.
    if (rec.t === 'exit') lastExitReason = rec.reason
    noteSignal()
    applyRecord(rec)
  }
}

/**
 * Fall back to "nothing known" and tell everyone.
 *
 * THIS IS THE WHOLE SAFETY PROPERTY, so it is worth stating what `INITIAL_PRESENCE` buys: with
 * `eqFocused:false` and `eqBounds:null` the ring PARKS (`cursorRingActive` needs both), and with
 * `observed:false` auto-hide fails OPEN and un-hides the overlays (`overlaysShouldHide`'s first
 * line). A presence source that has stopped being trustworthy must take the features it drives
 * with it — a frozen `eqFocused:true` is what left a halo chasing the pointer across the user's
 * browser, and a frozen `eqRunning:false` would hide every overlay forever.
 */
function resetPresence(): void {
  if (focusTimer) {
    clearTimeout(focusTimer)
    focusTimer = null
  }
  focus = newFocusDebounce(false)
  lastObservedFocus = false
  if (state === INITIAL_PRESENCE) return
  state = INITIAL_PRESENCE
  emit()
}

/**
 * Retire a watcher: ask it to stop, then unhook it so nothing it does on the way out can move any
 * state or fire any handler.
 *
 * IT ASKS RATHER THAN TERMINATES, AND THAT IS A REPRODUCED CRASH TALKING. `worker.terminate()`
 * while the thread is inside a koffi call aborts the whole process — see `WATCHER_STOP_MESSAGE`
 * in presenceProtocol.ts for the measurement. The watcher is inside a call for a fraction of a
 * percent of its life, which would have made this a rare, unattributable crash on the one path
 * every session takes: quit.
 *
 * A RETIRED WORKER STILL NEEDS AN `'error'` SINK. `'error'` is not an ordinary event: an
 * EventEmitter with no listener for it THROWS the payload, so removing the handlers wholesale
 * converts a throw inside a thread that is already being torn down from a log line into an
 * uncaught exception in the main process. This sink is terminal on purpose — this watcher is
 * already on its way out, and there is nothing left to do about it but say so.
 *
 * `wedged` is the watchdog's path, and it is counted: a thread that has stopped advancing may
 * never read the stop message either, and a watcher we cannot end is a watcher we must stop
 * REPLACING. See `LOST_WATCHER_LIMIT`.
 */
function retire(w: Worker, wedged = false): void {
  w.removeAllListeners()
  w.on('error', (err) => logError('main:presence', { message: 'retired presence watcher', err }))
  if (wedged) {
    lostWatchers++
    // It may still honour the stop when the call it is stuck in finally returns, and that is the
    // good case: a slow machine is not a lost thread, and only the exit tells them apart.
    w.once('exit', () => {
      lostWatchers--
    })
  }
  try {
    w.postMessage(WATCHER_STOP_MESSAGE)
  } catch (err) {
    // MEASURED: posting to a worker that has already exited is a silent no-op, not a throw — which
    // matters, because the exit handler retires too and a throw there would put a junk line in
    // errors.log on every ordinary stop. So this catch is for the case nobody has seen, and it
    // logs rather than swallows on the same reasoning: an unexpected refusal here means a watcher
    // that will not be asked again.
    logError('main:presence', { message: 'presence watcher would not take a stop', err })
  }
}

function clearStaleWatchdog(): void {
  if (!staleTimer) return
  clearInterval(staleTimer)
  staleTimer = null
}

/**
 * THE STALENESS WATCHDOG — the half of the fix that a dead-watcher handler cannot cover.
 *
 * A watcher that EXITS announces itself. One that WEDGES — thread alive, loop not advancing (a
 * syscall that never returned, a filter driver holding `EnumProcesses`, a suspended thread) —
 * announces nothing at all, and the only evidence is the heartbeat that stopped arriving. So:
 * check the clock, and when the channel has been silent past `WATCHER_STALE_MS`, treat the
 * watcher as gone. Reset FIRST (the state has been wrong for thirty seconds already and the
 * restart takes another moment), then retire it and restart on the same backoff an exit uses.
 *
 * The interval exists only while a watcher does, and is unref'd: it can never be the reason the
 * app stays alive at quit.
 */
function armStaleWatchdog(): void {
  clearStaleWatchdog()
  staleTimer = setInterval(() => {
    const w = watcher
    if (!w || !watcherIsStale(lastSignalAt, Date.now())) return
    logError('main:presence', {
      message: 'presence watcher went silent; assuming it is wedged and restarting',
      silentMs: Date.now() - lastSignalAt
    })
    watcher = null
    clearStaleWatchdog()
    retire(w, true)
    resetPresence()
    restartFailures++
    scheduleRestart()
  }, WATCHER_HEARTBEAT_MS)
  staleTimer.unref?.()
}

/**
 * Bring the watcher back after a failure, on a capped backoff.
 *
 * Not restarting at all was the old behavior and it is a silent, permanent feature outage: the
 * state reset made the app SAFE (overlays back, ring parked) but nothing ever looked at the game
 * again for the rest of the session. Both consumers are supposed to be always-on.
 *
 * The `listeners.size` check is what makes this respect the ref-count: a restart scheduled a
 * moment before the user turns the last feature off must not start a watcher nobody wants.
 */
function scheduleRestart(): void {
  if (restartTimer || listeners.size === 0) return
  // …unless this machine has already swallowed `LOST_WATCHER_LIMIT` threads whole. Replacing a
  // watcher that wedged is a recovery; replacing the fourth one is a thread leak with a good
  // excuse. Said ONCE — the same discipline the exit-loop fold applies to the other permanent
  // condition this feature can land in.
  if (lostWatchers >= LOST_WATCHER_LIMIT) {
    if (!surrendered) {
      surrendered = true
      logError('main:presence', {
        message:
          `${String(lostWatchers)} presence watcher threads have wedged and not stopped; not ` +
          'starting another for this session. Overlay auto-hide and the cursor ring stay in ' +
          'their fail-open posture (overlays visible, ring parked).'
      })
    }
    return
  }
  // COUNTED WHERE THE RESTART IS COMMITTED TO (JOS-96), after the guard rather than before it: a
  // call that is refused because a restart is already pending, or because nobody is listening any
  // more, did not restart anything and must not read as a health event. All three restart causes
  // (the stale-watcher watchdog, the watcher-gone handler, a failed start) funnel through here, so
  // this is the one increment site. `restartFailures` cannot serve — it is a backoff index that
  // resets to 0 on a healthy watcher.
  notePresenceRestart()
  restartTimer = setTimeout(() => {
    restartTimer = null
    if (listeners.size === 0 || watcher) return
    startWatcher()
  }, watcherRestartDelayMs(restartFailures))
  restartTimer.unref?.()
}

/**
 * The one path off the watcher, for every way it can end: a clean exit, a throw, and a thread
 * that never started. Idempotent by identity — `watcher !== w` means
 * this one has already been retired (or replaced), so a late `'exit'` after an `'error'` is a
 * no-op rather than a second restart.
 *
 * WHAT IT SAYS ABOUT THE EXIT IS `watcherExitStep`'S CALL (JOS-164), and both halves of that
 * matter. The LIFETIME rides along with the code, because "exited with 0" and "exited with 0 after
 * 900 ms, again" are different facts and only the second one is a diagnosis; and a run of those is
 * collapsed into ONE distinctly-named error rather than one entry per restart forever. The
 * fold is pure and lives beside the protocol, so the whole sequence is a unit test.
 */
function handleWatcherGone(w: Worker, code: number | null): void {
  if (watcher !== w) return
  watcher = null
  clearStaleWatchdog()
  retire(w)
  const lifetimeMs = Date.now() - watcherStartedAt
  const reason = lastExitReason
  lastExitReason = null
  // An exit while consumers remain is a real failure (the loop threw, or the native surface will
  // not load on this machine). Report it, fall back to "nothing known", and try again on the
  // backoff. With no consumers left there is nothing to report and nothing to restart, and the
  // trail is deliberately left alone: a teardown is not evidence either way.
  if (listeners.size === 0) return
  const step = watcherExitStep(exitTrail, { code, lifetimeMs, reason })
  exitTrail = step.trail
  if (step.log) logError('main:presence', step.log)
  resetPresence()
  restartFailures++
  scheduleRestart()
}

function startWatcher(): void {
  if (watcher || E2E || process.platform !== 'win32') return
  const init: PresenceWorkerInit = {
    eqRootWithSep: eqRootPrefix(effectiveEqRoot()),
    runningPollMs: RUNNING_POLL_MS,
    // Both clocks are DERIVED from the cursor gate (JOS-193): the fast tick exists for the cursor
    // call, so a watcher that will not make it asks for the coarse cadence instead.
    ...watcherCadence(watchCursor),
    watchCursor
  }
  let w: Worker
  try {
    w = new Worker(WORKER_PATH, { workerData: init })
  } catch (err) {
    logError('main:presence', { message: 'could not start the presence watcher', err })
    // A start that throws is as much a failure as an exit, and it is the one most likely to be
    // transient (a machine momentarily out of thread handles). Back off and try again — and fall
    // back to "nothing known" on the way, for the same reason an exit does: whatever is on screen
    // was decided by a watcher that no longer exists.
    resetPresence()
    restartFailures++
    scheduleRestart()
    return
  }
  watcher = w
  watcherStartedAt = Date.now()
  // Seed the silence clock at the start, not at the first line: the thread opens three system
  // libraries before it can say anything, and that quiet moment is normal.
  lastSignalAt = watcherStartedAt
  logInfo('[everquest-companion] presence watcher started')
  lastExitReason = null
  w.on('message', pumpMessage)
  w.on('error', (err) => {
    logError('main:presence', err)
    handleWatcherGone(w, null)
  })
  w.on('exit', (code) => handleWatcherGone(w, code))
  // The watcher must never be the reason the app stays alive at quit. A worker thread refs the
  // parent's event loop until it exits; `unref` gives that up, and `stopPresence()` on quit is
  // what actually ends it.
  w.unref()
  armStaleWatchdog()
}

function stopWatcher(): void {
  if (focusTimer) {
    clearTimeout(focusTimer)
    focusTimer = null
  }
  clearStaleWatchdog()
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  // A deliberate stop is not a failure — the next start deserves a clean slate, including the
  // exit trail: whatever the last run was doing, the next one gets to report it fresh.
  restartFailures = 0
  exitTrail = NEW_WATCHER_EXIT_TRAIL
  lastExitReason = null
  const w = watcher
  watcher = null
  if (!w) return
  retire(w)
  logInfo('[everquest-companion] presence watcher stopped')
  state = INITIAL_PRESENCE
  focus = newFocusDebounce(false)
  lastObservedFocus = false
}

/**
 * Say whether anything still needs the CURSOR looked at — the JOS-193 gate, and the owner's rule
 * in one call: with the ring off, this app does not touch the cursor.
 *
 * `presenceEffects.refreshPresenceEffects` is the only caller, because it is the only thing that
 * reads the prefs (`cursorWatchNeeded(getCursorRing())`), and it runs at startup and after every
 * settings write — which is the ONLY way `cursorRing.enabled` can change. That keeps the
 * store out of this file, exactly as `presenceNeeded` already does for the watcher's existence.
 *
 * A LIVE CHANGE REPLACES THE THREAD, and it has to. The flag is `workerData`, baked in when the
 * worker starts, and it is baked in rather than messaged because a `false` delivered one tick late
 * is still a tick spent in a cursor call the user switched off. A thread is a `LoadLibrary` x3 and
 * a `postMessage`; the ring's toggle is not a hot path.
 *
 * IT DOES NOT RESET THE PRESENCE STATE, and that is the difference between this and every other
 * path that ends a watcher. `resetPresence()` exists for a source that stopped being TRUSTWORTHY —
 * a thread that died or wedged, whose last words might describe a world from thirty seconds ago.
 * Here the outgoing watcher was right up to the moment it was retired and its replacement starts
 * in the same turn, re-announcing everything on its first ticks (the successor's change-detection
 * starts empty). Resetting would blink every auto-hidden overlay back on for ~160 ms because
 * somebody moved a slider in Preferences.
 */
export function setCursorWatch(enabled: boolean): void {
  if (enabled === watchCursor) return
  watchCursor = enabled
  const w = watcher
  if (!w) return
  // Take the old thread out of circulation FIRST: `handleWatcherGone` is keyed on identity, so a
  // `watcher` that is already null makes this retirement invisible to the exit handler — no error
  // entry, no backoff, no restart race with the start below.
  watcher = null
  clearStaleWatchdog()
  retire(w)
  // A deliberate replacement is not a failure and must not be counted as one.
  restartFailures = 0
  exitTrail = NEW_WATCHER_EXIT_TRAIL
  lastExitReason = null
  startWatcher()
}

/**
 * Subscribe to presence. REF-COUNTED: the first subscriber starts the watcher, the last one to
 * unsubscribe stops it. That is the whole "lazy" contract — with the ring off and both
 * auto-hide switches at a state that needs no watcher, nothing is ever started.
 *
 * The callback fires on every CHANGE (never on a repeat), and once immediately with whatever is
 * already known, so a late subscriber needs no separate hydration path.
 */
export function subscribePresence(cb: Listener): () => void {
  listeners.add(cb)
  if (listeners.size === 1) startWatcher()
  cb(state)
  let released = false
  return () => {
    if (released) return
    released = true
    listeners.delete(cb)
    if (listeners.size === 0) stopWatcher()
  }
}

/** Tear the watcher down regardless of subscribers (app quit). */
export function stopPresence(): void {
  listeners.clear()
  stopWatcher()
}

/** TEST/diagnostic seam: is a watcher alive right now? */
export function presenceWatcherRunning(): boolean {
  return watcher !== null
}
