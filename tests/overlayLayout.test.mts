// Default overlay placement (Task #59 follow-up: UNIFORM default size).
//
// This is pure geometry — no log, no fixture, so it never skips. It pins the two properties the
// first-open layout has to have on any display, and the one product rule behind them:
//   1. EVERY METER kind opens at the SAME width x height (user decision). No per-kind sizes.
//   2. The reserved slots never overlap and never leave the work area — with uniform sizes the
//      bottom-right stack wraps into a new column instead of running off the top of the screen.
// Persisted bounds are not exercised here: they short-circuit this module entirely in
// createOverlayWindow (index.ts prefers `cfg.bounds` and only calls in here when there are none).
//
// THE TOAST IS THE ONE KIND OUTSIDE ALL OF THAT (docs/plans/celebration-toasts.md §3). It is a
// transparent celebration strip, not a meter: its own width, TOP-CENTRED, and holding no slot
// in the bottom-right stack — so the meter assertions run over METER_KINDS and the toast gets
// its own geometry test below. Adding it must not have moved any meter's reserved slot, which
// is what the last test in this file checks.
//
// JOS-119 ADDED THE SEVENTH METER KIND ('debuffs') and with it the case rule 2 could no longer
// satisfy at a fixed size: seven 380x320 slots do not fit a 1366x728 work area under ANY column
// arrangement (three columns and two rows is six). So the uniform size is now a function of the
// display — it shrinks, all kinds together, until the reserved grid fits — and rule 1 is stated
// PER WORK AREA. `uniform on this display` is the property; `always 380x320` never was one that
// could survive a seventh window, and the alternative was two windows opening on top of each
// other, which is the thing this file exists to forbid.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  METER_KINDS,
  OVERLAY_MIN_SIZE,
  STRIP_KINDS,
  defaultOverlayBounds,
  overlayDefaultSize,
  scaledStripBounds,
  stripLayoutBounds,
  type Bounds
} from '../src/main/overlayLayout'
import { OVERLAY_KINDS } from '../src/shared/types'

/** Work areas worth proving: a 1080p desktop with a taskbar, a tall 1440p, a small laptop, and a
 *  non-zero-origin display (a second monitor left of the primary). */
const WORK_AREAS: Record<string, Bounds> = {
  '1080p': { x: 0, y: 0, width: 1920, height: 1040 },
  '1440p': { x: 0, y: 0, width: 2560, height: 1400 },
  'small laptop': { x: 0, y: 0, width: 1366, height: 728 },
  'offset display': { x: -1920, y: 120, width: 1920, height: 960 }
}

const overlaps = (a: Bounds, b: Bounds): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

test('every METER kind opens at ONE uniform default size', () => {
  const sizes = METER_KINDS.map((k) => overlayDefaultSize(k))
  const first = sizes[0]
  // Eight since JOS-195 added the XP window. The floor is a floor, not a count: it exists so a
  // kind cannot go MISSING from the stack without this file noticing.
  assert.ok(METER_KINDS.length >= 8, 'every meter kind is still registered')
  for (const [i, s] of sizes.entries()) {
    assert.deepEqual(s, first, `${METER_KINDS[i]} must use the uniform size`)
  }
  // Erring slightly larger than every per-kind size this replaced (the largest was 360x300), so
  // the event log — the only kind that is a list rather than dense bars — is not cramped.
  assert.ok(first.width >= 360, `width ${first.width} must not be smaller than the old event log`)
  assert.ok(first.height >= 300, `height ${first.height} must not be smaller than the old event log`)
})

test('…and the size stays uniform ON EVERY DISPLAY, even where it had to shrink', () => {
  for (const [name, wa] of Object.entries(WORK_AREAS)) {
    const sizes = METER_KINDS.map((k) => overlayDefaultSize(k, wa))
    for (const [i, s] of sizes.entries()) {
      assert.deepEqual(s, sizes[0], `${name}/${METER_KINDS[i]}: not the same size as its siblings`)
    }
    // Never LARGER than the shipped size — the ladder only ever goes down.
    assert.ok(sizes[0].width <= 380 && sizes[0].height <= 320, `${name}: ${JSON.stringify(sizes[0])}`)
  }
})

test('a display big enough for the whole stack is untouched at the shipped size', () => {
  // 1080p and up seat all NINE reserved slots at 380x320 (four columns of three), so nobody with
  // an ordinary monitor sees a smaller first-open window because a kind was added. This is the
  // claim each new kind has to re-earn: JOS-195's eighth was the first to arrive after the shrink
  // ladder existed, and shared/types.ts promised the machinery would absorb it.
  for (const name of ['1080p', '1440p']) {
    const s = overlayDefaultSize('fight', WORK_AREAS[name])
    assert.deepEqual(s, { width: 380, height: 320 }, `${name} should not have needed to shrink`)
  }
})

test('the 1920x960 offset display took the NINTH kind one rung down, and that is the answer', () => {
  // MEASURED, JOS-194, and the reason this case moved out of the test above rather than being
  // argued away. A 1920x960 work area is 80 px shorter than 1080p-with-a-taskbar, which is exactly
  // enough to cost it a THIRD ROW at 320 px: 4 columns x 2 rows = 8 full-size slots, and there are
  // now nine kinds. The ladder's next rung (0.85) gives 323x272, which seats 5 x 3 = 15.
  //
  // That is the machinery doing its job, not a regression. The alternative — the thing this whole
  // file exists to forbid — is two windows opening on the same spot. The slot is a little smaller
  // on one class of display; nobody's window lands under somebody else's.
  const s = overlayDefaultSize('fight', WORK_AREAS['offset display'])
  assert.deepEqual(s, { width: 323, height: 272 })
  // …and it is still a readable window rather than a postage stamp, on the same bar the small
  // laptop is held to.
  assert.ok(s.width >= 260 && s.height >= 220)
})

test('a small laptop SHRINKS the stack rather than stacking two windows on one spot', () => {
  // The exact case shared/types.ts used to warn about. Eight 380x320 slots cannot be laid out on
  // a 1366x728 work area; the answer is a smaller uniform slot, never an overlap (proven by the
  // no-overlap test below, which runs over this work area too).
  const wa = WORK_AREAS['small laptop']
  const s = overlayDefaultSize('fight', wa)
  assert.ok(s.width < 380, `expected a shrunk slot on a small laptop, got ${JSON.stringify(s)}`)
  // …and still a readable window, not a postage stamp.
  assert.ok(s.width >= 260 && s.height >= 220, `shrunk too far: ${JSON.stringify(s)}`)
})

test('the reserved slots never overlap and stay inside the work area', () => {
  for (const [name, wa] of Object.entries(WORK_AREAS)) {
    const placed = METER_KINDS.map((k) => defaultOverlayBounds(k, wa))
    for (const [i, b] of placed.entries()) {
      assert.equal(b.width, overlayDefaultSize(METER_KINDS[i], wa).width)
      assert.equal(b.height, overlayDefaultSize(METER_KINDS[i], wa).height)
      assert.ok(b.x >= wa.x, `${name}/${METER_KINDS[i]}: off the left edge`)
      assert.ok(b.y >= wa.y, `${name}/${METER_KINDS[i]}: off the top edge`)
      assert.ok(b.x + b.width <= wa.x + wa.width, `${name}/${METER_KINDS[i]}: off the right edge`)
      assert.ok(b.y + b.height <= wa.y + wa.height, `${name}/${METER_KINDS[i]}: off the bottom edge`)
    }
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        assert.ok(
          !overlaps(placed[i], placed[j]),
          `${name}: ${METER_KINDS[i]} overlaps ${METER_KINDS[j]} (${JSON.stringify(placed[i])} vs ${JSON.stringify(placed[j])})`
        )
      }
    }
  }
})

test('the first kind docks to the bottom-right corner, and the stack walks upward from it', () => {
  const wa = WORK_AREAS['1080p']
  const [first, second] = [defaultOverlayBounds(METER_KINDS[0], wa), defaultOverlayBounds(METER_KINDS[1], wa)]
  assert.equal(first.x + first.width, wa.x + wa.width - 16, 'right margin')
  assert.equal(first.y + first.height, wa.y + wa.height - 16, 'bottom margin')
  assert.equal(second.x, first.x, 'the second slot is in the same column')
  assert.ok(second.y < first.y, 'the stack grows upward')
})

test('a full column wraps LEFT rather than off the top of the screen', () => {
  // Deliberately short: only two uniform slots fit vertically, so the five kinds must spill into
  // additional columns. This is the case the old modulo wrap got wrong (it could overlap).
  const wa: Bounds = { x: 0, y: 0, width: 2000, height: 700 }
  const placed = METER_KINDS.map((k) => defaultOverlayBounds(k, wa))
  const columns = new Set(placed.map((b) => b.x))
  assert.ok(columns.size > 1, 'a short work area must use more than one column')
  for (const b of placed) {
    assert.ok(b.y >= wa.y && b.y + b.height <= wa.y + wa.height, 'still on-screen vertically')
  }
})

// ---- the celebration toast (docs/plans/celebration-toasts.md §3) -----------------------

test('the toast opens TOP-CENTRED on the work area, at its own width', () => {
  for (const [name, wa] of Object.entries(WORK_AREAS)) {
    const b = defaultOverlayBounds('toast', wa)
    // 560 since 2026-08-05 ("it needs to be a bit bigger/more prominent" — owner); the card's
    // type scaled with the lane, so the two numbers move together or not at all.
    assert.equal(b.width, 560, `${name}: the card lane's own width, not the meter size`)
    assert.equal(b.y, wa.y + 12, `${name}: 12px below the top of the work area`)
    // Centred: the gap to the left edge equals the gap to the right, within a rounding pixel.
    const left = b.x - wa.x
    const right = wa.x + wa.width - (b.x + b.width)
    assert.ok(Math.abs(left - right) <= 1, `${name}: not centred (${left} vs ${right})`)
  }
})

test('a display narrower than the strip still lands it on-screen', () => {
  const wa: Bounds = { x: 0, y: 0, width: 320, height: 240 }
  const b = defaultOverlayBounds('toast', wa)
  assert.equal(b.x, wa.x, 'clamped to the left edge rather than hanging off it')
  assert.ok(b.y >= wa.y, 'and never above the top of the work area')
})

/**
 * NO OVERLAY EVER OPENS OVER THE WHOLE SCREEN (JOS-83).
 *
 * A new user reported the celebration overlay as having "covered the entire screen" on their first
 * install. Nothing in this module has ever placed a window that could — the toast is a 560x360
 * strip and the meters are 380x320 — but the claim is cheap to make structurally impossible, and a
 * first-open window is the ONE geometry a user cannot have chosen for themselves. So every kind's
 * default bounds are pinned as a small fraction of any display it could land on.
 *
 * This says nothing about a window that PAINTS wrong (a driver that cannot composite a transparent
 * window shows the strip as a black rectangle — the JOS-40 report, and shared/graphicsPrefs.ts is
 * the answer to it). It pins the size, which is the half that lives here.
 */
test('a first-open overlay is a small window on any display — never a screen-filling one', () => {
  for (const [name, wa] of Object.entries(WORK_AREAS)) {
    for (const kind of OVERLAY_KINDS) {
      const b = defaultOverlayBounds(kind, wa)
      assert.ok(b.width < wa.width, `${name}/${kind}: as wide as the whole work area`)
      assert.ok(b.height < wa.height, `${name}/${kind}: as tall as the whole work area`)
      const share = (b.width * b.height) / (wa.width * wa.height)
      assert.ok(share < 0.25, `${name}/${kind}: covers ${(share * 100).toFixed(1)}% of the display`)
      assert.ok(b.x >= wa.x && b.y >= wa.y, `${name}/${kind}: starts off-screen`)
      assert.ok(
        b.x + b.width <= wa.x + wa.width && b.y + b.height <= wa.y + wa.height,
        `${name}/${kind}: runs past the work area`
      )
    }
  }
})

test('the toast holds NO slot in the meter stack — adding it moved nothing', () => {
  const wa = WORK_AREAS['1080p']
  assert.ok(OVERLAY_KINDS.includes('toast'), 'the toast is a registered overlay kind')
  assert.equal(METER_KINDS.includes('toast'), false, '…and is not one of the stacked meters')
  // The meters' slots are assigned by index within METER_KINDS, so the first five kinds must
  // still be exactly where they were before a sixth kind existed.
  const stack = METER_KINDS.map((k) => defaultOverlayBounds(k, wa))
  assert.deepEqual(stack[0], { width: 380, height: 320, x: 1524, y: 704 })
  assert.deepEqual(stack[1], { width: 380, height: 320, x: 1524, y: 374 })
  assert.deepEqual(stack[2], { width: 380, height: 320, x: 1524, y: 44 })
})

// ---- the two timer windows (JOS-119) ----------------------------------------------------

/**
 * TWO WINDOWS, PLACED SEPARATELY — the ticket, as geometry.
 *
 * The owner asked for buffs and debuffs to be windows he can move independently. The half of that
 * this file owns is the FIRST open: they must not arrive on top of one another, and neither may be
 * the screen-filling window JOS-83's report described. Everything after the first open is the
 * store's job — each kind persists its own bounds under `overlays.<kind>` — which
 * tests/e2e/buffs-overlay.e2e.mts drives against the real app.
 */
test('buffs and debuffs are two distinct stacked kinds with two distinct slots', () => {
  assert.ok(METER_KINDS.includes('buffs') && METER_KINDS.includes('debuffs'), 'both timer kinds stack')
  for (const [name, wa] of Object.entries(WORK_AREAS)) {
    const b = defaultOverlayBounds('buffs', wa)
    const d = defaultOverlayBounds('debuffs', wa)
    assert.ok(b.x !== d.x || b.y !== d.y, `${name}: the two timer windows open at the same spot`)
    assert.ok(!overlaps(b, d), `${name}: ${JSON.stringify(b)} overlaps ${JSON.stringify(d)}`)
    for (const [label, box] of [['buffs', b] as const, ['debuffs', d] as const]) {
      const share = (box.width * box.height) / (wa.width * wa.height)
      assert.ok(share < 0.25, `${name}/${label}: covers ${(share * 100).toFixed(1)}% of the display`)
    }
  }
})

// ---- the floor a window can be dragged down to (JOS-278) -----------------------------------

/**
 * THE MINIMUM SIZE IS A PINNED NUMBER, because it is a promise in two directions at once.
 *
 * Downward: a floor EXISTS, so no overlay can be dragged to a few pixels and lost behind the game
 * (the reason there has always been one). Upward: it is small enough to be worth having, for the
 * player who magnifies the whole screen with Lossless Scaling and gets this number back multiplied
 * (the 0.23.0 report this ticket came from). Neither half is what a bare `> 0` would catch.
 *
 * WHAT THIS FILE CANNOT SAY is whether the chrome still FITS at these numbers — that is a claim
 * about a real window laying out real controls, and it is measured next door in
 * tests/e2e/overlayMinSizeSteps.mts. Here the number is simply nailed down, so that a change to it
 * is a change somebody made on purpose and re-measured.
 */
test('the overlay floor is 140x90 — small enough to be worth having, large enough to find', () => {
  assert.deepEqual(OVERLAY_MIN_SIZE, { width: 140, height: 90 })
})

test('…and it is a FLOOR: strictly below the size every kind opens at, on every display', () => {
  for (const [name, wa] of Object.entries(WORK_AREAS)) {
    for (const kind of OVERLAY_KINDS) {
      const open = overlayDefaultSize(kind, wa)
      assert.ok(
        open.width > OVERLAY_MIN_SIZE.width && open.height > OVERLAY_MIN_SIZE.height,
        `${name}/${kind}: opens at ${open.width}x${open.height}, which is not above the floor`
      )
    }
  }
})

// ---- JOS-406: A STRIP'S WINDOW IS ITS CARD -----------------------------------------------
//
// The store keeps a LAYOUT BOX (CSS px at 100% text); the screen gets that box times the kind's
// effective text scale. These pin the arithmetic — centre-preserving, work-area clamped, and the
// exact inverse on the way back into the store — because it is the half of the feature that can be
// stated without a window. What only a real window can say (that the con card at 200% really is
// twice as wide, with the same three columns of chips) is asserted in tests/e2e/con-card.e2e.mts.

/** The work area the strip tests place against: an ordinary 1080p desktop with a taskbar. */
const STRIP_WA: Bounds = WORK_AREAS['1080p']

/** A layout box shaped like the con card's own first open: top-centred, 12px down. */
const centredLayout = (width: number, height: number): Bounds => ({
  width,
  height,
  x: STRIP_WA.x + Math.round((STRIP_WA.width - width) / 2),
  y: STRIP_WA.y + 12
})

test('a text scale of 1 is the identity — every strip is exactly its layout box', () => {
  for (const kind of STRIP_KINDS) {
    const layout = defaultOverlayBounds(kind, STRIP_WA)
    assert.deepEqual(scaledStripBounds(kind, layout, 1, STRIP_WA), layout, `${kind} moved at 1.0`)
  }
})

test('200% doubles a strip and keeps its MIDDLE where it was — the top edge holds', () => {
  const layout = centredLayout(530, 220)
  const b = scaledStripBounds('conCard', layout, 2, STRIP_WA)
  assert.equal(b.width, 1060, 'twice as wide')
  assert.equal(b.y, layout.y, 'the top edge never moves')
  const midLayout = layout.x + layout.width / 2
  const midWindow = b.x + b.width / 2
  assert.ok(Math.abs(midLayout - midWindow) <= 1, `grew off-centre (${midLayout} vs ${midWindow})`)
})

test('…and the con card is the one whose HEIGHT is not the scale’s to touch', () => {
  const layout = centredLayout(530, 220)
  assert.equal(
    scaledStripBounds('conCard', layout, 2, STRIP_WA).height,
    220,
    'the card measures its own height (JOS-386); scaling the placeholder would be a second opinion'
  )
  // The toast and the banner have no such measurement, so both of their axes scale.
  const toast = scaledStripBounds('toast', centredLayout(560, 360), 1.5, STRIP_WA)
  assert.equal(toast.width, 840)
  assert.equal(toast.height, 540)
})

test('a strip scaled wider than the screen becomes the screen, on-screen', () => {
  // A banner somebody has already dragged out to 1200 wide, then doubled: 2400 on a 1920 desktop.
  const layout = centredLayout(1200, 260)
  const b = scaledStripBounds('alertBanner', layout, 2, STRIP_WA)
  assert.equal(b.width, STRIP_WA.width, 'the work area is the real ceiling, not the old 720 cap')
  assert.equal(b.x, STRIP_WA.x, 'and it starts at the work area’s left edge')
})

test('…and a strip parked at an edge is pushed IN rather than allowed to grow off it', () => {
  // A banner the user dragged hard against the right edge, low down, then doubled.
  const layout: Bounds = { width: 400, height: 200, x: STRIP_WA.x + STRIP_WA.width - 400, y: 800 }
  const b = scaledStripBounds('alertBanner', layout, 2, STRIP_WA)
  assert.equal(b.x + b.width, STRIP_WA.x + STRIP_WA.width, 'right edge held to the work area')
  assert.ok(b.x >= STRIP_WA.x, 'and the left edge never left it')
  // The top edge is 800 and the work area ends at 1040, so a 400px-tall banner cannot fit under
  // it: the HEIGHT gives, exactly as `fittedOverlayHeight` makes it — the window never slides up.
  assert.equal(b.y, 800, 'the top edge still did not move')
  assert.equal(b.y + b.height, STRIP_WA.y + STRIP_WA.height, 'the bottom stopped at the work area')
})

test('an offset display places a strip on ITSELF, never back at the origin', () => {
  const wa = WORK_AREAS['offset display']
  const layout = defaultOverlayBounds('toast', wa)
  const b = scaledStripBounds('toast', layout, 1.5, wa)
  assert.ok(b.x >= wa.x && b.x + b.width <= wa.x + wa.width, `${b.x}+${b.width} left the display`)
  assert.ok(b.y >= wa.y, 'above the top of the work area')
})

test('a resize at 150% is remembered as the box it would be at 100%', () => {
  // The user drags the banner's right edge: the window is 900 wide, at 1.5.
  const chrome: Bounds = { width: 900, height: 300, x: 500, y: 340 }
  const layout = stripLayoutBounds('alertBanner', chrome, 1.5)
  assert.equal(layout.width, 600, 'chrome / 1.5')
  assert.equal(layout.height, 200, 'both axes for a banner')
  assert.equal(layout.y, chrome.y, 'position stays chrome pixels')
})

test('…and re-applying that scale gives back the very window the user let go of', () => {
  // The round trip is what makes the two functions one rule rather than two guesses — and it is
  // why BOTH are centre-preserving: record the left edge instead and a resize walks the window.
  for (const scale of [0.8, 1, 1.3, 1.5, 2]) {
    for (const kind of STRIP_KINDS) {
      const chrome: Bounds = { width: 640, height: 240, x: 600, y: 200 }
      const layout = stripLayoutBounds(kind, chrome, scale)
      const back = scaledStripBounds(kind, layout, scale, STRIP_WA)
      assert.ok(Math.abs(back.width - chrome.width) <= 1, `${kind}@${scale}: width ${back.width}`)
      assert.ok(Math.abs(back.x - chrome.x) <= 1, `${kind}@${scale}: x ${back.x}`)
      assert.equal(back.y, chrome.y, `${kind}@${scale}: y moved`)
    }
  }
})

test('a con card resize keeps its height out of the arithmetic entirely', () => {
  const chrome: Bounds = { width: 795, height: 411, x: 100, y: 12 }
  assert.equal(
    stripLayoutBounds('conCard', chrome, 1.5).height,
    411,
    'the height is the card’s; `storedOverlayBounds` replaces it with the placeholder anyway'
  )
})

/**
 * THE DEFAULT CON CARD WIDTH IS DERIVED FROM THE CHIP, not chosen (JOS-406).
 *
 * `CHIP_MIN_PX` (overlay/ConCard.tsx) is the measured minimum a resist chip column may be — 160,
 * being the widest phrase a chip prints (`may not land even with overchannel`, 145.23px in the
 * overlay's own type) plus 14px of padding and border. Three of those columns is the row this card
 * is supposed to draw, and the width is what holds three.
 *
 * The renderer's constant is SPELLED OUT here rather than imported, for the reason the e2e specs
 * spell out `PAD`: this is a node test over a main-process module, and reaching into a .tsx for one
 * number would drag React into it. A change to either number that forgets the other fails here.
 */
test('the con card opens wide enough for THREE chip columns at the measured chip minimum', () => {
  const CHIP_MIN_PX = 160
  const GRID_GAP = 4
  const ROOT_PAD = 6 // ConCardOverlay's own inset, each side
  const CARD_PAD = 10 // ConCard's padding, each side
  const CARD_BORDER = 1 // …and its border
  const grid = overlayDefaultSize('conCard').width - 2 * (ROOT_PAD + CARD_PAD + CARD_BORDER)
  const columns = Math.floor((grid + GRID_GAP) / (CHIP_MIN_PX + GRID_GAP))
  assert.ok(columns >= 3, `only ${columns} chip column(s) fit in ${grid}px of card`)
  // …and not FOUR, which would be a card wider than the row it is supposed to draw.
  assert.equal(columns, 3, `${columns} columns — the card is wider than the chips it holds`)
})
