// overlayScale — WHERE THE TEXT SIZE IS APPLIED, and the only place it is.
//
// An overlay window is two layers with different jobs, and the scale belongs to exactly one:
//
//   CONTROL CHROME (header + selector, footer, the toast's drag frame) lays out at scale 1
//   against the REAL window width. It is what you reach for when a window is wrong — the lock,
//   the alpha slider, A− / A+ itself — so it can never be the thing that grows out of the
//   window. Scaling it is what the first cut of this feature did (a CSS zoom on #overlay-root),
//   and at 2.0 on a narrow overlay the footer walked off the right edge with A− on it.
//
//   CONTENT (the bars, the feed rows, the toast cards) is the reading matter the scale is FOR,
//   and it is the only thing zoomed.
//
// CSS `zoom`, not `transform: scale()`: zoom participates in layout, so an auto-width child
// resolves its width against the pane divided by the zoom and fills it at every scale — the rows
// REFLOW instead of a magnified bitmap hanging off the pane's edge. Height it cannot fix, which
// is what the scroll pane below is for: at 2.0 you get fewer rows on screen, not fewer rows.
//
// MUI-FREE like the rest of this bundle.

import { useEffect, useRef, useState, type JSX } from 'react'
import type { CaptureReason } from './useOverlayChrome'

/** The zoomed box. Nothing inside it may size itself in viewport units — a `vw`/`vh` resolves
 *  against the WINDOW and is then multiplied by the zoom, i.e. past the pane it lives in. */
export function ScaledContent({
  textScale,
  children
}: {
  textScale: number
  children: React.ReactNode
}): JSX.Element {
  return <div style={{ zoom: textScale }}>{children}</div>
}

/**
 * THE SCROLL GRIP, in unscaled chrome pixels: how far in from the pane's right edge a pinned
 * overlay will take the mouse so the wheel reaches its rows (JOS-138).
 *
 * The scrollbar itself is 12px (overlay.html), so this is the bar plus ~10px of approach. It is
 * sized to be crossed rather than aimed at: the pointer arriving from the left, above or below
 * generates a move inside the strip before it reaches the bar, and that move is what arms the
 * grip. Coming at the bar from OUTSIDE the window's right border can miss the strip entirely —
 * the honest limit of a sensor made of mouse-moves; approach from anywhere else and it holds.
 */
export const SCROLL_GRIP_W = 22

/**
 * The scrolling content pane the three list-shaped kinds put their rows in: it takes the room the
 * chrome leaves (`flexGrow` + `minHeight: 0`, so a flex child actually shrinks) and scrolls what
 * does not fit — every row the meter has, at whatever size it is being read at.
 *
 * `overflowX: hidden` because the rows ellipsize rather than run wide, and a horizontal bar here
 * would eat a row's worth of height to say nothing.
 *
 * A PINNED OVERLAY SCROLLS NOW, AND ONLY AT ITS RIGHT EDGE (JOS-138; owner disposition
 * 2026-08-09, on a 0.14.0 report that pinning killed the scrollbar). It used to be true by
 * construction that it could not: pinned means `setIgnoreMouseEvents(true, {forward:true})`, and
 * `forward` forwards mouse MOVES and nothing else — a wheel notch is delivered to whatever is
 * under the cursor after the OS hit test, which for a click-through window is the game. So the
 * wheel cannot arrive unless the window stops ignoring the mouse for as long as it takes, which
 * means SCROLLING AND CLICK-THROUGH CANNOT BOTH BE TRUE OF THE SAME PIXEL. That is a real trade,
 * not a bug to engineer around, so it is made where it costs least:
 *
 *   - the pane watches the forwarded moves it already receives and, while the window is LOCKED
 *     and the rows genuinely overflow, takes the mouse (`capture('scroll', …)`) for exactly the
 *     time the pointer spends within SCROLL_GRIP_W of the right edge — the strip the scrollbar
 *     is drawn in, so the affordance is the bar the user is already reaching for;
 *   - everything else in the body is untouched and stays genuinely click-through, which is the
 *     point of pinning and what the e2e asserts alongside the scroll;
 *   - and both halves of the interaction come with it: the WHEEL, and DRAGGING THE BAR, because
 *     the grip hands the real scrollbar real mouse events rather than re-implementing scrolling.
 *
 * No new IPC and no new mouse hook: this is the P3 named-reason sensor with a fourth reason, over
 * the forwarding the meters already pay for (see useOverlayChrome's CaptureReason).
 *
 * A caller that passes no `capture` gets the old pane exactly — the event log and the buffs
 * overlay hold capture over their WHOLE window while hovered, which already carries the wheel and
 * is the same trade taken at the other extreme.
 */
export function OverlayContent({
  textScale,
  testId,
  locked = false,
  capture,
  children
}: {
  textScale: number
  testId?: string
  /** the window is pinned (click-through) — the only mode the grip exists in */
  locked?: boolean
  /** the named-reason sensor from useOverlayChrome; no sensor, no grip */
  capture?: (reason: CaptureReason, active: boolean) => void
  children: React.ReactNode
}): JSX.Element {
  const pane = useRef<HTMLDivElement>(null)
  /** What main has been told, so a move that changes nothing sends nothing. */
  const heldRef = useRef(false)
  const [held, setHeld] = useState(false)
  const grip = locked && capture !== undefined

  const hold = (want: boolean): void => {
    if (heldRef.current === want) return
    heldRef.current = want
    setHeld(want)
    capture?.('scroll', want)
  }

  // Unpinning releases the grip locally. `toggleLock` already forgets every reason in main's
  // bookkeeping, so this is the local half of the same forgetting — without it a stale `true`
  // would swallow the first genuine grip of the next pinned session.
  useEffect(() => {
    if (!grip) {
      heldRef.current = false
      setHeld(false)
    }
  }, [grip])

  const track = (ev: React.MouseEvent<HTMLDivElement>): void => {
    const el = pane.current
    if (!grip || !el) return
    // Ask the layout, every move: a pane with room for all its rows has nothing to scroll, and a
    // strip that took the mouse anyway would be click-through taken away for nothing.
    const overflows = el.scrollHeight - el.clientHeight > 1
    hold(overflows && ev.clientX >= el.getBoundingClientRect().right - SCROLL_GRIP_W)
  }

  return (
    <div
      ref={pane}
      data-testid={testId}
      // The observable half of the carve-out, and the only way a hidden window can be asked about
      // it: present while the pane is pinned, 'held' exactly while the grip owns the mouse.
      data-scroll-grip={grip ? (held ? 'held' : 'idle') : undefined}
      onMouseMove={track}
      onMouseLeave={() => hold(false)}
      style={{ flexGrow: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '4px 6px' }}
    >
      <ScaledContent textScale={textScale}>{children}</ScaledContent>
    </div>
  )
}

/**
 * The text scale in force at `el` — i.e. the zoom the components above set on the content pane.
 *
 * WHY A MEASURE-THEN-PLACE LAYER NEEDS IT. `getBoundingClientRect()` reports VISUAL pixels (the
 * zoom is already in them), while a pixel written back into `top`/`left` inside the zoomed
 * subtree is multiplied by that same zoom on the way to the screen. Divide once, at the boundary
 * between the two spaces, and the feed's hover card lands on the row it belongs to at every
 * scale; skip it and at 1.5 it lands half a window off.
 *
 * ONE caller today (hoverCardLayer): it is the only `position: fixed` layer rendered INSIDE the
 * content pane. The selector popup hangs off the header, which is chrome and therefore unscaled,
 * so it measures and places in one space and converts nothing.
 *
 * Read from the ELEMENT rather than from the config: this is the value the engine actually
 * applied, so a layer that is somehow outside the zoomed subtree measures 1 and is left alone.
 */
export function overlayCssZoom(el: Element | null | undefined): number {
  const z = el?.currentCSSZoom ?? 1
  return z > 0 ? z : 1
}
