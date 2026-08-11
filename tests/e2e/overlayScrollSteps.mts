// A PINNED OVERLAY STILL SCROLLS — and still passes clicks through (JOS-138).
//
// A 0.14.0 report: pin an overlay and its scrollbar stops working. That was true by construction.
// Pinned means `setIgnoreMouseEvents(true, {forward:true})`, and `forward` forwards mouse MOVES
// and nothing else — a wheel notch goes to whatever the OS hit test finds under the cursor, which
// for a click-through window is the game. So scrolling and click-through cannot both be true of
// the same pixel, and the owner's disposition (2026-08-09, "we should allow scroll") is bought by
// giving up the smallest patch of pixels that buys it: the SCROLL GRIP, a strip along the right
// edge of the pane where the scrollbar is already drawn (overlay/overlayScale.tsx).
//
// SO THIS STEP ASSERTS BOTH HALVES, and the second is the one that matters more:
//   1. the wheel moves the rows of a pinned meter, driven with the REAL pointer and a REAL wheel;
//   2. the rest of the pinned body takes no mouse at all — the pointer parked in the middle of the
//      same pane leaves the grip idle and reveals no chrome, which is the pin still being a pin.
//
// WHAT A HIDDEN WINDOW CAN AND CANNOT SAY. `EQ_E2E=1` shows no window, and no page can read its
// own `setIgnoreMouseEvents` state — so the window-level half is asserted through the two things
// that ARE observable from inside: the pane's own `data-scroll-grip` (what the renderer decided)
// and the header controls revealing (the round trip into main and back that only a taken capture
// produces — the same observable stepLockedSelector uses). Playwright's pointer and wheel are
// delivered by Chromium's input pipeline rather than by the OS, so they reach the page whether or
// not the window is composited; what they cannot prove is the OS hit test itself, and that is
// stated here rather than implied.
//
// Its own module because tests/e2e/overlay-sync.e2e.mts sits at the repo's max-lines budget:
// split, never ratchet (overlayScopeSteps.mts, drill.mts and combatPrefsSteps.mts precede it).

import type { ElectronApplication, Page } from 'playwright-core'
import { check, countOf, hoverAt, note, settle } from './appHarness.mjs'
import type { SetLocked } from './overlayScopeSteps.mjs'

/** A window rectangle, as Electron hands it over. */
interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The fight overlay's own window, found by its `?kind=fight` URL rather than its title (the
 * loaded page owns the title) — the same door `overlayBackground` uses in the owning spec.
 */
function fightBounds(app: ElectronApplication): Promise<Bounds | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().includes('kind=fight')
    )
    return w ? w.getBounds() : null
  })
}

async function setFightBounds(app: ElectronApplication, bounds: Bounds): Promise<void> {
  await app.evaluate(({ BrowserWindow }, b) => {
    const w = BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().includes('kind=fight')
    )
    if (w) w.setBounds(b)
  }, bounds)
}

/** The meter's bars pane — the same box the click-through contract is measured on. */
const PANE = '[data-testid="overlay-bars"]'

/** How the pane describes its own grip: absent while interactive, then 'idle' / 'held'. */
function gripState(overlay: Page): Promise<string> {
  return overlay.evaluate(
    (sel) => document.querySelector(sel)?.getAttribute('data-scroll-grip') ?? '(absent)',
    PANE
  )
}

/** How much the pane has to scroll, where it is scrolled to, and how wide it is. */
function paneScroll(overlay: Page): Promise<{ over: number; top: number; w: number }> {
  return overlay.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return { over: -1, top: -1, w: 0 }
    return {
      over: el.scrollHeight - el.clientHeight,
      top: el.scrollTop,
      w: el.getBoundingClientRect().width
    }
  }, PANE)
}

/**
 * The fractional x that lands the pointer INSIDE the grip, whatever this window has been resized
 * to: six pixels in from the pane's right edge.
 *
 * A fixed fraction would not do — `hoverAt` takes one, and 0.97 of a 380px pane is inside the
 * strip while 0.97 of an 800px pane is not. Six is spelled here rather than imported, like every
 * other constant this suite shares with the product (an e2e file loads no src module): it must
 * stay under `SCROLL_GRIP_W` in overlay/overlayScale.tsx, which is 22.
 */
async function gripFraction(overlay: Page): Promise<number> {
  const w = (await paneScroll(overlay)).w
  return w > 12 ? 1 - 6 / w : 0.99
}

/** The lock/close controls, which a locked overlay renders ONLY once it has taken the mouse. */
const controlCount = (overlay: Page): Promise<number> => countOf(overlay, 'button')

/** The A− / A+ value, set through the same door the footer's stepper uses. */
async function setTextScale(overlay: Page, textScale: number): Promise<void> {
  await overlay.evaluate((v) => {
    ;(
      window as unknown as { eqOverlay: { setConfig: (p: { textScale: number }) => void } }
    ).eqOverlay.setConfig({ textScale: v })
  }, textScale)
}

/** The overlay's smallest allowed height (windows.ts `minHeight` for every overlay kind). */
const MIN_OVERLAY_H = 90

/**
 * Make the rows outgrow the pane, using two things a user really does: shrink the window, and
 * turn the text up.
 *
 * NOT A HAND-MADE DOM. The fixture's fight has as many combatants as it has, and a meter sized
 * for them has nothing to scroll — so the pane is made SMALL rather than the list made long, at
 * the minimum height the product itself allows and the largest text size its stepper offers.
 * Returns the overflow it managed to produce; a run that cannot reach one is a `note`, and the
 * region half is asserted either way.
 */
async function makeItOverflow(app: ElectronApplication, overlay: Page, was: Bounds): Promise<number> {
  await setTextScale(overlay, 2)
  await setFightBounds(app, { ...was, height: MIN_OVERLAY_H })
  const read = await settle(() => paneScroll(overlay), (s) => s.over > 1, { timeoutMs: 8_000 })
  return read.over
}

/**
 * THE PIN IS STILL A PIN: the pointer in the MIDDLE of a pinned pane takes nothing.
 *
 * This is the assertion the carve-out has to survive. If parking the cursor over the meter body
 * captured the mouse, every click meant for the game would land on a transparent panel instead —
 * which is the bug pinning exists to prevent, reintroduced by the fix for scrolling.
 */
async function checkBodyStillPassesThrough(overlay: Page): Promise<void> {
  if (!check('the pane centre can be pointed at', await hoverAt(overlay, PANE, 0.5, 0.5))) return
  const grip = await gripState(overlay)
  check('the pointer in the MIDDLE of a pinned pane leaves the grip idle', grip === 'idle', grip)
  const controls = await controlCount(overlay)
  check(
    '…and no chrome reveals, so main was never asked to stop ignoring the mouse',
    controls === 0,
    `${controls} control(s)`
  )
}

/** THE GRIP: the pointer at the right edge takes the mouse, and the chrome reveal proves main heard. */
async function checkGripTakesTheMouse(overlay: Page): Promise<void> {
  const fx = await gripFraction(overlay)
  if (!check('the pane right edge can be pointed at', await hoverAt(overlay, PANE, fx, 0.5))) return
  const grip = await settle(() => gripState(overlay), (g) => g === 'held', { timeoutMs: 4_000 })
  check('the pointer at the pane RIGHT EDGE takes the scroll grip', grip === 'held', grip)
  const controls = await settle(() => controlCount(overlay), (n) => n > 0, { timeoutMs: 8_000 })
  check(
    '…and the capture really crossed into main — the locked overlay reveals its controls',
    controls > 0,
    `${controls} control(s)`
  )
}

/** …and the wheel, delivered there, actually moves the rows. */
async function checkWheelScrolls(overlay: Page): Promise<void> {
  const before = (await paneScroll(overlay)).top
  await overlay.mouse.wheel(0, 200)
  const after = await settle(async () => (await paneScroll(overlay)).top, (t) => t > before, {
    timeoutMs: 6_000
  })
  check('A WHEEL NOTCH OVER THE GRIP SCROLLS THE PINNED METER', after > before, `${before} → ${after}`)
  // …and back up, because a scroller that only ever goes one way is a scroller with a stuck row.
  await overlay.mouse.wheel(0, -400)
  const back = await settle(async () => (await paneScroll(overlay)).top, (t) => t < after, { timeoutMs: 6_000 })
  check('…and back up again', back < after, `${after} → ${back}`)
}

/**
 * The whole step. `setLocked` comes from the owning spec for the reason overlayScopeSteps states:
 * two definitions of "the lock has taken effect" is exactly the drift that makes one of them lie.
 */
export async function stepPinnedScroll(
  app: ElectronApplication,
  overlay: Page,
  setLocked: SetLocked
): Promise<void> {
  await setLocked(overlay, false)
  check(
    'an INTERACTIVE pane arms no grip — it already owns the mouse',
    (await gripState(overlay)) === '(absent)',
    await gripState(overlay)
  )

  await setLocked(overlay, true)
  check('a PINNED pane arms one', (await gripState(overlay)) === 'idle', await gripState(overlay))

  await checkBodyStillPassesThrough(overlay)

  const was = await fightBounds(app)
  if (!check('the overlay window can be measured', was !== null)) return
  const over = await makeItOverflow(app, overlay, was as Bounds)
  if (over > 1) {
    note(`the pinned pane has ${over.toFixed(0)}px more rows than room at ${MIN_OVERLAY_H}px tall, text size 2.0`)
    await checkGripTakesTheMouse(overlay)
    await checkWheelScrolls(overlay)
    // The grip is held for exactly as long as the pointer is in the strip: leaving releases it,
    // and the body is click-through again the moment it does.
    await hoverAt(overlay, PANE, 0.5, 0.5)
    const released = await settle(() => gripState(overlay), (g) => g === 'idle', { timeoutMs: 4_000 })
    check('leaving the strip releases the grip — the body is click-through again', released === 'idle', released)
  } else {
    note('the meter fits even at the minimum window height and text size 2.0 — nothing to scroll')
  }

  // Put the window and the text size back: every step after this one measures this same window.
  await setFightBounds(app, was as Bounds)
  await setTextScale(overlay, 1)
  await setLocked(overlay, false)
}
