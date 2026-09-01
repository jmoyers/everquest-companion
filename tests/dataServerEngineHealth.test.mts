// THE HEALTH PROBE, ASKED DIRECTLY (JOS-522) — what it tolerates and what it still refuses.
//
// A SUITE OF ITS OWN rather than more cases in `dataServerSupervisor.test.mts`, and the reason is
// the same one that split the fault suite out of it: that file is at the measured 400-code-line
// ceiling, and the house rule at a ceiling is to split rather than to ratchet. It is also the
// honest seam — every case below is about ONE probe conversation, and driving it through a
// supervisor would mean asserting the probe's frame handling through a state machine that has its
// own opinions about restarts. `engineHealth.ts`'s own header says the conversation is a unit test
// over an in-memory pipe with no port anywhere; this is that test.
//
// WHY IT EXISTS. The engine broadcasts to EVERY open connection with no subscription filter
// (`engine/crates/engined/src/world.rs broadcast()`), so a probe socket that is open while a fold
// reports progress receives an `epoch` where it expected its own reply. Until JOS-522 that was
// `unexpected` — a protocol violation — and the supervisor killed the engine for it: 381
// EngineUnhealthy errors in one day, each one a healthy engine restarted mid-catch-up so it could
// start its catch-up again. The probe now SKIPS connection-wide frames and keeps waiting. It has
// not become lenient about anything else, which is what the second half of this file pins.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeLine } from '../src/shared/dataServer/ndjson'
import type { ByteChannel } from '../src/shared/dataServer/ndjson'
import type {
  EngineMessage,
  HelloReply,
  Reply,
  ResetMessage
} from '../src/shared/dataServer/protocol.generated'
import {
  engineHealthCheck,
  EngineHealthError,
  healthFailureReason,
  HEALTH_REQUEST_ID,
  isTransientHealthFailure,
  type EngineHealth
} from '../src/main/dataServer/engineHealth'
import type { HealthFailure } from '../src/main/dataServer/engineProtocol'
import { fakeClock } from './dataServerSupervisorFakes.mts'

const TOKEN = 'a'.repeat(64)
const PROTOCOL = 1
const TIMEOUT_MS = 5_000

/** One end of a scripted connection: what the probe said, and the way to say things back. */
interface Wire {
  readonly channel: ByteChannel
  /** Every client frame the probe wrote, decoded, in order. */
  readonly sent: Record<string, unknown>[]
  /** Push engine frames at the probe, in order, the way a socket would — never inside its `write`. */
  send(...messages: EngineMessage[]): void
}

/**
 * A scripted engine, but the SCRIPT IS THE TEST'S.
 *
 * `scriptedChannel` in the supervisor fakes answers on its own; every case here is about the exact
 * INTERLEAVING of broadcasts and replies, so the test has to be the one holding the pen. Frames
 * arrive on a microtask for `scriptedChannel`'s reason: nothing may resolve inside the call that
 * sent it, which is the one behaviour of a socket that matters to a promise chain.
 */
function wire(react: (frame: Record<string, unknown>, w: Wire) => void): Wire {
  let onData: ((chunk: string) => void) | undefined
  let closed = false
  const w: Wire = {
    sent: [],
    send(...messages) {
      for (const message of messages) {
        queueMicrotask(() => {
          if (!closed) onData?.(encodeLine(message))
        })
      }
    },
    channel: {
      write(chunk) {
        if (closed) return
        for (const line of chunk.split('\n')) {
          if (line.trim() === '') continue
          const frame = JSON.parse(line) as Record<string, unknown>
          w.sent.push(frame)
          react(frame, w)
        }
      },
      onData(handler) {
        onData = handler
      },
      onClose() {
        // Nothing here hangs up; the close paths are the supervisor suite's subject.
      },
      close() {
        closed = true
      }
    }
  }
  return w
}

/** Drain the microtask queue AND the macrotask turn, so the probe's chain has finished. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * The two answers a healthy engine gives, at their OWN types rather than at the union's.
 *
 * `HelloReply` and `Reply` rather than `EngineMessage` so the cases below can spread one and
 * override a field — a hello with `ok: false`, a reply naming the wrong id — without a cast
 * standing between the fixture and the shape it claims to be.
 */
const HELLO: HelloReply = {
  kind: 'hello',
  ok: true,
  engineVersion: '0.0.0-scripted',
  protocolVersion: PROTOCOL
}
const HEALTH: Reply = {
  kind: 'reply',
  id: HEALTH_REQUEST_ID,
  ok: true,
  result: { status: 'folding', epoch: 3, uptimeMs: 1234 }
}

/**
 * THE FIVE CONNECTION-WIDE FRAMES, one of each, in the shapes the engine sends.
 *
 * Annotated with the generated types rather than left as loose objects because the generated types
 * are the only statement of what the engine may say — a fixture that drifted from one would be
 * saying the probe tolerates something the engine cannot send. It is DOCUMENTATION, not a gate:
 * `tests/**` is in neither tsconfig today (eslint.config.ts's carve-out says so and calls wiring it
 * up a worthwhile follow-up), so nothing compiles this file. It becomes a gate for free on the day
 * that follow-up lands, which is the cheapest reason to write the annotation now.
 */
const EPOCH_PROGRESS: EngineMessage = {
  kind: 'epoch',
  epoch: 3,
  reason: 'progress',
  progress: { pct: 62.4, events: 918_233, offset: 128_000_000, logSize: 205_000_000 }
}
const EPOCH_ATTACH: EngineMessage = { kind: 'epoch', epoch: 4, reason: 'attach' }
const FIRE: EngineMessage = {
  kind: 'fire',
  at: 1_724_700_000_000,
  rule: 'Mez broke',
  sound: 'default/ding',
  message: 'Your target resisted the Mesmerization spell.'
}
const CON_CARD: EngineMessage = {
  kind: 'conCard',
  at: 1_724_700_000_000,
  id: 'a-gnoll-pup',
  name: 'a gnoll pup',
  chips: [],
  spellData: false
}
const MODULE_CHANGED: EngineMessage = { kind: 'moduleChanged', module: 'loot', seq: 77 }
const KNOWLEDGE_MISS: EngineMessage = { kind: 'knowledgeMiss', domain: 'item', name: 'Cloak of Flames' }

/** Run one probe against a scripted wire, with a clock the test owns. */
function probe(w: Wire, clock = fakeClock()): { result: Promise<EngineHealth>; clock: ReturnType<typeof fakeClock> } {
  return {
    result: engineHealthCheck({
      channel: w.channel,
      token: TOKEN,
      protocolVersion: PROTOCOL,
      timeoutMs: TIMEOUT_MS,
      timer: clock.timer
    }),
    clock
  }
}

// ---- what the probe now tolerates: frames addressed to the CONNECTION -----------------------

test('A BROADCAST BEFORE THE HELLO REPLY IS SKIPPED, not a violation', async () => {
  // The commonest shape in the incident: the probe connects, the fold's 10 Hz progress beat reaches
  // every open connection, and the beat wins the race against the handshake answer.
  const w = wire((frame, wr) => {
    if (frame.op === 'hello') wr.send(EPOCH_PROGRESS, HELLO)
    else wr.send(HEALTH)
  })
  const health = await probe(w).result
  assert.equal(health.status, 'folding')
  assert.equal(health.engineVersion, '0.0.0-scripted')
  assert.equal(health.protocolVersion, PROTOCOL)
})

test('A BROADCAST BETWEEN HELLO AND THE HEALTH REPLY IS SKIPPED', async () => {
  const w = wire((frame, wr) => {
    if (frame.op === 'hello') wr.send(HELLO)
    else wr.send(EPOCH_PROGRESS, HEALTH)
  })
  const health = await probe(w).result
  assert.equal(health.epoch, 3)
  assert.equal(health.uptimeMs, 1234)
})

test('MANY BROADCASTS IN A ROW ARE ALL SKIPPED — a fold beating at 10 Hz under a probe', async () => {
  const w = wire((frame, wr) => {
    if (frame.op === 'hello') wr.send(EPOCH_PROGRESS, EPOCH_PROGRESS, EPOCH_PROGRESS, HELLO)
    else wr.send(EPOCH_PROGRESS, EPOCH_PROGRESS, HEALTH)
  })
  const health = await probe(w).result
  assert.equal(health.status, 'folding')
})

test('EVERY CONNECTION-WIDE KIND IS SKIPPED, not just the epoch that caused the incident', async () => {
  // The set is closed and it is the one `broadcast()` sends: a fold that fires an alert, draws a
  // con card, moves a module cursor or misses a name reaches a probe socket exactly as progress
  // does, and each of them was fatal for the same wrong reason.
  const all = [EPOCH_ATTACH, FIRE, CON_CARD, MODULE_CHANGED, KNOWLEDGE_MISS]
  const w = wire((frame, wr) => {
    if (frame.op === 'hello') wr.send(...all, HELLO)
    else wr.send(...all, HEALTH)
  })
  const health = await probe(w).result
  assert.equal(health.status, 'folding')
})

// ---- what it still refuses: everything that was never addressed to the connection -----------

test('A REPLY NAMING THE WRONG ID IS STILL `unexpected`', async () => {
  const w = wire((frame, wr) => {
    if (frame.op === 'hello') wr.send(HELLO)
    else wr.send(EPOCH_PROGRESS, { ...HEALTH, id: HEALTH_REQUEST_ID + 1 })
  })
  await assert.rejects(probe(w).result, (err: unknown) => {
    assert.ok(err instanceof EngineHealthError)
    assert.equal(err.reason, 'unexpected')
    return true
  })
})

test('A SUBSCRIPTION FRAME IS STILL `unexpected` — this connection never subscribed', async () => {
  // `reset` and `diff` carry an `id` and answer a subscription the probe never opened. They are the
  // line: tolerating a frame nobody addressed to us is not the same as tolerating a wrong answer.
  const subscriptionFrame: ResetMessage = { kind: 'reset', id: 9, epoch: 3, total: 0, rows: [] }
  const w = wire((_frame, wr) => {
    wr.send(subscriptionFrame)
  })
  await assert.rejects(probe(w).result, (err: unknown) => {
    assert.ok(err instanceof EngineHealthError)
    assert.equal(err.reason, 'unexpected')
    assert.match(err.message, /before answering hello/)
    return true
  })
})

test('THE REFUSALS AND THE MISMATCH ARE UNTOUCHED', async () => {
  const refused = wire((_frame, wr) => {
    wr.send(EPOCH_PROGRESS, { ...HELLO, ok: false })
  })
  await assert.rejects(probe(refused).result, (err: unknown) => {
    assert.equal((err as EngineHealthError).reason, 'refused')
    return true
  })
  const skewed = wire((_frame, wr) => {
    wr.send(EPOCH_PROGRESS, { ...HELLO, protocolVersion: PROTOCOL + 1 })
  })
  await assert.rejects(probe(skewed).result, (err: unknown) => {
    assert.equal((err as EngineHealthError).reason, 'protocolMismatch')
    return true
  })
})

test('SKIPPING DOES NOT RESET THE CLOCK — a chatty engine that never answers still times out', async () => {
  // The house rule from the brief, pinned: the 5 s bound is on the WHOLE conversation. An engine
  // that streams progress forever and never answers `session.health` must fail at the same instant
  // a mute one does, or a wedged fold could hold a probe open for as long as it kept talking.
  const w = wire((frame, wr) => {
    if (frame.op === 'hello') wr.send(HELLO)
    else wr.send(EPOCH_PROGRESS, EPOCH_PROGRESS, EPOCH_PROGRESS)
  })
  const { result, clock } = probe(w)
  const seen: unknown[] = []
  void result.catch((err: unknown) => seen.push(err))
  await settle()
  clock.advance(TIMEOUT_MS - 1)
  await settle()
  assert.equal(seen.length, 0, 'not a millisecond early')
  clock.advance(1)
  await settle()
  assert.equal(seen.length, 1)
  const err = seen[0]
  assert.ok(err instanceof EngineHealthError)
  assert.equal(err.reason, 'timeout')
  assert.match(err.message, /health/, 'the step it died in is the one it was actually waiting on')
})

// ---- which failures are worth a second ask (JOS-526) -----------------------------------------

test('THE TRANSIENT SET IS EXACTLY THE FOUR A SERVING ENGINE CAN PRODUCE', () => {
  // The line the two-strike rule draws. A stall, a refused connect, a hang-up and a transport error
  // are all things an engine that is fine can do under load; the other three are statements about
  // the credential, the build, or a peer that is not speaking this protocol, and asking again cannot
  // change any of them. The list is spelled out here rather than imported so a widening of the set
  // has to be written down twice.
  const every: HealthFailure[] = [
    'connect',
    'timeout',
    'closed',
    'transport',
    'refused',
    'protocolMismatch',
    'unexpected',
    'localSocket'
  ]
  assert.deepEqual(every.filter(isTransientHealthFailure), [
    'connect',
    'timeout',
    'closed',
    'transport',
    'localSocket'
  ])
})

test('A REJECTION CARRIES ITS REASON, AND ANYTHING ELSE IS THE CONNECT', () => {
  // `engineHealthCheck` rejects only with its own error; the one other thing a caller can catch is
  // the connect that has to succeed before the conversation starts, which has no reason of its own.
  assert.equal(healthFailureReason(new EngineHealthError('timeout', 'no answer')), 'timeout')
  assert.equal(healthFailureReason(new Error('ECONNREFUSED 127.0.0.1:51413')), 'connect')
  assert.equal(healthFailureReason('nothing throwable is off the table'), 'connect')
})

test('THE ERRNO SEPARATES OUR SOCKET FROM THE ENGINE — the field EADDRINUSE was never the listener', () => {
  // The message says `connect … 127.0.0.1:<engine port>` either way: Node stamps the DESTINATION on
  // every connect error, so only the code can say which endpoint failed.
  const withCode = (code: string): Error => Object.assign(new Error(`connect ${code} 127.0.0.1:51413`), { code })
  for (const code of ['EADDRINUSE', 'EADDRNOTAVAIL', 'EMFILE', 'ENFILE', 'ENOBUFS']) {
    assert.equal(healthFailureReason(withCode(code)), 'localSocket', code)
  }
  // Anything not on the list stays evidence about the engine — the safe direction.
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']) {
    assert.equal(healthFailureReason(withCode(code)), 'connect', code)
  }
  // The connect TIMEOUT rejects with a plain Error and no code at all.
  assert.equal(healthFailureReason(new Error('connecting to the engine on port 51413 timed out')), 'connect')
})

test('THE PROBE SAYS EXACTLY TWO THINGS, however many frames it skipped', async () => {
  // Skipping is "keep waiting", never "ask again": a probe that re-sent its request on every
  // broadcast would put a request storm on a busy engine, which is the failure mode this fix must
  // not trade the old one for.
  const w = wire((frame, wr) => {
    if (frame.op === 'hello') wr.send(EPOCH_PROGRESS, EPOCH_PROGRESS, HELLO)
    else wr.send(FIRE, EPOCH_PROGRESS, HEALTH)
  })
  await probe(w).result
  assert.equal(w.sent.length, 2)
  assert.equal(w.sent[0].op, 'hello')
  assert.equal(w.sent[1].op, 'session.health')
})
