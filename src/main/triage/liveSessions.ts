// ============================================================================
// liveSessions.ts — "is anyone in the app right now", read from CloudWatch.
// ============================================================================
//
// THE COUNTER TABLES CANNOT ANSWER THIS, and no amount of arithmetic over them will: `usage_daily`
// is keyed on a DAY, and "right now" is not a day. The only live signal this platform has is the
// EMF metric the ingest Lambda emits per accepted batch — `EQCompanion/Telemetry · Heartbeats`,
// dimension `Channel=prod` — where one heartbeat is one open session per five minutes. The Sum
// over a 300-second period therefore IS the number of sessions that were alive in that period,
// which is exactly the number the owner wanted at a glance.
//
// IT SITS BESIDE `buildAnalytics`, NEVER INSIDE IT (the `ghDownloads.ts` precedent, same
// reasoning): that function is pure over three arrays of counter rows and stays testable without
// a socket. This module is called in parallel with the database read and merged at the
// presentation edges — `ipc.ts` for the tab, `triageAnalytics.mts` for the digest.
//
// FAILURE IS SOFT, ALWAYS. No credentials, no stack cache, a throttled API, a region that does
// not answer: every one of them is `available:false` with a reason the caller prints in place of
// the number. A dark CloudWatch may not take down a readout that is otherwise about a database.
//
// THE DERIVATION IS SEPARATE AND PURE (`deriveLiveSessions`), so `tests/liveSessions.test.mts`
// drives every shape of fleet — nobody, a steady fleet, a fleet that just arrived, one that has
// been up longer than the window — against authored buckets and no AWS at all.

import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch'
import { fromIni } from '@aws-sdk/credential-providers'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TRIAGE_DIR } from './store'
import type { TriageLiveSessions } from '../../shared/triage'

/**
 * The region, from the CACHED terraform outputs — never `loadStack()`, which shells out to
 * `terraform output` when the cache is cold. That is right for a CLI the owner is watching and
 * wrong for a read that has to answer a UI without blocking on a child process, so a cold cache
 * is an ordinary unavailable reason here rather than a several-second stall.
 */
function cachedRegion(): string | null {
  const file = join(TRIAGE_DIR, 'stack.json')
  if (!existsSync(file)) return null
  try {
    const region: unknown = (JSON.parse(readFileSync(file, 'utf8')) as { region?: unknown }).region
    return typeof region === 'string' && region.length > 0 ? region : null
  } catch {
    return null
  }
}

/** The EMF namespace + metric the ingest Lambda writes (infra/lambda/telemetry.ts emitMetrics). */
export const LIVE_NAMESPACE = 'EQCompanion/Telemetry'
export const LIVE_METRIC = 'Heartbeats'
/** Installed builds only. The dev channel is the author's own machine and is not a fleet. */
export const LIVE_CHANNEL = 'prod'

/** One heartbeat per open session per five minutes — the period IS the cadence (flush.ts). */
export const BUCKET_MS = 5 * 60 * 1000
/**
 * How far back the age derivation can see: 12 hours, i.e. 144 buckets.
 *
 * Long enough that a typical evening's session is measured rather than truncated, short enough
 * that it is one small API call. A session older than this is reported as being exactly this old
 * — `ageIsFloor` says so, and the label says `est.`.
 */
export const LOOKBACK_MS = 12 * 60 * 60 * 1000
/** CloudWatch must not add its latency to a screen that is otherwise about a database. */
const TIMEOUT_MS = 5_000

/**
 * BUCKETS, DENSE AND ASCENDING, ending with the last COMPLETE one.
 *
 * Density is not cosmetic: CloudWatch omits a period entirely when nothing was published in it,
 * and the age derivation reads a gap as "no session was alive then", which is exactly what an
 * omitted period means. Reading the sparse list as if it were consecutive would silently splice
 * a quiet hour out of the timeline and inflate every age.
 */
export function denseBuckets(
  points: readonly { at: number; sum: number }[],
  endMs: number,
  lookbackMs = LOOKBACK_MS,
  bucketMs = BUCKET_MS
): number[] {
  const count = Math.max(1, Math.floor(lookbackMs / bucketMs))
  const first = endMs - count * bucketMs
  const out = new Array<number>(count).fill(0)
  for (const p of points) {
    const i = Math.floor((p.at - first) / bucketMs)
    if (i >= 0 && i < count && Number.isFinite(p.sum) && p.sum > 0) out[i] += p.sum
  }
  return out
}

/**
 * THE WHOLE READ-TIME MODEL, as a pure function over dense bucket sums (oldest first, the last
 * entry being the most recent COMPLETE bucket).
 *
 * ACTIVE NOW is the last bucket's sum, full stop — one heartbeat per session per bucket.
 *
 * THE AGE IS AN ESTIMATE, and here is the whole of it. Nothing knows when an individual session
 * started; what the buckets say is how many sessions were alive in each. A session is continuous,
 * so one that is alive now and was alive j buckets ago was alive in every bucket between — which
 * makes the count of now-sessions at least j buckets old at most the SMALLEST bucket in that span,
 * and exactly that if no session ends and is replaced inside one bucket. Summing that bound over j
 * is the mean age in buckets (the survival-function identity: E[age] = Σ P(age ≥ j)).
 *
 * WHAT MAKES IT HONEST RATHER THAN A GUESS is what it does at the edges:
 *   * it is a FLOOR, never an over-claim — `min` cannot count a session that is not there, and a
 *     fleet that churns within a bucket reads as YOUNGER than it is, not older;
 *   * a window that is fully occupied back to its oldest bucket sets `ageIsFloor`, because the
 *     sessions may be older than anything this read can see;
 *   * with nobody alive the age is NULL, not zero: an empty fleet has no age, and a 0 there would
 *     read as "everyone just arrived".
 * The label carries one word — `est.` — and the caveat diet is why it carries no more than that.
 */
export function deriveLiveSessions(
  buckets: readonly number[],
  asOfMs: number,
  bucketMs = BUCKET_MS
): TriageLiveSessions {
  const lookbackMs = buckets.length * bucketMs
  const activeNow = buckets.length > 0 ? Math.max(0, Math.round(buckets[buckets.length - 1])) : 0
  if (activeNow === 0) {
    return { available: true, activeNow: 0, asOfMs, avgAgeMs: null, ageIsFloor: false, lookbackMs }
  }
  // A RUNNING MINIMUM, not a per-bucket one, because a session is a process lifetime and is
  // therefore CONTINUOUS: to be alive now and also j buckets ago it had to be alive in every
  // bucket in between. So the count of now-sessions at least j buckets old is bounded by the
  // smallest bucket in that whole span — which is also what makes a GAP in the metric behave
  // correctly (nothing can be older than a period in which nobody was alive) rather than letting
  // an old, unrelated crowd on the far side of the gap age today's fleet.
  let survivors = 0
  let reach = activeNow
  for (let j = 1; j < buckets.length; j++) {
    reach = Math.min(reach, Math.max(0, buckets[buckets.length - 1 - j]))
    if (reach === 0) break
    survivors += reach
  }
  return {
    available: true,
    activeNow,
    asOfMs,
    avgAgeMs: Math.round((survivors / activeNow) * bucketMs),
    // The span reached the OLDEST bucket we can see and was still occupied ⇒ the sum was cut off
    // rather than finished, so the mean is a floor: these sessions may have started before
    // anything this read can see.
    ageIsFloor: buckets.length > 1 && reach > 0,
    lookbackMs
  }
}

export interface LiveSessionsOptions {
  /** The AWS profile the owner's shell signs with (`backend.ts TRIAGE_PROFILE`, or `--profile`). */
  profile?: string
  /** Defaults to the region in the cached terraform outputs. */
  region?: string
  nowMs?: number
}

/**
 * The last COMPLETE bucket's end. A period containing `now` is still filling — and heartbeats
 * arrive through a 60-second flush loop, so even a just-closed one is a little under-reported —
 * which is precisely why "active now" is defined as the last FULL bucket and not as the newest
 * datapoint CloudWatch will hand over.
 */
export function lastCompleteBucketEnd(nowMs: number, bucketMs = BUCKET_MS): number {
  return Math.floor(nowMs / bucketMs) * bucketMs
}

/** The one call. Never throws: every outcome is an `available` union member. */
export async function fetchLiveSessions(
  options: LiveSessionsOptions = {}
): Promise<TriageLiveSessions> {
  const nowMs = options.nowMs ?? Date.now()
  const region = options.region ?? cachedRegion()
  if (region === null || region === undefined) {
    return {
      available: false,
      reason: 'no cached terraform outputs - run any triage command once to write .triage/stack.json'
    }
  }
  const endMs = lastCompleteBucketEnd(nowMs)
  const client = new CloudWatchClient({
    region,
    maxAttempts: 2,
    requestHandler: { requestTimeout: TIMEOUT_MS },
    ...(options.profile ? { credentials: fromIni({ profile: options.profile }) } : {})
  })
  try {
    const res = await client.send(
      new GetMetricStatisticsCommand({
        Namespace: LIVE_NAMESPACE,
        MetricName: LIVE_METRIC,
        Dimensions: [{ Name: 'Channel', Value: LIVE_CHANNEL }],
        StartTime: new Date(endMs - LOOKBACK_MS),
        EndTime: new Date(endMs),
        Period: BUCKET_MS / 1000,
        Statistics: ['Sum']
      })
    )
    const points = (res.Datapoints ?? []).map((d) => ({
      at: d.Timestamp?.getTime() ?? 0,
      sum: d.Sum ?? 0
    }))
    return deriveLiveSessions(denseBuckets(points, endMs), endMs)
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) }
  } finally {
    client.destroy()
  }
}
