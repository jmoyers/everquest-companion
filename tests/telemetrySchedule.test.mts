// ============================================================================
// telemetrySchedule.test.mts — JOS-395: the telemetry loop's PHASE and WOBBLE.
// ============================================================================
//
// THE BUG THIS SUITE GUARDS IS A FLEET-SHAPED ONE. Every client armed a plain `setInterval` at
// launch, so a fleet that restarts together — which is what an updater rollout is — hammered API
// Gateway, the ingest Lambda and the same DSQL rows in the same second, five minutes apart,
// indefinitely. The fix is a per-launch phase plus a small per-tick wobble; the DANGER of the fix
// is that a careless jitter quietly rewrites the measurement, because the heartbeat cadence IS the
// live-sessions window (`triage/liveSessions.ts` reads one pulse per session per 10-minute
// CloudWatch bucket, and the tile says "in the last 10 min" in words).
//
// So four properties, and each is a way the fix could have gone wrong:
//
//   1. THE PHASE SPREADS A FLEET. One draw per launch, uniform over the whole flush interval —
//      the wobble is ±15 s and could never de-synchronize ten thousand installs on its own.
//   2. THE COINCIDENCE INVARIANT SURVIVES. A heartbeat tick is still a flush tick, so the pulse
//      leaves on the turn that recorded it. Under two independently jittered timers this would
//      have become a coin flip; it is now structural, and both halves of that are pinned — the
//      arithmetic here, and the call ORDER inside `flush.ts` by source.
//   3. THE AVERAGE CADENCE IS UNCHANGED. Every fire is computed from the nominal grid, never from
//      the last actual fire, so the wobble cannot accumulate. The contrast test below runs the
//      naive version beside the real one and measures how far it walks: 500 ticks of a
//      consistently-low wobble puts it TWO HOURS ahead of schedule.
//   4. THE RETRY DOES NOT RE-FORM THE HERD. A fleet that all got 429 in one second must not all
//      come back in one second — so the backoff is FULL jitter (uniform in [0, ceiling)), and its
//      ceiling is clamped to the next nominal tick so it can never outlive the tick that would
//      have done the same work.
//
// `src/main/telemetry/schedule.ts` imports NOTHING, which is what lets this file drive the real
// production arithmetic — seeded `rand`, virtual clock, no Electron, no fixtures, no mocks. The
// loop that consumes it lives in `flush.ts`, which imports the store and therefore Electron, so
// the handful of properties that live in the WIRING rather than the maths are asserted the way
// `telemetryNet.test.mts` and `healthCounters.test.mts` assert theirs: by reading the source.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  advance,
  armDelayMs,
  beginSchedule,
  FLUSH_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TICKS,
  isHeartbeatTick,
  nominalMs,
  type Rand,
  RETRY_BASE_MS,
  retryDelayMs,
  TICK_JITTER_FRACTION,
  type TickSchedule
} from '../src/main/telemetry/schedule'

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

/** A seeded uniform source (mulberry32). Deterministic, so a failure here is reproducible rather
 *  than "it went red once on a Tuesday" — a flaky randomness test is worse than none. */
function seeded(seed: number): Rand {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fire times of the first `ticks` ticks, replaying EXACTLY what `flush.ts` `onTick` does:
 *  arm from the grid → fire → heartbeat if this index is one → advance. */
function simulate(ticks: number, rand: Rand): { fires: number[]; beats: number[]; grid: number[] } {
  let s: TickSchedule = beginSchedule(rand)
  let elapsed = 0
  const fires: number[] = []
  const beats: number[] = []
  const grid: number[] = []
  for (let i = 0; i < ticks; i++) {
    grid.push(nominalMs(s))
    elapsed += armDelayMs(s, elapsed, rand)
    fires.push(elapsed)
    if (isHeartbeatTick(s.k)) beats.push(elapsed)
    s = advance(s, elapsed)
  }
  return { fires, beats, grid }
}

// ---- 1. the phase: what actually spreads a fleet ---------------------------------------------

test('the phase is ONE draw per launch, uniform across the whole flush interval', () => {
  // The acceptance criterion in words: "first flush lands at a random phase within the interval".
  assert.equal(beginSchedule(() => 0).phaseMs, 0)
  assert.equal(beginSchedule(() => 0.5).phaseMs, FLUSH_INTERVAL_MS / 2)
  // Uniform in [0, interval) — the top of the range is EXCLUSIVE, so a phase can never land on the
  // next grid point and turn the first flush into a five-minute wait plus one.
  assert.ok(beginSchedule(() => 0.999999).phaseMs < FLUSH_INTERVAL_MS)
})

test('a thousand launches land all over the interval — the property the herd argument needs', () => {
  const rand = seeded(20260816)
  const phases = Array.from({ length: 1000 }, () => beginSchedule(rand).phaseMs)
  for (const p of phases) assert.ok(p >= 0 && p < FLUSH_INTERVAL_MS, `phase out of range: ${p}`)
  // A wobble of ±15 s could not do this: the spread has to be the INTERVAL, or ten thousand
  // installs that rebooted together are still one spike with softer edges.
  assert.ok(Math.min(...phases) < 15_000, 'no launch near the start of the interval')
  assert.ok(Math.max(...phases) > FLUSH_INTERVAL_MS - 15_000, 'no launch near the end')
  const mean = phases.reduce((a, b) => a + b, 0) / phases.length
  assert.ok(Math.abs(mean - FLUSH_INTERVAL_MS / 2) < FLUSH_INTERVAL_MS * 0.05, `mean phase ${mean}`)
})

test('TICK 0 IS THE PHASE AND NOTHING ELSE — no wobble on top of a uniform draw', () => {
  const s = beginSchedule(() => 0.4)
  // The `rand` handed to `armDelayMs` is deliberately one that would blow the delay wide open if
  // tick 0 took a wobble; it is ignored, and the first fire is exactly the phase.
  assert.equal(armDelayMs(s, 0, () => 1), s.phaseMs)
  assert.equal(s.phaseMs, Math.floor(0.4 * FLUSH_INTERVAL_MS))
})

test('nothing is persisted: the schedule module imports nothing and reads no store', () => {
  // "Persist nothing" is the ticket's own word, and it is load-bearing — a phase written to disk
  // would survive the reboot that made the fleet synchronous in the first place. The strongest
  // available pin is that the module has no way to write anything: no imports at all.
  const src = read('src/main/telemetry/schedule.ts')
  assert.equal(src.match(/^import .*$/gm), null, 'schedule.ts must import nothing')
  // …and no back door around the import list, either.
  for (const word of ['require(', 'writeFile', 'globalThis', 'process.']) {
    assert.ok(!src.includes(word), `schedule.ts must not reach for ${word}`)
  }
  // The phase is minted from `rand` alone and lives in a returned value — nothing in the loop that
  // consumes it writes it down.
  const flush = read('src/main/telemetry/flush.ts')
  assert.ok(!/phaseMs/.test(flush), 'flush.ts must not handle the phase, let alone store it')
})

// ---- 2. the coincidence invariant -------------------------------------------------------------

test('the heartbeat is a WHOLE NUMBER of flush ticks — the invariant as arithmetic', () => {
  assert.equal(HEARTBEAT_INTERVAL_MS % FLUSH_INTERVAL_MS, 0)
  assert.ok(Number.isInteger(HEARTBEAT_TICKS) && HEARTBEAT_TICKS >= 2)
  // The day someone picks cadences that are not multiples, this constant goes fractional and every
  // heartbeat starts landing BETWEEN flush ticks. That is the failure this line exists to catch.
  assert.equal(HEARTBEAT_TICKS, HEARTBEAT_INTERVAL_MS / FLUSH_INTERVAL_MS)
})

test('EVERY HEARTBEAT IS A FLUSH TICK, and it is every k-th grid index — never a second timer', () => {
  const { fires, beats } = simulate(40, seeded(7))
  const fired = new Set(fires)
  assert.ok(beats.length > 0)
  for (const b of beats) assert.ok(fired.has(b), `heartbeat at ${b} was not a flush tick`)
  // …and tick 0 is NOT one: the first pulse is a full heartbeat interval after the phase, exactly
  // as it was before jitter existed.
  assert.equal(isHeartbeatTick(0), false)
  for (let k = 1; k < 40; k++) assert.equal(isHeartbeatTick(k), k % HEARTBEAT_TICKS === 0)
})

test('THE WIRING: one loop, and the heartbeat is recorded BEFORE the tick flushes', () => {
  // A SOURCE PIN, in the style of healthCounters.test.mts: `flush.ts` imports the store and so
  // Electron, and cannot be driven from here — but the ORDER inside `onTick` is half the invariant
  // (a flush that ran first would read a ring without the pulse in it and the pulse would wait a
  // full interval), so the order is asserted where it lives.
  const flush = read('src/main/telemetry/flush.ts')
  const tick = flush.slice(flush.indexOf('function onTick'), flush.indexOf('function recordHeartbeat'))
  assert.ok(tick.indexOf('isHeartbeatTick(s.k)') < tick.indexOf('void runFlush(0)'), 'flush ran first')
  assert.ok(tick.includes('recordHeartbeat()'))
  // ONE timer, chained — an interval cannot be re-timed per tick, so a surviving `setInterval` here
  // would mean the jitter is not actually being applied.
  assert.ok(!flush.includes('setInterval('), 'the loop must be a chained setTimeout, not an interval')
  // Neither handle may hold the process open.
  assert.ok(flush.includes('tick.unref()') && flush.includes('retry.unref()'))
  // The loop drives the real schedule rather than a second copy of the arithmetic.
  for (const seam of ['beginSchedule()', 'armDelayMs(sched, elapsed())', 'advance(s, elapsed())']) {
    assert.ok(flush.includes(seam), `flush.ts must use ${seam}`)
  }
})

// ---- 3. drift correction: the cadence does not move -------------------------------------------

test('every fire sits within ±5% of ITS OWN grid point, however the wobble falls', () => {
  const { fires, grid } = simulate(500, seeded(99))
  const bound = FLUSH_INTERVAL_MS * TICK_JITTER_FRACTION + 1
  for (let k = 0; k < fires.length; k++) {
    assert.ok(Math.abs(fires[k] - grid[k]) <= bound, `tick ${k}: ${fires[k]} vs grid ${grid[k]}`)
  }
  // The grid itself is exact — this is what "average cadence unchanged" means at the source.
  for (let k = 1; k < grid.length; k++) assert.equal(grid[k] - grid[k - 1], FLUSH_INTERVAL_MS)
})

test('AND THE NAIVE VERSION WALKS AWAY: grid-anchored vs last-fire-anchored, 500 ticks', () => {
  // The measurement that makes this the load-bearing half of the feature. A wobble added to the
  // LAST ACTUAL FIRE is a random walk; a run that leans low leans low forever.
  const low: Rand = () => 0 // every wobble at its floor: -5%
  const { fires } = simulate(500, low)
  const nominal500 = fires[0] + 499 * FLUSH_INTERVAL_MS
  assert.ok(Math.abs(fires[499] - nominal500) <= FLUSH_INTERVAL_MS * TICK_JITTER_FRACTION + 1)

  // The same 500 ticks scheduled from the previous fire instead of from the grid:
  let naive = fires[0]
  for (let k = 1; k < 500; k++) naive += FLUSH_INTERVAL_MS * (1 - TICK_JITTER_FRACTION)
  const walk = nominal500 - naive
  assert.ok(walk > 2 * 60 * 60 * 1000, `naive drift was only ${walk} ms`)
  // Two hours early on a ten-minute pulse is a client contributing ~5% too many heartbeats to
  // every live-sessions bucket — a jitter that silently rewrote the number it was told not to.
})

test('the average cadence is EXACTLY 5 min / 10 min across a long session', () => {
  const { fires, beats } = simulate(500, seeded(4242))
  const flushMean = (fires[499] - fires[0]) / 499
  assert.ok(Math.abs(flushMean - FLUSH_INTERVAL_MS) < 100, `flush mean ${flushMean}`)
  const beatMean = (beats[beats.length - 1] - beats[0]) / (beats.length - 1)
  assert.ok(Math.abs(beatMean - HEARTBEAT_INTERVAL_MS) < 100, `heartbeat mean ${beatMean}`)
  // No consecutive gap is anywhere near big enough to drop a live-sessions bucket, either.
  for (let k = 1; k < beats.length; k++) {
    const gap = beats[k] - beats[k - 1]
    assert.ok(Math.abs(gap - HEARTBEAT_INTERVAL_MS) <= FLUSH_INTERVAL_MS * TICK_JITTER_FRACTION * 2 + 2)
  }
})

test('a suspended machine SKIPS the grid points it slept through, and keeps the parity', () => {
  // A laptop that slept an hour wakes with twelve grid points in the past. Stepping one index at a
  // time would fire all twelve back to back: twelve heartbeats claiming twelve live sessions, and
  // twelve uploads in one second, from a machine that was doing nothing.
  const s = beginSchedule(() => 0.5)
  const slept = advance(s, s.phaseMs + 60 * 60 * 1000)
  assert.equal(slept.k, 12, 'the first FUTURE grid point, not the next index')
  assert.ok(nominalMs(slept) > s.phaseMs + 60 * 60 * 1000 - FLUSH_INTERVAL_MS)
  // The invariant reads the GRID INDEX, so whichever indices are skipped the survivors are still
  // every HEARTBEAT_TICKS-th one. A count of fires would have lost that.
  assert.equal(isHeartbeatTick(slept.k), 12 % HEARTBEAT_TICKS === 0)
  // An ordinary tick is still just the next index.
  assert.equal(advance(s, s.phaseMs).k, 1)
})

// ---- 4. the retry --------------------------------------------------------------------------

const FAR = 60 * 60 * 1000 // a "next tick" far enough away that the ceiling is the backoff itself

test('the backoff is FULL jitter — uniform in [0, ceiling), not a fixed doubling wait', () => {
  // Fixed `2^n × base` is the herd arriving by a different road: every client that failed in the
  // same second retries in the same second. Full jitter is the only shape that decorrelates.
  assert.equal(retryDelayMs(0, FAR, () => 0), 0, 'a full-jitter wait may be immediate')
  const top = retryDelayMs(0, FAR, () => 0.999999)
  assert.ok(top < RETRY_BASE_MS && top > RETRY_BASE_MS * 0.99, `top of the first window: ${top}`)
  const rand = seeded(31337)
  const draws = Array.from({ length: 2000 }, () => retryDelayMs(0, FAR, rand))
  for (const d of draws) assert.ok(d >= 0 && d < RETRY_BASE_MS, `draw out of window: ${d}`)
  const mean = draws.reduce((a, b) => a + b, 0) / draws.length
  // ~half the window is the signature of full jitter; a fixed backoff would sit at the top of it.
  assert.ok(Math.abs(mean - RETRY_BASE_MS / 2) < RETRY_BASE_MS * 0.05, `mean wait ${mean}`)
})

test('the ceiling doubles from 30 s per consecutive failure', () => {
  const nearlyOne = (): number => 0.999999
  for (let attempt = 0; attempt < 6; attempt++) {
    const d = retryDelayMs(attempt, FAR, nearlyOne)
    const ceiling = RETRY_BASE_MS * 2 ** attempt
    assert.ok(d < ceiling && d > ceiling * 0.99, `attempt ${attempt}: ${d} vs ceiling ${ceiling}`)
  }
})

test('A RETRY CAN NEVER OUTLIVE THE NEXT NOMINAL TICK — the ceiling is clamped to it', () => {
  // The give-up rule is unchanged and needs no counter: the chain ends by arithmetic, and the next
  // grid tick tries again with the buffer it always kept.
  const toNext = 42_000
  for (let attempt = 0; attempt < 20; attempt++) {
    const d = retryDelayMs(attempt, toNext, () => 0.999999)
    assert.ok(d < toNext, `attempt ${attempt} would have landed past the tick: ${d}`)
  }
  // Once the tick has arrived (or passed) there is nothing left to schedule.
  assert.equal(retryDelayMs(3, 0, () => 0.9), 0)
  assert.equal(retryDelayMs(3, -5_000, () => 0.9), 0)
  // A negative/absurd attempt count cannot widen the window either.
  assert.ok(retryDelayMs(-4, FAR, () => 0.999999) < RETRY_BASE_MS)
})

test('two clients that fail in the same second come back at different times', () => {
  // The whole point, stated as the fleet property rather than as a range.
  const a = Array.from({ length: 200 }, ((r) => () => retryDelayMs(1, FAR, r))(seeded(1)))
  const b = Array.from({ length: 200 }, ((r) => () => retryDelayMs(1, FAR, r))(seeded(2)))
  const collisions = a.filter((x, i) => x === b[i]).length
  assert.ok(collisions < 5, `${collisions} of 200 retries collided`)
  assert.ok(new Set(a).size > 150, 'one client’s own retries must not cluster either')
})

test('THE WIRING: the retry rides its own handle and is superseded by the next tick', () => {
  const flush = read('src/main/telemetry/flush.ts')
  // `attempt` counts within ONE interval, and the tick clears whatever the last one left pending —
  // otherwise a retry and the tick it was capped against could both post the same batch.
  const tick = flush.slice(flush.indexOf('function onTick'), flush.indexOf('function recordHeartbeat'))
  assert.ok(tick.includes('clearRetry()'), 'a tick must supersede the pending retry')
  assert.ok(flush.includes('void runFlush(attempt + 1)'), 'the chain must count its attempts')
  assert.ok(flush.includes('retryDelayMs(attempt, toNextTick)'), 'the cap must be the next tick')
  // …and a permanent refusal never reaches the retry chain at all (400/413 retire, as they always
  // have): only the "not now" outcome schedules anything.
  assert.ok(flush.includes("if (outcome !== 'retry'"), 'only a not-now answer may retry')
})
