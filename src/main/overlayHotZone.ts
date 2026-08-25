// ============================================================================
// overlayHotZone.ts — WHICH PIXELS OF A PINNED OVERLAY STILL WANT THE MOUSE (JOS-370).
// ============================================================================
//
// A locked overlay is click-through. It is also not USELESS: it reveals a pin you can press to
// unlock it, the meters keep a working fight selector in their title bar (P3), and since JOS-138 a
// pinned list scrolls at its right edge. All three need real mouse events, and until this ticket
// the app bought them with `setIgnoreMouseEvents(true, {forward:true})` — a system-wide WH_MOUSE_LL
// hook owned by MAIN, which made every stall of ours a stall of the user's cursor and of in-game
// mouselook. The hook is gone. What replaces it is this: main names the rectangles that still want
// the mouse, the presence worker hit-tests the cursor against them off-thread, and the window's
// capture is flipped from the answer.
//
// SO THIS FILE IS THE ANSWER TO "WHICH RECTANGLES", and it is a plain function of a kind and a
// window rectangle — Electron-free, like `pointerWatch.ts` beside it, so the whole policy is a
// node test rather than something to alt-tab into and check by eye.
//
// ================================ THE THREE ANSWERS, AND WHY ================================
// They are not a taste: each one mirrors the sensor that kind's renderer ALREADY runs, because the
// promise of this change is that nothing about the interaction moves — only its plumbing.
//
//   'chrome' — the METERS and the two timer-shaped panels with a header sensor (fight, overall,
//     heal-fight, heal-overall, xp, respawn). Their renderers capture on the HEADER ROW alone
//     (`capture('selector', …)` in OverlayHeader.tsx) precisely so a pinned meter's BARS stay
//     genuinely click-through, which is what pinning is for. Two rectangles: the header strip, and
//     the scroll grip along the right edge (overlayScale.tsx `SCROLL_GRIP_W`).
//   'window' — the LIST kinds (events, buffs, debuffs). Their renderers hold capture over the
//     WHOLE window while hovered (`onEnter`/`onLeave` on the root), which overlayScale.tsx already
//     names as "the same trade taken at the other extreme". One rectangle: the window.
//   'none'   — the three STRIPS (toast, alertBanner, conCard). They have no hover sensor at all;
//     their capture comes from their QUEUE (cardQueue.ts `useQueueMouseCapture`) — a card is on
//     screen, or it is not — and they never forwarded either. Nothing to watch.
//
// ================================ THE ONE HONEST WIDENING ================================
// The GRIP band is watched whether or not the pane currently overflows, and the renderer's own
// `track` handler still asks the layout before it holds anything (overlayScale.tsx). So on a
// pinned meter with nothing to scroll, the right edge now takes the mouse for as long as the
// pointer is in it — where before it did not. That is a ~23 px strip on a window the user pinned,
// it is the strip a scrollbar would be drawn in, and it is the price of not knowing a layout result
// in the main process. It is stated here rather than engineered around because the alternative is a
// second geometry channel from the renderer, which is a whole transport for a strip of pixels.
//
// COORDINATES ARE THE WINDOW'S OWN (DIP), because `BrowserWindow.getBounds()` is. The conversion to
// the physical pixels the watcher speaks happens once, at the Electron boundary (overlayHover.ts).

import { isStripKind } from './overlayLayout'
import type { OverlayKind } from '../shared/types'

/** A rectangle in the same coordinates the window reported. `Electron.Rectangle` satisfies it. */
export interface ZoneRect {
  x: number
  y: number
  width: number
  height: number
}

/** Which sensor a kind's renderer runs, and therefore which rectangles main watches for it. */
export type HotZoneStyle = 'chrome' | 'window' | 'none'

/**
 * The kinds whose renderer holds capture over its WHOLE window while hovered — the list-shaped
 * overlays, which pass no `capture` to `OverlayContent` and put `onMouseEnter={onEnter}` on their
 * root instead (EventLogOverlay.tsx, BuffsOverlay.tsx).
 */
const WHOLE_WINDOW_KINDS: OverlayKind[] = ['events', 'buffs', 'debuffs']

/**
 * HOW TALL THE CHROME STRIP IS, in the window's own px.
 *
 * MEASURED, not chosen (OVERLAY_MIN_SIZE's rule, one file over). The header row is 7 px of padding
 * per edge around a 20 px `IconButton` box plus its own 1 px bottom border — 35 px — sitting under
 * the overlay root's 1 px border, so the row ends 36 px from the top of the window. It does NOT
 * move with the text size: the overlay's scale goes on the content pane and never on the chrome
 * (useOverlayChrome.ts's opening note), which is what makes a constant honest here at all.
 *
 * 40 IS 36 PLUS SLACK, AND THE SLACK LEANS THE SAFE WAY. Too SHORT is a real defect — the bottom
 * band of the pin becomes unreachable and the user is left pressing a control that does not answer.
 * Too TALL costs the top few pixels of the bars their click-through while the pointer is in them,
 * which is a band nobody aims at through a window they pinned. `tests/e2e/overlay-sync.e2e.mts`
 * re-measures the real row and fails if it ever grows past this.
 */
export const CHROME_STRIP_PX = 40

/**
 * HOW WIDE THE SCROLL GRIP BAND IS, in the same px.
 *
 * `SCROLL_GRIP_W` is 22 (overlayScale.tsx) and is measured from the PANE's right edge, which sits
 * one pixel inside the window's own border — so 23 from the window's right edge is that same strip
 * and the border it lives against. Not a pixel more: every pixel here is click-through taken away.
 */
export const GRIP_BAND_PX = 23

/** Which sensor this kind runs. */
export function hotZoneStyle(kind: OverlayKind): HotZoneStyle {
  if (isStripKind(kind)) return 'none'
  return WHOLE_WINDOW_KINDS.includes(kind) ? 'window' : 'chrome'
}

/**
 * The rectangles a LOCKED overlay of this kind wants the mouse in, given where its window is.
 *
 * SMALL WINDOWS DEGRADE TO THE WHOLE WINDOW rather than to nonsense. The floor every kind shares is
 * 140x90 (OVERLAY_MIN_SIZE), so a window can legitimately be shorter than the strip plus a grip
 * worth watching; clamping each rectangle to the window is what keeps a zone from claiming pixels
 * the window does not own, and the two then simply overlap, which the hit test does not mind (it
 * asks whether ANY rectangle contains the point).
 *
 * `zoom` IS THE WINDOW'S OWN PAGE ZOOM, and it is a parameter because the two constants above are
 * CSS pixels while a window rectangle is DIP. Those are the same number at zoom 1 — which every
 * overlay is, in a packaged app — but Chromium stores zoom PER HOST and the dev server serves every
 * page from one host, so a main-window `setZoomFactor` (the app's text-size control) has been
 * MEASURED reaching an accessory window before (JOS-154, the cursor ring). One multiply here costs
 * nothing and makes the strip right in both worlds instead of right in one and silently short in
 * the other. Widths and positions are the WINDOW's and are never scaled.
 */
export function overlayHotZones(kind: OverlayKind, bounds: ZoneRect, zoom = 1): ZoneRect[] {
  const style = hotZoneStyle(kind)
  if (style === 'none') return []
  if (style === 'window') return [{ ...bounds }]
  const scale = zoom > 0 ? zoom : 1
  const stripH = Math.min(Math.round(CHROME_STRIP_PX * scale), bounds.height)
  const zones: ZoneRect[] = [{ x: bounds.x, y: bounds.y, width: bounds.width, height: stripH }]
  const gripW = Math.min(Math.round(GRIP_BAND_PX * scale), bounds.width)
  const gripH = bounds.height - stripH
  if (gripH > 0) {
    zones.push({
      x: bounds.x + bounds.width - gripW,
      y: bounds.y + stripH,
      width: gripW,
      height: gripH
    })
  }
  return zones
}

/**
 * Is this overlay one the hit test should be running for RIGHT NOW? PURE, so "no zones and
 * therefore no sampler" is a property a unit test holds rather than a claim about a call graph.
 *
 * Every term is a state in which a hover would be wrong rather than merely wasted:
 *
 *   - `open`/`alive` — a window that is not there has no pixels to hover.
 *   - `locked` — an INTERACTIVE overlay owns the mouse outright and its renderer gets every real
 *     event the window manager delivers. There is nothing for main to hand it.
 *   - `visible` — hidden by the replay gate or by a session teardown: not on screen, not hoverable.
 *   - `parked` — on screen at opacity 0 (JOS-427). This is the one that would be a BUG rather than
 *     an inefficiency: capture handed to an invisible rectangle is a click-eater over whatever the
 *     user just alt-tabbed to, which is exactly the hard gate `setOverlayIgnoreMouse` already keeps.
 *
 * ==================== WHAT IS NOT A TERM, AND WAS FOR ONE RELEASE ====================
 * WHICH APPLICATION HOLDS THE FOREGROUND. `eqFocused` shipped here as a fifth term with JOS-370 and
 * the owner overturned it the day after (ruling, 2026-08-24): presence PREFERENCES are what mean
 * "hide when EQ is not open or not in the foreground"; EQ should not impact hover state otherwise.
 * The defect it caused is small and exact — a meter pinned over a browser stopped revealing its own
 * pin, because main published no rectangle for it, where the WH_MOUSE_LL hook this replaced had
 * forwarded moves from every app on the machine.
 *
 * THE COUPLING THAT REMAINS IS THE HONEST ONE, and it is why nothing has to be re-derived here: an
 * overlay the auto-hide preferences hid is PARKED (`presenceEffects.ts onPresence`, JOS-427's
 * opacity flip), and a parked overlay already publishes nothing by the term above. So a player who
 * asked for "take them off when I leave the game" still pays no hit test the moment they alt-tab,
 * and a player who did not ask for it keeps a pin they can reach. This predicate never reads a
 * preference and never reads presence; it reads what the window IS.
 */
export function overlayWantsHoverZones(o: {
  locked: boolean
  alive: boolean
  visible: boolean
  parked: boolean
}): boolean {
  return o.locked && o.alive && o.visible && !o.parked
}
