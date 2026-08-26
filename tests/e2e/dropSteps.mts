// THE IN-WINDOW DROPS STEPS of the leveling spec (JOS-78), living next door because
// leveling.e2e.mts sits AT the repo max-lines budget and the rule here is to SPLIT, never ratchet
// (drill.mts set the precedent; combatSteps.mts and plannerSteps.mts followed it). The spec still
// owns the ORDER and the launch.
//
// WHAT THIS PROVES THAT NO UNIT TEST CAN. `tests/lootRates.test.mts` pins the arithmetic — the
// zone join, the half-open window, the active-time denominators, the ordering. What it cannot
// reach is the SEAM: that a loot line written into the tailed file travels the real path
// (chokidar → Tailer → parseEvent → LogBus → loot module → IPC → render) into a panel scoped by
// the very same `ScopedStats` the range panel reads, and that clicking a row there goes THROUGH
// the app's own `openLoot` opener — which is the only reason the drill's Back can say "Back to
// Leveling" and mean it (JOS-43: one navigation seam, never a per-view `cameFrom` prop).
//
// THE FIXTURE CARRIES NO LOOT AT ALL (e2e-leveling.log was cut for the charts), so the harness
// PLAYS it: `playLootDrops` appends four real dashed loot lines, three of one item and one of
// another, which is also what makes the ORDER assertable — a run where everything dropped once
// could not tell a sorted list from an unsorted one.
//
// WHY IT RUNS LAST among the chart steps: appending loot moves the progression module's activity
// stream (loot is one of the three columns `idleSpans` walks), so every "byte-identical" reading
// the timescale step takes must already be behind us.

import type { Page } from 'playwright-core'
import { check, countOf, note, rectOf, settle, settleCount } from './appHarness.mjs'
import { DROP_COUNT, DROP_ITEM, playLootDrops } from './gameplay.mjs'
import type { FixtureLog } from './logFixture.mjs'

export const DROPS = '[data-testid="leveling-drops"]'
export const DROPS_EMPTY = '[data-testid="leveling-drops-empty"]'
export const DROP_ROW = '[data-testid="leveling-drop-row"]'
export const DROP_ITEM_LINK = '[data-testid="leveling-drop-item"]'
export const LEVELING_VIEW = '[data-testid="leveling-view"]'
export const LOOT_DETAIL = '[data-testid="loot-detail"]'
export const LOOT_BACK = '[data-testid="loot-back"]'
export const LOOT_TITLE = '[data-testid="loot-detail-title"]'
export const ITEM_ZONE_TABLE = '[data-testid="item-zone-table"]'
export const ITEM_ZONE_ROW = '[data-testid="item-zone-row"]'

/** Rendered text of the first match; '' when the node isn't mounted. */
function textOf(page: Page, sel: string): Promise<string> {
  return page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '', sel)
}

/**
 * 8. THE DROPS PANEL — mounted with the tab, empty-but-STATED before anything drops, and filled by
 * loot that travels the real path.
 *
 * The empty state is asserted FIRST and on purpose: "no drops in the whole log" is the reading a
 * silently blank box would be indistinguishable from, and this fixture genuinely has none until
 * the harness plays some.
 *
 * Returns the row text, or null when the panel never filled (which downstream steps need to know).
 */
async function stepDropsPanel(page: Page, log: FixtureLog): Promise<string | null> {
  if (!check('the in-window drops panel is mounted with the Leveling tab', (await countOf(page, DROPS)) === 1)) {
    return null
  }
  const before = await countOf(page, DROP_ROW)
  if (before === 0) {
    check(
      '…and with no loot in range it STATES the empty window rather than drawing a blank box',
      (await countOf(page, DROPS_EMPTY)) === 1,
      (await textOf(page, DROPS_EMPTY)).replace(/\s+/g, ' ')
    )
  }

  // Play the drops into the tailed file. They travel chokidar → Tailer → parser → loot module →
  // IPC → render, exactly as a real pull's would.
  const written = playLootDrops(log)
  const rows = await settleCount(page, DROP_ROW, before + 1, { timeoutMs: 20_000 })
  if (!check(`${String(written)} looted lines reach the panel through the live tail`, rows > before, `${String(before)} → ${String(rows)} rows`)) {
    return null
  }

  // ORDER IS THE OBSERVATION: three of one item beat one of another, so the mote is the top row.
  // Its COUNT is asserted exactly, because the harness wrote it.
  //
  // AND THE WAIT IS FOR THE COUNT, NOT FOR THE ROW (JOS-490). `settleCount` above settles on a row
  // EXISTING, which is a different condition from the one asserted below — so the read could land
  // between the first drop reaching the panel and the third. That was never observable while the
  // snapshot was a synchronous main-process call; with the engine serving `module:getSnapshot` the
  // hydrate is a loopback round trip, which widens the window enough to catch it, and the suite did:
  // MEASURED on this ticket, the panel read `Mote of Major Potential 1× 0.00 drops/hr` here and
  // `3× 0.01 drops/hr` eight seconds later, off a fold that deep-equals the app's at a matched seq.
  // Nothing about the assertion changes — this waits for the state it is about, which is the repo's
  // own law (AGENTS.md: wait for the CONDITION, never for the clock).
  const top = (
    await settle(
      () => textOf(page, DROP_ROW),
      (t) => t.replace(/\s+/g, ' ').includes(`${String(DROP_COUNT)}×`),
      { timeoutMs: 20_000 }
    )
  ).replace(/\s+/g, ' ')
  check('…ordered by observed drops — the item that dropped three times is the top row', top.includes(DROP_ITEM), top)
  check(`…stating its in-window count exactly (${String(DROP_COUNT)} of them were written)`, top.includes(`${String(DROP_COUNT)}×`), top)
  // A RATE NEVER APPEARS WITHOUT ITS SPAN, AND THE SPAN NAMES ITS HOUR: the panel's single caption
  // is the denominator every row divides by, and the row itself carries either a rate or the
  // em-dash. Since JOS-288 that hour is the tab's basis pick rather than always the active one —
  // the default is `elapsed`, the toggle is `leveling-basis`, and `tests/rateBasis.test.mts` pins
  // which number each word produces. What this spec asserts is the honesty rule itself: a span is
  // stated, and it says WHICH hour it is, so a rate can never appear as a bare "per hour".
  const panel = (await textOf(page, DROPS)).replace(/\s+/g, ' ')
  check(
    '…over a STATED span that names its hour (a rate without its denominator is a claim, not a measurement)',
    /over .+ (elapsed|active)/.test(panel),
    panel.slice(0, 120)
  )
  check('…and every row carries a rate or an honest em-dash, never a bare count', /drops\/hr|—/.test(top), top)
  return top
}

/**
 * 9. THE ROUND TRIP — the JOS-43 law, exercised on the newest link in the app.
 *
 * Clicking an item opens the Loot tab's drill-down, whose Back must NAME the Leveling tab and
 * return there. The aria-label is read BEFORE the click, because "Back to the loot list" on a
 * deep-linked drill is the reported bug whatever the click then happens to do.
 *
 * The drill's own per-zone table is asserted on the way through: the item was just looted in the
 * fixture's live zone, so it has at least one zone row with a count.
 */
async function stepDropRoundTrip(page: Page): Promise<void> {
  if (!check('the top drop row is a link', (await countOf(page, DROP_ITEM_LINK)) > 0)) return
  // The box is REPORTED, not merely required: the one way this click fails is the panel being
  // squeezed to a clipped strip by the two panels sharing its column, and a row that is in the
  // DOM with no height looks identical to a broken handler in the failure line.
  const box = await rectOf(page, DROP_ITEM_LINK)
  const clicked = await page.click(`${DROP_ITEM_LINK} >> nth=0`, { timeout: 15_000 }).then(
    () => true,
    () => false
  )
  if (!check('clicking an item in the drops panel navigates', clicked, box ? `${String(box.w)}×${String(box.h)}px` : 'no box')) {
    return
  }
  const opened = await page.waitForSelector(LOOT_DETAIL, { timeout: 30_000 }).then(
    () => true,
    () => false
  )
  if (!check('…opening that item’s Loot drill-down', opened)) return
  check('…on the item that was clicked', (await textOf(page, LOOT_TITLE)).includes(DROP_ITEM), await textOf(page, LOOT_TITLE))

  // THE DRILL'S OWN HALF OF THE TICKET: where it drops for you, with a rate.
  const table = await settleCount(page, ITEM_ZONE_TABLE, 1, { timeoutMs: 15_000 })
  if (check('the drill-down draws the per-zone drop table', table === 1)) {
    const zoneRows = await settleCount(page, ITEM_ZONE_ROW, 1, { timeoutMs: 15_000 })
    check('…with a row for the zone it was just looted in', zoneRows > 0, `${String(zoneRows)} zone rows`)
    // THE SAME CORRECTION AS THE PANEL ABOVE (JOS-490), and for the same reason: `settleCount`
    // settles on the ROW existing, and what is asserted is what the row SAYS. This table's rate is
    // divided by ACTIVE time, which lands a beat after the row itself does, so the existing wait
    // could read a row whose Rate and Active cells were still placeholders — observed on this
    // ticket as `Nagafen's Lair 3 - -`. The predicate is now the assertion.
    const text = (
      await settle(
        () => textOf(page, ITEM_ZONE_TABLE),
        (t) => /drops\/hr|—/.test(t),
        { timeoutMs: 20_000 }
      )
    ).replace(/\s+/g, ' ')
    check('…and each row states a rate or an honest em-dash', /drops\/hr|—/.test(text), text.slice(0, 140))
  }

  // The affordance states its destination BEFORE it is pressed — the assertion that cannot pass
  // by accident.
  const label = (await page.getAttribute(LOOT_BACK, 'aria-label')) ?? ''
  check('the drill’s Back NAMES the tab it will return to', label === 'Back to Leveling', `"${label}"`)
  await page.click(LOOT_BACK, { timeout: 15_000 })
  const home = await settle(() => countOf(page, LEVELING_VIEW), (n) => n > 0, { timeoutMs: 20_000 })
  check('…and pressing it returns to the Leveling tab', home > 0)
  const backPanel = await settleCount(page, DROPS, 1, { timeoutMs: 15_000 })
  if (backPanel !== 1) note('the drops panel did not re-mount on return — the tab re-derives its scope on arrival, so this is worth a look')
  check('…with the drops panel still there', backPanel === 1)
}

/**
 * Steps 8 and 9, in order and as ONE entry point: the round trip is only meaningful once the
 * panel has a row to click, so the spec states the intent and this file owns the dependency
 * between them — which is also what keeps the caller inside the repo's `max-depth 3`.
 */
export async function stepDrops(page: Page, log: FixtureLog): Promise<void> {
  if ((await stepDropsPanel(page, log)) === null) return
  await stepDropRoundTrip(page)
}
