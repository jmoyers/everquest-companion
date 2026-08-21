// JOS-358 — NO TOOLTIP ANYWHERE ON AN OVERLAY WINDOW, AND NOTHING HOVERED OUTLIVES THE MOUSE.
//
// OWNER RULINGS. 2026-08-14, from hands-on testing and release-blocking, both halves: tooltips come
// off everything on the overlay windows EXCEPT the title bar (the unlock control kept its own, by
// name), and "when your mouse leaves the window its sometimes leaving a tooltip behind". Then
// 2026-08-16, the exception withdrawn: "let's drop tooltips in the overlays, even in the title bar".
// The title bar's controls keep their words as `aria-label` (which is how `PIN` below still finds
// the unlock control), and no element on any overlay window carries a `title` at all.
//
// WHY THE REAL APP IS ASKED. tests/overlayTooltipPolicy.test.mts sweeps the SOURCE and drives the
// strip/restore bookkeeping directly, which is everything a node test can hold — a native tooltip
// is drawn by the widget and is not in the DOM at all. What only a running window can say is what
// the rendered tree actually carries.
//
// A SHARED STEPS MODULE, like overlayScopeSteps/overlayTotalSteps beside it: the claim belongs to
// every overlay kind, and both specs that host it were already at the repo's measured 400-line
// ceiling (AGENTS.md: split, never ratchet).

import type { Page } from 'playwright-core'
import { check } from './appHarness.mjs'

/** The lock/unlock pin — selected by the aria-label the shared IconButton carries, in whichever of
 *  its two states the window is in. It is a NAME now, not a tooltip: the button draws no popup. */
const PIN = 'button[aria-label^="Lock"], button[aria-label^="Unlock"]'

/** What a window's tooltips look like right now, split at the title bar.
 *
 *  The header row is found through the DRAG GUTTER's parent rather than by a testid of its own:
 *  the gutter is the one element that exists only inside `OverlayHeader`, on every kind, in both
 *  modes (tests/e2e/overlayScopeSteps.mts aims at it for the same reason). */
function readTitles(page: Page): Promise<{ outside: string[]; inside: number; pins: number }> {
  return page.evaluate((pin) => {
    const header = document.querySelector('[data-testid="overlay-drag-gutter"]')?.parentElement ?? null
    const all = [...document.querySelectorAll<HTMLElement>('[title]')]
    return {
      outside: all.filter((e) => !header?.contains(e)).map((e) => e.title),
      inside: all.filter((e) => header?.contains(e)).length,
      pins: document.querySelectorAll(pin).length
    }
  }, PIN)
}

/**
 * THE POLICY, on whichever window is handed over: nothing below the title bar hovers, and since
 * 2026-08-16 the title bar does not either. The split is kept in the reading so a regression names
 * WHICH half came back. The pin is asserted present by NAME as well — a sweep that found no titles
 * because the header had not rendered would otherwise pass an empty window.
 */
export async function stepNoTooltipsAnywhere(page: Page, who: string): Promise<void> {
  const seen = await readTitles(page)
  check(`nothing below ${who}'s title bar hovers anything`, seen.outside.length === 0, JSON.stringify(seen.outside))
  check(`…and nothing in ${who}'s title bar does either`, seen.inside === 0, `${String(seen.inside)} in the header`)
  check('…while the unlock control is still there, by NAME rather than by tooltip', seen.pins === 1, `${String(seen.pins)} pin(s)`)
}

/**
 * …AND THE ROWS SPECIFICALLY, where a caller has some. Read off the row element rather than swept
 * out of the document, so the failure message names the surface that regressed.
 */
export async function stepRowsHoverNothing(page: Page, rowTestId: string): Promise<void> {
  const titles = await page.evaluate(
    (sel) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${sel}"]`)].map((e) => e.title),
    rowTestId
  )
  if (!check(`there are ${rowTestId} rows to make the claim about`, titles.length > 0)) return
  check(`no ${rowTestId} hovers anything`, titles.every((t) => t === ''), JSON.stringify(titles))
}
