import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proactiveTip } from '../src/main/ai/aiProactive'

const BASE = {
  enabled: true,
  inCombat: false,
  hook: 'zone' as const,
  zone: 'Old Sebilis',
  classes: ['WIZ', 'NEC', 'PAL'],
  inferred: false,
  currentLevel: 20,
  lastLevelHere: 15,
  spells: [{ cls: 'WIZ', names: ['Gate'] }],
  mobs: ['a sebilitite', 'Trakanon']
}

test('proactive stays quiet when off or in combat', () => {
  assert.equal(proactiveTip({ ...BASE, enabled: false }), null)
  assert.equal(proactiveTip({ ...BASE, inCombat: true }), null)
})

test('first visit with no catalog names stays quiet', () => {
  assert.equal(proactiveTip({ ...BASE, lastLevelHere: null, mobs: [] }), null)
})

test('first visit names catalog mobs in the zone', () => {
  const text = proactiveTip({ ...BASE, lastLevelHere: null })
  assert.ok(text)
  assert.match(text, /Old Sebilis/)
  assert.match(text, /a sebilitite/)
  assert.doesNotMatch(text, /gained/)
  assert.doesNotMatch(text, /\u2013|\u2014/)
})

test('same-level re-enter still primers when the catalog has names', () => {
  const text = proactiveTip({ ...BASE, lastLevelHere: 20, currentLevel: 20 })
  assert.ok(text)
  assert.match(text, /Catalog names here/)
})

test('zone re-enter after dings names the zone, delta, classes, and spells', () => {
  const text = proactiveTip(BASE)
  assert.ok(text)
  assert.match(text, /Old Sebilis/)
  assert.match(text, /5 levels/)
  assert.match(text, /WIZ, NEC, PAL/)
  assert.match(text, /Gate/)
  assert.doesNotMatch(text, /\u2013|\u2014/)
})
