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
 *   4. THE ROUTE IS ZONE-FIRST. A bracket draws RUNS — a named place, its difficulty, and what is
 *      worth carrying home — because that is what the ask asked for ("it should say crushbone …
 *      mistmoore splitpaw") and because a flat top-eight measurably buried it (fold rule 7).
 *   5. THE ONE DOOR OUT WORKS. A bracket's button writes every target under its runs to the wish
 *      list, and they are read back on the Wish list TAB, which unmounted this view to draw itself.
 *   6. …AND THE ROWS STAY, FLAGGED. THIS CLAIM IS THE REVERSE OF THE ONE THIS FILE SHIPPED WITH,
 *      and the reversal is the point rather than an embarrassment: the first cut excluded wished
 *      items from the fold, so pressing the button made the answer vanish. Fold rule 9 now FLAGS
 *      instead — a wished item bypasses the upgrade-gap test and sorts first — so the assertion is
 *      inverted with the rule, not softened.
 *   7. THE GEAR TAB'S HOVER COMPARISON IS ON THESE ROWS (owner ask, 2026-08-15 20:17). Asserted as
 *      mounting the SAME node (`gear-compare-pair`, keyed to the hovered item), because reuse is
 *      the claim — `tests/gearCompare.test.mts` and `gear.e2e` already own what is IN it.
 *
 * NOTHING HERE IS A FROZEN NUMBER except the level this spec itself states (AGENTS.md, "frozen
 * numbers rot"). Which items a bracket holds and which zones it names are the corpus's business and
 * it is rescraped; the assertions are counts of at-least-one, identities, and the one number the
 * spec wrote into the log.
 *
 * THE STAGED CHARACTER OWNS NOTHING — no `/outputfile` dump, an empty loot history — so the gap test
 * runs with an empty bar map, which the fold documents as EVERY SLOT A GAP. That is the shipped
 * default rather than a contrivance, and it is why this spec can assert that runs render at all
 * without fabricating an inventory the harness has no honest way to stage.
 *
 * Run: `npm run test:e2e -- plan.e2e`.
 */
import type { Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  failures,
  hoverAt,
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
const TARGET = '[data-testid="plan-target"]'
const ROLE = '[data-testid="plan-role"]'
const REACH = '[data-testid="plan-reach"]'
/** The comparison pair, by the testid the Gear tab's own spec reads — reuse is the claim. */
const PAIR = '[data-testid="gear-compare-pair"]'
const PAIR_ITEM = '[data-testid="gear-compare-card"]'

/** One target row, and the name inside it that carries both affordances (Loot link, hover pair). */
const targetOf = (key: string): string => `${TARGET}[data-item-key="${key}"]`
const nameOf = (key: string): string => `${targetOf(key)} [data-testid="planner-donor-name"]`

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

/** One run line as plain values a check can read: the place, and what it is offering. */
interface RunRead {
  from: string
  zone: string
  plus: string
  label: string
  keys: string[]
}

/**
 * Every run on screen, in draw order, each with the bracket it belongs to.
 *
 * `zone` comes off the data attribute (the fold's BASE spelling) and `label` off the rendered text,
 * so the claims below can say both "the fold grouped by a real place" and "a human can read it".
 */
function runsOnScreen(page: Page): Promise<RunRead[]> {
  return page.evaluate(() => {
    const out = []
    for (const card of document.querySelectorAll('[data-testid="plan-bracket"]')) {
      for (const run of card.querySelectorAll('[data-testid="plan-run"]')) {
        const head = run.querySelector('[data-testid="plan-run-head"]')
        out.push({
          from: card.getAttribute('data-from') ?? '',
          zone: run.getAttribute('data-zone') ?? '',
          plus: run.getAttribute('data-plus') ?? '',
          // The HEADING's own node, whitespace-collapsed — never the run box's first text LINE,
          // which would depend on where the browser chose to break a nowrap row (see the component).
          label: ((head as HTMLElement | null)?.innerText ?? '').replace(/\s+/g, ' ').trim(),
          keys: [...run.querySelectorAll('[data-testid="plan-target"]')]
            .map((t) => t.getAttribute('data-item-key') ?? '')
            .filter((k) => k !== '')
        })
      }
    }
    return out
  })
}

/**
 * 4. THE ROUTE IS ZONE-FIRST.
 *
 * The claims are shapes, never names: which zones the committed corpus puts in a level-12 bracket is
 * the corpus's business and it is rescraped. What must hold is that runs EXIST, that at least one
 * NAMES A PLACE (the whole point of the shape), that each carries something worth going for, and
 * that the caps the fold states are the caps on screen — three targets a run, six runs a bracket.
 */
async function stepRuns(page: Page): Promise<void> {
  const runs = await settle(() => runsOnScreen(page), (r) => r.length > 0, { timeoutMs: 30_000 })
  if (!check('a bracket draws RUNS - the zone-first answer the ask asked for', runs.length > 0)) return
  note(`${String(runs.length)} runs drawn · first: ${runs[0].label}`)

  check(
    'every run has a heading and something worth going there for',
    runs.every((r) => r.label !== '' && r.keys.length > 0),
    runs.slice(0, 3).map((r) => `${r.label} (${String(r.keys.length)})`).join(' · ')
  )
  // …and the heading a human reads NAMES THE PLACE the fold grouped on. Only runs that HAVE a zone
  // are asserted: `GearRun.zone` is legitimately `''` when the item pages listed their droppers
  // under no heading at all, and that run's line says so in words rather than naming a place.
  const placed = runs.filter((r) => r.zone !== '')
  check('at least one run names an actual zone - the "crushbone, mistmoore, splitpaw" answer', placed.length > 0)
  check(
    '…and each of those headings contains the zone the fold grouped on',
    placed.every((r) => r.label.includes(r.zone)),
    placed.slice(0, 3).map((r) => `"${r.label}" vs "${r.zone}"`).join(' · ')
  )
  // The caps the fold states, asserted as bounds rather than as counts (the corpus grows).
  check(
    'the run caps the fold states are the caps on screen - at most 3 items a run, 6 runs a bracket',
    runs.every((r) => r.keys.length <= 3) &&
      [...new Set(runs.map((r) => r.from))].every((from) => runs.filter((r) => r.from === from).length <= 6)
  )
  // A tiered run is a DIFFERENT trip from its base zone, and the fold refuses to con it — so if this
  // corpus produced one, it must be saying so in words rather than printing a band it cannot know.
  const tiered = runs.filter((r) => r.plus !== '')
  if (tiered.length === 0) note('no tiered (+N) run in this route — nothing to assert about the tier wording')
  else {
    check(
      'a +N run says its difficulty is unstated rather than borrowing the base zone`s band',
      tiered.every((r) => r.label.includes('difficulty unstated')),
      tiered[0].label
    )
  }
}

/** How many of `keys` the Wish list tab is drawing right now. */
function wishedCount(page: Page, keys: readonly string[]): Promise<number> {
  return page.evaluate(
    (ks) => ks.filter((k) => document.querySelector(`[data-testid="wishlist-row"][data-item="${k}"]`) !== null).length,
    [...keys]
  )
}

/** …and how many of them the PLAN is still drawing, flagged as wished. */
function flaggedCount(page: Page, keys: readonly string[]): Promise<number> {
  return page.evaluate(
    (ks) =>
      ks.filter(
        (k) => document.querySelector(`[data-testid="plan-target"][data-item-key="${k}"][data-wished="true"]`) !== null
      ).length,
    [...keys]
  )
}

/**
 * 5 + 6. THE DOOR OUT, AND THE ROWS THAT STAY BEHIND IT.
 *
 * The targets are read off the RUNS before the click, so what is checked on the other tab is the set
 * this button actually carried rather than whatever happens to be on the wish list. At least one is
 * the claim, not all of them: a target already fulfilled by the staged character goes to that tab's
 * done strip, which is correct behaviour and not a route row.
 *
 * Then the reversal (fold rule 9): the rows come BACK, wearing the flag. Asserted on
 * `data-wished="true"` rather than on mere presence, because a build that ignored the flag entirely
 * would draw the same rows and mean something different — the plan would have stopped knowing.
 */
async function stepAddBracket(page: Page): Promise<string[]> {
  const runs = await runsOnScreen(page)
  const from = runs[0]?.from ?? ''
  const keys = [...new Set(runs.filter((r) => r.from === from).flatMap((r) => r.keys))]
  if (!check('the first bracket has targets and a button to send them to the wish list', keys.length > 0)) return []
  note(`adding ${String(keys.length)} targets from bracket ${from}`)
  await page.click(`${BRACKET}[data-from="${from}"] [data-testid="plan-add-bracket"]`, { timeout: 15_000 })

  await page.click(WISH_TAB, { timeout: 15_000 })
  if (!check('the Wish list tab mounts', await until(async () => (await countOf(page, WISH_VIEW)) > 0, 30_000))) return []
  const landed = await settle(() => wishedCount(page, keys), (n) => n > 0, { timeoutMs: 20_000 })
  check(
    "every target under a bracket's runs arrives on the wish list, across two views and one store",
    landed > 0,
    `${String(landed)} of ${String(keys.length)} on the list`
  )

  await page.click(TAB, { timeout: 15_000 })
  if (!check('the Plan tab comes back', await until(async () => (await countOf(page, VIEW)) > 0, 30_000))) return []
  const flagged = await settle(() => flaggedCount(page, keys), (n) => n > 0, { timeoutMs: 20_000 })
  check(
    'the rows STAY on the plan, flagged as wished - a wished item is flagged, never filtered',
    flagged > 0,
    `${String(flagged)} of ${String(keys.length)} still drawn, wearing the flag`
  )
  return keys
}

/**
 * 7. THE GEAR TAB'S HOVER COMPARISON, ON A PLAN ROW.
 *
 * REUSE IS THE WHOLE CLAIM, so what is asserted is the identity of the node: `gear-compare-pair`
 * with the hovered item's own key on its left card. What is IN the pair — the stats, the equipped
 * cells, the freshness line, the anchoring geometry — belongs to `gear.e2e`'s compare step and
 * `tests/gearCompare.test.mts`, and restating any of it here would be a second opinion about a
 * component this tab does not own.
 *
 * The pointer is parked afterwards so the pair closes and cannot sit over the overflow measurement.
 */
async function stepHoverCompare(page: Page, keys: readonly string[]): Promise<void> {
  const key = keys[0]
  if (key === undefined) return
  if (!check('the hovered row has a name to point at', (await countOf(page, nameOf(key))) === 1)) return
  if (!(await hoverAt(page, nameOf(key), 0.5, 0.5))) {
    check('the plan target name is reachable by a real pointer', false, key)
    return
  }
  const opened = await until(async () => (await countOf(page, `${PAIR_ITEM}[data-item-key="${key}"]`)) === 1, 20_000)
  check(
    'hovering a plan target opens the SAME comparison pair the Gear tab opens',
    opened,
    `${String(await countOf(page, PAIR))} pairs open for ${key}`
  )
  // Park the pointer off the row so the pair leaves before anything else is measured.
  await page.mouse.move(2, 2)
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
      if (await stepDing(page, log)) {
        await stepRuns(page)
        // The hover claim runs on rows the add step has already written to the wish list, which
        // costs it nothing (the pair is about the ITEM, not about its wish state) and saves a
        // second read of the route.
        await stepHoverCompare(page, await stepAddBracket(page))
      }
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
