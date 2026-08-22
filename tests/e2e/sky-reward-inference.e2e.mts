/**
 * Headless Electron integration test for THE REWARD IN YOUR INVENTORY EXPORT (GitHub issue #27,
 * community PR #33 by johnsideserf, landed as JOS-428).
 *
 * THE REPORT, six times in one wave on 2026-08-20 and once from a fresh install with no log history
 * at all: a Sky quest whose reward plainly sits in the loaded inventory export still reads "not
 * turned in". Nothing was broken — completion was exclusively TURN-IN evidence (shared/questTurnIns
 * .ts), and a turn-in done before logging was on, or before a log rotation, leaves none. So a
 * player who finished the Plane years ago opened a tab that said they had finished nothing.
 *
 * THE ANSWER, argued in full in renderer/features/posky/rewardInference.ts: every Sky reward is
 * UNIQUE to its quest and 92 of the 94 in the item DB are NO DROP, and an item that cannot move has
 * exactly one way into a bag. So holding one is a turn-in the log never saw — a DERIVED floor of
 * one, labelled as derived, never persisted, and out-voted by any ledger evidence.
 *
 * WHY THIS NEEDS A REAL APP. The arithmetic is pure and pinned without a browser
 * (tests/rewardInference.test.mts drives every case of the gate and the floor). What no unit test
 * can see is the CHAIN, and it is long: an inventory file in the EQ install root → the outputs
 * registry finds and stats it → `parseInventoryDump` → `heldCountsFromDump` → main's store → the
 * `progress:changed` push → `useProgress` → the inference → the badge and the disabled undo on the
 * row a user is actually looking at. JOS-87 is this repo's standing reminder that a chain like that
 * breaks at a seam every unit test is happy with.
 *
 * THE FIXTURE PAIR IS WHAT MAKES THE CLAIM CLEAN, and both halves are already committed:
 *   * `e2e-copy.log` carries ZERO loot lines and ZERO completed trades, so the turn-in ledger is
 *     empty on this launch. Every count below therefore has exactly one possible source.
 *   * `Primitive_freeport-Inventory.txt` is the owner's own real `/outputfile inventory`, and it
 *     vouches for exactly ONE of the 95 quests: Paladin Test of Love, whose reward Thelvorn, Blade
 *     of Light is in the Primary slot. MEASURED over the committed pair, 2026-08-20 — one quest, so
 *     "1 of 95" is itself an assertion about the gate rather than a number to trust.
 *
 * AND THE ROW IT PICKS IS THE `+N` CASE, by luck and worth keeping: the export spells it
 * `Thelvorn, Blade of Light +5`, because the owner exalted it. The match is on the COUNTING key, so
 * an exalted reward is still the quest's reward — a rule this spec now holds end to end rather than
 * only in the fold that implements it.
 *
 * WHY IT NEVER TAKES THE SCREEN: `EQ_E2E=1` (src/main/e2e.ts) shows no window, skips the
 * single-instance lock, and points `userData` at a throwaway temp dir per launch.
 *
 * Run: `npm run test:e2e -- sky-reward-inference`.
 */
import type { Page } from 'playwright-core'
import { buildIfStale, check, countOf, dumpArtifacts, failures, reportRun, settle } from './appHarness.mjs'
import { mainWindow } from './appWindow.mjs'
import { launchOnFixture } from './logFixture.mjs'

const NAV_SKY = '[data-testid="nav-posky"]'
const NAV_OVERVIEW = '[data-testid="nav-overview"]'
const SEARCH = '[data-testid="posky-search"]'
const COUNTS = '[data-testid="posky-counts"]'
const ROW = '[data-testid="posky-quest-row"]'
const SUMMARY = `${ROW} .MuiAccordionSummary-root`
const BADGE = '[data-testid="posky-turned-in"]'
const UNDO = '[data-testid="posky-undo-turnin"]'
const TURNIN_COUNT = '[data-testid="posky-turnin-count"]'
/** JOS-145's box: the has-EVER-turned-in reading of done, which an inferred count has to satisfy. */
const HIDE_TURNED_IN = '[data-testid="posky-hide-turned-in"]'

/** The committed export, and the one quest in the committed data it vouches for. */
const DUMP = 'Primitive_freeport-Inventory.txt'
const VOUCHED = 'Paladin Test of Love'
/** A quest the same export says nothing about — the control, and the suite's usual subject. */
const UNVOUCHED = 'Beastlord Test of Azarack'

/** How many quests the filters leave, off the counts line. `null` when it is not mounted. */
function filteredCount(page: Page): Promise<number | null> {
  return page.evaluate((sel) => {
    const m = /(\d+) of (\d+) quests/.exec(document.querySelector(sel)?.textContent ?? '')
    return m ? Number(m[1]) : null
  }, COUNTS)
}

/** The badge as the DOM states it: the count it claims and whether it says where that came from. */
function badge(page: Page): Promise<{ count: number | null; inferred: string | null; title: string }> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return { count: null, inferred: null, title: '' }
    const n = el.getAttribute('data-count')
    return {
      count: n === null ? null : Number(n),
      inferred: el.getAttribute('data-inferred'),
      title: el.getAttribute('title') ?? ''
    }
  }, BADGE)
}

/** The undo control's state and the one thing it has to say for itself when it cannot act. */
function undo(page: Page): Promise<{ disabled: boolean | null; title: string }> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return { disabled: null, title: '' }
    // The title lives on the SPAN the tooltip needed, because a disabled button swallows no events.
    return {
      disabled: (el as HTMLButtonElement).disabled,
      title: el.closest('span')?.getAttribute('title') ?? ''
    }
  }, UNDO)
}

/** Narrow the list to one quest by name, and expand it so its detail toolbar exists. */
async function openQuest(page: Page, name: string): Promise<boolean> {
  await page.fill(`${SEARCH} input`, name)
  const only = await settle(() => filteredCount(page), (n) => n === 1, { timeoutMs: 30_000 })
  if (!check(`the search narrows to ${name} alone`, only === 1, `filtered=${String(only)}`)) return false
  await page.click(SUMMARY, { timeout: 15_000 })
  const drawn = await settle(() => countOf(page, TURNIN_COUNT), (n) => n === 1, { timeoutMs: 20_000 })
  return check(`…and expanding ${name} draws its turn-in controls`, drawn === 1, String(drawn))
}

/** Land, and open the Sky tab on its filter bar. */
async function openSky(page: Page): Promise<boolean> {
  await page.click(NAV_SKY, { timeout: 30_000 })
  const bar = await page.waitForSelector(SEARCH, { timeout: 60_000 }).then(
    () => true,
    () => false
  )
  if (!check('the Sky tab opens on its filter bar', bar)) return false
  return check('…with the counts line under it', (await filteredCount(page)) !== null)
}

/**
 * THE GATE, FIRST — because the whole claim is that this is a NARROW reading and not a blanket one.
 * The export is a real bag with 330 distinct items in it; if the tab lit up half the Plane, every
 * assertion below would still pass and the feature would still be wrong.
 *
 * COUNTED OFF THE COUNTS LINE, NOT OFF THE BADGES ON SCREEN. The list PAGES (JOS-191), so rendered
 * badges answer "how many are on the first page" — a number that would go on passing if the fold
 * lit up sixty quests further down. The tab's own filter is the reading that covers all 95: "hide
 * quests I have turned in" is `everTurnedIn` over the whole visible set, and the difference it
 * makes IS the number of quests this launch reads as turned in. The ledger is empty, so that
 * difference is the inference and nothing else.
 */
async function stepOnlyOneQuestIsVouchedFor(page: Page): Promise<number | null> {
  const all = await settle(() => filteredCount(page), (n) => n !== null && n > 1, { timeoutMs: 45_000 })
  if (!check('the tab opens on the whole Plane', all !== null && all > 1, `quests=${String(all)}`)) return null
  await page.click(HIDE_TURNED_IN, { timeout: 15_000 })
  const kept = await settle(() => filteredCount(page), (n) => n !== null && n < (all ?? 0), { timeoutMs: 20_000 })
  check(
    'THE LOADED EXPORT VOUCHES FOR EXACTLY ONE QUEST, not for everything it can name',
    all !== null && kept === all - 1,
    `of ${String(all)} quests, ${String((all ?? 0) - (kept ?? 0))} read as turned in`
  )
  // …and it is THIS one. The count above says how many; the search says which.
  await page.fill(`${SEARCH} input`, VOUCHED)
  const hidden = await settle(() => filteredCount(page), (n) => n === 0, { timeoutMs: 20_000 })
  check(
    `…and the one it hides is ${VOUCHED} — a filter that never heard of the inference reads the floored count`,
    hidden === 0,
    `filtered=${String(hidden)}`
  )
  await page.fill(`${SEARCH} input`, '')
  await page.click(HIDE_TURNED_IN, { timeout: 15_000 })
  const back = await settle(() => filteredCount(page), (n) => n === all, { timeoutMs: 20_000 })
  check('…and unticking the box leaves the tab exactly as it was found', back === all, String(back))
  return all
}

/**
 * THE REPORT'S OWN SENTENCE, on the row: the reward is in the bag, so the quest reads turned in.
 *
 * The ledger is EMPTY on this launch (the fixture completes no trade and this launch records
 * nothing by hand), so a badge here can have come from one place only.
 */
async function stepTheRewardReadsAsATurnIn(page: Page): Promise<void> {
  if (!(await openQuest(page, VOUCHED))) return
  const b = await badge(page)
  check(`${VOUCHED} reads TURNED IN off the export alone`, b.count === 1, `count=${String(b.count)}`)
  check(
    '…and the badge SAYS the reading is derived rather than read out of the log',
    b.inferred === 'true',
    `data-inferred=${String(b.inferred)}`
  )
  check(
    '…in words, on hover, naming the export as the evidence',
    b.title.includes('inventory export'),
    b.title
  )
  const u = await undo(page)
  check(
    'THE UNDO IS HONESTLY DEAD: the reward is still in the bag, so a take-back would not survive',
    u.disabled === true,
    `disabled=${String(u.disabled)}`
  )
  check('…and says exactly that instead of looking broken', u.title.includes('inventory export'), u.title)
}

/**
 * ONE-DIRECTIONAL, on the surface. A reward the export does not carry proves NOTHING — the file
 * only covers what was open when it was written — so the control row is untouched, not un-completed.
 */
async function stepAQuestItSaysNothingAboutIsUntouched(page: Page): Promise<void> {
  if (!(await openQuest(page, UNVOUCHED))) return
  const b = await badge(page)
  check(`${UNVOUCHED} has no badge at all — absence proves nothing either way`, b.count === null, String(b.count))
  const u = await undo(page)
  check('…and its undo is dead for the OLD reason, with the old words', u.title === 'Nothing to take back', u.title)
}

async function main(): Promise<void> {
  buildIfStale()

  const launched = await launchOnFixture('e2e-copy.log', { inventory: DUMP })
  let page: Page | null = null
  try {
    page = await mainWindow(launched.app)
    await page.waitForSelector(NAV_OVERVIEW, { timeout: 60_000 })
    if (!(await openSky(page))) {
      throw new Error('never reached the Sky tab — nothing below can be asserted')
    }
    await stepOnlyOneQuestIsVouchedFor(page)
    await stepTheRewardReadsAsATurnIn(page)
    await stepAQuestItSaysNothingAboutIsUntouched(page)
    if (failures.length) await dumpArtifacts(page, 'sky-reward-inference-FAIL')
  } finally {
    await launched.close()
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
