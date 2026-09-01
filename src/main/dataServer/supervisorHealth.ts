// ============================================================================
// supervisorHealth.ts — the watchdog over ONE launch: two strikes, and a machine that sleeps.
// ============================================================================
//
// SPLIT OUT OF `supervisor.ts` at the measured 400-code-line ceiling, where the house rule is to
// split rather than to ratchet — `supervisorChild.ts` made the same move for the same reason. The
// seam is honest as well as arithmetic: everything here is about ONE launch's health cadence, and
// the state machine next door is about a lifecycle. It owns no child, no token trail and no backoff.
//
// A FAILED PROBE IS NOT A VERDICT ON THE FIRST ASK. The evidence is 122 EngineUnhealthy reports in
// two days across the fleet, every one of them saying the engine did not answer health inside its
// budget and every one of them recovering on restart attempt 1 — i.e. the engine was there. A false
// kill costs the player a whole re-fold, so a reason a SERVING engine can produce
// (`isTransientHealthFailure`) buys exactly ONE more ask, immediately, on a FRESH CONNECTION,
// because the suspicion is about the socket as much as about the fold. Exactly one: two strikes is a
// second opinion, three would be a policy of not believing the instrument.
//
// AND A SUSPEND IS NOT A SYMPTOM. Windows freezes every `setTimeout` in the process without
// crediting the sleep, so a probe armed before the lid closed lands on a socket that has been dead
// for hours and reports a wedge that never happened. On suspend the watch stands down and an
// in-flight answer stops being its business; on resume it waits `ENGINE_RESUME_GRACE_MS` — the
// machine is still coming back, and a no from a machine that is still coming back is not a
// diagnosis — and then asks fresh.

import type { ByteChannel } from '../../shared/dataServer/ndjson'
import {
  engineHealthCheck,
  healthFailureReason,
  isTransientHealthFailure,
  type EngineHealth
} from './engineHealth'
import {
  ENGINE_HEALTH_INTERVAL_MS,
  ENGINE_HEALTH_TIMEOUT_MS,
  ENGINE_LOCAL_SOCKET_GRACE_MS,
  ENGINE_LOCAL_SOCKET_STREAK,
  ENGINE_RESUME_GRACE_MS,
  type EngineTimer,
  type HealthFailure
} from './engineProtocol'

/**
 * What the watchdog needs from the composition root — a SLICE of `EngineSupervisorDeps`, which
 * EXTENDS this interface rather than restating it. One declaration means the app's wiring and this
 * file cannot drift, and a test that already builds supervisor deps builds these for free.
 */
export interface HealthWatchDeps {
  connect(port: number): Promise<ByteChannel>
  timer: EngineTimer
  /** The dev log. */
  debug(line: string): void
  /** TEST SEAMS — every clock this watchdog has. */
  healthIntervalMs?: number
  healthTimeoutMs?: number
  resumeGraceMs?: number
  localSocketGraceMs?: number
  localSocketStreak?: number
}

/** The launch being asked about. Fixed for the watch's whole life: a respawn is a launch (contract
 *  rule 5), so it gets a new port, a new token and a new watch. */
export interface HealthWatchTarget {
  readonly port: number
  readonly token: string
  readonly protocolVersion: number
}

/** What the watch tells the supervisor, and the only two things it has an opinion about. */
export interface HealthWatchListener {
  /** A round trip answered. `first` is the launch's very first one — the READY edge. */
  onHealthy(health: EngineHealth, first: boolean): void
  /** The launch is not serving, and the reasons say how the watch concluded it: one entry where the
   *  reason was fatal on the first ask, two where a transient failure was confirmed. `err` is the
   *  LAST probe's own error, which is the sentence a failure report already carried. */
  onUnhealthy(reasons: readonly HealthFailure[], err: unknown): void
  /**
   * THIS PROCESS COULD NOT OPEN A SOCKET, `ENGINE_LOCAL_SOCKET_STREAK` times running.
   *
   * A SECOND EDGE RATHER THAN A REASON ON THE FIRST, because the two say opposite things about the
   * launch: `onUnhealthy` means retire the engine, this means the engine is fine and we are not.
   * Fired ONCE per watch — the condition is a drip, and one entry is the diagnosis.
   */
  onLocalSocket(tries: number, err: unknown): void
}

/** The watch, as its owner holds it. Every verb is idempotent. */
export interface LaunchHealthWatch {
  /** This launch is over: nothing further is scheduled and no answer still in flight is reported. */
  stop(): void
  suspend(): void
  resume(): void
}

/**
 * Arm the watchdog for one launch. The first probe starts AT ONCE, which is what makes the launch's
 * READY edge a proven round trip rather than a process that started.
 */
export function createLaunchHealthWatch(
  deps: HealthWatchDeps,
  target: HealthWatchTarget,
  on: HealthWatchListener
): LaunchHealthWatch {
  const watch = new HealthWatch(deps, target, on)
  watch.begin()
  return watch
}

class HealthWatch implements LaunchHealthWatch {
  /** The launch is over. A latch rather than a status, for `Launch.finished`'s reason exactly. */
  private stopped = false
  private paused = false
  /**
   * WHICH ROUND'S ANSWER STILL COUNTS. A promise cannot be cancelled, so "cancel the in-flight
   * probe" is really "stop being its caller": a suspend or a stop bumps this, and an answer stamped
   * with an older number is dropped. The probe's own timeout still closes its transport, so nothing
   * is leaked by being ignored.
   */
  private round = 0
  private first = true
  /** Consecutive asks that never reached the engine. Reset by any answer — see `answered`. */
  private localTries = 0
  /** Has the one local-socket entry been written for this watch? See `onLocalSocket`. */
  private localSaid = false
  private cancel: (() => void) | null = null
  private readonly intervalMs: number
  private readonly timeoutMs: number
  private readonly graceMs: number
  private readonly localGraceMs: number
  private readonly localStreak: number

  constructor(
    private readonly deps: HealthWatchDeps,
    private readonly target: HealthWatchTarget,
    private readonly on: HealthWatchListener
  ) {
    this.intervalMs = deps.healthIntervalMs ?? ENGINE_HEALTH_INTERVAL_MS
    this.timeoutMs = deps.healthTimeoutMs ?? ENGINE_HEALTH_TIMEOUT_MS
    this.graceMs = deps.resumeGraceMs ?? ENGINE_RESUME_GRACE_MS
    this.localGraceMs = deps.localSocketGraceMs ?? ENGINE_LOCAL_SOCKET_GRACE_MS
    this.localStreak = deps.localSocketStreak ?? ENGINE_LOCAL_SOCKET_STREAK
  }

  begin(): void {
    this.ask(null)
  }

  stop(): void {
    this.stopped = true
    this.round += 1
    this.cancel?.()
    this.cancel = null
  }

  suspend(): void {
    if (this.stopped || this.paused) return
    this.paused = true
    this.round += 1
    this.cancel?.()
    this.cancel = null
    this.deps.debug('data-server engine: the machine is suspending; the health watchdog stands down')
  }

  resume(): void {
    if (this.stopped || !this.paused) return
    this.paused = false
    this.schedule(this.graceMs)
    this.deps.debug(
      `data-server engine: the machine woke; the health watchdog asks again in ${String(this.graceMs)} ms`
    )
  }

  /** One ask. `strike` is the reason the previous ask failed with, or null when this is the first
   *  ask of a beat — which is the whole of the two-strike rule's state. */
  private ask(strike: HealthFailure | null): void {
    const round = this.round
    void this.probe()
      .then((health) => {
        this.answered(round, health)
      })
      .catch((err: unknown) => {
        this.failed(round, strike, err)
      })
  }

  /**
   * A round trip answered. A confirmation that PASSES forgives the strike before it without saying
   * anything — a transient stall the engine recovered from is exactly what the second ask is for,
   * and a report about a launch that is serving would be the false verdict in the other direction.
   */
  private answered(round: number, health: EngineHealth): void {
    if (this.spent(round)) return
    const first = this.first
    this.first = false
    this.localTries = 0
    this.on.onHealthy(health, first)
    this.schedule(this.intervalMs)
  }

  /** An ask failed. A transient FIRST strike buys the one confirmation; everything else, and the
   *  confirmation itself, is the answer. A local socket is neither — see `localSocket`. */
  private failed(round: number, strike: HealthFailure | null, err: unknown): void {
    if (this.spent(round)) return
    const reason = healthFailureReason(err)
    if (reason === 'localSocket') {
      this.localSocket(err)
      return
    }
    if (strike === null && isTransientHealthFailure(reason)) {
      this.deps.debug(
        `data-server engine: health probe failed (${reason}); confirming on a fresh connection`
      )
      this.ask(reason)
      return
    }
    this.on.onUnhealthy(strike === null ? [reason] : [strike, reason], err)
  }

  /**
   * THE ASK NEVER REACHED THE ENGINE, so it is not a verdict on one and the launch stands.
   *
   * Any strike before it is DROPPED — a confirmation that could not open a socket confirmed nothing.
   * The first few retries take the short grace and then the cadence falls back to the ordinary
   * interval, because a machine with no local ports is not helped by being asked every two seconds.
   */
  private localSocket(err: unknown): void {
    this.localTries += 1
    this.deps.debug(
      `data-server engine: this app could not open a socket to port ${String(this.target.port)} ` +
        `(${String(this.localTries)} in a row); the engine is serving and is not respawned`
    )
    if (this.localTries >= this.localStreak && !this.localSaid) {
      this.localSaid = true
      this.on.onLocalSocket(this.localTries, err)
    }
    this.schedule(this.localTries < this.localStreak ? this.localGraceMs : this.intervalMs)
  }

  /** A FRESH CONNECTION EVERY ASK, which is why a confirmation can disagree with a strike at all:
   *  half of what a probe tests is the socket. */
  private async probe(): Promise<EngineHealth> {
    const channel = await this.deps.connect(this.target.port)
    return engineHealthCheck({
      channel,
      token: this.target.token,
      protocolVersion: this.target.protocolVersion,
      timeoutMs: this.timeoutMs,
      timer: this.deps.timer
    })
  }

  private schedule(ms: number): void {
    this.cancel?.()
    this.cancel = this.deps.timer(() => {
      this.cancel = null
      this.ask(null)
    }, ms)
  }

  /** Is this answer still ours? See `round`. */
  private spent(round: number): boolean {
    return this.stopped || round !== this.round
  }
}
