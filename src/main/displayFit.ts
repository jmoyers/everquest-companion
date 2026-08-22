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
//   2. A rectangle that is only PARTLY on a display is clamped fully into the display it overlaps
//      most. Partly-off is the state the report describes and it is also the state a window is left
//      in by a resolution change, so it is corrected rather than tolerated.
//   3. A rectangle on NO display at all returns `null` — this module refuses to guess. The caller
//      knows what a sensible default is for the window it is placing (an overlay's reserved dock
//      slot; the main window centred on the primary display) and `null` is how it is asked for it.
//
// Sizes are clamped to the target area before the position is, so a window remembered from a
// larger display cannot be positioned as if it still fitted.
//
// ---- JOS-433: RULE 1 HAD A ONE-PIXEL CLIFF, AND IT COST A TASKBAR ------------------------------
//
// The v1.6.0 report: *"I have the Zone+Session overlay window at the bottom right of my EQ and my
// event+damage meter at the bottom left … every time I login all the windows move upward and I have
// to reposition them … doesn't do it if I position them at the top."*
//
// Rule 1's coverage test is ALL-OR-NOTHING, and rule 2's clamp target was the WORK AREA, so the two
// together made the bottom edge of the screen a cliff. MEASURED on a 1920x1080 display with a 40px
// taskbar, a 380x320 window parked along the bottom:
//
//     overhang  0px   stored y=760  ->  fitted y=760   (untouched)
//     overhang  1px   stored y=761  ->  fitted y=720   (hauled 41px UP)
//     overhang  2px   stored y=762  ->  fitted y=720   (hauled 42px UP)
//
// One pixel past the physical edge and the window is not nudged one pixel back — it is lifted clear
// of the taskbar, every time the fit runs (every launch, and every display-metrics-changed a
// fullscreen game fires at login). The user drags it back down, lands a pixel over again, and the
// next login repeats it. And a pixel over is not an exotic state: dragging a frameless window's
// body past the bottom edge is allowed, and overlayBounds.ts's own header records that `setBounds`
// is not an identity on a scaled display — the value round-trips through physical pixels and can
// come back one off, which is then what gets written down.
//
// THE OWNER'S RULING (2026-08-20): make the clamping less aggressive by default, so that deliberate
// bottom-of-screen placement survives a login. Two changes, and neither of them touches rule 3:
//
//   1b. A SLACK BAND. A rectangle that hangs past the physical edge by no more than `slackPx` is
//       left where it is. The correction exists to rescue a window the user cannot reach, and a
//       window whose last 40 pixels are off the bottom is not that window — it is a window somebody
//       parked. NOT ON THE TOP EDGE, deliberately: an overlay's drag handle is its header, so a top
//       overhang is the one direction that can take away the way back, which is the whole subject
//       of JOS-187. That asymmetry is also the reporter's own observation ("doesn't do it if I
//       position them at the top") read as a rule.
//   2b. THE CLAMP TARGET IS THE CALLER'S CHOICE, because it is a fact about the WINDOW rather than
//       about the geometry. An always-on-top overlay is drawn OVER the taskbar by design (rule 1
//       has always said so), so when one must be moved it should stop at the physical edge —
//       `clampTo: 'bounds'`, the default. An ordinary window is not drawn over the taskbar, so the
//       main window asks for `'workArea'` (windowPlacement.ts) and keeps exactly today's behaviour
//       for the case where it really must be re-placed.
//
// WHAT DOES NOT CHANGE, and is the reason a temporary correction is not a drift: the STORE keeps
// the rectangle the user chose (overlayBounds.ts), so a fit that has to move a window is undone the
// moment the metrics come back — `fitToDisplays` re-run against the restored displays returns the
// stored rectangle byte-identical. Pinned in tests/displayFit.test.mts.

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

/**
 * HOW FAR PAST A DISPLAY'S PHYSICAL EDGE A WINDOW MAY HANG AND STILL BE LEFT ALONE (JOS-433).
 *
 * 48px is a Windows 11 taskbar at 100% scaling — the band the old behaviour used to lift a window
 * clear of, and therefore the band a deliberate bottom-of-screen placement has to be allowed to sit
 * in. It is a distance, not a fraction, so it means the same thing to a big meter and a small one;
 * the honest cost is that the smallest overlay this app allows (OVERLAY_MIN_SIZE, 140x90) could be
 * left with a little over half of itself showing. That is still a window the user can see and drag,
 * and it is where they put it — which is the trade this rule exists to make.
 */
export const EDGE_SLACK_PX = 48

/** Where a fit that must MOVE a window puts it: over the taskbar (`bounds`) or beside it (`workArea`). */
export type ClampTarget = 'bounds' | 'workArea'

/** The two knobs on the fit — both defaulted, so the ordinary call is still `fitToDisplays(r, ds)`. */
export interface FitOptions {
  /** Overhang tolerated on the left, right and bottom edges. Defaults to `EDGE_SLACK_PX`. */
  slackPx?: number
  /** Which rectangle of the chosen display a moved window is clamped into. Defaults to `'bounds'`. */
  clampTo?: ClampTarget
}

/**
 * How far `rect` sticks out past `area` on its worst TOLERABLE edge — left, right or bottom.
 *
 * The TOP is not in this list on purpose (see rule 1b in the header): an overlay is dragged by the
 * header along its top edge, so a window hanging off the top is the one that cannot be recovered.
 * `topIsOff` below asks that question separately, and a `true` answer refuses the slack outright.
 */
function overhangPast(rect: Rect, area: Rect): number {
  return Math.max(
    0,
    area.x - rect.x,
    rect.x + rect.width - (area.x + area.width),
    rect.y + rect.height - (area.y + area.height)
  )
}

/**
 * Rule 1b: is `rect` merely PARKED over `area`'s edge rather than lost off it?
 *
 * True when nothing of it is above the area (an overlay is dragged by its top edge, so that
 * overhang is the one that can take away the way back) and no other edge is further out than
 * `slackPx`.
 */
function parkedOverEdge(rect: Rect, area: Rect, slackPx: number): boolean {
  return rect.y >= area.y && overhangPast(rect, area) <= slackPx
}

/** What the displays hold of one rectangle: how much in total, and which one holds the most. */
interface Coverage {
  /** Square pixels of `rect` covered by any display, summed (Electron's displays tile, so no union). */
  covered: number
  /** The display holding the largest piece of it, or `null` when none holds any at all. */
  best: DisplayArea | null
}

/** Measure `rect` against every display once — the only pass this module makes over them. */
function coverageOf(rect: Rect, displays: readonly DisplayArea[]): Coverage {
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
  return { covered, best }
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
 * Where `rect` should be on the displays that exist now — see the rules in the header.
 *
 * Returns the SAME numbers when the rectangle is already fully on screen (rule 1) or hangs off an
 * edge by no more than the slack (rule 1b), a clamped rectangle when it is substantially off (rule
 * 2), and `null` when no display holds any of it (rule 3) or when there is no display information
 * at all. A degenerate rectangle (zero or negative extent) is `null` too: there is nothing to keep
 * on screen and nothing sensible to clamp.
 */
export function fitToDisplays(
  rect: Rect,
  displays: readonly DisplayArea[],
  options: FitOptions = {}
): Rect | null {
  if (rect.width <= 0 || rect.height <= 0 || displays.length === 0) return null
  const { covered, best } = coverageOf(rect, displays)
  if (covered >= rect.width * rect.height) return rect
  if (!best) return null
  // Rule 1b: a window somebody parked over an edge is not a window that needs rescuing.
  if (parkedOverEdge(rect, best.bounds, options.slackPx ?? EDGE_SLACK_PX)) return rect
  return clampInto(rect, options.clampTo === 'workArea' ? best.workArea : best.bounds)
}
