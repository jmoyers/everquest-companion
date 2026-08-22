// fetch-wiki-images.mts — download EVERY wiki image the app can ask for into
// `resources/wiki-images/`, so the shipped app never has to ask a volunteer wiki for a
// picture at all. Run:
//
//   export PATH="/c/Program Files/nodejs:$PATH"   # this machine
//   npm run fetch:images
//
// WHY THIS EXISTS (JOS-198). `src/main/imageCache.ts` was a runtime scraper with a permanent
// disk cache: the FIRST time an install needed an icon or a boss portrait it fetched it from
// eqlwiki.com / wiki.project1999.com. That put two volunteer-run wikis in the startup path of
// every fresh install, and it made image fetching the single noisiest error source in the
// fleet. Both facts have the same fix: ship the bytes. The runtime cache stays as a fallback
// for anything the bundle misses, but on a normal install it never runs.
//
// THE SET IS THE WHOLE SET, and that was measured rather than assumed (numbers in the
// JOS-198 comment). Two families, which are exactly the two routes the `eqimg://` handler
// serves:
//
//   items   — `src/main/data/items.json`, every DISTINCT `iconId` (751 of them across 11,341
//             items). Upstream is `wikiItemIconUrl(id)` on eqlwiki. These are 40×40 game
//             icons: ~1.7 kB each.
//   bosses  — `src/renderer/src/data/eqlegends/bosses.json`, the 29 absolute portrait URLs on
//             wiki.project1999.com. These are real photographs of a mob model, ~92 kB each,
//             and they are the ones a user actually looks at.
//
// NAMES ARE THE CACHE'S OWN NAMES. Every file is written under `cacheFileName()` — the same
// function `<userData>/image-cache/` uses — so the bundled directory and the runtime cache
// are the same namespace and `src/main/bundledImages.ts` can probe one with the other's
// helpers. A second naming scheme here would be a second thing to keep in sync, forever.
//
// THE MANIFEST IS THE PROVENANCE RECORD. `manifest.json` states, per file, the exact upstream
// URL it came from, its byte length and its sha256. That is what makes the bundled bytes
// auditable ("where did this picture come from") and re-derivable (delete a file, re-run,
// get the same bytes), and it is the thing the credit in Preferences → Thanks and in the
// README is ABOUT. `tests/bundledImages.test.mts` reads it back and pins it against the two
// data files, so a scrape that adds a boss cannot silently ship without its portrait.
//
// ETIQUETTE (AGENTS.md LAW): sequential, delayed between requests, retried with exponential
// backoff honouring Retry-After, and cache-skipping — a file already on disk is never
// re-fetched, so a partial run resumes and a complete run is a no-op that only rewrites the
// manifest. `--seed <dir>` goes further: it imports bytes from an existing
// `<userData>/image-cache` (which shares this naming scheme), because the politest request is
// the one that is never sent for bytes this machine already downloaded once.
//
// Flags:
//   --seed <dir>   copy anything already present in that eqimg cache dir before fetching
//   --dry-run      report what WOULD be fetched (and the size of what is present), fetch nothing
//   --limit <n>    stop after n network fetches (for a smoke run)

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// The cache's OWN pure helpers — names, hashes, the allowlist, the sniff. Reused rather than
// re-derived so the bundled directory can never drift from the runtime cache it backstops.
import {
  cacheCandidateNames,
  cacheFileName,
  normalizeUpstreamImageUrl,
  sniffImageMime,
  urlCacheHash,
  wikiItemIconUrl,
  type EqImgRequest
} from '../src/main/imageCache'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outDir = join(root, 'resources', 'wiki-images')
const manifestPath = join(outDir, 'manifest.json')

/** Same polite identity every fetcher in this repo sends (AGENTS.md scraper etiquette). */
const UA = 'everquest-companion/0.1 (personal quest tracker)'
const REQUEST_DELAY_MS = 1000
const MAX_ATTEMPTS = 4
const RETRY_BASE_MS = 1_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---- the work list ------------------------------------------------------------------

/** One image we intend to ship: the request that names it, and where it came from. */
interface Wanted {
  readonly req: EqImgRequest
  readonly url: string
  /** Which family — reported separately because the two have wildly different byte profiles. */
  readonly kind: 'item' | 'boss'
}

/** Every DISTINCT item icon id in the committed item DB, ascending. */
function itemIconIds(): number[] {
  const db = JSON.parse(readFileSync(join(root, 'src', 'main', 'data', 'items.json'), 'utf8')) as {
    items: Record<string, { iconId?: number }>
  }
  const ids = new Set<number>()
  for (const item of Object.values(db.items)) {
    if (typeof item.iconId === 'number') ids.add(item.iconId)
  }
  return [...ids].sort((a, b) => a - b)
}

/** Every boss portrait URL in the committed raid-target list, in file order. */
function bossImageUrls(): string[] {
  const db = JSON.parse(
    readFileSync(join(root, 'src', 'renderer', 'src', 'data', 'eqlegends', 'bosses.json'), 'utf8')
  ) as { targets: { image?: string }[] }
  const urls: string[] = []
  for (const t of db.targets) {
    if (typeof t.image === 'string' && t.image !== '') urls.push(t.image)
  }
  return urls
}

/**
 * The complete work list. A boss URL that the runtime allowlist would REFUSE is dropped here
 * with a warning rather than fetched: shipping bytes the app could never have asked for would
 * put a file in the bundle that nothing can ever serve.
 */
function buildWanted(): Wanted[] {
  const wanted: Wanted[] = []
  for (const id of itemIconIds()) {
    wanted.push({ req: { kind: 'item', id: String(id) }, url: wikiItemIconUrl(String(id)), kind: 'item' })
  }
  for (const raw of bossImageUrls()) {
    const url = normalizeUpstreamImageUrl(raw)
    if (!url) {
      console.warn(`[fetch-wiki-images] SKIP (not on the runtime allowlist): ${raw}`)
      continue
    }
    wanted.push({ req: { kind: 'url', url, hash: urlCacheHash(url) }, url, kind: 'boss' })
  }
  return wanted
}

// ---- disk ---------------------------------------------------------------------------

/** The already-present file for this request, or null. Probes the cache's own candidate names. */
function presentFile(dir: string, req: EqImgRequest): string | null {
  for (const name of cacheCandidateNames(req)) {
    const p = join(dir, name)
    if (existsSync(p) && statSync(p).size > 0) return p
  }
  return null
}

/**
 * Import bytes from an existing eqimg cache. Only files that SNIFF as an image are taken —
 * a torn entry in someone's cache must not become a torn entry in the bundle — and they are
 * re-named through `cacheFileName` so a wrongly-suffixed source entry lands correctly.
 */
function seedFrom(seedDir: string, wanted: Wanted[]): number {
  if (!existsSync(seedDir)) {
    console.warn(`[fetch-wiki-images] --seed ${seedDir} does not exist; nothing seeded`)
    return 0
  }
  const have = new Set(readdirSync(seedDir))
  let taken = 0
  for (const w of wanted) {
    if (presentFile(outDir, w.req)) continue
    for (const name of cacheCandidateNames(w.req)) {
      if (!have.has(name)) continue
      const bytes = readFileSync(join(seedDir, name))
      const mime = sniffImageMime(bytes)
      if (!mime) break
      writeFileSync(join(outDir, cacheFileName(w.req, mime)), bytes)
      taken++
      break
    }
  }
  return taken
}

// ---- network ------------------------------------------------------------------------

/** Wait before the next attempt: the server's Retry-After when it gave one, else backoff. */
function backoffMs(res: Response | null, attempt: number): number {
  const retryAfter = Number(res?.headers.get('retry-after') ?? 0)
  return retryAfter > 0 ? retryAfter * 1000 : RETRY_BASE_MS * 2 ** (attempt - 1)
}

/** GET with exponential backoff; honours Retry-After on 429/5xx. Throws on a hard status. */
async function fetchWithBackoff(url: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'image/png,image/*;q=0.8,*/*;q=0.5' } })
      if (res.ok) return res
      if (res.status < 500 && res.status !== 429) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`)
      if (attempt >= MAX_ATTEMPTS) throw new Error(`GET ${url} -> ${res.status} after ${attempt} attempts`)
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err
    }
    await sleep(backoffMs(res, attempt))
  }
}

/** Fetch one image and write it under its cache name. Returns the bytes, or null if the
 *  upstream answered with something that is not an image (a wiki error page, an empty body). */
async function fetchOne(w: Wanted): Promise<Uint8Array | null> {
  const res = await fetchWithBackoff(w.url)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const mime = sniffImageMime(bytes)
  if (!mime) return null
  writeFileSync(join(outDir, cacheFileName(w.req, mime)), bytes)
  return bytes
}

/**
 * Fetch everything still missing, one at a time, `REQUEST_DELAY_MS` apart. Its own function
 * rather than a block inside `main` so the per-file bookkeeping reads at one level: a failure
 * here is never fatal, because the manifest is rebuilt from what is actually ON DISK afterwards
 * and a partial run is a resumable run.
 */
async function fetchMissing(missing: readonly Wanted[], limit: number): Promise<void> {
  let fetched = 0
  let notImages = 0
  let failed = 0
  for (const w of missing) {
    if (fetched >= limit) break
    const outcome = await fetchOutcome(w)
    if (outcome === 'ok') fetched++
    else if (outcome === 'not-an-image') notImages++
    else failed++
    await sleep(REQUEST_DELAY_MS)
  }
  console.log(`[fetch-wiki-images] fetched ${fetched}, not-an-image ${notImages}, failed ${failed}`)
}

/** One image's result, flattened to a word so the loop above stays a tally rather than a tree. */
async function fetchOutcome(w: Wanted): Promise<'ok' | 'not-an-image' | 'failed'> {
  try {
    if (await fetchOne(w)) return 'ok'
    console.warn(`[fetch-wiki-images] not an image: ${w.url}`)
    return 'not-an-image'
  } catch (err) {
    console.warn(`[fetch-wiki-images] FAILED ${w.url}: ${String(err)}`)
    return 'failed'
  }
}

// ---- manifest -----------------------------------------------------------------------

/** One row of `manifest.json`: what the file is, and exactly where its bytes came from. */
interface ManifestEntry {
  readonly file: string
  readonly url: string
  readonly kind: 'item' | 'boss'
  readonly bytes: number
  readonly sha256: string
}

interface Manifest {
  readonly generatedAt: string
  readonly note: string
  readonly sources: readonly string[]
  readonly totals: { readonly files: number; readonly bytes: number }
  readonly images: readonly ManifestEntry[]
}

function buildManifest(wanted: Wanted[]): Manifest {
  const images: ManifestEntry[] = []
  for (const w of wanted) {
    const path = presentFile(outDir, w.req)
    if (!path) continue
    const bytes = readFileSync(path)
    images.push({
      file: path.slice(outDir.length + 1).replaceAll('\\', '/'),
      url: w.url,
      kind: w.kind,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex')
    })
  }
  images.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  return {
    generatedAt: new Date().toISOString(),
    note:
      'Images shipped with the app so it never fetches art at runtime. Every file states the ' +
      'exact upstream URL it came from. Regenerate with `npm run fetch:images`.',
    sources: ['https://eqlwiki.com/', 'https://wiki.project1999.com/'],
    totals: { files: images.length, bytes: images.reduce((n, i) => n + i.bytes, 0) },
    images
  }
}

/** Human-sized bytes, for the run report. */
function mb(n: number): string {
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

// ---- main ---------------------------------------------------------------------------

function flag(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const seed = flag('--seed')
  const limitRaw = flag('--limit')
  const limit = limitRaw === null ? Infinity : Number(limitRaw)

  mkdirSync(outDir, { recursive: true })
  const wanted = buildWanted()
  const items = wanted.filter((w) => w.kind === 'item').length
  console.log(`[fetch-wiki-images] want ${wanted.length} images (${items} item icons, ${wanted.length - items} boss portraits)`)

  if (seed !== null) {
    const taken = seedFrom(seed, wanted)
    console.log(`[fetch-wiki-images] seeded ${taken} file(s) from ${seed} (already-downloaded bytes; no network)`)
  }

  const missing = wanted.filter((w) => !presentFile(outDir, w.req))
  console.log(`[fetch-wiki-images] ${wanted.length - missing.length} present, ${missing.length} to fetch`)

  if (!dryRun) await fetchMissing(missing, limit)

  const manifest = buildManifest(wanted)
  if (!dryRun) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const itemBytes = manifest.images.filter((i) => i.kind === 'item').reduce((n, i) => n + i.bytes, 0)
  const bossBytes = manifest.totals.bytes - itemBytes
  const itemFiles = manifest.images.filter((i) => i.kind === 'item').length
  console.log('')
  console.log(`[fetch-wiki-images] MEASURED — item icons : ${itemFiles} files, ${mb(itemBytes)}`)
  console.log(`[fetch-wiki-images] MEASURED — portraits  : ${manifest.totals.files - itemFiles} files, ${mb(bossBytes)}`)
  console.log(`[fetch-wiki-images] MEASURED — TOTAL      : ${manifest.totals.files} files, ${mb(manifest.totals.bytes)}`)
  const missingNow = wanted.length - manifest.totals.files
  if (missingNow > 0) console.log(`[fetch-wiki-images] still missing: ${missingNow} (re-run to resume)`)
}

// Deliberately NOT importable: this module runs on load. The test that pins the manifest
// (`tests/bundledImages.test.mts`) reads `manifest.json` and the two data files off disk
// rather than importing anything from here, so nothing can accidentally start a scrape.
void main()
