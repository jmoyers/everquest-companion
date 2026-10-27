// Wiki redirects kept as the `otherNames` of the record whose page they land on: a name the wiki
// sends to a page is the same thing, so Gaps counts it known and lookups find it. Mobs
// (`Hoptor Thaggelum` -> `The Ghoul Lord`, mobs.json), items (`Halfling Blood` -> `Vial of Halfling
// Blood`, items.json), spells (`Enchant: Gold` -> `Enchant Gold`, spells.json), and the drop
// aliases (dropGroups.json) a looted name is read through (owner, 2026-10-22: "no one told you to
// restrict it to mobs only"). Shared by scrape-mob-redirects, the scrapers that write those files,
// and the delta.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

/** One redirect page and the page it sends to (the target's title, any `#section` dropped). */
export interface Redirect {
  from: string
  to: string
}

/** The fields of a mobs.json record this reads and writes. */
export interface NamedMob {
  page: string
  name: string
  otherNames?: string[]
}

/** `#REDIRECT [[Target#Section|label]]` -> `Target`, or null when the text is not a redirect. */
export function redirectTarget(wikitext: string): string | null {
  const m = /^\s*#REDIRECT\s*\[\[([^\]|#]+)/i.exec(wikitext)
  return m ? m[1].trim().replace(/_/g, ' ') : null
}

/**
 * Each mob's `otherNames` from the redirects that land on its page, sorted; a redirect that only
 * re-cases the mob's own name or page title adds nothing (lookups already fold case) and is left out.
 */
export function applyOtherNames(mobs: NamedMob[], redirects: readonly Redirect[]): void {
  const byPage = byTarget(redirects)
  for (const m of mobs) {
    const own = new Set([m.name.toLowerCase(), m.page.toLowerCase()])
    const names = [...(byPage.get(m.page.toLowerCase()) ?? [])].filter((n) => !own.has(n.toLowerCase())).sort()
    if (names.length > 0) m.otherNames = names
    else delete m.otherNames
  }
}

/** The redirects landing on each page, by the page title lowercased (a redirect's target may differ in case). */
function byTarget(redirects: readonly Redirect[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const r of redirects) out.set(r.to.toLowerCase(), (out.get(r.to.toLowerCase()) ?? new Set<string>()).add(r.from))
  return out
}

/** The fields of an items.json record this reads and writes. */
export interface NamedItem {
  page: string
  otherNames?: string[]
}

/**
 * Each item record's `otherNames`: the redirects that land on its page, sorted, less every name that
 * is already a key of the catalog (that name has a record of its own, or is this one's). Every key of
 * a page gets the same list. `key` is the catalog's own fold (`itemKey`).
 */
export function applyItemOtherNames(items: Record<string, NamedItem>, redirects: readonly Redirect[], key: (name: string) => string): void {
  const landing = byTarget(redirects)
  for (const e of Object.values(items)) {
    const names = [...(landing.get(e.page.toLowerCase()) ?? [])].filter((n) => key(n) !== '' && !(key(n) in items)).sort()
    if (names.length > 0) e.otherNames = names
    else delete e.otherNames
  }
}

/** The fields of a spells.json row this reads and writes. */
export interface NamedSpell {
  name: string
  otherNames?: string[]
}

/** Each spell row's `otherNames`: the redirects that land on its page (the page is the spell's name), less any spell's own name. */
export function applySpellOtherNames(spells: NamedSpell[], redirects: readonly Redirect[]): void {
  const landing = byTarget(redirects)
  const own = new Set(spells.map((s) => s.name.toLowerCase()))
  for (const s of spells) {
    const names = [...(landing.get(s.name.toLowerCase()) ?? [])].filter((n) => !own.has(n.toLowerCase())).sort()
    if (names.length > 0) s.otherNames = names
    else delete s.otherNames
  }
}

/**
 * dropGroups.json's aliases with every redirect that lands on an item page added: a looted or listed
 * name the wiki sends to an item page (`Halfling Blood` -> `Vial of Halfling Blood`) is that item.
 * An alias the drop-list pages gave already is kept as it is; a name that is an item of its own is not one.
 */
export function withItemRedirectAliases(aliases: Readonly<Record<string, string>>, items: Readonly<Record<string, NamedItem>>, redirects: readonly Redirect[], key: (name: string) => string): Record<string, string> {
  const pages = new Map(Object.values(items).map((e) => [e.page.toLowerCase(), e.page]))
  const out: Record<string, string> = { ...aliases }
  for (const r of redirects) {
    const page = pages.get(r.to.toLowerCase())
    if (page === undefined || r.from in out || key(r.from) in items) continue
    out[r.from] = page
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => a[0].localeCompare(b[0])))
}

/** The redirects the records already carry, so a delta can change a few and apply them all again. */
export function redirectsOf(mobs: readonly NamedMob[]): Redirect[] {
  return mobs.flatMap((m) => (m.otherNames ?? []).map((from) => ({ from, to: m.page })))
}

// ---- the cached list (owner, 2026-10-19: everything read from the wiki is cached) ----------------


/** Every ns0 redirect a full run listed, kept current by the delta: mobs.json re-derives offline. */
export interface RedirectCache {
  updatedAt: string
  redirects: Redirect[]
}

/** Where every scraper finds the cached list. */
export const REDIRECT_CACHE = resolve(fileURLToPath(import.meta.url), '../cache/redirects/redirects.json')

/** The cached list's redirects, or none when no full run has cached it yet (a scraper then writes no `otherNames`). */
export function cachedRedirects(path: string = REDIRECT_CACHE): Redirect[] {
  const cached = readRedirectCache(path)
  if (cached === null) console.warn(`No cached redirect list at ${path}: run scrape-mob-redirects once (about 19 requests).`)
  return cached?.redirects ?? []
}

export function readRedirectCache(path: string): RedirectCache | null {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as RedirectCache
}

export function writeRedirectCache(path: string, redirects: readonly Redirect[]): void {
  mkdirSync(dirname(path), { recursive: true })
  const sorted = [...redirects].sort((a, b) => a.from.localeCompare(b.from))
  writeFileSync(path, JSON.stringify({ updatedAt: new Date().toISOString(), redirects: sorted }, null, 1))
}

/**
 * The cached list after the pages a delta read: each read page's old entry dropped, and the page
 * added again when it is a redirect now (`target` reads its text; null for none or no text).
 */
export function foldRedirectCache(cached: readonly Redirect[], pages: ReadonlyMap<string, string | null>): Redirect[] {
  const kept = cached.filter((r) => !pages.has(r.from))
  for (const [from, wt] of pages) {
    const to = wt == null ? null : redirectTarget(wt)
    if (to !== null) kept.push({ from, to })
  }
  return kept
}
