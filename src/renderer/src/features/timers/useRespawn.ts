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
  type RespawnPrefs,
  type RespawnSnap
} from '@shared/respawn'

export function useRespawnSnap(): RespawnSnap {
  const snap = useModule<RespawnSnap>('respawn')
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

/**
 * "That sighting was the spawn — start the clock from it" (owner ruling, round 3). Same shape as
 * the prefs writer above and for the same reason: main applies it to the running module and forces
 * a push, so the module delta is the authority and this hook keeps no local copy to render
 * optimistically from. The resolved boolean is deliberately dropped — a refusal means the row is
 * gone or is no longer seen, and the delta that says so is already on its way.
 */
export function useConfirmSighting(): (rowId: string) => void {
  return useCallback((rowId: string) => {
    void window.eq.confirmRespawnSighting(rowId)
  }, [])
}

/**
 * "Stop watching this mob" (owner ruling, round 4). Same shape and same reasoning as the two
 * writers above — main removes the entry, persists it, applies it to the running module and forces
 * a push, so the delta is the authority and nothing here keeps a second copy of the watch list to
 * render from.
 *
 * It takes a KEY rather than the edited prefs so that every surface offering this control sends the
 * same thing: a clock row, a floating-window row and a Recently-killed entry all know one mob's
 * name and none of them has to hold — or risk clobbering — the whole list. The resolved boolean is
 * dropped for the reason its sibling's is: false means nothing was watching that name any more, and
 * the delta that already says so is on its way.
 */
export function useUnwatch(): (key: string) => void {
  return useCallback((key: string) => {
    void window.eq.unwatchRespawn(key)
  }, [])
}
