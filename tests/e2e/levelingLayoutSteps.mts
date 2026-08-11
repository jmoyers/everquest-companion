// THE LEVELING TAB'S LAYOUT CONTRACT — the page never scrolls, and the panels never draw over
// each other (JOS-151, GitHub issue 14, relayed as report 01KZKYC0RSSBJNR19MXCY9FHX7).
//
// LIVING NEXT DOOR because leveling.e2e.mts sits AT the repo max-lines budget and the rule here is
// to SPLIT, never ratchet — sliceSteps.mts states the precedent and dropSteps.mts, combatSteps.mts
// and plannerSteps.mts set it. The overflow claim moved over with the new one rather than staying
// behind: they are two halves of one subject (what this tab does with the height it is given), and
// the narrow assertions below are only meaningful while the page itself still refuses to scroll.
//
// WHAT THE DEFECT ACTUALLY WAS, measured at the reporter's 1073x937 before the fix: below MUI's
// `lg` the tab's two columns become two rows, and they kept their side-by-side 2:1 split of a
// FIXED height. The second band was handed 198px for three intrinsically tall papers, so the AA
// ledger squeezed to 89px, the progress feed to 34px, and both spilled out of a band with
// `overflow: visible` and drew straight over "New at this level" (23px and 34px of real overlap).
// Nothing about that is visible to a unit test: it is one flex ratio meeting one viewport.
//
// WHY THE CHECKS ARE SHAPED THIS WAY. "Do two panels overlap" is only an honest question about
// boxes the user can SEE, and this tab is full of legitimate scrollers whose children hang far
// outside them — at any width, half the charts column is scrolled out of frame and its raw
// `getBoundingClientRect()` cheerfully reports it sitting on top of the panel below. So every box
// is intersected with EVERY clipping ancestor first (`hoverAt` in appHarness.mts had to learn the
// same lesson), and a band that is scrolled away has zero area and cannot collide with anything.
//
// AND WHY 900: that is the main window's own `minWidth` (src/main/windows.ts), so it is the
// narrowest the user can actually make it and the worst case for a height split. The reporter's
// 1073 is the same branch of the same breakpoint — one width proves the branch.

import type { ElectronApplication, Page } from 'playwright-core'
import { check, note, pageOverflow, settle, settleStable } from './appHarness.mjs'

/** The app's own minimum window width (src/main/windows.ts) — the narrowest a user can get. */
const MIN_W = 900

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
  /** does the stack itself scroll? (below `lg` it must — it is the region that owns the height) */
  regionScrolls: boolean
}

/** The two-column stack and its bands — the one element the fix is actually about. */
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

/** 7. THE LAYOUT CONTRACT: the app's content area owns the scroll; a view never grows the page. */
export async function stepOverflow(page: Page): Promise<void> {
  const over = await pageOverflow(page)
  check(
    'the Leveling tab never scrolls the page (its panels scroll inside themselves)',
    over.doc === 0 && over.content === 0,
    `document +${String(over.doc)}px · content area +${String(over.content)}px`
  )
}

/** The four claims that only hold once the tab has stopped sharing one height between two rows. */
function checkNarrow(cols: ColumnsInfo, bands: Band[]): void {
  check('narrow: the two columns STACK — one on top of the other, not side by side', cols.bands.length === 2 && cols.bands[0].x === cols.bands[1].x, cols.bands.map((b) => `x=${String(b.x)} h=${String(b.h)}`).join(' | '))
  check(
    'narrow: …and each band takes the height its panels need, so nothing is crushed out of it',
    cols.bands.every((b) => b.spill <= 1 || b.scrolls),
    cols.bands.map((b) => `spill +${String(b.spill)}px${b.scrolls ? ' (scroller)' : ''}`).join(' | ')
  )
  check('narrow: the STACK is the scroller — the height it was given is the height it keeps', cols.regionScrolls)
  const hits = collisionsOf(bands)
  check(
    'narrow: no two panels on the tab draw over each other',
    hits.length === 0,
    hits.length ? `${String(hits.length)} collisions: ${hits.slice(0, 3).join(' · ')}` : `${String(bands.length)} panels, all clear`
  )
}

/**
 * 7b. THE NARROW WINDOW (JOS-151). Squeeze the app to its own minimum width, prove the tab stacks
 * instead of colliding and that its controls are still reachable, then put the window back and
 * prove the wide layout returned unchanged.
 *
 * The two controls hit-tested are the ones at the two ENDS of the stack: the app-wide timeslice
 * (JOS-130) at the top of the charts band, and the unlock stepper in the panel that the spilling
 * papers used to bury. Both are asserted at BOTH widths, because "usable narrow" is only a claim
 * if "usable wide" is measured with the same instrument.
 */
export async function stepNarrowLayout(app: ElectronApplication, page: Page): Promise<void> {
  const win = await app.browserWindow(page)
  const wide = await win.evaluate((w) => w.getBounds())
  if ((await columnsInfo(page)) === null) {
    note('this log draws no charts, so the tab renders its empty state and has no two-column stack to narrow')
    return
  }

  const got = await resizeTo(app, page, MIN_W, Math.min(wide.height, 760))
  note(`narrowed the window to the app's own minimum: ${String(got)}px of viewport`)
  const cols = await columnsInfo(page)
  if (cols) checkNarrow(cols, await visibleBands(page))

  const over = await pageOverflow(page)
  check(
    'narrow: …and the PAGE still does not scroll (the stack absorbed it, not the app)',
    over.doc === 0 && over.content === 0,
    `document +${String(over.doc)}px · content area +${String(over.content)}px`
  )
  check('narrow: the timeslice control is still the thing at its own centre', (await hitTest(page, '[data-testid="leveling-slice-all"]')) === 'hit', await hitTest(page, '[data-testid="leveling-slice-all"]'))
  check('narrow: …and so is the unlock stepper the spilling panels used to bury', (await hitTest(page, '[data-testid="new-at-level-next"]')) === 'hit', await hitTest(page, '[data-testid="new-at-level-next"]'))

  // Back to where it started: the wide layout is two columns SIDE BY SIDE. The window's own
  // minimum goes back LAST — `resizeTo` lowers it every time — so this step cannot leak a
  // 360px-wide app into whatever runs after it.
  await resizeTo(app, page, wide.width, wide.height)
  await win.evaluate((w, min) => w.setMinimumSize(min, 600), MIN_W)
  const restored = await columnsInfo(page)
  check(
    'restored wide: the two columns are side by side again, sharing the height as they always did',
    !!restored && restored.bands.length === 2 && restored.bands[0].x !== restored.bands[1].x,
    restored ? restored.bands.map((b) => `x=${String(b.x)} h=${String(b.h)}`).join(' | ') : 'no stack'
  )
  check('restored wide: no two panels draw over each other either', collisionsOf(await visibleBands(page)).length === 0)
}
