import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AlertDef } from '../src/shared/alertTypes'
import {
  AI_CHAT_PERSIST_CAP,
  appendAiChatTip,
  parseAiChat,
  serializeAiChat,
  toolHintName
} from '../src/shared/aiChat'
import { aiModelBarLabel, formatAiSpend } from '../src/shared/aiModels'

const DRAFT: AlertDef = {
  id: 'draft-1',
  name: 'Charm break',
  enabled: true,
  trigger: { type: 'event', kind: 'uncharm' },
  sound: { packId: 'alan-rickman', soundId: 'break' }
}

test('appendAiChatTip writes one assistant line and skips a duplicate last line', () => {
  const first = appendAiChatTip(null, 'You just entered Befallen.')
  const rows = parseAiChat(first)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.role, 'ai')
  assert.equal(rows[0]?.text, 'You just entered Befallen.')
  assert.equal(appendAiChatTip(first, 'You just entered Befallen.'), first)
})

test('parseAiChat degrades junk to empty', () => {
  assert.deepEqual(parseAiChat(null), [])
  assert.deepEqual(parseAiChat('nope'), [])
  assert.deepEqual(parseAiChat('{}'), [])
})

test('serialize then parse keeps user and ai text', () => {
  const raw = serializeAiChat([
    { role: 'user', text: 'Where does it drop?' },
    { role: 'ai', text: 'A thunder spirit.' }
  ])
  assert.deepEqual(parseAiChat(raw), [
    { role: 'user', text: 'Where does it drop?' },
    { role: 'ai', text: 'A thunder spirit.' }
  ])
})

test('persist cap keeps the tail', () => {
  const many = Array.from({ length: AI_CHAT_PERSIST_CAP + 5 }, (_, i) => ({
    role: 'user' as const,
    text: String(i)
  }))
  const parsed = parseAiChat(serializeAiChat(many))
  assert.equal(parsed.length, AI_CHAT_PERSIST_CAP)
  assert.equal(parsed[0].text, '5')
})

test('persist keeps draft cards and mention names', () => {
  const raw = serializeAiChat([
    { role: 'user', text: 'Alert me on charm break' },
    {
      role: 'ai',
      text: 'I can watch Fungi Tunic.',
      drafts: [DRAFT],
      mentions: { items: ['Fungi Tunic'], spells: [], mobs: [] }
    }
  ])
  const parsed = parseAiChat(raw)
  assert.equal(parsed[1]?.drafts?.[0]?.id, 'draft-1')
  assert.equal(parsed[1]?.drafts?.[0]?.name, 'Charm break')
  assert.deepEqual(parsed[1]?.mentions?.items, ['Fungi Tunic'])
})

test('persist drops junk drafts and keeps old text-only rows', () => {
  const raw = JSON.stringify([
    { role: 'ai', text: 'ok', drafts: [{ id: 1 }], mentions: { items: ['A'], spells: 'nope' } }
  ])
  const parsed = parseAiChat(raw)
  assert.equal(parsed[0]?.text, 'ok')
  assert.equal(parsed[0]?.drafts, undefined)
  assert.deepEqual(parsed[0]?.mentions?.items, ['A'])
})

test('spend bar formats dollars and strips the picker tier prefix', () => {
  assert.equal(formatAiSpend(0.015), '$0.015')
  assert.equal(formatAiSpend(null), '-')
  assert.equal(aiModelBarLabel('deepseek/deepseek-v4-flash-0731'), 'DeepSeek V4 Flash')
})

test('toolHintName is the real tool, never a generic looking-up phrase', () => {
  assert.equal(toolHintName('search_items'), 'items')
  assert.equal(toolHintName('search_spells'), 'spells')
  assert.equal(toolHintName('search_mobs'), 'mobs')
  assert.equal(toolHintName('get_loadout'), 'loadout')
  assert.equal(toolHintName('get_aa'), 'aa')
  assert.equal(toolHintName('get_output'), 'output')
  assert.equal(toolHintName('draft_alert'), 'alert')
  assert.equal(toolHintName(undefined), '')
  assert.doesNotMatch(toolHintName('search_items'), /looking/i)
})
