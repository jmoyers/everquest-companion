/**
 * Rendered pages (`action=parse`) cached by revision, for the scrapers that read a page as the wiki
 * shows it (Plane of Sky, bosses). The revCache.ts bargain (owner, 2026-10-18: every text the app
 * takes from the wiki is cached the same way): one `rvprop=ids` request per 50 titles says which
 * cached pages moved, and only those are rendered again, one request each. A rendering can also
 * change with a TEMPLATE while the page's revision stays put (the Itempage `DMG Bonus` line,
 * 2026-10-18), so `refresh` re-renders everything; the delta passes it when a template changed.
 *
 * The HTML lives under `scripts/sources/cache/rendered/<site>/` (gitignored, like the item and mob
 * caches) with an `index.json` of the revid each file was rendered at.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { currentRevids, isStale, readRevIndex, writeRevIndex, type ApiGet } from './revCache'

export interface RenderOptions {
  /** the site's cache directory */
  dir: string
  /** read the cache only: no request at all */
  offline?: boolean
  /** render every page again (a template changed) */
  refresh?: boolean
}

/** A title as a file name: anything not a letter or digit becomes `_`. */
const fileOf = (dir: string, title: string): string => join(dir, `${title.replace(/[^A-Za-z0-9]+/g, '_')}.html`)

/**
 * Each title's rendered HTML: from the cache where its revision has not moved, else `render(title)`
 * (null for a page the wiki would not render, which is left uncached). Offline, only cached pages.
 */
export async function renderedPages(
  titles: readonly string[],
  render: (title: string) => Promise<string | null>,
  api: ApiGet,
  opts: RenderOptions
): Promise<Map<string, string>> {
  const indexPath = join(opts.dir, 'index.json')
  const revs = readRevIndex(indexPath)
  const live = opts.offline ? new Map<string, number>() : await currentRevids(api, [...titles])
  const out = new Map<string, string>()
  let rendered = 0
  for (const title of titles) {
    const file = fileOf(opts.dir, title)
    const have = existsSync(file)
    if (opts.offline || (!opts.refresh && !isStale(revs[title], live.get(title), have))) {
      if (have) out.set(title, readFileSync(file, 'utf8'))
      continue
    }
    const html = await render(title)
    rendered++
    if (html === null) continue
    mkdirSync(opts.dir, { recursive: true })
    writeFileSync(file, html)
    const rev = live.get(title)
    if (rev !== undefined) revs[title] = rev
    out.set(title, html)
  }
  if (!opts.offline) writeRevIndex(indexPath, revs)
  console.log(`  rendered pages: ${String(titles.length - rendered)} from the cache, ${String(rendered)} rendered`)
  return out
}
