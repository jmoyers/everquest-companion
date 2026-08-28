// ============================================================================
// telemetry/breadcrumbs.ts — the last ten things this process saw happen (JOS-100, JOS-501).
// ============================================================================
//
// An error report says WHAT broke. A breadcrumb ring says WHAT THE APP WAS DOING when it did,
// which is the difference between "a TypeError in foldEvent" and "a TypeError in foldEvent,
// three damage lines after a zone change". That second sentence is a bug someone can reproduce.
//
// IT IMPORTS NOTHING, exactly like `./health.ts`, and for a stricter version of the same reason.
// health.ts is a leaf so `errorLog.ts` can bump a counter without closing a cycle; this file is
// a leaf so it can be called from the hottest paths in the process without dragging the store,
// the collector or Electron into that call stack.
//
// ---------------------------------------------------------------------------------------
// WHO FILLS IT — AND THE BOOT WINDOW THAT NOBODY COVERED (JOS-501)
// ---------------------------------------------------------------------------------------
// It was originally fed from `LogBus.emit`, once per parsed line. JOS-499 deleted the parser out
// of this process, and the ring got one producer back off the engine's CURSORS
// (`dataServer/serveDeltas.ts` — `module:<id>` when a module moves). That is the nearest true
// thing this process still sees about the world, and it is a good producer.
//
// It is also a producer THAT CANNOT FIRE UNTIL AN ENGINE IS CONNECTED, ATTACHED AND LIVE, which
// on the owner's real log is the better part of a minute after launch. So every crash in the boot
// window — which is where the interesting crashes are, because that is where the supervisor, the
// connect flow and the first attach all happen — produced a report with an EMPTY ring. The
// telemetry e2e asserted the ring was non-empty and was red for exactly this reason: it throws
// its injected error moments after the window comes up, long before a cursor could move.
//
// So the ENGINE'S OWN LIFECYCLE EDGES feed it too: spawned, ready, live, gone — and since JOS-519
// `cycled`, which is a gone that had first been ready. They are what happened, they are the only
// things that happen in that window, and a handful of them per launch cannot crowd out a busy tail
// (a live session spends all ten slots on cursors within a beat, which is correct — boot crumbs
// only matter for boot crashes).
//
// THE BRIGHT LINE HOLDS. An edge is a member of a closed set spelled out in this file; it names
// no log content, no path, no character, no port and no pid. `noteEngineEdge` takes no parameter
// one could travel in, which is the same shape argument the section below makes for event kinds.
//
// ---------------------------------------------------------------------------------------
// THE PERFORMANCE LAW, AND HOW THIS OBEYS IT
// ---------------------------------------------------------------------------------------
// `linesPending` (collector.ts) is a plain integer add because it fires once per parsed line,
// and the startup replay folds 1.35M of them. This fires on the same path. So:
//
//   * ZERO ALLOCATION PER EVENT. Two preallocated arrays of fixed length and a cursor. A push
//     is three slot writes and a modulo. Nothing is created, nothing is copied, and the ring
//     never grows, so it cannot make garbage for a GC to collect mid-replay.
//   * NO CLOCK READ PER EVENT. This is the decision worth reading twice. `Date.now()` per event
//     would be ~1.35M syscall-ish reads during a replay to produce offsets nobody would look at
//     unless the app crashed. Every `LogEvent` ALREADY CARRIES `ts` — the log's own timestamp,
//     parsed once, on the event — so the offsets come out of arithmetic the app had already
//     done, for free.
//   * NO STRING WORK. The kind is stored BY REFERENCE (the event's own `kind` string, which is
//     a literal from the parser); nothing is concatenated, formatted or interned.
//
// WHAT THAT COSTS, STATED RATHER THAN HIDDEN: offsets are in LOG TIME, measured back from the
// NEWEST breadcrumb. During a live tail log time and wall time agree to within a second and the
// number reads exactly as "how long before the crash". During a REPLAY it reads as the spacing
// of the historical lines being folded — which is the honest measurement for a replay-mode
// crash, since wall time there would say "0 ms" for all ten and mean nothing.
//
// ---------------------------------------------------------------------------------------
// A KIND IS NOT CONTENT, and that is the whole reason this is allowed to exist
// ---------------------------------------------------------------------------------------
// `damage` says a damage line was parsed. It does not say who hit what, for how much, in which
// zone, or with what. There is no parameter on `noteEventKind` that a name, an amount or a line
// could travel in even if a caller wanted to pass one — the same shape argument health.ts makes
// for its five counters. The vocabulary is the closed `LogEventKind` enum, and the wire
// validator refuses anything outside it.

/** Breadcrumbs kept. Ten is what a person reads; it is also `MAX_BREADCRUMBS` on the wire,
 *  restated rather than imported so this module keeps its no-imports property. */
const RING = 10

/** Offsets are rounded to this, and capped at `MAX_OFFSET_MS`. COARSE on purpose: the question
 *  a breadcrumb answers is "just before, or a while before", never "at 1,247 ms". */
const OFFSET_ROUND_MS = 100
const MAX_OFFSET_MS = 10 * 60_000

/** One breadcrumb as the wire carries it. Mirrors `TelemetryBreadcrumb` (shared/telemetry.ts). */
export interface Breadcrumb {
  kind: string
  offsetMs: number
}

// Preallocated and never reallocated. `kinds` holds references to the parser's own literals.
const kinds: string[] = new Array<string>(RING).fill('unknown')
const stamps = new Float64Array(RING)
/** Next slot to write. `written` is the total ever pushed, so `written < RING` means partial. */
let cursor = 0
let written = 0

/**
 * WHICH HALF OF THE APP IS RUNNING. It was taken from the registry's replay BRACKET
 * (`beginReplay`/`endReplay`) rather than from a per-event `live` flag, because JOS-60 settled
 * that question: a replay is a STATE, not a flag on each event, and two sources of truth for it is
 * how one of them ends up wrong. That registry is deleted (JOS-499) and nothing sets this any
 * more — see `noteReplaying` for why the setter and the wire enum outlive their producer.
 */
let replaying = false

/**
 * COUNT ONE PARSED EVENT. Called from `LogBus.emit` — the one choke point both feeders and the
 * derived-event drain pass through. See the header for why this is three writes and no clock.
 *
 * `ts` is the event's OWN timestamp (`LogEvent.ts`), already parsed. Nothing about the event
 * other than its kind is retained, and `kind` is a member of a closed enum.
 */
export function noteEventKind(kind: string, ts: number): void {
  kinds[cursor] = kind
  stamps[cursor] = ts
  cursor = (cursor + 1) % RING
  if (written < RING) written++
}

/**
 * THE ENGINE'S LIFECYCLE, AS BREADCRUMBS — the boot window's only producer (JOS-501).
 *
 * A CLOSED SET, and closed in the type system rather than by convention: the parameter is a union
 * of four literals, so there is no expression a caller could pass that carries a name, a path, a
 * port or a pid. That is deliberately stricter than `noteEventKind` above, which takes a `string`
 * because the parser's kinds are literals it owns; here the callers are ordinary application code
 * and the type is what keeps them honest.
 *
 * THE CLOCK IS READ HERE, unlike the per-event path. These fire at most a handful of times per
 * launch — not 1.35M — so the argument that made `Date.now()` unaffordable there does not apply,
 * and there is no log timestamp to borrow: an engine edge is a fact about THIS PROCESS, not about
 * anything in the log.
 */
export type EngineEdge =
  /** The supervisor spawned a child. The earliest thing this process can say about an engine. */
  | 'engine:spawned'
  /** A `hello` + `session.health` round trip answered — READY means proven, not started. */
  | 'engine:ready'
  /** Its fold on this log reached the tail; served reads start answering here. */
  | 'engine:live'
  /** The launch ended — a crash, a respawn's teardown, or quit. */
  | 'engine:gone'
  /**
   * A launch that had REACHED READY died and is being replaced (JOS-519). It always follows an
   * `engine:gone`, and the pair is the whole point: `spawned`/`gone` with no `ready` between them
   * is an engine that never started, while `ready`/`gone`/`cycled` repeating is an engine that
   * works and keeps dying — the shape behind "the log keeps catching up while I am in game", and a
   * completely different bug. A deliberate stop never emits it.
   */
  | 'engine:cycled'

export function noteEngineEdge(edge: EngineEdge): void {
  noteEventKind(edge, Date.now())
}

/**
 * The registry entered or left a historical replay.
 *
 * NO PRODUCT CALLER REMAINS (JOS-499): the registry whose bracket this mirrored was deleted with
 * the TypeScript fold, and this process does not replay anything any more — the engine folds in
 * another one. `currentMode()` therefore answers `'live'` always, which is not a lie but is a
 * constant.
 *
 * The setter and the wire's two-valued enum are kept rather than collapsed, and the reason is the
 * backend: reports produced by every build before the deletion are in the error store and carry
 * `mode: 'replay'`, so a reader that could not represent the value would misread its own history.
 * When that history ages out, this and `TELEMETRY_ERROR_MODES` retire together.
 */
export function noteReplaying(active: boolean): void {
  replaying = active
}

/** `'replay'` while the registry's bracket is open, `'live'` otherwise. */
export function currentMode(): 'live' | 'replay' {
  return replaying ? 'replay' : 'live'
}

/**
 * The ring, NEWEST FIRST, with offsets measured back from the newest entry — so the first
 * breadcrumb always reads `0` and the rest say how long before it they happened.
 *
 * Allocation happens HERE and only here: this runs once per captured error, not once per event.
 *
 * A NON-MONOTONIC STAMP READS AS ZERO rather than as a negative number. Log timestamps have
 * one-second resolution and a derived event inherits its parent's `ts`, so two crumbs sharing a
 * second (or arriving very slightly out of order across an epoch boundary) is ordinary — and a
 * negative offset would be refused by the wire validator, costing the whole report over a
 * rounding artefact.
 */
export function readBreadcrumbs(): Breadcrumb[] {
  if (written === 0) return []
  const out: Breadcrumb[] = []
  const newestAt = (cursor - 1 + RING) % RING
  const newest = stamps[newestAt]
  for (let i = 0; i < written; i++) {
    const at = (newestAt - i + RING) % RING
    const raw = newest - stamps[at]
    const offset = Number.isFinite(raw) && raw > 0 ? Math.round(raw / OFFSET_ROUND_MS) * OFFSET_ROUND_MS : 0
    out.push({ kind: kinds[at], offsetMs: Math.min(offset, MAX_OFFSET_MS) })
  }
  return out
}

/** Drop everything. Called on the collector's session boundaries, beside `resetHealth` — a
 *  switch turned off must not leave a session's crumbs waiting to ride the next report. */
export function resetBreadcrumbs(): void {
  cursor = 0
  written = 0
  replaying = false
  kinds.fill('unknown')
  stamps.fill(0)
}
