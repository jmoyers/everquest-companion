// WHOSE DAMAGE, AND WHAT ITS OLD ROOM BECAME — the overlay half of JOS-115 and JOS-121.
//
// Two steps, one subject. JOS-115 retired the overlay's inline scope CONTROL and left the WORD as
// a read-only tag in the meter's header row; JOS-121 took the word out of that row entirely and
// put it on the panel floor, then split the freed width between the fight selector and the drag
// surface. So `stepOverlayScope` asserts WHERE the word is and that it still crosses windows, and
// `stepTitleBarRoom` MEASURES what the title bar did with what it got back.
//
// Its own module because tests/e2e/overlay-sync.e2e.mts sits at the repo's max-lines budget:
// split, never ratchet (drill.mts and combatPrefsSteps.mts set the precedent).
//
// `setLocked` is passed IN rather than re-implemented: the spec owns the lock helper because
// several of its other steps need it, and two definitions of "the lock has taken effect in this
// renderer" is exactly the drift that would make one of them lie.

import type { Page } from 'playwright-core'
import { check, countOf, note, settle, settleStable } from './appHarness.mjs'
import {
  OVERLAY_SCOPE_FLOOR,
  RETIRED_OVERLAY_CHIP,
  RETIRED_OVERLAY_HEADER_LABEL,
  setMeterScope
} from './combatPrefsSteps.mjs'

/** The selector trigger, by the ARIA contract OverlayHeader renders. Its parent IS the row. */
const TRIGGER = '[aria-haspopup="listbox"]'
/** The JOS-121 drag gutter at the right end of the title bar. */
export const DRAG_GUTTER = '[data-testid="overlay-drag-gutter"]'

/** Set the overlay's lock and wait for its own chrome to agree — supplied by the owning spec. */
export type SetLocked = (overlay: Page, locked: boolean) => Promise<void>

/** The floor readout's current text. */
async function label(overlay: Page): Promise<string> {
  return (await overlay.textContent(OVERLAY_SCOPE_FLOOR))?.trim() ?? ''
}

/**
 * WHERE THE WORD IS NOW: not in the title bar, and not a hit target.
 *
 * The structural half is deliberately not textual — whatever the word says, the element saying it
 * must not be a descendant of the header row. A title bar cannot get its room back if the tag
 * merely moved a few pixels within it.
 *
 * THE LONG FORM is the reason the word survived JOS-115 at all: `Group (no roster yet)` is the
 * sentence that explains a Group-scoped meter showing everybody (roster law 1's fallback), and it
 * is longest exactly when the panel is fullest of bars. A floor that could only hold the short
 * word would have dropped the job it was kept for, so the band is measured with the long form in
 * it — swapped in synchronously, so React never sees it.
 */
async function checkFloorPlacement(overlay: Page): Promise<void> {
  check('the inline scope CONTROL is gone from the overlay header (JOS-115)', (await countOf(overlay, RETIRED_OVERLAY_CHIP)) === 0)
  check('…and the scope READOUT has left the title bar too (JOS-121)', (await countOf(overlay, RETIRED_OVERLAY_HEADER_LABEL)) === 0)
  check('the meter panel carries it on its floor instead', (await countOf(overlay, OVERLAY_SCOPE_FLOOR)) === 1)
  const inHeader = await overlay.evaluate(
    ([trig, floor]) => Boolean(document.querySelector(trig)?.parentElement?.querySelector(floor)),
    [TRIGGER, OVERLAY_SCOPE_FLOOR] as const
  )
  check('…and it is nowhere inside the header row', inHeader === false)

  const longFits = await overlay.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) return false
    const was = el.textContent
    el.textContent = 'Group (no roster yet)'
    const fits = el.scrollWidth <= el.clientWidth
    el.textContent = was
    return fits
  }, OVERLAY_SCOPE_FLOOR)
  check('…and the honest long form fits the floor un-clipped: “Group (no roster yet)”', longFits)

  // NOT A CONTROL, and now not even a hit target: `pointerEvents: none` is what makes the word
  // click-through WITH the panel rather than a live patch sitting on a click-through window.
  const inert = await overlay.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return ''
    const cs = getComputedStyle(el)
    return `${cs.pointerEvents}/${cs.cursor}`
  }, OVERLAY_SCOPE_FLOOR)
  check('the floor readout takes no pointer at all — it states the scope, it does not offer it', inert === 'none/auto', inert)
}

/**
 * THE OVERLAY'S SCOPE READOUT (docs/plans/group-model.md §3) — the cross-window half of ONE
 * preference (JOS-115), now read from the PANEL FLOOR instead of the title bar (JOS-121).
 *
 * The overlay used to carry a one-click CYCLE writing a key of its own kind. The owner retired
 * every inline copy of that control ("shown INLINE on every combat surface and is too crowded"),
 * so the choice now lives in Preferences > Combat in the MAIN window and this window only reads
 * it. That makes this step the strongest assertion in the suite about the mechanism useCombatPrefs
 * documents: two windows, one origin, one localStorage, and the DOM's own 'storage' event doing
 * the notifying with no IPC channel involved at all. THAT CLAIM IS UNCHANGED by JOS-121 — the word
 * moved rooms, not wires, and this step still drives the real preferences control to prove it.
 *
 * What JOS-121 changed is WHERE the word is, and the rule that came with the move: it no longer
 * vanishes when the overlay is LOCKED. It is a watermark you read rather than chrome you reach
 * for, and a pinned meter is the one with no selector, no controls and no tooltip left to explain
 * why a name is missing from it.
 */
export async function stepOverlayScope(page: Page, overlay: Page, setLocked: SetLocked): Promise<void> {
  await setLocked(overlay, false)
  await checkFloorPlacement(overlay)

  const first = await label(overlay)
  // The SAME phrasing the Combat tab shows, because both go through `chipLabel` — one wording,
  // two renderers. Which of the two Group states the log leaves behind is not this spec's
  // business; that both windows would spell it identically is.
  check(
    'it defaults to Group, stating any fallback in the word rather than switching scope for you',
    first === 'Group' || first === 'Group (no roster yet)',
    first
  )
  const stable = await settleStable(() => label(overlay), { timeoutMs: 4_000 })
  check('…and it holds still on its own', stable === first, `${first} → ${stable}`)

  // THE CROSS-WINDOW APPLY. Written in the MAIN window through the real preferences control; this
  // window is a second BrowserWindow of the same origin and hears it through 'storage'.
  await setMeterScope(page, 'everyone', 'nav-combat')
  const applied = await settle(() => label(overlay), (t) => t === 'Everyone', { timeoutMs: 10_000 })
  check('a preference set in the main window reaches the floating overlay', applied === 'Everyone', applied)
  // …and no roster editor came with it: that is the Combat tab's job.
  check('the overlay offers no roster popover', (await countOf(overlay, '[data-testid="roster-open"]')) === 0)

  // THE TITLE BAR NEVER SAYS IT. With the scope set to 'Everyone' the word is unmistakable, so the
  // header row's own text is the assertion — the tag did not move a few pixels left, it left.
  const headerText = await overlay.evaluate(
    (trig) => (document.querySelector(trig)?.parentElement as HTMLElement | null)?.innerText ?? '',
    TRIGGER
  )
  check('no scope text in the overlay meter title bar', !headerText.includes('Everyone'), headerText.replace(/\s+/g, ' ').slice(0, 120))

  await setLocked(overlay, true)
  check('a LOCKED overlay KEEPS the floor readout (JOS-121 — it is the meter, not chrome)', (await countOf(overlay, OVERLAY_SCOPE_FLOOR)) === 1)
  check('…still saying the stored scope with no chrome around it', (await label(overlay)) === 'Everyone', await label(overlay))

  await setLocked(overlay, false)
  check('the overlay still shows the stored scope after the lock round trip', (await label(overlay)) === 'Everyone', await label(overlay))

  // Leave the app on its default so nothing downstream inherits a widened meter.
  await setMeterScope(page, 'group', 'nav-combat')
  await settle(() => label(overlay), (t) => t.startsWith('Group'), { timeoutMs: 10_000 })
}

// ── JOS-121: what the title bar did with the room ───────────────────────────────────────

/** One reading of the title bar's geometry: the row, the selector, and the drag surface. */
interface TitleBarRoom {
  rowW: number
  rowH: number
  /** the fight selector's trigger — the item whose title is a mob name under an ellipsis. */
  triggerW: number
  /** the visible width of the selector's TITLE span (what a longer mob name gets to use). */
  titleW: number
  /** row area minus every `no-drag` child's area, in px² — what a pointer can grab to move it. */
  dragArea: number
}

interface RoomReadings {
  before: TitleBarRoom
  after: TitleBarRoom
  /** the sentence the meter is actually saying right now, taken from the floor. */
  word: string
}

/**
 * Measure the title bar as it is, then again with JOS-115's row rebuilt around it.
 *
 * THE BEFORE IS RECONSTRUCTED, because this suite cannot run the previous build. Inside one
 * synchronous `evaluate` that React never gets to observe, the scope tag goes back where it was
 * with the styling it had, the drag gutter is hidden and the row's padding is set back to its old
 * `4px 8px` — then Chromium's own layout engine answers, at this window's real width, with this
 * fixture's real fight name in the title. The tag's TEXT is taken from the floor readout, so it is
 * the sentence the meter is currently saying rather than a hard-coded guess that would rot.
 *
 * `no-drag` children are found by their INLINE style (`useOverlayChrome.noDrag` is written that
 * way). `-webkit-app-region` is not an inherited CSS property, so a computed-style sweep would be
 * answering about declarations rather than about the drag region Electron installs.
 *
 * IT IS ONE FLAT LOOP, WITH NO INNER FUNCTION, and that is not a style choice: tsx compiles this
 * file with esbuild's keep-names on, which wraps every named function binding in a `__name(…)`
 * helper. Playwright ships the callback's SOURCE to the page, where that helper does not exist —
 * a `read()` extracted for tidiness died on `ReferenceError: __name is not defined`. Anything
 * evaluated in the page has to be written without local function bindings.
 */
function readRoom(overlay: Page, word: string): Promise<RoomReadings | null> {
  return overlay.evaluate(
    ([trigSel, gutterSel, scopeWord]) => {
      const trigger = document.querySelector(trigSel) as HTMLElement
      const row = trigger?.parentElement
      const gutter = row?.querySelector(gutterSel) as HTMLElement | null
      if (!row || !gutter) return null

      const pad = row.style.padding
      const gutterDisplay = gutter.style.display
      const tag = document.createElement('span')
      const readings: TitleBarRoom[] = []

      // Pass 0 reads the layout as it ships; pass 1 reads it with JOS-115's row rebuilt around it.
      for (let pass = 0; pass < 2; pass++) {
        const r = row.getBoundingClientRect()
        const t = trigger.getBoundingClientRect()
        // The title is the trigger's first span (name, then chevron, then the rate).
        const titleEl = trigger.querySelector('span')
        let titleW = 0
        if (titleEl) titleW = titleEl.getBoundingClientRect().width
        let noDrag = 0
        for (const el of Array.from(row.children) as HTMLElement[]) {
          if (el.style.webkitAppRegion === 'no-drag') {
            const b = el.getBoundingClientRect()
            noDrag += b.width * b.height
          }
        }
        readings.push({
          rowW: r.width,
          rowH: r.height,
          triggerW: t.width,
          titleW,
          dragArea: r.width * r.height - noDrag
        })
        if (pass === 0) {
          row.style.padding = '4px 8px'
          gutter.style.display = 'none'
          tag.style.cssText =
            'font-size:8px;letter-spacing:0.5px;text-transform:uppercase;padding:1px 3px;white-space:nowrap;flex-shrink:0'
          tag.textContent = scopeWord
          row.insertBefore(tag, trigger)
        }
      }

      tag.remove()
      gutter.style.display = gutterDisplay
      row.style.padding = pad
      return { before: readings[1], after: readings[0], word: scopeWord }
    },
    [TRIGGER, DRAG_GUTTER, word] as const
  )
}

/**
 * THE OVERLAY MUST BE UNLOCKED when this runs: `useOverlayChrome` hands out a drag region only
 * while the window is interactive, so a locked meter has a drag area of zero in both layouts and
 * the comparison would be about nothing.
 */
export async function stepTitleBarRoom(overlay: Page): Promise<void> {
  check('the title bar carries a real drag gutter now', (await countOf(overlay, DRAG_GUTTER)) === 1)

  // The word the reconstruction puts back is the one the meter is SAYING, read from the floor —
  // so this measures today's real sentence rather than a hard-coded guess that would rot. It is
  // fetched out here because the page-side callback is at its complexity budget.
  const saying = await label(overlay)
  const room = await readRoom(overlay, saying || 'Group')
  if (!check('the title bar could be measured', room !== null)) return
  const { before, after, word } = room as RoomReadings
  note(
    `title bar with “${word}” in it → without: selector ${before.triggerW.toFixed(1)}px → ` +
      `${after.triggerW.toFixed(1)}px, name ${before.titleW.toFixed(1)}px → ${after.titleW.toFixed(1)}px, ` +
      `drag ${before.dragArea.toFixed(0)}px² → ${after.dragArea.toFixed(0)}px² ` +
      `(row ${after.rowW.toFixed(0)}×${before.rowH.toFixed(0)}→${after.rowH.toFixed(0)})`
  )

  check(
    'THE SELECTOR GAINED THE ROOM — the trigger is wider without the scope word',
    after.triggerW > before.triggerW,
    `${before.triggerW.toFixed(1)}px → ${after.triggerW.toFixed(1)}px`
  )
  check(
    '…and the fight NAME is what got it, so a long mob name truncates later',
    after.titleW > before.titleW,
    `${before.titleW.toFixed(1)}px → ${after.titleW.toFixed(1)}px`
  )
  check(
    'THE DRAG SURFACE GREW TOO — the gutter and the extra row pixel outweigh the word it lost',
    after.dragArea > before.dragArea,
    `${before.dragArea.toFixed(0)}px² → ${after.dragArea.toFixed(0)}px²`
  )
}
