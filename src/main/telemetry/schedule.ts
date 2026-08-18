// telemetry/schedule.ts — WHEN the telemetry loop fires, as pure arithmetic over a nominal grid.
//
// THE PROBLEM THIS SOLVES (JOS-395). Every client started its timers with a plain `setInterval` at
// launch, so a fleet that restarts together — which is exactly what an updater rollout does — stays
// SYNCHRONIZED for as long as the machines stay up. Ten thousand installs then hit API Gateway, the
// ingest Lambda and the same handful of DSQL rows in the same second, every five minutes, forever.
// That is a self-inflicted thundering herd: the load is not the fleet's size, it is the fleet's
// PHASE. Spreading the same number of requests over the interval costs nothing and removes it.
//
// THE CADENCE IS NOT NEGOTIABLE, and that is the whole shape of this module (owner ruling
// 2026-08-16). 10 min / 5 min stay: `triage/liveSessions.ts` reads one heartbeat per session per
// 10-minute CloudWatch bucket, the Live-now tile says "sessions in the last 10 min" in words, and
// the release smoke dwells on that number. So what moves is the PHASE (where in the interval a
// given install sits) and the per-tick WOBBLE (±5% around each grid point) — never the average
// spacing, which stays exactly 5 min / 10 min because every fire time is computed from a NOMINAL
// GRID rather than from the previous actual fire.
//
//   grid:   phase          phase+5m        phase+10m       phase+15m       phase+20m
//   fires:    |·              ·|              |·              ·|             |·
//             ^ tick 0        ^ tick 1        ^ tick 2        ^ tick 3       ^ tick 4
//             flush           flush           flush           flush          flush
//                                             HEARTBEAT                      HEARTBEAT
//
// WHY DRIFT CORRECTION IS THE POINT AND NOT A DETAIL. Jitter added to the LAST ACTUAL FIRE is a
// random walk: 5% low, five hundred times, is a client whose "10 minute" heartbeat has quietly
// become an 8-minute one and whose contribution to the live-sessions bucket is 25% too high. Anchor
// each fire to `phase + k * interval` and the wobble cannot accumulate — tick 500 is within ±15 s
// of where an unjittered client would have put it, forever. `tests/telemetrySchedule.test.mts`
// pins that contrast directly, because it is the difference between a jitter that is free and a
// jitter that silently rewrites the measurement.
//
// AND WHY THE HEARTBEAT IS AN INDEX ON THE SAME GRID rather than a second jittered timer: the
// coincidence invariant (`flush.ts`) says a heartbeat tick IS a flush tick, so the pulse rides out
// on the timer turn that recorded it instead of waiting five minutes for the next one. Two
// independently jittered timers would land ±15 s apart and could fire in either order — the flush
// first half the time, which is precisely the five-minute wait the invariant exists to prevent.
// One grid, one loop, `HEARTBEAT_TICKS` apart: coincidence becomes structural rather than lucky.
//
// NOTHING HERE IS PERSISTED. The phase is minted per launch and forgotten; a client that restarts
// gets a new one, which is the behaviour the herd argument wants (a fleet that restarted together
// must not come back together). This module therefore imports NOTHING — no Electron, no store, no
// clock — so `tests/telemetrySchedule.test.mts` drives the real production arithmetic with a seeded
// `rand` and a virtual clock, and `flush.ts` supplies the only two impure things: `Date.now()` and
// `Math.random`.

/** A source of uniform randomness in [0, 1). Injectable so every decision below is pinnable. */
export type Rand = () => number

/** Batch cadence. Counts, not click streams — 5 min (JOS-269; the plan's T5 number was 60 s, and
 *  the `flush.ts` header says why one request in five minutes buys the same numbers for a fifth of
 *  the bill). It is the GRID SPACING here: every tick, jittered or not, is a multiple of it. */
export const FLUSH_INTERVAL_MS = 5 * 60 * 1000

/** Session heartbeat cadence: the "is anyone using it right now" pulse, 10 min (JOS-269; T5 said
 *  5). A MULTIPLE OF THE FLUSH ON PURPOSE — see `HEARTBEAT_TICKS`. */
export const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000

/**
 * THE COINCIDENCE INVARIANT, as a number: how many flush ticks make one heartbeat.
 *
 * It must be a whole number, and `tests/telemetrySchedule.test.mts` asserts that it is. The day
 * someone picks two cadences that are not multiples, this constant goes fractional and every
 * heartbeat starts landing between flush ticks — which is the failure the invariant is written to
 * make impossible rather than merely unlikely.
 */
export const HEARTBEAT_TICKS = HEARTBEAT_INTERVAL_MS / FLUSH_INTERVAL_MS

/** Per-tick wobble around the nominal grid point: ±5% of the flush interval, i.e. ±15 s. Small
 *  enough that no window this feeds can tell, large enough that a fleet's fires stop being one
 *  spike — the SPREAD that matters is the phase, and this only breaks up what is left of it. */
export const TICK_JITTER_FRACTION = 0.05

/** First retry after a "not now" upload, doubling per consecutive failure. Full-jitter (below),
 *  so this is a CEILING on the wait rather than the wait itself. */
export const RETRY_BASE_MS = 30 * 1000

/** A timer is never armed for zero: a delay that rounds to nothing spins the loop. */
const MIN_DELAY_MS = 1

/**
 * Where this launch sits inside the interval, and which tick is armed.
 *
 * `phaseMs` is milliseconds after the loop's origin at which tick 0 nominally fires; tick k
 * nominally fires at `phaseMs + k * FLUSH_INTERVAL_MS`. Both are plain data so the whole schedule
 * can be replayed in a test without a clock.
 */
export interface TickSchedule {
  readonly phaseMs: number
  readonly k: number
}

/**
 * Mint this launch's phase: ONE draw, uniform in [0, FLUSH_INTERVAL_MS), and the only randomness
 * that is not per-tick. This is the number that de-synchronizes the fleet — the ±5% wobble below
 * could not do it on its own, because ±15 s of spread on a ten-thousand-install spike is still a
 * spike.
 */
export function beginSchedule(rand: Rand = Math.random): TickSchedule {
  return { phaseMs: Math.floor(rand() * FLUSH_INTERVAL_MS), k: 0 }
}

/** Where tick `k` nominally belongs, in ms after the loop's origin. The grid, and the only thing
 *  any delay below is measured against. */
export function nominalMs(s: TickSchedule, k: number = s.k): number {
  return s.phaseMs + k * FLUSH_INTERVAL_MS
}

/** Is this grid index a heartbeat? Every index is a flush, so this is the whole invariant: a
 *  heartbeat tick is by construction a flush tick, and tick 0 is not one (the first heartbeat is a
 *  full `HEARTBEAT_INTERVAL_MS` after the phase, exactly as it was before jitter existed). */
export function isHeartbeatTick(k: number): boolean {
  return k > 0 && k % HEARTBEAT_TICKS === 0
}

/** The wobble for one tick: uniform in [-TICK_JITTER_FRACTION, +TICK_JITTER_FRACTION] × interval. */
function wobbleMs(rand: Rand): number {
  return (rand() * 2 - 1) * TICK_JITTER_FRACTION * FLUSH_INTERVAL_MS
}

/**
 * How long to wait, from `elapsedMs` after the origin, for the armed tick.
 *
 * COMPUTED FROM THE GRID, NEVER FROM THE LAST FIRE — that subtraction is the drift correction the
 * header argues for, and it is the reason the average cadence stays exactly 5 / 10 min however the
 * wobble falls.
 *
 * TICK 0 CARRIES NO WOBBLE, deliberately: its offset from the origin IS the phase draw, already
 * uniform over the whole interval, and adding ±5% to a uniform number over the same interval only
 * lets the first flush land before the origin (clamped) or past the interval (off the grid).
 */
export function armDelayMs(s: TickSchedule, elapsedMs: number, rand: Rand = Math.random): number {
  const target = nominalMs(s) + (s.k === 0 ? 0 : wobbleMs(rand))
  return Math.max(MIN_DELAY_MS, Math.round(target - elapsedMs))
}

/**
 * Arm the next tick, having just fired the current one at `elapsedMs`.
 *
 * NORMALLY `k + 1`. The `Math.max` is the SUSPENDED-MACHINE arm: a laptop that slept for an hour
 * wakes with twelve grid points already in the past, and stepping one index at a time would fire
 * all twelve back to back — twelve heartbeats claiming twelve live sessions, and twelve uploads in
 * one second, from a machine that was doing nothing. Skipping to the first FUTURE grid point drops
 * the missed ticks instead, which is honest: nothing happened while the machine was asleep.
 *
 * The skip cannot break the coincidence invariant, and that is why `isHeartbeatTick` reads the
 * GRID INDEX rather than a count of fires: whichever indices are skipped, the ones that do fire are
 * still every-other-index apart on the same grid.
 */
export function advance(s: TickSchedule, elapsedMs: number): TickSchedule {
  const due = Math.ceil((elapsedMs - s.phaseMs) / FLUSH_INTERVAL_MS)
  return { phaseMs: s.phaseMs, k: Math.max(s.k + 1, due) }
}

/**
 * How long to wait before retrying an upload that got a "not now" (offline, 429 daily cap, 503
 * kill switch).
 *
 * FULL JITTER, not "backoff plus a bit": the wait is uniform in [0, ceiling), which is the form
 * that actually decorrelates a herd — every client waiting `2^n × base` retries in lockstep with
 * every other client that failed in the same second, which is the same herd this whole module
 * exists to break, arriving by a different road.
 *
 * THE CEILING IS THE NEXT NOMINAL TICK, so a retry can never outlive the tick that would have done
 * the same work anyway. That is also the give-up rule, unchanged: nothing is dropped and nothing is
 * abandoned — the buffer keeps its records (`flush.ts` `retireBatch`) and the next grid tick tries
 * again, exactly as it did when the next identical boundary was the only retry there was.
 */
export function retryDelayMs(attempt: number, msToNextTick: number, rand: Rand = Math.random): number {
  const backoff = RETRY_BASE_MS * 2 ** Math.max(0, Math.floor(attempt))
  const ceiling = Math.min(backoff, Math.max(0, msToNextTick))
  return Math.floor(rand() * ceiling)
}
