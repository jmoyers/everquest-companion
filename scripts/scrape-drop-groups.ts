// scrape-drop-groups.ts — the pages mob drop lists link that are not items (owner ask, 2026-10-18):
// `[[Rusty Weapons]]`, `[[Cloth Armor]]` and the like. Mob pages link a group page instead of
// listing its items, and no scraper enumerates those pages, so they are fetched here (50 a
// request, redirects followed), kept in cache/drop-groups/pages.json, and each group's member items
// written to dropGroups.json for the Gaps tab's missing-drop check.
//
//   npx tsx scripts/scrape-drop-groups.ts            fetch, then derive
//   npx tsx scripts/scrape-drop-groups.ts --offline  derive from the cache, zero requests

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { itemKey } from '../src/main/itemsDb'
import { isMain } from './sources/isMain'
import { cachedRedirects, withItemRedirectAliases, type NamedItem } from './sources/mobRedirects'
import { wikiGet } from './sources/wikiApi'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ITEMS = resolve(ROOT, 'src/main/data/items.json')
const MOBS = resolve(ROOT, 'src/renderer/src/data/eqlegends/mobs.json')
const OUT = resolve(ROOT, 'src/renderer/src/data/eqlegends/dropGroups.json')
const CACHE = resolve(ROOT, 'scripts/sources/cache/drop-groups/pages.json')

/** A spell scroll on a drop list is matched by its own name; it is never a group. */
const SCROLL = /^(Spell|Song|Tome|Rune|Scroll): /i

export interface CachedPage {
  title: string
  content: string
}

/** The drop names no item is keyed by, less scrolls: the pages that may be groups, A to Z. */
export function groupTitles(mobs: readonly { drops?: string[] }[], itemKeys: ReadonlySet<string>): string[] {
  const names = new Set<string>()
  for (const m of mobs) for (const d of m.drops ?? []) if (!itemKeys.has(d.toLowerCase()) && !SCROLL.test(d)) names.add(d)
  return [...names].sort((a, b) => a.localeCompare(b))
}

/**
 * The items a group page lists, in the shapes the wiki uses: a set's `{{Gear Set|Cloth Shirt|…}}`,
 * else its list items and table cells, `*[[Rusty Axe]]`, `<li> {{:Amber}}`, `|{{:Bronze Axe}}`. None for a page that is
 * itself an item, mob or spell page (a drop list sometimes names a spell bare, and its page links
 * components and items with the effect, not members).
 */
export function groupMembers(wikitext: string, itemKeys: ReadonlySet<string>): string[] {
  if (/\{\{\s*(Itempage|Namedmobpage|MerchantPage|Spellpage)/i.test(wikitext)) return []
  const set = /\{\{\s*Gear Set\s*\|([^}]*)\}\}/i.exec(wikitext)
  const listed = [...wikitext.matchAll(/(?:^\*+|^\|(?!-)|<li>)\s*(?:\[\[([^\]|#]+)[^\]]*\]\]|\{\{:([^}|]+))/gm)].map((m) => m[1] ?? m[2])
  const members = new Map<string, string>()
  for (const raw of set ? set[1].split('|') : listed) {
    const target = raw.trim().replace(/_/g, ' ')
    if (itemKeys.has(target.toLowerCase())) members.set(target.toLowerCase(), target)
  }
  return [...members.values()].sort((a, b) => a.localeCompare(b))
}

/**
 * A drop-list link that is a redirect to an item page (`[[A Wooden Heart]]` -> Wooden Heart): the
 * item its `|itemname` names, when items.json keys it; null for any other page. The mob page lists
 * that item under another title, so the Gaps tab must not call it missing (review 2026-10-19).
 */
export function aliasedItem(wikitext: string, itemKeys: ReadonlySet<string>): string | null {
  if (!/\{\{\s*Itempage/i.test(wikitext)) return null
  const name = /\|\s*itemname\s*=\s*([^\n|}]+)/i.exec(wikitext)?.[1].trim() ?? ''
  return name !== '' && itemKeys.has(name.toLowerCase()) ? name : null
}

interface RevPage {
  title: string
  revisions?: { slots?: { main?: { content?: string } } }[]
}

interface Hop {
  from: string
  to: string
}
interface Batch {
  query?: { pages?: RevPage[]; redirects?: Hop[]; normalized?: Hop[] }
}

/** One batch's pages under the titles asked: a normalized or redirected title read through. */
function readThrough(asked: readonly string[], j: Batch): CachedPage[] {
  const to = new Map([...(j.query?.normalized ?? []), ...(j.query?.redirects ?? [])].map((r) => [r.from, r.to]))
  const text = new Map((j.query?.pages ?? []).map((p) => [p.title, p.revisions?.[0]?.slots?.main?.content ?? '']))
  return asked.map((title) => {
    let at = title
    for (let hop = 0; hop < 3 && to.has(at); hop++) at = to.get(at) ?? at
    return { title, content: text.get(at) ?? '' }
  })
}

/** Each title's wikitext, a redirect read through to its target and kept under the asked title. */
async function fetchPages(titles: readonly string[]): Promise<CachedPage[]> {
  const out: CachedPage[] = []
  for (let i = 0; i < titles.length; i += 50) {
    const slice = titles.slice(i, i + 50)
    const params = { action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', redirects: '1', titles: slice.join('|') }
    out.push(...readThrough(slice, await wikiGet<Batch>(params)))
    console.log(`  ${String(Math.min(i + 50, titles.length))}/${String(titles.length)} pages`)
  }
  return out
}

async function main(): Promise<void> {
  const items = (JSON.parse(readFileSync(ITEMS, 'utf8')) as { items: Record<string, NamedItem> }).items
  const itemKeys = new Set(Object.keys(items))
  const titles = groupTitles((JSON.parse(readFileSync(MOBS, 'utf8')) as { mobs: { drops?: string[] }[] }).mobs, itemKeys)
  // Cached like every other wiki text (owner, 2026-10-18): only a page the cache lacks, or one the
  // delta saw change (`--fresh <titles.json>`), is fetched; offline fetches nothing.
  const cached = new Map((existsSync(CACHE) ? (JSON.parse(readFileSync(CACHE, 'utf8')) as CachedPage[]) : []).map((p) => [p.title, p]))
  const freshAt = process.argv.indexOf('--fresh')
  const fresh = new Set(freshAt < 0 ? [] : (JSON.parse(readFileSync(process.argv[freshAt + 1], 'utf8')) as string[]))
  const ask = process.argv.includes('--offline') ? [] : titles.filter((t) => !cached.has(t) || fresh.has(t))
  console.log(`${String(titles.length)} drop names that are not items; ${String(ask.length)} to fetch`)
  for (const p of ask.length > 0 ? await fetchPages(ask) : []) cached.set(p.title, p)
  const pages = titles.flatMap((t) => cached.get(t) ?? [])
  if (ask.length > 0) {
    mkdirSync(dirname(CACHE), { recursive: true })
    writeFileSync(CACHE, JSON.stringify(pages, null, 1) + '\n')
  }
  const groups: Record<string, string[]> = {}
  const aliases: Record<string, string> = {}
  for (const p of pages) {
    const members = groupMembers(p.content, itemKeys)
    if (members.length > 0) groups[p.title] = members
    const item = aliasedItem(p.content, itemKeys)
    if (item !== null && item.toLowerCase() !== p.title.toLowerCase()) aliases[p.title] = item
  }
  // Every redirect that lands on an item page is an alias too: a looted name the wiki sends to the page
  // a mob page lists (owner, 2026-10-22: Halfling Blood, listed as Vial of Halfling Blood).
  const out = { source: 'eqlwiki.com — the drop-list pages that are not items', groups, aliases: withItemRedirectAliases(aliases, items, cachedRedirects(), itemKey) }
  writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n')
  const missing = pages.filter((p) => p.content === '').length
  console.log(`${String(pages.length)} pages: ${String(Object.keys(groups).length)} groups, ${String(Object.keys(aliases).length)} redirects to items, ${String(missing)} with no page`)
}

if (isMain(import.meta.url)) void main()
