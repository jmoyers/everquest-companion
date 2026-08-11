/**
 * Headless Electron integration test for THE DRILL SURVIVING A RESTART (JOS-116).
 *
 * THE BUG, in the owner's words: "switching views resets combat panels to fully drilled-out."
 * That half — the tab round trip — is asserted where the rest of the Combat tab is asserted
 * (tests/e2e/combatSteps.stepDrillRoundTrip, and stepGlanceDrill for the Overview card), because
 * it needs no second process and those specs already own a launched app.
 *
 * THIS SPEC IS THE OTHER HALF, and it is here for the same reason sky-filters is: the ticket asks
 * for "across restart preferred", and only two processes can say whether that is true.
 * `makeUserData()` hands both launches the SAME dir (the sky-filters / telemetry / overlay-sync
 * pattern), so launch 2 reads the localStorage launch 1 wrote — through a real process exit, not
 * a simulated one.
 *
 * WHY THE STORE-LEVEL TEST IS NOT ENOUGH. `tests/combatPrefs.test.mts` pins the value's shape
 * without a browser, and it would have passed while this feature stayed broken: the bug was never
 * in the read. It was in the lifecycle (`ViewContent` mounts one view at a time, so the Combat tab
 * is destroyed on every tab switch) and in an effect keyed on `selection` that could not tell a
 * user's click from a mount — an effect that would have cleared the stored drill on the very frame
 * that hydrated it. Neither is visible to anything but a real app.
 *
 * WHAT IT DOES NOT ASSERT: which abilities the drilled source has, or what their numbers are. That
 * is the engine's and it is pinned by fixture replay; the subject here is one token surviving a
 * process boundary, and the observable is the crumb.
 *
 * WHY IT NEVER TAKES THE SCREEN: `EQ_E2E=1` (src/main/e2e.ts) shows no window, skips the
 * single-instance lock, and points `userData` at a throwaway temp dir minted per run.
 *
 * Run: `npm run test:e2e -- combat-drill`
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
  settleCount,
  waitHydrated
} from './appHarness.mjs'
import { mainWindow, makeUserData, removeUserData } from './appWindow.mjs'
import { launchOnFixture, stageFixture } from './logFixture.mjs'

const NAV_COMBAT = '[data-testid="nav-combat"]'
const DASH = '[data-testid="combat-dashboard"]'
const ROW = '[data-testid="meter-row"]'
const BACK = '[data-testid="drill-back"]'
const SKILL = '[data-testid="skill-bar"]'
const STATS = '[data-testid="ability-stats"]'
/** The key itself, so a rename that kept THIS spec green would still be caught: an existing
 *  user's stored drill lives under exactly this name (features/combat/combatPrefs.drillKey). */
const KEY = 'eq.combat.drill.combat'

/** Is a drill open? The Back control exists only below the source list. */
async function drilled(page: Page): Promise<boolean> {
  return (await countOf(page, BACK)) > 0
}

/** Open the Combat tab and wait for the dashboard. Safe when it is already open. */
async function openCombat(page: Page): Promise<boolean> {
  await page.click(NAV_COMBAT, { timeout: 30_000 })
  return page.waitForSelector(DASH, { timeout: 60_000 }).then(() => true, () => false)
}

/** What the renderer actually stored, verbatim. `null` when nothing was ever drilled. */
function storedDrill(page: Page): Promise<string | null> {
  return page.evaluate((k) => localStorage.getItem(k), KEY)
}

/**
 * LAUNCH 1 — drill a source, expand one of its abilities, and leave it that way. Every wait here
 * is on the condition the click produces, never on a clock.
 */
async function armTheDrill(page: Page): Promise<boolean> {
  if (!check('the Combat tab opens', await openCombat(page))) return false
  const rows = await settleCount(page, ROW)
  if (rows === 0) {
    note('the fixture left no outgoing damage to rank — there was no bar to drill')
    return false
  }
  check('a fresh install opens on level 1 — nothing auto-drills (JOS-35)', !(await drilled(page)))
  check('…and nothing is stored yet, so an absent key IS level 1', (await storedDrill(page)) === null)

  await page.click(ROW, { timeout: 15_000 })
  if (!check('clicking a source bar drills it', await settle(() => drilled(page), (d) => d, { timeoutMs: 10_000 }))) {
    return false
  }

  // One ability's inline stats, if this source has any that bear stats. A DoT tick correctly does
  // nothing, so this walks the bars until one opens rather than assuming the first will.
  const bars = page.locator(`[data-testid="dash-panel"] ${SKILL}`)
  const n = await bars.count()
  for (let i = 0; i < n && (await countOf(page, STATS)) === 0; i++) {
    await bars.nth(i).click({ position: { x: 12, y: 8 }, timeout: 5_000 }).catch(() => undefined)
  }
  const expanded = (await countOf(page, STATS)) >= 1
  if (!expanded) note('the drilled source has no stat-bearing ability here — only the drill is armed')

  const stored = await settle(() => storedDrill(page), (v) => v !== null, { timeoutMs: 8_000 })
  check(`the drill is stored under ${KEY}`, stored !== null, String(stored))
  return expanded
}

/** LAUNCH 2 — a second process, the same userData dir, the same drill. */
async function checkAfterRestart(page: Page, expectAbility: boolean): Promise<void> {
  if (!check('the Combat tab opens after a restart', await openCombat(page))) return
  check('…and the stored drill crossed the process boundary intact', (await storedDrill(page)) !== null)

  const still = await settle(() => drilled(page), (d) => d, { timeoutMs: 15_000 })
  check('THE DRILL SURVIVES A FULL RESTART', still)
  if (!still) return
  if (expectAbility) {
    const stats = await settle(() => countOf(page, STATS), (c) => c >= 1, { timeoutMs: 10_000 })
    check('…and so does the ability whose stats were open', stats >= 1, `${stats} readout(s)`)
  }

  // AND IT IS STILL A DRILL YOU CAN LEAVE. A remembered level is worth nothing if the way out
  // went with the process, so the crumb's root link is exercised on the far side of the restart.
  await page.click('[data-testid="drill-all"]', { timeout: 10_000 }).catch(() => undefined)
  const out = await settle(() => drilled(page), (d) => !d, { timeoutMs: 10_000 })
  check('…and it can still be walked out of', out === false)
  check('…which clears the stored value rather than remembering "level 1"', (await storedDrill(page)) === null)
}

async function main(): Promise<void> {
  buildIfStale()
  // ONE staged EQ install and ONE userData dir for both launches: the fixture is what makes the
  // meter have rows at all, and the shared userData is what makes the restart a restart.
  const log = stageFixture('e2e-combat.log')
  const userData = makeUserData()
  let expectAbility = false

  console.log('launch 1: drill a source, expand an ability, leave it that way…')
  {
    const { app, close } = await launchOnFixture(log, { userData })
    try {
      const page = await mainWindow(app)
      await page.waitForSelector('[data-testid="nav-preferences"]', { timeout: 60_000 })
      if (check('hydration completes (replay hands off to the live tail)', !(await waitHydrated(page)).snap.hydrating)) {
        expectAbility = await armTheDrill(page)
      }
      if (failures.length) await dumpArtifacts(page, 'combat-drill-launch1-FAIL')
    } finally {
      await close()
    }
  }

  console.log('launch 2: a second process, the same userData — is it still drilled?')
  {
    const { app, close } = await launchOnFixture(log, { userData })
    try {
      const page = await mainWindow(app)
      await page.waitForSelector('[data-testid="nav-preferences"]', { timeout: 60_000 })
      if (check('hydration completes on the second launch', !(await waitHydrated(page)).snap.hydrating)) {
        await checkAfterRestart(page, expectAbility)
      }
      if (failures.length) await dumpArtifacts(page, 'combat-drill-launch2-FAIL')
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
  note('the combat-drill spec did not complete')
  process.exitCode = 1
})
