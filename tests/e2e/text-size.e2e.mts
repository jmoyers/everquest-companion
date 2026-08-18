/**
 * Headless Electron integration test for the MAIN WINDOW's TEXT SIZE (JOS-123).
 *
 * WHY IT IS AN E2E SPEC AND NOT A UNIT TEST. `tests/uiScale.test.mts` pins the ladder, the
 * normalizer and the wiring as source. Every remaining claim in the ticket is about a WINDOW:
 *
 *   1. "the control makes the app bigger" is a claim about a real webContents. The store write,
 *      the IPC handler and the `setZoomFactor` call could all be perfect and the window still not
 *      move; the only honest evidence is the page measuring itself before and after.
 *   2. "it persists across launches, and is applied at startup" is a claim about a SECOND boot
 *      reading a file the first one wrote, so this spec runs two launches over one userData dir —
 *      the telemetry-restart pattern. A reload would prove nothing: the zoom is already on that
 *      webContents.
 * SINCE JOS-405 IT OWNS BOTH TEXT SIZES, because Preferences → Text size now carries both: the
 * window's ladder and the OVERLAYS' shared size, the opt-in switch that unpins them from each
 * other, and the twelve per-overlay rows. Those steps are in ./overlayTextSizeSteps.mts, and they
 * belong to an e2e for a second reason on top of the three below — they are claims about SEPARATE
 * RENDERER PROCESSES agreeing, which no assertion in one process can make.
 *
 * AND SINCE JOS-407 IT OWNS THE OVERLAYS' TRANSPARENCY TOO (./overlayBgAlphaSteps.mts), for the
 * same reason and in the same section — which the section's own name now says out loud.
 *
 *   3. "…before the first paint" is the half no test can watch directly (there is no frame to
 *      inspect in a window that is never shown). What IS assertable is that the window is already
 *      at the stored size the first time the renderer can be asked at all, with nothing in this
 *      spec having touched it — which is what a `webPreferences.zoomFactor` build gives and what a
 *      post-load zoom would not. The construction itself is pinned as source next door.
 *
 * The measurement is `window.devicePixelRatio`, which Chromium reports as the display's own scale
 * multiplied by this webContents' zoom factor. Absolute values are a fact about whatever machine
 * this ran on, so every assertion here is a RATIO against the same window's reading at 100%.
 *
 * Run: `npm run test:e2e -- text-size`
 */
import type { Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  failures,
  note,
  reportRun,
  settle,
  settleGone
} from './appHarness.mjs'
import { mainWindow, makeUserData, removeUserData } from './appWindow.mjs'
// THE OVERLAYS' size (JOS-405) — the same Preferences section, but every claim about it spans two
// renderer processes, so the steps live in their own module beside the harness ones.
import {
  openTwoMeters,
  stepIndependent,
  stepOverlaySizeCard,
  stepPinnedMeterFollows,
  stepSharedAppliesLive,
  stepSurvivesTheSwitch,
  stepWindowMovesShared
} from './overlayTextSizeSteps.mjs'
// …and the overlays' TRANSPARENCY (JOS-407), which lives in the same Preferences section under its
// OWN switch. It runs after the size steps deliberately: they leave their switch on, so the very
// first thing the transparency steps can measure is that one row is half live.
import {
  stepAlphaSurvivesTheSwitch,
  stepBgAlphaCard,
  stepIndependentAlpha,
  stepSharedAlphaAppliesLive,
  stepWindowMovesSharedAlpha
} from './overlayBgAlphaSteps.mjs'
import { launchOnFixture, stageFixture } from './logFixture.mjs'
import { UI_SCALE_DEFAULT, UI_SCALE_STEPS, uiScalePercent } from '../../src/shared/uiScale'

const RAIL = '[data-testid="prefs-rail-textsize"]'
const PANE = '[data-testid="pref-text-size"]'
const NOTE = '[data-testid="pref-text-size-note"]'
const BUTTON = `${PANE} button`

/** The stop this spec chooses. A middle rung on purpose: an end would also pass a control that
 *  could only ever go to its own limit. */
const CHOSEN = 1.25
/** Floating point through a ratio of two measured pixel ratios; a stop is 0.1 away from its
 *  neighbour, so this is tight enough to tell them apart by an order of magnitude. */
const TOLERANCE = 0.005

const stopSelector = (scale: number): string =>
  `[data-testid="pref-text-size-${uiScalePercent(scale).replace('%', '')}"]`

/** What the page can say about how big it is being drawn. */
interface Zoom {
  /** display scale x zoom factor. Independent of the window's size, which is why it leads. */
  dpr: number
  /** CSS pixels across the window: shrinks as the zoom grows, at a fixed window size. */
  innerWidth: number
}

function zoomOf(page: Page): Promise<Zoom> {
  return page.evaluate(() => ({ dpr: window.devicePixelRatio, innerWidth: window.innerWidth }))
}

function storedScale(page: Page): Promise<number> {
  return page.evaluate(() =>
    (window as unknown as { eq: { getUiScale: () => Promise<number> } }).eq.getUiScale()
  )
}

/** Which stop is lit, as the DOM states it (MUI marks the selected toggle `aria-pressed`). */
function pressedLabel(page: Page): Promise<string> {
  return page.evaluate((sel) => {
    const on = document.querySelector(`${sel}[aria-pressed="true"]`)
    return (on as HTMLElement | null)?.innerText.trim() ?? ''
  }, BUTTON)
}

/**
 * Answer the analytics first-run notice, which a FRESH userData always shows and which sits over
 * the whole window until it is answered (the perf spec's helper, same reason). "Turn it off" keeps
 * this run quiet.
 */
async function dismissFirstRunNotice(page: Page): Promise<void> {
  const notice = '[data-testid="telemetry-notice"]'
  await page.waitForSelector(notice, { timeout: 30_000 }).catch(() => undefined)
  if ((await countOf(page, notice)) === 0) return
  await page.click('[data-testid="telemetry-notice-off"]')
  await settleGone(page, notice, { timeoutMs: 8_000 })
}

async function openTextSize(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="nav-preferences"]', { timeout: 60_000 })
  await page.click('[data-testid="nav-preferences"]', { timeout: 30_000 })
  await page.click(RAIL, { timeout: 15_000 })
  await page.waitForSelector(PANE, { timeout: 15_000 })
}

/** The card itself: every stop on the ladder, one of them lit, and the sentence that sends an
 *  overlay question to the overlay. */
async function stepCard(page: Page): Promise<void> {
  check('Preferences has a Text size section', (await countOf(page, PANE)) === 1)
  const buttons = await countOf(page, BUTTON)
  check(
    'it offers every stop on the ladder, from 90% to 150%',
    buttons === UI_SCALE_STEPS.length,
    `${String(buttons)} of ${String(UI_SCALE_STEPS.length)}`
  )
  const labels = await page.evaluate(
    (sel) => Array.from(document.querySelectorAll(sel)).map((b) => (b as HTMLElement).innerText.trim()),
    BUTTON
  )
  check(
    '…labelled as the percentages the shared ladder states',
    JSON.stringify(labels) === JSON.stringify(UI_SCALE_STEPS.map(uiScalePercent)),
    labels.join(' ')
  )
  const pressed = await pressedLabel(page)
  check(
    'a fresh install is lit at 100% — the default is unchanged for everybody who never chose',
    pressed === uiScalePercent(UI_SCALE_DEFAULT),
    pressed || 'nothing pressed'
  )
  const text = (await page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText ?? '',
    NOTE
  ))
    .replace(/\s+/g, ' ')
    .trim()
  // JOS-405 CHANGED WHAT THIS SENTENCE SAYS. It used to send an overlay question to the overlay
  // ("the floating overlays keep their own size control, on the overlay itself") and two 1.4.0
  // reporters proved that was a dead end — the stepper it pointed at is in a footer a PINNED
  // overlay does not draw. It now points at the control directly below it, in this same section.
  check(
    '…and the caption points at the overlays’ own size, which is now the next control down',
    /overlay/i.test(text) && !/on the overlay itself/i.test(text),
    text.slice(0, 140)
  )
}

/** THE ASSERTION THE TICKET IS ABOUT: pressing a stop makes this window bigger, now. */
async function stepBiggerNow(page: Page, base: Zoom): Promise<void> {
  await page.click(stopSelector(CHOSEN), { timeout: 15_000 })
  const after = await settle(
    () => zoomOf(page),
    (z) => Math.abs(z.dpr / base.dpr - CHOSEN) < TOLERANCE,
    { timeoutMs: 15_000 }
  )
  check(
    `pressing ${uiScalePercent(CHOSEN)} draws the window ${uiScalePercent(CHOSEN)} bigger, without a relaunch`,
    Math.abs(after.dpr / base.dpr - CHOSEN) < TOLERANCE,
    `devicePixelRatio ${String(base.dpr)} -> ${String(after.dpr)}`
  )
  check(
    '…which is a LAYOUT change, not a font swap: the same window now holds fewer CSS pixels',
    after.innerWidth < base.innerWidth,
    `${String(base.innerWidth)} -> ${String(after.innerWidth)} CSS px`
  )
  const stored = await storedScale(page)
  check('…and the stored answer is what was pressed', stored === CHOSEN, String(stored))
  const pressed = await pressedLabel(page)
  check('…with that stop lit', pressed === uiScalePercent(CHOSEN), pressed || 'nothing pressed')
}

/** The second launch: the size is already on before this spec touches anything. */
async function stepPersisted(page: Page, base: Zoom): Promise<void> {
  const arrived = await zoomOf(page)
  check(
    'a relaunch comes up ALREADY at the chosen size — nothing in this spec has clicked yet',
    Math.abs(arrived.dpr / base.dpr - CHOSEN) < TOLERANCE,
    `devicePixelRatio ${String(base.dpr)} at 100% -> ${String(arrived.dpr)} on arrival`
  )
  const stored = await storedScale(page)
  check('…because the choice outlived the process that made it', stored === CHOSEN, String(stored))
  await openTextSize(page)
  // WAIT FOR THE CONDITION. The card hydrates its value from main like every other prefs card, so
  // the lit button is an IPC round trip behind the mount — it opens on the 100% it was
  // constructed with and lands on the stored answer a moment later. That is the app's own
  // hydration pattern rather than a defect (the window itself was already at 125% before this
  // spec could ask, which is the assertion above); reading it on arrival was the race.
  const pressed = await settle(
    () => pressedLabel(page),
    (label) => label === uiScalePercent(CHOSEN),
    { timeoutMs: 15_000 }
  )
  check(
    '…and Preferences agrees with the window it is drawn in',
    pressed === uiScalePercent(CHOSEN),
    pressed || 'nothing pressed'
  )
}

/**
 * A RELOAD KEEPS THE SIZE — the assertion that decides whether main needs a `did-finish-load`
 * listener re-stating the zoom, and the reason it does not have one.
 *
 * Chromium keeps a zoom LEVEL per origin, so "a reload resets it" is a plausible enough worry
 * that the first cut of this feature carried a re-apply against it. Measured here instead: the
 * window is reloaded, and the size has to still be there. (The re-apply was also not free — a
 * post-load setZoomFactor wedged Playwright's stability check in a never-composited window and
 * took loadout-override.e2e.mts from green to a hard timeout. See windows.ts.)
 */
async function stepSurvivesReload(page: Page, base: Zoom): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForSelector('[data-testid="nav-preferences"]', { timeout: 60_000 })
  const after = await zoomOf(page)
  check(
    'a reload keeps the size, with nothing in main re-stating it',
    Math.abs(after.dpr / base.dpr - CHOSEN) < TOLERANCE,
    `devicePixelRatio ${String(base.dpr)} at 100% -> ${String(after.dpr)} after reload`
  )
}

/** Every way in is a way out: 100% must be reachable from anywhere on the ladder. */
async function stepBackTo100(page: Page, base: Zoom): Promise<void> {
  await page.click(stopSelector(UI_SCALE_DEFAULT), { timeout: 15_000 })
  const back = await settle(
    () => zoomOf(page),
    (z) => Math.abs(z.dpr - base.dpr) < TOLERANCE,
    { timeoutMs: 15_000 }
  )
  check(
    'choosing 100% again puts the window back exactly where it started',
    Math.abs(back.dpr - base.dpr) < TOLERANCE,
    `devicePixelRatio ${String(base.dpr)} -> ${String(back.dpr)}`
  )
  const stored = await storedScale(page)
  check('…and stores it, so the next launch is ordinary again', stored === UI_SCALE_DEFAULT, String(stored))
}

async function main(): Promise<void> {
  buildIfStale()
  const consoleErrors: string[] = []
  const watch = (page: Page): void => {
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))
  }

  // ONE dir for both launches, because the assertion between them is that it OUTLIVES the process
  // — the one thing a per-launch dir must not do by itself. And ONE staged log, so the two boots
  // are comparable in everything except the setting under test.
  const userData = makeUserData()
  const log = stageFixture('e2e-telemetry.log')

  /** The window's own reading at 100%, taken in launch 1 and compared against in launch 2. It is
   *  a fact about this display, so it can only come from this display. */
  let base: Zoom = { dpr: 1, innerWidth: 0 }

  console.log('launch 1: hidden Electron (EQ_E2E=1), fresh userData — the control and the press…')
  const first = await launchOnFixture(log, { userData })
  try {
    const page = await mainWindow(first.app)
    watch(page)
    await dismissFirstRunNotice(page)
    await openTextSize(page)
    await stepCard(page)
    base = await zoomOf(page)
    check('the window reports a usable baseline to measure against', base.dpr > 0 && base.innerWidth > 0, JSON.stringify(base))
    await stepBiggerNow(page, base)
    if (failures.length) await dumpArtifacts(page, 'text-size-FAIL-first')
  } finally {
    await first.close()
  }

  console.log('launch 2: same userData — does the size survive a restart…')
  const second = await launchOnFixture(log, { userData })
  try {
    const page = await mainWindow(second.app)
    watch(page)
    await stepPersisted(page, base)
    // The reload lands between the two on purpose: it needs a window that is already at the
    // chosen size, and it puts the view back to the app's default, so the last step re-opens
    // the section like any arriving user would.
    await stepSurvivesReload(page, base)
    await openTextSize(page)
    await stepBackTo100(page, base)

    // ---- THE OTHER TEXT SIZE (JOS-405) ----
    // The same section carries the OVERLAYS' size now, and every claim about it is a claim about
    // two renderer processes agreeing — see tests/e2e/overlayTextSizeSteps.mts for why none of it
    // can be a unit test. It runs in this launch because it needs a window whose Preferences pane
    // is already open, and it leaves the meters open for the teardown to close.
    await stepOverlaySizeCard(page)
    const meters = await openTwoMeters(second.app, page)
    if (meters) {
      const [fight, overall] = meters
      await stepSharedAppliesLive(page, fight, overall)
      await stepWindowMovesShared(page, fight, overall)
      await stepPinnedMeterFollows(page, fight)
      const own = await stepIndependent(page, fight, overall)
      await stepSurvivesTheSwitch(page, fight, overall, own)

      // ---- AND THE TRANSPARENCY (JOS-407) ----
      // The same section, the same two meters, and a switch of its own. The card step runs first
      // because it is the one that can see the two switches disagreeing — the size's is ON when
      // it starts, left that way by the step directly above.
      await stepBgAlphaCard(page)
      await stepSharedAlphaAppliesLive(page, fight, overall)
      await stepWindowMovesSharedAlpha(page, fight, overall)
      const ownAlpha = await stepIndependentAlpha(page, fight, overall)
      await stepAlphaSurvivesTheSwitch(page, fight, overall, ownAlpha)
    }
    if (failures.length) await dumpArtifacts(page, 'text-size-FAIL-restart')
  } finally {
    await second.close()
    await removeUserData(userData)
    await log.dispose()
  }

  // A missing IPC handler shows up here first (`invoke` rejects into an unhandled rejection).
  check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  if (consoleErrors.length === 0) {
    note('two real launches over one userData dir — the persistence claim is a restart, not a reload')
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
