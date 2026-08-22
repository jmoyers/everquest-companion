// A LOST MONITOR NEVER TAKES AN OVERLAY WITH IT (JOS-187).
//
// The 0.18.0 report: a player swapped a dual-monitor widescreen for a single monitor and the combat
// overlay was gone — off the right-hand edge of the only display left. Restarting did not help
// (restarting is what RE-APPLIED the stored position), and toggling the overlay off and on
// re-created the window at the same rectangle. There is nothing to drag it back by either: an
// overlay is frameless, always-on-top and out of Alt-Tab by design.
//
// THE POLICY THIS STEP EXISTS TO PIN — "clamp what is SHOWN, never what is STORED":
//
//   * `overlays.<kind>.bounds` keeps the rectangle the USER chose, wherever they chose it. Nothing
//     the app does to keep a window visible is ever written back over it.
//   * Every window is FITTED to the displays that exist at the moment it is placed — at creation
//     and again whenever the monitor arrangement changes under a running app.
//   * …and that fit MOVES AS LITTLE AS IT CAN (JOS-433, the last check below). A window parked
//     along the bottom edge of the screen is a placement somebody chose, not a window that needs
//     rescuing, so it is left alone — the correction is for a window the user cannot reach.
//
// Together those make a docking round trip lossless: undocked, the overlay is drawn on the laptop
// panel while the store still says "on the right-hand monitor"; docked again, the same fit puts it
// back. Persisting the correction instead would destroy that layout the first time a cable came
// out — on a screen the user might be on for the length of a train journey.
//
// WHAT ONLY THE REAL APP CAN SHOW. The geometry is pure and pinned in tests/displayFit.test.mts
// against arrangements this machine does not have. What no unit test can claim is that the fit is
// WIRED: that main re-places a live window when the screens change, that a window CREATED from an
// impossible rectangle comes up somewhere real, and — the half that is easiest to get wrong and
// impossible to see afterwards — that neither of those writes anything into the store.
//
// THE ONE SIMULATION, STATED PLAINLY. This box has one monitor and cannot grow or lose another, so
// the screen change is delivered by emitting Electron's own `display-metrics-changed` on the
// `screen` module in the main process. That is the exact event the product listens for and the
// listener reads nothing from its arguments — so what is faked here is the NOTIFICATION, and
// everything downstream of it (which displays exist, what fits on them, what is written where) is
// the real code answering for real. The lost-monitor half is supplied honestly instead: a stored
// rectangle at x=9000, which is off every display this machine has for the same reason the
// reporter's was off theirs.
//
// Its own module because tests/e2e/overlay-sync.e2e.mts sits at the repo's max-lines budget:
// split, never ratchet (overlayScopeSteps.mts, overlayScrollSteps.mts and overlayTotalSteps.mts
// precede it).

import type { ElectronApplication, Page } from 'playwright-core'
import { check, note, settle } from './appHarness.mjs'
import { overlayWindow } from './appWindow.mjs'

/** A window rectangle, as Electron hands it over. */
interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** Where the fight overlay's window is, and whether any display's work area holds all of it. */
interface Placement {
  bounds: Bounds | null
  onScreen: boolean
}

/**
 * The fight overlay's window as MAIN sees it — found by its `?kind=fight` URL rather than its title
 * (the loaded page owns the title), the same door every other step in this spec uses.
 *
 * `onScreen` is answered here rather than in the test process because it is a question about the
 * real displays, and only main can ask `screen`. It is deliberately the strict reading: the window
 * lies ENTIRELY within one display's work area. A window we have re-placed has no business
 * straddling anything.
 */
function fightPlacement(app: ElectronApplication): Promise<Placement> {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().includes('kind=fight')
    )
    if (!w) return { bounds: null, onScreen: false }
    const b = w.getBounds()
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height
    })
    return { bounds: b, onScreen }
  })
}

/** Tell the app its monitors changed — Electron's own event, on Electron's own emitter (see above). */
async function announceDisplayChange(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ screen }) => {
    screen.emit('display-metrics-changed')
  })
}

interface ConfigBridge {
  getConfig: () => Promise<{ bounds?: Bounds }>
  setConfig: (patch: { bounds: Bounds }) => Promise<unknown>
}

/** What the STORE says this overlay's bounds are — read through the overlay's own bridge. */
function storedBounds(overlay: Page): Promise<Bounds | null> {
  return overlay.evaluate(async () => {
    const cfg = await (window as unknown as { eqOverlay: ConfigBridge }).eqOverlay.getConfig()
    return cfg.bounds ?? null
  })
}

/** Write bounds into the store WITHOUT moving the window — the state a monitor change leaves behind. */
async function storeBounds(overlay: Page, bounds: Bounds): Promise<void> {
  await overlay.evaluate(async (b) => {
    await (window as unknown as { eqOverlay: ConfigBridge }).eqOverlay.setConfig({ bounds: b })
  }, bounds)
}

const key = (b: Bounds | null): string => (b ? `${b.x},${b.y},${b.width},${b.height}` : '(none)')

/** The primary display's PHYSICAL rectangle, taskbar included — whatever screen this box has. */
function primaryScreen(app: ElectronApplication): Promise<Bounds> {
  return app.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds)
}

/**
 * JOS-433: A WINDOW PARKED ALONG THE BOTTOM OF THE SCREEN STAYS THERE.
 *
 * The v1.6.0 report — two meters along the bottom edge, "every time I login all the windows move
 * upward and I have to reposition them", and nothing of the sort at the top. The geometry is pinned
 * in tests/displayFit.test.mts against screens this machine does not have (one pixel of overhang
 * used to cost a whole taskbar of upward movement); what only the real app can show is that the
 * relaxed fit is the one WIRED to the display change — that main, told its monitors moved, leaves
 * this window exactly where it is instead of lifting it clear of the taskbar.
 *
 * TWO PIXELS PAST THE PHYSICAL EDGE, because that is the state the report is about and it is not an
 * exotic one: a frameless window's body drags past the bottom edge quite happily, and
 * overlayBounds.ts records that `setBounds` can come back a pixel off on a scaled display — so a
 * meter somebody parks flush with the bottom is stored a pixel or two over often enough.
 *
 * Compared with a small tolerance for that same scaled-display round trip. The defect it is
 * standing in for is not a pixel, it is a taskbar: the old behaviour moved this window 42px.
 */
async function checkBottomAnchorSurvives(app: ElectronApplication, ov: Page): Promise<void> {
  const screenRect = await primaryScreen(app)
  const parked: Bounds = {
    x: Math.max(screenRect.x, screenRect.x + screenRect.width - 380 - 40),
    y: screenRect.y + screenRect.height - 320 + 2,
    width: 380,
    height: 320
  }
  await storeBounds(ov, parked)
  await announceDisplayChange(app)
  const near = (b: Bounds | null): boolean => b !== null && Math.abs(b.y - parked.y) <= 2 && Math.abs(b.x - parked.x) <= 2
  const settled = await settle(() => fightPlacement(app), (p) => near(p.bounds), { timeoutMs: 10_000 })
  check(
    'JOS-433: a meter parked over the bottom edge is still there after a display change',
    near(settled.bounds),
    `${key(settled.bounds)} (parked at ${key(parked)})`
  )
  check(
    '…and the store still holds the rectangle the user chose',
    key(await storedBounds(ov)) === key(parked),
    key(await storedBounds(ov))
  )
}

/** A rectangle on no display this machine has — the reporter's second monitor, after the fact. */
const LOST_MONITOR: Bounds = { x: 9000, y: 9000, width: 380, height: 320 }

interface OverlayToggle {
  getOverlayState: () => Promise<Record<string, boolean>>
  toggleOverlay: (k: string) => Promise<boolean>
}

/** Close the fight overlay and open it again — the "I restarted and toggled it" half of the report. */
async function reopenFightOverlay(app: ElectronApplication, page: Page): Promise<Page | null> {
  for (const want of [false, true]) {
    await page.evaluate(async (target) => {
      const eq = (window as unknown as { eq: OverlayToggle }).eq
      if ((await eq.getOverlayState()).fight !== target) await eq.toggleOverlay('fight')
    }, want)
    await settle(
      () => page.evaluate(() => (window as unknown as { eq: OverlayToggle }).eq.getOverlayState()),
      (s) => s.fight === want,
      { timeoutMs: 10_000 }
    )
  }
  return overlayWindow(app, 'fight')
}

/**
 * The whole ticket, driven against the running app. Takes the MAIN window's page; it finds the
 * overlay itself and leaves the store exactly as it found it, because every step after this one
 * inherits that userData dir.
 */
export async function stepOverlayDisplay(app: ElectronApplication, page: Page): Promise<void> {
  const overlay = await overlayWindow(app, 'fight')
  if (!check('the fight overlay is open for the display-fit step', overlay !== null)) return
  const ov = overlay as Page
  const original = await storedBounds(ov)

  // The state a player wakes up to: the store remembers a monitor that is no longer there. Written
  // WITHOUT touching the window, exactly as an unplugged cable leaves it.
  await storeBounds(ov, LOST_MONITOR)
  check('a rectangle on a monitor that no longer exists is still what the store remembers',
    key(await storedBounds(ov)) === key(LOST_MONITOR))

  // ── the LIVE half: the screens change under a running app ────────────────────────────────
  await announceDisplayChange(app)
  const live = await settle(() => fightPlacement(app), (p) => p.onScreen, { timeoutMs: 10_000 })
  check('a monitor change puts the overlay back on a display that exists', live.onScreen, key(live.bounds))
  check('…and the store still remembers where the USER put it — the clamp is what is SHOWN',
    key(await storedBounds(ov)) === key(LOST_MONITOR), key(await storedBounds(ov)))

  // ── the CREATION half: the report's own "I restarted and toggled it off and on" ───────────
  const reopened = await reopenFightOverlay(app, page)
  if (!check('the fight overlay reopens', reopened !== null)) return
  const fresh = await settle(() => fightPlacement(app), (p) => p.bounds !== null, { timeoutMs: 10_000 })
  check('…and a window CREATED from that rectangle comes up on screen, not past the edge of it',
    fresh.onScreen, key(fresh.bounds))
  const kept = await storedBounds(reopened as Page)
  check('…with the stored rectangle STILL untouched, so plugging the monitor back in restores it',
    key(kept) === key(LOST_MONITOR), key(kept))

  // ── JOS-433: the OTHER half of "clamp what is shown" — clamp it as little as possible ──────
  await checkBottomAnchorSurvives(app, reopened as Page)

  // Leave the store somewhere real — every step after this one shares this install. An install
  // that had no stored bounds at all (nothing in this hidden-window run ever moved the window)
  // gets the rectangle it is actually sitting on rather than the impossible one this step wrote.
  const restore = original ?? (await fightPlacement(app)).bounds
  if (restore) {
    await storeBounds(reopened as Page, restore)
    note(`the fight overlay's stored bounds were left at ${key(restore)} (was ${key(original)})`)
  }
}
