// Rendered pages cached by revision (owner, 2026-10-18: every text from the wiki is cached the same
// way): an unchanged page comes from disk, a moved one is rendered again, offline asks nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderedPages } from '../scripts/sources/renderCache'
import type { ApiGet } from '../scripts/sources/revCache'

test('only a page whose revision moved is rendered again; offline and refresh do as they say', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'render-cache-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  t.mock.method(console, 'log', () => undefined)
  let revs: Record<string, number> = { 'Plane of Sky': 1, 'Efreeti Mace': 7 }
  const api = (async () => ({ query: { pages: Object.entries(revs).map(([title, revid]) => ({ title, revisions: [{ revid }] })) } })) as unknown as ApiGet
  const asked: string[] = []
  const render = async (title: string): Promise<string> => {
    asked.push(title)
    return `<p>${title} r${String(revs[title])}</p>`
  }
  const titles = ['Plane of Sky', 'Efreeti Mace']
  await renderedPages(titles, render, api, { dir })
  assert.deepEqual(asked, titles, 'an empty cache renders everything once')
  revs = { 'Plane of Sky': 1, 'Efreeti Mace': 8 }
  const second = await renderedPages(titles, render, api, { dir })
  assert.deepEqual(asked.slice(2), ['Efreeti Mace'], 'only the page that moved')
  assert.equal(second.get('Efreeti Mace'), '<p>Efreeti Mace r8</p>')
  assert.equal(second.get('Plane of Sky'), '<p>Plane of Sky r1</p>')
  const offline = await renderedPages(titles, render, (() => Promise.reject(new Error('no request'))) as unknown as ApiGet, { dir, offline: true })
  assert.equal(offline.size, 2)
  await renderedPages(titles, render, api, { dir, refresh: true })
  assert.equal(asked.length, 5, 'a refresh renders every page again')
})
