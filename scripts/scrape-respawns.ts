/**
 * Wiki RESPAWN-FLOOR scraper (JOS-194) — the `|respawn_time` field off every page already in the
 * committed mob catalog.
 *
 *   npm run scrape:respawns              # 158 batched requests against the wiki
 *   npm run scrape:respawns -- --reparse # NO NETWORK: re-read the committed verbatim text
 *
 * WHY IT IS A SEPARATE PASS AND NOT A FIELD IN scrape-mobs.ts. `mobs.json` is inlined into BOTH
 * bundles (main reads it for `/con`, the renderer for mob search, map pins, item sourcing and the
 * Sky droppers), and 7,872 rows of a field that only 522 pages state would grow every one of
 * those consumers to carry a column six percent of them use. This output is 522 rows, imported by
 * the main process alone. Re-running `scrape:mobs` does not disturb it and vice versa.
 *
 * WHAT IT IS WORTH. Very little on its own, and `src/shared/respawnWiki.ts` carries the full
 * measurement in its header — 6.6% coverage, a hundred spellings, 111 pages whose answer is
 * "Triggered" or "?". The owner's direction on this ticket was that the wiki is a bad PRIMARY
 * source; this file exists so it can be a floor and a first-run default under timers that are
 * really driven by your own kills.
 *
 * BOTH HALVES ARE COMMITTED: the verbatim `text` and the parsed `seconds`. The text is what the
 * UI shows when the parse refused, and keeping it means a grammar fix in respawnWiki.ts applies
 * to the committed data without another 158 requests at the wiki's expense.
 *
 * Scraper etiquette (AGENTS.md LAW): one serialized request at a time, 110 ms between them,
 * exponential backoff honouring Retry-After on 429/5xx, and revisions batched at 50 titles —
 * BATCH=50 is MEASURED, not tunable (>50 pageids returns HTTP 200 with zero pages and no
 * warning). Output is sorted by key, so a re-scrape produces a clean diff.
 */
import { readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { parseWikiRespawn, type WikiRespawn, type WikiRespawnData } from '../src/shared/respawnWiki'
import type { MobData } from '../src/shared/types'

const API = 'https://eqlwiki.com/api.php'
const UA = 'everquest-companion/0.1 (personal quest tracker)'
const DELAY_MS = 110
const MAX_RETRIES = 5
const BATCH = 50

const HERE = dirname(fileURLToPath(import.meta.url))
const MOBS_PATH = resolve(HERE, '../src/renderer/src/data/eqlegends/mobs.json')
const OUT_PATH = resolve(HERE, '../src/main/data/respawns.json')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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
      const retryAfter = Number(res.headers.get('retry-after'))
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : wait)
      wait *= 2
      continue
    }
    throw new Error(`${res.status} ${res.statusText}`)
  }
}

/**
 * The field, verbatim, off one page's wikitext. Stops at a newline or the next `|`, which is the
 * `{{Namedmobpage}}` grammar's own field terminator (the same reading `mobLookupParse.ts` does).
 */
const FIELD_RE = /\|\s*respawn_time\s*=\s*([^\n|]*)/i

interface RevPage {
  title: string
  revisions?: { slots?: { main?: { content?: string } } }[]
}

/**
 * Re-run the grammar over the committed verbatim text, with no network at all. This is the whole
 * reason `text` is committed beside `seconds`: tightening `parseWikiRespawn` is a code change, and
 * a code change should not cost the wiki 158 requests to land. `text` is never touched here — only
 * `seconds` appears, disappears or moves — so a reparse diff is exactly the grammar's effect.
 */
function reparse(): void {
  const data = JSON.parse(readFileSync(OUT_PATH, 'utf8')) as WikiRespawnData
  let gained = 0
  let lost = 0
  for (const row of data.rows) {
    const before = row.seconds
    const after = parseWikiRespawn(row.text)
    if (after === null) delete row.seconds
    else row.seconds = after
    if (before === undefined && after !== null) gained++
    if (before !== undefined && after === null) lost++
  }
  writeFileSync(OUT_PATH, JSON.stringify(data, null, 1) + '\n')
  const parsed = data.rows.filter((r) => r.seconds !== undefined).length
  console.log(
    `reparse: ${String(data.rows.length)} rows → ${String(parsed)} parse ` +
      `(+${String(gained)} newly read, -${String(lost)} newly refused)`
  )
}

/** One batch's worth of rows: the pages that state a respawn, keyed by their in-game name. */
function rowsFromBatch(pages: RevPage[], byTitle: Map<string, string>): WikiRespawn[] {
  const out: WikiRespawn[] = []
  for (const p of pages) {
    const wikitext = p.revisions?.[0]?.slots?.main?.content ?? ''
    const m = FIELD_RE.exec(wikitext)
    const text = m ? m[1].trim() : ''
    if (text.length === 0) continue
    const name = byTitle.get(p.title) ?? p.title
    const row: WikiRespawn = { key: name.toLowerCase(), page: p.title, text }
    const seconds = parseWikiRespawn(text)
    if (seconds !== null) row.seconds = seconds
    out.push(row)
  }
  return out
}

/**
 * Two pages can state the same in-game name (era duplicates). Keep the first PARSED one, so a
 * duplicate whose field says "Triggered" never displaces a sibling that states a number.
 */
function dedupe(rows: readonly WikiRespawn[]): WikiRespawn[] {
  const byKey = new Map<string, WikiRespawn>()
  for (const row of rows) {
    const prior = byKey.get(row.key)
    if (!prior || (prior.seconds === undefined && row.seconds !== undefined)) byKey.set(row.key, row)
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key))
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes('--reparse')) {
    reparse()
    return
  }
  const catalog = JSON.parse(readFileSync(MOBS_PATH, 'utf8')) as MobData
  // The catalog's `name` is the in-game name (the article EQ actually prints); the page title is
  // the wiki's. We fetch BY TITLE and key BY NAME, because a death line prints the name.
  const byTitle = new Map(catalog.mobs.map((m) => [m.page, m.name]))
  const titles = [...byTitle.keys()]
  const rows: WikiRespawn[] = []

  for (let i = 0; i < titles.length; i += BATCH) {
    const j = await api<{ query?: { pages?: RevPage[] } }>({
      action: 'query',
      prop: 'revisions',
      rvprop: 'content',
      rvslots: 'main',
      titles: titles.slice(i, i + BATCH).join('|')
    })
    rows.push(...rowsFromBatch(j.query?.pages ?? [], byTitle))
    if (i % 1000 < BATCH) console.log(`  … ${String(i)}/${String(titles.length)} pages`)
  }

  const out = dedupe(rows)
  const data: WikiRespawnData = {
    source: 'eqlwiki.com — |respawn_time on every page in the committed mob catalog',
    scrapedAt: new Date().toISOString().slice(0, 10),
    rows: out
  }
  writeFileSync(OUT_PATH, JSON.stringify(data, null, 1) + '\n')
  const parsed = out.filter((r) => r.seconds !== undefined).length
  console.log(
    `respawns: ${String(titles.length)} pages → ${String(out.length)} state a respawn, ` +
      `${String(parsed)} parse to a duration, ${String(out.length - parsed)} do not`
  )
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
