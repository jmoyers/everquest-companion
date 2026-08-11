// The XP OVERLAY's model (JOS-195) — the row checklist and the mote family in
// `src/shared/xpOverlay.ts`, and the whole shaped window in `src/renderer/src/overlay/xpRows.ts`.
//
// WHAT THIS FILE IS FOR, and what it deliberately leaves to its neighbours. The overlay derives
// nothing: `rangeStats` is pinned in tests/levelingWindowScope.test.mts and the progression suite,
// `levelEta`'s four gates in tests/overviewLeveling.test.mts, `aaEta` in tests/aaPace.test.mts,
// `windowItemRows` in tests/lootRates.test.mts, and the slice definitions in
// tests/timeslice.test.mts. So nothing here re-checks an arithmetic. What it checks is the part
// that is NEW — which rows exist, which are switched off, what a mote is, and the one thing the
// window does that no other surface does: DECIDE WHICH PACES THE LOG CAN CURRENTLY STATE (levels
// and AA while both bars are moving; AA alone at the cap — JOS-202) and change its vocabulary with
// them.
//
// SNAPSHOTS ARE HAND-BUILT AND ANCHORED IN THE PAST, like every other test over this model: the
// derivations read `snap.lastTs` and never `Date.now()`, and a fixture near the wall clock would
// hide exactly that.

import test from 'node:test'
import assert from 'node:assert/strict'
import type { LootEvent } from '../src/shared/types'
import type { ProgressionSnap } from '../src/shared/progressionTypes'
import { resolveSlice, type SliceId } from '../src/shared/timeslice'
import {
  XP_ROW_IDS,
  isMote,
  moteRates,
  moteTier,
  normalizeXpRows,
  toggleXpRow,
  xpRowVisible
} from '../src/shared/xpOverlay'
import { dataBounds } from '../src/renderer/src/features/leveling/zoneBands'
// The em-dash rule's one spelling (rangeStatsRows rule 1): an unknown prints as this, never a 0.
import { NONE } from '../src/renderer/src/features/leveling/rangeStatsRows'
import { xpOverlayView } from '../src/renderer/src/overlay/xpRows'

const MIN = 60_000
const HOUR = 60 * MIN
/** An arbitrary, readable anchor, well behind the wall clock on purpose. */
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

/**
 * An hour of steady farming ending at `T0`, in one open zone interval, with a sample every minute.
 *
 * `unstated` makes every experience line an AT-CAP one (percentage -1, flag bit 1) — the shape the
 * game prints once the level bar stops existing, and the whole reason this window has a second
 * vocabulary. The loop stops STRICTLY BEFORE `lastTs` because `rangeStats` is half-open.
 */
function farming(opts: { pct: number; unstated?: boolean; zone?: string }): ProgressionSnap {
  const s = emptySnap()
  const start = T0 - HOUR
  for (let ts = start + MIN; ts < T0; ts += MIN) {
    s.expTs.push(ts)
    s.expPct.push(opts.unstated ? -1 : opts.pct)
    s.expFlag.push(opts.unstated ? 1 : 0)
    s.killTs.push(ts)
    s.killZone.push(0)
    s.killCredit.push(0)
  }
  s.zoneStart.push(start)
  s.zoneEnd.push(0)
  s.zoneName.push(opts.zone ?? 'Nagafen’s Lair - Solo 4 (Refined)')
  s.lastTs = T0
  return s
}

/** A ding `ms` before the end, so the ETA has an anchor to sum stated percentages from. */
function ding(s: ProgressionSnap, msBeforeEnd: number, level: number): void {
  s.levelTs.push(T0 - msBeforeEnd)
  s.levelValue.push(level)
}

/** An AA completion `ms` before the end. */
function aa(s: ProgressionSnap, msBeforeEnd: number, amount = 1): void {
  s.aaGainTs.push(T0 - msBeforeEnd)
  s.aaGainAmount.push(amount)
}

function loot(item: string, msBeforeEnd: number, zone: string, count?: number): LootEvent {
  return { ts: T0 - msBeforeEnd, item, zone, count }
}

/** The view, over the slice `id` — the same three calls the overlay component makes. */
function view(snap: ProgressionSnap, events: LootEvent[], id: SliceId = 'all', visible?: string[]): ReturnType<typeof xpOverlayView> {
  const bounds = dataBounds(snap, [])
  return xpOverlayView({
    snap,
    loot: events,
    slice: resolveSlice({ snap, bounds, id }),
    visible: normalizeXpRows(visible)
  })
}

const valueOf = (v: ReturnType<typeof xpOverlayView>, id: string): string =>
  v.rows.find((r) => r.id === id)?.value ?? '<missing>'
const labelOf = (v: ReturnType<typeof xpOverlayView>, id: string): string =>
  v.rows.find((r) => r.id === id)?.label ?? '<missing>'

// ---------------------------------------------------------------------------------------
// THE CHECKLIST — the whole of this window's configurability
// ---------------------------------------------------------------------------------------

test('an absent row list is EVERY row, and an empty one is a user who switched them all off', () => {
  assert.equal(normalizeXpRows(undefined), undefined, 'nothing stored stays nothing stored')
  for (const id of XP_ROW_IDS) assert.equal(xpRowVisible(id, undefined), true)
  // The distinction is the point: `[]` is a choice and must survive a round trip as one.
  assert.deepEqual(normalizeXpRows([]), [])
  for (const id of XP_ROW_IDS) assert.equal(xpRowVisible(id, []), false)
})

test('a stored row list is rebuilt: unknown ids dropped, duplicates collapsed, order this file’s', () => {
  assert.deepEqual(normalizeXpRows(['motes', 'xp', 'motes', 'dps', 42, null]), ['xp', 'motes'])
  // A hand-edited store cannot switch on a row this build does not have — which is the reason the
  // union is closed at all.
  assert.deepEqual(normalizeXpRows(['money']), [])
  assert.equal(normalizeXpRows('xp'), undefined, 'a non-array is not a list, it is nothing stored')
})

test('toggling a row off then on returns exactly the full set, in order', () => {
  const off = toggleXpRow('eta', undefined)
  assert.deepEqual(off, ['xp', 'motes'], 'toggling off an absent list starts from every row')
  assert.deepEqual(toggleXpRow('eta', off), [...XP_ROW_IDS])
  assert.deepEqual(toggleXpRow('xp', toggleXpRow('motes', off)), [])
})

test('a hidden row is ABSENT from the window, never present and blank', () => {
  const snap = farming({ pct: 1 })
  ding(snap, 30 * MIN, 43)
  const all = view(snap, [])
  assert.ok(all.rows.some((r) => r.row === 'xp') && all.rows.some((r) => r.row === 'eta'))
  const only = view(snap, [], 'all', ['xp'])
  assert.deepEqual(only.rows.map((r) => r.row), ['xp'])
  assert.deepEqual(view(snap, [], 'all', []).rows, [], 'all three off is an empty window, honestly')
})

// ---------------------------------------------------------------------------------------
// MOTES
// ---------------------------------------------------------------------------------------

test('the mote family is the anchored one the alert already ships, and the tier is display only', () => {
  assert.equal(isMote('Mote of Infinitesimal Potential'), true)
  assert.equal(isMote('Mote of Potential'), true, 'the tierless member is still a mote')
  assert.equal(isMote('Remote of Potential'), false, 'anchored at the start, never a substring')
  assert.equal(isMote('Bone Chips'), false)
  assert.equal(moteTier('Mote of Infinitesimal Potential'), 'Infinitesimal')
  assert.equal(moteTier('Mote of Greater Potential'), 'Greater')
  // Never shortened to nothing: the suffix goes only when something precedes it.
  assert.equal(moteTier('Mote of Potential'), 'Potential')
})

test('motes are ordered by what was OBSERVED, and a stack counts as its size', () => {
  const zone = 'Nagafen’s Lair - Solo 4 (Refined)'
  const events = [
    loot('Mote of Infinitesimal Potential', 50 * MIN, zone),
    loot('Mote of Infinitesimal Potential', 40 * MIN, zone),
    loot('Mote of Lesser Potential', 30 * MIN, zone, 3),
    loot('Bone Chips', 20 * MIN, zone, 9)
  ]
  const rows = moteRates({ events, t0: T0 - HOUR, t1: T0 + 1, activeMs: HOUR })
  assert.deepEqual(rows.map((r) => r.tier), ['Lesser', 'Infinitesimal'], 'the stack of 3 outranks two lines')
  assert.deepEqual(rows.map((r) => r.drops), [3, 2])
  // Nothing in this repo ranks the ten tiers, so the top row is only ever "the one you looted
  // most" — Bone Chips is simply not a mote and never enters at all.
  assert.equal(rows.length, 2)
  assert.equal(rows[0].perHourActive, 3, '3 in an hour of active time')
})

test('a slice with no mote says so, once, instead of leaving a blank section', () => {
  const snap = farming({ pct: 1 })
  const rows = view(snap, [loot('Bone Chips', 10 * MIN, 'Nagafen’s Lair - Solo 4 (Refined)')]).rows
  const motes = rows.filter((r) => r.row === 'motes')
  assert.equal(motes.length, 1)
  assert.equal(motes[0].detail, 'none here')
  assert.match(motes[0].title, /No upgrade mote has dropped in the whole log\./)
})

test('the ZONE half of a slice reaches the motes too — instance noise and all', () => {
  const snap = farming({ pct: 1, zone: 'Nagafen’s Lair - Solo 4 (Refined)' })
  const events = [
    // Same camp, a different instance ordinal: the MEMBERSHIP fold strips it, so this counts.
    loot('Mote of Minor Potential', 50 * MIN, 'Nagafen’s Lair - Solo 7 (Refined)'),
    loot('Mote of Minor Potential', 40 * MIN, 'Plane of Sky')
  ]
  const zoned = view(snap, events, 'zone').rows.filter((r) => r.row === 'motes')
  assert.equal(zoned.length, 1)
  assert.equal(zoned[0].detail, '1×', 'the drop in the other zone is not in this slice')
  const all = view(snap, events, 'all').rows.filter((r) => r.row === 'motes')
  assert.equal(all[0].detail, '2×')
})

// ---------------------------------------------------------------------------------------
// THE HEADLINE ROWS, AND THE CAP
// ---------------------------------------------------------------------------------------

test('below the cap the window speaks LEVELS: a pace and the level it is heading for', () => {
  const snap = farming({ pct: 1 })
  ding(snap, 30 * MIN, 43)
  const v = view(snap, [])
  assert.equal(v.atCap, false)
  assert.equal(labelOf(v, 'xp'), 'XP')
  assert.equal(valueOf(v, 'xp'), '0.59', '59 samples of 1% over one fully-active hour')
  assert.equal(v.rows.find((r) => r.id === 'xp')?.unit, 'lvl/hr')
  assert.equal(labelOf(v, 'eta'), 'Next level')
  assert.equal(v.rows.find((r) => r.id === 'eta')?.detail, 'to 44')
  assert.match(valueOf(v, 'eta'), /^~/, 'a projection wears its tilde')
  assert.equal(v.level, 43, 'the header chip is the level the log last reported')
})

// ---------------------------------------------------------------------------------------
// AA WHILE LEVELING (JOS-202) — the pace entry draws one row per measure the log is stating
// ---------------------------------------------------------------------------------------

test('AA/hr rides BESIDE the levels pace while leveling, points and all', () => {
  const snap = farming({ pct: 1 })
  ding(snap, 55 * MIN, 43)
  aa(snap, 40 * MIN, 2)
  aa(snap, 20 * MIN, 1)
  const v = view(snap, [])
  assert.equal(v.atCap, false, 'the log is still stating a level bar')
  // Both paces, in this order, under the ONE checklist entry a user switches off.
  assert.deepEqual(
    v.rows.filter((r) => r.row === 'xp').map((r) => r.id),
    ['xp', 'aa']
  )
  assert.equal(labelOf(v, 'aa'), 'AA')
  assert.equal(valueOf(v, 'aa'), '2.00', 'two completions over one fully-active hour')
  assert.equal(v.rows.find((r) => r.id === 'aa')?.unit, 'AA/hr')
  // The points the completions PAID ride as the detail — the pair the Leveling tab prints
  // together, because they diverge exactly while an item-shop bottle is running.
  assert.equal(v.rows.find((r) => r.id === 'aa')?.detail, '3.00 pts/hr')
  assert.equal(v.rows.find((r) => r.id === 'aa')?.inferred, false, 'both halves are counted lines')
  // The projection is untouched: below the cap it is still the LEVEL that is next.
  assert.equal(labelOf(v, 'eta'), 'Next level')
})

test('a slice holding no AA completion is told nothing about AA — never a row of em-dashes', () => {
  const snap = farming({ pct: 1 })
  ding(snap, 30 * MIN, 43)
  aa(snap, 90 * MIN) // an hour before this slice's window even opens
  const hour = view(snap, [], 'h1')
  assert.deepEqual(
    hour.rows.filter((r) => r.row === 'xp').map((r) => r.id),
    ['xp'],
    'the tab’s own rule (aaRateText): no completion in range, no AA read'
  )
  // …and the same record over the whole log, where the completion IS in range, does draw it.
  assert.ok(view(snap, [], 'all').rows.some((r) => r.id === 'aa'))
})

test('the AA row is the pace entry, so hiding that entry hides BOTH paces', () => {
  const snap = farming({ pct: 1 })
  aa(snap, 20 * MIN)
  const v = view(snap, [], 'all', ['eta', 'motes'])
  assert.equal(v.rows.some((r) => r.row === 'xp'), false)
  assert.deepEqual(v.rows.map((r) => r.row), ['eta', 'motes'])
})

test('AT THE CAP the levels row goes away, and the wait says it is inferred', () => {
  const snap = farming({ pct: 0, unstated: true })
  ding(snap, 50 * MIN, 50)
  aa(snap, 40 * MIN)
  aa(snap, 20 * MIN)
  const v = view(snap, [])
  assert.equal(v.atCap, true)
  // The AA row keeps the id it has below the cap — one measure, one row id, whatever the level is.
  assert.deepEqual(
    v.rows.filter((r) => r.row === 'xp').map((r) => r.id),
    ['aa'],
    'no level bar is stated, so no levels row is drawn'
  )
  assert.equal(labelOf(v, 'aa'), 'AA', 'the read that survives the cap')
  assert.equal(v.rows.find((r) => r.id === 'aa')?.unit, 'AA/hr')
  assert.equal(labelOf(v, 'eta'), 'Next AA')
  const eta = v.rows.find((r) => r.id === 'eta')
  assert.equal(eta?.inferred, true)
  assert.equal(eta?.detail, 'est.', 'the log states no AA bar position anywhere - one word says so')
})

test('at the cap the AA row is drawn even when the slice holds no completion at all', () => {
  const snap = farming({ pct: 0, unstated: true })
  const v = view(snap, [])
  assert.equal(v.atCap, true)
  // 0.00 over an hour of real active time is a measurement, not an unknown (progressionStats says
  // so: a gain line always states its amount, so this rate has no unstated-sample failure mode) —
  // and a capped window with no pace row at all would be the worse answer.
  assert.equal(valueOf(v, 'aa'), '0.00')
})

test('a refused projection is an em-dash WITH ITS REASON, never a number', () => {
  // No ding at all: there is no anchor to sum stated percentages from.
  const v = view(farming({ pct: 1 }), [])
  assert.equal(valueOf(v, 'eta'), NONE)
  assert.match(v.rows.find((r) => r.id === 'eta')?.title ?? '', /No level-up has been recorded/)
  assert.equal(v.rows.find((r) => r.id === 'eta')?.detail, '', 'nothing is claimed about a level')
})

test('the window states the span every rate on it divides by', () => {
  const snap = farming({ pct: 1 })
  assert.equal(view(snap, []).span, 'over 1h 0m active')
})

// ---------------------------------------------------------------------------------------
// THE SLICE
// ---------------------------------------------------------------------------------------

test('SESSION is a narrower stretch than ALL, and every number follows it', () => {
  const snap = farming({ pct: 1 })
  // A logout ending 20 minutes before the live edge: `session` starts at the login that closed it.
  snap.offlineStart.push(T0 - 40 * MIN)
  snap.offlineEnd.push(T0 - 20 * MIN)
  snap.offlineCamped.push(1)
  const events = [
    loot('Mote of Minor Potential', 50 * MIN, 'Nagafen’s Lair - Solo 4 (Refined)'),
    loot('Mote of Minor Potential', 10 * MIN, 'Nagafen’s Lair - Solo 4 (Refined)')
  ]
  const session = view(snap, events, 'session')
  const all = view(snap, events, 'all')
  assert.equal(session.span, 'over 20m active')
  assert.notEqual(all.span, session.span)
  // The drop from before the logout is outside this session, so the mote row counts one.
  assert.equal(session.rows.find((r) => r.row === 'motes')?.detail, '1×')
  assert.equal(all.rows.find((r) => r.row === 'motes')?.detail, '2×')
})

test('a record that states no logout cannot define a session — the pick degrades to the whole log', () => {
  const snap = farming({ pct: 1 })
  const bounds = dataBounds(snap, [])
  // `resolveSlice` answers honestly for an id the record cannot define (the control simply does
  // not offer the button), and the overlay's own `resolveSliceId` is what turns the stored
  // `session` default into `all` before it ever gets here.
  assert.equal(resolveSlice({ snap, bounds, id: 'session' }).caption, 'this session')
  assert.deepEqual(resolveSlice({ snap, bounds, id: 'session' }).range, resolveSlice({ snap, bounds, id: 'all' }).range)
})
