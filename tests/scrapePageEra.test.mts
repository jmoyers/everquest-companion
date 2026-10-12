// Page-era scraper (scripts/scrape-page-era.ts) batch reading. No network: fixtures and the
// committed response cache (scripts/sources/cache/page-era), read only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  answersSlice,
  asRevBatch,
  batchName,
  batchOf,
  categoryVerdicts,
  readTitleList,
  retryOnError,
  wikitextByRequested
} from '../scripts/sources/pageEraBatch'
import type { PageEraFile } from '../src/main/pageEraDb'

const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE = resolve(HERE, '../scripts/sources/cache/page-era')
const rev = (title: string, content: string): object => ({ title, revisions: [{ slots: { main: { content } } }] })

test('a requested title the API normalized still finds its wikitext', () => {
  const got = wikitextByRequested(['a minnow', 'Gone'], { pages: [rev('A minnow', 'fish'), { title: 'Gone', missing: true }] })
  assert.equal(got.get('a minnow'), 'fish')
  assert.equal(got.has('Gone'), false)
})

test('the committed first target batch answers the three lowercase titles it was asked for', () => {
  const sidecar = JSON.parse(readFileSync(resolve(HERE, '../src/main/data/pageEra.json'), 'utf8')) as PageEraFile
  const titles = Object.values(sidecar.pages).map((p) => p.title).sort((a, b) => a.localeCompare(b))
  const pages = JSON.parse(readFileSync(resolve(CACHE, 'target-a-goblin-seer-50.json'), 'utf8'))
  const got = wikitextByRequested(titles.slice(0, 50), { pages })
  for (const t of ['a goblin seer', 'a minnow', 'a nesting rat']) assert.ok(got.has(t), t)
})

test('a redirect is read through to its target page, not off the #REDIRECT line', () => {
  const batch = {
    pages: [rev('Mistmoore Castle', '{{Classic Era}}')],
    normalized: [{ from: 'mistmoore', to: 'Mistmoore' }],
    redirects: [{ from: 'Mistmoore', to: 'Mistmoore Castle' }]
  }
  assert.equal(wikitextByRequested(['mistmoore'], batch).get('mistmoore'), '{{Classic Era}}')
})

test('a cached batch from before redirects were followed is refetched when it holds a redirect page', () => {
  const read = (f: string): unknown => JSON.parse(readFileSync(resolve(CACHE, f), 'utf8'))
  assert.equal(asRevBatch(read('target-a-goblin-seer-50.json')), null)
  assert.equal(asRevBatch([{ title: 'X', categories: [] }]), null)
  assert.equal(asRevBatch(read('target-Yaulp-1.json'))?.pages.length, 1)
  const fresh = { pages: [rev('A', 'a')], redirects: [{ from: 'B', to: 'A' }] }
  assert.deepEqual(asRevBatch(fresh), fresh)
})

test('the categories fallback files a redirect under the title asked for', () => {
  const batch = {
    pages: [{ title: 'Skill Fishing', categories: [{ title: 'Category:Kunark Era' }] }],
    redirects: [{ from: 'Fishing', to: 'Skill Fishing' }]
  }
  assert.deepEqual([...categoryVerdicts(['Fishing'], batch)], [['fishing', true]])
})

test('a batch file is named by every title in it, so a changed list never reuses a stale batch', () => {
  assert.notEqual(batchName('meta', ['a goblin seer', 'Fishing']), batchName('meta', ['a goblin seer', 'Yaulp']))
  assert.equal(batchName('meta', ['a goblin seer', 'Fishing']), batchName('meta', ['a goblin seer', 'Fishing']))
})

test('an older first-title-named batch is reused only when its rows are exactly the titles asked', () => {
  const sidecar = JSON.parse(readFileSync(resolve(HERE, '../src/main/data/pageEra.json'), 'utf8')) as PageEraFile
  const titles = Object.values(sidecar.pages).map((p) => p.title).sort((a, b) => a.localeCompare(b))
  const read = (f: string): unknown => JSON.parse(readFileSync(resolve(CACHE, f), 'utf8'))
  // The last run asked 153 spellings that fold to the sidecar's 151 keys; the 151-title file is an older list.
  assert.equal(answersSlice(titles, read('meta-a-goblin-seer-153.json')), true)
  assert.equal(answersSlice(titles, read('meta-a-goblin-seer-151.json')), false)
  assert.equal(answersSlice(titles.slice(0, 50), read('target-a-goblin-seer-50.json')), true)
  assert.equal(answersSlice(titles.slice(0, 50), read('target-Ornate-Chain-50.json')), false)
})

test('an API error body is retried only as a maxlag with attempts left, otherwise it throws', () => {
  const maxlag = { error: { code: 'maxlag', info: 'lagged' } }
  assert.equal(retryOnError({ query: {} }, 0, 5), false)
  assert.equal(retryOnError(maxlag, 4, 5), true)
  assert.throws(() => retryOnError(maxlag, 5, 5), /maxlag/)
  assert.throws(() => retryOnError({ error: { code: 'badvalue' } }, 0, 5), /badvalue/)
})

test('a query response without pages throws instead of becoming an empty cached batch', () => {
  assert.throws(() => batchOf({}), /no pages/)
  const q = { pages: [{ title: 'A', missing: true }], redirects: [{ from: 'B', to: 'A' }] }
  assert.deepEqual(batchOf({ query: q }), { ...q, normalized: undefined })
})

test('a cached spell-page list warns when it is old or of unknown age, since only a re-enumeration finds new pages', () => {
  const committed = JSON.parse(readFileSync(resolve(CACHE, 'spell-pages.json'), 'utf8'))
  const legacy = readTitleList(committed)
  assert.ok((legacy?.titles.length ?? 0) > 2000)
  assert.match(legacy?.warning ?? '', /unknown age.*--refresh/)
  const now = Date.parse('2026-10-10T00:00:00Z')
  const fresh = readTitleList({ fetchedAt: '2026-10-01T00:00:00Z', titles: ['Yaulp'] }, now)
  assert.deepEqual(fresh, { titles: ['Yaulp'] })
  assert.match(readTitleList({ fetchedAt: '2026-08-01T00:00:00Z', titles: ['Yaulp'] }, now)?.warning ?? '', /70 days old/)
  assert.equal(readTitleList(null), null)
})
