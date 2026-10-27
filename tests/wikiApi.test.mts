// The one polite wiki client (scripts/sources/wikiApi.ts). fetch is stubbed and the clock is fake:
// nothing reaches the network and no test waits out a real backoff.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_ATTEMPTS, USER_AGENT, useWikiClock, wikiFile, wikiGet, wikiPost, wikiRequestCount } from '../scripts/sources/wikiApi'

/** A fake clock: `sleep` records the wait and moves time on by it. */
function fakeClock(t: TestContext): number[] {
  let now = 1_000_000
  const sleeps: number[] = []
  const restore = useWikiClock({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms)
      now += ms
    }
  })
  t.after(restore)
  return sleeps
}

const json = (body: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(body), { status: 200, ...init })

/** Stub fetch with the replies in order (the last one repeats); returns every call's url and init. */
function replies(t: TestContext, ...rs: (() => Response)[]): { url: string; init: RequestInit }[] {
  const calls: { url: string; init: RequestInit }[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return (rs[calls.length - 1] ?? rs[rs.length - 1])()
  })
  return calls
}

test('requests are spaced a second apart, the first not delayed', async (t) => {
  const sleeps = fakeClock(t)
  replies(t, () => json({ query: {} }))
  await wikiGet({ action: 'query', list: 'embeddedin' })
  await wikiGet({ action: 'query', list: 'embeddedin' })
  await wikiGet({ action: 'query', list: 'embeddedin' })
  assert.deepEqual(sleeps, [1000, 1000])
  assert.equal(wikiRequestCount(), 3)
})

test('every GET carries maxlag=5, JSON format 2 and the one User-Agent; a caller cannot lift maxlag', async (t) => {
  fakeClock(t)
  const calls = replies(t, () => json({ query: {} }))
  await wikiGet({ action: 'query', prop: 'revisions', titles: 'Yaulp', maxlag: '60' })
  const url = new URL(calls[0].url)
  assert.equal(url.origin + url.pathname, 'https://eqlwiki.com/api.php')
  assert.equal(url.searchParams.get('maxlag'), '5')
  assert.equal(url.searchParams.get('format'), 'json')
  assert.equal(url.searchParams.get('formatversion'), '2')
  assert.equal(url.searchParams.get('titles'), 'Yaulp')
  assert.equal((calls[0].init.headers as Record<string, string>)['User-Agent'], USER_AGENT)
  assert.match(USER_AGENT, /https:\/\//)
})

test('a 429 waits the server-named Retry-After before the retry', async (t) => {
  const sleeps = fakeClock(t)
  const calls = replies(t, () => new Response('', { status: 429, headers: { 'retry-after': '7' } }), () => json({ ok: 1 }))
  assert.deepEqual(await wikiGet({ action: 'query' }), { ok: 1 })
  assert.equal(calls.length, 2)
  assert.deepEqual(sleeps, [7000])
})

test('a 5xx is retried with a doubling backoff', async (t) => {
  const sleeps = fakeClock(t)
  const calls = replies(t, () => new Response('', { status: 503 }), () => new Response('', { status: 502 }), () => json({ ok: 1 }))
  assert.deepEqual(await wikiGet({ action: 'query' }), { ok: 1 })
  assert.equal(calls.length, 3)
  assert.deepEqual(sleeps, [1000, 2000])
})

test('a 5xx that never clears gives up after the shared six attempts, naming the request', async (t) => {
  fakeClock(t)
  const calls = replies(t, () => new Response('', { status: 500, statusText: 'Server Error' }))
  await assert.rejects(wikiGet({ action: 'query', list: 'categorymembers', cmtitle: 'Category:NPCs' }), /HTTP 500.*Category:NPCs/)
  assert.equal(MAX_ATTEMPTS, 6)
  assert.equal(calls.length, 6)
})

test('a network failure is retried like a 5xx', async (t) => {
  const sleeps = fakeClock(t)
  let n = 0
  t.mock.method(globalThis, 'fetch', async () => {
    if (++n === 1) throw new TypeError('fetch failed')
    return json({ ok: 1 })
  })
  assert.deepEqual(await wikiGet({ action: 'query' }), { ok: 1 })
  assert.equal(n, 2)
  assert.deepEqual(sleeps, [1000])
})

test('an API error body on HTTP 200 throws at once', async (t) => {
  fakeClock(t)
  const calls = replies(t, () => json({ error: { code: 'badvalue', info: 'Unrecognized value' } }))
  await assert.rejects(wikiGet({ action: 'query', list: 'embeddedin', eititle: 'Template:Itempage' }), (err: Error & { code?: string }) => {
    assert.match(err.message, /API error badvalue: Unrecognized value for query embeddedin Template:Itempage/)
    assert.equal(err.code, 'badvalue')
    return true
  })
  assert.equal(calls.length, 1)
})

test('a maxlag error body is retried after its Retry-After', async (t) => {
  const sleeps = fakeClock(t)
  const calls = replies(t, () => json({ error: { code: 'maxlag', info: 'Waiting' } }, { headers: { 'retry-after': '5' } }), () => json({ query: {} }))
  assert.deepEqual(await wikiGet({ action: 'query' }), { query: {} })
  assert.equal(calls.length, 2)
  assert.deepEqual(sleeps, [5000])
})

test('a 4xx is never retried', async (t) => {
  fakeClock(t)
  const calls = replies(t, () => new Response('', { status: 404, statusText: 'Not Found' }))
  await assert.rejects(wikiFile('https://eqlwiki.com/images/x.png'), /HTTP 404/)
  assert.equal(calls.length, 1)
})

test('a POST sends the parameters, maxlag included, as a form body', async (t) => {
  const sleeps = fakeClock(t)
  const calls = replies(t, () => json({ eqlmetadata: { pages: [] } }))
  await wikiGet({ action: 'query' })
  assert.deepEqual(await wikiPost({ action: 'eqlmetadata', titles: 'A|B' }), { eqlmetadata: { pages: [] } })
  const { url, init } = calls[1]
  assert.equal(url, 'https://eqlwiki.com/api.php')
  assert.equal(init.method, 'POST')
  const headers = init.headers as Record<string, string>
  assert.equal(headers['Content-Type'], 'application/x-www-form-urlencoded')
  assert.equal(headers['User-Agent'], USER_AGENT)
  const body = new URLSearchParams(String(init.body))
  assert.equal(body.get('action'), 'eqlmetadata')
  assert.equal(body.get('titles'), 'A|B')
  assert.equal(body.get('maxlag'), '5')
  assert.deepEqual(sleeps, [1000])
})

test('a file GET keeps the caller headers, adds the User-Agent and returns the response unread', async (t) => {
  fakeClock(t)
  const calls = replies(t, () => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 }))
  const res = await wikiFile('https://eqlwiki.com/images/a.png', { Accept: 'image/png' })
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [137, 80, 78, 71])
  const headers = calls[0].init.headers as Record<string, string>
  assert.equal(headers.Accept, 'image/png')
  assert.equal(headers['User-Agent'], USER_AGENT)
})
