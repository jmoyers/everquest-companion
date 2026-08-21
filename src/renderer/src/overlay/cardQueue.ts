// cardQueue — the QUEUE both STRIP overlays run on, as a pure reducer.
//
// It was the celebration toast's queue (./toastQueue.ts, docs/plans/celebration-toasts.md T8) and
// it is now the generic half of it, because JOS-378's alert banner is the same machine with
// different words in it: cards arrive, hold for their own time, pause under the pointer, leave on
// a 300 ms exit, and a burst past the cap evicts the OLDEST. Extracting was the alternative to a
// second copy — and a second copy of a timing reducer is two answers to "how long does a card
// stay", which is exactly the kind of drift the toast's own header warns about.
//
// WHAT MOVED AND WHAT DID NOT. The RULES moved here verbatim, generic over the payload; the
// toast's own vocabulary (its cap of 3, its 6 s fallback, `ToastAction`, `toastReduce`) stayed in
// ./toastQueue.ts as a thin façade, so no existing caller and no existing test changed a line.
// The banner passes its OWN cap and hold, which is the whole reason the generic exists: the toast
// stacks at most three celebrations, the banner shows as many lines as the user asked for.
//
// Every timing rule lives here as data arithmetic over an explicit `dtMs`, with no `setTimeout`,
// no `Date.now()` and no DOM: the component owns exactly one interval and dispatches `tick`. That
// is what makes "hover pins the card", "the clock resumes with a grace period" and "a burst of
// four leaves the oldest behind" testable in `npm test` instead of by watching the screen.
//
// THE RULES:
//   * A card holds for the `holdMs` its arrival named, then plays a 300 ms exit and is gone.
//   * Hovering a card PAUSES its clock — and only its clock. Two stacked cards run independent
//     timers, so pinning the top one does not freeze the one below it.
//   * Leaving a card resumes it with a ~1.5 s GRACE floor, so a card you were reading does not
//     vanish the instant your pointer crosses its edge.
//   * The queue is capped. A further arrival evicts the OLDEST (index 0), which is the one that
//     has been on screen longest — never the one that just arrived.
//   * Arrival order IS render order: index 0 draws first, newest last.
//   * A repeat `id` REFRESHES the card already on screen (it is the dedupe key) rather than
//     stacking a duplicate.
//
// A card that has begun EXITING cannot be caught by the pointer: it is fading and its hit box is
// going away, and "sometimes a hover re-opens it" is a worse contract than "the card left".

import { useEffect, useRef } from 'react'
import { onOverlayPointerExit } from './pointerExit'

/** Enter animation (slide + fade). The reducer does not time it — CSS does — but the components
 *  need the same number, and one definition is how they stay equal. */
export const CARD_ENTER_MS = 250
/** Exit animation. The card stays in state (fading) for exactly this long. */
export const CARD_EXIT_MS = 300
/** Floor the clock is restored to when the pointer leaves a pinned card. */
export const CARD_GRACE_MS = 1500

/** The least a payload must be for this queue to hold it: something to dedupe on. */
export interface QueuedPayload {
  id: string
}

export interface CardState<P extends QueuedPayload> {
  payload: P
  /** ms of hold time left before the exit starts. */
  remainingMs: number
  /** the pointer is over this card — its clock is paused */
  pinned: boolean
  /** ms into the exit animation, or null while the card is still holding */
  exitingMs: number | null
}

/**
 * The queue's actions. `show` carries its OWN hold and cap rather than reading them off the
 * payload: the two strips answer both questions differently (a celebration's duration rides its
 * payload; a banner line's comes from the overlay's config, and its cap is a user preference), and
 * a reducer that reached for a config would stop being pure.
 */
export type CardAction<P extends QueuedPayload> =
  | { type: 'show'; payload: P; holdMs: number; cap: number }
  | { type: 'tick'; dtMs: number }
  | { type: 'hover'; id: string; over: boolean }
  | { type: 'dismiss'; id: string }

function fresh<P extends QueuedPayload>(payload: P, holdMs: number): CardState<P> {
  return { payload, remainingMs: holdMs, pinned: false, exitingMs: null }
}

/** A new arrival: refresh a card with the same id, else append and evict past the cap. */
function show<P extends QueuedPayload>(
  state: CardState<P>[],
  payload: P,
  holdMs: number,
  cap: number
): CardState<P>[] {
  const at = state.findIndex((c) => c.payload.id === payload.id)
  if (at >= 0) {
    const next = state.slice()
    // Keep the pin: refreshing a card the user is actively reading must not yank it away.
    next[at] = { ...fresh(payload, holdMs), pinned: state[at].pinned }
    return next
  }
  const appended = [...state, fresh(payload, holdMs)]
  return appended.length > cap ? appended.slice(appended.length - cap) : appended
}

/** Advance one card's clocks by `dtMs`. Returns null when the card is finished and drops out. */
function tickCard<P extends QueuedPayload>(card: CardState<P>, dtMs: number): CardState<P> | null {
  if (card.exitingMs !== null) {
    const exitingMs = card.exitingMs + dtMs
    return exitingMs >= CARD_EXIT_MS ? null : { ...card, exitingMs }
  }
  if (card.pinned) return card
  const remainingMs = card.remainingMs - dtMs
  return remainingMs > 0 ? { ...card, remainingMs } : { ...card, remainingMs: 0, exitingMs: 0 }
}

/** Pointer in/out over one card: pause its clock, or resume it with the grace floor. */
function hover<P extends QueuedPayload>(state: CardState<P>[], id: string, over: boolean): CardState<P>[] {
  return state.map((c) => {
    if (c.payload.id !== id || c.exitingMs !== null) return c
    if (over) return { ...c, pinned: true }
    return { ...c, pinned: false, remainingMs: Math.max(c.remainingMs, CARD_GRACE_MS) }
  })
}

/** The queue's whole behaviour. Pure: same state + same action ⇒ same result, always. */
export function cardReduce<P extends QueuedPayload>(
  state: CardState<P>[],
  action: CardAction<P>
): CardState<P>[] {
  switch (action.type) {
    case 'show':
      return show(state, action.payload, action.holdMs, action.cap)
    case 'tick': {
      const next = state.map((c) => tickCard(c, action.dtMs)).filter((c): c is CardState<P> => c !== null)
      // Identity is preserved when nothing moved, so a paused, fully-pinned queue does not
      // re-render the window 10× a second over the game.
      return next.length === state.length && next.every((c, i) => c === state[i]) ? state : next
    }
    case 'hover':
      return hover(state, action.id, action.over)
    case 'dismiss': {
      const next = state.filter((c) => c.payload.id !== action.id)
      return next.length === state.length ? state : next
    }
  }
}

/**
 * How often a strip's clocks advance. 100 ms is imperceptible against a 4-6 s hold and costs
 * nothing: the reducer returns the SAME array when no card moved, so React re-renders only when
 * something actually changed.
 *
 * AND THE INTERVAL RUNS ONLY WHILE SOMETHING IS ON SCREEN (`useCardTick` below). An idle strip is
 * the overwhelmingly common state for both kinds, and a timer ticking ten times a second over a
 * running game for a window that is drawing nothing is pure cost.
 */
export const CARD_TICK_MS = 100

/**
 * Keep main's click-through state in step with the queue — the rule BOTH strips obey, and the one
 * main reads to decide whether an OPAQUE strip window is visible at all (windows.ts
 * `applyOpaqueStripVisibility`). It lives here so the two can never disagree.
 *
 * PASS-THROUGH IS THE SAFE ANSWER, so it is also the answer BEFORE the persisted config arrives:
 * a transparent window over the game that captured the mouse for even a few frames at startup
 * would eat a click aimed at the game, and the user would have no idea what did it. Once the
 * config is known: unlocked (being positioned) keeps the mouse unconditionally; locked captures it
 * only while a card is actually on screen.
 */
export function useQueueMouseCapture(ready: boolean, locked: boolean, hasCards: boolean): void {
  useEffect(() => {
    const ignore = !ready ? true : locked ? !hasCards : false
    window.eqOverlay.setIgnoreMouse(ignore)
  }, [ready, locked, hasCards])
}

/**
 * A PIN IS ALSO A CAPTURE, SO A LOST LEAVE STRANDS A STRIP TOO (JOS-381).
 *
 * The strips cannot reach the stuck state the ticket is about by its own route: their capture is
 * QUEUE-driven (`useQueueMouseCapture` above), never hover-driven, so there is no capture reason
 * here for a swallowed `mouseleave` to leave behind. But there is a second door to the same room.
 * A card under the pointer is PINNED — its clock stops — and the only thing that unpins it is the
 * DOM leave the Windows task switcher can eat exactly as it eats the meters'. A pin that never
 * ends is a card that never ages out, and while a card is on screen a locked strip is holding the
 * mouse: chrome-free, but not click-through, over the game, forever.
 *
 * So the strips ride the SAME signal rather than growing a rule of their own: an exit unpins every
 * card, the clocks resume (with the ordinary grace floor — leaving is leaving, however we heard
 * about it), the last card leaves on its own time and the queue hands the mouse back. Nothing here
 * dismisses a card early: the pointer having left is not the user having read it.
 *
 * The cards are read through a REF so the subscription is made once per window rather than rebuilt
 * whenever the queue moves — `useCardTick`'s arrangement, for the same reason.
 */
export function useUnpinOnPointerExit<P extends QueuedPayload>(
  cards: readonly CardState<P>[],
  dispatch: (a: { type: 'hover'; id: string; over: boolean }) => void
): void {
  const latest = useRef(cards)
  latest.current = cards
  useEffect(
    () =>
      onOverlayPointerExit(() => {
        for (const c of latest.current) {
          if (c.pinned) dispatch({ type: 'hover', id: c.payload.id, over: false })
        }
      }),
    [dispatch]
  )
}

/**
 * The one interval a strip owns, running only while it has something to time.
 *
 * `hasCards` in the dependency list is what makes an empty strip genuinely free: the effect tears
 * the timer down when the last card leaves and stands a fresh one up when the next arrives, so
 * the resting state of both windows is a React tree with no timers in it at all.
 */
export function useCardTick(hasCards: boolean, tick: () => void): void {
  // The callback is read through a REF rather than depended on: the caller re-creates its dispatch
  // wrapper every render, and an interval rebuilt every frame is the one thing this must not do.
  const latest = useRef(tick)
  latest.current = tick
  useEffect(() => {
    if (!hasCards) return
    const id = setInterval(() => latest.current(), CARD_TICK_MS)
    return () => clearInterval(id)
  }, [hasCards])
}
