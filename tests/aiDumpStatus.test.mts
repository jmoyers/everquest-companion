import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AiLiveStatus } from '../src/shared/aiChat'
import { askAgainChips, dumpNoticesFor } from '../src/renderer/src/features/aiAssistant/dumpStatus'

const emptyInv: AiLiveStatus = {
  zone: null,
  loadout: { ready: false, classes: [], inferred: false, uncertain: false },
  dumps: [{ kind: 'inventory', command: '/outputfile inventory', empty: true, updatedAt: null }],
  recap: []
}

const fullInv: AiLiveStatus = {
  ...emptyInv,
  dumps: [{ kind: 'inventory', command: '/outputfile inventory', empty: false, updatedAt: 1 }]
}

test('first poll is not a dump notice', () => {
  assert.deepEqual(dumpNoticesFor(null, fullInv), [])
})

test('empty to present is Bags updated', () => {
  assert.deepEqual(dumpNoticesFor(emptyInv, fullInv), ['Bags updated'])
})

test('ask-again is a chip with the last prompt, never empty', () => {
  const chips = askAgainChips(['Bags updated'], 'Am I wearing Fungi Tunic?')
  assert.equal(chips.length, 1)
  assert.equal(chips[0]?.id, 'ask-bags')
  assert.equal(chips[0]?.label, 'Ask again with bags')
  assert.equal(chips[0]?.prompt, 'Am I wearing Fungi Tunic?')
  assert.deepEqual(askAgainChips(['Bags updated'], '  '), [])
})
