/**
 * Revision-checked page cache, the scrape-spells mechanism shared: a cheap `rvprop=ids` pass
 * (50 titles a request) says which cached pages moved, and only those are re-fetched, again 50
 * a request. An index file beside the cache records the revid each cached file came from.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'

/** The caller's polite, throttled API GET (it owns delay, retry and the error-body check). */
export type ApiGet = <T>(params: Record<string, string>) => Promise<T>

/** MEASURED anonymous multi-value limit (scrape-items.ts header). */
const BATCH = 50

interface RevPage {
  title: string
  missing?: boolean
  revisions?: { revid?: number; slots?: { main?: { content?: string } } }[]
}
interface RevQuery {
  query?: { pages?: RevPage[]; normalized?: { from: string; to: string }[]; redirects?: { from: string; to: string }[] }
  continue?: unknown
}

/** One batch: requested title → its current revision (revid, and content when asked). */
async function revBatch(api: ApiGet, titles: string[], content: boolean): Promise<Map<string, { revid: number; content?: string }>> {
  const j = await api<RevQuery>({
    action: 'query',
    prop: 'revisions',
    rvprop: content ? 'ids|content' : 'ids',
    ...(content ? { rvslots: 'main' } : {}),
    titles: titles.join('|'),
    redirects: '1'
  })
  if (j.continue !== undefined) throw new Error(`revision batch continued (${titles[0]} …); refusing a partial answer`)
  return mapBack(j, titles)
}

/** The response's pages, keyed by the title each was REQUESTED under. */
function mapBack(j: RevQuery, titles: string[]): Map<string, { revid: number; content?: string }> {
  const byTitle = revisionsByTitle(j.query?.pages ?? [])
  // The API answers under the normalized, redirect-followed title; map back to what was asked.
  const normalized = j.query?.normalized ?? []
  const redirects = j.query?.redirects ?? []
  const out = new Map<string, { revid: number; content?: string }>()
  for (const t of titles) {
    const hit = byTitle.get(follow(redirects, follow(normalized, t)))
    if (hit) out.set(t, hit)
  }
  return out
}

function revisionsByTitle(pages: RevPage[]): Map<string, { revid: number; content?: string }> {
  const byTitle = new Map<string, { revid: number; content?: string }>()
  for (const p of pages) {
    const rev = p.revisions?.[0]
    if (rev?.revid != null) byTitle.set(p.title, { revid: rev.revid, content: rev.slots?.main?.content })
  }
  return byTitle
}

function follow(list: { from: string; to: string }[], t: string): string {
  return list.find((x) => x.from === t)?.to ?? t
}

async function batched(api: ApiGet, titles: string[], content: boolean): Promise<Map<string, { revid: number; content?: string }>> {
  const out = new Map<string, { revid: number; content?: string }>()
  for (let i = 0; i < titles.length; i += BATCH) {
    for (const [t, v] of await revBatch(api, titles.slice(i, i + BATCH), content)) out.set(t, v)
  }
  return out
}

/** Current revid per title; a title the wiki has no revision for is absent. */
export async function currentRevids(api: ApiGet, titles: string[]): Promise<Map<string, number>> {
  return new Map([...(await batched(api, titles, false))].map(([t, v]) => [t, v.revid]))
}

/** Current wikitext + revid per title, 50 a request; a title with no content is absent. */
export async function fetchContents(api: ApiGet, titles: string[]): Promise<Map<string, { revid: number; content: string }>> {
  const out = new Map<string, { revid: number; content: string }>()
  for (const [t, v] of await batched(api, titles, true)) if (v.content != null) out.set(t, { revid: v.revid, content: v.content })
  return out
}

/** Is the cached copy stale? No live revid ⇒ trust a file we have; else the revids must match. */
export function isStale(cachedRev: number | undefined, liveRev: number | undefined, haveFile: boolean): boolean {
  if (liveRev == null) return !haveFile
  return !haveFile || cachedRev !== liveRev
}

/** key → revid of the cached file. A missing or corrupt index costs a re-fetch, never a wrong answer. */
export function readRevIndex(path: string): Record<string, number> {
  if (!existsSync(path)) return {}
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { revs?: Record<string, number> }).revs ?? {}
  } catch {
    return {}
  }
}

/** Sorted keys, so the committed index diffs only by the revids that moved. */
export function writeRevIndex(path: string, revs: Record<string, number>): void {
  const sorted = Object.fromEntries(Object.keys(revs).sort().map((k) => [k, revs[k]]))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ revs: sorted }, null, 2) + '\n')
}
