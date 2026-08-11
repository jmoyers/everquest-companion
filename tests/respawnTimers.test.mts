// RESPAWN CLOCKS (JOS-194) - the estimate ladder, the reading, and the fold over real bytes.
//
// (The wiki floor that sits UNDER the ladder has its own file: tests/respawnWiki.test.mts.)
//
// THE GOLDEN WINDOW IS `wl40-farm-run.log`, an existing committed fixture, and it was picked
// because it proves BOTH arms of the design at once without a line being invented:
//
//   * Its first ~40 minutes are a Befallen farm run that begins MID-SESSION - the file opens
//     with no `You have entered` line at all. So every Befallen mob in it is killed during a
//     stay the log never states the beginning of, and NOT ONE of those repeat kills becomes a
//     sample. That is the `zoneSince > 0` rule doing its job on real bytes: 51 kills of
//     `a teir`dal ranger`, 43 of `a teir`dal shadowknight`, 4 of `gynok moltor`, and zero
//     learned gaps between them, because the app cannot say the player was standing there the
//     whole time.
//   * Then it zones - Innothule Swamp, The City of Guk, The Ruins of Old Guk - and everything
//     killed after that IS inside a stated stay, so the Guk ghouls learn gaps normally.
//
// The numbers below were hand-computed off the raw fixture text (timestamps parsed, deaths keyed
// by zone, gaps taken pairwise) BEFORE the module was asked, which is the golden-window law.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { RespawnModule } from '../src/main/modules/respawn'
import {
  DEFAULT_RESPAWN_PREFS,
  RESPAWN_LINGER_MS,
  normalizeRespawnPrefs,
  orderRespawnRows,
  resolveRespawn,
  respawnInZone,
  respawnReading,
  respawnRowExpired,
  respawnSourceLabel,
  respawnZoneKey,
  type RespawnPrefs,
  type RespawnRow,
  type RespawnSnap
} from '../src/shared/respawn'
import { readFixture } from './harness.mts'

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE ESTIMATE LADDER
// ─────────────────────────────────────────────────────────────────────────────

test('your own number outranks everything, and is never floored by the wiki', () => {
  // A player camping the spot knows more about it than a wiki describing a different server.
  const got = resolveRespawn({ customMs: 60_000, observedMs: 500_000, samples: 9, wikiMs: 900_000 })
  assert.deepEqual(got, { estimateMs: 60_000, source: 'custom' })
})

test('your kills win over the wiki when they clear its floor', () => {
  const got = resolveRespawn({ observedMs: 455_000, samples: 6, wikiMs: 267_000 })
  assert.deepEqual(got, { estimateMs: 455_000, source: 'observed' })
})

test('the wiki FLOORS a gap that two mobs of one name drove too low', () => {
  // 51 kills of `a teir`dal ranger` in one Befallen run produce a 61-second minimum gap. No mob in
  // this game respawns in a minute (the shortest the whole catalog states is 78 s), so that gap is
  // two rangers dying in one pull — and the floor is what keeps the clock off a number the mob
  // could never honour. The SOURCE stays 'observed': the evidence is still yours, it was just
  // clamped, and `respawnSourceLabel` says so out loud.
  const got = resolveRespawn({ observedMs: 61_000, samples: 23, wikiMs: 267_000 })
  assert.deepEqual(got, { estimateMs: 267_000, source: 'observed' })
})

test('the wiki is the default before any gap of your own', () => {
  assert.deepEqual(resolveRespawn({ samples: 0, wikiMs: 960_000 }), {
    estimateMs: 960_000,
    source: 'wiki'
  })
  // A minimum with no sample behind it is not evidence and cannot be used.
  assert.deepEqual(resolveRespawn({ observedMs: 5_000, samples: 0, wikiMs: 960_000 }), {
    estimateMs: 960_000,
    source: 'wiki'
  })
})

test('nothing states a respawn, so nothing is claimed', () => {
  assert.deepEqual(resolveRespawn({ samples: 0 }), { source: 'none' })
})

test('the provenance label never hides how thin the evidence is', () => {
  const base: RespawnRow = {
    id: 'z::m',
    key: 'm',
    display: 'M',
    zone: 'Z',
    diedTs: 0,
    source: 'observed',
    samples: 1,
    kills: 2,
    observedMs: 300_000,
    estimateMs: 300_000
  }
  assert.equal(respawnSourceLabel(base), 'your kills (1 gap)')
  assert.equal(respawnSourceLabel({ ...base, samples: 4 }), 'your kills (4 gaps)')
  assert.equal(
    respawnSourceLabel({ ...base, observedMs: 61_000, wikiMs: 267_000, estimateMs: 267_000 }),
    'your kills (1 gap), floored by the wiki'
  )
  assert.equal(respawnSourceLabel({ ...base, source: 'wiki' }), 'wiki default')
  assert.equal(respawnSourceLabel({ ...base, source: 'custom' }), 'your number')
  assert.equal(respawnSourceLabel({ ...base, source: 'none' }), 'no estimate yet')
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. READING A ROW AGAINST THE CLOCK
// ─────────────────────────────────────────────────────────────────────────────

function row(over: Partial<RespawnRow> = {}): RespawnRow {
  return {
    id: 'z::m',
    key: 'm',
    display: 'M',
    zone: 'Z',
    diedTs: 1_000_000,
    source: 'wiki',
    samples: 0,
    kills: 1,
    estimateMs: 600_000,
    ...over
  }
}

test('a countdown runs down, then reports how long ago it came due', () => {
  assert.deepEqual(respawnReading(row(), 1_000_000), {
    elapsedMs: 0,
    remainingMs: 600_000,
    fraction: 1,
    due: false,
    overdueMs: 0
  })
  const half = respawnReading(row(), 1_300_000)
  assert.equal(half.remainingMs, 300_000)
  assert.equal(half.fraction, 0.5)
  assert.equal(half.due, false)
  const past = respawnReading(row(), 1_700_000)
  assert.equal(past.remainingMs, 0)
  assert.equal(past.due, true)
  assert.equal(past.overdueMs, 100_000)
})

test('a row with no estimate counts UP and is never due', () => {
  const r = respawnReading(row({ estimateMs: undefined, source: 'none' }), 1_120_000)
  assert.deepEqual(r, { elapsedMs: 120_000, fraction: 0, due: false, overdueMs: 0 })
})

test('a clock that ran out long ago stops being a timer', () => {
  const r = row()
  assert.equal(respawnRowExpired(r, 1_600_000 + RESPAWN_LINGER_MS - 1), false)
  assert.equal(respawnRowExpired(r, 1_600_000 + RESPAWN_LINGER_MS + 1), true)
  // …and so does one that never had an estimate, judged on elapsed time instead.
  const bare = row({ estimateMs: undefined, source: 'none' })
  assert.equal(respawnRowExpired(bare, 1_000_000 + RESPAWN_LINGER_MS + 1), true)
})

test('soonest due leads, then the ones with no estimate', () => {
  // No "pinned first" tier: tracking is opt-in, so every row is a mob the player asked for and a
  // rank saying "this one was your idea" would put all of them in one bucket.
  const soon = row({ id: 'b', display: 'B', estimateMs: 60_000 })
  const later = row({ id: 'c', display: 'C', estimateMs: 300_000 })
  const latest = row({ id: 'a', display: 'A', estimateMs: 900_000 })
  const bare = row({ id: 'd', display: 'D', estimateMs: undefined, source: 'none' })
  const order = orderRespawnRows([bare, latest, later, soon], 1_000_000).map((r) => r.id)
  assert.deepEqual(order, ['b', 'c', 'a', 'd'])
})

// ─────────────────────────────────────────────────────────────────────────────
// 4b. SCOPING THE DISPLAY TO ONE ZONE (owner ruling, prototype round 1)
// ─────────────────────────────────────────────────────────────────────────────

test('a zone is compared canonically, the way every other dirty name in this app is', () => {
  assert.equal(respawnZoneKey('  The Ruins of Old Guk '), 'the ruins of old guk')
  assert.equal(respawnZoneKey(''), '')
})

test('the display shows the zone you are in, and a DUE clock elsewhere does not widen it', () => {
  const here = row({ id: 'here', zone: 'The Ruins of Old Guk', estimateMs: 600_000 })
  // Died an hour ago with a ten-minute estimate: due, and still not this zone's business.
  const dueThere = row({ id: 'there', zone: 'Befallen', diedTs: 400_000, estimateMs: 600_000 })
  assert.equal(respawnReading(dueThere, 1_000_000).due, true)
  const shown = respawnInZone([here, dueThere], 'the ruins of OLD guk')
  assert.deepEqual(
    shown.map((r) => r.id),
    ['here']
  )
})

test('the unknown zone is a BUCKET, not a wildcard', () => {
  // Before the log states a zone, the fold's zone and the row's are both '' — so an unplaced kill
  // shows while the app is still unplaced, and nothing from a NAMED zone leaks in beside it.
  const unplaced = row({ id: 'u', zone: '' })
  const placed = row({ id: 'p', zone: 'Befallen' })
  assert.deepEqual(
    respawnInZone([unplaced, placed], '').map((r) => r.id),
    ['u']
  )
  // …and once the zone is known, the unplaced row is the one that drops out.
  assert.deepEqual(
    respawnInZone([unplaced, placed], 'Befallen').map((r) => r.id),
    ['p']
  )
})

test('the same filter serves the watch CANDIDATES, which are the same shape', () => {
  const here = { key: 'a', display: 'A', zone: 'Befallen', lastTs: 1, kills: 1, watched: false }
  const there = { key: 'b', display: 'B', zone: 'Najena', lastTs: 2, kills: 1, watched: false }
  assert.deepEqual(
    respawnInZone([here, there], 'befallen').map((c) => c.key),
    ['a']
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE WATCH LIST NORMALIZER (runs at BOTH ends — the store and the IPC handler)
// ─────────────────────────────────────────────────────────────────────────────

test('a missing watch list is the shipped default', () => {
  assert.deepEqual(normalizeRespawnPrefs(undefined), DEFAULT_RESPAWN_PREFS)
  assert.deepEqual(normalizeRespawnPrefs(null), DEFAULT_RESPAWN_PREFS)
  assert.deepEqual(normalizeRespawnPrefs('nonsense'), DEFAULT_RESPAWN_PREFS)
})

test('the normalizer canonicalizes, de-duplicates and refuses junk', () => {
  const got = normalizeRespawnPrefs({
    watches: [
      { key: '  Gynok Moltor ', display: 'Gynok Moltor', customSec: 960.4 },
      { key: 'gynok moltor', display: 'a duplicate' },
      { key: '', display: 'no key at all' },
      'not an object',
      { key: 'over the cap', display: 'x', customSec: 999_999_999 },
      { key: 'under the floor', display: 'x', customSec: 0 }
    ]
  })
  assert.deepEqual(got.watches, [
    { key: 'gynok moltor', display: 'Gynok Moltor', customSec: 960 },
    { key: 'over the cap', display: 'x' },
    { key: 'under the floor', display: 'x' }
  ])
})

test('a store still carrying the retired auto-watch flag reads as its watch list, and nothing else', () => {
  // The prototype persisted `autoWiki`. The owner removed the feature; unknown fields are dropped
  // rather than carried, so the ruling takes effect on the next READ with no migration to write.
  const got = normalizeRespawnPrefs({ autoWiki: true, watches: [{ key: 'gynok moltor', display: 'Gynok Moltor' }] })
  assert.deepEqual(got, { watches: [{ key: 'gynok moltor', display: 'Gynok Moltor' }] })
  assert.equal(Object.hasOwn(got, 'autoWiki'), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE FOLD, over real bytes
// ─────────────────────────────────────────────────────────────────────────────

/** Replay a fixture through the module, then set its clock to `nowMs` and read the snapshot. */
function replay(fixture: string, prefs: RespawnPrefs, nowMs: number): RespawnSnap {
  const mod = new RespawnModule(prefs)
  mod.reset()
  let seq = 0
  for (const raw of readFixture(fixture)) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  mod.onTick(nowMs)
  return mod.snapshot().state
}

/** The fixture's last event, hand-read off the raw text: Mon Aug 03 2026 00:33:26 UTC. */
const WL40_END = 1785717206000

/**
 * A minute after the fixture's LAST BEFALLEN KILL (`a teir`dal shadowknight`, 23:32:08).
 *
 * The Befallen half of this fixture happens an hour before its end, and these clocks are four to
 * sixteen minutes long — so read at `WL40_END` every one of them has been due for the best part of
 * an hour and `RESPAWN_LINGER_MS` has correctly swept them away. That is the feature working, not a
 * fixture problem, so the test that is about WHAT THE FOLD LEARNED reads the clock while the run is
 * still current; the sweep itself has its own test below.
 */
const WL40_BEFALLEN_END = 1785713528000 + 60_000

function find(snap: RespawnSnap, key: string): RespawnRow | undefined {
  return snap.rows.find((r) => r.key === key)
}

/** Watch these mobs, with no numbers of your own. Tracking is opt-in, so a fold test that wants
 *  rows has to ask for them by name — which is the product's own rule, not a test convenience. */
function watching(...keys: string[]): RespawnPrefs {
  return { watches: keys.map((key) => ({ key, display: key })) }
}

/** The four Befallen mobs of the fixture's first half. All four are in the committed wiki floor. */
const BEFALLEN_FOUR = ['a teir`dal ranger', 'a teir`dal shadowknight', 'gynok moltor', 'korven nisere']

test('a farm run that begins mid-session learns NOTHING, because no stay was ever stated', () => {
  // The heart of the design, on real bytes. `wl40-farm-run.log` opens with no `You have entered`
  // line, so its first forty minutes — 51 kills of one ranger, 43 of one shadowknight, 4 of Gynok
  // Moltor — happen inside a stay whose start the log never says. Every one of those repeat kills
  // is a gap this app REFUSES to read as a respawn, because the player may have walked away and
  // come back between any two of them.
  const snap = replay('wl40-farm-run.log', watching(...BEFALLEN_FOUR), WL40_BEFALLEN_END)
  for (const key of BEFALLEN_FOUR) {
    const r = find(snap, key)
    assert.ok(r, `${key} should have a row (the wiki states a respawn for it)`)
    assert.equal(r.samples, 0, `${key} must learn no gaps before a stay is stated`)
    assert.equal(r.source, 'wiki', `${key} must fall back to the wiki default`)
    assert.equal(r.zone, '', `${key} died before any zone line`)
  }
  // …and the numbers are the wiki's own, unchanged.
  assert.equal(find(snap, 'gynok moltor')?.estimateMs, 960_000)
  assert.equal(find(snap, 'gynok moltor')?.wikiText, '16.0 min (PH)')
  assert.equal(find(snap, 'korven nisere')?.estimateMs, 270_000)
  // The KILLS are still counted — refusing to learn a gap is not refusing to see the deaths.
  assert.equal(find(snap, 'a teir`dal ranger')?.kills, 51)
  assert.equal(find(snap, 'a teir`dal shadowknight')?.kills, 43)
  assert.equal(find(snap, 'gynok moltor')?.kills, 4)
})

test('once the log states a stay, the same fold learns gaps normally', () => {
  // The Guk half of the same fixture, after `You have entered The Ruins of Old Guk.`. These mobs
  // are not in the wiki floor at all, so an explicit watch is the only way to clock them — which
  // is exactly the case the corroborating report is about, and exactly what the Timers tab's
  // one-click Watch is for.
  const snap = replay(
    'wl40-farm-run.log',
    watching('a vis ghoul knight', 'a wan ghoul knight', 'an urd ghoul wizard'),
    WL40_END
  )
  const vis = find(snap, 'a vis ghoul knight')
  assert.ok(vis)
  assert.equal(vis.zone, 'The Ruins of Old Guk')
  assert.equal(vis.kills, 8)
  assert.equal(vis.samples, 6)
  assert.equal(vis.observedMs, 162_000, 'the SMALLEST of the six gaps, not the average')
  assert.equal(vis.estimateMs, 162_000)
  assert.equal(vis.source, 'observed')

  const urd = find(snap, 'an urd ghoul wizard')
  assert.ok(urd)
  assert.equal(urd.kills, 4)
  assert.equal(urd.samples, 3)
  assert.equal(urd.observedMs, 140_000)

  // The boundary: `a wan ghoul knight`'s tightest pair is EXACTLY 60 seconds apart, which is the
  // shortest gap the module will read at all. It is admitted (the rule is `>=`), and the row is a
  // standing demonstration of why the estimate is labelled an upper bound rather than a
  // measurement — no mob in this game respawns in a minute.
  const wan = find(snap, 'a wan ghoul knight')
  assert.ok(wan)
  assert.equal(wan.samples, 11)
  assert.equal(wan.observedMs, 60_000)
})

test('NOTHING is clocked until the player opts in - not even a mob the wiki knows', () => {
  // The owner's ruling, on the fixture that would have shown it worst: this run kills four mobs the
  // committed floor states a duration for, hundreds of times between them, and the prototype's auto
  // rule put every one of them on screen. A fresh install now folds the same bytes and shows
  // nothing at all.
  const fresh = replay('wl40-farm-run.log', DEFAULT_RESPAWN_PREFS, WL40_BEFALLEN_END)
  assert.deepEqual(DEFAULT_RESPAWN_PREFS.watches, [], 'a fresh install watches nothing')
  assert.equal(fresh.rows.length, 0, 'and therefore clocks nothing')

  // The DISCOVERY surface is untouched — the deaths were all seen, and the mobs are offered.
  assert.ok(fresh.recent.length > 0, 'the watch CANDIDATES are still offered')
  const gynok = fresh.recent.find((c) => c.key === 'gynok moltor')
  assert.ok(gynok, 'a mob you killed four times is offered even though nothing clocks it')
  assert.equal(gynok.watched, false)
  assert.equal(gynok.wikiText, '16.0 min (PH)', 'and what the wiki says is shown BESIDE the offer')

  // Opting in to ONE mob clocks exactly that one, wiki durations elsewhere notwithstanding.
  const one = replay('wl40-farm-run.log', watching('gynok moltor'), WL40_BEFALLEN_END)
  assert.deepEqual(
    one.rows.map((r) => r.key),
    ['gynok moltor']
  )
})

test('a mob you start watching gets a clock from the kill you already made', () => {
  // The Timers tab's whole discoverability story, at the model level: `setPrefs` on a module that
  // has already folded the death produces the row immediately, rather than arming the next one.
  const mod = new RespawnModule({ watches: [] })
  mod.reset()
  let seq = 0
  for (const raw of readFixture('wl40-farm-run.log')) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  mod.onTick(WL40_END)
  assert.equal(mod.snapshot().state.rows.length, 0)
  const before = mod.snapshot().seq

  mod.setPrefs(watching('a vis ghoul knight'))
  const after = mod.snapshot()
  assert.equal(after.state.rows.length, 1)
  assert.equal(after.state.rows[0].key, 'a vis ghoul knight')
  assert.equal(after.state.rows[0].samples, 6)
  // THE REVISION MUST HAVE MOVED (JOS-87). A watch edit advances no log seq, so if the module
  // reported the last event's seq the renderer's `d.seq <= knownSeq` dedupe would swallow this
  // push and the row would never reach the screen on an idle log.
  assert.ok(after.seq > before, 'a watch edit must advance the module revision')
})

test('a custom number overrides what the fold learned, live', () => {
  const mod = new RespawnModule({ watches: [] })
  mod.reset()
  let seq = 0
  for (const raw of readFixture('wl40-farm-run.log')) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  mod.onTick(WL40_END)
  mod.setPrefs({ watches: [{ key: 'a vis ghoul knight', display: 'a vis ghoul knight', customSec: 1000 }] })
  const r = mod.snapshot().state.rows[0]
  assert.equal(r.estimateMs, 1_000_000)
  assert.equal(r.source, 'custom')
  // The learned bound is still carried, so the UI can show what it would otherwise have said.
  assert.equal(r.observedMs, 162_000)
})

test('the clocks expire, so a months-old replay does not open holding a hundred timers', () => {
  // The realistic cold start: the app folds the whole log at launch and the deaths in it are old.
  // Everything here IS watched, so the empty list is the linger sweep and nothing else.
  const prefs = watching(...BEFALLEN_FOUR, 'a vis ghoul knight', 'a wan ghoul knight')
  assert.ok(replay('wl40-farm-run.log', prefs, WL40_END).rows.length > 0, 'watched, and alive at the end of the run')
  const long = replay('wl40-farm-run.log', prefs, WL40_END + 7 * 24 * 3600 * 1000)
  assert.equal(long.rows.length, 0)
  // …and the candidates survive, because "what have I killed here" is not a countdown.
  assert.ok(long.recent.length > 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. THE ZONE SCOPE, over the same real bytes
// ─────────────────────────────────────────────────────────────────────────────

test('the fold keeps every zone; the display shows the one you are in', () => {
  // The owner's other ruling, on the fixture that produced it: this run kills in Befallen (before
  // any zone line, so the unknown-zone bucket) and then in The Ruins of Old Guk. The snapshot
  // carries BOTH — cross-zone data is kept — and `respawnInZone` is what each surface draws.
  const snap = replay(
    'wl40-farm-run.log',
    watching('gynok moltor', 'a vis ghoul knight'),
    WL40_BEFALLEN_END
  )
  assert.equal(snap.zone, 'The Ruins of Old Guk', 'the fold ends where the log last said it was')
  assert.deepEqual(
    snap.rows.map((r) => r.key).sort(),
    ['a vis ghoul knight', 'gynok moltor'],
    'both zones are still published'
  )
  assert.deepEqual(
    respawnInZone(snap.rows, snap.zone).map((r) => r.key),
    ['a vis ghoul knight'],
    'the overlay draws only the zone you are in'
  )
  // Gynok died before any zone line, so he is in the unknown bucket rather than in Guk.
  assert.equal(find(snap, 'gynok moltor')?.zone, '')
  assert.deepEqual(
    respawnInZone(snap.rows, '').map((r) => r.key),
    ['gynok moltor']
  )
})

test('a zone line ADVANCES the revision, or the screen never hears about it', () => {
  // Found by the e2e, fixed in the module (JOS-87's dedupe, one module further on). A zone line
  // moves no other state here — no death, no watch edit — so if it left `rev` alone the delta it
  // marks dirty is exactly the one `useModule`'s `d.seq <= knownSeq` throws away. With the display
  // scoped by zone, that is both surfaces still drawing the zone you just walked out of.
  const mod = new RespawnModule(watching('a vis ghoul knight'))
  mod.reset()
  let seq = 0
  for (const raw of [
    '[Sun Aug 02 23:45:41 2026] You have entered The Ruins of Old Guk.',
    '[Sun Aug 02 23:50:00 2026] You have slain a vis ghoul knight!'
  ]) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  const before = mod.snapshot()
  assert.equal(before.state.zone, 'The Ruins of Old Guk')

  const zoned = parseEvent('[Sun Aug 02 23:52:00 2026] You have entered Befallen.', seq++)
  assert.ok(zoned)
  mod.onEvent(zoned)
  const flushed = mod.flushDelta()
  assert.ok(flushed, 'a zone line makes the module dirty')
  assert.equal(flushed.delta.zone, 'Befallen')
  assert.ok(flushed.seq > before.seq, 'and the revision must move, or the renderer dedupes it away')
})

test('a zone line ENDS the stay, even when it names the zone you were already in', () => {
  // Zoning out and back is not camping, and the log states it the same way either time. Built from
  // the fixture's own line shapes with its own timestamps so nothing here is a shape EQ has not
  // printed — the third `slain` line is 5 minutes after the second, well over the gap floor, and
  // it still yields no sample because a zone line landed in between.
  const lines = [
    '[Sun Aug 02 23:45:41 2026] You have entered The Ruins of Old Guk.',
    '[Sun Aug 02 23:50:00 2026] You have slain a vis ghoul knight!',
    '[Sun Aug 02 23:55:00 2026] You have slain a vis ghoul knight!',
    '[Sun Aug 02 23:56:00 2026] You have entered The Ruins of Old Guk.',
    '[Mon Aug 03 00:01:00 2026] You have slain a vis ghoul knight!'
  ]
  const mod = new RespawnModule(watching('a vis ghoul knight'))
  mod.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  mod.onTick(Date.parse('2026-08-03T00:02:00') || WL40_END)
  const r = mod.snapshot().state.rows[0]
  assert.equal(r.kills, 3)
  // ONE sample: the 23:50 → 23:55 pair. The 23:55 → 00:01 pair spans a zone line and is refused.
  assert.equal(r.samples, 1)
  assert.equal(r.observedMs, 300_000)
})

test('two deaths of one name inside a minute are two mobs, not a respawn', () => {
  const lines = [
    '[Sun Aug 02 23:45:41 2026] You have entered The Ruins of Old Guk.',
    '[Sun Aug 02 23:50:00 2026] You have slain a vis ghoul knight!',
    '[Sun Aug 02 23:50:30 2026] You have slain a vis ghoul knight!'
  ]
  const mod = new RespawnModule(watching('a vis ghoul knight'))
  mod.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  mod.onTick(Date.parse('2026-08-02T23:51:00') || WL40_END)
  const r = mod.snapshot().state.rows[0]
  assert.equal(r.kills, 2)
  assert.equal(r.samples, 0, 'the shortest respawn the whole catalog states is 78 seconds')
  assert.equal(r.source, 'none')
  assert.equal(r.estimateMs, undefined)
})

