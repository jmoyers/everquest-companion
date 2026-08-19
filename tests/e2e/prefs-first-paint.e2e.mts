/**
 * Headless Electron integration test for PREFERENCES HYDRATION (JOS-340) — a control never paints
 * a value it does not know.
 *
 * THE DEFECT. Every card in Preferences reads a store that lives in MAIN, over a bridge on which
 * every method is an `ipcRenderer.invoke` promise. They were all written the same way: mount on
 * the compiled-in default, then correct from an effect. So the first painted frame of a switch was
 * always the DEFAULT, and the user's own value arrived a hop later. The owner reported it as
 * booleans that are ON rendering OFF and flickering ON.
 *
 * WHY IT IS AN E2E SPEC AND NOT A UNIT TEST. The claim is about a FRAME. A unit test can assert
 * that a hook returns the seeded value, and `tests/prefsHydration.test.mts` does exactly that for
 * the cache and its single-flight — but the thing that broke was the composition: a real store, a
 * real IPC hop, React's real commit order, and MUI's real DOM. Only the running app has all four.
 *
 * WHY IT DOES NOT USE `settle`. Everywhere else in this suite, waiting for the condition is the
 * law. Here it is the enemy: a settled read of a flickering switch is GREEN, because the flicker
 * ends correct. So the instrument is a `MutationObserver` armed by `page.addInitScript` before any
 * page script runs, recording the ordered list of distinct values each watched control has shown.
 * One entry means it was born right; two means it flashed, and the failure prints which way.
 * The recorder and its reasoning live in ./prefsFirstPaintSteps.mts.
 *
 * WHAT IT WATCHES, and the reason each is not redundant:
 *   * `hideWhenNotRunning` is stored OFF against a `true` default, and
 *   * `hideWhenUnfocused` is stored ON against a `false` default — the two directions, because a
 *     "fix" that merely flipped a default would cure exactly one of them, and the ticket asks
 *     about the reverse direction explicitly.
 *   * the in-app text size is stored at 110% against a 100% default — the non-boolean, because a
 *     readout flashes the same way a checkbox does and the law is not about checkboxes. It is a
 *     stepper's printed percentage since JOS-408 rather than a lit rung.
 *   * `pref-overlay-independent` is stored ON against a shipped OFF (JOS-408) — the switch that
 *     decides which SHAPE the Overlays card has. A flash there is not one control painting a guess
 *     but a whole card mounting the wrong way round: two shared steppers where twelve rows belong.
 *
 * AND IT ASSERTS TWO MOUNTS, because the pane has two ways of being born:
 *   1. A SECTION SWITCH. The rail is a switcher — one section mounted at a time — so every rail
 *      click is a fresh mount of those cards. This is the everyday case and it is the one a user
 *      hits over and over.
 *   2. A COLD RENDERER. After a reload nothing is cached at all, so the pane's very first paint is
 *      the one the hydration gate has to hold. Same claim, from zero.
 *
 * Run: `npm run test:e2e -- prefs-first-paint`
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
  settleGone
} from './appHarness.mjs'
import { mainWindow, makeUserData, removeUserData } from './appWindow.mjs'
import { launchOnFixture, stageFixture } from './logFixture.mjs'
import {
  armFirstPaintRecorder,
  checkFirstPaint,
  openPrefs,
  openSection,
  recorded,
  resetRecorder,
  setSwitch,
  storedAutoHide,
  storedScale
} from './prefsFirstPaintSteps.mjs'
import { uiScalePercent } from '../../src/shared/uiScale'

/** The section markers each rail click waits for. */
const OVERLAYS = '[data-testid="pref-overlay-autohide"]'
const APPEARANCE = '[data-testid="pref-text-size"]'
const GAME = '[data-testid="eq-folder-path"]'

/**
 * A middle rung, and NOT the default. An end of the ladder would also be reached by a control that
 * could only ever go to its own limit, and the default would make the whole claim vacuous. It is
 * ONE press of A+ from the shipped 100%, because the stepper walks the ladder's own rungs.
 */
const CHOSEN_SCALE = 1.1
const CHOSEN_LABEL = uiScalePercent(CHOSEN_SCALE)

/** The first-run analytics bar sits over the content area; every other spec clears it the same way. */
async function dismissFirstRunNotice(page: Page): Promise<void> {
  const notice = '[data-testid="telemetry-notice"]'
  await page.waitForSelector(notice, { timeout: 30_000 }).catch(() => undefined)
  if ((await countOf(page, notice)) === 0) return
  await page.click('[data-testid="telemetry-notice-off"]')
  await settleGone(page, notice, { timeoutMs: 8_000 })
}

/**
 * ARRANGE: put all three controls somewhere their DEFAULTS are not, through the real UI.
 *
 * Through the UI and not through `eq.setOverlayAutoHide`, for the reason combatPrefsSteps gives:
 * the write path is half of what makes the stored value real, and a test that seeds the store
 * directly proves nothing about the control it is about to watch. The stored values are then read
 * back from MAIN, so the expectations below rest on what is on disk rather than on what was
 * clicked.
 */
async function stepArrange(page: Page): Promise<void> {
  await openPrefs(page)
  await openSection(page, 'overlays', OVERLAYS)
  const a = await setSwitch(page, 'pref-hide-when-not-running', false)
  const b = await setSwitch(page, 'pref-hide-when-unfocused', true)
  check('both auto-hide switches take a value AGAINST their default (one each way)', a && b)
  // The banner ships OFF; ON is the value its card used to be born wrong for. Its switch is an
  // overlay's open-state, so the settle here waits on main's own push, not a local echo.
  const c = await setSwitch(page, 'pref-banner-enabled', true)
  check('the alert banner switch takes ON against its shipped OFF', c)

  await openSection(page, 'textsize', APPEARANCE)
  await page.click('[data-testid="pref-text-size-plus"]', { timeout: 15_000 })
  // …and the Overlays card's one switch, ON against its shipped OFF (JOS-408). It is what decides
  // whether that card is two shared steppers or twelve rows, so a first paint that gets it wrong
  // shows the reader the wrong card and then swaps it under them.
  const ind = await setSwitch(page, 'pref-overlay-independent', true)
  check('the overlays’ Independent switch takes ON against its shipped OFF', ind)

  const stored = await storedAutoHide(page)
  check(
    'main stored the pair as clicked, so the expectations below are about DISK and not about the UI',
    !stored.hideWhenNotRunning && stored.hideWhenUnfocused,
    JSON.stringify(stored)
  )
  const scale = await storedScale(page)
  check('…and stored the text size off the default rung', scale === CHOSEN_SCALE, String(scale))
}

/**
 * THE EVERYDAY MOUNT: leave the section, come back, and watch what the controls are BORN as.
 *
 * The rail switch to Game is what unmounts them — one section is mounted at a time — and the reset
 * happens while they are gone, so every value the recorder holds afterwards was painted by this
 * mount and no other. Before JOS-340 this reported `on -> off` and `off -> on`: two controls
 * flashing in opposite directions, which is the fingerprint of mounting on a default.
 */
async function stepSectionSwitch(page: Page): Promise<void> {
  await openSection(page, 'game', GAME)
  await resetRecorder(page)

  await openSection(page, 'overlays', OVERLAYS)
  const seen = await recorded(page)
  checkFirstPaint(
    seen,
    'pref-hide-when-not-running',
    'off',
    'a stored-OFF switch whose DEFAULT is on paints OFF on its first frame, and never anything else'
  )
  checkFirstPaint(
    seen,
    'pref-hide-when-unfocused',
    'on',
    '…and a stored-ON switch whose default is off paints ON, so the fix is not a flipped default'
  )
  checkFirstPaint(
    seen,
    'pref-banner-enabled',
    'on',
    'the alert banner switch, an overlay OPEN-STATE stored ON against its shipped OFF, is born ON (the 2026-08-16 regression)'
  )

  await resetRecorder(page)
  await openSection(page, 'textsize', APPEARANCE)
  const appearance = await recorded(page)
  checkFirstPaint(
    appearance,
    'pref-text-size-value',
    CHOSEN_LABEL,
    'the in-app stepper prints the STORED rung first, never 100% (the non-boolean half)'
  )
  checkFirstPaint(
    appearance,
    'pref-overlay-independent',
    'on',
    '…and the overlays’ switch is born ON, so the card mounts as the twelve rows rather than swapping shape'
  )
}

/**
 * THE COLD MOUNT: a fresh renderer, nothing cached, the pane's very first paint of its life.
 *
 * A reload throws away the module-level snapshot along with the whole JS heap, so this is the one
 * path where the gate genuinely has to HOLD — everything else in this spec is the warm cache doing
 * its job. The recorder survives, because `addInitScript` re-runs on the new document before any
 * app code, which is the only way to observe a first paint that happens milliseconds after load.
 *
 * `prefs-unreadable` is asserted absent as well: the gate's failure ending is a real sentence in
 * the product, and a spec that watched the happy path only would let a build where EVERY read
 * rejected pass this file with flying colours (nothing painted, nothing flashed).
 */
async function stepColdRenderer(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
  await dismissFirstRunNotice(page)
  await openPrefs(page)
  await openSection(page, 'overlays', OVERLAYS)

  const seen = await recorded(page)
  checkFirstPaint(
    seen,
    'pref-hide-when-not-running',
    'off',
    'after a RELOAD, with nothing cached, the stored-OFF switch is still born OFF'
  )
  checkFirstPaint(
    seen,
    'pref-hide-when-unfocused',
    'on',
    '…and the stored-ON one is still born ON'
  )
  checkFirstPaint(seen, 'pref-banner-enabled', 'on', '…and so is the alert banner switch, from a cold cache')
  check(
    'the pane hydrated rather than giving up: its unreadable-settings ending never appeared',
    (await countOf(page, '[data-testid="prefs-unreadable"]')) === 0
  )
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

  const userData = makeUserData()
  const log = stageFixture('e2e-telemetry.log')
  const app = await launchOnFixture(log, { userData })
  try {
    const page = await mainWindow(app.app)
    watch(page)
    // BEFORE anything is driven, and before the reload later on: the recorder has to exist in
    // every document this page will ever hold.
    await armFirstPaintRecorder(page)
    // …which means the FIRST document does not have it, since it loaded before the script was
    // registered. A reload right here puts the app and the instrument in the same world.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })

    await dismissFirstRunNotice(page)
    await stepArrange(page)
    await stepSectionSwitch(page)
    await stepColdRenderer(page)
    if (failures.length) await dumpArtifacts(page, 'prefs-first-paint-FAIL')
  } finally {
    await app.close()
    await removeUserData(userData)
    await log.dispose()
  }

  check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  if (failures.length === 0) {
    note('every claim here is a RECORDED SEQUENCE, not a settled read - a settled read of this defect is green on the broken build')
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
