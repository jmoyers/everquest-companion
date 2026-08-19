// storeOverlayIndependent.ts — the two flags behind ONE switch, wired to the real stores (JOS-408).
//
// A THIN ADAPTER, ON PURPOSE. The rule, the direction of the reconcile and the argument for both
// live in `shared/overlayIndependent.ts`, which imports nothing and is therefore node-tested end to
// end (tests/overlayIndependent.test.mts). What is here is the one thing that file cannot have: the
// actual stores.
//
// THE SETTERS ARE THE FEATURES' OWN, never `settingsStore.set`. That is what makes turning the
// switch on change nothing on screen — each of them runs its seed-on-first-opt-in
// (storeOverlayTextSize.ts / storeOverlayBgAlpha.ts), which is the JOS-405 / JOS-407 promise this
// ticket must not break while collapsing two switches into one.

import { getOverlayTextSize, setOverlayTextSize } from './storeOverlayTextSize'
import { getOverlayBgAlpha, setOverlayBgAlpha } from './storeOverlayBgAlpha'
import {
  reconcileOverlayIndependent,
  setOverlayIndependent,
  type IndependentIo
} from '../shared/overlayIndependent'

/** The two stores, as the three operations the shared rule asks for. */
const IO: IndependentIo = {
  read: () => ({ text: getOverlayTextSize().independent, bg: getOverlayBgAlpha().independent }),
  setText: (independent) => {
    setOverlayTextSize({ independent })
  },
  setBg: (independent) => {
    setOverlayBgAlpha({ independent })
  }
}

/** Latched, because the reconcile is a MIGRATION and a migration that runs twice is a bug waiting
 *  for a store somebody hand-edited between reads. Every later call is free. */
let reconciled = false

/**
 * RECONCILE ON READ, ONCE (the ticket's own wording).
 *
 * Called at STARTUP, before any window exists — which is why nothing here broadcasts. The two
 * flags are made to agree before a single overlay or Preferences pane has read either of them, so
 * there is no window holding a value that just changed underneath it.
 *
 * Returns whether it wrote.
 */
export function reconcileOverlayIndependentOnce(): boolean {
  if (reconciled) return false
  reconciled = true
  return reconcileOverlayIndependent(IO)
}

/** The one Switch in Preferences, applied. Both flags move together; the caller broadcasts. */
export function applyOverlayIndependent(on: boolean): void {
  setOverlayIndependent(IO, on)
}

/** TEST SEAM ONLY: forget the latch, so an e2e-style harness can watch the cold path twice. */
export function resetOverlayIndependentLatchForTests(): void {
  reconciled = false
}
