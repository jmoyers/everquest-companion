import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobsInZone, searchItems, searchMobs, searchSpells } from '../src/main/ai/aiKnowledge'
import { draftAlert } from '../src/main/ai/aiDraftAlert'
import { formatRecap, isRecapEvent } from '../src/main/ai/aiRecap'
import { AI_TOOLS, RETIRED_TOOL_NAMES } from '../src/main/ai/aiToolDefs'
import { resolveAiModel, AI_DEFAULT_MODEL, AI_MODEL_OPTIONS } from '../src/shared/aiModels'
import type { LogEvent } from '../src/shared/logEvents'

test('search_items hits a committed page by exact name', () => {
  const hits = searchItems('10 Dose Adrenaline Tap')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].page, '10 Dose Adrenaline Tap')
})

test('search_items substring is capped and prefers the named item', () => {
  const hits = searchItems('adrenaline tap')
  assert.ok(hits.length >= 1)
  assert.ok(hits.length <= 8)
  assert.ok(hits.some((h) => h.name.toLowerCase().includes('adrenaline tap')))
})

test('search_items empty query is no hits', () => {
  assert.deepEqual(searchItems('   '), [])
})

test('search_spells finds Clarity in the corrected catalog', () => {
  const hits = searchSpells('Clarity')
  assert.ok(hits.some((s) => s.name === 'Clarity'))
})

test('search_spells class token returns cleric rows', () => {
  const hits = searchSpells('class:clr')
  assert.ok(hits.length >= 1)
  assert.ok(hits.every((s) => s.classLevels.some((c) => c.cls === 'CLR')))
})

test('search_mobs finds a thunder spirit locally', () => {
  const hits = searchMobs('a thunder spirit')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].name, 'a thunder spirit')
  assert.ok((hits[0].drops?.length ?? 0) >= 0)
})

test('retired mock tools are gone from the schema', () => {
  const names = AI_TOOLS.map((t) => t.function.name)
  for (const retired of RETIRED_TOOL_NAMES) {
    assert.equal(names.includes(retired), false, retired)
  }
  assert.ok(names.includes('search_items'))
  assert.ok(names.includes('draft_alert'))
  assert.ok(names.includes('get_loadout'))
  assert.ok(names.includes('get_fight'))
  assert.ok(names.includes('get_zone'))
  assert.ok(names.includes('get_buffs'))
  assert.ok(names.includes('get_recent_loot'))
})

test('mobsInZone finds catalog rows for a real zone name', () => {
  const hits = mobsInZone('Plane of Sky')
  assert.ok(hits.length >= 1)
  assert.ok(hits.every((m) => (m.zones ?? []).some((z) => /sky/i.test(z))))
})

test('mobsInZone finds Befallen', () => {
  const hits = mobsInZone('Befallen')
  assert.ok(hits.length >= 1)
  assert.ok(hits.every((m) => (m.zones ?? []).some((z) => /befallen/i.test(z))))
})

test('draft_alert with a spell is a typed trigger and is not a store write', () => {
  const draft = draftAlert({ name: 'Clarity lands', spell: 'Clarity' })
  assert.ok(!('error' in draft))
  if ('error' in draft) return
  assert.equal(draft.trigger.type, 'event')
  if (draft.trigger.type === 'event') {
    assert.equal(draft.trigger.kind, 'buffApply')
    assert.equal(draft.trigger.where?.spell, 'Clarity')
  }
  assert.notEqual(draft.sound.packId, 'system')
  assert.notEqual(draft.sound.soundId, 'none')
})

test('draft_alert without a matcher errors', () => {
  const draft = draftAlert({ name: 'Nope' })
  assert.deepEqual(draft, { error: 'Provide spell, a known eventKind, or triggerRegex.' })
})

test('draft_alert eventKind uses a typed event trigger', () => {
  const draft = draftAlert({ name: 'Zone', eventKind: 'zone' })
  assert.ok(!('error' in draft))
  if ('error' in draft) return
  assert.equal(draft.trigger.type, 'event')
  if (draft.trigger.type === 'event') assert.equal(draft.trigger.kind, 'zone')
})

test('draft_alert regex is only the custom-line path', () => {
  const draft = draftAlert({ name: 'Custom', triggerRegex: '\\] You shout' })
  assert.ok(!('error' in draft))
  if ('error' in draft) return
  assert.equal(draft.trigger.type, 'raw')
  if (draft.trigger.type === 'raw') assert.equal(draft.trigger.regex, '\\] You shout')
})

test('unknown stored model degrades to the default', () => {
  assert.equal(resolveAiModel('poolside/laguna-xs-2.1'), AI_DEFAULT_MODEL)
  assert.equal(resolveAiModel('deepseek/deepseek-chat'), 'deepseek/deepseek-chat')
})

test('picker is two models per tier and Free slugs stay :free', () => {
  const byTier = { free: 0, good: 0, better: 0, best: 0 }
  for (const opt of AI_MODEL_OPTIONS) byTier[opt.tier] += 1
  assert.deepEqual(byTier, { free: 2, good: 2, better: 2, best: 2 })
  for (const opt of AI_MODEL_OPTIONS) {
    if (opt.tier === 'free') assert.match(opt.id, /:free$/)
    else assert.doesNotMatch(opt.id, /:free$/)
    assert.match(opt.label, /^\[(Free|Good|Better|Best)\] /)
  }
  assert.equal(AI_DEFAULT_MODEL, 'deepseek/deepseek-chat')
})

test('recap formats zone and damage from parsed fields, not raw', () => {
  const events: LogEvent[] = [
    { kind: 'zone', zone: 'The Plane of Sky', ts: Date.parse('2026-08-01T12:00:00'), seq: 1, raw: 'CHAT SHOULD NOT APPEAR' },
    {
      kind: 'damage',
      attacker: 'You',
      target: 'a thunder spirit',
      amount: 142,
      dtype: 'melee',
      skill: 'Melee',
      crit: false,
      ts: Date.parse('2026-08-01T12:00:08'),
      seq: 2,
      raw: 'ignored'
    }
  ]
  const lines = formatRecap(events)
  assert.ok(lines[0].includes('The Plane of Sky'))
  assert.ok(lines[1].includes('a thunder spirit'))
  assert.ok(lines[1].includes('142'))
  assert.ok(!lines.join('\n').includes('CHAT SHOULD NOT APPEAR'))
})

test('chat-like kinds are not recap events', () => {
  const fake = { kind: 'tell', ts: 1, seq: 1, raw: 'hi' } as unknown as LogEvent
  assert.equal(isRecapEvent(fake), false)
})
