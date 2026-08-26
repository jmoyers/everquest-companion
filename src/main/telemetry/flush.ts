// telemetry/flush.ts — the session lifecycle and the flush loop that now actually sends.
//
// TWO JOBS, ONE TIMER (JOS-395 merged them; before that they were two `setInterval`s):
//
//   * THE HEARTBEAT (10 min) is COLLECTION. It records `sessionHeartbeat` into the local ring so
//     "how long do sessions actually last" survives a process that is killed rather than closed
//     — a `sessionEnd` that never fires is exactly the data point you most want. It runs
//     whenever the user's switch is on, endpoint or no endpoint, because nothing it does leaves
//     the machine.
//
//   * THE FLUSH (5 min) is NETWORK. It happens only when `telemetryFlushEnabled` says so: not
//     under e2e, not without an endpoint, not with the switch off, and NOT BEFORE THE FIRST-RUN
//     NOTICE HAS RENDERED. Same discipline as `startQueueFlush` — one predicate (net.ts), read
//     by the loop on every tick rather than once at startup, because two copies of a network
//     gate is how one of them drifts.
//
// WHY ONE TIMER AND NOT TWO, which is THE COINCIDENCE INVARIANT made structural. The heartbeat
// cadence is a MULTIPLE of the flush cadence on purpose: a heartbeat tick must also be a flush
// tick, so the pulse rides out on the same timer turn that recorded it rather than waiting five
// minutes for the next one, and `triage/liveSessions.ts` can keep reading one heartbeat per
// session per bucket. Two `setInterval`s made that true by luck — they were started microseconds
// apart and drifted only slowly. Once each tick carries its own ±5% jitter (JOS-395) luck is not
// good enough: two independently wobbling timers land up to 30 s apart and fire in either order,
// and the flush-first half of those is exactly the five-minute wait the invariant forbids. So
// there is ONE loop over ONE grid (`./schedule.ts`), the heartbeat is an INDEX on that grid
// (`isHeartbeatTick`), and it is recorded BEFORE the tick's flush reads the ring. Coincidence is
// then a property of the code's shape, not of two clocks agreeing.
//
// AND WHY THE FLUSH RIDES A TIMER IT DOES NOT GATE. "A timer that can only ever no-op is still not
// created" (the `startQueueFlush` precedent) survives this merge intact and is in fact honoured
// harder: the collection timer exists whenever the switch is on, and a shut network gate now costs
// one predicate call per tick instead of a second timer. Nothing reaches the network before the
// notice — `flushTelemetry` re-reads the gate first, every time.
//
// The loop's timers are `unref`'d, so neither the tick nor a pending retry can be the reason the
// process stays alive.
//
// WHY THOSE TWO NUMBERS AND NOT THE ORIGINAL 60 s / 5 min (JOS-269, owner cost ruling 2026-08-12).
// Every flush is ONE request through API Gateway, Lambda and DSQL — the three meters that cost
// money — and the free tier had a month in sight (Lambda at 911k of 1M). Nothing here is a click
// stream: every event is a COUNTER DELTA that the ingest Lambda sums server-side into a day's row,
// so ten deltas in one batch aggregate to exactly what ten batches of one would have. Batching is
// therefore free of information loss, and 60 s → 5 min is ~5x fewer requests from an active
// client while 5 min → 10 min halves the idle floor.
//
// WHAT IT DOES COST, stated rather than hidden: TIME RESOLUTION on a session that is KILLED. A
// clean exit still reports `sessionEnd` with the exact uptime; a process that dies is only known
// to have lived as long as its last heartbeat said, so the worst-case understatement of such a
// session goes from just under 5 minutes to just under 10. That is a coarsening of the tail of the
// duration histogram, not a change to what is collected — the events, their fields and their
// buckets are untouched, and telemetry CONTENT is owner law that this ticket does not get to move.
//
// AND ONE THING THAT MUST NOT MOVE WITH IT: the "not now" arm of `flushTelemetry` below. The
// server's throttle is being halved in the same release, so 429 gets MORE likely, not less — the
// buffer keeps its records and the next tick tries again, exactly as before. A longer flush period
// makes that patience cheaper, never optional.
//
// WIRED INTO STARTUP from `src/main/index.ts` (the composition root), immediately beside
// `startQueueFlush()`, and stopped from `window-all-closed` beside `stopQueueFlush()`.

import { E2E } from '../e2e'
import { logInfo } from '../errorLog'
import {
  bucketOf,
  COLD_START_MS_EDGES,
  type StartupReplayStats,
  type TelemetryBatch,
  type TelemetryEnvelope,
  type TelemetryFlipKind,
  type TelemetryPrefs
} from '../../shared/telemetry'
import {
  TELEMETRY_API_URL,
  postTelemetryBatch,
  telemetryCollectEnabled,
  telemetryFlushEnabled,
  telemetryPermanentRefusal
} from './net'
import { flipNoticeBatch, flipNoticeKind, telemetryFlipNoticeEnabled } from './optOut'
import {
  beginSession,
  endSession,
  ensureAnalyticsId,
  envelope,
  markNoticeShown,
  pendingBatch,
  recordEvent,
  sessionUptimeMs,
  setTelemetryEnabled,
  takeLinesParsed,
  takeStartupReplay,
  viewsVisited
} from './collector'
import { markFunnelStep } from './funnels'
import { armSetupSnapshotOnOptIn } from './setupSnapshot'
// The live-session riders (JOS-367) — the probe, the tail and the window layer, gathered behind
// one call so neither session report can drain a different set than the other.
import { liveRiderFields } from './liveRiders'
import { takeHealth } from './health'
import { takeErrorReports } from './errorReports'
import { readRing, writeRing } from './ring'
import { getTelemetryPrefs } from '../store'
// WHEN this loop fires, as pure arithmetic: the per-launch phase, the drift-corrected grid, the
// heartbeat's index on it and the retry's full-jitter backoff. It lives one file over because it
// must import NOTHING — this file imports `../store`, and therefore Electron, and the schedule is
// the half a node test can drive with a seeded `rand` and a virtual clock (JOS-395).
import {
  advance,
  armDelayMs,
  beginSchedule,
  isHeartbeatTick,
  nominalMs,
  retryDelayMs,
  type TickSchedule
} from './schedule'

// The two cadences are SCHEDULE facts and are declared beside the grid they space; they are
// re-exported here because this is the module the rest of the app (and `liveSessions.ts`'s comment)
// has always named for them.
export { FLUSH_INTERVAL_MS, HEARTBEAT_INTERVAL_MS } from './schedule'

/**
 * WHAT ONE ATTEMPT SETTLED, as four words — the loop's whole reason for knowing more than "did a
 * batch come back". Only `retry` schedules anything: `idle` (gate shut or nothing buffered) has
 * nothing to try again with, and `accepted` / `refused` have both already left the ring.
 */
type FlushOutcome = 'idle' | 'accepted' | 'refused' | 'retry'

/**
 * Send the batch this tick has to send, and say how it went.
 *
 * The gate is re-read here rather than trusted from `startTimers`: the switch can go off, and
 * the notice can be answered, between one tick and the next.
 */
async function attemptFlush(): Promise<{ outcome: FlushOutcome; batch: TelemetryBatch | null }> {
  if (!telemetryFlushEnabled(E2E, TELEMETRY_API_URL, getTelemetryPrefs())) {
    return { outcome: 'idle', batch: null }
  }
  const batch = pendingBatch()
  if (batch === null) return { outcome: 'idle', batch: null }
  const { status } = await postTelemetryBatch(batch)
  const accepted = status >= 200 && status < 300
  // "Not now" (0 offline, 429 daily cap, 503 kill switch) keeps the buffer — for a jittered retry
  // inside this interval (`scheduleRetry`) and, failing that, for the next tick.
  if (!accepted && !telemetryPermanentRefusal(status)) return { outcome: 'retry', batch: null }
  return { outcome: accepted ? 'accepted' : 'refused', batch: retireBatch(batch, accepted) }
}

/**
 * Send the batch this tick has to send, and return it once the server has ACCEPTED it (null
 * for every other outcome — gate shut, nothing buffered, refused, or never answered).
 */
export async function flushTelemetry(): Promise<TelemetryBatch | null> {
  return (await attemptFlush()).batch
}

/**
 * Take the sent records out of the ring, and remember the batch for the Preferences viewer.
 *
 * OPT-OUT WINS A RACE WITH THE WIRE. The user can press the switch while a POST is in flight,
 * and `setTelemetryEnabled(false)` drops the ring and the id; writing the ring back here would
 * RESURRECT the file — with the batch they just opted out of sitting in it as `lastBatch`. So
 * the switch is re-read after the await and an opted-out install is left exactly as it is.
 *
 * The retire is `slice(n)` from the FRONT, which is right because records are appended at the
 * back and the batch is always the whole ring as it was read. The one imprecise case is a ring
 * that hit its cap mid-flight: the cap drops from the front too, so a few unsent records can go
 * with the sent ones. Losing a handful of counters is the documented cost of this feature; the
 * alternative (matching records by identity) buys nothing a counter feed can spend.
 */
function retireBatch(batch: TelemetryBatch, accepted: boolean): TelemetryBatch | null {
  if (!telemetryCollectEnabled(getTelemetryPrefs())) return null
  const ring = readRing()
  writeRing({
    ...ring,
    events: ring.events.slice(batch.events.length),
    lastBatch: accepted ? batch : ring.lastBatch
  })
  return accepted ? batch : null
}

/**
 * The optional `startup` field, spread into whichever session report drains it — `{}` when there
 * is nothing to report, so the property is ABSENT rather than `undefined`. That matters twice: the
 * validator's `startup === undefined` arm and JSON's own omission both mean "no reading", and an
 * explicit `startup: undefined` key would be a third spelling of it in the payload viewer.
 */
function startupField(): { startup?: StartupReplayStats } {
  const startup = takeStartupReplay()
  return startup === undefined ? {} : { startup }
}

/**
 * DRAIN THE HEALTH COUNTERS ONTO A SESSION REPORT (JOS-96), beside the two drains above and for
 * the same reason: whichever of `sessionHeartbeat` / `sessionEnd` fires first takes them, so a
 * session that does both reports each error exactly once and a killed session loses at most its
 * last window.
 *
 * IT IS RECORDED EVEN WHEN EVERYTHING IS ZERO, and that is the decision the whole readout rests
 * on. `healthCounters` is dimmed by VERSION in the rollup, so the report itself — not the errors
 * in it — is what says "a client on this build is capable of reporting". Emitting only on a bad
 * session would make a healthy build look exactly like a build that predates this code, and the
 * panel could never honestly separate "no errors" from "no data". The cost is one extra ring
 * record per ten minutes (JOS-269 halved the rate this is written at, and it was already
 * nothing); the alternative costs the question its answer.
 *
 * It is a SEPARATE `recordEvent` rather than a field on the session event because `healthCounters`
 * is an existing kind in the shipped contract — the ingest Lambda already validates it — so this
 * needs no wire change at all, and the deploy-skew rule (shared/telemetry.ts) is satisfied without
 * an additive field. An older Lambda accepts the batch and folds it under the OLD dims; it never
 * 400s, so nothing is ever dropped while the deploys are out of step.
 */
function reportHealth(): void {
  recordEvent({ t: 'healthCounters', ...takeHealth() })
}

/**
 * DRAIN THE ERROR REPORTS ONTO THE SAME SESSION REPORT (JOS-100), beside the health counters
 * and on the same terms: whichever of `sessionHeartbeat` / `sessionEnd` fires first takes them,
 * so nothing is double counted and a killed session loses at most its last window.
 *
 * IT EMITS NOTHING WHEN NOTHING BROKE, which is the opposite of `reportHealth` above and is the
 * same argument read from the other side. `healthCounters` is written even when every count is
 * zero because the report ITSELF is the per-version "a client on this build can report at all"
 * signal, and `healthReports` is the denominator every rate is divided by. That denominator
 * already exists — so an empty `errorReport` every ten minutes would add a ring record saying
 * something `healthReports` has already said, and would spend the 500-entry buffer doing it.
 *
 * `recordEvent` IS THE GATE, here as everywhere: the user's switch is checked there, once, and
 * an install with analytics off drops these on the floor exactly as it drops every other event.
 *
 * UNLIKE `healthCounters`, THIS IS A NEW EVENT KIND, so it cannot ship ahead of the ingest
 * deploy — shared/telemetry.ts says what happens if it does, and it is a fleet-wide analytics
 * blackout rather than a missing feature.
 */
function reportErrors(): void {
  for (const ev of takeErrorReports()) recordEvent(ev)
}

// ------------------------------------------------------------------------------- THE LOOP
//
// A CHAINED `setTimeout`, NOT A `setInterval`, and that is forced rather than stylistic: every
// tick's delay is a different number (the grid point minus where the clock actually is, plus this
// tick's wobble), and an interval cannot be re-timed without being torn down and rebuilt. A chained
// timeout IS "compute the next fire time from the grid" written out.
//
// `retry` is a second, short-lived handle: at most one in flight, and the next tick clears it.

/** This launch's phase and the index of the tick currently armed. `null` = not collecting, and it
 *  is the sentinel the two idempotent entry points below read. */
let sched: TickSchedule | null = null
/** Wall clock at which the grid begins. Every delay is expressed as ms after this. */
let origin = 0
let tick: ReturnType<typeof setTimeout> | null = null
let retry: ReturnType<typeof setTimeout> | null = null

/** ms since the loop's origin — the coordinate `./schedule.ts` speaks in. */
function elapsed(): number {
  return Date.now() - origin
}

/**
 * Start collection for this session. Idempotent.
 *
 * `coldStartMs` is how long the app took to become usable — measured by the caller (the
 * composition root knows when the process began and when the window was created; this module
 * does not) and bucketed here so the raw millisecond never enters the ring.
 */
export function startTelemetry(coldStartMs: number): void {
  if (sched !== null) return
  const prefs = getTelemetryPrefs()
  if (!prefs.enabled) return
  ensureAnalyticsId()
  beginSession()
  recordEvent({ t: 'sessionStart', coldStartMsBucket: bucketOf(coldStartMs, COLD_START_MS_EDGES) })
  // THE FIRST-RUN FUNNEL'S STEP 1, and it is a launch rather than the id-minting call that
  // produces it: `ensureAnalyticsId` mints again after a rotation or an off/on, and each of those
  // would otherwise look like a fresh installation. The once-ever mark (funnels.ts) is what makes
  // this the FIRST launch of this install, and it survives both of those events.
  markFunnelStep('first-run', 'installed')
  startTimers(prefs)
}

/** The loop, once the decision to run it has been made: mint this launch's phase, arm tick 0. */
function startTimers(prefs: TelemetryPrefs): void {
  origin = Date.now()
  sched = beginSchedule()
  armTick()
  announceFlush(prefs)
}

/** Arm the currently-scheduled tick, at whatever the grid says this one's delay is. */
function armTick(): void {
  if (sched === null) return
  tick = setTimeout(onTick, armDelayMs(sched, elapsed()))
  // `unref` so a pending timer can never be the reason the process stays alive.
  tick.unref()
}

/**
 * ONE TICK: the heartbeat if this grid index is one, then the upload.
 *
 * THE ORDER IS THE COINCIDENCE INVARIANT. `recordHeartbeat` is synchronous and runs FIRST, so the
 * `pendingBatch()` read inside the flush below sees a ring that already contains the pulse and it
 * leaves on this turn rather than waiting five minutes for the next. Nothing about the jitter can
 * separate them, because there is nothing to separate — it is one call after another.
 *
 * The next tick is armed BEFORE the flush is started: the flush is async and may sit on a 15-second
 * POST budget, and a grid that only advances after the network answers is a grid that drifts by
 * exactly the thing it was built not to drift by.
 */
function onTick(): void {
  const s = sched
  if (s === null) return
  if (isHeartbeatTick(s.k)) recordHeartbeat()
  sched = advance(s, elapsed())
  // A retry left over from the previous interval is superseded by this tick's own attempt.
  clearRetry()
  armTick()
  void runFlush(0)
}

/** The 10-minute pulse and the two drains that ride it. */
function recordHeartbeat(): void {
  // The heartbeat is also what DRAINS the parsed-line delta (collector.ts): the counter is
  // reported by the same event that proves the session was still alive to do the parsing, so a
  // killed process loses at most the last ten minutes of it (JOS-269; it was five). A LOST TAIL
  // IS NOT A MISCOUNT of an ordinary exit — `stopTelemetry` drains the same counter below — so
  // what widened is only how much a CRASH can swallow, and a counter is the shape that survives
  // that best.
  recordEvent({
    t: 'sessionHeartbeat',
    uptimeMs: sessionUptimeMs(),
    linesParsed: takeLinesParsed(),
    // …and this launch's startup replay, on the first heartbeat after it finished (JOS-57).
    // Drained, so exactly one report carries it: one launch is one reading. THE 10-MINUTE
    // HEARTBEAT DOES NOT ENDANGER THAT — the drain is a race between this and `sessionEnd`,
    // whichever fires first, and `takeStartupReplay` empties the slot either way. A longer
    // heartbeat only shifts WHICH of the two carries it; it can never lose or duplicate it.
    ...startupField(),
    // …and how the LAST TEN MINUTES ACTUALLY WENT (JOS-367): how late our two clocks ran and
    // whether they went late together, what the tail's reads cost, and what was switched on
    // while both were measured. Drained here on the same terms as the line delta above — one
    // interval is reported once, by whichever of these two events gets to it first.
    ...liveRiderFields()
  })
  reportHealth()
  reportErrors()
}

/**
 * One tick's upload, and the retries a "not now" earns it.
 *
 * WHY RETRY AT ALL WHEN THE NEXT TICK WOULD DO IT ANYWAY (JOS-395): because the next tick is the
 * SAME BOUNDARY, and a fleet that all got 429 at once would all come back at once five minutes
 * later — the herd re-forming out of the very answer that was meant to thin it. A full-jitter wait
 * (uniform in [0, ceiling), ceiling doubling from 30 s) spreads the second attempt across the
 * interval instead.
 *
 * `attempt` counts consecutive "not now" answers WITHIN this interval. Nothing here is a new
 * give-up rule: the ceiling is clamped to the next nominal tick, so the chain ends by arithmetic,
 * the buffer keeps its records exactly as it did before (`retireBatch`), and the next tick starts a
 * fresh chain. A permanent refusal (400/413) never reaches this code — it retires inside
 * `attemptFlush`, as it always has.
 */
async function runFlush(attempt: number): Promise<void> {
  const { outcome } = await attemptFlush()
  if (outcome !== 'retry' || sched === null) return
  const toNextTick = nominalMs(sched) - elapsed()
  if (toNextTick <= 0) return
  retry = setTimeout(() => void runFlush(attempt + 1), Math.max(1, retryDelayMs(attempt, toNextTick)))
  retry.unref()
}

/** Whether the loop's flush half has anywhere to go — said ONCE per process, in the log.
 *
 *  On a first run the app starts with `noticeShown: false`, so the gate is shut when `startTimers`
 *  runs; it opens a few seconds later when the notice renders and is answered. The loop needs no
 *  restarting for that (it has been ticking since launch and `attemptFlush` re-reads the gate every
 *  time) — but the log line still marks the moment the network half went live, which is the first
 *  thing anyone reads when asking why an install sent nothing. */
let announced = false
function announceFlush(prefs: TelemetryPrefs): void {
  if (announced || !telemetryFlushEnabled(E2E, TELEMETRY_API_URL, prefs)) return
  announced = true
  logInfo('[everquest-companion] telemetry: flush loop started')
}

function clearRetry(): void {
  if (retry !== null) clearTimeout(retry)
  retry = null
}

function clearTimers(): void {
  if (tick !== null) clearTimeout(tick)
  clearRetry()
  tick = null
  // Dropping the schedule is what makes a restart mint a NEW phase rather than resume the old one.
  sched = null
}

/**
 * The user switched it ON from Preferences, part-way through a session that started with it
 * off. Starts the session and its timers — but records NO `sessionStart`, deliberately: this
 * session began before collection did, and there is no honest cold-start figure for it. A
 * bucketed guess would be indistinguishable from a measurement in the aggregate, which is
 * exactly the kind of number world-model law 1 exists to refuse.
 *
 * (The e2e spec is what found this: enabling from the pane used to leave the heartbeat dead
 * until the next launch, so a session the user had explicitly opted into produced view dwells
 * but no session at all.)
 */
export function resumeTelemetry(): void {
  const prefs = getTelemetryPrefs()
  if (!prefs.enabled) return
  if (sched !== null) {
    // Already collecting — this call came from the first-run notice being answered, which is
    // the moment the NETWORK gate opens for a session that is already under way. The loop is
    // already on the grid; the next tick simply finds the gate open.
    announceFlush(prefs)
    return
  }
  beginSession()
  startTimers(prefs)
}

/** The user switched it OFF mid-session. Stops the timers WITHOUT a `sessionEnd` — a session
 *  they opted out of is not a session we get to write a closing record for. */
export function pauseTelemetry(): void {
  clearTimers()
  endSession()
}

/**
 * SEND ONE FLIP NOTICE (JOS-109). Best effort, exactly once, never retried — `./optOut.ts` holds
 * the whole argument for why this bypasses `telemetryFlushEnabled`'s `enabled` term and why it
 * may not keep anything to try again with.
 *
 * It does NOT touch the ring, in either direction: it neither reads it (the batch is built from
 * the envelope alone) nor writes it back on success (`retireBatch`'s resurrection hazard, which
 * for an opted-out install would recreate the very file the switch just deleted). The return
 * value exists for the tests and for the log line; no caller acts on it.
 */
export async function sendFlipNotice(
  kind: TelemetryFlipKind,
  env: TelemetryEnvelope,
  prefs: TelemetryPrefs
): Promise<boolean> {
  if (!telemetryFlipNoticeEnabled(E2E, TELEMETRY_API_URL, prefs)) return false
  const { status } = await postTelemetryBatch(flipNoticeBatch(kind, env, Date.now()))
  const accepted = status >= 200 && status < 300
  logInfo(
    `[everquest-companion] telemetry: ${kind} notice ${accepted ? 'sent' : 'not delivered'}` +
      (accepted ? '' : ' (not retried - see telemetry/optOut.ts)')
  )
  return accepted
}

/**
 * Apply the switch AND bring this session's timers into line with it. The one place both the
 * Preferences toggle and the first-run notice go through, so the two can never diverge.
 *
 * THE ORDER OF THE FOUR STEPS BELOW IS THE FEATURE (JOS-109), not house style:
 *
 *   1. read the switch as it stands, so a write that changes nothing emits nothing;
 *   2. for an OPT-OUT, build the notice BEFORE applying — `setTelemetryEnabled(false)` discards
 *      the analyticsId, and an envelope is the only thing that makes the notice countable;
 *   3. apply, which is what makes "off" mean off immediately: ring gone, id gone, timers stopped.
 *      Nothing waits on the network for that;
 *   4. for an OPT-IN, build the notice AFTER — the id it needs was minted by step 3 — and fire
 *      whichever notice step 2 or 4 produced, unawaited. The switch is a synchronous IPC answer
 *      and must not sit behind a 15 s POST budget.
 */
export function applyTelemetryEnabled(enabled: boolean): TelemetryPrefs {
  const kind = flipNoticeKind(getTelemetryPrefs().enabled, enabled)
  const farewell = kind === 'optOut' ? envelope() : null
  const next = setTelemetryEnabled(enabled)
  if (next.enabled) {
    resumeTelemetry()
    // THE SETUP SNAPSHOT GETS ANOTHER CHANCE (JOS-501). It arms ten seconds after `replayDone` and
    // is dropped on the floor if collection was off at that instant — and it latched itself either
    // way, so a session that started opted out could never file one. Somebody enabling telemetry
    // mid-session is very often doing it to report a problem, which makes theirs one of the
    // machine-class rows most worth having. A no-op once the snapshot has landed.
    armSetupSnapshotOnOptIn()
  } else pauseTelemetry()
  const env = farewell ?? (kind === 'optIn' ? envelope(next) : null)
  if (kind !== null && env !== null) void sendFlipNotice(kind, env, next)
  return next
}

/** The first-run notice was answered (or dismissed, which keeps it on — T1). */
export function answerNotice(keepEnabled: boolean): TelemetryPrefs {
  markNoticeShown()
  return applyTelemetryEnabled(keepEnabled)
}

/** Close the session: record `sessionEnd`, stop both timers. Safe to call more than once. */
export function stopTelemetry(): void {
  const uptime = sessionUptimeMs()
  if (uptime > 0) {
    recordEvent({
      t: 'sessionEnd',
      durationMs: uptime,
      viewsVisited: viewsVisited(),
      // The tail of the line delta: everything parsed since the last heartbeat. Without it every
      // session under ten minutes would report zero lines, and short sessions are common — MORE of
      // them fall in that band now that the heartbeat is 10 min (JOS-269), which makes this drain
      // load-bearing for a larger share of sessions rather than a rarer edge.
      linesParsed: takeLinesParsed(),
      // …and the startup reading, if no heartbeat got there first — which is the common case, and
      // more common still now: most sessions end before the ten-minute mark.
      ...startupField(),
      // The tail of the live readings too, and for the SAME reason the line delta needs one: most
      // sessions end before a heartbeat ever fires, so without this drain the stall numbers would
      // describe only the sessions that lasted ten minutes — a population selected against
      // precisely the short, bad session this measurement exists to catch.
      ...liveRiderFields()
    })
    // The tail of the health deltas, on the same terms as the line delta beside it. Inside the
    // `uptime > 0` guard deliberately: a process that never started collecting has no session to
    // report the health OF, and a bare `healthReports` row from it would inflate the denominator
    // every rate on the panel is divided by.
    reportHealth()
    // …and the tail of the error reports. Also inside the guard, and for the SECOND half of the
    // same reason: a process that never started collecting has no session clock, so every
    // report it produced would carry `sessionAgeBucket: 0` — a made-up number in a real column.
    reportErrors()
  }
  clearTimers()
  endSession()
}
