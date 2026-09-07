// The PURE half of the manual base-rung clear (see docs/plans/boss-lockout-credit-and-manual-clear.md
// section 2a). No DOM, no localStorage object — every function here takes plain values, which is
// what makes it a node test. The storage/React half is useWeekClears.ts, proven in
// tests/e2e/bosses-week.e2e.mts.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bossClearKey,
  nextWeekClearsOnToggle,
  parseWeekClears,
  serializeWeekClears,
  weekClearsStorageKey
} from '../src/renderer/src/features/bosses/weekClears'
import {
  hasCreditedAmbiguousKill,
  lockoutWindow,
  manualClearIsLiveThisWeek,
  tierLadder,
  type TierLock
} from '../src/renderer/src/features/bosses/lockout'
import type { KillTierRun } from '../src/shared/types'

// A Wednesday, comfortably inside one Pacific lockout week (reset is Tue 08:00 America/Los_Angeles).
const WED = Date.UTC(2026, 8, 2, 20, 0, 0)
const week = lockoutWindow(WED)

function run(over: Partial<KillTierRun>): KillTierRun {
  return { count: 1, firstTs: 0, lastTs: 0, credited: 0, lastCreditedTs: 0, ...over }
}

test('bossClearKey is trim + lowercase', () => {
  assert.equal(bossClearKey('  Lord Nagafen '), 'lord nagafen')
})

test('weekClearsStorageKey namespaces by character and degrades to "unknown"', () => {
  assert.equal(weekClearsStorageKey('Drammin_qeynos'), 'eq.bosses.weekClears.Drammin_qeynos')
  assert.equal(weekClearsStorageKey(null), 'eq.bosses.weekClears.unknown')
})

test('parseWeekClears degrades anything that is not a {string: number} map to {}', () => {
  assert.deepEqual(parseWeekClears(null), {})
  assert.deepEqual(parseWeekClears('not json'), {})
  assert.deepEqual(parseWeekClears('[1,2,3]'), {})
  assert.deepEqual(parseWeekClears('{"lord nagafen":"soon"}'), {})
  assert.deepEqual(parseWeekClears('{"lord nagafen":123}'), { 'lord nagafen': 123 })
})

test('serializeWeekClears round-trips', () => {
  const w = { 'lord nagafen': 111, 'lady vox': 222 }
  assert.deepEqual(parseWeekClears(serializeWeekClears(w)), w)
})

// The liveness-aware toggle (whole-branch review, Critical 2). WED and NOW are inside `week`;
// STALE is a mark made one lockout week earlier, which renders as an open rung.
const STALE = WED - 7 * 24 * 3600_000
const NOW = WED + 3600_000

test('nextWeekClearsOnToggle: an absent mark + click sets a fresh timestamp (rung will green)', () => {
  const next = nextWeekClearsOnToggle({}, 'lord nagafen', week, NOW)
  assert.deepEqual(next, { 'lord nagafen': NOW })
  assert.equal(manualClearIsLiveThisWeek(next['lord nagafen'], week), true)
})

test('nextWeekClearsOnToggle: a LIVE mark (this week) + click clears it', () => {
  assert.deepEqual(
    nextWeekClearsOnToggle({ 'lord nagafen': WED }, 'lord nagafen', week, NOW),
    {}
  )
})

test('nextWeekClearsOnToggle: a STALE mark (last week) + click sets a fresh this-week timestamp in ONE step', () => {
  const next = nextWeekClearsOnToggle({ 'lord nagafen': STALE }, 'lord nagafen', week, NOW)
  // NOT deleted — that is the Critical 2 bug. The stale key is overwritten with `nowMs`.
  assert.deepEqual(next, { 'lord nagafen': NOW })
  assert.equal(manualClearIsLiveThisWeek(next['lord nagafen'], week), true)
})

test('nextWeekClearsOnToggle does not mutate its input', () => {
  const before = { a: STALE, b: WED }
  nextWeekClearsOnToggle(before, 'b', week, NOW)
  assert.deepEqual(before, { a: STALE, b: WED })
  nextWeekClearsOnToggle(before, 'c', week, NOW)
  assert.deepEqual(before, { a: STALE, b: WED })
})

test('manualClearIsLiveThisWeek is true only for a mark made in the current lockout week', () => {
  assert.equal(manualClearIsLiveThisWeek(WED, week), true)
  assert.equal(manualClearIsLiveThisWeek(undefined, week), false)
  // one week earlier — a stale mark
  assert.equal(manualClearIsLiveThisWeek(WED - 7 * 24 * 3600_000, week), false)
})

test('hasCreditedAmbiguousKill sees a credited open-world or unknown run in-window and nothing else', () => {
  const inWin = week.start + 3600_000
  assert.equal(
    hasCreditedAmbiguousKill({ [-1]: run({ lastCreditedTs: inWin }) }, week),
    true
  )
  assert.equal(
    hasCreditedAmbiguousKill({ [-2]: run({ lastCreditedTs: inWin }) }, week),
    true
  )
  // a real difficulty tier does not count — that path is not ambiguous
  assert.equal(
    hasCreditedAmbiguousKill({ 0: run({ lastCreditedTs: inWin }) }, week),
    false
  )
  // an uncredited open-world run (a stranger's kill) does not count
  assert.equal(
    hasCreditedAmbiguousKill({ [-1]: run({ lastCreditedTs: 0 }) }, week),
    false
  )
  // last week's credited kill does not count
  assert.equal(
    hasCreditedAmbiguousKill({ [-1]: run({ lastCreditedTs: week.start - 1 }) }, week),
    false
  )
})

test('tierLadder without a manual arg is unchanged — five rungs, base first', () => {
  const rungs = tierLadder([])
  assert.deepEqual(
    rungs.map((r) => [r.tier, r.cleared]),
    [[0, false], [1, false], [2, false], [3, false], [4, false]]
  )
})

test('tierLadder merges a live manual base clear as a normal green rung', () => {
  const rungs = tierLadder([], WED)
  assert.deepEqual(rungs[0], { tier: 0, cleared: true, ts: WED, manual: true })
  // the other four are untouched
  assert.equal(rungs[1].cleared, false)
})

test('a real tier-0 lock wins over a manual mark (no double, no manual flag)', () => {
  const lock: TierLock = { tier: 0, ts: 12345 }
  const rungs = tierLadder([lock], WED)
  assert.deepEqual(rungs[0], { tier: 0, cleared: true, ts: 12345 })
})
