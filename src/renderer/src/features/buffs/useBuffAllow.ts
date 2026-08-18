// useBuffAllow — THE RENDERER HALF of the buff/debuff tracking allow-list (JOS-168).
//
// ONE HOOK, BOTH BUNDLES, exactly as `useScopeSelection` is for the app-wide scope pair. The Buffs
// tab's mode switch, the checkbox on every active card, the checkbox on every stats row and the two
// timer overlays' filter are five chromes over ONE preference, and they live in two different
// renderer processes. They all call this, because both preload bridges expose the same members
// under the same names (`getBuffAllow` / `onBuffAllow`, plus `setBuffAllow` on the app bridge — see
// preload/buffAllow.ts and preload/overlay.ts). The bridge is a PARAMETER rather than a `window.*`
// read so this file stays honest in both entries.
//
// WHY A MODULE-SCOPE STORE AND NOT JUST `useState`, which is `useScopeSelection`'s argument
// verbatim: the Buffs tab reads this preference from the mode switch, from every active card and
// from every stats row at once. Per-component copies would let an optimistic write move the box
// you pressed one frame before it moved the other surfaces. So there is ONE value per WINDOW,
// published through `useSyncExternalStore` over a VERSION counter (a getSnapshot returning a fresh
// object would re-render forever), and every consumer moves in the same commit.
//
// THE STORE IS A CACHE, NOT AN AUTHORITY. Main owns the value and persists it; this holds the last
// one it heard and writes through. A local write applies optimistically so a checkbox never waits
// on a round trip, and main's echo of the same value is a no-op here by `sameBuffAllowPrefs` — so
// a press costs exactly one render in the window that made it and one in every other.
//
// MUI-FREE (the overlay bundle imports it) and value-imports `shared/*` RELATIVELY — the overlay
// entry and node resolve no `@shared` alias for values (the repo-wide mobSearch precedent).

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import {
  DEFAULT_BUFF_ALLOW_PREFS,
  applyBuffAllowPatch,
  buffAllowCheck,
  normalizeBuffAllowPrefs,
  sameBuffAllowPrefs,
  type BuffAllowPatch,
  type BuffAllowPrefs
} from '../../../../shared/buffAllow'

/**
 * What this hook needs from a preload bridge. The app bridge satisfies all three; the overlay one
 * satisfies the two readers and has no setter, which is why `setBuffAllow` is optional — a window
 * over the game draws the filter and never edits it.
 */
export interface BuffAllowBridge {
  getBuffAllow: () => Promise<BuffAllowPrefs>
  onBuffAllow: (cb: (p: BuffAllowPrefs) => void) => () => void
  setBuffAllow?: (patch: BuffAllowPatch) => Promise<BuffAllowPrefs>
}

/** The window's one copy. Starts on the shipped answer, so the first frame — before the hydrate
 *  lands — already draws everything rather than flickering through an empty allow-list. */
let prefs: BuffAllowPrefs = DEFAULT_BUFF_ALLOW_PREFS
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

/** Take a value from somewhere else (the hydrate, or main's broadcast) — rebuilt, never trusted,
 *  and silent when it changes nothing. The equality check is what makes main's echo of this
 *  window's own optimistic write cost zero renders. */
function adopt(raw: unknown): void {
  const next = normalizeBuffAllowPrefs(raw)
  if (sameBuffAllowPrefs(next, prefs)) return
  prefs = next
  emit()
}

/** THE WIRE, AT MOST ONCE PER BRIDGE. Every consumer calls the hook, so the effect below runs many
 *  times; the subscription must not. Keyed on the bridge object because an HMR reload hands over a
 *  new one and the old listener is then attached to a dead preload. */
let wiredTo: BuffAllowBridge | null = null
let unwire: (() => void) | null = null

function wire(bridge: BuffAllowBridge): void {
  if (wiredTo === bridge) return
  unwire?.()
  wiredTo = bridge
  // HYDRATE THEN SUBSCRIBE: an overlay window opened after the last change must not sit on the
  // shipped default while the tab shows something else. A rejection is not an error state — it is a
  // window whose preload is not there yet, and drawing everything is the honest thing meanwhile.
  void bridge.getBuffAllow().then(adopt, () => undefined)
  unwire = bridge.onBuffAllow(adopt)
}

/** Back to the shipped default, and forget the wire. Exported for tests, like `resetScopeSelection`. */
export function resetBuffAllow(): void {
  unwire?.()
  unwire = null
  wiredTo = null
  prefs = DEFAULT_BUFF_ALLOW_PREFS
  emit()
}

export interface BuffAllowState {
  /** The whole preference, one stable object per value — safe as a `useMemo` dependency. */
  prefs: BuffAllowPrefs
  /** Flip the mode. Every explicit verdict survives it (shared/buffAllow.ts, fact 3). */
  setOptIn: (optIn: boolean) => void
  /** Check or uncheck one spell line. Always writes an EXPLICIT verdict, in either mode. */
  setLine: (key: string, checked: boolean) => void
}

/**
 * The allow-list in force in THIS window, and the two writers every control calls.
 *
 * `bridge` is optional because an HMR reload can render a frame before the preload has re-run. With
 * no bridge the hook is a local-only store on the shipped default — the surface renders the right
 * boxes and a press still moves this window, which is the honest degradation `useScopeSelection`
 * takes.
 */
export function useBuffAllow(bridge: BuffAllowBridge | undefined): BuffAllowState {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  useEffect(() => {
    if (bridge) wire(bridge)
  }, [bridge])

  // OPTIMISTIC, THEN AUTHORITATIVE: the local store moves this frame so the checkbox never lags its
  // own click, and main echoes the stored value back to every window including this one — where
  // `adopt`'s equality check makes it free.
  const patch = useCallback(
    (p: BuffAllowPatch): void => {
      adopt(applyBuffAllowPatch(prefs, p))
      void bridge?.setBuffAllow?.(p)
    },
    [bridge]
  )
  const setOptIn = useCallback((optIn: boolean) => { patch({ optIn }) }, [patch])
  const setLine = useCallback(
    (key: string, checked: boolean) => { patch(buffAllowCheck(key, checked)) },
    [patch]
  )

  return { prefs, setOptIn, setLine }
}
