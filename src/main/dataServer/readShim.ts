// ============================================================================
// readShim.ts — WHICH WORLD ANSWERS A READ, AND WHAT HAPPENS WHEN THE ENGINE CANNOT (JOS-489).
// ============================================================================
//
// THE COMPAT SHIM. Three fold-derived read IPCs — `module:getSnapshot`, `combat:snapshot`,
// `combat:searchFights` — are answered by asking the ENGINE. This file is the decision and what
// happens when the engine cannot answer; `serveShim.ts` is the wiring that gives it a real
// connection, and `src/main/ipc/world.ts` is where the handlers sit.
//
// ── THERE IS NO SECOND ARM ANY MORE (JOS-499, and JOS-501 made this page say so) ────────────────
//
// This file was written when the flag `EQC_ENGINE_SERVE` chose PER CALL between the engine and this
// process's own TypeScript fold, and its whole design was "the shim must never make the app worse
// than the flag-off world". THE FLAGS AND THE FOLD ARE BOTH GONE. `own()` is still a thunk and still
// the thing that answers when the engine cannot — but what it now carries is the EMPTY SHAPE each
// channel owes its caller (`serveShim.ts`: `null` for a module snapshot, a `hydrating` meter, no
// search hits, no `dropsSeen`), never a second opinion about the world.
//
// So the law is the plainer one the deletion release rests on: **A READ THAT CANNOT BE SERVED SAYS
// SO, AND NEVER INVENTS.** Everything below still follows. Every way the engine can fail to answer —
// no engine on this launch, a connection that is not ready, an engine attached to some other log, an
// engine still folding, a refusal, a silence, an answer whose shape is not the answer — resolves to
// the empty shape rather than to an error, so a caller of these three channels sees a blank surface
// instead of a crash, and the reason is counted and named in the dev log.
//
// THAT INCLUDES SILENCE, which is the failure a promise-shaped arm adds that a synchronous handler
// never had. An engine that accepted a request and never replied would hang the renderer's `invoke`
// forever. So the engine arm carries a DEADLINE (`timeoutMs`) and the empty shape answers when it
// passes. The bound is on the pathological case, not a budget: a healthy loopback round trip to a
// process that has already folded the log is sub-millisecond.
//
// ── "A SERVED ANSWER THAT WOULD BE A GUESS FALLS BACK LIKEWISE" ────────────────────────────────
//
// A reply can arrive, pass the protocol's own result guard, and still not be an ANSWER to the
// question this app asked. The `project` callback is where a caller states what would make the
// reply real; returning `null` from it is the caller saying "this is a guess" and takes the same
// fallback path as a refusal. Two such tests exist today (`serveShim.ts`): a `module.snapshot` whose
// echoed `module` is not the one asked for, and a `combat.snapshot` whose `now` is nowhere near this
// process's wall clock — the second being the engine honestly stamping a mid-scan answer with the
// FOLD's clock (`CombatSnapshotResult.now`), which is a real prefix state and a false present.
//
// ── THE NOTE IS COALESCED, BECAUSE THE FAILURE MODE IS A BURST ─────────────────────────────────
//
// These three channels are polled: a hydrating window asks for a dozen module snapshots at once and
// the meter re-asks on a cadence. So a disconnected engine does not produce one dev-log line, it
// produces hundreds a second, and a line per call would bury the very narration a developer opened
// the log to read. Instead the reasons are TALLIED and one sentence is printed at most once per
// window, naming every reason and how many calls each took. Nothing is dropped from the count — a
// coalesced note that lied about how often it happened would be worse than no note.
//
// AND THE SENTENCE ITSELF HAS TO BE TRUE. It used to read "N reads answered by the app's own fold
// instead of the engine", which was accurate until JOS-499 deleted that fold and then quietly
// described the empty shape as a second world's answer — the most misleading thing a diagnostic can
// do, because a developer reading it would go looking for the fold that disagreed. It now names what
// actually happened: the read went UNSERVED and the caller got the empty shape.
//
// ── PURE, AND WITH NO APP IMPORTS ON PURPOSE ───────────────────────────────────────────────────
//
// It takes its connection, its clock, its log sink and its bounds as dependencies, so the whole
// decision-and-fallback matrix is a `node:test` unit driven by fake clients — connected,
// disconnected, idle, answering, erroring — with no Electron, no socket and no Rust binary
// (`tests/dataServerShim.test.mts`). The awkward cases are the point, and they are impossible to
// stage against a real engine.

import type { ParamsFor, RequestOp, ResultFor } from '../../shared/dataServer/ops'

/**
 * WHY A CALL DID NOT COME FROM THE ENGINE. A closed set, because every member is a different thing
 * for a developer to go and fix, and because the coalesced note tallies by it.
 *
 * The first four are READINESS — asked before a request is ever put on the wire — and the last
 * three are what a request that WAS sent can come back as.
 */
export type FallbackReason =
  /** This launch has no engine client at all: no binary on this checkout, or the engine died. */
  | 'noClient'
  /** There is a client, but its connection is not `ready` — connecting, failed or closed. */
  | 'notConnected'
  /** Connected, but the engine is not attached to the log THIS PROCESS folded. Two worlds on two
   *  files is the one state where an answer would be confidently about the wrong thing. */
  | 'notAttached'
  /** Attached to the right log, but its fold has not gone live — every answer is a real prefix
   *  state of the right file, and a prefix is not what a window hydrating in the product asked
   *  for. */
  | 'notLive'
  /** The engine answered with an error. */
  | 'refused'
  /** The engine did not answer inside the deadline. */
  | 'timedOut'
  /** The engine answered, and the answer was not one — see the header. */
  | 'guess'

/** What a developer reads. One phrase per reason, in the vocabulary the rest of the dev log uses. */
const REASON_PHRASE: Record<FallbackReason, string> = {
  noClient: 'no engine client on this launch',
  notConnected: 'the connection is not ready',
  notAttached: 'the engine is on another log',
  notLive: 'the engine is still folding',
  refused: 'the engine refused',
  timedOut: 'the engine did not answer in time',
  guess: 'the engine’s answer would have been a guess'
}

/** Is the engine in a state where its answers may be this app's answers? */
export type Readiness = { readonly ok: true } | { readonly ok: false; readonly why: FallbackReason }

/** READY, as a value — there is exactly one shape of yes. */
export const SERVABLE: Readiness = { ok: true }

/** What the engine arm produced: the served value, or the reason there is not one. */
export type ServeOutcome<T> =
  | { readonly served: true; readonly value: T }
  | { readonly served: false; readonly why: FallbackReason; readonly detail: string }

export interface ShimDeps {
  /** Connection-state awareness, asked fresh per call — see `engineClientHost.engineServeReadiness`. */
  readiness: () => Readiness
  /** The typed request bridge. Rejects rather than resolving when the engine refuses. */
  request: <O extends RequestOp>(op: O, params: ParamsFor<O>) => Promise<ResultFor<O>>
  /** Where the coalesced sentence goes. */
  note: (line: string) => void
  now: () => number
  /** How long the engine may take before the empty shape answers instead. */
  timeoutMs: number
  /** How often the coalesced note may be printed, at most. */
  noteEveryMs: number
  /**
   * A promise that resolves after `ms`, for the deadline. Injected so a unit can run the matrix on
   * a 5 ms bound without waiting on a real clock — and so nothing here has to know that a timer in
   * the main process must be `unref`'d (`serveShim.ts` knows).
   */
  delay: (ms: number) => Promise<void>
}

/** What `world.ts` calls. One method per shape of question, plus the two the probe seam needs. */
export interface ReadShim {
  /**
   * ASK THE ENGINE, AND FALL BACK TO THE EMPTY SHAPE FOR ANY REASON AT ALL.
   *
   * `project` turns the served result into the answer this channel owes its caller, or returns
   * `null` to say the reply was not an answer (see the header). `own` carries THE EMPTY SHAPE this
   * channel owes a caller it cannot answer — it is a thunk so it is not built at all when the
   * engine served. It was the TypeScript arm until JOS-499 deleted that fold; nothing behind it
   * folds anything now, and the note this file prints says so.
   *
   * `null` IS RESERVED FOR "NOT AN ANSWER", even where `T` is itself nullable — which the module
   * channel's is, since `registry.snapshot` answers `null` for an id this build does not carry.
   * That is unambiguous rather than lucky: none of the three ops has a legitimate null answer (the
   * engine refuses an unknown module with an error rather than serving one), so a `null` out of
   * `project` can only ever be the projection's own verdict.
   */
  serve: <O extends RequestOp, T>(
    op: O,
    params: ParamsFor<O>,
    project: (result: ResultFor<O>) => T | null,
    own: () => T
  ) => Promise<T>
  /**
   * THE ENGINE ARM ALONE — no fallback, no note. It exists for the e2e's parity seam, which must be
   * able to say "the engine answered THIS and the app answered THAT" rather than being handed
   * whichever one won. Nothing in the product calls it.
   */
  ask: <O extends RequestOp, T>(
    op: O,
    params: ParamsFor<O>,
    project: (result: ResultFor<O>) => T | null
  ) => Promise<ServeOutcome<T>>
  /** Print whatever the tally is holding, now. Called at teardown and by the unit. */
  flushNotes: () => void
}

/** The sentinel a raced deadline resolves with — a private object, so no result can impersonate it. */
const DEADLINE = Symbol('deadline')

/**
 * One rejection, as a phrase. `EngineError` carries the schema's own `code`, which is the half a
 * developer branches on, so it is quoted in front of the message when there is one.
 *
 * THE NON-ERROR ARM GOES THROUGH `JSON.stringify` RATHER THAN `String`, because a thrown object
 * stringifies to `[object Object]` — a fallback detail that names nothing is the same failure the
 * coalesced note exists to avoid, one level down.
 */
function describe(err: unknown): string {
  if (err === null || err === undefined) return 'no reason given'
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code
    return typeof code === 'string' ? `${code}: ${err.message}` : err.message
  }
  if (typeof err === 'string') return err
  if (typeof err === 'number' || typeof err === 'boolean' || typeof err === 'bigint') {
    return String(err)
  }
  try {
    return JSON.stringify(err) ?? 'an unserializable rejection'
  } catch {
    return 'an unserializable rejection'
  }
}

/**
 * THE TALLY. Reasons and their counts since the last printed sentence, plus when that was.
 *
 * `lastAt` starts BEFORE ANY CLOCK, so the FIRST fallback of a launch is printed immediately: a
 * developer looking at a blank surface wants to know why within the second, not after a window
 * they did not know was running. Negative infinity rather than zero because the property
 * wanted is "no window has ever elapsed", and zero only says that to a clock whose epoch is far
 * away — which `Date.now()` is and a test's fake clock is not.
 */
interface NoteTally {
  readonly counts: Map<FallbackReason, number>
  lastAt: number
}

function flush(deps: ShimDeps, tally: NoteTally): void {
  if (tally.counts.size === 0) return
  const parts = Array.from(tally.counts, ([why, n]) => `${REASON_PHRASE[why]} ×${String(n)}`)
  const total = Array.from(tally.counts.values()).reduce((a, b) => a + b, 0)
  deps.note(
    `data-server shim: ${String(total)} unserved read${total === 1 ? '' : 's'} ` +
      `answered with the empty shape — ${parts.join(', ')}`
  )
  tally.counts.clear()
  tally.lastAt = deps.now()
}

function tallyFallback(deps: ShimDeps, tally: NoteTally, why: FallbackReason): void {
  tally.counts.set(why, (tally.counts.get(why) ?? 0) + 1)
  if (deps.now() - tally.lastAt >= deps.noteEveryMs) flush(deps, tally)
}

/**
 * ONE ROUND TRIP, BOUNDED. Resolves to the reply or to the deadline sentinel; rejects only where
 * the client itself rejected, which the caller turns into `refused`.
 */
function raceDeadline<T>(deps: ShimDeps, work: Promise<T>): Promise<T | typeof DEADLINE> {
  // The annotation is load-bearing: without it the arrow's return widens from the `unique symbol`
  // to plain `symbol`, and the race's type stops being the one the caller narrows against.
  return Promise.race([work, deps.delay(deps.timeoutMs).then((): typeof DEADLINE => DEADLINE)])
}

export function createReadShim(deps: ShimDeps): ReadShim {
  const tally: NoteTally = { counts: new Map(), lastAt: Number.NEGATIVE_INFINITY }

  const ask = async <O extends RequestOp, T>(
    op: O,
    params: ParamsFor<O>,
    project: (result: ResultFor<O>) => T | null
  ): Promise<ServeOutcome<T>> => {
    // READINESS FIRST, and it costs nothing: three field reads against a live connection. A request
    // put on a wire that is not there would come back as `refused` anyway, but it would come back
    // saying the wrong thing about WHY — and `why` is the whole value of the note.
    const ready = deps.readiness()
    if (!ready.ok) return { served: false, why: ready.why, detail: REASON_PHRASE[ready.why] }
    let reply: ResultFor<O> | typeof DEADLINE
    try {
      reply = await raceDeadline(deps, deps.request(op, params))
    } catch (err) {
      return { served: false, why: 'refused', detail: `${op} — ${describe(err)}` }
    }
    if (reply === DEADLINE) {
      return { served: false, why: 'timedOut', detail: `${op} after ${String(deps.timeoutMs)} ms` }
    }
    const value = project(reply)
    if (value === null) return { served: false, why: 'guess', detail: `${op} answered, unusably` }
    return { served: true, value }
  }

  const serve = async <O extends RequestOp, T>(
    op: O,
    params: ParamsFor<O>,
    project: (result: ResultFor<O>) => T | null,
    own: () => T
  ): Promise<T> => {
    const outcome = await ask(op, params, project)
    if (outcome.served) return outcome.value
    tallyFallback(deps, tally, outcome.why)
    return own()
  }

  return {
    serve,
    ask,
    flushNotes: (): void => {
      flush(deps, tally)
    }
  }
}
