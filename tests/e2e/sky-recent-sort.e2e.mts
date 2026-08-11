/**
 * Headless Electron integration test for "MOST RECENTLY LOOTED MEANS THE LOOT YOU JUST MADE"
 * (JOS-146).
 *
 * THE BUG, in the owner's words (live-testing 2026-08-09): sorting the Sky quest list by most
 * recently looted "is not always working" — he looted a Hazy Opal and a quest he had already
 * gathered every item for stayed on top instead of the Hazy Opal quest moving up. Sometimes it
 * worked, sometimes it did not.
 *
 * WHAT IT ACTUALLY WAS. Not the recency key. Replaying his real log proves that key was right the
 * whole time: the Magician quest that needs Hazy Opal takes first place the instant the opal
 * lands. The culprit was the FAVORITE PIN — `useQuestList` sorted the list and then ran a SECOND
 * `sort()` over a favorite rank, and a second pass always wins. `eq.questFavorites` in his dev app
 * read ["rogue::rogue test of silence","warrior::warrior test of think"], so the quest stuck on top
 * was one he had STARRED, and no recency the sort could compute was ever going to move it.
 * "Sometimes" was simply "whenever no starred quest was in the way".
 *
 * WHY THIS NEEDS A REAL APP. The rule itself is pure and pinned without a browser
 * (tests/questSort.test.mts drives `orderQuests` and replays the owner's two log lines through the
 * real parser). What no unit test could see is the WIRING, and the wiring is exactly where the bug
 * lived: the sort was never wrong, the caller applied something on top of it. A spec that stars a
 * quest through the real star button, loots for a DIFFERENT quest by appending to the log the app
 * is tailing, and then reads the order off the rows on screen is the only thing that can tell
 * "the comparator is right" from "the list is right".
 *
 * THE FIXTURE IS CHOSEN FOR ITS SILENCE. `e2e-copy.log` carries ZERO loot lines, so on launch NO
 * quest has any recency at all and the recency order is the whole 95-quest no-drop block, by name.
 * The one line this spec appends is therefore the only loot in the world, and the quest it belongs
 * to is the only quest that can be first — an exact expectation rather than a floor.
 *
 * EVERY LINE SHAPE IS COPIED FROM THE OWNER'S REAL LOG, never invented (the awaiting-sample law):
 *   `--You have looted an Azarack Skin from Protector of Sky's corpse.--`   (verbatim, as in
 *   tests/e2e/sky-turnin.e2e.mts). Azarack Skin is required by exactly ONE quest in the committed
 *   data, so the loot names its winner unambiguously.
 *
 * THE STARRED QUEST IS THE OWNER'S OWN: Warrior Test of Think, the "warrior haste belt" of the
 * report (its reward is Belt of the Four Winds). It needs three items, none of which this spec
 * ever loots, so it can only ever reach the top by being pinned.
 *
 * WHY IT NEVER TAKES THE SCREEN: `EQ_E2E=1` (src/main/e2e.ts) shows no window, skips the
 * single-instance lock, and points `userData` at a throwaway temp dir per launch.
 *
 * Run: `npm run test:e2e -- sky-recent-sort`.
 */
import type { Page } from 'playwright-core'
import { buildIfStale, check, dumpArtifacts, failures, reportRun, settle } from './appHarness.mjs'
import { mainWindow } from './appWindow.mjs'
import { launchOnFixture, type FixtureLog } from './logFixture.mjs'

const NAV_SKY = '[data-testid="nav-posky"]'
const NAV_OVERVIEW = '[data-testid="nav-overview"]'
const SEARCH = '[data-testid="posky-search"]'
const COUNTS = '[data-testid="posky-counts"]'
const ROW = '.MuiAccordion-root'
/** The quest name inside a row's summary (QuestAccordion renders it as a subtitle2). */
const ROW_NAME = '.MuiTypography-subtitle2'
/** The always-visible quest star, by the label it announces itself with. */
const STAR = '[aria-label="Favorite this quest"]'
/** The sort picker, reached through its own label so the "Count items from" select beside it
 *  cannot be hit by accident. MUI stamps `data-value` on each option. */
const SORT = 'div.MuiFormControl-root:has(> label:text-is("Sort")) div[role="combobox"]'
const FAVORITES_KEY = 'eq.questFavorites'
const SORT_KEY = 'eq.questSort'

/** The quest the appended loot belongs to, and the one line that makes it the newest loot alive. */
const LOOTED_QUEST = 'Beastlord Test of Azarack'
const LOOT = "--You have looted an Azarack Skin from Protector of Sky's corpse.--"
/** The quest that gets the star: the owner's own, and one this spec never loots for. */
const STARRED_QUEST = 'Warrior Test of Think'

/** The quest names on screen, in the order the list renders them. */
function rowNames(page: Page): Promise<string[]> {
  return page.evaluate(
    ([row, name]) =>
      [...document.querySelectorAll(row)].map(
        (a) => a.querySelector(name)?.textContent ?? ''
      ),
    [ROW, ROW_NAME]
  )
}

/** The first row's quest name, or '' when nothing is rendered yet. */
async function firstRow(page: Page): Promise<string> {
  return (await rowNames(page))[0] ?? ''
}

/** How many quests the filters leave, off the counts line. `null` when it is not mounted. */
function filteredCount(page: Page): Promise<number | null> {
  return page.evaluate((sel) => {
    const m = /(\d+) of (\d+) quests/.exec(document.querySelector(sel)?.textContent ?? '')
    return m ? Number(m[1]) : null
  }, COUNTS)
}

/** What the renderer stored, verbatim. `null` when the key was never written. */
function storedValue(page: Page, key: string): Promise<string | null> {
  return page.evaluate((k) => localStorage.getItem(k), key)
}

/** Open the Sky tab and wait for its toolbar. */
async function openSky(page: Page): Promise<boolean> {
  await page.click(NAV_SKY, { timeout: 30_000 })
  return page.waitForSelector(SEARCH, { timeout: 60_000 }).then(
    () => true,
    () => false
  )
}

/** Pick a sort order through the real control, and wait for the choice to be stored. */
async function setSort(page: Page, value: string): Promise<boolean> {
  await page.click(SORT, { timeout: 15_000 })
  await page.click(`li[role="option"][data-value="${value}"]`, { timeout: 15_000 })
  const stored = await settle(() => storedValue(page, SORT_KEY), (v) => v === value, {
    timeoutMs: 8_000
  })
  return check(`the sort order is set to ${value}`, stored === value, `stored ${String(stored)}`)
}

/** Narrow to one quest by name, star it through its own button, then clear the search. */
async function starQuest(page: Page, name: string): Promise<boolean> {
  await page.fill(`${SEARCH} input`, name)
  const only = await settle(() => filteredCount(page), (n) => n === 1, { timeoutMs: 20_000 })
  if (!check(`the search narrows to ${name} alone`, only === 1, `filtered=${String(only)}`)) return false
  await page.click(STAR, { timeout: 15_000 })
  const stored = await settle(
    () => storedValue(page, FAVORITES_KEY),
    (v) => (v ?? '').includes(name.toLowerCase()),
    { timeoutMs: 8_000 }
  )
  const ok = check(
    `starring ${name} writes it to ${FAVORITES_KEY}`,
    (stored ?? '').includes(name.toLowerCase()),
    String(stored)
  )
  await page.fill(`${SEARCH} input`, '')
  await settle(() => filteredCount(page), (n) => n !== null && n > 1, { timeoutMs: 20_000 })
  return ok
}

/**
 * A fixture with no loot in it: nothing has a recency, so the default order is the no-drop block
 * by name. Returns what is on top, so the steps below can prove the star did or did not move it.
 */
async function stepBefore(page: Page): Promise<string> {
  const stored = await settle(() => storedValue(page, SORT_KEY), (v) => v !== null, { timeoutMs: 15_000 })
  check(`a fresh install opens the Sky tab sorted by most recently looted`, stored === 'recent', String(stored))
  const top = await settle(() => firstRow(page), (v) => v !== '', { timeoutMs: 30_000 })
  check('the quest list renders rows to read an order off', top !== '', top)
  check(
    `…and with no loot in the log yet, ${STARRED_QUEST} is not one of them on merit`,
    top !== STARRED_QUEST,
    top
  )
  return top
}

/**
 * THE REGRESSION: a star must not take over an order whose subject is an event. Before JOS-146 the
 * click below moved the starred quest to row one of every order there is, which is what put a
 * finished quest above the opal the owner had just looted.
 */
async function stepStarDoesNotPin(page: Page, before: string): Promise<void> {
  if (!(await starQuest(page, STARRED_QUEST))) return
  const top = await settle(() => firstRow(page), (v) => v !== '', { timeoutMs: 20_000 })
  check(
    'STARRING A QUEST DOES NOT MOVE IT TO THE TOP OF "MOST RECENTLY LOOTED"',
    top === before,
    `${before} -> ${top}`
  )
}

/** …and the star is not broken, only bounded: every other order still pins it. */
async function stepStarStillPinsElsewhere(page: Page): Promise<void> {
  if (!(await setSort(page, 'closest'))) return
  const top = await settle(() => firstRow(page), (v) => v === STARRED_QUEST, { timeoutMs: 20_000 })
  check(
    'THE STAR STILL PINS TO THE TOP OF EVERY STANDING-PROPERTY ORDER — here, closest to done',
    top === STARRED_QUEST,
    top
  )
}

/**
 * THE HEADLINE, and the owner's case in miniature: with a quest starred and the list back on most
 * recently looted, loot an item for a DIFFERENT quest and watch that quest take the top.
 *
 * The line travels the whole real path — chokidar → Tailer → parseEvent → the loot module → IPC →
 * the renderer's ledger → the recency key → the order on screen.
 */
async function stepLootWins(page: Page, log: FixtureLog, at: Date): Promise<void> {
  if (!(await setSort(page, 'recent'))) return
  log.appendAt(at, LOOT)
  const top = await settle(() => firstRow(page), (v) => v === LOOTED_QUEST, { timeoutMs: 45_000 })
  if (
    !check(
      `LOOTING FOR ${LOOTED_QUEST} PUTS IT ON TOP, PAST THE STARRED QUEST`,
      top === LOOTED_QUEST,
      `top=${top}`
    )
  ) {
    return
  }
  const names = await rowNames(page)
  check(
    `…and ${STARRED_QUEST} is somewhere below it rather than above`,
    names.indexOf(STARRED_QUEST) !== 0,
    `index=${String(names.indexOf(STARRED_QUEST))}`
  )
  check(
    '…with its star still set: the pin was SKIPPED for this order, not cleared',
    ((await storedValue(page, FAVORITES_KEY)) ?? '').includes(STARRED_QUEST.toLowerCase())
  )
}

async function main(): Promise<void> {
  buildIfStale()

  const launched = await launchOnFixture('e2e-copy.log')
  let page: Page | null = null
  try {
    page = await mainWindow(launched.app)
    await page.waitForSelector(NAV_OVERVIEW, { timeout: 60_000 })
    if (!(await openSky(page))) {
      throw new Error('never reached the Plane of Sky tab — nothing below can be asserted')
    }
    const before = await stepBefore(page)
    await stepStarDoesNotPin(page, before)
    await stepStarStillPinsElsewhere(page)
    await stepLootWins(page, launched.log, new Date())
    if (failures.length) await dumpArtifacts(page, 'sky-recent-sort-FAIL')
  } finally {
    await launched.close()
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
