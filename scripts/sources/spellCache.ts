// spellCache.ts — the spell scraper's revision-keyed page cache: `cache/spells/<pageid>.wikitext`
// beside `index.json`, which records the REVID that produced each file (so a re-run asks the wiki
// only "has this page changed?", 50 pages per request) and, since 2026-10-10, each page's TITLE,
// the spell-name source, so `scrape-spells.ts --offline` can re-parse the cache with no request.
// Split out of scrape-spells.ts for the file ceiling; nothing else reads it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const CACHE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'cache/spells')
const INDEX_PATH = resolve(CACHE_DIR, 'index.json')

export interface WikiPage {
  pageid: number
  title: string
}

export interface CacheIndex {
  updatedAt: string
  /** pageid (as a string key, JSON's only kind) → revid of the cached wikitext. */
  revs: Record<string, number>
  /** pageid → page title, the spell-name source (`spellName`); absent in an index from before it. */
  titles?: Record<string, string>
}

export function readIndex(): CacheIndex {
  if (!existsSync(INDEX_PATH)) return { updatedAt: '', revs: {} }
  try {
    const j = JSON.parse(readFileSync(INDEX_PATH, 'utf8')) as CacheIndex
    return { updatedAt: j.updatedAt ?? '', revs: j.revs ?? {}, ...(j.titles ? { titles: j.titles } : {}) }
  } catch {
    // A corrupt index costs a re-fetch, never a wrong answer.
    return { updatedAt: '', revs: {} }
  }
}

const byPageid = (a: string, b: string): number => Number(a) - Number(b)

/** Written with SORTED keys so the committed file's diff shows only the revids that moved. */
export function writeIndex(idx: CacheIndex): void {
  const revs: Record<string, number> = {}
  for (const k of Object.keys(idx.revs).sort(byPageid)) revs[k] = idx.revs[k]
  const titles = idx.titles
    ? { titles: Object.fromEntries(Object.keys(idx.titles).sort(byPageid).map((k) => [k, idx.titles?.[k]])) }
    : {}
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(INDEX_PATH, JSON.stringify({ updatedAt: idx.updatedAt, revs, ...titles }, null, 2) + '\n')
}

export function cachePath(pageid: number): string {
  return resolve(CACHE_DIR, `${pageid}.wikitext`)
}

/** `--offline`: the page list is the index's titles, which a real run records; the wiki is sent nothing. */
export function indexedPages(idx: CacheIndex): WikiPage[] {
  const titles = idx.titles ?? {}
  const pages = Object.keys(titles).map((k) => ({ pageid: Number(k), title: titles[k] }))
  if (pages.length === 0) throw new Error('--offline needs titles in the cache index; a real run records them')
  return pages.sort((a, b) => a.pageid - b.pageid)
}
