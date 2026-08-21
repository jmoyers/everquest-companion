// A CAPTURED OVERLAY LETS GO WHEN THE CURSOR LEAVES IT — EVEN IF NOTHING TELLS IT (JOS-381).
//
// THE REPORT (owner, hands-on 2026-08-16): "the unlock button on the overlay properly unshows
// itself when you mouse off normally, but when you have the operating system alt-tab menu open,
// and you mouse over the overlays while it's still open, mouse-off never fires and the unlock
// buttons stay open permanently until you mouse in again."
//
// WHAT THE STEP RECREATES. A locked overlay's hover sensor is a FORWARDED mouse move, so the
// capture arrives as an ordinary DOM event — and then nothing else does: while the task switcher
// owns input there is no leave, no blur, no visibility change and no reason letting go. So the
// step captures the window through the DOM exactly as `stepLockedSelector` does, and then moves
// the CURSOR alone, with no event of any kind following it. Everything that happens after that is
// main's cursor watchdog (src/main/pointerWatch.ts) and nothing else.
//
// WHERE THE CURSOR COMES FROM, and why this is not the real one. `EQ_E2E=1` never shows a window
// and Playwright drives Chromium's SYNTHETIC pointer, so the real OS cursor is wherever the
// machine's owner left it — on a hidden window it is never inside, which would make every hover
// step in this suite look like a pointer that had already left. Under the flag the watchdog
// therefore takes its point from a probe object main installs for the harness
// (`globalThis.__eqOverlayPointerWatch`, src/main/overlayPointerWatch.ts), which is also how the
// PERFORMANCE half below can be asserted at all: the probe says which kinds have a live interval,
// what `ignore` main last applied, and how many exits have been pushed.
//
// THE PERFORMANCE HALF IS THE OWNER'S RULE, not a bonus (2026-08-16, the JOS-363..372 hitch
// program): the watchdog may exist only while a locked overlay is really capturing. That is a
// claim about a timer, which no DOM can show — so it is read off the probe at each of the three
// states this step passes through: locked and idle (none), captured (one), released (none again).
//
// Its own module because tests/e2e/overlay-sync.e2e.mts is at the repo's max-lines budget: split,
// never ratchet (overlayScrollSteps.mts and overlayMinSizeSteps.mts precede it).

import type { ElectronApplication, Page } from 'playwright-core'
import { check, note, settle, settleStable } from './appHarness.mjs'
import type { SetLocked } from './overlayScopeSteps.mjs'

/** A window rectangle, as Electron hands it over. */
interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** What the probe answers. Spelled here rather than imported — an e2e file loads no src module. */
interface WatchState {
  watching: string[]
  applied: Record<string, boolean>
  exits: Record<string, number>
}

const KIND = 'fight'

/** The fight overlay's own window, found by its `?kind=` URL — the door overlayScrollSteps uses. */
function fightBounds(app: ElectronApplication): Promise<Bounds | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('kind=fight'))
    return w ? w.getBounds() : null
  })
}

/** Everything main will say about its watchdog right now. */
function watchState(app: ElectronApplication): Promise<WatchState | null> {
  return app.evaluate(() => {
    const p = (globalThis as unknown as Record<string, unknown>).__eqOverlayPointerWatch as
      | { watching: () => string[]; applied: () => Record<string, boolean>; exits: () => Record<string, number> }
      | undefined
    return p ? { watching: p.watching(), applied: p.applied(), exits: p.exits() } : null
  })
}

/** Tell main where the cursor is. `null` is "nothing to say", which the watchdog reads as no news. */
function setCursor(app: ElectronApplication, at: { x: number; y: number } | null): Promise<void> {
  return app.evaluate((_e, p) => {
    const probe = (globalThis as unknown as Record<string, unknown>).__eqOverlayPointerWatch as
      | { cursor: { x: number; y: number } | null }
      | undefined
    if (probe) probe.cursor = p
  }, at)
}

/** The lock/close controls, which a locked overlay renders ONLY once it has taken the mouse. */
const controlCount = (overlay: Page): Promise<number> =>
  overlay.evaluate(() => document.querySelectorAll('button').length)

/**
 * Hover (or un-hover) the selector ROW, the way stepLockedSelector does and for the reason stated
 * there: React synthesises enter/leave at the root from `mouseover`/`mouseout`, so a directly
 * dispatched non-bubbling `mouseenter` reaches no handler at all.
 */
function dispatchRow(overlay: Page, type: 'mouseover' | 'mouseout'): Promise<void> {
  return overlay.evaluate((t) => {
    const row = document.querySelector('[aria-haspopup="listbox"]')?.parentElement
    row?.dispatchEvent(new MouseEvent(t, { bubbles: true, relatedTarget: document.body }))
  }, type)
}

const isWatching = (s: WatchState | null): boolean => s?.watching.includes(KIND) === true
const watchList = (s: WatchState | null): string => (s?.watching ?? []).join(', ') || '(none)'
const exitsSoFar = (s: WatchState | null): number => s?.exits[KIND] ?? 0

/**
 * WHAT A TICK COSTS, MEASURED ON THIS MACHINE rather than argued.
 *
 * A tick is one `getCursorScreenPoint()` — a `GetCursorPos` read — plus four numeric comparisons
 * against a rectangle main is already holding. This times the syscall half in the real main
 * process and prints it as a note; there is no assertion, because the number is a property of the
 * machine and a frozen one would rot (AGENTS.md). At five ticks a captured second, the note is the
 * whole per-second bill of the feature.
 */
async function noteTickCost(app: ElectronApplication): Promise<void> {
  const us = await app.evaluate(({ screen }) => {
    const n = 2000
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < n; i++) screen.getCursorScreenPoint()
    return Number(process.hrtime.bigint() - t0) / n / 1000
  })
  note(`one watchdog tick reads the cursor in ${us.toFixed(1)}us — ${(us * 5).toFixed(0)}us per captured second at 200ms`)
}

/** No timer while a locked overlay is IDLE, and none for an unlocked one — the whole of rule 2. */
async function checkNoTimer(app: ElectronApplication, name: string): Promise<void> {
  const s = await settleStable(() => watchState(app), { timeoutMs: 4_000 })
  check(name, !isWatching(s), watchList(s))
}

/** Take the capture the ordinary way, with the cursor genuinely over the window. */
async function captureTheWindow(app: ElectronApplication, overlay: Page, b: Bounds): Promise<void> {
  await setCursor(app, { x: b.x + Math.floor(b.width / 2), y: b.y + Math.floor(b.height / 2) })
  await dispatchRow(overlay, 'mouseover')
  const shown = await settle(() => controlCount(overlay), (n) => n > 0, { timeoutMs: 8_000 })
  check('hovering the selector row captures the mouse (its controls reveal)', shown > 0, `${shown} control(s)`)
  const s = await settle(() => watchState(app), isWatching, { timeoutMs: 6_000 })
  check('…and ONLY NOW does main watch the cursor', isWatching(s), watchList(s))
  // …and it says nothing while the pointer really is inside. This is the selector-popup case too:
  // the open list is inside this window, so a pointer moving from the header into it never leaves.
  const held = await settleStable(() => controlCount(overlay), { timeoutMs: 3_000, stable: 5 })
  check('a cursor still INSIDE the window keeps the capture — nothing is dropped', held > 0, `${held} control(s)`)
}

/**
 * THE ALT-TAB CASE: the cursor moves off and NOT ONE EVENT follows it — no mouseout, no blur, no
 * visibility change. Exactly what the task switcher leaves a captured window with.
 */
async function checkTheCursorWalksOff(app: ElectronApplication, overlay: Page, b: Bounds): Promise<void> {
  const before = exitsSoFar(await watchState(app))
  await setCursor(app, { x: b.x + b.width + 400, y: b.y + b.height + 400 })
  const gone = await settle(() => controlCount(overlay), (n) => n === 0, { timeoutMs: 6_000 })
  check('THE CHROME HIDES ON ITS OWN when the cursor has left, with no leave event', gone === 0, `${gone} control(s)`)

  const after = await settle(
    () => watchState(app),
    (s) => s?.applied[KIND] === true && exitsSoFar(s) > before,
    { timeoutMs: 6_000 }
  )
  const applied = after?.applied[KIND]
  check(
    '…and main really re-applied click-through (setIgnoreMouseEvents(true) over the game)',
    applied === true,
    `applied ignore=${String(applied)}`
  )
  check(
    '…off ONE pushed exit, not a stream of them',
    exitsSoFar(after) === before + 1,
    `${before} → ${exitsSoFar(after)}`
  )
  check('…and the timer stopped itself with the capture', !isWatching(after), watchList(after))
}

export async function stepPointerWatch(
  app: ElectronApplication,
  overlay: Page,
  setLocked: SetLocked
): Promise<void> {
  if (!check('main exposes its cursor watchdog to the harness (EQ_E2E only)', (await watchState(app)) !== null))
    return
  const rect = await fightBounds(app)
  if (rect === null) {
    check('the overlay window can be measured', false)
    return
  }

  await noteTickCost(app)
  await setLocked(overlay, true)
  await checkNoTimer(app, 'a LOCKED, idle overlay runs NO cursor timer at all (the owner’s performance rule)')
  await captureTheWindow(app, overlay, rect)
  await checkTheCursorWalksOff(app, overlay, rect)

  // Put the window back the way every step after this one expects to find it: no stale DOM hover,
  // no harness cursor, interactive — and no timer left running for an unlocked window.
  await dispatchRow(overlay, 'mouseout')
  await setCursor(app, null)
  await setLocked(overlay, false)
  await checkNoTimer(app, 'an UNLOCKED overlay runs no cursor timer either — it owns the mouse')
}
