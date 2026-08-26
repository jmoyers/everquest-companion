// useOverlayModule — the main window's `useModule`, for a window that only has `eqOverlay`.
//
// An overlay is a second renderer entry with a LEANER bridge (preload/overlay.ts): no `window.eq`,
// no MUI, no app context. But the transport it consumes is the same one the app consumes, so this
// is `lib/useModule.ts` re-expressed over the bridge this window actually has, and that file's
// header carries the argument for the shape. The three halves:
//
//   1. HYDRATE — `module:getSnapshot` gives the whole state plus the cursor it is at.
//   2. RE-ASK when `module:changed` reports a cursor ahead of the one being held.
//   3. RE-HYDRATE when the world changed hands or the character switched (JOS-172) — a historical
//      fold announces nothing on its own, so a window created in the same `whenReady` turn that
//      started one would otherwise sit on a random part-way-through slice forever. `onCharacter` is
//      main saying "throw it away and ask again", and `worldRebuilt.ts sendWorldRebuilt` is what
//      delivers it to this window at all.
//
// THE DELTA ARM IS GONE (JOS-499 item 7), with main's own fold. `lib/useModule.ts` carries the full
// account of what went with it and why none of it is missed; the short version is that a cursor is
// a dirty bit carrying no state, so there is nothing left to fold, dedupe, buffer or call stale.
//
// THE `empty` ARGUMENT STAYS, and it is the difference from the main window's hook. An overlay is a
// small always-visible surface with no room for a loading state — it draws the empty shape until it
// has something, which is what these windows have always done. The main window returns `null` and
// lets each view decide.
//
// MUI-FREE like everything in this bundle.

import { useEffect, useState } from 'react'
import { MODULE_WORLD_CHANGED, type ModuleChanged } from '@shared/types'

export function useOverlayModule<Snap>(moduleId: string, empty: Snap): Snap {
  const [state, setState] = useState<Snap>(empty)

  useEffect(() => {
    let cancelled = false
    /** The cursor the held state is at. -1 until the first snapshot lands. */
    let knownSeq = -1
    let hydrated = false
    /** The newest cursor heard while a hydrate was in flight; -1 when there is none. */
    let pendingSeq = -1

    const hydrate = (): void => {
      hydrated = false
      pendingSeq = -1
      void window.eqOverlay.getModuleSnapshot<Snap>(moduleId).then((snap) => {
        if (cancelled) return
        // NO SNAPSHOT: the engine has nothing to say for this module yet. The window keeps drawing
        // the empty shape rather than inventing rows — see the header.
        if (!snap) {
          hydrated = true
          return
        }
        knownSeq = snap.seq
        setState(snap.state)
        hydrated = true
        // …and the cursor that landed during the fetch — `lib/useModule.ts` states why it cannot be
        // dropped and why the re-fetch terminates.
        if (pendingSeq > knownSeq) hydrate()
      })
    }

    const offChanged = window.eqOverlay.onModuleChanged((c: ModuleChanged) => {
      if (c.moduleId === MODULE_WORLD_CHANGED) {
        hydrate()
        return
      }
      if (c.moduleId !== moduleId) return
      if (!hydrated) {
        if (c.seq > pendingSeq) pendingSeq = c.seq
        return
      }
      if (c.seq <= knownSeq) return
      hydrate()
    })
    const offChar = window.eqOverlay.onCharacter(() => {
      hydrate()
    })
    hydrate()

    return () => {
      cancelled = true
      offChanged()
      offChar()
    }
  }, [moduleId])

  return state
}
