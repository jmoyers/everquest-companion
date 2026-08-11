// Keeping a remembered window on a screen that still exists (JOS-187).
//
// A player switched a dual-monitor widescreen for a single monitor and lost the combat overlay off
// the right-hand edge; restarting re-applied the stored position and toggling the overlay off and
// on re-created the window at it, so there was no way back — an overlay is frameless and out of
// Alt-Tab, so there is nothing to drag either. `src/main/displayFit.ts` is the geometry that
// answers it and this file is the reason the answer can be CHECKED: it is pure, so every monitor
// arrangement below is describable in four numbers, including the ones this machine does not have.
// No log, no fixture, no Electron — it never skips.
//
// The four properties, and rule 1 is the one that keeps this a FIT rather than a clamp:
//   1. A window fully on the physical screens is returned UNTOUCHED — including one SPANNING two
//      monitors and one sitting over the TASKBAR (coverage is tested against `bounds`, which
//      includes the taskbar strip that `workArea` excludes). Both are placements a user chose.
//   2. A window only partly on screen is clamped fully into the WORK AREA of the display it
//      overlaps most — when we are already overruling a position, the window goes somewhere
//      unambiguously usable.
//   3. A window on no display at all answers `null`: this module refuses to guess, and the caller
//      (windowPlacement.ts) supplies the default it knows — an overlay's reserved dock slot, or
//      the main window centred on the primary display.
//   4. A window remembered from a LARGER display is shrunk to fit before it is positioned.
//
// What is NOT here, because it needs Electron and a real window: that the fit is applied at
// creation AND on a live monitor change, and that the corrected rectangle is never written back
// over the one the user chose. tests/e2e/overlay-sync.e2e.mts drives both against the real app.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  centerIn,
  clampInto,
  fitToDisplays,
  intersectArea,
  type DisplayArea,
  type Rect
} from '../src/main/displayFit'

/** A display with no taskbar: work area == physical screen. */
const full = (x: number, y: number, width: number, height: number): DisplayArea => ({
  bounds: { x, y, width, height },
  workArea: { x, y, width, height }
})

/** A 1080p display with a 40px taskbar along the bottom — the ordinary Windows desktop. */
const withTaskbar = (x: number, y: number): DisplayArea => ({
  bounds: { x, y, width: 1920, height: 1080 },
  workArea: { x, y, width: 1920, height: 1040 }
})

/** THE REPORT'S OWN SETUP: two 1080p monitors side by side, the second to the right. */
const DUAL: DisplayArea[] = [withTaskbar(0, 0), withTaskbar(1920, 0)]
/** …and what was left of it after the player unplugged one. */
const SINGLE: DisplayArea[] = [withTaskbar(0, 0)]

const inside = (r: Rect, a: Rect): boolean =>
  r.x >= a.x && r.y >= a.y && r.x + r.width <= a.x + a.width && r.y + r.height <= a.y + a.height

test('a window already fully on screen is returned untouched', () => {
  const rect: Rect = { x: 1500, y: 700, width: 380, height: 320 }
  assert.deepEqual(fitToDisplays(rect, SINGLE), rect)
  assert.deepEqual(fitToDisplays(rect, DUAL), rect)
})

test('…including one parked over the TASKBAR, which is a placement someone chose', () => {
  // Below the work area's bottom edge (1040) but inside the physical screen (1080). An overlay is
  // always-on-top; sitting over the taskbar is a normal thing to want, and testing coverage against
  // the work area would haul this window up by 40px on every single launch.
  const overTaskbar: Rect = { x: 200, y: 760, width: 380, height: 320 }
  assert.ok(overTaskbar.y + overTaskbar.height > SINGLE[0].workArea.height, 'the fixture must overlap the taskbar')
  assert.deepEqual(fitToDisplays(overTaskbar, SINGLE), overTaskbar)
})

test('…and one SPANNING two monitors, which is the other', () => {
  // Half on each display. Electron's display coordinates tile without overlapping, so the summed
  // per-display intersections are exactly the covered area — no union geometry needed.
  const spanning: Rect = { x: 1730, y: 300, width: 380, height: 320 }
  assert.deepEqual(fitToDisplays(spanning, DUAL), spanning)
  // …and the moment the right-hand monitor goes away, the same rectangle is no longer whole.
  assert.notDeepEqual(fitToDisplays(spanning, SINGLE), spanning)
})

test('THE REPORT: the overlay on the monitor that was unplugged is not left where it was', () => {
  // The overlay lived at x=2600 — squarely on the second display, and entirely past the right edge
  // of the desktop that survived it. It was a perfectly good position right up until it was not,
  // which is why nothing here treats the stored value as suspect until the displays are counted.
  const stored: Rect = { x: 2600, y: 640, width: 380, height: 320 }
  assert.deepEqual(fitToDisplays(stored, DUAL), stored, 'untouched while both monitors existed')
  // On the single display it overlaps NOTHING, so this module answers null rather than inventing a
  // spot — and windowPlacement.ts turns that into the kind's reserved first-open dock slot, which
  // is the one position in the app the user already knows to look at.
  assert.equal(fitToDisplays(stored, SINGLE), null)
})

test('…and a window only PARTLY off is clamped into the work area of the display it overlaps most', () => {
  const hanging: Rect = { x: 1700, y: 900, width: 380, height: 320 }
  const fitted = fitToDisplays(hanging, SINGLE)
  assert.ok(fitted, 'it overlaps the remaining display, so it is fitted rather than refused')
  assert.ok(inside(fitted, SINGLE[0].workArea), `not inside the work area: ${JSON.stringify(fitted)}`)
  // Clamped, not re-placed: it keeps its size and moves the minimum distance.
  assert.equal(fitted.width, 380)
  assert.equal(fitted.height, 320)
  assert.equal(fitted.x, 1920 - 380, 'flush against the right edge of the work area')
  assert.equal(fitted.y, 1040 - 320, 'and above the taskbar, which is where a window we MOVE belongs')
})

test('the display it overlaps MOST is the one it lands on', () => {
  // Straddling the seam, but mostly on the right-hand monitor: it must not be dragged onto the left.
  const mostlyRight: Rect = { x: 1850, y: 1000, width: 380, height: 320 }
  const fitted = fitToDisplays(mostlyRight, DUAL)
  assert.ok(fitted && inside(fitted, DUAL[1].workArea), `${JSON.stringify(fitted)} should be on the second display`)
})

test('a window on NO display answers null — the module refuses to guess', () => {
  assert.equal(fitToDisplays({ x: 4000, y: 4000, width: 380, height: 320 }, SINGLE), null)
  // A negative-coordinate desktop is real (a monitor to the LEFT of the primary), so "off screen"
  // is not "x < 0" — it is "no display holds any of it".
  assert.equal(fitToDisplays({ x: -2400, y: 0, width: 380, height: 320 }, SINGLE), null)
  const withLeftMonitor = [...SINGLE, full(-1920, 0, 1920, 1080)]
  assert.deepEqual(fitToDisplays({ x: -1800, y: 0, width: 380, height: 320 }, withLeftMonitor), {
    x: -1800,
    y: 0,
    width: 380,
    height: 320
  })
})

test('…and so does a window with no displays to be on, or no size to speak of', () => {
  assert.equal(fitToDisplays({ x: 0, y: 0, width: 380, height: 320 }, []), null)
  assert.equal(fitToDisplays({ x: 0, y: 0, width: 0, height: 320 }, SINGLE), null)
  assert.equal(fitToDisplays({ x: 0, y: 0, width: 380, height: -1 }, SINGLE), null)
})

test('a window remembered from a LARGER display is shrunk before it is positioned', () => {
  // A 900x900 window remembered from a 1440p panel, fitted onto a small laptop's work area.
  const laptop: DisplayArea[] = [full(0, 0, 1366, 728)]
  const fitted = fitToDisplays({ x: 1200, y: 600, width: 900, height: 900 }, laptop)
  assert.ok(fitted, 'it overlaps the laptop panel')
  assert.deepEqual(fitted, { x: 466, y: 0, width: 900, height: 728 })
  assert.ok(inside(fitted, laptop[0].workArea))
})

test('clampInto and centerIn are the two placements, and both stay inside', () => {
  const area: Rect = { x: 100, y: 100, width: 800, height: 600 }
  assert.deepEqual(clampInto({ x: 0, y: 0, width: 200, height: 100 }, area), {
    x: 100,
    y: 100,
    width: 200,
    height: 100
  })
  assert.deepEqual(centerIn({ width: 200, height: 100 }, area), {
    x: 400,
    y: 350,
    width: 200,
    height: 100
  })
  // Both shrink rather than overflow.
  assert.deepEqual(clampInto({ x: -50, y: -50, width: 2000, height: 2000 }, area), area)
  assert.deepEqual(centerIn({ width: 2000, height: 2000 }, area), area)
})

test('intersectArea is zero for rectangles that only touch', () => {
  const a: Rect = { x: 0, y: 0, width: 100, height: 100 }
  assert.equal(intersectArea(a, { x: 100, y: 0, width: 100, height: 100 }), 0, 'edge to edge is not overlap')
  assert.equal(intersectArea(a, { x: 50, y: 50, width: 100, height: 100 }), 2500)
  assert.equal(intersectArea(a, a), 10_000)
})
