// THE FAILURE CARD IS DRAWN FROM THIS EDGE (JOS-503) - the supervisor s onFault, every path.
//
// A SECOND SUITE RATHER THAN A SECTION, because dataServerSupervisor.test.mts reached the
// measured 400-code-line ceiling and the house rule there is to split. The harness both files
// drive is dataServerSupervisorHarness.mts.
//
// WHAT MAKES THIS A DIFFERENT SUBJECT FROM THE STATE MACHINE NEXT DOOR: report and onFault answer
// two different questions. report is for the ERROR STORE and fires on every ended launch, because
// a fleet wants the whole trail. onFault is for a HUMAN IN FRONT OF AN EMPTY WINDOW and fires at
// most twice in a session - when the resolver finds nothing, and when the quick-exit trail
// COLLAPSES - because that is when the sentence has stopped changing. Post-cutover there is no
// TypeScript fold behind either state, so both are a permanently empty app and the one thing they
// must not be is silent.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEngineSupervisor } from '../src/main/dataServer/supervisor'
import { ENGINE_QUICK_EXIT_STREAK } from '../src/main/dataServer/engineProtocol'
import { FakeChild, fakeClock, scriptedChannel } from './dataServerSupervisorFakes.mts'
import { harness, launched } from './dataServerSupervisorHarness.mts'

// ---- 5b. the PERSON's edge: what a failure card is drawn from (JOS-503) ---------------------
//
// `report` and `onFault` answer two different questions and this block is where the difference is
// pinned. `report` is for the ERROR STORE and fires on every ended launch, because a fleet wants
// the whole trail. `onFault` is for a HUMAN IN FRONT OF AN EMPTY WINDOW and fires at most twice in
// a session — when the resolver finds nothing, and when the trail COLLAPSES — because that is when
// the sentence has stopped changing. Post-cutover there is no TypeScript fold behind either state,
// so both are a permanently empty app and the one thing they must not be is silent.

test('NO BINARY: the fault edge fires ONCE, with nothing attempted', () => {
  const h = harness({ binary: null })
  h.supervisor.start()
  assert.deepEqual(h.faults, [{ kind: 'no-binary', attempts: 0, detail: null }])
  // `attempts: 0` is not a rounding of "one": nothing was launched, and a card saying "it has tried
  // 1 time" about a binary that was never spawned would be inventing an event.
  assert.equal(h.reports.length, 0, 'still not an error-store entry — see the absence tests above')
  // Absence is not retried, so there is no second edge to erase or repeat it.
  h.clock.advance(60_000)
  assert.equal(h.faults.length, 1)
})

test('A CRASH LOOP RAISES THE FAULT AT THE COLLAPSE AND NOT BEFORE — nor again after', () => {
  const h = harness()
  h.supervisor.start()
  // The first failures are NOT a fault. That is `engineExitStep`'s own argument reused: a single
  // fast failure really can be a machine having a moment, and a card that appeared for it would be
  // crying wolf at exactly the user who can least judge it.
  for (let i = 0; i < ENGINE_QUICK_EXIT_STREAK - 1; i += 1) {
    h.children[h.children.length - 1].exit(1)
    h.clock.advance(60_000)
  }
  assert.deepEqual(h.faults, [], 'no card while the condition could still be a hiccup')
  // The failure that COMPLETES the streak is the one that has stopped changing.
  h.children[h.children.length - 1].exit(1)
  h.clock.advance(60_000)
  assert.equal(h.faults.length, 1, 'one card, at the collapse')
  assert.equal(h.faults[0]?.kind, 'exited')
  assert.equal(h.faults[0]?.attempts, ENGINE_QUICK_EXIT_STREAK)
  // …and every later failure in the same run says nothing new, exactly as the error store's own
  // collapse does. A card that re-raised itself would flicker for the rest of the session.
  for (let i = 0; i < 20; i += 1) {
    h.children[h.children.length - 1].exit(1)
    h.clock.advance(60_000)
  }
  assert.equal(h.faults.length, 1, 'the diagnosis is said once')
})

test('REACHING READY TAKES THE CARD BACK DOWN — the same edge that resets the trail', async () => {
  const h = harness()
  await launched(h)
  assert.deepEqual(h.faults, [null], 'a proven round trip is the app saying it has no diagnosis')
})

test('RETRY forgives the trail, cancels the backoff and launches NOW', () => {
  const h = harness()
  h.supervisor.start()
  for (let i = 0; i < ENGINE_QUICK_EXIT_STREAK; i += 1) {
    h.children[h.children.length - 1].exit(1)
    h.clock.advance(60_000)
  }
  assert.equal(h.faults.length, 1)
  const spawned = h.children.length
  // A launch is in flight after the last backoff fired, so end it: what a person retries is the
  // state they are looking at, which is an app sitting on its next timer.
  h.children[h.children.length - 1].exit(1)
  assert.equal(h.supervisor.state, 'backoff')
  h.supervisor.restart()
  assert.equal(h.children.length, spawned + 1, 'it launched immediately rather than waiting out 30 s')
  // AND THE TRAIL IS FORGIVEN, which is the half that is invisible and matters most: a collapsed
  // trail carried across a retry would swallow the report for the next real failure. Three fresh
  // fast failures must produce a fresh diagnosis, exemplars and all.
  for (let i = 0; i < ENGINE_QUICK_EXIT_STREAK; i += 1) {
    h.children[h.children.length - 1].exit(1)
    h.clock.advance(60_000)
  }
  assert.equal(h.faults.length, 2, 'the next run gets its own diagnosis')
  assert.equal(h.reports[h.reports.length - 1]?.name, 'EngineLaunchLoop')
})

test('RETRY on an ABSENCE re-probes the disk — the button after restoring a quarantined file', () => {
  // The one case where retrying is not merely impatience: `resolveBinary` is asked again, so a
  // binary that has appeared since the launch (an antivirus quarantine restored, a `cargo build`
  // finished) is found. Modelled by a resolver that answers differently the second time.
  const clock = fakeClock()
  const children: FakeChild[] = []
  let onDisk: string | null = null
  const supervisor = createEngineSupervisor({
    resolveBinary: () => onDisk,
    spawn: () => {
      const child = new FakeChild()
      children.push(child)
      return child
    },
    connect: () => Promise.resolve(scriptedChannel('', 'ok')),
    mintToken: () => 'a'.repeat(64),
    timer: clock.timer,
    now: clock.now,
    debug: () => undefined,
    report: () => undefined
  })
  supervisor.start()
  assert.equal(supervisor.state, 'absent')
  assert.equal(children.length, 0)
  onDisk = 'C:/repo/engine/target/debug/engined.exe'
  supervisor.restart()
  assert.equal(children.length, 1, 'the retry asked the disk again rather than trusting the last answer')
})

test('RETRY leaves a launch that is already in flight alone', async () => {
  // "Try again" means "stop waiting and go now", never "kill whatever is running". A second launch
  // begun over a live one would orphan the first with its port and its token.
  const h = harness()
  await launched(h)
  h.supervisor.restart()
  assert.equal(h.children.length, 1, 'the healthy engine was not replaced by an impatient click')
})
