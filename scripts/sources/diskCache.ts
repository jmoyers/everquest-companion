// diskCache.ts — the scrapers' on-disk JSON response cache, once (it was four identical copies, in
// scrape-items, scrape-mobs, scrape-quests and scrape-page-era). One file per name under `dir`,
// `JSON.stringify` with no indentation, so the caches those copies wrote are read back unchanged.
// A file is written only AFTER the response it holds arrived complete; that rule is the caller's.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

export interface DiskCache {
  /** The cache file's path for `name`, for the callers that keep other files beside the JSON. */
  path: (name: string) => string
  /** Cached JSON, or null when absent, unreadable or `refresh`. The CALLER names the shape. */
  read: (name: string) => unknown
  /** Write `data` as `name`, creating the directory on first use. */
  write: (name: string, data: unknown) => void
}

/** A cache rooted at `dir`. `refresh` (a `--refresh` run) makes every read a miss. */
export function createCache(dir: string, opts: { refresh?: boolean } = {}): DiskCache {
  const path = (name: string): string => resolve(dir, name)
  const read = (name: string): unknown => {
    if (opts.refresh === true) return null
    const p = path(name)
    if (!existsSync(p)) return null
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as unknown
    } catch {
      return null
    }
  }
  const write = (name: string, data: unknown): void => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path(name), JSON.stringify(data), 'utf8')
  }
  return { path, read, write }
}
