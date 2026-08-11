// The Timers tab's data seam (JOS-194): the respawn module's snapshot, plus the one-second clock
// every countdown on the page reads.
//
// THE CLOCK IS LOCAL AND THERE IS EXACTLY ONE OF IT. A row carries its own `diedTs` and its own
// `estimateMs`, so a countdown needs no IPC at all — the buffs overlay's arrangement
// (`useSecondsClock`), for the same reason: a ticking number that travels over IPC is a message
// per second per row for a value the renderer can compute. One interval, threaded down as a
// prop, is also what keeps every row on the page agreeing about what time it is (world-model law
// 9's "one time base per chart", one floor down).

import { useCallback, useEffect, useState } from 'react'
import { useModule } from '../../lib/useModule'
import {
  EMPTY_RESPAWN_SNAP,
  mergeRespawnDelta,
  respawnBaselineStale,
  type RespawnDelta,
  type RespawnPrefs,
  type RespawnSnap
} from '@shared/respawn'

export function useRespawnSnap(): RespawnSnap {
  const snap = useModule<RespawnSnap, RespawnDelta>('respawn', mergeRespawnDelta, respawnBaselineStale)
  return snap ?? EMPTY_RESPAWN_SNAP
}

/** One shared 1 Hz clock. Every countdown on the surface reads this and nothing else. */
export function useSecondsClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(id)
    }
  }, [])
  return now
}

/**
 * Write the watch list. The handler re-normalizes, applies it to the running module and forces a
 * push, so the module delta that comes back is the authority — this hook deliberately keeps NO
 * local copy of the prefs to render optimistically from. An optimistic copy would be a second
 * answer to "what am I watching", and the round trip is a few milliseconds of a same-process IPC.
 */
export function useSetRespawnPrefs(): (next: RespawnPrefs) => void {
  return useCallback((next: RespawnPrefs) => {
    void window.eq.setRespawn(next)
  }, [])
}
