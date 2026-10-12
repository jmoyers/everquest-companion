/**
 * Wiki QUEST-CATALOG scraper — the item-first quest index (companion to scrape-posky).
 *
 *   npm run scrape:quests            # incremental: reuses the on-disk wikitext cache
 *   npm run scrape:quests -- --refresh   # ignore the cached index/pages, re-fetch all
 *
 * WHY: item pages only name a quest when someone filled in their `|relatedquests` field,
 * so classic turn-in items look quest-less from the item side (in the user's live cache:
 * 44 quest-flagged items, 10 with ZERO quest uses). The linkage lives on the QUEST pages
 * — this scrapes them once, offline, and commits the index.
 *
 * WHAT IT DOES
 *  1. Enumerates the quest-page universe: Category:Quests, its subcategories (one level),
 *     and every other category whose name ENDS in "Quest"/"Quests" (Repeatable Turn-in
 *     Quests, Ak'Anon Quests, Faydwer Quests — none of which are subcategories of
 *     Category:Quests). Categories that merely CONTAIN "Quest" are deliberately excluded:
 *     "Epic Quests Era" is an era tag holding 340 mob pages, not quests.
 *  2. Enumerates the wiki's ITEM-TITLE set: every page embedding Template:Itempage
 *     (~18.4k) plus Category:Quest Items (~4k). Category:Quest Items alone is NOT enough —
 *     Gnome Meat / Troll Parts / Spider Legs are QUEST ITEM-flagged pages that sit in
 *     Category:Inventory Items, so filtering prose links by that category would silently
 *     drop them.
 *  3. Asks the wiki for every page's current revid (50 pages per request), re-fetches only
 *     pages whose revid moved (50 per request; cache/quests/index.json records the revid of
 *     each cached file), and runs the PURE parser in ./sources/questPage.ts.
 *  4. Writes src/renderer/src/data/eqlegends/quests.json, sorted by page title
 *     (deterministic), consumed by src/main/itemLookup.ts as a local-first source.
 *
 * Scraper etiquette (AGENTS.md LAW): one serialized request at a time with a 1s delay
 * (owner ruling 2026-08-22 — fan-run servers; bulk API batching does the heavy lifting),
 * exponential backoff honouring Retry-After on 429/5xx, disk cache so a re-run is nearly
 * free, and partial runs resume instead of duplicating work.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { isMain } from './sources/isMain'
import { isEmptyParse, parseQuestPage, titleKey, type ParsedQuestPage } from './sources/questPage'
import type { QuestData, QuestEntry } from '../src/shared/types'

const API = 'https://eqlwiki.com/api.php'
const UA = 'everquest-companion/0.1 (personal quest tracker)'

const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = resolve(HERE, 'sources/cache/quests')
const OUT_PATH = resolve(HERE, '../src/renderer/src/data/eqlegends/quests.json')

const DELAY_MS = 1000
const MAX_RETRIES = 5

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const refresh = process.argv.slice(2).includes('--refresh')

// ---- polite API client ---------------------------------------------------------

/** Wait before a retry: the server's Retry-After when it gave a usable one, else our backoff. */
function retryDelayMs(res: Response, backoff: number): number {
  const retryAfter = Number(res.headers.get('retry-after'))
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff
}

/** Which request failed, for the thrown message — whichever identifying param it carried. */
function describeRequest(params: Record<string, string>): string {
  return `${params.action} ${params.cmtitle ?? params.eititle ?? params.pageid ?? params.pageids?.split('|')[0] ?? ''}`
}

/** One serialized GET with exponential backoff on 429/5xx (honours Retry-After). */
async function api<T>(params: Record<string, string>): Promise<T> {
  const url = `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params }).toString()}`
  let wait = 1000
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA } })
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err
      await sleep(wait)
      wait *= 2
      continue
    }
    if (res.ok) {
      await sleep(DELAY_MS)
      return (await res.json()) as T
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(retryDelayMs(res, wait))
      wait *= 2
      continue
    }
    throw new Error(`${res.status} ${res.statusText} for ${describeRequest(params)}`)
  }
}

interface Member {
  pageid: number
  ns: number
  title: string
}

/** A list response's `query` block. An error body or a missing block throws: it is never cached as an empty list. */
export function queryBlock<Q>(j: { query?: Q; error?: { code?: string; info?: string } }, what: string): Q {
  if (j.error) throw new Error(`API error ${j.error.code ?? '?'} for ${what}: ${j.error.info ?? ''}`)
  if (!j.query) throw new Error(`no query block in the response for ${what}`)
  return j.query
}

/** All members of a category, following cmcontinue. */
async function categoryMembers(title: string): Promise<Member[]> {
  const out: Member[] = []
  let cont: string | undefined
  for (let page = 0; page < 100; page++) {
    const params: Record<string, string> = {
      action: 'query',
      list: 'categorymembers',
      cmtitle: title,
      cmlimit: '500'
    }
    if (cont) params.cmcontinue = cont
    const j = await api<{
      query?: { categorymembers?: Member[] }
      error?: { code?: string; info?: string }
      continue?: { cmcontinue?: string }
    }>(params)
    out.push(...(queryBlock(j, title).categorymembers ?? []))
    cont = j.continue?.cmcontinue
    if (!cont) break
  }
  return out
}

/** Every category on the wiki (allcategories), used to find quest categories generically. */
async function allCategories(): Promise<string[]> {
  const out: string[] = []
  let cont: string | undefined
  for (let page = 0; page < 100; page++) {
    const params: Record<string, string> = { action: 'query', list: 'allcategories', aclimit: '500' }
    if (cont) params.accontinue = cont
    const j = await api<{
      query?: { allcategories?: { category: string }[] }
      error?: { code?: string; info?: string }
      continue?: { accontinue?: string }
    }>(params)
    out.push(...(queryBlock(j, 'allcategories').allcategories ?? []).map((c) => c.category))
    cont = j.continue?.accontinue
    if (!cont) break
  }
  return out
}

// ---- disk cache ----------------------------------------------------------------

function cachePath(name: string): string {
  return resolve(CACHE_DIR, name)
}

/** Cached JSON, or null when absent/unreadable/`--refresh`. The CALLER names the shape. */
function readCache(name: string): unknown {
  if (refresh) return null
  const p = cachePath(name)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as unknown
  } catch {
    return null
  }
}

function writeCache(name: string, data: unknown): void {
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(cachePath(name), JSON.stringify(data), 'utf8')
}

const pageFile = (pageid: number): string => cachePath(`page-${pageid}.wikitext`)

/** Wikitext via action=parse, which follows a redirect (the batch read does not). */
async function fetchParsed(pageid: number): Promise<string | null> {
  const j = await api<{ parse?: { wikitext?: string }; error?: { code?: string } }>({
    action: 'parse',
    pageid: String(pageid),
    prop: 'wikitext',
    redirects: '1'
  })
  return j.error ? null : (j.parse?.wikitext ?? null)
}

// ---- revision-keyed page cache --------------------------------------------------

/** More than 50 pageids per request returns HTTP 200 with zero pages (AGENTS.md). */
const BATCH = 50
const INDEX_FILE = 'index.json'

/** pageid → revid of the cached `page-<pageid>.wikitext`. */
type RevIndex = Record<string, number>

interface RevPage {
  pageid?: number
  revisions?: { revid?: number; slots?: { main?: { content?: string } } }[]
}
interface RevResponse {
  query?: { pages?: RevPage[] }
  error?: { code?: string; info?: string }
}

function readRevIndex(): RevIndex {
  return (readCache(INDEX_FILE) as { revs?: RevIndex } | null)?.revs ?? {}
}

/** Sorted keys, one per line, so a re-run's diff shows only the revids that moved. */
function writeRevIndex(revs: RevIndex): void {
  const sorted = Object.fromEntries(Object.keys(revs).sort((a, b) => Number(a) - Number(b)).map((k) => [k, revs[k]]))
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(cachePath(INDEX_FILE), JSON.stringify({ revs: sorted }, null, 2) + '\n', 'utf8')
}

/** One `prop=revisions` request for up to 50 pages. */
async function revisionBatch(pages: Member[], rvprop: string): Promise<RevPage[]> {
  const params: Record<string, string> = { action: 'query', prop: 'revisions', rvprop }
  if (rvprop.includes('content')) params.rvslots = 'main'
  params.pageids = pages.map((p) => p.pageid).join('|')
  return queryBlock(await api<RevResponse>(params), `revisions of ${pages[0]?.title}`).pages ?? []
}

/** Current revid per pageid, 50 pages per request. */
async function fetchRevIds(pages: Member[]): Promise<Map<number, number>> {
  const live = new Map<number, number>()
  for (let i = 0; i < pages.length; i += BATCH) {
    for (const p of await revisionBatch(pages.slice(i, i + BATCH), 'ids')) {
      const revid = p.revisions?.[0]?.revid
      if (p.pageid != null && revid != null) live.set(p.pageid, revid)
    }
  }
  return live
}

/**
 * Pages to re-fetch: no cached file, a revid that moved, or no index entry (cached before the
 * index, age unknown). A page the wiki gave no revid for keeps its cached copy.
 */
export function stalePages(
  pages: Member[],
  indexed: RevIndex,
  live: Map<number, number>,
  hasFile: (pageid: number) => boolean
): Member[] {
  return pages.filter((p) => {
    if (!hasFile(p.pageid)) return true
    const now = live.get(p.pageid)
    return now != null && indexed[String(p.pageid)] !== now
  })
}

/** A batch entry's wikitext; a redirect page is re-read through action=parse, which follows it. */
async function batchText(pageid: number, content: string | undefined): Promise<string | null> {
  if (content == null) return null
  return /^\s*#redirect/i.test(content) ? fetchParsed(pageid) : content
}

/**
 * Fetch `stale` 50 pages per request, writing each file and its revid as every batch lands so a
 * killed run resumes. Returns the titles the wiki gave nothing for.
 */
async function fetchStale(stale: Member[], revs: RevIndex, live: Map<number, number>): Promise<string[]> {
  const failed: string[] = []
  for (let i = 0; i < stale.length; i += BATCH) {
    const slice = stale.slice(i, i + BATCH)
    const got = new Map((await revisionBatch(slice, 'ids|content')).map((p) => [p.pageid, p.revisions?.[0]]))
    for (const p of slice) {
      const wt = await batchText(p.pageid, got.get(p.pageid)?.slots?.main?.content)
      const revid = live.get(p.pageid) ?? got.get(p.pageid)?.revid
      if (wt == null || revid == null) {
        failed.push(p.title)
        continue
      }
      writeFileSync(pageFile(p.pageid), wt, 'utf8')
      revs[String(p.pageid)] = revid
    }
    writeRevIndex(revs)
    console.log(`  fetched ${Math.min(i + BATCH, stale.length)}/${stale.length} changed pages`)
  }
  return failed
}

/** Bring the page cache up to date: one revid request per 50 pages, then only what moved. */
async function syncPageCache(pages: Member[]): Promise<string[]> {
  const revs = readRevIndex()
  const live = await fetchRevIds(pages)
  const stale = stalePages(pages, revs, live, (id) => existsSync(pageFile(id)))
  console.log(`  ${pages.length - stale.length}/${pages.length} cached pages current; ${stale.length} to fetch`)
  mkdirSync(CACHE_DIR, { recursive: true })
  return stale.length ? fetchStale(stale, revs, live) : []
}

// ---- universe enumeration ------------------------------------------------------

/** Categories that ARE quest lists: Category:Quests + anything ending in "Quest(s)". */
function questCategoryNames(all: string[]): string[] {
  const names = all
    .filter((c) => /\bquests?$/i.test(c))
    .filter((c) => !/^quest items$/i.test(c))
    .map((c) => `Category:${c}`)
  return [...new Set(names)].sort()
}

async function collectQuestPages(): Promise<Member[]> {
  const cached = readCache('quest-pages.json') as Member[] | null
  if (cached) {
    console.log(`Quest pages: ${cached.length} (cached)`)
    return cached
  }
  console.log('Enumerating quest categories…')
  const cats = questCategoryNames(await allCategories())
  console.log(`  ${cats.length} quest categories: ${cats.map((c) => c.replace('Category:', '')).join(', ')}`)

  const byTitle = new Map<string, Member>()
  const seenCats = new Set<string>()
  const queue = [...cats]
  // Category:Quests carries subcategories; walk ONE level down from any listed category.
  // `queue` GROWS during this loop — an array iterator re-reads length on every step, so
  // subcategories pushed below are visited by this same for-of.
  for (const cat of queue) {
    if (seenCats.has(cat)) continue
    seenCats.add(cat)
    const members = await categoryMembers(cat)
    let added = 0
    for (const m of members) {
      if (m.ns === 0 && !byTitle.has(m.title)) {
        byTitle.set(m.title, m)
        added++
      } else if (m.ns === 14 && !seenCats.has(m.title) && /\bquests?$/i.test(m.title)) {
        queue.push(m.title)
      }
    }
    console.log(`  ${cat}: ${members.length} members (+${added} pages)`)
  }
  const pages = [...byTitle.values()].sort((a, b) => a.title.localeCompare(b.title))
  writeCache('quest-pages.json', pages)
  console.log(`Quest pages: ${pages.length}`)
  return pages
}

/**
 * The item-page categories. `embeddedin Template:Itempage` looks like the obvious source
 * and is NOT usable: MediaWiki's templatelinks records INDIRECT transclusions, so every
 * NPC page that shows an item box (`{{:Gnome Meat}}`) is reported as embedding Itempage —
 * 18.4k "item pages" that include Guard Oystin, Crushbone and Venril Sathir. Filtering
 * prose links with that set dragged mobs and zones into requiredItems. The item CATEGORIES
 * are authored on the item pages themselves and stay clean (~11.2k titles).
 */
const ITEM_CATEGORIES = [
  'Category:Items',
  'Category:Inventory Items',
  'Category:Quest Items',
  'Category:Player Crafted'
]

/** Lowercased title set of every ITEM page on the wiki (the prose-link filter). */
async function collectItemTitles(): Promise<Set<string>> {
  const cached = readCache('item-titles.json') as string[] | null
  if (cached) {
    console.log(`Item titles: ${cached.length} (cached)`)
    return new Set(cached)
  }
  const titles = new Set<string>()
  for (const cat of ITEM_CATEGORIES) {
    const members = await categoryMembers(cat)
    let added = 0
    for (const p of members) {
      if (p.ns !== 0) continue
      const key = p.title.toLowerCase()
      if (!titles.has(key)) {
        titles.add(key)
        added++
      }
    }
    console.log(`  ${cat}: ${members.length} members (+${added} titles)`)
  }
  const sorted = [...titles].sort()
  writeCache('item-titles.json', sorted)
  console.log(`Item titles: ${sorted.length}`)
  return titles
}

// ---- main ----------------------------------------------------------------------

/**
 * Why this page is NOT a quest, or null when it is one.
 *
 * Category:Quests also holds INDEX pages ("Popular Quests by Level", "Class Race Quest
 * List") — no quest header at all, just hundreds of item links. Indexing those would tie
 * every listed item to a page that is not a quest.
 */
export function nonQuestReason(parsed: ParsedQuestPage): string | null {
  // The class test pages are stubs over Plane of Sky, or stale copies listing rewards as turn-ins.
  if (/ plane of sky tests$/i.test(parsed.page)) return 'Plane of Sky class tests (posky.json is the authority)'
  if (parsed.sectionHub) return 'section-transclusion hub (lists other quests, no quest header)'
  const indexPage =
    !parsed.hasTopTable && !parsed.giver && !parsed.startZone && parsed.requiredItems.length > 40
  if (parsed.disambiguation && isEmptyParse(parsed)) return 'disambiguation hub'
  if (indexPage) return `index/list page (${parsed.requiredItems.length} item links, no quest header)`
  if (isEmptyParse(parsed)) return 'no quest fields parsed'
  return null
}

/** Project a parsed page into a catalog entry — ONLY the fields the page actually stated. */
function toQuestEntry(parsed: ParsedQuestPage): QuestEntry {
  const entry: QuestEntry = { name: parsed.page, page: parsed.page }
  if (parsed.startZone) entry.startZone = parsed.startZone
  if (parsed.giver) entry.giver = parsed.giver
  if (parsed.minLevel != null) entry.minLevel = parsed.minLevel
  if (parsed.classes.length) entry.classes = parsed.classes
  if (parsed.relatedZones.length) entry.relatedZones = parsed.relatedZones
  if (parsed.relatedNpcs.length) entry.relatedNpcs = parsed.relatedNpcs
  if (parsed.rewards.length) entry.rewards = parsed.rewards.map((name) => ({ name }))
  if (parsed.requiredItems.length) entry.requiredItems = parsed.requiredItems
  if (parsed.expReward) entry.expReward = true
  return entry
}

function printSummary(quests: QuestEntry[], skipped: { page: string; reason: string }[]): void {
  const indexed = new Set<string>()
  let reqCount = 0
  let rewCount = 0
  for (const q of quests) {
    for (const r of q.requiredItems ?? []) {
      indexed.add(r.toLowerCase())
      reqCount++
    }
    for (const r of q.rewards ?? []) {
      indexed.add(r.name.toLowerCase())
      rewCount++
    }
  }
  console.log(`\nWrote ${quests.length} quests → ${OUT_PATH}`)
  console.log(
    `  items indexed: ${indexed.size} unique (${reqCount} required refs, ${rewCount} reward refs)  ` +
      `givers: ${quests.filter((q) => q.giver).length}  exp: ${quests.filter((q) => q.expReward).length}`
  )
  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length} pages (nothing parsed):`)
    for (const s of skipped) console.log(`  - ${s.page} — ${s.reason}`)
  }
}

interface CatalogRun {
  quests: QuestEntry[]
  skipped: { page: string; reason: string }[]
  /** pages that had no wikitext: the catalog would silently lose them */
  failed: string[]
}

/** Parse every page; a page with no wikitext is a failure, never a silent omission. */
export function buildCatalog(
  pages: Member[],
  wikitext: (p: Member) => string | null,
  isItem: (title: string) => boolean
): CatalogRun {
  const run: CatalogRun = { quests: [], skipped: [], failed: [] }
  for (const p of pages) {
    const wt = wikitext(p)
    if (wt == null) {
      run.failed.push(p.title)
      continue
    }
    const parsed = parseQuestPage(p.title, wt, isItem)
    const reason = nonQuestReason(parsed)
    if (reason) run.skipped.push({ page: p.title, reason })
    else run.quests.push(toQuestEntry(parsed))
  }
  run.quests.sort((a, b) => a.page.localeCompare(b.page))
  return run
}

/** The committed file's stamp when its quests did not change, so an unchanged wiki is a no-op diff. */
function previousScrapedAt(quests: QuestEntry[]): string | undefined {
  try {
    const prev = JSON.parse(readFileSync(OUT_PATH, 'utf8')) as QuestData
    return JSON.stringify(prev.quests) === JSON.stringify(quests) ? prev.scrapedAt : undefined
  } catch {
    return undefined
  }
}

async function main(): Promise<void> {
  const itemTitles = await collectItemTitles()
  const isItem = (title: string): boolean => itemTitles.has(titleKey(title))

  const pages = await collectQuestPages()
  console.log(`\nChecking ${pages.length} quest pages for changes…`)
  const fetchFailed = new Set(await syncPageCache(pages))
  const wikitext = (p: Member): string | null =>
    fetchFailed.has(p.title) || !existsSync(pageFile(p.pageid)) ? null : readFileSync(pageFile(p.pageid), 'utf8')

  const { quests, skipped, failed } = buildCatalog(pages, wikitext, isItem)
  if (failed.length) {
    // Writing now would drop these quests from the committed file.
    console.error(`\n${failed.length} pages have no wikitext; ${OUT_PATH} left unchanged:`)
    for (const t of failed) console.error(`  - ${t}`)
    console.error('Re-run to retry; --refresh re-lists the pages if they were deleted or renamed.')
    process.exitCode = 1
    return
  }
  const out: QuestData = {
    // Every page was just checked against its live revid, so a new stamp is honest.
    scrapedAt: previousScrapedAt(quests) ?? new Date().toISOString(),
    source: 'eqlwiki.com — Category:Quests + quest subcategories',
    quests
  }
  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2))

  printSummary(quests, skipped)
}

if (isMain(import.meta.url)) void main()
