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
// The properties, and rule 1 is the one that keeps this a FIT rather than a clamp:
//   1. A window fully on the physical screens is returned UNTOUCHED — including one SPANNING two
//      monitors and one sitting over the TASKBAR (coverage is tested against `bounds`, which
//      includes the taskbar strip that `workArea` excludes). Both are placements a user chose.
//   1b. …and so is one that hangs off the LEFT, RIGHT or BOTTOM edge by no more than the slack
//      (JOS-433). Never the TOP: an overlay is dragged by its header, so that is the one overhang
//      that can take away the way back.
//   2. A window substantially off screen is clamped fully into the display it overlaps most — into
//      its `bounds` by default (an always-on-top overlay belongs over the taskbar) or into its
//      `workArea` when the caller says so (windowPlacement.ts's main window).
//   3. A window on no display at all answers `null`: this module refuses to guess, and the caller
//      (windowPlacement.ts) supplies the default it knows — an overlay's reserved dock slot, or
//      the main window centred on the primary display.
//   4. A window remembered from a LARGER display is shrunk to fit before it is positioned.
//   5. A correction is never a drift: re-running the fit against the restored displays gives the
//      stored rectangle back byte-identical.
//
// THE JOS-433 REGRESSION is the bottom-anchor block below, and it is a measurement before it is a
// test: with the old all-or-nothing coverage test and a work-area clamp, ONE pixel of overhang past
// the physical bottom cost 41px of upward movement on a 1080p screen with a 40px taskbar — every
// launch, and every display change a fullscreen game fires at login.
//
// What is NOT here, because it needs Electron and a real window: that the fit is applied at
// creation AND on a live monitor change, and that the corrected rectangle is never written back
// over the one the user chose. tests/e2e/overlay-sync.e2e.mts drives both against the real app.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EDGE_SLACK_PX,
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

// ---- JOS-433: THE BOTTOM-ANCHOR REGRESSION ----------------------------------------------------
//
// "I have the Zone+Session overlay window at the bottom right of my EQ and my event+damage meter at
// the bottom left … every time I login all the windows move upward and I have to reposition them …
// doesn't do it if I position them at the top."  (report 01M0FZEB9DPPKE0KGKHHPH670K, v1.6.0)
//
// The old rule 1 was all-or-nothing and the old rule 2 clamped into the WORK AREA, so one pixel of
// overhang past the physical bottom bought 41px of upward movement on this fixture. These are the
// pixels that used to move.

/** The reporter's two windows: a meter along the bottom of a 1080p screen, `over` px past the edge. */
const alongTheBottom = (x: number, over: number): Rect => ({
  x,
  y: 1080 - 320 + over,
  width: 380,
  height: 320
})

test('JOS-433: a meter parked along the bottom edge survives, one pixel over or forty', () => {
  // 0px was already safe (the taskbar test above); 1px was the cliff, and 40 is a whole taskbar.
  for (const over of [0, 1, 2, 10, 40]) {
    for (const x of [40, 1500]) {
      const parked = alongTheBottom(x, over)
      assert.deepEqual(
        fitToDisplays(parked, SINGLE),
        parked,
        `${over}px over the bottom edge at x=${x} was moved`
      )
    }
  }
})

test('…and it survives it AGAIN, which is the part the reporter was counting', () => {
  // The fit runs on every launch and on every display change a fullscreen game fires at login. The
  // defect was that each of those runs moved the window again, so idempotence is the property.
  const parked = alongTheBottom(1500, 2)
  let rect = parked
  for (let login = 0; login < 5; login++) {
    const fitted = fitToDisplays(rect, SINGLE)
    assert.ok(fitted, 'still on a display')
    rect = fitted
  }
  assert.deepEqual(rect, parked, 'five logins later it is where the user put it')
})

test('…the slack band ends where it says it ends, and past it the window stops at the SCREEN edge', () => {
  const atTheLimit = alongTheBottom(1500, EDGE_SLACK_PX)
  assert.deepEqual(fitToDisplays(atTheLimit, SINGLE), atTheLimit, 'the last tolerated pixel')
  const overTheLimit = alongTheBottom(1500, EDGE_SLACK_PX + 1)
  const fitted = fitToDisplays(overTheLimit, SINGLE)
  assert.ok(fitted)
  // Nudged back onto the screen, NOT lifted above the taskbar: it moves the minimum distance.
  assert.equal(fitted.y, 1080 - 320)
  assert.equal(fitted.x, 1500, 'and it does not move sideways for a vertical problem')
})

test('…and the LEFT and RIGHT edges get the same tolerance', () => {
  const offLeft: Rect = { x: -40, y: 300, width: 380, height: 320 }
  assert.deepEqual(fitToDisplays(offLeft, SINGLE), offLeft)
  const offRight: Rect = { x: 1920 - 380 + 40, y: 300, width: 380, height: 320 }
  assert.deepEqual(fitToDisplays(offRight, SINGLE), offRight)
})

test('…but the TOP edge never does, because that is the one that hides the drag handle', () => {
  // An overlay is frameless and is dragged by its header. A window hanging off the top is the
  // JOS-187 report all over again — there is no way back — so it is corrected however small the
  // overhang is.
  const offTop: Rect = { x: 700, y: -1, width: 380, height: 320 }
  const fitted = fitToDisplays(offTop, SINGLE)
  assert.ok(fitted)
  assert.equal(fitted.y, 0, 'pulled down onto the screen')
})

test('JOS-433: a correction is never a drift — the metrics come back, so does the window', () => {
  // The user's rectangle lives in the store untouched (overlayBounds.ts), so the only thing that
  // has to hold here is that re-running the fit against the restored displays is an identity.
  const stored: Rect = { x: 1500, y: 740, width: 380, height: 320 }
  assert.deepEqual(fitToDisplays(stored, SINGLE), stored, 'untouched at the desktop resolution')
  const shrunken: DisplayArea[] = [
    { bounds: { x: 0, y: 0, width: 1600, height: 900 }, workArea: { x: 0, y: 0, width: 1600, height: 860 } }
  ]
  const temporary = fitToDisplays(stored, shrunken)
  assert.ok(temporary && inside(temporary, shrunken[0].bounds), 'moved onto the smaller screen')
  assert.notDeepEqual(temporary, stored)
  assert.deepEqual(fitToDisplays(stored, SINGLE), stored, 'and the stored rectangle is given back whole')
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

test('…and a window SUBSTANTIALLY off is clamped into the display it overlaps most', () => {
  // 160px off the right edge and 140px below the bottom — well past the slack band, so this is a
  // window that really has lost most of itself and the fit corrects it.
  const hanging: Rect = { x: 1700, y: 900, width: 380, height: 320 }
  const fitted = fitToDisplays(hanging, SINGLE)
  assert.ok(fitted, 'it overlaps the remaining display, so it is fitted rather than refused')
  assert.ok(inside(fitted, SINGLE[0].bounds), `not inside the screen: ${JSON.stringify(fitted)}`)
  // Clamped, not re-placed: it keeps its size and moves the minimum distance.
  assert.equal(fitted.width, 380)
  assert.equal(fitted.height, 320)
  assert.equal(fitted.x, 1920 - 380, 'flush against the right edge of the screen')
  // JOS-433: the physical edge, not the work area's. An overlay is always-on-top and is drawn over
  // the taskbar by design (the test above), so a correction that lifted it clear of one would be
  // moving the window further than the problem requires.
  assert.equal(fitted.y, 1080 - 320, 'flush against the bottom of the SCREEN, taskbar and all')
})

test('…into the WORK AREA instead when the caller says it is not an overlay', () => {
  // The main window's answer (windowPlacement.ts `mainWindowBounds`): an ordinary framed window
  // belongs beside the taskbar, not under it, so the one case where a window must really be MOVED
  // keeps its pre-JOS-433 landing spot.
  const hanging: Rect = { x: 1700, y: 900, width: 380, height: 320 }
  const fitted = fitToDisplays(hanging, SINGLE, { clampTo: 'workArea' })
  assert.ok(fitted && inside(fitted, SINGLE[0].workArea), `not inside the work area: ${JSON.stringify(fitted)}`)
  assert.equal(fitted.y, 1040 - 320, 'above the taskbar')
})

test('the display it overlaps MOST is the one it lands on', () => {
  // Straddling the seam, but mostly on the right-hand monitor: it must not be dragged onto the left.
  const mostlyRight: Rect = { x: 1850, y: 1000, width: 380, height: 320 }
  const fitted = fitToDisplays(mostlyRight, DUAL)
  assert.ok(fitted && inside(fitted, DUAL[1].bounds), `${JSON.stringify(fitted)} should be on the second display`)
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
