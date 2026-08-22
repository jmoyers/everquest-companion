// ============================================================================
// windowPlacement — asking the OS what screens exist, and where a window may go on them (JOS-187).
// ============================================================================
//
// The Electron half of `displayFit.ts` (which is the pure geometry, and carries the policy
// argument in its header — read that first). This file does two things and nothing else:
//
//   * it turns `screen`'s displays into the four-number shapes the geometry works in, and
//   * it names the DEFAULT each window falls back to when its remembered rectangle is on no
//     display at all — the overlay's own reserved dock slot (overlayLayout.ts) for an overlay,
//     and "centred on the primary display" for the main window.
//
// It also owns the WATCH. Placement has to be re-decided at two moments, not one: when a window is
// created (the launch after the monitor changed — which is the report's own case, since restarting
// is what re-applied the lost position) and while the app is running (the user unplugs the
// monitor the overlay is on, and nothing in this app would otherwise notice). Both go through the
// same function, so a window can never be created by one rule and corrected by another.
//
// THE SEAM IS DELIBERATELY THE ONLY ONE. Two nearby asks are on the owner's desk and NEITHER is
// built here: pinning overlays to a chosen monitor, and snapping them to a grid. Both are further
// constraints on the same question this file answers — "given what the user wants and what exists,
// where does this window go" — so both land in `overlayFittedBounds` (and, for a snap, on the
// user's own move) without disturbing anything below. Nothing here writes to the store, so a future
// rule can neither be fought by this one nor quietly overwrite what the user chose.
//
// WHY THE WATCH IS DEBOUNCED. A single dock/undock is a BURST of screen events — a removal, an
// addition and several metrics changes as Windows re-lays-out what is left — and the work areas
// are not final until it settles. Reconciling on the first one would place windows against an
// arrangement that is about to change again. The timer is unref'd, so it can never hold the
// process open (AGENTS.md: a main-process timer lands on the next 15.6 ms tick edge, which is
// noise against a 300 ms settle).

import { screen } from 'electron'
import { centerIn, fitToDisplays, type DisplayArea, type Rect, type Size } from './displayFit'
import { defaultOverlayBounds } from './overlayLayout'
import type { OverlayKind } from '../shared/types'

/**
 * The displays as the geometry needs them, or an empty list when there is no screen information
 * (the `screen` module throws before Electron is ready, and a headless environment can answer with
 * nothing). An empty list makes every fit below `null`, which is exactly "we cannot know, so change
 * nothing" — never "move this window to the origin".
 */
function displayAreas(): DisplayArea[] {
  try {
    return screen.getAllDisplays().map((d) => ({ bounds: d.bounds, workArea: d.workArea }))
  } catch {
    return []
  }
}

/**
 * Every display's WORK AREA — the rectangles an overlay drag may snap its edges to (JOS-217).
 *
 * The work area rather than `bounds`, deliberately, and it is the same distinction displayFit.ts
 * draws for a different reason: a window a user PARKS over the taskbar is a legitimate placement
 * and is left alone, but a window the app is helping them line up should land beside the taskbar,
 * not under it. Empty when there is no screen information, which makes the snap a no-op.
 */
export function displayWorkAreas(): Rect[] {
  return displayAreas().map((d) => d.workArea)
}

/** The primary display's work area, or null when there is no screen information (see above). */
function primaryWorkArea(): Rect | null {
  try {
    return screen.getPrimaryDisplay().workArea
  } catch {
    return null
  }
}

/**
 * Where a kind's overlay window belongs RIGHT NOW, given the bounds the user last left it at.
 *
 * `stored` that is still fully on a screen comes back unchanged — the overwhelmingly common case,
 * and the one that must cost nothing. So does one that hangs off an edge by no more than the fit's
 * slack (JOS-433: a meter parked along the bottom of the screen is a placement, not a defect).
 * `stored` that is substantially off screen is fitted, and a rectangle on no display at all falls
 * back to that kind's reserved first-open dock slot on the primary display: the same bottom-right
 * stack a fresh install gets, so a recovered overlay lands somewhere the user already knows to look
 * and never on top of another kind.
 *
 * THE FIT'S DEFAULTS ARE THE OVERLAY'S DEFAULTS — an always-on-top overlay is drawn over the
 * taskbar by design, so a correction that has to move one stops at the physical screen edge rather
 * than above the taskbar. `mainWindowBounds` below asks for the other answer, and says why.
 *
 * `null` means there is no display information to place against. Callers keep whatever they have.
 */
export function overlayFittedBounds(kind: OverlayKind, stored?: Rect): Rect | null {
  const fitted = stored ? fitToDisplays(stored, displayAreas()) : null
  if (fitted) return fitted
  const workArea = primaryWorkArea()
  return workArea ? defaultOverlayBounds(kind, workArea) : null
}

/**
 * THE WORK AREA A GIVEN RECTANGLE IS ON (JOS-386) — the screen a window has to fit inside RIGHT
 * NOW, which for a multi-monitor user is not the primary one.
 *
 * `getDisplayMatching` is Electron's own answer to "which display is this window mostly on", so a
 * window straddling two monitors resolves the same way the OS resolves it rather than by a rule
 * invented here. The WORK AREA rather than `bounds`, for the reason `displayWorkAreas` gives: a
 * window the app is sizing should stop at the taskbar, not run under it.
 *
 * `null` when there is no screen information at all (the `screen` module throws before Electron is
 * ready; a headless environment can answer with nothing), which every caller reads as "we cannot
 * know, so change nothing" — never as a reason to invent a rectangle.
 */
export function workAreaFor(rect: Rect): Rect | null {
  try {
    return screen.getDisplayMatching(rect).workArea
  } catch {
    return null
  }
}

/**
 * The same question for the MAIN window, whose fallback is different: it has no reserved slot, so a
 * rectangle on no display keeps the SIZE the user chose and is centred on the primary display.
 *
 * `undefined` in, `undefined` out — a fresh install has no remembered bounds and its first launch
 * is placed by the OS exactly as it always was. This function never invents a position for a window
 * that never had one.
 *
 * AND IT CLAMPS INTO THE WORK AREA, WHERE AN OVERLAY CLAMPS INTO THE SCREEN (JOS-433). The slack
 * band is shared — a main window somebody left flush with the bottom of their screen has exactly
 * the same right not to be hauled upward on every launch — but the two windows differ in the one
 * case where a rectangle really has to be MOVED: this one is an ordinary framed window that belongs
 * beside the taskbar, not under it. Same distinction, same reason, as `displayWorkAreas` above.
 */
export function mainWindowBounds(stored?: Rect): Rect | undefined {
  if (!stored) return undefined
  const fitted = fitToDisplays(stored, displayAreas(), { clampTo: 'workArea' })
  if (fitted) return fitted
  const workArea = primaryWorkArea()
  const size: Size = { width: stored.width, height: stored.height }
  return workArea ? centerIn(size, workArea) : stored
}

/** How long the monitor arrangement has to hold still before windows are re-placed against it. */
const SETTLE_MS = 300

/**
 * Re-run `onChange` shortly after the monitor arrangement changes, coalescing a dock/undock burst
 * into ONE pass (see the header). Installed once for the life of the process — a display that
 * appears later must not be able to miss it, which is the same argument `hardenWebContents` is
 * installed from a catch-all for.
 */
export function watchDisplays(onChange: () => void): void {
  let pending: NodeJS.Timeout | null = null
  const bump = (): void => {
    if (pending) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = null
      onChange()
    }, SETTLE_MS)
    pending.unref()
  }
  screen.on('display-added', bump)
  screen.on('display-removed', bump)
  screen.on('display-metrics-changed', bump)
}
