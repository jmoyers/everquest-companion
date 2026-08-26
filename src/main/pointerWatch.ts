// pointerWatch.ts — WHEN A CAPTURED WINDOW HAS TO BE TOLD THE POINTER LEFT (JOS-381).
//
// THE REPORT (owner, hands-on, 2026-08-16): "the unlock button on the overlay properly unshows
// itself when you mouse off normally, but when you have the operating system alt-tab menu open,
// and you mouse over the overlays while it's still open, mouse-off never fires and the unlock
// buttons stay open permanently until you mouse in again."
//
// WHY NOTHING IN THE WINDOW CAN NOTICE. A locked overlay is `setIgnoreMouseEvents(true,
// {forward:true})`: the forwarded moves ARE its hover sensor. The moment one of them reaches the
// header the renderer asks main to stop ignoring the mouse, and from then on the only things that
// can release the capture are a real leave reaching the window — a DOM `mouseleave`, a blur, a
// visibility change, or the last named reason letting go (renderer/overlay/pointerExit.ts, the
// three signals of JOS-358). With the Windows task switcher up, the switcher owns input: the
// forwarded move that CAPTURED still arrived, nothing arrives afterwards, and when the switcher
// closes the pointer is already somewhere else. So the window sits captured — chrome showing, and
// worse, NOT click-through over the game — until the pointer happens to come back and leave again.
//
// THE ANSWER IS ONE CHEAP QUESTION, ASKED ONLY WHILE IT MATTERS: is the cursor still inside the
// rectangle? This file is that question as a plain decision; `overlayPointerWatch.ts` is the half
// that knows about Electron, and it is the only caller.
//
// ================================ THE PERFORMANCE CONTRACT ================================
// The owner's standing rule (2026-08-16, the JOS-363..372 hitch program): "be careful with
// performance implications regarding the hover watchdog - we've done a lot of work to make it not
// hurt global mouse performance." Five rules, and they are the design rather than a caveat:
//
//   1. NOTHING TOUCHES THE MOUSE'S HOT PATH. No WH_MOUSE_LL, no hook of any kind, no change to
//      what forwards (nothing does since JOS-370, and the gate that used to decide it left with
//      the fold in JOS-499). This watch never sits between
//      the system and a mouse event; it READS a coordinate on a timer, which is the opposite
//      arrangement.
//   2. THE TIMER EXISTS ONLY WHILE A LOCKED OVERLAY IS CAPTURED — seconds at a time, per window.
//      A locked-and-idle overlay, an unlocked one, a hidden one and a destroyed one all have
//      exactly zero timers (`overlayShouldWatch` below is that decision, and it is unit-tested).
//   3. ONE READ PER TICK. A tick is one cursor read plus four numeric comparisons against a
//      rectangle this module is HOLDING. `getBounds()` is not free either, so it is not on the
//      tick: the rectangle is read when the watch starts and re-read ONLY to confirm an apparent
//      exit (see `pointerWatchTick`), which happens at most once per capture.
//   4. ONE MESSAGE PER CAPTURE. The exit is sent once and the watch stops itself; nothing here
//      sends IPC, calls `setIgnoreMouseEvents`, or moves a window on a tick.
//   5. 200 ms, and never tighter than 150. The exit only has to beat a human noticing the chrome
//      is still up — five reads a captured second is already generous.
//
// ELECTRON-FREE ON PURPOSE — the same bargain topmost.ts and security.ts strike. The window and
// the cursor arrive as a structural PORT, so the whole policy is a plain module a node test can
// drive with fakes, and the Electron half hands it the real thing.

/** A point in SCREEN coordinates (DIPs, which is what both halves of the compare speak). */
export interface WatchPoint {
  x: number
  y: number
}

/** A window rectangle in the same coordinates. Electron's `Rectangle` satisfies it. */
export interface WatchRect extends WatchPoint {
  width: number
  height: number
}

/**
 * Cadence. See rule 5 above: this is a "has the user moved off" question, not a tracking loop.
 * A tick that lands on the next 15.6 ms Windows edge is noise against it (AGENTS.md).
 */
export const POINTER_WATCH_MS = 200

/**
 * Is the point inside the rectangle? Half-open on the far edges, which is how a window's own hit
 * test reads them: a cursor at `x + width` is on the first pixel of whatever is next to it.
 */
export function pointInRect(p: WatchPoint, r: WatchRect): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height
}

/**
 * Everything one watch needs, taken structurally.
 *
 * `rect` is the rectangle the watch was STARTED with and is what every tick compares against —
 * see rule 3. `confirm` re-reads the window (null once it is gone) and is called only when the
 * cached rectangle says the pointer is outside, so a window that was re-placed while captured
 * (a monitor coming or going — windows.ts `reconcileOverlayDisplays`) corrects itself instead of
 * firing on a rectangle that has moved out from under it.
 */
export interface PointerWatchPort {
  /** The window's rectangle as it was when this watch started. */
  rect: WatchRect
  /** Re-read it. Null means the window is gone — the watch is over either way. */
  confirm: () => WatchRect | null
  /** Where the cursor is now. Null means it could not be read (see `pointerWatchTick`). */
  cursor: () => WatchPoint | null
  /** "The pointer is no longer over you." Sent at most ONCE per watch. */
  exit: () => void
}

/** What one tick concluded. `stay` is the overwhelmingly common answer and costs one cursor read. */
export type PointerTick = 'stay' | 'exit' | 'gone'

/**
 * One tick of one watch.
 *
 * A CURSOR NOBODY CAN READ IS NOT A CURSOR THAT LEFT (world-model law 1, applied to a coordinate):
 * `screen` can throw before Electron is ready and answers nothing under the e2e probe until the
 * harness has said where the pointer is, and a watch that read that silence as "outside" would
 * drop a capture the user is holding. It stays.
 *
 * The caller stops the interval on anything but `stay`; `exit` has already been sent by then.
 */
export function pointerWatchTick(port: PointerWatchPort): PointerTick {
  const p = port.cursor()
  if (p === null) return 'stay'
  if (pointInRect(p, port.rect)) return 'stay'
  // Only here — an apparent exit — is the window asked anything (rule 3).
  const now = port.confirm()
  if (now === null) return 'gone'
  if (pointInRect(p, now)) {
    // The window moved while we were watching it. Take the new rectangle and keep watching: the
    // pointer never left, and firing here would drop a capture the user is still holding.
    port.rect = now
    return 'stay'
  }
  port.exit()
  return 'exit'
}

/**
 * Does this overlay need a watch at all?
 *
 * THE WHOLE OF RULE 2, in one predicate, so "zero timers for a locked-and-idle overlay" is a
 * property a unit test can hold rather than a claim about a call graph:
 *
 *   - `locked` — an INTERACTIVE overlay owns the mouse outright and gets every real leave the
 *     window manager delivers. It has nothing to be rescued from, and polling for it would be a
 *     timer running for every window a user is dragging.
 *   - `captured` — the state this bug lives in, and the only one. Locked and idle means main is
 *     ignoring the mouse: there is no capture to release, so there is nothing to watch for.
 *   - `alive` — hidden or destroyed windows are nobody's hover target (`setOverlaysHidden`
 *     re-applies the locked mode on the way down, which is what stops the watch there).
 */
export function overlayShouldWatch(o: {
  locked: boolean
  captured: boolean
  alive: boolean
}): boolean {
  return o.locked && o.captured && o.alive
}

/** The live watches, by key (one per overlay KIND — never two for one window). */
const watches = new Map<string, NodeJS.Timeout>()

/** Stop `key`'s watch if it has one. Idempotent: every stop path calls it freely. */
export function stopPointerWatch(key: string): void {
  const t = watches.get(key)
  if (t === undefined) return
  clearInterval(t)
  watches.delete(key)
}

/**
 * Start (or restart) `key`'s watch. ONE interval per key by construction — the previous one is
 * cleared before the new one exists, so a re-capture can never leave two timers reading the cursor
 * for the same window.
 *
 * `unref` so it can never hold the process open: this is an accessory to a window, and quitting
 * must not wait on it.
 */
export function startPointerWatch(key: string, port: PointerWatchPort): void {
  stopPointerWatch(key)
  const timer = setInterval(() => {
    if (pointerWatchTick(port) !== 'stay') stopPointerWatch(key)
  }, POINTER_WATCH_MS)
  timer.unref?.()
  watches.set(key, timer)
}

/** Which keys are being watched right now — the observable behind "no timer while idle". */
export function pointerWatchKeys(): string[] {
  return [...watches.keys()]
}
