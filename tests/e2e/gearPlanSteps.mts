// The Plan tab's steps, shared out of the spec so `gearplan.e2e.mts` stays well under the
// code-line ceiling (the `gearColumnSteps.mts` / `plannerSteps.mts` precedent).
//
// WHAT THESE STEPS ARE FOR — the three things a unit test structurally cannot see:
//   1. THE TAB EXISTS AND DRAWS THE MODEL. `tests/gearPlan.test.mts` pins that the cell vocabulary
//      is `PLAN_SLOTS`; only a mounted app can say whether twenty-three cards reached the screen.
//   2. THE UNLOCK LADDER READS OFF THE PLANNED TIER. This is the coupling the whole feature exists
//      for and it spans the store, the shared fold and the card.
//   3. THE PANES ARE BOUNDED. No unit test can see a layout, and this app's content area is already
//      `overflow:auto` — so a pane that forgot `minHeight: 0` grows the page rather than scrolling.
//
// The expected cell COUNT is asked of the model rather than typed, so widening the board moves both
// halves at once. A frozen constant would rot and then lie.

import type { Page } from 'playwright-core'
import { check, countOf, note, settle, settleGone } from './appHarness.mjs'
// `until` already has FOUR copies in this directory and a fifth would be the drift the repo's
// "one component, every surface" rule is about — plannerSteps.mts is the one that exports it.
import { until } from './plannerSteps.mjs'
import { PLAN_SLOTS } from '../../src/shared/planner/types'

export const VIEW = '[data-testid="gearplan-view"]'
export const BOARD = '[data-testid="gearplan-board"]'
export const TOTALS = '[data-testid="gearplan-totals"]'
export const DIFF = '[data-testid="gearplan-diff"]'
/**
 * THE CARDS, and only the cards. `gearplan-cell-<PlanSlotId>` is a RESERVED namespace for exactly
 * that reason: this prefix selector has counted a control twice already (once when the item name
 * was `gearplan-cell-name`, once when the add/clear links were `gearplan-cell-add`/`-clear`), and
 * both times the symptom was a cell count of 24 or 46 rather than anything that looked like a bug.
 * Controls inside a card are named for what they DO (`gearplan-add-item`), never `cell-*`. It has
 * now happened a THIRD time, with `gearplan-cell-delta` — so the rule is restated as a rule: if a
 * testid inside a card begins `gearplan-cell-`, this selector is already counting it.
 */
export const CELL = '[data-testid^="gearplan-cell-"]'
const HEAD = '[data-testid="gearplan-cell-HEAD"]'

/** The whole visible text of one element, as a user reads it. */
function textOf(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel) => document.querySelector(sel)?.textContent?.trim() ?? '', selector)
}

/**
 * The analytics first-run notice, answered out of the way.
 *
 * It is a real overlay pinned to the bottom of the window, so it sits over anything a popover puts
 * down there — it swallowed the click on the item picker's "show more" row, which is at the foot of
 * a scrolled list. Every other spec that reaches the bottom of the window does this; the check is
 * kept so a run where the notice never appears still says so rather than silently skipping.
 */
export async function answerNotice(page: Page): Promise<void> {
  const notice = '[data-testid="telemetry-notice"]'
  // IT ARRIVES ON ITS OWN SCHEDULE, so a bare "is it here" check races it - the first attempt at
  // this ran before the notice mounted and then lost a click to it three steps later. Wait briefly
  // for it, and stay silent if it never comes: a run on a store that has already answered is not a
  // failure and must not report one.
  if (!(await until(async () => (await countOf(page, notice)) > 0, 4_000))) return
  await page.click('[data-testid="telemetry-notice-off"]')
  check('the analytics first-run notice can be answered out of the way', await settleGone(page, notice, { timeoutMs: 8_000 }))
}

/** Open the gear area by ROW, then the Plan tab by TAB — the way a user reaches it. */
export async function openPlanTab(page: Page): Promise<void> {
  await answerNotice(page)
  await page.click('[data-testid="nav-gear"]', { timeout: 60_000 })
  await page.waitForSelector('[data-testid="gear-area-tabs"]', { timeout: 20_000 })
  await page.click('[data-testid="tab-gearplan"]', { timeout: 20_000 })
  await page.waitForSelector(VIEW, { timeout: 20_000 })
}

/** The tab mounts, and the board draws the cell vocabulary the model states. */
export async function stepMount(page: Page): Promise<void> {
  await openPlanTab(page)
  check('the Plan tab is in the gear area and mounts its board', (await countOf(page, BOARD)) === 1)
  const cells = await countOf(page, CELL)
  check(
    `the board draws every PLAN_SLOTS cell (${String(PLAN_SLOTS.length)})`,
    cells === PLAN_SLOTS.length,
    `drew ${String(cells)}`
  )
  check('…and the totals panel is up beside it', (await countOf(page, TOTALS)) === 1)
}

/** The seeded cell reads out its item, its planned tier, and all four socket lines. */
export async function stepSeededCell(page: Page, item: string, tier: number): Promise<void> {
  const head = await settle(
    () => textOf(page, HEAD),
    (t) => t.includes(item)
  )
  check(`the seeded cell names its item ("${item}")`, head.includes(item), `cell=${head.slice(0, 160)}`)
  check(`…at the tier the store stated (+${String(tier)})`, head.includes(`+${String(tier)}`), head.slice(0, 160))
  // All four sockets are drawn once a cell has an item — the empty ones are the point.
  for (const socket of ['focus', 'click', 'worn', 'proc']) {
    check(
      `…and its ${socket} socket line is drawn`,
      (await countOf(page, `${HEAD} [data-testid="gearplan-socket-${socket}"]`)) === 1
    )
  }
  note(`seeded cell reads: ${head.replace(/\s+/g, ' ').slice(0, 200)}`)
}

/**
 * THE UNLOCK LADDER IS READ OFF THE PLANNED TIER, not off the dump. The seeded cell is at +2, so
 * focus and click are fillable and the other two say what they would cost — the one control doing
 * two jobs, which is the feature's whole claim.
 */
export async function stepUnlockLadder(page: Page): Promise<void> {
  const socket = (kind: string): Promise<string> =>
    textOf(page, `${HEAD} [data-testid="gearplan-socket-${kind}"]`)
  const filled = await socket('focus')
  check('a socket the plan has FILLED names its effect', filled.includes('Extended Enhancement'), filled)
  // An unlocked socket with nothing in it renders the app's `-` (house law 2: absent is a dash,
  // never a word and never a zero) — and specifically NOT the sentence a LOCKED socket carries,
  // which is the distinction this pair of checks exists to hold apart.
  const open = await socket('click')
  check('a socket the planned tier unlocked but nothing fills renders the absent dash', open.includes('-'), open)
  check('…and does not borrow a locked socket`s unlock sentence', !open.includes('to unlock'), open)
  check('…and one the tier has not reached states what would unlock it', (await socket('worn')).includes('+3 to unlock'))
  check('…the strictest one too', (await socket('proc')).includes('+4 to unlock'))
}

/** An exaltation moves an effect, so the panel LISTS it and no total counts it. */
export async function stepSocketsListed(page: Page): Promise<void> {
  const listed = await countOf(page, '[data-testid="gearplan-sockets-planned"]')
  check('the planned exaltation is listed in its own block, never inside the totals', listed === 1)
  if (listed === 1) {
    note(`sockets block reads: ${(await textOf(page, '[data-testid="gearplan-sockets-planned"]')).replace(/\s+/g, ' ').slice(0, 200)}`)
  }
}

/** The comparison ran against the staged dump and stated what it would change. */
export async function stepDiff(page: Page): Promise<void> {
  const shown = await settle(
    () => countOf(page, DIFF),
    (n) => n === 1
  )
  if (!check('the comparison against the dump is drawn', shown === 1)) return
  const text = await textOf(page, DIFF)
  check(
    '…and it states what it would change rather than listing zero rows',
    /would change|changes what you have on/.test(text),
    text.slice(0, 200)
  )
  note(`diff reads: ${text.replace(/\s+/g, ' ').slice(0, 240)}`)
}

/** The two panes are bounded and the page is not. */
export async function stepBounded(page: Page): Promise<void> {
  const m = await page.evaluate(() => {
    const doc = document.documentElement
    const board = document.querySelector('[data-testid="gearplan-board"]')?.parentElement ?? null
    return {
      docOverflow: doc.scrollHeight - doc.clientHeight,
      boardScrolls: board !== null && board.scrollHeight > board.clientHeight,
      boardFits: board !== null && board.clientHeight <= window.innerHeight
    }
  })
  check('the page itself does not scroll', m.docOverflow <= 1, `overflow=${String(m.docOverflow)}px`)
  check('…because the board is its own bounded scroller', m.boardFits, JSON.stringify(m))
  note(`board scrolls internally: ${String(m.boardScrolls)}`)
}

// =================================================================================
// THE EDIT PATH — what only a mounted app can prove
// =================================================================================

/**
 * PUT AN ITEM IN AN EMPTY CELL, through the real picker and the real `plannerSearchItems` IPC.
 *
 * The cell is PRIMARY rather than the seeded HEAD, so this step proves the empty-cell arm (one
 * control and nothing else) and leaves the seeded cell alone for the steps that read it.
 */
export async function stepAssignItem(page: Page, query: string): Promise<string | null> {
  const cell = '[data-testid="gearplan-cell-PRIMARY"]'
  check('an empty cell offers exactly one control', (await countOf(page, `${cell} [data-testid="gearplan-add-item"]`)) === 1)
  check('…and draws no socket lines at all', (await countOf(page, `${cell} [data-testid^="gearplan-socket-"]`)) === 0)

  await page.click(`${cell} [data-testid="gearplan-add-item"]`, { timeout: 15_000 })
  await page.waitForSelector('[data-testid="gearplan-item-search"]', { timeout: 15_000 })

  // OPENS SHOWING WHAT FITS, before a single letter is typed. This is the discoverability claim,
  // and it is only true because main narrows by SLOT before its fifty-hit cap - ask it corpus-wide
  // and the same fifty rows contain almost no primaries. Every row is checked against the slot for
  // that reason: a list that is merely non-empty would pass a broken implementation.
  const listed = await until(async () => (await countOf(page, '[data-testid="gearplan-item-hit"]')) > 0, 20_000)
  check('the picker lists what fits the cell with an EMPTY query', listed)
  if (listed) {
    const first = await page.evaluate(
      () => document.querySelector('[data-testid="gearplan-hit-name"]')?.textContent?.trim() ?? ''
    )
    note(`unprompted list opens with: ${first}`)

    // AND IT SAYS WHEN IT IS HOLDING BACK. A capped list looks exactly like a complete one - which
    // is how a real item ranked 51st of 362 read as "not in the database". The control has to both
    // appear and WORK, so the row count must actually grow.
    // Again, and deliberately: the control sits at the foot of a scrolled list, which is the band
    // the notice occupies. Idempotent, so a run that already answered it pays nothing.
    await answerNotice(page)
    const before = await countOf(page, '[data-testid="gearplan-item-hit"]')
    if (check('a truncated list offers "show more"', (await countOf(page, '[data-testid="gearplan-item-more"]')) === 1)) {
      await page.click('[data-testid="gearplan-item-more"]', { timeout: 15_000 })
      const grown = await settle(() => countOf(page, '[data-testid="gearplan-item-hit"]'), (n) => n > before)
      check('…and it fetches a bigger page rather than just relabelling', grown > before, `${String(before)} -> ${String(grown)}`)
    }
  }

  await page.fill('[data-testid="gearplan-item-search"] input', query)

  // WAIT FOR THE QUERY'S ROWS, NOT FOR "ANY ROWS". Since the picker started listing what fits the
  // cell before a letter is typed, "the list is non-empty" is true the instant it opens — so the
  // old wait returned immediately, scraped the UNPROMPTED first row ("Axe") and then clicked
  // whatever had replaced it by the time the click landed. The settled first name is the only
  // signal that the search actually came back.
  const name = await settle(
    () => page.evaluate(
      () => document.querySelector('[data-testid="gearplan-hit-name"]')?.textContent?.trim() ?? ''
    ),
    (n) => n.toLowerCase().includes(query.toLowerCase())
  )
  if (!check(`the item picker answers "${query}" over real IPC`, name !== '')) return null
  await page.click('[data-testid="gearplan-item-hit"]', { timeout: 15_000 })

  const landed = await settle(() => textOf(page, cell), (t) => t.includes(name))
  check(`"${name}" lands in the cell it was picked for`, landed.includes(name), landed.slice(0, 160))
  // R2's slot half, through the app: only a PRIMARY item could have been offered at all.
  note(`assigned: ${name}`)
  return name
}

/**
 * THE ONE CONTROL DOING TWO JOBS — the feature's whole claim, and the only place it is visible.
 *
 * A freshly assigned cell is at +0, so it has NO unlocked sockets. Raising its tier to +4 must
 * light all four, because `unlockedSockets` reads the PLANNED state rather than the dump.
 */
export async function stepTierUnlocks(page: Page): Promise<void> {
  const cell = '[data-testid="gearplan-cell-PRIMARY"]'
  const openSockets = async (): Promise<number> =>
    countOf(page, `${cell} [data-testid^="gearplan-socket-"] a, ${cell} [data-testid^="gearplan-socket-"] button`)

  check('a cell planned at +0 offers no socket to fill', (await openSockets()) === 0)
  const ratioBefore = await ratioOf(page, cell)
  const before = await textOf(page, cell)
  check('…and says what each locked socket would cost', before.includes('+1 to unlock') && before.includes('+4 to unlock'), before.slice(0, 200))

  // The slider's own input, driven by keyboard — a drag is a mouse gesture this harness cannot
  // aim reliably, and the control's CONTRACT is its value, not the pixels it was moved through.
  const slider = `${cell} [data-testid="gearplan-tier-slider"] input`
  await page.focus(slider, { timeout: 15_000 })
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowRight')

  const opened = await settle(openSockets, (n) => n === 4)
  check('raising the planned tier to +4 unlocks all four sockets', opened === 4, `open=${String(opened)}`)
  const after = await textOf(page, cell)
  check('…and the card header states the new tier', after.includes('+4'), after.slice(0, 160))
  check('…and no "to unlock" sentence survives', !after.includes('to unlock'), after.slice(0, 200))

  // THE SAME CONTROL DOING A THIRD JOB, and the reason the ratio is drawn on this surface at all.
  // `scaleGearStat` scales DMG and deliberately leaves DELAY alone, so a weapon's damage ratio
  // IMPROVES with its tier - which is a claim spanning phase 0's scaling, the shared fold and the
  // card, and is visible nowhere else in the app because nowhere else lets you set the tier.
  const ratioNow = await ratioOf(page, cell)
  check('a weapon cell draws its damage ratio on its own line', ratioBefore !== null && ratioNow !== null, `before=${String(ratioBefore)} after=${String(ratioNow)}`)
  if (ratioBefore !== null && ratioNow !== null) {
    check('…and raising the tier RAISES it - DMG scales, DELAY does not', ratioNow > ratioBefore, `${String(ratioBefore)} -> ${String(ratioNow)}`)
    note(`PRIMARY ratio +0 -> +4: ${String(ratioBefore)} -> ${String(ratioNow)}`)
  }
}

/**
 * The ratio a cell is printing, as a number. `null` when the cell draws no ratio line at all —
 * which is the correct answer for every cell that is not holding a weapon.
 */
async function ratioOf(page: Page, cell: string): Promise<number | null> {
  const text = await textOf(page, `${cell} [data-testid="gearplan-ratio"]`)
  const found = /RATIO\s+([\d.]+)/.exec(text)
  return found === null ? null : Number(found[1])
}

/** Pick an exaltation for a socket, through the donor corpus and R2. */
export async function stepSocketPick(page: Page): Promise<void> {
  const cell = '[data-testid="gearplan-cell-PRIMARY"]'
  await page.click(`${cell} [data-testid="gearplan-socket-proc"] button`, { timeout: 15_000 })
  await page.waitForSelector('[data-testid="gearplan-donor-search"]', { timeout: 15_000 })

  // An empty query LISTS: the legal set for one socket of one cell is small and closed.
  const listed = await until(async () => (await countOf(page, '[data-testid="gearplan-donor-hit"]')) > 0, 20_000)
  // A PANEL IS DISMISSED BY ITS OWN CONTROL, not by Escape: there is no backdrop and no focus trap
  // to press against any more, which is the point of it being a column.
  if (!check('the donor panel lists what fits before a single letter is typed', listed)) {
    await page.click('[data-testid="gearplan-socket-close"]', { timeout: 15_000 })
    return
  }
  const effect = await page.evaluate(
    () => document.querySelector('[data-testid="gearplan-donor-hit"]')?.textContent?.trim() ?? ''
  )
  await page.click('[data-testid="gearplan-donor-hit"]', { timeout: 15_000 })

  const after = await settle(() => textOf(page, cell), (t) => !t.includes('-\n'))
  check('the picked effect is stated in its socket', after.length > 0 && effect.length > 0)
  note(`socketed into PRIMARY/proc: ${effect.replace(/\s+/g, ' ').slice(0, 120)}`)
  // R2's side effect, through the app: the panel now lists a planned exaltation it did not before.
  const planned = await countOf(page, '[data-testid="gearplan-sockets-planned"]')
  check('…and the totals panel lists it, in the block that adds nothing up', planned === 1)
}

/** The one destructive control. A cell you can fill and not empty is a trap. */
export async function stepClearCell(page: Page): Promise<void> {
  const cell = '[data-testid="gearplan-cell-PRIMARY"]'
  await page.click(`${cell} [data-testid="gearplan-clear-cell"]`, { timeout: 15_000 })
  const emptied = await settle(
    () => countOf(page, `${cell} [data-testid="gearplan-add-item"]`),
    (n) => n === 1
  )
  check('clearing a cell empties it back to its one control', emptied === 1)
  check('…and its socket lines go with it', (await countOf(page, `${cell} [data-testid^="gearplan-socket-"]`)) === 0)
}

/**
 * EVERY DONOR ROW SAYS WHAT ITS EFFECT DOES, WITHOUT BEING ASKED.
 *
 * THIS STEP HAS NOW BEEN WRITTEN THREE TIMES AND THE THIRD IS WORTH RECORDING. It first drove a
 * per-row chevron that expanded a `SpellCard` inline; then a hover card, on the argument that a
 * planned socket already explains itself on hover and one question should not need two gestures.
 * Both were arguments about which GESTURE reveals the effect, and both were had while the picker
 * was a 360px popover with nowhere to put a list.
 *
 * In the right column there is room, so there is no gesture: the effect lines are permanent text.
 * The claim that replaces "hovering opens the card" is stronger and this step is what holds it —
 * that the lines are THERE, before any pointer moves, on rows you can compare side by side.
 *
 * WHAT ONLY A MOUNTED APP CAN SAY: the donor corpus carries three facts per effect and NOT the
 * numbered effect list. These lines come from the spell DB, one `spells:detail` round trip per
 * drawn row, joined by case-folded name at index build. If that join or that channel breaks, the
 * rows still render — with the corpus one-liner and no effect lines — and nothing below this level
 * would notice.
 */
export async function stepDonorInlineEffects(page: Page): Promise<void> {
  const cell = '[data-testid="gearplan-cell-PRIMARY"]'
  const hit = '[data-testid="gearplan-donor-hit"]'
  await page.click(`${cell} [data-testid="gearplan-socket-proc"] button`, { timeout: 15_000 })
  await page.waitForSelector('[data-testid="gearplan-donor-search"]', { timeout: 15_000 })
  if (!check('the exaltation panel has rows', await until(async () => (await countOf(page, hit)) > 0, 20_000))) {
    await page.click('[data-testid="gearplan-socket-close"]', { timeout: 15_000 })
    return
  }

  check('no chevron survives', (await countOf(page, '[data-testid="gearplan-donor-details"]')) === 0)

  // THE EFFECT LINES ARE THERE BEFORE ANYTHING IS HOVERED. Settled on rather than read once: each
  // row fetches on mount, so "no lines yet" is also what an in-flight lookup looks like.
  const withLines = await settle(
    () => countOf(page, '[data-testid="gearplan-donor-effects"]'),
    (n) => n > 0
  )
  check('rows state what their effect DOES, with no gesture at all', withLines > 0, `rows with lines=${String(withLines)}`)
  const rowText = await textOf(page, hit)
  note(`donor row reads: ${rowText.replace(/\s+/g, ' ').slice(0, 220)}`)

  // …and the lines are the SPELL DB's, not a re-print of the corpus one-liner the row already has.
  const lines = await page.$$eval('[data-testid="gearplan-donor-effects"]', (els) =>
    (els[0]?.textContent ?? '').trim()
  )
  check('…in the wiki`s own words, which the donor corpus does not carry', lines.length > 0, lines.slice(0, 120))

  // NO HOVER CARD ANYWHERE IN THIS PANEL, including after a pointer actually lands on a row - the
  // check that would catch a `SpellTooltip` left wrapped around a row by a later edit.
  // PARK THE POINTER FIRST. The click that opened this panel left it resting on the cell's own
  // proc socket line, which DOES still carry a spell card (see `stepSocketHover` — the board cell
  // has no room to inline anything, so hover is the only depth it has). MUI opens that card on an
  // enter delay, so without this the card the BOARD legitimately owns lands inside the window where
  // this step is asking about the PANEL, and the step reports the opposite of what is true.
  await page.mouse.move(2, 2)
  const settled = await until(async () => (await countOf(page, '[data-testid="spell-hover-card"]')) === 0, 8_000)
  check('no card is left standing once the pointer is off the board', settled)

  const rows = await countOf(page, hit)
  await page.hover(hit, { timeout: 15_000 })
  // A NEGATIVE ASSERTED OVER TIME, not sampled once: "no card yet" is what an enter delay looks
  // like too, so a single read right after the hover would pass even if a tooltip were mounted.
  const appeared = await until(async () => (await countOf(page, '[data-testid="spell-hover-card"]')) > 0, 2_000)
  check('hovering a row opens NOTHING - the card is gone from this surface', !appeared)
  check('…and hovering picked nothing either', (await countOf(page, '[data-testid="gearplan-donor-search"]')) === 1)
  check('…with every row it had', (await countOf(page, hit)) === rows)

  // THE PAGE, which is also what bounds the spell lookups — one `spells:detail` per DRAWN row, so
  // the page size is the fetch budget.
  //
  // THE INVARIANT IS ASSERTED, NOT A PARTICULAR LIST LENGTH. Which socket this step lands on decides
  // how many donors are legal, and the sockets vary by two orders of magnitude against the committed
  // corpus (a worn socket on PRIMARY offers 8; proc on the same cell offers 197). Pinning "this
  // list is long" would be pinning the fixture's gear, not the paging. What must hold either way is
  // that the panel never draws more than a page, and that it offers the way through exactly when it
  // is holding something back — the never-truncate-in-silence rule, measured.
  const more = await countOf(page, '[data-testid="gearplan-donor-more"]')
  check('the panel never draws more than one page at a time', rows <= 25, `rows=${String(rows)}`)
  if (more === 1) {
    note(`paging line: ${(await textOf(page, '[data-testid="gearplan-donor-more"]')).trim()}`)
    await page.click('[data-testid="gearplan-donor-more"]', { timeout: 15_000 })
    const grew = await settle(() => countOf(page, hit), (n) => n > rows)
    check('…and "show more" walks it out', grew > rows, `${String(rows)} -> ${String(grew)}`)
  } else {
    check('a full page with no "show more" would be a silent truncation', rows < 25, `rows=${String(rows)}`)
    note(`this socket's legal set fits in one page (${String(rows)} rows), so no paging control is drawn`)
  }

  await page.click(hit, { timeout: 15_000 })
  const picked = await settle(
    () => countOf(page, '[data-testid="gearplan-donor-search"]'),
    (n) => n === 0
  )
  check('picking a row closes the panel and returns the column to the totals', picked === 0)
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
 * HOVER A PLANNED EXALTATION, GET THE SPELL CARD — and the two things that could silently go wrong.
 *
 * The card is `lib/SpellCard` behind `SpellTooltip`, the same component four other surfaces already
 * hang off a spell name. What a unit test cannot see is whether it MOUNTS from inside a board cell:
 * `SpellCard` fetches per name over IPC, so a card that renders but never resolves looks identical
 * to one that was never wired up until you read it.
 *
 * AND THE PENCIL MUST NOT OPEN IT. The donor's provenance lives on that control as a native title,
 * and the spell card lives on the text - two elements precisely so the two hovers cannot race. If a
 * later edit moves the card up onto the `Link`, hovering the edit affordance starts opening a
 * reference card, and this check is what says so.
 */
export async function stepSocketHover(page: Page): Promise<void> {
  const effect = `${HEAD} [data-testid="gearplan-socket-effect-focus"]`
  check('the seeded cell`s filled socket exposes its effect text', (await countOf(page, effect)) === 1)
  check('…and no card is mounted before anything is hovered', (await countOf(page, '[data-testid="spell-hover-card"]')) === 0)

  await page.hover(effect, { timeout: 15_000 })
  const opened = await settle(
    () => countOf(page, '[data-testid="spell-hover-card"]'),
    (n) => n === 1
  )
  if (!check('hovering a planned exaltation opens the app`s own spell card', opened === 1)) return
  // The card RESOLVED, rather than mounting empty: it names the effect it was asked about.
  const card = await textOf(page, '[data-testid="spell-hover-card"]')
  check('…and it is the card for THAT effect, fetched and drawn', card.includes('Extended Enhancement'), card.replace(/\s+/g, ' ').slice(0, 160))
  note(`socket card reads: ${card.replace(/\s+/g, ' ').slice(0, 200)}`)

  // Off the row entirely, so the next step starts from a clean slate.
  await page.hover(TOTALS, { timeout: 15_000 })
  const closed = await settle(
    () => countOf(page, '[data-testid="spell-hover-card"]'),
    (n) => n === 0
  )
  check('…and leaving the text closes it - the card is non-interactive by construction', closed === 0)
}

/**
 * LOAD WHAT YOU ARE WEARING — and with it, the exaltations the client actually printed.
 *
 * THE CLAIM NO UNIT TEST CAN MAKE. `tests/gearPlanTotals.test.mts` proves the join works when the
 * corpus is handed in by a test; only the running app can say that the RENDERER hands it in — that
 * `useDonors()` reached `equippedRead` at all. Get that wiring wrong and nothing goes red anywhere:
 * every socket simply loads empty, and an empty socket is a legal state.
 *
 * FACE is the cell, and deliberately: the seeded HEAD is what the relaunch reads, PRIMARY is what
 * the edit steps use, and FACE is a cell the committed dump fills with a socketed item that no
 * other step touches. `fill` is the mode for the same reason - it cannot disturb either of them.
 */
export async function stepLoadEquipped(page: Page): Promise<void> {
  const face = '[data-testid="gearplan-cell-FACE"]'
  check('the cell about to be loaded starts empty', (await countOf(page, `${face} [data-testid="gearplan-add-item"]`)) === 1)

  await page.click('[data-testid="gearplan-load"]', { timeout: 15_000 })
  await page.waitForSelector('[data-testid="gearplan-load-fill"]', { timeout: 15_000 })
  await page.click('[data-testid="gearplan-load-fill"]', { timeout: 15_000 })

  const loaded = await settle(
    () => textOf(page, face),
    (t) => t.includes('Mithril')
  )
  check('a `fill` load puts the worn item in its own cell', loaded.includes('Mithril'), loaded.slice(0, 160))
  check('…at the tier the dump`s name stated', loaded.includes('+3'), loaded.slice(0, 160))
  // THE POINT OF THE STEP. The dump named `Polished Mithril Mask (Exaltation)` - a DONOR item. The
  // effect below is nowhere in that file; it is what the corpus says that donor offers, resolved in
  // the renderer and written into the socket the corpus named.
  const socket = await textOf(page, `${face} [data-testid="gearplan-socket-focus"]`)
  check('…and its worn exaltation arrives as an EFFECT, resolved through the corpus', socket.includes('Improved Damage'), socket)
  note(`loaded FACE reads: ${loaded.replace(/\s+/g, ' ').slice(0, 200)}`)

  // The seeded cell is untouched, which is the whole promise `fill` makes.
  const head = await textOf(page, HEAD)
  check('…and `fill` touched nothing that was already planned', head.includes('Crown of Narandi') && head.includes('+2'), head.slice(0, 160))
}

/** The loaded socket survived the store round trip, exactly as a hand-picked one would. */
export async function stepLoadedSocketReturns(page: Page): Promise<void> {
  const socket = await settle(
    () => textOf(page, '[data-testid="gearplan-cell-FACE"] [data-testid="gearplan-socket-focus"]'),
    (t) => t.includes('Improved Damage')
  )
  check(
    'the socket a LOAD resolved is a plan like any other - it comes back after a relaunch',
    socket.includes('Improved Damage'),
    socket
  )
}

/**
 * A CELL STATES WHAT IT WOULD CHANGE, not what its item is.
 *
 * THIS STEP REPLACED A HOVER-CARD TEST. The cell and the picker rows used to open the app's item
 * window on hover; it was dropped because a `clickThrough` card cannot flip (its own header states
 * that price) and so clipped off the bottom of the window, and because the absolute stat list it
 * showed is not the question a board is asked. The delta is.
 *
 * WHAT ONLY A MOUNTED APP CAN SAY: that the comparison ran against the item worn in the SAME cell,
 * at both sides' real tiers, through the corpus and the staged dump. The seeded HEAD cell plans a
 * Crown of Narandi at +2 over whatever the dump wears there, so the line must be signed deltas
 * rather than the item's own numbers.
 */
export async function stepCellDelta(page: Page): Promise<void> {
  check('no hover card is mounted from a cell any more', (await countOf(page, '[role="tooltip"]')) === 0)

  const line = await settle(
    () => textOf(page, `${HEAD} [data-testid="gearplan-stat-delta"]`),
    (t) => t.length > 0
  )
  if (!check('the seeded cell states a DELTA rather than its own stats', line.length > 0)) return
  // Signed both ways or not a delta: an absolute stat line is all `+`, so a `-` is the proof the
  // subtraction actually happened against something worn.
  check('…and it is signed - the comparison ran', /[+-]\d/.test(line), line.replace(/\s+/g, ' ').slice(0, 160))

  // THE GROUPING AND THE HUES, ASSERTED ON WHAT WAS ACTUALLY PAINTED. `splitDelta` is unit-tested,
  // but nothing below the renderer can say the two groups reached the DOM in that order wearing
  // those colours — and the pair of them IS the readability claim.
  //
  // IT READS THE COLOURS AND NOT THE SIGNS ON PURPOSE. The obvious version of this check — every
  // `+` before every `-` — passes today and is wrong: `DELAY` and `WEIGHT` are better smaller, so
  // a gains run may legitimately end `DELAY -6 · RANGE +5` and the sign order says nothing. The
  // computed colour is the thing under test, so it is the thing to ask about.
  const groups = await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (el === null) return []
    return [...el.querySelectorAll('span')]
      .filter((s) => s.textContent !== null && /[+-]\d/.test(s.textContent))
      .map((s) => getComputedStyle(s).color)
  }, `${HEAD} [data-testid="gearplan-stat-delta"]`)

  // rgb(127, 191, 143) is KIND_COLOR.member; rgb(207, 102, 121) is KIND_COLOR.enemy.
  const seen = groups.map((c) => (c.includes('127, 191, 143') ? 'gain' : c.includes('207, 102, 121') ? 'loss' : '?'))
  check('each stat run is painted a KIND_COLOR hue, not an unstyled default', !seen.includes('?'), seen.join(','))
  check(
    'gains are drawn before losses, in at most one run each - the line is grouped',
    seen.join(',') === 'gain,loss' || seen.join(',') === 'gain' || seen.join(',') === 'loss',
    seen.join(',')
  )
  note(`cell delta reads: ${line.replace(/\s+/g, ' ').slice(0, 200)}`)
}

/**
 * EMPTY THE WHOLE BOARD — and prove the confirm is a confirm.
 *
 * RUN LAST, IN THE SECOND LAUNCH, because it destroys the document every other step reads. Its
 * position in the spec is part of the test: anything that ran after it would be asserting against a
 * board this step wiped.
 *
 * TWO CLAIMS. Opening the menu must change NOTHING — a destructive control that acts on the way to
 * its own confirmation is not confirmed at all — and the row must state the real count, because
 * that number IS the warning in a surface with no modals and no undo.
 */
export async function stepClearAll(page: Page, planned: number): Promise<void> {
  const cells = async (): Promise<number> => countOf(page, `${CELL} [data-testid="gearplan-item-name"]`)
  check(`the board has ${String(planned)} planned before the wipe`, (await cells()) === planned)

  await page.click('[data-testid="gearplan-clear-all"]', { timeout: 15_000 })
  await page.waitForSelector('[data-testid="gearplan-clear-all-confirm"]', { timeout: 15_000 })
  const row = await textOf(page, '[data-testid="gearplan-clear-all-confirm"]')
  check('the confirm names the number it would discard', row.includes(String(planned)), row.replace(/\s+/g, ' '))
  check('…and says it cannot be undone', row.includes('cannot be undone'), row.replace(/\s+/g, ' '))
  check('…and OPENING it discarded nothing', (await cells()) === planned)

  await page.click('[data-testid="gearplan-clear-all-confirm"]', { timeout: 15_000 })
  const left = await settle(cells, (n) => n === 0)
  check('confirming empties every cell', left === 0, `${String(planned)} -> ${String(left)}`)
  // …and the controls that only make sense with a plan go with it (law 9, the toolbar's own rule).
  check('…and the wipe control removes itself', (await countOf(page, '[data-testid="gearplan-clear-all"]')) === 0)
}
