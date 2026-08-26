// The instruments the supervisor's state-machine suite drives (JOS-467).
//
// A separate module rather than a block at the top of the test file, for the reason the repo's
// other harnesses are separate (`tests/e2e/settle.mts`): the fakes are a VOCABULARY, and two suites
// already want them — the state-machine suite and, for its clock, anything later that needs a
// deterministic backoff.
//
// NOTHING HERE IS A MOCK LIBRARY. Every fake satisfies the supervisor's structural interfaces by
// shape, exactly as the real `ChildProcess` does (`processPriority.ts`'s `PriorityWebContents`
// discipline), so a test's child and the app's child are the same type and neither is a cast.

import { encodeLine } from '../src/shared/dataServer/ndjson'
import type { ByteChannel } from '../src/shared/dataServer/ndjson'
import type { EngineTimer } from '../src/main/dataServer/engineProtocol'
import type {
  SupervisedChild,
  SupervisedStdin,
  SupervisedStream
} from '../src/main/dataServer/supervisor'

/**
 * A CLOCK A TEST OWNS. Every wait in this feature — the announce timeout, the restart backoff, the
 * stop grace, the health interval — goes through `EngineTimer`, so a 30 second ceiling is asserted
 * in a microsecond and a suite never sleeps.
 *
 * `advance` fires everything DUE, in the order it was scheduled, and re-checks afterwards: a
 * callback that schedules another timer inside the same window (a respawn that fails again) still
 * runs, which is the whole shape of a crash loop.
 */
export interface FakeClock {
  readonly timer: EngineTimer
  now(): number
  advance(ms: number): void
  pending(): number
}

export function fakeClock(): FakeClock {
  let clock = 0
  let seq = 0
  const due = new Map<number, { at: number; fn: () => void }>()
  const timer: EngineTimer = (fn, ms) => {
    const id = (seq += 1)
    due.set(id, { at: clock + ms, fn })
    return () => due.delete(id)
  }
  const fireDue = (): boolean => {
    for (const [id, entry] of [...due].sort((a, b) => a[1].at - b[1].at)) {
      if (entry.at > clock) continue
      due.delete(id)
      entry.fn()
      return true
    }
    return false
  }
  return {
    timer,
    now: () => clock,
    advance(ms) {
      clock += ms
      // Bounded so a timer that reschedules itself at zero cannot hang the suite instead of failing
      // it — an infinite loop in a test is the hardest kind of red to read.
      for (let guard = 0; guard < 1000 && fireDue(); guard += 1) continue
    },
    pending: () => due.size
  }
}

class FakeStream implements SupervisedStream {
  encoding: string | null = null
  private handler: ((chunk: string) => void) | null = null
  setEncoding(encoding: string): unknown {
    this.encoding = encoding
    return this
  }
  on(_event: 'data', listener: (chunk: string) => void): unknown {
    this.handler = listener
    return this
  }
  /** Push bytes at the supervisor the way an OS pipe would — in whatever chunk we choose, which is
   *  how the split-frame case gets tested for free. */
  emit(chunk: string): void {
    this.handler?.(chunk)
  }
}

class FakeStdin implements SupervisedStdin {
  written = ''
  ended = false
  errorHandlers = 0
  write(chunk: string): unknown {
    this.written += chunk
    return true
  }
  end(): unknown {
    this.ended = true
    return this
  }
  on(_event: 'error', _listener: (err: Error) => void): unknown {
    this.errorHandlers += 1
    return this
  }
}

let pidSeq = 4000

/** A child process, structurally, with a test at the other end of every pipe. */
export class FakeChild implements SupervisedChild {
  readonly pid = (pidSeq += 1)
  readonly stdin = new FakeStdin()
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()
  kills = 0
  unrefs = 0
  private readonly onExitCbs: ((code: number | null, signal: string | null) => void)[] = []
  private readonly onErrorCbs: ((err: Error) => void)[] = []

  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: string, listener: unknown): unknown {
    if (event === 'exit') this.onExitCbs.push(listener as (c: number | null, s: string | null) => void)
    else this.onErrorCbs.push(listener as (e: Error) => void)
    return this
  }
  kill(): unknown {
    this.kills += 1
    return true
  }
  unref(): unknown {
    this.unrefs += 1
    return this
  }

  /** The one line the contract allows on stdout. */
  announce(port = 51413, protocolVersion = 1): void {
    this.stdout.emit(`EQC-ENGINE PORT=${String(port)} PROTOCOL=${String(protocolVersion)}\n`)
  }
  exit(code: number | null, signal: string | null = null): void {
    for (const cb of [...this.onExitCbs]) cb(code, signal)
  }
  failToStart(err: Error): void {
    for (const cb of [...this.onErrorCbs]) cb(err)
  }
}

/** How a scripted engine answers a probe. Each is a real binary somebody will ship one day. */
export type ChannelBehaviour = 'ok' | 'refuse' | 'mute' | 'mismatch' | 'closed'

/**
 * An engine at the far end of a `ByteChannel`, scripted.
 *
 * It speaks the real NDJSON framing and the real generated shapes — the seam being exercised is the
 * one the renderer will use — but it is not the engine and knows nothing but `hello` and
 * `session.health`. Replies arrive on a microtask so the supervisor's promise chain behaves exactly
 * as it does over a socket: nothing resolves inside the call that sent it.
 */
export function scriptedChannel(token: string, behaviour: ChannelBehaviour, protocol = 1): ByteChannel {
  let onData: ((chunk: string) => void) | undefined
  let onClose: ((error?: unknown) => void) | undefined
  let greeted = false
  let closed = false
  const reply = (message: unknown): void => {
    queueMicrotask(() => {
      if (!closed) onData?.(encodeLine(message))
    })
  }
  const hangUp = (): void => {
    queueMicrotask(() => {
      if (closed) return
      closed = true
      onClose?.()
    })
  }
  return {
    write(chunk) {
      if (closed) return
      for (const line of chunk.split('\n')) {
        if (line.trim() === '') continue
        answer(JSON.parse(line) as Record<string, unknown>)
      }
    },
    onData(handler) {
      onData = handler
    },
    onClose(handler) {
      onClose = handler
    },
    close() {
      closed = true
    }
  }

  function answer(message: Record<string, unknown>): void {
    if (behaviour === 'closed') {
      hangUp()
      return
    }
    if (!greeted) {
      // Contract rule 4: a connection opens with a valid hello or is CLOSED. `refuse` is the token
      // check working, seen from the caller's side.
      if (message.op !== 'hello' || message.token !== token || behaviour === 'refuse') {
        hangUp()
        return
      }
      greeted = true
      reply({
        kind: 'hello',
        ok: true,
        engineVersion: '0.0.0-scripted',
        protocolVersion: behaviour === 'mismatch' ? protocol + 1 : protocol
      })
      return
    }
    // `mute`: the socket is up and the fold is wedged. Only an unanswered round-trip can see it.
    if (behaviour === 'mute') return
    reply({
      kind: 'reply',
      id: message.id,
      ok: true,
      result: { status: 'idle', epoch: 1, uptimeMs: 1234 }
    })
  }
}
