// useModule — read a module's served state, and stay current with it.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// FOR A COMPONENT AUTHOR — THIS IS THE WHOLE CONTRACT, AND IT IS THE WHOLE THING YOU NEED
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
//     const snap = useModule<LootSnap>('loot')
//
//   * You get the module's current state, or `null`. `null` means THERE IS NO STATE YET: still
//     loading, or the engine has nothing to say for this module on this launch. It is never an
//     empty result — draw a loading state, or coalesce with `??` if drawing the empty shape is the
//     honest thing for your surface. Both are ordinary; pick the one your view means.
//   * It stays current by itself. When the world moves, your component re-renders with the new
//     state. There is nothing to subscribe to, nothing to refresh, nothing to tear down.
//   * THE VALUE IS STABLE BY IDENTITY UNTIL IT ACTUALLY CHANGES. That is what it buys you: the
//     snapshot is safe to use directly as a `useMemo`/`useEffect` dependency and safe to pass
//     across a `React.memo` boundary, and it will not churn a memo you built on it. Two components
//     reading the same module hold the SAME object, so `Object.is` means what you assume.
//   * Call it as many times as you like, anywhere. Ten components reading `character` cost what
//     one costs. Mount, unmount and remount freely — none of that is your bookkeeping.
//
// That is the entire component-facing surface. If you find yourself wanting anything else — to
// peek at whether it has hydrated, to force a refresh, to know where a value came from — DO NOT
// widen this hook: that want is a design signal about the surface asking for it, and it should be
// raised as one (owner ruling, 2026-08-26).
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// BELOW THIS LINE IS FOR SOMEBODY CHANGING THE PLUMBING, NOT FOR SOMEBODY USING IT
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// THE MACHINERY IS DELIBERATELY INVISIBLE ABOVE (ruling 18's cache-transparency law, renderer
// edition — the engine's own phrasing is that caching must be so transparent that even its
// consumers cannot tell cached from fetched). Everything the four bullets above quietly rely on
// lives in ONE file, `moduleStore.ts`, and none of it appears in any component:
//
//   * one held snapshot per module, shared by every reader (this is where the identity guarantee
//     comes from, and why N readers are not N copies);
//   * one `module:getSnapshot` round trip per push rather than one per reader;
//   * ONE `onModuleChanged` and ONE `onCharacter` listener for the whole window, owned by the
//     store rather than by each hook instance;
//   * cursor arithmetic (`seq`/`pendingSeq`), in-flight dedupe, and the buffer that makes
//     subscribe-before-hydrate safe;
//   * a frame-coalesced flush, so several modules announcing in one engine beat are one batch;
//   * clearing on a character switch, and dropping the replies still in flight for the old world.
//
// Read that file's header before changing any of it. The hook itself is deliberately four lines:
// there is no behaviour here to get wrong, which is the point of putting all of it behind one
// abstraction rather than in thirty-three call sites.
//
// THE STORE'S TWO MEMBERS ARE `useSyncExternalStore`'s OWN CONTRACT (`subscribe`, `getSnapshot`),
// and that is on purpose rather than incidental: the SELECTOR form (JOS-512 — subscribe to a
// slice, re-render only when that slice moves) is `useSyncExternalStoreWithSelector` over exactly
// the same two members, so it can be added beside this hook without this hook changing at all.
//
// ── AND YET THIS HOOK DOES NOT CALL `useSyncExternalStore`. THE REASON IS A PREFERENCE ───────
//
// It did briefly, and the honest history matters because the comment that first sat here was
// WRONG. `useSyncExternalStore` is the textbook primitive for a store like this, and it was
// swapped out mid-ticket on a theory — that its updates, being synchronous and non-interruptible
// by design (which is how it guarantees no tearing), were starving the Mobs tab's
// `useDeferredValue` ranking. That theory was TESTED AND DISPROVED: the swap did not fix the
// failing spec. The real cause was elsewhere entirely and was not a scheduling problem at all
// (tests/e2e/mob-drops-era.e2e.mts, and its own comment now records it).
//
// So this is not a measured necessity, and nobody should read it as one. It is a deliberate
// PREFERENCE, on two grounds that stand on their own:
//
//   * `useView.ts` — the engine-backed successor to this hook, which every migrated surface will
//     use — is subscribe-plus-state. Two hooks with the same job should not have two update
//     disciplines, and the successor is the one that sets the house style.
//   * A plain `setState` is an ORDINARY update React may batch and schedule against other work,
//     which is the scheduling behaviour this app had before this ticket. Keeping it means this
//     ticket changed WHERE data is held without also changing how urgently every one of 32 call
//     sites re-renders — a smaller blast radius for a plumbing change, whatever the merits of the
//     alternative.
//
// WHAT IS GIVEN UP: the tearing guarantee. It costs nothing here, and this is the part to re-check
// before reversing the decision. Tearing means two components painting different values of one
// store in one frame; every subscriber is notified inside a single store flush, React 18
// auto-batches the resulting `setState`s into one pass, and they all read the SAME held object, so
// they cannot disagree. The guarantee earns its keep when a store can change DURING rendering;
// this one only ever changes in a promise continuation or a bridge callback, never mid-render.
// Switching back to `useSyncExternalStore` is therefore a legitimate option, not a regression —
// just do it on its own merits and not on the theory that was already tried and disproved.

import { useEffect, useState } from 'react'
import { createModuleStore, scheduleFrame, type ModuleStore } from './moduleStore'

/**
 * The window's ONE store, built on first use.
 *
 * Lazy rather than a module-level `const` for two reasons: `window.eq` is the preload bridge and
 * this module is imported by unit tests where there is no window, and building it on the first
 * subscription rather than on import keeps a launch that never reads a module from installing an
 * IPC listener at all.
 */
let store: ModuleStore | null = null
function moduleStore(): ModuleStore {
  store ??= createModuleStore({ bridge: window.eq, schedule: scheduleFrame })
  return store
}

/** What this hook holds, and WHICH module it belongs to — see the render-time guard below. */
interface Held<Snap> {
  readonly id: string
  readonly snap: Snap | null
}

// THE THREE ASSERTIONS BELOW ARE THE ONE PLACE THE SHAPE IS NAMED. The store is keyed by a runtime
// string and answers `unknown`, which is the honest type for it; this hook knows the module id as a
// literal at every call site and is where a caller states what that module's state is. They are
// written out rather than wrapped in a `read<Snap>()` helper because such a helper would use `Snap`
// exactly once — in a return position — which is the shape the lint rule below is right to refuse,
// and earning a SECOND exemption to save two lines is not a trade worth making.
//
// `Snap` APPEARS ONLY IN THE RETURN TYPE here too, which `no-unnecessary-type-parameters` reads as
// removable. It is not: `getModuleSnapshot` answers `unknown`, so widening this to `unknown` would
// type every view's state as `unknown` and move twenty compile errors into runtime. This parameter
// is the only statement anywhere of what a served snapshot's shape IS.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- see above
export function useModule<Snap>(moduleId: string): Snap | null {
  // Seeded from the store rather than from `null`: a module something else is already reading is
  // answered on this hook's FIRST render, with no loading frame it does not need.
  const [held, setHeld] = useState<Held<Snap>>(() => ({
    id: moduleId,
    snap: moduleStore().getSnapshot(moduleId) as Snap | null
  }))

  useEffect(() => {
    const take = (): void => {
      const snap = moduleStore().getSnapshot(moduleId) as Snap | null
      // Bail out the way React does. The store only notifies when it has taken a new reply, but
      // this also covers the `take()` below, which fires on every subscribe.
      setHeld((prev) => (prev.id === moduleId && Object.is(prev.snap, snap) ? prev : { id: moduleId, snap }))
    }
    const off = moduleStore().subscribe(moduleId, take)
    // CLOSE THE GAP between the render that read the store and the effect that subscribed to it:
    // a reply can land in between, and its notification went to nobody. `useSyncExternalStore` does
    // exactly this re-read internally, and it is the one piece of that hook worth keeping by hand.
    take()
    return off
  }, [moduleId])

  // State belonging to a module nobody is asking about any more is not shown for the render
  // between the id changing and the effect that acts on it — `useView`'s descriptor guard, for
  // the same reason and with the same shape.
  return held.id === moduleId ? held.snap : (moduleStore().getSnapshot(moduleId) as Snap | null)
}
