/**
 * THE MANUAL BASE-RUNG CLEAR, AND THAT IT SURVIVES A RESTART
 * (docs/plans/boss-lockout-credit-and-manual-clear.md section 2a).
 *
 * Its own module for the reason `loadoutSectionSteps.mts` and `buffRestartSteps.mts` have one:
 * bosses-week.e2e.mts is at the measured 400-code-line factoring ceiling, and this is a pair of
 * steps — one per launch — about the manual d0 mark rather than about the tab preference that
 * spec is named for.
 *
 * CLOCK-GATED LIKE EVERY GREEN RUNG IN THAT SPEC. The affordance needs a credited
 * open-world/unknown kill of that target THIS lockout week, which depends on the real clock over a
 * fixed fixture, so `stepManualClearPersists` SKIPS cleanly when the owner's log has no eligible
 * target this reset week rather than asserting one exists. When it does fire it proves the click
 * writes through to localStorage; `stepManualClearSurvivedRestart` then proves — only if launch 1
 * actually marked something — that the write crossed a process boundary.
 */
import type { Page } from 'playwright-core'
import { check, settle } from './appHarness.mjs'

/** The base rung on a week-view card, carrying `data-can-mark` / `data-manual` / `data-cleared`. */
const RUNG_D0 = '[data-testid="boss-rung-d0"]'

/** Every persisted per-character weekClears key currently in localStorage. */
function weekClearsKeys(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith('eq.bosses.weekClears.'))
  )
}

/** LAUNCH 1: click an eligible d0 rung and prove the mark writes through to localStorage. */
export async function stepManualClearPersists(page: Page): Promise<void> {
  // The store must have learned the character (Critical 1). Without this a "no markable rung"
  // result below would be indistinguishable from the store never bootstrapping — with it, a skip
  // means only "no target has a credited open-world kill this reset week", which is legitimate and
  // clock-dependent. What stays uncoverable here is the click path itself when the real log has no
  // eligible target; the pure toggle logic is pinned in tests/bossWeekClears.test.mts instead.
  const ready = await page.locator('[data-testid="boss-view"]').getAttribute('data-week-clears-ready')
  check('the weekClears store learned the character', ready === 'true', String(ready))

  const markable = page.locator(`${RUNG_D0}[data-can-mark="1"]`).first()
  if ((await markable.count()) === 0) {
    console.log('  (no target has a credited open-world kill this week — manual-clear step skipped)')
    return
  }
  await markable.click()
  const cleared = await settle(
    () => markable.getAttribute('data-cleared'),
    (v) => v === '1',
    { timeoutMs: 5_000 }
  )
  check('clicking an eligible d0 rung marks it cleared', cleared === '1', String(cleared))
  check('…and the rung reports it was a manual mark', (await markable.getAttribute('data-manual')) === '1')
  const keys = await weekClearsKeys(page)
  check('…and it wrote a per-character weekClears key', keys.length === 1, JSON.stringify(keys))
}

/** LAUNCH 2: if launch 1 marked a rung, the write must have crossed the process boundary. */
export async function stepManualClearSurvivedRestart(page: Page): Promise<void> {
  if ((await weekClearsKeys(page)).length === 0) return
  const stillMarked = await page.locator(`${RUNG_D0}[data-manual="1"]`).count()
  check('A MANUAL BASE-RUNG CLEAR SURVIVES A FULL RESTART', stillMarked > 0, String(stillMarked))
}
