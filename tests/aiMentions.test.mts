import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  emptyMentions,
  mentionsFromToolResult,
  mergeMentions
} from '../src/main/ai/aiMentions'

const itemsJson = JSON.stringify({
  hits: [{ name: 'Rod of Insidious Glamour' }, { name: 'Cloak of the Sky' }, { name: '' }]
})
const spellsJson = JSON.stringify({
  hits: [{ name: 'Clarity' }, { name: 'Kei' }, { extra: true }]
})
const mobsJson = JSON.stringify({
  hits: [{ name: 'a thunder spirit' }, { name: 'an azure drake' }]
})

test('search_items harvests hit names', () => {
  assert.deepEqual(mentionsFromToolResult('search_items', itemsJson), {
    items: ['Rod of Insidious Glamour', 'Cloak of the Sky'],
    spells: [],
    mobs: []
  })
})

test('search_spells harvests hit names', () => {
  assert.deepEqual(mentionsFromToolResult('search_spells', spellsJson), {
    items: [],
    spells: ['Clarity', 'Kei'],
    mobs: []
  })
})

test('search_mobs harvests hit names', () => {
  assert.deepEqual(mentionsFromToolResult('search_mobs', mobsJson), {
    items: [],
    spells: [],
    mobs: ['a thunder spirit', 'an azure drake']
  })
})

test('unknown tool and junk JSON are empty mentions', () => {
  assert.deepEqual(mentionsFromToolResult('get_loadout', itemsJson), emptyMentions())
  assert.deepEqual(mentionsFromToolResult('search_items', 'not-json'), emptyMentions())
  assert.deepEqual(mentionsFromToolResult('search_items', '{"hits":null}'), emptyMentions())
})

test('mergeMentions concatenates unique names and caps at 12', () => {
  const a = mentionsFromToolResult('search_items', itemsJson)
  const b = mentionsFromToolResult(
    'search_items',
    JSON.stringify({ hits: [{ name: 'cloak of the sky' }, { name: 'Journeyman Boots' }] })
  )
  const merged = mergeMentions(a, b)
  assert.deepEqual(merged.items, [
    'Rod of Insidious Glamour',
    'Cloak of the Sky',
    'Journeyman Boots'
  ])

  const many = {
    items: Array.from({ length: 20 }, (_, i) => `Item ${i}`),
    spells: [],
    mobs: []
  }
  assert.equal(mergeMentions(emptyMentions(), many).items.length, 12)
  assert.equal(mergeMentions(emptyMentions(), many).items[0], 'Item 0')
  assert.equal(mergeMentions(emptyMentions(), many).items[11], 'Item 11')
})
