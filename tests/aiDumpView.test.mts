import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DUMP_STALE_MS, dumpHonesty } from '../src/main/ai/aiDumpView'
import { compactFight, compactLoot, compactZone } from '../src/main/ai/aiLiveViews'

test('empty dump tells them to type the command', () => {
  const d = dumpHonesty({
    kind: 'inventory',
    command: '/outputfile inventory',
    text: '',
    updatedAtMs: null,
    nowMs: 1_000_000
  })
  assert.equal(d.empty, true)
  assert.equal(d.stale, false)
  assert.equal(d.text, '[EMPTY]')
  assert.match(d.note, /\/outputfile inventory/)
  assert.doesNotMatch(d.note, /wearing/)
})

test('stale dump is flagged after 20 minutes', () => {
  const now = 2_000_000
  const d = dumpHonesty({
    kind: 'inventory',
    command: '/outputfile inventory',
    text: 'Fungi Tunic',
    updatedAtMs: now - DUMP_STALE_MS - 1,
    nowMs: now
  })
  assert.equal(d.empty, false)
  assert.equal(d.stale, true)
  assert.match(d.note, /may not match/)
})

test('hydrating fight is not live', () => {
  const v = compactFight({ hydrating: true, inCombat: false, selected: null })
  assert.equal(v.hydrating, true)
  assert.match(String(v.note), /Still reading/)
})

test('unknown zone does not invent mobs', () => {
  const v = compactZone(null, [{ name: 'a thunder spirit', drops: ['x'] }], [])
  assert.equal(v.zone, null)
  assert.equal(v.mobs, undefined)
})

test('loot join marks unknown names', () => {
  const v = compactLoot(
    [{ ts: 1, item: 'Not A Real Item', source: 'a rat' }],
    () => undefined
  )
  const row = (v.items as { known: boolean; item: string }[])[0]
  assert.equal(row?.known, false)
  assert.equal(row?.item, 'Not A Real Item')
})
