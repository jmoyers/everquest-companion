/**
 * Headless Electron integration test for CLOSING THE WINDOW WITHOUT ENDING THE APP (JOS-139).
 *
 * TWO CLAIMS, and they are different kinds of claim:
 *
 *   1. THE PREFERENCE ROUND-TRIPS. Preferences has a `Window` section, its switch is OFF before
 *      anybody touches it (the owner's 2026-08-16 reversal: the X quits until somebody opts in),
 *      flipping it is what MAIN says is stored afterwards, and searching the
 *      pane for "tray" finds it. That last one is not decoration: every one of the five reports
 *      behind this ticket used a different word for the same thing ("notification icon area",
 *      "system tray", "taskbar", "alt-tab"), so the card is only findable if the keywords are.
 *
 *   2. THE CLOSE IS INTERCEPTED, AND THE ACCESSORIES SURVIVE IT. With the preference on, a
 *      `window:close` leaves the main window ALIVE and every open overlay window alive with it —
 *      and the app does not quit. With the preference off, the same gesture destroys them and the
 *      process ends, which is exactly what every other spec in this suite relies on.
 *
 * HOW THE SECOND CLAIM IS DRIVEN, and the honest limit. `EQ_E2E` deliberately creates no tray icon
 * (the harness runs beside the user's own session, and `tests/e2e/appWindow.mts closeWindows` ends
 * a test app by closing every window), so `closeIntent` normally answers 'close' and nothing about
 * this app changes under test. `EQ_TRAY_E2E=1` — read in ONE file, src/main/tray.ts — says "pretend
 * the icon is there": no Tray is created and no popover is ever shown, the interceptor simply
 * answers 'hide'. That is enough to prove the half that matters (the window and the overlays are
 * still there, the process is still running).
 *
 * WHAT IT CANNOT SEE: that the window was `hide()`n rather than merely not closed. Under EQ_E2E no
 * window is ever shown, so `isVisible()` is false either way and an assertion on it would be
 * vacuous. That half is pinned as source order in tests/closeToTray.test.mts (`preventDefault`
 * always comes with a `hide()`) and verified by hand in the real app.
 *
 * Run: `npm run test:e2e -- close-to-tray`
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
import { launchOnFixture, stageFixture } from './logFixture.mjs'
import { openPrefs, openSection, setSwitch } from './prefsFirstPaintSteps.mjs'

const CARD = '[data-testid="pref-close-to-tray"]'
const SWITCH = 'pref-keep-in-tray'

interface CloseToTray {
  enabled: boolean
  noticeAcknowledged: boolean
}

/** The stored preference, straight from main — the proof, rather than the control's own opinion. */
function stored(page: Page): Promise<CloseToTray> {
  return page.evaluate(() =>
    (window as unknown as { eq: { getCloseToTray: () => Promise<CloseToTray> } }).eq.getCloseToTray()
  )
}

/** Every live window this process still has, by title. Titles are what identify them: the main
 *  window and each overlay kind carry their own (windows.ts / overlayLayout.ts). */
function liveWindows(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed())
      .map((w) => w.getTitle())
  )
}

/** The first-run analytics bar sits over the content area; every other spec clears it the same way. */
async function dismissFirstRunNotice(page: Page): Promise<void> {
  const notice = '[data-testid="telemetry-notice"]'
  await page.waitForSelector(notice, { timeout: 30_000 }).catch(() => undefined)
  if ((await countOf(page, notice)) === 0) return
  await page.click('[data-testid="telemetry-notice-off"]')
  await settleGone(page, notice, { timeoutMs: 8_000 })
}

/** CLAIM 1a: the section is in the rail, the card is in it, and it opens OFF. */
async function stepCard(page: Page): Promise<void> {
  await openPrefs(page)
  check(
    'Preferences grows a `Window` section in the rail',
    (await countOf(page, '[data-testid="prefs-rail-window"]')) === 1
  )
  await openSection(page, 'window', CARD)
  const on = await page.$eval(`[data-testid="${SWITCH}"] input`, (el) => (el as HTMLInputElement).checked)
  check('and its switch opens OFF, which is the shipped default', !on)
  check('main agrees, on a store that has never been written', !(await stored(page)).enabled)
}

/** CLAIM 1b: flipping it is what MAIN says is stored, in both directions. Ends ON, which is what
 *  the hide claim below needs. */
async function stepRoundTrip(page: Page): Promise<void> {
  check('the switch takes ON', await setSwitch(page, SWITCH, true))
  const on = await settle(() => stored(page), (p) => p.enabled, { timeoutMs: 8_000 })
  check('and main stored it, so the card is rendering the reply rather than its own request', on.enabled)
  check(
    'the notice flag is untouched by the switch - it is the card’s memory, not a setting',
    on.noticeAcknowledged === false,
    JSON.stringify(on)
  )

  check('and it takes OFF again', await setSwitch(page, SWITCH, false))
  const off = await settle(() => stored(page), (p) => !p.enabled, { timeoutMs: 8_000 })
  check('with main agreeing both ways', !off.enabled)

  check('and ON once more, for the hide claim below', await setSwitch(page, SWITCH, true))
  await settle(() => stored(page), (p) => p.enabled, { timeoutMs: 8_000 })
}

/** CLAIM 1c: the words the reports used all lead here. */
async function stepSearch(page: Page): Promise<void> {
  await page.fill('[data-testid="prefs-search"] input', 'tray')
  const found = await settle(() => countOf(page, CARD), (n) => n === 1, { timeoutMs: 8_000 })
  check('searching Preferences for "tray" finds the card', found === 1)
  await page.fill('[data-testid="prefs-search"] input', '')
  await settle(() => countOf(page, CARD), (n) => n === 1, { timeoutMs: 8_000 })
}

/**
 * CLAIM 2a: the close is intercepted, and NOTHING ELSE goes with it.
 *
 * An overlay is opened first on purpose. The main window's `close` handler destroys every overlay
 * and the cursor ring — an accessory must never keep the app alive — and the whole feature is that
 * a HIDE runs none of that. A spec with no overlay open could not tell the two apart.
 */
async function stepHide(app: ElectronApplication, page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { eq: { toggleOverlay: (k: string) => Promise<boolean> } }).eq.toggleOverlay('fight')
  )
  const before = await settle(() => liveWindows(app), (t) => t.length >= 2, { timeoutMs: 15_000 })
  check('an overlay is open beside the app window', before.length >= 2, before.join(' | '))

  let quit = false
  app.once('close', () => {
    quit = true
  })
  await page.evaluate(() => (window as unknown as { eq: { closeWindow: () => void } }).eq.closeWindow())

  // AN ABSENCE, SO THE WAIT IS FOR A POSITIVE SIGNAL (the suite's law): poll the window list until
  // it STOPS CHANGING, then assert what it settled on. A teardown would have shrunk it to nothing
  // and settled there, which this reads as the failure it is — a fixed sleep would only have been
  // a bet that teardown is fast.
  const after = await settleStable(() => liveWindows(app), { stable: 8, pollMs: 150 })
  check('the app window survived its own close', after.length === before.length, after.join(' | '))
  check('every open overlay survived it too', after.length >= 2, after.join(' | '))
  check('and the process is still running', !quit)
  check(
    'the renderer is still alive in there, folding the log as before',
    (await page.evaluate(() => document.readyState)) === 'complete'
  )
}

/**
 * CLAIM 2b: with the preference off, the X is the X — the window goes, the overlays go with it,
 * and the process ends. This is today's behaviour, and it is what the rest of the suite's teardown
 * (`closeWindows`) depends on.
 */
async function stepCloseForReal(app: ElectronApplication, page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { eq: { setCloseToTray: (p: unknown) => Promise<unknown> } }).eq.setCloseToTray({
      enabled: false
    })
  )
  const exited = app.waitForEvent('close', { timeout: 30_000 }).then(
    () => true,
    () => false
  )
  await page.evaluate(() => (window as unknown as { eq: { closeWindow: () => void } }).eq.closeWindow())
  check('with the preference off, closing the window ends the app exactly as it always did', await exited)
}

async function main(): Promise<void> {
  buildIfStale()
  const consoleErrors: string[] = []

  const userData = makeUserData()
  const log = stageFixture('e2e-telemetry.log')
  // THE ONE VARIABLE THIS SPEC ADDS, and no other spec sets it. See the header.
  const app = await launchOnFixture(log, { userData, env: { EQ_TRAY_E2E: '1' } })
  try {
    const page = await mainWindow(app.app)
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    await dismissFirstRunNotice(page)
    await stepCard(page)
    await stepRoundTrip(page)
    await stepSearch(page)
    if (failures.length) await dumpArtifacts(page, 'close-to-tray-FAIL')
    await stepHide(app.app, page)
    await stepCloseForReal(app.app, page)
  } finally {
    await app.close()
    await removeUserData(userData)
    await log.dispose()
  }

  check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  if (failures.length === 0) {
    note('the hide half runs under EQ_TRAY_E2E=1, read only by src/main/tray.ts - no tray icon is ever created here')
  }
  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
