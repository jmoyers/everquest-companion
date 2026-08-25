// ============================================================================
// telemetryValidateSession.ts — THE TWO SESSION REPORTS AND THEIR OPTIONAL RIDERS.
// ============================================================================
//
// The FIFTH file of the one definition (`telemetryValidate.ts`'s header lists the other four), and
// split out for exactly the reason those two were: a rider added to these two events pushed that
// file past the repo's 400-code-line ceiling, and the house answer is a split.
//
// THE CUT IS BY SUBJECT, not by size. `sessionHeartbeat` and `sessionEnd` are the two events that
// carry OPTIONAL RIDERS — measurements that ride an existing kind rather than arriving as a new one
// — and every rider follows THE ADDITIVE-FIELD RULE stated in `./telemetry.ts`:
//
//   * `linesParsed` (2026-08-06) — the rule's first customer, and where it was learned.
//   * `startup` (JOS-57) — the startup replay reading, all six fields or none, with three later
//     discriminators each independently optional inside it.
//   * `live` / `tail` / `state` (JOS-367) — what a RUNNING session did between two reports: how
//     late our two clocks ran (and whether they went late TOGETHER, which is the machine-or-us
//     verdict), what the tail's reads cost, and what was switched on while both were measured.
//     Three independent groups, each all-or-nothing inside itself, declared in
//     `./telemetryLive.ts` because the contract file is at its factoring ceiling.
//
// Why the rule: a NEW EVENT KIND fails the whole batch on a server that has not been redeployed,
// and `telemetryPermanentRefusal` classes that 400 as "these bytes will never be accepted" and
// drops everything the client was carrying. A new OPTIONAL FIELD on an existing kind costs an old
// server nothing — the validators do not sanitize an object, they CONSTRUCT one field by field, so
// a field it has never heard of is simply not copied across.
//
// So the interesting property this file has to keep is that every rider can be absent, can be
// `null`, and can arrive at a server that predates it — and that a rider whose parts only mean
// something TOGETHER is refused rather than half-accepted.

import {
  COLD_START_MS_EDGES,
  isTelemetryObject,
  LOG_SIZE_BYTES_EDGES,
  MAX_COUNT,
  MAX_DURATION_MS,
  MAX_REPLAY_EVENTS,
  NEW_BYTES_EDGES,
  STUTTER_MS_EDGES,
  TELEMETRY_OVERLAY_KINDS,
  TELEMETRY_VIEWS,
  type EvSessionEnd,
  type EvSessionHeartbeat,
  type StartupReplayStats,
  type StartupStutterStats,
  type TelemetryEvent
} from './telemetry'
import {
  FREE_MEM_GB_EDGES,
  LIVE_STALL_MS_EDGES,
  WORKING_SET_MB_EDGES,
  type LiveStallStats,
  type SessionStateStats,
  type TailReadStats
} from './telemetryLive'
import {
  PERF_SEAMS,
  type GcStallStats,
  type SeamStallStats,
  type SeamStatsEntry
} from './perfSeams'
import { bucket, fail, flag, whole, type Validated } from './telemetryValidateBase'

export function vSessionStart(o: Record<string, unknown>): Validated<TelemetryEvent> {
  const b = bucket(o.coldStartMsBucket, 'coldStartMsBucket', COLD_START_MS_EDGES)
  return b.ok ? { ok: true, value: { t: 'sessionStart', coldStartMsBucket: b.value } } : b
}

/**
 * `linesParsed`, which both session-report events carry OPTIONALLY (the additive-field rule in
 * `./telemetry.ts`). Absent and null both mean "nothing to add", exactly as they do for
 * `failureClass` — an older client, or one whose parser never ran, simply does not send it.
 */
function optionalLines(o: Record<string, unknown>): Validated<number | undefined> {
  if (o.linesParsed === undefined || o.linesParsed === null) return { ok: true, value: undefined }
  return whole(o.linesParsed, 'linesParsed', MAX_COUNT)
}

/**
 * The startup replay reading (JOS-57), which both session reports carry OPTIONALLY under the same
 * additive-field rule as `linesParsed` — absent and null both mean "no reading in this one".
 *
 * ALL SIX FIELDS OR NONE. A partial reading is refused rather than repaired, because every number
 * in it describes the SAME seconds and a duty with no wall clock beside it (or a block count with
 * no worst block) is not a smaller measurement, it is an uninterpretable one. Constructed field by
 * field like every other validator here, so nothing that is not in the schema survives the trip.
 *
 * THE SIX ARE THE ORIGINAL SIX. JOS-57's scope addition layered three more on
 * (`startupDiscriminators`, below), and each of THOSE is optional on its own — that is what makes
 * them safe to ship into a fleet talking to a server that has never heard of them.
 */
function optionalStartup(o: Record<string, unknown>): Validated<StartupReplayStats | undefined> {
  const raw = o.startup
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (!isTelemetryObject(raw)) return fail('startup', 'startup must be an object.')
  const replayMs = whole(raw.replayMs, 'startup.replayMs', MAX_DURATION_MS)
  if (!replayMs.ok) return replayMs
  const events = whole(raw.eventsReplayed, 'startup.eventsReplayed', MAX_REPLAY_EVENTS)
  if (!events.ok) return events
  const duty = whole(raw.dutyPct, 'startup.dutyPct', 100)
  if (!duty.ok) return duty
  const maxBlock = whole(raw.maxBlockMs, 'startup.maxBlockMs', MAX_DURATION_MS)
  if (!maxBlock.ok) return maxBlock
  const blocks = whole(raw.blocksOver50, 'startup.blocksOver50', MAX_COUNT)
  if (!blocks.ok) return blocks
  const logSize = bucket(raw.logSizeBucket, 'startup.logSizeBucket', LOG_SIZE_BYTES_EDGES)
  if (!logSize.ok) return logSize
  return startupDiscriminators(raw, {
    replayMs: replayMs.value,
    eventsReplayed: events.value,
    dutyPct: duty.value,
    maxBlockMs: maxBlock.value,
    blocksOver50: blocks.value,
    logSizeBucket: logSize.value
  })
}

/**
 * THE JOS-57 SCOPE ADDITION's three fields, layered onto a reading whose original six have already
 * been accepted — the ADDITIVE-FIELD RULE applied INSIDE an existing group.
 *
 * Each is independently optional, and that is the whole deploy-skew argument: a client that sends
 * all three to a server built before they existed loses exactly them (this function does not run
 * there, and the six-field constructor copies nothing it does not name), while a client too old to
 * send them talks to a new server unchanged. Absent and null both mean "not reported", exactly as
 * they do for `linesParsed` and for the group as a whole.
 */
function startupDiscriminators(
  raw: Record<string, unknown>,
  base: StartupReplayStats
): Validated<StartupReplayStats> {
  const newBytes = optionalBucket(raw.newBytesBucket, 'startup.newBytesBucket', NEW_BYTES_EDGES)
  if (!newBytes.ok) return newBytes
  const stutter = optionalStutter(raw.stutter)
  if (!stutter.ok) return stutter
  const firstMb = optionalWhole(raw.firstMbMs, 'startup.firstMbMs', MAX_DURATION_MS)
  if (!firstMb.ok) return firstMb
  return {
    ok: true,
    value: {
      ...base,
      ...(newBytes.value === undefined ? {} : { newBytesBucket: newBytes.value }),
      ...(stutter.value === undefined ? {} : { stutter: stutter.value }),
      ...(firstMb.value === undefined ? {} : { firstMbMs: firstMb.value })
    }
  }
}

/** `whole`, but absent/null is a legal answer meaning "not reported". */
function optionalWhole(raw: unknown, field: string, max: number): Validated<number | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  return whole(raw, field, max)
}

/** `bucket`, but absent/null is a legal answer meaning "not reported". */
function optionalBucket(
  raw: unknown,
  field: string,
  edges: readonly number[]
): Validated<number | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  return bucket(raw, field, edges)
}

/**
 * The stutter trio, ALL THREE OR NONE — the same refusal the six-field group makes, for the same
 * reason: a p95 with no p50 beside it cannot say whether the whole distribution moved or only its
 * tail, and that distinction is the entire point of measuring a distribution instead of a max.
 */
function optionalStutter(raw: unknown): Validated<StartupStutterStats | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (!isTelemetryObject(raw)) return fail('startup.stutter', 'startup.stutter must be an object.')
  const p50 = bucket(raw.p50Bucket, 'startup.stutter.p50Bucket', STUTTER_MS_EDGES)
  if (!p50.ok) return p50
  const p95 = bucket(raw.p95Bucket, 'startup.stutter.p95Bucket', STUTTER_MS_EDGES)
  if (!p95.ok) return p95
  const latePct = whole(raw.latePct, 'startup.stutter.latePct', 100)
  if (!latePct.ok) return latePct
  return { ok: true, value: { p50Bucket: p50.value, p95Bucket: p95.value, latePct: latePct.value } }
}

/**
 * THE LIVE STALL READING (JOS-367), the third rider on these two events and the same deal as the
 * two above: absent and null both mean "nothing to report in this one".
 *
 * ALL SIX OR NONE, `coincident` excepted. Every number describes the SAME interval, and a p95
 * with no sample count under it is not a percentile of anything — the refusal `optionalStartup`
 * makes about its six, made here about these.
 *
 * `coincident` IS INDEPENDENTLY OPTIONAL because absent and zero are opposite facts: absent means
 * the probe worker was not running (no second clock, no verdict available), zero means two clocks
 * were compared and never went late together — which is the reading that says the fault is OURS.
 */
function optionalLive(o: Record<string, unknown>): Validated<LiveStallStats | undefined> {
  const raw = o.live
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (!isTelemetryObject(raw)) return fail('live', 'live must be an object.')
  const samples = whole(raw.samples, 'live.samples', MAX_COUNT)
  if (!samples.ok) return samples
  const p95 = bucket(raw.p95Bucket, 'live.p95Bucket', LIVE_STALL_MS_EDGES)
  if (!p95.ok) return p95
  const max = bucket(raw.maxBucket, 'live.maxBucket', LIVE_STALL_MS_EDGES)
  if (!max.ok) return max
  const over100 = whole(raw.over100, 'live.over100', MAX_COUNT)
  if (!over100.ok) return over100
  const over500 = whole(raw.over500, 'live.over500', MAX_COUNT)
  if (!over500.ok) return over500
  const coincident = optionalWhole(raw.coincident, 'live.coincident', MAX_COUNT)
  if (!coincident.ok) return coincident
  const value: LiveStallStats = {
    samples: samples.value,
    p95Bucket: p95.value,
    maxBucket: max.value,
    over100: over100.value,
    over500: over500.value
  }
  if (coincident.value !== undefined) value.coincident = coincident.value
  return { ok: true, value }
}

/**
 * WHAT THE LIVE TAIL'S READS COST (JOS-367). All eight or none, for the same reason: they are one
 * interval's account of one file, and a read count with no latency beside it describes nothing.
 *
 * The whole group is absent on a session with no character attached — which is a REAL state, not
 * a failure, and is why this is optional rather than zero-filled.
 */
function optionalTail(o: Record<string, unknown>): Validated<TailReadStats | undefined> {
  const raw = o.tail
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (!isTelemetryObject(raw)) return fail('tail', 'tail must be an object.')
  const reads = whole(raw.reads, 'tail.reads', MAX_COUNT)
  if (!reads.ok) return reads
  const reopens = whole(raw.reopens, 'tail.reopens', MAX_COUNT)
  if (!reopens.ok) return reopens
  const p95 = bucket(raw.p95Bucket, 'tail.p95Bucket', LIVE_STALL_MS_EDGES)
  if (!p95.ok) return p95
  const max = bucket(raw.maxBucket, 'tail.maxBucket', LIVE_STALL_MS_EDGES)
  if (!max.ok) return max
  const over100 = whole(raw.over100, 'tail.over100', MAX_COUNT)
  if (!over100.ok) return over100
  const over500 = whole(raw.over500, 'tail.over500', MAX_COUNT)
  if (!over500.ok) return over500
  return tailBytes(raw, { reads: reads.value, reopens: reopens.value, p95Bucket: p95.value, maxBucket: max.value, over100: over100.value, over500: over500.value })
}

/** The tail group's two SIZE buckets, split off so neither function is past the repo's factoring
 *  ceilings. Both are required members of the group — see `optionalTail`. */
function tailBytes(
  raw: Record<string, unknown>,
  base: Omit<TailReadStats, 'deltaBytesBucket' | 'logSizeBucket'>
): Validated<TailReadStats> {
  const delta = bucket(raw.deltaBytesBucket, 'tail.deltaBytesBucket', NEW_BYTES_EDGES)
  if (!delta.ok) return delta
  const size = bucket(raw.logSizeBucket, 'tail.logSizeBucket', LOG_SIZE_BYTES_EDGES)
  if (!size.ok) return size
  return { ok: true, value: { ...base, deltaBytesBucket: delta.value, logSizeBucket: size.value } }
}

/**
 * WHAT THE APP WAS DOING while the two groups above were measured (JOS-367). All six or none.
 *
 * `overlaysOpen` and `overlaysLocked` are counts of WINDOWS, so their ceiling is the number of
 * overlay kinds the schema knows — not `MAX_COUNT`. A number above it is not a busy install, it
 * is a client this server should not believe.
 */
function optionalState(o: Record<string, unknown>): Validated<SessionStateStats | undefined> {
  const raw = o.state
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (!isTelemetryObject(raw)) return fail('state', 'state must be an object.')
  const open = whole(raw.overlaysOpen, 'state.overlaysOpen', TELEMETRY_OVERLAY_KINDS.length)
  if (!open.ok) return open
  const locked = whole(raw.overlaysLocked, 'state.overlaysLocked', TELEMETRY_OVERLAY_KINDS.length)
  if (!locked.ok) return locked
  const presence = flag(raw.presenceOn, 'state.presenceOn')
  if (!presence.ok) return presence
  const ring = flag(raw.ringOn, 'state.ringOn')
  if (!ring.ok) return ring
  const freeMem = bucket(raw.freeMemBucket, 'state.freeMemBucket', FREE_MEM_GB_EDGES)
  if (!freeMem.ok) return freeMem
  const workingSet = bucket(raw.workingSetBucket, 'state.workingSetBucket', WORKING_SET_MB_EDGES)
  if (!workingSet.ok) return workingSet
  return {
    ok: true,
    value: {
      overlaysOpen: open.value,
      overlaysLocked: locked.value,
      presenceOn: presence.value,
      ringOn: ring.value,
      freeMemBucket: freeMem.value,
      workingSetBucket: workingSet.value
    }
  }
}

/**
 * WHAT V8 SPENT (JOS-458), the fourth rider. All five or none, for `optionalLive`'s reason: a
 * pause count with no worst pause beside it cannot say whether V8 collected often or collected
 * badly, and that distinction is the entire hypothesis.
 *
 * The whole group is absent when the observer was not running — a REAL state (an old client, a
 * platform that refused the hook), and why this is optional rather than zero-filled.
 */
function optionalGc(o: Record<string, unknown>): Validated<GcStallStats | undefined> {
  const raw = o.gc
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (!isTelemetryObject(raw)) return fail('gc', 'gc must be an object.')
  const pauses = whole(raw.pauses, 'gc.pauses', MAX_COUNT)
  if (!pauses.ok) return pauses
  const major = whole(raw.majorPauses, 'gc.majorPauses', MAX_COUNT)
  if (!major.ok) return major
  const max = bucket(raw.maxBucket, 'gc.maxBucket', LIVE_STALL_MS_EDGES)
  if (!max.ok) return max
  const total = bucket(raw.totalBucket, 'gc.totalBucket', LIVE_STALL_MS_EDGES)
  if (!total.ok) return total
  const over100 = whole(raw.over100, 'gc.over100', MAX_COUNT)
  if (!over100.ok) return over100
  return {
    ok: true,
    value: {
      pauses: pauses.value,
      majorPauses: major.value,
      maxBucket: max.value,
      totalBucket: total.value,
      over100: over100.value
    }
  }
}

/**
 * WHICH OF OUR SEAMS RAN (JOS-458), the fifth rider — and THE ONE PLACE ON THIS WIRE WHERE A KEY
 * CARRIES MEANING, which is why it is walked rather than read.
 *
 * The group is a partial record keyed by `PERF_SEAMS`. Every other object on this wire has a fixed
 * field list, so "construct field by field" is automatic; here the field list IS the enum, and a
 * validator that iterated the PAYLOAD's own keys would let a forged client write an arbitrary
 * string into the `usage_daily` dimension column. So the loop is over the compiled array and the
 * output is built from it: an unknown key is not rejected, it simply has no route across, which is
 * the same posture every other constructor here takes toward a field it does not name.
 *
 * A seam that IS named is all three or none, for the reason above: `calls` without `maxBucket` is
 * a frequency with no cost beside it.
 */
function optionalSeams(o: Record<string, unknown>): Validated<SeamStallStats | undefined> {
  const raw = o.seams
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (!isTelemetryObject(raw)) return fail('seams', 'seams must be an object.')
  const value: SeamStallStats = {}
  for (const seam of PERF_SEAMS) {
    const entry = raw[seam]
    if (entry === undefined || entry === null) continue
    const one = seamEntry(entry, seam)
    if (!one.ok) return one
    value[seam] = one.value
  }
  return { ok: true, value }
}

/** One named seam's three numbers, split off so `optionalSeams` stays inside the repo's factoring
 *  ceilings — the `tailBytes` precedent, for the same reason. */
function seamEntry(raw: unknown, seam: string): Validated<SeamStatsEntry> {
  if (!isTelemetryObject(raw)) return fail(`seams.${seam}`, `seams.${seam} must be an object.`)
  const calls = whole(raw.calls, `seams.${seam}.calls`, MAX_COUNT)
  if (!calls.ok) return calls
  const max = bucket(raw.maxBucket, `seams.${seam}.maxBucket`, LIVE_STALL_MS_EDGES)
  if (!max.ok) return max
  const over100 = whole(raw.over100, `seams.${seam}.over100`, MAX_COUNT)
  if (!over100.ok) return over100
  return { ok: true, value: { calls: calls.value, maxBucket: max.value, over100: over100.value } }
}

/**
 * The five riders, validated together and spread onto whichever session report carried them — one
 * helper so `vSessionHeartbeat` and `vSessionEnd` cannot drift apart, and so neither of them is
 * past the repo's complexity ceiling.
 *
 * Each group is INDEPENDENTLY optional: a client with no tail attached sends `live` and `state`
 * and no `tail`, and an older server that has never heard of any of them copies none of them
 * across and accepts the batch exactly as before (THE ADDITIVE-FIELD RULE).
 */
function liveRiders(
  o: Record<string, unknown>
): Validated<Pick<EvSessionHeartbeat, 'live' | 'tail' | 'state' | 'gc' | 'seams'>> {
  const live = optionalLive(o)
  if (!live.ok) return live
  const tail = optionalTail(o)
  if (!tail.ok) return tail
  const state = optionalState(o)
  if (!state.ok) return state
  const gc = optionalGc(o)
  if (!gc.ok) return gc
  const seams = optionalSeams(o)
  if (!seams.ok) return seams
  return {
    ok: true,
    value: {
      ...(live.value === undefined ? {} : { live: live.value }),
      ...(tail.value === undefined ? {} : { tail: tail.value }),
      ...(state.value === undefined ? {} : { state: state.value }),
      ...(gc.value === undefined ? {} : { gc: gc.value }),
      ...(seams.value === undefined ? {} : { seams: seams.value })
    }
  }
}

export function vSessionHeartbeat(o: Record<string, unknown>): Validated<TelemetryEvent> {
  const ms = whole(o.uptimeMs, 'uptimeMs', MAX_DURATION_MS)
  if (!ms.ok) return ms
  const lines = optionalLines(o)
  if (!lines.ok) return lines
  const startup = optionalStartup(o)
  if (!startup.ok) return startup
  const riders = liveRiders(o)
  if (!riders.ok) return riders
  const value: EvSessionHeartbeat = { t: 'sessionHeartbeat', uptimeMs: ms.value, ...riders.value }
  if (lines.value !== undefined) value.linesParsed = lines.value
  if (startup.value !== undefined) value.startup = startup.value
  return { ok: true, value }
}

export function vSessionEnd(o: Record<string, unknown>): Validated<TelemetryEvent> {
  const ms = whole(o.durationMs, 'durationMs', MAX_DURATION_MS)
  if (!ms.ok) return ms
  const views = whole(o.viewsVisited, 'viewsVisited', TELEMETRY_VIEWS.length)
  if (!views.ok) return views
  const lines = optionalLines(o)
  if (!lines.ok) return lines
  const startup = optionalStartup(o)
  if (!startup.ok) return startup
  const riders = liveRiders(o)
  if (!riders.ok) return riders
  const value: EvSessionEnd = {
    t: 'sessionEnd',
    durationMs: ms.value,
    viewsVisited: views.value,
    ...riders.value
  }
  if (lines.value !== undefined) value.linesParsed = lines.value
  if (startup.value !== undefined) value.startup = startup.value
  return { ok: true, value }
}
