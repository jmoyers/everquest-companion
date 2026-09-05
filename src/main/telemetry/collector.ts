// telemetry/collector.ts — accept an event, put it in the ring, and own the analyticsId.
//
// Everything that WRITES to the ring goes through `recordEvent`, and `recordEvent` refuses when
// the user's switch is off. That is one gate, in one place, rather than a check at each of the
// (eventually many) call sites — the same reasoning that put `queueFlushEnabled` inside
// `startQueueFlush` instead of restating it in the composition root.
//
// THE analyticsId (plan T3). A separate, anonymous, ROTATABLE id — deliberately NOT the
// feedback `installId`, so the two data sets cannot be joined even by us. It is minted LAZILY on
// the collector's first start, never at migration time: a store migration that minted an
// identifier would create one for a user who then turns the feature off before it is ever used.
// Rotation mints a new one AND drops the ring, which by design severs the retention chain — a
// rotated id is a new cohort member, and TELEMETRY.md says so.

import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  tzOffsetBucket,
  MAX_COUNT,
  TELEMETRY_API_VERSION,
  type TelemetryBatch,
  type TelemetryEnvelope,
  type StartupReplayStats,
  type TelemetryEvent,
  type TelemetryPayloadView,
  type TelemetryPlatform,
  type TelemetryPrefs
} from '../../shared/telemetry'
import { CHANNEL } from '../channel'
import { logInfo } from '../errorLog'
import { getTelemetryPrefs, setTelemetryPrefs } from '../store'
import { telemetryCollectEnabled, telemetryEndpointConfigured } from './net'
import { resetHealth } from './health'
import { resetErrorReports } from './errorReports'
import { dropRing, pushCapped, readRing, writeRing } from './ring'

/** `process.platform` folded onto the closed enum — a raw platform string is still a string. */
export function platformOf(platform: string): TelemetryPlatform {
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux') return platform
  return 'other'
}

/** Session bookkeeping. In-memory only: a session is by definition this process's lifetime. */
let startedAt = 0
const viewsSeen = new Set<string>()
/**
 * Log lines parsed since the last report went into the ring. A DELTA, not a total: it is drained
 * by the heartbeat (every 5 min) and by `sessionEnd`, so the fleet-wide sum is a sum of deltas
 * and no double counting is possible even when a session is killed rather than closed.
 *
 * A plain integer add, deliberately — this is incremented once per parsed line, which is the
 * hottest path in the app, so it may not read the store, allocate or touch the ring.
 */
let linesPending = 0
/**
 * THIS LAUNCH'S STARTUP REPLAY READING, waiting for a session report to carry it (JOS-57).
 *
 * It is a PENDING VALUE for the same reason `linesPending` is: the reading is produced at the
 * moment the replay finishes, and the events that can carry it (`sessionHeartbeat`, `sessionEnd`)
 * fire on their own schedule. Whichever comes first drains it, so the fleet counter can never
 * double-count one launch — and, since the drain is the only reader, a launch that is killed
 * before either event simply never reports, which is the documented cost of riding an existing
 * event instead of minting a new kind (shared/telemetry.ts, THE ADDITIVE-FIELD RULE).
 */
let startupPending: StartupReplayStats | null = null
/**
 * How many sessions have BEGUN in this process. It exists for one decision and says so (JOS-272):
 * whether `beginSession` is the first — in which case the errors filed before the pipeline existed
 * (a store schema quarantine, anything else raised at module scope) come with it — or a later one,
 * which starts empty like every session always has.
 *
 * It is counted HERE because a session is this module's idea, and `endSession` deliberately does NOT
 * decrement it: a session that was ended and resumed is not the boot window, and the errors filed
 * while the switch was off must not ride into the session the user turned back on.
 */
let sessionsBegun = 0

/** Wall-clock ms since `startTelemetry()` — 0 before it has run. */
export function sessionUptimeMs(now = Date.now()): number {
  return startedAt === 0 ? 0 : Math.max(0, now - startedAt)
}

export function beginSession(now = Date.now()): void {
  startedAt = now
  viewsSeen.clear()
  linesPending = 0
  startupPending = null
  // The health deltas live in their own leaf module (telemetry/health.ts — it has to, so
  // `errorLog.ts` can bump one without a cycle), but they are SESSION state exactly like the two
  // above and are cleared on the same boundaries.
  resetHealth()
  // Same for the error reports and the breadcrumb ring behind them (JOS-100). This call is also
  // what STAMPS the session clock those reports bucket their age against: `errorReports.ts`
  // cannot ask the collector for `sessionUptimeMs` without closing the errorLog cycle, so the
  // collector tells it instead, at the one moment both agree a session has begun.
  //
  // …AND ON THE FIRST SESSION IT KEEPS WHAT WAS ALREADY THERE (JOS-272). Everything `logError` filed
  // before this line ran was recorded and then cleared by it, which is why a store-schema quarantine
  // — raised from `store.ts`'s module scope, long before a window exists — has never once reached
  // the fleet. Only the FIRST session inherits: see `sessionsBegun` above.
  resetErrorReports(now, sessionsBegun === 0)
  sessionsBegun += 1
}

/**
 * Close the session's in-memory bookkeeping — including the undrained line delta, which is what
 * makes "turn it off" mean it: `pauseTelemetry` comes through here, and lines counted before the
 * switch was flipped must not be waiting to be reported if it is flipped back.
 */
export function endSession(): void {
  startedAt = 0
  viewsSeen.clear()
  linesPending = 0
  startupPending = null
  resetHealth()
  // The session clock is stamped to 0 here on purpose: `resetErrorReports` takes `now` and a
  // report built after this point would bucket its age from the LAST session's start. There is
  // no session, so the honest answer is bucket 0 and an empty ring.
  resetErrorReports(0)
}

/**
 * COUNT ONE (or n) PARSED LOG LINES. Called from the log feeders (`src/main/session.ts`) — both
 * the startup replay and the live tail — and it counts PARSING WORK, not distinct lines: the
 * replay re-reads a character's history on every launch and those lines are counted again.
 * TELEMETRY.md's field note says exactly that, so the number cannot be read as "lines in the log".
 *
 * NOTHING ABOUT THE LINE IS RETAINED. The argument is a count; there is no parameter that could
 * carry text even if a caller wanted to give it one.
 */
export function noteLinesParsed(n = 1): void {
  if (!Number.isFinite(n) || n <= 0) return
  linesPending += n
}

/**
 * Drain the delta for a report, capped at `MAX_COUNT` — the schema's ceiling for every count
 * field, which a 1.1M-event replay really does exceed.
 *
 * THE REMAINDER IS KEPT, not clamped away: the next heartbeat reports it. Clamping would quietly
 * undercount exactly the biggest logs, which are the ones the number is most interesting for.
 */
export function takeLinesParsed(): number {
  const taken = Math.min(linesPending, MAX_COUNT)
  linesPending -= taken
  return taken
}

/**
 * HOLD THIS LAUNCH'S STARTUP REPLAY READING until a session report can carry it (JOS-57). Called
 * once, from `src/main/perf.ts`, when the `replayDone` startup phase lands.
 *
 * FIRST WRITE WINS, and that is the comparability rule made mechanical: one launch is one reading,
 * so a second call (which the `replayDone` seam cannot produce today — `addMark` refuses a
 * duplicate phase — but a future wiring mistake could) is dropped rather than allowed to overwrite
 * the measurement the launch actually made.
 */
export function noteStartupReplay(stats: StartupReplayStats): void {
  // The same gate `recordEvent` applies, at the same place: an install with the switch off holds
  // nothing in memory either, so turning the switch on mid-session cannot resurrect a reading
  // taken while it was off.
  if (!telemetryCollectEnabled(getTelemetryPrefs())) return
  if (startupPending !== null) return
  startupPending = stats
}

/** Drain the reading for a report, or `undefined` when there is nothing to say. */
export function takeStartupReplay(): StartupReplayStats | undefined {
  const held = startupPending
  startupPending = null
  return held ?? undefined
}

/**
 * Mint the analyticsId if this install does not have one yet. Only when the feature is ON: a
 * user who has turned it off gets no identifier at all, not even an unused one.
 */
export function ensureAnalyticsId(): string | null {
  const prefs = getTelemetryPrefs()
  if (!telemetryCollectEnabled(prefs)) return null
  if (prefs.analyticsId !== null) return prefs.analyticsId
  const analyticsId = randomUUID()
  setTelemetryPrefs({ analyticsId })
  logInfo('[everquest-companion] telemetry: minted a new anonymous analytics id')
  return analyticsId
}

/**
 * Record one ALREADY-VALIDATED event. The IPC handler validates renderer input at the boundary
 * and main-side callers construct typed values, so this function's job is the gate and the ring,
 * not the shape.
 *
 * THERE IS EXACTLY ONE CARVE-OUT FROM THIS GATE IN THE WHOLE FEATURE, and it is named here so a
 * reader auditing "nothing is collected when the switch is off" finds it at the gate rather than
 * by accident: the OPT-OUT NOTICE (JOS-109, `./optOut.ts`). It is authored AT the flip and sent
 * as its own single-event batch, so it never enters this ring and never passes through this
 * function — which is why the gate below needs no exception written into it. The carve-out is
 * real all the same: one fieldless event leaves the machine after the switch reads false, it is
 * disclosed in TELEMETRY.md, and `./optOut.ts` argues every term of it. Nothing else may ever
 * take that route; everything else in this app goes through the line below.
 */
export function recordEvent(ev: TelemetryEvent): void {
  if (!telemetryCollectEnabled(getTelemetryPrefs())) return
  if (ev.t === 'viewDwell') viewsSeen.add(ev.view)
  const ring = readRing()
  writeRing({ ...ring, events: pushCapped(ring.events, { ts: Date.now(), ev }) })
}

/**
 * IS THE RING ACCEPTING ANYTHING RIGHT NOW? — `recordEvent`'s own gate, asked out loud (JOS-501).
 *
 * `recordEvent` drops silently when collection is off, which is right for a firehose of dwell and
 * heartbeat events: a caller that had to check first would be a second copy of the policy. But a
 * ONCE-PER-PROCESS event cannot be dropped silently, because there is no second one coming — and
 * that is exactly what happened to the setup snapshot, which arms ten seconds after `replayDone`
 * and latched itself whether or not the ring took it. A user who turned telemetry on after boot
 * never contributed a machine-class row for that session.
 *
 * So the snapshot asks before it builds, and stays pending when the answer is no. This is a READ
 * of the same predicate rather than a second one — if it ever disagrees with the line in
 * `recordEvent`, that is the bug.
 */
export function telemetryCollecting(): boolean {
  return telemetryCollectEnabled(getTelemetryPrefs())
}

/** How many distinct views this session has dwelled on (the `sessionEnd` field). */
export function viewsVisited(): number {
  return viewsSeen.size
}

/** The per-session constants every batch carries. Null until an id exists (⇒ nothing to send). */
export function envelope(prefs: TelemetryPrefs = getTelemetryPrefs()): TelemetryEnvelope | null {
  if (prefs.analyticsId === null) return null
  return {
    analyticsId: prefs.analyticsId,
    appVersion: app.getVersion(),
    // 'e2e' is not a telemetry channel (T7 — the harness never sends). It cannot reach here
    // while the flush gate excludes e2e, and if it ever did it would read as a dev run.
    channel: CHANNEL === 'prod' ? 'prod' : 'dev',
    platform: platformOf(process.platform),
    tzOffsetBucket: tzOffsetBucket(-new Date().getTimezoneOffset())
  }
}

/**
 * The batch a flush is about to send, or null when there is nothing to send / no id yet.
 * Pure with respect to the ring: BUILDING a batch never removes anything. The records come out
 * only once the server has answered (flush.ts `retireBatch`), so a POST that never lands loses
 * nothing.
 */
export function pendingBatch(): TelemetryBatch | null {
  const env = envelope()
  if (env === null) return null
  const events = readRing().events
  if (events.length === 0) return null
  return { v: TELEMETRY_API_VERSION, env, events: [...events] }
}

/**
 * The user's switch. OFF drops the ring IMMEDIATELY and DISCARDS THE ANALYTICS ID.
 *
 * The id going too was not the first design, and the e2e spec is what found it: because the
 * feature is opt-OUT, the collector mints an id on the very first launch — before the notice
 * has been answered — so a user who then presses "Turn it off" was left carrying an identifier
 * for something they had just declined. Nothing could have been done with it (the buffer is
 * gone and the build is dark), but "off" that leaves an id in your settings file is off with an
 * asterisk. Turning it back on mints a fresh one, which is exactly the rotate semantics: a
 * re-enable is a new cohort member, and that is the honest cost of having switched off.
 */
export function setTelemetryEnabled(enabled: boolean): TelemetryPrefs {
  if (!enabled) {
    dropRing()
    return setTelemetryPrefs({ enabled: false, analyticsId: null })
  }
  setTelemetryPrefs({ enabled: true })
  ensureAnalyticsId()
  // Re-read: `ensureAnalyticsId` writes the id through the store, not through this call.
  return getTelemetryPrefs()
}

/**
 * The first-run notice has RENDERED. It flips whichever button was pressed — and a plain
 * dismissal counts as an answer too, because that is what opt-out means (T1) — so the modal is
 * a once-ever event and the network gate above it opens exactly once.
 *
 * It does NOT touch `enabled`: `answerNotice` (flush.ts) pairs it with the switch, so the
 * session's timers come into line with the answer in one place.
 */
export function markNoticeShown(): TelemetryPrefs {
  return setTelemetryPrefs({ noticeShown: true })
}

/** New id, empty ring. Severs the retention chain on purpose (T3). */
export function rotateAnalyticsId(): TelemetryPrefs {
  dropRing()
  const next = setTelemetryPrefs({ analyticsId: randomUUID() })
  logInfo('[everquest-companion] telemetry: analytics id rotated; the local buffer was dropped')
  return next
}

/** Everything the Preferences payload viewer renders (T4). */
export function telemetryPayload(): TelemetryPayloadView {
  const ring = readRing()
  return {
    prefs: getTelemetryPrefs(),
    endpointConfigured: telemetryEndpointConfigured(),
    buffered: ring.events,
    lastBatch: ring.lastBatch
  }
}
