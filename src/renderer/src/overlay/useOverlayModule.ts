// useOverlayModule — the main window's `useModule`, for a window that only has `eqOverlay`.
//
// An overlay is a second renderer entry with a LEANER bridge (preload/overlay.ts): no `window.eq`,
// no MUI, no app context. But the transport it consumes is the same one the app consumes and it
// has the same three halves, so this is `lib/useModule.ts` re-expressed over the bridge this
// window actually has:
//
//   1. HYDRATE — `module:getSnapshot` gives the whole state plus the revision it is at.
//   2. RIDE THE DELTAS — `module:delta` is an INCREMENT; `apply` folds it in. A delta whose seq is
//      not strictly newer is dropped, which is what makes a duplicate flush harmless.
//   3. …AND RE-HYDRATE WHEN THE WORLD WAS REBUILT (JOS-172). A historical fold pushes NOTHING —
//      `endReplay()` discards what it accumulated — so a window created in the same `whenReady`
//      turn that started the fold hydrates at a random instant part-way through months of log and
//      then rides increments describing none of it. `onCharacter` is main saying "throw it away
//      and ask again", on the same channel and under the same name as the main window's bridge,
//      and pipeline.ts's `sendWorldRebuilt` is what delivers it to this window at all.
//
//   A seq that went BACKWARDS is that same rebuild seen from the other side (a module reset
//   restarts its counter low), so it re-hydrates rather than being dropped forever.
//
// IT BUFFERS ACROSS THE HYDRATION AWAIT, and that is NOT a nicety copied for symmetry. The two
// overlay surfaces that hand-rolled this before both fold WHOLE-SNAPSHOT modules, where a delta is
// a replace and a lost one is repaired by the next flush. `progression` and `loot` are the first
// modules an overlay folds that are APPEND-ONLY: a delta landing between the `getModuleSnapshot`
// call and its resolution carries a slice of history that no later delta will ever restate, so
// dropping it would leave a permanent hole in a column. Subscribe first, buffer, replay in seq
// order, and let the seq check discard whatever the snapshot already covered — `useModule`'s own
// rule, for the same reason.
//
// WHY IT IS A FILE AND NOT A LOCAL (JOS-195). `EventLogOverlay` and `BuffsOverlay` each wrote a
// smaller version of this by hand, and the XP window would have been the third. Neither is
// converted here: this is the new window's ticket, folding them in is a behavior-preserving pass
// with two e2e specs of its own to re-run, and the repo's rule is that a refactor rides its own
// wave. This is the home it lands in when it does.
//
// MUI-FREE like everything in this bundle.

import { useEffect, useRef, useState } from 'react'
import type { ModuleDelta } from '@shared/types'

/**
 * Hydrate a module and ride its deltas. `apply` is the module's own delta contract — a replace for
 * a whole-snapshot module, a concat for an append-only one, the columnar merge for `progression`.
 *
 * `Delta` appears once in the signature, which `no-unnecessary-type-parameters` reads as
 * removable. It is not: every call site passes its own delta shape, parameters are CONTRAVARIANT,
 * and widening to `unknown` would make each module's typed reducer unassignable — so the type
 * parameter IS the safety. `lib/useModule.ts` records the same finding at the same rule.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- see above
export function useOverlayModule<Snap, Delta>(
  moduleId: string,
  applyDelta: (state: Snap, delta: Delta) => Snap,
  empty: Snap
): Snap {
  const [state, setState] = useState<Snap>(empty)
  // Latest reducer without making the effect depend on its identity.
  const applyRef = useRef(applyDelta)
  applyRef.current = applyDelta

  useEffect(() => {
    let cancelled = false
    /** The highest seq folded into `state`. -1 until the first snapshot lands. */
    let knownSeq = -1
    let hydrated = false
    const buffered: ModuleDelta<Delta>[] = []

    const applyOne = (d: ModuleDelta<Delta>): void => {
      if (d.seq <= knownSeq) return
      knownSeq = d.seq
      setState((prev) => applyRef.current(prev, d.delta))
    }

    const hydrate = (): void => {
      hydrated = false
      buffered.length = 0
      void window.eqOverlay.getModuleSnapshot<Snap>(moduleId).then((snap) => {
        if (cancelled || !snap) return
        knownSeq = snap.seq
        setState(snap.state)
        hydrated = true
        // Replay what landed during the await, in seq order; the seq check above drops anything
        // the snapshot already covered.
        for (const d of [...buffered].sort((a, b) => a.seq - b.seq)) applyOne(d)
        buffered.length = 0
      })
    }

    const off = window.eqOverlay.onModuleDelta<Delta>((d: ModuleDelta<Delta>) => {
      if (d.moduleId !== moduleId) return
      if (!hydrated) {
        buffered.push(d)
        return
      }
      // A seq that went BACKWARDS is a module that was reset in main — ask again rather than
      // folding an increment into a state it does not describe.
      if (d.seq < knownSeq) {
        hydrate()
        return
      }
      applyOne(d)
    })
    const offChar = window.eqOverlay.onCharacter(() => {
      hydrate()
    })
    hydrate()

    return () => {
      cancelled = true
      off()
      offChar()
    }
  }, [moduleId])

  return state
}
