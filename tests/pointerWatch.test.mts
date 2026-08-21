// THE CURSOR WATCHDOG, AND THE PRICE IT IS ALLOWED TO COST (JOS-381).
//
// THE REPORT (owner, hands-on, 2026-08-16): "the unlock button on the overlay properly unshows
// itself when you mouse off normally, but when you have the operating system alt-tab menu open,
// and you mouse over the overlays while it's still open, mouse-off never fires and the unlock
// buttons stay open permanently until you mouse in again."
//
// A locked overlay's hover sensor is a FORWARDED mouse move; the moment it captures, the only
// things that can release it are events the task switcher is busy swallowing. So main watches the
// cursor for it. The decision is src/main/pointerWatch.ts — electron-free on purpose, the bargain
// topmost.ts strikes — and this file drives it directly.
//
// AND THE SECOND HALF OF THIS FILE IS THE PERFORMANCE CONTRACT, because the owner's rule
// (2026-08-16, the JOS-363..372 hitch program) is the harder half of the ticket: "be careful with
// performance implications regarding the hover watchdog - we've done a lot of work to make it not
// hurt global mouse performance." A watchdog that fixes the stuck pin and costs the game a hitch
// is not a fix. Three of the five rules are properties a node test can hold — the timer exists
// only while captured, a tick asks the window nothing, one message per capture — and the two that
// are about the call graph (no hook, no z-order or geometry call) are asserted as source pins, the
// same bargain tests/overlayFocusPolicy.test.mts strikes for the alt-tab foreground half.
//
// No Electron and no DOM: it never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  POINTER_WATCH_MS,
  overlayShouldWatch,
  pointInRect,
  pointerWatchKeys,
  pointerWatchTick,
  startPointerWatch,
  stopPointerWatch,
  type PointerWatchPort,
  type WatchRect
} from '../src/main/pointerWatch'

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src')
const src = (...rel: string[]): string => readFileSync(join(SRC, ...rel), 'utf8')

/**
 * The same file with its COMMENTS taken out — what the process will actually run.
 *
 * The "no hook, no z-order" pins below are about calls, and these headers NAME the calls they
 * promise not to make (that is the point of them). Asserting over the raw text would make the
 * explanation the violation.
 */
const code = (...rel: string[]): string =>
  src(...rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

/** A 200x100 window at (100, 100) — one rectangle for every case below. */
const RECT: WatchRect = { x: 100, y: 100, width: 200, height: 100 }

/**
 * A port over plain values, counting what the tick actually asked for. The counts ARE the
 * performance assertion: `confirms` is how many times a tick reached for `getBounds()`.
 */
function fakePort(
  cursor: { x: number; y: number } | null,
  confirmWith: WatchRect | null = RECT
): PointerWatchPort & { confirms: number; exits: number; reads: number } {
  return {
    rect: { ...RECT },
    confirms: 0,
    exits: 0,
    reads: 0,
    confirm(): WatchRect | null {
      this.confirms++
      return confirmWith
    },
    cursor(): { x: number; y: number } | null {
      this.reads++
      return cursor
    },
    exit(): void {
      this.exits++
    }
  }
}

// ---------------------------------------------------------------- the rectangle, and its edges

test('a point inside is inside, and the far edges belong to whatever is next to the window', () => {
  assert.equal(pointInRect({ x: 200, y: 150 }, RECT), true)
  // The near edges are the window's own first pixel…
  assert.equal(pointInRect({ x: 100, y: 100 }, RECT), true)
  // …and the far ones are the first pixel of what is beside it, which is how a hit test reads them.
  assert.equal(pointInRect({ x: 300, y: 150 }, RECT), false)
  assert.equal(pointInRect({ x: 200, y: 200 }, RECT), false)
  // Off in each direction, one axis at a time — a compare that dropped an axis passes half of this.
  assert.equal(pointInRect({ x: 99, y: 150 }, RECT), false)
  assert.equal(pointInRect({ x: 200, y: 99 }, RECT), false)
})

// ------------------------------------------------------------------------ what one tick decides

test('the pointer still inside: the tick says stay and asks the WINDOW nothing', () => {
  const port = fakePort({ x: 150, y: 150 })
  assert.equal(pointerWatchTick(port), 'stay')
  assert.equal(port.reads, 1, 'one cursor read per tick, and only one')
  assert.equal(port.confirms, 0, 'getBounds() is not on the tick — rule 3')
  assert.equal(port.exits, 0)
})

test('A CURSOR NOBODY CAN READ IS NOT A CURSOR THAT LEFT', () => {
  // `screen` throws before Electron is ready, and the e2e probe answers nothing until the harness
  // has said where the pointer is. Reading either silence as a leave would drop a capture the user
  // is holding — world-model law 1, applied to a coordinate.
  const port = fakePort(null)
  assert.equal(pointerWatchTick(port), 'stay')
  assert.equal(port.exits, 0)
  assert.equal(port.confirms, 0)
})

test('the pointer outside: ONE confirming read of the window, then one exit', () => {
  const port = fakePort({ x: 900, y: 900 })
  assert.equal(pointerWatchTick(port), 'exit')
  assert.equal(port.confirms, 1, 'the window is asked exactly once, on the apparent exit')
  assert.equal(port.exits, 1, 'one message per capture')
})

test('…and a window that MOVED under the watch corrects itself instead of firing', () => {
  // A monitor coming or going re-places overlays (windows.ts reconcileOverlayDisplays) without
  // touching their capture. The cached rectangle would say "outside" for a pointer that never left.
  const moved: WatchRect = { x: 800, y: 800, width: 200, height: 100 }
  const port = fakePort({ x: 900, y: 850 }, moved)
  assert.equal(pointerWatchTick(port), 'stay')
  assert.equal(port.exits, 0, 'the pointer never left — nothing is sent')
  assert.deepEqual(port.rect, moved, 'and the watch keeps the rectangle it just learned')
  // The next tick is cheap again: the new rectangle is the one being compared against.
  assert.equal(pointerWatchTick(port), 'stay')
  assert.equal(port.confirms, 1, 'no second read of the window')
})

test('a window that is GONE ends the watch, and says nothing to it', () => {
  const port = fakePort({ x: 900, y: 900 }, null)
  assert.equal(pointerWatchTick(port), 'gone')
  assert.equal(port.exits, 0, 'a destroyed window is never sent anything')
})

// ------------------------------------------------- rule 2: no timer outside the captured state

test('THE ONLY STATE THAT EARNS A TIMER is a LOCKED overlay that is CAPTURING', () => {
  assert.equal(overlayShouldWatch({ locked: true, captured: true, alive: true }), true)
  // Locked and idle — main is ignoring the mouse, so there is no capture to release. This is the
  // resting state of every pinned overlay and it must cost nothing at all.
  assert.equal(overlayShouldWatch({ locked: true, captured: false, alive: true }), false)
  // Interactive: the window owns the mouse and gets every real leave the window manager delivers.
  assert.equal(overlayShouldWatch({ locked: false, captured: true, alive: true }), false)
  assert.equal(overlayShouldWatch({ locked: false, captured: false, alive: true }), false)
  // Hidden or destroyed: nobody's hover target.
  assert.equal(overlayShouldWatch({ locked: true, captured: true, alive: false }), false)
})

test('the cadence is 200 ms — generous for a human, and never tighter than 150', () => {
  assert.equal(POINTER_WATCH_MS, 200)
  assert.ok(POINTER_WATCH_MS >= 150, 'the owner floor: do not go tighter than 150 ms')
})

// ------------------------------------------------------------------ the registry, on real timers

test('ONE interval per kind, and it stops itself the moment it fires', async () => {
  assert.deepEqual(pointerWatchKeys(), [], 'nothing is watched before anything captures')
  const port = fakePort({ x: 150, y: 150 })
  startPointerWatch('fight', port)
  // A re-capture must never leave two timers reading the cursor for one window.
  startPointerWatch('fight', port)
  assert.deepEqual(pointerWatchKeys(), ['fight'])

  await new Promise((r) => setTimeout(r, POINTER_WATCH_MS * 2 + 60))
  assert.ok(port.reads >= 2, `the watch is running (${port.reads} reads)`)
  assert.equal(port.exits, 0, 'the pointer is inside — nothing is sent')
  assert.equal(port.confirms, 0, 'and the window is never asked while it is inside')

  // The pointer walks off with no event of any kind — the task-switcher case.
  const reads = port.reads
  port.cursor = (): { x: number; y: number } => {
    port.reads++
    return { x: 900, y: 900 }
  }
  await new Promise((r) => setTimeout(r, POINTER_WATCH_MS * 2 + 60))
  assert.equal(port.exits, 1, 'exactly one exit, however many ticks have passed since')
  assert.deepEqual(pointerWatchKeys(), [], 'and the timer is gone with it')
  assert.ok(port.reads > reads)
})

test('stopping is idempotent, and stopping one kind leaves the other alone', () => {
  startPointerWatch('fight', fakePort({ x: 150, y: 150 }))
  startPointerWatch('events', fakePort({ x: 150, y: 150 }))
  assert.deepEqual(pointerWatchKeys().sort(), ['events', 'fight'])
  stopPointerWatch('fight')
  stopPointerWatch('fight')
  assert.deepEqual(pointerWatchKeys(), ['events'])
  stopPointerWatch('events')
  assert.deepEqual(pointerWatchKeys(), [])
})

// ------------------------------------------------------------- the call graph the rules live in

test('the watch is wired to the ONE place click-through changes, and to every path back', () => {
  const windows = src('main', 'windows.ts')
  // Start/stop rides `setOverlayIgnoreMouse` — the lock toggle, the auto-hide pass, the replay gate
  // and the renderer's own hover sensor all funnel through it, so there is no second opinion about
  // what "captured" means.
  const fn = /export function setOverlayIgnoreMouse[\s\S]*?\n\}/.exec(windows)?.[0] ?? ''
  // `effective`, not `ignore`, since JOS-427: a PARKED overlay is capture-off whatever its queue
  // asked, so the watch must ride the value the window actually got.
  assert.match(fn, /watchOverlayPointer\(kind, w, effective\)/)
  // …and the two paths a window leaves by: its own close, and the main window taking it down with
  // the app (which removes the 'closed' handler first).
  assert.equal((windows.match(/stopOverlayPointerWatch\(kind\)/g) ?? []).length, 2)
})

test('NOTHING IN THIS CHANGE TOUCHES THE MOUSE HOT PATH — no hook, no z-order, no geometry', () => {
  const watch = code('main', 'overlayPointerWatch.ts')
  // The forwarding decision (and therefore WH_MOUSE_LL) still belongs to replayGate.ts alone.
  assert.doesNotMatch(watch, /setIgnoreMouseEvents|forward:/)
  // No SetWindowPos of any spelling, and no window move: the two calls the hitch program is about.
  assert.doesNotMatch(watch, /setAlwaysOnTop|assertTopmost|raiseTopmost|setBounds/)
  // The only per-tick system call is the cursor read.
  assert.match(watch, /screen\.getCursorScreenPoint\(\)/)
  assert.equal((watch.match(/getCursorScreenPoint/g) ?? []).length, 1)
  // And the exit is one send, on the transition.
  assert.equal((watch.match(/webContents\.send/g) ?? []).length, 1)
})

test('the renderer treats main’s push as an ordinary leave, and clears every reason', () => {
  const exit = src('renderer', 'src', 'overlay', 'pointerExit.ts')
  // Leave signal 4, installed for every KIND beside the three the window can hear for itself.
  assert.match(exit, /window\.eqOverlay\.onPointerExit\(overlayPointerExited\)/)
  // The release raises an exit of its own (signal 3), so the fan-out is guarded against recursion.
  assert.match(exit, /if \(firing\) return/)

  const chrome = src('renderer', 'src', 'overlay', 'useOverlayChrome.ts')
  const release = /const releaseAllReasons = [\s\S]*?\n {2}\}/.exec(chrome)?.[0] ?? ''
  assert.match(release, /reasonsRef\.current\.clear\(\)/, 'every named reason goes, not just one')
  assert.match(release, /applyCapture\(\)/, 'and the mouse is handed back in one call')
  assert.match(release, /if \(reasonsRef\.current\.size === 0\) return/, 're-entrancy: nothing to do')
  assert.match(chrome, /onOverlayPointerExit\(\(\) => releaseRef\.current\(\)\)/)

  // The preload's door is receive-only: the signal can never become a request.
  const preload = src('preload', 'overlay.ts')
  assert.match(preload, /onPointerExit: \(cb: \(\) => void\)/)
})

test('the STRIPS ride the same signal — a pinned card is a capture that never ends', () => {
  // Their capture is queue-driven, so no capture REASON can be stranded here; the pin is the door
  // they can reach the same stuck state through (cardQueue.ts's argument).
  const queue = src('renderer', 'src', 'overlay', 'cardQueue.ts')
  assert.match(queue, /export function useUnpinOnPointerExit/)
  assert.match(queue, /if \(c\.pinned\) dispatch\(\{ type: 'hover', id: c\.payload\.id, over: false \}\)/)
  // Nothing is dismissed early: the pointer having left is not the user having read it.
  const hook = /export function useUnpinOnPointerExit[\s\S]*?\n\}/.exec(queue)?.[0] ?? ''
  assert.doesNotMatch(hook, /'dismiss'/)
  for (const file of ['ToastOverlay.tsx', 'AlertBannerOverlay.tsx']) {
    assert.match(src('renderer', 'src', 'overlay', file), /useUnpinOnPointerExit\(/, file)
  }
})
