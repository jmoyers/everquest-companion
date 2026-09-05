import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AlertDef } from '../src/shared/alertTypes'
import {
  applyStreamChunk,
  dropDraft,
  toolWord
} from '../src/renderer/src/features/aiAssistant/streamApply'
import type { ChatMessage } from '../src/renderer/src/features/aiAssistant/chatTypes'

const DRAFT: AlertDef = {
  id: 'd1',
  name: 'Charm break',
  enabled: true,
  trigger: { type: 'event', kind: 'uncharm' },
  sound: { packId: 'alan-rickman', soundId: 'break' }
}

test('tool chunk writes the real tool name', () => {
  const pending: ChatMessage[] = [
    { role: 'user', text: 'what is this' },
    { role: 'ai', text: '', pending: true }
  ]
  const next = applyStreamChunk(
    pending,
    { requestId: 'r1', kind: 'tool', tool: 'search_items' },
    'r1'
  )
  assert.equal(next[1]?.toolHint, 'items')
  assert.equal(toolWord('get_loadout'), 'loadout')
})

test('dropDraft removes one card and leaves the rest', () => {
  const other: AlertDef = { ...DRAFT, id: 'd2', name: 'Mez' }
  const msgs: ChatMessage[] = [
    { role: 'ai', text: 'ok', drafts: [DRAFT, other] }
  ]
  const next = dropDraft(msgs, 0, 'd1')
  assert.deepEqual(next[0]?.drafts?.map((d) => d.id), ['d2'])
  assert.equal(dropDraft(next, 0, 'd2')[0]?.drafts, undefined)
})
