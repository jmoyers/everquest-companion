/** Batch helpers for scripts/scrape-page-era.ts, kept apart so they can be tested offline. */
import { createHash } from 'crypto'
import { pageEraKey } from '../../src/main/pageEraDb'
import { eraBadge, namesEra } from '../../src/shared/planner/era'

export interface RevPage {
  title: string
  missing?: boolean
  revisions?: { slots?: { main?: { content?: string } } }[]
}

export interface TitleMap {
  from: string
  to: string
}

/** A `query` batch as cached: the pages plus the title rewrites the API applied (`redirects=1`). */
export interface RevBatch<P = RevPage> {
  pages: P[]
  normalized?: TitleMap[]
  redirects?: TitleMap[]
}

const slugOf = (titles: readonly string[]): string => titles[0].replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40)

/** A file name only this exact title list can own: the first title for the eye, a hash of all. */
export function batchName(prefix: string, titles: readonly string[]): string {
  const hash = createHash('sha1').update(titles.join('\n')).digest('hex').slice(0, 12)
  return `${prefix}-${slugOf(titles)}-${String(titles.length)}-${hash}.json`
}

/** The name batches had before the hash (first title + count): readable only via `answersSlice`. */
export function legacyBatchName(prefix: string, titles: readonly string[]): string {
  return `${prefix}-${slugOf(titles)}-${String(titles.length)}.json`
}

/** True when a legacy batch (a page array, or eqlmetadata rows) answers exactly the requested titles. */
export function answersSlice(slice: readonly string[], cached: unknown): boolean {
  const meta = (cached as { eqlmetadata?: { pages?: { requested?: string[] }[] } } | null)?.eqlmetadata?.pages
  const got = Array.isArray(cached)
    ? (cached as { title: string }[]).map((p) => p.title)
    : meta?.flatMap((r) => r.requested ?? [])
  if (got === undefined) return false
  const keys = (ts: readonly string[]): string => [...new Set(ts.map(pageEraKey))].sort().join('\n')
  return keys(got) === keys(slice)
}

const contentOf =(p: RevPage): string | undefined => p.revisions?.[0]?.slots?.main?.content

/** The key of the page the API answered a requested title with, through normalization then redirect. */
export function answeredKey(title: string, batch: Omit<RevBatch<unknown>, 'pages'>): string {
  let key = pageEraKey(title)
  for (const hops of [batch.normalized, batch.redirects]) {
    const hop = hops?.find((m) => pageEraKey(m.from) === key)
    if (hop !== undefined) key = pageEraKey(hop.to)
  }
  return key
}

/** Each requested title's wikitext, matched by key: the API answers 'a minnow' as 'A minnow'. */
export function wikitextByRequested(slice: readonly string[], batch: RevBatch): Map<string, string> {
  const byKey = new Map<string, string>()
  for (const p of batch.pages) {
    const wt = contentOf(p)
    if (wt != null) byKey.set(pageEraKey(p.title), wt)
  }
  const out = new Map<string, string>()
  for (const t of slice) {
    const wt = byKey.get(answeredKey(t, batch))
    if (wt !== undefined) out.set(t, wt)
  }
  return out
}

export interface CatPage {
  title: string
  missing?: boolean
  categories?: { title: string }[]
}

/** Each requested title's out-of-era verdict from its (redirect-resolved) page's era categories. */
export function categoryVerdicts(slice: readonly string[], batch: RevBatch<CatPage>): Map<string, boolean> {
  const byKey = new Map<string, boolean>()
  for (const p of batch.pages) {
    const tokens = (p.categories ?? []).flatMap((c) => {
      const m = /^Category:\s*(.+?)[ _]+Era$/i.exec(c.title)
      return m === null ? [] : [m[1].replace(/[_\s]+/g, ' ').trim()]
    })
    byKey.set(pageEraKey(p.title), tokens.some((t) => namesEra(t) && eraBadge(t) === 'out'))
  }
  const out = new Map<string, boolean>()
  for (const t of slice) {
    const v = byKey.get(answeredKey(t, batch))
    if (v !== undefined) out.set(pageEraKey(t), v)
  }
  return out
}

/**
 * A cached revisions batch, or null to refetch. A bare page array predates `redirects=1`; it is
 * still exact when every page is content or missing and none is a #REDIRECT stub.
 */
export function asRevBatch<P = RevPage>(cached: unknown): RevBatch<P> | null {
  if (cached === null || typeof cached !== 'object') return null
  if (!Array.isArray(cached)) return Array.isArray((cached as RevBatch).pages) ? (cached as RevBatch<P>) : null
  const pages = cached as P[]
  const exact = (cached as RevPage[]).every((p) => {
    const wt = contentOf(p)
    return wt === undefined ? p.missing === true : !/^\s*#redirect/i.test(wt)
  })
  return exact ? { pages } : null
}

/** Whether an API error body is a maxlag to retry; any other error, or maxlag past the last attempt, throws. */
export function retryOnError(j: unknown, attempt: number, maxRetries: number): boolean {
  const error = (j as { error?: { code?: string; info?: string } } | null)?.error
  if (error === undefined) return false
  if (error.code === 'maxlag' && attempt < maxRetries) return true
  throw new Error(`API error ${String(error.code)}: ${error.info ?? ''}`)
}

/** A fresh query response as a cacheable batch; one without pages throws instead of caching []. */
export function batchOf<P>(j: { query?: Partial<RevBatch<P>> }): RevBatch<P> {
  const q = j.query
  if (q?.pages === undefined) throw new Error(`query returned no pages: ${JSON.stringify(j).slice(0, 300)}`)
  return { pages: q.pages, normalized: q.normalized, redirects: q.redirects }
}

const LIST_STALE_DAYS = 30

/**
 * The cached spell-page list, plus a warning when it is over LIST_STALE_DAYS old or predates the
 * recorded fetch date (a bare array): a page list cannot be revid-checked, only re-enumerated.
 */
export function readTitleList(cached: unknown, now = Date.now()): { titles: string[]; warning?: string } | null {
  if (Array.isArray(cached)) {
    return { titles: cached as string[], warning: 'the cached spell-page list is of unknown age; new spell pages need --refresh' }
  }
  const c = cached as { fetchedAt?: string; titles?: string[] } | null
  if (!Array.isArray(c?.titles)) return null
  const days = Math.floor((now - Date.parse(c.fetchedAt ?? '')) / 86_400_000)
  if (days <= LIST_STALE_DAYS) return { titles: c.titles }
  return { titles: c.titles, warning: `the cached spell-page list is ${String(days)} days old; new spell pages need --refresh` }
}
