/**
 * Headless Electron integration test for THE SKY TAB'S STICKY FILTERS (JOS-90).
 *
 * THE BUG, in the reporter's words: tick "Hide completed" on the Plane of Sky tab to see exactly
 * what is left, click away to any other tab, come back — and every quest you have already turned
 * in is on the screen again. Hiding completed steps is not a momentary filter, it is how a user
 * says "show me what is left", and the app forgot it the moment the view unmounted.
 *
 * WHY THE ROUND TRIP HAS TO BE DRIVEN BY A REAL APP. The unit-testable half of this is one line —
 * a `useState` initialiser reading localStorage — and a test of THAT would pass while the feature
 * stayed broken, because the bug was never in the read. It was in the LIFECYCLE: `App`'s
 * `ViewContent` mounts exactly one feature view at a time, so leaving the Sky tab destroys
 * `useQuestList` and everything it was holding. Only a spec that actually leaves the tab can
 * distinguish "the state is stored" from "the state survives being thrown away", which is why
 * every assertion below is bracketed by a NAVIGATION, and why the trip out asserts the filter bar
 * is GONE first — an unmount that never happened would make the rest of this spec a tautology.
 *
 * TWO LAUNCHES, ONE userData DIR. The tab round trip and the RESTART are different promises, and
 * a spec that only proved the first would leave "preferred, if that is where other view toggles
 * live" untested. `makeUserData()` hands both launches the same dir (the telemetry/overlay-sync
 * pattern), so launch 2 reads the localStorage launch 1 wrote — through a real process exit, not
 * a simulated one.
 *
 * WHAT IT DOES NOT ASSERT: which quests the tick removes from the list. That is
 * `selectQuests`'s filter, pinned without a browser in tests/questSort.test.mts, and repeating it
 * here would only make this spec depend on the committed quest data staying the shape it is.
 * The subject here is the STATE, and the state is what the box says.
 *
 * WHY IT NEVER TAKES THE SCREEN: `EQ_E2E=1` (src/main/e2e.ts) shows no window, skips the
 * single-instance lock, and points `userData` at a throwaway temp dir minted per launch.
 *
 * Run: `npm run test:e2e -- sky-filters` (or node --import tsx this file).
 */
import type { Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  failures,
  reportRun,
  settle,
  settleGone
} from './appHarness.mjs'
import { launchApp, mainWindow, makeUserData, removeUserData } from './appWindow.mjs'

const NAV_SKY = '[data-testid="nav-posky"]'
const NAV_OVERVIEW = '[data-testid="nav-overview"]'
/** The checkbox under test. MUI renders the real `<input>` inside this node — see `boxState`. */
const BOX = '[data-testid="posky-hide-completed"]'
/** The preference itself, as `useQuestList` stores it. Read back so the spec pins the KEY too:
 *  a rename that kept the round trip working would still break an existing user's saved choice. */
const KEY = 'eq.posky.hideCompleted'

/** Is the box ticked? `null` when it is not mounted — never confused with "unticked". */
function boxState(page: Page): Promise<boolean | null> {
  return page.evaluate(
    (sel) => (document.querySelector(`${sel} input`) as HTMLInputElement | null)?.checked ?? null,
    BOX
  )
}

/** What the renderer has actually stored, verbatim. `null` when the key was never written. */
function storedValue(page: Page): Promise<string | null> {
  return page.evaluate((k) => localStorage.getItem(k), KEY)
}

/** Open the Sky tab and wait for its toolbar. Safe when the tab is already the open one. */
async function openSky(page: Page, timeoutMs = 60_000): Promise<boolean> {
  await page.click(NAV_SKY, { timeout: 30_000 })
  return page.waitForSelector(BOX, { timeout: timeoutMs }).then(
    () => true,
    () => false
  )
}

/**
 * Leave for another tab, and confirm the Sky view is really gone. This is the step the bug lived
 * in: the assertion after it means nothing unless `useQuestList` was actually unmounted here.
 */
async function leaveSky(page: Page): Promise<boolean> {
  await page.click(NAV_OVERVIEW, { timeout: 30_000 })
  return settleGone(page, BOX, { timeoutMs: 15_000 })
}

/** Click the box and wait for the tick to reach the state we asked for. */
async function setBox(page: Page, want: boolean): Promise<boolean | null> {
  await page.click(BOX, { timeout: 15_000 })
  return settle(() => boxState(page), (v) => v === want, { timeoutMs: 8_000 })
}

/** A tab round trip: away to the Overview, back to Sky, then read the box. */
async function roundTrip(page: Page): Promise<boolean | null> {
  if (!check('leaving the Sky tab unmounts it (the filter bar is gone)', await leaveSky(page))) {
    return null
  }
  if (!check('…and the Sky tab comes back', await openSky(page))) return null
  return settle(() => boxState(page), (v) => v !== null, { timeoutMs: 8_000 })
}

/** A fresh install shows everything — the pref is absent, and absence is the default, not `false`. */
async function stepDefault(page: Page): Promise<void> {
  check('a fresh install opens the Sky tab with "Hide completed" UNTICKED', (await boxState(page)) === false)
  check('…and mounts exactly one such box', (await countOf(page, BOX)) === 1)
}

/** One explicit action clears every list-narrowing control, including the search field. */
async function stepResetFilters(page: Page): Promise<void> {
  await page.fill('[data-testid="posky-search"] input', 'Khyldorn')
  await page.click('[data-testid="posky-class-filter"]')
  await page.getByRole('option', { name: 'Monk', exact: true }).click()
  await page.click('[data-testid="posky-island-filter"]')
  await page.getByRole('option', { name: 'Island 8', exact: true }).click()
  await page.click(BOX)
  await page.click('[data-testid="posky-favorites-only"]')
  await page.click('[data-testid="posky-reset-filters"]')
  const state = await page.evaluate(() => ({
    query: document.querySelector<HTMLInputElement>('[data-testid="posky-search"] input')?.value,
    island: document.querySelector<HTMLInputElement>('[data-testid="posky-island-filter"] input')?.value,
    classChips: document.querySelectorAll('[data-testid="posky-class-filter"] .MuiChip-root').length,
    hideCompleted: document.querySelector<HTMLInputElement>('[data-testid="posky-hide-completed"] input')?.checked,
    turnInsOnly: document.querySelector<HTMLInputElement>('[data-testid="posky-turn-ins-only"] input')?.checked,
    favoritesOnly: document.querySelector<HTMLInputElement>('[data-testid="posky-favorites-only"] input')?.checked,
    resetDisabled: document.querySelector<HTMLButtonElement>('[data-testid="posky-reset-filters"]')?.disabled
  }))
  check(
    'Reset filters clears class, island, search, and every list toggle',
    state.query === '' && state.island === '' && state.classChips === 0 &&
      state.hideCompleted === false && state.turnInsOnly === false &&
      state.favoritesOnly === false && state.resetDisabled === true,
    JSON.stringify(state)
  )
}

/** THE HEADLINE: tick it, leave the tab, come back — it is still ticked. */
async function stepSticksAcrossTabs(page: Page): Promise<void> {
  const ticked = await setBox(page, true)
  if (!check('the box ticks when clicked', ticked === true, String(ticked))) return
  const stored = await settle(() => storedValue(page), (v) => v === '1', { timeoutMs: 8_000 })
  check(`the tick is stored under ${KEY}`, stored === '1', `stored ${String(stored)}`)

  const after = await roundTrip(page)
  check('HIDE COMPLETED SURVIVES LEAVING AND RETURNING TO THE SKY TAB', after === true, String(after))
}

/**
 * The other direction, and the reason this is a PREFERENCE rather than a latch: un-ticking has to
 * survive the same round trip. A "sticky" implementation that only ever remembered `true` (an
 * absent-means-default read paired with a write that skipped `false`) would pass the step above
 * and strand a user who changed their mind on the far side of one tab switch.
 */
async function stepUntickSticksToo(page: Page): Promise<void> {
  const unticked = await setBox(page, false)
  if (!check('the box un-ticks when clicked again', unticked === false, String(unticked))) return
  const stored = await settle(() => storedValue(page), (v) => v === '0', { timeoutMs: 8_000 })
  check('…and the un-tick is stored too, not merely un-remembered', stored === '0', `stored ${String(stored)}`)

  const after = await roundTrip(page)
  check('…so the box comes back UNTICKED, the way it was left', after === false, String(after))
}

/** Leave it ticked for launch 2 — the restart half reads what this launch wrote. */
async function stepArmRestart(page: Page): Promise<boolean> {
  const ticked = await setBox(page, true)
  return check('the box is left ticked for the restart check', ticked === true, String(ticked))
}

/** THE RESTART: a second process, the same userData dir, the same answer. */
async function stepSurvivesRestart(page: Page): Promise<void> {
  if (!check('the Sky tab opens after a restart', await openSky(page))) return
  const after = await settle(() => boxState(page), (v) => v !== null, { timeoutMs: 8_000 })
  check('HIDE COMPLETED SURVIVES A FULL RESTART', after === true, String(after))
  check('…and the stored pref crossed the process boundary intact', (await storedValue(page)) === '1')
}

async function main(): Promise<void> {
  buildIfStale()

  // OWNED BY THIS SPEC, not by either launch: the restart assertion IS the dir outliving a
  // process, so `launchApp` must not delete what it did not create.
  const userData = makeUserData()
  try {
    console.log('launch 1: a fresh install — default, tab round trip, and the un-tick…')
    const first = await launchApp({ userData })
    let page: Page | null = null
    try {
      page = await mainWindow(first.app)
      await page.waitForSelector(NAV_OVERVIEW, { timeout: 60_000 })
      if (!check('the Sky tab opens', await openSky(page))) {
        throw new Error('never reached the Plane of Sky tab — nothing below can be asserted')
      }
      await stepDefault(page)
      await stepResetFilters(page)
      await stepSticksAcrossTabs(page)
      await stepUntickSticksToo(page)
      await stepArmRestart(page)
      if (failures.length) await dumpArtifacts(page, 'sky-filters-FAIL')
    } finally {
      await first.close()
    }

    console.log('launch 2: the SAME userData dir, a new process — the tick must still be there…')
    const second = await launchApp({ userData })
    let restarted: Page | null = null
    try {
      restarted = await mainWindow(second.app)
      await restarted.waitForSelector(NAV_OVERVIEW, { timeout: 60_000 })
      await stepSurvivesRestart(restarted)
      if (failures.length) await dumpArtifacts(restarted, 'sky-filters-restart-FAIL')
    } finally {
      await second.close()
    }
  } finally {
    await removeUserData(userData)
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
