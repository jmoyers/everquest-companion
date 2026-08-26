// ============================================================================
// engineHealth.ts — "is it actually serving?", asked over the real protocol (JOS-467).
// ============================================================================
//
// A CHILD IN THE PROCESS TABLE IS NOT A DATA SERVER. `spawn` resolving, and even the announce line
// arriving, proves the binary started and reached its listener — it proves nothing about whether a
// connection to that port is answered, whether the token it was handed is the token it verifies
// against, or whether the wire version it prints is the one it actually speaks. Those are three
// different ways a launch can be silently dead, and the only observation that covers all three is a
// ROUND TRIP over the product's own door.
//
// So the health probe is not a ping this file invents. It is `hello` followed by `session.health` —
// contract rule 4 ("every TCP connection opens with a valid hello or is closed") and API surface 1
// (plan §"The eight API surfaces"), sent through the generated types and the shared transport. The
// supervisor's readiness therefore means exactly what a renderer's first connection will mean, and
// there is no second definition of "up" to drift from the first.
//
// IT TAKES A `ByteChannel`, NOT A SOCKET, and that is the seam doing its job (transport.ts's
// header): this file cannot learn what a frame is, so it survives the day the wire becomes
// WebSockets, and the whole conversation is a unit test over an in-memory pipe with no port
// anywhere. `socketChannel.ts` is the only file in this feature that knows a socket exists.
//
// EVERY FAILURE IS THE SAME OUTCOME — a rejected promise carrying a bounded reason — because the
// supervisor's answer to all of them is identical: this launch did not work, kill it and back off.
// The REASON is what makes the error-store row diagnosable, so it is specific even though the
// branch is not.

import { createNdjsonTransport, type ByteChannel } from '../../shared/dataServer/ndjson'
import type { ClientMessage, EngineMessage } from '../../shared/dataServer/protocol.generated'
import type { EngineTimer } from './engineProtocol'

/**
 * The request id the health probe uses.
 *
 * ONE, and it can be a constant because a probe connection carries exactly one request and is then
 * closed. Correlation ids exist so a multiplexed connection can tell two answers apart; there is no
 * second request here to be confused with. A reply naming any other id is a protocol violation and
 * is treated as one.
 */
export const HEALTH_REQUEST_ID = 1

/** What a healthy engine said about itself. Every field is the engine's own answer, repeated for
 *  the dev log — nothing here is a policy input. */
export interface EngineHealth {
  /** The engine binary's own version (informational; `protocolVersion` is the compatibility check). */
  readonly engineVersion: string
  readonly protocolVersion: number
  readonly status: string
  readonly epoch: number
  readonly uptimeMs: number
}

/** Why a probe failed. A closed set, so the supervisor's report can name it without repeating a
 *  sentence the engine wrote. */
export type HealthFailure =
  | 'connect'
  | 'timeout'
  | 'closed'
  | 'transport'
  | 'refused'
  | 'protocolMismatch'
  | 'unexpected'

export class EngineHealthError extends Error {
  constructor(
    readonly reason: HealthFailure,
    message: string
  ) {
    super(message)
    this.name = 'EngineHealthError'
  }
}

/** What one probe needs. An options object rather than five parameters — `max-params` is 4 here,
 *  and a call site reading `{ channel, token, … }` is the better artifact anyway. */
export interface HealthProbeOptions {
  readonly channel: ByteChannel
  /** The per-launch token, presented ONCE in the hello. Never logged, never persisted. */
  readonly token: string
  /** The version WE were generated against. A mismatch is fatal by ruling. */
  readonly protocolVersion: number
  readonly timeoutMs: number
  readonly timer: EngineTimer
}

/** The probe's two-step conversation, as a state a single message handler can read. */
type ProbeStep = 'hello' | 'health'

/** Narrow a `Reply.result` to the health shape without a cast: the registry is closed, so the two
 *  fields no other arm carries are the whole test. */
function asHealthResult(result: unknown): { status: string; epoch: number; uptimeMs: number } | null {
  if (typeof result !== 'object' || result === null) return null
  const r = result as Record<string, unknown>
  if (typeof r.status !== 'string' || typeof r.epoch !== 'number' || typeof r.uptimeMs !== 'number') {
    return null
  }
  return { status: r.status, epoch: r.epoch, uptimeMs: r.uptimeMs }
}

/**
 * Run one probe: hello, then `session.health`, then close.
 *
 * THE CHANNEL IS ALWAYS CLOSED, on every path including success — a probe every 30 s that leaked a
 * socket would be a file-descriptor leak with a health check's name on it. `Transport.close()` is
 * idempotent and closes the channel under it, so the single `settle` below is the whole discipline.
 *
 * THE TIMEOUT IS THE OUTER BOUND ON THE WHOLE CONVERSATION, not per message: a peer that answers
 * `hello` in 4.9 s and then says nothing has still failed, and two independent clocks would let it
 * hold a probe open for twice as long as anyone budgeted.
 */
export async function engineHealthCheck(opts: HealthProbeOptions): Promise<EngineHealth> {
  // A HANG-UP WITH NOTHING SAID IS AN ANSWER, AND THE TRANSPORT DOES NOT REPORT IT. Read
  // `createNdjsonTransport`'s close path: a stream that ends cleanly on a frame boundary simply
  // marks itself closed — there is no error, because at the transport's level nothing went wrong.
  // But contract rule 4 says the engine CLOSES a connection it refuses, so silence-then-FIN is
  // precisely how a rejected token arrives, and a probe that only noticed it on the 5 s timeout
  // would turn the commonest refusal into the slowest one. The wrapper below sees the close the
  // transport is about to swallow, without taking it away from the transport.
  let onHangUp: (() => void) | null = null
  const transport = createNdjsonTransport<ClientMessage, EngineMessage>(
    watchClose(opts.channel, () => onHangUp?.())
  )
  return new Promise<EngineHealth>((resolve, reject) => {
    const probe: ProbeState = {
      step: 'hello',
      done: false,
      hello: null,
      ours: opts.protocolVersion,
      fail: (reason, message) => {
        if (probe.done) return
        probe.done = true
        cancel()
        transport.close()
        reject(new EngineHealthError(reason, message))
      },
      ok: (health) => {
        if (probe.done) return
        probe.done = true
        cancel()
        transport.close()
        resolve(health)
      },
      sendHealth: () => {
        probe.step = 'health'
        transport.send({ id: HEALTH_REQUEST_ID, op: 'session.health', params: {} })
      }
    }
    const cancel = opts.timer(() => {
      probe.fail('timeout', `the engine did not answer ${probe.step} within ${String(opts.timeoutMs)} ms`)
    }, opts.timeoutMs)
    onHangUp = () => {
      probe.fail('closed', `the engine closed the connection during ${probe.step}`)
    }

    // `code: 'closed'`/`'io'` is the peer hanging up. Contract rule 4 says the engine closes a
    // connection it refuses, so a close with no reply IS an answer — and it is the one a client must
    // read the same way as an explicit `ok:false` (HelloReply's own doc says so).
    transport.onError((err) => {
      probe.fail(err.code === 'closed' || err.code === 'io' ? 'closed' : 'transport', err.message)
    })
    transport.onMessage((msg) => {
      if (probe.step === 'hello') handleHello(msg, probe)
      else handleHealth(msg, probe)
    })

    try {
      transport.send({ op: 'hello', token: opts.token, protocolVersion: opts.protocolVersion })
    } catch (err) {
      probe.fail('transport', err instanceof Error ? err.message : String(err))
    }
  })
}

/**
 * A channel that tells a SECOND listener about the end of the stream.
 *
 * `ByteChannel.onClose` registers ONE handler by contract (a stream with two readers is a stream
 * with a race), and the transport rightly claims it. This forwards rather than competes: the
 * transport's handler runs first and unchanged, then ours. Everything else passes straight through,
 * so this adds no behaviour of its own and cannot become a second opinion about the wire.
 */
function watchClose(channel: ByteChannel, onEnd: () => void): ByteChannel {
  return {
    write: (chunk) => channel.write(chunk),
    onData: (handler) => channel.onData(handler),
    onClose: (handler) =>
      channel.onClose((error) => {
        handler(error)
        onEnd()
      }),
    close: () => channel.close()
  }
}

/**
 * The probe's whole mutable world, in one object.
 *
 * It exists so the two message steps below can be TOP-LEVEL functions — each inside its own
 * complexity budget, each readable on its own — instead of two nested branches of one closure. The
 * hello's facts are held here because the health result the caller wants is the union of both
 * answers, and the second answer does not repeat the first.
 */
interface ProbeState {
  step: ProbeStep
  done: boolean
  hello: { engineVersion: string; protocolVersion: number } | null
  /** The version THIS build was generated against. */
  readonly ours: number
  fail(reason: HealthFailure, message: string): void
  ok(health: EngineHealth): void
  sendHealth(): void
}

/** Step one: the handshake answer, and the ONE compatibility check in the whole feature. */
function handleHello(msg: EngineMessage, probe: ProbeState): void {
  if (msg.kind !== 'hello') {
    probe.fail('unexpected', `the engine sent \`${msg.kind}\` before answering hello`)
    return
  }
  if (!msg.ok) {
    probe.fail('refused', 'the engine refused the token')
    return
  }
  if (msg.protocolVersion !== probe.ours) {
    // FATAL BY RULING, not a state to recover from: both sides generate from one schema artifact,
    // so a mismatch is a build that was assembled wrong. Retrying it forever would be a restart
    // loop against a condition no amount of waiting can fix — which is exactly what the exit-trail
    // fold collapses into one entry.
    probe.fail(
      'protocolMismatch',
      `the engine speaks protocol ${String(msg.protocolVersion)}, this build speaks ${String(probe.ours)}`
    )
    return
  }
  probe.hello = { engineVersion: msg.engineVersion, protocolVersion: msg.protocolVersion }
  probe.sendHealth()
}

/** Step two: the answer to `session.health`, or the reasons it was not one. */
function handleHealth(msg: EngineMessage, probe: ProbeState): void {
  if (msg.kind === 'error') {
    probe.fail('refused', `session.health was refused: ${msg.error.code} — ${msg.error.message}`)
    return
  }
  if (msg.kind !== 'reply' || msg.id !== HEALTH_REQUEST_ID) {
    probe.fail('unexpected', `the engine sent \`${msg.kind}\` where session.health's reply belonged`)
    return
  }
  const health = asHealthResult(msg.result)
  if (health === null) {
    probe.fail('unexpected', 'session.health replied with a result that is not a health result')
    return
  }
  probe.ok({
    engineVersion: probe.hello?.engineVersion ?? '',
    protocolVersion: probe.hello?.protocolVersion ?? probe.ours,
    ...health
  })
}
