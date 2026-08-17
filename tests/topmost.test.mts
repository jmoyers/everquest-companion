// THE Z-ORDER RE-ASSERT, AND THE ONE WINDOW THAT IS EXEMPT FROM IT (JOS-368).
//
// `setAlwaysOnTop` is a `SetWindowPos` — compositor work over a running game — and the app was
// issuing one per overlay per show, five at a time, on every alt-tab. The fix is to ask the
// window whether it still holds the style before re-stating it.
//
// (JOS-368 argued this from a sharper premise that turned out to be wrong: that the game runs in
// an EXCLUSIVE display mode, where the same call is a mode switch worth a black flash and a
// frozen second. JOS-375 established that the client's Fullscreen setting is a BORDERLESS
// fullscreen window. The guard is unchanged and so is every claim below — five calls where zero
// are needed is five too many either way — but the numbers here are a call count, never a stall.)
//
// TWO CLAIMS, and the second is the one that is easy to get wrong:
//   1. A window that still holds topmost is left alone; a window that lost it is re-asserted. The
//      hidden-window case the guard must not break is the second half of that sentence.
//   2. THE CURSOR RING IS NOT GUARDED. It shares the overlays' 'screen-saver' level, and within
//      one level the most recent assertion wins — so "already topmost" is precisely the state in
//      which the ring's raise still has work to do. A guarded ring would be a no-op forever and
//      the circle would slide behind an overlay on mouseover.
//
// The helpers are Electron-free by construction (`TopmostWindow` is structural), so this drives
// them with a fake window that records what it was told. The CALL SITES in windows.ts cannot be
// driven that way — they need a real always-on-top window stack over a real game — so they are
// pinned as source, the same bargain tests/overlayFocusPolicy.test.mts strikes for `setFocusable`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  assertTopmost,
  raiseTopmost,
  resetTopmostStatsForTests,
  topmostStats,
  type TopmostWindow
} from '../src/main/topmost'

/** A BrowserWindow as far as these helpers can tell: one style bit and a call log. */
function fakeWindow(startsTopmost: boolean): TopmostWindow & { calls: string[] } {
  const calls: string[] = []
  let topmost = startsTopmost
  return {
    calls,
    isAlwaysOnTop: () => topmost,
    setAlwaysOnTop: (flag, level) => {
      assert.equal(flag, true, 'nothing here ever turns always-on-top OFF')
      topmost = flag
      calls.push(level)
    }
  }
}

test('A WINDOW THAT STILL HOLDS TOPMOST IS NOT TOUCHED — the whole point', () => {
  resetTopmostStatsForTests()
  const w = fakeWindow(true)
  assertTopmost(w)
  assertTopmost(w)
  assert.deepEqual(w.calls, [], 'no SetWindowPos reaches the window')
  assert.deepEqual(topmostStats(), { issued: 0, avoided: 2 })
})

test('A WINDOW THAT LOST TOPMOST IS RE-ASSERTED — the case auto-hide depends on', () => {
  // A HIDDEN window can genuinely lose WS_EX_TOPMOST on Windows, which is why the re-assert in
  // `setOverlaysHidden` exists at all. The guard must not be a way of losing it.
  resetTopmostStatsForTests()
  const w = fakeWindow(false)
  assertTopmost(w)
  assert.deepEqual(w.calls, ['screen-saver'], 'and at the level the whole app uses')
  assert.deepEqual(topmostStats(), { issued: 1, avoided: 0 })
})

test('THE RING RAISE IS UNCONDITIONAL — an already-topmost window is exactly its job', () => {
  resetTopmostStatsForTests()
  const ring = fakeWindow(true)
  raiseTopmost(ring)
  raiseTopmost(ring)
  assert.deepEqual(ring.calls, ['screen-saver', 'screen-saver'])
  assert.deepEqual(topmostStats(), { issued: 2, avoided: 0 })
})

// ------------------------------------------------------------------ the call sites, as a source pin

const windows = readFileSync(new URL('../src/main/windows.ts', import.meta.url), 'utf8')

/** The body of a named top-level function, up to the next top-level `}`. */
function body(decl: string): string {
  const start = windows.indexOf(decl)
  assert.notEqual(start, -1, `${decl} not found`)
  const end = windows.indexOf('\n}', start)
  assert.notEqual(end, -1, `${decl} has no end`)
  return windows.slice(start, end)
}

test('NO BARE setAlwaysOnTop SURVIVES IN windows.ts — one door, or the guard is decorative', () => {
  // The pressure is to reach for the bare setter from whatever new show path gets written next.
  // Comments about it are welcome and do not count; only real calls do.
  const hits = windows
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && l.includes('.setAlwaysOnTop('))
    .map((l) => l.trim())
  assert.deepEqual(hits, [], `every raise goes through ./topmost.ts; found:\n${hits.join('\n')}`)
})

test('THE OVERLAY SHOW PATHS ARE GUARDED, and the ring paths are not', () => {
  for (const decl of [
    // The opaque-visibility path is now per STRIP KIND rather than per toast (JOS-378 added the
    // alert banner, whose empty window has the same problem opaque); the guard it must go through
    // is unchanged, which is the whole of what this test is about.
    'function applyOpaqueStripVisibility(',
    'export function createOverlayWindow(',
    'export function setOverlaysHidden('
  ]) {
    const fn = body(decl)
    assert.match(fn, /assertTopmost\(w\)/, `${decl} re-asserts through the guard`)
  }
  // ...and every ring path takes the unconditional spelling, including the raise that IS the
  // "ring above overlays" invariant.
  for (const decl of [
    'export function createCursorRingWindow(',
    'export function setCursorRingVisible(',
    'function raiseCursorRing('
  ]) {
    const fn = body(decl)
    assert.match(fn, /raiseTopmost\(w\)/, `${decl} raises unconditionally`)
    assert.ok(!fn.includes('assertTopmost('), `${decl} must never be guarded`)
  }
})
