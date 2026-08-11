/**
 * Headless Electron integration test for the CURSOR RING's COLOUR (JOS-125).
 *
 * WHY IT IS AN E2E SPEC AND NOT A UNIT TEST. `tests/cursorRingColor.test.mts` pins the normalizer,
 * the one place a hex becomes a CSS colour, and the parity between that function and the CSS in
 * cursor.html. What is left is a claim about a RUNNING APP, and it has three halves:
 *
 *   1. the picker is really in Preferences, and a fresh install shows WHITE — the colour every
 *      ring drawn before this ticket was, so the upgrade recolours nobody.
 *   2. picking a colour repaints the live sample immediately, through the real IPC round trip
 *      (Preferences writes a patch, main re-normalizes, the card renders main's reply).
 *   3. the choice OUTLIVES THE PROCESS. That is a second launch reading a file the first one
 *      wrote, so this spec runs two launches over one userData dir — the text-size pattern.
 *
 * WHAT IT CANNOT SEE, stated rather than implied: the ring window itself. That window is created
 * only while EverQuest is the foreground window (presenceEffects.ts), and there is no EverQuest
 * in a headless test — so the drawing this spec reads is the Preferences SAMPLE, which is the
 * same `ringStrokeColor()` seam the ring window paints with and is asserted to be that seam in
 * the unit test next door. Nothing here fakes a ring window; the gap is real and named.
 *
 * Run: `npm run test:e2e -- cursor-ring-color`
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
import { launchOnFixture, stageFixture } from './logFixture.mjs'
import { DEFAULT_RING_COLOR, ringStrokeColor } from '../../src/shared/presencePrefs'

const RAIL = '[data-testid="prefs-rail-cursor"]'
const PANE = '[data-testid="pref-cursor-ring"]'
const COLOR = '[data-testid="pref-cursor-ring-color"]'
const PREVIEW = '[data-testid="pref-cursor-ring-preview"]'

/** The colour this spec picks. Not a primary and not a shade of white: it has to be unmistakable
 *  in a computed style, and it has to be a colour somebody might actually want over a dark
 *  dungeon floor. */
const CHOSEN = '#ff8800'

/** What the browser says the sample is drawn in. `getComputedStyle` answers colours in `rgb()` /
 *  `rgba()` form, which is exactly the form `ringStrokeColor` produces, so the two compare
 *  directly and no test-side colour arithmetic exists to be wrong. */
function previewColor(page: Page): Promise<string> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    return el ? getComputedStyle(el).borderTopColor : ''
  }, PREVIEW)
}

/**
 * Choose a colour, the way the platform dialog's OK button does.
 *
 * NOT `page.fill()`, and the reason is React rather than Playwright. Filling a non-text input
 * assigns `element.value` and then dispatches the events — but React installs its own setter on
 * the node to track the last value it saw, so a plain assignment updates that tracker too and
 * React concludes nothing changed. The onChange handler never runs, the IPC write never happens,
 * and the spec would pass or fail on the wrong thing entirely. Calling the PROTOTYPE's setter
 * leaves React's tracker stale, which is exactly the state a real user's colour dialog leaves it
 * in, so the app's own handler runs from here down.
 */
function pickColor(page: Page, hex: string): Promise<void> {
  return page.evaluate(
    ({ sel, value }) => {
      const el = document.querySelector(sel) as HTMLInputElement | null
      if (!el) throw new Error(`pickColor: ${sel} is not on the page`)
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      if (!setter) throw new Error('pickColor: HTMLInputElement has no value setter')
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    },
    { sel: COLOR, value: hex }
  )
}

function inputValue(page: Page): Promise<string> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    return (el as HTMLInputElement | null)?.value ?? ''
  }, COLOR)
}

function storedColor(page: Page): Promise<string> {
  return page.evaluate(() =>
    (window as unknown as { eq: { getCursorRing: () => Promise<{ colorHex: string }> } }).eq
      .getCursorRing()
      .then((r) => r.colorHex)
  )
}

/**
 * Answer the analytics first-run notice, which a FRESH userData always shows and which sits over
 * the whole window until it is answered (the text-size / perf helper). "Turn it off" keeps this
 * run quiet.
 */
async function dismissFirstRunNotice(page: Page): Promise<void> {
  const notice = '[data-testid="telemetry-notice"]'
  await page.waitForSelector(notice, { timeout: 30_000 }).catch(() => undefined)
  if ((await countOf(page, notice)) === 0) return
  await page.click('[data-testid="telemetry-notice-off"]')
  await settleGone(page, notice, { timeoutMs: 8_000 })
}

async function openCursorRing(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="nav-preferences"]', { timeout: 60_000 })
  await page.click('[data-testid="nav-preferences"]', { timeout: 30_000 })
  await page.click(RAIL, { timeout: 15_000 })
  await page.waitForSelector(PANE, { timeout: 15_000 })
}

/** The card as a fresh install shows it: a picker, on white, drawing a white ring. */
async function stepDefaultIsUnchanged(page: Page): Promise<void> {
  check('Preferences has a Cursor ring section', (await countOf(page, PANE)) === 1)
  check('…with a colour picker in it', (await countOf(page, COLOR)) === 1)
  const type = await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    return (el as HTMLInputElement | null)?.type ?? ''
  }, COLOR)
  check('…which is the platform colour input, not a text field', type === 'color', type)

  const value = await settle(() => inputValue(page), (v) => v === DEFAULT_RING_COLOR, {
    timeoutMs: 15_000
  })
  check(
    'a fresh install is on white — the colour every ring had before this control existed',
    value === DEFAULT_RING_COLOR,
    value
  )
  const drawn = await previewColor(page)
  check(
    '…and the sample is drawn in exactly the old ring colour',
    drawn === ringStrokeColor(DEFAULT_RING_COLOR),
    `${drawn} vs ${ringStrokeColor(DEFAULT_RING_COLOR)}`
  )
}

/** THE ASSERTION THE TICKET IS ABOUT: picking a colour changes the ring's colour, now. */
async function stepPickAColor(page: Page): Promise<void> {
  await pickColor(page, CHOSEN)
  const drawn = await settle(() => previewColor(page), (c) => c === ringStrokeColor(CHOSEN), {
    timeoutMs: 15_000
  })
  check(
    `picking ${CHOSEN} redraws the ring in it, without a relaunch`,
    drawn === ringStrokeColor(CHOSEN),
    `${drawn} vs ${ringStrokeColor(CHOSEN)}`
  )
  const stored = await settle(() => storedColor(page), (c) => c === CHOSEN, { timeoutMs: 15_000 })
  check('…and main stored what was picked', stored === CHOSEN, stored)
}

/** The second launch: the colour is already the chosen one before this spec touches anything. */
async function stepPersisted(page: Page): Promise<void> {
  const stored = await storedColor(page)
  check(
    'a relaunch still has the chosen colour — it outlived the process that picked it',
    stored === CHOSEN,
    stored
  )
  await openCursorRing(page)
  // WAIT FOR THE CONDITION. The card hydrates from main like every other prefs card, so the
  // input opens on the default it was constructed with and lands on the stored answer an IPC
  // round trip later. That is the app's hydration pattern, not a defect.
  const value = await settle(() => inputValue(page), (v) => v === CHOSEN, { timeoutMs: 15_000 })
  check('…and the picker agrees with the store it hydrated from', value === CHOSEN, value)
  const drawn = await previewColor(page)
  check('…as does the ring it draws', drawn === ringStrokeColor(CHOSEN), drawn)
}

/** Every way in is a way out: white must be reachable again, or the control is a one-way door. */
async function stepBackToWhite(page: Page): Promise<void> {
  await pickColor(page, DEFAULT_RING_COLOR)
  const drawn = await settle(
    () => previewColor(page),
    (c) => c === ringStrokeColor(DEFAULT_RING_COLOR),
    { timeoutMs: 15_000 }
  )
  check(
    'choosing white again puts the ring back exactly where it started',
    drawn === ringStrokeColor(DEFAULT_RING_COLOR),
    drawn
  )
  const stored = await storedColor(page)
  check('…and stores it, so the next launch is ordinary again', stored === DEFAULT_RING_COLOR, stored)
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

  // ONE dir for both launches, because the assertion between them is that the choice OUTLIVES
  // the process. One staged log, so the two boots differ only in the setting under test.
  const userData = makeUserData()
  const log = stageFixture('e2e-telemetry.log')

  console.log('launch 1: hidden Electron (EQ_E2E=1), fresh userData — the default and the pick…')
  const first = await launchOnFixture(log, { userData })
  try {
    const page = await mainWindow(first.app)
    watch(page)
    await dismissFirstRunNotice(page)
    await openCursorRing(page)
    await stepDefaultIsUnchanged(page)
    await stepPickAColor(page)
    if (failures.length) await dumpArtifacts(page, 'cursor-ring-color-FAIL-first')
  } finally {
    await first.close()
  }

  console.log('launch 2: same userData — did the colour survive a restart…')
  const second = await launchOnFixture(log, { userData })
  try {
    const page = await mainWindow(second.app)
    watch(page)
    await stepPersisted(page)
    await stepBackToWhite(page)
    if (failures.length) await dumpArtifacts(page, 'cursor-ring-color-FAIL-restart')
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
