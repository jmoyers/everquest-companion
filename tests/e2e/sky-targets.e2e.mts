/**
 * Headless Electron integration test for THE TARGETS TAB (issue #30) — the Sky tracker's kill
 * list: every mob still worth killing for the quests you have never turned in, plus the two
 * honest remainders (the random-drop Wind Runes and the items nothing committed can source).
 *
 * WHY THIS NEEDS A REAL APP. The fold itself is unit-tested against the real pure code
 * (tests/skyTargets.test.mts). What no unit test can see is the CHAIN the tab's whole promise
 * rests on: that the list moves LIVE — an ignore flag flipped on the Quests tab, a loot line
 * travelling chokidar to Tailer to the loot ledger, a trade closing a quest — each re-derives
 * the pane with no reload anywhere. JOS-87 is the standing reminder that chains break at seams
 * every unit test is happy with.
 *
 * EVERY LINE SHAPE IS COPIED FROM THE OWNER'S REAL LOG, never invented (the awaiting-sample law)
 * — the same proven Beastlord Test of Azarack lines sky-turnin.e2e.mts and
 * sky-class-unlocks.e2e.mts drive. That quest is also the right subject HERE for a reason those
 * specs did not need: its two items are exactly the tab's two remainder paths — Azarack Skin is
 * one of the three items no catalog page sources (the no-known-source note), and Wind Rune Heda
 * is a random drop (the collective entry). So the arc below exercises the honest-rendering
 * sections, not only the mob cards.
 *
 * NUMBERS ARE RELATIVE, NEVER FROZEN: the committed Sky data can gain quests and mobs, so every
 * assertion is a floor, a delta, or a property (presence, agreement between the tab label and the
 * rows) that holds at any count.
 *
 * Run: `npm run test:e2e -- sky-targets`.
 */
import type { Page } from 'playwright-core'
import { buildIfStale, check, countOf, dumpArtifacts, failures, reportRun, settle } from './appHarness.mjs'
import { mainWindow } from './appWindow.mjs'
import { launchOnFixture, stageFixture, type FixtureLog } from './logFixture.mjs'

const NAV_SKY = '[data-testid="nav-posky"]'
const NAV_OVERVIEW = '[data-testid="nav-overview"]'
const TAB_TARGETS = '[data-testid="posky-tab-targets"]'
const TAB_QUESTS = '[data-testid="posky-tab-quests"]'
const TAB_IGNORED = '[data-testid="posky-tab-ignored"]'
const PANE = '[data-testid="posky-targets"]'
const COUNT = '[data-testid="posky-targets-count"]'
const ROW = '[data-testid^="sky-target-row-"]'
const SEARCH = '[data-testid="posky-search"] input'
const COUNTS = '[data-testid="posky-counts"]'
/** The flag buttons carry no testid; their aria-labels are the stable words the user hears. */
const IGNORE = '[aria-label="Ignore this quest permanently"]'
const UNIGNORE = '[aria-label="Stop ignoring this quest"]'

/** The quest driven live, and the verbatim lines that do it (shapes from the real log). */
const GIVER = 'Animist Kratho'
const ITEMS = ['Azarack Skin', 'Wind Rune Heda'] as const
const LOOT = [
  `--You have looted an ${ITEMS[0]} from Protector of Sky's corpse.--`,
  `--You have looted a ${ITEMS[1]} from an azarack's corpse.--`
]
const TURN_IN = [
  ...ITEMS.map((i) => `You offered 1 ${i} to ${GIVER}.`),
  `You complete the trade with ${GIVER}.`
]
/** The item whose presence tracks the Beastlord quest's contribution: it is needed by that quest
 *  alone, so it appears and disappears with it (Wind Rune Heda is shared and would not). */
const MARKER = ITEMS[0]

/** The pane's whole text — presence is asserted on words, the way a player reads the tab. */
function paneText(page: Page): Promise<string> {
  return page.evaluate((sel) => document.querySelector(sel)?.textContent ?? '', PANE)
}

/** The tab label's own count, or null while the tab is countless. */
function labelCount(page: Page): Promise<number | null> {
  return page.evaluate((sel) => {
    const m = /Targets \((\d+)\)/.exec(document.querySelector(sel)?.textContent ?? '')
    return m ? Number(m[1]) : null
  }, TAB_TARGETS)
}

/** Open the Sky tab, then the Targets tab, and wait for the pane. */
async function openTargets(page: Page): Promise<boolean> {
  await page.click(NAV_SKY, { timeout: 30_000 })
  await page.waitForSelector(TAB_TARGETS, { timeout: 60_000 })
  await page.click(TAB_TARGETS, { timeout: 15_000 })
  const shown = await page.waitForSelector(PANE, { timeout: 30_000 }).then(
    () => true,
    () => false
  )
  return check('the Targets tab opens onto its own pane', shown)
}

/** Rows, the derived statement, and the one agreement that matters: label count = row count. */
async function stepPane(page: Page): Promise<void> {
  const rows = await settle(() => countOf(page, ROW), (n) => n > 0, { timeoutMs: 30_000 })
  check('the fixture leaves mobs still worth killing', rows > 0, `rows=${String(rows)}`)
  const count = await page.evaluate((sel) => document.querySelector(sel)?.textContent ?? '', COUNT)
  check(
    'the pane states its order and that it is derived, never a guess',
    count.includes('sort first') && count.includes('Derived from your quest progress'),
    count.slice(0, 200)
  )
  const label = await labelCount(page)
  check(
    'THE TAB LABEL COUNTS THE MOB CARDS - the same array the pane draws',
    label === rows,
    `label=${String(label)} rows=${String(rows)}`
  )
  const covered = await page.evaluate(
    (sel) => [...document.querySelectorAll(sel)].every((el) => Number(el.getAttribute('data-covers')) >= 1),
    ROW
  )
  check('every row says how many needed items its mob covers', covered)
}

/**
 * AE3, LIVE: ignoring a quest takes its wants out of the kill list; un-ignoring restores them.
 * The flag is flipped on the QUESTS tab — a different tab entirely — which is exactly the chain
 * the unit tests cannot see: one localStorage flag, read through useVisibleQuests, re-deriving
 * this pane with nothing reloaded.
 */
async function stepIgnoreRemoves(page: Page): Promise<void> {
  const before = await settle(() => paneText(page), (t) => t.includes(MARKER), { timeoutMs: 20_000 })
  if (!check('the marker item is on the pane before anything is flagged', before.includes(MARKER))) return

  await page.click(TAB_QUESTS, { timeout: 15_000 })
  await page.waitForSelector(COUNTS, { timeout: 15_000 })
  await page.fill(SEARCH, 'Test of Azarack', { timeout: 15_000 })
  await page.waitForSelector(IGNORE, { timeout: 15_000 })
  await page.click(IGNORE, { timeout: 15_000 })
  await page.fill(SEARCH, '', { timeout: 15_000 })

  await page.click(TAB_TARGETS, { timeout: 15_000 })
  await page.waitForSelector(PANE, { timeout: 15_000 })
  const gone = await settle(() => paneText(page), (t) => !t.includes(MARKER), { timeoutMs: 20_000 })
  check('IGNORING THE QUEST TAKES ITS ITEM OFF THE KILL LIST, LIVE', !gone.includes(MARKER))

  await page.click(TAB_IGNORED, { timeout: 15_000 })
  await page.waitForSelector(UNIGNORE, { timeout: 15_000 })
  await page.click(UNIGNORE, { timeout: 15_000 })
  await page.click(TAB_TARGETS, { timeout: 15_000 })
  await page.waitForSelector(PANE, { timeout: 15_000 })
  const back = await settle(() => paneText(page), (t) => t.includes(MARKER), { timeoutMs: 20_000 })
  check('…and un-ignoring on the Ignored tab puts it straight back', back.includes(MARKER))
}

/**
 * AE7, LIVE, in two honest halves. Looting the items zeroes the shortfall — the quest has
 * nothing left to grind, so its wants leave the list BEFORE any turn-in. Handing them over then
 * turns the quest in, which is the state the first-time need set never readmits. Both
 * transitions arrive through the tailed log with no reload.
 */
async function stepLiveArc(page: Page, log: FixtureLog, at: Date): Promise<void> {
  const before = await paneText(page)
  if (!check('the marker item is back on the pane before the live arc', before.includes(MARKER))) return

  log.appendAt(at, ...LOOT)
  const looted = await settle(() => paneText(page), (t) => !t.includes(MARKER), { timeoutMs: 30_000 })
  check('LOOTING THE LAST ITEMS TAKES THE QUEST OFF THE LIST - nothing left to grind', !looted.includes(MARKER))

  log.appendAt(new Date(at.getTime() + 30_000), ...TURN_IN)
  // The turn-in spends the items AND counts the quest as run: under the first-time need set the
  // wants must NOT come back, even though the spent items would otherwise read as needed again.
  const settled = await settle(() => paneText(page), (t) => !t.includes(MARKER), { timeoutMs: 30_000 })
  check('…AND THE TURN-IN KEEPS IT OFF: a run quest never rejoins the first-time need set', !settled.includes(MARKER))
}

async function main(): Promise<void> {
  buildIfStale()

  const log = stageFixture('e2e-copy.log')
  const now = Date.now()
  try {
    const launched = await launchOnFixture(log)
    let page: Page | null = null
    try {
      page = await mainWindow(launched.app)
      await page.waitForSelector(NAV_OVERVIEW, { timeout: 60_000 })
      if (!(await openTargets(page))) {
        throw new Error('never reached the Targets tab - nothing below can be asserted')
      }
      await stepPane(page)
      await stepIgnoreRemoves(page)
      await stepLiveArc(page, log, new Date(now - 60_000))
      if (failures.length) await dumpArtifacts(page, 'sky-targets-FAIL')
    } finally {
      await launched.close()
    }
  } finally {
    await log.dispose()
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error -', err)
  process.exitCode = 1
})
