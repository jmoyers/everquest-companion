/**
 * Headless Electron integration test for THE SKY TAB'S DROPDOWNS BEING REACHABLE — while the item
 * hover cards are back on the rows underneath them (JOS-143, then JOS-181).
 *
 * THE BUG, as the owner hit it, and it is the SECOND sighting of one defect. On the Loot page a
 * 0.14.0 user could not change the sort (JOS-127); the cause was never the sort's own tooltip but
 * the rows BELOW the toolbar, which anchored `placement="top"`, INTERACTIVE item cards that opened
 * upward across it and kept `pointer-events: auto` while they were up. The Plane of Sky tracker is
 * built to the same plan — `QuestFilterBar` is five dropdowns sitting on top of a scrolling
 * accordion — and every required-item chip in the collapsed summary row anchored exactly such a
 * card (`features/posky/ItemTooltip.tsx`, up to 380px wide). For the first quest in the list those
 * cards land ON the toolbar. JOS-143's answer was universal removal: no popper anywhere near a
 * dropdown, and the Sky tab lost its item cards entirely.
 *
 * AND THE OWNER HAS NOW RULED THE TRADE THE OTHER WAY (JOS-181, on v0.18.0): the rich cards come
 * back to this tab, and the defect does not come with them. So THIS SPEC'S TRIPWIRE CHANGES, and
 * the change is the whole point of the rewrite. It used to be "hovering the chip opens no popper at
 * all" — a rule the product has stopped believing in. It is now three properties of the card that
 * IS there, each of which the 0.15.0 card failed:
 *   1. it opens DOWNWARD — its top edge is below its anchor's, and therefore below the toolbar the
 *      anchor sits under. The old card was `placement="top"`; a flip back turns this red.
 *   2. it takes NO POINTER EVENTS (computed `pointer-events: none` on the popper). The old card was
 *      interactive, which is the property that literally ate the click.
 *   3. it is GONE by the time the click resolves — it closes on pointerdown, so it can never be
 *      floating over the option list the user just opened.
 * Each is a different way the defect could return, and none of them is "count the poppers".
 *
 * AND THE NEW TRIPWIRE WAS MEASURED AGAINST THE OLD SHAPE (2026-08-10, this fixture, this harness,
 * a 1280-wide window), the way loot-sort.e2e.mts and this spec's first cut both were. Dropping the
 * `clickThrough` flag in `SkyItemCard` — which is exactly the v0.15.0 card, `placement="top"` and
 * interactive — turns FOUR checks red and nothing else: the card's top edge lands at 161 against a
 * filter bar whose bottom is 263 (it is ON the toolbar) and against an anchor at 416, computed
 * `pointer-events` reads `auto`, and the card is still up over an open option list. Every one of
 * them is green with the flag on.
 *
 * WHY THIS NEEDS A BROWSER AT ALL. `tests/tooltipCursor.test.mts` pins the code shape and cannot
 * rot — it derives the rule (every file that renders a dropdown mounts no popper; the Sky rows
 * mount their card only through the one wrapper that always asks for click-through mode) rather
 * than listing it. But "the code asks for click-through" and "the control takes the click" are
 * different claims, and only the second is what the owner reported. This spec asserts the second,
 * in the order a user meets it: hover the anchor that used to open the card onto the toolbar, ask
 * the DOM what is really on top of each dropdown (`elementFromPoint` — the browser's own hit test,
 * which is exactly the question "where would this click land?"), then work all three dropdowns with
 * real clicks WITH A CARD OPEN.
 *
 * WHAT ELEMENTFROMPOINT IS AND IS NOT, MEASURED. The original spec recorded this and the run above
 * confirms it: with the broken card up, `elementFromPoint` PASSED and so did every real click,
 * because where a popper lands is a function of the window and this one is a fixed 1280 the owner's
 * is not. So the geometry is the statement of what the user is owed — their click reaching the
 * control — while the three properties above are what catch the regression at any width.
 *
 * IT ALSO PINS THAT THE DROPPER ROSTER STAYS REACHABLE (JOS-173, carried forward). Deleting the
 * card in JOS-143 deleted one of the facts it carried: the required-item chip's card printed
 * posky's `where` AND a "Drops: <mob names>" line, and the native title that replaced it was
 * `it.where` alone, so a 0.16.0 player hovering an item read "Island 5" and nothing more, and said
 * so. JOS-173 rebuilt the roster as a title; JOS-181 gives it back its own block IN the card
 * (`posky-card-drops`), which is a rendered node again — so this spec reads the node rather than an
 * attribute. "The card cannot eat a click" is trivially satisfiable by a card that says nothing;
 * this is the check that keeps the two rules honest together.
 *
 * WHAT IT READS (JOS-29): `tests/fixtures/e2e-copy.log`, a committed fixture. The Sky tab's quest
 * LIST comes from the committed catalog rather than from the log, so the rows and their item chips
 * are there whatever the log said — which is what makes this spec deterministic. Nothing here
 * asserts a quest by name or a count by number (frozen numbers rot); it asserts that a control the
 * user aimed at is the thing their pointer finds.
 *
 * WHY IT NEVER TAKES THE SCREEN: `EQ_E2E=1` (src/main/e2e.ts) shows no window, skips the
 * single-instance lock, and points `userData` at a throwaway temp dir minted per launch.
 *
 * Run: `npm run test:e2e -- sky-dropdowns`.
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
  settleStable
} from './appHarness.mjs'
import { mainWindow } from './appWindow.mjs'
import { launchOnFixture } from './logFixture.mjs'

const NAV_SKY = '[data-testid="nav-posky"]'
const NAV_OVERVIEW = '[data-testid="nav-overview"]'
/** The toolbar's two `TextField select`s — the controls the owner could not work. */
const SORT = '[data-testid="posky-sort"]'
const COUNT_SOURCE = '[data-testid="posky-count-source"]'
/** The clickable half of a MUI `TextField select` — the div that opens the menu. */
const combo = (sel: string): string => `${sel} [role="combobox"]`
const OPTION = 'li[role="option"]'
/** The chip-select beside them: an Autocomplete, whose list opens into the same band. */
const ISLAND = '[data-testid="posky-island-filter"]'
/** Any MUI tooltip popper, whoever mounted it. */
const POPPER = '.MuiTooltip-popper'
/** The card's own "where, and who drops it" block (features/posky/SkyItemCard.tsx). */
const CARD_DROPS = '[data-testid="posky-card-drops"]'
/** A required-item chip in the collapsed summary — THE anchor whose card sat on the toolbar. */
const ITEM_CHIP = '[data-testid="posky-item-chip"]'
/** The kill-target caption on the same row: the other `placement="top"` anchor that was here. */
const KILL_TARGET = '[data-testid="posky-kill-target"]'
/** The three controls this spec insists stay reachable, in the order they sit on the bar. */
const CONTROLS = [
  [SORT, 'Sort'],
  [COUNT_SOURCE, 'Count items from'],
  [ISLAND, 'island filter']
] as const

/**
 * What is REALLY on top of a control right now — the tag `elementFromPoint` finds at its centre,
 * and whether that node belongs to the control.
 *
 * This IS the click, asked as a question: `elementFromPoint` is the same hit test the browser runs
 * to decide what a press lands on. Answering "inside the control" while a card is open is the
 * deterministic form of "the card did not eat it".
 */
function whatCovers(page: Page, sel: string): Promise<{ tag: string; inside: boolean }> {
  return page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return { tag: 'none', inside: false }
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
    if (!hit) return { tag: 'none', inside: false }
    return { tag: hit.tagName.toLowerCase(), inside: el.contains(hit) || hit === el }
  }, sel)
}

interface CardFacts {
  /** the popper's own box */
  top: number
  bottom: number
  /** the hovered anchor's box, read in the same frame so the comparison is not a guess */
  anchorTop: number
  /** the lowest edge of the three toolbar controls — the band a card may never reach */
  barBottom: number
  /** COMPUTED pointer-events on the popper: 'none' is the whole fix */
  pointerEvents: string
  text: string
}

/**
 * The card and the toolbar, measured together in ONE frame. Separate reads would be two different
 * layouts and the comparison between them would mean nothing.
 */
function cardFacts(page: Page, anchor: string): Promise<CardFacts | null> {
  return page.evaluate(
    (a) => {
      const p = document.querySelector(a.popper)
      const el = document.querySelector(a.anchor)
      if (!p || !el) return null
      const r = p.getBoundingClientRect()
      let barBottom = 0
      for (const s of a.controls) {
        const c = document.querySelector(s)
        if (c) barBottom = Math.max(barBottom, c.getBoundingClientRect().bottom)
      }
      return {
        top: r.top,
        bottom: r.bottom,
        anchorTop: el.getBoundingClientRect().top,
        barBottom,
        pointerEvents: getComputedStyle(p).pointerEvents,
        text: (p as HTMLElement).innerText
      }
    },
    { popper: POPPER, anchor, controls: CONTROLS.map(([sel]) => sel) }
  )
}

/** What a `TextField select` is showing, as the user reads it. */
function selectValue(page: Page, sel: string): Promise<string> {
  return page.evaluate(
    (s) => (document.querySelector(s) as HTMLElement | null)?.innerText.trim() ?? '',
    combo(sel)
  )
}

function appears(page: Page, sel: string, ms = 20_000): Promise<boolean> {
  return page.waitForSelector(sel, { timeout: ms }).then(
    () => true,
    () => false
  )
}

/** The centre of a control, in viewport coordinates — where a real click on it goes. */
function centreOf(page: Page, sel: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }, sel)
}

/** Land, then open the Sky tab on a toolbar with quest rows under it. */
async function stepReady(page: Page): Promise<void> {
  if (!check('the app lands on the nav', await appears(page, NAV_OVERVIEW, 60_000))) {
    throw new Error('never landed — nothing below can be asserted')
  }
  await page.click(NAV_SKY, { timeout: 30_000 })
  if (!check('the Sky tab opens on its filter bar', await appears(page, SORT, 60_000))) {
    throw new Error('no Sky toolbar — nothing below can be asserted')
  }
  const rows = await settleCount(page, ITEM_CHIP, 1, { timeoutMs: 20_000 })
  check('…with quest rows under it, carrying required-item chips', rows > 0, `chips=${String(rows)}`)
}

/** Park the pointer where nothing is hoverable and let any open card go. */
async function pointerAway(page: Page): Promise<void> {
  await page.mouse.move(2, 2)
  await settleStable(() => countOf(page, POPPER), { timeoutMs: 3000 })
}

/**
 * HOVER AN ANCHOR AND OPEN ITS CARD — then check the three properties that make the card
 * incapable of the defect, and ask the geometry what is over each dropdown while it is up.
 *
 * The first quest's chip is the worst case on the whole tab and the exact anchor the owner
 * reported: it is the second line of the collapsed summary of the TOP row, so a card that opens
 * upward from it lands on QuestFilterBar itself.
 */
async function stepCardIsHarmless(page: Page, sel: string, what: string, expectCard: boolean): Promise<void> {
  if ((await countOf(page, sel)) === 0) {
    note(`no ${what} in this run — that anchor could not be hovered`)
    return
  }
  if (!(await hoverAt(page, sel, 0.5, 0.5))) {
    note(`could not put the pointer on the ${what}`)
    return
  }
  const poppers = await settleStable(() => countOf(page, POPPER), { timeoutMs: 4000 })
  if (!expectCard) {
    // The kill-target caption names MOBS, not items, and carries its roster as a native title —
    // no DOM node, no hit area. It is on this tab and it stays that way (JOS-143's rule survives
    // everywhere the answer is a sentence rather than an item).
    check(`hovering the ${what} opens no popper at all`, poppers === 0, `poppers=${String(poppers)}`)
    return
  }
  if (!check(`hovering the ${what} opens its item card`, poppers === 1, `poppers=${String(poppers)}`)) return

  const facts = await cardFacts(page, sel)
  if (!check(`…and the ${what}'s card can be measured`, facts != null) || !facts) return
  // TRIPWIRE 1 — it opens DOWNWARD. Below its own anchor, and so below the bar the anchor is under.
  check(
    `…the card opens BELOW the ${what}, never up over the toolbar`,
    facts.top >= facts.anchorTop,
    `card top=${facts.top.toFixed(0)} anchor top=${facts.anchorTop.toFixed(0)}`
  )
  check(
    '…and its top edge is below the whole filter bar',
    facts.top >= facts.barBottom,
    `card top=${facts.top.toFixed(0)} bar bottom=${facts.barBottom.toFixed(0)}`
  )
  // TRIPWIRE 2 — it holds no pointer events. This is the property the 0.15.0 card lacked.
  check(
    '…the card takes no pointer events at all',
    facts.pointerEvents === 'none',
    `computed pointer-events=${facts.pointerEvents}`
  )
  // …and the statement of what the user is owed, at this window width.
  for (const [control, name] of CONTROLS) {
    const cover = await whatCovers(page, control)
    check(
      `…and ${name} is still the topmost thing at its own centre (${what} hovered)`,
      cover.inside,
      `elementFromPoint hit <${cover.tag}>`
    )
  }
}

/**
 * AND THE ROSTER IS STILL THERE TO READ (JOS-173, in the card again since JOS-181).
 *
 * A card that cannot eat a click is trivially achievable by a card that says nothing, so the
 * reporter's own question is asked of the thing on screen: hovering a required item has to answer
 * WHO drops it, not just which island it is on. Read from the rendered block rather than from a
 * `title` attribute, because that is where the facts live again.
 */
async function stepCardNamesTheDropper(page: Page): Promise<void> {
  if (!(await hoverAt(page, ITEM_CHIP, 0.5, 0.5))) {
    note('could not hover a required-item chip for the roster check')
    return
  }
  const drops = await settleCount(page, CARD_DROPS, 1, { timeoutMs: 6000 })
  if (!check('the hovered item card carries a drop block', drops > 0, `blocks=${String(drops)}`)) return
  const text = await page.evaluate(
    (s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '',
    CARD_DROPS
  )
  // The 0.16.0 shape, pinned as what this must never be again: an island and nothing else.
  check('…it is not an island and nothing else (the 0.16.0 shape)', !/^Island \d+$/.test(text.trim()), text)
  check('…it says WHO drops the item', text.includes('Dropped by:'), text.replace(/\n/g, ' / '))
  // `Plane of Sky` is the zone every resolved Sky mob states, so a roster carrying it names a mob
  // rather than a wind rune's "random drop — any Plane of Sky mob" (which states no island at all).
  const named = text.includes('· Plane of Sky')
  check('…and names a catalog mob with its level and zone', named, text.replace(/\n/g, ' / '))
  note(`first roster: ${text.replace(/\n/g, ' / ')}`)
  await pointerAway(page)
}

/**
 * THE USER'S SENTENCE, END TO END, WITH A CARD OPEN: hover the chip whose card used to eat this
 * click, walk the pointer onto the dropdown, press ONCE, and change what it says.
 *
 * The press is spelled out as move / down / up rather than `page.click` for one reason: the card's
 * leave delay has to still be running when the button goes down, which is the only way this asserts
 * "the FIRST click, while a tooltip is visible" rather than "a click, after everything settled".
 * The popper count read between the move and the press is what says which of those two happened.
 *
 * Asserted by NAME rather than by index, and the value has to actually BECOME the other one —
 * "the menu opened" is not the report, "I cannot change it" is.
 */
async function stepSelectChanges(page: Page, sel: string, what: string): Promise<void> {
  const before = await selectValue(page, sel)
  if (!check(`the ${what} control states a value to begin with`, before.length > 0, before)) return

  await hoverAt(page, ITEM_CHIP, 0.5, 0.5)
  await settleCount(page, POPPER, 1, { timeoutMs: 4000 })
  const at = await centreOf(page, combo(sel))
  if (!check(`the ${what} control has a box to press`, at != null) || !at) return
  await page.mouse.move(at.x, at.y)
  const upAtPress = await countOf(page, POPPER)
  check(`a card is still open as the pointer reaches ${what}`, upAtPress > 0, `poppers=${String(upAtPress)}`)
  await page.mouse.down()
  await page.mouse.up()

  const options = await settleCount(page, OPTION, 2, { timeoutMs: 10_000 })
  if (!check(`ONE click on ${what} opens its menu, card and all`, options >= 2, `options=${String(options)}`)) {
    return
  }
  // …and the card let go the moment the pointer went down, rather than floating over the options.
  const stillUp = await settleStable(() => countOf(page, POPPER), { timeoutMs: 3000 })
  check(`…and the card is gone by the time ${what}'s options are up`, stillUp === 0, `poppers=${String(stillUp)}`)

  const labels = await page.evaluate(
    (s) => [...document.querySelectorAll(s)].map((o) => (o as HTMLElement).innerText.trim()),
    OPTION
  )
  const other = labels.find((l) => l !== before)
  if (!check(`…offering a value other than the one already chosen (${what})`, other != null, labels.join(' | '))) {
    return
  }

  await page.click(`${OPTION} >> text="${other ?? ''}"`, { timeout: 15_000 })
  const after = await settleStable(() => selectValue(page, sel), { timeoutMs: 6000 })
  check(`…and picking it actually changes ${what}`, after === other, `${before} -> ${after}`)
  await pointerAway(page)
}

/**
 * The chip-select on the same row, which is a different control with the same exposure: an
 * Autocomplete's listbox is a portal that opens straight down into the band a card used to fill.
 * Same hover-then-press sequence, so this too is a first click taken with a card open. Typing
 * rather than clicking an option, for the reason sky-filters states: a click into a portal is a bet
 * about layout that has nothing to do with what is being tested here.
 */
async function stepChipSelectOpens(page: Page): Promise<void> {
  await hoverAt(page, ITEM_CHIP, 0.5, 0.5)
  await settleCount(page, POPPER, 1, { timeoutMs: 4000 })
  const at = await centreOf(page, `${ISLAND} input`)
  if (!check('the island chip-select has a box to press', at != null) || !at) return
  await page.mouse.move(at.x, at.y)
  const upAtPress = await countOf(page, POPPER)
  check('a card is still open as the pointer reaches the island filter', upAtPress > 0, `poppers=${String(upAtPress)}`)
  await page.mouse.down()
  await page.mouse.up()
  const options = await settleCount(page, OPTION, 1, { timeoutMs: 10_000 })
  check('the island chip-select opens its list on that one click', options > 0, `options=${String(options)}`)
  await page.keyboard.press('Escape')
  await pointerAway(page)
}

async function main(): Promise<void> {
  buildIfStale()

  console.log('launch: hidden Electron (EQ_E2E=1) against tests/fixtures/e2e-copy.log…')
  const { app, close } = await launchOnFixture('e2e-copy.log')

  let page: Page | null = null
  try {
    page = await mainWindow(app)
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    await stepReady(page)
    await stepCardIsHarmless(page, ITEM_CHIP, 'first quest’s required-item chip', true)
    await pointerAway(page)
    await stepCardIsHarmless(page, KILL_TARGET, 'kill-target caption', false)
    await pointerAway(page)
    await stepCardNamesTheDropper(page)
    await stepSelectChanges(page, SORT, 'Sort')
    await stepSelectChanges(page, COUNT_SOURCE, 'Count items from')
    await stepChipSelectOpens(page)

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

    await dumpArtifacts(page, failures.length ? 'sky-dropdowns-FAIL' : 'sky-dropdowns-pass')
  } finally {
    await close()
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
