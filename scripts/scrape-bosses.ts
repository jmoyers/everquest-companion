/**
 * Curated EQ Legends raid-target roster → src/renderer/src/data/eqlegends/bosses.json.
 * Each target's image is pulled from its wiki page via the MediaWiki pageimages API
 * (hotlinked at runtime; the renderer CSP allows https images).
 *
 *   npm run scrape:bosses
 *
 * `match` holds the exact in-log "slain" names used to detect kills.
 *
 * Every request goes through sources/wikiApi.ts: a second apart across both wikis, maxlag=5,
 * retried on 429/5xx with Retry-After honoured.
 *
 * A PORTRAIT IS KEPT (owner, 2026-10-18: if an image exists, use it; some were picked by hand): a
 * target the committed bosses.json already has an image for keeps it, and only a target with none
 * is looked up. Pages are read through sources/renderCache.ts, by revision, like every other text.
 *
 *   npm run scrape:bosses -- --offline   from the render cache, zero requests
 *   npm run scrape:bosses -- --refresh   render every page again
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import type { BossData, RaidTarget } from '../src/shared/types'
import { renderedPages, type RenderOptions } from './sources/renderCache'
import type { ApiGet } from './sources/revCache'
import { wikiGet } from './sources/wikiApi'

const RENDER = { offline: process.argv.includes('--offline'), refresh: process.argv.includes('--refresh') }

const EQL = 'https://eqlwiki.com'
const P99 = 'https://wiki.project1999.com'
/** The identity this scraper has always sent both wikis; the P99 wiki is not ours to re-test. */
const UA = 'Mozilla/5.0 everquest-companion/0.2 (personal raid tracker)'

interface Curated {
  name: string
  category: string
  /** eqlwiki page title override */
  page?: string
  /** Project 1999 wiki page title override (better classic NPC portraits) */
  p99?: string
  /** manual image URL override (highest priority) */
  image?: string
  match: string[]
  zone?: string
}

// Classic-only (no Kunark/Velious). Ordered as the EQL progression:
// Nagafen -> Vox -> Yael -> Plane of Fear -> Plane of Hate -> Plane of Sky.
const TARGETS: Curated[] = [
  // Open-world raid targets (early progression). Naggy/Vox are dragons, Yael a
  // lich — grouped as the pre-plane open-world bosses.
  { name: 'Lord Nagafen', category: 'Open World', match: ['Lord Nagafen'], zone: "Nagafen's Lair" },
  { name: 'Lady Vox', category: 'Open World', match: ['Lady Vox'], zone: 'Permafrost Keep' },
  { name: 'Master Yael', category: 'Open World', match: ['Master Yael'], zone: 'The Hole' },
  // Kedge Keep's dragon-fish (level 53), reported missing from the roster by a 0.12.0 user
  // (JOS-101). Log-form name verified TWICE against sources already in the repo/on disk:
  // mobs.json carries `{ page: 'Phinigel Autropos', name: 'Phinigel Autropos', level: '53',
  // zones: ['Kedge Keep'] }` (scraped from eqlwiki), and the owner's own log prints
  // `Your faction standing with Phinigel Autropos has been adjusted by ...` 17 times — the
  // faction is named for him, so the spelling is the game's, not the wiki's.
  { name: 'Phinigel Autropos', category: 'Open World', match: ['Phinigel Autropos'], zone: 'Kedge Keep' },

  // Plane of Fear
  { name: 'Cazic Thule', category: 'Plane of Fear', p99: 'Cazic Thule (God)', match: ['Cazic Thule', 'Cazic-Thule'], zone: 'Plane of Fear' },
  { name: 'Dread', category: 'Plane of Fear', match: ['Dread'], zone: 'Plane of Fear' },
  { name: 'Terror', category: 'Plane of Fear', match: ['Terror'], zone: 'Plane of Fear' },
  { name: 'Fright', category: 'Plane of Fear', match: ['Fright'], zone: 'Plane of Fear' },
  { name: 'A dracoliche', category: 'Plane of Fear', page: 'A dracoliche', match: ['a dracoliche', 'A dracoliche'], zone: 'Plane of Fear' },

  // Plane of Hate (Innoruuk + minis)
  { name: 'Innoruuk', category: 'Plane of Hate', page: 'Innoruuk', match: ['Innoruuk, the Prince of Hate', 'Innoruuk'], zone: 'Plane of Hate' },
  { name: 'Maestro of Rancor', category: 'Plane of Hate', match: ['Maestro of Rancor'], zone: 'Plane of Hate' },
  { name: 'Lord of Loathing', category: 'Plane of Hate', match: ['Lord of Loathing'], zone: 'Plane of Hate' },
  { name: 'Lord of Ire', category: 'Plane of Hate', match: ['Lord of Ire'], zone: 'Plane of Hate' },
  { name: 'Master of Spite', category: 'Plane of Hate', match: ['Master of Spite'], zone: 'Plane of Hate' },
  { name: 'Mistress of Scorn', category: 'Plane of Hate', match: ['Mistress of Scorn'], zone: 'Plane of Hate' },
  { name: 'High Priest M`kari', category: 'Plane of Hate', match: ['High Priest M`kari'], zone: 'Plane of Hate' },
  // eqlwiki titles the page with a capital T (Magi P`Tasa) and a title is case-sensitive after its
  // first letter, so the lowercase name found no page, and no portrait, on either wiki.
  { name: 'Magi P`tasa', category: 'Plane of Hate', page: 'Magi P`Tasa', p99: 'Magi P`Tasa', match: ['Magi P`tasa'], zone: 'Plane of Hate' },
  { name: 'Coercer T`vala', category: 'Plane of Hate', match: ['Coercer T`vala'], zone: 'Plane of Hate' },
  { name: 'Grandmaster R`Tal', category: 'Plane of Hate', match: ['Grandmaster R`Tal'], zone: 'Plane of Hate' },
  { name: 'Ashenbone Broodmaster', category: 'Plane of Hate', match: ['Ashenbone Broodmaster'], zone: 'Plane of Hate' },
  { name: 'Avatar of Abhorrence', category: 'Plane of Hate', match: ['Avatar of Abhorrence'], zone: 'Plane of Hate' },

  // Plane of Sky (island bosses, in island order)
  { name: 'Thunder Spirit Princess', category: 'Plane of Sky', match: ['Thunder Spirit Princess'], zone: 'Plane of Sky — Island 1' },
  { name: 'Noble Dojorn', category: 'Plane of Sky', match: ['Noble Dojorn'], zone: 'Plane of Sky — Island 1.5' },
  { name: 'Protector of Sky', category: 'Plane of Sky', match: ['Protector of Sky'], zone: 'Plane of Sky — Island 2' },
  { name: 'Gorgalosk', category: 'Plane of Sky', match: ['Gorgalosk'], zone: 'Plane of Sky — Island 3' },
  { name: 'Keeper of Souls', category: 'Plane of Sky', match: ['Keeper of Souls'], zone: 'Plane of Sky — Island 4' },
  { name: 'The Spiroc Lord', category: 'Plane of Sky', page: 'Spiroc Lord', match: ['The Spiroc Lord'], zone: 'Plane of Sky — Island 5' },
  { name: 'Bazzt Zzzt', category: 'Plane of Sky', match: ['Bazzt Zzzt'], zone: 'Plane of Sky — Island 6' },
  { name: 'Sister of the Spire', category: 'Plane of Sky', match: ['Sister of the Spire'], zone: 'Plane of Sky — Island 7' },
  { name: 'Eye of Veeshan', category: 'Plane of Sky', match: ['Eye of Veeshan'], zone: 'Plane of Sky — Island 8' },

  // Plane of Sky — the Efreeti Cycle (a spawn chain that FOLLOWS Eye in the
  // wiki's boss listing). Noble Dojorn (Island 1.5, above) is the "first kill in
  // the Efreeti Cycle"; killing him spawns the Overseer of Air (the wiki's
  // "second boss in the Efreeti Cycle", up on Island 4), whose death spawns the
  // Hand of Veeshan back on Island 8 (the final Efreeti-Cycle kill, sharing the
  // island with the Eye). These were missing from the roster — the log shows
  // both killed ('Overseer of Air has been slain by …', 'The Hand of Veeshan has
  // been slain by …'). The Hand's log name carries a leading 'the'/'The'
  // (lowercase mid-sentence, capitalized on the slain-by line) — bossStatus's
  // matchKey strips a single leading article, so 'hand of veeshan' matches both.
  { name: 'Overseer of Air', category: 'Plane of Sky', match: ['Overseer of Air'], zone: 'Plane of Sky — Efreeti Cycle (Island 4)' },
  { name: 'The Hand of Veeshan', category: 'Plane of Sky', page: 'The Hand of Veeshan', match: ['The Hand of Veeshan', 'the Hand of Veeshan'], zone: 'Plane of Sky — Efreeti Cycle (Island 8)' }
]

/** One wiki's API, as the render cache's revision check asks it. */
const apiOf = (apiBase: string): ApiGet => ((params: Record<string, string>) => wikiGet(params, `${apiBase}/api.php`, UA))

/** A page's parsed HTML, or null on any failure (the next image source is tried instead). */
async function renderPage(apiBase: string, page: string): Promise<string | null> {
  try {
    const params = { action: 'parse', page, prop: 'text', redirects: '1' }
    const json = await wikiGet<{ parse?: { text?: string | { '*'?: string } } }>(params, `${apiBase}/api.php`, UA)
    const t = json.parse?.text
    return (typeof t === 'string' ? t : t?.['*']) ?? null
  } catch {
    return null
  }
}

/** A page's parsed HTML through the render cache (`cache/rendered/<site>`), or undefined. */
async function pageHtml(apiBase: string, page: string): Promise<string | undefined> {
  const site = apiBase === P99 ? 'p99' : 'eqlwiki'
  const opts: RenderOptions = { ...RENDER, dir: `scripts/sources/cache/rendered/${site}` }
  return (await renderedPages([page], (t) => renderPage(apiBase, t), apiOf(apiBase), opts)).get(page)
}

function imgSrcs(html: string): string[] {
  return [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]).filter((s) => s.includes('/images/'))
}

/** Project 1999 wiki: prefer the "Npc_*" portrait convention. */
async function p99Image(page: string): Promise<string | undefined> {
  const html = await pageHtml(P99, page)
  if (!html) return undefined
  const srcs = imgSrcs(html)
  const pick = srcs.find((s) => /Npc_/i.test(s)) ?? srcs.find((s) => !/Item_|WarningIcon|\.svg/i.test(s))
  if (!pick) return undefined
  return pick.startsWith('http') ? pick : P99 + pick
}

/** EQ Legends wiki fallback: the "Npc_*" portrait when the page has one, as on P99 (Phinigel
 *  Autropos's page shows a Kedge Keep map first), else the first non-loot-icon image. */
async function eqlImage(page: string): Promise<string | undefined> {
  const html = await pageHtml(EQL, page)
  if (!html) return undefined
  const srcs = imgSrcs(html)
  const pick = srcs.find((s) => /Npc_/i.test(s)) ?? srcs.find((s) => !/Item_\d+/i.test(s))
  if (!pick) return undefined
  return pick.startsWith('http') ? pick : EQL + pick
}

/** Multi-source image resolution: manual override → P99 portrait → eqlwiki. */
async function fetchImage(t: Curated): Promise<string | undefined> {
  if (t.image) return t.image
  const p99 = await p99Image(t.p99 ?? t.name)
  if (p99) return p99
  return eqlImage(t.page ?? t.name)
}

/** The images the committed bosses.json already has, by target name. */
function keptImages(path: string): Map<string, string> {
  if (!existsSync(path)) return new Map()
  const data = JSON.parse(readFileSync(path, 'utf8')) as BossData
  return new Map(data.targets.flatMap((t) => (t.image ? [[t.name, t.image] as const] : [])))
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url))
  const outPath = resolve(here, '../src/renderer/src/data/eqlegends/bosses.json')
  const kept = keptImages(outPath)
  const targets: RaidTarget[] = []
  let withImg = 0
  for (const t of TARGETS) {
    const image = t.image ?? kept.get(t.name) ?? (await fetchImage(t))
    if (image) withImg++
    targets.push({ name: t.name, category: t.category, match: t.match, zone: t.zone, image })
    console.log(`  ${image ? '🖼 ' : '·  '}${t.name}`)
  }
  const data: BossData = { scrapedAt: new Date().toISOString(), targets }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(data, null, 2))
  console.log(`\nWrote ${targets.length} targets (${withImg} with images) → ${outPath}`)
}

void main()
