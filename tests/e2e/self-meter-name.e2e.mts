/**
 * Headless Electron integration test for SHOWING THE CHARACTER'S NAME on the damage meter.
 *
 * The engine folds every self reference to "You"; this feature re-labels the self meter row to
 * "<character> (You)" in the renderer when `eq.combat.selfMeterName` is on. The observable is the
 * text of the rank-1 meter row on the Combat tab.
 *
 * WHY A REAL APP. `tests/selfMeterLabel.test.mts` pins the pure label logic without a browser;
 * what only a launched app can show is that the `character` module's name reaches `SegmentBody`,
 * that the pref's `storage`-event path re-renders the meter, and that an absent key is still
 * "You" after a restart. Two launches on ONE shared `userData` dir, so the second proves
 * persistence through a real process exit (the combat-drill / telemetry / overlay-sync pattern).
 *
 * Run: `npm run test:e2e -- self-meter-name`
 */
import type { Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  dumpArtifacts,
  failures,
  note,
  reportRun,
  settle,
  settleCount,
  waitHydrated
} from './appHarness.mjs'
import { mainWindow, makeUserData, removeUserData } from './appWindow.mjs'
import { launchOnFixture, stageFixture } from './logFixture.mjs'

const NAV_COMBAT = '[data-testid="nav-combat"]'
const NAV_PREFS = '[data-testid="nav-preferences"]'
const DASH = '[data-testid="combat-dashboard"]'
const ROW = '[data-testid="meter-row"]'
const RAIL_COMBAT = '[data-testid="prefs-rail-combat"]'
const TOGGLE = '[data-testid="pref-self-meter-name"]'
/** The key itself, so a rename that kept THIS spec green would still be caught: the pref lives
 *  under exactly this name (features/combat/selfMeterLabel.ts `SELF_METER_NAME_KEY`). */
const KEY = 'eq.combat.selfMeterName'
/** The fixture character (logFixture.mts `LOG_NAME` = `eqlog_Primitive_freeport.txt`), so the
 *  "on" label is exactly this. */
const NAMED = 'Primitive (You)'

/** Open the Combat tab and wait for the dashboard. Safe when it is already open. */
async function openCombat(page: Page): Promise<boolean> {
  await page.click(NAV_COMBAT, { timeout: 30_000 })
  return page.waitForSelector(DASH, { timeout: 60_000 }).then(
    () => true,
    () => false
  )
}

/** The text of the first meter row, whitespace-collapsed. '' when no row is rendered. */
function firstRowText(page: Page): Promise<string> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null
    return (el?.innerText ?? '').replace(/\s+/g, ' ').trim()
  }, ROW)
}

/** What the renderer actually stored under KEY, verbatim. `null` when the pref was never touched. */
function stored(page: Page): Promise<string | null> {
  return page.evaluate((k) => localStorage.getItem(k), KEY)
}

/** Flip the Combat → "show my name" switch on, from a cold Preferences tab. */
async function turnOnTheNamePref(page: Page): Promise<boolean> {
  await page.click(NAV_PREFS, { timeout: 30_000 })
  await page.waitForSelector(RAIL_COMBAT, { timeout: 20_000 })
  await page.click(RAIL_COMBAT, { timeout: 15_000 })
  await page.waitForSelector(TOGGLE, { timeout: 15_000 })
  // The testid sits on the MUI Switch root; the clickable control is the input inside it.
  await page.click(`${TOGGLE} input`, { timeout: 15_000 })
  // `useBoolPref` writes '1'/'0' (never removes) — so "on" is exactly '1' in localStorage.
  return (await settle(() => stored(page), (v) => v === '1', { timeoutMs: 8_000 })) === '1'
}

async function main(): Promise<void> {
  buildIfStale()
  // ONE staged EQ install and ONE userData dir for both launches: the fixture is what gives the
  // meter rows at all, and the shared userData is what makes the second launch a restart.
  const log = stageFixture('e2e-combat.log')
  const userData = makeUserData()

  // LAUNCH 1 — default is the bare "You"; flip the toggle; the self row becomes "Primitive (You)".
  console.log('launch 1: default "You", flip the Combat toggle, watch the self row get a name…')
  {
    const { app, close } = await launchOnFixture(log, { userData })
    try {
      const page = await mainWindow(app)
      await page.waitForSelector(NAV_PREFS, { timeout: 60_000 })
      check('hydration completes (replay hands off to the live tail)', !(await waitHydrated(page)).snap.hydrating)

      check('the Combat tab opens', await openCombat(page))
      const rows = await settleCount(page, ROW)
      check('the fixture ranked at least one source', rows > 0, `${rows} rows`)

      const beforeText = await firstRowText(page)
      // The row's innerText glues the name to the first stat badge ("You62% hit …"), so `\bYou\b`
      // would miss — assert on the label's presence and the ABSENCE of the "(You)" tag the pref adds.
      check(
        'a fresh install shows the bare "You" on the self row (not the name)',
        beforeText.includes('You') && !beforeText.includes('(You)'),
        beforeText || 'empty'
      )
      check('…and the pref key is absent (never touched)', (await stored(page)) === null)

      check(`the Combat → name toggle stores '1'`, await turnOnTheNamePref(page))

      check('the Combat tab reopens', await openCombat(page))
      const namedText = await settle(() => firstRowText(page), (t) => t.includes(NAMED), { timeoutMs: 10_000 })
      check(`the self row now reads "${NAMED}"`, namedText.includes(NAMED), namedText || 'empty')

      if (failures.length) await dumpArtifacts(page, 'self-meter-name-launch1-FAIL')
    } finally {
      await close()
    }
  }

  // LAUNCH 2 — a second process, the same userData: the pref (and the label) survive the exit.
  console.log('launch 2: a second process, the same userData — is the self row still named?')
  {
    const { app, close } = await launchOnFixture(log, { userData })
    try {
      const page = await mainWindow(app)
      await page.waitForSelector(NAV_PREFS, { timeout: 60_000 })
      check(
        'hydration completes on the second launch',
        !(await waitHydrated(page)).snap.hydrating
      )
      check('the stored pref crossed the process boundary', (await stored(page)) === '1')

      check('the Combat tab opens after a restart', await openCombat(page))
      check('the restart still ranks a source', (await settleCount(page, ROW)) > 0)
      const stillNamed = await settle(() => firstRowText(page), (t) => t.includes(NAMED), { timeoutMs: 15_000 })
      check(`THE NAMED SELF ROW SURVIVES A FULL RESTART — "${NAMED}"`, stillNamed.includes(NAMED), stillNamed || 'empty')

      if (failures.length) await dumpArtifacts(page, 'self-meter-name-launch2-FAIL')
    } finally {
      await close()
      await removeUserData(userData)
      await log.dispose()
    }
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  note('the self-meter-name spec did not complete')
  process.exitCode = 1
})
