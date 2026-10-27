// Page-era scraper (scripts/scrape-page-era.ts) batch reading. No network: fixtures only. The
// legacy-shape batches (first-title-named, written before redirects were followed) are kept in
// tests/fixtures/page-era, copied from the 2026-10-10 cache with their page text cut to 60
// characters: a fresh scrape replaces them in the live cache, so the cache cannot be the fixture.
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
  wikitextByRequested
} from '../scripts/sources/pageEraBatch'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(HERE, 'fixtures/page-era')
const read = (f: string): unknown => JSON.parse(readFileSync(resolve(FIXTURES, f), 'utf8'))
/** The sidecar's page titles when those batches were written (151 keys, 2026-10-10). */
const TITLES = read('sidecar-titles-2026-10-10.json') as string[]
const rev = (title: string, content: string): object => ({ title, revisions: [{ slots: { main: { content } } }] })

test('a requested title the API normalized still finds its wikitext', () => {
  const got = wikitextByRequested(['a minnow', 'Gone'], { pages: [rev('A minnow', 'fish'), { title: 'Gone', missing: true }] })
  assert.equal(got.get('a minnow'), 'fish')
  assert.equal(got.has('Gone'), false)
})

test('the first target batch answers the three lowercase titles it was asked for', () => {
  const pages = read('target-a-goblin-seer-50.json') as object[]
  const got = wikitextByRequested(TITLES.slice(0, 50), { pages })
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
  const titles = TITLES
  // The last run asked 153 spellings that fold to the sidecar's 151 keys; the 151-title file is an older list.
  assert.equal(answersSlice(titles, read('meta-a-goblin-seer-153.json')), true)
  assert.equal(answersSlice(titles, read('meta-a-goblin-seer-151.json')), false)
  assert.equal(answersSlice(titles.slice(0, 50), read('target-a-goblin-seer-50.json')), true)
  assert.equal(answersSlice(titles.slice(0, 50), read('target-Ornate-Chain-50.json')), false)
})

test('a query response without pages throws instead of becoming an empty cached batch', () => {
  assert.throws(() => batchOf({}), /no pages/)
  const q = { pages: [{ title: 'A', missing: true }], redirects: [{ from: 'B', to: 'A' }] }
  assert.deepEqual(batchOf({ query: q }), { ...q, normalized: undefined })
})

test('a cached spell-page list warns when it is old or of unknown age, since only a re-enumeration finds new pages', () => {
  const committed = readFileSync(resolve(HERE, '../scripts/sources/cache/page-era/spell-pages.json'), 'utf8')
  assert.ok((readTitleList(JSON.parse(committed))?.titles.length ?? 0) > 2000)
  // The legacy shape, a bare title array, carries no date at all.
  assert.match(readTitleList(['Yaulp'])?.warning ?? '', /unknown age.*--refresh/)
  const now = Date.parse('2026-10-10T00:00:00Z')
  const fresh = readTitleList({ fetchedAt: '2026-10-01T00:00:00Z', titles: ['Yaulp'] }, now)
  assert.deepEqual(fresh, { titles: ['Yaulp'] })
  assert.match(readTitleList({ fetchedAt: '2026-08-01T00:00:00Z', titles: ['Yaulp'] }, now)?.warning ?? '', /70 days old/)
  assert.equal(readTitleList(null), null)
})
