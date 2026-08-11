// THE DRILL YOU LEFT STAYS DRILLED (JOS-116).
//
// THE BUG, which this repo has now fixed three times in three places (JOS-90, JOS-97, and here):
// `App.tsx`'s `ViewContent` mounts exactly ONE feature view at a time, so switching tabs UNMOUNTS
// the Combat tab. Every `useState` in it dies with it, and coming back reset the meter to the
// fully zoomed-out source list — the drill you were reading, and the ability whose crit rate you
// had opened, both gone because you glanced at the map.
//
// The floating overlay never had the bug, because its drill has always lived in its persisted
// config (`OverlayDrill`, useOverlayChrome.ts: "config IS the state… a drill survives a restart
// exactly like window position does"). This is that mechanism mirrored for the in-app surfaces,
// in the storage they already use for view prefs — so it survives a tab switch AND a restart,
// which is what the owner asked for ("across restart preferred").
//
// TWO THINGS ARE REMEMBERED, because JOS-113 made the drill two things: the drilled SUBJECT and
// which of its abilities have their stats expanded inline. The second used to be a `useState`
// inside each `SkillBar` — the same unmount-and-forget one level down — so it is remembered here
// beside the drill it belongs to and handed down through a context (abilityExpand.tsx).
//
// WHAT IS NOT HERE, deliberately:
//   * NO EFFECT KEYED ON THE SELECTION. The overlay's twin says why at length and it applies
//     verbatim: an effect fires on mount (twice under StrictMode) and would clear the value we
//     just hydrated. Worse here than there, because `selection` HYDRATES asynchronously — the
//     global fight id arrives from main a beat after mount (useGlobalFight), so an effect keyed on
//     it would fire again a frame later and wipe the drill every single time the tab opened.
//     Undrilling on a genuine change is the CALLER's job, on the handler that made the change.
//   * NO STALENESS CHECK. A drill naming a source that is not in the current fight resolves to
//     level 1 all by itself, in `petRows.meterPanel` — the JOS-105 degrade rule, already in the
//     tree and already tested. Persisting the token changes nothing about that: it degrades on
//     the render, and it comes BACK if the entity does (an id is not evidence of absence).

import { useCallback, useMemo } from 'react'
import { useRawPref } from './useCombatPrefs'
import {
  abilityKey,
  drillKey,
  parseDrillMemory,
  serializeDrillMemory,
  withAbility,
  withDrill,
  type DrillMemory
} from './combatPrefs'
import type { Drill } from './dashboardData'

export interface DrillMemoryApi {
  /** where this surface is drilled to, or null for level 1 */
  drill: Drill | null
  /** drill / un-drill. Changing the SUBJECT collapses whatever was expanded inside the old one. */
  setDrill: (d: Drill | null) => void
  /** is this ability's inline stat readout open? */
  isOpen: (category: string, name: string) => boolean
  /** open or close it */
  setOpen: (category: string, name: string, open: boolean) => void
}

/**
 * One surface's remembered drill. `surface` is the key suffix — 'combat' for the tab, 'overview'
 * for the glance card — and the two are separate on purpose: DpsCard has always promised that
 * nothing on it may move the Combat tab's drill, and one shared key would break that promise the
 * first time somebody clicked a bar on the Overview page.
 */
export function useDrillMemory(surface: string): DrillMemoryApi {
  const key = drillKey(surface)
  const [raw, setRaw] = useRawPref(key)
  // MEMOIZED ON THE RAW STRING, and it is load-bearing rather than a micro-optimisation: the
  // Combat tab re-renders on every snapshot tick (~4x/sec in a fight), and a freshly parsed object
  // each time would give `drill` a new identity every render — which would re-run the Esc-key
  // effect keyed on it, four times a second, forever.
  const memory: DrillMemory = useMemo(() => parseDrillMemory(raw), [raw])

  // `write` takes the CURRENT memory as its argument rather than closing over it, so the two
  // setters below depend only on `setRaw` and stay stable across renders.
  const write = useCallback(
    (next: DrillMemory, prev: DrillMemory) => {
      // Identity means nothing changed (combatPrefs returns the same object for a no-op), so a
      // click that lands where you already are writes nothing and re-renders nobody.
      if (next === prev) return
      setRaw(serializeDrillMemory(next))
    },
    [setRaw]
  )

  const setDrill = useCallback((d: Drill | null) => write(withDrill(memory, d), memory), [write, memory])
  const setOpen = useCallback(
    (category: string, name: string, open: boolean) =>
      write(withAbility(memory, abilityKey(category, name), open), memory),
    [write, memory]
  )
  const isOpen = useCallback(
    (category: string, name: string) => memory.abilities.includes(abilityKey(category, name)),
    [memory]
  )

  return { drill: memory.drill, setDrill, isOpen, setOpen }
}
