/**
 * Headless Electron integration test for the PLAN tab
 * (docs/plans/gear-progression-planner.md, wave 3).
 *
 * WHY A SPEC AT ALL, given `tests/progressionPlan.test.mts` owns every rule the fold obeys and
 * `tests/zoneLevelProfile.test.mts` / `tests/conBands.test.mts` own the two tables it reads. What
 * needs a real app is the CHAIN, and it is a long one that no unit test can see:
 *
 *   a line appended to the log the app is tailing → chokidar → Tailer → the parser's `LEVEL_RE` →
 *   the character + progression modules → `useStatedLevel` → the fold's `PlanInputs.level` →
 *   a card on screen → a click → `useWishlist.add` → an IPC write → main's validator →
 *   electron-store → a SIBLING TAB that unmounted this view and re-read the document.
 *
 * Six of those eight links are invisible under the node runner, and the two ends of the chain are
 * exactly what the feature is: the log says what level you are, and the plan turns that into a
 * shopping list you can keep.
 *
 * WHAT IT ASSERTS, in order and each for its own reason:
 *   1. The gear area offers a Plan tab and clicking it mounts the view. `GEAR_AREA_VIEWS` derives
 *      the tab bar AND the nav row, so this is also the assertion that adding a fifth face did not
 *      cost the other four theirs (the shared bar is why `gear.e2e` is run beside this one).
 *   2. WITH NO LEVEL STATED, THE TAB SAYS SO. This is the claim the feature would most easily fail
 *      quietly: the fold opens its first bracket AT the character's level, so a default of 1 would
 *      render a confident six-bracket route about a character the log has never described. The
 *      staged fixture states no level at all, which makes this the DEFAULT state rather than one
 *      the spec had to contrive.
 *   3. A DING FILLS IT IN, LIVE. `appendAt` writes the exact line the parser matches
 *      (`src/main/log/parseWorld.ts LEVEL_RE`) into the very log the app is tailing, and the first
 *      bracket must then open at the level that line stated — not near it, AT it.
 *   4. THE ONE DOOR OUT WORKS. A bracket's button writes its targets to the wish list, and they are
 *      read back on the Wish list TAB, which unmounted this view to draw itself.
 *   5. …AND THE PLAN DOES NOT KEEP A SECOND COPY (plan §8). The fold dedupes against the wish list,
 *      so the rows that just left are gone from the card when the tab comes back. That is the
 *      surprising half of the design and therefore the half worth pinning.
 *
 * NOTHING HERE IS A FROZEN NUMBER except the level this spec itself states (AGENTS.md, "frozen
 * numbers rot"). Which items a bracket holds is the corpus's business and it is rescraped; the
 * assertions are counts of at-least-one, identities, and the one number the spec wrote into the log.
 *
 * Run: `npm run test:e2e -- plan`.
 */
import type { Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  failures,
  note,
  pageOverflow,
  reportRun,
  settle
} from './appHarness.mjs'
import { mainWindow, makeUserData, removeUserData } from './appWindow.mjs'
import { launchOnFixture, stageFixture, type FixtureLog } from './logFixture.mjs'

const NAV = '[data-testid="nav-gear"]'
const TAB = '[data-testid="tab-plan"]'
const GEAR_TAB = '[data-testid="tab-gear"]'
const WISH_TAB = '[data-testid="tab-wishlist"]'
const VIEW = '[data-testid="plan-view"]'
const WISH_VIEW = '[data-testid="wishlist-view"]'
const EMPTY = '[data-testid="plan-empty"]'
const BRACKET = '[data-testid="plan-bracket"]'
const ROLE = '[data-testid="plan-role"]'
const REACH = '[data-testid="plan-reach"]'

/**
 * THE LEVEL THIS SPEC STATES, and the line that states it — EQ's own spelling, anchored at both
 * ends by `LEVEL_RE`. Twelve because it is past the level-2 line the epoch detector treats as a
 * character rebirth (src/main/log/epochDetector.ts) and low enough that the classic zones the
 * committed catalog profiles best are the ones in reach.
 */
const DING_LEVEL = 12
const DING_LINE = `You have gained a level! Welcome to level ${String(DING_LEVEL)}!`

const until = (fn: () => Promise<boolean>, ms: number): Promise<boolean> => settle(fn, (ok) => ok, { timeoutMs: ms })

const textOf = (page: Page, sel: string): Promise<string> =>
  page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '', sel)

/** 1. THE FIFTH TAB. The nav row opens the area; the tab is what this spec is about. */
async function stepMount(page: Page): Promise<boolean> {
  const hasRow = await page.waitForSelector(NAV, { timeout: 60_000 }).then(
    () => true,
    () => false
  )
  if (!check('the nav drawer has a Gear row', hasRow)) return false
  await page.click(NAV, { timeout: 15_000 })

  const hasTab = await until(async () => (await countOf(page, TAB)) > 0, 30_000)
  if (!check('the gear area offers a Plan tab beside the four it already had', hasTab)) {
    const noLogs = (await textOf(page, 'main')).includes('No EverQuest logs found')
    if (noLogs) note('no character logs on this machine — the app shows its fresh-machine empty state')
    return false
  }
  // …and the four it already had are still there, because one list (`GEAR_AREA_VIEWS`) draws them.
  for (const tab of [GEAR_TAB, WISH_TAB, '[data-testid="tab-planner"]', '[data-testid="tab-character"]']) {
    check(`…without costing ${tab} its seat in the bar`, (await countOf(page, tab)) === 1)
  }

  await page.click(TAB, { timeout: 15_000 })
  const mounted = await until(async () => (await countOf(page, VIEW)) > 0, 30_000)
  check('clicking the Plan tab mounts the view', mounted)
  return mounted
}

/**
 * 2. NO STATED LEVEL, NO ROUTE — and the tab says which of those it is.
 *
 * The wording is asserted on its SUBJECT rather than verbatim: what must be on screen is that
 * nothing has stated a level and what would state one, because a page that merely said "no plan"
 * would leave the reader with no move to make. The level chip must be ABSENT, which is the other
 * half of the same claim — a chip reading "Level 1" here would be the guess this refuses.
 */
async function stepUnstated(page: Page): Promise<void> {
  const empty = await until(async () => (await countOf(page, EMPTY)) === 1, 30_000)
  if (!check('with no level stated, the tab draws an empty state rather than a route', empty)) return
  const text = (await textOf(page, EMPTY)).replace(/\s+/g, ' ').trim()
  check(
    '…and it says the level is UNSTATED, not that there is nothing to plan',
    text.includes('stated your level') && text.includes('/who'),
    text.slice(0, 160)
  )
  check('…with no bracket drawn at a level nobody stated', (await countOf(page, BRACKET)) === 0)
  check('…and no level chip, because there is no level to put in one', (await countOf(page, '[data-testid="plan-level"]')) === 0)
  // Both picks are on screen while the route is not: the controls are the tab, not the route's
  // decoration, so a player can set them up before the log has said anything.
  check('the role and reach pickers are drawn even with no route to apply them to', (await countOf(page, ROLE)) === 1 && (await countOf(page, REACH)) === 1)
}

/**
 * 3. THE DING, WRITTEN INTO THE LOG THE APP IS TAILING.
 *
 * The bracket is asserted on `data-from`, which is the fold's own `PlanBracket.from`: the first
 * bracket opens AT the current level, so this is the one place the whole chain's arithmetic is
 * visible as a single number that came out of a line this file wrote.
 */
async function stepDing(page: Page, log: FixtureLog): Promise<boolean> {
  log.appendAt(new Date(), DING_LINE)
  const stated = await until(async () => (await countOf(page, '[data-testid="plan-level"]')) === 1, 60_000)
  check(`a level-up line stated live gives the tab a level to plan from`, stated, await textOf(page, EMPTY))
  if (stated) {
    const chip = (await textOf(page, '[data-testid="plan-level"]')).replace(/\s+/g, ' ').trim()
    check('…and the chip states the level the log stated', chip.includes(String(DING_LEVEL)), chip)
  }

  const opened = await until(async () => (await countOf(page, `${BRACKET}[data-from="${String(DING_LEVEL)}"]`)) > 0, 60_000)
  check(
    `the route's first bracket opens AT the stated level, not near it`,
    opened,
    `${String(await countOf(page, BRACKET))} brackets, first from ${await page.evaluate((s) => document.querySelector(s)?.getAttribute('data-from') ?? '(none)', BRACKET)}`
  )
  if (opened) note(`${String(await countOf(page, BRACKET))} brackets drawn from level ${String(DING_LEVEL)}`)
  return opened
}

/** The first bracket that actually has something to add, and what it is offering. */
function firstAddable(page: Page): Promise<{ from: string; keys: string[] } | null> {
  return page.evaluate(() => {
    for (const card of document.querySelectorAll('[data-testid="plan-bracket"]')) {
      if (card.querySelector('[data-testid="plan-add-bracket"]') === null) continue
      const keys = [...card.querySelectorAll('[data-testid="plan-target"]')]
        .map((t) => t.getAttribute('data-item-key') ?? '')
        .filter((k) => k !== '')
      if (keys.length > 0) return { from: card.getAttribute('data-from') ?? '', keys }
    }
    return null
  })
}

/** How many of `keys` the Wish list tab is drawing right now. */
function wishedCount(page: Page, keys: readonly string[]): Promise<number> {
  return page.evaluate(
    (ks) => ks.filter((k) => document.querySelector(`[data-testid="wishlist-row"][data-item="${k}"]`) !== null).length,
    [...keys]
  )
}

/**
 * 4 + 5. THE DOOR OUT, AND THE PROMISE THAT THERE IS ONLY ONE DOCUMENT.
 *
 * The targets are read off the CARD before the click, so what is checked on the other tab is the
 * set this button actually carried rather than whatever happens to be on the wish list. At least
 * one is the claim, not all of them: a target already fulfilled by the staged character goes to
 * that tab's done strip, which is correct behaviour and not a route row.
 */
async function stepAddBracket(page: Page): Promise<void> {
  const addable = await firstAddable(page)
  if (!check('a bracket has targets and a button to send them to the wish list', addable !== null) || addable === null) {
    return
  }
  note(`adding ${String(addable.keys.length)} targets from bracket ${addable.from}`)
  await page.click(`${BRACKET}[data-from="${addable.from}"] [data-testid="plan-add-bracket"]`, { timeout: 15_000 })

  await page.click(WISH_TAB, { timeout: 15_000 })
  if (!check('the Wish list tab mounts', await until(async () => (await countOf(page, WISH_VIEW)) > 0, 30_000))) return
  const landed = await settle(() => wishedCount(page, addable.keys), (n) => n > 0, { timeoutMs: 20_000 })
  check(
    "a bracket's targets arrive on the wish list, written across two views and one store",
    landed > 0,
    `${String(landed)} of ${String(addable.keys.length)} on the list`
  )

  // 5. AND THE PLAN LET GO OF THEM. The fold dedupes against the wish list document, so a target
  //    that is now wanted is no longer a thing the route has to tell you about — the plan SEEDS
  //    that document (plan §8) and refuses to be a second copy of it.
  await page.click(TAB, { timeout: 15_000 })
  if (!check('the Plan tab comes back', await until(async () => (await countOf(page, VIEW)) > 0, 30_000))) return
  const stillHere = await settle(
    () => page.evaluate((ks) => ks.filter((k) => document.querySelector(`[data-testid="plan-target"][data-item-key="${k}"]`) !== null).length, [...addable.keys]),
    (n) => n < addable.keys.length,
    { timeoutMs: 20_000 }
  )
  check(
    'the targets that went on the wish list leave the plan - it seeds that document, it does not duplicate it',
    stillHere < addable.keys.length,
    `${String(stillHere)} of ${String(addable.keys.length)} still drawn as targets`
  )
}

/** Watch a page for the console errors this spec fails on. */
function watch(page: Page, into: string[]): void {
  page.on('console', (m) => {
    if (m.type() === 'error') into.push(m.text())
  })
  page.on('pageerror', (e) => into.push(String(e)))
}

async function main(): Promise<void> {
  buildIfStale()
  const consoleErrors: string[] = []
  const userData = makeUserData()
  // NO `/outputfile` DUMP AND NO SECOND CHARACTER: this spec's subject is a character the log has
  // barely described, which is the state claim 2 is about. The fixture states no level of its own
  // (7 lines, cut by `tests/extract-e2e-fixtures.mjs`), so the ding this file writes is the only
  // level statement in the whole run and there is nothing for it to race.
  const log = stageFixture('e2e-planner.log')

  console.log('launch: hidden Electron (EQ_E2E=1) against tests/fixtures/e2e-planner.log…')
  const app = await launchOnFixture(log, { userData })
  try {
    const page = await mainWindow(app.app)
    watch(page, consoleErrors)
    if (await stepMount(page)) {
      await stepUnstated(page)
      if (await stepDing(page, log)) await stepAddBracket(page)
      const over = await pageOverflow(page)
      check(
        'Plan never scrolls the page (its cards clip inside their own box)',
        over.doc === 0 && over.content === 0,
        `document +${String(over.doc)}px · content area +${String(over.content)}px`
      )
    }
    await dumpArtifacts(page, failures.length ? 'plan-FAIL' : 'plan-pass')
  } finally {
    // The staged install was created HERE, so `launchOnFixture` does not own it and will not take
    // it away with the app (logFixture.mts) — this file disposes of what this file made.
    await app.close()
    await removeUserData(userData)
    await log.dispose()
  }

  check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
