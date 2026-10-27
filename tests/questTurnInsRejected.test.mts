// ============================================================================
// Taking a Sky turn-in back (upstream issue #72) — the rejected list.
// ============================================================================
//
// THE REPORT (jmoyers/everquest-companion#72): the Sky tab marked quests turned in that the
// player had not done, and nothing could lower it — not a fresh achievements dump, not the
// Count-from "rebase" (which only moves held counts), not a reinstall (the state is in userData
// and is rebuilt from the log). The mechanism: a trade the log showed can be wrong, an abandoned
// offer folded into the next trade to the same giver, or a trade the NPC handed straight back —
// and a log-detected instant could not be undone, because the next snapshot re-persisted it.
//
// The fix is one rule, pinned here against the REAL shared code: a REJECTED instant
// (`ProgressState.rejectedTurnIns`) is absent everywhere a turn-in is read, and it stays absent
// when the log shows it again. The undo and the reset are both STATEMENTS of that rule
// (`takeBackTurnIn`, `rejectAllTurnIns`), so the renderer carries no arithmetic of its own.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_TURN_INS_PER_QUEST,
  applyTurnIns,
  rejectAllTurnIns,
  rejectedTurnIns,
  resolveTurnIns,
  sanitizeTurnInInstants,
  takeBackTurnIn,
  turnInsToPersist,
  withoutRejected
} from '../src/shared/questTurnIns'
import { questKey } from '../src/renderer/src/features/posky/keys'
import type { PoskyQuest, ProgressState } from '../src/shared/types'

const CLAW: PoskyQuest = {
  className: 'Beastlord',
  name: 'Test of Claw',
  giver: 'Gorgalosk',
  items: [{ name: 'Sphinx Claw', count: 2, who: [], where: 'Island 4' }]
}
const CLAW_KEY = questKey(CLAW)

const progress = (p: Partial<ProgressState>): ProgressState => ({
  inventory: {},
  completedQuests: [],
  ...p
})

test('a rejected detection is not a turn-in, even though the log still shows it', () => {
  const p = progress({ rejectedTurnIns: { [CLAW_KEY]: [1000] } })
  const r = resolveTurnIns(p, { [CLAW_KEY]: [1000] })
  assert.deepEqual(r.instants, {}, 'the instant is gone from the ledger')
  assert.deepEqual(r.all, {}, 'and so is the count')
})

test('…and a copy of it an older build re-persisted into the store is refused the same way', () => {
  const p = progress({ questTurnIns: { [CLAW_KEY]: [1000, 2000] }, rejectedTurnIns: { [CLAW_KEY]: [1000] } })
  const r = resolveTurnIns(p, { [CLAW_KEY]: [1000] })
  assert.deepEqual(r.instants[CLAW_KEY], [2000], 'the other turn-in stands')
  assert.equal(r.all[CLAW_KEY], 1)
})

test('rejecting is per instant: a later trade of the same quest counts', () => {
  const rejected = { [CLAW_KEY]: [1000] }
  assert.deepEqual(withoutRejected({ [CLAW_KEY]: [1000, 5000] }, rejected), { [CLAW_KEY]: [5000] })
  assert.deepEqual(withoutRejected({ [CLAW_KEY]: [1000] }, rejected), {}, 'a key left with nothing drops')
})

test('an undo of a log-detected instant persists both halves in one statement', () => {
  const p = progress({ questTurnIns: { [CLAW_KEY]: [1000] }, completedQuests: [CLAW_KEY] })
  const next = applyTurnIns(p, CLAW_KEY, [], [1000])
  assert.deepEqual(next.questTurnIns, {}, 'the instant is out of the ledger')
  assert.deepEqual(next.completedQuests, [], 'and out of the downgrade mirror, so a legacy floor cannot keep it')
  assert.deepEqual(next.rejectedTurnIns, { [CLAW_KEY]: [1000] }, 'and remembered as rejected')
  // The next snapshot shows the same trade again: nothing to persist, nothing to count.
  const again = resolveTurnIns({ ...p, ...next }, { [CLAW_KEY]: [1000] })
  assert.deepEqual(turnInsToPersist({ ...p, ...next }, again.instants), [])
  assert.deepEqual(again.all, {})
})

test('applyTurnIns without a rejected list leaves the stored rejections alone', () => {
  const p = progress({ rejectedTurnIns: { [CLAW_KEY]: [1000] } })
  const next = applyTurnIns(p, CLAW_KEY, [3000])
  assert.equal('rejectedTurnIns' in next, false, 'the key is not restated')
  assert.deepEqual(resolveTurnIns({ ...p, ...next }, { [CLAW_KEY]: [1000] }).instants[CLAW_KEY], [3000])
})

test('the rejected list is sanitized like the ledger: junk dropped, a hand-edited store survives', () => {
  const p = progress({ rejectedTurnIns: { [CLAW_KEY]: [1000, -1, 'x' as unknown as number], other: [] } })
  assert.deepEqual(rejectedTurnIns(p), { [CLAW_KEY]: [1000] })
  assert.deepEqual(rejectedTurnIns(progress({})), {})
  assert.deepEqual(rejectedTurnIns(null), {})
})

test('a full rejected list keeps its NEWEST instants, so the latest take-back is the one that sticks', () => {
  const old = Array.from({ length: MAX_TURN_INS_PER_QUEST }, (_, i) => 1000 + i)
  const newest = 999_999
  // The undo restates the whole list with the new rejection on the end; the oldest one gives way.
  const next = applyTurnIns(progress({}), CLAW_KEY, [], [...old, newest])
  const kept = next.rejectedTurnIns?.[CLAW_KEY] ?? []
  assert.equal(kept.length, MAX_TURN_INS_PER_QUEST)
  assert.equal(kept[kept.length - 1], newest)
  assert.equal(kept[0], 1001)
  // …and the same on the way back out of a store that holds more.
  const read = rejectedTurnIns(progress({ rejectedTurnIns: { [CLAW_KEY]: [...old, newest] } }))[CLAW_KEY]
  assert.deepEqual([read.length, read[0], read[read.length - 1]], [MAX_TURN_INS_PER_QUEST, 1001, newest])
  // The turn-in list itself is unchanged: its cap still keeps the oldest.
  assert.equal(sanitizeTurnInInstants([...old, newest]).includes(newest), false)
})

test('THE UNDO STATEMENT: a hand-recorded instant is dropped, a log-detected one is dropped AND rejected', () => {
  assert.deepEqual(takeBackTurnIn([1000, 2000], [1000], []), { instants: [1000] }, 'newest was by hand')
  assert.deepEqual(takeBackTurnIn([1000, 2000], [2000], []), { instants: [1000], rejected: [2000] })
  assert.deepEqual(takeBackTurnIn([1000], [1000], [500]), { instants: [], rejected: [500, 1000] }, 'earlier rejections kept')
  assert.deepEqual(takeBackTurnIn([], [], []), { instants: [] }, 'nothing left: the legacy floor clears')
})

test('THE RESET STATEMENT: nothing turned in, every detection rejected, earlier rejections kept', () => {
  assert.deepEqual(rejectAllTurnIns([1000, 2000], [500]), { instants: [], rejected: [500, 1000, 2000] })
  assert.deepEqual(rejectAllTurnIns([], []), { instants: [], rejected: [] })
})
