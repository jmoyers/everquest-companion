/**
 * Headless Electron integration test for the LEVELING tab
 * (docs/plans/leveling-analytics.md §8, "Final verification").
 *
 * WHY ITS OWN FILE: one spec per surface, all of them sharing `appHarness.mts` and running back
 * to back from `npm run test:e2e`. `EQ_E2E=1` (src/main/e2e.ts) shows no window, skips the
 * single-instance lock and points `userData` at a throwaway temp dir, so this runs invisibly
 * beside the user's game and dev app.
 *
 * WHY `userData` IS WIPED FIRST: several assertions here are about the state the tab comes up
 * in. Nothing about a selection or a timescale is persisted today (both are session-lifetime
 * component state, deliberately), but a fresh dir is what makes "before any interaction" mean
 * the same thing on every machine and after every earlier spec — which is what a per-launch
 * userData dir now guarantees for free.
 *
 * WHAT IT ASSERTS, against whatever the real log holds right now:
 *   1. the nav row mounts the view (or the no-logs empty state honestly explains why not);
 *   2. a chart is drawn, and the ZONE-BAND STRIP is mounted inside it with real bands;
 *   2b. (JOS-292) the level chart draws the FRACTIONAL CURVE - denser than the ding series it is
 *      anchored on, inside its own plot, with an uncertainty band over every stretch the log did
 *      not state, no vertex inside one, and a readout that says so rather than naming a bar
 *      position there. Step 2b lives in `curveSteps.mts`;
 *   3. the range-stats panel is mounted with the view and scoped to the TIMESCALE'S WINDOW
 *      (JOS-75 — it used to exist only while a drag did);
 *   4. a real pointer DRAG across the chart narrows that scope to the selection, and the panel
 *      re-derives WITH rows (hero cards + at least one per-zone row — `Σ zones[].spanMs ==
 *      durationMs` means a committed range always covers at least one zone row, even if it is
 *      the `unknown` one);
 *   5. a CLICK (under `DRAG_THRESHOLD_PX`) drops the selection and the panel FALLS BACK to the
 *      window, restoring exactly the numbers it had before the drag — the precedence contract;
 *   5b. the TIMESCALE control (JOS-71) offers only the windows this log can fill, and picking one
 *      replaces the whole time base: the strip re-cuts itself and stays inside its plot, the
 *      hover still resolves a cursor, a drag still commits a range and a click still dismisses it,
 *      and `All` restores the exact window it started on;
 *   5c. and (JOS-75) the DASHBOARD NUMBERS move with it — the range panel's stated stretch, its
 *      readouts and the AA pace panel all re-derive on a window change, dominate correctly
 *      (a window inside another can never count more), and come back BYTE-IDENTICAL at `All`;
 *   6. the "New at this level" panel is mounted with its stepper — and, once the combo module
 *      has resolved a loadout, draws real unlock rows for it (floors, never today's counts);
 *   6a. (JOS-391) and each spell row says what the spell is WORTH: compact damage/heal figures per
 *      mana, the `already yours (CLS N)` claim naming a level below the one on screen, the spell it
 *      replaces from the shipped line research, and the word `directional` said exactly ONCE on
 *      the panel rather than footnoted per row. Step 6a lives in `unlockRowSteps.mts`;
 *   6c. (JOS-392) the spell a row says it REPLACES is a hover target of its own, and the card that
 *      opens is that spell's - carrying the figures main read for it;
 *   6d. (JOS-392) and typing `27-28 cleric shaman` turns the panel into the matching spells, each
 *      row's chips stating the level each class gets it at, in any word order - then clearing the
 *      box gives the level view back. Steps 6c/6d live in `unlockRowSteps.mts` too;
 *   6e. (JOS-393) and a spell the wiki badges out of era is FOUND by that search and MARKED - the
 *      chip on the row, the same words on its card - while its in-era sibling one rung down the
 *      same ladder wears nothing;
 *   7. (JOS-289) THE WHOLE PAGE SCROLLS AND NO PANEL DOES: the window itself never scrolls, no
 *      panel on the tab shows an internal vertical scrollbar except the drops list whose row count
 *      earns one, and the deepest panel is reached by scrolling the PAGE. No renderer console
 *      errors either;
 *   7b. and at the narrowest window the app allows, the two columns STACK instead of sharing one
 *      height (JOS-151's collision, which JOS-289 removed the cause of): no panel draws over
 *      another, the stack is not a scroller, and both the timeslice control and the unlock stepper
 *      are still the thing at their own centre;
 *   7c. and a spell name in the per-level readout opens the full spell card. Steps 7/7b/7c live in
 *      `levelingLayoutSteps.mts`;
 *   8. (JOS-78) the IN-WINDOW DROPS panel is mounted with the tab, states its empty window rather
 *      than drawing a blank box, and fills from loot the harness plays into the tailed file —
 *      ordered by observed drops, each row stating a count and a rate over a STATED span that
 *      names its hour (JOS-288: elapsed by default, active behind the tab's basis toggle);
 *   9. and clicking a row opens that item's Loot drill-down (with its own per-zone drop-rate
 *      table) through the app's ONE navigation seam, so Back NAMES the Leveling tab and returns
 *      here (the JOS-43 law, on the app's newest cross-view link). Steps 8/9 live in
 *      `dropSteps.mts` — this spec is at the repo's max-lines budget;
 *   10. (JOS-450) and the best-spells readout SEARCHES the whole catalog: typing swaps its ranked
 *      table for results, a spell no class in this loadout can learn is drawn as a row of that
 *      readout wearing its own class-level chip, and clearing the box hands the table back. It runs
 *      inside step 6f's sequence and lives in `bestSpellsSearchSteps.mts`.
 *
 * FRESH-MACHINE HONESTY. A machine with no EQ logs mounts no feature view at all, and a
 * character whose log carries fewer than two dings and fewer than two AA gains draws no chart —
 * `LevelingView` renders its stated empty state instead. Both are the CORRECT behaviour: the
 * spec detects them, asserts the honest EMPTY-state versions of the above (the view mounts, the
 * empty state says why, and no stats panel exists), `note()`s what it saw, and skips the
 * assertions that presuppose a drawn chart.
 *
 * Floors and identities only, never today's numbers (AGENTS.md: frozen numbers rot).
 *
 * Run: `npm run test:e2e`.
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
  rectOf,
  reportRun,
  settle,
  settleCount,
  settleGone,
  waitHydrated
} from './appHarness.mjs'
import { mainWindow } from './appWindow.mjs'
import { launchOnFixture } from './logFixture.mjs'
// The in-window drops panel and its round trip into the item drill-down (JOS-78) — next door
// because this spec sits AT the repo max-lines budget; see that file's header.
import { stepDrops } from './dropSteps.mjs'
import { stepScopeDefaults, stepZoneSlice } from './sliceSteps.mjs'
// The layout contract, the spell card in the per-level readout and the narrow window (JOS-289,
// which inverted JOS-151's claim here) — next door for the same reason, and see that file's header
// for what the reporter's 1073x937 did to this tab and what the owner overturned afterwards.
import { dismissFirstRunNotice, stepNarrowLayout, stepPageScroll, stepSpellCard } from './levelingLayoutSteps.mjs'
// WHAT A POINTERMOVE COSTS (JOS-290) — the drag-responsiveness pin, next door because this file
// is at the repo's line budget. It measures inside the same gesture it asserts about.
import { stepDragCost } from './dragPerfSteps.mjs'
// THE FRACTIONAL CURVE (JOS-292) — the vertices, the uncertainty bands, and the readout standing
// on one. Next door for the same line-budget reason; see that file's header.
// …and (JOS-339) THE CAMERA beside them: three PNGs of the chart column at three window shapes,
// for an owner who has to rule on how the plots LOOK. Same file — same two plots.
import { stepChartShots, stepLevelCurve } from './curveSteps.mjs'
// THE "NEW AT THIS LEVEL" PANEL, both halves — the join (step 6) and what a row is WORTH beside
// it (step 6a, JOS-391: the figures, `already yours`, `replaces`, and the one `directional` in
// the header). Next door for the same line-budget reason; the pair is one question about one
// panel, and this spec still owns the order and the launch.
import { shootUnlockPanel, stepNewAtLevel, stepUnlockEra, stepUnlockSearch } from './unlockRowSteps.mjs'
// THE RIGHT COLUMN'S READOUT (JOS-445) — best damage by dps, best healing by hps, at the level the
// tab is showing. Next door for the same line-budget reason; it asserts the SEAM the unit suite
// cannot reach (the lines crossing IPC, one stepper driving two columns, a header click re-ranking).
import { shootBestSpells, stepBestSpells } from './bestSpellsSteps.mjs'

const NAV = '[data-testid="nav-leveling"]'
const VIEW = '[data-testid="leveling-view"]'
const EMPTY = '[data-testid="leveling-empty"]'
const AA_CHART = '[data-testid="leveling-aa-chart"]'
const LEVEL_CHART = '[data-testid="leveling-level-chart"]'
const BANDS = '[data-testid="leveling-zone-bands"]'
const BAND = '[data-testid="leveling-zone-band"]'
const LEGEND_ROW = '[data-testid="leveling-zone-legend-row"]'
const PANEL = '[data-testid="leveling-range-stats"]'
/** The panel's stated stretch — the two instants its numbers cover (JOS-75). */
const PANEL_RANGE = '[data-testid="leveling-range-window"]'
const AA_PACE = '[data-testid="leveling-aa-pace"]'
// The "New at this level" selectors moved with steps 6/6a into `unlockRowSteps.mts`.
// The app-wide TIMESLICE control (JOS-130) — it absorbed the tab's own timescale, so the duration
// rungs are four ids among nine and the testid prefix names the surface rather than the feature.
const TIMESCALE = '[data-testid="leveling-slice"]'
const TS_WINDOW = '[data-testid="leveling-slice-window"]'
/**
 * The narrowest slice that REPLACES THE DRAWN WINDOW, most-narrow first — which is what step 5b
 * is about (a new time base: the strip re-cuts, a stale selection is dropped, the hover re-maps).
 *
 * `Zone` is deliberately not a candidate: it narrows the NUMBERS and leaves the window alone by
 * design, so it would fail assertions that are correct about every other slice. It gets its own
 * step (`stepZoneSlice`) that asserts exactly the opposite pair.
 */
const NARROW_ORDER = ['h1', 'h6', 'h24', 'd7', 'session'] as const
const TOOLTIP = '[data-testid="chart-tooltip"]'
const HERO = '[data-testid="leveling-range-hero"]'
const ZONE_ROW = '[data-testid="leveling-range-zone-row"]'
const LEDGER = '[data-testid="aa-ledger"]'
const LEDGER_ROW = '[data-testid="aa-ledger-row"]'
const LEDGER_RUNG = '[data-testid="aa-ledger-rung"]'
const LEDGER_TOTAL = '[data-testid="aa-ledger-total"]'
const HERO_AA_SPENT = '[data-testid="leveling-hero-aa-spent"]'

/** Rendered text of the first match; '' when the node isn't mounted. */
function textOf(page: Page, sel: string): Promise<string> {
  return page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '', sel)
}

/** The FIRST integer in a rendered string, thousands separators removed; null when there is none. */
function numIn(text: string): number | null {
  const m = /\d[\d,]*/.exec(text)
  return m ? Number(m[0].replace(/,/g, '')) : null
}

/** Poll a predicate until it holds or the deadline passes. Everything here lands asynchronously. */
function until(fn: () => Promise<boolean>, ms: number): Promise<boolean> {
  return settle(fn, (ok) => ok, { timeoutMs: ms })
}

/**
 * A REAL pointer drag across `sel`, left to right, through the harness's own `hoverAt` — real
 * `pointerdown`/`pointermove`/`pointerup` with genuine `buttons` state, because that is exactly
 * what `useChartSelection` reads (pointer capture on the wrapper, a `DRAG_THRESHOLD_PX` gate,
 * and a `MIN_SELECTION_MS` floor under which the drag is DISCARDED). A synthesized event would
 * prove nothing about that seam.
 *
 * The intermediate move matters: the threshold flips `dragging` on the first move past 5px and
 * the draft band tracks every one after it, so a single teleporting move would exercise only
 * half the hook.
 *
 * Fractions are wide on purpose (10% → 90%): the domain spans the whole fixture, so any sizeable
 * fraction of it is far past the 60-second minimum selection.
 *
 * THE RED THIS SPEC WAS FILED AGAINST LIVED IN `hoverAt`, not here (JOS-29). The level chart is
 * the SECOND panel in a column that owns its own scroll, so its box routinely sits partly below
 * that column's visible bottom — and the old helper clamped only to the WINDOW. MEASURED
 * 2026-08-06: box at y 838..994 in an 860-tall window, drag point computed at y=848, which
 * `elementFromPoint` resolves to the app's content area. The pointer handlers never saw a single
 * event; the harness had been dragging a different element for as long as this spec existed.
 * `hoverAt` now scrolls the element into view, intersects with every clipping ancestor, and
 * verifies the point actually lands inside — so this function is unchanged in intent and finally
 * true in fact.
 */
async function dragRange(page: Page, sel: string): Promise<boolean> {
  if (!(await hoverAt(page, sel, 0.1, 0.5))) return false
  await page.mouse.down()
  await hoverAt(page, sel, 0.5, 0.5)
  // THE CHART-INTERACTION SEAM, read mid-gesture: the hover layer binds pointermove only and
  // bails while `ev.buttons !== 0`, and `useChartSelection` additionally flows `dragging` down as
  // `suppressed`. A tooltip here is the regression — and it is asserted at EVERY timescale,
  // because the seam is what a new window is most likely to break.
  const held = await countOf(page, TOOLTIP)
  await hoverAt(page, sel, 0.9, 0.5)
  await page.mouse.up()
  check('a range drag suppresses the hover tooltip (the pointer seam)', held === 0, `${String(held)} tooltip(s) mid-drag`)
  return true
}

/** The slice ids the control is offering — `all` and `custom` always, plus whatever this
 *  character's log can define. The caption (`-window`) and the custom range's two inputs
 *  (`-custom-from` / `-custom-to`) share the prefix and are not ids; no SliceId carries a hyphen,
 *  which is what that filter is reading. */
function offeredScales(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="leveling-slice-"]'))
      .map((e) => (e.getAttribute('data-testid') ?? '').replace('leveling-slice-', ''))
      .filter((id) => id.length > 0 && id !== 'window' && !id.includes('-'))
  )
}

/** How many zone bands are drawn OUTSIDE their own plot — the law-9 tripwire (see stepTimescale). */
function bandsOutsidePlot(page: Page): Promise<number> {
  return page.evaluate((s) => {
    const rects = Array.from(document.querySelectorAll<SVGRectElement>(s))
    return rects.filter((r) => {
      const vb = r.ownerSVGElement?.viewBox.baseVal.width ?? 0
      const x = r.x.baseVal.value
      const w = r.width.baseVal.value
      return x < -0.01 || x + w > vb + 0.01
    }).length
  }, BAND)
}

/**
 * The drawn strip's GEOMETRY, as a comparable string: every band's x and width in viewBox units.
 *
 * A band count is not evidence that the strip moved — the same number of bands can survive a
 * window change by coincidence. The rectangles cannot: they are `xOf(scale, …)` of the strip's own
 * clipped intervals, so if this string is unchanged after a window change, the strip is still
 * drawing the old time base while the curve draws the new one.
 */
function bandSignature(page: Page): Promise<string> {
  return page.evaluate((s) =>
    Array.from(document.querySelectorAll<SVGRectElement>(s))
      .map((r) => `${r.x.baseVal.value.toFixed(1)}+${r.width.baseVal.value.toFixed(1)}`)
      .join(' ')
  , BAND)
}

/**
 * WHICH SCOPE the range-stats panel is showing — `window`, `selection`, or '' when the panel
 * is not mounted at all. The `data-scope` attribute is the view's own answer, so this reads the
 * precedence contract (JOS-75) rather than inferring it from which numbers happen to be there.
 */
function scopeOf(page: Page): Promise<string> {
  return page.evaluate((s) => document.querySelector(s)?.getAttribute('data-scope') ?? '', PANEL)
}

/**
 * THE DASHBOARD READOUT: every windowed number on the tab, as one comparable string.
 *
 * The range panel (its stated stretch, the four hero cards, the chip row and the per-zone table)
 * plus the AA pace panel — i.e. exactly the surfaces JOS-75 bound to the scope. Comparing the
 * whole thing is what makes "All restores the originals" an assertion about the DASHBOARD and
 * not about one lucky number.
 */
async function dashboardReadout(page: Page): Promise<string> {
  const parts = await page.evaluate(
    (sels) => sels.map((s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? ''),
    [PANEL, AA_PACE]
  )
  return parts.join(' ¦ ').replace(/\s+/g, ' ').trim()
}

/** Credited kills as the panel's second hero card states them; null when it is not drawn. */
function killsShown(page: Page): Promise<number | null> {
  return page
    .evaluate((s) => (Array.from(document.querySelectorAll(s))[1] as HTMLElement | undefined)?.innerText ?? '', HERO)
    .then((t) => numIn(t))
}

/** A press-and-release with NO travel — the click gesture, which drops a committed selection. */
async function clickChart(page: Page, sel: string): Promise<void> {
  await hoverAt(page, sel, 0.5, 0.5)
  await page.mouse.down()
  await page.mouse.up()
  // The dismissal's own condition: the panel falls back to the WINDOW scope. Since JOS-75 the
  // panel does not unmount — dropping the selection is the whole observable effect, so waiting
  // for the scope to flip is waiting for the thing under test.
  await settle(() => scopeOf(page), (s) => s !== 'selection', { timeoutMs: 8_000 })
}

// ── the run ───────────────────────────────────────────────────────────────────────────

/** 1. THE NAV ROW MOUNTS THE VIEW. Returns false on the no-logs machine, where nothing does. */
async function stepMount(page: Page): Promise<boolean> {
  const hasRow = await page.waitForSelector(NAV, { timeout: 60_000 }).then(
    () => true,
    () => false
  )
  if (!check('the nav drawer has a Leveling row', hasRow)) return false
  await page.click(NAV, { timeout: 15_000 })
  const mounted = await page.waitForSelector(VIEW, { timeout: 30_000 }).then(
    () => true,
    () => false
  )
  if (!mounted) {
    // The one legitimate reason the view does not mount: no character logs at all, so App's
    // fresh-machine empty state stands in front of every feature view.
    const noLogs = (await textOf(page, 'main')).includes('No EverQuest logs found')
    check('clicking Leveling mounts the view (or the no-logs empty state explains why not)', noLogs)
    if (noLogs) note('no character logs on this machine — the app shows its fresh-machine empty state and no feature view mounts')
    return false
  }
  check('clicking the Leveling nav row mounts the view', true)
  return true
}

/**
 * Wait out the startup replay: until it hands off, every module is still filling.
 *
 * The old copy of this loop ended with a flat `sleep(1500)` "to let the post-hydration render
 * land". What actually has to land is the CHART, and `stepChart` already waits for it — so the
 * guess is simply gone.
 */
async function waitReplayed(page: Page): Promise<void> {
  const { snap, ms } = await waitHydrated(page)
  check('hydration completes (replay hands off to the live tail)', !snap.hydrating, `${String(ms)}ms`)
}

/**
 * 2. A CHART IS DRAWN, or the view's stated empty state says why not.
 *
 * Both outcomes are correct behaviour; only a THIRD outcome (neither) is a failure. Returns the
 * chart to drag on — the level chart when it is drawn, else the AA chart, since either one owns
 * the SAME selection (useChartSelection is called once, in the view).
 */
async function stepChart(page: Page): Promise<string | null> {
  const drawn = await until(async () => (await countOf(page, LEVEL_CHART)) + (await countOf(page, AA_CHART)) > 0, 45_000)
  if (drawn) {
    const sel = (await countOf(page, LEVEL_CHART)) > 0 ? LEVEL_CHART : AA_CHART
    const box = await rectOf(page, sel)
    check(
      'the leveling chart is mounted with real size',
      !!box && box.w > 0 && box.h > 0,
      box ? `${String(box.w)}×${String(box.h)}px` : 'absent'
    )
    return box && box.w > 0 && box.h > 0 ? sel : null
  }
  const emptyText = (await textOf(page, EMPTY)).replace(/\s+/g, ' ').trim()
  check(
    'no chart drawn ⇒ the view states WHY, never a blank pane',
    emptyText.length > 0,
    emptyText.slice(0, 110)
  )
  note('this character’s log carries too few level-ups / AA gains to draw a chart — the stated empty state is the correct surface, and the band-strip and selection assertions are skipped')
  return null
}

/** 3. THE ZONE-BAND STRIP IS MOUNTED — inside the chart, with real bands and a legend. */
async function stepBands(page: Page): Promise<void> {
  const strips = await countOf(page, BANDS)
  const bands = await countOf(page, BAND)
  if (strips === 0) {
    // Correct behaviour when the analytics module has no zone intervals over the domain at all
    // (a log with no `You have entered` line yet). Nothing to draw is not a blank pane.
    note('the progression snapshot carries no zone intervals over this domain — the band strip correctly draws nothing this run')
    return
  }
  check('the zone-band strip is mounted on the chart', strips > 0, `${String(strips)} strip(s)`)
  check('…and it draws real bands (a strip with nothing in it would be a lie)', bands > 0, `${String(bands)} bands`)
  // The identification path that does NOT depend on hover (plan §6.2) — the strip and the
  // legend are two halves of one claim, so a strip without a legend is a half-drawn feature.
  const legend = await countOf(page, LEGEND_ROW)
  check('…and the zone legend names the zones it drew', legend > 0, `${String(legend)} legend rows`)
}

/**
 * 3 + 4 + 5. THE PRECEDENCE CONTRACT — the headline of this spec since JOS-75.
 *
 * The panel is mounted with the view, scoped to the TIMESCALE'S WINDOW. A real drag NARROWS it
 * to the selection — same panel, same derivation, different instants — and the click that drops
 * the selection puts it back on the window with EXACTLY the numbers it had before. Stated as one
 * step because the three readings are only meaningful together: a panel that never changed scope
 * would pass any one of them alone.
 *
 * The restore is asserted on the WHOLE dashboard readout, not just the panel: the AA pace tiles
 * read the same scope, so a drag that moved them and a clear that did not put them back would be
 * the same defect one surface further along.
 */
async function stepSelection(page: Page, chart: string): Promise<void> {
  if (
    !check(
      'the range-stats panel is mounted with the view, scoped to the timescale window',
      (await countOf(page, PANEL)) === 1 && (await scopeOf(page)) === 'window',
      `${String(await countOf(page, PANEL))} panel(s), scope "${await scopeOf(page)}"`
    )
  ) {
    return
  }
  const windowReadout = await dashboardReadout(page)
  const windowKills = await killsShown(page)

  if (!check('the chart is reachable for a drag', await dragRange(page, chart))) return
  const narrowed = await settle(() => scopeOf(page), (s) => s === 'selection', { timeoutMs: 8000 })
  if (!check('dragging a range across the chart narrows the panel to the selection', narrowed === 'selection', narrowed)) {
    return
  }

  // WITH ROWS: the four hero cards, and at least one per-zone row. The zone table is never
  // legitimately empty for a committed range — `Σ zones[].spanMs == durationMs` (plan §4) means
  // the range is fully covered, with an `unknown` row standing in before the first zone line.
  const heroes = await countOf(page, HERO)
  const zones = await countOf(page, ZONE_ROW)
  check('…with its hero stats', heroes > 0, `${String(heroes)} hero cards`)
  check('…and at least one per-zone row (a committed range is always fully covered by zones)', zones > 0, `${String(zones)} zone rows`)

  // A selection is a NARROWER range on the same base, so it can never count more than the window
  // that contains it. An identity, not today's number.
  const selKills = await killsShown(page)
  check(
    'a selection inside the window can never count MORE kills than the window',
    selKills !== null && windowKills !== null && selKills <= windowKills,
    `selection ${String(selKills)} vs window ${String(windowKills)}`
  )

  await clickChart(page, chart)
  check(
    'a click (under the drag threshold) drops the selection and the panel falls back to the window',
    (await scopeOf(page)) === 'window',
    `scope "${await scopeOf(page)}" after the click`
  )
  check(
    '…restoring the window readout byte for byte (clearing is a fallback, never a re-measurement)',
    (await dashboardReadout(page)) === windowReadout
  )
}

/** The full-history dashboard, read before the control is touched — what `All` must restore. */
interface DashboardBaseline {
  readout: string
  range: string
  kills: number | null
}

/**
 * 5c. THE NUMBERS FOLLOWED THE WINDOW (JOS-75) — asserted right after a switch to `narrow`.
 *
 * Two identities, so nothing here rots with the fixture: the panel states the NEW window's own
 * stretch rather than the full history's, and its counts are DOMINATED by the wide window's (a
 * stretch contained in another can never hold more of anything). A fixture whose every kill
 * happens to fall inside the narrow window makes the second reading a legitimate equality, and
 * that is `note`d rather than quietly passed off as proof.
 */
async function stepScopedNumbers(page: Page, narrow: string, base: DashboardBaseline): Promise<void> {
  const range = await settle(() => textOf(page, PANEL_RANGE), (t) => t !== base.range, { timeoutMs: 8000 })
  check(
    `the dashboard states the "${narrow}" window's own stretch, not the full history's`,
    range !== base.range,
    `${base.range} → ${range}`.replace(/\s+/g, ' ')
  )
  const kills = await killsShown(page)
  const known = kills !== null && base.kills !== null
  check(
    '…and its counts are DOMINATED by the wide window (a narrower stretch can never hold more)',
    known && kills <= base.kills,
    `${String(kills)} kills at ${narrow} vs ${String(base.kills)} at All`
  )
  if (known && kills === base.kills) {
    note(
      `every credited kill in this fixture falls inside the "${narrow}" window, so the kills readout is legitimately unchanged — the stated stretch above is what proves the re-derivation`
    )
  }
  check(
    '…and the dashboard as a whole re-derived rather than restating the full-history numbers',
    (await dashboardReadout(page)) !== base.readout
  )
}

/**
 * 5b. THE TIMESCALE (JOS-71) — the window is the user's to pick, and picking one must move the
 * WHOLE time base with it (world-model law 9: one `{t0,t1,bucketMs}` per chart).
 *
 * The three things this asserts that no unit test can:
 *   • the presets on screen are the ones this character's history can FILL — `All` alone on a
 *     short log, more rungs as the log gets longer, and never a rung that would draw empty time;
 *   • every interaction survives the swap. The drag-select range panel, the zone strip, the
 *     legend and the hover tooltip are re-exercised AT THE NARROW SCALE, because a window is
 *     exactly the shared state that lets them start disagreeing about what a pixel means;
 *   • the bands stay INSIDE their plot. `mergeZoneBands` clips to the domain, so a band drawn
 *     past the viewBox edge means the strip is still reading the old window while the curve
 *     reads the new one — the marker-swim shape, caught geometrically instead of by eye.
 *
 * The committed selection from the previous step is expected to be DROPPED by the switch: a range
 * the new window does not contain is not on the chart any more, so the panel falls back to the
 * window (it no longer unmounts — JOS-75).
 *
 * AND THE NUMBERS MOVE WITH IT (JOS-75, the ticket this step grew for). Everything the tab states
 * about a stretch of time is re-derived on the new window: the panel's stated stretch, its hero
 * readouts, its per-zone table and the AA pace tiles. Two things are asserted about that, and
 * both are identities rather than today's numbers — the narrow window's counts are DOMINATED by
 * the wide one's (a window inside another can never count more), and `All` comes back byte for
 * byte, which is the whole "nothing changes for the user who never touches the control" promise
 * stated in pixels instead of prose.
 */
async function stepTimescale(page: Page, chart: string): Promise<void> {
  if (!check('the timescale control is mounted with the charts', (await countOf(page, TIMESCALE)) > 0)) return
  const before = await textOf(page, TS_WINDOW)
  check('…and it states the window on screen', before.includes('→'), before.replace(/\s+/g, ' '))

  const offered = await offeredScales(page)
  check('the slices offered are the ones this log can define', offered[0] === 'all', `[${offered.join(', ')}]`)
  // The narrowest slice this log can actually offer. `custom` is always in the list and is not a
  // change of base until somebody types two instants into it, so it is deliberately not a
  // candidate here — this step is about the control replacing the time base in one click.
  const narrow = NARROW_ORDER.find((id) => offered.includes(id))
  if (!narrow) {
    note(`this log defines no slice narrower than All — it offers only [${offered.join(', ')}] and states the slice`)
    return
  }

  // The full-history dashboard, read BEFORE anything is touched — the state `All` must restore.
  const allReadout = await dashboardReadout(page)
  const allRange = await textOf(page, PANEL_RANGE)
  const allKills = await killsShown(page)

  // A committed range from the WIDE window, so the switch has something to invalidate.
  if (!(await dragRange(page, chart))) return
  await settleCount(page, PANEL, 1, { timeoutMs: 8000 })
  const bandsBefore = await bandSignature(page)

  await page.click(`[data-testid="leveling-slice-${narrow}"]`, { timeout: 10_000 })
  const after = await settle(() => textOf(page, TS_WINDOW), (t) => t !== before, { timeoutMs: 8000 })
  check(`picking "${narrow}" replaces the window wholesale`, after !== before, `${before} → ${after}`.replace(/\s+/g, ' '))
  check(
    'a selection the new window cannot contain is dropped with it',
    (await settle(() => scopeOf(page), (s) => s === 'window', { timeoutMs: 8000 })) === 'window',
    `scope "${await scopeOf(page)}" after the switch`
  )

  await stepScopedNumbers(page, narrow, { readout: allReadout, range: allRange, kills: allKills })

  // Everything still on screen, and still agreeing about the new base.
  const box = await rectOf(page, chart)
  check('the chart still draws at the narrow scale', !!box && box.w > 0 && box.h > 0, box ? `${String(box.w)}×${String(box.h)}px` : 'absent')
  const bands = await countOf(page, BAND)
  check(
    'the zone strip stays inside its plot at the new scale',
    (await bandsOutsidePlot(page)) === 0,
    `${String(bands)} bands, ${String(await countOf(page, LEGEND_ROW))} legend rows`
  )
  check(
    '…and it re-cut itself to the new window (the strip reads the SAME base the curve does)',
    bands === 0 || (await bandSignature(page)) !== bandsBefore
  )

  // Hover, at the new scale: the tooltip reads the cursor back through the SAME base the curve
  // was drawn with, so a card here is the inverse mapping still working.
  if (await hoverAt(page, chart, 0.55, 0.55)) {
    check('the hover readout still resolves a cursor at the narrow scale', (await countOf(page, TOOLTIP)) > 0)
    await page.mouse.move(2, 2)
    await settleGone(page, TOOLTIP, { timeoutMs: 5000 })
  }

  // …and a drag inside the narrow window still narrows the panel and still clears.
  if (await dragRange(page, chart)) {
    const narrowed = await settle(() => scopeOf(page), (s) => s === 'selection', { timeoutMs: 8000 })
    check('dragging a range at the narrow scale narrows the panel', narrowed === 'selection', `${String(await countOf(page, HERO))} hero cards`)
    await clickChart(page, chart)
    check('…and a click clears it back to the window there too', (await scopeOf(page)) === 'window')
  }

  // Back to the default: the control is a view, not a trapdoor.
  await page.click('[data-testid="leveling-slice-all"]', { timeout: 10_000 })
  const back = await settle(() => textOf(page, TS_WINDOW), (t) => t === before, { timeoutMs: 8000 })
  check('returning to All restores the full-history window exactly', back === before, `${back}`.replace(/\s+/g, ' '))
  // THE PROMISE, IN PIXELS: not just the drawn window but every number under it. A user who
  // takes a look through the control and comes back must find the tab exactly as they left it.
  const restored = await settle(() => dashboardReadout(page), (t) => t === allReadout, { timeoutMs: 8000 })
  check(
    '…and every dashboard number with it, byte for byte',
    restored === allReadout,
    restored === allReadout ? '' : `${allReadout.slice(0, 160)} ≠ ${restored.slice(0, 160)}`
  )
}

/**
 * 6b. THE AA LEDGER — and the one assertion no unit test can make: the panel's reconciliation
 * footer and the AA-points-spent HERO CARD are two components rendering the same identity
 * (Σ per-ability invested == `computeAAAccounting().allocated`), so the app is only honest if the
 * two numbers on screen are equal. tests/aaLedger.test.mts pins the maths; this pins the SCREEN.
 *
 * Also exercises the disclosure: a row's rungs do not exist until the row is clicked.
 * Floors and identities only — the real log's ability count grows with play.
 */
async function stepAaLedger(page: Page): Promise<void> {
  const mounted = await page.waitForSelector(LEDGER, { timeout: 20_000 }).then(
    () => true,
    () => false
  )
  // A character who has bought no AA at all renders no ledger, which is the correct surface.
  if (!mounted) {
    note('this character has no AA purchases in the log — the ledger panel is correctly absent')
    return
  }
  const rows = await countOf(page, LEDGER_ROW)
  if (!check('the AA ledger lists per-ability ladders', rows > 0, `${String(rows)} abilities`)) return

  // The two numbers, read from the two components that computed them independently.
  const spentHero = numIn(await textOf(page, HERO_AA_SPENT))
  const footer = await textOf(page, LEDGER_TOTAL)
  const ledgerTotal = numIn(footer)
  check(
    'the ledger footer totals EXACTLY the AA-points-spent hero card (one identity, two components)',
    spentHero !== null && ledgerTotal === spentHero,
    `ledger ${String(ledgerTotal)} vs hero ${String(spentHero)} — "${footer.replace(/\s+/g, ' ')}"`
  )

  // Progressive disclosure: the rungs are not in the DOM until the ability is opened.
  check('a ladder keeps its rungs collapsed until it is asked for them', (await countOf(page, LEDGER_RUNG)) === 0)
  // A click that cannot land is a FAILED CHECK, never a thrown spec: `main` has no catch around
  // its steps, so an escaping TimeoutError kills the whole run — including the assertions after
  // this one and the artifact dump that would explain it.
  const clicked = await page.click(`${LEDGER_ROW} >> nth=0`, { timeout: 10_000 }).then(
    () => true,
    () => false
  )
  if (!check('the top ability row is clickable', clicked)) return
  const rungs = await settleCount(page, LEDGER_RUNG, 1, { timeoutMs: 8_000 })
  check('…and clicking it opens its rungs', rungs > 0, `${String(rungs)} rungs`)
}

async function main(): Promise<void> {
  buildIfStale()

  // See the header: a fresh dir is what makes "before any selection" mean the same thing on
  // every machine, and every launch gets one.
  console.log('launch: hidden Electron (EQ_E2E=1) against tests/fixtures/e2e-leveling.log…')
  // THE INVENTORY DUMP IS STAGED FOR STEP 8's WORN-FOCUS MARKER (JOS-452). The tab itself reads
  // nothing else from it: the gear compare card lives on another surface, and with no dump the
  // best-spells readout is byte-identical to what it was, which is what that step's `note` arm
  // covers. It is the owner's own committed dump, so the focus effects in force are real ones.
  const { app, close, log } = await launchOnFixture('e2e-leveling.log', {
    inventory: 'Primitive_freeport-Inventory.txt',
    // JOS-507 — hand-authored `spells_us.txt` + `dbstr_us.txt` so the readout's search-by-TYPE step
    // holds on any machine rather than only on one with EverQuest installed. It changes nothing the
    // other steps read: the ranked tables and the wiki search are the committed catalog's, and this
    // is a file only the engine's `spells.search` opens.
    clientTables: true
  })

  let page: Page | null = null
  try {
    page = await mainWindow(app)
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    if (await stepMount(page)) {
      // FIRST, because it is a fixed overlay across the bottom of the window and every hover and
      // hit test below asks `elementFromPoint` (see the helper — since JOS-289 the page scrolls
      // and a plot can legitimately park underneath it).
      await dismissFirstRunNotice(page)
      await waitReplayed(page)
      const chart = await stepChart(page)
      if (chart) {
        // FIRST OF THE SCOPE STEPS, and it has to be: it reads what the tab OPENED on (JOS-332,
        // this tier + elapsed), so anything that presses a control has to come after it.
        await stepScopeDefaults(page)
        await stepBands(page)
        // The curve itself (JOS-292), read before any gesture has been made: its vertices, its
        // refusals, and the readout standing on one. It leaves no selection and no tooltip.
        await stepLevelCurve(page, LEVEL_CHART)
        // BEFORE the selection step: that one leaves a range-stats panel mounted in the charts
        // column, and the ledger assertions want the tab in the state a user first sees.
        await stepAaLedger(page)
        await stepSelection(page, chart)
        // AFTER the selection step, which proves the panel works on the default (full-history)
        // window — this one then proves the same gestures survive a wholesale window change.
        await stepTimescale(page, chart)
        // STRAIGHT AFTER IT (JOS-339): that step leaves the tab on `All` with no selection, which
        // is the state the shots open from. It puts the window size and the slice back itself.
        await stepChartShots(app, page)
        // The other half of the same control (JOS-130, sliceSteps.mts): the preset that moves the
        // arithmetic and not the window. It runs AFTER stepTimescale, which leaves the tab on
        // `All`, and takes the spec's own dashboard readout so "byte for byte" means one thing.
        await stepZoneSlice(page, () => dashboardReadout(page))
        // LAST among the chart steps (JOS-78): it APPENDS loot, and loot is one of the three
        // columns the idle classifier walks — so every byte-identical reading above must already
        // be behind us. See dropSteps.mts.
        await stepDrops(page, log)
        // LAST of all: it PROFILES, so anything that runs after it would be measuring this step's
        // leftovers, and it wants the tab in the fullest state the spec ever puts it in (the
        // drops panel is populated by the step above) — which is the state a move used to have
        // to re-render. It commits its own selection and leaves it; nothing below reads one.
        await stepDragCost(page, LEVEL_CHART)
      } else {
        // The empty-state half of the headline assertion still holds, and is the honest thing
        // to assert on a log with no chart: there is no domain, so there is no scope, so there
        // is nothing for the panel to be a read of.
        check('…and with no chart there is no range-stats panel either', (await countOf(page, PANEL)) === 0)
      }
      // Deliberately OUTSIDE the chart branch: the unlock panel is computed from the committed
      // DBs, so it must be there whether or not this log has enough dings to draw a chart.
      await stepNewAtLevel(page, log)
      // …and the OTHER question the same panel answers (JOS-392): typing turns it into a spell
      // finder. It runs here because the step above has resolved the loadout and walked to a level
      // with rows on it, which is the state "clearing restores the level view" is a claim about;
      // it puts the box back empty itself, so everything below still sees the level view.
      await stepUnlockSearch(page)
      // …and (JOS-393) the era verdict on the rows that search returns: `Sloths Healing` is found
      // and MARKED out of era, its card says the same, and `Snails Healing` one rung down the same
      // ladder wears nothing. It runs on the search rather than the level list because the loadout
      // here is whatever this machine's log resolved and a shaman is not guaranteed; the fold
      // itself is pinned over the committed data by tests/spellEra.test.mts. It leaves the box
      // empty, like the step above it.
      await stepUnlockEra(page)
      // Straight after it, on the level that step walked to: the readout's spell names now carry
      // the full card (JOS-293's `SpellTooltip`), which is only usable because the list stopped
      // being a 120px porthole — the two halves of JOS-289 proving each other.
      await stepSpellCard(page)
      // AFTER the whole unlock-panel sequence (JOS-445): those steps resolve the loadout and walk
      // the stepper to a level with rows on it, which is the state this readout is a claim about —
      // and they leave the search box empty, so the stepper is live. It presses the stepper once
      // and presses it back, so nothing below sees a level the steps above did not leave.
      await stepBestSpells(page)
      await stepPageScroll(page)
      // LAST, because it moves the window: it puts the size and the minimum back before it
      // returns, but nothing after it should have to trust that.
      await stepNarrowLayout(app, page)
      // AFTER EVEN THAT (JOS-391): the camera SHOWS the window, and showing it moves the scroll
      // position and stalls compositing — measured, it broke three of the layout checks above
      // when it sat in place after step 6a. It asserts nothing, so it costs nothing here.
      await shootUnlockPanel(app, page)
      // …and the new readout beside it (JOS-445), for the same reason and in the same place: a
      // surface the owner asked for gets a picture. Both cameras run after every measurement.
      await shootBestSpells(app, page)
    }

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

    if (failures.length) await dumpArtifacts(page, 'leveling-FAIL')
    else await dumpArtifacts(page, 'leveling-pass')
  } finally {
    await close()
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
