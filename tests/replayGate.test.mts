// The replay gate (src/main/replayGate.ts) — "nothing rides the screen until parsing is done"
// (JOS-62), in test form.
//
// Everything asserted here is PURE: the two predicates that decide whether a window may be shown
// and what the cursor ring (window + 8 ms sampler) should be doing. No Electron, no windows, no log
// — so this suite is as cheap and as unskippable as presence/overlayLayout.
//
// THERE USED TO BE A THIRD, and its retirement is JOS-370. `overlayForwardsMouse(kind,
// replayRunning)` answered "does this kind's click-through install the WH_MOUSE_LL forwarding
// hook", and its whole job was to drop that hook for the seconds a fold owned the message loop.
// There is no hook left anywhere in the application to drop — a locked overlay is
// `setIgnoreMouseEvents(true)` with no second argument and its hover sensor is an off-thread
// cursor hit test — so the predicate is gone rather than left answering a question nobody asks.
// The tests it had are replaced, not deleted: the first one below asserts it is UNREACHABLE (a
// forwarding predicate that came back would be a system-wide mouse hook coming back with it), and
// tests/overlayLockedSelector.test.mts sweeps every source file for a second argument.
//
// The two properties worth pinning are the ones a reviewer would otherwise have to take on
// trust:
//
//   1. THE GATE ONLY EVER TAKES THINGS AWAY. `mayShowWindows` is a conjunction with the E2E flag
//      in it, so no state of the replay flag can make a window showable in the headless harness —
//      which is what makes this feature INERT under EQ_E2E=1 structurally rather than by reading
//      src/main/e2e.ts and hoping.
//   2. THE SEQUENCING ACROSS START/DONE RESTORES EXACTLY WHAT IT SUSPENDED. A replay that starts
//      and finishes must leave every predicate answering what it answered before, for every kind
//      — no lock state is copied on the way in, so nothing can be restored wrongly on the way out.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  historicalReplayRunning,
  mayShowWindows,
  ringDisposition,
  setHistoricalReplayRunning
} from '../src/main/replayGate'
import * as gate from '../src/main/replayGate'

test('mayShowWindows: E2E dominates, and the replay only ever removes a show', () => {
  assert.equal(mayShowWindows(false, false), true)
  // The whole feature: a fold in flight means no overlay and no ring on screen.
  assert.equal(mayShowWindows(false, true), false)
  // …and the harness's contract survives both states of the new flag.
  assert.equal(mayShowWindows(true, false), false)
  assert.equal(mayShowWindows(true, true), false)
})

test('THE MOUSE HALF IS RETIRED — nothing here can ask for a forwarding hook (JOS-370)', () => {
  // The module can no longer answer the question, which is the point: a predicate that still
  // answered would be one import away from putting a WH_MOUSE_LL hook back in the main process.
  assert.equal('overlayForwardsMouse' in gate, false)
  assert.equal('overlayMouseForward' in gate, false)
  // And the file still SAYS what it was for. JOS-62's report (jerky mouselook during the fold) and
  // its diagnosis are why this module exists at all; deleting the predicate without the story
  // would leave the next reader to rediscover both.
  const text = readFileSync(new URL('../src/main/replayGate.ts', import.meta.url), 'utf8')
  assert.match(text, /WH_MOUSE_LL/)
  assert.match(text, /JOS-370/)
})

test('the gate flips and restores, leaving the show decision exactly as it found it', () => {
  const before = {
    running: historicalReplayRunning(),
    mayShow: mayShowWindows(false, historicalReplayRunning())
  }
  assert.equal(before.running, false, 'nothing is replaying before a replay starts')

  setHistoricalReplayRunning(true)
  assert.equal(historicalReplayRunning(), true)
  assert.equal(mayShowWindows(false, historicalReplayRunning()), false)

  setHistoricalReplayRunning(false)
  assert.equal(historicalReplayRunning(), false)
  assert.equal(
    mayShowWindows(false, historicalReplayRunning()),
    before.mayShow,
    'the windows are back to the state they were in before the replay'
  )
})

test('ringDisposition: the 8 ms sampler gate, including the replay window', () => {
  const on = { enabled: true, hasBounds: true, active: true, focused: true, replayRunning: false }
  // The steady states this predicate already had.
  assert.equal(ringDisposition(on), 'run')
  assert.equal(ringDisposition({ ...on, active: false, focused: false }), 'idle')
  assert.equal(ringDisposition({ ...on, hasBounds: false }), 'suspended')
  assert.equal(ringDisposition({ ...on, enabled: false }), 'off')

  // JOS-62: a fold suspends the ring however active it would otherwise be — no window is created,
  // nothing is shown, and (the point) no sampler runs.
  assert.equal(ringDisposition({ ...on, replayRunning: true }), 'suspended')
  assert.equal(ringDisposition({ ...on, active: false, replayRunning: true }), 'suspended')
  // …but the user's own switch still outranks it: off is off, and the window is destroyed rather
  // than parked, replay or no replay.
  assert.equal(ringDisposition({ ...on, enabled: false, replayRunning: true }), 'off')
})

test('THE RING DOES NOT TWITCH ON CLICK: a hidden pointer parks, it does not hide (JOS-120)', () => {
  // The reported defect, as a truth table. Both rows below are "the ring is not active"; they
  // used to be the SAME state, and expressing both by hiding the window is what made the ring
  // jump on every click.
  //
  // A hidden window produces no frames, so the park that empties the halo is never composited —
  // MEASURED in Electron 43: the park's rAF did not run for the whole 600 ms the window was
  // hidden, and fired 1 ms AFTER showInactive(), by which point Windows had already re-presented
  // the last composited surface: the halo, at the pre-suppression point. Hence the split.
  const on = { enabled: true, hasBounds: true, active: true, focused: true, replayRunning: false }

  // Mouselook / any mouse button held in the world view. EverQuest still owns the screen, there
  // is simply no pointer to ring. The window MUST stay put so the park can actually be painted.
  assert.equal(
    ringDisposition({ ...on, active: false, focused: true }),
    'parked',
    'no pointer but the game still has the foreground ⇒ park in place, never hide'
  )

  // Alt-tabbed away / the game is gone. Now the window really does have to come off screen: a
  // halo over the user's browser was the bug that put the focus term in this predicate at all.
  assert.equal(
    ringDisposition({ ...on, active: false, focused: false }),
    'idle',
    'the game no longer owns the screen ⇒ the window comes off it'
  )

  // …and the two facts are asked SEPARATELY on purpose. A pointer hidden by some other app while
  // EverQuest sits in the background must still take the ring off screen — inferring the reason
  // from `active` alone would leave a transparent always-on-top window over that other app.
  assert.equal(ringDisposition({ ...on, active: false, focused: false }), 'idle')

  // A replay still outranks both: no window, no stream, whatever the pointer is doing.
  assert.equal(ringDisposition({ ...on, active: false, focused: true, replayRunning: true }), 'suspended')
})
