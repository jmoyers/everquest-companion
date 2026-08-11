// TURN-IN DETECTION + CELEBRATION TEST (Task #46, JOS-131): the pure baseline-guarded "which
// quests just gained a turn-in" core that PoskyView (confetti) + App (snackbar + questComplete
// sound + the celebration toast) fire on. Mirrors the boss-defeat baseline contract:
// the historical set is seeded silently and NEVER celebrated; only a transition after
// the baseline fires.
//
// JOS-131 TURNED THE FLAG INTO A COUNT. A Sky quest can be run again, so the detector reports
// INSTANTS per quest and the celebration compares COUNTS: the second turn-in of a quest you had
// already done is a live transition too, which is the boss watch's rule ("every time is worth
// celebrating") applied here.
//
// Also replays the REAL matcher (countTurnIns) over synthetic turn-in events to
// prove the end-to-end path: a live turn-in of the exact required set (incl. a +N variant
// normalized at the boundary) is detected, and reload/hydration does not celebrate.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  countTurnIns,
  newlyCompletedTurnIns
} from '../src/renderer/src/features/posky/turnInCelebration'
import { questKey } from '../src/renderer/src/features/posky/keys'
import poskyRaw from '../src/renderer/src/data/eqlegends/posky.json' with { type: 'json' }
import type { PoskyQuest, TurnInEvent } from '../src/shared/types'

const quests = (poskyRaw as { quests: PoskyQuest[] }).quests
const monkFists = quests.find((q) => q.name === 'Monk Test of Fists')!

/** Quest key → how many times, which is what the celebration compares. */
const counts = (instants: Record<string, number[]>): Record<string, number> =>
  Object.fromEntries(Object.entries(instants).map(([k, v]) => [k, v.length]))

test('baseline run (prev == null) celebrates NOTHING — historical counts seeded silently', () => {
  const historical = { 'Monk::Monk Test of Fists': 1, 'Warrior::Warrior Test of Bash': 3 }
  assert.deepEqual(newlyCompletedTurnIns(null, historical), [])
})

test('a quest whose count grew after the baseline is a live transition', () => {
  const baseline = { 'Monk::Monk Test of Fists': 1 }
  const next = { 'Monk::Monk Test of Fists': 1, 'Warrior::Warrior Test of Bash': 1 }
  assert.deepEqual(newlyCompletedTurnIns(baseline, next), [
    { key: 'Warrior::Warrior Test of Bash', count: 1 }
  ])
})

test('THE JOS-131 CASE: a SECOND turn-in of a quest already done celebrates, at count 2', () => {
  const baseline = { 'Monk::Monk Test of Fists': 1 }
  const again = { 'Monk::Monk Test of Fists': 2 }
  assert.deepEqual(newlyCompletedTurnIns(baseline, again), [
    { key: 'Monk::Monk Test of Fists', count: 2 }
  ])
})

test('exactly-once per turn-in: an unchanged count never re-fires', () => {
  // Simulate the ref update the hook does: after firing, the baseline becomes `next`.
  let baseline: Record<string, number> | null = { 'Monk::Monk Test of Fists': 1 }
  const afterTurnIn = { 'Monk::Monk Test of Fists': 1, 'Warrior::Warrior Test of Bash': 1 }
  assert.deepEqual(newlyCompletedTurnIns(baseline, afterTurnIn), [
    { key: 'Warrior::Warrior Test of Bash', count: 1 }
  ])
  baseline = afterTurnIn // hook advances the baseline ref
  // A later observation with the SAME counts (e.g. a re-render / another delta) → nothing.
  assert.deepEqual(newlyCompletedTurnIns(baseline, afterTurnIn), [])
  // A new quest still fires, and the already-fired one still does not.
  const more = { ...afterTurnIn, 'Cleric::Cleric Test of Theurgy': 1 }
  assert.deepEqual(newlyCompletedTurnIns(baseline, more), [
    { key: 'Cleric::Cleric Test of Theurgy', count: 1 }
  ])
})

test('a count that jumps by two reports ONE transition, at the new count', () => {
  // A catch-up delta (two turn-ins in one snapshot) is one thing that happened, reported with
  // the honest number rather than as two bursts.
  assert.deepEqual(newlyCompletedTurnIns({ 'A::Qa': 1 }, { 'A::Qa': 3 }), [
    { key: 'A::Qa', count: 3 }
  ])
})

test('multiple simultaneous completions all fire once', () => {
  const next = { 'A::Qa': 1, 'B::Qb': 1, 'C::Qc': 1 }
  assert.deepEqual(
    newlyCompletedTurnIns({}, next).map((t) => t.key).sort(),
    ['A::Qa', 'B::Qb', 'C::Qc']
  )
})

test('a count that DROPS (an undone turn-in) fires nothing', () => {
  assert.deepEqual(newlyCompletedTurnIns({ 'A::Qa': 2, 'B::Qb': 1 }, { 'A::Qa': 1 }), [])
})

// ---- end-to-end over the REAL posky.json (Brass Knuckles data completeness, Task #46) ----

test('Monk Test of Fists now requires Brass Knuckles (efreeti-cycle item restored)', () => {
  const names = monkFists.items.map((i) => i.name)
  assert.ok(names.includes('Brass Knuckles'), 'Brass Knuckles is a required turn-in item')
  assert.ok(names.includes('Nebulous Sapphire'), 'Nebulous Sapphire still required (unchanged)')
  assert.equal(monkFists.giver, 'Holwin')
})

test('a live turn-in of the exact required set is detected (incl. +N normalization)', () => {
  const required = monkFists.items.map((i) => i.name)
  // The user looted a `Brass Knuckles +2` variant — offering it must still satisfy the
  // base requirement (itemCountKey folds the +N suffix, Task #42). Swap in the variant.
  const offered = required.map((n) => (n === 'Brass Knuckles' ? 'Brass Knuckles +2' : n))
  const turnIn: TurnInEvent = { ts: 1_700_000_000_000, npc: 'Holwin', items: offered }

  const detected = countTurnIns([turnIn], quests)
  assert.deepEqual(
    detected[questKey(monkFists)],
    [turnIn.ts],
    'the +2 turn-in matches the base requirement, and the INSTANT is what is reported'
  )

  // Baseline-guarded celebration: seed silent on load, fire on the live transition.
  assert.deepEqual(newlyCompletedTurnIns(null, counts(detected)), [], 'load never celebrates')
  assert.deepEqual(newlyCompletedTurnIns({}, counts(detected)), [
    { key: questKey(monkFists), count: 1 }
  ])
})

test('TWO turn-ins of the same quest are TWO instants, not one flag', () => {
  const offered = monkFists.items.map((i) => i.name)
  const detected = countTurnIns(
    [
      { ts: 1_700_000_000_000, npc: 'Holwin', items: offered },
      { ts: 1_700_000_600_000, npc: 'Holwin', items: offered }
    ],
    quests
  )
  assert.deepEqual(detected[questKey(monkFists)], [1_700_000_000_000, 1_700_000_600_000])
  assert.equal(counts(detected)[questKey(monkFists)], 2, 'the count is what the badge says')
})

test('an incomplete turn-in (missing Brass Knuckles) is NOT detected', () => {
  const partial = monkFists.items.filter((i) => i.name !== 'Brass Knuckles').map((i) => i.name)
  const detected = countTurnIns([{ ts: 1, npc: 'Holwin', items: partial }], quests)
  assert.equal(
    detected[questKey(monkFists)],
    undefined,
    'missing an item ⇒ not detected now Brass Knuckles is required'
  )
})
