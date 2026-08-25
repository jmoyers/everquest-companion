// GOLDEN-WINDOW PROGRESSION TESTS — WL40–WL45 (docs/plans/leveling-analytics.md).
//
// METHODOLOGY (AGENTS.md): every window is a VERBATIM span of the user's real log, cut by
// tests/extract-progression-fixtures.mjs through the shared scrub, hand-read line by line, and
// replayed through the REAL parseEvent + EpochDetector + ProgressionModule before `rangeStats`
// is called over hand-chosen bounds. The expectations below are what a human counted in the
// fixture (`grep -c` on the committed file), not what the code happened to produce.
//
//   WL40  the farm run (Sun Aug 02 15:12→17:33) — ten dings, dense stated percentages. The
//         load-bearing arithmetic: Σ percent between consecutive dings ≈ 1.0 level.
//   WL41  three zones with kills in each (Sat Aug 01 13:38→14:11) — per-zone rows, self-vs-pet
//         credit, and the Σ-identities across a real travel hop.
//   WL42  idle (Mon Aug 03 00:55→14:31) — a 13-minute break AND a 12.6-hour silence.
//   WL43  AT THE CAP (Fri Jul 31 17:51→18:56) — 21 exp lines, not one of them stating a
//         percentage. THE regression: nothing may render 0.0% or a fabricated rate.
//   WL44  the loadout swap (Fri Jul 31 16:19 level 50 → Sun Aug 02 02:26 level 13) — the run
//         split, and no rate fabricated across the unlogged drop.
//   WL45  kill credit (Thu Jul 30 16:28→16:56) — all three shapes in one zone.
//   WL46  the tier swap (Sun Aug 23 13:37→15:20) — one place spelled two ways, a visit the log
//         never closed, and the two mechanisms that between them read a 1h51m Plane of Hate
//         session as 15 idle minutes (JOS-454).
//
// Plus a FULL-LOG tripwire asserting IDENTITIES and floors only (the log is live and grows;
// frozen counts rot — AND SO DO RATIOS whose denominator is the owner's play, which is what
// JOS-241 re-derived identity 5 below out of; tests/progressionJoin.mts carries the conditioning),
// skipped when the real log is absent (CI).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { parseEvent } from '../src/main/log/parser'
import { EpochDetector, LAUNCH_MS } from '../src/main/log/epochDetector'
import { EXP_CAP, ProgressionModule } from '../src/main/modules/progression'
import { rangeStats, type RangeStats } from '../src/shared/progressionStats'
// The two zone folds WL46 is about (JOS-291): the PLACE, and the exact spelling of the tier.
import { zoneKey } from '../src/shared/zones'
import { zoneIdKey } from '../src/shared/zoneScope'
import type { ProgressionSnap } from '../src/shared/progressionTypes'
import { readFixture } from './harness.mts'
import { expPairing, recentPairingRatio } from './progressionJoin.mts'

const LOG =
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Primitive_freeport.txt'

/**
 * Replay raw lines through the real parser + ProgressionModule. With `withEpoch`, the REAL
 * EpochDetector runs exactly as index.ts's feeder wires it: the primary event is folded first,
 * then the synthesized `epoch` event is delivered (bus.emitDerived semantics).
 */
function replay(lines: string[], withEpoch = false): ProgressionSnap {
  const mod = new ProgressionModule()
  mod.reset()
  const epoch = new EpochDetector()
  epoch.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    mod.onEvent(ev, false)
    if (withEpoch) {
      const epochEv = epoch.observe(ev)
      if (epochEv) mod.onEvent(epochEv, false)
    }
  }
  return mod.snapshot().state
}

const T = (stamp: string): number => Date.parse(stamp)

/** The whole fixture as one range: from its first sample to just past its last event. */
function wholeOf(snap: ProgressionSnap): RangeStats {
  const firsts = [snap.expTs[0], snap.killTs[0], snap.lootTs[0], snap.zoneStart[0]].filter(
    (v): v is number => v !== undefined
  )
  return rangeStats({ snap, range: { t0: Math.min(...firsts), t1: snap.lastTs + 1000 } })
}

/** The four Σ-identities every RangeStats must satisfy, whatever the data. */
function assertIdentities(r: RangeStats, label: string): void {
  const sum = (f: (z: RangeStats['zones'][number]) => number): number => r.zones.reduce((n, z) => n + f(z), 0)
  assert.equal(sum((z) => z.spanMs), r.durationMs, `${label}: Σ zone span == duration`)
  assert.equal(sum((z) => z.kills), r.kills, `${label}: Σ zone kills == kills`)
  assert.equal(sum((z) => z.expSamples), r.expSamples, `${label}: Σ zone exp samples == expSamples`)
  assert.equal(sum((z) => z.idleMs), r.idleMs, `${label}: Σ zone idle == idleMs`)
  assert.equal(r.activeMs + r.idleMs, r.durationMs, `${label}: active + idle == duration`)
  assert.equal(r.killsSelf + r.killsPet, r.kills, `${label}: credit halves sum to kills`)
}

/** Every `*Ts` column of a snapshot, for the ordering / epoch-floor sweeps. */
function timeColumns(snap: ProgressionSnap): number[][] {
  return [snap.expTs, snap.killTs, snap.witnessTs, snap.lootTs, snap.zoneStart, snap.levelTs, snap.aaGainTs]
}

/**
 * The structural contract of the columnar snapshot: post-epoch, index-aligned, ascending,
 * with contiguous half-open zone intervals and the unstated-percentage SENTINEL intact. All of
 * it is what `rangeStats`' binary searches assume, so a violation would silently mis-slice.
 */
function assertColumnsWellFormed(snap: ProgressionSnap): void {
  for (const col of timeColumns(snap)) {
    if (col.length) assert.ok(col[0] >= LAUNCH_MS, 'every retained sample is post-launch')
    for (let i = 1; i < col.length; i++) assert.ok(col[i] >= col[i - 1], 'ascending')
  }
  assert.equal(snap.expPct.length, snap.expTs.length)
  assert.equal(snap.expFlag.length, snap.expTs.length)
  assert.equal(snap.killZone.length, snap.killTs.length)
  assert.equal(snap.killCredit.length, snap.killTs.length)
  assert.equal(snap.zoneEnd.length, snap.zoneStart.length)
  assert.equal(snap.zoneName.length, snap.zoneStart.length)
  assert.equal(snap.aaGainAmount.length, snap.aaGainTs.length)
  assert.equal(snap.levelValue.length, snap.levelTs.length)
  for (let i = 0; i + 1 < snap.zoneStart.length; i++) {
    assert.equal(snap.zoneEnd[i], snap.zoneStart[i + 1], 'intervals abut with no gap and no overlap')
  }
  assert.equal(snap.zoneEnd[snap.zoneEnd.length - 1], 0, 'the last interval is still open')
  for (let i = 0; i < snap.expTs.length; i++) {
    if ((snap.expFlag[i] & 1) !== 0) assert.equal(snap.expPct[i], -1, 'unstated is the sentinel, not zero')
    else assert.ok(snap.expPct[i] > 0, 'a stated percentage is always positive')
  }
}

/** The identities must hold for ANY sub-range, not just the whole span. Deterministic PRNG so
 *  a failure is reproducible; the ranges themselves are anchor-independent by construction. */
function assertSubRangeIdentities(snap: ProgressionSnap, whole: RangeStats): void {
  let seed = 20260803
  const rand = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = 0; i < 20; i++) {
    const a = whole.t0 + rand() * whole.durationMs
    const b = whole.t0 + rand() * whole.durationMs
    assertIdentities(rangeStats({ snap, range: { t0: Math.min(a, b), t1: Math.max(a, b) } }), `sub-range ${i}`)
  }
}

/**
 * Σ stated percent between consecutive dings ≈ 1.0 level, for every ding pair whose interval
 * is free of unstated samples and does not cross a loadout swap. Returns how many pairs
 * qualified (a count, not an anchor — it grows as the user plays).
 */
function dingIntervalsAreOneLevel(snap: ProgressionSnap): number {
  let checked = 0
  for (let i = 1; i < snap.levelTs.length; i++) {
    if (snap.levelValue[i] < snap.levelValue[i - 1]) continue
    const seg = rangeStats({ snap, range: { t0: snap.levelTs[i - 1], t1: snap.levelTs[i] } })
    if (seg.expUnstated > 0 || seg.expSamples === 0) continue
    assert.ok(
      seg.levelEquiv >= 0.9 && seg.levelEquiv <= 1.1,
      `level ${snap.levelValue[i - 1]}→${snap.levelValue[i]} summed to ${seg.levelEquiv}`
    )
    checked++
  }
  return checked
}

// ─────────────────────────────────────────────────────────────────────────────
// WL40 — THE FARM RUN. Hand-read from tests/fixtures/wl40-farm-run.log (raw 987818–1017315):
//   15:12:00 Welcome to level 18!  …  17:33:26 Welcome to level 28!   (11 ding lines)
//   `grep -c 'You gain .*experience'` = 324, none of them percent-less, none of them party.
//   `grep -c 'You have slain'` = 327; the three `has been slain by <other>` lines are the only
//   other kill lines and none of their killers is ever bound as a pet in the window.
//   The five zone lines only start at 16:34:05, so the first 82 minutes are the `unknown` row.
test('WL40 farm run: ten dings, and Σ percent between consecutive dings is ~1.0 level', () => {
  const snap = replay(readFixture('wl40-farm-run.log'))
  const r = rangeStats({
    snap,
    range: { t0: T('Sun Aug 02 15:12:00 2026'), t1: T('Sun Aug 02 17:33:27 2026') }
  })

  assert.equal(r.expSamples, 324, 'every exp line in the window')
  assert.equal(r.expUnstated, 0, 'below the cap the game always states a percentage')
  assert.equal(r.expParty, 0, 'a solo run — no group-mate paid this exp')
  assert.equal(r.kills, 327, 'credited kills')
  assert.equal(r.killsSelf, 327)
  assert.equal(r.killsPet, 0, 'this loadout has no pet')
  assert.equal(r.killsWitnessed, 3, 'three kills by other players, excluded from every rate')
  assert.deepEqual(r.levelUps.map((l) => l.level), [18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28])
  assert.equal(r.levelRuns.length, 1, 'one unbroken run — no swap here')
  assert.deepEqual(r.levelRuns[0].fromLevel, 18)
  assert.deepEqual(r.levelRuns[0].toLevel, 28)

  // THE LOAD-BEARING ARITHMETIC. The percentage is an INCREMENT of the current level's bar, so
  // summing it between two consecutive dings must land on one level. Every one of the ten pairs
  // in this window does (measured spread 0.9667 … 1.0224 — three-decimal rounding per line).
  const dings = r.levelUps
  for (let i = 1; i < dings.length; i++) {
    const seg = rangeStats({ snap, range: { t0: dings[i - 1].ts, t1: dings[i].ts } })
    assert.ok(
      seg.levelEquiv > 0.95 && seg.levelEquiv < 1.05,
      `level ${dings[i - 1].level}→${dings[i].level} summed to ${seg.levelEquiv}, not ~1 level`
    )
    assert.equal(seg.expUnstated, 0)
  }
  // Ten level bars filled + the partway-through-28 remainder.
  assert.ok(r.levelEquiv > 9.9 && r.levelEquiv < 10.1, `levelEquiv ${r.levelEquiv}`)

  // ONE ~14-minute travel gap (16:32 → 16:46), the only silence over IDLE_GAP_MS.
  assert.equal(r.idleGaps, 1)
  assert.equal(r.idleMs, 823_000)
  assert.equal(r.durationMs, 8_487_000)

  // The window opens 82 minutes before its first zone line, so that time is an `unknown` row —
  // the pre-first-zone remainder, which is what makes Σ span == duration an identity.
  assert.deepEqual(
    r.zones.map((z) => z.zone),
    ['unknown', 'Innothule Swamp', 'The City of Guk', 'The Ruins of Old Guk']
  )
  const guk = r.zones.find((z) => z.zone === 'The Ruins of Old Guk')!
  assert.equal(guk.visits, 3, 'three entry lines for the same zone — three visits, one row')
  assert.equal(guk.kills, 107)
  assert.equal(guk.expSamples, 107)
  assertIdentities(r, 'WL40')
})

// ─────────────────────────────────────────────────────────────────────────────
// WL41 — MULTI-ZONE. Hand-read from tests/fixtures/wl41-multizone.log (raw 822348–834348):
//   13:38:00 entered The Plane of Hate - Solo 1 (Awakened)
//   13:56:57 entered The Oasis of Marr
//   13:58:08 entered The Plane of Hate - Solo 2 (Adaptive)
//   `grep -c 'You have slain'` = 7. All ten `has been slain by` lines name Innoruuk`s Chosen,
//   which the window itself binds (`Innoruuk\`s Chosen has been charmed.`), so all ten are
//   CREDITED pet kills and nothing here is merely witnessed.
test('WL41 multi-zone: kills and time attribute to the zone they happened in', () => {
  const snap = replay(readFixture('wl41-multizone.log'))
  const r = wholeOf(snap)

  assert.deepEqual(snap.zoneName, [
    'The Plane of Hate - Solo 1 (Awakened)',
    'The Oasis of Marr',
    'The Plane of Hate - Solo 2 (Adaptive)'
  ], 'RAW display names, instance suffix and all (law 2)')
  assert.equal(r.zones.length, 3, 'the range opens exactly on the first zone line — no unknown row')

  assert.equal(r.kills, 17)
  assert.equal(r.killsSelf, 7)
  assert.equal(r.killsPet, 10, 'the charmed pet is bound INSIDE the window')
  assert.equal(r.killsWitnessed, 0)
  assert.deepEqual(
    r.zones.map((z) => [z.zone, z.kills, z.killsSelf, z.killsPet, z.visits]),
    [
      ['The Plane of Hate - Solo 1 (Awakened)', 10, 4, 6, 1],
      ['The Oasis of Marr', 2, 2, 0, 1],
      ['The Plane of Hate - Solo 2 (Adaptive)', 5, 1, 4, 1]
    ]
  )
  // The two Plane of Hate instance TIERS are different raw names and stay different rows here —
  // merging them by base name is a DISPLAY choice (the band strip), never a counting one.
  assert.equal(r.zones[0].spanMs, 1_077_000)
  assert.equal(r.zones[1].spanMs, 71_000)
  assert.equal(r.zones[2].spanMs, 832_000)

  // Continuous play: not one gap over five minutes anywhere in 33 minutes.
  assert.equal(r.idleGaps, 0)
  assert.equal(r.idleMs, 0)
  assert.equal(r.activeMs, r.durationMs)
  assertIdentities(r, 'WL41')
})

/**
 * WL41, AGAIN — THIS TIER vs EVERY TIER OF THE ZONE (JOS-291), over the real tiered names.
 *
 * This window is the shape the ticket is about, printed by the actual game: ONE camp the log spells
 * two ways (`The Plane of Hate - Solo 1 (Awakened)` and `- Solo 2 (Adaptive)`) with a different zone
 * in between, and the counts in each hand-read above. So the two memberships have measurably
 * different answers here and neither of them is a synthetic construction.
 *
 * THE DEFAULT IS PINNED FIRST AND BYTE FOR BYTE: absent `zoneExactKey` is `null` is the read this
 * app has given since JOS-130, over the same golden window whose every number is hand-counted a few
 * lines up. Then the exact-tier reads, and then the property that makes the option honest rather
 * than merely narrower — the tiers PARTITION the camp, so nothing is lost or double-counted by
 * asking the question the other way.
 */
test('WL41 tiers: all-tiers is the unchanged read, and exact-tier admits one spelling', () => {
  const snap = replay(readFixture('wl41-multizone.log'))
  const range = { t0: snap.zoneStart[0], t1: snap.lastTs + 1000 }
  const solo1 = 'the plane of hate - solo 1 (awakened)'
  const solo2 = 'the plane of hate - solo 2 (adaptive)'

  // 1. THE DEFAULT, BYTE-IDENTICAL — with the argument, without it, filtered and unfiltered.
  assert.deepEqual(rangeStats({ snap, range, zoneExactKey: null }), rangeStats({ snap, range }))
  assert.deepEqual(
    rangeStats({ snap, range, zoneKey: 'plane of hate', zoneExactKey: null }),
    rangeStats({ snap, range, zoneKey: 'plane of hate' })
  )

  // 2. ALL TIERS is the place: both spellings in, the Oasis hop out.
  const every = rangeStats({ snap, range, zoneKey: 'plane of hate' })
  assert.equal(every.kills, 15, '10 in the first tier + 5 in the second, and none of the 2 in Marr')
  assert.equal(every.durationMs, 1_077_000 + 832_000, 'and the time is Σ of the two visits')
  assert.equal(every.zones.length, 2, 'two spellings, two ROWS — the join fold is untouched by this')

  // 3. EXACT TIER is the spelling. Each one alone, and the neighbour tier is as far out as Marr is.
  const first = rangeStats({ snap, range, zoneKey: 'plane of hate', zoneExactKey: solo1 })
  assert.equal(first.kills, 10)
  assert.equal(first.durationMs, 1_077_000)
  assert.deepEqual(first.zones.map((z) => z.zone), ['The Plane of Hate - Solo 1 (Awakened)'])
  const second = rangeStats({ snap, range, zoneKey: 'plane of hate', zoneExactKey: solo2 })
  assert.equal(second.kills, 5)
  assert.equal(second.durationMs, 832_000)
  assert.deepEqual(second.zones.map((z) => z.zone), ['The Plane of Hate - Solo 2 (Adaptive)'])

  // 4. THE TIERS PARTITION THE CAMP. Nothing is lost between the two questions and nothing is
  //    counted twice — the same claim tests/timeslice.test.mts makes for the zones of a range.
  assert.equal(first.kills + second.kills, every.kills)
  assert.equal(first.durationMs + second.durationMs, every.durationMs)
  assert.equal(first.expSamples + second.expSamples, every.expSamples)
  assert.equal(first.activeMs + second.activeMs, every.activeMs)

  // 5. …and the tiers really do read differently, which is the whole reason the option exists: the
  //    first tier of this camp paid a different rate from the second.
  assert.notEqual(first.killsPerHourActive, second.killsPerHourActive)
})

// ─────────────────────────────────────────────────────────────────────────────
// WL42 — IDLE. Hand-read from tests/fixtures/wl42-idle-gap.log (raw 1100597–1110597):
//   00:54:58  entered Innothule Swamp — the range opens here, but the first ACTIVITY
//             (exp/kill/loot) is 01:09:27, so the opening 14m29s is silence with nothing
//             before it: idle by the same rule, anchored at the range edge.
//   01:10:07 → 01:23:22  13m15s   (a break: over the threshold, well under an hour)
//   01:33:16 → 14:11:28  12h38m   (overnight — the game may not even have been running)
// The whole window is 13h37m wall, of which 30m33s is active.
test('WL42 idle: a break and an overnight silence, attributed to the zone you stood in', () => {
  const snap = replay(readFixture('wl42-idle-gap.log'))
  const r = wholeOf(snap)

  assert.equal(r.idleThresholdMs, 5 * 60_000, 'the threshold is surfaced, never implicit')
  assert.equal(r.idleGaps, 3, 'the leading edge silence + the 13m break + the overnight')
  assert.equal(r.durationMs, 48_989_000)
  assert.equal(r.idleMs, 47_156_000)
  assert.equal(r.activeMs, 1_833_000)
  // The WHOLE gap counts, not `gap - threshold`: the threshold is a classifier, not a grace
  // period. 14m29s + 13m15s + 12h38m ≈ 13h6m, which is exactly idleMs.
  assert.equal(r.activeMs + r.idleMs, r.durationMs)

  // The overnight silence happened IN The Ruins of Old Paineel, and that is where it lands.
  const paineel = r.zones.find((z) => z.zone === 'The Ruins of Old Paineel')!
  assert.equal(paineel.visits, 4)
  assert.equal(paineel.idleMs, 45_673_000)
  assert.equal(paineel.activeMs, 1_793_000)
  assert.equal(paineel.kills, 36)
  // Every travel zone on the way there is pure idle — you were passing through, not playing.
  for (const z of r.zones) {
    if (z.zone === 'The Ruins of Old Paineel' || z.zone === 'The Northern Desert of Ro') continue
    assert.equal(z.kills, 0, `${z.zone} was a waypoint`)
    assert.equal(z.idleMs, z.spanMs, `${z.zone} is entirely idle`)
    assert.equal(z.levelsPerHourActive, null, `${z.zone}: no active time ⇒ no rate, never 0`)
  }
  assertIdentities(r, 'WL42')
})

// ─────────────────────────────────────────────────────────────────────────────
// WL43 — AT THE CAP. Hand-read from tests/fixtures/wl43-capped-no-pct.log (raw 693485–707000):
//   `grep -c 'You gain .*experience'` = 21 and `grep -c 'experience! ('` = 0 — not one of them
//   states a percentage. The character hit level 50 at 16:19 and does not ding again for 34 h,
//   so there is no level bar for the game to report progress against.
//   14 `You have slain`; 7 `has been slain by`, of which 5 name "a fire giant warrior" (charmed
//   inside the window ⇒ credited) and 2 name Dranix / a fire giant wizard (witnessed).
//   One AA gain of 2 points lands inside the window.
test('WL43 at the cap: unstated percentages are unknown, never zero, and never a rate', () => {
  const snap = replay(readFixture('wl43-capped-no-pct.log'))
  const r = wholeOf(snap)

  assert.equal(r.expSamples, 21, 'the experience was real — 21 lines of it')
  assert.equal(r.expUnstated, 21, 'and the log stated the size of exactly none of it')
  assert.equal(r.expParty, 1, 'one of them is the party shape')
  assert.equal(r.levelEquiv, 0, 'nothing stated ⇒ nothing summed (an unstated line is NOT 0%)')

  // THE REGRESSION THAT MATTERS. levelEquiv is 0 here because the log said nothing, not because
  // no progress was made — so every LEVELS rate must be null. A "0.0 levels/hr" on this window
  // would be a fabricated number (law 1: unknown is not zero).
  assert.equal(r.levelsPerHourActive, null)
  assert.equal(r.levelsPerHourWall, null)
  for (const z of r.zones) {
    assert.equal(z.levelsPerHourActive, null, `${z.zone}: no stated sample ⇒ no levels rate`)
    assert.equal(z.levelEquiv, 0)
  }
  // Kills ARE fully observable at the cap, so their rate is not null — the two facts are
  // independent and the panel must not blank both because one is unknown.
  assert.ok(r.killsPerHourActive !== null && r.killsPerHourActive > 0)

  assert.equal(r.kills, 19)
  assert.equal(r.killsSelf, 14)
  assert.equal(r.killsPet, 5)
  assert.equal(r.killsWitnessed, 2)
  assert.equal(r.aaGained, 2, 'AA still accrues at the cap')
  assert.equal(r.aaGainEvents, 1)
  assert.deepEqual(r.levelUps, [], 'no ding — that is the whole point of the window')

  // Instance re-entry bounces produce distinct RAW names; four intervals, four rows plus the
  // pre-first-zone remainder.
  assert.deepEqual(r.zones.map((z) => z.zone), [
    'unknown',
    "Nagafen's Lair",
    "Nagafen's Lair - Solo 2 (Adaptive)",
    "Nagafen's Lair - Group 3 (Fused)"
  ])
  assertIdentities(r, 'WL43')
})

// ─────────────────────────────────────────────────────────────────────────────
// WL44 — THE LOADOUT SWAP. Hand-read from tests/fixtures/wl44-swap-boundary.log
// (raw 669590–975780). The only four ding lines in the span:
//   Fri Jul 31 16:19:04  Welcome to level 50!   ← last ding of the PAL/MNK/ENC loadout
//   … a class is swapped in; the reported level falls to 10 with NO log line of any kind …
//   Sun Aug 02 02:13:34  Welcome to level 11!
//   Sun Aug 02 02:20:00  Welcome to level 12!
//   Sun Aug 02 02:26:50  Welcome to level 13!
// The span also swallows the whole at-the-cap window — all 502 percent-less exp lines in the
// post-epoch log sit inside it, alongside 175 that DO state a percentage.
test('WL44 swap boundary: the drop opens a new run, and no rate is fabricated across it', () => {
  const snap = replay(readFixture('wl44-swap-boundary.log'))
  const r = wholeOf(snap)

  assert.deepEqual(r.levelUps.map((l) => l.level), [50, 11, 12, 13], 'the drop to 10 is never logged')
  assert.equal(r.levelRuns.length, 2, 'one break, at the swap')
  assert.deepEqual(
    r.levelRuns.map((run) => [run.fromLevel, run.toLevel]),
    [[50, 50], [11, 13]]
  )
  // No run ever spans the drop, and none of them descends — the run boundary IS the honest
  // statement that the gap between 50 and 11 is not a "time to level".
  for (const run of r.levelRuns) {
    assert.ok(run.toLevel >= run.fromLevel, 'a run never descends')
    assert.ok(run.endTs >= run.startTs, 'a run never has a negative span')
  }
  assert.equal(r.levelRuns[0].endTs, T('Fri Jul 31 16:19:04 2026'))
  assert.equal(r.levelRuns[1].startTs, T('Sun Aug 02 02:13:34 2026'))
  assert.ok(
    r.levelRuns[1].startTs - r.levelRuns[0].endTs > 33 * 3_600_000,
    'the 34-hour hole between the runs is the unlogged swap, not a level that took 34 hours'
  )

  // The at-cap window inside this span: 502 unstated samples that contribute nothing to
  // levelEquiv, while the 175 stated ones still do. A partial answer, correctly labeled.
  assert.equal(r.expUnstated, 502)
  assert.equal(r.expSamples, 677)
  assert.equal(r.expParty, 28)
  assert.ok(r.levelEquiv > 4.0 && r.levelEquiv < 4.05, `levelEquiv ${r.levelEquiv} from the stated samples only`)
  assert.notEqual(r.levelsPerHourActive, null, 'some samples WERE stated, so a floor rate is honest')

  assert.equal(r.kills, r.killsSelf + r.killsPet)
  assert.ok(r.killsPet > 0, 'the pre-swap loadout had a pet')
  assertIdentities(r, 'WL44')
})

// ─────────────────────────────────────────────────────────────────────────────
// WL45 — KILL CREDIT. Hand-read from tests/fixtures/wl45-kill-credit.log (raw 492616–500616),
// one zone (Nagafen's Lair - Solo) and all three shapes:
//   8 × `You have slain X!`                                        → yours
//   2 × `… has been slain by Garab!` + 1 × `… by Jenartik!`        → your pets (both bound in
//        the window by `<Name> told you, '… Master.'`)             → credited, INFERRED
//   1 × `… by Gobantik!` + 2 × `… by a fire giant warrior!`        → somebody else's kills
test('WL45 kill credit: yours + your pet count; everybody else is witnessed only', () => {
  const snap = replay(readFixture('wl45-kill-credit.log'))
  const r = wholeOf(snap)

  assert.equal(r.kills, 11)
  assert.equal(r.killsSelf, 8)
  assert.equal(r.killsPet, 3)
  assert.equal(r.killsSelf + r.killsPet, r.kills, 'the two halves are the whole')
  assert.equal(r.killsWitnessed, 3, 'Gobantik and the two fire-giant-warrior kills')

  // THE POINT: witnessed kills never enter a rate. If they did, kills/hr would be 14/duration.
  assert.equal(r.killsPerHourActive, 11 / (r.activeMs / 3_600_000))

  assert.equal(r.zones.length, 1)
  assert.equal(r.zones[0].zone, "Nagafen's Lair - Solo")
  assert.equal(r.zones[0].kills, 11)
  assert.equal(r.zones[0].killsPet, 3)
  assert.equal(r.expSamples, 11)
  assert.equal(r.expUnstated, 0)
  assert.ok(r.levelEquiv > 0.21 && r.levelEquiv < 0.22)
  assertIdentities(r, 'WL45')
})

// ─────────────────────────────────────────────────────────────────────────────
// WL46 — THE OWNER'S 2026-08-23 SCREENSHOT, AS BYTES (JOS-454). One place spelled two ways, the
// step out of the instance, and what a selection across the whole afternoon then reads.
//
// tests/fixtures/wl46-hate-tier-swap.log is raw 2441268–2466682 — Sun Aug 23 13:37:51 → 15:20:30,
// cut at the instant the record stood when he took the shot. The five zone lines are hand-read
// off the file: plain `The Plane of Hate` (76 s), `The Plane of Hate 4 (Refined)` for 1h35m, a
// 27-second re-entry to the instance, then plain `The Plane of Hate` twice with the last interval
// left OPEN.
//
// TWO SEPARATE FACTS ARE PINNED HERE, and the report was both of them at once:
//
//   1. `exactTier` MEMBERSHIP. `zones.zoneKey` folds both spellings to `plane of hate`, so
//      `allTiers` sees the whole afternoon; `zoneScope.zoneIdKey` does not, so the tier the log
//      LAST named — plain Hate, because he had just walked out — admits only the 76 s + 82 s +
//      the open tail. Every kill, every experience line and the ding are in the instance tier and
//      fall outside it. This is not a bug in this file's arithmetic; it is JOS-332's opening
//      ruling meeting a case its own safety argument did not cover, and the numbers below are
//      what it costs. The FIX for it is on the panel (`rangeStatsRows.membershipText`) — the
//      elapsed span now says what it left out — and in a ruling, not here.
//
//   2. THE OPEN INTERVAL × AN UNCLAMPED RANGE. `zoneSegments` closes a still-open visit at the
//      END OF THE RANGE, so a range reaching past the record hands the plain-Hate tail every
//      millisecond of that overhang. The owner's selection ended at 15:29:55 against a record
//      that had stopped: 13m11s of the 15m27s this reads is chart gutter. `windowScope`'s clamp
//      (JOS-454) is what removes it, and the second half of this test is the before/after of
//      exactly that subtraction, over these bytes.
//
// One honest note about `activeMs`, so the number is not read as more than it is: in the LIVE
// record the 13:38 head sits inside a silence that began before the fixture's first line, so the
// owner's panel read `0s active`. Here the walk has nothing before its own left edge to bracket
// against, so the head reads as 54 s of activity. The fixture cannot carry a gap whose other end
// it does not contain, and that is a property of cutting a window, not of the fold.
test('WL46 tier swap: one place, two spellings, and the visit that is still open', () => {
  const snap = replay(readFixture('wl46-hate-tier-swap.log'))
  assert.deepEqual(snap.zoneName, [
    'The Plane of Hate',
    'The Plane of Hate 4 (Refined)',
    'The Plane of Hate 4 (Refined)',
    'The Plane of Hate',
    'The Plane of Hate'
  ])
  assert.equal(snap.zoneEnd[4], 0, 'he never left the last one, so the log never closed it')
  // The afternoon's play, all of it inside the instance tier.
  assert.equal(snap.expTs.length, 68)
  assert.equal(snap.killTs.length, 65)
  assert.equal(snap.witnessTs.length, 4)
  assert.equal(snap.levelTs.length, 1, 'one ding — the curve the owner watched rise')
})

test('WL46: the tier the log last named excludes the whole session, and says nothing about it', () => {
  const snap = replay(readFixture('wl46-hate-tier-swap.log'))
  const range = { t0: T('2026-08-23T13:38:20'), t1: T('2026-08-23T15:29:55') }
  const place = zoneKey('The Plane of Hate')

  // Unrestricted, and `allTiers` — the same read, because the place fold admits both spellings.
  const all = rangeStats({ snap, range })
  const tiers = rangeStats({ snap, range, zoneKey: place })
  // Every MEASURE agrees — the place fold admits both spellings, which is JOS-130 unchanged. Not
  // `deepEqual`, and the one field that differs is worth naming: a zone filter clips its idle
  // spans to the visits, so a silence straddling a zone line is SPLIT and `idleGaps` counts 7
  // where the unfiltered read counts 4. Same milliseconds, more pieces — `subtractSpans`' own
  // documented behaviour, and measured here rather than papered over.
  for (const f of ['durationMs', 'activeMs', 'idleMs', 'kills', 'expSamples', 'levelEquiv'] as const) {
    assert.equal(tiers[f], all[f], `every tier: ${f} matches the unfiltered read`)
  }
  assert.ok(tiers.idleGaps >= all.idleGaps, 'clipping a silence to the visits can only split it further')
  assert.equal(all.durationMs, range.t1 - range.t0, 'unfiltered, elapsed IS the range')
  assert.equal(all.kills, 65)
  assert.equal(all.expSamples, 68)

  // …and the tier he was standing in when he looked.
  const exact = rangeStats({ snap, range, zoneKey: place, zoneExactKey: zoneIdKey('The Plane of Hate') })
  assert.equal(exact.durationMs, 927_000, 'THE SCREENSHOT: 15m 27s of a 1h 51m selection')
  assert.equal(exact.kills, 0, 'every kill was in the instance tier')
  assert.equal(exact.expSamples, 0)
  assert.equal(exact.levelEquiv, 0)
  // 0.0, not an em-dash, and that is the CORRECT reading: `levelsUnknown` nulls a rate only when
  // experience lines existed and stated no percentage (law 1). Here there were no lines at all,
  // so zero progress is a fact rather than an absence of one. (On the owner's live record the
  // active clock was 0 too, which nulls it on the other rule — see this block's header note.)
  assert.equal(exact.levelsPerHourActive, 0)

  // EXACT IS A NARROWING OF ALL, never a different question (JOS-291) — count for count.
  const other = rangeStats({ snap, range, zoneKey: place, zoneExactKey: zoneIdKey('The Plane of Hate 4 (Refined)') })
  assert.equal(exact.durationMs + other.durationMs, all.durationMs, 'the two tiers partition the place')
  assert.equal(exact.kills + other.kills, all.kills)
  assert.equal(exact.expSamples + other.expSamples, all.expSamples)
  assertIdentities(exact, 'WL46 exact')
  assertIdentities(other, 'WL46 hate4')
})

test('WL46: an OPEN visit turns every millisecond past the record into time in that zone', () => {
  const snap = replay(readFixture('wl46-hate-tier-swap.log'))
  const t0 = T('2026-08-23T13:38:20')
  const args = { zoneKey: zoneKey('The Plane of Hate'), zoneExactKey: zoneIdKey('The Plane of Hate') }

  // What the chart's trailing gutter selected…
  const padded = rangeStats({ snap, range: { t0, t1: T('2026-08-23T15:29:55') }, ...args })
  // …and what the record actually holds. `windowScope.statsRangeFor` is the clamp that makes the
  // second one the range every number is measured over; this asserts WHY it has to.
  const clamped = rangeStats({ snap, range: { t0, t1: snap.lastTs + 1 }, ...args })

  assert.equal(clamped.durationMs, 136_001, 'the two real plain-Hate visits, and nothing else')
  assert.equal(
    padded.durationMs - clamped.durationMs,
    T('2026-08-23T15:29:55') - (snap.lastTs + 1),
    'every millisecond of the overhang was booked as standing in the zone — the open interval absorbs it ALL'
  )
  assert.equal(padded.kills, clamped.kills, 'and it invents no events, which is what makes it pure idle')
  assert.equal(clamped.idleMs, 0, 'the honest range holds no qualifying silence at all')
  assert.ok(padded.idleMs > 14 * 60_000, 'while the padded one is almost entirely manufactured silence')
})

// ─────────────────────────────────────────────────────────────────────────────
// RETENTION. The caps are a drop-oldest ring, and `windowStart` is the honest label for what
// aged out — the panel refuses to render a selection reaching below it rather than quietly
// under-counting. Driven with synthesized events (the real log is three orders of magnitude
// under EXP_CAP, so no fixture can reach this).
test('retention: the exp cap drops oldest-first and publishes an honest floor', () => {
  const mod = new ProgressionModule()
  mod.reset()
  const base = T('Sat Aug 01 00:00:00 2026')
  const n = EXP_CAP + 3000
  for (let i = 0; i < n; i++) {
    mod.onEvent({ kind: 'expGain', seq: i, ts: base + i * 1000, raw: '', party: false, pct: 1 }, false)
  }
  const snap = mod.snapshot().state

  // The cap is a FLOOR on retention: the column never holds fewer than EXP_CAP samples, and
  // never more than one trim batch beyond it.
  assert.ok(snap.expTs.length >= EXP_CAP, `kept ${snap.expTs.length}`)
  assert.ok(snap.expTs.length < EXP_CAP + 1100, 'trimmed back promptly')
  assert.equal(snap.dropped, n - snap.expTs.length, 'every dropped sample is accounted for')
  assert.ok(snap.dropped > 0, 'the cap actually bit')

  // OLDEST-first: what survives is the tail of the stream, and the floor is its first sample.
  assert.equal(snap.expTs[snap.expTs.length - 1], base + (n - 1) * 1000, 'the newest sample is kept')
  assert.equal(snap.windowStart, snap.expTs[0], 'the floor IS the oldest surviving timestamp')
  assert.ok(snap.windowStart > base, 'and it has moved forward off the start of the stream')

  // A selection reaching below the floor is CLIPPED; one that starts at it is not.
  assert.equal(rangeStats({ snap, range: { t0: base, t1: snap.lastTs } }).clipped, true)
  assert.equal(rangeStats({ snap, range: { t0: snap.windowStart, t1: snap.lastTs } }).clipped, false)
  // Uncapped series are untouched by any of this.
  assert.equal(snap.levelTs.length, 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// FULL-LOG TRIPWIRE — IDENTITIES AND FLOORS ONLY. The real log is live and grows every session,
// so there are no fixed counts here. Skipped when the real log is absent (CI).
test('full-log replay: progression identities hold and the epoch floor is respected', { skip: !existsSync(LOG) }, () => {
  const snap = replay(readFileSync(LOG, 'utf8').split(/\r?\n/), true)
  const r = wholeOf(snap)
  assert.ok(r.expSamples > 0 && r.kills > 0, 'the current character has played')

  // 1. THE EPOCH FLOOR — nothing the wiped beta character did may appear.
  // 2. Columns are index-aligned + ascending, zone intervals contiguous (the binary search's
  //    whole premise), and an unstated sample is the -1 sentinel, never 0.
  assertColumnsWellFormed(snap)

  // 3. The Σ-identities over the whole span, and over 20 deterministic sub-ranges.
  assertIdentities(r, 'full log')
  assertSubRangeIdentities(snap, r)

  // 4. Σ percent between consecutive dings is one level — the claim that makes "levels of
  //    progress" a measurement rather than a guess.
  assert.ok(dingIntervalsAreOneLevel(snap) > 20, 'enough ding-bounded intervals to be meaningful')

  // 5. CREDIT vs EXP — THE CORRESPONDENCE, CONDITIONED ON EXPERIENCE ACTUALLY BEING PAID
  //    (JOS-241; the ratio clause of the frozen-numbers law, and JOS-234's playbook applied to
  //    this file). This used to read `kills / expSamples ∈ (0.85, 1.15)`, and it went
  //    deterministically red at 1.153 with no diff behind it: the character reached the cap and
  //    farms greys, which print no experience line at all, so the numerator grew and the
  //    denominator did not. Measured share of credited kills that HAD a line to claim: 87-100%
  //    per day through 2026-08-10, then 6.1% and 2.0%. The ratio was measuring the owner's con
  //    colour. Widening the bound would only have bought a few more evenings of it.
  //
  //    So the sentence is restated over the two CONDITIONED populations (tests/progressionJoin.mts
  //    derives both from the columns): the credited kills that had an experience line to claim,
  //    and the experience lines that had a credited kill to pay. Those are the two directions of
  //    one relation, so their sizes agree exactly to the degree the join is one-to-one — and a
  //    grey kill, a quest turn-in, and a group-mate's party experience are each in NEITHER term,
  //    which is what stops the number tracking how the owner spent his evening.
  //    MEASURED 2026-08-12 over 1.61M lines: 5443 payable / 5433 paid = 1.0018, with 14 contended
  //    (0.26%); every 500-kill window in the whole log reads between 0.9940 and 1.0060.
  //
  //    AND IT WAS MUTATION-TESTED, because a tripwire that never trips is decoration. Four breaks
  //    were introduced into src/main/modules/progression.ts, run against the real log, reverted:
  //      • every third-party kill credited  → contended 64/5705 (1.12%)   — the contention clause
  //      • every self kill counted twice    → payable/paid 9628/5433       — the ratio
  //      • the at-cap experience line pushed to the column twice → 5443/6334 — the ratio, downward
  //      • self kills counted twice ONLY after 2026-08-11 → recent 500/476 — the RECENT clause
  //        alone; the aggregate read 1.0070 and contention 0.77%, both comfortably inside their
  //        bounds. That is the whole argument for the recency restatement, measured.
  assert.equal(r.kills, snap.killTs.length, 'the range query reports the whole credited column')
  assert.equal(r.expSamples, snap.expTs.length, 'and the whole experience column')
  const pairing = expPairing(snap)
  assert.ok(pairing.payable.length > 0 && pairing.paid.length > 0, 'experience was paid for kills')
  const ratio = pairing.payable.length / pairing.paid.length
  assert.ok(ratio > 0.98 && ratio < 1.02, `payable/paid ${pairing.payable.length}/${pairing.paid.length}`)
  //    …and the ONE measured reason the two sizes may differ at all: a mob and its pet dying in
  //    the same second contend for one line. Anything else that inflates the credited column —
  //    a witnessed kill credited, a self kill counted twice through its third-person twin —
  //    arrives here as contention it cannot explain.
  assert.ok(
    pairing.contended / pairing.payable.length < 0.01,
    `contended ${pairing.contended}/${pairing.payable.length}`
  )
  //    Again over the most recent payable kills alone: a regression that only breaks NEW lines is
  //    otherwise diluted by thousands of correctly paired old ones. (Recent in PAYABLE kills, not
  //    in wall clock — at the cap the log can go days without paying one, and a stretch that pays
  //    nothing is exactly the stretch this identity has nothing to say about.)
  const recent = recentPairingRatio(pairing, 500)
  assert.ok(
    recent.ratio > 0.97 && recent.ratio < 1.03,
    `recent payable/paid ${recent.kills}/${recent.lines}`
  )
  assert.ok(r.killsWitnessed > 0, 'other people kill things in this world')
  assert.ok(r.killsWitnessed < r.kills, 'and most kills in the series are still yours')

  // 6. Level runs: exactly one more run than there are downward transitions, none descending.
  const drops = snap.levelValue.filter((v, i) => i > 0 && v < snap.levelValue[i - 1]).length
  assert.equal(r.levelRuns.length, drops + 1)
  for (const run of r.levelRuns) assert.ok(run.toLevel >= run.fromLevel && run.endTs >= run.startTs)

  // 7. Retention: this log is far under every cap, so nothing has aged out and no range is
  //    clipped. (The direction is the invariant — `dropped` can only grow with `windowStart`.)
  assert.equal(snap.dropped, 0, 'a 1.1M-line log is well under the caps')
  assert.equal(snap.windowStart, 0, 'nothing aged out ⇒ no retention floor to warn about')
  assert.equal(r.clipped, false)
})
