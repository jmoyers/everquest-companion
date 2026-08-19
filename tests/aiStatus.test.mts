import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dumpLiveFrom,
  epochMsFromIso,
  loadoutLiveFromSummary,
  takeSseLines,
  tokenFromSseLine
} from '../src/main/ai/aiMentions'

test('loadoutLiveFromSummary maps getLoadoutSummary fields', () => {
  assert.deepEqual(loadoutLiveFromSummary({ ready: false }), {
    ready: false,
    classes: [],
    inferred: false,
    uncertain: false
  })
  assert.deepEqual(
    loadoutLiveFromSummary({
      ready: true,
      classes: ['ENC', 'MAG'],
      inferred: true,
      uncertain: false,
      note: 'ignored'
    }),
    { ready: true, classes: ['ENC', 'MAG'], inferred: true, uncertain: false }
  )
})

test('epochMsFromIso and dumpLiveFrom use registry command + dump text', () => {
  assert.equal(epochMsFromIso(null), null)
  assert.equal(epochMsFromIso('not-a-date'), null)
  const iso = '2026-08-18T12:00:00.000Z'
  assert.equal(epochMsFromIso(iso), Date.parse(iso))

  assert.deepEqual(dumpLiveFrom('inventory', '/outputfile inventory', '[EMPTY]', null), {
    kind: 'inventory',
    command: '/outputfile inventory',
    empty: true,
    updatedAt: null
  })
  assert.deepEqual(
    dumpLiveFrom('spellbook', '/outputfile spellbook', 'Gate\t1', iso),
    {
      kind: 'spellbook',
      command: '/outputfile spellbook',
      empty: false,
      updatedAt: Date.parse(iso)
    }
  )
})

test('tokenFromSseLine reads OpenRouter delta content and skips [DONE]', () => {
  const line = 'data: {"choices":[{"delta":{"content":"Hello"}}]}'
  assert.equal(tokenFromSseLine(line), 'Hello')
  assert.equal(tokenFromSseLine('data: [DONE]'), null)
  assert.equal(tokenFromSseLine('event: ping'), null)
  assert.equal(tokenFromSseLine('data: {"choices":[{"delta":{}}]}'), null)
  assert.equal(tokenFromSseLine('data: not-json'), null)
})

test('takeSseLines keeps the incomplete tail', () => {
  const { lines, rest } = takeSseLines('data: {"choices":[{"delta":{"content":"A"}}]}\ndata: {"cho')
  assert.deepEqual(lines, ['data: {"choices":[{"delta":{"content":"A"}}]}'])
  assert.equal(rest, 'data: {"cho')
  assert.equal(tokenFromSseLine(lines[0] ?? ''), 'A')
})
