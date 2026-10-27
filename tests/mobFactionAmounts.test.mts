// MobEntry.factionAmounts strings (src/shared/mobFactionAmounts.ts): every shape the mob-page parser
// writes reads back to the hit it encodes, and encodes again to the same string.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeFactionAmount, encodeFactionAmount, type MobFactionHit } from '../src/shared/mobFactionAmounts'

const SHAPES: [string, MobFactionHit][] = [
  ['-1', { side: 'lowers', min: -1, max: -1 }],
  ['-100', { side: 'lowers', min: -100, max: -100 }],
  ['10', { side: 'raises', min: 10, max: 10 }],
  ['-10?', { side: 'lowers', min: -10, max: -10, unconfirmed: true }],
  ['10?', { side: 'raises', min: 10, max: 10, unconfirmed: true }],
  // A Troll Slayer: `(-10) to (-30) (unconfirmed)`.
  ['-30..-10?', { side: 'lowers', min: -30, max: -10, unconfirmed: true }],
  ['-30..-10', { side: 'lowers', min: -30, max: -10 }],
  ['5..10', { side: 'raises', min: 5, max: 10 }],
  ['-', { side: 'lowers' }],
  ['+', { side: 'raises' }],
  ['-?', { side: 'lowers', unconfirmed: true }],
  ['+?', { side: 'raises', unconfirmed: true }]
]

test('every stored shape decodes to its hit and encodes back to the same string', () => {
  for (const [s, hit] of SHAPES) {
    assert.deepEqual(decodeFactionAmount(s), hit, s)
    assert.equal(encodeFactionAmount(hit), s, s)
  }
})

test('a single amount is one number, not a range of one', () => {
  assert.equal(encodeFactionAmount({ side: 'lowers', min: -30, max: -30 }), '-30')
})
