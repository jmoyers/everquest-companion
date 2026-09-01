// ============================================================================
// supervisor.ts — Electron main owns the engine's LIFECYCLE and nothing else (JOS-467, phase 0).
// ============================================================================
//
// THE BOUNDARY, from the plan (docs/plans/data-server.md, "The shape"): main does window
// management and the OS — overlays, presence, tray, updater, audio out — and NO GAME DATA, EVER.
// What it owns of the data server is exactly four verbs: spawn, watch, respawn, kill. Not a row,
// not a view, not a subscription. That is why this file talks about ports, tokens, exit codes and
// backoff and never once about a log line.
//
// IT IS ELECTRON-FREE, AND STRUCTURALLY SO — every dependency arrives as a callback in
// `EngineSupervisorDeps`, so there is no import of `electron`, `node:child_process` or `node:net`
// anywhere below. The house pattern is `processPriority.ts` ("the pid arithmetic and the failure
// policy are a MECHANISM, the switch is a POLICY, and the composition root owns both halves") and
// `presenceProtocol.ts` before it. What it buys is not tidiness: it is a `node:test` unit that
// drives every failure path — a spawn that times out, a binary that prints garbage, a crash loop,
// a kill escalation — with no app, no Rust binary and no skip.
//
// THE SUPERVISION PRECEDENT IS THE PRESENCE WATCHER (`presence.ts:618-692`), and three of its
// hard-won rules are here in spirit:
//   * ONE FUNNEL OFF A LAUNCH. Every way a launch can end — an exit, a throw, a timeout, a failed
//     health probe — goes through `endLaunch`, which is idempotent by identity. A late `exit` after
//     a `kill` we issued is a no-op rather than a second report and a second respawn.
//   * THE EXIT TRAIL. A crash loop mints ONE error name, not fifty (`engineExitStep`).
//   * BACKOFF, CAPPED, RESET ON HEALTH. The counter resets the moment a launch reaches READY —
//     which here means a PROVEN round-trip, not a process that started.
//
// AND THE REPORTING MISTAKE IT AVOIDS is `childProcessGone.ts:29-45`: every report is a
// name/message/code triple the error store can fingerprint, built by `engineProtocol.ts` so this
// file cannot forget one.
//
// A RESPAWN IS A LAUNCH (contract rule 5). Fresh token, fresh port, fresh epoch world. Nothing is
// carried across except the FAILURE trail, which is about this supervisor's patience and not about
// the world. Resume is always requery, which is a client's problem (JOS-468), not this file's.
//
// AND SINCE JOS-519 A SECOND TRAIL RIDES BESIDE IT, counting the opposite thing. The failure trail
// resets on every READY edge, which is correct for a launch loop and is exactly why an engine that
// reaches READY, serves, and dies ten minutes later — over and over, always coming back — never
// produced a single error-store entry. `servedTrail` counts those, once per session, because a user
// sees each of them as another "Catching up on your log". It is an INSTRUMENT: nothing about
// respawn, backoff or the fault card reads it.
//
// IT IS A CLASS, and that is a factoring decision rather than a style one: every one of these
// methods is a callback somebody else holds, and a single factory closure holding them all is one
// function of three hundred lines. A class gives each verb its own name, its own budget and its own
// test, and keeps the state per-instance so a suite can run twenty supervisors without a reset hook.
//
// NO RENDERER EXPOSURE, ON PURPOSE, AND STILL NONE IN PHASE 3. Nothing here imports the client
// library or touches IPC. What JOS-479 added is exactly one callback — `onReady`, beside `onPid` —
// through which the launch hands out the port and the TOKEN IT MINTED. That is the smallest
// possible widening and it could not be avoided: the supervisor owns the secret by design (rule 1,
// stdin and nowhere else), so an in-app client can only exist if the owner of the secret offers it.
// The supervisor still knows nothing about what the client then says.

import type { EngineFaultKind } from '../../shared/engineLaunch'
// THE CHILD'S OWN SHAPES AND ITS LINE READER, split out at the measured 400-code-line ceiling
// (JOS-503) — where the house rule is to split rather than to ratchet. See `supervisorChild.ts`'s
// header for why that is the natural seam, and note that nothing about this file's structural
// Electron-freedom changed: that file imports the shared line codec and nothing else.
import { describeErr, readLines, type SupervisedChild } from './supervisorChild'
import { PROTOCOL_VERSION } from '../../shared/dataServer/protocol.generated'
import type { EngineHealth } from './engineHealth'
// THE HEALTH CADENCE LIVES NEXT DOOR TOO (JOS-526), split at the same ceiling and along the same
// house rule as `supervisorChild.ts`. This file still owns what a failed probe MEANS for a launch;
// it no longer owns how often one is asked, or what a machine waking up does to the question.
import {
  createLaunchHealthWatch,
  type HealthWatchDeps,
  type LaunchHealthWatch
} from './supervisorHealth'
import {
  ENGINE_ANNOUNCE_TIMEOUT_MS,
  ENGINE_STOP_GRACE_MS,
  NEW_ENGINE_EXIT_TRAIL,
  NEW_ENGINE_SERVED_TRAIL,
  boundedDetail,
  engineExitStep,
  engineLocalSocketLog,
  engineRestartDelayMs,
  engineServedCycleStep,
  engineShutdownExitLog,
  parseAnnounce,
  redactToken,
  type EngineAnnounce,
  type EngineExitCause,
  type EngineExitLog,
  type EngineExitTrail,
  type EngineFailure,
  type EngineHealthVerdict,
  type EnginePowerHandlers,
  type EngineServedTrail,
  type HealthFailure
} from './engineProtocol'

// THE CHILD, STRUCTURALLY, LIVES NEXT DOOR NOW (JOS-503) — `supervisorChild.ts`, split out at the
// measured 400-code-line ceiling where the house rule is to split rather than to ratchet. It is
// RE-EXPORTED here because this file is the module every caller already names for the supervision
// feature, and a split made to satisfy a line budget must not become import churn across callers.
export type { SupervisedChild, SupervisedStdin, SupervisedStream } from './supervisorChild'

/** Where the supervisor is right now. Observable so the dev log and a test can both read it. */
export type EngineStatus = 'stopped' | 'absent' | 'starting' | 'ready' | 'backoff' | 'stopping'

/**
 * THE FAILURES A *LAUNCH* CAN HAVE — `EngineFailure` minus the two that do not end one.
 *
 * `local-socket` is the second exclusion and it earns the same structural treatment: a connect that
 * failed on our own endpoint is not evidence about the engine, so `fold` and `endLaunch` cannot be
 * handed it and a serving engine cannot be retired over it.
 *
 * `shutdown-exit` is a child that exited badly after the app closed its stdin. It is handled in
 * `onExit`'s stopping arm, which returns before `endLaunch` — so it can never fold into a restart
 * trail, and the paragraph there says so at length. This type is that paragraph made STRUCTURAL:
 * `fold` and `endLaunch` cannot be handed it, which is also what lets a fault carry `cause.failure`
 * straight across to `EngineFaultKind` with no unreachable branch to prove dead (JOS-503).
 */
export type LaunchFailure = Exclude<EngineFailure, 'shutdown-exit' | 'local-socket'>

/**
 * A LAUNCH THAT PROVED ITSELF, and everything a client needs to talk to it (JOS-479).
 *
 * The supervisor owns the secret — it mints the token and writes it down the child's stdin, which
 * is the whole reason nothing else in the process can know it — so the only honest way for the
 * app's own client to reach this engine is for the supervisor to HAND IT OVER at the one moment it
 * is meaningful. That moment is READY, which here means a proven `hello` + `session.health` round
 * trip and not a process that started.
 *
 * A RESPAWN IS A LAUNCH (contract rule 5): the next of these carries a different port AND a
 * different token, and nothing about the previous connection survives. `null` is the same edge in
 * the other direction — this launch is over, whatever the client still holds is pointed at a socket
 * that is gone.
 */
export interface ReadyEngine {
  readonly pid: number | null
  readonly port: number
  /** The per-launch secret, minted by `mintToken` and known to exactly two processes. */
  readonly token: string
  readonly protocolVersion: number
  readonly engineVersion: string
  /** The generation the engine reported at the health probe, before any attach of ours. */
  readonly epoch: number
}

/**
 * WHY A LAUNCH IS NOT GOING TO WORK, at the two moments a PERSON should be told (JOS-503).
 *
 * This is not a second reporting channel beside `report`. That one exists for the error store and
 * fires on every ended launch, because a fleet wants the whole trail; this one fires exactly twice
 * in a session — when the resolver finds nothing, and when the quick-exit trail COLLAPSES — because
 * a person wants to be told once, when the answer has stopped changing.
 *
 * `null` is the other edge and it means recovery: a launch reached READY, so whatever card was on
 * screen is about a world that has since started working.
 *
 * IT CARRIES NO PATHS. The candidate list belongs to whoever resolved the binary
 * (`engineHost.ts resolveEngineBinary`), and a supervisor that took `resolveBinary(): string | null`
 * has never seen it. The composition root grafts it on, which is the same split every other fact in
 * this file keeps.
 */
export interface EngineFaultCause {
  readonly kind: EngineFaultKind
  /** Consecutive failed launches, INCLUDING this one. 0 for an absence — nothing was attempted. */
  readonly attempts: number
  /** The one bounded, token-redacted line of context `EngineExitCause` already built. */
  readonly detail: string | null
}

/**
 * Everything the composition root hands this module. No Electron reaches past this interface.
 *
 * It EXTENDS the watchdog's own slice (`HealthWatchDeps`: the connect, the clock, the dev log and
 * their test seams) rather than restating it, so the two files cannot drift and one wiring satisfies
 * both.
 */
export interface EngineSupervisorDeps extends HealthWatchDeps {
  /** The engine binary's path, or null when this build has none — see `beginLaunch`. */
  resolveBinary(): string | null
  spawn(binPath: string): SupervisedChild
  /** `src/main/dataServer/token.ts mintToken`. Injected so a test can pin what was written. */
  mintToken(): string
  now(): number
  /** The error store. Never called for an ABSENCE — see `beginLaunch`. */
  report(log: EngineExitLog): void
  /** The engine's pid as it comes and goes: the priority arm, and anything else that needs to know
   *  which process is the engine. Called with null the moment a launch ends. */
  onPid?(pid: number | null): void
  /**
   * THE READY EDGE (JOS-479) — `onPid`'s sibling, and deliberately a second callback rather than a
   * widened first one: the pid arm is about a PROCESS and wants to hear about it as early as
   * possible, while a client is about a CONNECTION and must not be told anything until a round trip
   * has proven there is one. They fire at the same instant today and would not have to.
   *
   * Called with null on exactly the edges `onPid(null)` fires on, and for the same reason: a
   * consumer holding a socket to a dead engine is a consumer whose next request hangs.
   */
  onReady?(engine: ReadyEngine | null): void
  /**
   * THE PERSON'S EDGE (JOS-503) — see `EngineFaultCause`. Called with a cause when a launch is not
   * going to work and with `null` when one reaches READY. Never called for `shutdown-exit`, which
   * is structurally impossible here: that path returns from `onExit`'s stopping arm without ever
   * reaching `fold`.
   */
  onFault?(fault: EngineFaultCause | null): void
  /**
   * A SERVING ENGINE JUST DIED AND A RESPAWN FOLLOWS (JOS-519) — the breadcrumb edge, and the only
   * thing this supervisor says about the cycling that is not an error-store entry.
   *
   * It fires on EVERY such death rather than once, because a ring is a sequence and the whole point
   * is that a crash report shows the shape: ready, gone, cycled, ready, gone, cycled. It takes no
   * parameter for `noteEngineEdge`'s reason — there is nothing a name, a port or a pid could travel
   * in — and the count lives in the entry the deps' `report` gets.
   */
  onServedExit?(): void
  /**
   * THE MACHINE'S OWN SLEEP, seamed like the clock (`EnginePowerHandlers`): the composition root
   * subscribes to Electron's `powerMonitor` and calls these; this file never learns the word.
   * Registered ONCE, from the constructor — a supervisor outlives every launch it makes, and the
   * suspend that matters most is the one that arrives while nothing is running.
   */
  powerEvents?(handlers: EnginePowerHandlers): void
  /** TEST SEAMS — every clock, and the wire version. (The health clocks are `HealthWatchDeps`'.) */
  protocolVersion?: number
  announceTimeoutMs?: number
  stopGraceMs?: number
}

/** ONE launch's whole mutable world. A respawn builds a new one; nothing is reused. */
interface Launch {
  readonly child: SupervisedChild
  readonly startedAt: number
  readonly token: string
  announce: EngineAnnounce | null
  /** Did this launch ever reach READY? The one bit that separates "the engine will not start" from
   *  "the engine started, served, and then died" — the second is JOS-519's whole subject. */
  served: boolean
  /** The engine's last stderr line, kept as the `detail` a failure report carries. */
  lastStderr: string | null
  /** Has this launch already been folded? The idempotence latch — see `endLaunch`. */
  finished: boolean
  /** Did WE kill it (the grace escalation)? A forced exit's code is our own action echoing back,
   *  never the child's diagnosis — the shutdown-exit report reads this to stay quiet about it. */
  killed: boolean
  cancelAnnounce: (() => void) | null
  /** The health cadence, armed once the launch announces. It owns its own timer. */
  health: LaunchHealthWatch | null
  cancelGrace: (() => void) | null
}

/** What `endLaunch` is told about the ending. `alive` defaults to TRUE — the safe direction: a
 *  child we wrongly believe is dead is a child nobody retires. */
interface EndInfo {
  exitCode?: number | null
  signal?: string | null
  detail?: unknown
  alive?: boolean
  /** Present only on the `unhealthy` path: the probe verdict, spread onto the cause. */
  health?: EngineHealthVerdict
}

export class EngineSupervisor {
  private status: EngineStatus = 'stopped'
  private launch: Launch | null = null
  private trail: EngineExitTrail = NEW_ENGINE_EXIT_TRAIL
  /** THE OTHER TRAIL (JOS-519), and it is deliberately NOT reset anywhere in this file: it counts
   *  engines that WORKED and then died, so a launch reaching READY is what feeds it. */
  private servedTrail: EngineServedTrail = NEW_ENGINE_SERVED_TRAIL
  private failures = 0
  private cancelRestart: (() => void) | null = null
  /** Set by `stop()`. A stop must survive a launch that is mid-handshake, so it is a latch rather
   *  than a status read: the exit that arrives afterwards checks THIS. */
  private stopping = false
  /** When the machine last woke, SESSION-scoped like `servedTrail` and for the same reason: a
   *  respawn must not forget that the last minute contained a sleep. */
  private lastResumeAt: number | null = null
  private readonly protocolVersion: number
  private readonly announceTimeoutMs: number
  private readonly stopGraceMs: number

  constructor(private readonly deps: EngineSupervisorDeps) {
    this.protocolVersion = deps.protocolVersion ?? PROTOCOL_VERSION
    this.announceTimeoutMs = deps.announceTimeoutMs ?? ENGINE_ANNOUNCE_TIMEOUT_MS
    this.stopGraceMs = deps.stopGraceMs ?? ENGINE_STOP_GRACE_MS
    deps.powerEvents?.({ suspend: () => { this.onSuspend() }, resume: () => { this.onResume() } })
  }

  // ------------------------------------------------------------------ the public four

  /**
   * Where this supervisor is right now. A READ, and the type says so — the setter is every private
   * transition in this file and there is no way to write it from outside.
   *
   * `EngineStatus` already promised to be "observable so the dev log and a test can both read it";
   * this is the accessor that makes the promise true for the performance panel as well (JOS-483).
   * The distinction it needs is `absent` from everything else: a build with no engine binary is the
   * ORDINARY state of every install that is not a developer's cargo tree, and a panel that drew an
   * ENGINE section there would be showing a feature this build does not have.
   */
  currentStatus(): EngineStatus {
    return this.status
  }

  /** Start, or restart after a `stop()`. Idempotent while a launch or a backoff is in flight. */
  start(): void {
    this.stopping = false
    if (this.launch || this.cancelRestart) return
    this.beginLaunch()
  }

  /**
   * Stop: CLOSE STDIN, escalate to `kill` after the grace. Idempotent.
   *
   * Closing stdin IS the shutdown signal (contract rule 3), so the ordinary teardown never sends a
   * signal at all — which is what makes an orderly engine shutdown possible in the first place. A
   * `kill` cannot be caught and cannot flush anything.
   */
  stop(): void {
    this.stopping = true
    this.cancelRestart?.()
    this.cancelRestart = null
    const l = this.launch
    if (!l) {
      this.status = 'stopped'
      return
    }
    this.status = 'stopping'
    l.cancelAnnounce?.()
    l.cancelAnnounce = null
    l.health?.stop()
    this.deps.debug('data-server engine: closing stdin (the shutdown signal)')
    this.retire(l)
  }

  /**
   * TRY AGAIN, BECAUSE A PERSON ASKED (JOS-503) — the failure card's retry button.
   *
   * NOT `stop()` THEN `start()`, and the difference is not stylistic. `stop()` retires the child and
   * leaves `this.launch` set until the exit event arrives, so a `start()` on the next line finds a
   * launch in flight and no-ops; the retry would appear to do nothing. What a person means by "try
   * again" is also not "kill whatever is running" — it is "stop waiting and go now".
   *
   * So this FORGIVES and HURRIES: the failure count and the exit trail reset (a retry is a new run,
   * and holding a collapsed trail across it would mean the next real failure was never reported),
   * any pending backoff is cancelled, and a launch begins immediately. A launch already in flight is
   * LEFT ALONE — it is already the answer to the question, and beginning a second one would orphan
   * the first with its port and its token.
   *
   * It is exactly right for both terminal states: an absence has no launch and no timer, so it
   * re-probes the disk at once (which is what makes it the correct button after somebody has
   * restored a quarantined file), and a collapsed crash loop is sitting on a 30 s timer that this
   * cancels.
   */
  restart(): void {
    this.stopping = false
    this.failures = 0
    this.trail = NEW_ENGINE_EXIT_TRAIL
    if (this.launch) return
    this.cancelRestart?.()
    this.cancelRestart = null
    this.deps.debug('data-server engine: retrying the launch (asked for)')
    this.beginLaunch()
  }

  /** Where the supervisor is. */
  get state(): EngineStatus {
    return this.status
  }

  /** The port a READY engine is listening on, else null. */
  get port(): number | null {
    return this.status === 'ready' ? (this.launch?.announce?.port ?? null) : null
  }

  /** One line for the dev log or a test assertion. */
  describe(): string {
    const port = this.launch?.announce?.port
    const where = port === undefined ? '' : ` on port ${String(port)}`
    return `data-server engine: ${this.status}${where} (failures ${String(this.failures)})`
  }

  // ------------------------------------------------------------------ launching

  /**
   * Start one launch. Everything that can go wrong from here funnels into `endLaunch`.
   *
   * THE TOKEN GOES DOWN STDIN AND NOWHERE ELSE (contract rule 1) — never argv, never env, both of
   * which any process running as this user can read out of the process table.
   */
  private beginLaunch(): void {
    const bin = this.deps.resolveBinary()
    if (bin === null) {
      // ABSENCE IS A LOGGED CONDITION, NOT A CRASH — and not a retry either. A build with no engine
      // binary will not grow one while it runs, so a backoff against it is a timer that can only
      // ever say the same thing; and it is not an error-store entry, because until the phase-3
      // packaging change lands "no engine here" is the ORDINARY state of every build that is not a
      // developer's own cargo tree. The app runs without it.
      this.status = 'absent'
      this.deps.debug('data-server engine: no engine binary found; the supervisor is idle (phase 3)')
      // …AND SOMEBODY IS TOLD (JOS-503). The paragraph above is still true — this is not an error
      // and not a retry — but it stopped being true that nobody needs to know: post-cutover there is
      // no fold to fall back to, so this condition IS a permanently empty app, and the one thing it
      // must not be is silent. `attempts` is 0 because nothing was launched.
      this.deps.onFault?.({ kind: 'no-binary', attempts: 0, detail: null })
      return
    }
    const token = this.deps.mintToken()
    let child: SupervisedChild
    try {
      child = this.deps.spawn(bin)
    } catch (err) {
      // A spawn that THROWS never produced a child, so there is no lifetime to fold — and it is the
      // failure most likely to be a machine having a moment (out of handles, a scanner holding the
      // file). It gets the same trail and the same backoff as every other.
      this.fold({
        failure: 'spawn-failed',
        exitCode: null,
        signal: null,
        lifetimeMs: 0,
        detail: boundedDetail(`${bin}: ${describeErr(err)}`)
      })
      this.scheduleRestart()
      return
    }
    this.status = 'starting'
    this.deps.debug(`data-server engine: spawning ${bin}`)
    this.launch = this.wire(child, token)
  }

  /** Attach every listener one launch needs, and hand it its token. */
  private wire(child: SupervisedChild, token: string): Launch {
    const l: Launch = {
      child,
      token,
      startedAt: this.deps.now(),
      announce: null,
      served: false,
      lastStderr: null,
      finished: false,
      killed: false,
      cancelAnnounce: null,
      health: null,
      cancelGrace: null
    }
    // The engine must never be the reason a quitting app stays alive (`presence.ts`'s `w.unref()`,
    // the same promise for a process instead of a thread). `stop()` is what actually ends it.
    child.unref()
    // ARMED BEFORE THE STREAM IS READ, and the order is load-bearing: a child (or a test's fake)
    // that announces synchronously would otherwise have its announce handled first and this timer
    // installed afterwards — a live timeout sitting under a healthy engine, waiting to end it.
    l.cancelAnnounce = this.deps.timer(() => {
      l.cancelAnnounce = null
      if (l.announce) return
      this.endLaunch(l, 'announce-timeout', { alive: true })
    }, this.announceTimeoutMs)
    // BOTH STREAMS ARE REDACTED AT THE DOOR, before anything reads a line — see `redactToken`, and
    // the real boot that made it necessary. A child that echoes its own stdin is a child that
    // publishes the launch secret into our logs, and this is the one place that can stop it.
    readLines(child.stdout, (line) => this.onStdoutLine(l, redactToken(line, token)))
    readLines(child.stderr, (line) => {
      // DIAGNOSTICS GO TO STDERR (contract rule 2), so this is the engine's own voice and the one
      // useful `detail` a failure report can carry. Bounded on the way in for the reason
      // `boundedDetail` states: it is text from outside our types heading for a log a person reads.
      const safe = redactToken(line, token)
      l.lastStderr = boundedDetail(safe)
      this.deps.debug(`data-server engine: ${trim(safe)}`)
    })
    child.on('error', (err) => {
      this.endLaunch(l, 'spawn-failed', { detail: describeErr(err), alive: false })
    })
    child.on('exit', (code, signal) => this.onExit(l, code, signal))
    this.writeToken(l, token)
    return l
  }

  /** The token, LF-terminated, as the FIRST line on stdin. */
  private writeToken(l: Launch, token: string): void {
    const stdin = l.child.stdin
    if (!stdin) {
      this.endLaunch(l, 'spawn-failed', { detail: 'the child has no stdin for the token', alive: true })
      return
    }
    // EPIPE arrives ASYNCHRONOUSLY when the child dies before reading, and an unhandled `error` on
    // a stream is an uncaught exception in the main process. The exit event is the real signal;
    // this handler exists so the pipe can never be the thing that takes the app down.
    stdin.on('error', (err) => {
      this.deps.debug(`data-server engine: stdin error (${describeErr(err)})`)
    })
    try {
      stdin.write(`${token}\n`)
    } catch (err) {
      this.endLaunch(l, 'spawn-failed', { detail: describeErr(err), alive: true })
    }
  }

  // ------------------------------------------------------------------ what the child says

  /** The child's stdout, line by line. Exactly ONE line is legal (contract rule 2). */
  private onStdoutLine(l: Launch, line: string): void {
    if (l.finished) return
    if (l.announce) {
      // A SECOND LINE IS A CONTRACT VIOLATION, AND IT IS STILL NOT WORTH KILLING A WORKING ENGINE
      // OVER. The engine is answering on a socket; whatever it also printed is noise from a build
      // that put a diagnostic on the wrong stream. It is said, and otherwise ignored.
      this.deps.debug(`data-server engine: unexpected stdout after the announce: ${trim(line)}`)
      return
    }
    const announce = parseAnnounce(line)
    if (!announce) {
      this.endLaunch(l, 'bad-announce', { detail: line, alive: true })
      return
    }
    l.announce = announce
    l.cancelAnnounce?.()
    l.cancelAnnounce = null
    this.deps.debug(
      `data-server engine announced port ${String(announce.port)} protocol ${String(announce.protocolVersion)}`
    )
    this.beginHealth(l, announce)
  }

  private onExit(l: Launch, code: number | null, signal: string | null): void {
    if (this.stopping) {
      // A DELIBERATE STOP IS NOT A FAILURE (`presence.ts stopWatcher`'s rule): no trail, no
      // respawn — whatever the exit code says. We asked for this.
      l.finished = true
      clearLaunchTimers(l)
      this.deps.onPid?.(null)
      this.deps.onReady?.(null)
      if (this.launch === l) this.launch = null
      this.status = 'stopped'
      this.deps.debug(`data-server engine: exited ${String(code ?? -1)} after the shutdown signal`)
      // …BUT A BAD ENDING IS STILL ON THE RECORD (JOS-501 integration). This fires while the app
      // is QUITTING, so the debug line above is stdout on a process about to die — the one channel
      // that cannot be read after the fact. An exit 0 needs no more than that; a child that exited
      // nonzero on the polite path is a real defect nobody would ever see, so it gets the durable
      // entry. Deliberately NOT `endLaunch`: that funnel folds restart decisions, and a shutdown
      // exit must never count toward a crash streak — the launch is over because we ended it.
      // AND NOT WHEN WE KILLED IT: a forced exit's code is our own escalation echoing back ("we
      // asked for this; a kill exit code is not a diagnosis" — the suite's words), and the
      // escalation is already narrated where it happens.
      if (code !== 0 && !l.killed) {
        this.deps.report(
          engineShutdownExitLog(code, signal, Math.max(0, this.deps.now() - l.startedAt))
        )
      }
      return
    }
    this.endLaunch(l, 'exited', { exitCode: code, signal, alive: false })
  }

  // ------------------------------------------------------------------ health

  /** Arm the watchdog for a launch that has announced. It reports back through exactly two edges;
   *  the cadence, the two-strike rule and the sleep gate are `supervisorHealth.ts`'s. */
  private beginHealth(l: Launch, announce: EngineAnnounce): void {
    const target = { port: announce.port, token: l.token, protocolVersion: this.protocolVersion }
    l.health = createLaunchHealthWatch(this.deps, target, {
      onHealthy: (health, first) => { if (first) this.reachedReady(l, announce, health) },
      onUnhealthy: (reasons, err) => { this.unhealthy(l, reasons, err) },
      onLocalSocket: (tries, err) => { this.localSocket(l, tries, err) }
    })
  }

  /** The app could not open a socket, repeatedly. One entry, and the launch is left running — the
   *  engine is bound and serving, and a respawn cannot supply a local port. */
  private localSocket(l: Launch, tries: number, err: unknown): void {
    this.deps.report(
      engineLocalSocketLog(tries, Math.max(0, this.deps.now() - l.startedAt), boundedDetail(describeErr(err)))
    )
  }

  /**
   * The watchdog has run out of asks. A wedged engine is indistinguishable from a healthy one except
   * through an unanswered round-trip — the presence stale-watchdog's argument for a process — and
   * the report carries how the verdict was REACHED: both reason enums, and how long ago the machine
   * woke, so a fleet can separate a wedge from a sleep without a second free-text field.
   */
  private unhealthy(l: Launch, reasons: readonly HealthFailure[], err: unknown): void {
    const resumedAgoMs =
      this.lastResumeAt === null ? null : Math.max(0, this.deps.now() - this.lastResumeAt)
    this.endLaunch(l, 'unhealthy', {
      detail: describeErr(err),
      alive: true,
      health: { healthReasons: reasons, resumedAgoMs }
    })
  }

  /** The machine is going away. The watchdog stands down rather than reporting a socket that is
   *  about to be frozen mid-question. */
  private onSuspend(): void {
    this.launch?.health?.suspend()
  }

  /** …and it is back. The stamp is taken here rather than in the watch because it outlives every
   *  launch: a respawn during the wake window must still know a sleep just ended. */
  private onResume(): void {
    this.lastResumeAt = this.deps.now()
    this.launch?.health?.resume()
  }

  /** The one place a launch becomes THE engine — and the backoff resets HERE, on a proven
   *  round-trip rather than on a process that merely started. */
  private reachedReady(l: Launch, announce: EngineAnnounce, health: EngineHealth): void {
    this.status = 'ready'
    this.failures = 0
    this.trail = NEW_ENGINE_EXIT_TRAIL
    // …AND `servedTrail` IS NOT TOUCHED HERE (JOS-519). Resetting it would erase the only record of
    // the failure it exists for: an engine that reaches READY, serves, dies, and is replaced by
    // another that does the same. That trail is about launches that never worked; this one counts
    // the ones that did.
    l.served = true
    // WHATEVER CARD IS ON SCREEN IS ABOUT A WORLD THAT NOW WORKS (JOS-503). Cleared on the same
    // proven round trip that resets the trail, because they are the same fact: this supervisor has
    // stopped having a diagnosis.
    this.deps.onFault?.(null)
    this.deps.onPid?.(l.child.pid ?? null)
    this.deps.debug(
      `data-server engine ready: pid ${String(l.child.pid ?? 0)}, port ${String(announce.port)}, ` +
        `protocol ${String(announce.protocolVersion)}, engine ${health.engineVersion || 'unknown'}, ` +
        `status ${health.status}`
    )
    // THE HANDOVER, AFTER THE NARRATION on purpose: whatever the client does with this — connect,
    // hello, attach — is caused by the ready line, so the ready line has to be in the log ABOVE it.
    // A reader following a dev log top to bottom should never see the consequence before the cause.
    this.deps.onReady?.({
      pid: l.child.pid ?? null,
      port: announce.port,
      token: l.token,
      protocolVersion: announce.protocolVersion,
      engineVersion: health.engineVersion,
      epoch: health.epoch
    })
  }

  // ------------------------------------------------------------------ ending, folding, retrying

  /**
   * THE ONE FUNNEL OFF A LAUNCH — the presence watcher's `handleWatcherGone`, one process over.
   *
   * Idempotent by identity: a launch that has already been folded returns immediately, so the
   * `exit` that follows a kill WE issued is a no-op rather than a second report and a second
   * respawn. Every failure mode in this file lands here and nowhere else.
   */
  private endLaunch(l: Launch, failure: LaunchFailure, info: EndInfo): void {
    if (l.finished) return
    l.finished = true
    clearLaunchTimers(l)
    this.deps.onPid?.(null)
    this.deps.onReady?.(null)
    const cause = {
      failure,
      exitCode: info.exitCode ?? null,
      signal: info.signal ?? null,
      lifetimeMs: Math.max(0, this.deps.now() - l.startedAt),
      detail: boundedDetail(info.detail) ?? l.lastStderr,
      ...info.health
    }
    this.fold(cause)
    // The child may still be running (a timeout, a bad announce, a failed health probe). Retiring it
    // is not optional — see `retire`. On the exit path it costs one `end()` on a closed pipe.
    if (info.alive !== false) this.retire(l)
    if (this.launch === l) this.launch = null
    if (this.stopping) {
      this.status = 'stopped'
      return
    }
    if (l.served) this.noteServedExit(cause)
    this.scheduleRestart()
  }

  /**
   * A LAUNCH THAT HAD SERVED IS BEING REPLACED (JOS-519). Below the `stopping` return above on
   * purpose: what this counts is a RESPAWN after serving, and a supervisor that is stopping is not
   * going to respawn anything — the quit path and `stop()` are not failures, whatever the exit code
   * says, and this counter must not turn an orderly shutdown into a symptom.
   *
   * A wedge counts as a death. `unhealthy` ends a launch whose process may still be running, but
   * the consequence is identical — the engine is retired, a fresh one launches, and the whole log is
   * folded again — and it is that consequence the user is reporting.
   */
  private noteServedExit(cause: Omit<EngineExitCause, 'attempt'>): void {
    const step = engineServedCycleStep(this.servedTrail, cause)
    this.servedTrail = step.trail
    this.deps.onServedExit?.()
    this.deps.debug(
      `data-server engine: a serving engine died (${String(step.trail.cycles)} this session)`
    )
    if (step.log) this.deps.report(step.log)
  }

  /** Count the failure, fold it into the trail, report what the fold says to report. */
  private fold(cause: Omit<EngineExitCause, 'attempt' | 'failure'> & { failure: LaunchFailure }): void {
    this.failures += 1
    const step = engineExitStep(this.trail, { ...cause, attempt: this.failures })
    const collapsing = !this.trail.collapsed && step.trail.collapsed
    this.trail = step.trail
    if (step.log) this.deps.report(step.log)
    // THE COLLAPSE EDGE IS THE ONE A PERSON IS TOLD ABOUT (JOS-503), and it is the right moment for
    // exactly the reason `engineExitStep` collapses at all: before it, a fast failure really can be
    // a machine having a moment and a card would be crying wolf; at it, the trail has become the one
    // shape that only a condition which is not clearing can produce. The retry backoff keeps running
    // underneath — a card is not a surrender — but the sentence has stopped changing, so it is said.
    if (collapsing) {
      this.deps.onFault?.({ kind: cause.failure, attempts: step.trail.streak, detail: cause.detail })
    }
  }

  /** The backoff. Capped, and the counter resets the moment a launch reaches READY. */
  private scheduleRestart(): void {
    if (this.cancelRestart || this.stopping) return
    const delay = engineRestartDelayMs(this.failures)
    this.status = 'backoff'
    this.deps.debug(`data-server engine: restarting in ${String(delay)} ms (failure ${String(this.failures)})`)
    this.cancelRestart = this.deps.timer(() => {
      this.cancelRestart = null
      if (this.stopping || this.launch) return
      this.beginLaunch()
    }, delay)
  }

  /**
   * Ask a child to stop, the way the contract says: CLOSE ITS STDIN. `kill` is the escalation,
   * armed for `stopGraceMs` and disarmed by the exit a polite shutdown produces.
   *
   * It runs for a FAILED launch too, not only for `stop()` — a binary that announced garbage or
   * stopped answering is still a live process holding a port, and leaving it behind is how a
   * respawn ends up unable to bind and a machine ends up with a herd of orphaned engines.
   */
  private retire(l: Launch): void {
    try {
      l.child.stdin?.end()
    } catch (err) {
      this.deps.debug(`data-server engine: closing stdin failed (${describeErr(err)})`)
    }
    l.cancelGrace?.()
    l.cancelGrace = this.deps.timer(() => {
      l.cancelGrace = null
      this.deps.debug('data-server engine: no exit on stdin EOF; escalating to kill')
      l.killed = true
      try {
        l.child.kill()
      } catch (err) {
        this.deps.debug(`data-server engine: kill failed (${describeErr(err)})`)
      }
    }, this.stopGraceMs)
  }
}

/** The composition root's door. A function rather than the constructor so the call sites read the
 *  same as every other wiring in `src/main`, and so the class stays free to grow a second one. */
export function createEngineSupervisor(deps: EngineSupervisorDeps): EngineSupervisor {
  return new EngineSupervisor(deps)
}

/** Every timer one launch owns, cancelled — including the watchdog's, which also stops any answer
 *  still in flight from being reported about a launch that is over. */
function clearLaunchTimers(l: Launch): void {
  l.cancelAnnounce?.()
  l.cancelGrace?.()
  l.cancelAnnounce = null
  l.cancelGrace = null
  l.health?.stop()
}

/** A stream line on its way to the dev log: bounded and control-free, like every other outside
 *  string in this feature. */
function trim(line: string): string {
  return boundedDetail(line) ?? '(blank)'
}
