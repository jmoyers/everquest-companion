// The scrapers' shared JSON cache (scripts/sources/diskCache.ts), in a temp directory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCache } from '../scripts/sources/diskCache'

test('a written entry is compact JSON under its own name, read back as written', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'diskcache-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const cache = createCache(join(dir, 'items'))
  const pages = [{ pageid: 7, title: 'Lute' }]
  cache.write('item-pages.json', pages)
  assert.equal(cache.path('item-pages.json'), join(dir, 'items', 'item-pages.json'))
  assert.equal(readFileSync(cache.path('item-pages.json'), 'utf8'), '[{"pageid":7,"title":"Lute"}]')
  assert.deepEqual(cache.read('item-pages.json'), pages)
})

test('an absent or unreadable entry is a miss, and a refresh run misses everything', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'diskcache-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const cache = createCache(dir)
  assert.equal(cache.read('nothing.json'), null)
  writeFileSync(join(dir, 'torn.json'), '{"pages": [')
  assert.equal(cache.read('torn.json'), null)
  cache.write('whole.json', { ok: 1 })
  assert.equal(createCache(dir, { refresh: true }).read('whole.json'), null)
  assert.deepEqual(createCache(dir, { refresh: false }).read('whole.json'), { ok: 1 })
})
