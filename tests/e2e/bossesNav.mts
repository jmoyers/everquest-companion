// THE BOSSES TAB ROUND TRIP — the navigation bracket bosses-week wraps every assertion in, out
// of that file because it is at the 400-code-line ceiling (the same move, for the same reason,
// as loadoutSectionSteps.mts). The trip OUT asserts the toolbar is really gone first: the
// remembered-tab bug lived in the unmount, so an assertion after a navigation that never
// unmounted anything would be a tautology (bosses-week's header carries the whole argument).
//
// Selectors are spelled again rather than imported: this file must not make bosses-week export
// its constants (loadoutSectionSteps' rule).

import type { Page } from 'playwright-core'
import { check } from './appHarness.mjs'
import { settleGone } from './settle.mjs'

const NAV_BOSSES = '[data-testid="nav-bosses"]'
const NAV_OVERVIEW = '[data-testid="nav-overview"]'
const MODE = '[data-testid="boss-mode"]'

/** Open the Bosses tab and wait for its toolbar. Safe when the tab is already the open one. */
export async function openBosses(page: Page, timeoutMs = 60_000): Promise<boolean> {
  await page.click(NAV_BOSSES, { timeout: 30_000 })
  return page.waitForSelector(MODE, { timeout: timeoutMs }).then(
    () => true,
    () => false
  )
}

/**
 * Leave for another tab, and confirm the Bosses view is really gone. This is the step the bug
 * lived in: the assertion after it means nothing unless `BossView` was actually unmounted here.
 */
export async function leaveBosses(page: Page): Promise<boolean> {
  await page.click(NAV_OVERVIEW, { timeout: 30_000 })
  return settleGone(page, MODE, { timeoutMs: 15_000 })
}

/** Away to the Overview and back to Bosses, with the unmount actually asserted in between. */
export async function awayAndBack(page: Page): Promise<boolean> {
  if (!check('leaving the Bosses tab unmounts it (the mode toggle is gone)', await leaveBosses(page))) {
    return false
  }
  return check('…and the Bosses tab comes back', await openBosses(page))
}
