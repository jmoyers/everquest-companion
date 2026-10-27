// ITEM SCRAPER key index (scripts/scrape-items.ts): which page each lookup key resolves to.
// Fixtures are small {{Itempage}} strings shaped like the real pages they are named after.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { batchProblem, buildIndex, embeddedIn, reachableCount, toEntry, type RunStats } from '../scripts/scrape-items'
import type { ItemDbEntry } from '../src/main/itemsDb'

const page = (fields: string): string => `<onlyinclude>{{Itempage\n${fields}\n}}</onlyinclude>`
const stats = (): RunStats => ({
  pages: 0, entries: 0, notItem: 0, missing: 0, empty: 0, aliases: 0, collisions: 0
})
const entry = (title: string, wt: string): ItemDbEntry => {
  const e = toEntry(title, wt)
  assert.ok(e, title)
  return e
}

test('an |itemname alias never evicts the page whose title is that name', () => {
  // 'Armadillo Tail' carries a copy-pasted itemname and a longer record than the real page.
  const tail = entry(
    'Armadillo Tail',
    page('|itemname = Armadillo Tooth\n|notes = A long note that makes this record serialize longer than the real one.\n|statsblock = MAGIC ITEM<br>\nWT: 0.1')
  )
  const tooth = entry('Armadillo Tooth', page('|itemname = Armadillo Tooth\n|statsblock = WT: 0.1'))
  const items = buildIndex([tail, tooth], stats())
  assert.equal(items.get('armadillo tooth')?.page, 'Armadillo Tooth')
  assert.equal(items.get('armadillo tail')?.page, 'Armadillo Tail')
})

test('an alias still claims a key no page title holds', () => {
  const e = entry('Gnome Meat (raw)', page('|itemname = Gnome Meat\n|statsblock = WT: 0.1'))
  assert.equal(buildIndex([e], stats()).get('gnome meat')?.page, 'Gnome Meat (raw)')
})

test('title-vs-title case variants still go to the richer record', () => {
  const stub = entry('Cyclops skull', page('|statsblock = WT: 1'))
  const full = entry('Cyclops Skull', page('|statsblock = MAGIC ITEM<br>\nWT: 1.0\n|notes = Used in a quest.'))
  assert.equal(buildIndex([full, stub], stats()).get('cyclops skull')?.page, 'Cyclops Skull')
})

test('a disambiguated "(Item)" title is also reachable by its base name', () => {
  const e = entry('Dimensional Hole (Item)', page('|itemname = Dimensional Hole (Item)\n|statsblock = WT: 0.1'))
  const items = buildIndex([e], stats())
  assert.equal(items.get('dimensional hole')?.page, 'Dimensional Hole (Item)')
  assert.equal(items.get('dimensional hole (item)')?.page, 'Dimensional Hole (Item)')
})

test('the committed count is the distinct pages a key reaches, not every parsed page', () => {
  const stub = entry('Cyclops skull', page('|statsblock = WT: 1'))
  const full = entry('Cyclops Skull', page('|statsblock = MAGIC ITEM<br>\nWT: 1.0\n|notes = Used in a quest.'))
  const alias = entry('Gnome Meat (raw)', page('|itemname = Gnome Meat\n|statsblock = WT: 0.1'))
  assert.equal(reachableCount(buildIndex([full, stub, alias], stats())), 2)
})

test('a cached or fetched batch counts only when it holds exactly the requested pages', () => {
  const slice = [{ pageid: 1, ns: 0, title: 'A' }, { pageid: 2, ns: 0, title: 'B' }]
  const full = [{ pageid: 2, title: 'B' }, { pageid: 1, title: 'A', missing: true }]
  assert.equal(batchProblem(slice, full, false), null)
  assert.match(batchProblem(slice, [{ pageid: 1, title: 'A' }], false) ?? '', /do not match/)
  assert.match(batchProblem(slice, [], false) ?? '', /do not match/)
  assert.match(batchProblem(slice, [{ pageid: 3, title: 'C' }, { pageid: 1, title: 'A' }], false) ?? '', /do not match/)
  assert.match(batchProblem(slice, full, true) ?? '', /continue/)
})

test('an API error body throws instead of reading as an empty result (fetch is stubbed, no network)', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ error: { code: 'badvalue', info: 'nope' } }), { status: 200 })
  )
  await assert.rejects(embeddedIn('Template:Itempage'), /API error badvalue/)
})
