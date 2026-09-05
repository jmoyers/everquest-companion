/**
 * THE GEAR TAB'S COMPARISON PAIR (JOS-338, rewritten by JOS-344) — hover a search row and the app
 * draws the item you are pointing at and, beside it, what you are wearing in the slots it would go
 * in, WHERE A HUMAN CAN SEE THEM.
 *
 * ---------------------------------------------------------------------------
 * THE LESSON THIS FILE EXISTS TO CARRY: DOM PRESENCE IS NOT VISIBILITY
 * ---------------------------------------------------------------------------
 *
 * The first version of this module asserted that the card was in the DOM and what it said, and
 * every one of those assertions was green while the owner's screen showed NOTHING. Measured in a
 * headless run at the default window size: viewport 1268 wide, the anchored full-width `<tr>`
 * ending at x=1251, and the card drawn from x=1265 to x=1520 — three pixels of it inside the
 * glass. A card can be present, correct, readable by `textContent` and completely invisible.
 *
 * So the containment check below is not a nicety, it is the point: at the DEFAULT window size and
 * again at a NARROW one, both cards' boxes must lie inside the viewport. `checkPairOnScreen` is
 * exported because the Exaltations browser's donor rows mount the same pair (JOS-344 part 3) and
 * one law wants one instrument.
 *
 * TWO MEASURED TRAPS IN THAT INSTRUMENT, both worth knowing before editing it:
 *
 *   1. THE PAINTED RECT IS NOT THE LAYOUT RECT IN THIS HARNESS. `EQ_E2E=1` never shows the window,
 *      so it is never composited, and MUI's `Grow` transition freezes at its opening
 *      `scale(0.75, 0.5625)` — measured: the tooltip's computed transform stays that matrix
 *      forever, and a card whose layout box is 580px wide paints as 435px centred on the transform
 *      origin. That is a box 25% too SMALL and 37px too far right, which flatters every containment
 *      check ever written against it. So the box is reconstructed from the layout instead: climb
 *      the `offsetParent` chain to the POPPER — the outermost box below `body`, and the only one
 *      here whose transform is a pure TRANSLATE — and add the untransformed `offsetLeft/offsetTop`
 *      of everything below it. That is the geometry the user gets the moment the window paints.
 *      (Measured while writing this: the frozen scale sits on `.MuiTooltip-tooltip`, which is
 *      itself an `offsetParent`, so "the element's own offsetParent" is NOT far enough up.)
 *   2. THE ORDER IS READ AS COORDINATES, not as document order. "Item card, equipped card to its
 *      RIGHT" is the owner's ruling and a flex container can be told to reverse; the assertion is
 *      `item.right <= equipped.left`.
 *
 * WHAT ELSE NEEDS A REAL APP, given `tests/gearCompare.test.mts` owns the join, every word, and the
 * three source-pinned popper guarantees without a DOM:
 *
 *   1. A REAL POINTER ON A REAL ROW OPENS IT. The anchor, MUI's popper, the `plannerInventory` IPC
 *      and main's parse of the staged dump are four separate parts, and only a running app has all
 *      four.
 *   2. THE EQUIPPED CARD IS THE STAGED DUMP'S. The host spec stages the committed
 *      `Primitive_freeport-Inventory.txt` into the throwaway install, so `Primary  Thelvorn, Blade
 *      of Light +5` and `Secondary  Whitened Treant Fists` are facts on disk that have to travel
 *      main's parser, `equippedHosts`' cell assignment, the IPC and the renderer join to reach a
 *      hovered row. The expected words come from the card's own vocabulary, never typed.
 *   3. THE JOS-143 REGRESSION, WHICH IS THE STANDING RISK OF THE FEATURE. This table has carried
 *      "no popper on these dense rows" since it shipped, because twice (JOS-127, JOS-143) a card
 *      belonging to a row under a dropdown toolbar opened upward across it and ate the clicks aimed
 *      at the controls. So the pair is opened and then, WITH IT OPEN, the toolbar's era toggle and
 *      search box, the row's own wish heart (JOS-335) and the item name's Loot link are all
 *      hit-tested — `document.elementFromPoint` skips a `pointer-events: none` node, so this
 *      measures exactly what "the click still lands" means.
 *   4. IT CLOSES WHEN THE POINTER LEAVES (JOS-293's leave discipline, measured rather than trusted).
 *
 * IT LEAVES THE TAB AS IT FOUND IT: search box empty, both pickers cleared, the window back at the
 * size and minimum it arrived with, pointer parked off the table, no pair open — the steps after it
 * in `gear.e2e.mts` were written against that state.
 */
import type { ElectronApplication, Page } from 'playwright-core'
import { check, countOf, hoverAt, note, settle, settleGone, settleStable } from './appHarness.mjs'
import { clearPicks, pickIn } from './gearFilterSteps.mjs'
import type { GearRow } from '../../src/shared/planner/gear'
// The card's own words, so the expectation is COMPUTED from the module under test's own spelling
// rather than typed into this file (and a change to the spelling turns the unit test red first).
import { NO_BASE_CHANGE } from '../../src/renderer/src/features/gear/gearCompare'

const ROW = '[data-testid="gear-row"]'
/** The three nodes the JOS-344 layout is made of — exported for the Exaltations side. */
export const PAIR = '[data-testid="gear-compare-pair"]'
export const ITEM_CARD = '[data-testid="gear-compare-card"]'
export const EQUIPPED_CARD = '[data-testid="gear-compare-equipped-card"]'
const SEARCH = '[data-testid="gear-search"] input'
const SLOT_PICKER = '[data-testid="gear-slot"]'
const ERA_TOGGLE = '[data-testid="gear-era-toggle"]'
const WISH = '[data-testid="gear-wish"]'
const NAME_LINK = '[data-testid="planner-donor-name"]'

/** Below the app's own 900px minimum ON PURPOSE — see `stepNarrow`. */
const NARROW_W = 760

const rowOf = (key: string): string => `${ROW}[data-item-key="${key}"]`

const until = (fn: () => Promise<boolean>, ms: number): Promise<boolean> => settle(fn, (ok) => ok, { timeoutMs: ms })

/** One equipped cell of the open pair, as plain values a check can read. */
interface CardCell {
  cell: string
  name: string
  empty: boolean
  delta: string
}

interface PairRead {
  present: boolean
  /** the RIGHT card exists — absent before the first inventory read settles, and only then */
  equipped: boolean
  item: string
  stats: string
  /** the "simulated at Tier N" line — absent at base, which is where this step runs */
  simulated: boolean
  cells: CardCell[]
  freshness: string
  /** the no-dump hint drew instead of the equipped cells */
  noDump: boolean
}

const NO_PAIR: PairRead = {
  present: false,
  equipped: false,
  item: '',
  stats: '',
  simulated: false,
  cells: [],
  freshness: '',
  noDump: false
}

/**
 * Read the open pair.
 *
 * NO NAMED FUNCTION BINDINGS inside `page.evaluate` (repo law — tsx/esbuild's `keepNames` wraps
 * `const f = …` in a `__name` helper that lives in the NODE bundle, and the page dies on
 * `ReferenceError: __name is not defined`). Inline callbacks are fine; a `const` one is not.
 */
export function readPair(page: Page): Promise<PairRead> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) {
      return { present: false, equipped: false, item: '', stats: '', simulated: false, cells: [], freshness: '', noDump: false }
    }
    const card = el.querySelector('[data-testid="gear-compare-card"]')
    return {
      present: true,
      equipped: el.querySelector('[data-testid="gear-compare-equipped-card"]') !== null,
      item: card?.getAttribute('data-item-key') ?? '',
      stats: (el.querySelector('[data-testid="gear-compare-stats"]')?.textContent ?? '').trim(),
      simulated: el.querySelector('[data-testid="gear-compare-simulated"]') !== null,
      cells: Array.from(el.querySelectorAll('[data-testid="gear-compare-slot"]')).map((c) => ({
        cell: c.getAttribute('data-cell') ?? '',
        name: (c.querySelector('[data-testid="gear-compare-equipped-name"]')?.textContent ?? '').trim(),
        empty: c.querySelector('[data-testid="gear-compare-empty"]') !== null,
        delta: (c.querySelector('[data-testid="gear-compare-delta"]')?.textContent ?? '').trim()
      })),
      freshness: (el.querySelector('[data-testid="gear-compare-freshness"]')?.textContent ?? '').trim(),
      noDump: el.querySelector('[data-testid="gear-compare-nodump"]') !== null
    }
  }, PAIR)
}

/** One box in viewport coordinates. */
interface Box {
  l: number
  t: number
  r: number
  b: number
}

interface PairGeometry {
  vw: number
  vh: number
  pair: Box | null
  item: Box | null
  equipped: Box | null
}

/** The LAYOUT geometry of the open pair — see trap 1 in the header for why not `getBoundingClientRect`. */
function pairGeometry(page: Page): Promise<PairGeometry> {
  return page.evaluate(() => {
    const boxes = ['gear-compare-pair', 'gear-compare-card', 'gear-compare-equipped-card'].map((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
      if (!el) return null
      // Climb the offsetParent chain to the POPPER — the outermost box before `body`, and the only
      // one in this subtree whose own transform is a pure translate, so its client rect is honest.
      // Everything below it contributes untransformed `offsetLeft/Top`, which is exactly the
      // geometry the frozen `Grow` scale hides (trap 1). No named `const` function bindings in
      // here: `keepNames` would emit a `__name` helper the page does not have.
      let node = el
      let dx = 0
      let dy = 0
      while (node.offsetParent instanceof HTMLElement && node.offsetParent !== document.body) {
        dx += node.offsetLeft
        dy += node.offsetTop
        node = node.offsetParent
      }
      const base = node.getBoundingClientRect()
      const l = (node === el ? base.left : base.left + dx)
      const t = (node === el ? base.top : base.top + dy)
      return { l: Math.round(l), t: Math.round(t), r: Math.round(l + el.offsetWidth), b: Math.round(t + el.offsetHeight) }
    })
    return {
      vw: document.documentElement.clientWidth,
      vh: document.documentElement.clientHeight,
      pair: boxes[0],
      item: boxes[1],
      equipped: boxes[2]
    }
  })
}

const say = (b: Box | null): string => (b === null ? 'absent' : `x ${String(b.l)}→${String(b.r)}  y ${String(b.t)}→${String(b.b)}`)

/**
 * THE ASSERTION THE OFF-SCREEN DEFECT WOULD HAVE FAILED, and the one the shipped spec never made.
 *
 * Both cards are inside the window, and the equipped one is to the RIGHT of the item one. The
 * geometry is allowed to STOP MOVING first (`settleStable`) — popper places, then re-places once
 * the modifiers have measured the popper it just placed.
 */
export async function checkPairOnScreen(page: Page, label: string): Promise<void> {
  await settleStable(() => pairGeometry(page).then((g) => JSON.stringify(g)), { timeoutMs: 10_000 })
  const g = await pairGeometry(page)
  const { item, equipped, vw, vh } = g
  if (!check(`${label}: both cards of the pair are drawn`, item !== null && equipped !== null, say(item) + ' | ' + say(equipped))) {
    return
  }
  for (const [what, box] of [['the item card', item], ['the equipped card', equipped]] as const) {
    if (box === null) continue
    check(
      `${label}: ${what} is inside the window — every edge of it`,
      box.l >= 0 && box.t >= 0 && box.r <= vw && box.b <= vh,
      `${say(box)} in a ${String(vw)}×${String(vh)} viewport`
    )
  }
  if (item !== null && equipped !== null) {
    check(
      `${label}: the equipped card is to the RIGHT of the item card, not under it`,
      item.r <= equipped.l && item.t === equipped.t,
      `${say(item)} then ${say(equipped)}`
    )
  }
}

/**
 * Is the control the thing at its own centre, or has something been drawn over it?
 *
 * BORROWED VERBATIM FROM `levelingLayoutSteps.mts` (JOS-289), where the same question was asked of
 * a spilling panel. Returns a WORD, so a failure names what covered the control instead of just
 * saying false.
 */
export function hitTest(page: Page, s: string): Promise<string> {
  return page.evaluate((q) => {
    const el = document.querySelector(q)
    if (!el) return 'absent'
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return 'collapsed to nothing'
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    if (!top) return 'nothing at its centre'
    if (el.contains(top) || top.contains(el)) return 'hit'
    return `covered by ${top.tagName}.${String(top.className).slice(0, 40)}`
  }, s)
}

/**
 * Resize and WAIT FOR THE CONDITION (wave E3) — the `levelingLayoutSteps.resizeTo` pattern, which
 * reads the renderer's own viewport first because a resize crosses Electron, the OS, Chromium's
 * layout and React before anything measurable moves. Exported: the exalt side narrows too.
 */
export async function resizeTo(app: ElectronApplication, page: Page, width: number, height: number): Promise<number> {
  const win = await app.browserWindow(page)
  await win.evaluate((w, b) => {
    // Below the app's own 900px minimum nothing would move at all; the combat dashboard's narrow
    // step lifts the same floor for the same reason, and the caller puts it back.
    w.setMinimumSize(360, 360)
    w.setBounds({ ...w.getBounds(), width: b.w, height: b.h })
  }, { w: width, h: height })
  return settle(() => page.evaluate(() => document.documentElement.clientWidth), (v) => Math.abs(v - width) <= 24, {
    timeoutMs: 15_000
  })
}

/** Put the app's own window minimum back, so a narrow step cannot leak a 360px app. */
export async function restoreMinimum(app: ElectronApplication, page: Page): Promise<void> {
  const win = await app.browserWindow(page)
  await win.evaluate((w) => {
    w.setMinimumSize(900, 600)
  })
}

/** Point at something and wait for its pair to have an ANSWER in it, not merely to be in the DOM. */
export async function openPairOn(page: Page, selector: string, key: string): Promise<PairRead> {
  if (!(await hoverAt(page, selector, 0.5, 0.5))) return NO_PAIR
  return settle(() => readPair(page), (c) => c.present && c.item === key, { timeoutMs: 20_000 })
}

/**
 * The same, AFTER A RESIZE — which is a different question and needs a different instrument.
 *
 * `resizeTo` returns as soon as the renderer AGREES about the viewport width, and the layout inside
 * it keeps moving for a few frames after that (wave E3's measured trap, `levelingLayoutSteps` says
 * the same thing about bands). A hover aimed at where a row USED to be lands on the row above it
 * and opens nothing. So the anchor's own box is allowed to stop moving first, and the hover is
 * given a second attempt — a lost pointer is not a missing card and this step must not report one
 * as the other.
 */
export async function openPairSettled(page: Page, selector: string, key: string): Promise<PairRead> {
  await settleStable(
    () =>
      page.evaluate((q) => {
        const r = document.querySelector(q)?.getBoundingClientRect()
        return r ? `${String(Math.round(r.left))},${String(Math.round(r.top))},${String(Math.round(r.width))}` : 'gone'
      }, selector),
    { timeoutMs: 15_000 }
  )
  const first = await openPairOn(page, selector, key)
  if (first.present) return first
  await closePair(page)
  return openPairOn(page, selector, key)
}

/** Move the pointer off the list and prove the pair went with it. */
export async function closePair(page: Page): Promise<boolean> {
  await page.mouse.move(4, 4)
  await settleGone(page, PAIR, { timeoutMs: 10_000 })
  return (await countOf(page, PAIR)) === 0
}

/**
 * 1. THE PAIR, ON THE ROW THE HOST SPEC ALREADY PINS.
 *
 * Thelvorn is a PRIMARY item and the staged dump wears one at +5, so this single row proves the
 * whole chain AND the ruling on it (2026-09-05): the card compares BASE AGAINST BASE — the route's
 * own math — so a candidate identical to the worn copy shows NO differences and SAYS so, with the
 * merged tier stated in the frame label. The expected words come from the card's own
 * `NO_BASE_CHANGE`, so this spec cannot drift from the wording.
 */
async function stepPairOpens(page: Page, base: GearRow): Promise<boolean> {
  await page.fill(SEARCH, base.name, { timeout: 15_000 })
  const onScreen = await until(async () => (await countOf(page, rowOf(base.key))) === 1, 20_000)
  if (!check('the comparison step has its row on screen', onScreen)) return false
  check('no card is open until something is pointed at', (await countOf(page, PAIR)) === 0)

  const card = await openPairOn(page, rowOf(base.key), base.key)
  if (!check('pointing at a gear row opens its comparison pair', card.present, JSON.stringify(card).slice(0, 200))) {
    return false
  }
  check('…and the item card is about the row the pointer is on', card.item === base.key, card.item)
  check('the item card states the item’s own numbers', card.stats.includes('DMG'), card.stats || '(none)')
  check('…and says nothing about a simulation, because the selector is at base', !card.simulated)
  check('the equipped card is drawn beside it, because the staged dump has been read', card.equipped)
  checkEquippedCard(card)
  checkFreshness(card)
  await checkPairOnScreen(page, 'default size')
  return true
}

/**
 * THE DUMP'S AGE, ON THE EQUIPPED CARD (JOS-253's truth, through `outputAgeLabel`).
 *
 * A floating card that says what you are wearing has to say how old that claim is — and over a
 * staged dump that exists it must NOT be offering the run-the-command hint instead. Since JOS-344
 * the line lives on the RIGHT card, which is the one whose claim it dates.
 */
function checkFreshness(card: PairRead): void {
  check(
    'the equipped card says how old the dump making that claim is',
    card.freshness.includes('inventory dump') && card.freshness.includes('updated'),
    card.freshness || '(no line)'
  )
  check('…and does not offer the run-the-command hint, because there IS a dump', !card.noDump)
}

/**
 * The card this ticket exists for, read against the file on disk.
 *
 * ONE CELL, because the corpus states one slot for this item — and the name in it is a line of the
 * staged dump. The comparison is BASE AGAINST BASE (the 2026-09-05 ruling), so the same item shows
 * `NO_BASE_CHANGE` — the card's own words — while the name still states the worn copy's `+5`.
 */
function checkEquippedCard(card: PairRead): void {
  check(
    'the equipped card names the cell this item would go in, once',
    card.cells.length === 1 && card.cells[0].cell === 'PRIMARY',
    card.cells.map((c) => c.cell).join(', ') || '(no cells)'
  )
  const first = card.cells[0] as CardCell | undefined
  check(
    'and it names what the staged dump says is in that hand, at its own +N',
    first?.name === 'Thelvorn, Blade of Light +5',
    first?.name ?? '(nothing)'
  )

  check(
    'base against base, the same item is no change — and the card says so in its own words',
    (first?.delta ?? '').includes(NO_BASE_CHANGE),
    `card says "${first?.delta ?? ''}" · wanted "${NO_BASE_CHANGE}"`
  )
}

/**
 * 2. THE NARROW WINDOW — where "it fits" stops being luck.
 *
 * The pair is ~584px wide and the list starts ~237px in, so at the default size it clears the right
 * edge with room to spare and a containment check there proves only that today's numbers happen to
 * add up. `NARROW_W` is BELOW the app's own 900px minimum on purpose: it is the width at which the
 * pair's natural right edge lands past the glass, so the only thing that can keep it on screen is
 * `preventOverflow` sliding it — which is precisely the modifier JOS-338 had switched off.
 */
async function stepNarrow(app: ElectronApplication, page: Page, key: string): Promise<void> {
  const win = await app.browserWindow(page)
  const wide = await win.evaluate((w) => w.getBounds())
  const got = await resizeTo(app, page, NARROW_W, Math.min(wide.height, 760))
  note(`narrowed the window past the app's own minimum: ${String(got)}px of viewport`)
  const card = await openPairSettled(page, rowOf(key), key)
  if (check('narrow: pointing at the row still opens the pair', card.present)) {
    await checkPairOnScreen(page, 'narrow')
  }
  await closePair(page)
  await resizeTo(app, page, wide.width, wide.height)
  await restoreMinimum(app, page)
}

/**
 * 3. THE JOS-143 REGRESSION, HIT-TESTED WITH THE PAIR OPEN.
 *
 * Four controls are asked whether they are still the thing at their own centre: two in the toolbar
 * ABOVE the list — the place both historical reports failed — and two INSIDE the hovered row
 * itself, which is the pair this ticket could most easily have broken.
 */
async function stepStillClickable(page: Page, key: string): Promise<void> {
  const card = await openPairOn(page, rowOf(key), key)
  if (!check('the pair is open for the hit test', card.present)) return
  for (const [what, selector] of [
    ['the era toggle in the toolbar above', ERA_TOGGLE],
    ['the search box', SEARCH],
    ['the row’s own wish heart', `${rowOf(key)} ${WISH}`],
    ['the item name’s Loot link', `${rowOf(key)} ${NAME_LINK}`]
  ] as const) {
    const verdict = await hitTest(page, selector)
    check(`with the pair open, ${what} is still the thing a click would reach`, verdict === 'hit', verdict)
  }
  check('the pair is still open — the hit test measured a live card, not an absent one', (await countOf(page, PAIR)) === 1)
  check('and it closes when the pointer leaves the row', await closePair(page))
}

/**
 * 4. THE SECOND HAND, and the dedupe.
 *
 * A row is taken OFF THE SCREEN rather than named here (AGENTS.md, "frozen numbers rot" — a frozen
 * item name rots the same way when the corpus is rescraped): the slot picker is set to SECONDARY,
 * and whatever the table then shows must be compared against `Whitened Treant Fists`, which is what
 * the staged dump has in that hand. A row that states BOTH hands additionally proves the dedupe —
 * two cells, never one twice — and when the visible set has none, that is a NOTE rather than a
 * failure, because which items state two slots is the corpus's business and not this spec's.
 */
async function stepSecondHand(page: Page): Promise<void> {
  await page.fill(SEARCH, '', { timeout: 15_000 })
  await pickIn(page, SLOT_PICKER, 'SECONDARY')
  const listed = await until(async () => (await countOf(page, ROW)) > 0, 20_000)
  if (!check('the slot picker leaves secondary-hand rows on screen', listed)) {
    await clearPicks(page, SLOT_PICKER)
    return
  }
  const key = await page.evaluate((s) => document.querySelector(s)?.getAttribute('data-item-key') ?? '', ROW)
  const card = await openPairOn(page, rowOf(key), key)
  if (check(`pointing at a secondary-slot row opens its pair (${key})`, card.present)) {
    const secondary = card.cells.find((c) => c.cell === 'SECONDARY')
    check(
      'the SECONDARY cell names what the staged dump has in that hand, at its own +N',
      secondary?.name === 'Whitened Treant Fists +4',
      secondary?.name ?? `(no SECONDARY cell; cells: ${card.cells.map((c) => c.cell).join(', ')})`
    )
    const cells = card.cells.map((c) => c.cell)
    check('no cell is compared twice', new Set(cells).size === cells.length, cells.join(', '))
    if (cells.length > 1) {
      check(
        'an item that states two slots is compared against both of them',
        cells.includes('PRIMARY') && cells.includes('SECONDARY'),
        cells.join(', ')
      )
    } else {
      note(`the first secondary row on screen (${key}) states one slot — the two-slot dedupe is pinned in tests/gearCompare.test.mts`)
    }
  }
  await closePair(page)
  await clearPicks(page, SLOT_PICKER)
}

/** The whole comparison step. Hands the tab back with nothing narrowed and no pair open. */
export async function stepGearCompare(app: ElectronApplication, page: Page, base: GearRow): Promise<void> {
  if (await stepPairOpens(page, base)) {
    await stepStillClickable(page, base.key)
    await stepNarrow(app, page, base.key)
  }
  await closePair(page)
  await stepSecondHand(page)
  await page.fill(SEARCH, '', { timeout: 15_000 })
}
