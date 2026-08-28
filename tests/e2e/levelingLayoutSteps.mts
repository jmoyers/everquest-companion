// THE LEVELING TAB'S LAYOUT CONTRACT — the PAGE scrolls and the panels do not, and no two panels
// draw over each other (JOS-289, which inverted the claim JOS-151 wrote here; GitHub issue 14).
//
// LIVING NEXT DOOR because leveling.e2e.mts sits AT the repo max-lines budget and the rule here is
// to SPLIT, never ratchet — sliceSteps.mts states the precedent and dropSteps.mts, combatSteps.mts
// and plannerSteps.mts set it. Both halves of "what this tab does with the height it is given"
// live together: the scroll claim and the narrow-window collision claim are only meaningful about
// each other.
//
// WHAT THIS FILE USED TO ASSERT, AND WHY IT NO LONGER DOES. Until JOS-289 the headline check was
// `the Leveling tab never scrolls the page (its panels scroll inside themselves)` — the standing
// app law, honestly measured. The OWNER OVERTURNED THE LAW FOR THIS TAB (directive 2026-08-13,
// verbatim: *the entire pane should scroll*). The panels-scroll-inside-themselves half was the
// defect, not the design: the per-level SPELL READOUT was four and a half rows of a twelve-row
// list read through a 120px slot, the zone legend showed two wrapped lines of however many zones
// you had visited, the AA ledger showed seven of fifty abilities, and the whole charts column sat
// behind a scroller of its own. So the assertion is INVERTED rather than deleted: the app content
// area is the ONE scroller, the view owns none, and the deepest panel is reachable by scrolling
// the page. `over.doc === 0` survives untouched — the WINDOW must still never scroll; the shell is
// `height: 100vh; overflow: hidden` and a document scrollbar would mean the chrome had moved.
//
// AND WHERE "New at this level" LIVES NOW (JOS-300, owner directive 2026-08-13). JOS-289 left it
// full width under both columns, which put a browsable reference panel at the page's own bottom
// and left an enormous hole beside it: the charts column ends well short of the
// ledger/drops/feed column. The panel moved into the BOTTOM OF THE LEFT COLUMN to fill that hole,
// which retires a claim this file used to make. "Deepest" no longer means "last": whichever
// column is taller owns the page's bottom, and on a log with a long AA ledger that is the RIGHT
// one, so scrolling the content area to `scrollHeight` can legitimately leave the panel ABOVE the
// fold. What survives — and what the owner's sentence was ever about — is that the panel is
// reached by scrolling the PAGE rather than by finding a box to scroll inside it. That is what
// `stepPageScroll` measures now: a scroll request routed through the content area (the only
// scroller between this panel and the window) brings it fully into view, and the content area's
// own scrollTop MOVED to do it. The page-really-grows half is still measured, as its own claim
// about the page rather than about the panel.
//
// WHY THE NARROW CHECKS ARE SHAPED THIS WAY. "Do two panels overlap" is only an honest question
// about boxes the user can SEE, and a page-tall view has most of itself outside the viewport at
// any moment — a raw `getBoundingClientRect()` cheerfully reports a panel two screens down sitting
// on top of one in frame. So every box is intersected with EVERY clipping ancestor first (`hoverAt`
// in appHarness.mts had to learn the same lesson), and a band scrolled out of frame has zero area
// and cannot collide with anything.
//
// WHAT THE ORIGINAL DEFECT WAS, measured at the reporter's 1073x937: below MUI's `lg` the tab's
// two columns became two rows and kept their side-by-side 2:1 split of a FIXED height. The second
// band was handed 198px for three intrinsically tall papers, the AA ledger squeezed to 89px, the
// progress feed to 34px, and both spilled and drew over "New at this level" (23px and 34px of real
// overlap). There is no fixed height to split any more, which is a stronger fix than the stacking
// one — but the collision check stays, because "stronger fix" is a claim and this is a measurement.
//
// AND WHY 900: that is the main window's own `minWidth` (src/main/windows.ts), so it is the
// narrowest the user can actually make it and the worst case for a height split. The reporter's
// 1073 is the same branch of the same breakpoint — one width proves the branch.

import type { ElectronApplication, Page } from 'playwright-core'
import { check, countOf, hoverAt, note, pageOverflow, settle, settleCount, settleGone, settleStable, sleep } from './appHarness.mjs'

/** The app's own minimum window width (src/main/windows.ts) — the narrowest a user can get. */
const MIN_W = 900

/** The app shell's scrolling content area — since JOS-289 the ONE scroller this tab sits inside. */
const CONTENT = '[data-testid="app-content"]'
/**
 * The panel furthest down the LEFT column since JOS-300 — below the charts, the plots and the
 * range read, and below the fold on any tab tall enough to scroll. Deliberately NOT called the
 * page's bottom any more: the right column is frequently the taller of the two and owns the last
 * pixel. This is the deep-link target ("New at this level"), which is why reaching it is a claim
 * worth measuring at all.
 */
const DEEPEST = '[data-testid="new-at-level"]'
/** A spell name in the per-level readout, and the card it opens (lib/SpellCard.tsx). */
const SPELL_NAME = '[data-testid="unlock-spell-name"]'
const SPELL_CARD = '[data-testid="spell-hover-card"]'

/**
 * The ONE internal vertical scroller this tab is allowed to keep, by testid.
 *
 * The JOS-260 rule, applied rather than waived: a list stays windowed where the ROW COUNT demands
 * it. The in-window drops list is the only one here that qualifies — 641 distinct looted item
 * names in the owner's log (measured 2026-08-13), all of which the `All` slice legitimately asks
 * for — and even it is a `maxHeight` ceiling rather than a height, so a scope with a dozen drops
 * shows all twelve and this element does not scroll at all.
 */
const JUSTIFIED_SCROLLERS = ['leveling-drops-list']

/**
 * ANSWER THE ANALYTICS FIRST-RUN NOTICE, which a FRESH `userData` always shows and which is a
 * `position: fixed` Snackbar pinned 16px off the bottom of the WINDOW — over whatever the content
 * area has scrolled under it.
 *
 * MEASURED, and it is JOS-289 that made it matter here. This spec hit-tests and hovers, and both
 * ask `elementFromPoint`. While the tab was clamped to the viewport, the charts column's own
 * scroller never parked a plot against the window's bottom edge; now that the PAGE scrolls,
 * `scrollIntoViewIfNeeded` legitimately lands the level chart at 704..860 in an 860px window and
 * the notice covers its middle. The curve readout step then hovered the notice and read no card —
 * a true report about a first-run overlay, and nothing at all about the curve.
 *
 * "Turn it off" rather than "dismiss": a spec should not leave a second feature collecting in the
 * background while it measures a third. perf.e2e.mts, cursor-ring-color and cursor-ring-zoom each
 * carry their own copy of this; a fourth is a consolidation ticket, not a reason to skip it.
 */
export async function dismissFirstRunNotice(page: Page): Promise<void> {
  const notice = '[data-testid="telemetry-notice"]'
  await page.waitForSelector(notice, { timeout: 30_000 }).catch(() => undefined)
  if ((await countOf(page, notice)) === 0) return
  await page.click('[data-testid="telemetry-notice-off"]')
  check('the analytics first-run notice can be answered out of the way', await settleGone(page, notice, { timeoutMs: 8_000 }))
}

/** A top-level panel of the tab, as the user SEES it: clipped by every scroller above it. */
interface Band {
  /** its first line of text, which is what makes a failure readable */
  name: string
  x: number
  y: number
  w: number
  h: number
}

/**
 * Every outermost Paper on the Leveling tab, intersected with each clipping ancestor.
 *
 * Outermost only: a chip or a nested card is a part of a panel, not a band of the page, and
 * counting them would report every panel as colliding with its own contents.
 */
function visibleBands(page: Page): Promise<Band[]> {
  return page.evaluate(() => {
    const view = document.querySelector('[data-testid="leveling-view"]')
    if (!view) return [] as Band[]
    const out: Band[] = []
    for (const el of Array.from(view.querySelectorAll('.MuiPaper-root'))) {
      const node = el as HTMLElement
      if (node.parentElement?.closest('.MuiPaper-root')) continue
      const r = node.getBoundingClientRect()
      let x0 = r.left
      let y0 = r.top
      let x1 = r.right
      let y1 = r.bottom
      for (let p = node.parentElement; p; p = p.parentElement) {
        const cs = getComputedStyle(p)
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
        const pr = p.getBoundingClientRect()
        x0 = Math.max(x0, pr.left)
        y0 = Math.max(y0, pr.top)
        x1 = Math.min(x1, pr.right)
        y1 = Math.min(y1, pr.bottom)
      }
      out.push({
        name: (node.innerText || '').split('\n')[0].slice(0, 40),
        x: Math.round(x0),
        y: Math.round(y0),
        w: Math.round(x1 - x0),
        h: Math.round(y1 - y0)
      })
    }
    return out
  })
}

/** Pairs of bands that share pixels. A band scrolled out of view has no area and cannot. */
function collisionsOf(bands: Band[]): string[] {
  const hits: string[] = []
  for (let i = 0; i < bands.length; i++) {
    for (let j = i + 1; j < bands.length; j++) {
      const a = bands[i]
      const b = bands[j]
      if (a.w <= 0 || a.h <= 0 || b.w <= 0 || b.h <= 0) continue
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      if (ox > 1 && oy > 1) hits.push(`"${a.name}" over "${b.name}" (${String(ox)}x${String(oy)}px)`)
    }
  }
  return hits
}

interface ColumnsInfo {
  /** one box per band of the tab's two-column stack, in DOM order */
  bands: { x: number; y: number; h: number; spill: number; scrolls: boolean }[]
  /** does the stack itself scroll? Since JOS-289 the answer must be NO at every width. */
  regionScrolls: boolean
}

/** The two-column stack and its bands — the one element the JOS-151 fix was about. */
function columnsInfo(page: Page): Promise<ColumnsInfo | null> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="leveling-columns"]')
    if (!el) return null
    return {
      bands: Array.from(el.children).map((c) => {
        const box = c as HTMLElement
        const r = box.getBoundingClientRect()
        const ov = getComputedStyle(box).overflowY
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          h: Math.round(r.height),
          spill: box.scrollHeight - box.clientHeight,
          scrolls: ov === 'auto' || ov === 'scroll'
        }
      }),
      regionScrolls: el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY === 'auto'
    }
  })
}

/**
 * Is the control the thing at its own centre, or has something been drawn over it?
 *
 * The point of the ticket, stated as a hit test rather than as geometry: a covered control is one
 * a click cannot reach, which is the same failure JOS-127 removed the loot ledger's hover cards
 * for. Returns a WORD, so a failure says what covered it instead of just `false`.
 */
function hitTest(page: Page, sel: string): Promise<string> {
  return page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return 'absent'
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return 'collapsed to nothing'
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    if (!top) return 'nothing at its centre'
    if (el.contains(top) || top.contains(el)) return 'hit'
    return `covered by ${top.tagName}.${String(top.className).slice(0, 40)}`
  }, sel)
}

/**
 * Resize and WAIT FOR THE CONDITION (wave E3), which here has to be TWO conditions: a resize
 * crosses Electron, the OS, Chromium's layout and React, and settling on geometry alone can
 * settle three identical readings before the request has even left the main process — measured
 * twice while writing this, both times reporting the old width as if it were the new one. So the
 * renderer's own viewport is read first, and only then are the boxes allowed to stop moving.
 */
async function resizeTo(app: ElectronApplication, page: Page, width: number, height: number): Promise<number> {
  const win = await app.browserWindow(page)
  await win.evaluate((w, b) => {
    // Below the app's own minimum nothing here would even be reachable; lifting it is how the
    // combat dashboard's narrow step exercises the same CSS, and it is put back at the end.
    w.setMinimumSize(360, 360)
    w.setBounds({ ...w.getBounds(), width: b.w, height: b.h })
  }, { w: width, h: height })
  const got = await settle(
    () => page.evaluate(() => document.documentElement.clientWidth),
    (v) => Math.abs(v - width) <= 24,
    { timeoutMs: 15_000 }
  )
  await settleStable(() => visibleBands(page).then((b) => JSON.stringify(b)), { timeoutMs: 15_000 })
  return got
}

/** One element inside the view that scrolls vertically, named well enough to fix. */
interface InnerScroller {
  id: string
  what: string
  spill: number
}

/**
 * Every element inside the Leveling view that is BOTH declared a vertical scroller AND actually
 * overflowing — i.e. every place the user would see an internal scrollbar.
 *
 * Both halves matter. A declared-but-not-overflowing box is exactly what a generous `maxHeight`
 * ceiling looks like on a short list, and reporting it would fail the tab for doing the right
 * thing; an overflowing box with `overflow: visible` is not a scroller at all, it is the page
 * doing its job. Only the intersection is the smell JOS-289 removed.
 */
function innerScrollers(page: Page): Promise<InnerScroller[]> {
  return page.evaluate(() => {
    const view = document.querySelector('[data-testid="leveling-view"]')
    if (!view) return [] as InnerScroller[]
    const out: InnerScroller[] = []
    for (const el of Array.from(view.querySelectorAll('*'))) {
      const node = el as HTMLElement
      const ov = getComputedStyle(node).overflowY
      if (ov !== 'auto' && ov !== 'scroll') continue
      const spill = node.scrollHeight - node.clientHeight
      if (spill <= 1) continue
      out.push({
        id: node.getAttribute('data-testid') ?? '',
        what: `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 40)}`,
        spill
      })
    }
    return out
  })
}

/** The app content area's scroll geometry — the one scroller the tab is supposed to grow. */
function contentScroll(page: Page): Promise<{ top: number; height: number; client: number } | null> {
  return page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null
    return el ? { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight } : null
  }, CONTENT)
}

/** Scroll the content area to its very bottom and WAIT for it to land there. */
async function scrollContentToBottom(page: Page): Promise<number> {
  await page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null
    if (el) el.scrollTop = el.scrollHeight
  }, CONTENT)
  return settle(
    () => contentScroll(page).then((c) => (c ? Math.round(c.top) : -1)),
    (v) => v > 0,
    { timeoutMs: 5_000 }
  )
}

/** Put the page back at the top and WAIT for it, so the next step measures a known scroll. */
async function resetContentScroll(page: Page): Promise<void> {
  await page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null
    if (el) el.scrollTop = 0
  }, CONTENT)
  await settle(() => contentScroll(page).then((c) => (c ? Math.round(c.top) : -1)), (v) => v === 0, { timeoutMs: 5_000 })
}

/** Is `sel` fully inside the content area's visible box right now? */
function fullyInContent(page: Page, sel: string): Promise<string> {
  return page.evaluate(
    (a) => {
      const el = document.querySelector(a.sel)
      const box = document.querySelector(a.content)
      if (!el || !box) return 'absent'
      const r = el.getBoundingClientRect()
      const b = box.getBoundingClientRect()
      if (r.height < 1) return 'collapsed to nothing'
      if (r.bottom > b.bottom + 2) return `${String(Math.round(r.bottom - b.bottom))}px below the fold`
      if (r.top < b.top - 2) return `${String(Math.round(b.top - r.top))}px above the fold`
      return 'in view'
    },
    { sel, content: CONTENT }
  )
}

/**
 * 7. THE LAYOUT CONTRACT SINCE JOS-289: the app's content area owns the scroll, THE WHOLE VIEW
 * grows into it, and no panel keeps a scroller of its own except the one whose row count earns it.
 *
 * Four claims. The last two are the owner's sentence stated as measurements, and JOS-300 split
 * them apart on purpose:
 *
 *   - THE PAGE GROWS AND SCROLLS. Drive the content area to `scrollHeight` and it lands somewhere
 *     past zero. That is a fact about the page, and it is no longer tied to any one panel — since
 *     the reference panel moved into the left column, the bottom of the page belongs to whichever
 *     column is taller, which is usually the ledger/drops/feed one.
 *   - THE DEEP-LINK PANEL IS REACHED BY SCROLLING THE PAGE. Ask for it with
 *     `scrollIntoViewIfNeeded` and it comes fully into the content area's visible box, AND the
 *     content area's own scrollTop had to move to get there. The second half is what makes this a
 *     page-scroll claim rather than a tautology: `[data-testid="app-content"]` is the only
 *     scroller between this panel and the window, so if the panel arrived and something scrolled,
 *     the page is what scrolled. An inner porthole doing the work would leave scrollTop at 0 —
 *     and would also have already failed the no-internal-scrollbars claim above.
 */
export async function stepPageScroll(page: Page): Promise<void> {
  const over = await pageOverflow(page)
  check(
    'the WINDOW itself never scrolls (the shell is 100vh; a document scrollbar means the chrome moved)',
    over.doc === 0,
    `document +${String(over.doc)}px`
  )

  const inner = await innerScrollers(page)
  const unjustified = inner.filter((s) => !JUSTIFIED_SCROLLERS.includes(s.id))
  check(
    'no panel on the Leveling tab shows an internal vertical scrollbar (the page is the scroller)',
    unjustified.length === 0,
    unjustified.length
      ? unjustified.map((s) => `${s.id || s.what} +${String(s.spill)}px`).slice(0, 4).join(' · ')
      : `${String(inner.length)} declared scroller(s), all justified`
  )

  const before = await contentScroll(page)
  if (!check('the app content area is measurable', before !== null) || !before) return
  if (before.height <= before.client + 1) {
    note(
      `this log's Leveling tab fits the window without scrolling (${String(before.height)}px of content in ${String(before.client)}px) — there is nothing for a page scroll to reach, which is the honest state and not a clamp`
    )
    return
  }
  note(`the tab is ${String(before.height)}px tall in a ${String(before.client)}px window — it grew the page, as JOS-289 asks`)

  // CLAIM 3, about the PAGE and nothing else: it can be driven to its own bottom. Deliberately
  // not asserted against any panel since JOS-300 — the deepest pixel belongs to whichever column
  // ran longer, and tying a panel to it would be measuring this fixture's ledger length.
  const landed = await scrollContentToBottom(page)
  check(
    'the page scrolls to its own bottom (the content area is the scroller that grew)',
    landed > 0,
    `scrollTop ${String(landed)} of ${String(before.height - before.client)}px of travel`
  )
  await resetContentScroll(page)

  // CLAIM 4: the deep-link panel is below the fold, and PAGE scroll is what brings it into view.
  const beforeReach = await fullyInContent(page, DEEPEST)
  if (beforeReach === 'in view') {
    note('the "New at this level" panel already sits fully on the first screen of this tab — a short left column is an honest state, and there is no page-scroll reach to measure')
    return
  }
  await page.locator(DEEPEST).first().scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined)
  const reach = await settle(() => fullyInContent(page, DEEPEST), (v) => v === 'in view', { timeoutMs: 5_000 })
  const moved = await contentScroll(page)
  check(
    'scrolling the PAGE reaches the "New at this level" panel at the bottom of the left column',
    reach === 'in view' && (moved?.top ?? 0) > 0,
    `${beforeReach} → ${reach} at scrollTop ${String(Math.round(moved?.top ?? -1))}`
  )
  await resetContentScroll(page)
}

/**
 * 7c. THE SPELL CARD IN THE PER-LEVEL READOUT (JOS-293's card, integrated by JOS-289).
 *
 * Here rather than in leveling.e2e.mts because the two halves prove each other: the unlock list is
 * the surface the owner named as cramped, and a hover card is the thing a 120px porthole made
 * useless — you cannot point at a row you cannot see. The card is `lib/SpellCard`'s, which fetches
 * the whole record from main on open, so this also proves the IPC reaches this surface.
 */
export async function stepSpellCard(page: Page): Promise<void> {
  const names = await countOf(page, SPELL_NAME)
  if (names === 0) {
    note('the level on screen unlocks no SPELLS for this loadout (skills-only, or an unresolved combo) — there is no spell name here to hover')
    return
  }
  if (!check('a spell name in the per-level readout is reachable to hover', await hoverAt(page, SPELL_NAME, 0.5, 0.5))) {
    return
  }
  const cards = await settleCount(page, SPELL_CARD, 1, { timeoutMs: 8_000 })
  check('…and hovering it opens the full spell card', cards > 0, `${String(cards)} card(s) over ${String(names)} spell rows`)
  // CLOSE IT, AND WAIT FOR IT — MEASURED, not tidiness. A MUI popper is portalled to `document.body`
  // and absolutely positioned, so a card still open over a panel two screens down grows the
  // DOCUMENT's scrollHeight: the first run of this step left one behind and `stepPageScroll` read
  // `document +62px` and correctly failed the shell's own never-scrolls claim. `leaveDelay` is
  // 60ms (lib/SpellCard.tsx), so moving the mouse is not the same thing as the card being gone.
  await page.mouse.move(2, 2)
  await settleGone(page, SPELL_CARD, { timeoutMs: 5_000 })
  // …AND THE CROSSING, which only means anything from HERE (see `checkHoverCrossing`): a card has
  // just been opened and closed, so MUI's app-global enter hysteresis is running.
  await checkHoverCrossing(page)
}

/** The visible centre of each of the first `n` spell names — `hoverAt`'s clipping maths, per row. */
function spellNamePoints(page: Page, n: number): Promise<{ x: number; y: number }[]> {
  return page.evaluate(
    (a) => {
      const out: { x: number; y: number }[] = []
      for (const el of Array.from(document.querySelectorAll(a.sel)).slice(0, a.n)) {
        const r = el.getBoundingClientRect()
        let [left, top, right, bottom] = [r.left, r.top, r.right, r.bottom]
        for (let p = el.parentElement; p; p = p.parentElement) {
          const s = getComputedStyle(p)
          if (s.overflowX === 'visible' && s.overflowY === 'visible') continue
          const pr = p.getBoundingClientRect()
          left = Math.max(left, pr.left)
          top = Math.max(top, pr.top)
          right = Math.min(right, pr.right)
          bottom = Math.min(bottom, pr.bottom)
        }
        left = Math.max(left, 0)
        top = Math.max(top, 0)
        right = Math.min(right, window.innerWidth - 1)
        bottom = Math.min(bottom, window.innerHeight - 1)
        if (right - left <= 0 || bottom - top <= 0) continue
        const x = Math.round(left + (right - left) / 2)
        const y = Math.round(top + (bottom - top) / 2)
        const hit = document.elementFromPoint(x, y)
        if (hit && (hit === el || el.contains(hit))) out.push({ x, y })
      }
      return out
    },
    { sel: SPELL_NAME, n }
  )
}

/**
 * The floor a card must clear before it is allowed to exist, in page-milliseconds from the pointer
 * arriving on the name. THE CLOCK IS THE INSTRUMENT HERE, which is the sanctioned exception to wave
 * E3's "wait for the condition, never for the clock" — the claim IS a claim about time.
 *
 * 200 against a declared 250: a floor rather than an equality, because the poll that spots the card
 * has a 5ms grain and MUI's timer is a `setTimeout`. What it discriminates is the whole distance
 * between the two behaviours — with `enterNextDelay` at its DEFAULT of 0 a card opens on the next
 * tick and this gap reads single digits.
 */
const ENTER_FLOOR_MS = 200

/** How long the pointer rests on each name as it crosses. */
const CROSS_DWELL_MS = 90

/** What the in-page watcher parks on `window`. Only the numbers ever cross the bridge. */
interface CardWatch {
  /** Most cards open at the same instant. */
  __eqCardsMax?: number
  /** For each card that OPENED: page-milliseconds from the pointer arriving on a name to it. */
  __eqGaps?: number[]
  __eqLastEnter?: number
  __eqPrevCards?: number
  __eqCardWatch?: number
  __eqCardAbort?: AbortController
}

/**
 * Start watching, from inside the page: how long each card made the pointer wait, and how many
 * were ever open at once.
 *
 * THE MEASUREMENT IS TAKEN IN THE PAGE BECAUSE THE HARNESS IS TOO SLOW TO TAKE IT (measured, and
 * it is why this step is shaped the way it is). A real `page.mouse.move` on this tab costs ~820ms
 * end to end under the runner's four-way parallelism — the CDP dispatch waits on a renderer that
 * is drawing two charts and tailing a live log — so a node-side "cross three names in 270ms" is
 * not a thing this harness can perform at all: the first attempt clocked 2728ms for three moves
 * and every row therefore dwelled long past ANY enter delay. Both timestamps below are the page's
 * own, so node's latency cannot enter the number: `__eqLastEnter` is stamped by a real
 * `pointerover` on a spell name, and the gap is measured to the first frame a card exists.
 *
 * A POLL AND NOT A `MutationObserver`, for a harness reason worth writing down: this file runs
 * through tsx, and esbuild's `keepNames` wraps any function assigned to a NAMED binding in a
 * `__name(...)` call. That helper exists in the node module, not in the page — so an `evaluate`
 * body containing `const sample = () => …` dies on `ReferenceError: __name is not defined`
 * (measured, on this step's second run). Every function here is passed straight to its consumer as
 * an argument, where nothing infers a name for it, and the listener is removed with an
 * `AbortController` rather than a stored reference for exactly the same reason.
 *
 * 5ms is far finer than it needs to be: a card that opens stays open for its 60ms `leaveDelay`.
 */
function startCardWatch(page: Page): Promise<void> {
  return page.evaluate((a) => {
    const w = window as unknown as CardWatch
    w.__eqCardsMax = 0
    w.__eqGaps = []
    w.__eqPrevCards = document.querySelectorAll(a.card).length
    w.__eqLastEnter = undefined
    w.__eqCardAbort = new AbortController()
    document.addEventListener(
      'pointerover',
      (e) => {
        const t = e.target
        if (t instanceof Element && t.closest(a.name)) w.__eqLastEnter = performance.now()
      },
      { capture: true, signal: w.__eqCardAbort.signal }
    )
    w.__eqCardWatch = window.setInterval(() => {
      const n = document.querySelectorAll(a.card).length
      if (n > (w.__eqCardsMax ?? 0)) w.__eqCardsMax = n
      // A card APPEARING is the event: the gap is from the pointer arriving on a name to this.
      if (n > (w.__eqPrevCards ?? 0) && w.__eqLastEnter !== undefined) {
        ;(w.__eqGaps ??= []).push(Math.round(performance.now() - w.__eqLastEnter))
      }
      w.__eqPrevCards = n
    }, 5)
  }, { card: SPELL_CARD, name: SPELL_NAME })
}

/** Stop it and hand back what it saw. */
function stopCardWatch(page: Page): Promise<{ max: number; gaps: number[] }> {
  return page.evaluate(() => {
    const w = window as unknown as CardWatch
    if (w.__eqCardWatch !== undefined) window.clearInterval(w.__eqCardWatch)
    w.__eqCardAbort?.abort()
    return { max: w.__eqCardsMax ?? 0, gaps: w.__eqGaps ?? [] }
  })
}

/**
 * THE HOVER CROSSING (JOS-511 item 4) — the claim the ticket asked for, DOM-proven.
 *
 * THE DEFECT IT PINS. MUI's enter hysteresis is app-global: once ANY tooltip has closed, the next
 * one's `enterDelay` is skipped for about 860ms and `enterNextDelay` applies instead — and that
 * defaults to 0. So the 250ms `SpellTooltip` already declared bought nothing in the one situation
 * that matters. After a reader had opened ONE card, every spell name the cursor crossed on the way
 * down the list opened its own card instantly and fired its own uncancellable `spells:detail`
 * (three engine round trips plus ~8 scans of the 1,900-row catalog in main, each).
 *
 * WHY IT IS AN E2E CLAIM. There is no unit test of this: the behaviour is MUI's timer state, shared
 * across every tooltip in the app, driven by a real pointer. Only the running window has it.
 *
 * WHAT IS ASSERTED, AND WHY IT IS NOT A WALL-CLOCK COUNT. The ticket asked for "crossing three rows
 * quickly opens at most one card". The harness cannot cross quickly — see `startCardWatch` for the
 * measurement (~820ms per real pointer dispatch on this tab), which means every row in a node-driven
 * crossing dwells long past any enter delay and opens its card legitimately. So the claim is made on
 * the property that count was a proxy FOR: every card that opened made the pointer wait its full
 * quarter second first. With `enterNextDelay` left at its default that number is single digits, and
 * a crossing at any human speed opens a card per name; at 250 the same crossing opens none.
 *
 * THE CONTROL IS HALF THE CLAIM. A step that never saw a card would pass this vacuously and would
 * also be what a BROKEN card looks like, so the gaps have to be non-empty and the step ends by
 * resting on the last name and proving a card still opens there.
 *
 * AND IT WAS PROVEN TO FAIL. Deleting `enterNextDelay` from `SpellTooltip` and re-running this spec
 * reads `enter gaps 255/4ms` — the FIRST card waits its `enterDelay` and the second opens on contact
 * in four milliseconds, which is MUI's app-global hysteresis measured in this app rather than quoted
 * from its docs. With the value in place the same run reads `259/259ms`. A test that cannot fail is
 * not a claim, so that number is written down here.
 */
async function checkHoverCrossing(page: Page): Promise<void> {
  const pts = await spellNamePoints(page, 3)
  if (pts.length < 3) {
    note(`only ${String(pts.length)} spell names are visible at this level — a crossing needs three, so this claim is not measurable here`)
    return
  }
  // THE WATCHER SAMPLES IN THE PAGE, AND THAT IS THE FIX FOR A MEASUREMENT THAT ATE ITSELF. The
  // first version of this step read `countOf` between the moves — one CDP round trip each, ~800ms
  // apiece under the suite's load — so a "90ms" dwell was really the better part of a second and a
  // card opened perfectly legitimately. The instrument was creating what it was there to refute.
  // A MutationObserver plus a 10ms poll records the high-water mark from inside the page, so the
  // crossing costs three `mouse.move`s and three node-side sleeps and nothing else.
  await startCardWatch(page)
  const began = Date.now()
  for (const p of pts) {
    await page.mouse.move(p.x, p.y)
    await sleep(CROSS_DWELL_MS)
  }
  const elapsed = Date.now() - began
  const { max, gaps } = await stopCardWatch(page)
  // The instrument has to have seen something, or the assertion below is vacuous.
  if (!check('crossing three spell names after one card had opened opens cards at all', gaps.length > 0, `${String(gaps.length)} card opening(s) seen in ${String(elapsed)}ms`)) {
    return
  }
  const instant = gaps.filter((g) => g < ENTER_FLOOR_MS)
  check(
    'crossing a spell name straight after a card closed still makes it WAIT — none opens on contact',
    instant.length === 0,
    `enter gaps ${gaps.map(String).join('/')}ms against a ${String(ENTER_FLOOR_MS)}ms floor · ${String(max)} card(s) open at once`
  )
  note(`the crossing itself took ${String(elapsed)}ms of harness time for 3 real pointer moves — the gaps above are the PAGE's own clock, which is why that does not matter`)
  // THE CONTROL: the pointer is still resting on the third name, so a card must arrive.
  const opened = await settleCount(page, SPELL_CARD, 1, { timeoutMs: 8_000 })
  check('…and the card still opens when the pointer STAYS on a name', opened > 0, `${String(opened)} card(s) after resting`)
  await page.mouse.move(2, 2)
  await settleGone(page, SPELL_CARD, { timeoutMs: 5_000 })
}

/** The claims that only hold once the tab has stopped sharing one height between two rows. */
function checkNarrow(cols: ColumnsInfo, bands: Band[]): void {
  check('narrow: the two columns STACK — one on top of the other, not side by side', cols.bands.length === 2 && cols.bands[0].x === cols.bands[1].x, cols.bands.map((b) => `x=${String(b.x)} h=${String(b.h)}`).join(' | '))
  check(
    'narrow: …and each band takes the height its panels need, so nothing is crushed out of it',
    cols.bands.every((b) => b.spill <= 1),
    cols.bands.map((b) => `spill +${String(b.spill)}px${b.scrolls ? ' (scroller)' : ''}`).join(' | ')
  )
  // INVERTED BY JOS-289. The stack used to be the scroller below `lg` — that was JOS-151's fix for
  // the collision, and it is exactly the "mini content area" the owner ruled against.
  check('narrow: the STACK is NOT a scroller — the page carries the height, at every width', !cols.regionScrolls)
  const hits = collisionsOf(bands)
  check(
    'narrow: no two panels on the tab draw over each other',
    hits.length === 0,
    hits.length ? `${String(hits.length)} collisions: ${hits.slice(0, 3).join(' · ')}` : `${String(bands.length)} panels, all clear`
  )
}

/**
 * 7b. THE NARROW WINDOW (JOS-151, re-read under JOS-289). Squeeze the app to its own minimum
 * width, prove the tab stacks instead of colliding and that its controls are still reachable, then
 * put the window back and prove the wide layout returned unchanged.
 *
 * The two controls hit-tested are the ones at the two ENDS of the stack: the app-wide timeslice
 * (JOS-130) at the top of the charts band, and the unlock stepper in the panel that the spilling
 * papers used to bury. Both are asserted at BOTH widths, because "usable narrow" is only a claim
 * if "usable wide" is measured with the same instrument. The stepper is scrolled to first now —
 * at 900px the tab is several screens tall and a panel below the fold is not a covered panel.
 */
export async function stepNarrowLayout(app: ElectronApplication, page: Page): Promise<void> {
  const win = await app.browserWindow(page)
  const wide = await win.evaluate((w) => w.getBounds())
  // SINCE JOS-300 THE ROW IS ALWAYS IN THE DOM — the empty-state sentence and the reference panel
  // live inside its left band now, so "is there a stack" stopped being the same question as "are
  // there two columns to collide". A one-band row is the chart-less tab, honestly drawn.
  const present = await columnsInfo(page)
  if (!present || present.bands.length < 2) {
    note('this log draws no charts, so the tab renders its empty state and there is no second column to collide with')
    return
  }

  const got = await resizeTo(app, page, MIN_W, Math.min(wide.height, 760))
  note(`narrowed the window to the app's own minimum: ${String(got)}px of viewport`)
  const cols = await columnsInfo(page)
  if (cols) checkNarrow(cols, await visibleBands(page))

  const over = await pageOverflow(page)
  check('narrow: …and the WINDOW still does not scroll (only the content area inside it does)', over.doc === 0, `document +${String(over.doc)}px`)
  const narrowInner = (await innerScrollers(page)).filter((s) => !JUSTIFIED_SCROLLERS.includes(s.id))
  check(
    'narrow: no panel grows an internal scrollbar at the app minimum either',
    narrowInner.length === 0,
    narrowInner.map((s) => `${s.id || s.what} +${String(s.spill)}px`).slice(0, 4).join(' · ')
  )
  check('narrow: the timeslice control is still the thing at its own centre', (await hitTest(page, '[data-testid="leveling-slice-all"]')) === 'hit', await hitTest(page, '[data-testid="leveling-slice-all"]'))
  // Scroll to it first: since JOS-289 this panel legitimately lives below the fold, and asking
  // `elementFromPoint` about a box outside the viewport answers about whatever is at those
  // coordinates instead. Reachability is the claim; being on the first screen never was.
  await page.locator('[data-testid="new-at-level-next"]').first().scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined)
  await settleStable(() => visibleBands(page).then((b) => JSON.stringify(b)), { timeoutMs: 10_000 })
  check('narrow: …and so is the unlock stepper the spilling panels used to bury', (await hitTest(page, '[data-testid="new-at-level-next"]')) === 'hit', await hitTest(page, '[data-testid="new-at-level-next"]'))

  // Back to where it started: the wide layout is two columns SIDE BY SIDE. The window's own
  // minimum goes back LAST — `resizeTo` lowers it every time — so this step cannot leak a
  // 360px-wide app into whatever runs after it.
  await resizeTo(app, page, wide.width, wide.height)
  await win.evaluate((w, min) => w.setMinimumSize(min, 600), MIN_W)
  const restored = await columnsInfo(page)
  check(
    'restored wide: the two columns are side by side again',
    !!restored && restored.bands.length === 2 && restored.bands[0].x !== restored.bands[1].x,
    restored ? restored.bands.map((b) => `x=${String(b.x)} h=${String(b.h)}`).join(' | ') : 'no stack'
  )
  check('restored wide: no two panels draw over each other either', collisionsOf(await visibleBands(page)).length === 0)
}
