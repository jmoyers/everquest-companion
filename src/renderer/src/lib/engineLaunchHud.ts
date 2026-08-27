// lib/engineLaunchHud.ts — the shell's half of the launch banner (JOS-503).
//
// `enginePerfHud.ts` next door is the same shape for a different question, and the two differences
// are worth stating because they are both deliberate:
//
//   * IT ARMS NOTHING. The perf hook turns a main-process poll on and off, because its numbers cost
//     a round trip to a child process and its panel is open for seconds. This one subscribes to a
//     channel main pushes on CHANGE and never polls at all — during a fold that is the engine's own
//     ~4 Hz cadence, and once the fold has landed it is silence.
//   * IT KEEPS A RING, and the perf hook explicitly does not. The reason is the same one that file
//     gives in the other direction: a ring is for a RATE. The engine reports a MARK (bytes folded),
//     which is cumulative — an estimate of when it will finish is exactly a rate, so the history is
//     the thing that makes it computable.
//
// EVERY ARRAY OPERATION IS IN `shared/engineLaunch.ts`, NOT HERE, and that is not only tidiness:
// the no-munging rule (`eslint.domainMunging.mjs`) reads element TYPES declared under `src/shared/`
// wherever a renderer file touches them, and a hook that sliced its own sample array would be
// carrying an exemption for arithmetic that has nothing to do with domain data. `FoldRing` is
// opaque; this file pushes into it and asks it for a readout.
//
// The shared import is RELATIVE, like `enginePerfHud.ts`'s and `useView.ts`'s, so a unit suite that
// resolves no `@shared/*` alias can import whatever imports this.

import { useEffect, useRef, useState } from 'react'
import type { EngineLaunchSay, FoldReadout, FoldRing } from '../../../shared/engineLaunch'
import { ENGINE_LAUNCH_STARTING, NEW_FOLD_RING, foldReadout, pushFold } from '../../../shared/engineLaunch'

/** What the banner draws from: main's answer, and the estimate derived from a run of them. */
export interface EngineLaunchView {
  readonly say: EngineLaunchSay
  /** Present only while a fold is running and at least one measurement has arrived. */
  readonly readout: FoldReadout | null
}

const NOTHING_YET: EngineLaunchView = { say: ENGINE_LAUNCH_STARTING, readout: null }

/**
 * The engine's launch, as one object a component can render.
 *
 * SUBSCRIBE FIRST, THEN READ — `useEnginePerf`'s order, for a stricter version of its reason. The
 * push carries every change; the single mount-time read exists because the two states this banner
 * is FOR (no binary, a collapsed crash loop) are states that have stopped changing, so a window
 * that mounted after one of them would sit in front of a permanently empty app with nothing to
 * explain it. Reading second and then ignoring the answer if a push has already landed is what
 * keeps the ordering from mattering: a stale read can never overwrite a fresh push.
 *
 * THE RING IS DROPPED WHENEVER THERE IS NO FOLD. A phase that is not `folding` carries `fold: null`
 * (main's own invariant), and starting the next fold's estimate from the last one's samples would
 * make a re-fold's first frame look like a rate of minus two hundred megabytes a second. `pushFold`
 * also defends the same boundary from the numbers themselves, so this is belt and braces across an
 * edge that is silent when it is wrong.
 */
export function useEngineLaunch(): EngineLaunchView {
  const [view, setView] = useState<EngineLaunchView>(NOTHING_YET)
  const ring = useRef<FoldRing>(NEW_FOLD_RING)

  useEffect(() => {
    let pushed = false
    const take = (say: EngineLaunchSay): void => {
      ring.current = say.fold === null ? NEW_FOLD_RING : pushFold(ring.current, say.fold)
      setView({ say, readout: say.fold === null ? null : foldReadout(ring.current) })
    }
    const off = window.eq.onEngineLaunch((say) => {
      pushed = true
      take(say)
    })
    void window.eq
      .engineLaunchState()
      .then((say) => {
        if (!pushed) take(say)
      })
      .catch(() => {
        // No handler, or main threw. Both mean "nothing to draw", which is the state already held.
      })
    return off
  }, [])

  return view
}
