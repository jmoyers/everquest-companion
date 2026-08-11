/** Focused Sky quest-list UX steps layered onto the sticky-filter lifecycle spec. */

import type { ElectronApplication, Page } from 'playwright-core'
import { check, countIn, settle, settleGone, settleStable } from './appHarness.mjs'

const BOX = '[data-testid="posky-hide-completed"]'
const TURNED_IN_BOX = '[data-testid="posky-hide-turned-in"]'
const ISLAND = '[data-testid="posky-island-filter"]'
const BOSS = '[data-testid="posky-boss-filter"]'
const COUNTS = '[data-testid="posky-counts"]'
const SEARCH = '[data-testid="posky-search"] input'
const RESET = '[data-testid="posky-reset-filters"]'
const TURN_INS_ONLY = '[data-testid="posky-turn-ins-only"]'
const FAVORITES_ONLY = '[data-testid="posky-favorites-only"]'
const QUEST_SCROLL = '[data-testid="posky-quest-scroll"]'
const SCROLL_TOP = '[data-testid="posky-scroll-top"]'
const QUEST_KEY = 'Paladin::Paladin Test of Spirit'

function boxState(page: Page, box: string): Promise<boolean | null> {
  return page.evaluate(
    (sel) => (document.querySelector(`${sel} input`) as HTMLInputElement | null)?.checked ?? null,
    box
  )
}

function chipsIn(page: Page, picker: string): Promise<string[]> {
  return page.evaluate(
    (sel) => [...document.querySelectorAll(`${sel} .MuiChip-label`)].map((n) => n.textContent ?? ''),
    picker
  )
}

function filteredCount(page: Page): Promise<number | null> {
  return page.evaluate((sel) => {
    const match = /(\d+) of (\d+) quests/.exec(document.querySelector(sel)?.textContent ?? '')
    return match ? Number(match[1]) : null
  }, COUNTS)
}

async function pick(page: Page, picker: string, typed: string): Promise<void> {
  await page.click(`${picker} input`, { timeout: 15_000 })
  await page.fill(`${picker} input`, typed)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
}

async function setBox(page: Page, box: string): Promise<void> {
  await page.click(box, { timeout: 15_000 })
  await settle(() => boxState(page, box), (value) => value === true, { timeoutMs: 8_000 })
}

/** Keyboard search, one-click clearing, and the conditional return-to-top affordance. */
async function stepSearchResetAndScroll(page: Page): Promise<void> {
  await page.fill(SEARCH, 'replace me')
  await page.keyboard.press('Control+F')
  const selected = await page.evaluate((sel) => {
    const input = document.querySelector<HTMLInputElement>(sel)
    return input === document.activeElement && input.selectionStart === 0 && input.selectionEnd === input.value.length
  }, SEARCH)
  check('Ctrl+F focuses and selects the Sky search while the view is mounted', selected)
  await page.keyboard.type('spirit')
  check('typing after Ctrl+F replaces the selected search', (await page.inputValue(SEARCH)) === 'spirit')

  await pick(page, ISLAND, 'Island 7')
  await pick(page, BOSS, 'The Spiroc Lord')
  await setBox(page, BOX)
  await setBox(page, TURNED_IN_BOX)
  await page.click(FAVORITES_ONLY)
  await page.click(RESET)

  const cleared = await settle(
    async () => ({
      query: await page.inputValue(SEARCH),
      islands: await chipsIn(page, ISLAND),
      bosses: await chipsIn(page, BOSS),
      hidden: await boxState(page, BOX),
      turnedIn: await boxState(page, TURNED_IN_BOX),
      turnInsOnly: await boxState(page, TURN_INS_ONLY),
      favorites: await boxState(page, FAVORITES_ONLY)
    }),
    (value) =>
      value.query === '' &&
      value.islands.length === 0 &&
      value.bosses.length === 0 &&
      value.hidden === false &&
      value.turnedIn === false &&
      value.turnInsOnly === false &&
      value.favorites === false,
    { timeoutMs: 8_000 }
  )
  check('Reset filters clears search, facets, and every Quests-tab toggle', cleared.query === '', JSON.stringify(cleared))

  await settle(() => filteredCount(page), (count) => count !== null && count > 30, { timeoutMs: 8_000 })
  check('the scroll-to-top button is absent while the quest list is at the top', (await countIn(page, SCROLL_TOP)) === 0)
  await page.evaluate((sel) => document.querySelector<HTMLElement>(sel)?.scrollTo({ top: 100_000 }), QUEST_SCROLL)
  const scrolledTop = await settleStable(
    () => page.evaluate((sel) => document.querySelector<HTMLElement>(sel)?.scrollTop ?? -1, QUEST_SCROLL),
    { timeoutMs: 8_000 }
  )
  if (!check('the quest list stays scrolled after its geometry settles', scrolledTop > 0, String(scrolledTop))) return
  const appeared = await settle(() => countIn(page, SCROLL_TOP), (count) => count === 1, { timeoutMs: 8_000 })
  if (!check('the scroll-to-top button appears after the quest list is scrolled', appeared === 1, String(appeared))) return

  // Reaching zero deliberately unmounts this conditional button, so skip the target-stability
  // retry after the action; the position and disappearance below prove the handler ran.
  await page.click(SCROLL_TOP, { force: true })
  const top = await settle(
    () => page.evaluate((sel) => document.querySelector<HTMLElement>(sel)?.scrollTop ?? -1, QUEST_SCROLL),
    (value) => value === 0,
    { timeoutMs: 8_000 }
  )
  check('the scroll-to-top button returns the quest list to the top', top === 0, String(top))
  check('the scroll-to-top button hides again at the top', await settleGone(page, SCROLL_TOP, { timeoutMs: 8_000 }))
}

/** Repeating the same real deep link must reopen and focus its independently open row. */
async function stepRepeatedQuestFocus(app: ElectronApplication, page: Page): Promise<void> {
  const overlay = await settle(
    () => app.windows().find((candidate) => candidate.url().includes('kind=toast')) ?? null,
    (candidate) => candidate !== null,
    { timeoutMs: 15_000 }
  )
  if (!check('the toast overlay is available for a real quest-focus roundtrip', overlay !== null)) return

  const focusQuest = (): Promise<void> =>
    (overlay as Page).evaluate((quest) => {
      ;(window as unknown as { eqOverlay: { focusApp: (focus: unknown) => void } }).eqOverlay.focusApp({
        view: 'posky',
        quest
      })
    }, QUEST_KEY)
  const anchoredSummary = '[data-anchored="true"] .MuiAccordionSummary-root'
  const focusedState = (): Promise<{ expanded: boolean; focused: boolean }> =>
    page.evaluate((summary) => {
      const el = document.querySelector<HTMLElement>(summary)
      return {
        expanded: el?.closest('.MuiAccordion-root')?.classList.contains('Mui-expanded') ?? false,
        focused: el === document.activeElement
      }
    }, anchoredSummary)

  await focusQuest()
  const first = await settle(focusedState, (state) => state.expanded && state.focused, { timeoutMs: 15_000 })
  check('a quest deep link opens and focuses the requested row', first.expanded && first.focused, JSON.stringify(first))

  await page.evaluate((summary) => document.querySelector<HTMLElement>(summary)?.click(), anchoredSummary)
  await settle(() => countIn(page, '[data-anchored="true"].Mui-expanded'), (count) => count === 0, { timeoutMs: 8_000 })
  await focusQuest()
  const repeated = await settle(focusedState, (state) => state.expanded && state.focused, { timeoutMs: 15_000 })
  check('repeating the same quest deep link reopens and refocuses it', repeated.expanded && repeated.focused, JSON.stringify(repeated))
  await page.click(RESET)
}

export async function stepQuestListUx(app: ElectronApplication, page: Page): Promise<void> {
  await stepSearchResetAndScroll(page)
  await stepRepeatedQuestFocus(app, page)
}
