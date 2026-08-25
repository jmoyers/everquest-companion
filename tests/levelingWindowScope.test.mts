// PURE UNIT TESTS for the Leveling tab's SCOPE
// (src/renderer/src/features/leveling/windowScope.ts, JOS-75).
//
// No log, no fixture, no DOM — so this file never skips. It pins the four things "the dashboard
// numbers follow the timescale" can get quietly wrong:
//
//   1. THE `All` IDENTITY. Picking a window must not change the picture for the user who never
//      picks one. `All`'s scope has to be BYTE-IDENTICAL to a full-history read — every field of
//      `RangeStats`, not just the headline rate — or this feature silently rewrote today's
//      numbers while claiming to add a control. The drawn window is NOT that range (it carries
//      a trailing gutter past the newest event), so the clamp is what makes the identity true
//      and this is the test that would catch its removal.
//
//   2. A NARROW WINDOW MEASURES THE NARROW WINDOW. Its counts must be strictly smaller when the
//      history has events outside it, and its rates must be the window's own — a scope that
//      returned the same numbers at every scale would look exactly like a working feature.
//
//   3. AN EMPTY / IDLE WINDOW REFUSES TO INVENT A RATE. A window with no experience line in it
//      states no levels-per-hour (null, which every surface renders as an em-dash), and a window
//      that is one long silence has zero active time rather than a fabricated denominator. This
//      is `rangeStats`' own rule; the point here is that the SCOPE does not launder it.
//
//   4. A SELECTION WINS, AND ONLY A SELECTION. Precedence is the whole contract between the
//      timescale and the drag: a committed range narrows the same base, clearing it falls back
//      to the window, and the WORDING follows so a number can never be read against the wrong
//      stretch.
//
// Imported RELATIVELY: node tests run through tsx with no `@shared` alias.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rangeStats } from '../src/shared/progressionStats'
import type { ProgressionSnap } from '../src/shared/progressionTypes'
import { windowFor } from '../src/renderer/src/features/leveling/chartWindow'
import {
  SELECTION_LABEL,
  scopedStats,
  statsRangeFor,
  timescaleLabel
} from '../src/renderer/src/features/leveling/windowScope'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** An arbitrary, readable anchor — nothing here depends on the wall clock. */
const T0 = Date.parse('Sat Aug 01 12:00:00 2026')

function emptySnap(): ProgressionSnap {
  return {
    expTs: [], expPct: [], expFlag: [],
    killTs: [], killZone: [], killCredit: [],
    witnessTs: [], recentKills: [], lootTs: [],
    zoneStart: [], zoneEnd: [], zoneName: [],
    offlineStart: [], offlineEnd: [], offlineCamped: [],
    levelTs: [], levelValue: [], aaGainTs: [], aaGainAmount: [],
    lastTs: 0, windowStart: 0, dropped: 0
  }
}

function addZone(snap: ProgressionSnap, ts: number, name: string): void {
  const n = snap.zoneStart.length
  if (n > 0) snap.zoneEnd[n - 1] = ts
  snap.zoneStart.push(ts)
  snap.zoneEnd.push(0)
  snap.zoneName.push(name)
  snap.lastTs = Math.max(snap.lastTs, ts)
}

/** One kill + the experience line the game printed with it, both at `ts`. */
function addPull(snap: ProgressionSnap, ts: number, pct: number): void {
  snap.expTs.push(ts)
  snap.expPct.push(pct)
  snap.expFlag.push(0)
  snap.killTs.push(ts)
  snap.killZone.push(snap.zoneStart.length - 1)
  snap.killCredit.push(0)
  snap.lastTs = Math.max(snap.lastTs, ts)
}

function addAa(snap: ProgressionSnap, ts: number, amount: number): void {
  snap.aaGainTs.push(ts)
  snap.aaGainAmount.push(amount)
  snap.lastTs = Math.max(snap.lastTs, ts)
}

/**
 * Two days of play at one pull a minute, four hours a day, in two camps — enough for a `24h`
 * window to genuinely exclude a day's worth of everything, and dense enough that the idle
 * classifier stays quiet inside a session (IDLE_GAP_MS is five minutes).
 */
function twoDaySnap(): { snap: ProgressionSnap; lo: number; hi: number } {
  const snap = emptySnap()
  addZone(snap, T0, 'Befallen')
  for (let m = 0; m < 240; m++) addPull(snap, T0 + m * MIN, 1)
  addAa(snap, T0 + 30 * MIN, 1)
  addZone(snap, T0 + DAY, 'Lower Guk')
  for (let m = 0; m < 240; m++) addPull(snap, T0 + DAY + m * MIN, 2)
  addAa(snap, T0 + DAY + 60 * MIN, 2)
  // Deliberately OUTSIDE the last hour, so an `h1` window has a completion count of a real zero.
  addAa(snap, T0 + DAY + 90 * MIN, 1)
  snap.levelTs.push(T0 + DAY + 200 * MIN)
  snap.levelValue.push(42)
  return { snap, lo: T0, hi: snap.lastTs }
}

// ── 1. the `All` identity ─────────────────────────────────────────────────────────────

test('`All` scopes EXACTLY the record — the drawn trailing gutter is never counted as time', () => {
  const { lo, hi } = twoDaySnap()
  const win = windowFor(lo, hi, 'full')
  assert.ok(win.t1 > hi, 'the drawn window really does run past the newest event (else this proves nothing)')
  // `hi + 1`, not `hi`: ranges are half-open, and the newest event is stamped AT `hi` — see
  // `TAIL_MS`. This was a measured off-by-one, not a decoration.
  assert.deepEqual(statsRangeFor(win, { lo, hi }), { t0: lo, t1: hi + 1 })
})

test('`All`s numbers are BYTE-IDENTICAL to a full-history read — every field, not just the rate', () => {
  const { snap, lo, hi } = twoDaySnap()
  const scope = scopedStats({ snap, win: windowFor(lo, hi, 'full'), bounds: { lo, hi }, id: 'full', selection: null })
  assert.equal(scope.kind, 'window')
  assert.deepEqual(scope.stats, rangeStats({ snap, range: { t0: lo, t1: hi + 1 } }))
  // …and it really does hold the WHOLE record: the last pull of the log is inside the totals.
  assert.equal(scope.stats.kills, snap.killTs.length)
  assert.equal(scope.stats.expSamples, snap.expTs.length)
  assert.equal(scope.stats.aaGainEvents, snap.aaGainTs.length)
})

test('a fixed window that snapped OUTWARD past either end of the record is clamped back to it', () => {
  const { lo, hi } = twoDaySnap()
  for (const id of ['h24', 'h6', 'h1'] as const) {
    const r = statsRangeFor(windowFor(lo, hi, id), { lo, hi })
    assert.equal(r.t1, hi + 1, `${id} stops at the newest event, inclusive`)
    assert.ok(r.t0 >= lo, `${id} never reaches back before the first`)
    assert.ok(r.t0 < r.t1, `${id} still spans time`)
  }
})

test('a degenerate record (one instant) yields a zero-length range rather than an inverted one', () => {
  const r = statsRangeFor(windowFor(T0, T0, 'full'), { lo: T0, hi: T0 })
  assert.equal(r.t0, T0)
  assert.ok(r.t1 >= r.t0 && r.t1 <= T0 + 1, 'clamped to the record, never left at the padded drawn edge')
})

// ── 2. a narrow window measures the narrow window ─────────────────────────────────────

test('a narrower scale re-derives the numbers — it does not restate the full-history ones', () => {
  const { snap, lo, hi } = twoDaySnap()
  const all = scopedStats({ snap, win: windowFor(lo, hi, 'full'), bounds: { lo, hi }, id: 'full', selection: null })
  const day = scopedStats({ snap, win: windowFor(lo, hi, 'h24'), bounds: { lo, hi }, id: 'h24', selection: null })
  const hour = scopedStats({ snap, win: windowFor(lo, hi, 'h1'), bounds: { lo, hi }, id: 'h1', selection: null })

  // Day two's pulls pay 2% each, day one's 1% — so the rate genuinely MOVES with the window,
  // which a scope that quietly kept measuring everything could not do.
  assert.ok(all.stats.kills > day.stats.kills, 'the 24h window drops day one entirely')
  assert.ok(day.stats.kills > hour.stats.kills)
  assert.equal(hour.stats.kills, 61, 'one pull a minute across the hour, the newest one included')
  assert.ok(
    (day.stats.levelsPerHourActive ?? 0) > (all.stats.levelsPerHourActive ?? 0),
    'the recent camp pays double, and the recent window says so'
  )
  // Dominance, which holds for any log at any scale: a window inside another can never count more.
  for (const narrow of [day, hour]) {
    assert.ok(narrow.stats.durationMs < all.stats.durationMs)
    assert.ok(narrow.stats.activeMs <= all.stats.activeMs)
    assert.ok(narrow.stats.aaGainEvents <= all.stats.aaGainEvents)
    assert.ok(narrow.stats.levelEquiv <= all.stats.levelEquiv + 1e-9)
  }
})

test('the AA reads follow the window too — an hour that earned nothing says so, and says 0', () => {
  const { snap, lo, hi } = twoDaySnap()
  const all = scopedStats({ snap, win: windowFor(lo, hi, 'full'), bounds: { lo, hi }, id: 'full', selection: null })
  const hour = scopedStats({ snap, win: windowFor(lo, hi, 'h1'), bounds: { lo, hi }, id: 'h1', selection: null })
  assert.equal(all.stats.aaGainEvents, 3)
  assert.equal(hour.stats.aaGainEvents, 0, 'the last hour of this log holds no completion')
  // A MEASURED zero, not an unknown: a gain line always states its amount, so 0.0 here is a fact.
  assert.equal(hour.stats.aaPerHourActive, 0)
  assert.ok((all.stats.aaPerHourActive ?? 0) > 0)
})

// ── 3. empty and idle windows refuse to invent ────────────────────────────────────────

test('a window with no experience line states NO levels rate — null, never 0.0', () => {
  const snap = emptySnap()
  addZone(snap, T0, 'Befallen')
  snap.lastTs = T0 + HOUR
  const scope = scopedStats({
    snap,
    win: windowFor(T0, T0 + HOUR, 'full'),
    bounds: { lo: T0, hi: T0 + HOUR },
    id: 'full',
    selection: null
  })
  assert.equal(scope.stats.expSamples, 0)
  assert.equal(scope.stats.kills, 0)
  assert.equal(scope.stats.activeMs, 0, 'an hour of pure silence is idle, so there is no active time')
  assert.equal(scope.stats.idleMs, HOUR + 1, 'the whole scope, tail millisecond and all')
  assert.equal(scope.stats.levelsPerHourActive, null)
  assert.equal(scope.stats.killsPerHourActive, null)
  assert.equal(scope.stats.aaPerHourActive, null, 'no active time ⇒ no denominator, not a zero')
})

test('a window over a snapshot that has folded NOTHING is empty rather than NaN', () => {
  // The VIEW never reaches this state — `dataBounds` returns null with no timestamp anywhere and
  // LevelingView renders its stated empty state instead of a scope. Pinned anyway because the
  // arithmetic must not be the thing that breaks if it ever does.
  const snap = emptySnap()
  const scope = scopedStats({
    snap,
    win: windowFor(T0, T0, 'full'),
    bounds: { lo: T0, hi: T0 },
    id: 'full',
    selection: null
  })
  // A record holding one instant spans that instant and nothing more — never the fractional
  // drawn pad, and never a negative or NaN span the rates would be divided by.
  assert.equal(scope.stats.durationMs, 1)
  assert.equal(scope.stats.expSamples, 0)
  assert.equal(scope.stats.kills, 0)
  assert.deepEqual(scope.stats.levelUps, [])
  for (const n of [scope.stats.activeMs, scope.stats.idleMs, scope.stats.offlineMs, scope.stats.levelEquiv]) {
    assert.ok(Number.isFinite(n), 'every span is a number, not a NaN a rate would inherit')
  }
})

test('a window that is entirely one long silence has zero active time and no fabricated rate', () => {
  const { snap, hi } = twoDaySnap()
  // The eight-hour gap between the two camps: real time, no events at all.
  const quiet = { t0: T0 + 6 * HOUR, t1: T0 + 14 * HOUR }
  const scope = scopedStats({
    snap,
    win: windowFor(T0, hi, 'full'),
    bounds: { lo: T0, hi },
    id: 'full',
    selection: quiet
  })
  assert.equal(scope.stats.activeMs, 0)
  assert.equal(scope.stats.idleMs, 8 * HOUR, 'the whole stretch is present-but-silent — idle, never offline')
  assert.equal(scope.stats.offlineMs, 0, 'no login line closed anything here, so nothing is called offline')
  assert.equal(scope.stats.levelsPerHourActive, null)
})

// ── 4. precedence, and the wording that follows it ────────────────────────────────────

test('a committed selection WINS over the window, and clearing it falls straight back', () => {
  const { snap, lo, hi } = twoDaySnap()
  const win = windowFor(lo, hi, 'h24')
  const sel = { t0: T0 + DAY + 30 * MIN, t1: T0 + DAY + 90 * MIN }

  const narrowed = scopedStats({ snap, win, bounds: { lo, hi }, id: 'h24', selection: sel })
  assert.equal(narrowed.kind, 'selection')
  // The drag sits well inside the record, so the JOS-454 clamp is a no-op on it and the range IS
  // the gesture. (This assertion used to read "never re-clamped to the record" — see the test
  // below for the case that overturned the words while leaving this one's numbers alone.)
  assert.deepEqual(narrowed.range, sel, 'a drag inside the record is the range verbatim')
  assert.deepEqual(narrowed.stats, rangeStats({ snap, range: sel }), 'and it is the SAME derivation, not a second one')

  const fallback = scopedStats({ snap, win, bounds: { lo, hi }, id: 'h24', selection: null })
  assert.equal(fallback.kind, 'window')
  assert.deepEqual(fallback.stats, rangeStats({ snap, range: statsRangeFor(win, { lo, hi }) }))
  assert.notDeepEqual(fallback.stats, narrowed.stats, 'the two scopes really are different readings')
})

// JOS-454. A drag to the right edge of the chart lands in the TRAILING GUTTER — every scale
// carries one (`chartWindow.TRAILING_FRAC`, 4% of the span) so the current level reads as a
// plateau instead of a bare endpoint. Rule 2 clamps a WINDOW back to the record for exactly that
// reason; rule 3 used to hand a SELECTION through untouched, and the two rules were in conflict
// about the same milliseconds. The owner's report is what the conflict costs: a selection ending
// 15:29:55 over a record that stopped at 15:20:27 handed 9m28s of manufactured silence to the
// numbers — and because `zoneSegments` closes a still-OPEN zone visit at the end of the RANGE,
// under a zone slice all of it was booked as time standing in that zone.
test('a drag into the trailing gutter is CLAMPED to the record, exactly as a window is', () => {
  const { snap, lo, hi } = twoDaySnap()
  const win = windowFor(lo, hi, 'full')
  // The drawn window's right edge, which is what the user can actually drag to.
  assert.ok(win.t1 > hi, 'the drawn window really does run past the newest event')
  const gutter = { t0: hi - HOUR, t1: win.t1 }

  const scope = scopedStats({ snap, win, bounds: { lo, hi }, id: 'full', selection: gutter })
  assert.equal(scope.kind, 'selection', 'it is still the drag that is in force')
  assert.equal(scope.range.t0, gutter.t0, 'the left edge is inside the record and is untouched')
  assert.equal(scope.range.t1, hi + 1, 'the right edge stops one millisecond past the newest event')
  assert.deepEqual(
    scope.stats,
    rangeStats({ snap, range: { t0: gutter.t0, t1: hi + 1 } }),
    'and the numbers are the clamped range — still ONE derivation'
  )
  // THE MEASUREMENT THE CLAMP EXISTS FOR: the unclamped read is longer by the whole gutter, and
  // every millisecond of the difference is silence the log never recorded.
  const unclamped = rangeStats({ snap, range: gutter })
  assert.equal(unclamped.durationMs - scope.stats.durationMs, win.t1 - (hi + 1))
  assert.equal(unclamped.kills, scope.stats.kills, 'the gutter holds no events — it can only add idle')
  assert.ok(unclamped.idleMs > scope.stats.idleMs)
})

test('a drag that lies ENTIRELY past the record measures nothing, and says so', () => {
  const { snap, lo, hi } = twoDaySnap()
  const win = windowFor(lo, hi, 'full')
  // Possible with a real pointer: the gutter is drawable, so a short drag can sit wholly inside
  // it. Honest answer is an empty range — never a slab of invented time.
  const scope = scopedStats({ snap, win, bounds: { lo, hi }, id: 'full', selection: { t0: hi + 5, t1: win.t1 } })
  assert.equal(scope.range.t0, scope.range.t1, 'clamped to a zero-length range rather than inverted')
  assert.equal(scope.stats.durationMs, 0)
  assert.equal(scope.stats.kills, 0)
})

test('every scope says WHICH stretch it covers, in one spelling per scope', () => {
  assert.equal(timescaleLabel('full'), 'the whole log')
  assert.equal(timescaleLabel('h24'), 'last 24h of the log')
  assert.equal(timescaleLabel('h1'), 'last 1h of the log')
  const { snap, lo, hi } = twoDaySnap()
  const win = windowFor(lo, hi, 'h6')
  assert.equal(scopedStats({ snap, win, bounds: { lo, hi }, id: 'h6', selection: null }).label, 'last 6h of the log')
  assert.equal(
    scopedStats({ snap, win, bounds: { lo, hi }, id: 'h6', selection: { t0: hi - HOUR, t1: hi } }).label,
    SELECTION_LABEL,
    'a selection is never described as the timescale it sits inside'
  )
})

// ── 5. the slice the tab now follows (JOS-130) ────────────────────────────────────────
//
// The timescale became four rungs of an app-wide TIMESLICE, so the scope grew three optional
// inputs: an exact range (a slice states both its ends and must not be re-derived from a padded
// drawn window), a zone filter, and its own wording. What is pinned here is that all three are
// PASS-THROUGH — the scope still runs exactly one `rangeStats` and invents no arithmetic of its
// own — and that omitting them is byte-identical to JOS-71's behaviour.

test('a slice hands its EXACT range through — a stated end is never pushed out by the drawn pad', () => {
  const { snap, lo, hi } = twoDaySnap()
  const exact = { t0: T0 + 2 * HOUR, t1: T0 + 3 * HOUR }
  const scope = scopedStats({
    snap,
    // The drawn window deliberately runs past `exact.t1` (that is the trailing gutter); the point
    // is that the NUMBERS do not.
    win: windowFor(lo, hi, 'full'),
    bounds: { lo, hi },
    id: 'full',
    range: exact,
    label: 'the custom range',
    selection: null
  })
  assert.deepEqual(scope.range, exact)
  assert.equal(scope.label, 'the custom range', 'and the slice supplies the wording')
  assert.deepEqual(scope.stats, rangeStats({ snap, range: exact }), 'still ONE derivation, not a second')
})

test('the zone half rides on the scope and reaches rangeStats untouched', () => {
  const { snap, lo, hi } = twoDaySnap()
  const args = { snap, win: windowFor(lo, hi, 'full'), bounds: { lo, hi }, id: 'full' as const, selection: null }
  const all = scopedStats(args)
  assert.equal(all.zoneKey, null, 'an unrestricted scope says so rather than leaving it undefined')
  assert.equal(all.zoneName, null)

  const guk = scopedStats({ ...args, zoneKey: 'lower guk', zoneName: 'Lower Guk', label: 'Lower Guk' })
  assert.equal(guk.zoneKey, 'lower guk')
  assert.deepEqual(guk.stats, rangeStats({ snap, range: guk.range, zoneKey: 'lower guk' }))
  assert.ok(guk.stats.kills < all.stats.kills, 'day one happened in Befallen and is not counted here')
  assert.equal(guk.label, 'Lower Guk')
})

test('a drag narrows TIME and keeps the zone — and the wording says both', () => {
  const { snap, lo, hi } = twoDaySnap()
  const sel = { t0: T0 + DAY + 30 * MIN, t1: T0 + DAY + 90 * MIN }
  const scope = scopedStats({
    snap,
    win: windowFor(lo, hi, 'full'),
    bounds: { lo, hi },
    id: 'full',
    zoneKey: 'lower guk',
    zoneName: 'Lower Guk',
    label: 'Lower Guk',
    selection: sel
  })
  assert.equal(scope.kind, 'selection')
  assert.deepEqual(scope.range, sel)
  assert.equal(scope.zoneKey, 'lower guk', 'the zone survives the drag — it is the other dimension')
  assert.equal(scope.label, `${SELECTION_LABEL} in Lower Guk`)
  assert.deepEqual(scope.stats, rangeStats({ snap, range: sel, zoneKey: 'lower guk' }))
})

// JOS-454, the wording half. The zone survived the drag; the MEMBERSHIP clause did not. A slice
// states its zone half as `Befallen 2 (Adaptive), this tier only` (`timeslice.zoneCaption`) and a
// drag replaced that whole sentence with its own, keeping the zone's raw name and dropping the
// clause — so under `exactTier` the numbers admitted one spelling of a camp while nothing on the
// tab said a tier was in force at all. The clause is the half that decides whether an hour of
// play counts, which makes it the half a caption may not lose.
test('a drag keeps the MEMBERSHIP clause too, not just the zone name', () => {
  const { snap, lo, hi } = twoDaySnap()
  const sel = { t0: T0 + DAY + 30 * MIN, t1: T0 + DAY + 90 * MIN }
  const args = {
    snap,
    win: windowFor(lo, hi, 'full'),
    bounds: { lo, hi },
    id: 'full' as const,
    zoneKey: 'lower guk',
    zoneName: 'Lower Guk',
    zoneCaption: 'Lower Guk 2 (Adaptive), this tier only',
    label: 'Lower Guk 2 (Adaptive), this tier only'
  }
  const dragged = scopedStats({ ...args, selection: sel })
  assert.equal(dragged.zoneCaption, 'Lower Guk 2 (Adaptive), this tier only', 'it rides on the scope')
  assert.equal(dragged.label, `${SELECTION_LABEL} in Lower Guk 2 (Adaptive), this tier only`)

  // The window under the same slice says the same thing in the slice's own words — one membership,
  // two scopes, never two answers.
  const windowed = scopedStats({ ...args, selection: null })
  assert.equal(windowed.zoneCaption, 'Lower Guk 2 (Adaptive), this tier only')
  assert.equal(windowed.label, 'Lower Guk 2 (Adaptive), this tier only')

  // A caller with no slice (there are still some) falls back to the raw name, which is what this
  // function did before the field existed.
  const bare = scopedStats({ ...args, zoneCaption: undefined, selection: sel })
  assert.equal(bare.zoneCaption, 'Lower Guk')
  assert.equal(bare.label, `${SELECTION_LABEL} in Lower Guk`)

  // …and an unrestricted scope has no clause to state, rather than an empty one.
  const open = scopedStats({ snap, win: windowFor(lo, hi, 'full'), bounds: { lo, hi }, id: 'full', selection: sel })
  assert.equal(open.zoneCaption, null)
  assert.equal(open.label, SELECTION_LABEL)
})

test('omitting all three new inputs is EXACTLY the JOS-71 scope', () => {
  const { snap, lo, hi } = twoDaySnap()
  for (const id of ['full', 'h24', 'h1'] as const) {
    const win = windowFor(lo, hi, id)
    const scope = scopedStats({ snap, win, bounds: { lo, hi }, id, selection: null })
    assert.deepEqual(scope.range, statsRangeFor(win, { lo, hi }), `${id}: still derived from the drawn window`)
    assert.equal(scope.label, timescaleLabel(id))
    assert.deepEqual(scope.stats, rangeStats({ snap, range: statsRangeFor(win, { lo, hi }) }))
  }
})
