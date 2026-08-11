// ============================================================================
// cursorRingClick.test.mts — JOS-120: "the ring twitches on every click".
// ============================================================================
//
// THE REPORT: the cursor-ring halo moves a bit on every click and then resets onto the pointer.
//
// THE MECHANISM, and it is not the game's. EverQuest stops drawing the system pointer for as long
// as a mouse button is held in the world view, so the ring is suppressed and then un-suppressed
// on every click. Suppression used to mean `hide()`, and that is the whole bug:
//
//   A HIDDEN WINDOW PRODUCES NO FRAMES, so the park that is supposed to empty the halo is
//   received by the renderer and never painted. MEASURED (Electron 43.2.0, a transparent
//   frameless window driven by the shipping cursorRing.ts logic): with `hide()` first and the
//   park second, the park's `requestAnimationFrame` did not run for the entire 600 ms the window
//   was hidden — the pending-frame flag stayed set and the element kept the transform it had
//   before the hide. It ran 1 ms AFTER `showInactive()`, by which time Windows had already
//   re-presented the window's last composited surface: the halo, at the point the pointer
//   occupied before it vanished. Hence "moves a bit, then resets".
//
// This file is that sequence as a simulation. It models the four clocks that actually interact
// (the watcher's tick, the 8 ms sampler, the renderer's animation frame, and the compositor's
// last-surface-wins), drives them from the REAL decisions in replayGate.ts and
// presenceProtocol.ts, and asks the only question that matters: WHAT WAS ON THE SCREEN.
//
// `hideOnPark` is the pre-fix code path, kept on purpose — a repro nobody can run is a claim, and
// the first test below is what makes the second one mean something.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ringDisposition } from '../src/main/replayGate'
import {
  CURSOR_GATE_LATENCY_MS,
  CURSOR_POLL_MS,
  FOREGROUND_EVERY_TICKS,
  WATCHER_TICK_FLOOR_MS,
  cursorRingActive,
  unguardedSamplesPerHiddenCursor
} from '../src/main/presenceProtocol'
import { DEFAULT_CURSOR_RING, INITIAL_PRESENCE } from '../src/shared/presencePrefs'
import type { CursorPoint, PresenceState, ScreenRect } from '../src/shared/presencePrefs'

/** A 60 Hz panel. The compositor produces a frame this often — and ONLY while the window is
 *  visible, which is the fact the whole defect turns on. */
const FRAME_MS = 16

/** presenceEffects.ts's PARKED. Off-screen by construction: a parked halo is an absent one. */
const PARKED: CursorPoint = { x: -9999, y: -9999 }
const isParked = (p: CursorPoint | null): boolean => p !== null && p.x === PARKED.x

const EQ: ScreenRect = { x: 0, y: 0, width: 2560, height: 1440 }

/** Where the pointer is, and whether Windows is drawing one, at time t. */
interface World {
  cursorAt: (t: number) => CursorPoint
  pointerDrawn: (t: number) => boolean
}

/** One millisecond of what the user could actually see: the halo's composited position, or null
 *  when the ring window is not on screen at all. */
interface Screenshot {
  t: number
  halo: CursorPoint | null
}

/** The two shipped-before numbers, kept so the repro is the OLD pipeline and not a caricature of
 *  it: one 150 ms tick carried the cursor gate as well as the foreground scan. */
const BEFORE = { hideOnPark: true, gateTickMs: 150 }
const AFTER = { hideOnPark: false, gateTickMs: WATCHER_TICK_FLOOR_MS }

/**
 * Run the whole pipeline for `ms` milliseconds.
 *
 * `hideOnPark` selects the pre-JOS-120 behavior (every inactive state hid the window). With it
 * false the fold asks `ringDisposition`, exactly as presenceEffects.ts does. `gateTickMs` is how
 * often the watcher child looks at `CURSOR_SHOWING`.
 */
/** Everything the four clocks share. One mutable bag so each clock can be its own small
 *  function — the alternative is one `simulate` nobody can follow. */
interface Rig {
  now: number
  hideOnPark: boolean
  state: PresenceState
  // --- main ---
  streaming: boolean
  lastSent: CursorPoint | null
  // --- the ring window ---
  visible: boolean
  /**
   * When it was last mapped. A SHOW PUTS THE LAST COMPOSITED SURFACE BACK ON SCREEN and the
   * renderer's next frame replaces it — measured at ~1 ms of renderer latency plus a frame, which
   * this models as "no frame can be produced in the same instant the window appears". Without
   * this term the simulation would show a window that repaints itself before anyone can see it,
   * and the whole defect would be invisible here exactly as it was invisible in review.
   */
  visibleSince: number
  // --- the renderer (cursorRing.ts: one variable, one boolean, newest point wins) ---
  latest: CursorPoint | null
  queued: boolean
  /** What the compositor is showing. SURVIVES a hide — that is the stale surface. */
  composited: CursorPoint | null
}

const RING = { ...DEFAULT_CURSOR_RING, enabled: true }

function send(r: Rig, p: CursorPoint): void {
  if (r.lastSent && r.lastSent.x === p.x && r.lastSent.y === p.y) return
  r.lastSent = p
  r.latest = p
  r.queued = true
}

/** presenceEffects.ts's `applyRing`, minus the parts that need a real window. */
function applyRing(r: Rig): void {
  const disposition = ringDisposition({
    enabled: RING.enabled,
    hasBounds: r.state.eqBounds !== null,
    active: cursorRingActive(r.state, RING),
    focused: r.state.eqFocused,
    replayRunning: false
  })
  if (disposition === 'run') {
    if (!r.visible) {
      r.visible = true
      r.visibleSince = r.now
    }
    if (!r.streaming) {
      r.streaming = true
      r.lastSent = null // startStream(): a fresh stream owes the renderer an unconditional point
    }
    return
  }
  r.streaming = false
  if (disposition === 'parked' && !r.hideOnPark) {
    // parkRingInPlace(): empty the halo and LEAVE THE WINDOW VISIBLE, so the park reaches a frame.
    send(r, PARKED)
    return
  }
  // suspendCursorStream(): park, and only THEN hide. Pre-fix this ran for 'parked' too, and
  // pre-fix the hide came first — either way the park never got a frame.
  if (r.hideOnPark) r.visible = false
  send(r, PARKED)
  r.visible = false
}

/** One 8 ms sample. Reads the pointer whatever it is doing — it has no other source of truth. */
function sample(r: Rig, world: World): void {
  const p = world.cursorAt(r.now)
  const x = p.x - EQ.x
  const y = p.y - EQ.y
  const inside = x >= 0 && y >= 0 && x <= EQ.width && y <= EQ.height
  send(r, inside ? { x, y } : PARKED)
}

function simulate(
  world: World,
  ms: number,
  { hideOnPark, gateTickMs }: { hideOnPark: boolean; gateTickMs: number }
): Screenshot[] {
  const r: Rig = {
    now: 0,
    hideOnPark,
    state: {
      ...INITIAL_PRESENCE,
      observed: true,
      eqRunning: true,
      eqFocused: true,
      eqBounds: EQ,
      cursorVisible: world.pointerDrawn(0)
    },
    streaming: false,
    lastSent: null,
    visible: false,
    visibleSince: -1,
    latest: null,
    queued: false,
    composited: null
  }
  applyRing(r)

  const shots: Screenshot[] = []
  for (let t = 0; t <= ms; t++) {
    r.now = t
    // THE WATCHER. One `GetCursorInfo` per tick; a change re-runs the whole fold.
    if (t % gateTickMs === 0 && world.pointerDrawn(t) !== r.state.cursorVisible) {
      r.state = { ...r.state, cursorVisible: world.pointerDrawn(t) }
      applyRing(r)
    }
    if (r.streaming && t % CURSOR_POLL_MS === 0) sample(r, world)
    // THE FRAME. Produced only while the window is visible — the load-bearing measured fact —
    // and never in the same instant it is mapped, which is the window the stale surface shows in.
    if (t % FRAME_MS === 0 && r.queued && r.visible && t > r.visibleSince) {
      r.queued = false
      r.composited = r.latest
    }
    shots.push({ t, halo: r.visible ? r.composited : null })
  }
  return shots
}

// A click: press at A, EverQuest hides the pointer and re-centres it to C for the duration, and
// on release the pointer is drawn again at B (the hand moved while the game had it).
const A: CursorPoint = { x: 1000, y: 700 }
const C: CursorPoint = { x: 1280, y: 720 }
const B: CursorPoint = { x: 1040, y: 690 }
const DOWN = 1000
const UP = 1120

const CLICK: World = {
  cursorAt: (t) => (t < DOWN ? A : t < UP ? C : B),
  pointerDrawn: (t) => t < DOWN || t >= UP
}

/** Every position the halo was actually composited at, in order, ignoring parked (= invisible)
 *  and ignoring a window that is off screen. */
function haloPositions(shots: Screenshot[], from = 0): CursorPoint[] {
  const seen: CursorPoint[] = []
  for (const s of shots) {
    if (s.t < from || s.halo === null || isParked(s.halo)) continue
    const last = seen[seen.length - 1]
    if (!last || last.x !== s.halo.x || last.y !== s.halo.y) seen.push(s.halo)
  }
  return seen
}

test('THE REPRO: the old suppression put the halo back where the pointer used to be', () => {
  // This is the twitch, reproduced. It is here so that the assertion in the next test is a fix
  // for something rather than a description of nothing.
  const shots = simulate(CLICK, 1400, BEFORE)

  // While the pointer was hidden the ring chased the re-centred point — it was still streaming,
  // because the gate had not closed yet.
  const during = haloPositions(shots.filter((s) => s.t >= DOWN && s.t < UP))
  assert.ok(
    during.some((p) => p.x === C.x && p.y === C.y),
    'the ring painted the pointer EverQuest had already hidden and moved'
  )

  // …and then the window was hidden with an unpainted park, so showing it again re-presented the
  // stale surface: the halo, at the point it held before the click.
  const after = haloPositions(shots, UP)
  assert.ok(
    after.some((p) => p.x === C.x && p.y === C.y),
    'THE TWITCH: after the pointer came back, the halo was on screen at a point from the ' +
      'suppressed period before it snapped onto the real cursor'
  )
  assert.deepEqual(after[after.length - 1], B, 'it did settle on the truth — hence "resets"')
})

test('AFTER THE FIX: a click composites no halo that is not the live pointer (JOS-120)', () => {
  const shots = simulate(CLICK, 1400, AFTER)

  // Nothing from the suppressed period, and nothing from before it, is ever shown again: the
  // window is never hidden for a click, so the park is composited on the very next frame and the
  // halo is simply absent until a fresh sample arrives.
  const after = haloPositions(shots, UP)
  for (const p of after) {
    assert.deepEqual(
      p,
      B,
      `the halo was composited at ${p.x},${p.y} after the pointer returned — the only ` +
        'position the user may see is the live pointer'
    )
  }
  assert.ok(after.length > 0, 'and the ring does come back — suppression is not a one-way door')

  // The window itself never leaves the screen: 'parked' is not 'idle'. If this flips, the stale
  // surface is back and so is the twitch.
  assert.equal(
    shots.filter((s) => s.t >= DOWN && s.t <= UP && s.halo === null).length,
    0,
    'the ring window stays put while the game still owns the screen; only the halo goes away'
  )

  // The halo IS empty for the whole press — parked, composited, honest.
  const during = haloPositions(shots.filter((s) => s.t >= DOWN + CURSOR_GATE_LATENCY_MS && s.t < UP))
  assert.deepEqual(during, [], 'once the gate closes there is no halo at all, not a stale one')
})

test('the gate that stops the ring is observed faster than the ring can be drawn (JOS-120)', () => {
  // The second half of the defect: `cursorVisible` gates an 8 ms consumer, and it used to be read
  // on the same 150 ms tick as the expensive foreground scan — so a whole mouse click could pass
  // without the gate ever looking, and the ring tracked a pointer nobody could see for ~19
  // samples. Splitting the loop is what makes the number below small.
  assert.equal(
    unguardedSamplesPerHiddenCursor(150, CURSOR_POLL_MS),
    19,
    'the shipped-before cadence, stated so the improvement is a number and not an adjective'
  )
  assert.ok(
    unguardedSamplesPerHiddenCursor(CURSOR_GATE_LATENCY_MS, CURSOR_POLL_MS) <= 4,
    'the gate must close inside one display frame’s worth of samples'
  )
  // The cheap half runs every tick; the expensive half keeps the ~150 ms cadence alt-tab needs.
  assert.ok(FOREGROUND_EVERY_TICKS > 1, 'the loop is SPLIT — folding it back reinstates the bug')
  const foregroundMs = WATCHER_TICK_FLOOR_MS * FOREGROUND_EVERY_TICKS
  assert.ok(
    foregroundMs >= 120 && foregroundMs <= 200,
    `foreground scans every ${foregroundMs} ms — the band alt-tab has always felt instant in`
  )
})
