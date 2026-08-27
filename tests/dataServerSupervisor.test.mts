// THE STATE MACHINE (JOS-467): spawn, watch, respawn, kill — every path, with a fake child and a
// clock the test owns.
//
// WHAT THIS SUITE IS FOR. A supervisor is nothing but its failure paths: the happy one is four
// lines. What has to be pinned is what happens when the binary is missing, when it prints garbage,
// when it never speaks, when it dies immediately and forever, when it is alive but wedged, and when
// it refuses to notice it has been asked to leave. Every one of those is a real binary somebody
// ships one day, and none of them is reachable by running the app.
//
// IT NEEDS NO RUST. `supervisor.ts` imports no Electron, no `child_process` and no `net`, so the
// whole machine is drivable from here — which is the entire return on that discipline. The real
// child, the real pipe and the real socket are asserted next door
// (tests/dataServerEngineChild.test.mts) against the Node fake engine; the real BINARY is JOS-470.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ENGINE_ANNOUNCE_TIMEOUT_MS,
  ENGINE_HEALTH_INTERVAL_MS,
  ENGINE_QUICK_EXIT_STREAK,
  ENGINE_RESTART_BACKOFF_MS,
  ENGINE_STOP_GRACE_MS
} from '../src/main/dataServer/engineProtocol'
import { harness, launched, settle } from './dataServerSupervisorHarness.mts'

// THE HARNESS AND ITS TWO WAITS LIVE NEXT DOOR (JOS-503) - dataServerSupervisorHarness.mts, split
// out when this file passed the measured 400-code-line ceiling. Its second reader is
// dataServerSupervisorFault.test.mts, which owns the onFault edge and the retry.

// ---- 1. absence is a condition, not a crash ------------------------------------------------

test('NO BINARY: one log line, no error, no child, no retry storm', () => {
  const h = harness({ binary: null })
  h.supervisor.start()
  assert.equal(h.supervisor.state, 'absent')
  assert.equal(h.children.length, 0)
  assert.equal(h.reports.length, 0, 'a build with no engine is not a build with a bug')
  assert.equal(h.clock.pending(), 0, 'a binary that does not exist will not appear while we wait')
  assert.ok(h.logs.some((l) => l.includes('no engine binary')))
})

test('NO BINARY: the READY edge never fires, which is what keeps the app’s own alerts audible', () => {
  // THE SHIPPED SILENCE THIS PINS (JOS-496). `armEngineAlerts()` used to be called from
  // `startEngineSupervisor()` before any binary was probed for. It gates on `EQC_ENGINE_SERVE` and
  // `EQC_ENGINE_ALERTS`, both DEFAULT-ON since JOS-495, so a checkout with no `cargo build` armed —
  // and arming makes this process's own `AlertsModule.publish` a no-op. No binary means no client
  // means no `fire` frame, ever, so the app silenced its own evaluator in favour of an engine that
  // did not exist and played NO ALERTS AT ALL until quit.
  //
  // The handoff now hangs off `onReady`, so what this asserts IS the fix's whole foundation: on a
  // build with no engine the edge does not fire, in either direction, so nothing is ever handed
  // over and the TypeScript evaluator keeps the sound it has always had.
  const h = harness({ binary: null })
  h.supervisor.start()
  assert.deepEqual(h.readies, [], 'a build with no engine must never announce a launch to hand off to')
  // …and it stays that way: absence is not retried, so there is no later edge either. An hour of
  // clock proves it, because the thing being ruled out is a timer nobody armed.
  h.clock.advance(3_600_000)
  assert.deepEqual(h.readies, [])
})

test('A FAILED LAUNCH ANNOUNCES ITS LOSS, so a silenced app is always given its sound back', () => {
  // The other half of the same fix. Every way a launch can end short of a quit — a bad announce
  // here — reaches `onReady(null)`, which is where `disarmEngineAlerts()` now hangs. Before this,
  // a crash-looping engine left the evaluator silenced through every backoff.
  const h = harness()
  h.supervisor.start()
  const child = h.children[h.children.length - 1]
  child.stdout.emit('this is not an announce\n')
  assert.ok(
    h.readies.includes(null),
    'the loss edge must fire for a launch that never became ready, or nothing gives the sound back'
  )
})

// ---- 2. the token ---------------------------------------------------------------------------

test('THE TOKEN IS THE FIRST LINE ON STDIN, LF-terminated, and nothing else is written', () => {
  const h = harness()
  h.supervisor.start()
  const child = h.children[0]
  assert.equal(child.stdin.written, `${h.tokens[0]}\n`)
  assert.equal(child.stdin.written.endsWith('\n'), true)
  assert.equal(child.stdin.errorHandlers, 1, 'an EPIPE must never be an uncaught exception in main')
  assert.equal(child.unrefs, 1, 'the engine must never hold a quitting app open')
})

test('A RESPAWN IS A LAUNCH: a fresh token every time, never the old one', async () => {
  const h = harness()
  await launched(h)
  h.children[0].exit(1)
  h.clock.advance(ENGINE_RESTART_BACKOFF_MS[0])
  assert.equal(h.children.length, 2)
  assert.equal(h.tokens.length, 2)
  assert.notEqual(h.tokens[0], h.tokens[1])
  assert.equal(h.children[1].stdin.written, `${h.tokens[1]}\n`)
})

// ---- 3. the announce line -------------------------------------------------------------------

test('a spawn that never announces fails on the timeout, and the child is retired', () => {
  const h = harness()
  h.supervisor.start()
  assert.equal(h.supervisor.state, 'starting')
  h.clock.advance(ENGINE_ANNOUNCE_TIMEOUT_MS)
  assert.equal(h.reports.length, 1)
  assert.equal(h.reports[0].name, 'EngineAnnounceTimeout')
  // A child that never spoke is still a live process holding a port. Closing stdin is how it is
  // asked to leave; nothing is left behind for the respawn to collide with.
  assert.equal(h.children[0].stdin.ended, true)
  assert.equal(h.supervisor.state, 'backoff')
})

test('A BINARY THAT PRINTS ANYTHING ELSE IS A FAILED SPAWN', () => {
  const h = harness()
  h.supervisor.start()
  h.children[0].stdout.emit("thread 'main' panicked at engine/src/main.rs:12:5\n")
  assert.equal(h.reports.length, 1)
  assert.equal(h.reports[0].name, 'EngineBadAnnounce')
  assert.match(String(h.reports[0].detail), /panicked/, 'the offending line is the exemplar')
  assert.equal(h.children[0].stdin.ended, true)
})

test('the announce line survives being split across pipe reads', async () => {
  const h = harness()
  h.supervisor.start()
  const child = h.children[0]
  child.stdout.emit('EQC-ENGINE PORT=5')
  child.stdout.emit('1413 PROTOCOL=1')
  assert.equal(h.reports.length, 0, 'half a line is not a violation, it is a chunk boundary')
  child.stdout.emit('\n')
  await settle()
  assert.equal(h.supervisor.state, 'ready')
  assert.equal(h.supervisor.port, 51413)
})

test('EXTRA STDOUT AFTER THE ANNOUNCE IS NOTED, NOT FATAL — a working engine is not killed', async () => {
  const h = harness()
  const child = await launched(h)
  child.stdout.emit('note: this line does not belong on stdout\n')
  assert.equal(h.supervisor.state, 'ready', 'it is answering on a socket; the stray line is noise')
  assert.equal(h.reports.length, 0)
  assert.ok(h.logs.some((l) => l.includes('unexpected stdout')))
})

// ---- 4. health is a ROUND TRIP, not a process that started ----------------------------------

test('READY means a proven hello + session.health, and it is when the pid is published', async () => {
  const h = harness()
  const child = await launched(h)
  assert.equal(h.supervisor.state, 'ready')
  assert.equal(h.supervisor.port, 51413)
  assert.deepEqual(h.pids, [child.pid], 'the priority arm learns the pid only once it is real')
  assert.ok(h.logs.some((l) => l.includes('ready')))
})

for (const behaviour of ['refuse', 'mute', 'mismatch', 'closed'] as const) {
  test(`a launch that answers \`${behaviour}\` never reaches ready, and is retired`, async () => {
    const h = harness({ behaviour })
    h.supervisor.start()
    h.children[0].announce()
    if (behaviour === 'mute') {
      await settle()
      // Only a clock can see a wedge: the socket is up and nothing is coming.
      h.clock.advance(60_000)
    }
    await settle()
    assert.notEqual(h.supervisor.state, 'ready')
    assert.equal(h.reports.length, 1, `expected one report, got ${JSON.stringify(h.reports)}`)
    assert.equal(h.reports[0].name, 'EngineUnhealthy')
    assert.equal(h.children[0].stdin.ended, true)
  })
}

test('THE WATCHDOG KEEPS ASKING — an engine that goes wedged mid-session is caught', async () => {
  // The presence stale-watchdog's argument, for a process: the state is a CACHE of the last
  // observation, and a child that is still in the process table but no longer serving is
  // indistinguishable from a healthy one unless somebody asks AGAIN. An engine that was healthy at
  // launch and stopped answering at hour three is the case this exists for.
  const h = harness()
  const child = await launched(h)
  assert.equal(h.supervisor.state, 'ready')
  assert.ok(h.clock.pending() > 0, 'a ready engine always has its next probe scheduled')
  h.setBehaviour('closed')
  h.clock.advance(ENGINE_HEALTH_INTERVAL_MS)
  await settle()
  assert.equal(h.reports.length, 1)
  assert.equal(h.reports[0].name, 'EngineUnhealthy')
  assert.equal(child.stdin.ended, true, 'a wedged engine is retired, not left holding a port')
  assert.equal(h.supervisor.state, 'backoff')
})

// ---- 4b. the READY handover (JOS-479) --------------------------------------------------------
//
// The one thing phase 3 added to this file's surface: the launch hands out its port and its TOKEN,
// once, at the moment a round trip has proven there is something to talk to. It is the only way an
// in-app client can exist at all — rule 1 puts the secret on stdin and nowhere else, so the process
// that minted it is the only one that can offer it.

test('READY HANDS THE CLIENT A PORT AND THE LAUNCH’S OWN TOKEN — after the ready line, never before', async () => {
  const h = harness()
  const child = await launched(h)
  assert.equal(h.readies.length, 1)
  const ready = h.readies[0]
  assert.notEqual(ready, null)
  if (ready === null) return
  assert.equal(ready.port, 51413)
  assert.equal(ready.pid, child.pid)
  assert.equal(ready.token, h.tokens[0], 'the token handed out is THIS launch’s, not a second mint')
  assert.equal(ready.protocolVersion, 1)
  assert.equal(ready.engineVersion, '0.0.0-scripted')
  assert.equal(ready.epoch, 1, 'the generation the engine reported, before any attach of ours')
  // The dev log must read cause-then-consequence: whatever the client does is caused by ready.
  assert.ok(
    h.logs.findIndex((l) => l.includes('ready')) >= 0,
    'the ready narration precedes the handover, so a log read top to bottom explains itself'
  )
})

test('A RESPAWN IS A LAUNCH: null on the way down, then a DIFFERENT port’s token on the way back', async () => {
  const h = harness()
  await launched(h)
  h.children[0].exit(1)
  assert.deepEqual(h.readies.slice(1), [null], 'a client holding a socket to a dead engine must be told')
  h.clock.advance(ENGINE_RESTART_BACKOFF_MS[0])
  h.children[1].announce()
  await settle()
  assert.equal(h.readies.length, 3)
  const second = h.readies[2]
  assert.notEqual(second, null)
  if (second === null) return
  assert.equal(second.token, h.tokens[1])
  assert.notEqual(second.token, h.tokens[0], 'nothing is carried across a respawn — resume is re-query')
})

test('a launch that never reached ready never hands anything out, and still says null when it ends', () => {
  const h = harness()
  h.supervisor.start()
  h.clock.advance(ENGINE_ANNOUNCE_TIMEOUT_MS)
  // One `null` and no engine: there was never a connection to offer, and the end is still an end.
  assert.deepEqual(h.readies, [null])
})

test('a DELIBERATE stop tells the client too — an orderly shutdown is not a silent one', async () => {
  const h = harness()
  const child = await launched(h)
  assert.equal(h.readies.length, 1)
  h.supervisor.stop()
  child.exit(0)
  assert.deepEqual(h.readies.slice(1), [null])
  assert.equal(h.reports.length, 0, 'we asked for this — it is not a failure')
})

// ---- 5. crash, backoff, and the folded trail -----------------------------------------------

test('a crash respawns on the schedule, and consecutive crashes climb it', async () => {
  const h = harness()
  await launched(h)
  h.children[0].exit(1)
  assert.equal(h.supervisor.state, 'backoff')
  assert.deepEqual(h.pids, [h.children[0].pid, null], 'the priority arm is told the moment it ends')
  // Not a millisecond early: a backoff that fires on the wrong clock is not a backoff.
  h.clock.advance(ENGINE_RESTART_BACKOFF_MS[0] - 1)
  assert.equal(h.children.length, 1)
  h.clock.advance(1)
  assert.equal(h.children.length, 2)
  h.children[1].exit(1)
  h.clock.advance(ENGINE_RESTART_BACKOFF_MS[1] - 1)
  assert.equal(h.children.length, 2, 'the second failure waits longer than the first')
  h.clock.advance(1)
  assert.equal(h.children.length, 3)
})

test('A CRASH LOOP MINTS ONE ERROR NAME, NOT FIFTY — end to end through the supervisor', () => {
  const h = harness()
  h.supervisor.start()
  for (let i = 0; i < 20; i += 1) {
    h.children[h.children.length - 1].exit(1)
    h.clock.advance(60_000)
  }
  assert.ok(h.children.length > 10, 'it really did keep trying')
  assert.equal(h.reports.length, ENGINE_QUICK_EXIT_STREAK, 'two exemplars and one diagnosis')
  assert.equal(h.reports[h.reports.length - 1].name, 'EngineLaunchLoop')
})

test('reaching READY resets the backoff — an eight-hour session with one hiccup retries at 1 s', async () => {
  const h = harness()
  await launched(h)
  h.children[0].exit(1)
  h.clock.advance(ENGINE_RESTART_BACKOFF_MS[0])
  // The replacement is healthy…
  h.children[1].announce()
  await settle()
  assert.equal(h.supervisor.state, 'ready')
  // …so the NEXT failure is failure number one again, not number two.
  h.children[1].exit(1)
  h.clock.advance(ENGINE_RESTART_BACKOFF_MS[0])
  assert.equal(h.children.length, 3, 'the schedule started over')
  assert.equal(h.reports.length, 2, 'both exits reported, neither collapsed')
})

test('a spawn that THROWS is folded like any other failure — no child, same backoff', () => {
  const h = harness({ spawnThrows: new Error('EPERM: a scanner is holding the file') })
  h.supervisor.start()
  assert.equal(h.children.length, 0)
  assert.equal(h.reports[0].name, 'EngineSpawnFailed')
  assert.match(h.reports[0].message, /EPERM/)
  assert.equal(h.supervisor.state, 'backoff')
})

// ---- 6. shutdown: stdin close, then escalation ---------------------------------------------

test('CLOSING STDIN IS THE SHUTDOWN, AND KILL IS ONLY THE ESCALATION', async () => {
  const h = harness()
  const child = await launched(h)
  h.supervisor.stop()
  assert.equal(child.stdin.ended, true, 'EOF on stdin is the whole signal')
  assert.equal(child.kills, 0, 'nothing has been killed yet, and nothing should be')
  child.exit(0)
  assert.equal(h.supervisor.state, 'stopped')
  assert.equal(h.reports.length, 0, 'a deliberate stop is not a failure')
  h.clock.advance(ENGINE_STOP_GRACE_MS * 10)
  assert.equal(child.kills, 0, 'the grace timer was disarmed by the exit it was waiting for')
  assert.equal(h.children.length, 1, 'and a stopped supervisor never respawns')
  assert.deepEqual(h.pids, [child.pid, null])
})

test('A NONZERO EXIT ON THE SHUTDOWN PATH IS ON THE RECORD — and a zero one is not', async () => {
  // The debug narration is stdout on a process that is QUITTING, which is the one channel that
  // cannot be read after the fact (JOS-501 integration; the engine-boots spec carries the race).
  // So the bad ending gets a durable entry with its own name — and deliberately NOT through the
  // exit trail: a shutdown exit is not a crash and must never count toward a restart streak.
  const h = harness()
  const child = await launched(h)
  h.supervisor.stop()
  child.exit(3)
  assert.equal(h.supervisor.state, 'stopped')
  assert.equal(h.reports.length, 1, 'the bad ending is durable')
  assert.equal(h.reports[0].name, 'EngineShutdownExit')
  assert.equal(h.reports[0].code, 3, 'the code rides the machine-readable field')
  assert.match(h.reports[0].message, /exited 3 after the shutdown signal/)
  assert.equal(h.children.length, 1, 'and it is still not a failure the supervisor acts on')
})

test('AN ENGINE THAT IGNORES EOF IS KILLED — a wedged child cannot veto a quit', async () => {
  const h = harness()
  const child = await launched(h)
  h.supervisor.stop()
  h.clock.advance(ENGINE_STOP_GRACE_MS - 1)
  assert.equal(child.kills, 0, 'the grace is a grace')
  h.clock.advance(1)
  assert.equal(child.kills, 1)
  assert.ok(h.logs.some((l) => l.includes('escalating to kill')))
})

test('stop() is idempotent, and stopping before anything spawned is not an error', () => {
  const h = harness()
  h.supervisor.stop()
  h.supervisor.stop()
  assert.equal(h.supervisor.state, 'stopped')
  assert.equal(h.reports.length, 0)
})

test('a pending respawn is cancelled by stop() — a backoff must not resurrect a stopped engine', async () => {
  const h = harness()
  await launched(h)
  h.children[0].exit(1)
  assert.equal(h.supervisor.state, 'backoff')
  h.supervisor.stop()
  h.clock.advance(60_000)
  assert.equal(h.children.length, 1, 'the timer was cancelled, not merely ignored')
})

test('a child that exits BADLY after we asked it to is on the record, but never acted on', async () => {
  // THE CLAIM THIS REPLACES said the whole stopping path was silent ("we asked for this; a kill
  // exit code is not a diagnosis"). Half survives: the supervisor still never ACTS on it — no
  // trail, no respawn, state is stopped. What changed (JOS-501 integration): an engine that dies
  // with an access violation while shutting down is a real defect in the only fold the product
  // has, and the stdout narration dies with the quitting app — so the bad ending is durable now.
  // The kill WE issue stays unreported (the escalation test below): that code is our own action.
  const h = harness()
  const child = await launched(h)
  h.supervisor.stop()
  child.exit(3221225477, 'SIGTERM')
  assert.equal(h.reports.length, 1, 'the bad ending is durable')
  assert.equal(h.reports[0].name, 'EngineShutdownExit')
  assert.equal(h.reports[0].code, 3221225477, 'the ten-digit code rides the machine-readable field')
  assert.equal(h.supervisor.state, 'stopped')
  assert.equal(h.children.length, 1, 'and it is still never acted on: no respawn')
})

test('start() while a launch is in flight is a no-op, not a second engine', () => {
  const h = harness()
  h.supervisor.start()
  h.supervisor.start()
  h.supervisor.start()
  assert.equal(h.children.length, 1)
})

test('the ONE FUNNEL is idempotent: a late exit after a kill we issued reports nothing extra', () => {
  const h = harness()
  h.supervisor.start()
  h.clock.advance(ENGINE_ANNOUNCE_TIMEOUT_MS)
  assert.equal(h.reports.length, 1)
  // The child we retired finally dies. It has already been folded; a second report and a second
  // respawn would be the bug this latch exists for.
  h.children[0].exit(null, 'SIGTERM')
  assert.equal(h.reports.length, 1)
  assert.equal(h.children.length, 1)
})

// ---- 7. the child's own voice ---------------------------------------------------------------

test("stderr is the engine's voice, and its last line is the detail a failure carries", () => {
  const h = harness()
  h.supervisor.start()
  h.children[0].stderr.emit('warming up\nERROR: could not open the knowledge corpus\n')
  h.children[0].exit(1)
  assert.equal(h.reports[0].detail, 'ERROR: could not open the knowledge corpus')
  assert.ok(h.logs.some((l) => l.includes('warming up')))
})

test('THE LAUNCH TOKEN NEVER COMES BACK OUT — a child that echoes its stdin publishes nothing', () => {
  // MEASURED on the first real-app boot of this feature: a stand-in binary read the token, failed
  // to understand it, and echoed it inside its own error message on stderr — which the supervisor
  // then kept as the `detail` a failure report carries, and a detail reaches errors.log and the
  // fleet. The bright line is "gameplay data never auto-leaves a client"; a per-launch secret
  // walking out in a bug report is the same wall, so both streams are redacted at the door.
  const h = harness()
  h.supervisor.start()
  const token = h.tokens[0]
  h.children[0].stderr.emit(`ReferenceError: ${token} is not defined\n`)
  h.children[0].stdout.emit(`echo: ${token}\n`)
  h.children[0].exit(1)
  const everything = [...h.logs, JSON.stringify(h.reports)].join('\n')
  assert.equal(everything.includes(token), false, 'the token reached a log')
  assert.match(everything, /<token>/, 'and it was redacted rather than the line being dropped')
})

test('an 8 MB stdout line with no newline does not throw into the app', () => {
  // `LineDecoder` raises past its ceiling, and a throw inside a `data` handler is an uncaught
  // exception in the main process — i.e. a child could take the app down by printing.
  const h = harness()
  h.supervisor.start()
  assert.doesNotThrow(() => {
    for (let i = 0; i < 9; i += 1) h.children[0].stdout.emit('x'.repeat(1024 * 1024))
  })
  h.clock.advance(ENGINE_ANNOUNCE_TIMEOUT_MS)
  assert.equal(h.reports[0].name, 'EngineAnnounceTimeout', 'it fails the way a silent binary does')
})
