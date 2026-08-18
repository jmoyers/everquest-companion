// prefsHydration.tsx — A CONTROL NEVER PAINTS A VALUE IT DOES NOT KNOW (JOS-340).
//
// THE BUG THIS FILE EXISTS FOR. Every card in Preferences was written the same way, and the
// comment on each one said so proudly ("the VoiceSetting pattern exactly"):
//
//     const [prefs, setPrefs] = useState(DEFAULT_X)                   // paint a guess
//     useEffect(() => { void window.eq.getX().then(setPrefs) }, [])   // ...then correct it
//
// The store is MAIN-side (electron-store) and every method on the `window.eq` bridge is an
// `ipcRenderer.invoke` — a promise. So the first painted frame of a switch was always the
// COMPILED-IN DEFAULT, and the stored value arrived one microtask-plus-an-IPC-hop later. A user
// whose value differs from the default watches the control flip under them. The owner reported it
// as booleans that are ON rendering OFF and flickering ON; it runs BOTH ways, because two of the
// defaults are `true` (`hideWhenNotRunning`, the toast's `locked`) and a stored OFF flashed ON
// first. It was never only a first-open problem either: the section rail is a SWITCHER — one
// section is mounted at a time — so every rail click was a fresh mount and a fresh flash.
//
// WHY A GATE AND NOT A SYNCHRONOUS SNAPSHOT. The obvious alternative is to inject the store's
// values at window load so there is nothing to wait for. There is no such path today: the bridge
// is `invoke`-only end to end (no `sendSync`, no `additionalArguments`), so "seed from a sync
// read" is not a fix that can be written — it would first have to introduce a BLOCKING sync
// channel into the trust boundary, paid at load by every window's preload including the five
// overlays, and deadlocking outright if it ever ran before main registered the handler. And it
// would buy less than it looks: a value captured at window load is FROZEN at window load, right
// on the first mount and stale on every mount after the user changes something — which means a
// live cache anyway. ./prefsSnapshot.ts is that cache, without the blocking channel.
//
// SO: ONE GATE FOR THE WHOLE PANE, NEVER PER-CONTROL SKELETONS. `PrefsGate` reads everything the
// pane paints from main in ONE parallel batch and renders nothing at all until the batch lands.
// A spinner per card would be a worse version of the same lie — thirteen little "loading" states
// for the reader to interpret — and the batch is a handful of in-memory store reads, so what it
// actually costs is a frame. (TelemetrySetting HAD such a skeleton, a bare "Loading...", and this
// change deletes it.) The cards then read their starting value out of the snapshot SYNCHRONOUSLY,
// on the way to their first render (`usePrefsSeed`), and their `useEffect` hydration is deleted
// rather than kept "just in case": a second read is a second answer.
//
// AND THE CACHE IS WHAT MAKES IT INVISIBLE. The snapshot survives unmounting, so the gate is only
// ever cold ONCE per renderer. Every rail click and every trip back to this tab paints from a warm
// cache on the first frame with no wait at all.
//
// WHAT IS NOT IN HERE. The Combat section's two cards read localStorage
// (features/combat/useCombatPrefs.ts) — a synchronous store, so they never had this bug and they
// are the proof of what the fix is imitating. `TelemetryNotice` is mounted from App.tsx rather
// than from the pane and already refuses to paint what it does not know (`null` until main
// answers); it is left exactly as it is.

import { type JSX, type ReactNode, createContext, useContext, useEffect, useState } from 'react'
import { Typography } from '@mui/material'
import { loadPrefsSnapshot, peekPrefsSnapshot, type PrefsSnapshot } from './prefsSnapshot'

// The pure half is re-exported through here so a card imports ONE module and never has to know
// which side of the DOM-free line a symbol lives on.
export {
  peekPrefsSnapshot,
  recordPref,
  resetPrefsSnapshotForTests,
  type AlertBannerSeed,
  type ConCardSeed,
  type PrefsSnapshot,
  type ToastSeed
} from './prefsSnapshot'

/** "The gate above me is open." The VALUE comes from the cache, for the reason below. */
const GateContext = createContext(false)

/**
 * The starting value for one card, read synchronously on the way to its first render.
 *
 * IT READS THE CACHE, NOT A CONTEXT VALUE, AND THAT DISTINCTION IS THE WHOLE FIX WORKING (the e2e
 * caught it). `PrefsGate` mounts once and stays mounted for as long as the tab is open — the rail
 * is a switcher, so it is the CARDS that come and go underneath it. A snapshot captured into the
 * gate's own state would therefore be frozen at the moment the pane opened: flip a switch, click
 * to another section and back, and the card would seed from the value the pane loaded minutes ago
 * rather than from the one the user just set. Reading `peekPrefsSnapshot()` at each card's mount
 * is what makes the seed mean "what is stored right now".
 *
 * IT IS DELIBERATELY NOT REACTIVE. Nothing re-renders when the cache changes, and nothing should:
 * every card owns its own live state and takes this only as a starting point, so a subscription
 * here would buy no correctness and would re-render the entire pane every four seconds on the
 * telemetry panel's poll alone.
 *
 * It throws outside the gate ON PURPOSE. A card rendered without one has no guarantee a snapshot
 * exists and would silently go back to painting a default — the exact defect this file removes —
 * so the failure is loud, at development time, in the one place that can fix it.
 */
export function usePrefsSeed(): PrefsSnapshot {
  const open = useContext(GateContext)
  const snap = peekPrefsSnapshot()
  if (!open || snap === null) {
    throw new Error('a Preferences card was rendered outside <PrefsGate>, so it has no value to paint')
  }
  return snap
}

/**
 * THE GATE. Holds the pane until the snapshot is in hand, then hands it down.
 *
 * Cold, it renders NOTHING: not a spinner, not a skeleton. A settings pane that appears a frame
 * later is not a state worth naming, and naming it thirteen times over would be worse than the
 * flicker it replaces.
 *
 * A FAILED READ SAYS SO. If main cannot answer, the honest ending is not a blank pane forever, and
 * it is certainly not a pane full of defaults presented as the user's settings — it is one
 * sentence stating that the settings could not be read. That is an ending a person can act on, and
 * it keeps the law intact: nothing paints a value it does not know.
 */
export function PrefsGate({ children }: { children: ReactNode }): JSX.Element | null {
  // `hydrated` is a LATCH, not a copy of the data: the gate only needs to know whether a snapshot
  // exists, and the cards read the snapshot itself (see `usePrefsSeed`). Seeded from the cache so
  // a warm renderer opens the pane on its first frame with no state transition at all.
  const [hydrated, setHydrated] = useState(() => peekPrefsSnapshot() !== null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (hydrated) return
    let alive = true
    void loadPrefsSnapshot(window.eq).then(
      () => {
        if (alive) setHydrated(true)
      },
      (err: unknown) => {
        if (!alive) return
        setFailed(true)
        window.eq.reportError({
          source: 'renderer:prefsHydration',
          message: `Preferences could not read its settings from the app: ${String(err)}`
        })
      }
    )
    return () => {
      alive = false
    }
  }, [hydrated])

  if (!hydrated) {
    if (!failed) return null
    return (
      <Typography variant="body2" color="text.secondary" data-testid="prefs-unreadable">
        Your settings could not be read from the app. Restarting it usually fixes this; if it keeps
        happening, please send a report.
      </Typography>
    )
  }
  return <GateContext.Provider value>{children}</GateContext.Provider>
}
