// Revision-checked page cache (scripts/sources/revCache.ts), against a stub API: no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { currentRevids, fetchContents, isStale, type ApiGet } from '../scripts/sources/revCache'

/** A stub wiki: `revs` maps the page's canonical title to its revid and content. */
function stubApi(revs: Record<string, { revid: number; content: string }>, calls: Record<string, string>[]): ApiGet {
  return <T,>(params: Record<string, string>): Promise<T> => {
    calls.push(params)
    const asked = params.titles.split('|')
    const normalized = asked.filter((t) => t[0] !== t[0].toUpperCase()).map((t) => ({ from: t, to: t[0].toUpperCase() + t.slice(1) }))
    const titles = asked.map((t) => normalized.find((n) => n.from === t)?.to ?? t)
    const pages = titles.map((t) =>
      revs[t]
        ? { title: t, revisions: [{ revid: revs[t].revid, ...(params.rvprop.includes('content') ? { slots: { main: { content: revs[t].content } } } : {}) }] }
        : { title: t, missing: true }
    )
    return Promise.resolve({ query: { pages, normalized } } as T)
  }
}

test('revids come back under the title that was asked, normalization included', async () => {
  const calls: Record<string, string>[] = []
  const api = stubApi({ Warrior: { revid: 7, content: 'w' }, 'Character Classes': { revid: 9, content: 'c' } }, calls)
  const live = await currentRevids(api, ['warrior', 'Character Classes', 'Gone'])
  assert.deepEqual([...live], [['warrior', 7], ['Character Classes', 9]])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].rvprop, 'ids')
  const got = await fetchContents(api, ['Character Classes'])
  assert.deepEqual(got.get('Character Classes'), { revid: 9, content: 'c' })
})

test('a cached page is refetched only when its revision moved or it was never cached', () => {
  assert.equal(isStale(9, 9, true), false)
  assert.equal(isStale(8, 9, true), true)
  assert.equal(isStale(undefined, 9, true), true)
  assert.equal(isStale(9, 9, false), true)
  assert.equal(isStale(9, undefined, true), false)
  assert.equal(isStale(undefined, undefined, false), true)
})

test('titles are asked 50 to a request', async () => {
  const calls: Record<string, string>[] = []
  const titles = Array.from({ length: 120 }, (_, i) => `Page ${i}`)
  await currentRevids(stubApi({}, calls), titles)
  assert.deepEqual(calls.map((c) => c.titles.split('|').length), [50, 50, 20])
})
