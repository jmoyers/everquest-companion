// The module registry: the single owner of the extension push loop.
//
// Responsibilities:
//   - hold the registered modules (registration order = bus delivery order),
//   - subscribe each to the LogBus so they fold every event,
//   - after LIVE events, schedule a trailing ~100ms flush; for each module a
//     non-null flushDelta() is pushed to the renderer as `module:delta`,
//   - answer `module:getSnapshot(id)` by returning that module's snapshot().
//
// During historical replay (live:false) modules fold silently and NO flush is
// scheduled — the renderer hydrates via getSnapshot once, then rides deltas. The
// seq on every delta/snapshot is the last LogEvent seq the module consumed, which
// the renderer uses for gap detection + dupe rejection.
//
// "SILENTLY" USED TO MEAN "NO FLUSH IS SCHEDULED", WHICH IS NOT THE SAME THING (JOS-60).
// Modules ACCUMULATE their pending deltas while folding — no `onEvent` in the tree looks at
// `live` before appending to its pending list — so the replay leaves a full delta sitting in
// every module. Two callers then shipped it: `tick()`, driven by session.ts's 1-second wall-clock
// heartbeat, which belongs to the PREVIOUS character and keeps firing straight through the new
// one's replay; and the `flushNow()` at the end of `tailCharacter`, one statement before
// `log:character`. Either way the renderer received ANOTHER CHARACTER'S ENTIRE HISTORY as an
// INCREMENT against the state it was still holding — and an increment is exactly what every
// always-mounted celebration detector is watching for. MEASURED on a padded two-character e2e
// install: a `kills` delta carrying a boss the previous character never killed, delivered 1.7 s
// before `log:character`, firing the seeded bossDefeat alert on every switch back.
//
// So a replay is now a STATE, not just a flag on each event: `beginReplay()` / `endReplay()`
// bracket it, nothing is pushed while it is in flight, and what it accumulated is DISCARDED
// rather than flushed. Discarding loses nothing — everything the replay folded is in
// `snapshot()`, and `log:character` makes every consumer re-hydrate from exactly that.

import type { EqModule, ModuleDelta } from './types'
import type { LogBus, LogEventListener } from '../log/bus'
// A leaf with no imports of its own (see its header), so this cannot participate in a cycle.
import { noteReplaying } from '../telemetry/breadcrumbs'
// Likewise a leaf (`perfAttribution.ts`'s header states the rule it keeps for exactly this import).
import { timeSeam } from '../perfAttribution'

const FLUSH_THROTTLE_MS = 100

export interface RegistryHost {
  /** Push a `module:delta` to the renderer. */
  emitDelta(delta: ModuleDelta): void
}

/**
 * THE ATTRIBUTION SEAM (JOS-55): who spends the startup fold.
 *
 * MEASURED: parsing the owner's 1.4M-event log alone runs at 565k events/sec, and the whole
 * pipeline at ~32k — so ~94% of a startup replay happens downstream of the parser and, until this
 * existed, nothing said which consumer it happened in. This interface is how `npm run bench:replay`
 * finds out: it is handed to `attach()` and the registry installs a TIMED dispatch loop instead of
 * the plain one.
 *
 * A PARAMETER, NOT AN ENVIRONMENT VARIABLE — the `replaySlicer.ts` precedent, and the same
 * argument: a knob that installs a per-event profiler on a real user's startup is a knob a support
 * answer will eventually recommend. A seam in the signature is visible to the bench and to nobody
 * else, and the branch is taken ONCE, at attach: a normal boot subscribes the same closure it
 * always did, with no timer, no clock reads and no test per event.
 *
 * `note(index, ms)` rather than `note(id, ms)` because it is called once per MODULE per EVENT —
 * 18 million times on this log — and an array index add is a cost the measurement can afford where
 * a map lookup is a cost it would end up measuring.
 */
export interface ModuleDispatchTimer {
  /** The modules about to be dispatched, in delivery order. Called once, from `attach`. */
  begin(ids: readonly string[]): void
  /** Module `index` folded one event in `ms`. HOT — keep it to an array write. */
  note(index: number, ms: number): void
}

export class ModuleRegistry {
  private modules: EqModule[] = []
  private byId = new Map<string, EqModule>()
  private unsub: (() => void) | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * True while a HISTORICAL REPLAY is folding (see the header). Every push path checks it, so
   * there is one answer to "may a delta leave this process right now" rather than one per caller.
   */
  private replaying = false

  constructor(private host: RegistryHost) {}

  /** Register in delivery order. Call before wiring to the bus. */
  register(mod: EqModule): void {
    this.modules.push(mod)
    this.byId.set(mod.id, mod)
  }

  /**
   * Every registered module, in delivery order. Read-only, and it exists for ONE caller: the fold
   * checkpoint (JOS-208) has to ask each module whether it can serialize itself, and asking means
   * having the list. A getter rather than a `checkpointables()` method, because the registry has no
   * business knowing what a checkpoint is — it owns the push loop and nothing else.
   */
  list(): readonly EqModule[] {
    return this.modules
  }

  /**
   * The registered module with this id, if any. Deliberately NOT generic: a type parameter
   * appearing once in a signature is just a cast wearing a `<>`, and it let a caller name any
   * type it liked with no evidence. A module's `snapshot().state` is `unknown` by design —
   * the caller narrows it at its own boundary, where the id and the shape are read together.
   */
  get(id: string): EqModule | undefined {
    return this.byId.get(id)
  }

  /**
   * Subscribe every module to the bus (registration order). Returns unsubscribe.
   *
   * `timer` is the bench's attribution seam (see ModuleDispatchTimer) and is absent everywhere
   * else. The choice is made HERE, once, so a normal boot's dispatch loop is byte for byte the
   * one that existed before JOS-55.
   */
  attach(bus: LogBus, timer?: ModuleDispatchTimer): () => void {
    const off = bus.subscribe(timer ? this.timedDispatch(timer) : this.dispatch())
    this.unsub = off
    return off
  }

  /** The ordinary dispatch: every module, in order, and a trailing flush after a LIVE event. */
  private dispatch(): LogEventListener {
    return (ev, live) => {
      for (const mod of this.modules) mod.onEvent(ev, live)
      if (live) this.scheduleFlush()
    }
  }

  /**
   * The same dispatch, clocked BETWEEN modules: one `performance.now()` before the first and one
   * after each, so module i's cost is the difference of two consecutive readings. N+1 clock reads
   * per event rather than 2N — the cheapest honest per-module attribution there is, and the bench
   * states what even that costs (a timed run against an untimed one).
   */
  private timedDispatch(
    timer: ModuleDispatchTimer
  ): LogEventListener {
    const mods = this.modules
    timer.begin(mods.map((m) => m.id))
    return (ev, live) => {
      let t = performance.now()
      for (let i = 0; i < mods.length; i++) {
        mods[i]?.onEvent(ev, live)
        const t1 = performance.now()
        timer.note(i, t1 - t)
        t = t1
      }
      if (live) this.scheduleFlush()
    }
  }

  /** Reset every module (character (re)load) and drop any pending flush. */
  reset(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    for (const mod of this.modules) mod.reset()
  }

  /**
   * A historical replay is starting: nothing may be pushed until `endReplay()`.
   *
   * Idempotent, and it drops any flush the PREVIOUS character's last live event had already
   * scheduled — that timer would otherwise fire mid-replay and push a delta describing a world
   * that no longer exists.
   */
  beginReplay(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.replaying = true
    // AN ERROR REPORT'S `mode` READS FROM THIS BRACKET (JOS-100), not from a per-event `live`
    // flag — the JOS-60 rule that a replay is a STATE, applied to one more consumer. Two
    // sources of truth for "are we replaying" is how one of them ends up wrong.
    noteReplaying(true)
  }

  /**
   * The replay is over: DISCARD everything it accumulated.
   *
   * Draining `flushDelta()` and throwing the results away is the whole point — it is how each
   * module's pending list gets cleared without the renderer ever seeing it, so the first delta
   * after a switch describes LIVE events only. The full historical state is served by
   * `snapshot()`, which `log:character` sends every consumer back to.
   */
  endReplay(): void {
    if (!this.replaying) return
    this.replaying = false
    noteReplaying(false)
    for (const mod of this.modules) mod.flushDelta()
  }

  /** Full snapshot for `module:getSnapshot`. Null when the id is unknown. */
  snapshot(id: string): { seq: number; state: unknown } | null {
    return this.byId.get(id)?.snapshot() ?? null
  }

  /**
   * Wall-clock heartbeat (Task #30). Advance every module's optional onTick, then
   * run the SAME flush path as live events (deltas push only when a module went
   * dirty). Called ~1×/sec from session.ts with Date.now() while the live tail runs —
   * never during historical replay — so real-time deadlines (buffs' 15s land
   * timeout) fire even when the log is idle.
   */
  tick(nowMs: number): void {
    // NOT DURING A REPLAY (JOS-60). The heartbeat's interval outlives a character switch, so this
    // fires while the NEXT character's history is still folding — and a wall-clock deadline
    // evaluated against a half-rebuilt world is meaningless even before the push it used to do.
    // session.ts stops the heartbeat around a replay as well; this is the structural half.
    if (this.replaying) return
    for (const mod of this.modules) mod.onTick?.(nowMs)
    this.doFlush()
  }

  /**
   * Flush every module now (used to push a character-switch immediately).
   *
   * A TIMED SEAM (JOS-458): this is every module folding its pending delta at once, on the loop,
   * because an out-of-band write asked it to — the shape of work that can hold main for the
   * hundreds of milliseconds two field reports describe. The THROTTLED path (`scheduleFlush` →
   * `doFlush`) is deliberately not timed: it is the steady state, it is already bounded by
   * `FLUSH_THROTTLE_MS`, and timing it would fill the seam ring with the app behaving normally.
   */
  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    timeSeam('registryFlush', () => {
      this.doFlush()
    })
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.doFlush()
    }, FLUSH_THROTTLE_MS)
  }

  private doFlush(): void {
    // THE ONE GATE every push path funnels through — see `beginReplay`.
    if (this.replaying) return
    for (const mod of this.modules) {
      const out = mod.flushDelta()
      if (out) this.host.emitDelta({ moduleId: mod.id, seq: out.seq, delta: out.delta })
    }
  }
}
