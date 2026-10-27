/**
 * Wiki ITEM-DATABASE scraper — the FULL corpus of item knowledge (companion to
 * scrape-quests / scrape-mobs).
 *
 *   npm run scrape:items                # incremental: reuses the on-disk response cache
 *   npm run scrape:items -- --refresh   # ignore the cached index/batches, re-fetch everything
 *
 * WHY: `itemLookup.ts` used to answer every unknown item with a live two-request round trip
 * (search → parse) whose result lived only in that one user's userData cache. Item pages are
 * static wiki content, so the whole corpus is scraped ONCE here, committed as
 * src/main/data/items.json, and read locally — the precedent posky.json / quests.json /
 * mobs.json already set. The live wiki path survives in itemLookup as the FALLBACK for items
 * whose page was created after the last refresh.
 *
 * ENUMERATION (probed against the live wiki 2026-08-03, MediaWiki 1.45.3):
 *   embeddedin Template:Itempage, ns0            18,367 pages   (37 index requests @ eilimit=500)
 *   Category:Items ∪ Inventory Items ∪ Quest      11,212 pages   (44 index requests)
 *     Items ∪ Player Crafted
 *   ...of which only THREE (Exaltations, Large Groove Nocks, Soil of Underfoot) are absent
 *   from the embeddedin list — and none of the three opens an {{Itempage}} template, so the
 *   direct-template filter below would drop them anyway. `embeddedin` is therefore a proven
 *   SUPERSET here (MediaWiki's templatelinks records the direct transclusion every real item
 *   page performs), and the category union is deliberately NOT scraped: it costs 44 requests
 *   and adds nothing. `Template:Itempage` has no redirects, so there is no alias to miss.
 *
 * `embeddedin` also reports INDIRECT transclusions — a quest/index page that shows an item
 * box (`{{:Gnome Meat}}`) is listed as embedding Itempage. That is the same trap
 * scrape-quests documented and scrape-mobs solved: enumerate broadly, then keep only pages
 * whose OWN wikitext opens the template (`isItemPage`). Over-broad enumeration is made safe
 * by evidence, not by a guess.
 *
 * CONTENT FETCH IS BATCHED — this is the difference between hundreds of requests and tens of
 * thousands. `action=query&prop=revisions&rvprop=content&rvslots=main&pageids=<50 ids>`
 * returns fifty pages' complete wikitext in ONE response. MEASURED: 50 ids works, 60 comes
 * back with ZERO pages (the anonymous multi-value limit is 50 and the API does not warn), so
 * BATCH is pinned to 50 and never raised blind. 18,367 pages ⇒ 368 content requests.
 *
 * PARSING is `parseItemWikitext` from src/main/itemLookupParse.ts — the SAME pure function
 * the live fallback uses. The committed record is therefore the identical shape a live lookup
 * would have produced; there is no second parser to drift.
 *
 * Scraper etiquette (AGENTS.md LAW): every request goes through sources/wikiApi.ts — one
 * serialized request at a time, a second apart (owner ruling 2026-08-22 — fan-run servers; bulk
 * API batching does the heavy lifting), maxlag=5, exponential backoff honouring Retry-After on
 * 429/5xx, an error body thrown rather than read as empty — a disk cache under
 * scripts/sources/cache/items so a warm re-run hits the network ZERO times, and partial runs
 * resume batch-by-batch instead of duplicating work (a batch file is written only after its
 * response arrived intact). Output keys are sorted, so a re-scrape produces a clean diff.
 */
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { parseItemWikitext, templateField } from '../src/main/itemLookupParse'
import { itemKey, type ItemDbEntry, type ItemDbFile } from '../src/main/itemsDb'
import { pageNotices } from '../src/shared/pageNotices'
import { isMain } from './sources/isMain'
import { applyItemOtherNames, cachedRedirects } from './sources/mobRedirects'
import { createCache } from './sources/diskCache'
import { wikiGet } from './sources/wikiApi'

const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = resolve(HERE, 'sources/cache/items')
const OUT_PATH = resolve(HERE, '../src/main/data/items.json')

/** MEASURED anonymous multi-value limit (see header) — 60 ids silently returns nothing. */
const BATCH = 50
const SOURCE = 'eqlwiki.com — embeddedin Template:Itempage (ns0), filtered to pages opening {{Itempage}}'

const refresh = process.argv.slice(2).includes('--refresh')

interface Member {
  pageid: number
  ns: number
  title: string
}

/** Every ns0 page that (directly or indirectly) transcludes a template. */
export async function embeddedIn(template: string): Promise<Member[]> {
  const out: Member[] = []
  let cont: string | undefined
  for (let page = 0; page < 200; page++) {
    const params: Record<string, string> = {
      action: 'query',
      list: 'embeddedin',
      eititle: template,
      einamespace: '0',
      eilimit: '500'
    }
    if (cont) params.eicontinue = cont
    const j = await wikiGet<{ query?: { embeddedin?: Member[] }; continue?: { eicontinue?: string } }>(params)
    out.push(...(j.query?.embeddedin ?? []))
    cont = j.continue?.eicontinue
    if (!cont) return out
  }
  throw new Error(`embeddedin ${template}: still continuing after 200 pages, refusing a truncated list`)
}

// ---- disk cache: sources/diskCache.ts ------------------------------------------

const { read: readCache, write: writeCache } = createCache(CACHE_DIR, { refresh })

/** One page of a `prop=revisions` response. `missing` pages carry no revision at all. */
interface RevPage {
  pageid?: number
  title: string
  missing?: boolean
  revisions?: { slots?: { main?: { content?: string } } }[]
}

/**
 * Fifty pages' wikitext in ONE request, cached by the batch's first pageid + its length.
 * Naming it after CONTENT (not a running index) is what makes a partial run resumable
 * without duplicating: the page list is itself cached and sorted, so the same slice always
 * produces the same file name, and a re-run reads it back instead of asking the wiki.
 */
async function fetchBatch(slice: Member[]): Promise<RevPage[]> {
  const file = `batch-${slice[0].pageid}-${slice.length}.json`
  const cached = readCache(file) as RevPage[] | null
  // A batch left by an older page list can share the name; reuse it only if it holds exactly this slice.
  if (Array.isArray(cached) && batchProblem(slice, cached, false) === null) return cached
  const j = await wikiGet<{ query?: { pages?: RevPage[] }; continue?: unknown }>({
    action: 'query',
    prop: 'revisions',
    rvprop: 'content',
    rvslots: 'main',
    pageids: slice.map((p) => p.pageid).join('|')
  })
  const pages = j.query?.pages ?? []
  const problem = batchProblem(slice, pages, j.continue !== undefined)
  if (problem) throw new Error(`batch ${file}: ${problem}; not cached`)
  // Write only AFTER a complete response: a half-written batch must never look cached.
  writeCache(file, pages)
  return pages
}

/** Why a batch response is not the whole slice (null when it is): wrong page set, or continued. */
export function batchProblem(slice: Member[], pages: RevPage[], continued: boolean): string | null {
  if (continued) return 'response carries continue (partial content)'
  const want = slice.map((p) => p.pageid).sort((a, b) => a - b).join()
  const have = pages.map((p) => p.pageid ?? -1).sort((a, b) => a - b).join()
  return want === have ? null : `pages ${pages.length} do not match the ${slice.length} requested`
}

// ---- page → record -------------------------------------------------------------------

/**
 * Does this page's OWN wikitext open an {{Itempage}} template? `embeddedin` reports indirect
 * transclusions, so this is the evidence that makes the over-broad enumeration safe.
 */
export function isItemPage(wikitext: string): boolean {
  return /\{\{\s*Itempage\b/i.test(wikitext)
}

/**
 * The page's `|itemname`, when it is a plain display name that DIFFERS from the page title.
 * Rejects anything carrying markup — an item name is a name, and a field holding a template
 * or a link is a page someone filled in wrong, not a second name for this item.
 */
export function displayName(wikitext: string, title: string): string | undefined {
  const raw = templateField(wikitext, 'itemname')?.replace(/\s+/g, ' ').trim()
  if (!raw || raw.length > 80) return undefined
  if (/[{}[\]|<>]/.test(raw)) return undefined
  return raw === title ? undefined : raw
}

/** A value that says nothing: the parser's `undefined`, a `false` flag, an empty list. */
function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === false || (Array.isArray(v) && v.length === 0)
}

/** Keep only the keys whose value says something — see the compaction note in itemsDb.ts. */
function compact(entry: ItemDbEntry): ItemDbEntry {
  const kept = Object.entries(entry).filter(([, v]) => !isEmptyValue(v))
  return Object.fromEntries(kept) as unknown as ItemDbEntry
}

/** One item page → the committed record (or null when the page carried nothing at all). */
export function toEntry(title: string, wikitext: string): ItemDbEntry | null {
  const parsed = parseItemWikitext(title, wikitext)
  const name = displayName(wikitext, title)
  // `{{DNE}}` / `{{delete}}`: the page says the item may not be in Legends (owner, 2026-10-22).
  const notices = pageNotices(wikitext)
  const entry = compact({ page: title, ...parsed, ...(name ? { name } : {}), ...(notices === undefined ? {} : { notices }) })
  // A record that states nothing beyond its own title is noise: a stub page with an empty
  // template. Committing it would only teach the app to stop asking the wiki about it.
  return Object.keys(entry).length > 1 ? entry : null
}

// ---- main ------------------------------------------------------------------------------

export interface RunStats {
  pages: number
  entries: number
  notItem: number
  missing: number
  empty: number
  /** distinct pages that also registered an `|itemname` key */
  aliases: number
  /** keys claimed by more than one page (richer record wins — see `addKeys`) */
  collisions: number
}

/**
 * Register a record under its page title and, when it differs, its `|itemname`.
 *
 * COLLISIONS ARE REAL AND EXPECTED (measured: 51 among page titles alone). The wiki carries
 * case-variant duplicates of the same item — "Cyclops skull" AND "Cyclops Skull",
 * "Elf-hide Gloves" AND "Elf-Hide Gloves" — which fold to one key because the key folds case
 * (law 2). One of the pair is normally the filled-in page and the other a near-stub, so the
 * RICHER record wins (more serialized bytes = more fields the page actually stated); ties go
 * to the first title in sort order, which keeps the output deterministic either way.
 *
 * Titles are registered FIRST and an alias never takes a key a page title holds: a page whose
 * `|itemname` was copy-pasted from another item ('Armadillo Tail' naming 'Armadillo Tooth')
 * would otherwise evict the real page whenever its record serialized longer.
 */
function claimKey(items: Map<string, ItemDbEntry>, k: string, entry: ItemDbEntry, stats: RunStats): void {
  const prev = items.get(k)
  if (prev) stats.collisions++
  if (!prev || JSON.stringify(entry).length > JSON.stringify(prev).length) items.set(k, entry)
}

/** A disambiguated title's base name: `Dimensional Hole (Item)` → `Dimensional Hole`. */
function baseTitle(page: string): string | undefined {
  return /^(.+?)\s*\(Item\)$/i.exec(page)?.[1]
}

export function buildIndex(entries: ItemDbEntry[], stats: RunStats): Map<string, ItemDbEntry> {
  const items = new Map<string, ItemDbEntry>()
  for (const e of entries) {
    const k = itemKey(e.page)
    if (k) claimKey(items, k, e, stats)
  }
  const titled = new Set(items.keys())
  for (const e of entries) {
    if (e.name) stats.aliases++
    const aliases = new Set([e.name, baseTitle(e.page)].map((a) => (a ? itemKey(a) : '')))
    for (const k of aliases) if (k && !titled.has(k)) claimKey(items, k, e, stats)
  }
  return items
}

/** Distinct pages a key still reaches: a case-variant loser is parsed but not shipped. */
export function reachableCount(items: Map<string, ItemDbEntry>): number {
  return new Set(items.values()).size
}

/** Fold one fetched page into the entry list, counting exactly why it produced no record. */
function foldPage(p: RevPage, entries: ItemDbEntry[], stats: RunStats): void {
  const wt = p.revisions?.[0]?.slots?.main?.content
  if (p.missing === true || wt == null) {
    stats.missing++
    return
  }
  if (!isItemPage(wt)) {
    stats.notItem++
    return
  }
  const entry = toEntry(p.title, wt)
  if (!entry) {
    stats.empty++
    return
  }
  stats.entries++
  entries.push(entry)
}

async function collectPages(): Promise<Member[]> {
  const cached = readCache('item-pages.json') as Member[] | null
  if (cached) {
    console.log(`Item pages: ${cached.length} (cached)`)
    return cached
  }
  console.log('Enumerating embeddedin Template:Itempage…')
  const members = await embeddedIn('Template:Itempage')
  const pages = members
    .filter((m) => m.ns === 0)
    .sort((a, b) => a.title.localeCompare(b.title))
  writeCache('item-pages.json', pages)
  console.log(`Item pages: ${pages.length}`)
  return pages
}

function printSummary(stats: RunStats, keys: number, bytes: number, startedAt: number): void {
  const mins = ((Date.now() - startedAt) / 60000).toFixed(1)
  console.log(`\nWrote ${stats.entries} items (${keys} keys) → ${OUT_PATH}  (${mins} min)`)
  console.log(
    `  pages enumerated: ${stats.pages}   parsed as items: ${stats.entries}   ` +
      `not an item page: ${stats.notItem}   empty template: ${stats.empty}   missing: ${stats.missing}`
  )
  console.log(`  name aliases: ${stats.aliases}   key collisions (richer record wins): ${stats.collisions}`)
  console.log(`  raw size: ${(bytes / 1048576).toFixed(2)} MB (inlined into the main bundle)`)
}

async function main(): Promise<void> {
  const startedAt = Date.now()
  const pages = await collectPages()
  const batches = Math.ceil(pages.length / BATCH)
  console.log(`\nFetching ${pages.length} pages in ${batches} batches of ${BATCH}…`)

  const entries: ItemDbEntry[] = []
  const stats: RunStats = {
    pages: pages.length, entries: 0, notItem: 0, missing: 0, empty: 0, aliases: 0, collisions: 0
  }
  for (let i = 0; i < pages.length; i += BATCH) {
    for (const p of await fetchBatch(pages.slice(i, i + BATCH))) foldPage(p, entries, stats)
    const n = i / BATCH + 1
    if (n % 25 === 0) console.log(`  batch ${n}/${batches}  (items so far: ${stats.entries})`)
  }

  const items = buildIndex(entries, stats)
  // Sorted keys ⇒ a deterministic file ⇒ a re-scrape diffs cleanly against the wiki.
  const sorted = Object.fromEntries([...items.entries()].sort((a, b) => a[0].localeCompare(b[0])))
  // The cached redirects that land on each page as its otherNames (owner, 2026-10-22: Halfling Blood).
  applyItemOtherNames(sorted, cachedRedirects(), itemKey)
  const out: ItemDbFile = {
    scrapedAt: new Date().toISOString(),
    source: SOURCE,
    count: reachableCount(items),
    items: sorted
  }
  // No pretty-printing: this file is INLINED into every user's main bundle, and indentation
  // is ~30% of it. It is generated, and `git diff` on a scraped 8 MB dataset is a review of
  // the summary line, not of the bytes.
  const json = JSON.stringify(out)
  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, json, 'utf8')

  printSummary(stats, items.size, Buffer.byteLength(json), startedAt)
}

if (isMain(import.meta.url)) void main()
