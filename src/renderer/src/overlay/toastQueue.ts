// toastQueue — the celebration toast's queue, as the TOAST's vocabulary over the shared reducer.
//
// THE RULES MOVED, THE NUMBERS STAYED (JOS-378). Every timing rule this file used to implement
// now lives in ./cardQueue.ts, generic over the payload, because the alert banner is the same
// machine with different words in it and a second copy of a timing reducer is two answers to
// "how long does a card stay". Read that file's header for the rules themselves — hover pins,
// the grace floor, the cap evicting the OLDEST, a repeat id refreshing rather than stacking.
//
// WHAT IS STILL THE TOAST'S OWN, and why this file did not simply disappear: the CAP (three
// celebrations), the FALLBACK hold (6 s, used when a payload names no duration of its own — main
// normally fills it from the toast config), and the fact that a toast's hold rides its PAYLOAD at
// all. The banner answers all three differently. So this is a façade: one action shape, one
// reducer name, byte-identical behaviour, and no caller or test of it changed a line.

import type { ToastPayload } from '@shared/toast'
import {
  CARD_ENTER_MS,
  CARD_EXIT_MS,
  CARD_GRACE_MS,
  cardReduce,
  type CardAction,
  type CardState
} from './cardQueue'

/** Most cards on screen at once; a fourth evicts the oldest. */
export const TOAST_CAP = 3
/** Enter animation (slide-down + fade) — the shared number, under the name ToastCard imports. */
export const TOAST_ENTER_MS = CARD_ENTER_MS
/** Exit animation. The card stays in state (fading) for exactly this long. */
export const TOAST_EXIT_MS = CARD_EXIT_MS
/** Floor the clock is restored to when the pointer leaves a pinned card. */
export const TOAST_GRACE_MS = CARD_GRACE_MS
/** Used when a payload names no duration of its own (main normally fills it from the config). */
export const TOAST_FALLBACK_MS = 6000

export type ToastCardState = CardState<ToastPayload>

export type ToastAction =
  | { type: 'show'; payload: ToastPayload }
  | { type: 'tick'; dtMs: number }
  | { type: 'hover'; id: string; over: boolean }
  | { type: 'dismiss'; id: string }

/** The toast's two answers — its hold comes off the payload, its cap is three — as one mapping. */
function asCardAction(action: ToastAction): CardAction<ToastPayload> {
  if (action.type !== 'show') return action
  return {
    type: 'show',
    payload: action.payload,
    holdMs: action.payload.durationMs ?? TOAST_FALLBACK_MS,
    cap: TOAST_CAP
  }
}

/** The celebration queue's whole behaviour. Pure, exactly as it always was. */
export function toastReduce(state: ToastCardState[], action: ToastAction): ToastCardState[] {
  return cardReduce(state, asCardAction(action))
}
