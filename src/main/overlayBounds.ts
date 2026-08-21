// ============================================================================
// overlayBounds — WHERE AN OVERLAY WINDOW IS, HOW TALL IT IS, AND WHICH OF THAT IS WRITTEN DOWN.
// ============================================================================
//
// One subject, two rulings, and they only make sense beside each other:
//
//   JOS-187 — the store keeps the rectangle THE USER CHOSE; the screen gets the one that FITS.
//   JOS-386 — …except a con card's HEIGHT, which is never anybody's choice at all: it follows
//             the card, every time, and is derived rather than remembered.
//
// It is its own module because windows.ts is AT the repo's 400-code-line ceiling and this is the
// part of it that was never about Electron's window factory — it is a policy about persistence,
// with three `setBounds`-shaped lines at the bottom. Same split, and the same argument, as
// OVERLAY_TITLE moving to overlayLayout.ts (JOS-194) and the snap moving to overlaySnapDrag.ts.
// windows.ts HANDS this file each window as it is created; nothing here reaches back for a
// registry, so the dependency runs one way and there is no cycle to reason about.
//
// ---- JOS-187: WHAT IS SHOWN vs WHAT IS STORED -------------------------------------------------
//
// THE STORE KEEPS THE RECTANGLE THE USER CHOSE. THE SCREEN GETS THE ONE THAT FITS. That is the
// whole policy, and it is what makes a docking round trip lossless: undock the widescreen and the
// overlay is DRAWN on the laptop panel while `overlays.<kind>.bounds` still says "x: 2600, on the
// right-hand monitor"; plug the monitor back in and the same fit puts it back where it was, on the
// display the user actually put it on. Persisting the corrected rectangle instead would silently
// destroy that layout the first time a cable came out — and it would do it on a laptop screen the
// user may only be on for the length of a train journey.
//
// The mechanism is one remembered rectangle. Every rectangle the APP applies to a window itself is
// recorded here first, and the move handler refuses to persist the one it recognises as its own —
// so the only writes that reach the store are the user's own moves and resizes. The marker is
// dropped the moment a window reports any OTHER rectangle, so a user who later drags a window back
// onto that exact spot still has it saved. Deliberately not a timer or a re-entrancy flag: Electron
// may emit 'moved'/'resized' synchronously from `setBounds` or a tick later, and a policy that
// depended on which would be a policy that worked on one platform.
//
// A PIXEL OF SLACK, because `setBounds` is not always an identity: on a scaled display the value
// makes a round trip through physical pixels and can come back one off. The cost is that a 1px
// nudge in the instant after a re-placement is not persisted — which is not a position anyone is
// expressing — and it is paid only until the window next moves anywhere else.
//
// ---- JOS-386: THE WINDOW FITS THE CARD --------------------------------------------------------
//
// The con card was a 520x300 window whatever it drew, and the card is a few lines of chips and
// drops, so most of that window was an EMPTY APRON: invisible while the overlay is transparent, a
// dark box under the card in the JOS-40 opaque mode, and in BOTH modes a rectangle that captures
// the mouse for as long as a card is on screen.
//
// THREE PARTS, THREE PROCESSES, AND NONE OF THEM DOES TWO JOBS:
//
//   renderer/overlay/overlayFit.ts + ConCardOverlay — MEASURES what was drawn. It has to be the
//     renderer: the card's height is a layout result at whatever text scale the user chose, and
//     `getBoundingClientRect` is the only thing that can read it (it already carries the `zoom`
//     ScaledContent applies, so the measurement is in the same pixels a window is).
//   overlayLayout.ts `fittedOverlayHeight` — the POLICY. Pure, node-tested: the request, clamped
//     up to the floor every kind shares and down to the room below the window's TOP EDGE, so a
//     card too tall for the space under it SHRINKS and never slides the window up the screen.
//   this file — the WINDOW. It owns no geometry rule of its own; it applies one.
//
// AND THE HEIGHT NEVER REACHES THE STORE, which is where the two rulings meet:
//
//   * the fit's own resize goes through `applyOverlayBounds`, so it is marked as OURS and the move
//     handler below refuses to write it down — the JOS-187 mechanism, unchanged;
//   * and `storedOverlayBounds` strips the height from the rectangle that IS written down, so a
//     user's MOVE persists with the kind's default height. Otherwise one tall card would become
//     the size of every empty window from then on. What persists for a fit kind is position and
//     WIDTH; the height is re-derived on every card.

import type { BrowserWindow, Rectangle } from 'electron'
import { fitsHeightToContent, fittedOverlayHeight, overlayDefaultSize } from './overlayLayout'
import { setOverlayConfig } from './store'
import { workAreaFor } from './windowPlacement'
import type { OverlayKind } from '../shared/types'

/** The live window per kind, as windows.ts creates them. Replaced on re-open, never read stale:
 *  every consumer below asks `isDestroyed()` first. */
const overlayWindows = new Map<OverlayKind, BrowserWindow>()

/** The rectangle the APP last applied to each kind — the JOS-187 marker (see the header). */
const appliedBounds = new Map<OverlayKind, Rectangle>()

/**
 * THE LAST HEIGHT EACH FIT KIND'S RENDERER ASKED FOR.
 *
 * Remembered, rather than applied once and forgotten, because two later events have to re-derive
 * from it: a drag onto a display with a different work area, and a drag of the window's own bottom
 * edge (which the OS allows — a fit kind stays `resizable` for its WIDTH, and Electron's flag is
 * both-axes-or-neither). Both land in the move handler below.
 *
 * Never cleared on close: a re-opened window has a fresh renderer that measures again within a
 * frame of its first card, so a stale entry can only ever produce the height that renderer is about
 * to ask for anyway — and until it does, it is the better of the two guesses.
 */
const requestedHeight = new Map<OverlayKind, number>()

/** The four fields a rectangle comparison walks. Exported for the cursor ring's exact-match twin. */
export const RECT_KEYS = ['x', 'y', 'width', 'height'] as const

/** Same rectangle, within the pixel of slack the header argues for. */
const sameSpot = (a: Rectangle, b: Rectangle): boolean =>
  RECT_KEYS.every((k) => Math.abs(a[k] - b[k]) <= 1)

/**
 * Take ownership of a freshly created overlay window: remember it, and persist the USER's moves and
 * resizes off it (never one of ours — the marker above).
 *
 * The two listeners are installed here rather than in windows.ts because everything they consult is
 * here. `refitOverlay` runs after the write on purpose: the move may have carried the window onto a
 * display with a different work area, or the user may have just dragged a bottom edge that is not
 * theirs to set, and both are answered by re-deriving from the last measurement.
 */
export function installOverlayBounds(kind: OverlayKind, w: BrowserWindow): void {
  overlayWindows.set(kind, w)
  const save = (): void => {
    if (w.isDestroyed()) return
    const b = w.getBounds()
    const applied = appliedBounds.get(kind)
    if (applied && sameSpot(applied, b)) return
    appliedBounds.delete(kind)
    setOverlayConfig(kind, { bounds: storedOverlayBounds(kind, b) })
    refitOverlay(kind)
  }
  w.on('moved', save)
  w.on('resized', save)
}

/**
 * "The app itself put this window here" — for the one placement that happens before the window
 * exists, at construction (windows.ts `overlayPlacement`). Everywhere else `applyOverlayBounds`
 * records it as a side effect of doing it.
 */
export function markAppliedBounds(kind: OverlayKind, b: Rectangle): void {
  appliedBounds.set(kind, b)
}

/** Move a kind's overlay onto `b` without that move being mistaken for the user's own (header). */
export function applyOverlayBounds(kind: OverlayKind, b: Rectangle): void {
  const w = overlayWindows.get(kind)
  if (!w || w.isDestroyed() || sameSpot(w.getBounds(), b)) return
  appliedBounds.set(kind, b)
  w.setBounds(b)
}

/**
 * "What I drew is this tall" — the renderer's request, clamped and applied to the live window.
 *
 * REFUSED FOR ANYTHING THAT IS NOT A POSITIVE FINITE NUMBER, because this arrives from a renderer
 * and is validated here rather than trusted (the posture every other renderer input on this
 * boundary takes). Zero or less is not a request for a tiny window, it is a bug or an empty
 * measurement — and an empty queue is explicitly none of this feature's business: what a con-card
 * window does when no card is showing is unchanged, so the renderer stays silent and the window
 * keeps whatever height it had.
 */
export function fitOverlayHeight(kind: OverlayKind, height: unknown): void {
  if (!fitsHeightToContent(kind)) return
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return
  requestedHeight.set(kind, height)
  refitOverlay(kind)
}

/**
 * Re-derive a fit kind's height from the last request and apply it.
 *
 * A no-op until a renderer has measured something, and a no-op when there is no display information
 * to clamp against (headless, or before Electron is ready) — "we cannot know, so change nothing",
 * which is the same answer `overlayFittedBounds` gives for the same reason.
 */
function refitOverlay(kind: OverlayKind): void {
  const w = overlayWindows.get(kind)
  const want = requestedHeight.get(kind)
  if (!w || w.isDestroyed() || want === undefined) return
  const b = w.getBounds()
  const workArea = workAreaFor(b)
  if (!workArea) return
  const height = fittedOverlayHeight(want, b.y, workArea)
  if (height !== b.height) applyOverlayBounds(kind, { ...b, height })
}

/**
 * The rectangle that goes in the STORE for a move the user made: everything exactly as it is,
 * except that a fit kind's height reverts to its first-open placeholder (see the header).
 */
function storedOverlayBounds(kind: OverlayKind, b: Rectangle): Rectangle {
  if (!fitsHeightToContent(kind)) return b
  return { ...b, height: overlayDefaultSize(kind).height }
}
