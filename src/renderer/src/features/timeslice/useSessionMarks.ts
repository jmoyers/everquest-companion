// useSessionMarks — THE RENDERER HALF of the app-wide session marks (JOS-436's model, JOS-322's
// seam).
//
// ONE HOOK, BOTH BUNDLES, and it is `useScopeSelection` next door applied to the third cross-window
// fact — deliberately down to the shape: hydrate then subscribe, write through, degrade to an empty
// list with no bridge at all. Both preloads expose the SAME three members under the SAME names
// (`getSessionMarks` / `addSessionMark` / `onSessionMarks`), so the Loot ledger's slice bar and the
// zone meter overlay's title-bar button are two chromes over one fact. The bridge is a PARAMETER
// rather than a `window.*` read so this file stays honest in both entries.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT MOVED, AND WHY IT HAD TO (JOS-322).
//
// The marks used to be a module variable inside `useTimeslice`. That was fine while the only
// consumer was the ledger in one window, and it was wrong for two reasons the moment the owner
// ruled that one click splits everything:
//
//   1. THE LATENT SECOND COPY. A module variable is per RENDERER PROCESS, so an overlay window
//      would have kept its own list — the exact defect JOS-332 had already had to fix once for the
//      scope selection, waiting to happen again.
//   2. THE COMBAT ENGINE IS IN MAIN. A renderer cannot split the meter's records at all, and a
//      renderer that stamped its own clock and told main afterwards would give the loot split and
//      the engine split two boundaries a round trip apart.
//
// So MAIN stamps the instant, once, and this is a CACHE of what it says — never an authority. The
// press is the one call here that is not optimistic: there is no local instant to apply, because
// the whole point is that the instant is main's.
//
// MUI-FREE (the overlay bundle imports it) and value-imports `shared/*` RELATIVELY — the overlay
// entry and node both resolve no `@shared` alias for values (the repo-wide mobSearch precedent).

import { useCallback, useEffect, useSyncExternalStore } from 'react'

/**
 * The three bridge members this needs. Both preloads satisfy it structurally, so neither bundle has
 * to adapt anything — `useSessionMarks(window.eq)` and `useSessionMarks(window.eqOverlay)` are the
 * two call sites.
 */
export interface SessionMarksBridge {
  getSessionMarks: () => Promise<number[]>
  addSessionMark: () => Promise<number[]>
  onSessionMarks: (cb: (m: number[]) => void) => () => void
}

/** The window's one copy, ascending. Empty is the honest opening: nobody has pressed the button. */
let marks: readonly number[] = []
let version = 0
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function getVersion(): number {
  return version
}

function emit(): void {
  version++
  for (const cb of [...listeners]) cb()
}

/** Two lists of instants, compared element-wise. What makes main's echo of a press this window made
 *  cost zero renders — and what keeps a hydrate that changed nothing from re-rendering the ledger. */
function same(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/**
 * Take a list from somewhere else (the hydrate, the broadcast, or a press's own answer) — rebuilt
 * from what arrived and never trusted as an object, silent when it changes nothing.
 *
 * The filter is deliberately narrow rather than a full re-derivation: main owns the list and has
 * already run `addSessionMark` over it, so this only refuses shapes that could not have come from
 * there at all (an IPC payload is still IPC input).
 */
function adopt(raw: unknown): void {
  if (!Array.isArray(raw)) return
  const next = raw.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
  if (same(next, marks)) return
  marks = next
  emit()
}

/** THE WIRE, AT MOST ONCE PER BRIDGE. Every consumer calls the hook, so the effect below runs many
 *  times; the subscription must not. Keyed on the bridge object because an HMR reload hands over a
 *  new one and the old listener is then attached to a dead preload. */
let wiredTo: SessionMarksBridge | null = null
let unwire: (() => void) | null = null

function wire(bridge: SessionMarksBridge): void {
  if (wiredTo === bridge) return
  unwire?.()
  wiredTo = bridge
  // HYDRATE THEN SUBSCRIBE: a window that opened after the last press (a freshly spawned overlay)
  // must not sit on an empty list while the tab shows three sessions. A rejection is not an error
  // state — it is a window whose preload is not there yet, and empty is honest meanwhile.
  void bridge.getSessionMarks().then(adopt, () => undefined)
  unwire = bridge.onSessionMarks(adopt)
}

/** Back to no marks, and forget the wire. Exported for tests and for a character rebuild, exactly
 *  like `resetScopeSelection`. LOCAL ONLY: this clears the window's cache, not main's list — a test
 *  putting its own store back must not be able to reach across and split somebody's meter. */
export function resetSessionMarks(): void {
  unwire?.()
  unwire = null
  wiredTo = null
  marks = []
  emit()
}

export interface SessionMarksState {
  /** The instants "start a new session now" has been pressed at, ascending. */
  marks: readonly number[]
  /**
   * Press it. Resolves to the mark list AFTER the press, so the caller can select the segment it
   * just opened — the ledger does exactly that, and the overlay's button ignores the answer because
   * a floating meter has no picker to move.
   *
   * NOT OPTIMISTIC, unlike every other write in this family, and for a reason rather than an
   * omission: the value being written is an INSTANT, and the whole design is that main stamps it
   * once so both halves of the split share it. A local guess would be a different instant.
   */
  press: () => Promise<readonly number[]>
}

/**
 * The session marks in force in THIS app, and the one control that moves them.
 *
 * `bridge` is optional because an HMR reload can render a frame before the preload has re-run. With
 * no bridge the hook is a read-only empty list and the press resolves to it — the same honest
 * degradation `useScopeSelection` and `useGlobalFight` take.
 */
export function useSessionMarks(bridge: SessionMarksBridge | undefined): SessionMarksState {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  useEffect(() => {
    if (bridge) wire(bridge)
  }, [bridge])

  const press = useCallback(async (): Promise<readonly number[]> => {
    if (!bridge) return marks
    const next = await bridge.addSessionMark()
    // Main echoes the same list to every window including this one, where `adopt`'s equality check
    // makes it free. Adopting the answer here too is what keeps the pressing window from waiting a
    // round trip to redraw its own picker.
    adopt(next)
    return marks
  }, [bridge])

  return { marks, press }
}
