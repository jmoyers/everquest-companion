// useModule — hydrate a module's served state and stay current with it.
//
// ── WHAT THIS HOOK WAS, AND WHAT THE DELETION RELEASE LEFT OF IT (JOS-499 item 7) ──────────────
//
// It used to fold two channels at once. `module:delta` carried INCREMENTS out of main's own
// TypeScript fold and the hook applied them with a caller-supplied `applyDelta`, deduping by seq;
// `module:changed` carried the ENGINE's cursor, which is a dirty bit with no state in it, and the
// answer to one is to ask for the whole snapshot again. Which channel a given hook instance rode
// was decided per hydrate by `snap.served` — the shim saying who answered.
//
// THE TS FOLD IS GONE, so there is one channel, and the hook is the smaller half:
//
//   1. HYDRATE — `module:getSnapshot` gives the whole state plus the cursor it is at.
//   2. RE-ASK when `module:changed` reports a cursor ahead of the one being held.
//   3. RE-HYDRATE when the world changed hands (`MODULE_WORLD_CHANGED`) or the character switched.
//
// EVERYTHING THAT WENT WITH THE DELTA ARM, and why none of it is missed:
//
//   * `applyDelta`. There are no increments to fold. A cursor carries no state by design — that IS
//     the boundary's design (`serveDeltas.ts`), and the answer to a dirty bit is a fresh read.
//   * The seq DEDUPE. It existed because two producers could describe the same fold; with one
//     producer a cursor is either ahead of what is held or it is not, and `knownSeq` answers that.
//   * The `stale` predicate. It existed for a delta the held baseline could not ABSORB — a shape
//     written by a main process running different code (routine in dev, and the update path in
//     general). Nothing is absorbed any more: every read replaces the whole state, so a shape change
//     is repaired by the very next hydrate rather than being merged into forever. The three call
//     sites that passed one (`killsBaselineStale`, `respawnBaselineStale`, and useSpellSets's
//     inline shape-version check) are covered by that, and their predicates die with this parameter.
//   * The BUFFER across the hydration await. It existed because an append-only module's delta
//     carried history no later delta would restate, so dropping one left a permanent hole. A cursor
//     restates nothing and needs to: `pendingSeq` below keeps the newest one heard during a fetch
//     and re-asks if the reply came from before it, which terminates because a re-fetch answers at
//     or past the cursor that provoked it.
//
// ── `null` IS THE HONEST LOADING/UNAVAILABLE STATE, AND IT IS LOAD-BEARING NOW ─────────────────
//
// It always meant "no state yet". After the deletion it also means "the engine has nothing to say
// for this module" — no engine on this launch, still folding, on another log. There is no TS
// fallback left to paper over that, by ruling 12, and papering over it is exactly what a
// deletion release must not do: a view that invented empty data would be claiming the player has
// looted nothing rather than admitting it cannot answer yet. Call sites that coalesce with `??`
// to an empty value are choosing "draw the empty shape" and are unchanged; call sites that pass
// `null` through draw a loading state.

import { useEffect, useState } from 'react'
import { MODULE_WORLD_CHANGED, type ModuleChanged } from '@shared/types'

// `Snap` NOW APPEARS ONCE IN THE SIGNATURE, which `no-unnecessary-type-parameters` reads as
// removable. It is not, and the reason changed with the hook: the parameter used to earn its keep
// through `applyDelta`'s contravariance, and it now earns it as the only statement anywhere of what
// a served snapshot's shape IS. `getModuleSnapshot` answers `unknown`, so widening this to `unknown`
// would type every view's state as `unknown` and move twenty compile errors into runtime.
// `useOverlayModule` pins the same shape with a second occurrence (its `empty`) and needs no
// directive; this one does.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- see above
export function useModule<Snap>(moduleId: string): Snap | null {
  const [state, setState] = useState<Snap | null>(null)

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
      void window.eq.getModuleSnapshot<Snap>(moduleId).then((snap) => {
        if (cancelled) return
        // NO SNAPSHOT IS AN ANSWER, and it is the engine-absent one. Nothing is held and nothing is
        // invented; the view draws its loading/unavailable state until a cursor or a rebuild says
        // to ask again.
        if (!snap) {
          setState(null)
          hydrated = true
          return
        }
        knownSeq = snap.seq
        setState(snap.state)
        hydrated = true
        // …AND THE CURSOR THAT LANDED DURING THE FETCH. It cannot simply be dropped: the reply it
        // raced may have been taken from the engine BEFORE that cursor moved, and no later frame
        // restates a cursor already reported.
        if (pendingSeq > knownSeq) hydrate()
      })
    }

    const offChanged = window.eq.onModuleChanged((c: ModuleChanged) => {
      // The world that answers reads changed hands (the engine went live, or went away). There is
      // no cursor to compare and nothing held is trustworthy: ask again.
      if (c.moduleId === MODULE_WORLD_CHANGED) {
        hydrate()
        return
      }
      if (c.moduleId !== moduleId) return
      // Not hydrated yet: remember the newest cursor and let the in-flight fetch settle it.
      if (!hydrated) {
        if (c.seq > pendingSeq) pendingSeq = c.seq
        return
      }
      if (c.seq <= knownSeq) return // we already hold this cursor
      hydrate()
    })

    // Re-hydrate on a character switch (the world was rebuilt under a new ref).
    const offChar = window.eq.onCharacter(() => {
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
