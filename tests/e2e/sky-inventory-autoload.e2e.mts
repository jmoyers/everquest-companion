/**
 * Headless Electron integration test for THE SKY TAB LOADING THE INVENTORY DUMP BY ITSELF (JOS-253),
 * for the QUIET line it says so on (JOS-268), and for it actually COUNTING the thing it loaded
 * (JOS-294).
 *
 * READ THE THIRD RULING FIRST, because it moves the default this spec used to open on. JOS-253 made
 * the app load the dump; JOS-268 made it say how fresh that dump was; neither touched the count
 * SOURCE, which defaulted to `log` — and `log` reads the export for nothing at all
 * (features/inventory/reconcile.ts). So the fixed surface still answered 0/2 to a player whose file
 * held both items, and four reports across three releases (GitHub #27, in-app
 * 01KZWDKMXYRERD96CF8AYQFA7P, Reddit, and this spec's own JOS-253 report — whose header already
 * named the cause) are all that one gap. JOS-294 closes it in three places this spec now pins:
 *   THE DEFAULT IS `both`. A fresh install counts whichever witness holds more of each item, so the
 *   freshness line is up from the first render rather than after a trip through the dropdown. The
 *   flip is a provable no-op for anyone without a dump (tests/countSourceDefault.test.mts reduces
 *   the two sources to byte-identical `ReconcileResult`s), which is what lets it be a default change.
 *   `log` SAYS WHAT IT IS DOING. Chosen on purpose with a dump loaded, it now states that the export
 *   is loaded and not counted, and names the source that would count it. That was the one state of
 *   three with nothing on screen, and it is where every reporter was standing.
 *   THE READY TAB CARRIES THE CONTROL. It used to render neither the dropdown nor the caption
 *   (`QuestFilterBar` lives on the Quests branch alone), so the tab the count source can EMPTY was
 *   the one tab with no way to see or change it.
 *
 * THE REPORT (feedback 01KZV7C6F9GB93XCZCJSGJJKWA, v0.23.0): the inventory reload button in the
 * Plane of Sky section stays disabled even after running `/outputfile` in game. There was no log
 * slice with it, and there did not need to be — the cause was one clause in `QuestFilterBar.tsx`,
 * `disabled={countSource === 'log'}`, and `log` is the DEFAULT count source. So the control was
 * born disabled on a fresh install and no detection path was ever consulted: the app never looked
 * for the reporter's file, never failed to find it, and never said anything either way.
 *
 * THE OWNER'S RULING (2026-08-12) was that the button was the wrong shape of answer regardless:
 * stop making the user press one. Load the dump when it changes, the way the app already follows
 * files, and show BOTH instants — when the file was written and when we read it — so a stale copy
 * is visibly stale.
 *
 * AND THE SECOND RULING, hours later on the shipped surface (JOS-268), which is what this spec now
 * describes. The freshness truth was right and its PRESENTATION was not: a full-width outlined bar
 * with a bold command, a clause and a Reload button, on screen at all times. So —
 *
 *   THE BUTTON IS GONE. Not disabled, not moved: gone. The app reads the dump at session start and
 *   follows every rewrite, so the only thing a click could do is what already happened.
 *   THE LINE IS QUIET. Caption-sized, in the same disabled grey the stamps were already in, with
 *   no card around it.
 *   IT ONLY COMES UP WHEN THE DUMP IS COUNTED. `log` reads the file for nothing, and a freshness
 *   line about a file no number on screen depends on is the caveat the UI diet refuses. (JOS-294
 *   keeps that rule and adds the missing sentence beside it: under `log` WITH A DUMP LOADED the slot
 *   says the export is not being counted, which is a fact about the counts rather than about the
 *   file's age. With no dump loaded it is still silent — there is nothing to fail to count.)
 *   AND IT MOVES NOTHING. It hangs off the bottom edge of the "Count items from" select, out of
 *   flow, so picking a source cannot shove the counts and the quest list down the page.
 *
 * The last one is the assertion that needs saying twice, because it is the one a refactor breaks
 * silently: the neighbour below the bar is measured with the line ABSENT, with it PRESENT, and
 * with it absent again, and all three have to be the same y. A block element would pass every
 * other check in this file.
 *
 * AND THE FOURTH RULING (JOS-431), which is the same surface answering a SECOND report. The three
 * acts above all rest on one act of writing: the dump is OVERWRITTEN in place while the app is up,
 * and the app follows it. Report 01M0FMGA4DQRMG46290GWVVHQ6 (v1.6.0) is what happens when the
 * writer REPLACES the file instead — a fresh dump on disk, a days-old timestamp on screen, and a
 * restart as the only cure. So this spec now writes the other shape too, and adds the affordance
 * the reporter asked for by name:
 *
 *   THE FILE IS DELETED AND WRITTEN AGAIN, in the same session, on the same watcher. The app has
 *   to date the replacement rather than the file that is gone (`stepReplacedNotOverwritten`), and
 *   the evidence is deliberately an AGE IN MINUTES rather than a clock — the step's own header
 *   says why a second timestamp stamped `now` would have proved nothing.
 *   THE LINE CARRIES A REFRESH, in the row's own quiet voice, and pressing it re-reads the dump.
 *   Not the JOS-268 button returning: `RELOAD` is still asserted absent beside it.
 *
 * WHY THIS NEEDS A REAL APP, AND A REAL FILE. Every piece of the arc is a seam between processes:
 * chokidar in main sees a write into the EQ install root → the outputs registry re-finds and
 * re-stats the file → `loadInventory` parses it and stamps `readAt` → the store → two IPC pushes →
 * a hook re-asking `outputsStatus` and a hook re-reading progress → two words on a line. Unit
 * tests can pin the WORDS (tests/outputsRegistry.test.mts owns the three-plus-two states without a
 * DOM) and cannot pin the chain, and that half of this ticket is entirely the chain. So the
 * assertions here are driven by WRITING THE DUMP into the staged install — the same act as typing
 * the command in game — and read off the line a player is looking at.
 *
 * TWO LAUNCHES, BECAUSE "IT FOLLOWS THE FILE" IS TWO PROMISES.
 *
 *   LAUNCH 1 — a machine where `/outputfile inventory` has NEVER been run (the staged install has
 *   a log and nothing else, which is what every e2e launch used to be). It pins the presentation
 *   first — nothing under the default source, the line and only the line under an inventory one —
 *   and then the dump is written while the app is up, and the two slots have to go from "not yet
 *   run"/"not loaded yet" to a pair of real instants WITH NO CLICK. That is the watcher's
 *   appear-then-arm path (`watchForOutputFile`), which is exactly the player the steps are for.
 *
 *   LAUNCH 2 — the dump is rewritten while the app is DOWN, then the app comes back on the SAME
 *   userData dir. A watcher cannot see a change that predates it (`ignoreInitial: true`), so
 *   nothing but the startup read can move the load instant here — and before JOS-253 nothing did:
 *   the store kept the previous run's copy and the app tailed a character against a dump it had
 *   never opened. The assertion is that the load instant DIFFERS from the one launch 1 ended on,
 *   which is locale-independent and cannot be satisfied by the watcher.
 *
 * WHY THE LOAD INSTANT IS READ AS A `title` AND NOT AS TEXT. The visible words are deliberately
 * coarse (`formatAge`: anything under 90 seconds is "just now"), so two loads a few seconds apart
 * read identically — the text is right for a human and useless as evidence. The exact clock is
 * already on the element as its tooltip, for the reason OutputFileLine states, so the spec reads
 * the precise value and compares STRINGS rather than parsing a localised date.
 *
 * AND THE STALE COLOUR IS READ AS A RELATION, not as a hex value: the load slot goes warning-
 * coloured only when the file is newer than our copy, so "not stale" is asserted as "the same
 * colour as the age slot beside it". That survives a theme change, which comparing against a
 * literal would not. The QUIET styling is read the same way — one text size across the row, no
 * border, no fill — rather than against literal px and rgb values that a theme owns.
 *
 * WHAT IT DOES NOT ASSERT: which items the dump adds to the held counts. That is
 * `reconcile`/`heldCountsFromDump`, pinned against the real 295-row dump without a browser
 * (tests/outputsInventory.test.mts, tests/inventoryBaseline.test.mts), and repeating it here would
 * only make this spec depend on the committed dump staying the shape it is. The subject here is
 * whether the app NOTICES the file, and what it says when it has.
 *
 * WHY IT NEVER TAKES THE SCREEN: `EQ_E2E=1` (src/main/e2e.ts) shows no window, skips the
 * single-instance lock, and points `userData` at a throwaway temp dir per launch.
 *
 * Run: `npm run test:e2e -- sky-inventory-autoload`.
 */
import type { Page } from 'playwright-core'
import { buildIfStale, check, countOf, dumpArtifacts, failures, reportRun, settle } from './appHarness.mjs'
import { mainWindow, makeUserData, removeUserData } from './appWindow.mjs'
import { launchOnFixture, stageFixture, writeInventoryDump, type FixtureLog } from './logFixture.mjs'
// JOS-431's two acts live next door because this file is AT the repo max-lines budget and the rule
// is to SPLIT, never ratchet. The selectors and the `slot` reader they share come back with them,
// so there is still exactly one spelling of each.
import {
  AGE,
  DUMP,
  LOADED,
  REFRESH,
  slot,
  stepRefreshRereads,
  stepReplacedNotOverwritten,
  type Slot
} from './inventoryRewriteSteps.mjs'

const NAV_SKY = '[data-testid="nav-posky"]'
const NAV_OVERVIEW = '[data-testid="nav-overview"]'
/** The `/outputfile` line the Sky tab renders — the whole surface under test. */
const FRESH = '[data-testid="posky-inventory-fresh"]'
/** The command itself, and the HOW affordance the ticket kept (subdued, not absent). */
const COMMAND = '[data-testid="posky-inventory-fresh-command"]'
const HOW = '[data-testid="posky-inventory-fresh-steps-toggle"]'
/** What HOW opens: the numbered steps, on a surface of their own over the list. */
const STEPS = '[data-testid="posky-inventory-fresh-steps"]'
/**
 * THE CONTROL THAT NO LONGER EXISTS (JOS-268). Named here only so its absence can be asserted, and
 * it is still absent after JOS-431 put `REFRESH` on the line — the two are different controls in
 * different places, which is the whole point of the later ticket's own assertions.
 */
const RELOAD = '[data-testid="posky-reload-inventory"]'
/** THE SECOND TENANT OF THAT SLOT (JOS-294): what `log` says when a dump IS loaded. */
const IGNORED = '[data-testid="posky-inventory-ignored"]'
/** …in the exact words a player reads, because "there is a line" is not the fix. */
const IGNORED_TEXT = 'Inventory export loaded but not counted - switch to Both to include it.'
/** The Ready tab, which since JOS-294 carries the source control and its caption of its own. */
const TAB_READY = '[data-testid="posky-tab-ready"]'
const READY = '[data-testid="posky-ready"]'
/** The dropdown the line now belongs to, and whose value decides whether it is drawn at all. */
const COUNT_SOURCE = '[data-testid="posky-count-source"]'
const COUNT_SOURCE_VALUE = `${COUNT_SOURCE} [role="combobox"]`
/** Where `setCountSource` writes the pick (useProgress's `COUNT_SOURCE_KEY`). */
const COUNT_SOURCE_KEY = 'eq.countSource'
/** THE NEIGHBOUR: the first thing below the filter bar, and what an in-flow line would push down. */
const COUNTS = '[data-testid="posky-counts"]'
/** The tab's own handle, now that the Reload button is not there to wait for. */
const SEARCH = '[data-testid="posky-search"]'

/**
 * THE LAYOUT, READ IN ONE FRAME — which is the only way the no-reflow comparison means anything.
 * Two separate reads would be two different layouts, and "the same y" between them would be a
 * coincidence rather than a claim.
 *
 * `counts` is the neighbour under the bar; `select` is the bottom edge of the dropdown the line
 * hangs from; `line` is the line's own top, or null when it is not on screen at all.
 */
interface Layout {
  counts: number | null
  select: number | null
  line: number | null
  /** the line's own bottom edge — an overlay still has to FIT, not just fail to push */
  lineBottom: number | null
}

// NO HELPER FUNCTION INSIDE THE `evaluate` BODY: the runner loads these specs through tsx, whose
// esbuild transform names inner functions with a `__name` shim that does not exist in the page.
// Three straight-line reads instead, which is also the whole point — they are one frame.
//
// `lineSel` is a parameter since JOS-294 because the slot has two tenants — the freshness line and
// the "loaded but not counted" sentence — and every layout promise the ticket above made has to be
// true of BOTH. Measuring the second one with the first one's helper is what keeps that honest.
function layout(page: Page, lineSel: string = FRESH): Promise<Layout> {
  return page.evaluate(
    (s) => {
      const counts = document.querySelector(s.counts)
      const select = document.querySelector(s.select)
      const line = document.querySelector(s.line)
      return {
        counts: counts ? Math.round(counts.getBoundingClientRect().top) : null,
        select: select ? Math.round(select.getBoundingClientRect().bottom) : null,
        line: line ? Math.round(line.getBoundingClientRect().top) : null,
        lineBottom: line ? Math.round(line.getBoundingClientRect().bottom) : null
      }
    },
    { counts: COUNTS, select: COUNT_SOURCE, line: lineSel }
  )
}

function appears(page: Page, sel: string, ms = 20_000): Promise<boolean> {
  return page.waitForSelector(sel, { timeout: ms }).then(
    () => true,
    () => false
  )
}

/** Land, then open the Sky tab on the filter bar the report is about. */
async function openSky(page: Page): Promise<boolean> {
  if (!check('the app lands on the nav', await appears(page, NAV_OVERVIEW, 60_000))) return false
  await page.click(NAV_SKY, { timeout: 30_000 })
  if (!check('the Sky tab opens on its filter bar', await appears(page, SEARCH, 60_000))) return false
  return check('…with the counts line under it to measure against', await appears(page, COUNTS, 30_000))
}

/**
 * Pick a count source THROUGH THE REAL CONTROL, and wait for the pick to be stored.
 *
 * The stored key is the settle condition rather than the rendered line, because this helper is
 * also used to turn the line OFF — waiting on the thing under test would make the "it goes away"
 * assertion wait on itself.
 */
async function setCountSource(page: Page, value: string): Promise<boolean> {
  await page.click(COUNT_SOURCE, { timeout: 15_000 })
  await page.click(`li[role="option"][data-value="${value}"]`, { timeout: 15_000 })
  const stored = await settle(
    () => page.evaluate((k) => localStorage.getItem(k), COUNT_SOURCE_KEY),
    (v) => v === value,
    { timeoutMs: 8_000 }
  )
  return check(`the count source is set to ${value}`, stored === value, `stored ${String(stored)}`)
}

/**
 * THE DEFAULT STATE, pinned before anything moves — AND IT IS A DIFFERENT DEFAULT SINCE JOS-294.
 *
 * This step used to assert `Log (ever looted)`, no freshness line, and no Reload button, and the
 * first two of those were the JOS-253 defect wearing the JOS-268 presentation: `log` reads the dump
 * for NOTHING (reconcile.ts), so a fresh install loaded the player's export, dated it, and counted
 * not one item out of it — with no line about the file because no inventory source was up. Four
 * reports across three releases end there.
 *
 * So the default is `both` now, which is the source that counts whichever witness can vouch for
 * more, and the freshness line comes up WITH IT on a machine that has never run the command
 * ("not yet run · not loaded yet" — the honest state, and the one that teaches the command).
 *
 * THE STORED KEY IS READ AS WELL AS THE CONTROL, because "the default" is the whole claim: an
 * absent `eq.countSource` is what this asserts about, and a value in storage would mean the spec
 * was reading somebody's pick instead (features/inventory/countSource.ts — an explicit choice is
 * returned verbatim, and this launch has never made one).
 */
async function stepDefaultCountsTheDump(page: Page): Promise<void> {
  const stored = await page.evaluate((k) => localStorage.getItem(k), COUNT_SOURCE_KEY)
  check('nothing has ever chosen a count source on this install', stored === null, String(stored))
  const source = await page.evaluate(
    (s) => (document.querySelector(s) as HTMLElement | null)?.innerText.trim() ?? '',
    COUNT_SOURCE_VALUE
  )
  check(
    'a fresh install counts the inventory export by default',
    source === 'Both (higher of the two)',
    source
  )
  check('…so the freshness line is up without anyone touching the dropdown', (await countOf(page, FRESH)) === 1)
  // CONSTRAINT 4, as one number. The control is not disabled, not hidden: it does not exist.
  check('…and the Reload inventory button is gone from the tab', (await countOf(page, RELOAD)) === 0)
}

/**
 * THE LOG SOURCE, CHOSEN ON PURPOSE, ON A MACHINE WITH NO DUMP: still says nothing, and that is
 * still right — there is no file, so there is nothing to fail to count.
 *
 * This is JOS-268's constraint 2 in the only state where it survives JOS-294 intact, and it is also
 * how the rest of this spec gets its baseline: the no-reflow comparisons need a layout with the
 * slot EMPTY, and after this ticket the default no longer provides one.
 */
async function stepLogSaysNothingWithNoDump(page: Page): Promise<Layout> {
  if (!(await setCountSource(page, 'log'))) return layout(page)
  const gone = await settle(() => countOf(page, FRESH), (n) => n === 0, { timeoutMs: 10_000 })
  check('picking the log source takes the freshness line away', gone === 0, `lines=${String(gone)}`)
  check(
    '…and with no dump on the machine it says nothing at all — there is nothing to ignore',
    (await countOf(page, IGNORED)) === 0
  )
  return layout(page)
}

/**
 * THE LINE COMES UP WITH THE SOURCE, AND NOTHING ELSE MOVES.
 *
 * Three things at once, because they are one claim about one act: picking an inventory-backed
 * source draws the line, puts it UNDER the dropdown it belongs to, and leaves the counts line
 * exactly where it was. The third is the ticket's third constraint and the reason the line is
 * absolutely positioned.
 */
async function stepInventorySourceRevealsIt(page: Page, before: Layout): Promise<void> {
  if (!(await setCountSource(page, 'inventory'))) return
  if (!check('picking an inventory source brings the line up', await appears(page, FRESH, 20_000))) return
  const after = await layout(page)
  check(
    '…and the row below the bar has not moved a pixel (the line is out of flow)',
    after.counts !== null && after.counts === before.counts,
    `counts top was ${String(before.counts)}, now ${String(after.counts)}`
  )
  check(
    '…the bar itself is the same height it was',
    after.select !== null && after.select === before.select,
    `dropdown bottom was ${String(before.select)}, now ${String(after.select)}`
  )
  check(
    '…and the line hangs BELOW the dropdown it belongs to',
    after.line !== null && after.select !== null && after.line >= after.select,
    `line top=${String(after.line)} dropdown bottom=${String(after.select)}`
  )
  // …and it FITS in the gap the bar already leaves. Out of flow is not a licence to land on top of
  // the row below: the whole reason the quiet chrome compresses its line-height is that the caption
  // has to live inside the view's own `Stack spacing`.
  check(
    '…and it fits in the gap rather than landing on the row below',
    after.lineBottom !== null && after.counts !== null && after.lineBottom <= after.counts,
    `line bottom=${String(after.lineBottom)} counts top=${String(after.counts)}`
  )
  check('…the Reload button did not come back with it', (await countOf(page, RELOAD)) === 0)
}

/**
 * UNDERSTATED, MEASURED RATHER THAN EYEBALLED (constraint 1).
 *
 * Read as RELATIONS, like the stale colour is: the command is the same text size as the timestamp
 * beside it (one caption row, not a bold headline over a footnote), and the line carries no card —
 * no border, no fill. Both survive a theme change; a literal `12px` or `rgb(…)` would not.
 *
 * The HOW affordance is checked as PRESENT and sentence-cased, which is the "subdued, not absent"
 * half of the same constraint.
 */
async function stepItIsUnderstated(page: Page): Promise<void> {
  const style = await page.evaluate(
    (s) => {
      const line = document.querySelector(s.line)
      const command = document.querySelector(s.command)
      const age = document.querySelector(s.age)
      if (!line || !command || !age) return null
      const box = getComputedStyle(line)
      return {
        border: box.borderTopWidth,
        fill: box.backgroundColor,
        commandSize: getComputedStyle(command).fontSize,
        ageSize: getComputedStyle(age).fontSize
      }
    },
    { line: FRESH, command: COMMAND, age: AGE }
  )
  if (!check('the quiet line can be measured', style !== null) || !style) return
  check('the command is no louder than the timestamp beside it', style.commandSize === style.ageSize, `${style.commandSize} vs ${style.ageSize}`)
  check('…the line wears no card border', style.border === '0px', style.border)
  check('…and no fill of its own — it sits on the panel', style.fill === 'rgba(0, 0, 0, 0)', style.fill)
  // The two affordances, read the same way: sentence-cased words, no louder than the stamps they
  // sit beside. The second one is JOS-431's, and it is held to this constraint rather than exempted
  // from it — the JOS-268 button was a control BESIDE the dropdown, this is one word INSIDE the
  // caption row, and `RELOAD`'s continued absence three steps up is the other half of that claim.
  for (const [sel, word] of [[HOW, 'How'], [REFRESH, 'Refresh']] as const) {
    const label = await page.evaluate(
      (s) => (document.querySelector(s) as HTMLElement | null)?.innerText.trim() ?? '',
      sel
    )
    check(`…and the ${word} affordance is there, in a quiet voice`, label === word, label)
  }
}

/**
 * ASKING HOW MOVES NOTHING EITHER — the steps open OVER the list, not through it.
 *
 * The whole line is an overlay, and the panel it opens is inside that overlay, so the five steps
 * are drawn on a surface of their own above the quest rows. If the steps ever went back into flow
 * they would shove the entire tab down by five lines on a click, which is the loudest version of
 * the defect this ticket is about.
 */
async function stepAskingHowMovesNothing(page: Page, before: Layout): Promise<void> {
  await page.click(HOW, { timeout: 15_000 })
  const steps = await settle(
    () => countOf(page, STEPS),
    (n) => n === 1,
    { timeoutMs: 8_000 }
  )
  if (!check('the HOW affordance opens the steps', steps === 1, `panels=${String(steps)}`)) return
  const after = await layout(page)
  check(
    '…over the rows below, not through them (nothing moved)',
    after.counts !== null && after.counts === before.counts,
    `counts top was ${String(before.counts)}, now ${String(after.counts)}`
  )
  await page.click(HOW, { timeout: 15_000 })
  const closed = await settle(
    () => countOf(page, STEPS),
    (n) => n === 0,
    { timeoutMs: 8_000 }
  )
  check('…and the same affordance closes them again', closed === 0, `panels=${String(closed)}`)
}

/** The never-run pair: the player has typed nothing and we have loaded nothing, said separately. */
async function stepNeverRun(page: Page): Promise<void> {
  const age = await slot(page, AGE)
  const loaded = await slot(page, LOADED)
  check('with no dump on the machine, the file slot says the command was never run', age.text === 'not yet run', age.text)
  check('…and the load slot says so in its own words — a different fact', loaded.text === 'not loaded yet', loaded.text)
  // Neither can claim an instant it does not have, so neither carries an exact clock.
  check('…neither slot offers a clock time it does not have', age.title === '' && loaded.title === '', `${age.title} | ${loaded.title}`)
}

/**
 * THE ACCEPTANCE CRITERION: write the dump — the simulated `/outputfile inventory` — and touch
 * nothing else. Both instants have to appear.
 *
 * `settle` rather than a sleep, per the suite's law: the watcher holds the change until the file
 * has been the same size for 400 ms (outputs/watch.ts) and then a whole chain runs, so the only
 * honest wait is on the reading itself.
 */
async function stepAutoLoads(page: Page, installDir: string): Promise<Slot | null> {
  writeInventoryDump(installDir, DUMP)
  const age = await settle(
    () => slot(page, AGE),
    (s) => s.text !== 'not yet run',
    { timeoutMs: 30_000 }
  )
  if (!check('a dump written while the app is up is picked up with NO click', age.text !== 'not yet run', age.text)) {
    return null
  }
  check('…and the file slot dates it from the file itself', age.text === 'updated just now', age.text)
  check('…with the exact write time one hover away', age.title.length > 0, age.title)

  const loaded = await settle(
    () => slot(page, LOADED),
    (s) => s.text !== 'not loaded yet',
    { timeoutMs: 30_000 }
  )
  check('…and the load slot stops saying we have never read one', loaded.text === 'loaded just now', loaded.text)
  check('…carrying the instant WE read it', loaded.title.length > 0, loaded.title)
  // A load that just happened is never behind the file it just read.
  check(
    '…and a fresh load is not flagged stale (same colour as the slot beside it)',
    loaded.color === age.color,
    `loaded=${loaded.color} age=${age.color}`
  )
  return loaded
}

/**
 * AND IT LEAVES THE SAME WAY IT ARRIVED (constraint 3, the other direction).
 *
 * A line that appears without pushing content down but pulls it back UP on the way out is the same
 * defect with the sign flipped, so the neighbour is measured against the layout the tab started
 * on — with a real dump on disk this time, which is the state a block element would betray.
 */
async function stepItLeavesWithoutMoving(page: Page, before: Layout): Promise<void> {
  if (!(await setCountSource(page, 'log'))) return
  const gone = await settle(() => countOf(page, FRESH), (n) => n === 0, { timeoutMs: 10_000 })
  check('going back to the log source takes the line away again', gone === 0, `lines=${String(gone)}`)
  const after = await layout(page)
  check(
    '…and the row below the bar is still where it always was',
    after.counts !== null && after.counts === before.counts,
    `counts top was ${String(before.counts)}, now ${String(after.counts)}`
  )
}

/**
 * AND NOW THE STATE THE WHOLE OF JOS-294 IS ABOUT: `log` is selected, a dump HAS been loaded, and
 * the tab has to say so.
 *
 * This runs immediately after `stepItLeavesWithoutMoving`, which is what makes it the reporter's
 * exact situation rather than a contrived one: the app picked the file up by itself moments ago
 * (`stepAutoLoads`), the source ignores every item in it, and before this ticket the surface said
 * NOTHING — the one state of three with no line, which is why four reports read as four different
 * bugs. The sentence names the source that would count it, because "your export is being ignored"
 * without a way out is a caveat rather than an answer.
 *
 * The geometry is asserted again rather than assumed: this is a second tenant of the same overlay
 * slot, so it owes the same no-reflow promise, and a block element here would push the quest list
 * down exactly the way JOS-268 refused.
 */
async function stepLogSaysTheDumpIsIgnored(page: Page, before: Layout): Promise<void> {
  const up = await settle(() => countOf(page, IGNORED), (n) => n === 1, { timeoutMs: 10_000 })
  if (!check('with a dump loaded, the log source finally says it is not counting it', up === 1, `lines=${String(up)}`)) {
    return
  }
  const text = await page.evaluate(
    (s) => (document.querySelector(s) as HTMLElement | null)?.innerText.trim() ?? '',
    IGNORED
  )
  check('…in words that name the way out, not just the problem', text === IGNORED_TEXT, text)
  const after = await layout(page, IGNORED)
  check(
    '…and it moved nothing either (the slot has one geometry, whichever line is in it)',
    after.counts !== null && after.counts === before.counts,
    `counts top was ${String(before.counts)}, now ${String(after.counts)}`
  )
  check(
    '…hanging below the dropdown and fitting above the row under it',
    after.line !== null &&
      after.select !== null &&
      after.lineBottom !== null &&
      after.counts !== null &&
      after.line >= after.select &&
      after.lineBottom <= after.counts,
    `select bottom=${String(after.select)} line=${String(after.line)}-${String(after.lineBottom)} counts top=${String(after.counts)}`
  )
}

/** What the Ready tab looks like around its count-source control, read in one frame. */
interface ReadyLayout {
  /** the control's own bottom edge */
  select: number | null
  /** the caption hanging off it, top and bottom */
  line: number | null
  lineBottom: number | null
  /** the top of whatever the tab draws under that row — the thing a caption must not land on */
  next: number | null
}

function readyLayout(page: Page, lineSel: string): Promise<ReadyLayout> {
  return page.evaluate(
    (s) => {
      const container = document.querySelector(s.ready)
      const select = document.querySelector(s.select)
      const line = document.querySelector(s.line)
      const next = container?.children[1] ?? null
      return {
        select: select ? Math.round(select.getBoundingClientRect().bottom) : null,
        line: line ? Math.round(line.getBoundingClientRect().top) : null,
        lineBottom: line ? Math.round(line.getBoundingClientRect().bottom) : null,
        next: next ? Math.round(next.getBoundingClientRect().top) : null
      }
    },
    { ready: READY, select: COUNT_SOURCE, line: lineSel }
  )
}

/**
 * THE READY TAB CARRIES THE CONTROL AND ITS CAPTION (JOS-294, scope C).
 *
 * The in-app reporter (01KZWDKMXYRERD96CF8AYQFA7P) had a deleted log and a full dump, so their
 * Ready tab was empty of quests they were in fact holding every item for — and `QuestFilterBar`,
 * the only place the count source could be changed, renders ONLY on the Quests branch
 * (PoskyView.tsx). A control that can empty a tab has to be reachable from it: that is the JOS-155
 * argument, made for a checkbox, and this dropdown empties this tab far harder than the checkbox
 * ever did.
 *
 * Four claims, in the order a stranded player would need them: the control is HERE, it carries the
 * pick made on the other tab (one stored key, not a second opinion), the caption under it says the
 * dump is being ignored, and the control WORKS from here — picking Both swaps the caption for the
 * freshness line without leaving the tab.
 */
async function stepReadyTabCarriesTheSource(page: Page): Promise<void> {
  await page.click(TAB_READY, { timeout: 15_000 })
  if (!check('the Ready tab opens', await appears(page, READY, 20_000))) return
  check('…carrying the count-source control itself, not only a caption', (await countOf(page, COUNT_SOURCE)) === 1)
  const source = await page.evaluate(
    (s) => (document.querySelector(s) as HTMLElement | null)?.innerText.trim() ?? '',
    COUNT_SOURCE_VALUE
  )
  check('…showing the pick made on the Quests tab (one stored source, two surfaces)', source === 'Log only (ever looted)', source)

  const shown = await settle(() => countOf(page, IGNORED), (n) => n === 1, { timeoutMs: 10_000 })
  if (check('…and saying, HERE, that the loaded dump is not being counted', shown === 1, `lines=${String(shown)}`)) {
    const box = await readyLayout(page, IGNORED)
    check(
      '…as a caption under the control that fits above the tab body',
      box.line !== null &&
        box.select !== null &&
        box.lineBottom !== null &&
        box.next !== null &&
        box.line >= box.select &&
        box.lineBottom <= box.next,
      `select bottom=${String(box.select)} line=${String(box.line)}-${String(box.lineBottom)} next=${String(box.next)}`
    )
  }

  // THE WAY OUT, taken from the tab it was needed on.
  if (!(await setCountSource(page, 'both'))) return
  const fresh = await settle(() => countOf(page, FRESH), (n) => n === 1, { timeoutMs: 10_000 })
  check('picking Both from the Ready tab counts the dump without leaving the tab', fresh === 1, `lines=${String(fresh)}`)
  check('…and the not-counted sentence goes with it', (await countOf(page, IGNORED)) === 0)
}

/**
 * THE OTHER HALF: a dump rewritten while the app was DOWN.
 *
 * The watcher is armed `ignoreInitial: true` and cannot see this write, so the load instant can
 * only move if main READS the dump when the session starts — which is what JOS-253 added beside
 * the watch, mirroring the log's own scan-then-tail. Compared as a string against what launch 1
 * ended on, because the visible words are too coarse to tell two loads a minute apart apart.
 */
async function stepStartupRead(page: Page, before: Slot): Promise<void> {
  const loaded = await settle(
    () => slot(page, LOADED),
    (s) => s.title.length > 0 && s.title !== before.title,
    { timeoutMs: 30_000 }
  )
  check(
    'a dump rewritten while the app was closed is read at startup, not left for a click',
    loaded.title !== '' && loaded.title !== before.title,
    `launch 1 read at ${before.title} · launch 2 read at ${loaded.title}`
  )
  const age = await slot(page, AGE)
  check('…so the app is not showing a copy older than the file (no stale flag)', loaded.color === age.color, `loaded=${loaded.color} age=${age.color}`)
  check('…and the file is dated from disk, as it always was', age.title.length > 0, age.title)
}


/**
 * ONE LAUNCH, WITH ITS CONSOLE WATCHED AND ITS ARTIFACTS DROPPED — the boilerplate both launches
 * need, factored so `main` reads as the two-act story the header describes rather than as four
 * levels of nesting. `run` gets the page and returns nothing; whatever it wants to keep it keeps
 * by closure.
 */
async function launch(
  log: FixtureLog,
  userData: string,
  tag: string,
  run: (page: Page) => Promise<void>
): Promise<void> {
  const app = await launchOnFixture(log, { userData })
  try {
    const page = await mainWindow(app.app)
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    await run(page)

    check(`no renderer console errors (${tag})`, consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
    await dumpArtifacts(page, failures.length ? `${tag}-FAIL` : `${tag}-pass`)
  } finally {
    await app.close()
  }
}

async function main(): Promise<void> {
  buildIfStale()

  // Owned by this spec: the startup-read assertion IS one launch's record outliving its process.
  const userData = makeUserData()
  // No `inventory:` option — launch 1's whole point is a machine that has never run the command.
  const log: FixtureLog = stageFixture('e2e-copy.log')
  let readAt: Slot | null = null

  try {
    console.log('launch 1: never-run machine, then write the dump underneath it…')
    await launch(log, userData, 'sky-inventory-autoload-1', async (page) => {
      if (!(await openSky(page))) return
      await stepDefaultCountsTheDump(page)
      // The baseline for every no-reflow comparison below is the slot EMPTY, which since JOS-294 is
      // the log source on a machine with no dump rather than the default.
      const base = await stepLogSaysNothingWithNoDump(page)
      await stepInventorySourceRevealsIt(page, base)
      await stepItIsUnderstated(page)
      await stepAskingHowMovesNothing(page, base)
      await stepNeverRun(page)
      readAt = await stepAutoLoads(page, log.installDir)
      // The other shape of rewrite, in the same session and on the same file (JOS-431).
      await stepReplacedNotOverwritten(page, log.installDir)
      await stepItLeavesWithoutMoving(page, base)
      await stepLogSaysTheDumpIsIgnored(page, base)
      await stepReadyTabCarriesTheSource(page)
    })

    const before = readAt
    if (before === null) {
      check('launch 1 never loaded a dump, so the startup read cannot be measured', false)
    } else {
      // THE WRITE THE APP CANNOT WATCH: it happens between the two processes.
      writeInventoryDump(log.installDir, DUMP)
      console.log('launch 2: same userData, a dump rewritten while nothing was running…')
      await launch(log, userData, 'sky-inventory-autoload-2', async (page) => {
        if (!(await openSky(page))) return
        // The line is drawn only under an inventory-backed source. Picking one explicitly here —
        // rather than riding launch 1's stored `both` — keeps this act independent of whatever the
        // default happens to be, which is a thing this spec has now watched change once. It is the
        // same act a returning player performs, and the freshness it then shows is the startup read
        // this act is about.
        if (!(await setCountSource(page, 'inventory'))) return
        if (!check('the line comes back with the source', await appears(page, FRESH, 20_000))) return
        await stepStartupRead(page, before)
        // …and the affordance the second report asked for, pressed for real (JOS-431). It goes
        // last because it needs the app to have been up a while — see the step's own header.
        await stepRefreshRereads(page, await slot(page, LOADED))
      })
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
