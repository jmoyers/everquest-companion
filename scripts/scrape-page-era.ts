/**
 * PAGE-ERA fetcher — the wiki's era verdict for the NON-ITEM pages our era? items link
 * (JOS-341, the follow-up JOS-333 measured and refused to do on its own).
 *
 *   npm run scrape:page-era              # incremental: reuses the on-disk response cache
 *   npm run scrape:page-era -- --refresh # ignore the cache, re-ask the wiki
 *   npm run scrape:page-era -- --dry-run # enumerate and print, send NOTHING
 *
 * WHY. eqlwiki draws its red `OUT OF ERA` pill on LINKS, not on pages: its skin module
 * `skins.EQLImmersive.eraFilter` walks every internal anchor, asks a custom `action=eqlmetadata`
 * for each TARGET's `outOfEra`, and styles the ones that come back true (JOS-333 characterized it
 * live and the finding is written up in `src/main/planner/eraDerive.ts`). Our item corpus holds
 * ITEM pages only — `embeddedin Template:Itempage` — so when the link that decides an item's era
 * points at an armour-SET page or a quest hub, the corpus cannot see it and the row stays `era?`.
 * The owner's Silver Full Breastplate is exactly that: one pill on its page, sitting on
 * `[[Cultural Tradeskills: Human]]`, which is not an item page.
 *
 * MEASURED BEFORE ANY REQUEST WAS SENT (this script's `--dry-run`, over the committed corpus and
 * the item scraper's wikitext cache): the 2,292 corpus pages layers 1-2 leave silent name 151
 * DISTINCT non-item pages in their `|notes`, between them referenced by 824 pages, and 622 of
 * those references are the nine `Cultural Tradeskills: <Race>` set hubs. So the whole question is
 * 151 titles wide, which is why this is cheap enough to be polite.
 *
 * THE REQUEST BUDGET, in full, for a cold run on today's corpus:
 *   1 × POST `action=eqlmetadata`  — the wiki's own predicate, 450 titles per request (its skin's
 *       own batch size), so all 151 fit in one.
 *   4 × GET  `prop=revisions&rvprop=content` — 50 titles per request (the anonymous multi-value
 *       limit `scrape-items.ts` MEASURED: 60 returns zero pages with no warning). This is what
 *       reads each page's own `{{X Era}}` banner or `[[Category:X Era]]`, and it is not
 *       redundant with the line above — see THE SILENCE PROBLEM.
 *   0–4 × GET `prop=categories` — the DOCUMENTED FALLBACK, and only if `eqlmetadata` fails. The
 *       skin module spells this path out itself: fold each category name (lowercase, strip
 *       spaces/underscores/slashes/hyphens, drop a trailing `era`) and match it against
 *       `mw.config.wgEQLEraOutKeys`, which is the eleven `out` rows of `PAGE_ERA` in
 *       `shared/planner/era.ts` at `wgEQLEraConfigRevision` 156232. We do not re-implement that
 *       list; `eraBadge`/`namesEra` ARE it.
 * Five requests, warm cache zero. Same UA, same 1 s serialized delay (owner ruling 2026-08-22
 * — fan-run servers), same Retry-After backoff
 * as every other scraper here (AGENTS.md scraper etiquette).
 *
 * THE SILENCE PROBLEM, and why the token is fetched rather than inferred. `outOfEra: false` is
 * returned both for a page the wiki classifies as classic content and for a page nobody has
 * classified at all — `[[Blacksmithing]]`, `[[Warrior]]`, an NPC stub. Treating those the same
 * would let a link to a skill page argue that a piece of gear is in era, which is guessing in the
 * one direction that shows a player content that is not there. So this fetch keeps the page's own
 * era TOKEN, and `eraDerive.ts` requires a positive token before it will read a page as evidence
 * FOR an item. The `outOfEra` boolean stands on its own for the OUT direction, because there the
 * wiki has made a positive claim.
 *
 * ENUMERATION NEEDS ITEM WIKITEXT, and `|notes` is stored markup-stripped, so it cannot come from
 * `items.json`. Warm path: the ITEM scraper's response cache (`sources/cache/items`, ~370 batch
 * files, gitignored) — zero requests. Cold path: this script fetches wikitext for the 2,292 silent
 * pages ONLY, 50 at a time (46 requests), into its own cache. Either way the enumeration is the
 * shipped parser's `notesLinkTargets`, never a regex written twice.
 *
 * AND THE SPELL PAGES (JOS-393), which are the same question asked about a third enumeration. The
 * wiki badges a link to `Sloths Healing` — `{{Kunark Era}}`, `Shaman - Level 50+` — exactly the way
 * it badges a link to a Velious breastplate, and the committed spell catalog records every field of
 * that page except the badge, so a level-50 shaman was being told the spell was newly his. The
 * TARGETS are the spell scrape's own enumeration (`embeddedin Template:Spellpage`, 4 GETs, cached)
 * UNION the names `spells.json` carries, because those two sets differ on 53 rows — a page's own
 * `spellname` field sometimes spells the name with a backtick, and a few catalog names are wiki
 * REDIRECTS, which embed no template and so are in no enumeration — and the catalog's name is the
 * only handle the loader has to join on. ~2,090 titles is 5 more `eqlmetadata` POSTs at its batch
 * size, and no wikitext at all: only the OUT direction is read (`pageEraDb.ts` `spells`).
 *
 * OUTPUT is `src/main/data/pageEra.json` (shape: `src/main/pageEraDb.ts`), keys sorted so a
 * re-fetch diffs cleanly. `items.json` and `spells.json` are NOT rewritten — this is a sidecar, and
 * each corpus is a scrape of a different enumeration on its own schedule.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { notesLinkTargets, parsePageEraTag } from '../src/main/itemLookupParse'
import { itemKey, type ItemDbEntry, type ItemDbFile } from '../src/main/itemsDb'
import { pageEraKey, type PageEraEntry, type PageEraFile } from '../src/main/pageEraDb'
import { eraBadge, layeredVerdict, namesEra } from '../src/shared/planner/era'
import type { SpellDbFile } from '../src/shared/types'

const API = 'https://eqlwiki.com/api.php'
const UA = 'everquest-companion/0.1 (personal quest tracker)'

const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = resolve(HERE, 'sources/cache/page-era')
const ITEM_CACHE_DIR = resolve(HERE, 'sources/cache/items')
const ITEMS_PATH = resolve(HERE, '../src/main/data/items.json')
const MOBS_PATH = resolve(HERE, '../src/renderer/src/data/eqlegends/mobs.json')
const SPELLS_PATH = resolve(HERE, '../src/main/data/spells.json')
const OUT_PATH = resolve(HERE, '../src/main/data/pageEra.json')

const DELAY_MS = 1000
const MAX_RETRIES = 5
/** MEASURED anonymous multi-value limit (scrape-items.ts header) — 60 silently returns nothing. */
const TITLE_BATCH = 50
/** The batch size eqlwiki's OWN era filter uses against this endpoint. */
const META_BATCH = 450
const SOURCE =
  'eqlwiki.com — action=eqlmetadata outOfEra + page era banner/category, for the non-item |notes ' +
  'link targets of the corpus pages layers 1-2 leave silent, the mobs that drop them, and every ' +
  'spell page the spell catalog enumerates'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const argv = process.argv.slice(2)
const refresh = argv.includes('--refresh')
const dryRun = argv.includes('--dry-run')

// ---- polite API client (identical contract to scrape-items.ts, plus a POST) --------------------

/** Wait before a retry: the server's Retry-After when it gave a usable one, else our backoff. */
function retryDelayMs(res: Response, backoff: number): number {
  const retryAfter = Number(res.headers.get('retry-after'))
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff
}

let requestsSent = 0

/** A maxlag deferral arrives as HTTP 200 with an error body (and a Retry-After header). */
function isMaxlagDeferral(j: unknown): boolean {
  return (j as { error?: { code?: string } }).error?.code === 'maxlag'
}

/**
 * One serialized request with exponential backoff on 429/5xx (honours Retry-After).
 *
 * POST exists for exactly one caller: `action=eqlmetadata` is POST-only (JOS-333's live probe), and
 * 450 titles would not fit a query string anyway.
 */
/** GET puts the params in the query string; POST puts them in the body. One shape either way. */
function requestFor(params: Record<string, string>, method: 'GET' | 'POST'): [string, RequestInit] {
  // maxlag=5: MediaWiki's own bot-courtesy contract — the server refuses the request outright
  // when replication lag exceeds 5s, instead of straining to serve it (owner ruling 2026-08-22).
  const body = new URLSearchParams({ format: 'json', formatversion: '2', maxlag: '5', ...params })
  if (method === 'GET') return [`${API}?${body.toString()}`, { headers: { 'User-Agent': UA } }]
  return [
    API,
    {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    }
  ]
}

async function api<T>(params: Record<string, string>, method: 'GET' | 'POST' = 'GET'): Promise<T> {
  const [url, init] = requestFor(params, method)
  let wait = 1000
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      requestsSent++
      res = await fetch(url, init)
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err
      await sleep(wait)
      wait *= 2
      continue
    }
    if (res.ok) {
      await sleep(DELAY_MS)
      const j = (await res.json()) as T
      if (isMaxlagDeferral(j) && attempt < MAX_RETRIES) {
        await sleep(retryDelayMs(res, wait))
        wait *= 2
        continue
      }
      return j
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(retryDelayMs(res, wait))
      wait *= 2
      continue
    }
    throw new Error(`${res.status} ${res.statusText} for ${params.action} ${params.prop ?? ''}`)
  }
}

// ---- disk cache (the scrape-items contract: write only after a complete response) --------------

function readCache(name: string): unknown {
  if (refresh) return null
  const p = resolve(CACHE_DIR, name)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as unknown
  } catch {
    return null
  }
}

function writeCache(name: string, data: unknown): void {
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(resolve(CACHE_DIR, name), JSON.stringify(data), 'utf8')
}

/** A file name a title list can own: the batch's first title, folded to something a disk likes. */
function batchName(prefix: string, titles: readonly string[]): string {
  const slug = titles[0].replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40)
  return `${prefix}-${slug}-${String(titles.length)}.json`
}

// ---- step 1: which corpus pages are still silent, and what do their notes link -----------------

interface RevPage {
  title: string
  missing?: boolean
  revisions?: { slots?: { main?: { content?: string } } }[]
}

/** The zones an item states on its OWN page — the same read `eraDerive.ts` makes. */
function pageZones(entry: ItemDbEntry): string[] {
  return (entry.dropsFrom ?? []).flatMap((s) => (s.zone === undefined ? [] : [s.zone]))
}

/**
 * The corpus pages layers 1-2 leave silent: no drop zone anyone can resolve AND no era claim of
 * their own. Exactly the set `buildEraDerivations` walks, and exactly the rows chipped `era?`.
 */
function silentPages(file: ItemDbFile): { page: string; key: string }[] {
  const out: { page: string; key: string }[] = []
  const seen = new Set<string>()
  for (const entry of Object.values(file.items)) {
    if (seen.has(entry.page)) continue
    seen.add(entry.page)
    if (layeredVerdict(pageZones(entry), entry.eraTag) !== 'unknown') continue
    out.push({ page: entry.page, key: itemKey(entry.page) })
  }
  return out.sort((a, b) => a.page.localeCompare(b.page))
}

/** Wikitext for a list of TITLES, 50 per request, cached per batch. */
async function fetchWikitext(titles: readonly string[], prefix: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (let i = 0; i < titles.length; i += TITLE_BATCH) {
    const slice = titles.slice(i, i + TITLE_BATCH)
    const file = batchName(prefix, slice)
    let pages = readCache(file) as RevPage[] | null
    if (pages === null) {
      const j = await api<{ query?: { pages?: RevPage[] } }>({
        action: 'query',
        prop: 'revisions',
        rvprop: 'content',
        rvslots: 'main',
        titles: slice.join('|')
      })
      pages = j.query?.pages ?? []
      writeCache(file, pages)
    }
    for (const p of pages) {
      const wt = p.revisions?.[0]?.slots?.main?.content
      if (wt != null) out.set(p.title, wt)
    }
  }
  return out
}

/**
 * Item wikitext for the silent pages — from the ITEM scraper's cache when it is on disk (free), by
 * fetching the silent pages alone when it is not.
 *
 * The item cache is gitignored (30 MB of raw wikitext), so a fresh clone takes the cold path and
 * pays 46 requests instead of the item scraper's 369. Which path ran is printed, because a run
 * that reads a cache older than `items.json` is enumerating yesterday's notes.
 */
/** Whatever the ITEM scraper's cache still holds for the pages we want. Empty when it is absent. */
function fromItemCache(wanted: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>()
  if (!existsSync(ITEM_CACHE_DIR) || refresh) return out
  for (const f of readdirSync(ITEM_CACHE_DIR)) {
    if (!f.startsWith('batch-')) continue
    const pages = JSON.parse(readFileSync(resolve(ITEM_CACHE_DIR, f), 'utf8')) as RevPage[]
    for (const p of pages) keepWanted(out, p, wanted)
  }
  console.log(`Item wikitext: ${String(out.size)} of ${String(wanted.size)} silent pages from the ITEM scraper's cache`)
  return out
}

function keepWanted(out: Map<string, string>, p: RevPage, wanted: ReadonlySet<string>): void {
  const wt = p.revisions?.[0]?.slots?.main?.content
  if (wt != null && wanted.has(p.title)) out.set(p.title, wt)
}

async function itemWikitext(pages: readonly { page: string }[]): Promise<Map<string, string>> {
  const wanted = new Set(pages.map((p) => p.page))
  const out = fromItemCache(wanted)
  const missing = [...wanted].filter((t) => !out.has(t)).sort((a, b) => a.localeCompare(b))
  if (missing.length === 0) return out
  const batches = Math.ceil(missing.length / TITLE_BATCH)
  console.log(`Fetching wikitext for ${String(missing.length)} silent pages (${String(batches)} requests)…`)
  // A dry run says what it WOULD ask for and enumerates off what it has. The gap is the item cache
  // being older than `items.json` (JOS-328 rebuilt the corpus after the last item scrape), so those
  // pages contribute no notes targets to the printed census — stated, not silently absorbed.
  if (dryRun) {
    console.log('  --dry-run: skipped; the census below is missing those pages')
    return out
  }
  for (const [t, wt] of await fetchWikitext(missing, 'items')) out.set(t, wt)
  return out
}

// ---- step 2: ask the wiki about the targets ----------------------------------------------------

/**
 * `action=eqlmetadata`'s answer, RECORDED HERE VERBATIM because this endpoint is not MediaWiki's —
 * it is eqlwiki's own, undocumented outside the skin module that calls it, and the response shape
 * below was read off the live wire on 2026-08-13 (the cached response is in
 * `sources/cache/page-era/meta-*.json` and is the citation):
 *
 *   { "eqlmetadata": { "eraRevision": 156232,
 *                      "pages": [ { "title": "Cultural_Tradeskills:_Human", "outOfEra": true,
 *                                   "missing": false, "touched": "20260809044324",
 *                                   "requested": ["Cultural_Tradeskills:_Human"] }, … ] } }
 *
 * `eraRevision` is the punchline: 156232 is the `Template:PageEra` revid `shared/planner/era.ts`
 * already cites for its mirrored register. The endpoint and our table are the same revision of the
 * same switch, which is why this is mirroring and not a second opinion.
 *
 * `requested` is the spelling WE asked with; `title` is what the wiki resolved it to. Both are
 * keyed, so a redirect in someone's notes still finds its answer.
 */
interface MetaRow {
  title?: string
  outOfEra?: boolean
  missing?: boolean
  requested?: string[]
}
interface MetaResponse {
  eqlmetadata?: { eraRevision?: number; pages?: MetaRow[] }
  error?: { code?: string; info?: string }
}

let eraRevision: number | undefined

async function fetchMetadata(titles: readonly string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  for (let i = 0; i < titles.length; i += META_BATCH) {
    const slice = titles.slice(i, i + META_BATCH)
    const file = batchName('meta', slice)
    let j = readCache(file) as MetaResponse | null
    if (j === null) {
      j = await api<MetaResponse>({ action: 'eqlmetadata', titles: slice.join('|') }, 'POST')
      writeCache(file, j)
    }
    const rows = j.eqlmetadata?.pages
    if (rows === undefined) throw new Error(`eqlmetadata returned no pages: ${JSON.stringify(j).slice(0, 300)}`)
    eraRevision ??= j.eqlmetadata?.eraRevision
    for (const row of rows) keepRow(out, row)
  }
  return out
}

/** One answered row, filed under BOTH spellings: what we asked and what the wiki resolved it to. */
function keepRow(out: Map<string, boolean>, row: MetaRow): void {
  if (row.outOfEra === undefined) return
  for (const spelling of [row.title, ...(row.requested ?? [])]) {
    if (spelling !== undefined) out.set(pageEraKey(spelling), row.outOfEra)
  }
}

/**
 * THE DOCUMENTED FALLBACK, run only when `eqlmetadata` did not answer. `prop=categories` on the
 * target, each category name put through the SAME register the banner reader uses: a category the
 * era tables do not name is not an era claim (`namesEra`, the P99 date-filing guard), and one they
 * do name is out-of-era exactly when `eraBadge` says so. That is `wgEQLEraOutKeys` — we hold the
 * eleven keys already, at the same `Template:PageEra` revid.
 */
async function fetchCategories(titles: readonly string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  interface CatPage {
    title: string
    missing?: boolean
    categories?: { title: string }[]
  }
  for (let i = 0; i < titles.length; i += TITLE_BATCH) {
    const slice = titles.slice(i, i + TITLE_BATCH)
    const file = batchName('cats', slice)
    let pages = readCache(file) as CatPage[] | null
    if (pages === null) {
      const j = await api<{ query?: { pages?: CatPage[] } }>({
        action: 'query',
        prop: 'categories',
        cllimit: 'max',
        titles: slice.join('|')
      })
      pages = j.query?.pages ?? []
      writeCache(file, pages)
    }
    for (const p of pages) {
      const tokens = (p.categories ?? []).flatMap((c) => {
        const m = /^Category:\s*(.+?)[ _]+Era$/i.exec(c.title)
        return m === null ? [] : [m[1].replace(/[_\s]+/g, ' ').trim()]
      })
      out.set(pageEraKey(p.title), tokens.some((t) => namesEra(t) && eraBadge(t) === 'out'))
    }
  }
  return out
}

// ---- step 3: the DROPPERS (the owner's Life's Guard addition) ----------------------------------
//
// THE EXAMPLE, and what measuring it actually found. The owner named Life's Guard as "an era? item
// whose out-of-era reference is the MOB it drops from". Its committed row says otherwise and the
// correction is worth more than the assumption: the page opens `{{Classic Era}}` and its one stated
// dropper sits under a `Plane of Hate` heading, so layers 1-2 rank it IN ERA, not era?. What is
// true is the rest of the report — the pill on that page is on `[[Agent of Innoruuk]]`, a Plane of
// Hate REVAMP mob the wiki badges out of era, and the row is currently offered as farmable loot.
//
// So the dropper edge is not only a fifth way to answer a silent row; it is the JOS-298 argument
// applied one link further out. A revamp replaces a classic zone's CONTENTS without adding a zone,
// so "Plane of Hate" says nothing about whether this drop table is the one running on this server —
// but the wiki's per-MOB verdict does. That makes the mob names a target set of their own.
//
// SCOPE, measured over the committed corpus: 5,451 pages state a `|dropsfrom`, naming 4,023
// distinct mobs; the mob catalog names 4,292 more droppers of the same items; the union is 5,006
// titles, which is 12 `eqlmetadata` POSTs at its own batch size. Both halves are asked, because
// the renderer folds the catalog's zones in beside the page's and an edge that read only one of
// them could call an item unreachable that the catalog knows a Lower Guk froglok drops.

/** Every mob name that could decide an item's era: the pages' own `|dropsfrom` ∪ the catalog's. */
function dropperTitles(file: ItemDbFile, catalog: { mobs: { name: string; drops?: string[] }[] }): string[] {
  const names = new Map<string, string>()
  const add = (raw: string): void => {
    const key = pageEraKey(raw)
    if (key !== '' && !names.has(key)) names.set(key, raw.trim())
  }
  const seen = new Set<string>()
  const corpusKeys = new Set<string>()
  for (const entry of Object.values(file.items)) {
    if (seen.has(entry.page)) continue
    seen.add(entry.page)
    corpusKeys.add(itemKey(entry.page))
    for (const src of entry.dropsFrom ?? []) add(src.mob)
  }
  for (const mob of catalog.mobs) {
    if ((mob.drops ?? []).some((d) => corpusKeys.has(itemKey(d)))) add(mob.name)
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b))
}

// ---- step 4: the SPELL pages (JOS-393) ---------------------------------------------------------
//
// THE REPORT. `Sloths Healing` was drawn as new at level 50 for a shaman. Its page opens
// `{{Kunark Era}}` and states `Shaman - Level 50+`, and eqlwiki badges every link to it out of era.
// The committed catalog holds that page's mana, its messages and its class line, and nothing at all
// about its era — so this is the same fetch the items and the mobs already get, pointed at the
// third enumeration.
//
// TWO SPELLINGS OF THE SAME SET, and both are asked. The scrape's enumeration is
// `embeddedin Template:Spellpage` (2,035 pages today); the catalog's rows are keyed by the page's
// own `| spellname =` field, which `scrape-spells.ts` prefers over the title. MEASURED over the
// committed corpus: 53 of 1,928 catalog names match no enumerated title (`Atol\`s Spectral
// Shackles` for `Atol's Spectral Shackles`, `Manicial Strength` for the page the wiki also keeps at
// `Maniacal Strength`, `Cantana of Soothing`), and 184 enumerated titles are carried by the catalog
// under a different name. The endpoint answers a redirect as happily as a page, so asking the UNION
// costs nothing but a few titles and leaves the LOADER able to join on the only handle it has.

/** Every page the spell scrape enumerates, by title. Cached — a re-run asks the wiki nothing. */
async function spellPageTitles(): Promise<string[]> {
  const cached = readCache('spell-pages.json') as string[] | null
  if (cached !== null) return cached
  const out: string[] = []
  let eicontinue: string | undefined
  for (let page = 0; page < 200; page++) {
    const j = await api<{
      query?: { embeddedin?: { title: string }[] }
      continue?: { eicontinue?: string }
    }>({
      action: 'query',
      list: 'embeddedin',
      eititle: 'Template:Spellpage',
      einamespace: '0',
      eilimit: '500',
      ...(eicontinue === undefined ? {} : { eicontinue })
    })
    for (const p of j.query?.embeddedin ?? []) out.push(p.title)
    eicontinue = j.continue?.eicontinue
    if (eicontinue === undefined) break
  }
  writeCache('spell-pages.json', out)
  return out
}

/** The enumeration ∪ the catalog's own names, deduped by key and sorted. */
function spellTargets(titles: readonly string[], catalog: SpellDbFile): string[] {
  const byKey = new Map<string, string>()
  for (const raw of [...titles, ...catalog.spells.map((s) => s.name)]) {
    const key = pageEraKey(raw)
    if (key !== '' && !byKey.has(key)) byKey.set(key, raw.trim())
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b))
}

// ---- main --------------------------------------------------------------------------------------

/** One target's row, folding the three reads into the committed record. */
function entryFor(
  title: string,
  wikitext: string | undefined,
  outOfEra: boolean | undefined,
  by: 'eqlmetadata' | 'categories'
): PageEraEntry {
  const eraTag = wikitext === undefined ? undefined : parsePageEraTag(wikitext)
  return {
    title,
    // The endpoint is the authority; when it declined to answer at all, a page whose own banner the
    // register calls out is still out (the same predicate, read off the page instead of the API).
    outOfEra: outOfEra ?? (eraTag !== undefined && eraBadge(eraTag) === 'out'),
    ...(eraTag === undefined ? {} : { eraTag }),
    ...(wikitext === undefined ? { missing: true } : {}),
    by
  }
}

/**
 * The boolean tables (`mobs`, `spells`), built the one way: a key per title the endpoint ANSWERED
 * for, and nothing at all for the ones it did not. Shared by both so the two cannot come to mean
 * different things about an absent row.
 */
function answered(titles: readonly string[], verdicts: ReadonlyMap<string, boolean>): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const title of titles) {
    const v = verdicts.get(pageEraKey(title))
    if (v !== undefined) out[pageEraKey(title)] = v
  }
  return out
}

function printCensus(refs: Map<string, string[]>, targets: readonly string[]): void {
  const byTarget = new Map<string, number>()
  for (const list of refs.values()) for (const t of list) byTarget.set(t, (byTarget.get(t) ?? 0) + 1)
  console.log(`\n${String(targets.length)} distinct non-item targets, referenced by ${String(refs.size)} era? pages`)
  console.log('  top 12 by referencing pages:')
  for (const [t, n] of [...byTarget].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`    ${String(n).padStart(4)}  ${t}`)
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now()
  const corpus = JSON.parse(readFileSync(ITEMS_PATH, 'utf8')) as ItemDbFile
  const catalog = JSON.parse(readFileSync(MOBS_PATH, 'utf8')) as { mobs: { name: string; drops?: string[] }[] }
  const silent = silentPages(corpus)
  console.log(`Corpus: ${String(Object.keys(corpus.items).length)} keys; ${String(silent.length)} pages layers 1-2 leave silent`)

  const wikitext = await itemWikitext(silent)
  const refs = new Map<string, string[]>()
  const targets = new Set<string>()
  const isItem = (t: string): boolean => corpus.items[itemKey(t)] !== undefined
  for (const { page, key } of silent) {
    const wt = wikitext.get(page)
    if (wt === undefined) continue
    // An item page linking another ITEM page is already an edge layer 3 walks (components, yields,
    // quests) or a link the corpus can answer on its own — this table is for what it CANNOT reach.
    const linked = notesLinkTargets(wt).filter((t) => t !== page && !isItem(t))
    if (linked.length === 0) continue
    refs.set(key, linked)
    for (const t of linked) targets.add(t)
  }
  const titles = [...targets].sort((a, b) => a.localeCompare(b))
  printCensus(refs, titles)

  const droppers = dropperTitles(corpus, catalog)
  console.log(`${String(droppers.length)} distinct dropper mobs (page |dropsfrom ∪ the mob catalog)`)

  if (dryRun) {
    // The spell enumeration is 4 GETs of its own on a cold cache; a dry run states the cost rather
    // than paying it, so this arm never asks the wiki for the title list either.
    const posts = 2 + Math.ceil(droppers.length / META_BATCH)
    console.log(`\n--dry-run: nothing sent. A cold run would send ${String(posts)}+ POSTs + ${String(Math.ceil(titles.length / TITLE_BATCH))}+4 GETs.`)
    return
  }

  const spellCatalog = JSON.parse(readFileSync(SPELLS_PATH, 'utf8')) as SpellDbFile
  const spellTitles = spellTargets(await spellPageTitles(), spellCatalog)
  console.log(`${String(spellTitles.length)} distinct spell pages (Template:Spellpage ∪ the ${String(spellCatalog.spells.length)} catalog names)`)

  let verdicts: Map<string, boolean>
  let by: 'eqlmetadata' | 'categories' = 'eqlmetadata'
  let mobVerdicts = new Map<string, boolean>()
  let spellVerdicts = new Map<string, boolean>()
  try {
    verdicts = await fetchMetadata(titles)
    mobVerdicts = await fetchMetadata(droppers)
    spellVerdicts = await fetchMetadata(spellTitles)
  } catch (err) {
    console.log(`eqlmetadata failed (${String(err)}) — falling back to prop=categories, as the skin module documents`)
    verdicts = await fetchCategories(titles)
    mobVerdicts = await fetchCategories(droppers)
    spellVerdicts = await fetchCategories(spellTitles)
    by = 'categories'
  }
  const targetText = await fetchWikitext(titles, 'target')

  const pages: Record<string, PageEraEntry> = {}
  for (const title of titles) {
    pages[pageEraKey(title)] = entryFor(title, targetText.get(title), verdicts.get(pageEraKey(title)), by)
  }
  // ASKED, not answered: a target the endpoint did not name at all stays out of its table, and the
  // readers take its absence as silence rather than as `false` (law 1, and see pageEraDb).
  const mobs = answered(droppers, mobVerdicts)
  const spells = answered(spellTitles, spellVerdicts)

  const out: PageEraFile = {
    scrapedAt: new Date().toISOString(),
    source: SOURCE,
    // Keys, not titles: the corpus spells a few targets two ways (`Fishing`/`fishing`,
    // `Halfling`/`halfling`) and they fold to one page.
    count: Object.keys(pages).length,
    ...(eraRevision === undefined ? {} : { eraRevision }),
    pages: Object.fromEntries(Object.entries(pages).sort((a, b) => a[0].localeCompare(b[0]))),
    refs: Object.fromEntries([...refs].sort((a, b) => a[0].localeCompare(b[0]))),
    mobs: Object.fromEntries(Object.entries(mobs).sort((a, b) => a[0].localeCompare(b[0]))),
    spells: Object.fromEntries(Object.entries(spells).sort((a, b) => a[0].localeCompare(b[0])))
  }
  mkdirSync(dirname(OUT_PATH), { recursive: true })
  // Compact, the items.json posture: the `mobs` table alone is 5k rows, so this stopped being a
  // file anyone reads by eye the moment the dropper edge joined. What IS reviewable is the census
  // printed below and the corpus sweep that asserts it (`tests/plannerEraCorpus.test.mts`).
  writeFileSync(OUT_PATH, `${JSON.stringify(out)}\n`, 'utf8')

  const outCount = Object.values(out.pages).filter((p) => p.outOfEra).length
  const tagged = Object.values(out.pages).filter((p) => p.eraTag !== undefined).length
  const mobsOut = Object.values(mobs).filter(Boolean).length
  const spellsOut = Object.values(spells).filter(Boolean).length
  console.log(
    `\nWrote ${String(titles.length)} pages + ${String(Object.keys(mobs).length)} mobs + ` +
      `${String(Object.keys(spells).length)} spells → ${OUT_PATH}  (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`
  )
  console.log(`  pages out of era: ${String(outCount)}   states an era token: ${String(tagged)}   verdict by: ${by}`)
  console.log(`  mobs out of era:  ${String(mobsOut)} of ${String(Object.keys(mobs).length)} answered`)
  // The three counts a spell reader needs: out, in, and the ones nobody answered for (asked minus
  // answered — silence, which the loader marks nothing for).
  console.log(
    `  spells out of era: ${String(spellsOut)}   in era: ${String(Object.keys(spells).length - spellsOut)}   ` +
      `unanswered: ${String(spellTitles.length - Object.keys(spells).length)} of ${String(spellTitles.length)} asked`
  )
  console.log(`  eraRevision: ${String(eraRevision)}   live requests sent this run: ${String(requestsSent)}`)
}

void main()
