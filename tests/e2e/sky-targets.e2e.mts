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
 * every unit test is happy with. JOS-417 added the two seams the integration grew: a quest name
 * that is a DOOR onto the Quests tab (`revealQuest`, a control on one tab moving another), and
 * the first-time toggle, whose whole subject is a quest that is ABSENT. JOS-423 added a third: the
 * walk order the fold computes has to reach the SCREEN as structure the eye can follow - island
 * headings that climb, every card under one of them, the unplaced group at the bottom.
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
/** JOS-423: one per island heading, carrying the sortable island number (or `none`). */
const ISLAND = '[data-testid="sky-target-island"]'
const SEARCH = '[data-testid="posky-search"] input'
const COUNTS = '[data-testid="posky-counts"]'
/** JOS-417's two additions: the quest door on an item line, and the first-time toggle. */
const QUEST_LINK = '[data-testid="sky-target-quest"]'
const FIRST_TIME = '[data-testid="posky-targets-first-time"]'
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

/** Is the first-time box ticked? Reads the checkbox itself, never its wrapper's class. */
function firstTimeTicked(page: Page): Promise<boolean | null> {
  return page.evaluate((sel) => {
    const input = document.querySelector(sel)?.querySelector('input')
    return input instanceof HTMLInputElement ? input.checked : null
  }, FIRST_TIME)
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
    'the pane states its ordering rule - state, never process',
    count.includes('island by island'),
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
 * JOS-423, the owner's directive as the player sees it: THE PANE READS IN WALK ORDER. The fold's
 * comparator is unit-pinned; what only a real app can show is that the ORDER SURVIVES THE RENDER —
 * that the headings the user scrolls past really do climb, that every card sits under one of them
 * (a card outside the grouping would be invisible to the eye but still counted by the tab label),
 * and that the unplaced group is at the BOTTOM rather than merely present somewhere.
 *
 * Numbers are relative, never frozen (this file's law): the assertion is that the sequence is
 * non-decreasing and that `none` is last, which holds at any island set the committed data grows.
 */
async function stepIslandOrder(page: Page): Promise<void> {
  const islands = await page.evaluate(
    (sel) => [...document.querySelectorAll(sel)].map((el) => el.getAttribute('data-island') ?? ''),
    ISLAND
  )
  if (!check('the mob cards are grouped under island headings', islands.length > 0, `groups=${islands.join(',')}`)) {
    return
  }
  const numbered = islands.filter((i) => i !== 'none').map(Number)
  const climbs = numbered.every((n, i) => i === 0 || numbered[i - 1] <= n)
  check('THE ISLANDS CLIMB - the list reads in walk order', climbs, `groups=${islands.join(',')}`)
  const noneAt = islands.indexOf('none')
  check(
    'a mob the data places nowhere is LAST, never folded into a guessed island',
    noneAt === -1 || noneAt === islands.length - 1,
    `groups=${islands.join(',')}`
  )
  if (noneAt !== -1) {
    const title = await page.evaluate(
      (sel) => [...document.querySelectorAll(sel)].at(-1)?.textContent ?? '',
      `${ISLAND} [data-testid="sky-target-island-title"]`
    )
    check('…and its heading says so in words rather than showing a number', title.includes('not stated'), title)
  }
  // Every card is under a heading: the grouping is a re-cut of the whole list, not a filter.
  const rows = await countOf(page, ROW)
  const grouped = await countOf(page, `${ISLAND} ${ROW}`)
  check('every mob card sits inside an island group', grouped === rows, `grouped=${String(grouped)} rows=${String(rows)}`)
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
  // The turn-in spends the items AND counts the quest as run. "Keeps it off" can only be
  // asserted AFTER the trade has demonstrably landed - the marker is already absent from the
  // loot step, so a poll that raced the tailer would pass vacuously. The evidence is the quest's
  // own turned-in badge on the Quests tab; only then is the Targets pane's silence meaningful.
  await page.click(TAB_QUESTS, { timeout: 15_000 })
  await page.waitForSelector(COUNTS, { timeout: 15_000 })
  await page.fill(SEARCH, 'Test of Azarack', { timeout: 15_000 })
  const badge = await settle(
    () => countOf(page, '[data-testid="posky-turned-in"]'),
    (c) => c > 0,
    { timeoutMs: 30_000 }
  )
  if (!check('the trade landed: the quest wears its turned-in badge', badge > 0)) return
  await page.fill(SEARCH, '', { timeout: 15_000 })
  await page.click(TAB_TARGETS, { timeout: 15_000 })
  await page.waitForSelector(PANE, { timeout: 15_000 })
  // The spent items would read as needed again under hasEveryItem - the first-time need set is
  // what keeps a run quest out, and this is the assertion that proves it, post-evidence.
  const settled = await paneText(page)
  check('…AND THE TURN-IN KEEPS IT OFF: a run quest never rejoins the first-time need set', !settled.includes(MARKER))
}

/**
 * JOS-417: A QUEST NAME ON A CARD IS A DOOR. The item lines name the quests that want the item;
 * clicking one is `revealQuest` — the same deep link a celebration toast follows — so the app
 * lands on the Quests tab with every filter cleared and the search box holding that name. The
 * search box is the falsifiable half: the tab could switch for any reason, but only the deep link
 * fills the box, and a filter left set would be the defect `revealQuest` exists to prevent.
 */
async function stepQuestDoor(page: Page): Promise<void> {
  const name = await page.evaluate(
    (sel) => document.querySelector(sel)?.textContent ?? '',
    QUEST_LINK
  )
  if (!check('an item line names a quest to open', name.trim() !== '', `name=${name}`)) return
  await page.click(QUEST_LINK, { timeout: 15_000 })
  await page.waitForSelector(COUNTS, { timeout: 15_000 })
  const typed = await settle(
    () => page.evaluate((sel) => (document.querySelector(sel) as HTMLInputElement | null)?.value ?? '', SEARCH),
    (v) => v !== '',
    { timeoutMs: 15_000 }
  )
  check(
    'CLICKING A QUEST NAME OPENS IT ON THE QUESTS TAB, filters cleared',
    typed.trim() === name.trim(),
    `search=${typed} link=${name}`
  )
  await page.fill(SEARCH, '', { timeout: 15_000 })
  await page.click(TAB_TARGETS, { timeout: 15_000 })
  await page.waitForSelector(PANE, { timeout: 15_000 })
}

/**
 * JOS-417, the last live transition and the reason the toggle exists. The arc above left the
 * Beastlord quest TURNED IN with its items spent — so it wants them again, and the only thing
 * keeping it off the list is the first-time box. Unticking brings the marker straight back; the
 * box is the honest inverse of the assertion the arc just made, which is what makes both
 * falsifiable rather than one of them being a way to always pass.
 */
async function stepRefarmToggle(page: Page): Promise<void> {
  const ticked = await firstTimeTicked(page)
  if (!check('the first-time box is drawn and starts ticked', ticked === true, `ticked=${String(ticked)}`)) return
  const before = await paneText(page)
  if (!check('the run quest is off the list while the box is ticked', !before.includes(MARKER))) return

  await page.click(FIRST_TIME, { timeout: 15_000 })
  const wide = await settle(() => paneText(page), (t) => t.includes(MARKER), { timeoutMs: 20_000 })
  check('UNTICKING THE BOX READMITS THE REFARM - its items were spent, so it wants them again', wide.includes(MARKER))

  await page.click(FIRST_TIME, { timeout: 15_000 })
  const narrow = await settle(() => paneText(page), (t) => !t.includes(MARKER), { timeoutMs: 20_000 })
  check('…and re-ticking it puts the first-time reading back', !narrow.includes(MARKER))
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
      await stepIslandOrder(page)
      await stepQuestDoor(page)
      await stepIgnoreRemoves(page)
      await stepLiveArc(page, log, new Date(now - 60_000))
      await stepRefarmToggle(page)
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
