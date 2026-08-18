/**
 * Headless Electron spec for JOS-378 — AN ALERT BANNER SHOWS ON-SCREEN TEXT PER ALERT.
 *
 * WHAT ONLY THE REAL APP CAN SHOW. The pure halves are pinned elsewhere: what a line SAYS and the
 * handler's validator in tests/alertBanner.test.mts, the queue's timing in that file and
 * tests/toastQueue.test.mts, preview parity in tests/alertPreview.test.mts. What no unit test can
 * claim is that the PIECES ARE WIRED, and the wiring here spans three windows and a store:
 *
 *   1. A FRESH INSTALL SHOWS NO BANNER. The owner's first ruling is that this ships OFF, and a
 *      default is a claim about a window that either exists or does not. Every launch gets a fresh
 *      userData dir, so this spec is always a first run — which makes it the only place that can
 *      prove the absence.
 *   2. THE PER-ALERT CONTROLS ARE NOT THERE UNTIL THE OVERLAY IS (ruling 2). Asserted from BOTH
 *      surfaces, before and after the switch: the row's toggle and the editor's block, with the
 *      quiet line naming Preferences standing in for them while the overlay is off.
 *   3. TURNING IT ON IN PREFERENCES CREATES THE WINDOW AND INTRODUCES IT. The switch, the store,
 *      the window factory and the overlay's own first-run card are four separate parts.
 *   4. A FIRING RENDERS A LINE, the line carries the alert's NAME, and its text is CENTRED in the
 *      strip — the last of those is geometry, which is a thing only a laid-out window has. The row's ▶
 *      IS a firing (tests/alertPreview.test.mts pins that equality at the seam), so it is what
 *      this spec presses — and it is also the acceptance criterion in its own right, because
 *      pressing ▶ is how a user positions a strip they have never seen.
 *   5. THE PER-ALERT SWITCH TAMES ONE ALERT, from the list, without opening anything.
 *   6. A MUTED APP STILL SHOWS LINES. This is the report the whole ticket exists for (2026-08-15:
 *      "I don't always hear it over Discord"), and it is the one claim that would silently rot if
 *      the banner were ever moved inside the audio path.
 *
 * NO WINDOW IS EVER SHOWN. `EQ_E2E=1` is the whole test mode (src/main/e2e.ts): the main window
 * never shows and overlays skip `showInactive`, so the banner window here is created, loaded and
 * driven entirely off-screen. That is also why the DOM is asserted rather than the animation.
 *
 * Run: `npm run test:e2e -- alert-banner`.
 */
import type { ElectronApplication, Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  failures,
  reportRun,
  settle,
  settleStable
} from './appHarness.mjs'
import { mainWindow, makeUserData, removeUserData } from './appWindow.mjs'
import { launchOnFixture, stageFixture } from './logFixture.mjs'
// THE STRIP SCALES WITH ITS TEXT (JOS-406). The toast, the alert banner and the con card are the
// three overlays whose WINDOW IS THE CARD, so the one step is shared between their three specs
// rather than written out three times — its header carries the whole argument.
import { stepStripBgSlider, stepStripScalesWithText } from './stripScaleSteps.mjs'

const ROW = '[data-testid="alert-row"]'
const LINE = '[data-testid="banner-line"]'
const ROW_TOGGLE = '[data-testid="alert-show-on-screen-toggle"]'

/** The banner overlay's page, identified by the `?kind=` query its window was opened with. */
async function findBannerWindow(app: ElectronApplication): Promise<Page | null> {
  for (const w of app.windows()) {
    const search = await w.evaluate(() => window.location.search).catch(() => '')
    if (search.includes('kind=alertBanner')) return w
  }
  return null
}

/** Every rendered line's text, in stack order (oldest first, newest at the bottom). */
function lineTexts(page: Page): Promise<string[]> {
  return page.evaluate((sel) =>
    [...document.querySelectorAll(sel)].map((el) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()),
    LINE
  )
}

/** Open the Alerts tab and wait for the seeded list to have rows. */
async function openAlerts(page: Page): Promise<void> {
  await page.click('[data-testid="nav-alerts"]', { timeout: 60_000 })
  await page.waitForSelector(ROW, { timeout: 30_000 })
}

/** Open the editor on the first row, run a claim against it, and close it again. */
async function inEditor(page: Page, body: () => Promise<void>): Promise<void> {
  await page.click(`${ROW} [data-testid="alert-edit"]`, { timeout: 20_000 })
  await page.waitForSelector('[data-testid="alert-dialog"]', { timeout: 20_000 })
  await body()
  await page.keyboard.press('Escape')
  await settle(() => countOf(page, '[data-testid="alert-dialog"]'), (n) => n === 0, { timeoutMs: 10_000 })
}

/** Press the first row's ▶ — a real firing, by the preview law. Returns the lines after it. */
async function preview(page: Page, banner: Page, expect: number): Promise<string[]> {
  await page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLElement | null)?.click(),
    `${ROW} [data-testid="alert-test"]`
  )
  await settle(() => lineTexts(banner), (l) => l.length >= expect, { timeoutMs: 15_000 })
  return lineTexts(banner)
}

/**
 * BEFORE THE SWITCH: neither surface offers an on-screen control, and the editor says where the
 * switch is rather than saying nothing. The "or nothing" half of the ticket's ruling was
 * deliberately not taken — see BannerBlock.tsx for the argument.
 */
async function stepControlsHiddenWhileOff(page: Page): Promise<void> {
  check(
    'with the overlay off, no row offers an on-screen toggle',
    (await countOf(page, ROW_TOGGLE)) === 0
  )
  await inEditor(page, async () => {
    check(
      '…and the editor offers no on-screen controls either',
      (await countOf(page, '[data-testid="alert-banner-block"]')) === 0
    )
    check(
      '…but it does NAME the switch that would give them, and links to it',
      (await countOf(page, '[data-testid="alert-banner-off-note"]')) === 1 &&
        (await countOf(page, '[data-testid="alert-banner-prefs-link"]')) === 1
    )
  })
}

/** Preferences → Overlays: the card exists, its switch is OFF, and pressing it makes the window. */
async function stepTurnItOn(app: ElectronApplication, page: Page): Promise<Page | null> {
  await page.click('[data-testid="nav-preferences"]', { timeout: 60_000 })
  await page.waitForSelector('[data-testid="prefs-rail-overlays"]', { timeout: 20_000 })
  await page.click('[data-testid="prefs-rail-overlays"]')
  await page.waitForSelector('[data-testid="pref-alert-banner"]', { timeout: 15_000 })
  // The switch's testid sits on the MUI root, so the checkbox is the input inside it. Its state
  // arrives from MAIN's store over IPC a beat after the pane mounts, so it is read until it
  // settles rather than whatever it happened to say first.
  const off = await settleStable(
    () =>
      page.evaluate(
        (sel) => (document.querySelector(sel) as HTMLInputElement | null)?.checked,
        '[data-testid="pref-banner-enabled"] input'
      ),
    { timeoutMs: 8_000, stable: 4, pollMs: 150 }
  )
  check('…and Preferences agrees: the switch is OFF, matching the window that never opened', off === false, String(off))
  await page.click('[data-testid="pref-banner-enabled"] input')
  const banner = await settle(() => findBannerWindow(app), (w) => w !== null, { timeoutMs: 30_000 })
  check('turning it on in Preferences → Overlays creates the banner window', banner !== null)
  return banner
}

/**
 * THE INTRODUCTION: the one line the overlay ever shows about itself. A user who has just ticked a
 * switch has no way to learn where the strip landed until an alert happens to fire, and a strip
 * you cannot find is a strip you cannot move.
 */
async function stepIntroduction(banner: Page): Promise<void> {
  const lines = await settle(() => lineTexts(banner), (l) => l.length >= 1, { timeoutMs: 20_000 })
  if (!check('a freshly enabled banner INTRODUCES itself (one line, unprompted)', lines.length === 1, `${String(lines.length)} line(s)`)) {
    return
  }
  check('…naming what the window is', /alert banner/i.test(lines[0]), lines[0])
  check('…naming the per-alert marking that reaches it', lines[0].includes('Show on screen'), lines[0])
  check('…and pointing at where it is moved from', lines[0].includes('Preferences'), lines[0])
  // Cleared through its own × so the counts below start from a known, empty strip.
  await banner.evaluate((sel) => {
    document.querySelectorAll(sel).forEach((el) => (el as HTMLElement).click())
  }, '[data-testid="banner-close"]')
  const rest = await settle(() => lineTexts(banner), (l) => l.length === 0, { timeoutMs: 10_000 })
  check('…and every line closes on its own ×', rest.length === 0, `${String(rest.length)} line(s)`)
}

/** AFTER THE SWITCH: both surfaces now offer the control, and it starts ON (absent = shown). */
async function stepControlsAppear(page: Page): Promise<void> {
  await openAlerts(page)
  const toggles = await settle(() => countOf(page, ROW_TOGGLE), (n) => n > 0, { timeoutMs: 15_000 })
  check('with the overlay on, every row offers an on-screen toggle', toggles > 0, `${String(toggles)} toggle(s)`)
  const on = await page.evaluate((sel) => document.querySelector(sel)?.getAttribute('data-on'), ROW_TOGGLE)
  check('…starting ON, because an alert written before this feature existed still shows', on === 'true', String(on))
  await inEditor(page, async () => {
    check(
      'and the editor offers the switch, the override and the swatches',
      (await countOf(page, '[data-testid="alert-show-on-screen"]')) === 1 &&
        (await countOf(page, '[data-testid="alert-banner-text"]')) === 1 &&
        (await countOf(page, '[data-testid="alert-banner-colors"]')) === 1
    )
    check('…and no longer the note about a switch that is now on', (await countOf(page, '[data-testid="alert-banner-off-note"]')) === 0)
  })
}

/** A firing renders a line, and the line says what the alert would SAY. */
async function stepFiringRendersALine(page: Page, banner: Page): Promise<string> {
  const name = (await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText.trim(), `${ROW} p`)) ?? ''
  const lines = await preview(page, banner, 1)
  if (!check('pressing ▶ on a row renders a line on the banner', lines.length === 1, `${String(lines.length)} line(s)`)) {
    return name
  }
  check(
    '…carrying the alert\'s own NAME, which is what an empty override prints (JOS-380)',
    !!name && lines[0].includes(name),
    `row "${name}" · line "${lines[0]}"`
  )
  return name
}

/**
 * THE LINE IS CENTRED (JOS-380) — geometry, so only a real window can claim it.
 *
 * It is read at a glance over the game from wherever the eyes already are, and the dismiss button
 * on the right is exactly the thing that would pull a centred sentence off true. The two claims
 * below are the two halves of that: the text is centre-aligned, and its box sits on the line's
 * midpoint rather than half a button to the left of it.
 */
async function stepTextIsCentered(banner: Page): Promise<void> {
  const geom = await banner.evaluate((sel: string[]) => {
    const line = document.querySelector(sel[0])
    const text = line?.querySelector(sel[1])
    if (!line || !text) return null
    const l = line.getBoundingClientRect()
    const t = text.getBoundingClientRect()
    return {
      align: getComputedStyle(text).textAlign,
      offset: Math.abs((t.left + t.right) / 2 - (l.left + l.right) / 2)
    }
  }, [LINE, '[data-testid="banner-text"]'])
  check('the banner text is CENTRE-aligned in its line', geom?.align === 'center', JSON.stringify(geom))
  check(
    '…and its box sits on the line centre — the dismiss button is balanced, not subtracted',
    geom !== null && geom.offset <= 2,
    JSON.stringify(geom)
  )
}

/** The row's toggle tames ONE alert: no line, from a control that opened nothing. */
async function stepPerAlertSwitchHides(page: Page, banner: Page): Promise<void> {
  const before = (await lineTexts(banner)).length
  await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement | null)?.click(), ROW_TOGGLE)
  await settle(
    () => page.evaluate((sel) => document.querySelector(sel)?.getAttribute('data-on'), ROW_TOGGLE),
    (v) => v === 'false',
    { timeoutMs: 10_000 }
  )
  await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement | null)?.click(), `${ROW} [data-testid="alert-test"]`)
  // Nothing is supposed to happen, so the positive signal is the stack HOLDING STILL.
  const after = await settleStable(() => lineTexts(banner), { timeoutMs: 8_000, stable: 5, pollMs: 150 })
  check(
    'an alert switched off from the list renders NO line, however often it fires',
    after.length === before,
    `${String(before)} before · ${String(after.length)} after`
  )
  // …and back on, so the mute step below has something to show.
  await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement | null)?.click(), ROW_TOGGLE)
  await settle(
    () => page.evaluate((sel) => document.querySelector(sel)?.getAttribute('data-on'), ROW_TOGGLE),
    (v) => v === 'true',
    { timeoutMs: 10_000 }
  )
}

/** THE REPORT THIS TICKET EXISTS FOR: the app is muted, and the line still appears. */
async function stepMutedStillShows(page: Page, banner: Page, name: string): Promise<void> {
  await page.evaluate(async () => {
    const eq = (window as unknown as { eq: { getAlertPrefs: () => Promise<Record<string, unknown>>; setAlertPrefs: (p: unknown) => Promise<unknown> } }).eq
    await eq.setAlertPrefs({ ...(await eq.getAlertPrefs()), muted: true })
    // The player keeps a live copy and re-reads it on focus — the same nudge an alt-tab gives it.
    window.dispatchEvent(new Event('focus'))
  })
  const before = (await lineTexts(banner)).length
  const lines = await preview(page, banner, before + 1)
  check(
    'a MUTED app still shows the line (mute is about sound; this is the Discord report)',
    lines.length > before && lines[lines.length - 1].includes(name),
    `${String(before)} before · ${lines.join(' | ') || '(none)'}`
  )
}

async function main(): Promise<void> {
  buildIfStale()

  const log = stageFixture('e2e-voice.log')
  const userData = makeUserData()

  console.log('launch: hidden Electron (EQ_E2E=1) against tests/fixtures/e2e-voice.log…')
  const { app, close } = await launchOnFixture(log, { userData })
  let page: Page | null = null
  try {
    page = await mainWindow(app)
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    await page.waitForSelector('[data-testid="nav-preferences"]', { timeout: 60_000 })
    await openAlerts(page)

    // OFF OUT OF THE BOX (owner ruling 1). A fresh install has no stored `overlays.alertBanner`,
    // so the DEFAULT decides — and the window is the feature, so the proof is that it does not
    // exist before anybody has touched a setting.
    const preexisting = await settleStable(() => findBannerWindow(app).then((w) => w !== null), {
      timeoutMs: 6_000,
      stable: 4,
      pollMs: 200
    })
    check('a fresh install spawns NO banner window — the kind ships off', preexisting === false)

    await stepControlsHiddenWhileOff(page)
    const banner = await stepTurnItOn(app, page)
    if (banner) {
      await stepIntroduction(banner)
      await stepControlsAppear(page)
      const name = await stepFiringRendersALine(page, banner)
      await stepTextIsCentered(banner)
      // …and with a line on screen, the window at 200% has to be the same banner, twice the size:
      // a raid call that wrapped because the window did not grow is the defect this ticket is about.
      await stepStripScalesWithText(app, banner, 'alertBanner', 'alert banner')
      // …and the drag frame's OTHER new knob (JOS-407): this kind's transparency, which until now
      // was a 0.72 nobody could reach.
      await stepStripBgSlider(banner, 'banner-drag-frame', 'alert banner')
      await stepPerAlertSwitchHides(page, banner)
      await stepMutedStillShows(page, banner, name)
    }

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
    if (failures.length) await dumpArtifacts(page, 'alert-banner-FAIL')
  } finally {
    await close()
  }

  await removeUserData(userData)
  await log.dispose()
  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
