// THE TURN-IN STATEMENTS BEFORE AND AFTER THE LOG HAS LOADED (src/renderer/src/features/posky/turnInActions.ts).
//
// Right after launch the store already holds the persisted detections and the turn-ins module has
// not answered, so `detected` is empty. An undo then could not tell a detection from a
// hand-recorded instant: it dropped the instant WITHOUT rejecting it, and the module's first
// snapshot wrote the trade straight back. The hook now takes `detected: null` for "not loaded" and
// says nothing until it has; the Sky tab disables both controls on the same flag.
//
// Run for real through `hookHost.mts` (no jsdom here); `window.eq` is a recording stub.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mountHook } from './hookHost.mjs'
import { useTurnInActions } from '../src/renderer/src/features/posky/turnInActions'
import type { QuestTurnIns, TurnInInstants } from '../src/shared/questTurnIns'
import type { ProgressState } from '../src/shared/types'

const KEY = 'Cleric::Test of Faith'
const DETECTED_AT = 1_700_000_000_000
const TURN_INS: QuestTurnIns = { instants: { [KEY]: [DETECTED_AT] }, all: { [KEY]: 1 } }

interface Call {
  key: string
  instants: number[]
  rejected?: number[]
}

function stubBridge(): Call[] {
  const calls: Call[] = []
  const setQuestTurnIns = (key: string, instants: number[], rejected?: number[]): Promise<ProgressState> => {
    calls.push(rejected === undefined ? { key, instants } : { key, instants, rejected })
    return Promise.resolve({} as ProgressState)
  }
  ;(globalThis as { window?: unknown }).window = { eq: { setQuestTurnIns } }
  return calls
}

function actions(detected: TurnInInstants | null): ReturnType<typeof useTurnInActions> {
  return mountHook(() => useTurnInActions(TURN_INS, detected, {}, () => undefined)).value
}

test('before the log has loaded, undo and reset state nothing', async () => {
  const calls = stubBridge()
  const a = actions(null)
  await a.undoTurnIn(KEY)
  await a.resetTurnIns()
  assert.deepEqual(calls, [])
})

test('once it has, taking back a detection rejects it so the next snapshot cannot restore it', async () => {
  const calls = stubBridge()
  await actions({ [KEY]: [DETECTED_AT] }).undoTurnIn(KEY)
  assert.deepEqual(calls, [{ key: KEY, instants: [], rejected: [DETECTED_AT] }])
})

test('once it has, the reset rejects every detection it takes back', async () => {
  const calls = stubBridge()
  await actions({ [KEY]: [DETECTED_AT] }).resetTurnIns()
  assert.deepEqual(calls, [{ key: KEY, instants: [], rejected: [DETECTED_AT] }])
})

test('a second record before the re-render keeps the first one', async () => {
  const calls = stubBridge()
  const a = actions({ [KEY]: [DETECTED_AT] })
  await a.recordTurnIn(KEY)
  await a.recordTurnIn(KEY)
  const [first, second] = calls.map((c) => c.instants)
  assert.equal(first.length, 2)
  assert.deepEqual(second.slice(0, 2), first)
  assert.equal(second.length, 3)
})
