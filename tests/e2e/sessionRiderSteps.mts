// ============================================================================
// WHAT RIDES A SESSION REPORT, READ OFF THE RING — steps for tests/e2e/telemetry.e2e.mts.
// ============================================================================
//
// A MODULE RATHER THAN MORE OF THAT SPEC, for `errorReportSteps.mts`'s reason: JOS-367's steps
// put the spec past the repo's 400-code-line ceiling, and the answer here is a split.
//
// THE CUT IS A REAL SEAM, and it is why the startup reading (JOS-57) moved in here beside them
// rather than being left behind: both are measurements that RIDE `sessionHeartbeat` / `sessionEnd`
// rather than arriving as events of their own, both are therefore invisible from inside a running
// launch, and both are asserted the same single way — by reading `<userData>/telemetry.json` after
// the process that wrote it has exited. One subject, one file. The spec keeps its own (consent,
// the bar, the switch, the buffer).
//
// WHY THESE ASSERTIONS CANNOT BE UNIT TESTS. Every hop of this feature is a seam:
//
//     markStartupPhase('replayDone')  →  two 250 ms timers, one of them in a WORKER THREAD
//         →  the worker's messages crossing back to main  →  the drain onto sessionEnd
//         →  <userData>/telemetry.json
//
// `tests/liveStalls.test.mts` drives every fold, bucket and the coincidence matcher directly and
// proves their arithmetic; only a running app proves that a fourth rollup entry really emitted a
// loadable `perfProbeWorker.js`, that a thread started inside a packaged main bundle, and that
// the chain closes. That is the exact failure JOS-364 was written to correct one event over — a
// schema, a rollup and a panel all fine while nothing ever emits, which reads as "the fleet has
// no stalls".
//
// READ AFTER THE PROCESS EXITS, because the drain rides `sessionEnd`: a heartbeat is ten minutes
// away and this suite caps a spec at five, and `sessionEnd` is the arm most real sessions use
// anyway (most sessions end before the ten-minute mark).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { check } from './appHarness.mjs'
// The SERVER's own validator, run on the bytes a real launch produced — so this asserts "the
// ingest Lambda would accept this", not "it looks about right". `errorReportSteps.mts`'s trick.
import { validateTelemetryEvent } from '../../src/shared/telemetryValidate'

interface Ring {
  events?: { ev: Record<string, unknown> }[]
}

/**
 * THE STARTUP READING ACTUALLY FIRED (JOS-57) — read off the ring FILE, with the app that wrote
 * it gone. It cannot be observed from inside a running launch: the reading is produced when the
 * replay finishes and is carried by the next session report, which is a heartbeat ten minutes
 * later (JOS-269; it was five, and a suite that caps a spec at 5 min was never going to see it
 * either way) or the `sessionEnd` written on the way out — and it is the `sessionEnd` arm this
 * asserts, which is the arm that got MORE common, not less. So this is the only place the chain —
 * `replayDone` → perf.ts → the collector's pending slot → `sessionEnd` → the ring on disk — is
 * visible at once, and it is exactly the failure JOS-39 was about: a schema and a panel that are
 * both fine while nothing ever emits, which reads as "the fleet has no slow launches".
 *
 * The numbers are asserted as SHAPE, not as values: this launch really did replay the staged
 * fixture, so a millisecond figure is a property of the machine running the suite (frozen numbers
 * rot). What must be true on any machine is that the reading exists, carries all six fields, and
 * that the size is a BUCKET INDEX rather than a byte count.
 */
export function stepStartupReading(userData: string): void {
  const path = join(userData, 'telemetry.json')
  let events: { ev: Record<string, unknown> }[]
  try {
    events = (JSON.parse(readFileSync(path, 'utf8')) as { events?: { ev: Record<string, unknown> }[] }).events ?? []
  } catch (err) {
    check('the session ring reached disk', false, String(err))
    return
  }
  // ── THE STARTUP REPLAY READING RETIRES (JOS-499) — AND THE CHAIN IT PROVED DOES NOT ─────────
  //
  // WHAT IT CLAIMED. Six numbers — `replayMs`, `eventsReplayed`, `dutyPct`, `maxBlockMs`,
  // `blocksOver50`, `logSizeBucket` — describing what THIS PROCESS'S historical fold cost, carried
  // out on a session report. Every one of them came from `TailResult` and the two startup probes,
  // all of which are deleted: `reportStartupReplay` is gated on `replayStats` and there are none,
  // so nothing is emitted and there is nothing to assert.
  //
  // THE FAILURE THIS STEP EXISTS FOR IS NOT THE READING, IT IS THE CHAIN — JOS-39's, verbatim: a
  // schema and a panel that are both fine while nothing ever emits, which reads as "the fleet has
  // no slow launches". That failure is still possible and is still worth catching, so what is
  // asserted instead is the chain's SURVIVING half: a session report really did reach the ring on
  // disk, written by an app that has since exited. A ring with no session report at all is the same
  // silence JOS-39 was about, one carrier further down.
  const kinds = [...new Set(events.map((r) => String(r.ev.t)))]
  if (
    !check(
      'a session report reached the ring on disk — the carrier the startup reading used to ride',
      events.length > 0 && kinds.includes('sessionEnd'),
      `${String(events.length)} event(s): ${kinds.join(', ')}`
    )
  ) {
    return
  }
  // …AND NOTHING INVENTS ONE. An app that folds nothing must not report a fold: a `startup` block
  // appearing here would mean somebody wired zeroes into the fleet reading, which is worse than the
  // silence above because it looks like data.
  check(
    'no launch claims a replay it never ran — the reading is absent, not zeroed',
    events.every((r) => r.ev.startup === undefined),
    JSON.stringify(events.find((r) => r.ev.startup !== undefined)?.ev.startup ?? 'absent')
  )
}


/**
 * SHAPE, NOT VALUES. How late this machine's timers ran while it replayed a fixture is a property
 * of the box running the suite, and frozen numbers rot. `coincident` is asserted only IF present:
 * absent is a documented answer meaning "no second clock ran", and a CI box that refuses a thread
 * must not turn into a red suite over a diagnostic that already knows how to say so. `tail` is
 * genuinely optional too — a launch that never tails live has nothing to report, which is the
 * contract's own rule rather than a softened assertion.
 */
export function stepLiveRiders(userData: string): void {
  let events: { ev: Record<string, unknown> }[]
  try {
    events = (JSON.parse(readFileSync(join(userData, 'telemetry.json'), 'utf8')) as Ring).events ?? []
  } catch (err) {
    check('the live stall reading reached the ring on disk', false, String(err))
    return
  }
  const carriers = events.filter((r) => r.ev.live !== undefined)
  if (
    !check(
      'the live stall reading reached the ring on disk, on a session report',
      carriers.length >= 1,
      `${String(carriers.length)} carrier(s) among ${String(events.length)}: ${[...new Set(events.map((r) => String(r.ev.t)))].join(', ')}`
    )
  ) {
    return
  }
  const ev = carriers[0].ev
  liveShape(ev.live as Record<string, unknown>)
  stateShape(ev.state as Record<string, unknown> | undefined)
  // …and the whole event through the server's validator: every rider it carried is inside its
  // ladder, or the ingest would have refused the batch it rode in.
  const validated = validateTelemetryEvent(ev)
  check(
    '…and the report carrying them would be ACCEPTED by the ingest validator, unaltered',
    validated.ok,
    validated.ok ? '' : `${validated.field}: ${validated.message}`
  )
}

function liveShape(live: Record<string, unknown>): void {
  check(
    '…with samples from a probe that really ran, and percentiles that are BUCKET INDICES',
    ['samples', 'p95Bucket', 'maxBucket', 'over100', 'over500'].every(
      (k) => typeof live[k] === 'number'
    ) &&
      (live.samples as number) > 0 &&
      (live.p95Bucket as number) <= 8,
    JSON.stringify(live)
  )
  // AND THE SECOND THREAD ANSWERED. This is the assertion the whole ticket rests on and the one
  // no unit test can make: a `coincident` of any value means `perfProbeWorker.js` was emitted as
  // its own rollup entry, loaded from `__dirname` inside a real main bundle, kept its own clock
  // and got a message back across the thread boundary. ABSENT would mean no second clock ran —
  // a legal answer for a user's machine (the contract documents it), and a regression here.
  check(
    '…and the WORKER probe answered: a verdict exists, so two clocks were really compared',
    typeof live.coincident === 'number',
    // The detail prints on pass as well as fail (the harness's shape), so it states the VALUE and
    // lets the check's own sentence carry the claim — `undefined` here reads as "never spoke".
    `coincident=${JSON.stringify(live.coincident)}`
  )
}

function stateShape(state: Record<string, unknown> | undefined): void {
  check(
    '…and the state rider beside it: two window counts, two flags, two memory buckets',
    state !== undefined &&
      ['overlaysOpen', 'overlaysLocked', 'freeMemBucket', 'workingSetBucket'].every(
        (k) => typeof state[k] === 'number'
      ) &&
      typeof state.presenceOn === 'boolean' &&
      typeof state.ringOn === 'boolean',
    JSON.stringify(state)
  )
}
