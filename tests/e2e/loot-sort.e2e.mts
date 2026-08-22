/**
 * Headless Electron integration test for THE LOOT SORT CONTROL BEING REACHABLE (JOS-127).
 *
 * THE BUG, as a 0.14.0 user hit it: you cannot change the Loot page's order off "Last looted".
 * The Sort select is in the toolbar; the surfaces stacked immediately BELOW it — the
 * notable-pickups strip and the first rows of the ledger — anchored `placement="top"`,
 * INTERACTIVE item cards (`lib/KnownItemTooltip`, up to 380px wide). A card opened upward
 * across the toolbar, and because an interactive MUI tooltip keeps `pointer-events: auto` while
 * it is up, the click aimed at the select landed on the card instead. The owner's direction was
 * removal: fewer tooltips, and never text that can sit over an interactive control.
 *
 * WHY THIS NEEDS A BROWSER AT ALL. `tests/tooltipCursor.test.mts` already pins the code shape —
 * no file that draws the ledger may mount a popper — and that guard is the one that cannot rot.
 * But "the code mounts no Tooltip" and "the control is clickable" are different claims, and only
 * the second is what the user reported. This spec asserts the second directly: hover the exact
 * anchors that used to open the card, then ask the DOM what is actually on top of the Sort
 * control (`elementFromPoint`), then change the order with a real click.
 *
 * WHAT IT READS (JOS-29): `tests/fixtures/e2e-deep-link.log` — the committed fixture whose loot
 * lines already fill this ledger for `deep-link-back.e2e.mts`. Reusing it costs no new cut and no
 * live log; the strip step is guarded with a `note` because whether a pickup is NOTABLE depends
 * on an item-knowledge lookup, which is allowed to come back empty on an offline machine.
 *
 * MEASURED AGAINST THE BROKEN CODE (2026-08-09, this fixture, this harness): reverting only the
 * renderer half of the fix turns "hovering the notable-pickups chip opens no tooltip popper at
 * all" red — `poppers=1` — and green again with it. Say which of the two checks earns that: the
 * POPPER COUNT is the one that reproduced. The `elementFromPoint` check beside it passed even
 * while the card was up, because where a popper lands is a function of the window's size and this
 * window is a fixed 1280 that the owner's is not. So the geometry check is the statement of what
 * the user is owed (their click reaches the select) and the count is the tripwire that catches
 * the regression at any width. Neither is redundant, and neither is the whole guard —
 * `tests/tooltipCursor.test.mts` pins the code shape that makes both true.
 *
 * WHY IT NEVER TAKES THE SCREEN: `EQ_E2E=1` (src/main/e2e.ts) shows no window, skips the
 * single-instance lock, and points `userData` at a throwaway temp dir minted per launch.
 *
 * Run: `npm run test:e2e -- loot-sort`.
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
  reportRun,
  settleCount,
  settleStable,
  waitHydrated
} from './appHarness.mjs'
import { mainWindow } from './appWindow.mjs'
import { launchOnFixture } from './logFixture.mjs'
// The app-wide timeslice's loot half (JOS-130) — next door, like every other step module here.
// `stepNewSession` is JOS-436's, and it rides this spec for the same reason: it is a LEDGER
// surface, and it needs the ledger in the state a user first sees it in.
import { stepLootSlice, stepNewSession } from './sliceSteps.mjs'
// JOS-322's step, next door again: the SAME button, now proving it moves the combat engine's own
// Overall picker as well as the ledger's. It rides this spec because this is where the button is.
import { stepOneClickSplitsBoth } from './sessionSplitSteps.mjs'

const GRID = '[data-testid="overview-grid"]'
const LOOT_LIST = '[data-testid="loot-list"]'
const LOOT_ROW = '[data-testid="loot-row"]'
/** The item NAME inside a row — the anchor the item card used to hang from. */
const LOOT_NAME = '[data-testid="loot-item-name"]'
const SORT = '[data-testid="loot-sort"]'
/** The clickable half of a MUI `TextField select` — the div that opens the menu. */
const SORT_BUTTON = `${SORT} [role="combobox"]`
const SORT_OPTION = 'li[role="option"]'
/** Any MUI tooltip popper, whoever mounted it. The ledger must mount none. */
const POPPER = '.MuiTooltip-popper'
/** A notable-pickups chip: the other anchor that used to open a card over the toolbar. */
const PICKUP = '[data-testid="loot-list"] .MuiChip-clickable'

function appears(page: Page, sel: string, ms = 20_000): Promise<boolean> {
  return page.waitForSelector(sel, { timeout: ms }).then(
    () => true,
    () => false
  )
}

/**
 * What is REALLY on top of the Sort control right now — the tag of whatever
 * `elementFromPoint` finds at its centre, and whether that node is inside the control.
 *
 * This is the assertion the ticket is about. A `countOf(POPPER) === 0` alone would pass on a
 * popper that mounted somewhere harmless; asking the geometry says the thing the user cares
 * about, which is that their click reaches the select.
 */
function whatCoversSort(page: Page): Promise<{ tag: string; inside: boolean }> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return { tag: 'none', inside: false }
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
    if (!hit) return { tag: 'none', inside: false }
    return { tag: hit.tagName.toLowerCase(), inside: el.contains(hit) || hit === el }
  }, SORT)
}

/** The order the select is showing, as the user reads it. */
function sortValue(page: Page): Promise<string> {
  return page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText.trim() ?? '',
    SORT_BUTTON
  )
}

/** Land, let the startup replay finish, and open the Loot tab on its ledger. */
async function stepReady(page: Page): Promise<void> {
  if (!check('the app lands on the Overview', await appears(page, GRID, 60_000))) {
    throw new Error('never landed on Overview — nothing below can be asserted')
  }
  const { snap } = await waitHydrated(page)
  if (!check('hydration completes (the replay has filled the loot ledger)', !snap.hydrating)) {
    throw new Error('still hydrating — nothing below can be asserted')
  }
  await page.click('[data-testid="nav-loot"]', { timeout: 15_000 })
  if (!check('the Loot tab opens on its ledger', await appears(page, LOOT_LIST))) {
    throw new Error('no loot ledger — nothing below can be asserted')
  }
  check('…with the grouped table’s Sort control mounted', await appears(page, SORT))
}

/**
 * HOVER THE ANCHORS THAT USED TO EAT THE CLICK, then look at what is over the control.
 *
 * `settleStable` on the popper count is how the absence is asserted (wave E3's law): wait for the
 * reading to stop moving — which covers the shared Tooltip's `enterDelay` several times over —
 * and only then claim nothing is there.
 */
async function stepNothingCoversSort(page: Page, sel: string, what: string): Promise<void> {
  if ((await countOf(page, sel)) === 0) {
    note(`no ${what} in this run — that anchor could not be hovered`)
    return
  }
  if (!(await hoverAt(page, sel, 0.5, 0.5))) {
    note(`could not put the pointer on the ${what}`)
    return
  }
  const poppers = await settleStable(() => countOf(page, POPPER), { timeoutMs: 4000 })
  check(`hovering the ${what} opens no tooltip popper at all`, poppers === 0, `poppers=${String(poppers)}`)
  const cover = await whatCoversSort(page)
  check(
    `…and the Sort control is still the topmost thing at its own centre (${what})`,
    cover.inside,
    `elementFromPoint hit <${cover.tag}>`
  )
}

/**
 * THE USER'S SENTENCE, END TO END: change the order and have it change.
 *
 * Both orders are asserted by NAME rather than by index, because "cannot get off last-looted" is
 * the report — the value has to actually become the other one.
 */
async function stepSortChanges(page: Page): Promise<void> {
  const before = await sortValue(page)
  if (!check('the Sort control states an order to begin with', before.length > 0, before)) return
  await page.click(SORT_BUTTON, { timeout: 15_000 })
  const options = await settleCount(page, SORT_OPTION, 2, { timeoutMs: 10_000 })
  if (!check('clicking it opens the order menu', options >= 2, `options=${String(options)}`)) return

  const labels = await page.evaluate(
    (sel) => [...document.querySelectorAll(sel)].map((o) => (o as HTMLElement).innerText.trim()),
    SORT_OPTION
  )
  const other = labels.find((l) => l !== before)
  if (!check('…offering an order other than the one already chosen', other != null, labels.join(' | '))) return

  await page.click(`${SORT_OPTION} >> text="${other ?? ''}"`, { timeout: 15_000 })
  const after = await settleStable(() => sortValue(page), { timeoutMs: 6000 })
  check('…and picking it actually changes the order', after === other, `${before} -> ${after}`)

  const stored = await page.evaluate(() => localStorage.getItem('eq.lootSort'))
  check('…and the choice is remembered for the next launch', stored != null, String(stored))
}

/** The rows are still the drill-down's way in — removing the hover must not have cost the click. */
async function stepRowStillDrills(page: Page): Promise<void> {
  if ((await countOf(page, LOOT_ROW)) === 0) {
    note('the ledger has no row to open this run')
    return
  }
  await page.click(LOOT_ROW, { timeout: 15_000 })
  check('a ledger row still opens that item’s drill-down', await appears(page, '[data-testid="loot-detail"]'))
}

async function main(): Promise<void> {
  buildIfStale()

  console.log('launch: hidden Electron (EQ_E2E=1) against tests/fixtures/e2e-deep-link.log…')
  // `log` is the staged copy the app is tailing — JOS-436's step LOOTS SOMETHING through it, which
  // is the only way to prove a new session accrues from the click rather than from the last line
  // the fixture happened to carry.
  const { app, close, log } = await launchOnFixture('e2e-deep-link.log')

  let page: Page | null = null
  try {
    page = await mainWindow(app)
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    await stepReady(page)
    await stepNothingCoversSort(page, LOOT_NAME, 'first row’s item name')
    await stepNothingCoversSort(page, PICKUP, 'notable-pickups chip')
    await stepSortChanges(page)
    // BEFORE the drill: that step takes the pane over and the ledger unmounts with it. The slice
    // control is a ledger surface, and it must be read in the state a user first sees.
    await stepLootSlice(page)
    // AFTER the slice step, which reads the ledger on `All` and needs it untouched, and BEFORE the
    // drill, which unmounts the whole bar. It leaves the ledger back on `All` for that step.
    await stepNewSession(page, log)
    // AFTER it, because it presses the same button a second time and reads the DELTA — and still
    // before the drill, which unmounts the whole bar.
    await stepOneClickSplitsBoth(page, log)
    await stepRowStillDrills(page)

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

    await dumpArtifacts(page, failures.length ? 'loot-sort-FAIL' : 'loot-sort-pass')
  } finally {
    await close()
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
