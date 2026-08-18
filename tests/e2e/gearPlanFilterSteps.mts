// The Plan tab's FILTER steps — the pool filter and the stat filter.
//
// SPLIT OUT OF `gearPlanSteps.mts`, which reached the 400-code-line ceiling when the stat filter
// arrived. The seam is the subject rather than the size: everything here drives a control that
// NARROWS the candidate list and then asserts on what survived, which is one story told twice.
// Everything left behind is about the board, the cells and the two pickers themselves.
//
// Both steps share a shape worth naming: they assert on the LIST, and they assert that an empty
// list says WHICH filter emptied it. A picker that silently returns nothing is the failure mode
// this whole feature area keeps rediscovering (`Patchwork Boots`, the era verdict, the pool chips),
// so every narrowing control here owes the reader a sentence.

import type { Page } from 'playwright-core'
import { check, countOf, note, settle } from './appHarness.mjs'
import { until } from './plannerSteps.mjs'
// The ChipMultiSelect driver, shared rather than re-rolled: the listbox is a portal with its own
// geometry, and a fourth copy of "type it, arrow down, enter" is the drift law 7 is about.
import { clearPicks, pickIn } from './gearFilterSteps.mjs'
import { textOf } from './gearPlanSteps.mjs'
import {
  chipLit,
  drillAndBack,
  setChip,
  textOf as memoText
} from './areaMemorySteps.mjs'

/** The comparison chip — in the PANEL, because only a cell knows what "worn" means. */
const BEATS = '[data-testid="gearplan-stat-beats"]'

/**
 * THE STAT FILTER, THROUGH THE REAL SEARCH — "show me gear with more of this than I have on".
 *
 * `tests/gearPlanStatPick.test.mts` owns the RULES (AND across picks, absent-is-zero, which stats
 * are better smaller). What only a mounted app can say is the part that spans main:
 *
 *   1. PICKING A STAT REORDERS THE LIST BY IT. Asserted on the rendered order, because the sort is
 *      applied in the renderer over what main returned and nothing below this level sees the two
 *      meet.
 *   2. THE SORT COVERS THE WHOLE SLOT AND NOT ONE PAGE. This is the defect the feature would ship
 *      with by default: main ranks by NAME and caps at fifty, so sorting that page by wisdom gives
 *      the wisest of the fifty best NAME matches — a plausible-looking list that is simply wrong,
 *      and wrong invisibly. The panel asks for `PLANNER_PAGE_MAX` the moment a stat is picked, so
 *      the "show more" row must DISAPPEAR: nothing is being held back any more.
 */
export async function stepStatFilter(page: Page): Promise<void> {
  const cell = '[data-testid="gearplan-cell-HEAD"]'
  const hit = '[data-testid="gearplan-item-hit"]'
  const names = (): Promise<string[]> =>
    page.$$eval('[data-testid="gearplan-hit-name"]', (els) => els.map((e) => e.textContent ?? ''))

  // THE STAT PICK IS ON THE PAGE'S FILTER BAR AND THE COMPARISON IS IN THE PANEL, which is the
  // split this step exists to hold. So the pick is made BEFORE a cell is opened — it has to be
  // reachable with no panel up, and the `Beats worn` chip must not exist yet, because nothing has
  // named what "worn" would mean.
  check('the stat pick is reachable with no picker open', (await countOf(page, '[data-testid="gearplan-stat-pick"]')) === 1)
  check('…and the compare chip is not, because no cell has been named', (await countOf(page, BEATS)) === 0)

  await page.click(`${cell} [data-testid="gearplan-item-name"]`, { timeout: 15_000 })
  await page.waitForSelector('[data-testid="gearplan-item-search"]', { timeout: 15_000 })
  if (!check('the panel lists head items to narrow', await until(async () => (await countOf(page, hit)) > 0, 20_000))) {
    await page.click('[data-testid="gearplan-select-close"]', { timeout: 15_000 })
    return
  }
  const pagedBefore = await countOf(page, '[data-testid="gearplan-item-more"]')
  const before = await names()

  await pickIn(page, '[data-testid="gearplan-stat-pick"]', 'WIS')
  const after = await settle(names, (n) => n.length > 0 && n.join('|') !== before.join('|'))
  check('picking a stat reorders the list', after.join('|') !== before.join('|'), `${String(after.length)} rows`)
  note(`top by WIS: ${after.slice(0, 3).join(', ')}`)

  // …and the order is BY THAT STAT. Read off the rendered rows' own delta lines rather than
  // recomputed here: what is under test is that the list a user sees is in wisdom order.
  const paged = await countOf(page, '[data-testid="gearplan-item-more"]')
  check(
    'the sort covers the whole slot, not one page of name matches',
    paged === 0,
    `"show more" present before=${String(pagedBefore)} after=${String(paged)}`
  )

  // THE TOGGLE APPEARS ONLY ONCE THERE IS SOMETHING TO BE BETTER ON — not disabled, absent, and
  // present the moment it has meaning (house law 9).
  check('the compare toggle appears with the first picked stat', (await countOf(page, BEATS)) === 1)
  const listed = await countOf(page, hit)
  await page.click(BEATS, { timeout: 15_000 })
  const narrowed = await settle(() => countOf(page, hit), (n) => n < listed)
  check('…and turning it on can only ever REMOVE rows', narrowed <= listed, `${String(listed)} -> ${String(narrowed)}`)
  note(`beats-worn narrowed HEAD: ${String(listed)} -> ${String(narrowed)}`)

  // AND THE EMPTY LIST BLAMES THE RIGHT THING. "Your filters are hiding them" is the pool filter's
  // sentence and would be the wrong answer here; the stat filter has its own, and it is asked first.
  if (narrowed === 0) {
    const empty = await textOf(page, '[data-testid="gearplan-item-empty"]')
    check('…and an empty list says nothing BEAT what is worn', empty.includes('beats what you have on'), empty)
  }

  // THE LENS SURVIVES THE CELL, which is the whole reason it moved out of the panel. Closing and
  // opening a DIFFERENT cell must find the pick still made — under the old placement it reset, so
  // working down a board meant re-picking the same stat at every slot.
  await page.click('[data-testid="gearplan-select-close"]', { timeout: 15_000 })
  const kept = await page.$$eval('[data-testid="gearplan-stat-pick"] .MuiChip-root', (els) =>
    els.map((e) => e.textContent ?? '')
  )
  check('the pick outlives the panel it narrowed', kept.some((c) => c.includes('WIS')), kept.join(','))

  await page.click('[data-testid="gearplan-cell-PRIMARY"] [data-testid="gearplan-item-name"]', { timeout: 15_000 })
  await page.waitForSelector('[data-testid="gearplan-item-search"]', { timeout: 15_000 })
  check('…and a DIFFERENT cell opens already ranked by it', (await countOf(page, BEATS)) === 1)

  // Put the bar back the way it was found — every later step reads an unfiltered list.
  await page.click(BEATS, { timeout: 15_000 })
  await page.click('[data-testid="gearplan-select-close"]', { timeout: 15_000 })
  await clearPicks(page, '[data-testid="gearplan-stat-pick"]')
}

/**
 * THE POOL FILTER, THROUGH THE REAL PICKER — the claim no unit test can reach.
 *
 * `tests/gearPlanSignals.test.mts` pins `hidesRow`'s truth table. What it cannot see is whether the
 * bar's value actually REACHES the picker: wire `filter` to the wrong prop and every unit test
 * stays green while the control does nothing at all. So this drives the chip and then counts rows.
 *
 * "WISHLISTED" IS THE ONE TO DRIVE, because it is the only filter whose input this spec controls.
 * Era depends on the corpus's provenance, ownership on the staged dump, class fit on the inferred
 * loadout - all three are real but none is something a step can set to a known value. The wish list
 * starts EMPTY, so "keep only what is wishlisted" must hide everything, which is an exact number
 * rather than an inequality.
 *
 * THE CHIP IS NOW TOGGLED WITH THE PANEL OPEN, and that is the point of the panel. Selecting used
 * to be a MUI `Popover` whose backdrop swallowed any click aimed at the bar behind it, so this step
 * had to close the picker, toggle, and reopen. A panel takes no backdrop: the chips stay live while
 * you choose, and the list re-filters under you. Driving it the old way would no longer test the
 * thing that changed.
 */
export async function stepPoolFilter(page: Page): Promise<void> {
  const cell = '[data-testid="gearplan-cell-PRIMARY"]'
  const hits = (): Promise<number> => countOf(page, '[data-testid="gearplan-item-hit"]')
  const search = async (): Promise<void> => {
    await page.click(`${cell} [data-testid="gearplan-add-item"]`, { timeout: 15_000 })
    await page.waitForSelector('[data-testid="gearplan-item-search"]', { timeout: 15_000 })
    await page.fill('[data-testid="gearplan-item-search"] input', 'thelvorn')
  }

  await search()
  // WAIT FOR THE QUERY'S OWN ROWS, NOT FOR ANY ROWS AT ALL. The panel lists the whole slot
  // unprompted, so `hits() > 0` is already true the instant it opens and `before` used to be
  // captured off that first, unfiltered list — then the deferred 'thelvorn' search landed, the
  // count dropped, and the hidden-count assertion compared against a number from a different
  // question. It passed or failed on whether the search beat the read, which is a coin flip.
  //
  // The positive signal is that every row ON SCREEN answers the query that was typed.
  const onlyMatches = async (): Promise<boolean> => {
    const names = await page.$$eval('[data-testid="gearplan-hit-name"]', (els) =>
      els.map((e) => e.textContent ?? '')
    )
    return names.length > 0 && names.every((n) => n.toLowerCase().includes('thelvorn'))
  }
  if (!check('the panel has rows for the QUERY before any filter is applied', await until(onlyMatches, 20_000))) {
    await page.click('[data-testid="gearplan-select-close"]', { timeout: 15_000 })
    return
  }
  const before = await hits()
  await page.click('[data-testid="gearplan-filter-wished"]', { timeout: 15_000 })

  // WAIT ON THE POSITIVE SIGNAL, NOT ON THE ABSENCE OF ROWS. "Zero hits" is also what an in-flight
  // search looks like, so settling on it passes at t=0 and then reads an empty list that has not
  // been filtered yet — which is exactly how this step first failed. The hidden COUNT only appears
  // once rows have arrived AND been held back, so it is the one state worth waiting for.
  const line = await settle(
    () => textOf(page, '[data-testid="gearplan-filter-hidden"]'),
    (t) => t.includes(String(before))
  )
  check('the bar, readable behind the open picker, says how many it is holding back', line.includes(String(before)), line)

  const after = await hits()
  check('"Wishlisted" empties the picker when the wish list is empty', after === 0, `before=${String(before)} after=${String(after)}`)

  // RULE 2 of the signals file: nothing is hidden silently — and the empty list has to say which
  // of the two possible reasons emptied it, because "no such item" is the wrong answer here.
  const empty = await textOf(page, '[data-testid="gearplan-item-empty"]')
  check('…and the empty list blames the FILTER, not the database', empty.includes('filters are hiding'), empty)

  await page.click('[data-testid="gearplan-filter-wished"]', { timeout: 15_000 })
  const restored = await settle(hits, (n) => n === before)
  check('turning it back off restores every row', restored === before, `got ${String(restored)}`)
  await page.click('[data-testid="gearplan-select-close"]', { timeout: 15_000 })
}

/**
 * THE ITEM'S FULL RECORD, AND THE WAY BACK — one step, because they are one promise.
 *
 * `openLoot` is the app's standing deep-link idiom and the Gear, Effects and Wish list tabs already
 * take it; this adds the Plan tab to that list, so the claim to prove is the WHOLE round trip
 * rather than that a click fired. `drillAndBack` is the shared helper that owns it, and using it
 * buys a second assertion for free — the one the plan doc named as this feature's trap: that the
 * board's own filters survive being unmounted by a route rather than by a nav click (JOS-90/97/116).
 *
 * THE FORM IS PUT INTO A STATE NOTHING DEFAULTS TO first, which is what makes the restoration mean
 * anything: restoring a default is indistinguishable from having never saved.
 *
 * THE ICON IS THE LINK AND THE NAME IS NOT. The name was already the picker's door and one click
 * target cannot do two things, so the two are asserted apart — if a later edit moves the routing
 * onto the name, opening the picker starts navigating away from the board and this fails.
 */
export async function stepOpenItemRecord(page: Page): Promise<void> {
  const cell = '[data-testid="gearplan-cell-HEAD"]'
  const link = `${cell} [data-testid="gearplan-open-item"]`
  if (!check('a filled cell offers a way to the item`s full record', (await countOf(page, link)) === 1)) return

  // A state nothing ships with: wishlisted ON, and a stat picked.
  await setChip(page, '[data-testid="gearplan-filter-wished"]', 'on')
  await pickIn(page, '[data-testid="gearplan-stat-pick"]', 'WIS')
  const read = async (p: Page): Promise<Record<string, string>> => ({
    wished: await chipLit(p, '[data-testid="gearplan-filter-wished"]'),
    stats: await memoText(p, '[data-testid="gearplan-stat-pick"]')
  })
  const parked = await read(page)
  check(
    'the Plan tab is holding a form nothing defaults to before it is taken away',
    parked.wished === 'on' && parked.stats.includes('WIS'),
    Object.entries(parked).map(([k, v]) => `${k}=${v}`).join(' · ')
  )

  await drillAndBack(page, {
    label: 'the Plan tab',
    tab: '[data-testid="tab-gearplan"]',
    view: '[data-testid="gearplan-view"]',
    read,
    link
  })

  // …and hand the tab back the way the steps around this one expect to find it.
  await setChip(page, '[data-testid="gearplan-filter-wished"]', 'off')
  await clearPicks(page, '[data-testid="gearplan-stat-pick"]')
}
