// overlayFit — THE MEASUREMENT SIDE of "the window fits the card" (JOS-386).
//
// Three processes share this feature and each owns exactly one part of it:
//
//   this file / ConCardOverlay  — MEASURES what was drawn, and decides when that is worth saying.
//   main/overlayLayout.ts       — the POLICY: clamp the request to the floor and to the work area
//                                 below the window's top edge (`fittedOverlayHeight`).
//   main/windows.ts             — the WINDOW: apply it, never persist it as a chosen size.
//
// The pure halves live here so `npm test` can hold them (this repo has no jsdom — the split every
// card feature uses; conCardRows.ts states it). The hook that owns the ResizeObserver stays with
// the component, because it is DOM plumbing and there is nothing to assert about it that the e2e
// does not assert better against the real window.
//
// WHAT IS MEASURED IS THE CONTENT BOX, NOT THE WINDOW. The overlay's root is `height: 100%` of a
// window whose height is what we are trying to decide, so measuring it would be a loop that always
// answers "whatever I already am". The measured element is the inner wrapper holding the drag frame
// and the scaled card; the window's own padding is added back here.

/**
 * The height to ask main for, given the measured content box and the padding the overlay root wears
 * on each side.
 *
 * `getBoundingClientRect().height` already carries the CSS `zoom` ScaledContent applies for the text
 * scale (overlayScale.tsx says why that is the unit that matters), so nothing here multiplies by a
 * scale — a card at 2.0 measures twice as tall and the window follows it, which is acceptance
 * criterion 3 of this ticket.
 *
 * CEILED rather than rounded: a fractional layout height that rounds DOWN is a window one pixel
 * short of its own content, and on a card with a border that pixel is visible as a clipped edge.
 */
export function overlayFitRequest(contentPx: number, paddingPx: number): number {
  if (!Number.isFinite(contentPx) || contentPx <= 0) return 0
  return Math.ceil(contentPx) + 2 * paddingPx
}

/**
 * How far a new measurement has to differ from the last one SENT before it is worth an IPC message.
 *
 * A layout height is a float and a window height is an integer, so the two disagree by a fraction
 * of a pixel constantly; without a threshold a card that never changed would send on every render.
 * One pixel is the smallest difference a window can actually express.
 */
export const FIT_EPSILON_PX = 1

/** Is this measurement a real change from the last one sent? An unsent height always is. */
export function fitChanged(sent: number | null, next: number): boolean {
  if (next <= 0) return false
  return sent === null || Math.abs(next - sent) > FIT_EPSILON_PX
}
