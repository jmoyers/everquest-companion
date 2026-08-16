// ============================================================================
// Issue #27 — a quest whose REWARD is in the inventory export has been turned in.
// ============================================================================
//
// THE REPORT (github issue #27, and reproduced on a second install): a fresh install loads an
// inventory export, the export plainly contains a Sky quest's reward item, and the quest still
// reads "not turned in". Nothing was broken — nothing ever consulted the reward. The ledger
// (shared/questTurnIns.ts) has exactly three sources: log-detected trades, hand statements, and
// the legacy `completedQuests` key. A turn-in done before logging was on leaves none of those.
//
// WHY THE INFERENCE IS SOUND, measured against the committed data (2026-08-16): every one of the
// 95 Sky quests has a reward, every reward is UNIQUE to its quest, none appears as a drop
// anywhere in the items DB, none is consumed by another Sky quest, and 92 of 94 in the DB are
// NO DROP. Holding the reward proves at least one turn-in the same way a log line would.
//
// WHAT THIS SUITE PINS:
//   1. THE SET (`rewardInferredQuests`): which quest keys the loaded export vouches for —
//      matching on the same counting key the held counts use (lowercased, `+N` folded), so an
//      exalted reward still testifies for its quest. A quest with no reward in the data never
//      infers; an absent export infers nothing.
//   2. THE FLOOR (`withRewardInference`): a vouched-for quest with NO other evidence reads
//      turnIns 1 / completed, and says WHERE the reading came from (`rewardInferred`), because a
//      reader who cannot tell "the log said so" from "we worked it out" cannot tell which rows
//      to trust (the classUnlocks.ts precedent). Real evidence wins: any ledger count leaves the
//      quest untouched and unlabelled.
//   3. WHAT IT NEVER TOUCHES: the inference is DERIVED state — applied after
//      `computeQuestProgress`, never written to the ledger — so consumption, the celebration
//      baseline and persistence never see it. An inferred turn-in predates the log, so its items
//      were never in the log counts and it owes no subtraction (the "a dump owes none" rule,
//      one storey up).
//   4. THE COMPOSITIONS: `everTurnedIn` reads an inferred quest as run, so the hide-turned-in
//      box, the class-unlock derivation and the Ready tab's first-time default all get the same
//      answer without reading a second field.
//
// ONE-DIRECTIONAL, deliberately: reward present ⇒ turned in; reward ABSENT proves nothing (the
// export only covers what was open when it was written — a banked reward is invisible). Nothing
// here ever un-completes a quest, which is the same promise "a dump adds, it never subtracts"
// already makes about counts.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  rewardInferredQuests,
  withRewardInference
} from '../src/renderer/src/features/posky/rewardInference'
import { everTurnedIn, firstTimeReady } from '../src/renderer/src/features/posky/questCompletion'
import type { QuestProgress } from '../src/renderer/src/features/posky/useProgress'

// =============================================================================
// 1. The set: which quests the export vouches for
// =============================================================================

/** The three fields the inference reads; everything else on PoskyQuest is not its business. */
const QUESTS = [
  { className: 'Cleric', name: 'Cleric Test of Resolution', reward: 'Necklace of Resolution' },
  { className: 'Wizard', name: 'Wizard Test of Focus', reward: "Al`Kabor's Cap of Binding" },
  { className: 'Rogue', name: 'Rogue Test of Thievery', reward: 'Wispy Choker of Vigor' },
  // The data has no quest without a reward today; the type allows one, so the rule must too.
  { className: 'Monk', name: 'Monk Test of Stone', reward: undefined }
]

test('a reward sitting in the export vouches for its quest', () => {
  const keys = rewardInferredQuests(QUESTS, { 'necklace of resolution': 1 })
  assert.ok(keys.has('Cleric::Cleric Test of Resolution'))
  assert.equal(keys.size, 1)
})

test('an exalted reward still testifies: the +N variant folds onto the counting key', () => {
  // heldCountsFromDump keys are the RAW name lowercased — the fold is the inference's job.
  const keys = rewardInferredQuests(QUESTS, { "al`kabor's cap of binding +2": 1 })
  assert.ok(keys.has('Wizard::Wizard Test of Focus'))
})

test('a quest with no reward in the data never infers (missing data, not a finished quest)', () => {
  const keys = rewardInferredQuests(QUESTS, { 'necklace of resolution': 1, undefined: 1 })
  assert.ok(!keys.has('Monk::Monk Test of Stone'))
})

test('an absent reward proves nothing, and an absent export proves nothing about anything', () => {
  assert.equal(rewardInferredQuests(QUESTS, { 'wispy choker of vigor': 1 }).size, 1)
  assert.equal(rewardInferredQuests(QUESTS, {}).size, 0)
  assert.equal(rewardInferredQuests(QUESTS, undefined).size, 0)
})

test('a zero or negative count is an absent item, not a held one', () => {
  const keys = rewardInferredQuests(QUESTS, {
    'necklace of resolution': 0,
    'wispy choker of vigor': -1
  })
  assert.equal(keys.size, 0)
})

// =============================================================================
// 2. The floor, and what real evidence does to it
// =============================================================================

/** A QuestProgress as a quest nobody has touched would carry it (the questRow precedent). */
function questRow(p: { className: string; name: string; turnIns?: number }): QuestProgress {
  const turnIns = p.turnIns ?? 0
  return {
    key: `${p.className}::${p.name}`,
    className: p.className,
    name: p.name,
    items: [],
    haveCount: 0,
    needCount: 2,
    ratio: 0,
    missing: ['Wind Rune Ena', 'Pulsating Ruby'],
    turnIns,
    logTurnIns: 0,
    completed: turnIns >= 1
  }
}

const VOUCHED = new Set(['Cleric::Cleric Test of Resolution'])

test('no other evidence + reward held → turnIns floors at 1, completed, and says why', () => {
  const q = withRewardInference(questRow({ className: 'Cleric', name: 'Cleric Test of Resolution' }), VOUCHED)
  assert.equal(q.turnIns, 1)
  assert.equal(q.completed, true)
  assert.equal(q.rewardInferred, true)
  // The log's share is untouched: nothing here is log evidence.
  assert.equal(q.logTurnIns, 0)
})

test('a quest the export does not vouch for is returned untouched and unlabelled', () => {
  const before = questRow({ className: 'Rogue', name: 'Rogue Test of Thievery' })
  const after = withRewardInference(before, VOUCHED)
  assert.equal(after.turnIns, 0)
  assert.equal(after.completed, false)
  assert.equal(after.rewardInferred, undefined)
})

test('real evidence wins: a ledger count is never floored, relabelled or double-counted', () => {
  const q = withRewardInference(
    questRow({ className: 'Cleric', name: 'Cleric Test of Resolution', turnIns: 2 }),
    VOUCHED
  )
  assert.equal(q.turnIns, 2)
  assert.equal(q.rewardInferred, undefined)
})

test('the transform is pure: the input row is not mutated', () => {
  const before = questRow({ className: 'Cleric', name: 'Cleric Test of Resolution' })
  withRewardInference(before, VOUCHED)
  assert.equal(before.turnIns, 0)
  assert.equal(before.completed, false)
  assert.equal((before as { rewardInferred?: true }).rewardInferred, undefined)
})

// =============================================================================
// 3. The compositions: one field, every downstream reading agrees
// =============================================================================

test('everTurnedIn reads an inferred quest as run — hide-turned-in and class unlocks follow', () => {
  const q = withRewardInference(questRow({ className: 'Cleric', name: 'Cleric Test of Resolution' }), VOUCHED)
  assert.equal(everTurnedIn(q), true)
})

test('the Ready tab’s first-time default drops an inferred quest: it has been run', () => {
  const inferred = withRewardInference(
    questRow({ className: 'Cleric', name: 'Cleric Test of Resolution' }),
    VOUCHED
  )
  const fresh = questRow({ className: 'Rogue', name: 'Rogue Test of Thievery' })
  assert.deepEqual(
    firstTimeReady([inferred, fresh]).map((q) => q.key),
    ['Rogue::Rogue Test of Thievery']
  )
})
