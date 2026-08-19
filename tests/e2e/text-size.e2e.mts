/**
 * Headless Electron integration test for PREFERENCES → APPEARANCE (JOS-123, JOS-405, JOS-407,
 * reshaped by JOS-408).
 *
 * WHY IT IS AN E2E SPEC AND NOT A UNIT TEST. `tests/uiScale.test.mts` pins the ladder, the
 * normalizer, the stepper's rungs and the wiring as source. Every remaining claim is about a
 * WINDOW:
 *
 *   1. "the control makes the app bigger" is a claim about a real webContents. The store write, the
 *      IPC handler and the `setZoomFactor` call could all be perfect and the window still not move;
 *      the only honest evidence is the page measuring itself before and after.
 *   2. "it persists across launches, and is applied at startup" is a claim about a SECOND boot
 *      reading a file the first one wrote, so this spec runs two launches over one userData dir —
 *      the telemetry-restart pattern. A reload would prove nothing: the zoom is already on that
 *      webContents.
 *   3. "…before the first paint" is the half no test can watch directly (there is no frame to
 *      inspect in a window that is never shown). What IS assertable is that the window is already
 *      at the stored size the first time the renderer can be asked at all, with nothing in this
 *      spec having touched it — which is what a `webPreferences.zoomFactor` build gives and what a
 *      post-load zoom would not. The construction itself is pinned as source next door.
 *
 * SINCE JOS-408 THE SECTION IS CALLED APPEARANCE AND IS TWO CARDS: this window's text size as an
 * A− / A+ over the same five-stop ladder, and ONE Overlays card whose single Independent switch
 * governs both the overlays' text size and their transparency. The overlay steps live in
 * ./overlaysAppearanceSteps.mts — one module for one card, folded together the way the two cards
 * were — and they belong to an e2e for a reason on top of the three above: they are claims about
 * SEPARATE RENDERER PROCESSES agreeing, which no assertion in one process can make.
 *
 * The main window's measurement is `window.devicePixelRatio`, which Chromium reports as the
 * display's own scale multiplied by this webContents' zoom factor. Absolute values are a fact about
 * whatever machine this ran on, so every assertion here is a RATIO against the same window's
 * reading at 100%.
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
// THE OVERLAYS' appearance (JOS-405, JOS-407, JOS-408) — the same Preferences section, but every
// claim about it spans two renderer processes, so the steps live in their own module beside the
// harness ones.
import {
  openTwoMeters,
  stepClosedTag,
  stepIndependentRow,
  stepIndependentShape,
  stepPinnedMeterFollows,
  stepRowFollowsWindow,
  stepSharedAlphaAppliesLive,
  stepSharedSizeAppliesLive,
  stepSurvivesTheSwitch,
  stepSyncedShape,
  stepWindowMovesShared
} from './overlaysAppearanceSteps.mjs'
import { launchOnFixture, stageFixture } from './logFixture.mjs'
import { UI_SCALE_DEFAULT, UI_SCALE_MAX, UI_SCALE_MIN, uiScalePercent } from '../../src/shared/uiScale'

const RAIL = '[data-testid="prefs-rail-textsize"]'
const PANE = '[data-testid="pref-text-size"]'
const NOTE = '[data-testid="pref-text-size-note"]'
const VALUE = '[data-testid="pref-text-size-value"]'
const MINUS = '[data-testid="pref-text-size-minus"]'
const PLUS = '[data-testid="pref-text-size-plus"]'

/** The stop this spec chooses. A middle rung on purpose: an end would also pass a control that
 *  could only ever go to its own limit. It is TWO presses of A+ from the default, because the
 *  stepper walks the ladder's own rungs (100 → 110 → 125) rather than adding a fixed amount. */
const CHOSEN = 1.25
const PRESSES_TO_CHOSEN = 2
/** Floating point through a ratio of two measured pixel ratios; a stop is 0.1 away from its
 *  neighbour, so this is tight enough to tell them apart by an order of magnitude. */
const TOLERANCE = 0.005

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

/** What the stepper is printing. The five buttons became one readout in JOS-408, so "which stop is
 *  chosen" is a string rather than an `aria-pressed` scan. */
function shownScale(page: Page): Promise<string> {
  return page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText.trim() ?? '',
    VALUE
  )
}

/** Whether one of the stepper's ends is disabled, as the DOM states it. */
function isDisabled(page: Page, selector: string): Promise<boolean> {
  return page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLButtonElement | null)?.disabled === true,
    selector
  )
}

/** Press one end N times, waiting for the readout to settle after each — the size applies over IPC
 *  and a press sent into a value that has not landed yet would step from the old rung. */
async function press(page: Page, selector: string, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    const before = await shownScale(page)
    await page.click(selector, { timeout: 15_000 })
    await settle(() => shownScale(page), (v) => v !== before, { timeoutMs: 15_000 }).catch(() => before)
  }
}

/**
 * Press one end until it refuses, and hand back where it stopped.
 *
 * IT CHECKS `disabled` BEFORE EACH CLICK RATHER THAN CLICKING A FIXED NUMBER OF TIMES, and that is
 * the design under test rather than a convenience: the ladder's end is a DISABLED button, so a
 * spec that kept clicking would be asserting against a control the product deliberately made
 * unclickable — Playwright waits for `enabled` and times out. The cap is a runaway guard; a ladder
 * that never disabled its end would exhaust it and fail the claim below rather than loop forever.
 */
async function pressToEnd(page: Page, selector: string): Promise<number> {
  let pressed = 0
  for (let i = 0; i < 8 && !(await isDisabled(page, selector)); i++) {
    const before = await shownScale(page)
    await page.click(selector, { timeout: 15_000 })
    await settle(() => shownScale(page), (v) => v !== before, { timeoutMs: 15_000 }).catch(() => before)
    pressed++
  }
  return pressed
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

async function openAppearance(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="nav-preferences"]', { timeout: 60_000 })
  await page.click('[data-testid="nav-preferences"]', { timeout: 30_000 })
  await page.click(RAIL, { timeout: 15_000 })
  await page.waitForSelector(PANE, { timeout: 15_000 })
}

/** The card itself: ONE stepper, the stored rung printed, and the sentence that says this control
 *  is about the app window and the overlays are below. */
async function stepCard(page: Page): Promise<void> {
  check('Preferences → Appearance has an in-app text size', (await countOf(page, PANE)) === 1)
  const rail = await page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText.trim() ?? '',
    RAIL
  )
  check('…and the rail row is called Appearance', rail === 'Appearance', rail)
  // ONE control, not five. The whole page is steppers now (owner, 2026-08-17: "make the controls
  // uniform - the +/- version of the control on the whole page").
  const buttons = await countOf(page, `${PANE} button`)
  check('it is ONE stepper — a minus and a plus, not a row of percentages', buttons === 2, `${String(buttons)} button(s)`)
  const shown = await shownScale(page)
  check(
    'a fresh install prints 100% — the default is unchanged for everybody who never chose',
    shown === uiScalePercent(UI_SCALE_DEFAULT),
    shown || 'nothing printed'
  )
  const text = (await page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText ?? '',
    NOTE
  ))
    .replace(/\s+/g, ' ')
    .trim()
  // JOS-408 NARROWED WHAT THIS SENTENCE CLAIMS. It used to say "the whole window"; the owner asked
  // for it to be about the app itself, with the overlays named as the card below rather than as a
  // footnote on this one.
  check(
    '…and the caption says this is the app window only, with the overlays below',
    /app window/i.test(text) && /overlays/i.test(text),
    text.slice(0, 160)
  )
}

/** THE ASSERTION THE TICKET IS ABOUT: pressing A+ makes this window bigger, now. */
async function stepBiggerNow(page: Page, base: Zoom): Promise<void> {
  await press(page, PLUS, PRESSES_TO_CHOSEN)
  const after = await settle(
    () => zoomOf(page),
    (z) => Math.abs(z.dpr / base.dpr - CHOSEN) < TOLERANCE,
    { timeoutMs: 15_000 }
  )
  check(
    `two presses of A+ walk the ladder to ${uiScalePercent(CHOSEN)} and draw the window that much bigger, without a relaunch`,
    Math.abs(after.dpr / base.dpr - CHOSEN) < TOLERANCE,
    `devicePixelRatio ${String(base.dpr)} -> ${String(after.dpr)}`
  )
  check(
    '…which is a LAYOUT change, not a font swap: the same window now holds fewer CSS pixels',
    after.innerWidth < base.innerWidth,
    `${String(base.innerWidth)} -> ${String(after.innerWidth)} CSS px`
  )
  const stored = await storedScale(page)
  check('…and the stored answer is the RUNG, never a value between two of them', stored === CHOSEN, String(stored))
  const shown = await shownScale(page)
  check('…with the stepper printing it', shown === uiScalePercent(CHOSEN), shown || 'nothing printed')
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
  await openAppearance(page)
  // NO SETTLE NEEDED SINCE JOS-340, and this is where that fix is most visible: the card seeds from
  // the pane's hydration snapshot, so the stored rung is what it prints on its FIRST frame. The
  // wait is only for the pane to exist at all.
  const shown = await settle(() => shownScale(page), (v) => v !== '', { timeoutMs: 15_000 })
  check('…and Preferences agrees with the window it is drawn in', shown === uiScalePercent(CHOSEN), shown || 'nothing printed')
}

/**
 * A RELOAD KEEPS THE SIZE — the assertion that decides whether main needs a `did-finish-load`
 * listener re-stating the zoom, and the reason it does not have one.
 *
 * Chromium keeps a zoom LEVEL per origin, so "a reload resets it" is a plausible enough worry that
 * the first cut of this feature carried a re-apply against it. Measured here instead. (The
 * re-apply was also not free — a post-load setZoomFactor wedged Playwright's stability check in a
 * never-composited window and took loadout-override.e2e.mts from green to a hard timeout.)
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

/**
 * THE ENDS OF THE LADDER, AND THE ONLY DISABLED BUTTONS THE OWNER'S REVIEW ALLOWS.
 *
 * "our first pass had enabled controls when they didn't do anything" — the answer everywhere else
 * in this section was to stop rendering the control. A stepper at its clamp is the one exception,
 * and it is a different statement: the button is there because the value can move in general, and
 * it is grey because it cannot move THIS way. So the claim is symmetrical — at the top, A+ is dead
 * and A− is live; at the bottom, the reverse — and it is measured at both ends.
 */
async function stepEnds(page: Page): Promise<void> {
  const up = await pressToEnd(page, PLUS)
  const top = await shownScale(page)
  check('A+ walks the ladder up and then REFUSES — it stops at the top rung', top === uiScalePercent(UI_SCALE_MAX),
    `${String(up)} press(es) to ${top}`)
  check('…and it is disabled there, because the value cannot move', await isDisabled(page, PLUS))
  check('…while A− is still live, because it can', (await isDisabled(page, MINUS)) === false)

  const down = await pressToEnd(page, MINUS)
  const bottom = await shownScale(page)
  check('A− does the same at the bottom', bottom === uiScalePercent(UI_SCALE_MIN), `${String(down)} press(es) to ${bottom}`)
  check('…disabled there, with A+ live — the same rule, mirrored',
    (await isDisabled(page, MINUS)) && !(await isDisabled(page, PLUS)))
  // The whole ladder was walked in both directions, which is also the claim that the five rungs
  // are still five: four presses from the top to the bottom.
  check('…and the two walks covered the whole ladder', down === 4, `${String(down)} presses from top to bottom`)
}

/** Every way in is a way out: 100% must be reachable from anywhere on the ladder. */
async function stepBackTo100(page: Page, base: Zoom): Promise<void> {
  await press(page, PLUS, 1)
  const back = await settle(
    () => zoomOf(page),
    (z) => Math.abs(z.dpr - base.dpr) < TOLERANCE,
    { timeoutMs: 15_000 }
  )
  check(
    'stepping back to 100% puts the window exactly where it started',
    Math.abs(back.dpr - base.dpr) < TOLERANCE,
    `devicePixelRatio ${String(base.dpr)} -> ${String(back.dpr)}`
  )
  const stored = await storedScale(page)
  check('…and stores it, so the next launch is ordinary again', stored === UI_SCALE_DEFAULT, String(stored))
}

/**
 * THE OVERLAYS CARD, in the order the ticket's confusion audit walks it: the synced shape, the
 * shared controls working in both directions, the pinned meter, then the switch and the twelve
 * rows, then back through the switch to prove nothing was lost.
 */
async function overlaySteps(page: Page, fight: Page, overall: Page): Promise<void> {
  await stepSyncedShape(page)
  await stepSharedSizeAppliesLive(page, fight, overall)
  await stepSharedAlphaAppliesLive(page, fight, overall)
  await stepWindowMovesShared(page, fight, overall)
  await stepPinnedMeterFollows(page, fight)

  await stepIndependentShape(page)
  await stepClosedTag(page)
  await stepIndependentRow(page, fight, overall)
  const remembered = await stepRowFollowsWindow(page, fight)
  await stepSurvivesTheSwitch(page, fight, overall, remembered)
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
    await openAppearance(page)
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
    // chosen size, and it puts the view back to the app's default, so the steps after it re-open
    // the section like any arriving user would.
    await stepSurvivesReload(page, base)
    await openAppearance(page)
    // The ends first, then home: everything below runs at 100%, which is where the overlay steps'
    // own clicking is most reliable and where a reader of a failure screenshot expects to be.
    await stepEnds(page)
    await stepBackTo100(page, base)

    // ---- THE OTHER HALF OF APPEARANCE (JOS-405, JOS-407, folded by JOS-408) ----
    // Every claim about the Overlays card is a claim about two renderer processes agreeing — see
    // tests/e2e/overlaysAppearanceSteps.mts for why none of it can be a unit test. It runs in this
    // launch because it needs a window whose Preferences pane is already open, and it leaves the
    // meters open for the teardown to close.
    const meters = await openTwoMeters(second.app, page)
    if (meters) await overlaySteps(page, meters[0], meters[1])
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
