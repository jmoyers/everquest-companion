/**
 * The Gear tab's 2026-08-25 review round, driven in a real window: a NUMERIC SEARCH TOKEN, the
 * DROP COLUMNS chip, and the double-click FIT that must not drift. A module rather than more of
 * `gear.e2e.mts`, the gearColumnSteps.mts precedent: that file is at the repo's 400-code-line
 * factoring ceiling, and everything these steps need is already standing in the host spec.
 *
 * WHAT NEEDS A REAL APP HERE, given the unit tests own the arithmetic:
 *
 *   * THE TOKEN reaches the table through the DEFERRED search and reads the SCALED vector - the
 *     unit test proves `ac>=20` keeps the right rows; what only a window can prove is that the
 *     rows the window MOUNTS all clear the line, blank cells included (absent fails every operator).
 *   * THE CHIP toggles three sortable headers as ONE, and the table stays in percent mode either
 *     way for the derived column set (gearColumns.ts hands the trio's budget back, 2026-08-25).
 *   * THE FIT is a DOM measurement - a Range over text the ellipsis clips, a flex row's gaps, the
 *     cell's own computed padding - and it went wrong twice in ways no unit test can see: a
 *     measurement that read the column's CURRENT width fed itself its last answer, so every
 *     double-click grew (2026-08-15) and then shrank (the review's finding) the column. So the step
 *     double-clicks TWICE and demands the same width, and demands the name is no longer clipped.
 */
import type { Page } from 'playwright-core'
import { check, countOf, settle } from './appHarness.mjs'

const TABLE = '[data-testid="gear-table"]'
const COUNT = '[data-testid="gear-count"]'
const SEARCH = '[data-testid="gear-search"] input'
const AC_CELL = '[data-testid="gear-cell-AC"]'
const DROPS_TOGGLE = '[data-testid="gear-drops-toggle"]'
const ZONE_HEADER = '[data-testid="gear-sort-zone"]'
const LEVEL_HEADER = '[data-testid="gear-sort-zoneLevel"]'
const MOB_HEADER = '[data-testid="gear-sort-mob"]'
const NAME_HEADER = 'th[data-col="name"]'
const NAME_GRIP = 'th[data-col="name"] [data-testid="gear-col-resize"]'
const THELVORN_KEY = 'thelvorn, blade of light'
const THELVORN_NAME = `[data-testid="gear-row"][data-item-key="${THELVORN_KEY}"] [data-testid="planner-donor-name"]`

const until = (fn: () => Promise<boolean>, ms: number): Promise<boolean> => settle(fn, (ok) => ok, { timeoutMs: ms })

async function shownCount(page: Page): Promise<number> {
  const text = await page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '', COUNT)
  return Number((/[\d,]+/.exec(text)?.[0] ?? '0').replace(/,/g, ''))
}

/** Type into the search box and let the DEFERRED filter land - the three-poll streak, as gearColumnSteps. */
async function typeAndSettle(page: Page, value: string): Promise<number> {
  await page.fill(SEARCH, value, { timeout: 15_000 })
  let last = -1
  let streak = 0
  await settle(
    async () => {
      const shown = await shownCount(page)
      streak = shown === last ? streak + 1 : 0
      last = shown
      return streak >= 2
    },
    (ok) => ok,
    { timeoutMs: 15_000 }
  )
  return last
}

/**
 * 1. A NUMERIC TOKEN narrows the table, and every mounted row clears the line it names.
 * Runs on an unnarrowed corpus with the columns derived (AC is a core column, so its cells are on
 * screen without the picker), and hands the box back empty.
 */
export async function stepGearThreshold(page: Page): Promise<void> {
  const all = await typeAndSettle(page, '')
  const shown = await typeAndSettle(page, 'ac>=20')
  check('`ac>=20` narrows the table', shown > 0 && shown < all, `${String(shown)} of ${String(all)} rows state 20+ AC`)
  const cells = await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((c) => (c as HTMLElement).innerText.trim()), AC_CELL)
  const failing = cells.filter((t) => t === '' || Number(t) < 20)
  check(
    'every mounted AC cell reads 20 or more - no blank (absent fails the operator) and no 19',
    cells.length > 0 && failing.length === 0,
    failing.length === 0 ? `${String(cells.length)} cells checked` : `offending cells: ${failing.slice(0, 5).join(' | ')}`
  )
  await typeAndSettle(page, '')
  check('…and clearing the token restores the whole corpus', (await shownCount(page)) === all)
}

/** 2. THE DROP COLUMNS CHIP takes the Zone / Level / Mob trio off as one, and puts it back as one. */
export async function stepGearDropsToggle(page: Page): Promise<void> {
  const trio = async (): Promise<number> =>
    (await countOf(page, ZONE_HEADER)) + (await countOf(page, LEVEL_HEADER)) + (await countOf(page, MOB_HEADER))
  check('the trio is drawn by default - three sortable headers', (await trio()) === 3, `${String(await trio())} headers`)
  await page.click(DROPS_TOGGLE, { timeout: 15_000 })
  const gone = await until(async () => (await trio()) === 0, 15_000)
  check('switching Drop columns off removes all three headers at once', gone, `${String(await trio())} headers left`)
  // The derived column set stays a percentage layout without the trio - the budget it freed goes
  // back to the numbers rather than tipping the table into pixel mode (gearColumns.ts, 2026-08-25).
  check('…and the table stays in percent mode with the trio off', (await page.getAttribute(TABLE, 'data-layout')) === 'percent')
  await page.click(DROPS_TOGGLE, { timeout: 15_000 })
  const back = await until(async () => (await trio()) === 3, 15_000)
  check('…and switching it on draws all three again', back, `${String(await trio())} headers`)
}

function nameWidth(page: Page): Promise<number> {
  return page.evaluate((sel) => Math.round((document.querySelector(sel) as HTMLElement | null)?.getBoundingClientRect().width ?? 0), NAME_HEADER)
}

/**
 * 3. DOUBLE-CLICK FITS THE ITEM COLUMN TO ITS CONTENT, AND A SECOND DOUBLE-CLICK LANDS ON THE
 * SAME NUMBER. Runs with the box narrowed to Thelvorn so the widest mounted name is a known one,
 * and hands the widths back to the automatic layout (Alt+double-click) - the picker steps that
 * follow read `data-layout` and would misread a stored width map as their own doing.
 */
export async function stepGearColumnFit(page: Page): Promise<void> {
  await typeAndSettle(page, 'thelvorn')
  const auto = await nameWidth(page)
  await page.dblclick(NAME_GRIP, { timeout: 15_000 })
  const pixels = await until(async () => (await page.getAttribute(TABLE, 'data-layout')) === 'pixel', 15_000)
  check('a double-click on the grip puts the table in stated pixels', pixels)
  const first = await nameWidth(page)
  check('…and the Item column moved to fit its content', first > 0 && first !== auto, `${String(auto)}px → ${String(first)}px`)
  const clipped = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null
    return el === null ? -1 : el.scrollWidth - el.clientWidth
  }, THELVORN_NAME)
  check('…so the item name is no longer clipped (the fit measured the text, not the box)', clipped >= 0 && clipped <= 1, `overflow ${String(clipped)}px`)

  await page.dblclick(NAME_GRIP, { timeout: 15_000 })
  await until(async () => (await nameWidth(page)) !== 0, 5_000)
  const second = await nameWidth(page)
  check(
    'a SECOND double-click lands on the same width - the fit does not keep shrinking or growing',
    Math.abs(second - first) <= 1,
    `${String(first)}px then ${String(second)}px`
  )

  await page.dblclick(NAME_GRIP, { modifiers: ['Alt'], timeout: 15_000 })
  const restored = await until(async () => (await page.getAttribute(TABLE, 'data-layout')) === 'percent', 15_000)
  check('Alt+double-click hands every column back to the automatic layout', restored)
  await typeAndSettle(page, '')
}
