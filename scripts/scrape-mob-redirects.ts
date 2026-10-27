// Collect every main-namespace redirect on eqlwiki and keep those that land on a mob, item or spell
// page as that record's `otherNames` (mobs.json, items.json, spells.json), and those that land on an
// item page as drop aliases too (dropGroups.json) (sources/mobRedirects.ts; owner, 2026-10-22: "no
// one told you to restrict it to mobs only"). One request per 500 redirects, at the shared 1 request
// per second. scrape:items, scrape:spells and scrape-drop-groups apply the cached list themselves;
// after a full `scrape:mobs`, run this with --offline.
// The list is kept in cache/redirects/redirects.json like every other wiki text (owner, 2026-10-19:
// "everything we get from the wiki should be cached"), so mobs.json re-derives from it offline.
//
//   npx tsx scripts/scrape-mob-redirects.ts            fetch the list (about 19 requests), cache it, apply
//   npx tsx scripts/scrape-mob-redirects.ts --offline  apply the cached list, zero requests

import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { isMain } from './sources/isMain'
import { itemKey } from '../src/main/itemsDb'
import { applyItemOtherNames, applyOtherNames, applySpellOtherNames, readRedirectCache, withItemRedirectAliases, writeRedirectCache, type NamedItem, type NamedMob, type NamedSpell, type Redirect } from './sources/mobRedirects'
import { wikiGet } from './sources/wikiApi'

const MOBS_PATH = resolve(fileURLToPath(import.meta.url), '../../src/renderer/src/data/eqlegends/mobs.json')
const ITEMS_PATH = resolve(fileURLToPath(import.meta.url), '../../src/main/data/items.json')
const SPELLS_PATH = resolve(fileURLToPath(import.meta.url), '../../src/main/data/spells.json')
const DROPS_PATH = resolve(fileURLToPath(import.meta.url), '../../src/renderer/src/data/eqlegends/dropGroups.json')
const CACHE = resolve(fileURLToPath(import.meta.url), '../sources/cache/redirects/redirects.json')

type Get = typeof wikiGet

/** Every row of one `list=` query, 500 a request, following its continue key. */
async function listAll<T>(get: Get, list: string, prefix: string, params: Record<string, string>): Promise<T[]> {
  const out: T[] = []
  let cont: string | undefined
  for (let page = 0; page < 200; page++) {
    const q: Record<string, string> = { action: 'query', list, [`${prefix}limit`]: '500', ...params }
    if (cont) q[`${prefix}continue`] = cont
    const j = await get<{ query?: Record<string, T[]>; continue?: Record<string, string> }>(q)
    out.push(...(j.query?.[list] ?? []))
    cont = j.continue?.[`${prefix}continue`]
    console.log(`  ${list} request ${String(page + 1)}: ${String(out.length)}`)
    if (!cont) break
  }
  return out
}

/**
 * Every ns0 redirect and its target: the redirect pages by id and title (`list=allpages`), joined
 * to each redirect's target by that id (`list=allredirects`). The API resolves no redirect while
 * it lists redirect pages, so it takes the two lists.
 */
export async function allRedirects(get: Get = wikiGet): Promise<Redirect[]> {
  const pages = await listAll<{ pageid: number; title: string }>(get, 'allpages', 'ap', { apnamespace: '0', apfilterredir: 'redirects' })
  const targets = await listAll<{ fromid: number; title: string }>(get, 'allredirects', 'ar', { arnamespace: '0', arprop: 'ids|title' })
  const titleOf = new Map(pages.map((p) => [p.pageid, p.title]))
  return targets.flatMap((t) => {
    const from = titleOf.get(t.fromid)
    return from === undefined ? [] : [{ from, to: t.title }]
  })
}

async function main(): Promise<void> {
  const data = JSON.parse(readFileSync(MOBS_PATH, 'utf8')) as { mobs: NamedMob[] }
  const offline = process.argv.slice(2).includes('--offline')
  const cached = offline ? readRedirectCache(CACHE) : null
  if (offline && cached === null) throw new Error(`no cached redirect list at ${CACHE}: run once without --offline (about 19 requests)`)
  const redirects = cached?.redirects ?? (await allRedirects())
  if (cached === null) writeRedirectCache(CACHE, redirects)
  applyOtherNames(data.mobs, redirects)
  const named = data.mobs.filter((m) => m.otherNames).length
  const names = data.mobs.reduce((n, m) => n + (m.otherNames?.length ?? 0), 0)
  writeFileSync(MOBS_PATH, JSON.stringify(data, null, 2))
  console.log(`${String(redirects.length)} redirects; ${String(names)} land on ${String(named)} mob pages`)
  applyToItemsAndSpells(redirects)
}

/** The same list onto items.json, spells.json and dropGroups.json's aliases, each written as its scraper writes it. */
export function applyToItemsAndSpells(redirects: readonly Redirect[]): void {
  const items = JSON.parse(readFileSync(ITEMS_PATH, 'utf8')) as { items: Record<string, NamedItem> }
  applyItemOtherNames(items.items, redirects, itemKey)
  // Compact, as scrape-items writes it: the file is inlined into the main bundle.
  writeFileSync(ITEMS_PATH, JSON.stringify(items), 'utf8')
  const pages = new Set(Object.values(items.items).filter((e) => e.otherNames).map((e) => e.page))
  const spells = JSON.parse(readFileSync(SPELLS_PATH, 'utf8')) as { spells: NamedSpell[] }
  applySpellOtherNames(spells.spells, redirects)
  writeFileSync(SPELLS_PATH, JSON.stringify(spells, null, 2))
  const drops = JSON.parse(readFileSync(DROPS_PATH, 'utf8')) as { aliases?: Record<string, string> }
  const before = Object.keys(drops.aliases ?? {}).length
  drops.aliases = withItemRedirectAliases(drops.aliases ?? {}, items.items, redirects, itemKey)
  writeFileSync(DROPS_PATH, JSON.stringify(drops, null, 1) + '\n')
  const spellNamed = spells.spells.filter((s) => s.otherNames).length
  console.log(`items: other names on ${String(pages.size)} pages; spells: on ${String(spellNamed)}; drop aliases ${String(before)} -> ${String(Object.keys(drops.aliases).length)}`)
}

if (isMain(import.meta.url)) void main()
