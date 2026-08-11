// PURE UNIT TESTS for the app-wide TIMESLICE (src/shared/timeslice.ts, JOS-130) and for the zone
// filter it drives through `rangeStats` / `windowItemRows`.
//
// No log, no fixture, no DOM — so this file never skips. It pins the five things "one slice
// everywhere" can get quietly wrong:
//
//   1. THE DEFINITIONS ARE THE LOG'S, NOT THE CLOCK'S. `Session` is the newest login line the log
//      states, `Zone` is the last zone line, and neither reads `Date.now()` — a replay of
//      yesterday's log has to give yesterday's answer, and restarting the app must not move a
//      boundary.
//
//   2. A PRESET THAT WOULD RESTATE ANOTHER IS NOT OFFERED. A record with no logout in it is one
//      session, so `Session` would be `All` under a second name; a record with no zone line has no
//      current zone. A control with two buttons for one answer teaches something false.
//
//   3. `All` IS BYTE-IDENTICAL TO THE UNFILTERED READ. The whole point of a default is that the
//      user who never touches the control sees what this app showed before it existed — asserted
//      field by field on `RangeStats`, not on a headline.
//
//   4. THE ZONE FILTER PARTITIONS, IT DOES NOT SAMPLE. Σ over the zones of a range must equal the
//      unfiltered range, every count and every millisecond — that is what makes "this zone" a
//      slice of the record rather than a second, differently-derived opinion about it. And the Σ
//      identity `active + idle + offline == duration` has to survive a range full of holes.
//
//   5. THE TWO SIDES USE ONE MEMBERSHIP TEST. A loot row is in the ledger if and only if the same
//      instant is inside the range the xp numbers were measured over — same half-open convention,
//      same zone fold, or the two halves of one screen describe different stretches of play.
//
// Imported RELATIVELY: node tests run through tsx with no `@shared` alias.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rangeStats } from '../src/shared/progressionStats'
import { windowItemRows } from '../src/shared/lootRates'
import { zoneKey } from '../src/shared/zones'
import type { LootEvent } from '../src/shared/types'
import type { ProgressionSnap } from '../src/shared/progressionTypes'
import {
  TAIL_MS,
  availableSlices,
  currentZoneOf,
  inSlice,
  resolveSlice,
  resolveSliceId,
  sessionStartOf,
  sliceDurationMs,
  sliceLabel,
  type SliceId
} from '../src/shared/timeslice'

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

/** A derived `offlineGap`: it exists only once the login line that ENDED it has been written. */
function addOffline(snap: ProgressionSnap, start: number, end: number): void {
  snap.offlineStart.push(start)
  snap.offlineEnd.push(end)
  snap.offlineCamped.push(1)
  snap.lastTs = Math.max(snap.lastTs, end)
}

/**
 * TWO CAMPS, TWO SESSIONS, AND THE SAME ZONE VISITED IN BOTH.
 *
 * Day one: four hours in Befallen, then an hour in Lower Guk. An overnight logout. Day two: two
 * hours back in Befallen, then two in Lower Guk. That shape is what makes every preset here
 * genuinely different from every other one — `Zone` spans both days, `Session` spans one, and
 * `Zone + Session` is neither.
 */
function twoSessionSnap(): { snap: ProgressionSnap; lo: number; hi: number; login: number } {
  const snap = emptySnap()
  addZone(snap, T0, 'Befallen')
  for (let m = 0; m < 240; m++) addPull(snap, T0 + m * MIN, 1)
  addZone(snap, T0 + 4 * HOUR, 'Lower Guk')
  for (let m = 0; m < 60; m++) addPull(snap, T0 + 4 * HOUR + m * MIN, 3)
  const camped = T0 + 5 * HOUR
  const login = T0 + DAY
  addOffline(snap, camped, login)
  addZone(snap, login, 'Befallen')
  for (let m = 0; m < 120; m++) addPull(snap, login + m * MIN, 2)
  addZone(snap, login + 2 * HOUR, 'Lower Guk')
  for (let m = 0; m < 120; m++) addPull(snap, login + 2 * HOUR + m * MIN, 4)
  return { snap, lo: T0, hi: snap.lastTs, login }
}

// ── 1 + 2. the definitions, and what a record can offer ───────────────────────────────

test('Session is the newest LOGIN the log states, and nothing about the clock', () => {
  const { snap, login } = twoSessionSnap()
  assert.equal(sessionStartOf(snap), login, 'the end of the newest offlineGap — the "Welcome" line')
  const plain = emptySnap()
  assert.equal(sessionStartOf(plain), null, 'no logout in the record ⇒ no boundary, and none invented')
})

test('the current zone is the last zone line, raw name and folded key', () => {
  const { snap } = twoSessionSnap()
  assert.deepEqual(currentZoneOf(snap), { key: 'lower guk', name: 'Lower Guk' })
  assert.equal(currentZoneOf(emptySnap()), null, 'before the first zone line there is no current zone')
})

test('a preset that would restate another is NOT offered', () => {
  const { snap, lo, hi } = twoSessionSnap()
  const offered = availableSlices(snap, { lo, hi })
  assert.equal(offered[0], 'all', 'the default is first and always available')
  assert.equal(offered[offered.length - 1], 'custom', 'and custom is last, always available too')
  for (const id of ['session', 'zone', 'zoneSession'] as const) {
    assert.ok(offered.includes(id), `${id} is offerable on a record that defines it`)
  }

  // A log with no logout is ONE session, so the button would be `All` under a second name.
  const oneSession = emptySnap()
  addZone(oneSession, T0, 'Befallen')
  addPull(oneSession, T0 + MIN, 1)
  const thin = availableSlices(oneSession, { lo: T0, hi: oneSession.lastTs })
  assert.ok(!thin.includes('session'), 'no logout ⇒ no Session button')
  assert.ok(!thin.includes('zoneSession'), '…and no Zone + Session either — it needs both halves')
  assert.ok(thin.includes('zone'), 'the zone line is there, so Zone is')

  // No zone line at all: the other direction.
  const nowhere = emptySnap()
  addOffline(nowhere, T0, T0 + HOUR)
  addPull(nowhere, T0 + HOUR + MIN, 1)
  const ids = availableSlices(nowhere, { lo: T0, hi: nowhere.lastTs })
  assert.ok(!ids.includes('zone') && !ids.includes('zoneSession'), 'no zone line ⇒ no zone presets')
  assert.ok(ids.includes('session'))
})

test('a duration rung is offered only when the record spans strictly longer than it', () => {
  const { snap, lo, hi } = twoSessionSnap()
  const offered = availableSlices(snap, { lo, hi })
  assert.ok(offered.includes('h24') && offered.includes('h1'), 'a >1d record fills 24h and 1h')
  assert.ok(!offered.includes('d7'), 'and cannot fill 7d')
  assert.equal(sliceDurationMs('h6'), 6 * HOUR)
  assert.equal(sliceDurationMs('all'), null, 'All is not a length')
  assert.equal(sliceDurationMs('session'), null)
})

test('a pick the record cannot define degrades to All rather than to a slice nobody can read', () => {
  const bare = emptySnap()
  addPull(bare, T0, 1)
  const bounds = { lo: T0, hi: bare.lastTs }
  assert.equal(resolveSliceId('zone', bare, bounds), 'all')
  assert.equal(resolveSliceId('session', bare, bounds), 'all')
  assert.equal(resolveSliceId('custom', bare, bounds), 'custom', 'custom is always definable')
  const { snap, lo, hi } = twoSessionSnap()
  assert.equal(resolveSliceId('zoneSession', snap, { lo, hi }), 'zoneSession', 'kept when the log defines it')
})

test('every preset resolves to the range and the zone its definition states', () => {
  const { snap, lo, hi, login } = twoSessionSnap()
  const bounds = { lo, hi }
  const of = (id: SliceId): ReturnType<typeof resolveSlice> => resolveSlice({ snap, bounds, id })

  assert.deepEqual(of('all').range, { t0: lo, t1: hi + TAIL_MS }, 'All is the record, tail millisecond and all')
  assert.equal(of('all').zoneKey, null)

  assert.deepEqual(of('session').range, { t0: login, t1: hi + TAIL_MS })
  assert.equal(of('session').zoneKey, null, 'Session says nothing about where')

  assert.deepEqual(of('zone').range, { t0: lo, t1: hi + TAIL_MS }, 'Zone is every visit ever…')
  assert.equal(of('zone').zoneKey, 'lower guk', '…restricted to the zone you are in')

  assert.deepEqual(of('zoneSession').range, { t0: login, t1: hi + TAIL_MS })
  assert.equal(of('zoneSession').zoneKey, 'lower guk')

  // A rung reaches back its own length from the NEWEST EVENT (`hi`), and then carries the same
  // tail millisecond every slice does — so it spans its hour of record and holds the last line.
  assert.deepEqual(of('h1').range, { t0: hi - HOUR, t1: hi + TAIL_MS }, 'a rung ends at the newest event')
})

test('a custom range is clamped inside the record and never inverted', () => {
  const { snap, lo, hi } = twoSessionSnap()
  const bounds = { lo, hi }
  const inside = { t0: lo + HOUR, t1: lo + 2 * HOUR }
  assert.deepEqual(resolveSlice({ snap, bounds, id: 'custom', custom: inside }).range, inside)
  const wild = resolveSlice({ snap, bounds, id: 'custom', custom: { t0: lo - DAY, t1: hi + DAY } })
  assert.deepEqual(wild.range, { t0: lo, t1: hi + TAIL_MS }, 'a range past both ends is the record')
  const backwards = resolveSlice({ snap, bounds, id: 'custom', custom: { t0: hi, t1: lo } })
  assert.ok(backwards.range.t1 >= backwards.range.t0, 'never an inverted range for a rate to divide by')
  const none = resolveSlice({ snap, bounds, id: 'custom' })
  assert.deepEqual(none.range, { t0: lo, t1: hi + TAIL_MS }, 'a custom range nobody has chosen is the whole record')
})

test('a record with no timestamps at all resolves to an empty range rather than to NaN', () => {
  const slice = resolveSlice({ snap: emptySnap(), bounds: null, id: 'session' })
  assert.deepEqual(slice.range, { t0: 0, t1: 0 })
  assert.equal(slice.zoneKey, null)
})

test('every slice has ONE label and ONE in-sentence spelling', () => {
  const { snap, lo, hi } = twoSessionSnap()
  const bounds = { lo, hi }
  assert.equal(sliceLabel('zoneSession'), 'Zone + Session')
  assert.equal(resolveSlice({ snap, bounds, id: 'all' }).caption, 'the whole log')
  assert.equal(resolveSlice({ snap, bounds, id: 'session' }).caption, 'this session')
  assert.equal(resolveSlice({ snap, bounds, id: 'zone' }).caption, 'Lower Guk')
  assert.equal(resolveSlice({ snap, bounds, id: 'zoneSession' }).caption, 'Lower Guk this session')
  // The duration rungs keep the JOS-71 spelling, so `windowScope.timescaleLabel` and this agree.
  assert.equal(resolveSlice({ snap, bounds, id: 'h24' }).caption, 'last 24h of the log')
})

// ── 5. one membership test ────────────────────────────────────────────────────────────

test('inSlice is half-open at the top and folds the zone exactly like the rows do', () => {
  const { snap, lo, hi } = twoSessionSnap()
  const bounds = { lo, hi }
  const zone = resolveSlice({ snap, bounds, id: 'zone' })
  assert.ok(inSlice(zone, lo + HOUR, 'Lower Guk'))
  assert.ok(inSlice(zone, lo + HOUR, 'lower guk'), 'the fold is case-insensitive, like zoneIdKey')
  assert.ok(!inSlice(zone, lo + HOUR, 'Befallen'), 'a drop from another zone is out')
  assert.ok(!inSlice(zone, lo + HOUR), 'a row with no zone belongs to `unknown`, not to a named zone')

  const custom = resolveSlice({ snap, bounds, id: 'custom', custom: { t0: lo, t1: lo + HOUR } })
  assert.ok(inSlice(custom, lo), 'closed at the bottom')
  assert.ok(!inSlice(custom, lo + HOUR), 'open at the top — the same convention rangeStats uses')
  assert.ok(inSlice(custom, lo + HOUR - 1))
})

// ── 3 + 4. what the zone filter does to the numbers ───────────────────────────────────

test('an ABSENT zone filter is byte-identical to the read this app has always done', () => {
  const { snap, lo, hi } = twoSessionSnap()
  const range = { t0: lo, t1: hi + TAIL_MS }
  assert.deepEqual(rangeStats({ snap, range, zoneKey: null }), rangeStats({ snap, range }))
})

test('the zone filter PARTITIONS the range — Σ over the zones is the whole of it', () => {
  const { snap, lo, hi } = twoSessionSnap()
  const range = { t0: lo, t1: hi + TAIL_MS }
  const all = rangeStats({ snap, range })
  // Over the MEMBERSHIP fold's classes, which is what the control partitions the record into.
  const keys = [...new Set(all.zones.map((z) => zoneKey(z.zone)))]
  const parts = keys.map((k) => rangeStats({ snap, range, zoneKey: k }))

  const sum = (pick: (s: (typeof parts)[number]) => number): number => parts.reduce((n, p) => n + pick(p), 0)
  assert.equal(sum((p) => p.durationMs), all.durationMs, 'every millisecond of the range is in exactly one zone')
  assert.equal(sum((p) => p.activeMs), all.activeMs)
  assert.equal(sum((p) => p.idleMs), all.idleMs)
  assert.equal(sum((p) => p.offlineMs), all.offlineMs)
  assert.equal(sum((p) => p.kills), all.kills, 'and every credited kill')
  assert.equal(sum((p) => p.expSamples), all.expSamples)
  assert.equal(sum((p) => p.aaGainEvents), all.aaGainEvents)
  assert.ok(Math.abs(sum((p) => p.levelEquiv) - all.levelEquiv) < 1e-9)
})

test('the Σ identity survives a range full of holes: active + idle + offline == duration', () => {
  const { snap, lo, hi } = twoSessionSnap()
  const range = { t0: lo, t1: hi + TAIL_MS }
  for (const zoneKey of [null, 'befallen', 'lower guk']) {
    const s = rangeStats({ snap, range, zoneKey })
    assert.equal(s.activeMs + s.idleMs + s.offlineMs, s.durationMs, `zone ${String(zoneKey)}`)
    assert.equal(s.zones.reduce((n, z) => n + z.spanMs, 0), s.durationMs, 'and the rows still tile it')
  }
})

test('the overnight belongs to the camp it was taken from, and only to that camp', () => {
  const { snap, lo, hi } = twoSessionSnap()
  const range = { t0: lo, t1: hi + TAIL_MS }
  // The logout was taken in Lower Guk (day one ended there), so Befallen never sees it.
  const guk = rangeStats({ snap, range, zoneKey: 'lower guk' })
  const befallen = rangeStats({ snap, range, zoneKey: 'befallen' })
  assert.ok(guk.offlineMs > 0, 'the camp you logged out of carries the absence')
  assert.equal(befallen.offlineMs, 0, 'and the other one does not')
  assert.equal(guk.offlineMs, rangeStats({ snap, range }).offlineMs, 'nothing is lost or doubled')
})

test('a zone-filtered rate divides by that ZONE own active time, never by the range wall clock', () => {
  const { snap, lo, hi } = twoSessionSnap()
  const range = { t0: lo, t1: hi + TAIL_MS }
  const all = rangeStats({ snap, range })
  const guk = rangeStats({ snap, range, zoneKey: 'lower guk' })
  assert.ok(guk.durationMs < all.durationMs, 'the filtered range really is smaller')
  // Lower Guk pays 3% and 4% a pull; Befallen pays 1% and 2%. So the rate MOVES with the zone,
  // which a filter that quietly kept measuring everything could not do.
  assert.ok((guk.levelsPerHourActive ?? 0) > (all.levelsPerHourActive ?? 0))
  assert.equal(guk.zones.length, 1, 'one zone asked for, one row back')
  assert.equal(guk.zones[0].zone, 'Lower Guk', 'raw display name, first-seen casing')
  assert.equal(guk.zones[0].activeMs, guk.activeMs, 'the row and the range agree, by construction')
})

test('an INSTANCE RE-ENTRY is the same camp — the slice folds the tier and the selector away', () => {
  // The shape EQ Legends really prints, and the reason the membership fold is not `zoneIdKey`:
  // three spellings of one place, and a fourth zone in between that must NOT be swept in.
  const snap = emptySnap()
  addZone(snap, T0, "Nagafen's Lair - Solo 4 (Refined)")
  for (let m = 0; m < 60; m++) addPull(snap, T0 + m * MIN, 1)
  addZone(snap, T0 + HOUR, 'Befallen')
  for (let m = 0; m < 60; m++) addPull(snap, T0 + HOUR + m * MIN, 1)
  addZone(snap, T0 + 2 * HOUR, "The Nagafen's Lair - Solo 7 (Awakened)")
  for (let m = 0; m < 60; m++) addPull(snap, T0 + 2 * HOUR + m * MIN, 1)
  const bounds = { lo: T0, hi: snap.lastTs }

  const slice = resolveSlice({ snap, bounds, id: 'zone' })
  assert.equal(slice.zoneKey, "nagafen's lair", 'the ordinal, the tier and the article all fold away')
  assert.equal(slice.zoneName, "The Nagafen's Lair - Solo 7 (Awakened)", 'but the CAPTION shows the raw name (law 2)')

  const s = rangeStats({ snap, range: slice.range, zoneKey: slice.zoneKey })
  assert.equal(s.kills, 120, 'both instances of the camp are counted, and Befallen is not')
  // The first visit is a full hour; the second is still OPEN, so it runs to the end of the slice
  // (the last pull at +2h59m, plus the tail millisecond) rather than to a fabricated exit.
  assert.equal(s.durationMs, HOUR + 59 * MIN + TAIL_MS, 'and so is the time spent in each of them')
  // The JOIN fold is untouched, so the two spellings stay two ROWS — each one still exactly the
  // row `lootRates.itemZoneRows` joins that visit's drops onto (rule 2).
  assert.equal(s.zones.length, 2, 'two spellings, two rows — membership is coarser than the join')

  // …and the loot side folds identically, which is the whole point of one membership test.
  const events: LootEvent[] = [
    { ts: T0 + 10 * MIN, item: 'Mote', zone: "Nagafen's Lair - Solo 4 (Refined)" },
    { ts: T0 + HOUR + 10 * MIN, item: 'Mote', zone: 'Befallen' },
    { ts: T0 + 2 * HOUR + 10 * MIN, item: 'Mote', zone: "The Nagafen's Lair - Solo 7 (Awakened)" }
  ]
  assert.deepEqual(
    events.filter((e) => inSlice(slice, e.ts, e.zone)).length,
    2,
    'the ledger admits both instances of the camp and neither of the neighbours'
  )
})

test('a filter for a zone the range never held is empty rather than clamped onto its neighbour', () => {
  const { snap, lo, hi } = twoSessionSnap()
  const s = rangeStats({ snap, range: { t0: lo, t1: hi + TAIL_MS }, zoneKey: 'najena' })
  assert.equal(s.durationMs, 0)
  assert.equal(s.kills, 0, 'a kill next door is NOT clamped into the nearest visit of the zone asked for')
  assert.equal(s.expSamples, 0)
  assert.deepEqual(s.zones, [])
  assert.equal(s.levelsPerHourActive, null, 'and no rate is fabricated over a range with no time in it')
})

test('a zone-filtered scope is DOMINATED by the unfiltered one, count for count', () => {
  const { snap, lo, hi } = twoSessionSnap()
  const range = { t0: lo, t1: hi + TAIL_MS }
  const all = rangeStats({ snap, range })
  for (const key of ['befallen', 'lower guk']) {
    const part = rangeStats({ snap, range, zoneKey: key })
    assert.ok(part.kills <= all.kills)
    assert.ok(part.durationMs <= all.durationMs)
    assert.ok(part.activeMs <= all.activeMs)
    assert.ok(part.killsWitnessed <= all.killsWitnessed)
    assert.ok(part.levelEquiv <= all.levelEquiv + 1e-9)
  }
})

// ── the loot side of the same slice ───────────────────────────────────────────────────

const drops: LootEvent[] = [
  { ts: T0 + 10 * MIN, item: 'Mote of Potential', zone: 'Befallen' },
  { ts: T0 + 20 * MIN, item: 'Mote of Potential', zone: 'Befallen', count: 3 },
  { ts: T0 + 4 * HOUR + 10 * MIN, item: 'Mote of Potential', zone: 'Lower Guk' },
  { ts: T0 + 4 * HOUR + 20 * MIN, item: 'Rusty Dagger', zone: 'Lower Guk' },
  { ts: T0 + 30 * MIN, item: 'Bone Chips' }
]

test('windowItemRows applies the slice ZONE as well as its range', () => {
  const args = { events: drops, t0: T0, t1: T0 + DAY, activeMs: HOUR }
  const everywhere = windowItemRows(args)
  assert.equal(everywhere.find((r) => r.key === 'mote of potential')?.drops, 5, '1 + 3 + 1, stacks counted')

  const befallen = windowItemRows({ ...args, zoneKey: 'befallen' })
  assert.equal(befallen.length, 1, 'one item dropped there')
  assert.equal(befallen[0].drops, 4, 'and the Lower Guk mote is not counted against Befallen hours')

  const unknown = windowItemRows({ ...args, zoneKey: 'unknown' })
  assert.equal(unknown.length, 1, 'the pre-first-zone-line row has its own bucket, named like the zone row')
  assert.equal(unknown[0].item, 'Bone Chips')
})

test('the ledger filter and the stats query agree about which rows are in the slice', () => {
  const { snap, lo, hi } = twoSessionSnap()
  const bounds = { lo, hi }
  for (const id of ['all', 'session', 'zone', 'zoneSession'] as const) {
    const slice = resolveSlice({ snap, bounds, id })
    const ledger = drops.filter((e) => inSlice(slice, e.ts, e.zone))
    const rows = windowItemRows({
      events: drops,
      t0: slice.range.t0,
      t1: slice.range.t1,
      activeMs: HOUR,
      zoneKey: slice.zoneKey
    })
    const counted = rows.reduce((n, r) => n + r.events, 0)
    assert.equal(counted, ledger.length, `${id}: the two sides admit the same rows`)
  }
})
