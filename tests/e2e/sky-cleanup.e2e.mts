/**
 * Headless Electron integration test for THE CLEANUP TAB (JOS-389, rebuilt JOS-401) — the fifth
 * Sky tab, which lists the quest items no un-turned-in quest still wants, says where they are
 * sitting, and argues the other way before you throw them out.
 *
 * THE OWNER'S ASK, 2026-08-16: after a long Plane of Sky campaign a player is carrying dozens of
 * quest items in bags, bank, shared bank, personal depot and the Dragon Hoard for quests they
 * finished months ago, and nothing in the app has ever said which are safe to destroy. Nothing
 * should say "destroy this" either: a Sky quest can be run AGAIN, a second turn-in is a second copy
 * of the reward, and two copies merge into a +1. So the row carries both halves.
 *
 * AND HIS SECOND ASK, THE DAY THE TAB SHIPPED (JOS-401): the destruction is IN THE LOG. It always
 * was — `You successfully destroyed <N> <Item>.`, 356 lines of his own — and the app was asking him
 * to press a button stating it. The button is gone, the manual re-read of the inventory export is
 * gone (this tab follows the file like every other Sky surface), and what replaces both is the
 * subject of steps 3 to 5 below: a destroy line arriving in the tailed log while the tab is open.
 *
 * WHY THIS NEEDS A REAL APP. The arithmetic is pure and pinned without a browser
 * (tests/skyCleanup.test.mts drives the cases, tests/lootDispositionWindows.test.mts the fold on
 * real bytes, tests/skyItemOverrides.test.mts the witness discount per count source). What no unit
 * test can see is the WIRING: the log line → the parser → the LootModule's LIVE delta → the held
 * counts → `reconcile` → the cleanup model → a tab whose COUNT is computed above the pane it
 * labels, and the same number arriving on the Quests tab beside it.
 *
 * THE FIXTURE IS THE POINT, and it was measured rather than invented. The committed dump
 * (tests/fixtures/Primitive_freeport-Inventory.txt, a real `/outputfile inventory`) contains
 * EXACTLY ONE Plane of Sky quest item — `Azarack Skin`, one copy, in `General 5-Slot7` — and that
 * item is required by exactly ONE quest in the committed data, `Beastlord Test of Azarack`. So a
 * single recorded turn-in flips one item from "still wanted" to "spare", and every number below is
 * caused by one act. The log fixture `e2e-copy.log` carries ZERO loot lines, so nothing else can be
 * in the way and every count this spec asserts is arithmetic this file performed on purpose.
 *
 * THE ARITHMETIC, SPELLED OUT ONCE (count source `both`, the shipped default — `max(dump, log less
 * the turn-ins)`, each witness discounted on its own terms). The dump is READ at launch, so its
 * instant precedes everything this spec does and every subtraction below is stamped after it:
 *
 *   after the turn-in   log 0 - 1 turn-in = 0 · dump 1 - 1 turn-in = 0            -> no row
 *   loot 3              log 3 - 1 turn-in = 2 · dump 1 + 3 - 1 turn-in = 3       -> x3
 *   destroy 1           log 3-1 = 2, -1 turn-in = 1 · dump 1+3-1-1 = 2           -> x2
 *   destroy 5 more      log floors at 0 · dump floors at 0                       -> no row
 *
 * THE SECOND AND THIRD LINES USED TO READ `x2` AND `x1`, AND THAT WAS THE BUG JOS-409 NAMES. The
 * dump witness was discounted by the post-dump turn-in and credited with NONE of the post-dump loot,
 * so it collapsed to 0 and the log answered alone — and the log charges the turn-in against the
 * three copies it watched drop, because it never saw the one the dump vouched for. One physical
 * turn-in, two witnesses, both charged. The player is holding three skins here, and the tab used to
 * say two. This spec is the live path agreeing with tests/skyCurrencyRuneWitness.test.mts.
 *
 * THE FIRST LINE IS JOS-403, AND IT USED TO READ `x1`. The spec asserted that a turn-in leaves the
 * dump's copy on the tab, on JOS-141's "a dump owes nothing" — which is true of the turn-ins made
 * BEFORE the file was written and false of the one this spec plays afterwards. That was the
 * reporter's second complaint verbatim (v1.4.0, feedback 01M081TPHPGB173YCC4YH7AMZB: the Cleanup tab
 * kept listing copies he no longer held), and the tab is now empty until the player farms a copy the
 * turn-in did not eat. The arithmetic is pinned unit-side in tests/skyTurnInAfterDump.test.mts; what
 * this spec adds is that the whole live path agrees.
 *
 * AND SINCE JOS-409 THAT TURN-IN IS PLAYED INTO THE LOG RATHER THAN CLICKED. The dump's window is a
 * comparison against a FILE'S generation stamp, so only an EVENT time may enter it, and the hand
 * counter's instant is a click time — an upper bound on when the trade happened and nothing more.
 * Step 2 therefore pins both halves: the click leaves the dump witness alone, and the real trade
 * lines still spend it. Every number in the table above is unchanged, because the hand-recorded
 * turn-in is taken back before the real one arrives.
 *
 * The last line is the floor doing its job in public: five destroyed where two were held is not
 * -3, and the row simply ends. Both witnesses are discounted, which is why the last step needs the
 * dump half to work as well as the log half — the dump would otherwise keep vouching for its copy
 * forever, which is exactly the defect the owner reported.
 *
 * WHY IT NEVER TAKES THE SCREEN: `EQ_E2E=1` (src/main/e2e.ts) shows no window, skips the
 * single-instance lock, and points `userData` at a throwaway temp dir per launch.
 *
 * Run: `npm run test:e2e -- sky-cleanup`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import {
  ARTIFACTS,
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  failures,
  note,
  reportRun,
  settle,
  settleCount,
  settleGone,
  settleStable
} from './appHarness.mjs'
import { mainWindow } from './appWindow.mjs'
import { launchOnFixture, type FixtureLog } from './logFixture.mjs'

const NAV_SKY = '[data-testid="nav-posky"]'
const NAV_OVERVIEW = '[data-testid="nav-overview"]'
const SEARCH = '[data-testid="posky-search"]'
const COUNTS = '[data-testid="posky-counts"]'
const QUEST_ROW = '[data-testid="posky-quest-row"]'
const SUMMARY = `${QUEST_ROW} .MuiAccordionSummary-root`
const RECORD_TURNIN = '[data-testid="posky-record-turnin"]'
/** The take-back beside it. It can only reach turn-ins the LOG does not also know about. */
const UNDO_TURNIN = '[data-testid="posky-undo-turnin"]'

const TAB_QUESTS = '[data-testid="posky-tab-quests"]'
const TAB_CLEANUP = '[data-testid="posky-tab-cleanup"]'
const CLEANUP = '[data-testid="posky-cleanup"]'
const CAVEAT = '[data-testid="posky-cleanup-caveat"]'
const EMPTY = '[data-testid="posky-cleanup-empty"]'
const ROW = '[data-testid="posky-cleanup-row"]'
/** The item and every reward on this tab are the same component (QuestItemsTable's ItemNameLink). */
const NAME_LINK = `${ROW} [data-testid="posky-item-link"]`
/** …so the REWARD carries a handle of its own, because it is the one this spec is about. */
const REWARD_LINK = `${ROW} [data-testid="posky-cleanup-reward"] [data-testid="posky-item-link"]`
const POPPER = '.MuiTooltip-popper'
/** The count-source control, which STAYS - it is the strategy, not a refresh. */
const SOURCE = '[data-testid="posky-count-source"]'
/** Everything JOS-401 removed. Asserted as an ABSENCE, once, so a revert cannot pass quietly. */
const GONE = [
  '[data-testid="posky-cleanup-destroy"]',
  '[data-testid="posky-cleanup-destroyed"]',
  '[data-testid="posky-cleanup-undo"]',
  '[data-testid="posky-cleanup-refresh"]'
]

const QUEST = 'Beastlord Test of Azarack'
const GIVER = 'Animist Kratho'
const ITEM = 'Azarack Skin'
const RUNE = 'Wind Rune Heda'
const REWARD = 'Azarack Skin Wristwraps'
/** ONE COMPLETED TRADE, as the game prints it: an offer per required item, then the closing line
 *  (shared/questTurnIns.ts states the shape; sky-turnin.e2e.mts drives the whole arc off it). This
 *  is what a LOG-DETECTED turn-in is, and since JOS-409 it is the only kind that windows the dump. */
const TURN_IN = [
  `You offered 1 ${ITEM} to ${GIVER}.`,
  `You offered 1 ${RUNE} to ${GIVER}.`,
  `You complete the trade with ${GIVER}.`
]
/** The dump that holds exactly one Sky item — see the header. */
const DUMP = 'Primitive_freeport-Inventory.txt'
/** The owner's caveat, in his own words. "There is a warning" is not the assertion; this is. */
const CAVEAT_TEXT =
  'Cleanup lists items you could destroy because every Sky quest that needs them has been turned in. Destroying is permanent and happens in the game, not here. If you delete something you wanted, that is on you.'
/** What a row says when no loaded dump names the item - the state the place read starts in. */
const NO_PLACE = 'not in the export'

/**
 * A PICTURE OF THE TAB — OPT-IN, and off in every ordinary run.
 *
 * THIS SUITE CANNOT PHOTOGRAPH ITSELF, and that is by design rather than by defect. `EQ_E2E=1`
 * never shows the window (src/main/e2e.ts), so `page.screenshot` waits for a frame an uncomposited
 * surface will never produce — the shared `dumpArtifacts` gives it a 3 s budget and reports the
 * lapse — and `webContents.capturePage()` on a hidden window was MEASURED here to return a blank
 * 924-byte frame, which is worse than no artifact because it looks like one.
 *
 * The only way to a real picture is to put the window on screen, which is exactly the property the
 * suite promises not to break. So it is behind `EQ_E2E_SHOT=1`: unset (every CI and local run) the
 * spec behaves identically to every other spec and takes no screen at all; set, it shows the
 * window inactive for one capture and hides it again, which is how a human gets a picture of a
 * surface to review without hand-driving the app.
 *
 * A failure to capture is logged and never a check. The HTML dump is still what a failing run is
 * read from.
 */
async function captureTab(app: ElectronApplication, tag: string): Promise<void> {
  if (process.env.EQ_E2E_SHOT !== '1') return
  try {
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      // The MAIN window by its own document, not `getAllWindows()[0]` — the overlays and the
      // cursor ring are windows too, and they are all hidden, so an index-based pick photographs
      // whichever blank one the array happened to start with.
      const win = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && w.webContents.getURL().includes('index.html')
      )
      if (!win) return null
      // Inactive: the point is a frame, never the focus. Hidden again before anything else runs.
      win.showInactive()
      await new Promise((r) => setTimeout(r, 750))
      const shot = (await win.capturePage()).toPNG().toString('base64')
      win.hide()
      return shot
    })
    if (png === null) return
    mkdirSync(ARTIFACTS, { recursive: true })
    const at = join(ARTIFACTS, `${tag}.png`)
    writeFileSync(at, Buffer.from(png, 'base64'))
    console.log(`artifact: ${at}`)
  } catch (err) {
    console.log(`artifact: capturePage unavailable - ${String(err)}`)
  }
}

/** One Cleanup row as the player reads it: the item, how many, where, and every turn-in line. */
interface Row {
  item: string
  count: number
  where: string
  turnIns: string[]
}

function rows(page: Page): Promise<Row[]> {
  return page.evaluate((sel) => {
    return [...document.querySelectorAll(sel)].map((el) => ({
      item: el.getAttribute('data-item') ?? '',
      count: Number(el.getAttribute('data-count')),
      where: (el.querySelector('[data-testid="posky-cleanup-where"]') as HTMLElement | null)?.innerText.trim() ?? '',
      turnIns: [...el.querySelectorAll('[data-testid="posky-cleanup-turnin"]')].map((t) =>
        (t as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
      )
    }))
  }, ROW)
}

/**
 * The tab's own label, which carries the row count — the number that decides whether to look.
 *
 * `textContent`, not `innerText`: MUI upper-cases tab labels in CSS, and `innerText` reports the
 * TRANSFORMED text ("CLEANUP"). The claim here is about the words the component renders, so it is
 * read from the DOM rather than from the theme's typography.
 */
function tabLabel(page: Page): Promise<string> {
  return page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? '', TAB_CLEANUP)
}

/**
 * The `have/need` pair in the QUEST tab's item table — `sky-item-override.e2e.mts`'s reader,
 * because two steps below assert the exact thing that spec asserts from the other end: there is one
 * held count and both tabs read it.
 */
function haveText(page: Page, item: string): Promise<string | null> {
  return page.evaluate((name) => {
    const row = [...document.querySelectorAll('tr')].find((tr) =>
      (tr.cells[1]?.textContent ?? '').trim().startsWith(name)
    )
    if (!row) return null
    return /^\s*(\d+\/\d+)/.exec(row.cells[2]?.textContent ?? '')?.[1] ?? null
  }, item)
}

/** How many quests the filters leave, off the counts line. `null` when it is not mounted. */
function filteredCount(page: Page): Promise<number | null> {
  return page.evaluate((sel) => {
    const m = /(\d+) of (\d+) quests/.exec(document.querySelector(sel)?.textContent ?? '')
    return m ? Number(m[1]) : null
  }, COUNTS)
}

/** Open the Sky tab and narrow the Quests list to the one quest, expanded. */
async function openTheQuest(page: Page): Promise<boolean> {
  await page.click(NAV_SKY, { timeout: 30_000 })
  const bar = await page.waitForSelector(SEARCH, { timeout: 60_000 }).then(
    () => true,
    () => false
  )
  if (!check('the Sky tab opens on its filter bar', bar)) return false
  await page.fill(`${SEARCH} input`, QUEST)
  const only = await settle(() => filteredCount(page), (n) => n === 1, { timeoutMs: 30_000 })
  if (!check(`the search narrows to ${QUEST} alone`, only === 1, `filtered=${String(only)}`)) return false
  await page.click(SUMMARY, { timeout: 15_000 })
  const have = await settle(() => haveText(page, ITEM), (v) => v !== null, { timeoutMs: 20_000 })
  return check('…and expanding it draws the item table', have !== null, String(have))
}

/**
 * Back to the Quests tab, with the one quest's panel open again.
 *
 * The accordion has to be re-expanded every time: a tab switch UNMOUNTS the pane (AGENTS.md's
 * "a view unmounts on every tab switch"), and `QuestAccordion` is deliberately uncontrolled, so a
 * remount is a collapsed row. The search box is not re-typed for the opposite reason — the filter
 * state lives in `useQuestList`, above the tab switch, and survives.
 */
async function reopenTheQuestPanel(page: Page): Promise<boolean> {
  await page.click(TAB_QUESTS, { timeout: 15_000 })
  await page.waitForSelector(SUMMARY, { timeout: 20_000 })
  await page.click(SUMMARY, { timeout: 15_000 })
  const have = await settle(() => haveText(page, ITEM), (v) => v !== null, { timeoutMs: 20_000 })
  return check('the quest panel opens again on the Quests tab', have !== null, String(have))
}

async function openCleanup(page: Page): Promise<boolean> {
  await page.click(TAB_CLEANUP, { timeout: 15_000 })
  const up = await page.waitForSelector(CLEANUP, { timeout: 20_000 }).then(
    () => true,
    () => false
  )
  return check('the Cleanup tab opens', up)
}

/** Wait for the tab to settle on a stated count for the one item; `null` when the row is gone. */
function settleCountOf(page: Page, want: number | null): Promise<Row[]> {
  return settle(
    () => rows(page),
    (r) => (want === null ? r.length === 0 : r.length === 1 && r[0].count === want),
    { timeoutMs: 30_000 }
  )
}

/**
 * STEP 1 — THE MEMBERSHIP RULE, ASSERTED AS AN ABSENCE, and the screen's own controls.
 *
 * The dump says this character is holding an Azarack Skin and the app counts it (the Quests tab
 * reads 1/1 for it). It is still not on this tab, because the quest that wants it has never been
 * handed in. An item any un-turned-in quest still needs is not spare, and that is the entire rule.
 */
async function stepNothingSpareYet(page: Page): Promise<boolean> {
  const held = await haveText(page, ITEM)
  check('the dump makes the app count the skin in the first place', held === '1/1', String(held))
  if (!(await openCleanup(page))) return false

  const caveat = await page.evaluate(
    (s) => (document.querySelector(s) as HTMLElement | null)?.innerText.trim() ?? '',
    CAVEAT
  )
  check('the caveat is up before anything is listed, in the owner`s words', caveat === CAVEAT_TEXT, caveat)
  // Not dismissible: an Alert with a close action renders one, and this one must never have it.
  check(
    '…and it cannot be dismissed - this screen is destructive advice by design',
    (await countOf(page, `${CAVEAT} .MuiAlert-action`)) === 0
  )
  check('the count-source control is still here - it is the strategy, not a refresh', (await countOf(page, SOURCE)) === 1)
  // JOS-401's removals, as an absence. The log states a destroy, so no button asks the player to.
  for (const sel of GONE) {
    check(`no ${sel} anywhere on the tab (JOS-401)`, (await countOf(page, sel)) === 0)
  }

  const listed = await rows(page)
  check(
    'AN ITEM AN UN-TURNED-IN QUEST STILL NEEDS IS NOT LISTED',
    listed.length === 0,
    listed.map((r) => r.item).join(', ')
  )
  check('…so is the empty state, rather than a bare pane', (await countOf(page, EMPTY)) === 1)
  return check('…and the tab wears no count', (await tabLabel(page)) === 'Cleanup', await tabLabel(page))
}

/**
 * STEP 2 — THE TURN-IN ATE THE DUMP'S COPY (JOS-403), so the tab stays empty. AND WHICH KIND OF
 * TURN-IN MAY SAY SO (JOS-409).
 *
 * The copy the file vouched for is the copy the player just handed to Animist Kratho. This spec
 * used to assert the opposite here — one row, x1 — on JOS-141's "a dump is written after every
 * turn-in, so it owes no subtraction". That holds for the turn-ins made BEFORE the file, and the
 * one played below is stamped after the app read it: reconcile discounts the dump witness by the
 * turn-ins recorded strictly after its instant, exactly as it already does for destroys.
 *
 * WHAT JOS-409 CHANGED, AND WHY THIS STEP NOW HAS TWO HALVES. The window is a comparison between an
 * INSTANT and a FILE'S GENERATION STAMP, so it may only read instants that are event times. The
 * hand counter's are not: `recordTurnIn` stamps `Date.now()` at the CLICK, which is an upper bound
 * on when the trade happened and nothing more, so a player recording on Friday a hand-in made on
 * Tuesday would have a Wednesday dump discounted for a turn-in it already reflects. That is
 * JOS-141's double-subtraction arriving through the door JOS-403 opened, and it read as a count
 * that was too low — the one direction the 2026-08-09 ruling refuses.
 *
 * So the click no longer moves the dump witness (first half, asserted as the count HOLDING), and
 * the real trade lines still do (second half, the JOS-403 claim intact end to end). The hand-recorded
 * one is taken back before the real one is played, so the ledger below carries exactly one turn-in
 * and every number in steps 3 to 6 is unchanged. The hand counter's own live arc is
 * `sky-turnin.e2e.mts`; what this step owes it is only the dump-window rule.
 *
 * Asserted as an ABSENCE THAT SETTLES rather than a bare read, because the empty tab is also what
 * the previous step saw: the turn-in has to travel the store → the ledger → reconcile before this
 * means anything, and the Quests tab reading 0/1 is the positive half of the same claim.
 */
async function stepTurnInEatsTheDumpsCopy(page: Page, log: FixtureLog): Promise<boolean> {
  if (!(await reopenTheQuestPanel(page))) return false

  // (a) THE HAND COUNTER DOES NOT WINDOW THE DUMP. `settleStable` is how an absence of change is
  // asserted here: the click has to be given time to travel the whole path and then be seen NOT to
  // have moved this number, which a bare read a millisecond later cannot distinguish from a race.
  await page.click(RECORD_TURNIN, { timeout: 15_000 })
  const heldOn = await settleStable(() => haveText(page, ITEM), { timeoutMs: 10_000 })
  check(
    'A HAND-RECORDED TURN-IN LEAVES THE DUMP ALONE — a click time is not an event time (JOS-409)',
    heldOn === '1/1',
    String(heldOn)
  )
  // Take it back, so the ledger the rest of this spec reasons about carries the played turn-in and
  // nothing else. An undo can only reach the turn-ins the log does not also know about, which is
  // exactly what this one is.
  await page.click(UNDO_TURNIN, { timeout: 15_000 })

  // (b) THE REAL TRADE, in the tailed log: an offer per required item, then the line that closes
  // the group (shared/questTurnIns.ts states that shape; sky-turnin.e2e.mts drives it at length).
  // Its instant is the log's own, and it is stamped after the dump was read.
  log.append(...TURN_IN)
  const spent = await settle(() => haveText(page, ITEM), (v) => v === '0/1', { timeoutMs: 20_000 })
  if (
    !check(
      'THE TURN-IN SPENDS THE COPY THE DUMP VOUCHED FOR — the quest reads 0/1 with no fresh dump',
      spent === '0/1',
      String(spent)
    )
  ) {
    return false
  }
  if (!(await openCleanup(page))) return false
  const listed = await settleCountOf(page, null)
  check(
    '…so nothing is spare: an item you no longer hold is not on the Cleanup tab',
    listed.length === 0,
    listed.map((r) => `${r.item} x${String(r.count)}`).join(', ')
  )
  return check('…and the tab still wears no count', (await tabLabel(page)) === 'Cleanup', await tabLabel(page))
}

/**
 * STEP 3 — THE REFARM PUTS IT BACK, and the row states everything the decision needs.
 *
 * Three loots arrive in the tailed log. This is the Sky refarm story on the tab that exists for it —
 * hand it in, farm more, and the spares show up.
 *
 * IT READS x3, WHICH IS WHAT THE PLAYER IS HOLDING (JOS-409). It used to read x2, and the two is
 * where this ticket's whole argument is visible on a screen: the log charges the turn-in against the
 * three copies it watched drop, because it never saw the one the dump vouched for, so its answer is
 * 3 - 1 = 2. The dump saw that fourth copy and has now been credited with the loot that arrived in
 * its own window, so it answers 1 + 3 - 1 = 3 and wins the max. One physical turn-in used to be
 * charged to both witnesses at once; a count that was too low is the failure the 2026-08-09 ruling
 * exists to refuse.
 */
async function stepRefarmMakesItSpare(page: Page, log: FixtureLog): Promise<boolean> {
  log.append(`--You have looted 3 ${ITEM} from a spiroc guardian's corpse.--`)
  const listed = await settleCountOf(page, 3)
  if (
    !check(
      'A LOOT LINE ARRIVING IN THE TAILED LOG PUTS THE ITEM ON THE TAB — every quest that wants it is done',
      listed.length === 1 && listed[0].count === 3,
      listed.map((r) => `${r.item} x${String(r.count)}`).join(', ')
    )
  ) {
    return false
  }
  check('…named with the tab`s own held count', listed[0].item === ITEM, listed[0].item)
  // MEMBERSHIP AND PLACE SETTLE SEPARATELY, and that is not padding. The row exists the moment the
  // count crosses zero; where it SITS is a second read (`character:sheet` → the dump → `carryAll`)
  // that resolves on its own clock, so waiting on the row and then reading the place is a race the
  // row wins. Each claim waits for itself. The place still comes from the DUMP — a file that no
  // longer vouches for the count can still say which bag slot it was in, and does.
  const placed = await settle(
    () => rows(page),
    (r) => r.length === 1 && r[0].where !== NO_PLACE,
    { timeoutMs: 20_000 }
  )
  const [row] = placed
  check('…and placed where the DUMP says it is sitting', row.where === 'General 1', row.where)
  check(
    '…with the turn-in it feeds spelled out: who, how many times, and what it pays',
    row.turnIns.length === 1 &&
      row.turnIns[0].startsWith(`Animist Kratho - Beastlord Test of Azarack (Beastlord) · turned in 1 time · reward: ${REWARD}`),
    row.turnIns.join(' | ')
  )
  // The other half of the decision. Skins and no wind rune is not another set, so the row says what
  // it would take rather than arguing to keep something that cannot be handed in yet.
  check(
    '…and the decision line states the gap toward running it again',
    row.turnIns[0].endsWith('you hold 1 of the 2 needed for another turn-in'),
    row.turnIns[0]
  )
  return check('the tab now carries the count', (await tabLabel(page)) === 'Cleanup (1)', await tabLabel(page))
}

/**
 * STEP 4 — EVERY NAME ON THE ROW IS THE ITEM CARD'S ANCHOR (the owner's third ask).
 *
 * "for quest reward, we need the tooltip on hover on that." Both names — the item and the reward —
 * are the same component now (`ItemNameLink`), so hovering the LAST link on the row is the reward's
 * own hover and proves the pair. One popper, never two: `tests/tooltipCursor.test.mts` pins that
 * this tab reaches the card only through `SkyItemCard`, and this is the browser agreeing.
 */
async function stepRewardHovers(page: Page): Promise<void> {
  const links = await countOf(page, NAME_LINK)
  if (!check('the row draws two hoverable names: the item and its reward', links === 2, `links=${String(links)}`)) {
    return
  }
  // `locator.hover()` rather than the harness's `hoverAt`, and the difference is measured: this
  // name sits in the LAST column of a table inside a horizontally scrolling pane, so the fraction
  // helper clips it away to nothing and declines. Playwright's own hover scrolls the pane first
  // and then aims, which is the whole job here — the fraction helper earns its keep on charts,
  // where the POINT inside the element is the subject.
  const put = await page
    .locator(REWARD_LINK)
    .first()
    .hover({ timeout: 10_000 })
    .then(
      () => true,
      () => false
    )
  if (!put) {
    note('could not put the pointer on the reward name')
    return
  }
  // WAIT FOR IT TO OPEN, never for it to be stably absent: the card carries an item LOOKUP behind
  // MUI's enter delay, so a stability read settles on 0 long before the popper exists and reports
  // an absence that was only ever a race (measured here, 2026-08-17).
  const poppers = await settleCount(page, POPPER, 1, { timeoutMs: 15_000 })
  check('hovering the REWARD opens its item card', poppers === 1, `poppers=${String(poppers)}`)
  // Off the name and the card leaves with it — a card that outlives its anchor is the click-eating
  // defect this tab's whole card policy exists to prevent.
  await page.mouse.move(5, 5)
  check('…and it leaves when the pointer does', await settleGone(page, POPPER, { timeoutMs: 10_000 }))
}

/**
 * STEP 5 — THE LOG SAYS YOU DESTROYED ONE, AND THE COUNT GOES DOWN. Live, with no button.
 *
 * The refarm left the row at x3, so there is something for both witnesses to lose: one destroy line
 * takes it to x2 — the log witness by the fold (3 looted less 1 destroyed less the turn-in = 1) and
 * the dump witness by the discount reconcile applies for destroys stamped after the file was
 * written (1 + 3 - 1 - 1 = 2, which is what the row reports).
 */
async function stepDestroyLowersIt(page: Page, log: FixtureLog): Promise<boolean> {
  log.append(`You successfully destroyed 1 ${ITEM}.`)
  const after = await settleCountOf(page, 2)
  if (
    !check(
      'A DESTROY LINE LOWERS THE COUNT — the thing the app used to need a button for',
      after.length === 1 && after[0].count === 2,
      after.map((r) => `${r.item} x${String(r.count)}`).join(', ')
    )
  ) {
    return false
  }
  check('…and the tab`s count follows it', (await tabLabel(page)) === 'Cleanup (1)', await tabLabel(page))

  // ONE HELD COUNT, TWO TABS. The Quests tab's Have cell is the same number by construction; a
  // disagreement here would mean the destroy reached one fold and not the other.
  if (!(await reopenTheQuestPanel(page))) return false
  const have = await settle(() => haveText(page, ITEM), (v) => v === '1/1', { timeoutMs: 20_000 })
  return check('THE QUEST THAT NEEDS IT AGREES, with no statement from anybody', have === '1/1', String(have))
}

/**
 * STEP 6 — DESTROY MORE THAN YOU HAVE AND THE ROW ENDS AT ZERO, never below it.
 *
 * Five where two are held. The fold floors per row, so the log witness lands on 0 rather than -3 —
 * which matters because a negative would silently eat the next copy the player farms. The dump
 * witness is discounted and floored the same way, and only when BOTH have let go does the row
 * leave: this last assertion is the one that would still fail if the dump kept vouching for its
 * copy, which is the defect the owner reported.
 */
async function stepFloorEndsTheRow(page: Page, log: FixtureLog): Promise<void> {
  if (!(await openCleanup(page))) return
  log.append(`You successfully destroyed 5 ${ITEM}.`)
  const gone = await settleCountOf(page, null)
  if (
    !check(
      'DESTROYING THE LOT TAKES THE ROW OFF THE TAB — and destroying more than you hold floors at 0',
      gone.length === 0,
      gone.map((r) => `${r.item} x${String(r.count)}`).join(', ')
    )
  ) {
    return
  }
  check('…the empty state is back', (await countOf(page, EMPTY)) === 1)
  check('…and the tab drops its count', (await tabLabel(page)) === 'Cleanup', await tabLabel(page))

  if (!(await reopenTheQuestPanel(page))) return
  const have = await settle(() => haveText(page, ITEM), (v) => v === '0/1', { timeoutMs: 20_000 })
  check('THE QUEST READS 0 FOR THE ITEM TOO, and not a negative one', have === '0/1', String(have))
  check(
    '…and it says so with no provenance chip: this is the LOG talking, not the user',
    (await countOf(page, '[data-testid="posky-item-override"]')) === 0
  )
}

/**
 * The six steps, each gating the next — written as early returns rather than as nested ifs, which
 * is also what keeps this file inside the measured `max-depth`. A step that could not establish its
 * own precondition has already said so through `check`; there is nothing to add here.
 */
async function arc(page: Page, app: ElectronApplication, log: FixtureLog): Promise<void> {
  if (!(await stepNothingSpareYet(page))) return
  if (!(await stepTurnInEatsTheDumpsCopy(page, log))) return
  if (!(await stepRefarmMakesItSpare(page, log))) return
  // The tab at its most interesting: caveat, source control, one row with its place and its
  // decision line (no verdict chip - owner ruling 2026-08-17, the reader makes their own choice). Taken before anything is destroyed, so the artifact shows the
  // screen a player decides from. Opt-in (see `captureTab`) - an ordinary run writes no PNG.
  await captureTab(app, 'sky-cleanup-tab')
  await stepRewardHovers(page)
  if (!(await stepDestroyLowersIt(page, log))) return
  await stepFloorEndsTheRow(page, log)
}

async function main(): Promise<void> {
  buildIfStale()

  // The dump is staged AT LAUNCH: this spec is about a player who already ran the command, and the
  // watcher's appear-then-arm path is `sky-inventory-autoload.e2e.mts`'s subject, not this one.
  const launched = await launchOnFixture('e2e-copy.log', { inventory: DUMP })
  let page: Page | null = null
  try {
    page = await mainWindow(launched.app)
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    await page.waitForSelector(NAV_OVERVIEW, { timeout: 60_000 })
    if (!(await openTheQuest(page))) {
      throw new Error('never reached the expanded Sky quest — nothing below can be asserted')
    }
    await arc(page, launched.app, launched.log)
    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
    await dumpArtifacts(page, failures.length ? 'sky-cleanup-FAIL' : 'sky-cleanup-pass')
  } finally {
    await launched.close()
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
