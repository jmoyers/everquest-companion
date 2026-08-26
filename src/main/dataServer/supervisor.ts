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

import { LineDecoder, type ByteChannel } from '../../shared/dataServer/ndjson'
import { PROTOCOL_VERSION } from '../../shared/dataServer/protocol.generated'
import { engineHealthCheck, type EngineHealth } from './engineHealth'
import {
  ENGINE_ANNOUNCE_TIMEOUT_MS,
  ENGINE_HEALTH_INTERVAL_MS,
  ENGINE_HEALTH_TIMEOUT_MS,
  ENGINE_STOP_GRACE_MS,
  NEW_ENGINE_EXIT_TRAIL,
  boundedDetail,
  engineExitStep,
  engineRestartDelayMs,
  parseAnnounce,
  redactToken,
  type EngineAnnounce,
  type EngineExitCause,
  type EngineExitLog,
  type EngineExitTrail,
  type EngineFailure,
  type EngineTimer
} from './engineProtocol'

// ------------------------------------------------------------------ the child, structurally
//
// Every shape below is `node:child_process`'s reduced to what a lifecycle decision needs — the
// `PriorityWebContents` discipline (processPriority.ts): the real objects satisfy these by
// structure, and a test's fakes do too, so neither is a cast. Method parameters compare
// BIVARIANTLY, which is why `signal: string | null` here accepts Node's `NodeJS.Signals | null`.

export interface SupervisedStdin {
  write(chunk: string): unknown
  /** Closing stdin IS the shutdown signal — contract rule 3. */
  end(): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
}

export interface SupervisedStream {
  setEncoding(encoding: string): unknown
  on(event: 'data', listener: (chunk: string) => void): unknown
}

export interface SupervisedChild {
  /** OPTIONAL, not `number | undefined`: Node declares it optional on `ChildProcess` (it is absent
   *  until the process actually exists), and a required-but-undefined property is a different type
   *  that the real object does not satisfy. */
  readonly pid?: number
  readonly stdin: SupervisedStdin | null
  readonly stdout: SupervisedStream | null
  readonly stderr: SupervisedStream | null
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  /** NO SIGNAL PARAMETER, and that is the interface stating a policy rather than being lazy: the
   *  escalation sends the DEFAULT (`SIGTERM`, which on Windows is a `TerminateProcess`), and a seam
   *  that could carry a signal would be a seam somebody could send `SIGKILL` through on a platform
   *  that does not have it. It also makes the shape satisfiable: Node's `kill(signal?: Signals |
   *  number)` is not comparable to a `string` parameter in either direction. */
  kill(): unknown
  /** The engine must never hold a quitting app open. */
  unref(): unknown
}

/** Where the supervisor is right now. Observable so the dev log and a test can both read it. */
export type EngineStatus = 'stopped' | 'absent' | 'starting' | 'ready' | 'backoff' | 'stopping'

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

/** Everything the composition root hands this module. No Electron reaches past this interface. */
export interface EngineSupervisorDeps {
  /** The engine binary's path, or null when this build has none — see `beginLaunch`. */
  resolveBinary(): string | null
  spawn(binPath: string): SupervisedChild
  connect(port: number): Promise<ByteChannel>
  /** `src/main/dataServer/token.ts mintToken`. Injected so a test can pin what was written. */
  mintToken(): string
  timer: EngineTimer
  now(): number
  /** The dev log. */
  debug(line: string): void
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
  /** TEST SEAMS — every clock, and the wire version. */
  protocolVersion?: number
  announceTimeoutMs?: number
  stopGraceMs?: number
  healthIntervalMs?: number
  healthTimeoutMs?: number
}

/** ONE launch's whole mutable world. A respawn builds a new one; nothing is reused. */
interface Launch {
  readonly child: SupervisedChild
  readonly startedAt: number
  readonly token: string
  announce: EngineAnnounce | null
  /** The engine's last stderr line, kept as the `detail` a failure report carries. */
  lastStderr: string | null
  /** Has this launch already been folded? The idempotence latch — see `endLaunch`. */
  finished: boolean
  cancelAnnounce: (() => void) | null
  cancelHealth: (() => void) | null
  cancelGrace: (() => void) | null
}

/** What `endLaunch` is told about the ending. `alive` defaults to TRUE — the safe direction: a
 *  child we wrongly believe is dead is a child nobody retires. */
interface EndInfo {
  exitCode?: number | null
  signal?: string | null
  detail?: unknown
  alive?: boolean
}

export class EngineSupervisor {
  private status: EngineStatus = 'stopped'
  private launch: Launch | null = null
  private trail: EngineExitTrail = NEW_ENGINE_EXIT_TRAIL
  private failures = 0
  private cancelRestart: (() => void) | null = null
  /** Set by `stop()`. A stop must survive a launch that is mid-handshake, so it is a latch rather
   *  than a status read: an async health probe that resolves afterwards checks THIS. */
  private stopping = false
  private readonly protocolVersion: number
  private readonly announceTimeoutMs: number
  private readonly stopGraceMs: number
  private readonly healthIntervalMs: number
  private readonly healthTimeoutMs: number

  constructor(private readonly deps: EngineSupervisorDeps) {
    this.protocolVersion = deps.protocolVersion ?? PROTOCOL_VERSION
    this.announceTimeoutMs = deps.announceTimeoutMs ?? ENGINE_ANNOUNCE_TIMEOUT_MS
    this.stopGraceMs = deps.stopGraceMs ?? ENGINE_STOP_GRACE_MS
    this.healthIntervalMs = deps.healthIntervalMs ?? ENGINE_HEALTH_INTERVAL_MS
    this.healthTimeoutMs = deps.healthTimeoutMs ?? ENGINE_HEALTH_TIMEOUT_MS
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
    l.cancelHealth?.()
    l.cancelAnnounce = null
    l.cancelHealth = null
    this.deps.debug('data-server engine: closing stdin (the shutdown signal)')
    this.retire(l)
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
      lastStderr: null,
      finished: false,
      cancelAnnounce: null,
      cancelHealth: null,
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
    this.probeHealth(l, true)
  }

  private onExit(l: Launch, code: number | null, signal: string | null): void {
    if (this.stopping) {
      // A DELIBERATE STOP IS NOT A FAILURE (`presence.ts stopWatcher`'s rule): no report, no trail,
      // no respawn — whatever the exit code says. We asked for this.
      l.finished = true
      clearLaunchTimers(l)
      this.deps.onPid?.(null)
      this.deps.onReady?.(null)
      if (this.launch === l) this.launch = null
      this.status = 'stopped'
      this.deps.debug(`data-server engine: exited ${String(code ?? -1)} after the shutdown signal`)
      return
    }
    this.endLaunch(l, 'exited', { exitCode: code, signal, alive: false })
  }

  // ------------------------------------------------------------------ health

  /** One health round-trip, and the reschedule that makes it a watchdog. */
  private probeHealth(l: Launch, first: boolean): void {
    const announce = l.announce
    if (!announce) return
    void this.runProbe(l, announce)
      .then((health) => {
        if (l.finished || this.stopping) return
        if (first) this.reachedReady(l, announce, health)
        l.cancelHealth = this.deps.timer(() => this.probeHealth(l, false), this.healthIntervalMs)
      })
      .catch((err: unknown) => {
        if (l.finished || this.stopping) return
        // A wedged engine is indistinguishable from a healthy one except through an unanswered
        // round-trip — the presence stale-watchdog's whole argument, restated for a process.
        this.endLaunch(l, 'unhealthy', { detail: describeErr(err), alive: true })
      })
  }

  private async runProbe(l: Launch, announce: EngineAnnounce): Promise<EngineHealth> {
    const channel = await this.deps.connect(announce.port)
    return engineHealthCheck({
      channel,
      token: l.token,
      protocolVersion: this.protocolVersion,
      timeoutMs: this.healthTimeoutMs,
      timer: this.deps.timer
    })
  }

  /** The one place a launch becomes THE engine — and the backoff resets HERE, on a proven
   *  round-trip rather than on a process that merely started. */
  private reachedReady(l: Launch, announce: EngineAnnounce, health: EngineHealth): void {
    this.status = 'ready'
    this.failures = 0
    this.trail = NEW_ENGINE_EXIT_TRAIL
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
  private endLaunch(l: Launch, failure: EngineFailure, info: EndInfo): void {
    if (l.finished) return
    l.finished = true
    clearLaunchTimers(l)
    this.deps.onPid?.(null)
    this.deps.onReady?.(null)
    this.fold({
      failure,
      exitCode: info.exitCode ?? null,
      signal: info.signal ?? null,
      lifetimeMs: Math.max(0, this.deps.now() - l.startedAt),
      detail: boundedDetail(info.detail) ?? l.lastStderr
    })
    // The child may still be running (a timeout, a bad announce, a failed health probe). Retiring it
    // is not optional — see `retire`. On the exit path it costs one `end()` on a closed pipe.
    if (info.alive !== false) this.retire(l)
    if (this.launch === l) this.launch = null
    if (this.stopping) {
      this.status = 'stopped'
      return
    }
    this.scheduleRestart()
  }

  /** Count the failure, fold it into the trail, report what the fold says to report. */
  private fold(cause: Omit<EngineExitCause, 'attempt'>): void {
    this.failures += 1
    const step = engineExitStep(this.trail, { ...cause, attempt: this.failures })
    this.trail = step.trail
    if (step.log) this.deps.report(step.log)
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

/** Every timer one launch owns, cancelled. */
function clearLaunchTimers(l: Launch): void {
  l.cancelAnnounce?.()
  l.cancelHealth?.()
  l.cancelGrace?.()
  l.cancelAnnounce = null
  l.cancelHealth = null
  l.cancelGrace = null
}

/**
 * Split one of the child's streams into lines. `LineDecoder` is the shared codec — the same one the
 * wire uses — so there is exactly one answer in this repo to "where does a line end".
 *
 * IT CANNOT THROW INTO THE STREAM. `LineDecoder.push` raises on a frame past its ceiling, and a
 * throw inside a `'data'` handler is an uncaught exception in the main process — i.e. a child that
 * printed 8 MB with no newline could take the app down. A decoder that has given up is simply
 * stopped: the launch will fail its announce timeout or its next health probe, which are the paths
 * built to handle it.
 */
function readLines(stream: SupervisedStream | null, onLine: (line: string) => void): void {
  if (!stream) return
  const decoder = new LineDecoder()
  let dead = false
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    if (dead) return
    let lines: string[]
    try {
      lines = decoder.push(chunk)
    } catch {
      dead = true
      return
    }
    for (const line of lines) {
      if (line.trim() !== '') onLine(line)
    }
  })
}

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A stream line on its way to the dev log: bounded and control-free, like every other outside
 *  string in this feature. */
function trim(line: string): string {
  return boundedDetail(line) ?? '(blank)'
}
