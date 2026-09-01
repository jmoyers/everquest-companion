// THE SUPERVISOR SUITE'S HARNESS — one supervisor-under-test, fully wired, and everything it said.
//
// SPLIT OUT OF `dataServerSupervisor.test.mts` (JOS-503), when that file passed the measured
// 400-code-line ceiling and the house rule at that ceiling is to split rather than to ratchet.
// `dataServerSupervisorFakes.mts` beside it made the same move for the same reason, and its header
// already states the argument: these are a VOCABULARY, and more than one suite wants them.
// `dataServerSupervisorFault.test.mts` is the second suite.
//
// It is not a mock library either. Every dependency below is the real `EngineSupervisorDeps`
// satisfied by SHAPE, and every list it hands back is simply what the supervisor said through one
// of them — which is what lets an assertion be about a CALLBACK SEQUENCE rather than about a spy.

import { createEngineSupervisor, type EngineFaultCause, type EngineSupervisorDeps, type ReadyEngine } from '../src/main/dataServer/supervisor'
import type { EngineExitLog, EnginePowerHandlers } from '../src/main/dataServer/engineProtocol'
import { FakeChild, connectError, fakeClock, scriptedChannel, type ChannelBehaviour } from './dataServerSupervisorFakes.mts'

/** Everything one supervisor-under-test is wired to, and everything it said. */
export function harness(opts: { binary?: string | null; behaviour?: ChannelBehaviour; spawnThrows?: Error } = {}) {
  const clock = fakeClock()
  const children: FakeChild[] = []
  let power: EnginePowerHandlers | null = null
  const reports: EngineExitLog[] = []
  const logs: string[] = []
  const pids: (number | null)[] = []
  const readies: (ReadyEngine | null)[] = []
  /** THE PERSON'S EDGE (JOS-503) — every `onFault`, in order, `null`s included. */
  const faults: (EngineFaultCause | null)[] = []
  /** THE CYCLING EDGE (JOS-519) — one entry per launch that had SERVED and then died, stamped with
   *  the fake clock so a suite can assert both how many there were and when. */
  const servedExits: number[] = []
  const tokens: string[] = []
  let mintCount = 0
  // MUTABLE, because a health WATCHDOG is only a watchdog if the answer can change under it: the
  // engine that was fine a minute ago is exactly the one this has to catch.
  let behaviour: ChannelBehaviour = opts.behaviour ?? 'ok'
  // …AND A QUEUE BESIDE IT, because a two-strike probe asks TWICE and the interesting cases are the
  // ones where the two asks disagree. A queued entry answers the next connection and is spent; when
  // the queue is empty every connection gets `behaviour`.
  const queued: ChannelBehaviour[] = []
  const connects: ChannelBehaviour[] = []
  const deps: EngineSupervisorDeps = {
    resolveBinary: () => (opts.binary === undefined ? 'C:/repo/engine/target/debug/engined.exe' : opts.binary),
    spawn: () => {
      if (opts.spawnThrows) throw opts.spawnThrows
      const child = new FakeChild()
      children.push(child)
      return child
    },
    connect: (_port) => {
      const next = queued.shift() ?? behaviour
      connects.push(next)
      // A `ConnectRefusal` is the dep rejecting: there is no channel and the engine never heard the
      // question, which is the whole point of the local-socket class.
      if (typeof next === 'object') return Promise.reject(connectError(next.connectFails))
      return Promise.resolve(scriptedChannel(tokens[tokens.length - 1] ?? '', next))
    },
    mintToken: () => {
      mintCount += 1
      const token = `${'a'.repeat(63)}${String(mintCount)}`
      tokens.push(token)
      return token
    },
    timer: clock.timer,
    now: clock.now,
    debug: (line) => logs.push(line),
    report: (log) => reports.push(log),
    onPid: (pid) => pids.push(pid),
    onReady: (engine) => readies.push(engine),
    onFault: (fault) => faults.push(fault),
    onServedExit: () => servedExits.push(clock.now()),
    powerEvents: (handlers) => (power = handlers)
  }
  return {
    clock,
    children,
    reports,
    logs,
    pids,
    readies,
    faults,
    servedExits,
    tokens,
    /** One entry per probe connection, in order, saying which engine answered it. */
    connects,
    supervisor: createEngineSupervisor(deps),
    setBehaviour: (next: ChannelBehaviour) => (behaviour = next),
    /** Script the next N connections, ahead of the standing behaviour. */
    queueBehaviours: (...next: ChannelBehaviour[]) => queued.push(...next),
    /** The machine, as `powerMonitor` would say it. */
    suspend: () => power?.suspend(),
    resume: () => power?.resume()
  }
}

/** What one wired supervisor hands back. Named so a second suite can take it as a parameter. */
export type Harness = ReturnType<typeof harness>

/** Drain the microtask queue AND the macrotask turn, so an async health probe has finished. */
export async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

/** Start, announce, and wait for the health round-trip to land. The ordinary happy launch. */
export async function launched(h: Harness): Promise<FakeChild> {
  h.supervisor.start()
  const child = h.children[h.children.length - 1]
  child.announce()
  await settle()
  return child
}
