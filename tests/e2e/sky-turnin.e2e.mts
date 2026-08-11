/**
 * Headless Electron integration test for THE SKY TURN-IN, END TO END (JOS-131) — and, since
 * JOS-147, for THE READY TAB, whose membership rule is that same arc read as a set, and since
 * JOS-155 for that tab's first-time-only toggle, which is the arc read as a set once more.
 *
 * THE ASK, in the owner's words (2026-08-09): a Sky farmer wants to run quests more than once, and
 * today a completed quest stays 5/5 forever, so refarming a second copy is invisible. A turn-in
 * should SUBTRACT the turned-in items from the inventory model rather than pin the quest at
 * complete; a badge shows that you turned it in and how many times; multiple turn-ins work by
 * default.
 *
 * WHY THIS NEEDS A REAL APP. The arithmetic is unit-tested against the real pure code
 * (tests/questTurnIns.test.mts). What no unit test can see is the CHAIN: a trade line in the log
 * travelling chokidar → Tailer → parseEvent → the turnins module → IPC → the renderer's ledger →
 * a write back into electron-store → the progress push → the row on screen. JOS-87 is this repo's
 * standing reminder that a chain like that can break at a seam every unit test is happy with. So
 * every assertion below is driven by APPENDING LINES to the log the app is tailing, and read off
 * the quest row a user would be looking at.
 *
 * EVERY LINE SHAPE IS COPIED FROM THE OWNER'S REAL LOG, never invented (the awaiting-sample law):
 *   `--You have looted an Azarack Skin from Protector of Sky's corpse.--`   (verbatim)
 *   `--You have looted a Wind Rune Heda from an azarack's corpse.--`        (both halves observed)
 *   `You offered 1 <Item> to <NPC>.`                                        (shape verbatim)
 *   `You complete the trade with <NPC>.`                                    (shape verbatim)
 * The quest is Beastlord Test of Azarack because it is the only quest in the committed data whose
 * giver is Animist Kratho and whose whole item list is those two — so the trade below matches one
 * quest and exactly one.
 *
 * THE SECOND TURN-IN IS STAMPED A MINUTE AFTER THE FIRST, deliberately: EQ timestamps are
 * second-resolution and the ledger merges turn-ins by INSTANT, so two handed in inside one second
 * are one event by design (shared/questTurnIns.ts states that limit). It also hands in nothing it
 * looted a second time, which the app is right to trust: the log said the trade completed.
 *
 * TWO LAUNCHES, AND THE SECOND ONE TAILS A FRESH LOG. That is the point of it — the store, not the
 * log, has to remember. Launch 2 gets the SAME userData dir and a NEWLY STAGED fixture with none
 * of launch 1's appended lines, which is the truncated-log / character-epoch case the persistence
 * exists for. A second launch on the same log would have re-derived the count and proved nothing.
 *
 * WHY IT NEVER TAKES THE SCREEN: `EQ_E2E=1` (src/main/e2e.ts) shows no window, skips the
 * single-instance lock, and points `userData` at a throwaway temp dir per launch.
 *
 * Run: `npm run test:e2e -- sky-turnin`.
 */
import type { Page } from 'playwright-core'
import { buildIfStale, check, countOf, dumpArtifacts, failures, reportRun, settle } from './appHarness.mjs'
import { mainWindow, makeUserData, removeUserData } from './appWindow.mjs'
import { launchOnFixture, stageFixture, type FixtureLog } from './logFixture.mjs'

const NAV_SKY = '[data-testid="nav-posky"]'
const NAV_OVERVIEW = '[data-testid="nav-overview"]'
const SEARCH = '[data-testid="posky-search"]'
const HIDE_COMPLETED = '[data-testid="posky-hide-completed"]'
/** The JOS-145 box beside it: the OTHER reading of done, has-ever-turned-in. */
const HIDE_TURNED_IN = '[data-testid="posky-hide-turned-in"]'
const BADGE = '[data-testid="posky-turned-in"]'
const ROW = '.MuiAccordion-root'
const COUNTS = '[data-testid="posky-counts"]'
/** JOS-147's Ready tab and its pane: the list of quests you are holding every item for. */
const TAB_QUESTS = '[data-testid="posky-tab-quests"]'
const TAB_READY = '[data-testid="posky-tab-ready"]'
const READY = '[data-testid="posky-ready"]'
/** JOS-155's toggle on that tab: "only quests I have never turned in", ticked on a fresh install. */
const READY_FIRST_TIME = '[data-testid="posky-ready-first-time"]'

/** The quest under test, and the two lines that put its items in your bags. */
const QUEST = 'Beastlord Test of Azarack'
const GIVER = 'Animist Kratho'
const ITEMS = ['Azarack Skin', 'Wind Rune Heda'] as const
const LOOT = [
  `--You have looted an ${ITEMS[0]} from Protector of Sky's corpse.--`,
  `--You have looted a ${ITEMS[1]} from an azarack's corpse.--`
]
/** One completed trade: an offer per item, then the line that closes the group. */
const TURN_IN = [...ITEMS.map((i) => `You offered 1 ${i} to ${GIVER}.`), `You complete the trade with ${GIVER}.`]

/** How many turn-ins the badge claims. `null` when there is no badge — never confused with 0. */
function badgeCount(page: Page): Promise<number | null> {
  return page.evaluate((sel) => {
    const n = document.querySelector(sel)?.getAttribute('data-count')
    return n === null || n === undefined ? null : Number(n)
  }, BADGE)
}

/** The badge's words, as the user reads them. Empty when it is not there. */
function badgeLabel(page: Page): Promise<string> {
  return page.evaluate((sel) => document.querySelector(sel)?.textContent ?? '', BADGE)
}

/** "have/need" off the quest row's own progress caption. `null` until the row exists. */
function itemsHeld(page: Page): Promise<string | null> {
  return page.evaluate((sel) => {
    const text = document.querySelector(sel)?.textContent ?? ''
    const m = /(\d+)\/(\d+) items/.exec(text)
    return m ? `${m[1]}/${m[2]}` : null
  }, ROW)
}

/** How many quests the filters leave, off the counts line. `null` when it is not mounted. */
function filteredCount(page: Page): Promise<number | null> {
  return page.evaluate((sel) => {
    const m = /(\d+) of (\d+) quests/.exec(document.querySelector(sel)?.textContent ?? '')
    return m ? Number(m[1]) : null
  }, COUNTS)
}

/**
 * Is THIS quest on the Ready tab right now? `null` when the Ready pane is not mounted at all —
 * never confused with "mounted and does not list it", which is the answer half these checks want.
 *
 * The quest's own `name` in the committed data carries its class ("Beastlord Test of Azarack"), so
 * one substring identifies exactly one of the 95 rows.
 */
function readyHasQuest(page: Page): Promise<boolean | null> {
  return page.evaluate(
    ([sel, quest]) => {
      const el = document.querySelector(sel)
      return el ? (el.textContent ?? '').includes(quest) : null
    },
    [READY, QUEST] as const
  )
}

/** The Ready pane's whole text, for the copy assertions. Empty when it is not mounted. */
function readyText(page: Page): Promise<string> {
  return page.evaluate((sel) => document.querySelector(sel)?.textContent ?? '', READY)
}

/**
 * The number ON the Ready tab itself. A bare "Ready" is the tab saying ZERO (the label drops the
 * parenthesis when the list is empty), which is a real reading and not a missing one; `null` is
 * only ever "the tab is not there at all".
 */
function readyTabCount(page: Page): Promise<number | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const m = /Ready \((\d+)\)/.exec(el.textContent ?? '')
    return m ? Number(m[1]) : 0
  }, TAB_READY)
}

/** Is JOS-155's toggle ticked? Reads the checkbox itself, never the class on its wrapper. */
function firstTimeTicked(page: Page): Promise<boolean | null> {
  return page.evaluate((sel) => {
    const input = document.querySelector(sel)?.querySelector('input')
    return input instanceof HTMLInputElement ? input.checked : null
  }, READY_FIRST_TIME)
}

/** Open the Sky tab and narrow the list to the one quest this spec is about. */
async function openQuest(page: Page): Promise<boolean> {
  await page.click(NAV_SKY, { timeout: 30_000 })
  const shown = await page.waitForSelector(SEARCH, { timeout: 60_000 }).then(
    () => true,
    () => false
  )
  if (!shown) return false
  await page.fill(`${SEARCH} input`, QUEST)
  const only = await settle(() => filteredCount(page), (n) => n === 1, { timeoutMs: 15_000 })
  return check(`the search narrows the tab to ${QUEST} alone`, only === 1, `filtered=${String(only)}`)
}

/** A fresh install has never handed this in: no badge, nothing held, and the mobs still to kill. */
async function stepBefore(page: Page): Promise<void> {
  check('a quest never turned in shows NO badge', (await countOf(page, BADGE)) === 0)
  const held = await settle(() => itemsHeld(page), (v) => v !== null, { timeoutMs: 15_000 })
  check('…and reads 0 of the 2 items it needs', held === '0/2', `held=${String(held)}`)
}

/** Loot both items, live, and watch the row fill up. */
async function stepLoot(page: Page, log: FixtureLog, at: Date): Promise<void> {
  log.appendAt(at, ...LOOT)
  const held = await settle(() => itemsHeld(page), (v) => v === '2/2', { timeoutMs: 30_000 })
  if (!check('looting both items live fills the quest to 2/2', held === '2/2', `held=${String(held)}`)) return
  check(
    '…and the row says it is ready to hand in',
    (await page.evaluate((sel) => document.querySelector(sel)?.textContent ?? '', ROW)).includes(
      'Ready to turn in'
    )
  )
}

// ── THE READY TAB (JOS-147), AND ITS FIRST-TIME TOGGLE (JOS-155) ─────────────────────────────
//
// The turn-in arc this spec already drives IS the Ready tab's membership rule, which is why the
// checks live here rather than in a spec of their own: the set is `hasEveryItem` and nothing else,
// so looting the last item must ADD the quest, handing it in must REMOVE it, and refarming must
// bring it back — all read off the real tab, on real app state, with no filter typed anywhere.
// tests/questTurnIns.test.mts pins the predicate; only a running app can prove the tab is wired
// to it, that the wiring survives a live turn-in, and that the two hide-boxes cannot reach it.
//
// JOS-155 hangs off the SAME arc for the same reason. Its toggle asks "have you ever handed this
// in", and this spec is the only place that walks a quest from never-run to run-and-refarmed on a
// real app — so the refarm step now reads the tab from BOTH sides of the box (absent ticked, which
// is how the tab arrives; present unticked) and watches the tab's own count follow. The default
// itself is checked before anything is stored, because "absent key means ON" is a claim about a
// userData dir nobody has written to yet.

/** Before any loot: the tab is mounted, this quest is not on it, and it says something either way. */
async function stepReadyBefore(page: Page): Promise<void> {
  await page.click(TAB_READY, { timeout: 15_000 })
  const has = await settle(() => readyHasQuest(page), (v) => v !== null, { timeoutMs: 20_000 })
  check('a quest holding none of its items is NOT on the Ready tab', has === false, `has=${String(has)}`)
  // JOS-155's default, read off a userData dir that has never held the key: an ABSENT stored value
  // means ON here, which is the one inverted flag on this tab, so a fresh install must show it
  // ticked without anybody having ticked it.
  check(
    'the first-time-only box is TICKED on a fresh install, with nothing stored',
    (await firstTimeTicked(page)) === true
  )
  // The empty state is COPY, so it is asserted where it can actually appear — and the fixture's own
  // loot decides which of the two states that is, so both are stated rather than guessed at.
  const text = await readyText(page)
  const counted = /\d+ quests? you are holding every item for/.test(text)
  check(
    counted ? 'a non-empty Ready tab counts what is on it' : 'an empty Ready tab says what would put a quest on it',
    counted || text.includes('Nothing is ready to turn in'),
    text.slice(0, 200)
  )
  await page.click(TAB_QUESTS, { timeout: 15_000 })
}

/**
 * Holding everything: the quest joins the tab, and NEITHER hide-box can take it off.
 *
 * "Hide completed" hides exactly `hasEveryItem` — the same predicate the Ready tab is made of — so
 * this is the one that matters: ticked, the Quests tab drops the row to zero and the Ready tab must
 * still be holding it. A tab that honoured that box could only ever be empty.
 *
 * Nothing has been handed in yet at this point in the arc, so JOS-155's toggle has no opinion about
 * this quest and the row is there whatever the box says. That is deliberate ordering: the toggle is
 * exercised where it can actually disagree, after the turn-in and the refarm.
 */
async function stepReadyHolding(page: Page): Promise<void> {
  await page.click(TAB_READY, { timeout: 15_000 })
  const on = await settle(() => readyHasQuest(page), (v) => v === true, { timeoutMs: 20_000 })
  if (!check('COLLECTING THE LAST ITEM PUTS THE QUEST ON THE READY TAB', on === true, `has=${String(on)}`)) return

  await page.click(TAB_QUESTS, { timeout: 15_000 })
  await page.click(HIDE_COMPLETED, { timeout: 15_000 })
  const gone = await settle(() => filteredCount(page), (n) => n === 0, { timeoutMs: 8_000 })
  check('"hide completed" empties the QUESTS tab of it, as it always has', gone === 0, `filtered=${String(gone)}`)
  await page.click(TAB_READY, { timeout: 15_000 })
  const kept = await settle(() => readyHasQuest(page), (v) => v !== null, { timeoutMs: 8_000 })
  check('…AND THE READY TAB KEEPS IT: the hide-boxes do not reach this tab', kept === true, `has=${String(kept)}`)

  await page.click(TAB_QUESTS, { timeout: 15_000 })
  await page.click(HIDE_COMPLETED, { timeout: 15_000 })
  await settle(() => filteredCount(page), (n) => n === 1, { timeoutMs: 8_000 })
}

/**
 * Handed over: the items are spent, so the quest leaves the tab. Nothing else had to happen.
 *
 * Both readings agree here — it is out of the membership rule AND out of the first-time reading —
 * so this step proves the subtraction rather than the toggle. The step that separates them is the
 * refarm below, where the items come back and the turn-in does not go away.
 */
async function stepReadyAfterTurnIn(page: Page): Promise<void> {
  await page.click(TAB_READY, { timeout: 15_000 })
  const off = await settle(() => readyHasQuest(page), (v) => v === false, { timeoutMs: 20_000 })
  check('A TURN-IN TAKES THE QUEST OFF THE READY TAB — the items it needed are gone', off === false, `has=${String(off)}`)
  await page.click(TAB_QUESTS, { timeout: 15_000 })
}

/**
 * …and refarming the same two drops puts it back — BUT NOT UNDER THE DEFAULT (JOS-155).
 *
 * This is the one row in the whole arc where the tab's toggle and its membership rule disagree, and
 * it is exactly the case the owner asked for: the quest is holding every item again (so
 * `readyQuests` has it) and it has been handed in once (so the first-time reading does not). Ticked
 * — which is how the tab arrives — it is absent; unticked, it is there. Both directions are driven,
 * because a filter that only ever hides is indistinguishable from a broken list.
 *
 * The TAB'S COUNT is read on both sides of the toggle too. It is `list.ready.length`, the same
 * array the pane draws, so the number and the rows cannot disagree — but that is a claim about the
 * code, and this is the test that says it is true on screen.
 *
 * The box is left TICKED, the way it was found: it is a stored preference and launch 2 shares the
 * store, so leaving it off would hand the restart assertion a tab it did not set up.
 */
async function stepReadyRefarm(page: Page, log: FixtureLog, at: Date): Promise<void> {
  log.appendAt(at, ...LOOT)
  // The Quests tab is what is mounted here, and its row is the evidence the refarm actually
  // landed — wait for THAT, so an absence on the Ready tab below can only mean the toggle.
  const held = await settle(() => itemsHeld(page), (v) => v === '2/2', { timeoutMs: 30_000 })
  if (!check('refarming both items fills the quest to 2/2 again', held === '2/2', `held=${String(held)}`)) return

  await page.click(TAB_READY, { timeout: 15_000 })
  const hidden = await settle(() => readyHasQuest(page), (v) => v === false, { timeoutMs: 20_000 })
  check(
    'A REFARMED QUEST IS ABSENT UNDER THE DEFAULT — first-time turn-ins is what the tab shows',
    hidden === false,
    `has=${String(hidden)}`
  )
  const hiddenCount = await readyTabCount(page)

  await page.click(READY_FIRST_TIME, { timeout: 15_000 })
  const back = await settle(() => readyHasQuest(page), (v) => v === true, { timeoutMs: 20_000 })
  check(
    '…AND PRESENT THE MOMENT THE BOX IS UNTICKED — membership is the predicate, not a one-way flag',
    back === true,
    `has=${String(back)}`
  )
  const shownCount = await settle(
    () => readyTabCount(page),
    (n) => n !== null && hiddenCount !== null && n > hiddenCount,
    { timeoutMs: 8_000 }
  )
  check(
    'THE TAB COUNT FOLLOWS THE TOGGLE: the refarm is in the number as well as in the list',
    shownCount !== null && hiddenCount !== null && shownCount === hiddenCount + 1,
    `ticked=${String(hiddenCount)} unticked=${String(shownCount)}`
  )

  await page.click(READY_FIRST_TIME, { timeout: 15_000 })
  const again = await settle(() => readyHasQuest(page), (v) => v === false, { timeoutMs: 8_000 })
  check('…and re-ticking hides it again, so the box is a toggle and not a one-shot', again === false)
  check('…leaving the stored preference as this spec found it', (await firstTimeTicked(page)) === true)
  await page.click(TAB_QUESTS, { timeout: 15_000 })
}

/**
 * THE HEADLINE: hand it in, and the items are SPENT. The badge appears, the bar goes back to 0/2,
 * and the quest is farmable again — which before JOS-131 was a row pinned at 2/2 forever.
 */
async function stepTurnIn(page: Page, log: FixtureLog, at: Date): Promise<void> {
  log.appendAt(at, ...TURN_IN)
  const count = await settle(() => badgeCount(page), (n) => n === 1, { timeoutMs: 30_000 })
  if (!check('a turn-in in the log puts a badge on the quest', count === 1, `count=${String(count)}`)) return
  check('…reading "Turned in"', (await badgeLabel(page)) === 'Turned in')
  const held = await settle(() => itemsHeld(page), (v) => v === '0/2', { timeoutMs: 15_000 })
  check(
    'THE TURN-IN SUBTRACTS WHAT IT CONSUMED — the quest is back at 0/2 and can be farmed again',
    held === '0/2',
    `held=${String(held)}`
  )
}

/**
 * THE TWO BOXES, ON THE ONE QUEST THEY MUST DISAGREE ABOUT (JOS-131's meaning, JOS-145's second
 * reading — both argued in features/posky/questCompletion.ts).
 *
 * Read AFTER the turn-in, so the row on screen is exactly the case: a quest handed in once, whose
 * items that turn-in spent, which the player can farm again. "Hide completed" (has every item now)
 * must KEEP it, because every item it needs is gone from your bags and that is work left. "Hide
 * turned in" (has ever turned in) must REMOVE it, because you have run it, which is the question
 * that box asks. The unit suite pins the predicates; this pins that the two checkboxes on screen
 * are wired to the ones they claim, on real app state rather than a hand-built quest.
 *
 * Both are left as they were found: they are stored preferences and launch 2 shares the store.
 */
async function stepHideBoxes(page: Page): Promise<void> {
  await page.click(HIDE_COMPLETED, { timeout: 15_000 })
  const still = await settle(() => filteredCount(page), (n) => n !== null, { timeoutMs: 8_000 })
  check(
    'HIDE COMPLETED KEEPS A TURNED-IN QUEST YOU ARE REFARMING — it is work left, not work done',
    still === 1,
    `filtered=${String(still)}`
  )
  check('…and its badge is still there beside it', (await badgeCount(page)) === 1)
  await page.click(HIDE_COMPLETED, { timeout: 15_000 })
  await settle(() => filteredCount(page), (n) => n === 1, { timeoutMs: 8_000 })

  await page.click(HIDE_TURNED_IN, { timeout: 15_000 })
  const gone = await settle(() => filteredCount(page), (n) => n === 0, { timeoutMs: 8_000 })
  check(
    'HIDE TURNED IN TAKES THE SAME QUEST OFF THE LIST — the other reading, on its own box',
    gone === 0,
    `filtered=${String(gone)}`
  )
  check('…so its row is gone from the list too, not merely uncounted', (await countOf(page, ROW)) === 0)
  await page.click(HIDE_TURNED_IN, { timeout: 15_000 })
  const back = await settle(() => filteredCount(page), (n) => n === 1, { timeoutMs: 8_000 })
  check('…and un-ticking brings it straight back', back === 1, `filtered=${String(back)}`)
}

/** Multiple turn-ins are the default: hand it in again, and the badge counts. */
async function stepAgain(page: Page, log: FixtureLog, at: Date): Promise<void> {
  log.appendAt(at, ...TURN_IN)
  const count = await settle(() => badgeCount(page), (n) => n === 2, { timeoutMs: 30_000 })
  if (!check('A SECOND TURN-IN COUNTS ITSELF', count === 2, `count=${String(count)}`)) return
  check('…and the badge says so in words', (await badgeLabel(page)) === 'Turned in x2', await badgeLabel(page))
}

/** THE STORE, not the log: a fresh log with none of those lines, and the count is still 2. */
async function stepRemembered(page: Page): Promise<void> {
  if (!(await openQuest(page))) return
  const count = await settle(() => badgeCount(page), (n) => n !== null, { timeoutMs: 30_000 })
  check(
    'THE TURN-INS SURVIVE A RESTART ON A LOG THAT NO LONGER SHOWS THEM',
    count === 2,
    `count=${String(count)}`
  )
}

async function main(): Promise<void> {
  buildIfStale()

  // Owned by this spec: the restart assertion IS the dir outliving a process.
  const userData = makeUserData()
  const log = stageFixture('e2e-copy.log')
  const now = Date.now()
  try {
    console.log('launch 1: loot the items, hand them in twice, and watch the row…')
    const first = await launchOnFixture(log, { userData })
    let page: Page | null = null
    try {
      page = await mainWindow(first.app)
      await page.waitForSelector(NAV_OVERVIEW, { timeout: 60_000 })
      if (!(await openQuest(page))) {
        throw new Error('never reached the quest row — nothing below can be asserted')
      }
      await stepBefore(page)
      await stepReadyBefore(page)
      await stepLoot(page, log, new Date(now - 120_000))
      await stepReadyHolding(page)
      await stepTurnIn(page, log, new Date(now - 60_000))
      await stepReadyAfterTurnIn(page)
      await stepHideBoxes(page)
      await stepReadyRefarm(page, log, new Date(now - 30_000))
      await stepAgain(page, log, new Date(now))
      if (failures.length) await dumpArtifacts(page, 'sky-turnin-FAIL')
    } finally {
      await first.close()
    }

    console.log('launch 2: the SAME store, a FRESH log — the count must come from the store…')
    const second = await launchOnFixture('e2e-copy.log', { userData })
    let restarted: Page | null = null
    try {
      restarted = await mainWindow(second.app)
      await restarted.waitForSelector(NAV_OVERVIEW, { timeout: 60_000 })
      await stepRemembered(restarted)
      if (failures.length) await dumpArtifacts(restarted, 'sky-turnin-restart-FAIL')
    } finally {
      await second.close()
    }
  } finally {
    await log.dispose()
    await removeUserData(userData)
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
