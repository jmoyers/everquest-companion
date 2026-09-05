// THE TWO-STRIKE PROBE AND THE SLEEPING MACHINE (JOS-526).
//
// A SUITE OF ITS OWN for the reason that split the fault suite out before it: the state machine's
// file sits at the measured 400-code-line ceiling, and the house rule at a ceiling is to split
// rather than to ratchet. It is also the honest seam — every case here is about the health
// WATCHDOG's policy (how many times it asks, and what a suspend does to the question), not about
// spawn, backoff or kill.
//
// WHAT IT PINS, AND WHY THE NUMBERS MATTER. On 1.14.0 the fleet's loudest engine error was
// EngineUnhealthy — 122 in two days across 2,002 installs, every one recovering on restart attempt
// 1, i.e. every one a healthy engine killed for a stall it had already recovered from. Each false
// kill costs the player a full re-fold. So a reason a SERVING engine can produce buys one more ask
// and no more; a reason that is a statement about the build or the credential buys none; and a probe
// that spanned a suspend is not evidence about anything, because Windows freezes the timer without
// crediting the sleep.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ENGINE_HEALTH_INTERVAL_MS,
  ENGINE_HEALTH_TIMEOUT_MS,
  ENGINE_LOCAL_SOCKET_GRACE_MS,
  ENGINE_LOCAL_SOCKET_STREAK,
  ENGINE_QUICK_EXIT_STREAK,
  ENGINE_RESUME_GRACE_MS,
  engineRestartDelayMs
} from '../src/main/dataServer/engineProtocol'
import { harness, launched, settle, type Harness } from './dataServerSupervisorHarness.mts'

/** One watchdog beat, driven to a standstill: fire the interval, then let every microtask land.
 *  A confirmation needs no clock — it is immediate by design — so one settle covers both asks. */
async function beat(h: Harness): Promise<void> {
  h.clock.advance(ENGINE_HEALTH_INTERVAL_MS)
  await settle()
}

// ---- 1. the second ask, and what it is allowed to conclude -----------------------------------

test('A TRANSIENT FAILURE IS CONFIRMED BEFORE IT KILLS — two asks, then the verdict', async () => {
  const h = await launchedThen(harness(), 'closed')
  assert.equal(h.connects.length, 3, 'the launch probe, the strike, and the one confirmation')
  assert.equal(h.reports.length, 1)
  assert.equal(h.reports[0].name, 'EngineUnhealthy')
  assert.deepEqual(
    h.reports[0].healthReasons,
    ['closed', 'closed'],
    'the report says how the verdict was reached: both asks, as enums'
  )
})

test('A CONFIRMATION THAT PASSES FORGIVES THE STRIKE — the false kill this exists to stop', async () => {
  const h = harness()
  await launched(h)
  // One stall, then the engine answers again — the 1.14.0 shape, where restart attempt 1 always
  // worked because there was never anything wrong with the engine.
  h.queueBehaviours('mute')
  h.clock.advance(ENGINE_HEALTH_INTERVAL_MS)
  await settle()
  h.clock.advance(ENGINE_HEALTH_TIMEOUT_MS)
  await settle()
  assert.equal(h.reports.length, 0, 'a launch that answered the second ask is a launch that is serving')
  assert.equal(h.supervisor.state, 'ready')
  assert.equal(h.children.length, 1, 'and nothing was respawned')
})

test('EXACTLY ONE CONFIRMATION — a second opinion, never a policy of not believing the instrument', async () => {
  const h = await launchedThen(harness(), 'closed')
  assert.equal(h.connects.length, 3)
  // The launch is over, so no further beat exists to ask a third time with.
  h.clock.advance(ENGINE_HEALTH_INTERVAL_MS * 10)
  await settle()
  assert.equal(h.connects.filter((c) => c === 'closed').length, 2)
})

test('THE WATCHDOG KEEPS ITS CADENCE AFTER A FORGIVEN STRIKE', async () => {
  const h = harness()
  await launched(h)
  h.queueBehaviours('closed')
  await beat(h)
  assert.equal(h.reports.length, 0)
  // The next beat is a beat, not a leftover confirmation: the interval starts again from the answer.
  h.setBehaviour('closed')
  await beat(h)
  assert.equal(h.reports.length, 1, 'a genuinely wedged engine is still caught, one interval later')
})

// ---- 2. what stays fatal on the first ask ----------------------------------------------------

for (const [behaviour, reason] of [
  ['mismatch', 'protocolMismatch'],
  ['deny', 'refused']
] as const) {
  test(`\`${behaviour}\` IS FATAL ON THE FIRST ASK — a second one cannot change the answer`, async () => {
    const h = harness({ behaviour })
    h.supervisor.start()
    h.children[0].announce()
    await settle()
    assert.equal(h.connects.length, 1, 'it was not asked twice')
    assert.equal(h.reports.length, 1)
    assert.equal(h.reports[0].name, 'EngineUnhealthy')
    assert.deepEqual(h.reports[0].healthReasons, [reason])
  })
}

test('THE REASONS REACH THE MESSAGE, which is the field the error store keeps', async () => {
  const h = await launchedThen(harness(), 'closed')
  assert.match(h.reports[0].message, /probes closed then closed/)
  assert.match(h.reports[0].message, /no resume this session/)
})

// ---- 3. the machine goes to sleep ------------------------------------------------------------

test('A SUSPEND CANCELS AN IN-FLIGHT PROBE — the answer it was waiting for is no longer evidence', async () => {
  const h = harness()
  await launched(h)
  h.setBehaviour('mute')
  h.clock.advance(ENGINE_HEALTH_INTERVAL_MS)
  await settle()
  assert.equal(h.connects.length, 2, 'a probe is in flight, waiting on a socket that says nothing')
  h.suspend()
  // The probe's own budget expires while the machine is away. Under the old rule that was a wedge.
  h.clock.advance(ENGINE_HEALTH_TIMEOUT_MS * 10)
  await settle()
  assert.equal(h.reports.length, 0, 'a question asked across a sleep is not answered by the sleep')
  assert.equal(h.supervisor.state, 'ready')
})

test('A SUSPENDED WATCHDOG ASKS NOTHING — the cadence stands down with it', async () => {
  const h = harness()
  await launched(h)
  h.suspend()
  h.clock.advance(ENGINE_HEALTH_INTERVAL_MS * 20)
  await settle()
  assert.equal(h.connects.length, 1, 'only the launch probe; sleeping is not a state to poll from')
  assert.ok(h.logs.some((l) => l.includes('stands down')))
})

test('RESUME RE-PROBES AFTER THE GRACE, and not a millisecond before', async () => {
  const h = harness()
  await launched(h)
  h.suspend()
  h.resume()
  h.clock.advance(ENGINE_RESUME_GRACE_MS - 1)
  await settle()
  assert.equal(h.connects.length, 1, 'the machine is still coming back; a no from it is not a diagnosis')
  h.clock.advance(1)
  await settle()
  assert.equal(h.connects.length, 2)
  assert.equal(h.supervisor.state, 'ready')
  assert.equal(h.reports.length, 0)
})

test('THE REPORT SAYS HOW LONG AGO THE MACHINE WOKE', async () => {
  const h = harness()
  await launched(h)
  h.suspend()
  h.resume()
  h.setBehaviour('closed')
  h.clock.advance(ENGINE_RESUME_GRACE_MS)
  await settle()
  assert.equal(h.reports.length, 1)
  assert.equal(h.reports[0].name, 'EngineUnhealthy')
  assert.equal(
    h.reports[0].resumedAgoMs,
    ENGINE_RESUME_GRACE_MS,
    'the number that tells a fleet whether the remaining timeouts are sleep-adjacent'
  )
  assert.match(h.reports[0].message, new RegExp(`${String(ENGINE_RESUME_GRACE_MS)} ms after resume`))
})

test('A SESSION WITH NO SLEEP SAYS SO — null, never a zero that reads as “just woke”', async () => {
  const h = await launchedThen(harness(), 'closed')
  assert.equal(h.reports[0].resumedAgoMs, null)
})

test('THE WAKE STAMP OUTLIVES THE LAUNCH — a respawn during the wake window still knows', async () => {
  const h = harness()
  await launched(h)
  h.resume()
  // The engine dies and comes back; the new launch then wedges. The sleep is a fact about the
  // MACHINE, so the report about the replacement must still carry it.
  h.children[0].exit(1)
  h.setBehaviour('closed')
  h.clock.advance(1_000)
  h.children[1].announce()
  await settle()
  const last = h.reports[h.reports.length - 1]
  assert.equal(last.name, 'EngineUnhealthy')
  assert.equal(last.resumedAgoMs, 1_000)
})

test('A RESUME WITH NO LAUNCH IS NOT AN ERROR — the commonest sleep is an idle one', async () => {
  const h = harness({ binary: null })
  h.supervisor.start()
  h.suspend()
  h.resume()
  h.clock.advance(ENGINE_RESUME_GRACE_MS * 10)
  await settle()
  assert.equal(h.reports.length, 0)
  assert.equal(h.connects.length, 0)
})

// ---- 4. the connect that never left this process ---------------------------------------------
//
// THE FIELD SHAPE THIS SECTION EXISTS FOR: `EngineLaunchLoop: 3 consecutive launches failed …
// connect EADDRINUSE 127.0.0.1:<port> (alive for 24 ms)`. The port is the DESTINATION Node stamps on
// every connect error and the engine had already bound and announced it, so the collision is on OUR
// local endpoint — and the app answered by killing a serving engine three times in a row, each kill
// costing a full re-fold and none of them able to supply a local port.

/** The engine is up; this process cannot open a socket to it. One ask, then the grace. */
async function localBeat(h: Harness): Promise<void> {
  h.clock.advance(ENGINE_LOCAL_SOCKET_GRACE_MS)
  await settle()
}

/** A launch that announced, whose every probe is refused before it reaches the engine. */
async function launchedWithNoSocket(code = 'EADDRINUSE'): Promise<Harness> {
  const h = harness({ behaviour: { connectFails: code } })
  h.supervisor.start()
  h.children[0].announce()
  await settle()
  return h
}

test('A LOCAL SOCKET FAILURE NEVER KILLS THE ENGINE — the launch-loop shape, at its cause', async () => {
  const h = await launchedWithNoSocket()
  await localBeat(h)
  await localBeat(h)
  await localBeat(h)
  assert.equal(h.children.length, 1, 'one engine, still running: a respawn cannot supply a local port')
  assert.equal(h.children[0].kills, 0)
  assert.equal(h.children[0].stdin.ended, false, 'and it was never retired')
  assert.equal(
    h.reports.filter((r) => r.name === 'EngineUnhealthy' || r.name === 'EngineLaunchLoop').length,
    0,
    'the engine is not the one that failed, so it is not the one reported'
  )
})

test('IT IS ASKED AGAIN ON A GRACE — an immediate second ask is the same instant, same pool', async () => {
  const h = await launchedWithNoSocket()
  assert.equal(h.connects.length, 1, 'no confirmation: the two-strike rule is for reasons the engine gave')
  h.clock.advance(ENGINE_LOCAL_SOCKET_GRACE_MS - 1)
  await settle()
  assert.equal(h.connects.length, 1)
  await localBeat(h)
  assert.equal(h.connects.length, 2)
})

test('THE SAME ENGINE REACHES READY WHEN THE MACHINE RECOVERS — no respawn, no re-fold', async () => {
  const h = await launchedWithNoSocket()
  await localBeat(h)
  h.setBehaviour('ok')
  await localBeat(h)
  assert.equal(h.supervisor.state, 'ready')
  assert.equal(h.children.length, 1)
  assert.equal(h.readies.filter((r) => r !== null).length, 1, 'one READY edge, from the launch that announced')
  assert.equal(h.reports.length, 0)
})

test('THE STREAK IS WORTH ONE ENTRY, and it names the app rather than the engine', async () => {
  const h = await launchedWithNoSocket()
  for (let i = 1; i < ENGINE_LOCAL_SOCKET_STREAK; i += 1) await localBeat(h)
  assert.equal(h.reports.length, 1)
  assert.equal(h.reports[0].name, 'EngineLocalSocket')
  assert.equal(h.reports[0].exits, ENGINE_LOCAL_SOCKET_STREAK)
  assert.equal(h.reports[0].attempt, 0, 'this is not a retry of anything')
  assert.match(h.reports[0].message, /EADDRINUSE/)
  assert.equal(h.supervisor.state, 'starting', 'the launch is still the launch')
})

test('ONE ENTRY, THEN THE ORDINARY CADENCE — a drip is not a flood to report', async () => {
  const h = await launchedWithNoSocket()
  for (let i = 1; i < ENGINE_LOCAL_SOCKET_STREAK; i += 1) await localBeat(h)
  const asked = h.connects.length
  await localBeat(h)
  assert.equal(h.connects.length, asked, 'the short grace is spent; the interval owns the cadence now')
  h.clock.advance(ENGINE_HEALTH_INTERVAL_MS)
  await settle()
  assert.equal(h.connects.length, asked + 1)
  assert.equal(h.reports.length, 1, 'and still one entry')
})

test('ONLY THE LOCAL ERRNOS — a refused connect is still evidence about the engine', async () => {
  const h = harness({ behaviour: { connectFails: 'ECONNREFUSED' } })
  h.supervisor.start()
  h.children[0].announce()
  await settle()
  assert.equal(h.connects.length, 2, 'the ordinary transient path: one strike, one confirmation')
  assert.equal(h.reports.length, 1)
  assert.equal(h.reports[0].name, 'EngineUnhealthy')
  assert.deepEqual(h.reports[0].healthReasons, ['connect', 'connect'])
})

/** Drive `ENGINE_QUICK_EXIT_STREAK` whole launches: announce, let the probes land, ride the backoff. */
async function threeLaunches(h: Harness): Promise<void> {
  h.supervisor.start()
  for (let i = 0; i < ENGINE_QUICK_EXIT_STREAK; i += 1) {
    // A launch that was never replaced has no next child to announce — which is the whole assertion.
    if (h.children.length > i) h.children[i].announce()
    await settle()
    h.clock.advance(engineRestartDelayMs(ENGINE_QUICK_EXIT_STREAK))
    await settle()
  }
}

test('THE REPORTED LOOP, BOTH WAYS — a peer refusal collapses a trail, a local socket does not', async () => {
  const peer = harness({ behaviour: { connectFails: 'ECONNREFUSED' } })
  await threeLaunches(peer)
  assert.equal(peer.children.length, ENGINE_QUICK_EXIT_STREAK + 1, 'three failed launches and the next')
  assert.ok(
    peer.reports.some((r) => r.name === 'EngineLaunchLoop'),
    'a connect the ENGINE caused is still a launch loop, and is still collapsed'
  )
  // The same three launches, the same instant, the same message — but the errno says the connect
  // never left this process, and the field report's `EADDRINUSE` is that errno.
  const local = harness({ behaviour: { connectFails: 'EADDRINUSE' } })
  await threeLaunches(local)
  assert.equal(local.children.length, 1, 'one engine, never replaced')
  assert.equal(local.reports.filter((r) => r.name === 'EngineLaunchLoop').length, 0)
})

test('A LOCAL SOCKET ON THE CONFIRMATION DROPS THE STRIKE — it confirmed nothing', async () => {
  const h = harness()
  await launched(h)
  h.queueBehaviours('closed', { connectFails: 'EADDRINUSE' })
  h.clock.advance(ENGINE_HEALTH_INTERVAL_MS)
  await settle()
  assert.equal(h.reports.length, 0, 'a socket that never opened is not a second opinion about a stall')
  assert.equal(h.supervisor.state, 'ready')
  assert.equal(h.children.length, 1)
})

/** A ready launch, then one whole watchdog beat answered by `behaviour` — strike and confirmation. */
async function launchedThen(h: Harness, behaviour: 'closed' | 'mute'): Promise<Harness> {
  await launched(h)
  h.setBehaviour(behaviour)
  await beat(h)
  return h
}
