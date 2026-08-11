// OFF MEANS WE NEVER TOUCH THE CURSOR (JOS-193 — owner ruling 2026-08-10, from report
// 01KZPEK72BFZNG719NKZ22NSH7: a Yolomouse cursor would not glow while this app was running).
//
// The ring stays. What changes is what the app does when the ring is switched OFF, which is the
// state every install ships in: nothing of ours reads, polls or draws over the cursor, so a
// third-party cursor tool is working against an app that is not in the room.
//
// THE DEFAULT INSTALL IS THE WHOLE CASE, and it is why "the ring is off, so obviously nothing
// runs" was not already true. Overlay auto-hide ships ON, so `presenceNeeded` is true and the
// watcher thread exists on a default install — and that watcher read `GetCursorInfo` ~69 times a
// second to maintain `cursorVisible`, a fact whose only consumer in the entire application is
// `cursorRingActive`, for a ring that was never going to be drawn.
//
// THE APP HAS EXACTLY TWO CURSOR CALLS, and this file is the map of both plus the wiring that
// gates them:
//
//   1. `GetCursorInfo` — declared once in presenceNative.ts, called once from the WATCHER THREAD
//      (presenceWorker.ts). Gated by `PresenceWorkerInit.watchCursor`, which comes from
//      `cursorWatchNeeded(cursorRing)`. Pinned BEHAVIOURALLY by tests/presenceWorker.test.mts,
//      which runs the real worker with the gate down and proves it never emits a cursor record.
//   2. `screen.getCursorScreenPoint()` — called once, from `sampleCursor` in presenceEffects.ts,
//      which runs only from the interval `startStream` creates, which runs only on
//      `ringDisposition === 'run'`. `!enabled ⇒ 'off'` is stated exhaustively below.
//
// SO WHY A SOURCE PIN FOR THE REST. The predicates are pure and tested; the DELIVERY is three
// assignments across three files that nothing else can observe — `refreshPresenceEffects` needs
// Electron, a store and a worker thread to run at all, and the thing being protected is precisely
// that the call is still there and still made with the right argument. That is the same bargain
// tests/overlayLockedSelector.test.mts strikes for the mouse-forwarding wiring, for the same
// reason.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ringDisposition } from '../src/main/replayGate'
import {
  FOREGROUND_EVERY_TICKS,
  WATCHER_TICK_FLOOR_MS,
  WATCHER_TICK_MS,
  cursorRingActive,
  overlaysShouldHide,
  watcherCadence
} from '../src/main/presenceProtocol'
import {
  DEFAULT_CURSOR_RING,
  INITIAL_PRESENCE,
  cursorWatchNeeded
} from '../src/shared/presencePrefs'
import type { PresenceState } from '../src/shared/presencePrefs'

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

const BOUNDS = { x: 0, y: 0, width: 1920, height: 1080 }

/** A presence snapshot the watcher HAS reported, with the game live and in front. */
const LIVE: PresenceState = {
  observed: true,
  eqRunning: true,
  eqFocused: true,
  eqBounds: BOUNDS,
  cursorVisible: true
}

/** Every combination of the four facts that are NOT the feature switch. */
const OTHER_FACTS = [false, true].flatMap((hasBounds) =>
  [false, true].flatMap((active) =>
    [false, true].flatMap((focused) =>
      [false, true].map((replayRunning) => ({ hasBounds, active, focused, replayRunning }))
    )
  )
)

// ------------------------------------------------------------- (2) main's own cursor sampler

test('THE RING WINDOW AND THE 8 ms SAMPLER ARE OFF TOGETHER, on every other fact', () => {
  // 'off' is the only disposition that destroys the window and stops the stream, and it is also
  // the only one `enabled:false` can reach. Exhaustive over the other four inputs: no combination
  // of a focused game, known bounds, a live pointer or a replay can talk the app into creating a
  // ring window or calling `screen.getCursorScreenPoint()`.
  for (const facts of OTHER_FACTS) {
    assert.equal(ringDisposition({ enabled: false, ...facts }), 'off', JSON.stringify(facts))
  }
  assert.equal(DEFAULT_CURSOR_RING.enabled, false, 'and that is the shipped default')
})

// ------------------------------------------------------------------ (1) the watcher's own call

test('THE CURSOR IS POLLED ONLY FOR THE RING — and the ring ships OFF', () => {
  assert.equal(
    cursorWatchNeeded(DEFAULT_CURSOR_RING),
    false,
    'the default install starts a watcher (auto-hide) that never looks at the cursor'
  )
  assert.equal(cursorWatchNeeded({ ...DEFAULT_CURSOR_RING, enabled: true }), true)

  // The claim the predicate rests on, stated where it can rot loudly: `cursorVisible` has exactly
  // ONE consumer, and it is the ring. If a future feature reads it, this is the assertion that has
  // to be argued with first.
  const on = { ...DEFAULT_CURSOR_RING, enabled: true }
  assert.equal(cursorRingActive({ ...LIVE, cursorVisible: false }, on), false)
  assert.equal(cursorRingActive({ ...LIVE, cursorVisible: true }, on), true)

  // Auto-hide is the OTHER consumer of the watcher, and it is blind to the cursor by construction —
  // which is what makes "the default install needs a watcher but not a cursor" true rather than
  // merely convenient.
  const bothOn = { hideWhenNotRunning: true, hideWhenUnfocused: true }
  for (const p of [LIVE, { ...LIVE, eqRunning: false, eqFocused: false }, INITIAL_PRESENCE]) {
    assert.equal(
      overlaysShouldHide({ ...p, cursorVisible: false }, bothOn),
      overlaysShouldHide({ ...p, cursorVisible: true }, bothOn),
      'auto-hide reads the same answer with the cursor hidden and shown'
    )
  }
})

test('THE FAST TICK EXISTS FOR THE CURSOR CALL, so a watcher without one asks for the coarse clock', () => {
  // The split cadence costs 0.19-0.31 % of a core against 0.06-0.16 % for the single one
  // (presenceProtocol.ts's cadence section). It buys a gate that closes inside one display frame,
  // which is worth every bit of it FOR THE RING and worth nothing at all without one: 9 ticks in
  // 10 would fire only to decrement a counter. So the default install gets the cheap loop back.
  assert.deepEqual(watcherCadence(true), {
    tickMs: WATCHER_TICK_MS,
    foregroundEveryTicks: FOREGROUND_EVERY_TICKS
  })
  const off = watcherCadence(false)
  assert.equal(off.foregroundEveryTicks, 1, 'one tick per foreground block — there is nothing else')
  assert.equal(
    off.tickMs,
    WATCHER_TICK_FLOOR_MS * FOREGROUND_EVERY_TICKS,
    'and it asks for the period ten floor-ticks measured at anyway (~160 ms)'
  )
  // The foreground/alt-tab cadence is the one thing that must NOT move: auto-hide is the feature
  // still running, and it is judged on how fast an overlay reacts to an alt-tab. The ring-on loop
  // reaches ~160 ms as ten ticks of `setInterval(1)`, which MEASURES at the 15.6 ms Windows quantum
  // (`WATCHER_TICK_FLOOR_MS`); the ring-off loop asks for that product directly. Same period, one
  // timer callback instead of ten.
  const on = watcherCadence(true)
  assert.equal(
    off.tickMs * off.foregroundEveryTicks,
    WATCHER_TICK_FLOOR_MS * on.foregroundEveryTicks,
    'same ~160 ms between foreground scans, either way'
  )
})

// ----------------------------------------------------------------------------- the wiring

test('THE WATCHER IS TOLD BEFORE IT EXISTS — the gate is set ahead of subscribePresence', () => {
  const effects = src('../src/main/presenceEffects.ts')
  // ONE reader of the pref for this purpose, and it hands the predicate's answer straight over.
  assert.equal((effects.match(/setCursorWatch\(/g) ?? []).length, 1)
  assert.match(effects, /setCursorWatch\(cursorWatchNeeded\(ring\)\)/)
  // ORDER IS THE POINT. `subscribePresence` is what starts the first watcher of a session, and a
  // gate set after it would leave a window in which a default install polls the cursor. Both calls
  // live in `refreshPresenceEffects`, so their positions in the file are their order.
  assert.ok(
    effects.indexOf('setCursorWatch(') < effects.indexOf('subscribePresence(onPresence)'),
    'the cursor gate is set before the watcher can be started'
  )
})

test('THE GATE IS BAKED INTO THE THREAD, and a live toggle replaces the thread', () => {
  const presence = src('../src/main/presence.ts')
  // `watchCursor` reaches the worker as workerData, alongside the cadence it implies.
  assert.match(presence, /\.\.\.watcherCadence\(watchCursor\)/)
  assert.ok(/watchCursor\r?\n\s*\}/.test(presence), 'and the flag itself rides the same init')
  // The live half: changing the answer ends the running watcher and starts a replacement. Without
  // it, turning the ring off would leave a thread polling the cursor until the next launch.
  assert.match(presence, /export function setCursorWatch\(enabled: boolean\): void \{/)
  assert.match(presence, /if \(enabled === watchCursor\) return/)
  assert.ok(
    presence.indexOf('retire(w)', presence.indexOf('export function setCursorWatch')) > 0,
    'the outgoing watcher is retired, not left running beside its replacement'
  )
})

test('THE WORKER SKIPS THE BLOCK, rather than calling and discarding', () => {
  const worker = src('../src/main/presenceWorker.ts')
  // ONE call site, inside the guarded block — a `cursorShowing()` anywhere else in the loop would
  // be a cursor read the setting cannot switch off.
  assert.equal((worker.match(/native\.cursorShowing\(\)/g) ?? []).length, 1)
  assert.match(worker, /if \(watchCursor\) cursorBlock\(\)/)
  // …and the surface still declares exactly one cursor call for the whole application.
  const native = src('../src/main/presenceNative.ts')
  assert.equal((native.match(/GetCursorInfo\(/g) ?? []).length, 2, 'the binding and its one call')
})
