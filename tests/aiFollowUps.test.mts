import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AiLiveStatus, AiMentions } from '../src/shared/aiChat'
import { followUpsFor } from '../src/renderer/src/features/aiAssistant/followUps'

const STATUS: AiLiveStatus = {
  zone: 'The Plane of Sky',
  loadout: { ready: true, classes: ['ENC', 'MAG', 'NEC'], inferred: true, uncertain: false },
  dumps: [],
  recap: []
}

const ITEM: AiMentions = { items: ['Fungi Tunic'], spells: [], mobs: [] }

test('item mentions produce wearing and who drops', () => {
  const chips = followUpsFor('Where does it drop?', ITEM, { ...STATUS, zone: null })
  assert.equal(chips[0]?.label, 'Am I wearing this?')
  assert.equal(chips[0]?.prompt, 'Am I wearing Fungi Tunic?')
  assert.equal(chips[1]?.label, 'Who drops it?')
  assert.equal(chips[1]?.prompt, 'Who drops Fungi Tunic?')
})

test('zone produces worth killing', () => {
  const chips = followUpsFor('What just happened?', undefined, STATUS)
  assert.ok(chips.some((c) => c.label === 'What is worth killing here?'))
  assert.ok(chips.some((c) => c.prompt === 'What is worth killing in The Plane of Sky?'))
})

test('alert prompt skips extra alert chip', () => {
  const chips = followUpsFor('Alert me when charm breaks', undefined, { ...STATUS, zone: null })
  assert.equal(chips.some((c) => c.id === 'alert'), false)
  assert.equal(chips.length, 0)
})

test('caps at three and still offers the alert chip when there is room', () => {
  const withItemAndZone = followUpsFor('Where does it drop?', ITEM, STATUS)
  assert.equal(withItemAndZone.length, 3)
  assert.equal(withItemAndZone.some((c) => c.id === 'alert'), false)

  const withZoneOnly = followUpsFor('What just happened?', undefined, STATUS)
  assert.ok(withZoneOnly.length <= 3)
  assert.ok(withZoneOnly.some((c) => c.id === 'alert'))
})
