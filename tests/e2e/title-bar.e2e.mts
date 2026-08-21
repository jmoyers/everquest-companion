/**
 * Headless Electron test for the TITLE BAR's DOUBLE-CLICK (JOS-204).
 *
 * THE REPORT: rapidly checking and unchecking an overlay in the title bar's Overlay menu toggled
 * the main window between maximized and windowed. The mechanism is a seam between two trees —
 * MUI's Menu is a PORTAL, so its clicks bubble the REACT tree into the bar's `onDoubleClick`
 * while its DOM node sits under <body>, where the old `closest('[data-no-drag]')` guard could
 * never see it. `isDragSurfaceDoubleClick` (src/renderer/src/components/titleBarDrag.ts) now asks
 * DOM CONTAINMENT first, which covers every portaled child rather than the one that was reported.
 *
 * WHY IT IS AN E2E SPEC. tests/titleBarDrag.test.mts owns the decision in both directions, and it
 * is a fast pure test — but its DOM is a fake, and the whole defect was that React's tree and the
 * browser's tree disagree. Only a real window with the real MUI Menu can state that a portal's
 * double-click reaches this handler AT ALL (it does — that is the first assertion here) and that
 * the handler now refuses it. The two portals asserted are deliberately different components: the
 * Overlay `Menu` from the report, and the character `Select`'s dropdown, which nobody reported
 * and which was equally broken.
 *
 * HOW THE ANSWER IS READ, and why it is not `isMaximized()`. `BrowserWindow.maximize()` SHOWS a
 * hidden window (Electron's own doc says so), and `EQ_E2E=1` is a test mode whose first promise
 * is that no window is ever shown — a spec that reproduces this bug by really maximizing would
 * throw the app onto the owner's screen mid-suite, and could never assert the POSITIVE case at
 * all. So this spec removes main's own `window:toggleMaximize` listener and counts the messages
 * instead. That is the claim under test stated exactly: the question is what the RENDERER
 * decided to ask for, and the count says it in both directions.
 *
 * Run: `npm run test:e2e -- title-bar`
 */
import type { ElectronApplication, Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  failures,
  note,
  reportRun,
  settle,
  settleGone,
  settleStable
} from './appHarness.mjs'
import { mainWindow, makeUserData, removeUserData } from './appWindow.mjs'
import { launchOnFixture } from './logFixture.mjs'
import { IPC } from '../../src/shared/ipc'

const BAR = '[data-testid="title-bar"]'
const OVERLAY_BUTTON = '[aria-label="Floating DPS overlays"]'
/** One row of the overlay menu — the gesture in the report lands on one of these. */
const OVERLAY_ROW = '[data-testid="overlay-menu-events"]'
/** The menu's own <ul>: 8px of vertical padding that belongs to no row at all. */
const MENU_LIST = '.MuiMenu-list'
/** The character picker's trigger, and the subheader its dropdown opens with (a portal, and a
 *  row that selects nothing when clicked — so double-clicking it changes no character). */
const PICKER = `${BAR} .MuiSelect-select`
const PICKER_SUBHEADER = '.MuiListSubheader-root'
/** The maximize caption button, whose label is main's answer pushed back to the renderer. */
const MAXIMIZE = '[aria-label="Maximize"]'

/**
 * Take main's `window:toggleMaximize` listener away and count the messages instead.
 *
 * The app's own listener is REMOVED on purpose (see the header): with it in place a reproduction
 * would maximize — and therefore show — a window this test mode promises never to show. Nothing
 * else in this spec drives the real window controls.
 */
async function instrumentMaximize(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }, channel: string) => {
    const g = globalThis as unknown as { __eqMaxAsks?: number }
    g.__eqMaxAsks = 0
    ipcMain.removeAllListeners(channel)
    ipcMain.on(channel, () => {
      g.__eqMaxAsks = (g.__eqMaxAsks ?? 0) + 1
    })
  }, IPC.windowToggleMaximize)
}

/** How many times the renderer has asked to toggle maximize since the instrument went in. */
function maximizeAsks(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => (globalThis as unknown as { __eqMaxAsks?: number }).__eqMaxAsks ?? -1)
}

/** Every ask this spec has already accounted for. Each step asserts a DELTA against it. */
let accounted = 0

/**
 * Assert how many times the LAST gesture asked to toggle maximize, and bank the reading.
 *
 * DELTAS, NOT TOTALS, so a step that fails cannot decide the next step's verdict — the first cut
 * compared against zero, and one reproduced ask made every later refusal report the same stale
 * total and fail with it.
 *
 * Two waits, both conditions rather than clocks (settle.mts): first for the expected ask to
 * ARRIVE, which is instant when the expectation is zero, then for the reading to STOP MOVING,
 * which is how "nobody asked" becomes information instead of a bet on IPC latency.
 */
async function checkAsks(app: ElectronApplication, name: string, want: number): Promise<void> {
  await settle(() => maximizeAsks(app), (n) => n - accounted >= want, { timeoutMs: 6_000, pollMs: 100 })
  const now = await settleStable(() => maximizeAsks(app), { timeoutMs: 6_000, pollMs: 100, stable: 3 })
  const delta = now - accounted
  accounted = now
  check(name, delta === want, `asked ${String(delta)}x, expected ${String(want)}`)
}

/** Answer the analytics first-run notice, which a fresh userData always shows over the window. */
async function dismissFirstRunNotice(page: Page): Promise<void> {
  const notice = '[data-testid="telemetry-notice"]'
  await page.waitForSelector(notice, { timeout: 30_000 }).catch(() => undefined)
  if ((await countOf(page, notice)) === 0) return
  await page.click('[data-testid="telemetry-notice-off"]')
  await settleGone(page, notice, { timeoutMs: 8_000 })
}

/** Is `sel` a DOM descendant of the title bar? The portal question, asked of the real DOM. */
function insideBar(page: Page, sel: string): Promise<boolean> {
  return page.evaluate(
    ([barSel, otherSel]) => {
      const bar = document.querySelector(barSel)
      const other = document.querySelector(otherSel)
      return bar != null && other != null && bar.contains(other)
    },
    [BAR, sel] as const
  )
}

/**
 * THE REPORTED GESTURE: the Overlay menu open, two quick clicks on a row.
 *
 * Three assertions, in the order the mechanism runs: the menu really is OUTSIDE the bar in the
 * DOM (without which this spec proves nothing), the double-click really does reach the bar's
 * React handler (asserted by the `data-no-drag` half — a marked control inside the bar is the
 * control case that says the handler is wired at all), and no maximize was asked for.
 */
async function stepOverlayMenu(app: ElectronApplication, page: Page): Promise<void> {
  await page.click(OVERLAY_BUTTON, { timeout: 30_000 })
  await page.waitForSelector(OVERLAY_ROW, { timeout: 15_000 })
  check(
    'the overlay menu is a PORTAL — its rows are not inside the title bar in the DOM',
    !(await insideBar(page, OVERLAY_ROW)),
    'if this is ever false the rest of this spec is asserting nothing'
  )

  // Two quick clicks on a row: the report's gesture. It toggles that overlay on and back off,
  // which is what the user was doing when the window started jumping.
  await page.dblclick(OVERLAY_ROW, { timeout: 15_000 })
  await checkAsks(app, 'double-clicking a row of the open overlay menu never asks to maximize', 0)

  // …and the menu's own padding, which toggles nothing at all: the same portal, a target with no
  // handler of its own, so the ONLY thing that could answer it is the bar.
  await page.dblclick(MENU_LIST, { position: { x: 20, y: 3 }, timeout: 15_000 })
  await checkAsks(app, "…nor does the menu's own padding, which belongs to no row", 0)

  await page.keyboard.press('Escape')
  await settleGone(page, OVERLAY_ROW, { timeoutMs: 8_000 })
}

/** THE PORTAL NOBODY REPORTED: the character picker's dropdown, equally outside the bar. */
async function stepCharacterPicker(app: ElectronApplication, page: Page): Promise<void> {
  if ((await countOf(page, PICKER)) === 0) {
    note('no character picker in this launch — the second portal went unasserted')
    return
  }
  await page.click(PICKER, { timeout: 15_000 })
  await page.waitForSelector(PICKER_SUBHEADER, { timeout: 15_000 })
  check(
    "the character picker's dropdown is a portal too",
    !(await insideBar(page, PICKER_SUBHEADER)),
    ''
  )
  // The subheader is a row that selects nothing, so this changes no character.
  await page.dblclick(PICKER_SUBHEADER, { timeout: 15_000 })
  await checkAsks(
    app,
    'double-clicking inside it never asks to maximize either — the fix is not menu-specific',
    0
  )
  await page.keyboard.press('Escape')
  await settleGone(page, PICKER_SUBHEADER, { timeoutMs: 8_000 })
}

/**
 * A control that really is inside the bar: `data-no-drag` still wins.
 *
 * This used to double-click the preferences GEAR - an in-bar control whose own action (open
 * Preferences, twice) left the bar exactly where it was. The gear is gone (owner, 2026-08-16:
 * Preferences lives in the left nav), so the overlay trigger stands in: its first click opens the
 * menu and the second lands on the menu's backdrop, a portal under <body> that React still routes
 * to this bar's handler. The claim this step makes is therefore the user's-side one - a
 * double-click that starts on an in-bar control never maximizes - and the pure guard's own steps
 * below cover the portal mechanics.
 */
async function stepControlsInBar(app: ElectronApplication, page: Page): Promise<void> {
  await page.dblclick(OVERLAY_BUTTON, { timeout: 15_000 })
  await page.keyboard.press('Escape')
  await checkAsks(
    app,
    'double-clicking a control INSIDE the bar never asks either — data-no-drag still holds',
    0
  )
}

/**
 * THE FEATURE IS STILL THERE. Every assertion above is a refusal, and a handler that refused
 * EVERYTHING would pass all of them — so the bar's own drag surface has to still answer. Safe to
 * drive here only because main's listener is gone: the ask is counted, no window is maximized,
 * nothing is shown.
 */
async function stepDragSurfaceStillMaximizes(app: ElectronApplication, page: Page): Promise<void> {
  // Left of centre and inside the bar's own height: the brand text and the drag spacer live
  // there, and both are plain children of the drag region.
  await page.dblclick(BAR, { position: { x: 60, y: 20 }, timeout: 15_000 })
  await checkAsks(
    app,
    'double-clicking the drag surface DOES ask to maximize — the feature survived the fix',
    1
  )
}

/** The renderer's own view of the window: nothing ever came back saying it was maximized. */
async function stepNeverMaximized(page: Page): Promise<void> {
  const label = await settleStable(() => countOf(page, MAXIMIZE), { timeoutMs: 6_000, pollMs: 100 })
  check(
    'the caption button still offers Maximize — main never told this window it was maximized',
    label === 1,
    `${String(label)} maximize buttons`
  )
}

async function main(): Promise<void> {
  buildIfStale()
  const consoleErrors: string[] = []
  const userData = makeUserData()

  const launched = await launchOnFixture('e2e-telemetry.log', { userData })
  try {
    const page = await mainWindow(launched.app)
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    await dismissFirstRunNotice(page)
    await page.waitForSelector(BAR, { timeout: 60_000 })
    await instrumentMaximize(launched.app)

    await stepOverlayMenu(launched.app, page)
    await stepCharacterPicker(launched.app, page)
    await stepControlsInBar(launched.app, page)
    await stepDragSurfaceStillMaximizes(launched.app, page)
    await stepNeverMaximized(page)

    if (failures.length) await dumpArtifacts(page, 'title-bar-FAIL')
  } finally {
    await launched.close()
    await removeUserData(userData)
  }

  check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  if (failures.length === 0) {
    note('two different MUI portals double-clicked in a real window; neither reached the drag surface')
  }
  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
