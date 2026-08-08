/**
 * Headless Electron integration test for the Plane of Sky quest list.
 *
 * Pure sort keys are pinned in tests/questSort.test.mts. This spec owns what only the rendered
 * app can prove: keyboard search, tooltip/menu coexistence, island filtering, authoritative sort
 * order despite a starred quest, direction controls, and the accordion's visual/single-open behavior.
 *
 * Run: `npm run test:e2e -- posky`.
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
import { mainWindow } from './appWindow.mjs'
import { launchOnFixture } from './logFixture.mjs'

const QUEST = '[data-testid="posky-quest"]'

async function choose(page: Page, testId: string, option: string): Promise<void> {
  await page.click(`[data-testid="${testId}"]`)
  await page.getByRole('option', { name: option, exact: true }).click()
}

function countSourceTooltipVisible(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[role="tooltip"]')].some((tip) =>
      tip.textContent?.includes('Which source decides what you have')
    )
  )
}

/** Keyboard search and the count-source tooltip/menu lifecycle. */
async function stepControls(page: Page): Promise<void> {
  await page.keyboard.press('Control+f')
  check(
    'Ctrl+F focuses the Plane of Sky quest search',
    await page.evaluate(() => {
      const search = document.querySelector('[data-testid="posky-search"] input')
      return search !== null && document.activeElement === search
    })
  )
  await page.hover('[data-testid="posky-count-source"]')
  const helpVisible = await settle(() => countSourceTooltipVisible(page), (visible) => visible, { timeoutMs: 10_000 })
  check('hovering the Plane of Sky count source still explains it', helpVisible)
  await page.click('[data-testid="posky-count-source"]')
  const sourceMenu = await settle(
    () =>
      Promise.all([page.locator('[role="listbox"]').count(), countSourceTooltipVisible(page)]).then(
        ([menus, tooltip]) => menus === 1 && !tooltip
      ),
    (ready) => ready,
    { timeoutMs: 10_000 }
  )
  check('opening the Plane of Sky count-source menu dismisses its tooltip', sourceMenu)
  await page.keyboard.press('Escape')
  await page.hover('[data-testid="nav-posky"]')
  await page.hover('[data-testid="posky-count-source"]')
  const helpReturned = await settle(() => countSourceTooltipVisible(page), (visible) => visible, { timeoutMs: 10_000 })
  check('the count-source tooltip can appear again after its menu closes', helpReturned)

  const islandControl = await page.locator('[data-testid="posky-island-filter"]').evaluate((root) => {
    const label = root.querySelector('label')
    return { label: label?.textContent ?? '', width: root.getBoundingClientRect().width }
  })
  check(
    'the island filter keeps its full label and a readable control width',
    islandControl.label.includes('Filter by island') && islandControl.width >= 180,
    JSON.stringify(islandControl)
  )
}

/** The island dropdown matches ANY explicitly located required drop, not runes or blank inputs. */
async function stepIslandFilter(page: Page): Promise<void> {
  await choose(page, 'posky-island-filter', 'Island 8')
  const state = await settle(
    () =>
      page.evaluate((selector) => {
        const rows = [...document.querySelectorAll<HTMLElement>(selector)]
        return rows.length > 0 && rows.every((row) => (row.dataset.islands ?? '').split(',').includes('8'))
      }, QUEST),
    (matches) => matches,
    { timeoutMs: 10_000 }
  )
  check('Island 8 filters to quests requiring an explicitly stated Island 8 drop', state)
  await choose(page, 'posky-island-filter', 'Island 5')
  const eagle = await settle(
    () =>
      page.evaluate((selector) => {
        const row = [...document.querySelectorAll<HTMLElement>(selector)].find((quest) =>
          quest.innerText.includes('Druid Test of Eagle')
        )
        return { present: row !== undefined, primaryIsland: row?.dataset.primaryIsland ?? null }
      }, QUEST),
    (value) => value.present && value.primaryIsland === '7',
    { timeoutMs: 10_000 }
  )
  check(
    'Island 5 includes Druid Test of Eagle through a later required item, not its Island 7 primary item',
    eagle?.present === true && eagle.primaryIsland === '7',
    JSON.stringify(eagle)
  )
  await choose(page, 'posky-island-filter', 'All islands')
  await settle(() => countOf(page, QUEST), (count) => count >= 3, { timeoutMs: 10_000 })
}

async function favoriteTwoQuests(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    const row = [...document.querySelectorAll<HTMLElement>(selector)].find(
      (quest) => Number(quest.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')) > 0
    )
    row?.querySelector<HTMLButtonElement>('[aria-label="Favorite this quest"]')?.click()
  }, QUEST)
  const search = page.locator('[data-testid="posky-search"] input')
  await search.fill('Khyldorn')
  await settle(() => countOf(page, QUEST), (count) => count === 1, { timeoutMs: 10_000 })
  await page.click(`${QUEST} [aria-label="Favorite this quest"]`)
  await search.fill('')
  await settle(() => countOf(page, QUEST), (count) => count >= 40, { timeoutMs: 10_000 })
}

async function revealEveryQuest(page: Page): Promise<void> {
  const showMore = page.getByRole('button', { name: /^Show more/ })
  await settle(() => countOf(page, QUEST), (count) => count <= 50, { timeoutMs: 10_000 })
  for (let pageNo = 0; pageNo < 3 && (await showMore.count()) > 0; pageNo++) {
    await showMore.click()
  }
  await settle(() => countOf(page, QUEST), (count) => count >= 90, { timeoutMs: 10_000 })
}

function readCompletionOrder(page: Page, section: string) {
  return page.evaluate(({ selector, sectionSelector }) => {
    const rows = [...document.querySelectorAll<HTMLElement>(`${sectionSelector} ${selector}`)]
    const values = rows.map((row) =>
      Number(row.querySelector<HTMLElement>('[role="progressbar"]')?.getAttribute('aria-valuenow') ?? Number.NaN)
    )
    const khyldornIndex = rows.findIndex((row) => row.innerText.includes('Khyldorn the Blood Drinker'))
    return {
      ordered: values.every((value, index) => index === 0 || values[index - 1] >= value),
      count: rows.length,
      firstValue: values[0] ?? null,
      khyldornIndex,
      khyldornValue: khyldornIndex >= 0 ? values[khyldornIndex] : null,
      khyldornStarred:
        khyldornIndex >= 0 && rows[khyldornIndex].querySelector('[aria-label="Unfavorite this quest"]') !== null
    }
  }, { selector: QUEST, sectionSelector: section })
}

function favoriteCompletionOrderMatches(state: Awaited<ReturnType<typeof readCompletionOrder>> | null | undefined): boolean {
  if (!state) return false
  return state.ordered && (state.firstValue ?? 0) > 0 && state.khyldornValue === 0 && state.khyldornIndex > 0 && state.khyldornStarred
}

function readIslandBadges(page: Page) {
  return page.evaluate((selector) => {
    const rows = [...document.querySelectorAll<HTMLElement>(selector)]
    const known = rows.filter((row) => row.dataset.primaryIsland !== undefined)
    const unknown = rows.filter((row) => row.dataset.primaryIsland === undefined)
    return {
      knownCount: known.length,
      unknownCount: unknown.length,
      matching: rows.every((row) => {
        const badge = row.querySelector<HTMLElement>('[data-testid="posky-primary-island-badge"]')
        return badge?.textContent?.trim() === (row.dataset.primaryIsland ? `Island ${row.dataset.primaryIsland}` : undefined)
      })
    }
  }, QUEST)
}

function readIslandOrder(page: Page, descending: boolean, section: string) {
  return page.evaluate(
    ({ selector, desc, sectionSelector }) => {
      const rows = [...document.querySelectorAll<HTMLElement>(`${sectionSelector} ${selector}`)]
      let previous: number | null = null
      let sawUnknown = false
      let ordered = true
      let knownCount = 0
      let unknownCount = 0
      for (const row of rows) {
        const value = row.dataset.primaryIsland
        if (value === undefined || value === '') {
          sawUnknown = true
          unknownCount++
          continue
        }
        const island = Number(value)
        knownCount++
        if (sawUnknown || (previous !== null && (desc ? island > previous : island < previous))) {
          ordered = false
        }
        previous = island
      }
      return { ordered, knownCount, unknownCount }
    },
    { selector: QUEST, desc: descending, sectionSelector: section }
  )
}

function islandOrderMatches(
  state: Awaited<ReturnType<typeof readIslandOrder>> | null | undefined,
  requireUnknown = false
): boolean {
  return Boolean(state?.ordered && state.knownCount > 0 && (!requireUnknown || state.unknownCount > 0))
}

/** A favorite stays marked without overriding the selected completion-progress order. */
async function stepCompletionSort(page: Page): Promise<void> {
  await favoriteTwoQuests(page)
  await choose(page, 'posky-sort', 'Completion progress')
  await revealEveryQuest(page)
  const favorites = await settle(
    () => readCompletionOrder(page, '[data-testid="posky-favorites-section"]'),
    (value) => favoriteCompletionOrderMatches(value),
    { timeoutMs: 10_000 }
  )
  check(
    'Favorites stay at the top while respecting completion-progress order internally',
    favoriteCompletionOrderMatches(favorites) && favorites.count >= 2,
    JSON.stringify(favorites)
  )
  const regular = await readCompletionOrder(page, '[data-testid="posky-regular-section"]')
  check('non-favorites independently respect completion-progress order', regular.count > 0 && regular.ordered)

  const viewport = page.locator('[data-testid="posky-quest-scroll"]')
  await viewport.evaluate((element) => element.scrollTo({ top: 0 }))
  check('scroll-to-top stays hidden before the quest list is scrolled', await settleGone(page, '[data-testid="posky-scroll-top"]'))
  const scrolled = await settle(
    () =>
      viewport.evaluate((list) => {
        const header = document.querySelector<HTMLElement>('[data-testid="posky-favorites-toggle"]')
        const button = document.querySelector<HTMLElement>('[data-testid="posky-scroll-top"]')
        if (!header) return false
        if (list.scrollTop === 0) list.scrollTo({ top: list.scrollHeight })
        const listBox = list.getBoundingClientRect()
        const buttonStyle = button ? getComputedStyle(button) : null
        return (
          list.scrollTop > 0 &&
          Math.abs(header.getBoundingClientRect().top - listBox.top) < 2 &&
          buttonStyle?.right === '16px' &&
          buttonStyle.bottom === '16px'
        )
      }),
    (ready) => ready
  )
  check('Favorites stays sticky and scroll-to-top appears at bottom right while scrolled', scrolled)
  await page.click('[data-testid="posky-scroll-top"]')
  const returnedTop = await settle(() => viewport.evaluate((element) => element.scrollTop), (top) => top === 0)
  check(
    'scroll-to-top returns to the start and hides itself again',
    returnedTop === 0 && (await settleGone(page, '[data-testid="posky-scroll-top"]'))
  )

  const favoriteToggle = page.locator('[data-testid="posky-favorites-toggle"]')
  await viewport.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await favoriteToggle.click()
  const collapsed = (await favoriteToggle.getAttribute('aria-expanded')) === 'false'
  const closedAtFavorites = await settle(() => viewport.evaluate((element) => element.scrollTop), (top) => top === 0)
  await viewport.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await favoriteToggle.click()
  const openedAtFavorites = await settle(() => viewport.evaluate((element) => element.scrollTop), (top) => top === 0)
  check('the sticky Favorites header returns to the section when closing or opening it', collapsed && closedAtFavorites === 0 && openedAtFavorites === 0)
}

/** Main-item island order is strict, reversible, and equally authoritative with that star set. */
async function stepIslandSort(page: Page): Promise<void> {
  await choose(page, 'posky-sort', 'Main item island')
  await revealEveryQuest(page)
  const badges = await readIslandBadges(page)
  check(
    'known primary islands render matching badges while unknown quests stay unbadged',
    badges.knownCount > 0 && badges.unknownCount > 0 && badges.matching,
    JSON.stringify(badges)
  )
  const favoriteAscending = await readIslandOrder(page, false, '[data-testid="posky-favorites-section"]')
  const regularAscending = await readIslandOrder(page, false, '[data-testid="posky-regular-section"]')
  check(
    'Main item island defaults to ascending inside favorites and non-favorites',
    islandOrderMatches(favoriteAscending) && islandOrderMatches(regularAscending, true),
    JSON.stringify({ favoriteAscending, regularAscending })
  )
  await page.click('[data-testid="posky-sort-direction"]')
  await revealEveryQuest(page)
  const favoriteDescending = await readIslandOrder(page, true, '[data-testid="posky-favorites-section"]')
  const regularDescending = await readIslandOrder(page, true, '[data-testid="posky-regular-section"]')
  check(
    'descending reverses each section and keeps unknown non-favorites last',
    islandOrderMatches(favoriteDescending) && islandOrderMatches(regularDescending, true),
    JSON.stringify({ favoriteDescending, regularDescending })
  )

  await page.reload()
  await page.waitForSelector('[data-testid="nav-posky"]', { timeout: 60_000 })
  await page.click('[data-testid="nav-posky"]')
  await page.waitForSelector(QUEST, { timeout: 20_000 })
  await revealEveryQuest(page)
  const restoredFavorites = await readIslandOrder(page, true, '[data-testid="posky-favorites-section"]')
  const restoredRegular = await readIslandOrder(page, true, '[data-testid="posky-regular-section"]')
  const restoredSort = await page.locator('[data-testid="posky-sort"]').innerText()
  check(
    'Main item island and descending direction persist across a renderer reload',
    restoredSort.includes('Main item island') &&
      islandOrderMatches(restoredFavorites) &&
      islandOrderMatches(restoredRegular, true) &&
      (await countOf(
        page,
        '[data-testid="posky-sort-direction"][aria-label="Change to ascending order"]'
      )) === 1,
    `${restoredSort} · ${JSON.stringify({ restoredFavorites, restoredRegular })}`
  )
}

/** Opening a new quest replaces the current selection instead of accumulating open panels. */
async function stepSingleOpenQuest(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    const rows = [...document.querySelectorAll<HTMLElement>(selector)]
    rows[2]?.querySelector<HTMLElement>('.MuiAccordionSummary-root')?.click()
  }, QUEST)
  const state = await settle(
    () =>
      page.evaluate((selector) => {
        const rows = [...document.querySelectorAll<HTMLElement>(selector)]
        return (
          rows.filter((row) => row.classList.contains('Mui-expanded')).length === 1 &&
          !rows[1]?.classList.contains('Mui-expanded') &&
          rows[2]?.classList.contains('Mui-expanded') === true
        )
      }, QUEST),
    (singleOpen) => singleOpen,
    { timeoutMs: 10_000 }
  )
  check('opening another Sky quest closes the previously expanded quest', state)
}

function readQuestVisualState(page: Page) {
  return page.evaluate((selector) => {
    const rows = [...document.querySelectorAll<HTMLElement>(selector)]
    if (rows.length < 3) return null
    const above = getComputedStyle(rows[1], '::before')
    const below = getComputedStyle(rows[2], '::before')
    const expandedStyle = getComputedStyle(rows[1])
    return {
      above: above.display !== 'none' && Number(above.opacity) > 0 && parseFloat(above.height) >= 1,
      below: (below.display !== 'none' && Number(below.opacity) > 0 && parseFloat(below.height) >= 1) || parseFloat(expandedStyle.borderBottomWidth) >= 1,
      expanded: rows[1].classList.contains('Mui-expanded'),
      selectedBackground: getComputedStyle(rows[1]).backgroundColor !== getComputedStyle(rows[0]).backgroundColor
    }
  }, QUEST)
}

function readQuestTableState(page: Page) {
  return page.evaluate((selector) => {
    const row = document.querySelectorAll<HTMLElement>(selector)[1]
    if (!row) return null
    const itemRows = [...row.querySelectorAll<HTMLTableRowElement>('tbody > tr')]
    const headerCell = row.querySelector<HTMLElement>('thead th')
    const firstItemCell = itemRows[0]?.querySelector<HTMLElement>('td')
    const lastItemCells = [...(itemRows.at(-1)?.querySelectorAll<HTMLElement>('td') ?? [])]
    return {
      headerSeparated: headerCell !== null && parseFloat(getComputedStyle(headerCell).borderBottomWidth) >= 1,
      itemsSeparated: itemRows.length < 2 || (firstItemCell !== null && parseFloat(getComputedStyle(firstItemCell).borderBottomWidth) >= 1),
      finalItemOpen: lastItemCells.length > 0 && lastItemCells.every((cell) => parseFloat(getComputedStyle(cell).borderBottomWidth) === 0)
    }
  }, QUEST)
}

/** Expanded quests read as one selected block, with clean outer and inner boundaries. */
async function stepQuestDividers(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    const rows = [...document.querySelectorAll<HTMLElement>(selector)]
    rows[1]?.querySelector<HTMLElement>('.MuiAccordionSummary-root')?.click()
  }, QUEST)
  const state = await settle(
    async () => {
      const [visual, table] = await Promise.all([readQuestVisualState(page), readQuestTableState(page)])
      return visual && table ? { ...visual, ...table } : null
    },
    (value) => value?.expanded === true,
    { timeoutMs: 10_000 }
  )
  check('an expanded Sky quest keeps visible dividers above and below it', state?.expanded === true && state.above && state.below, JSON.stringify(state))
  check('the expanded Sky quest uses a distinct selected background', state?.selectedBackground === true)
  check(
    'the Sky item table keeps internal rules but leaves its final row open',
    state?.headerSeparated === true && state.itemsSeparated === true && state.finalItemOpen === true,
    JSON.stringify(state)
  )
  await stepSingleOpenQuest(page)
}

async function main(): Promise<void> {
  buildIfStale()
  console.log('launch: hidden Electron (EQ_E2E=1) against tests/fixtures/w14-sky-currency-loot.log…')
  const { app, close } = await launchOnFixture('w14-sky-currency-loot.log')
  let page: Page | null = null
  try {
    page = await mainWindow(app)
    const consoleErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => consoleErrors.push(String(error)))
    await page.waitForSelector('[data-testid="nav-posky"]', { timeout: 60_000 })
    const dismissNotice = page.locator('[data-testid="telemetry-notice-dismiss"]')
    if ((await dismissNotice.count()) > 0) {
      await dismissNotice.click()
      check(
        'the first-run telemetry notice is gone before Plane of Sky controls are exercised',
        await settleGone(page, '[data-testid="telemetry-notice"]', { timeoutMs: 8_000 })
      )
    }
    await page.click('[data-testid="nav-posky"]')
    await page.waitForSelector(QUEST, { timeout: 20_000 })

    await stepControls(page)
    await stepIslandFilter(page)
    await stepCompletionSort(page)
    await stepIslandSort(page)
    await stepQuestDividers(page)

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
    if (failures.length) await dumpArtifacts(page, 'posky-FAIL')
  } finally {
    await close()
  }
  reportRun()
}

main().catch((error: unknown) => {
  console.error('e2e: harness error —', error)
  note('the Plane of Sky spec did not complete')
  process.exitCode = 1
})
