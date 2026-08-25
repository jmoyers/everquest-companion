// useOverlayChrome — the window plumbing every overlay KIND shares, in one place.
//
// All five overlays (damage fight/overall, healing fight/overall, event log) are the same
// window with a different body: a persisted config (position, background alpha, TEXT SIZE, lock
// AND the drill-down), a lock toggle that flips click-through, and the hover dance that briefly
// re-captures the mouse over a LOCKED overlay so its own controls stay reachable. This hook is
// that plumbing; each overlay file keeps only its header, selector and body.
//
// It REMEMBERS the text size and applies none of it: the scale goes on the content pane and not
// on the chrome, so the placement belongs to the surface (overlayScale.tsx).
//
// CONFIG IS THE STATE. `patch` writes locally first (so the UI moves this frame) and then
// through to main, which echoes it back over onConfig — there is no second copy to drift, and
// a drill survives a restart exactly like window position does.
//
// MUI-FREE ON PURPOSE: the overlay is its own renderer entry (overlay.html) with no theme and
// no component library. Do not import @mui/* into this bundle.

import { useEffect, useRef, useState } from 'react'
import type { OverlayConfig, OverlayDrill } from '@shared/types'
import { clampTextScale } from '@shared/types'
import {
  DEFAULT_OVERLAY_TEXT_SIZE,
  effectiveOverlayTextScale,
  type OverlayTextSizePrefs
} from '@shared/overlayTextScale'
import {
  DEFAULT_OVERLAY_BG_ALPHA,
  clampBgAlpha,
  effectiveOverlayBgAlpha,
  type OverlayBgAlphaPrefs
} from '@shared/overlayBgAlpha'
import { onOverlayPointerExit, overlayPointerExited } from './pointerExit'

/**
 * WHY A LOCKED OVERLAY EVER CAPTURES THE MOUSE, and why the reason has a NAME.
 *
 * Locked means `setIgnoreMouseEvents(true)`: clicks go to the game. When something under the
 * cursor genuinely needs a click, the renderer asks main to stop ignoring; when it stops needing
 * one, it asks again.
 *
 * WHERE THE FIRST OF THOSE ASKS COMES FROM CHANGED IN JOS-370, and it is the whole point of that
 * ticket. A pinned window used to receive mouse MOVES, because main asked Windows to forward them
 * — `setIgnoreMouseEvents(true, {forward:true})` — and that forwarding is a system-wide WH_MOUSE_LL
 * hook owned by our MAIN process. Every mouse event on the machine then waited on main's message
 * loop, so a 30 ms stall of ours was a 30 ms freeze of the user's cursor and of in-game mouselook,
 * and past `LowLevelHooksTimeout` Windows silently dropped the hook and the pin quietly stopped
 * revealing. Nothing of ours is in that path now: the presence WORKER reads the cursor on its own
 * thread, hit-tests it against the rectangles this window still wants (main/overlayHotZone.ts) and
 * main pushes the edges over `overlay:hover`. Once capture is taken the page receives real mouse
 * events again, so every sensor below this line works exactly as it always did.
 *
 * The reasons are NAMED because more than one can be true at once and they end at different
 * moments. The selector popup is the case that forced it (P3): the popup is `position: fixed`
 * and therefore NOT inside the header row, so moving the pointer from the header down into the
 * open list fires the header's `mouseleave` — and a single boolean would drop capture out from
 * under the very list the user is reaching for. Two reasons, released independently, cannot.
 *
 *   'sensor'   — MAIN says the cursor is in one of this window's hot zones (JOS-370). It is the
 *                FIRST reason a pinned window can ever hold — nothing else here can fire while the
 *                window is ignoring the mouse — and it is deliberately the coarsest: main knows a
 *                rectangle, the four reasons below know the DOM. It is released the moment the
 *                cursor leaves that rectangle, and by then a finer reason is usually holding.
 *   'window'   — the pointer is anywhere over the overlay. The whole-window sensor the event log
 *                and the buff/debuff timers use: everything is capturable while hovered.
 *   'selector' — the pointer is over the SELECTOR ROW specifically (P3). The meters use this
 *                instead of 'window', so a locked meter's BODY stays genuinely click-through.
 *   'popup'    — the selector's list is open. Outlives 'selector' by construction (above).
 *   'scroll'   — the pointer is in the SCROLL GRIP: the narrow strip along the right edge of a
 *                content pane that has more rows than it can show (JOS-138, overlayScale.tsx).
 *                It is the reason a pinned overlay can be scrolled at all, and it is deliberately
 *                the narrowest of the five: a wheel notch is only delivered to a window that is
 *                not ignoring the mouse, so scrolling and click-through cannot both be true of the
 *                same pixel, and this is the smallest patch of pixels that buys the scroll.
 */
export type CaptureReason = 'sensor' | 'window' | 'selector' | 'popup' | 'scroll'

export interface OverlayChrome {
  /**
   * Has the persisted config actually arrived? Every field below has a sensible default, so
   * most surfaces never need this — but a window that DECIDES something from `locked` before
   * the answer lands (the celebration toast, which asks main to capture or pass through the
   * mouse) must not act on the default first and correct itself a frame later.
   */
  ready: boolean
  /**
   * The hydrated config itself, null until it arrives. Every field a surface routinely needs is
   * broken out below; this is the door for a knob that belongs to ONE kind and has no business
   * being a member of a hook five other overlays share — today, the toast blob (its duration, and
   * whether this install has been introduced to the celebration overlay yet, JOS-83).
   */
  config: OverlayConfig | null
  /** click-through + no chrome; the persisted lock state */
  locked: boolean
  /**
   * The background alpha the body is painted with, 0.1..1 — the EFFECTIVE one (JOS-407), which is
   * the shared preference unless the player has turned on independent transparency, and this
   * window's own stored value if they have.
   *
   * Every caller is unchanged by the switch existing, which is the point of resolving it here: a
   * surface asks "how see-through am I" and gets an answer, never a rule.
   */
  bgAlpha: number
  /**
   * Text size, 0.8..2 — the EFFECTIVE one (JOS-405), which is the shared preference unless the
   * player has turned on independent sizes, and this window's own stored value if they have.
   * Remembered here, APPLIED by the surface: it goes on the content pane (overlayScale.tsx) and
   * never on the chrome, and the stepper prints it and disables its ends against it.
   *
   * Every caller is unchanged by the switch existing, which is the point of resolving it here:
   * a surface asks "how big do I draw" and gets an answer, never a rule.
   */
  textScale: number
  /** Config IS the drill state — no local mirror to drift. */
  drill: OverlayDrill | null
  /** the mouse is currently captured over a locked overlay (its controls are showing) */
  hovering: boolean
  patch: (p: Partial<OverlayConfig>) => void
  setDrill: (d: OverlayDrill | null) => void
  toggleLock: () => void
  /**
   * Declare that ONE named reason does (or no longer does) need real mouse events over a LOCKED
   * overlay. Capture is on while any reason holds; a no-op while interactive, where the window
   * already owns the mouse. See CaptureReason for the three and why they are named.
   */
  capture: (reason: CaptureReason, active: boolean) => void
  /** `capture('window', …)` — the whole-window sensor, spelled as the two DOM handler names. */
  onEnter: () => void
  onLeave: () => void
  /** spread onto the header: the whole bar drags the window when interactive */
  dragRegion: React.CSSProperties
  /** spread onto anything clickable inside a drag region */
  noDrag: React.CSSProperties
}

export function useOverlayChrome(): OverlayChrome {
  const [cfg, setCfg] = useState<OverlayConfig | null>(null)
  /**
   * THE TEXT-SIZE PREFERENCE, which is not this window's config and does not gate `ready`.
   *
   * It starts at the shipped defaults rather than null on purpose, and that is not the JOS-340
   * defect: `ready` exists for decisions a window must not make twice (the toast asking main to
   * capture the mouse), and a SIZE is not one of them — it is a number the pane is drawn at, and
   * arriving a hop later re-draws the same rows a little bigger. Gating the whole window on it
   * would mean an overlay that paints nothing at all until a second IPC round trip lands.
   */
  const [textSize, setTextSize] = useState<OverlayTextSizePrefs>(DEFAULT_OVERLAY_TEXT_SIZE)
  /** …and the TRANSPARENCY preference (JOS-407), on exactly the terms above: not this window's
   *  config, not part of `ready`, and starting at the shipped default because a shade arriving a
   *  hop later re-paints the same rows a little fainter. */
  const [bgPrefs, setBgPrefs] = useState<OverlayBgAlphaPrefs>(DEFAULT_OVERLAY_BG_ALPHA)
  const [hovering, setHovering] = useState(false)
  /** What is asking for the mouse right now. Capture is on exactly while this is non-empty. */
  const reasonsRef = useRef<Set<CaptureReason>>(new Set())
  /** The state main is actually in, so a redundant IPC send can never happen. */
  const capturedRef = useRef(false)

  // Hydrate from the persisted config and stay subscribed to main's echo. The first snapshot
  // renders against whatever this resolves to.
  useEffect(() => {
    void window.eqOverlay.getConfig().then(setCfg)
    return window.eqOverlay.onConfig(setCfg)
  }, [])

  // The same hydrate-then-subscribe shape one preference over (JOS-405). The push is what a PINNED
  // window has instead of a stepper: locked means no chrome, so every change it obeys was made in
  // Preferences or on another window.
  useEffect(() => {
    void window.eqOverlay.getTextSize().then(setTextSize)
    return window.eqOverlay.onTextSize(setTextSize)
  }, [])

  // The same hydrate-then-subscribe for the transparency preference (JOS-407).
  useEffect(() => {
    void window.eqOverlay.getBgAlpha().then(setBgPrefs)
    return window.eqOverlay.onBgAlpha(setBgPrefs)
  }, [])

  const locked = cfg?.locked ?? false
  const drill = cfg?.drill ?? null
  // ONE FUNCTION DECIDES EACH OF THESE, and it is not this file (shared/overlayTextScale.ts,
  // shared/overlayBgAlpha.ts).
  const textScale = effectiveOverlayTextScale(textSize, cfg?.textScale)
  const bgAlpha = effectiveOverlayBgAlpha(bgPrefs, cfg?.bgAlpha)

  /**
   * THE LOCK CHANGING IS A RESET, HOWEVER IT CHANGED.
   *
   * `toggleLock` (the pin button) already forgets every reason, because main re-applies
   * click-through from scratch (`applyOverlayLocked`) without asking this side anything. But the
   * pin is not the only door: Preferences flips a lock, the celebration toast's does, and every
   * flip comes back as a config ECHO — and a reason held at that moment used to survive it. Then
   * `capturedRef` disagrees with the window, and the next genuine hover sends NOTHING because it
   * believes it is already captured: a pinned overlay that has quietly stopped listening.
   * MEASURED in the e2e (JOS-138): a locked meter arrived at the scroll step already showing its
   * hover chrome, from a `capture('selector', true)` two steps earlier that no unlock ever cleared.
   */
  useEffect(() => {
    reasonsRef.current.clear()
    capturedRef.current = !locked
    setHovering(false)
  }, [locked])

  const patch = (p: Partial<OverlayConfig>): void => {
    setCfg((c) => (c ? { ...c, ...p } : c))
    // A TEXT-SIZE PRESS MOVES THE PREFERENCE WHILE SYNCED, so it moves THIS FRAME (JOS-405).
    //
    // Main routes the write for real — this side does not decide where it lands — but the value
    // the window DRAWS at is `effectiveOverlayTextScale(textSize, …)`, and while the switch is off
    // that reads the preference and never the config line above. Without this, A+ would do nothing
    // visible until main's broadcast came back, which is the one thing a reading-distance control
    // must not feel like. Main's answer arrives moments later and overwrites it, as always.
    if (p.textScale !== undefined && !textSize.independent) {
      const shared = clampTextScale(p.textScale)
      setTextSize((t) => (t.independent ? t : { ...t, shared }))
    }
    // …and a `bg` DRAG the same way (JOS-407). It matters more here than it does one field over:
    // a slider the user is dragging must track the cursor, and a shade that only landed once main
    // answered would lag every pixel of the drag behind the pointer.
    if (p.bgAlpha !== undefined && !bgPrefs.independent) {
      const shared = clampBgAlpha(p.bgAlpha)
      setBgPrefs((b) => (b.independent ? b : { ...b, shared }))
    }
    void window.eqOverlay.setConfig(p)
  }

  // Drill/undrill writes straight through to the store — immediate, not debounced like bounds:
  // it's a rare, deliberate click. `patch` applies it locally first so the bars swap this frame.
  const setDrill = (d: OverlayDrill | null): void => patch({ drill: d })

  /** Push the union of the live reasons to main, once, and only when it actually changed. */
  const applyCapture = (): void => {
    const want = reasonsRef.current.size > 0
    if (capturedRef.current === want) return
    capturedRef.current = want
    setHovering(want)
    window.eqOverlay.setIgnoreMouse(!want)
    // THE THIRD LEAVE SIGNAL (JOS-358). The last named reason letting go is this window saying
    // nothing here needs the mouse any more — and it is the moment a PINNED overlay stops being
    // able to observe a leave for itself, because main is about to start ignoring mouse events
    // again. A native tooltip raised over the title bar would otherwise stay up over the game.
    if (!want) overlayPointerExited()
  }

  /**
   * THE LEAVE NOBODY IN THIS WINDOW COULD SEE (JOS-381).
   *
   * Main watches the cursor for the seconds a LOCKED overlay is capturing and says so when it is
   * outside the window (src/main/pointerWatch.ts carries the report and the performance contract).
   * That arrives here as leave signal 4, and the honest reading of it is that every named reason is
   * wrong AT ONCE: the pointer is not over the header, the selector row, the open popup or the
   * scroll grip, because it is not over the window. So they all go, and one `applyCapture` hands
   * the mouse back exactly the way an ordinary `mouseleave` would.
   *
   * THE EARLY RETURN IS THE RE-ENTRANCY GUARD'S OTHER HALF. Releasing the last reason is itself
   * leave signal 3 (`applyCapture` raises an exit), so this handler is called back into — with no
   * reason held there is nothing to release and it stops there. pointerExit.ts's own `firing` flag
   * makes the fan-out single regardless; both are cheap and neither alone is sufficient.
   *
   * The handler is reached through a REF so the subscription is made once per window instead of
   * being torn down and rebuilt on every render — `useCardTick`'s arrangement, for its interval.
   */
  const releaseAllReasons = (): void => {
    if (reasonsRef.current.size === 0) return
    reasonsRef.current.clear()
    applyCapture()
  }
  const releaseRef = useRef(releaseAllReasons)
  releaseRef.current = releaseAllReasons
  useEffect(() => onOverlayPointerExit(() => releaseRef.current()), [])

  const capture = (reason: CaptureReason, active: boolean): void => {
    // Interactive windows already own the mouse — a sensor firing there must not send anything,
    // or the first hover would "capture" a window that was never ignoring events.
    if (!locked) return
    if (active) reasonsRef.current.add(reason)
    else reasonsRef.current.delete(reason)
    applyCapture()
  }

  /**
   * MAIN'S HOT-ZONE SENSOR, as the fifth reason (JOS-370).
   *
   * It is reached through a REF for `onOverlayPointerExit`'s reason one block up: the subscription
   * is made once per window rather than torn down and rebuilt on every render, and `capture` closes
   * over `locked`, so the ref is also what keeps the guard inside it honest across a lock toggle.
   *
   * A LOCK FLIP NEEDS NO SPECIAL CASE HERE, which is worth stating because it is the seam JOS-138
   * lost a capture at. The effect above clears every reason when `locked` changes; main
   * simultaneously retracts (or publishes) this window's zones, and the worker's own remembered
   * answer for the key goes with them — so the very next sample re-announces an ENTER if the
   * cursor is still there. Both sides forget together, within one 32 ms tick.
   */
  const captureRef = useRef(capture)
  captureRef.current = capture
  useEffect(() => window.eqOverlay.onHover((inside) => captureRef.current('sensor', inside)), [])

  const toggleLock = (): void => {
    const next = !locked
    window.eqOverlay.setLocked(next)
    patch({ locked: next })
    // Main applies the new click-through state itself (applyOverlayLocked), so this side just
    // forgets every reason and records where that leaves us — otherwise a stale reason would
    // survive the mode change and the next `capture(x, false)` would send a spurious flip.
    reasonsRef.current.clear()
    capturedRef.current = !next
    setHovering(false)
    // PINNING IS A LEAVE TOO (JOS-358): the press that locks the window is made ON the control
    // whose tooltip is up, and the very next thing that happens is the window going
    // click-through — after which nothing can un-hover it.
    overlayPointerExited()
  }

  return {
    ready: cfg !== null,
    config: cfg,
    locked,
    bgAlpha,
    textScale,
    drill,
    hovering,
    patch,
    setDrill,
    toggleLock,
    capture,
    onEnter: () => capture('window', true),
    onLeave: () => capture('window', false),
    dragRegion: !locked ? ({ WebkitAppRegion: 'drag' } as React.CSSProperties) : {},
    noDrag: { WebkitAppRegion: 'no-drag' } as React.CSSProperties
  }
}
