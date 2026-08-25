// A PINNED OVERLAY REVEALS ITS PIN WITHOUT A MOUSE HOOK (JOS-370).
//
// WHAT CHANGED. A locked overlay used to be `setIgnoreMouseEvents(true, {forward:true})`, and that
// `forward` installs a low-level mouse hook (WH_MOUSE_LL) owned by the MAIN process — a
// SYNCHRONOUS stop on the machine's mouse path, so every mouse event on the desktop waited on our
// message loop and any hitch of ours froze the user's cursor and their in-game mouselook. The hook
// bought one thing: mouse MOVES, which were the hover sensor that took the mouse back for the pin.
//
// The sensor is now a hit test: main publishes the rectangles a pinned window still wants
// (src/main/overlayHotZone.ts), the presence worker reads the cursor on its own thread at ~32 ms
// and reports enter/leave EDGES, and main flips the window's capture and pushes `overlay:hover`.
//
// WHAT ONLY THE REAL APP CAN SHOW, and therefore what this step is for. The geometry, the codec,
// the cadence and the gating are all pure and pinned in tests/overlayHotZone.test.mts; the worker's
// own loop is driven for real in tests/presenceWorker.test.mts. What neither can see is the SEAM:
// that a transition reported to main opens the window's mouse mode AND reaches the renderer's
// capture machinery, so the pin actually appears — through the real preload, the real channel and
// the real hook that decides what a locked overlay draws.
//
// WHERE THE TRANSITION COMES FROM, and why it is not a real cursor. `EQ_E2E=1` never shows a
// window, and the presence watcher never starts at all under it — so there is no thread to read a
// cursor and no on-screen rectangle for it to be inside. The step therefore drives the edge in
// through the probe main installs for the harness (`globalThis.__eqOverlayHover`,
// src/main/overlayHover.ts), which is exactly what the worker would have said. Everything after
// that point is the product.
//
// THE STRIP IS MEASURED, NOT RESTATED. `CHROME_STRIP_PX` is a constant in main, and a constant
// about a LAYOUT is only honest while it still covers the row it describes — too short and the
// bottom band of the pin becomes unreachable, which is the defect this ticket exists to remove,
// reintroduced quietly. So the step measures the real header row in the real overlay and fails if
// it has grown past what main publishes. (OVERLAY_MIN_SIZE's rule, one file over.)
//
// Its own module because tests/e2e/overlay-sync.e2e.mts is at the repo's max-lines budget: split,
// never ratchet (overlayScrollSteps.mts, overlayMinSizeSteps.mts and overlayPointerWatchSteps.mts
// precede it).

import type { ElectronApplication, Page } from 'playwright-core'
import { check, note, settle } from './appHarness.mjs'
import type { SetLocked } from './overlayScopeSteps.mjs'

const KIND = 'fight'

/** What the hover probe answers. Spelled here rather than imported — an e2e file loads no src module. */
interface HoverProbe {
  pushed: () => Record<string, boolean>
  transition: (key: string, inside: boolean) => void
  stripPx: number
}

/** What the POINTER-WATCH probe says about the mouse mode main last applied — the observable of
 *  `setIgnoreMouseEvents`, which cannot be seen from inside a page. */
interface WatchProbe {
  applied: () => Record<string, boolean>
}

/** Drive one edge in, as the worker would have reported it. */
function transition(app: ElectronApplication, inside: boolean): Promise<boolean> {
  return app.evaluate((_e, args) => {
    const p = (globalThis as unknown as Record<string, unknown>).__eqOverlayHover as
      | HoverProbe
      | undefined
    if (!p) return false
    p.transition(args.kind, args.inside)
    return true
  }, { kind: KIND, inside })
}

/** The strip height main publishes, and the ignore-state it last applied to this kind. */
function mainState(app: ElectronApplication): Promise<{ stripPx: number; ignoring: boolean | null; pushed: boolean | null } | null> {
  return app.evaluate((_e, kind) => {
    const g = globalThis as unknown as Record<string, unknown>
    const hover = g.__eqOverlayHover as HoverProbe | undefined
    const watch = g.__eqOverlayPointerWatch as WatchProbe | undefined
    if (!hover) return null
    return {
      stripPx: hover.stripPx,
      ignoring: watch ? (watch.applied()[kind] ?? null) : null,
      pushed: hover.pushed()[kind] ?? null
    }
  }, KIND)
}

/** The lock/close controls, which a locked overlay renders ONLY once it has taken the mouse. */
const controlCount = (overlay: Page): Promise<number> =>
  overlay.evaluate(() => document.querySelectorAll('button').length)

/**
 * The header row's own height, from the row the selector trigger lives in — the row whose bottom
 * edge the published strip has to reach.
 */
function headerHeight(overlay: Page): Promise<number> {
  return overlay.evaluate(() => {
    const row = document.querySelector('[aria-haspopup="listbox"]')?.parentElement
    if (!row) return -1
    const r = row.getBoundingClientRect()
    // From the TOP OF THE WINDOW, not the top of the row: the overlay root carries a 1px border
    // above it, and the strip main publishes starts at the window's own edge.
    return Math.ceil(r.bottom)
  })
}

export async function stepHoverZones(
  app: ElectronApplication,
  overlay: Page,
  setLocked: SetLocked
): Promise<void> {
  await setLocked(overlay, true)

  const state = await mainState(app)
  if (!state) {
    note('main installed no hover probe — the hookless sensor step needs EQ_E2E')
    await setLocked(overlay, false)
    return
  }

  // ---- THE STRIP COVERS THE ROW IT DESCRIBES ------------------------------------------------
  const row = await headerHeight(overlay)
  check(
    'the published chrome strip still reaches the bottom of the real header row',
    row > 0 && row <= state.stripPx,
    `row ends at ${String(row)}px, strip is ${String(state.stripPx)}px`
  )
  note(`chrome strip ${String(state.stripPx)}px vs a measured header row of ${String(row)}px`)

  // ---- A LOCKED, UNHOVERED OVERLAY SHOWS NO CHROME AND IGNORES THE MOUSE ---------------------
  const idle = await controlCount(overlay)
  check('a pinned overlay with the cursor elsewhere draws no controls', idle === 0, `${String(idle)} control(s)`)
  check(
    '…and main is ignoring its mouse events (it is click-through)',
    state.ignoring !== false,
    `applied ignore=${String(state.ignoring)}`
  )

  // ---- THE ENTER EDGE ------------------------------------------------------------------------
  // THIS IS THE WHOLE FEATURE. No mouse event of any kind is dispatched into the page: the ONLY
  // input is main being told the cursor crossed into a rectangle, exactly as the worker would say
  // it. If the pin appears, the hookless sensor works end to end.
  check('the hover edge reached main', await transition(app, true))
  const revealed = await settle(() => controlCount(overlay), (n) => n > 0, { timeoutMs: 8_000 })
  check(
    'ENTER: an off-thread hit test alone reveals the pin (no mouse hook, no mouse event)',
    revealed > 0,
    `${String(revealed)} control(s)`
  )
  const captured = await mainState(app)
  check(
    '…and main opened the window’s mouse mode so the pin can be pressed',
    captured?.ignoring === false,
    `applied ignore=${String(captured?.ignoring)}`
  )
  check('…and the window was told, once, which way the edge went', captured?.pushed === true)

  // ---- THE LEAVE EDGE ------------------------------------------------------------------------
  // Main does NOT take the mouse back itself here — it only says the cursor left, and the RENDERER
  // decides, because more than one named reason can be holding (an open selector popup reaches
  // below the strip, and a main-side release would close the list under the user's hand). So the
  // observable is the same one the DOM sensor has always had: the chrome goes, and the ignore
  // state comes back through the renderer's own `setIgnoreMouse`.
  check('the leave edge reached main', await transition(app, false))
  const hidden = await settle(() => controlCount(overlay), (n) => n === 0, { timeoutMs: 8_000 })
  check('LEAVE: the chrome goes again', hidden === 0, `${String(hidden)} control(s)`)
  const released = await settle(
    async () => (await mainState(app))?.ignoring ?? null,
    (v) => v === true,
    { timeoutMs: 8_000 }
  )
  check(
    '…and the RENDERER gave the mouse back — main never took it (the popup rule)',
    released === true,
    `applied ignore=${String(released)}`
  )

  await setLocked(overlay, false)
}
