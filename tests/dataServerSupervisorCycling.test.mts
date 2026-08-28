// THE ENGINE THAT KEEPS DYING AFTER IT SERVED (JOS-519) - the supervisor's session-scoped cycling
// counter, its one error-store entry, and the breadcrumb edge under it.
//
// THE REPORT BEHIND THIS SUITE. A 1.11.0 user said the log "keeps catching up even while in-game",
// and the engine diagnostic his report carried at that same moment said no engine answered. One
// hypothesis fits both facts: the engine reaches READY, folds, dies minutes later (an EDR product,
// an OOM), and the supervisor respawns it - and a respawn is a launch, so each one re-folds the
// whole log behind a fresh "Catching up on your log".
//
// WHY IT WAS INVISIBLE, which is the whole reason this file exists: `supervisor.ts` resets the exit
// trail on every READY edge. That is correct for a launch-time crash loop - the trail is about
// launches that never worked - and it means an engine that dies every ten minutes but ALWAYS comes
// back never collapses a trail, never raises a fault, and never mints an entry. The error store has
// zero engine families, and nobody could say whether that was because mid-session deaths do not
// happen or because nothing reports them.
//
// A THIRD SUITE RATHER THAN A SECTION, for the reason `dataServerSupervisorFault.test.mts` is a
// second one: `dataServerSupervisor.test.mts` sits at the measured 400-code-line ceiling, and the
// house rule there is to split on a seam rather than to widen a threshold. The seam is the subject -
// that file owns the state machine, the fault file owns the person's edge, this one owns the
// instrument. All three drive `dataServerSupervisorHarness.mts`.
//
// INSTRUMENTATION ONLY. Nothing here asserts a change to respawn, backoff or the failure card,
// because the ticket changed none of them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ENGINE_RESTART_BACKOFF_MS,
  ENGINE_SERVED_CYCLE_ERROR_NAME,
  ENGINE_SERVED_CYCLE_STREAK,
  type EngineExitLog
} from '../src/main/dataServer/engineProtocol'
import { harness, launched, settle, type Harness } from './dataServerSupervisorHarness.mts'

/** One READY->exit cycle: the serving engine dies, the backoff fires, and the replacement proves
 *  itself too. Every one of these is a full re-fold - the "catching up" the user is reporting. */
async function cycle(h: Harness): Promise<void> {
  h.children[h.children.length - 1].exit(1)
  h.clock.advance(ENGINE_RESTART_BACKOFF_MS[0])
  h.children[h.children.length - 1].announce()
  await settle()
}

/** Only the cycling entries. The ordinary per-exit reports are still made, and are asserted too. */
function cyclingReports(h: Harness): EngineExitLog[] {
  return h.reports.filter((r) => r.name === ENGINE_SERVED_CYCLE_ERROR_NAME)
}

test('THREE MID-SESSION DEATHS ARE ONE ENTRY - and the exit trail next door still says nothing', async () => {
  const h = harness()
  await launched(h)
  for (let i = 0; i < ENGINE_SERVED_CYCLE_STREAK; i += 1) await cycle(h)
  const cycling = cyclingReports(h)
  assert.equal(cycling.length, 1, 'one entry per session, not one per death')
  assert.equal(cycling[0].exits, ENGINE_SERVED_CYCLE_STREAK, 'and it names the count')
  assert.match(cycling[0].message, /restarted 3 times this session after serving/)
  // THE COUNTER DOES NOT RESET ON READY, and this is the assertion that says why it had to exist at
  // all: every one of those three deaths reset the exit TRAIL at the next READY, so that trail files
  // three ordinary exemplars and would never reach its own diagnosis, however long this ran.
  assert.deepEqual(
    h.reports.filter((r) => r.name !== ENGINE_SERVED_CYCLE_ERROR_NAME).map((r) => r.name),
    ['EngineExited', 'EngineExited', 'EngineExited']
  )
  assert.equal(h.faults.filter((f) => f !== null).length, 0, 'no card: the engine keeps working')
  assert.equal(h.servedExits.length, 3, 'a breadcrumb per respawn-after-serving, not one per session')
})

test('THE ENTRY CARRIES THE LAST EXIT’S OWN DETAIL - the fold’s, never a second vocabulary', async () => {
  const h = harness()
  await launched(h)
  for (let i = 0; i < ENGINE_SERVED_CYCLE_STREAK - 1; i += 1) await cycle(h)
  // The engine's own voice on the way out, which is the `detail` an ordinary report already carries
  // and which is bounded and token-redacted at the door like every other line off that stream.
  h.children[h.children.length - 1].stderr.emit('ERROR: the log file went away under us\n')
  await cycle(h)
  const cycling = cyclingReports(h)
  assert.equal(cycling.length, 1)
  assert.equal(cycling[0].detail, 'ERROR: the log file went away under us')
  assert.match(cycling[0].message, /the log file went away under us/)
  assert.equal(cycling[0].code, 1, 'the exit code rides the machine-readable field, as everywhere')
})

test('TWO IS NOT A PATTERN - the ring shows both, the error store is told nothing', async () => {
  const h = harness()
  await launched(h)
  for (let i = 0; i < ENGINE_SERVED_CYCLE_STREAK - 1; i += 1) await cycle(h)
  assert.deepEqual(cyclingReports(h), [], 'two deaths is a machine having a bad ten minutes')
  assert.equal(h.servedExits.length, 2, 'the breadcrumb is per death; only the ENTRY waits')
})

test('A DELIBERATE STOP IS NOT A MID-SESSION DEATH - it cannot be the third', async () => {
  const h = harness()
  await launched(h)
  for (let i = 0; i < ENGINE_SERVED_CYCLE_STREAK - 1; i += 1) await cycle(h)
  assert.equal(h.servedExits.length, 2)
  h.supervisor.stop()
  // Even a ten-digit crash code on the way out. The quit path takes this same arm, and we asked for
  // it: what that produces is an `EngineShutdownExit`, a different row, and never a symptom of this.
  h.children[h.children.length - 1].exit(3221225477, 'SIGTERM')
  assert.equal(h.servedExits.length, 2, 'a stop we asked for never counts, whatever the exit code')
  assert.deepEqual(cyclingReports(h), [], 'and it cannot complete a pattern it is not part of')
  assert.equal(h.reports[h.reports.length - 1].name, 'EngineShutdownExit')
})

test('A LAUNCH THAT NEVER SERVED IS THE OTHER BUG, and this counter never sees it', () => {
  const h = harness()
  h.supervisor.start()
  for (let i = 0; i < 20; i += 1) {
    h.children[h.children.length - 1].exit(1)
    h.clock.advance(60_000)
  }
  assert.deepEqual(h.servedExits, [], 'a crash loop is a LAUNCH loop - the exit trail owns it')
  assert.deepEqual(cyclingReports(h), [])
  assert.equal(h.reports[h.reports.length - 1].name, 'EngineLaunchLoop', 'and it still collapses')
})
