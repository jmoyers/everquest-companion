// useModule — the one hook every module-backed view uses to stay live.
//
// It replaces the hydrate/subscribe race each view used to hand-roll:
//   1. hydrate via getModuleSnapshot(moduleId) → { seq, state },
//   2. subscribe to module:delta filtered by moduleId,
//   3. apply deltas IN ORDER via the caller's applyDelta(state, delta),
//      rejecting dupes (delta.seq <= known seq),
//   4. re-hydrate on onCharacter (state was fully rebuilt in main). The only
//      real gap source is a remount/switch, and re-hydration covers it — so
//      instead of trying to detect a mid-stream gap (delta seqs batch many
//      events, so there's no reliable "expected next" to compare against) we
//      lean on the full-snapshot re-fetch that onCharacter already triggers.
//
// Deltas that arrive between the getModuleSnapshot call and the subscription are
// not lost: we subscribe BEFORE awaiting the snapshot and buffer, then replay the
// buffer (dropping anything already covered by the snapshot's seq).
//
// The optional `stale` predicate covers the ONE gap the above cannot: a delta the held
// baseline is unable to absorb because it was written under a different SHAPE (main restarted
// on new code while this window kept running — routine in dev, and the update path in
// general). A per-key merge across that boundary silently preserves old-shaped entries
// forever, so the module says so and the hook re-hydrates instead of merging. See
// shared/kills.ts (KILLS_SHAPE_VERSION), the first module to need it.

// ── ONE WORLD, ONE NUMBERING SPACE (JOS-493) ───────────────────────────────────────────────────
//
// Everything above describes ONE fold: main's. With `EQC_ENGINE_SERVE=1` there are two, and step 1
// and step 3 stopped being the same world — the snapshot is answered by the RUST ENGINE (the compat
// shim, `src/main/dataServer/serveShim.ts`) while `module:delta` keeps arriving from this process's
// own fold. The seqs are then unrelated numbers, and step 3's dupe rule quietly eats every one of
// them: MEASURED on a respawn watch at engine seq 4 against app seq 3, and STRUCTURAL for the four
// modules that publish a private revision counter (combo, character, respawn, buffTimers).
//
// So the hook rides exactly ONE of two channels, and the SNAPSHOT ITSELF says which — `served` is
// the shim stating that the engine answered:
//
//   * served      → ignore `module:delta` entirely; re-fetch when `module:changed` reports a cursor
//                   ahead of the one we are holding. That is the boundary's own design: the frame is
//                   a dirty bit carrying no state, and the answer to it is the snapshot op.
//   * not served  → exactly the behaviour above these lines, unchanged, in every launch that never
//                   asked for an engine.
//
// The hook therefore knows nothing about a flag, and cannot be left holding a stale opinion about
// one: the question is re-answered by every hydrate.

import { useEffect, useRef, useState } from 'react'
import { MODULE_WORLD_CHANGED, type ModuleChanged, type ModuleDelta } from '@shared/types'

// `Delta` used to appear ONCE in the signature, which no-unnecessary-type-parameters reads as
// removable (it was suppressed here: every call site passes its own delta shape explicitly, and
// widening the parameter to `unknown` would make each module's typed applyDelta unassignable —
// parameters are contravariant, so the type parameter IS the safety). `stale` is its second
// use, so the suppression is no longer needed; the reasoning still is.
export function useModule<Snap, Delta>(
  moduleId: string,
  applyDelta: (state: Snap, delta: Delta) => Snap,
  stale?: (state: Snap, delta: Delta) => boolean
): Snap | null {
  const [state, setState] = useState<Snap | null>(null)
  // Latest applyDelta without making the effect depend on its identity.
  const applyRef = useRef(applyDelta)
  applyRef.current = applyDelta
  const staleRef = useRef(stale)
  staleRef.current = stale

  useEffect(() => {
    let cancelled = false
    // Known seq: the highest LogEvent seq folded into `state`. -1 until hydrated.
    let knownSeq = -1
    // Deltas that arrive before hydration completes, replayed after.
    const buffered: ModuleDelta<Delta>[] = []
    let hydrated = false
    // The state the folds have produced so far, mirrored out of setState so `stale` can be
    // asked BEFORE a delta is applied (a React updater is the wrong place to start an IPC).
    let current: Snap | null = null
    /** Did the ENGINE answer the snapshot we are holding? Re-answered by every hydrate. */
    let served = false
    /** The newest engine cursor heard while a hydrate was in flight; -1 when there is none. */
    let pendingSeq = -1

    const applyOne = (d: ModuleDelta<Delta>): void => {
      if (d.moduleId !== moduleId) return
      // NOT OUR WORLD. This increment came out of main's own fold and `knownSeq` is a cursor in the
      // engine's — comparing them is meaningless in both directions (it would drop a real delta as a
      // dupe, or fold one into a state it does not describe). The frame is still DELIVERED, because
      // two consumers read a delta as an event rather than as state (the alert player's fires, the
      // live dot); folding it is the part that belongs to one world only.
      if (served) return
      if (d.seq <= knownSeq) return // dupe or already-covered
      if (current != null && staleRef.current?.(current, d.delta) === true) {
        // This baseline cannot absorb this delta. Re-fetch rather than merge; the fresh
        // snapshot carries whatever shape main is on now, and the delta is re-covered by seq.
        hydrate()
        return
      }
      knownSeq = d.seq
      setState((prev) => {
        if (prev == null) return prev
        const next = applyRef.current(prev, d.delta)
        current = next
        return next
      })
    }

    const hydrate = (): void => {
      hydrated = false
      buffered.length = 0
      pendingSeq = -1
      current = null
      void window.eq.getModuleSnapshot<Snap>(moduleId).then((snap) => {
        if (cancelled || !snap) return
        knownSeq = snap.seq
        // WHICH WORLD ANSWERED, asked fresh every time: the shim decides PER CALL, so an engine that
        // was still folding a moment ago serves the next read and one that died stops serving this
        // one. Nothing is remembered across a hydrate.
        served = snap.served === true
        setState(snap.state)
        current = snap.state
        hydrated = true
        // Replay anything that landed during the await, in seq order.
        for (const d of buffered.sort((a, b) => a.seq - b.seq)) applyOne(d)
        buffered.length = 0
        // …AND THE CURSOR THAT LANDED DURING IT. A `module:changed` arriving while this fetch was in
        // flight cannot simply be dropped: the reply it raced may have been taken from the engine
        // BEFORE that cursor moved, and no later frame restates a cursor that has already been
        // reported. It terminates — a re-fetch answers at or past the cursor that provoked it.
        if (served && pendingSeq > knownSeq) hydrate()
      })
    }

    const offDelta = window.eq.onModuleDelta<Delta>((d) => {
      if (d.moduleId !== moduleId) return
      // Buffer until hydrated so a delta racing the snapshot isn't lost or applied
      // against null state; the hydrate replay drops any already covered by seq.
      if (!hydrated) {
        buffered.push(d)
        return
      }
      applyOne(d)
    })

    // THE SERVED WORLD'S DIRTY BIT (JOS-493) — a name and a cursor, never state.
    const offChanged = window.eq.onModuleChanged((c: ModuleChanged) => {
      // The world that answers reads changed hands (the engine went live, or went away). There is
      // no cursor to compare and nothing held is trustworthy: ask again, and the reply says which
      // world we are in now.
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
      // We are folding main's own world; its increments arrive on `module:delta`, not here.
      if (!served) return
      if (c.seq <= knownSeq) return // we already hold this cursor
      hydrate()
    })

    // Re-hydrate on a character switch (main rebuilt everything under a new ref).
    const offChar = window.eq.onCharacter(() => hydrate())

    hydrate()

    return () => {
      cancelled = true
      offDelta()
      offChanged()
      offChar()
    }
  }, [moduleId])

  return state
}
