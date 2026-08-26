// THE SPAWN CONTRACT, AGAINST A REAL CHILD PROCESS (JOS-467).
//
// The state machine next door (tests/dataServerSupervisor.test.mts) drives every failure path with
// in-process fakes and a clock the test owns, which is the right instrument for a state machine and
// the wrong one for a contract. Three of the five contract rules are claims about the OPERATING
// SYSTEM, and no fake can be wrong about them in the way the real thing can:
//
//   1. the token reaches the child over a real PIPE, as the first line, before it does anything;
//   2. the port announced on a real STDOUT is a port a real `net.connect` reaches, and the hello +
//      session.health round-trip completes over a real socket through the real NDJSON transport;
//   3. closing a real STDIN really does end a real process — the dies-with-app law — and a child
//      that ignores it really is killed.
//
// It needs no Rust: `tests/fixtures/fakeEngine.mjs` honours the same contract in Node, with a mode
// per misbehaviour. The real binary is JOS-466 and the real-binary end-to-end is JOS-470; what this
// suite pins is the SUPERVISOR's half, which is the half this ticket ships.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createEngineSupervisor, type EngineSupervisor } from '../src/main/dataServer/supervisor'
import { connectToEngine } from '../src/main/dataServer/socketChannel'
import { mintToken } from '../src/main/dataServer/token'
import type { EngineExitLog } from '../src/main/dataServer/engineProtocol'

const FAKE_ENGINE = fileURLToPath(new URL('./fixtures/fakeEngine.mjs', import.meta.url))

/** Real clocks, short. Every wait in the supervisor is injectable, so a suite driving real
 *  processes still never sits on a ten-second production timeout. */
const ANNOUNCE_MS = 8_000
const GRACE_MS = 400
const HEALTH_MS = 4_000

interface Rig {
  readonly supervisor: EngineSupervisor
  readonly reports: EngineExitLog[]
  readonly logs: string[]
  readonly children: ChildProcess[]
  dispose(): void
}

/** A supervisor wired to a REAL spawn, a REAL socket and real timers. */
function rig(mode: string): Rig {
  const reports: EngineExitLog[] = []
  const logs: string[] = []
  const children: ChildProcess[] = []
  const supervisor = createEngineSupervisor({
    // The "binary" is the fake engine's mode; the spawn below turns it into `node fakeEngine.mjs
    // <mode>`. That is precisely what the injectable seam is for — the supervisor cannot tell, and
    // the real composition root (`engineHost.ts`) is three lines it does not need to reimplement.
    resolveBinary: () => mode,
    spawn: (bin) => {
      const child = spawn(process.execPath, [FAKE_ENGINE, bin], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
      children.push(child)
      return child
    },
    connect: (port) => connectToEngine(port, 2_000),
    mintToken,
    timer: (fn, ms) => {
      const handle = setTimeout(fn, ms)
      return () => clearTimeout(handle)
    },
    now: () => Date.now(),
    debug: (line) => logs.push(line),
    report: (log) => reports.push(log),
    onPid: () => undefined,
    announceTimeoutMs: ANNOUNCE_MS,
    stopGraceMs: GRACE_MS,
    healthTimeoutMs: HEALTH_MS,
    // Long enough that no test trips the watchdog by accident; the watchdog itself is pinned with a
    // clock the test owns, next door.
    healthIntervalMs: 60_000
  })
  return {
    supervisor,
    reports,
    logs,
    children,
    dispose() {
      supervisor.stop()
      // Belt and braces: a test that failed mid-flight must not leave a node process behind on the
      // owner's machine. `stop()` is the polite path and this is the one that cannot be ignored.
      for (const child of children) if (child.exitCode === null) child.kill()
    }
  }
}

/** Wait for a condition, never for the clock (the repo's e2e law, applied to a unit suite). */
async function until(what: string, ok: () => boolean, budgetMs = 15_000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

test('A REAL CHILD: token down the pipe, port off stdout, health over a real socket', async (t) => {
  const r = rig('ok')
  t.after(() => r.dispose())
  r.supervisor.start()
  await until('the engine to be ready', () => r.supervisor.state === 'ready')
  assert.equal(r.reports.length, 0)
  // The port is the OS's, not ours: an ephemeral one nobody could have squatted before we launched.
  assert.ok((r.supervisor.port ?? 0) > 0)
  assert.ok(r.logs.some((l) => l.includes('announced port')))
  // …and the fake only announces AFTER it has read the token, so reaching ready at all proves the
  // first line on stdin arrived and was the credential the socket then accepted.
  assert.ok(r.logs.some((l) => l.includes('ready')))
})

test('EOF ON STDIN ENDS THE PROCESS — the dies-with-app law, on a real child', async (t) => {
  const r = rig('ok')
  t.after(() => r.dispose())
  r.supervisor.start()
  await until('ready', () => r.supervisor.state === 'ready')
  const child = r.children[0]
  r.supervisor.stop()
  await until('the child to exit', () => child.exitCode !== null)
  assert.equal(child.exitCode, 0, 'it exits 0, promptly, of its own accord')
  assert.equal(child.killed, false, 'and it was never signalled — closing stdin was the whole ask')
  assert.equal(r.reports.length, 0, 'a deliberate stop is not a failure')
  assert.equal(r.supervisor.state, 'stopped')
})

test('A CHILD THAT IGNORES EOF IS KILLED — a wedged engine cannot veto a quit', async (t) => {
  const r = rig('deaf')
  t.after(() => r.dispose())
  r.supervisor.start()
  await until('ready', () => r.supervisor.state === 'ready')
  const child = r.children[0]
  r.supervisor.stop()
  await until('the escalation to land', () => child.exitCode !== null || child.signalCode !== null)
  assert.ok(r.logs.some((l) => l.includes('escalating to kill')))
  assert.notEqual(child.exitCode, 0, 'this one did not go quietly')
})

test('a binary that panics on stdout is a failed spawn, and its process is retired', async (t) => {
  const r = rig('garbage')
  t.after(() => r.dispose())
  r.supervisor.start()
  await until('the bad-announce report', () => r.reports.length > 0)
  assert.equal(r.reports[0].name, 'EngineBadAnnounce')
  assert.match(String(r.reports[0].detail), /panicked/)
  await until('the retired child to exit', () => r.children[0].exitCode !== null)
})

test('a binary that dies before it can announce is reported with its exit code', async (t) => {
  const r = rig('crash')
  t.after(() => r.dispose())
  r.supervisor.start()
  await until('the exit report', () => r.reports.length > 0)
  assert.equal(r.reports[0].name, 'EngineExited')
  assert.equal(r.reports[0].code, 3, 'the number that separates one crash from another')
  // stderr is the engine's own voice and the one useful detail a failure can carry.
  assert.match(String(r.reports[0].detail), /STATUS_DLL_NOT_FOUND/)
})

test('AN ENGINE THAT REFUSES THE TOKEN NEVER BECOMES THE ENGINE', async (t) => {
  // Contract rule 4 over a real socket: the connection is CLOSED with nothing said, which is the
  // commonest refusal and the one a probe must notice without waiting out its timeout.
  const r = rig('refuse')
  t.after(() => r.dispose())
  const started = Date.now()
  r.supervisor.start()
  await until('the unhealthy report', () => r.reports.length > 0)
  assert.equal(r.reports[0].name, 'EngineUnhealthy')
  assert.notEqual(r.supervisor.state, 'ready')
  assert.ok(Date.now() - started < HEALTH_MS, 'a hang-up is an answer, not a timeout')
})

test('A LIVE SOCKET BEHIND A WEDGED FOLD FAILS ITS ROUND TRIP', async (t) => {
  // The one failure only a round-trip can see: the process is up, the port is open, the handshake
  // completes, and `session.health` is never answered.
  const r = rig('mute')
  t.after(() => r.dispose())
  r.supervisor.start()
  await until('the health timeout', () => r.reports.length > 0, 20_000)
  assert.equal(r.reports[0].name, 'EngineUnhealthy')
  assert.match(r.reports[0].message, /did not answer health/)
})

test('a build-version skew is fatal at hello rather than papered over', async (t) => {
  const r = rig('mismatch')
  t.after(() => r.dispose())
  r.supervisor.start()
  await until('the mismatch report', () => r.reports.length > 0)
  assert.equal(r.reports[0].name, 'EngineUnhealthy')
  assert.match(r.reports[0].message, /speaks protocol/)
})

test('a diagnostic on the wrong stream does not cost a working engine its life', async (t) => {
  const r = rig('chatty')
  t.after(() => r.dispose())
  r.supervisor.start()
  await until('ready', () => r.supervisor.state === 'ready')
  await until('the stray line to be noticed', () => r.logs.some((l) => l.includes('unexpected stdout')))
  assert.equal(r.supervisor.state, 'ready')
  assert.equal(r.reports.length, 0)
})
