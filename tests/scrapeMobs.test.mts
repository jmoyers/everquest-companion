// Mob scraper cache freshness (scripts/scrape-mobs.ts). No network: only the batch writer runs,
// against throwaway page ids in the (gitignored) mob cache directory, removed afterwards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { indexAgeDays, writePrefetched } from '../scripts/scrape-mobs'

const CACHE = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/sources/cache/mobs')
const file = (id: number): string => resolve(CACHE, `page-${id}.wikitext`)

test('a requested page the batch did not carry is not left to be re-parsed from its old file', (t) => {
  const createdDir = !existsSync(CACHE)
  mkdirSync(CACHE, { recursive: true })
  t.after(() => {
    for (const id of [999999901, 999999902]) rmSync(file(id), { force: true })
    if (createdDir) rmSync(CACHE, { recursive: true, force: true })
  })
  writeFileSync(file(999999902), 'stale wikitext')
  const fresh = { pageid: 999999901, revisions: [{ slots: { main: { content: 'fresh' } } }] }
  const notCarried = writePrefetched([fresh], [999999901, 999999902])
  assert.deepEqual(notCarried, [999999902])
  assert.equal(readFileSync(file(999999901), 'utf8'), 'fresh')
  assert.equal(existsSync(file(999999902)), false)
})

test('the cached page list reports its age so a stale index is warned about', (t) => {
  const p = resolve(CACHE, '..', `age-probe-${process.pid}.json`)
  writeFileSync(p, '[]')
  t.after(() => rmSync(p, { force: true }))
  const fortyDaysAgo = (Date.now() - 40 * 86_400_000) / 1000
  utimesSync(p, fortyDaysAgo, fortyDaysAgo)
  assert.ok(indexAgeDays(p) > 39 && indexAgeDays(p) < 41)
})
