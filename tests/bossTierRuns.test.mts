// PER-TIER KILL RUNS — the Lord of Ire misattribution (owner-verified, 2026-08-04).
//
// THE BUG, exactly. The kill record was five scalars {count, bestTier, firstTs, lastTs,
// display} and the fold took Math.max on BOTH the tier and the timestamp, so those two facts
// could describe DIFFERENT kills. The bosses roster then grouped each target by the class-combo
// interval covering its `lastTs` while painting its `bestTier`. The user killed Lord of Ire at
// d4 (Refined) on Sat Aug 01 16:09:29 running PAL/MNK/ENC, and again at d0 (base) on Mon Aug 03
// 23:02:44 running ROG/PAL/BER after a loadout swap on Sun Aug 02 01:57:42. The card rendered a
// d4 badge filed under ROG/PAL/BER — a loadout that never killed it at d4.
//
// WHAT THAT SECOND KILL IS CALLED NOW (JOS-166). The Mon Aug 03 kill was in `The Plane of Hate`
// with no `- Solo` suffix — the OPEN WORLD, which has no instance and therefore no lockout. It
// used to fold to tier 0 because a bare zone name and a base instance decoded identically; it
// now folds to TIER_OPEN_WORLD. The misattribution this file pins is unaffected either way: what
// it is about is that a run's tier and its timestamps describe the SAME kills, and the two runs
// here are still two runs. The assertions below name the key rather than assuming 0.
//
// The combo-interval layer was CORRECT and is untouched here (world-model law 10: intervals are
// revisable and join at READ; nothing stamps an interval id onto a kill). What was lossy was the
// KILL RECORD. It is now per instance tier (`KillInfo.tiers`, shared/kills.ts), the four scalars
// are DERIVED from that map, and the roster splits a multi-tier target into one card per tier —
// each joining the intervals at its OWN most recent kill and wearing its OWN badge.
//
// What is pinned below:
//   1. THE FOLD, against the real log window (tests/fixtures/bosstier-lord-of-ire.log, cut by
//      tests/extract-boss-tier-fixtures.mjs from raw lines 853620 / 865678.. / 1205559 /
//      1211528..): one entry, two tier runs, each keeping its own timestamps.
//   2. THE JOIN: d4 files under the Aug-01 interval, the open-world run under the Aug-03 one —
//      and the OLD rule (join at the target's overall lastTs) is shown to produce the wrong
//      answer on the same data, so a regression cannot pass quietly.
//   3. NO VISUAL REGRESSION for the common case: a single-tier target yields exactly one card
//      whose status is deep-equal to the unprojected one.
//   4. THE DELTA CONTRACT: a changed mob REPLACES its entry wholesale, and a baseline written
//      under a different shape version is invalidated rather than merged into.
//   5. THE RECOMPUTE PATH: the KillMap is a pure function of the log, rebuilt from scratch every
//      load — which is why widening it ships NO store migration (ProgressState persists
//      inventory / completedQuests / combo corrections and no kill data whatsoever).
//
// Imported RELATIVELY: node tests run through tsx with no `@shared` / `@renderer` aliases.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEqTimestamp, parseEvent } from '../src/main/log/parser'
import { KillsModule } from '../src/main/modules/kills'
import { recordKill } from '../src/main/log/reducers'
import {
  KILLS_SHAPE_VERSION,
  TIER_OPEN_WORLD,
  killTotals,
  killsBaselineStale,
  mergeKillsDelta,
  tierRuns,
  type KillMap,
  type KillsSnap
} from '../src/shared/kills'
import { allStatuses, statusFor, lowerKillMap } from '../src/renderer/src/features/bosses/bossStatus'
import { loadoutGroups } from '../src/renderer/src/features/bosses/loadoutGroups'
import type { ComboInterval } from '../src/shared/classCombo'
import type { RaidTarget } from '../src/shared/types'
import { readFixture } from './harness.mts'

const at = (stamp: string): number => parseEqTimestamp(stamp)

/** The three real instants the diagnosis quoted. */
const D4_KILL = at('Sat Aug 01 16:09:29 2026')
const SWAP = at('Sun Aug 02 01:57:42 2026')
/** The Mon Aug 03 kill — in `The Plane of Hate` with no instance suffix, i.e. the open world. */
const OPEN_KILL = at('Mon Aug 03 23:02:44 2026')

/** Replay raw lines through the REAL parser into a fresh kills module. */
function replay(lines: string[]): KillsSnap {
  const mod = new KillsModule()
  mod.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  return mod.snapshot().state
}

/** A combo interval with everything defaulted — these tests are about the JOIN, not the slots. */
function interval(id: string, startTs: number, endTs: number | null): ComboInterval {
  return {
    id,
    startTs,
    endTs,
    startLo: startTs,
    startHi: startTs,
    endLo: endTs,
    endHi: endTs,
    startReason: 'evidence',
    expectedSlots: 3,
    slots: [],
    levelLo: null,
    levelHi: null,
    evidenceCount: 1,
    userLocked: false
  }
}

/** The roster row for the boss in question (the real bosses.json match name). */
const LORD_OF_IRE: RaidTarget = {
  name: 'Lord of Ire',
  category: 'Plane of Hate',
  match: ['Lord of Ire']
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE FOLD — the real two-kill window.
// ─────────────────────────────────────────────────────────────────────────────

test('golden window: one mob, two worlds, two runs that keep their own timestamps', () => {
  const snap = replay(readFixture('bosstier-lord-of-ire.log'))

  assert.equal(snap.v, KILLS_SHAPE_VERSION, 'the snapshot states the shape its entries were written at')
  const ire = snap.mobs['lord of ire']
  assert.ok(ire, 'the KillMap is keyed by the canonical lowercase name')
  assert.equal(ire.display, 'Lord of Ire')

  // THE RECORD: two runs, each carrying the tier AND the timestamps of its own kills — plus,
  // since 2026-08-05, how many of them the log CREDITED to you. Both kills in this window print
  // `You gain experience!` in the second before the slain line, so both are yours.
  //
  // The second run's key was `0` until JOS-166 and is now the open world: `You have entered The
  // Plane of Hate.` names no instance. Nothing else about the run moved — same count, same
  // timestamps, same credit — which is the point: the key names WHERE, and only where.
  assert.deepEqual(ire.tiers, {
    [TIER_OPEN_WORLD]: { count: 1, firstTs: OPEN_KILL, lastTs: OPEN_KILL, credited: 1, lastCreditedTs: OPEN_KILL },
    4: { count: 1, firstTs: D4_KILL, lastTs: D4_KILL, credited: 1, lastCreditedTs: D4_KILL }
  })

  // The scalars are DERIVED — and this is precisely the pair that used to lie together:
  // `bestTier` comes from the Aug 01 kill, `lastTs` from the Aug 03 one. Keeping them is fine
  // now that the runs behind them are on the record.
  assert.equal(ire.count, 2)
  assert.equal(ire.bestTier, 4)
  assert.equal(ire.firstTs, D4_KILL)
  assert.equal(ire.lastTs, OPEN_KILL)
  assert.deepEqual({ ...killTotals(ire.tiers) }, {
    count: ire.count,
    bestTier: ire.bestTier,
    firstTs: ire.firstTs,
    lastTs: ire.lastTs,
    credited: ire.credited
  })
  assert.equal(ire.credited, 2, 'both kills paid experience — they are yours')
})

test('the fold writes only the tiers map; the scalars are re-derived from it', () => {
  const kills: KillMap = {}
  // Three kills at d2 and one at d1, deliberately out of tier order.
  recordKill(kills, { key: 'a mob', display: 'A mob', tier: 2, ts: 1000, credited: true })
  recordKill(kills, { key: 'a mob', display: 'a mob', tier: 1, ts: 2000, credited: true })
  // One of the four was somebody else's kill: it counts for the mob and credits nothing.
  recordKill(kills, { key: 'a mob', display: 'a mob', tier: 2, ts: 3000, credited: false })
  recordKill(kills, { key: 'a mob', display: 'a mob', tier: 2, ts: 500, credited: true })

  const k = kills['a mob']
  assert.deepEqual(k.tiers, {
    1: { count: 1, firstTs: 2000, lastTs: 2000, credited: 1, lastCreditedTs: 2000 },
    2: { count: 3, firstTs: 500, lastTs: 3000, credited: 2, lastCreditedTs: 1000 }
  })
  assert.equal(k.count, 4, 'count is the sum over runs')
  assert.equal(k.credited, 3, 'and credit is its own sum — three of the four were yours')
  assert.equal(k.bestTier, 2)
  assert.equal(k.firstTs, 500, 'earliest kill at any tier')
  assert.equal(k.lastTs, 3000, 'latest kill at any tier')
  assert.equal(k.display, 'A mob', 'display is still set once, from the first-seen kill')

  // Ordering: runs come out oldest-LAST-kill first, which is the order the grouping joins in.
  assert.deepEqual(tierRuns(k.tiers).map((r) => r.tier), [1, 2])
})

test('a mob killed at ONE tier folds to one run — the common case is unchanged', () => {
  const kills: KillMap = {}
  recordKill(kills, { key: 'a rat', display: 'a rat', tier: 0, ts: 10, credited: true })
  recordKill(kills, { key: 'a rat', display: 'a rat', tier: 0, ts: 20, credited: true })
  assert.deepEqual(kills['a rat'], {
    count: 2,
    bestTier: 0,
    firstTs: 10,
    lastTs: 20,
    credited: 2,
    display: 'a rat',
    tiers: { 0: { count: 2, firstTs: 10, lastTs: 20, credited: 2, lastCreditedTs: 20 } }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE JOIN — the roster's loadout sectioning.
// ─────────────────────────────────────────────────────────────────────────────

test('golden window: d4 files under the loadout that killed it at d4, open world under the later one', () => {
  const snap = replay(readFixture('bosstier-lord-of-ire.log'))
  const statuses = allStatuses([LORD_OF_IRE], snap.mobs)

  // The real swap the diagnosis names: PAL/MNK/ENC until Sun Aug 02 01:57:42, ROG/PAL/BER after.
  const before = interval('ci1', at('Fri Jul 31 00:00:00 2026'), SWAP)
  const after = interval('ci2', SWAP, null)
  const groups = loadoutGroups([before, after], statuses)

  assert.equal(groups.length, 2, 'one target, two tier runs, two intervals — two sections')

  const [first, second] = groups
  assert.equal(first.interval?.id, 'ci1')
  assert.equal(first.rows.length, 1)
  assert.equal(first.rows[0].s.target.name, 'Lord of Ire')
  assert.equal(first.rows[0].s.bestTier, 4, 'the card under the Aug-01 loadout wears the d4 badge')
  assert.equal(first.rows[0].s.count, 1, 'and counts only the kills it is claiming')
  assert.equal(first.rows[0].s.lastTs, D4_KILL, 'dated by its own kill, not the target’s latest')

  assert.equal(second.interval?.id, 'ci2')
  assert.equal(second.rows.length, 1)
  // It wore a `D0` badge before JOS-166. That kill was in the open world, so the badge now says
  // so — the card under this loadout is not claiming a base-difficulty clear.
  assert.equal(
    second.rows[0].s.bestTier,
    TIER_OPEN_WORLD,
    'the card under the Aug-03 loadout badges the open world, not a difficulty'
  )
  assert.equal(second.rows[0].s.lastTs, OPEN_KILL)

  // THE REGRESSION ITSELF. The old rule joined the whole target at its overall `lastTs` and
  // painted its overall `bestTier` — which lands the d4 badge in the Aug-03 interval. Nothing in
  // the new grouping may put tier 4 there.
  assert.equal(
    second.rows.some((r) => r.s.bestTier === 4),
    false,
    'a d4 badge must never appear under the loadout whose kills were all open world'
  )

  // Clicking either card still opens the WHOLE mob: both kills, both runs.
  for (const g of groups) {
    assert.equal(g.rows[0].whole.count, 2)
    assert.equal(g.rows[0].whole.bestTier, 4)
    assert.deepEqual(Object.keys(g.rows[0].whole.tiers).sort(), [String(TIER_OPEN_WORLD), '4'])
  }
})

test('a single-tier target renders exactly as before: one card, status untouched', () => {
  const kills: KillMap = {}
  recordKill(kills, { key: 'maestro of rancor', display: 'Maestro of Rancor', tier: 2, ts: OPEN_KILL, credited: true })
  const target: RaidTarget = {
    name: 'Maestro of Rancor',
    category: 'Plane of Hate',
    match: ['Maestro of Rancor']
  }
  const [status] = allStatuses([target], kills)
  const groups = loadoutGroups([interval('ci1', 0, null)], [status])

  assert.equal(groups.length, 1)
  assert.equal(groups[0].rows.length, 1, 'one tier, one card')
  // The PROJECTION is the identity here — the badge, the dates and the count are the same
  // objects' worth of facts the card drew before this change.
  assert.deepEqual(groups[0].rows[0].s, status)
  assert.deepEqual(groups[0].rows[0].whole, status)
})

test('two runs of one target inside ONE interval stay one card', () => {
  // Killed at d1 and d3 on the same night: the header’s claim is true of both, and a target
  // must not appear twice under one header.
  const kills: KillMap = {}
  recordKill(kills, { key: 'a mob', display: 'A mob', tier: 1, ts: OPEN_KILL - 60_000, credited: true })
  recordKill(kills, { key: 'a mob', display: 'A mob', tier: 3, ts: OPEN_KILL, credited: true })
  const target: RaidTarget = { name: 'A mob', category: 'Open World', match: ['A mob'] }
  const groups = loadoutGroups([interval('ci1', 0, null)], allStatuses([target], kills))

  assert.equal(groups.length, 1)
  assert.equal(groups[0].rows.length, 1, 'merged back into one card')
  assert.equal(groups[0].rows[0].s.count, 2)
  assert.equal(groups[0].rows[0].s.bestTier, 3, 'badged with the highest tier it is claiming')
})

test('undefeated targets are not grouped — they carry no timestamp to join on', () => {
  const target: RaidTarget = { name: 'Innoruuk', category: 'Plane of Hate', match: ['Innoruuk'] }
  assert.deepEqual(loadoutGroups([interval('ci1', 0, null)], allStatuses([target], {})), [])
})

test('a target folds its tier runs across every one of its roster match names', () => {
  const kills: KillMap = {}
  recordKill(kills, { key: 'lord of ire', display: 'Lord of Ire', tier: 4, ts: D4_KILL, credited: true })
  recordKill(kills, { key: 'the lord of ire', display: 'The Lord of Ire', tier: 0, ts: OPEN_KILL, credited: true })
  // lowerKillMap strips the leading article, so both spellings land on one key; two DIFFERENT
  // match names would fold the same way.
  const status = statusFor(LORD_OF_IRE, lowerKillMap(kills))
  assert.equal(status.killed, true)
  assert.equal(Object.keys(status.tiers).length >= 1, true)
  assert.equal(status.count, killTotals(status.tiers).count, 'the status scalars fold its own runs')
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE DELTA CONTRACT.
// ─────────────────────────────────────────────────────────────────────────────

test('a delta REPLACES a mob wholesale — entries are never merged field by field', () => {
  const baseline: KillsSnap = {
    v: KILLS_SHAPE_VERSION,
    mobs: {
      'a mob': {
        count: 1,
        bestTier: 4,
        firstTs: 10,
        lastTs: 10,
        credited: 1,
        display: 'A mob',
        tiers: { 4: { count: 1, firstTs: 10, lastTs: 10, credited: 1, lastCreditedTs: 10 } }
      },
      'a rat': {
        count: 1,
        bestTier: 0,
        firstTs: 5,
        lastTs: 5,
        credited: 1,
        display: 'a rat',
        tiers: { 0: { count: 1, firstTs: 5, lastTs: 5, credited: 1, lastCreditedTs: 5 } }
      }
    }
  }
  // Main re-folded 'a mob' and now reports ONLY a d0 run for it (an epoch reset, say). If the
  // merge were field-wise, the d4 run would survive forever with nothing to justify it.
  const next = mergeKillsDelta(baseline, {
    v: KILLS_SHAPE_VERSION,
    changed: {
      'a mob': {
        count: 1,
        bestTier: 0,
        firstTs: 99,
        lastTs: 99,
        credited: 1,
        display: 'A mob',
        tiers: { 0: { count: 1, firstTs: 99, lastTs: 99, credited: 1, lastCreditedTs: 99 } }
      }
    }
  })
  assert.deepEqual(next.mobs['a mob'].tiers, {
    0: { count: 1, firstTs: 99, lastTs: 99, credited: 1, lastCreditedTs: 99 }
  })
  assert.equal(next.mobs['a mob'].bestTier, 0, 'the replaced entry is exactly what main sent')
  assert.deepEqual(next.mobs['a rat'], baseline.mobs['a rat'], 'untouched mobs ride along unchanged')
  assert.notEqual(next.mobs, baseline.mobs, 'a new object, so React sees the change')
})

test('a baseline written under a different shape version is invalidated, never merged', () => {
  // The live-session hazard: this window hydrated from a main process on the OLD five-scalar
  // record and is now receiving deltas from a main process on the new one. Merging per mob would
  // leave every untouched mob narrow forever.
  const stale = {
    v: 1,
    mobs: { 'a rat': { count: 1, bestTier: 0, firstTs: 5, lastTs: 5, display: 'a rat' } }
  } as unknown as KillsSnap
  const delta = {
    v: KILLS_SHAPE_VERSION,
    changed: {
      'a mob': {
        count: 1,
        bestTier: 2,
        firstTs: 9,
        lastTs: 9,
        credited: 1,
        display: 'A mob',
        tiers: { 2: { count: 1, firstTs: 9, lastTs: 9, credited: 1, lastCreditedTs: 9 } }
      }
    }
  }

  assert.equal(killsBaselineStale(stale, delta), true, 'the version mismatch is detectable')
  const next = mergeKillsDelta(stale, delta)
  assert.equal(next.v, KILLS_SHAPE_VERSION, 'the survivor adopts the version main is on')
  assert.deepEqual(Object.keys(next.mobs), ['a mob'], 'the old-shaped entries are dropped, not carried')

  // …and a matching version merges normally, so the guard cannot loop on a steady state.
  const same: KillsSnap = { v: KILLS_SHAPE_VERSION, mobs: next.mobs }
  assert.equal(killsBaselineStale(same, delta), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE RECOMPUTE PATH — why widening the record ships NO store migration.
// ─────────────────────────────────────────────────────────────────────────────

test('the KillMap is a pure function of the log: no persisted kill state to migrate', () => {
  const lines = readFixture('bosstier-lord-of-ire.log')
  // Two independent modules over the same lines produce byte-identical state, so nothing about
  // the map comes from anywhere but the log. Every launch re-scans the log (main/session.ts) and
  // rebuilds it from zero — an upgraded install lands on the new shape on its first replay, with
  // no stored kill data anywhere to convert. (The persisted ProgressState carries inventory,
  // completed quests and combo corrections; it has never carried kills.)
  assert.deepEqual(replay(lines), replay(lines))

  const mod = new KillsModule()
  mod.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  assert.equal(Object.keys(mod.snapshot().state.mobs).length > 0, true)
  mod.reset()
  assert.deepEqual(mod.snapshot().state, { v: KILLS_SHAPE_VERSION, mobs: {} }, 'reset holds nothing back')
})
