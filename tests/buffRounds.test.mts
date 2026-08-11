// JOS-140 — THE COUNT-AND-CLOSE RULE, on its own, as arithmetic.
//
// `HoldGroup` (src/main/modules/buffRounds.ts) is the one object both halves of the buff model
// keep their landings in, and it is where three of the owner's rulings actually live:
//
//   a round of N landings on a name already holding M REFRESHES min(N, M) of them, newest first,
//   and APPENDS the remaining max(0, N - M);
//   an anonymous wear-off CLOSES THE OLDEST;
//   a duration sample is minted ONLY from a landing that was alone in its round, on a name
//   nothing else was holding, that nothing touched before its wear-off.
//
// The rules exist because EQ stamps to the second and prints no instance identifier, so one AE
// cast landing on five mobs that share a name is five byte-identical lines. tests/buffTimers.test.mts
// and tests/buffUnifiedModel.test.mts drive them through the real parser and the real modules on
// real bytes; this file drives the object directly, because the arithmetic of "how many are held"
// is the part a fixture cannot isolate and the part a future reader will want to check by hand.
//
// Run: `npm test`.

import test from 'node:test'
import assert from 'node:assert/strict'
import { HoldGroup } from '../src/main/modules/buffRounds.ts'

const SEC = 1000

/** Land `n` times in the SAME second — one AE round hitting `n` mobs of one name. */
function round(g: HoldGroup, ts: number, n: number, contaminated = false): void {
  for (let i = 0; i < n; i++) g.land(ts, contaminated)
}

// ---------------------------------------------------------------------------------------------
// COUNTING. What is HELD, not what has ever landed.
// ---------------------------------------------------------------------------------------------

test('a round of five landings on one name is ONE row with a count of five', () => {
  const g = new HoldGroup()
  round(g, 1_000, 5)
  assert.equal(g.count, 5, 'five mobs of that name are held')
  assert.equal(g.oldestTs, 1_000)
  assert.equal(g.newestTs, 1_000, 'they share a log second, which is why they are indistinguishable')
})

test('a SECOND round of five on the same five refreshes them — the count does not double', () => {
  // THE DEFECT THIS IS: counting a re-mez as new mobs makes the chip climb forever. The reporter's
  // slice re-mezzes the same names nine times in three minutes; a growing count would have read 45.
  const g = new HoldGroup()
  round(g, 1_000, 5)
  round(g, 40 * SEC, 5)
  assert.equal(g.count, 5, 'still five mobs, re-mezzed')
  assert.equal(g.oldestTs, 40 * SEC, 'and every clock was refreshed by the new round')
})

test('a BIGGER round refreshes what it can and appends the rest', () => {
  const g = new HoldGroup()
  round(g, 1_000, 1)
  round(g, 10 * SEC, 4)
  assert.equal(g.count, 4, 'one was already held, three more of that name joined it')
  assert.equal(g.oldestTs, 10 * SEC)
})

test('a SMALLER round refreshes only the newest and leaves the older clocks alone', () => {
  // A single-target re-mez on a name five of which are held. Which one it hit is a documented
  // non-distinguishable, so the bounded reading is taken: refresh the newest, and let the four
  // older clocks keep predicting the four wear-offs that are coming.
  const g = new HoldGroup()
  round(g, 1_000, 5)
  g.land(30 * SEC)
  assert.equal(g.count, 5, 'a refresh is never a sixth mob')
  assert.equal(g.oldestTs, 1_000, 'the oldest clock is untouched — it is the next one to expire')
  assert.equal(g.newestTs, 30 * SEC)
})

// ---------------------------------------------------------------------------------------------
// CLOSING. Oldest first, because no line says which.
// ---------------------------------------------------------------------------------------------

/**
 * TWO MOBS OF ONE NAME ON TWO DIFFERENT CLOCKS — the only way the log can produce that, and the
 * shape every close/sweep/pause case below needs. A round of two opens two landings sharing one
 * second; a later single re-mez refreshes the NEWEST of them, which is what leaves the pair with
 * distinct clocks. (Two landings in two different seconds would be a refresh, not a second mob.)
 */
function twoOnDifferentClocks(): HoldGroup {
  const g = new HoldGroup()
  round(g, 1_000, 2)
  g.land(20 * SEC)
  return g
}

test('a wear-off closes the OLDEST landing, and the row survives with one fewer', () => {
  const g = twoOnDifferentClocks()
  const closed = g.closeOldest(30 * SEC)
  assert.equal(closed?.hold.startedTs, 1_000, 'the oldest is the maximum-likelihood one to have ended')
  assert.equal(g.count, 1, 'the other is still held')
  assert.equal(g.oldestTs, 20 * SEC)
})

test('a wear-off with NO hold behind it closes nothing and contaminates what is there', () => {
  // Proof the model UNDER-COUNTED. Whatever is still in the group is now being measured against
  // the wrong landing, so nothing in it may be learned from.
  const g = new HoldGroup()
  g.land(1_000)
  assert.equal(g.closeOldest(10 * SEC)?.sampleMs, 9 * SEC)
  assert.equal(g.closeOldest(11 * SEC), null, 'nothing left to close')
  g.land(20 * SEC)
  // The next landing opens on an empty group and is clean again — the contamination applied to
  // what was standing at the time, not to the name forever.
  assert.equal(g.closeOldest(30 * SEC)?.sampleMs, 10 * SEC)
})

// ---------------------------------------------------------------------------------------------
// CLEAN CYCLES. The whole of ruling 5, and the reason the learner can be trusted at all.
// ---------------------------------------------------------------------------------------------

test('a landing ALONE in its round on an EMPTY name mints its span', () => {
  const g = new HoldGroup()
  g.land(1_000)
  assert.equal(g.closeOldest(45 * SEC)?.sampleMs, 44 * SEC)
})

test('…but a SIBLING in the same round retroactively refuses both', () => {
  const g = new HoldGroup()
  round(g, 1_000, 2)
  assert.equal(g.closeOldest(45 * SEC)?.sampleMs, null, 'two mobs, one second, no way to tell them apart')
  assert.equal(g.closeOldest(46 * SEC)?.sampleMs, null)
})

test('…and a REFRESH refuses it, because a re-landing is either the same mob or another one', () => {
  const g = new HoldGroup()
  g.land(1_000)
  g.land(20 * SEC)
  assert.equal(g.closeOldest(45 * SEC)?.sampleMs, null)
})

test('…and a landing onto a name already held is refused even though it is alone in its round', () => {
  const g = new HoldGroup()
  round(g, 1_000, 2)
  g.land(20 * SEC) // refreshes the newest of the two
  round(g, 30 * SEC, 3) // two refreshes, one append — the append is not clean either
  assert.equal(g.count, 3)
  for (let i = 0; i < 3; i++) assert.equal(g.closeOldest(60 * SEC)?.sampleMs, null)
})

test('a caller-stated contamination is honoured — a family, or two ranks in one cast window', () => {
  const g = new HoldGroup()
  g.land(1_000, true)
  assert.equal(g.closeOldest(45 * SEC)?.sampleMs, null, 'we do not know WHICH spell that was')
})

test('contamination is one-way: a clean-looking later line never restores it', () => {
  const g = new HoldGroup()
  g.land(1_000)
  g.contaminateAll()
  assert.equal(g.closeOldest(45 * SEC)?.sampleMs, null)
})

// ---------------------------------------------------------------------------------------------
// SINGLETONS. You, your summoned pet and your charmed pet are IDENTITIES the model tracks (law 4),
// so a re-cast on one of them is unambiguously a refresh and stays measurable. A mob is only ever
// a NAME, and the world hands out that name more than once.
// ---------------------------------------------------------------------------------------------

test('a SINGLETON group holds one landing and a re-cast RESETS its clock, cleanly', () => {
  // The refresh-inflation defence JOS-117 pinned, in its new home: the span is measured from the
  // RE-LAND, so a buff refreshed ten minutes in mints one clean full cycle rather than the sum of
  // the leftover and the new duration.
  const g = new HoldGroup(true)
  g.land(1_000)
  g.land(600 * SEC)
  assert.equal(g.count, 1, 'there is only ever one of you')
  assert.equal(g.oldestTs, 600 * SEC, 'and the clock restarted')
  assert.equal(g.closeOldest(600 * SEC + 1_980_000)?.sampleMs, 1_980_000, 'measured from the re-land')
})

test('a singleton still refuses a contamination its caller states', () => {
  const g = new HoldGroup(true)
  g.land(1_000, true)
  assert.equal(g.closeOldest(45 * SEC)?.sampleMs, null)
})

// ---------------------------------------------------------------------------------------------
// SWEEPING and the offline PAUSE — the two things that move landings without a line saying so.
// ---------------------------------------------------------------------------------------------

test('the sweep drops landings older than a cutoff, oldest first, and mints nothing', () => {
  // A cull is not evidence: `dropExpired` hands back the LANDINGS and never a sample, which is the
  // whole difference between it and `closeOldest`. Since JOS-180 the caller keeps what it gets
  // (the late-join memory), but what it gets is a start time and a `clean` flag — no span, because
  // nobody saw this hold end.
  const g = twoOnDifferentClocks()
  const dropped = g.dropExpired(10 * SEC)
  assert.equal(dropped.length, 1)
  assert.equal(dropped[0].startedTs, 1_000, 'the oldest landing, handed back whole')
  assert.ok(!('sampleMs' in dropped[0]), 'a cull hands back a landing, never a measurement')
  assert.equal(g.count, 1)
  assert.equal(g.oldestTs, 20 * SEC)
})

test('a pause shifts only the clocks that predate the absence, and keeps them ordered', () => {
  const g = twoOnDifferentClocks()
  assert.equal(g.shiftBy(60 * SEC, 5 * SEC), true, 'the pre-absence landing moved')
  assert.deepEqual(
    g.holds.map((h) => h.startedTs),
    [20 * SEC, 61 * SEC],
    'and the list is re-sorted, because oldest-first is what closeOldest means'
  )
  assert.equal(g.shiftBy(60 * SEC, 0), false, 'nothing predates the cutoff — no change reported')
})
