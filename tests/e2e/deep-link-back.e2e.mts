/**
 * Headless Electron integration test for DEEP-LINK BACK CONTINUITY (JOS-43).
 *
 * THE BUG, in the owner's words: drill into loot or a mob from elsewhere in the app, press Back,
 * and you are dumped at the top of the Loot/Mobs LIST — not where you came from. The contract the
 * app now keeps is that a cross-view deep link carries its ORIGIN and Back returns THERE, while
 * the list stays the back-target for a drill you genuinely opened from the list.
 *
 * WHY ITS OWN FILE, and not more steps bolted onto the Overview spec: the subject is the
 * NAVIGATION SEAM, not a surface. It crosses three tabs (Overview → Loot, Overview → Mobs, and
 * back again) and it is the one thing in the app whose correctness is a round TRIP rather than an
 * arrival. `overview.e2e.mts` is also within a few lines of the repo's `max-lines 400` ceiling,
 * which is the same reason that spec was split out of `combat-dashboard.e2e.mts`.
 *
 * WHY THE OVERVIEW IS THE SENDER HERE: it is the only tab that deep-links to BOTH receivers with
 * rows the log fills on its own — a recent drop opens the Loot drill, a recent kill opens the
 * Mob page. The planner→loot round trip is asserted where that link lives (`planner.e2e.mts`), and
 * the stack RULES themselves (what pushes, what clears, chaining, the bound) are pinned without a
 * browser in `tests/navOriginStack.test.mts`.
 *
 * WHAT IT READS (JOS-29): `tests/fixtures/e2e-deep-link.log` — 339 committed lines carrying two
 * loot lines off a credited Lord Nagafen kill, which is exactly the drop row and the kill row this
 * spec clicks. The steps keep their `note`-rather-than-red guards (the row is still a thing the
 * log has to have produced), but with a fixture the same branch is taken on every machine, every
 * run: the guards are honesty, not a lottery. What was never conditional is the DIRECTION of the
 * assertion — where Back went.
 *
 * SINCE JOS-201 IT ALSO OWNS THE MOUSE'S BACK BUTTON, and that is the right file rather than a new
 * one: mouse4 is not a second navigation model, it is a second way to press the SAME Back this spec
 * already drives, so the two belong under one round trip. What it can and cannot reach is spelled
 * out at `stepMouseBack`.
 *
 * WHY IT NEVER TAKES THE SCREEN: `EQ_E2E=1` (src/main/e2e.ts) shows no window, skips the
 * single-instance lock, and points `userData` at a throwaway temp dir minted per launch.
 *
 * Run: `npm run test:e2e -- deep-link`.
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
  settleCount,
  settleGone,
  settleStable,
  waitHydrated
} from './appHarness.mjs'
import { mainWindow } from './appWindow.mjs'
import { launchOnFixture } from './logFixture.mjs'

const GRID = '[data-testid="overview-grid"]'
const DROP_ROW = '[data-testid="overview-drop-row"]'
/** The NAME is the link on a kill row, not the row: the rest of it is facts about the kill, and
 *  clicking an experience percentage must not navigate. Measured, not assumed — clicking the row
 *  itself lands on the zone/exp cells and goes nowhere. */
const KILL_LINK = '[data-testid="overview-kill-name"]'
const LOOT_DETAIL = '[data-testid="loot-detail"]'
const LOOT_LIST = '[data-testid="loot-list"]'
const LOOT_ROW = '[data-testid="loot-row"]'
const LOOT_BACK = '[data-testid="loot-back"]'
const LOOT_CRUMB = '[data-testid="loot-breadcrumb-root"]'
const MOBS_BACK = '[data-testid="mobs-back"]'

/** Wait for a selector to be mounted; false rather than a throw, so a step can report instead. */
function appears(page: Page, sel: string, ms = 20_000): Promise<boolean> {
  return page.waitForSelector(sel, { timeout: ms }).then(
    () => true,
    () => false
  )
}

/** The accessible name of the back affordance — ONE string also feeding its tooltip, so reading
 *  it proves what the user is told BEFORE they commit to the click. */
function backLabel(page: Page, sel: string): Promise<string> {
  return page.getAttribute(sel, 'aria-label').then((v) => v ?? '')
}

/** Rendered text of the first match; '' when the node isn't mounted. */
function textOf(page: Page, sel: string): Promise<string> {
  return page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '', sel)
}

/**
 * Is there at least one of these yet? A POLL, not a read: coming back to the Overview remounts
 * every card, and its feeds fill from the module snapshot an IPC round trip later. Reading once
 * on arrival reported "no kills in the log" on a log that had just deep-linked one — the classic
 * way a live-data spec turns a timing gap into a false skip.
 */
async function haveRow(page: Page, sel: string, ms = 8000): Promise<boolean> {
  return (await settleCount(page, sel, 1, { timeoutMs: ms })) > 0
}

/**
 * Land, and let the startup replay finish — every row this spec clicks is one the replay puts on
 * the Overview. Same shape as the Overview spec's own hydration wait.
 */
async function stepReady(page: Page): Promise<void> {
  if (!check('the app lands on the Overview', await appears(page, GRID, 60_000))) {
    throw new Error('never landed on Overview — nothing below can be asserted')
  }
  const { snap } = await waitHydrated(page)
  if (!check('hydration completes (the replay has filled the recent feeds)', !snap.hydrating)) {
    throw new Error('still hydrating — nothing below can be asserted')
  }
  // No post-hydration sleep: every step below opens with `haveRow`, which waits for the feed it
  // is about to click. That IS the state the old 1500ms was standing in for (wave E3).
}

/**
 * 1. OVERVIEW → THE LOOT DRILL → BACK TO THE OVERVIEW.
 *
 * The headline round trip. The arrow states its destination before it is pressed, which is the
 * assertion that cannot pass by accident: "Back to the loot list" on a deep-linked drill IS the
 * reported bug, whatever the click then happens to do.
 */
async function stepLootRoundTrip(page: Page): Promise<boolean> {
  if (!(await haveRow(page, DROP_ROW))) {
    note('no loot in the log yet — the drops feed has no row to deep-link from this run')
    return false
  }
  await page.click(DROP_ROW, { timeout: 15_000 })
  if (!check('a recent-drop row opens the Loot tab’s item drill', await appears(page, LOOT_DETAIL, 30_000))) {
    return false
  }
  const label = await backLabel(page, LOOT_BACK)
  check('its back arrow names the tab that sent us, not the ledger', label === 'Back to Overview', label)

  await page.click(LOOT_BACK, { timeout: 15_000 })
  check('…and pressing it returns to the Overview', await appears(page, GRID))
  check(
    '…with the nav agreeing about where we are',
    (await countOf(page, '[data-testid="nav-overview"].Mui-selected')) === 1
  )
  check('…and the loot drill left behind', (await countOf(page, LOOT_DETAIL)) === 0)
  return true
}

/**
 * 2. THE OTHER HALF OF THE SAME CONTRACT: a NATIVE arrival still backs out to its own list.
 *
 * A fix for "Back went to the wrong place" is only correct if it left the right place alone. So:
 * deep-link in again (which also re-proves the router's nonce — the same row must open the same
 * item twice), leave the drill by the BREADCRUMB, which still means the ledger and always will,
 * then open an item the way a reader browsing loot does: by clicking a row in the list they are
 * standing in. That drill was not deep-linked, so Back must say the list and land there.
 */
async function stepNativeArrival(page: Page): Promise<void> {
  await page.click(DROP_ROW, { timeout: 15_000 })
  if (!check('the same drop row deep-links a second time (the nonce contract)', await appears(page, LOOT_DETAIL, 30_000))) {
    return
  }
  await page.click(LOOT_CRUMB, { timeout: 15_000 })
  if (!check('the breadcrumb root still means the loot ledger, deep link or not', await appears(page, LOOT_LIST))) {
    return
  }
  if (!(await haveRow(page, LOOT_ROW))) {
    note('the ledger has no row to open natively this run')
    return
  }
  await page.click(LOOT_ROW, { timeout: 15_000 })
  if (!check('clicking a ledger row opens that item’s drill', await appears(page, LOOT_DETAIL))) return
  const label = await backLabel(page, LOOT_BACK)
  check('a drill opened FROM the list says the list is where back goes', label === 'Back to the loot list', label)
  await page.click(LOOT_BACK, { timeout: 15_000 })
  check('…and it lands there — a native drill does not inherit a parked origin', await appears(page, LOOT_LIST))
  check('…without leaving the Loot tab', (await countOf(page, '[data-testid="nav-loot"].Mui-selected')) === 1)
}

/**
 * 3. THE SECOND RECEIVER: OVERVIEW → A MOB PAGE → BACK TO THE OVERVIEW.
 *
 * The Mobs drill's Back has always NAMED its destination rather than saying "Back", which is why
 * the fix reads as one word changing: it said "Mobs" when the reader had never been there. Here it
 * must read "Overview" and go there. Needs a kill row, so it re-enters from the Overview first.
 */
async function stepMobRoundTrip(page: Page): Promise<void> {
  await page.click('[data-testid="nav-overview"]', { timeout: 15_000 })
  if (!(await appears(page, GRID))) {
    note('could not get back to the Overview to start the mob round trip')
    return
  }
  if (!(await haveRow(page, KILL_LINK))) {
    note('no kills in the log yet — the kills feed has no row to deep-link from this run')
    return
  }
  await page.click(KILL_LINK, { timeout: 15_000 })
  if (!check('a recent-kill name opens the Mobs tab’s creature page', await appears(page, MOBS_BACK, 30_000))) return
  // Rendered text, not the source string: MUI buttons carry `text-transform: uppercase`, so the
  // DOM says OVERVIEW where the code says Overview. The identity is the word, not its casing.
  const label = (await textOf(page, MOBS_BACK)).replace(/\s+/g, ' ').trim()
  check('the mob page’s Back names the Overview, not this tab’s own list', label.toLowerCase() === 'overview', label)
  await page.click(MOBS_BACK, { timeout: 15_000 })
  check('…and pressing it returns to the Overview', await appears(page, GRID))
  check(
    '…rather than to the mobs browse surface',
    (await countOf(page, '[data-testid="mobs-zone-roster"]')) === 0
  )
}

/**
 * 4. A MANUAL TAB SWITCH ENDS THE JOURNEY. Deep-link into the loot drill, then choose a tab by
 * hand and come back through the nav: the drill is gone (leaving a view unmounts it) and nothing
 * of the parked origin survives to hijack the next Back. Stated as the state a user can see — the
 * Loot tab opens on its LEDGER, which is what "nothing parked" looks like from the outside.
 */
async function stepManualNavClears(page: Page): Promise<void> {
  await page.click('[data-testid="nav-overview"]', { timeout: 15_000 })
  if (!(await appears(page, GRID)) || !(await haveRow(page, DROP_ROW))) return
  await page.click(DROP_ROW, { timeout: 15_000 })
  if (!(await appears(page, LOOT_DETAIL, 30_000))) return
  await page.click('[data-testid="nav-mobs"]', { timeout: 15_000 })
  // LEAVING is the act under test — the drill has to actually unmount before coming back can
  // prove that nothing of the parked origin survived it.
  await settleGone(page, LOOT_DETAIL, { timeoutMs: 15_000 })
  await page.click('[data-testid="nav-loot"]', { timeout: 15_000 })
  check('a hand-picked tab ends the journey: Loot re-opens on its ledger', await appears(page, LOOT_LIST))
  check('…with no drill left over', (await countOf(page, LOOT_DETAIL)) === 0)
}

/**
 * PRESS THE MOUSE'S BACK BUTTON (JOS-201).
 *
 * WHAT THIS DOES AND DOES NOT PROVE, stated rather than implied. It raises the `app-command` on the
 * real main window, so everything from `installBackButton`'s listener onward is the shipping path:
 * the command filter, the `app:back` IPC, the preload bridge, the provider's subscription and
 * whatever back affordance is registered. The ONE link it cannot drive is the OS's — Windows
 * turning a physical mouse4 into WM_APPCOMMAND — because Electron surfaces that only as this event
 * and Playwright's synthetic mouse has no XButton at all. (A CDP-injected `mousedown` would prove
 * even less: Chromium routes the real button through the browser process, so it never appears in
 * the renderer as a mouse event on Windows in the first place. That is exactly why this feature is
 * an `app-command` handler and not a DOM listener.)
 *
 * The window is identified by its URL, positively, for the same reason `mainWindow()` identifies
 * it by `window.eq`: the overlays load `overlay.html` and any of them may be open.
 */
function pressMouseBack(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'))
    if (!win) return false
    win.emit('app-command', {}, 'browser-backward')
    return true
  })
}

/**
 * 5. THE BUTTON THE TICKET IS ABOUT: mouse-Back walks the SAME contract the on-screen arrow does.
 *
 * Three presses, three different states, because a back button that only works in the easy case is
 * the bug being fixed rather than the fix: a DEEP-LINKED drill goes back to the tab that sent you
 * (the reported ask — an item description returning to the page that opened it); a NATIVE drill
 * goes back to its own list, unchanged; and a press with no drill and nothing parked does NOTHING,
 * which is the assertion that stops this from becoming a tab-switch generator.
 */
async function stepMouseBack(page: Page, app: ElectronApplication): Promise<void> {
  await page.click('[data-testid="nav-overview"]', { timeout: 15_000 })
  if (!(await appears(page, GRID)) || !(await haveRow(page, DROP_ROW))) {
    note('no drops feed this run — the mouse-back round trip has nothing to deep-link from')
    return
  }
  await page.click(DROP_ROW, { timeout: 15_000 })
  if (!check('a recent-drop row opens the item drill (again)', await appears(page, LOOT_DETAIL, 30_000))) return

  if (!check('the main window accepts the browser-back app-command', await pressMouseBack(app))) return
  check('the mouse’s Back button returns to the tab that deep-linked here', await appears(page, GRID))
  check('…leaving the drill behind, exactly as the arrow does', await settleGone(page, LOOT_DETAIL))

  // A drill opened from the list it belongs to: Back is the list, and the mouse must agree.
  await page.click('[data-testid="nav-loot"]', { timeout: 15_000 })
  if (!(await appears(page, LOOT_LIST)) || !(await haveRow(page, LOOT_ROW))) return
  await page.click(LOOT_ROW, { timeout: 15_000 })
  if (!(await appears(page, LOOT_DETAIL))) return
  await pressMouseBack(app)
  check('on a natively opened drill it means that drill’s own list', await appears(page, LOOT_LIST))
  check('…without leaving the Loot tab', (await countOf(page, '[data-testid="nav-loot"].Mui-selected')) === 1)

  // Nothing to back out of. An ABSENCE, so it is asserted the way this suite asserts absences:
  // wait for the reading to stop moving, THEN read it (wave E3).
  await pressMouseBack(app)
  const stayed = await settleStable(async () => ({
    ledger: await countOf(page, LOOT_LIST),
    drill: await countOf(page, LOOT_DETAIL),
    onLoot: await countOf(page, '[data-testid="nav-loot"].Mui-selected')
  }))
  check(
    'a press with nowhere to go does nothing at all',
    stayed.ledger === 1 && stayed.drill === 0 && stayed.onLoot === 1,
    JSON.stringify(stayed)
  )
}

async function main(): Promise<void> {
  buildIfStale()

  console.log('launch: hidden Electron (EQ_E2E=1) against tests/fixtures/e2e-deep-link.log…')
  const { app, close } = await launchOnFixture('e2e-deep-link.log')

  let page: Page | null = null
  try {
    page = await mainWindow(app)
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    await stepReady(page)
    if (await stepLootRoundTrip(page)) {
      await stepNativeArrival(page)
      await stepManualNavClears(page)
    }
    await stepMobRoundTrip(page)
    await stepMouseBack(page, app)

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

    if (failures.length) await dumpArtifacts(page, 'deep-link-back-FAIL')
    else await dumpArtifacts(page, 'deep-link-back-pass')
  } finally {
    await close()
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
