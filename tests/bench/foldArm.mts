/**
 * ============================================================================
 * foldArm.mts — WHERE THE STARTUP FOLD GOES, microsecond by microsecond (JOS-55).
 * ============================================================================
 *
 * The measured fact this exists to break down: the parser alone folds the owner's 1.4M-event log
 * at ~565k events/sec (1.8 us/event) while the whole pipeline manages ~32k (31 us/event). About
 * 94% of a startup replay happens DOWNSTREAM of the parser, and until this file nothing said in
 * which consumer. `replay.bench.mts` prints the table this produces; JOS-56 bisects with it.
 *
 * WHY THIS FOLD RUNS IN THE BENCH'S OWN PROCESS, not in the app it launches.
 *   The instrumentation is a parameter — `registry.attach(bus, timer)` and `new LogBus(probe)` —
 *   for exactly the reason `replaySlicer.ts` states about its own seam: an environment variable
 *   that installs a per-event profiler on a real startup is a knob a support answer will
 *   eventually recommend. A parameter is visible to this file and to nobody else. But a parameter
 *   can only be passed by a caller in the same process, and the bench cannot reach inside the
 *   Electron app it launches. So the Electron arm stays exactly what it was (wall clock, duty,
 *   block probe, the budgets), and the ATTRIBUTION arm folds the same log here, through the same
 *   modules, in the same order.
 *
 * WHAT MAKES "THE SAME MODULES" TRUE RATHER THAN CLAIMED: `src/main/modules/wiring.ts` owns the
 *   construction and the registration order, and pipeline.ts — the app's composition root — is its
 *   other caller. A module added to the app is folded here without anyone remembering to update a
 *   list. The bus, the combat engine, the epoch and offline-gap detectors are wired below in the
 *   order pipeline.ts and index.ts wire them, and that order IS the delivery order.
 *
 * WHAT IS HONESTLY DIFFERENT, because a profiler that hides its own distortions is worthless:
 *   * No Electron. Same V8, same code, but no renderer, no IPC, no protocol handlers and no
 *     window competing for the main thread. The Electron arm's `events/sec folding` is printed
 *     beside this arm's rate so the two can be compared rather than confused.
 *   * No duty cycle (`unchunkedSlicer()`): this arm measures the fold's SPEED, not the throttle.
 *   * The two knowledge lookups (item, mob) are absent and the alert defs are empty. All three are
 *     LIVE-only paths — a historical replay never calls them — but say so rather than imply they
 *     were measured.
 *   * The user's learned message overlay lives in userData, which is Electron's to find; this arm
 *     seeds the miner with the committed baseline alone. It changes which cast messages the parser
 *     recognizes at the margin, not the shape of the fold.
 */
import { createReadStream } from 'node:fs'
import { CombatEngine } from '../../src/main/combat/engine'
import { ENGINE_SECTIONS, type EngineFoldProbe } from '../../src/main/combat/foldProbe'
import { EpochDetector } from '../../src/main/log/epochDetector'
import { LogBus, type LogBusProbe, type LogEventListener } from '../../src/main/log/bus'
import { ModuleRegistry, type ModuleDispatchTimer } from '../../src/main/modules/registry'
import { SessionDetector } from '../../src/main/log/sessionDetector'
import { createModules } from '../../src/main/modules/wiring'
import { installCharacterName, installSpellDb } from '../../src/main/log/rulesets'
import { MobLootIndex } from '../../src/main/mobLookupParse'
import { scanLog } from '../../src/main/log/scanHistory'
import { unchunkedSlicer, type Slicer } from '../../src/main/log/replaySlicer'
import baselineJson from '../../src/main/data/messageOverlay.baseline.json'
import type { MessageOverlay } from '../../src/shared/types'

/** The committed baseline overlay as a seed, imported directly — `data/overlayPersistence.ts`
 *  reaches for Electron's `app` to find the user's copy and cannot be imported outside it. The
 *  key is what the miner files its counts under (JOS-231); the bench seeds the baseline alone. */
const BASELINE = { key: 'baseline', counts: baselineJson as unknown as MessageOverlay }

// ------------------------------------------------------------------------------ the accumulator

/** One row of the attribution table: a consumer, how many events it saw, what they cost it. */
export interface ConsumerCost {
  consumer: string
  events: number
  totalMs: number
}

/** One row of the ENGINE's own sub-table (JOS-59): a section of combat/** and what it cost. */
export interface SectionCost {
  section: string
  totalMs: number
}

/**
 * THE ENGINE'S SECTION TIMER (JOS-59) — the bench half of `combat/foldProbe.ts`.
 *
 * A STACK, not a flat mark. The engine's work nests (route → resolve → aggregate → ring, with
 * `classify` re-entered underneath the analytics fold), so time is charged to whichever section
 * is INNERMOST and released back to its parent on `leave`. The rows are therefore disjoint and
 * sum to the whole of `ingestEvent`, which is the same number the JOS-55 table's `combat engine`
 * row reports — the two can be checked against each other, and the printout does.
 *
 * ONE clock read per transition, the same economy `ModuleRegistry`'s timed dispatch uses: a
 * boundary is both an end and a beginning, so reading `performance.now()` once and differencing
 * it against the previous reading costs half what a naive before/after pair would.
 */
class SectionTimer implements EngineFoldProbe {
  readonly ms: number[] = ENGINE_SECTIONS.map(() => 0)
  private stack: number[] = []
  private depth = 0
  private t0 = 0

  enter(section: number): void {
    const now = performance.now()
    if (this.depth > 0) this.ms[this.stack[this.depth - 1]] += now - this.t0
    this.stack[this.depth++] = section
    this.t0 = now
  }

  leave(): void {
    const now = performance.now()
    if (this.depth > 0) {
      this.ms[this.stack[--this.depth]] += now - this.t0
    }
    this.t0 = now
  }

  rows(): SectionCost[] {
    return ENGINE_SECTIONS.map((section, i) => ({ section, totalMs: this.ms[i] ?? 0 }))
  }
}

/**
 * The whole instrument: a `ModuleDispatchTimer` for the registry and a `LogBusProbe` for the bus,
 * in one object because they share one fact — whether the events currently being delivered are
 * PRIMARY or a DERIVED drain.
 *
 * That flag is why the drain gets its own row instead of being an invisible surcharge on every
 * module's number. A derived event (`buffExpired`, `epoch`, `offlineGap`) travels the same
 * listener loop as a primary one, so without the bracket every consumer's total would silently
 * include work done on somebody else's behalf and the rows would not add up to the fold.
 *
 * Accumulators are plain arrays indexed by dispatch position: `note()` runs once per module per
 * event — 18 million times on this log — and an array add is a cost the measurement can afford
 * where a map lookup is a cost it would end up measuring.
 */
class FoldTimer implements ModuleDispatchTimer, LogBusProbe {
  private ids: readonly string[] = []
  private moduleMs: number[] = []
  /** Time modules spent on DERIVED events, kept apart so the rows stay disjoint. */
  private derivedModuleMs: number[] = []
  private inDerived = false
  /** Primary events dispatched to the modules (counted at position 0). */
  private primaryEvents = 0
  private derivedEvents = 0
  private derivedMs = 0
  /** The tail consumers (combat, epoch, offline-gap) — subscribed after the registry. */
  private tail = new Map<string, { primaryMs: number; derivedMs: number; events: number }>()

  begin(ids: readonly string[]): void {
    this.ids = ids
    this.moduleMs = ids.map(() => 0)
    this.derivedModuleMs = ids.map(() => 0)
  }

  note(index: number, ms: number): void {
    if (this.inDerived) {
      this.derivedModuleMs[index] = (this.derivedModuleMs[index] ?? 0) + ms
      return
    }
    if (index === 0) this.primaryEvents += 1
    this.moduleMs[index] = (this.moduleMs[index] ?? 0) + ms
  }

  start(): void {
    this.inDerived = true
  }

  end(count: number, ms: number): void {
    this.inDerived = false
    this.derivedEvents += count
    this.derivedMs += ms
  }

  /**
   * Wrap a bus listener so its time lands in a named row. Used for the three consumers that
   * subscribe AFTER the registry — the combat engine, the epoch detector and the offline-gap
   * detector — none of which the registry seam can see.
   *
   * The engine is ONE OPAQUE ROW on purpose (JOS-55): its internals are another ticket's subject
   * (JOS-52), and a bench that reached inside them would be measuring a moving target.
   */
  wrap(name: string, fn: LogEventListener): LogEventListener {
    this.tail.set(name, { primaryMs: 0, derivedMs: 0, events: 0 })
    const row = this.tail.get(name)
    return (ev, live) => {
      const t0 = performance.now()
      fn(ev, live)
      const dt = performance.now() - t0
      if (!row) return
      if (this.inDerived) row.derivedMs += dt
      else {
        row.primaryMs += dt
        row.events += 1
      }
    }
  }

  /**
   * The table's rows, PRIMARY work per consumer plus ONE row for the whole derived drain (every
   * consumer's work on derived events, summed — the drain is a shared cost and splitting it per
   * consumer would invite reading a 0.2% row as a finding).
   */
  rows(): ConsumerCost[] {
    const out: ConsumerCost[] = this.ids.map((id, i) => ({
      consumer: `module:${id}`,
      events: this.primaryEvents,
      totalMs: this.moduleMs[i] ?? 0
    }))
    for (const [name, row] of this.tail) {
      out.push({ consumer: name, events: row.events, totalMs: row.primaryMs })
    }
    out.push({
      consumer: 'derived-event drain',
      events: this.derivedEvents,
      totalMs: this.derivedMs
    })
    return out
  }
}

// ------------------------------------------------------------------------------------ the world

/** What a caller may install into the world besides the modules themselves. */
export interface WorldOpts {
  /** The JOS-55 attribution seam. */
  timer?: FoldTimer
  /** The JOS-59 engine-section probe. */
  sections?: SectionTimer
  /**
   * A listener subscribed BEFORE the registry attaches — i.e. ahead of all 20 modules and of
   * every tail consumer. The golden recorder (JOS-465) uses it: phase 1's artifact is what the
   * PARSER emitted, and the only place that is observable unmodified is the head of the
   * registration order.
   */
  observe?: LogEventListener
  /**
   * PIN THE CONSTRUCTION CLOCK (JOS-465). `RespawnModule` seeds its ordering clock from
   * `Date.now()` at construction and at `reset()` — correctly, a fresh fold is entitled to
   * today's reading (`tests/foldDeterminism.test.mts` says so by name) — and nothing advances it
   * during a bench fold, so it survives into `snapshot()` and ORDERS THE ROWS. That makes a
   * respawn snapshot a statement about WHEN THE WORLD WAS BUILT, and a golden recorded on Monday
   * would not re-check on Tuesday.
   *
   * So the recorder passes an instant derived from the LOG — the same class of value the combat
   * oracle's `now` is — and the world is constructed under it. Absent (every timing arm, and
   * `foldForOracle`), nothing is pinned and the behaviour is exactly what it always was.
   *
   * The pin covers CONSTRUCTION ONLY. The fold itself is audited separately and reads no clock
   * at all (`tests/foldDeterminism.test.mts`), which is the guarantee that makes the pin
   * sufficient rather than merely helpful.
   */
  constructionNowMs?: number
}

/** The world's handles: everything a caller might need to read state back out of. */
export interface World {
  bus: LogBus
  combat: CombatEngine
  registry: ModuleRegistry
  /** `modules.ordered`' ids, in registration order — the order wiring.ts declares. */
  moduleIds: string[]
}

/**
 * Build the fold's consumers exactly as the app builds them: the module registry over
 * `createModules`' ordered list, then the combat engine (with the roster seam installed before it
 * ever folds a line), then the epoch and offline-gap detectors LAST — the order pipeline.ts and
 * index.ts subscribe them in, which is the order the bus delivers in.
 */
function buildWorld(
  character: { name: string; server: string; logPath: string },
  opts: WorldOpts = {}
): World {
  const { timer, sections } = opts
  const realNow = Date.now
  if (opts.constructionNowMs !== undefined) {
    const pinned = opts.constructionNowMs
    Date.now = (): number => pinned
  }
  try {
    return construct(character, opts, timer, sections)
  } finally {
    Date.now = realNow
  }
}

/** buildWorld's body, split out so the clock pin above is a plain try/finally around one call. */
function construct(
  character: { name: string; server: string; logPath: string },
  opts: WorldOpts,
  timer?: FoldTimer,
  sections?: SectionTimer
): World {
  const bus = new LogBus(timer)
  if (opts.observe) bus.subscribe(opts.observe)
  const modules = createModules({
    overlays: [BASELINE],
    // The shared own-loot index the consider module folds every loot event into. Electron-free,
    // and omitting it would skip a real per-event cost.
    ownLoot: new MobLootIndex(),
    emitDerived: (ev, live) => {
      bus.emitDerived(ev, live)
    }
  })
  const registry = new ModuleRegistry({ emitDelta: () => undefined })
  for (const mod of modules.ordered) registry.register(mod)
  registry.reset()
  modules.character.setCharacter(character)
  // Whose log this is — the self-`/who` rule can only fire once the parser knows the name, and
  // session.ts installs it before the replay for exactly that reason.
  installCharacterName(character.name)
  registry.attach(bus, timer)

  const combat = new CombatEngine()
  if (sections) combat.attachFoldProbe(sections)
  combat.setRoster(modules.roster)
  combat.reset()
  combat.setPlayerName(character.name)
  const epoch = new EpochDetector()
  const sessions = new SessionDetector()

  const ingest: LogEventListener = (ev, live) => {
    combat.ingestEvent(ev, live)
  }
  // The epoch and offline-gap subscriptions as index.ts writes them, minus the two things a
  // historical fold never does anyway: the boundary log line and the LIVE re-hydrate push.
  const observeEpoch: LogEventListener = (ev, live) => {
    if (ev.kind === 'epoch') return
    const epochEv = epoch.observe(ev)
    if (epochEv) bus.emitDerived(epochEv, live)
  }
  const observeSession: LogEventListener = (ev, live) => {
    if (ev.kind === 'offlineGap') return
    const gap = sessions.observe(ev)
    if (gap) bus.emitDerived(gap, live)
  }
  bus.subscribe(timer ? timer.wrap('combat engine', ingest) : ingest)
  bus.subscribe(timer ? timer.wrap('epoch detector', observeEpoch) : observeEpoch)
  bus.subscribe(timer ? timer.wrap('offline-gap detector', observeSession) : observeSession)
  return { bus, combat, registry, moduleIds: modules.ordered.map((m) => m.id) }
}

/**
 * THE GOLDEN RECORDER'S FOLD (JOS-465): `foldForOracle` widened by exactly two things — a
 * pre-module observer and a pinned construction clock — and handing back the REGISTRY as well as
 * the engine, because phase 2's artifact is every module's published snapshot.
 *
 * `slicer` is a parameter for the slicer-invariance pin: the same recorder is run under
 * `unchunkedSlicer()` and under the budgeted/resting arms and the artifacts must not move
 * (`tests/replayChunking.test.mts`'s 5-arm precedent, applied to the whole world instead of one
 * module). A golden is only accepted once that holds.
 */
export async function foldForGoldens(
  character: { name: string; server: string; logPath: string },
  opts: { observe?: LogEventListener; constructionNowMs: number; slicer?: Slicer }
): Promise<{ world: World; events: number; lastTs: number }> {
  const world = buildWorld(character, {
    observe: opts.observe,
    constructionNowMs: opts.constructionNowMs
  })
  let lastTs = 0
  world.bus.subscribe((ev) => {
    if (ev.ts > lastTs) lastTs = ev.ts
  })
  const res = await scanLog(character.logPath, world.bus, 0, {
    slicer: opts.slicer ?? unchunkedSlicer()
  })
  return { world, events: res.seq, lastTs }
}

/**
 * THE LAW-8 ORACLE'S FOLD (JOS-59): the same world as every arm above, folded once, with the
 * ENGINE handed back so its snapshots can be read. `engineOracle.mts` is the only caller — the
 * timing arms deliberately throw the engine away, because a fold that also had to keep a
 * snapshotable handle alive is not quite the fold the app runs.
 */
export async function foldForOracle(character: {
  name: string
  server: string
  logPath: string
}): Promise<{ combat: CombatEngine; events: number; lastTs: number }> {
  const { bus, combat } = buildWorld(character, {})
  let lastTs = 0
  bus.subscribe((ev) => {
    if (ev.ts > lastTs) lastTs = ev.ts
  })
  const res = await scanLog(character.logPath, bus, 0, { slicer: unchunkedSlicer() })
  return { combat, events: res.seq, lastTs }
}

// ------------------------------------------------------------------------------------- the arms

export interface FoldResult {
  events: number
  ms: number
  eventsPerSec: number
  /** Present only on the attributed arm. */
  rows?: ConsumerCost[]
  /** Present only on the ENGINE-SECTION arm (JOS-59). */
  sections?: SectionCost[]
}

const rate = (events: number, ms: number): number => (ms > 0 ? Math.round((events / ms) * 1000) : 0)

/**
 * Read the log once and throw the bytes away, so the FIRST timed arm is not the one that pays for
 * a cold page cache. 109 MB off an NVMe is not seconds — but it is not nothing either, and it
 * lands entirely on whichever arm runs first, which would make the arms incomparable for a reason
 * that has nothing to do with what any of them measure.
 */
export async function warmPageCache(logPath: string): Promise<number> {
  const t0 = performance.now()
  const stream = createReadStream(logPath, { highWaterMark: 1 << 20 })
  for await (const chunk of stream) void (chunk as Buffer).length
  return performance.now() - t0
}

/**
 * THE COMPARATOR ARM: `scanLog` with NO subscribers — read, split, parse, emit to an empty
 * listener list. It replaces a throwaway script whose 565k events/sec number is quoted in
 * replay.bench.mts's own header and could not be reproduced from anything committed.
 *
 * IT RUNS TWICE, and the difference between the two runs is the point.
 *
 *   `spellDb: true` — the parser THE APP ACTUALLY INSTALLS. `createModules` builds the effective
 *      spell DB (spells.json + the observed-message overlay) and installs it into the parser
 *      config, which is what turns on the message-driven buffApply/buffWearOff matching: ~1.9k
 *      spells' worth of cast-on-you / wear-off text, consulted per line. This is the honest
 *      comparator for the attributed fold, because a parser configured differently is a different
 *      parser and the subtraction between them would otherwise mean nothing.
 *   `spellDb: false` — the BARE parser, with no DB and no character name. This is almost certainly
 *      what the deleted throwaway measured, and it is here so the 565k/s number in the ledger's
 *      history has something committed to be compared against instead of remembered.
 *
 * The character name matters for the same reason the DB does: the self-`/who` rule cannot fire
 * without it (`installCharacterName`), and session.ts installs it before the replay for exactly
 * that reason.
 */
export async function foldParseOnly(
  character: { name: string; server: string; logPath: string },
  opts: { spellDb: boolean }
): Promise<FoldResult> {
  if (opts.spellDb) {
    createModules({ overlays: [BASELINE] })
    installCharacterName(character.name)
  } else {
    installSpellDb(undefined)
    installCharacterName(undefined)
  }
  const bus = new LogBus()
  const t0 = performance.now()
  const res = await scanLog(character.logPath, bus, 0, { slicer: unchunkedSlicer() })
  const ms = performance.now() - t0
  return { events: res.seq, ms, eventsPerSec: rate(res.seq, ms) }
}

/**
 * THE FULL FOLD: every consumer the app subscribes, over the same bytes.
 *
 * `timed` installs the attribution seam. Both modes exist so the profiler's own cost can be
 * stated rather than assumed — the bench runs the untimed arm on both sides of the timed one and
 * prints the difference beside the table.
 *
 * `unchunkedSlicer()` throughout: the duty cycle is a decision about wall clock, and this arm is
 * about the code's speed. The Electron arm reports the throttled reality.
 */
export async function foldFull(
  character: { name: string; server: string; logPath: string },
  timed: boolean
): Promise<FoldResult> {
  const timer = timed ? new FoldTimer() : undefined
  const { bus } = buildWorld(character, { timer })
  const t0 = performance.now()
  const res = await scanLog(character.logPath, bus, 0, { slicer: unchunkedSlicer() })
  const ms = performance.now() - t0
  return {
    events: res.seq,
    ms,
    eventsPerSec: rate(res.seq, ms),
    ...(timer ? { rows: timer.rows() } : {})
  }
}

/**
 * THE ENGINE-SECTION ARM (JOS-59): the same fold with ONLY the engine's own probe installed —
 * no per-module dispatch timer.
 *
 * ITS OWN ARM RATHER THAN A COLUMN ON THE TIMED ONE, deliberately. The section timer reads the
 * clock at every boundary inside `ingestEvent`, so installing it beside the registry timer would
 * inflate the `combat engine` row of the JOS-55 table — the very row this ticket has to quote
 * before and after. Kept apart, that table means exactly what it meant in JOS-58, and this arm's
 * numbers are read as SHARES OF THE ENGINE, which is the question it was built to answer.
 */
export async function foldSections(character: {
  name: string
  server: string
  logPath: string
}): Promise<FoldResult> {
  const sections = new SectionTimer()
  const { bus } = buildWorld(character, { sections })
  const t0 = performance.now()
  const res = await scanLog(character.logPath, bus, 0, { slicer: unchunkedSlicer() })
  const ms = performance.now() - t0
  return { events: res.seq, ms, eventsPerSec: rate(res.seq, ms), sections: sections.rows() }
}
