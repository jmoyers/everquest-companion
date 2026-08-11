// ============================================================================
// displayFit — keeping a remembered window rectangle on a screen that still exists (JOS-187).
// ============================================================================
//
// A player switched from a dual-monitor widescreen to a single monitor and lost the combat
// overlay: the window's remembered position was a point on a desktop that no longer had those
// coordinates, so it opened past the right edge of the only display left. Restarting could not
// help — restarting is what RE-APPLIED it — and toggling the overlay off and on re-created the
// window at the same stored rectangle. An overlay is frameless, always-on-top and out of Alt-Tab
// by design, so there was no way to drag it back either. This module is the geometry that answers
// that: given a remembered rectangle and the displays that exist NOW, where should the window go?
//
// PURE ON PURPOSE. Nothing here imports Electron: `windowPlacement.ts` is the half that asks the
// `screen` module what exists and calls in here, and this half is node-testable
// (tests/displayFit.test.mts) against display arrangements this machine does not have — a
// dual-wide that was unplugged, a second monitor above the primary, a display whose work area is
// smaller than the window. That split is why the fix can be TESTED rather than only reasoned about.
//
// THE POLICY, IN THREE RULES — and rule 1 is the one that makes this a fit rather than a clamp:
//
//   1. A rectangle FULLY covered by the displays' physical bounds is returned UNTOUCHED. Two
//      cases depend on it and both are legitimate placements a user chose:
//        * a window SPANNING two adjacent monitors (Electron's display coordinates tile without
//          overlapping, so the sum of the per-display intersections is exactly the covered area —
//          no union geometry needed), and
//        * a window sitting over the TASKBAR. `bounds` is the physical screen and `workArea`
//          excludes the taskbar; an always-on-top overlay parked over it is a normal thing to
//          want, and testing against the work area would haul it up by 40px on every launch.
//      So COVERAGE is tested against `bounds`, and only a window that has to MOVE is put into the
//      `workArea` — when we are already overruling the user's position, we put the window
//      somewhere unambiguously usable rather than somewhere half under a taskbar.
//   2. A rectangle that is only PARTLY on a display is clamped fully into the work area of the
//      display it overlaps most. Partly-off is the state the report describes and it is also the
//      state a window is left in by a resolution change, so it is corrected rather than tolerated.
//   3. A rectangle on NO display at all returns `null` — this module refuses to guess. The caller
//      knows what a sensible default is for the window it is placing (an overlay's reserved dock
//      slot; the main window centred on the primary display) and `null` is how it is asked for it.
//
// Sizes are clamped to the target work area before the position is, so a window remembered from a
// larger display cannot be positioned as if it still fitted.

/** A screen-coordinate rectangle — the shape `BrowserWindow.getBounds()` and `Display.bounds` share. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Just the dimensions of one — what survives when a rectangle has to be re-placed. */
export interface Size {
  width: number
  height: number
}

/**
 * One display, as this module needs it: the physical screen (`bounds`, the coverage test) and the
 * part of it a window belongs in (`workArea`, the clamp target). The two-field shape is Electron's
 * `Display` narrowed to what is used, so a test can describe a monitor in four numbers.
 */
export interface DisplayArea {
  bounds: Rect
  workArea: Rect
}

/** How much of `a` lies inside `b`, in square pixels (0 when they do not touch). */
export function intersectArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * `rect` moved (and, if it has to be, shrunk) so it lies entirely within `area`. Size first: a
 * window wider than the area it is being put into can never be positioned inside it, and shrinking
 * afterwards would leave the position computed against a width that no longer exists.
 */
export function clampInto(rect: Rect, area: Rect): Rect {
  const width = Math.min(rect.width, area.width)
  const height = Math.min(rect.height, area.height)
  return {
    width,
    height,
    x: Math.round(Math.max(area.x, Math.min(rect.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(rect.y, area.y + area.height - height)))
  }
}

/** `size` centred in `area`, shrunk to fit if it is larger. The re-placement of last resort. */
export function centerIn(size: Size, area: Rect): Rect {
  const width = Math.min(size.width, area.width)
  const height = Math.min(size.height, area.height)
  return {
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2)
  }
}

/**
 * Where `rect` should be on the displays that exist now — see the three rules in the header.
 *
 * Returns the SAME numbers when the rectangle is already fully on screen (rule 1), a clamped
 * rectangle when it is partly off (rule 2), and `null` when no display holds any of it (rule 3) or
 * when there is no display information at all. A degenerate rectangle (zero or negative extent)
 * is `null` too: there is nothing to keep on screen and nothing sensible to clamp.
 */
export function fitToDisplays(rect: Rect, displays: readonly DisplayArea[]): Rect | null {
  if (rect.width <= 0 || rect.height <= 0 || displays.length === 0) return null
  let covered = 0
  let best: DisplayArea | null = null
  let bestArea = 0
  for (const d of displays) {
    const area = intersectArea(rect, d.bounds)
    covered += area
    if (area > bestArea) {
      bestArea = area
      best = d
    }
  }
  if (covered >= rect.width * rect.height) return rect
  return best ? clampInto(rect, best.workArea) : null
}
