// fetch-wiki-images retry policy: fetch is stubbed, nothing reaches the network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchWithBackoff } from '../scripts/fetch-wiki-images.mts'

test('a hard 4xx fails on the first request instead of being retried', async (t) => {
  const stub = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404, statusText: 'Not Found' }))
  await assert.rejects(fetchWithBackoff('https://example.invalid/x.png'), /404/)
  assert.equal(stub.mock.callCount(), 1)
})
