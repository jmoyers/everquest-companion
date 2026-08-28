// moduleStore — ONE held snapshot per module, ONE fetch per push, ONE listener for the whole app.
//
// ── WHAT THIS REPLACES, AND WHAT IT COST (JOS-510 item 1) ─────────────────────────────────────
//
// `useModule` used to be self-contained: every hook INSTANCE opened its own `module:changed`
// listener, ran its own `module:getSnapshot` round trip, and held its own copy of the reply in its
// own `useState`. That is correct and it does not scale with the number of readers, which is the
// only axis this app grows on. Measured at the time this was written: 33 live `useModule` call
// sites, and they are not spread evenly — `character` has 7, `progression` 6, `loot` 4. So ONE
// engine push on the character module meant seven IPC round trips, seven decoded replies, seven
// distinct state objects, and seven `setState`s, to describe one fact.
//
// It also made reference equality useless downstream. Seven readers of one module held seven
// different objects for the same state, so a `React.memo` or a `useMemo` keyed on a snapshot could
// never bail out on identity even when nothing had changed. Fixing the fan-out and fixing the
// identity are the same fix, which is why this file is one thing and not two.
//
// ── THE SHAPE ─────────────────────────────────────────────────────────────────────────────────
//
// A module-level `Map` keyed by module id. Each entry holds:
//
//   * THE SNAPSHOT — one object, handed to every subscriber of that module BY IDENTITY. Two hooks
//     reading `character` receive the same object, so `Object.is` means what a caller assumes.
//   * THE CURSOR (`seq`) the held snapshot is at, and `pendingSeq`, the newest cursor heard while
//     a fetch was in flight. Both are `useModule`'s own arithmetic, moved rather than redesigned.
//   * A `Set` of subscriber callbacks. Its SIZE is also the answer to "is anyone watching this
//     module", which is what lets an unwatched module cost zero IPC.
//
// The bridge listeners belong to the STORE, not to a hook: one `onModuleChanged` and one
// `onCharacter` for the whole window, attached when the first subscriber anywhere arrives.
//
// ── THE THREE CONTRACTS THAT WERE PRESERVED EXACTLY ───────────────────────────────────────────
//
//   1. `null` IS THE HONEST LOADING/UNAVAILABLE STATE. It always meant "no state yet"; since the
//      TypeScript fold was deleted it also means "the engine has nothing to say for this module" —
//      no engine on this launch, still folding, on another log. There is no fallback left to paper
//      over that (ruling 12), so a reply of `null` is STORED as null rather than being smoothed
//      into an empty value. Call sites that coalesce with `??` are choosing to draw the empty
//      shape; call sites that pass `null` through draw a loading state. Unchanged either way.
//   2. SUBSCRIBE BEFORE HYDRATE. `subscribe()` puts the callback in the Set BEFORE it starts any
//      fetch, so a cursor arriving during the very first round trip cannot be missed. The buffer
//      that made that safe is `pendingSeq`, and it terminates for the reason it always did: a
//      re-fetch answers at or past the cursor that provoked it.
//   3. THE `onCharacter` RE-HYDRATE. Main pushes `onCharacter` once state is fully rebuilt, and
//      the world behind every held snapshot is then gone. The store is CLEARED — every subscriber
//      is told, and reads `null`, which is the true answer for that instant — and every watched
//      module is asked again immediately. A `generation` counter discards the replies that were
//      already in flight for the character nobody is looking at any more.
//
// ── WHY NOTHING IS CACHED ACROSS A GAP IN SUBSCRIBERS ─────────────────────────────────────────
//
// Two different situations, two different answers, and the difference is whether the store still
// has a listener on the bridge:
//
//   * ONE MODULE loses its last reader (a tab unmounts). The store is still listening, so it can
//     still hear that module's cursor move — it just declines to spend IPC on a module nobody is
//     reading, and marks the entry `stale` instead. A later reader gets the cached snapshot for
//     its first paint AND a fresh fetch, which is strictly better than the flash of `null` the
//     old per-hook version produced on every remount.
//   * THE WHOLE STORE loses its last reader. The listeners come off, so nothing can record that
//     anything went stale, and therefore nothing cached may be trusted afterwards. The store is
//     emptied. A cache whose invalidation channel is closed is not a cache.
//
// ── THE FLUSH IS FRAME-COALESCED, AND THE TIMER IS NOT A BELT-AND-BRACES (integrator, JOS-510) ─
//
// One engine beat routinely announces several modules at once, and a single module's cursor can
// move more than once inside one animation frame. A push therefore does not fetch: it marks the
// module DIRTY and arms ONE flush, and the flush fetches every dirty module together. Three pushes
// inside a frame are one batch and one notification per subscriber, not three of each.
//
// The flush is armed on `requestAnimationFrame` AND on a timer, whichever fires first, and the
// timer is load-bearing rather than defensive: THIS REPO HAS ALREADY MEASURED THAT rAF CAN BE
// THROTTLED TO NOTHING IN A WINDOW THAT IS NEVER COMPOSITED (AGENTS.md, the `nextFrames` trap in
// the e2e vocabulary), and the same is true of a minimized window and of one closed to the tray
// while alerts keep firing. A store that only woke on rAF would simply stop delivering data to
// those windows. Arming both — rather than checking `document.visibilityState` when scheduling —
// is what also covers the window that becomes hidden AFTER the flush was armed, which no
// check-at-schedule-time can. The floor is two frames so that a window which IS compositing
// always flushes on its own frame boundary and the timer stays the fallback it is named as.

import { MODULE_WORLD_CHANGED } from '../../../shared/types'
import type { CharacterRef, ModuleChanged, ModuleSnapshot } from '../../../shared/types'

/**
 * The three bridge members this store needs. Declared structurally rather than as `typeof
 * window.eq` so the store can be constructed over a fake in a unit test — which is the whole
 * reason the app's singleton is assembled in `useModule.ts` and not here.
 */
export interface ModuleBridge {
  getModuleSnapshot: (moduleId: string) => Promise<ModuleSnapshot | null>
  onModuleChanged: (cb: (c: ModuleChanged) => void) => () => void
  onCharacter: (cb: (c: CharacterRef | null) => void) => () => void
}

/**
 * What a subscriber does with the store: watch one module, and read what it holds.
 *
 * BOTH MEMBERS ARE DELIBERATELY UNTYPED IN THE SNAPSHOT (`unknown`, not a type parameter). A store
 * keyed by a runtime string cannot know what any module's state IS, and saying otherwise with a
 * generic would be this file inventing a claim it cannot check — the parameter would appear once,
 * in a return position, which is the definition of a lie the compiler will happily tell. Naming
 * the shape is `useModule`'s job, at the one call site that knows the module id as a literal.
 */
export interface ModuleStore {
  /** Register `onChange` for one module. Hydrates if nothing trustworthy is held. Returns the
   *  unsubscribe, which is idempotent. */
  subscribe: (moduleId: string, onChange: () => void) => () => void
  /** The held snapshot, or `null` — contract 1. Stable by identity between notifications. */
  getSnapshot: (moduleId: string) => unknown
}

interface Entry {
  /** The one object every subscriber of this module reads. `null` is loading/unavailable. */
  snapshot: unknown
  /** The cursor `snapshot` is at. -1 until the first snapshot lands. */
  seq: number
  /** The newest cursor heard while a fetch was in flight; -1 when there is none. */
  pendingSeq: number
  hydrated: boolean
  fetching: boolean
  /** The cursor moved while nobody was watching — serve the cache, then refresh. */
  stale: boolean
  subs: Set<() => void>
}

/**
 * ONE frame. The header says why this is a FLOOR and not the schedule.
 *
 * It was two frames on the theory that a compositing window should always reach its rAF first and
 * the timer should stay visibly a fallback. That reasoning had the cost backwards: the windows that
 * take this path are precisely the ones where rAF never fires at all — a minimized window, one
 * closed to the tray with alerts still firing, and EVERY e2e launch — so for them the floor is not
 * a fallback, it is the whole schedule, and doubling it doubled their latency to no end. Bursts
 * still coalesce either way: cursors that arrive in one IPC batch are all marked dirty inside the
 * same task, before any timer scheduled during it can fire.
 */
const FRAME_FLOOR_MS = 16

/**
 * The globals the default scheduler arms, declared structurally on purpose: the guarded
 * `requestAnimationFrame` may genuinely not exist (a unit test, a worker), and spelling it this
 * way keeps this file typechecking in a project with no DOM lib instead of needing one.
 */
interface FrameGlobals {
  requestAnimationFrame?: (cb: () => void) => number
  cancelAnimationFrame?: (handle: number) => void
}

/**
 * Run `run` on the next animation frame, or on the floor timer if that comes first — see the
 * header. Exported so the arm that matters for a hidden window can be tested rather than assumed.
 */
export function scheduleFrame(run: () => void): void {
  const frames = globalThis as FrameGlobals
  let fired = false
  let raf: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const fire = (): void => {
    if (fired) return
    fired = true
    if (raf !== null) frames.cancelAnimationFrame?.(raf)
    if (timer !== null) clearTimeout(timer)
    run()
  }
  timer = setTimeout(fire, FRAME_FLOOR_MS)
  raf = frames.requestAnimationFrame?.(fire) ?? null
}

/** The entry bookkeeping, at module scope so `createModuleStore` stays inside the measured
 *  `max-lines-per-function` ceiling — these five touch one entry and nothing else. */
function entryFor(entries: Map<string, Entry>, id: string): Entry {
  const held = entries.get(id)
  if (held) return held
  const fresh: Entry = {
    snapshot: null,
    seq: -1,
    pendingSeq: -1,
    hydrated: false,
    fetching: false,
    stale: false,
    subs: new Set()
  }
  entries.set(id, fresh)
  return fresh
}

/** Copied before iterating: a subscriber may unsubscribe from inside its own notification. */
function notify(entry: Entry): void {
  for (const cb of [...entry.subs]) cb()
}

/** Take a reply. NO SNAPSHOT IS AN ANSWER, and it is the engine-absent one (contract 1): nothing
 *  is held and nothing is invented, and the cursor is left where it was — a null reply reports
 *  none. The view draws its loading/unavailable state until a cursor or a rebuild says to re-ask. */
function absorb(entry: Entry, snap: ModuleSnapshot | null): void {
  entry.fetching = false
  entry.hydrated = true
  entry.snapshot = snap ? snap.state : null
  if (snap) entry.seq = snap.seq
}

/** Buffer the newest cursor heard while a fetch was in flight — contract 2. */
function noteCursor(entry: Entry, seq: number): void {
  if (seq > entry.pendingSeq) entry.pendingSeq = seq
}

/**
 * Is ANY module being read right now? DERIVED from the subscriber Sets rather than kept as a
 * counter beside them, and the difference is worth the loop: a counter is a second source of truth
 * for the same fact, and the failure mode when it drifts is not a leak but a store that has
 * DETACHED from the bridge while readers are still mounted — data that silently stops updating,
 * with nothing in the app saying so. Twenty-odd modules make this loop free, and it cannot
 * disagree with the thing it is counting.
 */
function watched(entries: Map<string, Entry>): boolean {
  for (const entry of entries.values()) {
    if (entry.subs.size > 0) return true
  }
  return false
}

/** Everything held stops describing the world (a character switch). */
function resetEntry(entry: Entry): void {
  entry.snapshot = null
  entry.seq = -1
  entry.pendingSeq = -1
  entry.hydrated = false
  entry.fetching = false
  entry.stale = false
}

/**
 * Build a store over one bridge and one scheduler.
 *
 * The inner functions are `function` declarations rather than consts because they are mutually
 * recursive by design — a fetch that lands behind a cursor re-arms the flush that fetches it —
 * and hoisting is what lets them be written in reading order instead of in dependency order.
 */
export function createModuleStore(deps: {
  bridge: ModuleBridge
  schedule: (run: () => void) => void
}): ModuleStore {
  const { bridge, schedule } = deps
  const entries = new Map<string, Entry>()
  const dirty = new Set<string>()
  let armed = false
  /** Bumped whenever every held snapshot stops describing the world. Replies from an older
   *  generation are dropped on arrival. */
  let generation = 0
  let detach: (() => void) | null = null

  function markDirty(id: string): void {
    dirty.add(id)
    if (armed) return
    armed = true
    schedule(flush)
  }

  function flush(): void {
    armed = false
    const ids = [...dirty]
    dirty.clear()
    for (const id of ids) hydrate(id)
  }

  function hydrate(id: string): void {
    const entry = entryFor(entries, id)
    entry.fetching = true
    entry.stale = false
    entry.pendingSeq = -1
    const born = generation
    void bridge.getModuleSnapshot(id).then((snap) => {
      // A reply taken from a world that has since been rebuilt describes a character nobody is
      // looking at any more. Dropping it is the whole job of the generation counter.
      if (born !== generation) return
      absorb(entry, snap)
      notify(entry)
      // …AND THE CURSOR THAT LANDED DURING THE FETCH. It cannot simply be dropped: the reply it
      // raced may have been taken from the engine BEFORE that cursor moved, and no later frame
      // restates a cursor already reported.
      if (entry.pendingSeq > entry.seq) markDirty(id)
    })
  }

  function onCursor(c: ModuleChanged): void {
    // The world that answers reads changed hands (the engine went live, or went away). There is
    // no cursor to compare and nothing held is trustworthy: ask again, for everything watched.
    if (c.moduleId === MODULE_WORLD_CHANGED) {
      for (const [id, entry] of entries) {
        if (entry.subs.size > 0) markDirty(id)
        else entry.stale = true
      }
      return
    }
    const entry = entries.get(c.moduleId)
    if (!entry) return
    // Not settled yet: remember the newest cursor and let the in-flight fetch settle it.
    if (!entry.hydrated || entry.fetching) {
      noteCursor(entry, c.seq)
      return
    }
    if (c.seq <= entry.seq) return // we already hold this cursor
    // NOBODY IS READING THIS MODULE. Record that the cache went stale and spend no IPC on it;
    // the next subscriber pays for the refresh, and gets the cached snapshot meanwhile.
    if (entry.subs.size === 0) entry.stale = true
    else markDirty(c.moduleId)
  }

  function onCharacterSwitch(): void {
    generation += 1
    dirty.clear()
    for (const [id, entry] of entries) {
      resetEntry(entry)
      if (entry.subs.size === 0) continue
      // Told first — every reader is back to `null`, which is the true answer for this instant —
      // and asked immediately rather than a frame later: a character switch is not a 10 Hz event.
      notify(entry)
      hydrate(id)
    }
  }

  function attach(): void {
    const offChanged = bridge.onModuleChanged(onCursor)
    const offChar = bridge.onCharacter(onCharacterSwitch)
    detach = (): void => {
      offChanged()
      offChar()
    }
  }

  /** The last subscriber left. Header: a cache whose invalidation channel is closed is not one. */
  function release(): void {
    detach?.()
    detach = null
    entries.clear()
    dirty.clear()
    generation += 1
  }

  return {
    subscribe(moduleId, onChange) {
      const idle = !watched(entries)
      const entry = entryFor(entries, moduleId)
      // CONTRACT 2 — the callback is registered before anything is fetched.
      entry.subs.add(onChange)
      if (idle) attach()
      // One fetch for N subscribers: the second through Nth arrive while `fetching` is true.
      if ((!entry.hydrated || entry.stale) && !entry.fetching) hydrate(moduleId)
      return () => {
        // Idempotent: a second call finds nothing to remove and must not close a live store.
        if (!entry.subs.delete(onChange)) return
        if (!watched(entries)) release()
      }
    },
    getSnapshot(moduleId) {
      return entries.get(moduleId)?.snapshot ?? null
    }
  }
}
