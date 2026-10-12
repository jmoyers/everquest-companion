// validate-data.mts — dev-time checks on the wiki-derived data files, run after a re-derive and
// before a data commit: what was extracted, compared against what is known (owner, 2026-10-10).
//
//   npx tsx scripts/validate-data.mts [--client-spells <path to the game's spells_us.txt>]
//
// Sends the wiki nothing. The client file is read only when named, as a one-time dev comparison;
// nothing in the app or the scrapers depends on it. FAIL lines set a non-zero exit; note lines
// are for the reviewer.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SpellDbFile } from '../src/shared/types'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), 'utf8'))
const fold = (s: string): string => s.toLowerCase().replace(/[`’]/g, "'").replace(/\s+/g, ' ').trim()
const sample = (xs: string[], n = 5): string =>
  xs.slice(0, n).join(' | ') + (xs.length > n ? ` … +${String(xs.length - n)}` : '')

let failed = false
function fail(msg: string): void {
  failed = true
  console.log(`FAIL ${msg}`)
}
const note = (msg: string): void => console.log(`note ${msg}`)

interface Item {
  summary?: string
}
interface Mob {
  name: string
  page?: string
  drops?: string[]
}
interface Quest {
  name: string
  rewards?: { name: string }[]
  requiredItems?: string[]
}

function checkItems(): Set<string> {
  const { items } = read('src/main/data/items.json') as { items: Record<string, Item> }
  const keys = Object.keys(items)
  const templated = keys.filter((k) => items[k].summary?.includes('{{'))
  if (templated.length) note(`items: ${String(templated.length)} summaries still carry a wiki template: ${sample(templated)}`)
  return new Set(keys)
}

function checkMobs(itemKeys: Set<string>): Set<string> {
  const { mobs } = read('src/renderer/src/data/eqlegends/mobs.json') as { mobs: Mob[] }
  const unknown: string[] = []
  for (const m of mobs) for (const d of m.drops ?? []) if (!itemKeys.has(d.toLowerCase())) unknown.push(`${m.name}: ${d}`)
  note(`mobs: ${String(mobs.length)}; ${String(unknown.length)} drop names with no item record: ${sample(unknown)}`)
  return new Set(mobs.map((m) => m.page ?? m.name))
}

function checkFactions(mobPages: Set<string>): void {
  const { hit } = read('src/renderer/src/data/eqlegends/mobFactions.json') as { hit: string[] }
  const orphans = hit.filter((h) => !mobPages.has(h))
  if (orphans.length) note(`mobFactions: ${String(orphans.length)} of ${String(hit.length)} name no mob record: ${sample(orphans)}`)
}

function checkQuests(): void {
  const { quests } = read('src/renderer/src/data/eqlegends/quests.json') as { quests: Quest[] }
  const placeholder = /^(unknown|none|tbd|n\/a)$/i
  const placeholders = quests.filter((q) => (q.rewards ?? []).some((r) => placeholder.test(r.name))).map((q) => q.name)
  if (placeholders.length) fail(`quests: ${String(placeholders.length)} ship a placeholder reward: ${sample(placeholders)}`)
  const both = quests
    .filter((q) => {
      const rewards = new Set((q.rewards ?? []).map((r) => fold(r.name)))
      return (q.requiredItems ?? []).some((i) => rewards.has(fold(i)))
    })
    .map((q) => q.name)
  if (both.length) note(`quests: ${String(both.length)} list an item as both turn-in and reward: ${sample(both)}`)
}

function checkSpells(clientFile: string | undefined): void {
  const { spells } = read('src/main/data/spells.json') as SpellDbFile
  const names = spells.map((s) => s.name)
  const broken = names.filter((n) => /[|=]/.test(n))
  if (broken.length) fail(`spells: ${String(broken.length)} names carry an unparsed field: ${sample(broken)}`)
  const seen = new Map<string, number>()
  for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1)
  const dupes = [...seen].filter(([, c]) => c > 1).map(([n, c]) => `${n} x${String(c)}`)
  if (dupes.length) note(`spells: ${String(dupes.length)} names appear on more than one page: ${sample(dupes)}`)
  if (clientFile !== undefined) auditClientNames(names, clientFile)
}

/** The page's own `|spellname`, from the committed spell cache, by the page title. */
function statedName(title: string, idByTitle: Map<string, string>): { id: string; stated: string } | undefined {
  const id = idByTitle.get(fold(title))
  if (id === undefined) return undefined
  const page = join(ROOT, 'scripts/sources/cache/spells', `${id}.wikitext`)
  if (!existsSync(page)) return undefined
  const stated = /\|\s*spellname\s*=\s*([^\n|]*)/.exec(readFileSync(page, 'utf8'))?.[1].trim() ?? ''
  return { id, stated }
}

/** One-time dev comparison against the game's own spell list. A page title the client has never
 *  heard of is a wiki typo or a duplicate page: the owner fixes it on the wiki, or names the
 *  game's spelling in spellCorrectionsList.ts with evidence. Nothing here feeds the scrape. */
function auditClientNames(names: string[], clientFile: string): void {
  if (!existsSync(clientFile)) {
    fail(`client spell file not found: ${clientFile}`)
    return
  }
  const client = new Set<string>()
  for (const line of readFileSync(clientFile, 'utf8').split('\n')) {
    const n = line.split('^')[1]
    if (n) client.add(fold(n))
  }
  const index = read('scripts/sources/cache/spells/index.json') as { titles?: Record<string, string> }
  const titles = index.titles ?? {}
  const idByTitle = new Map(Object.entries(titles).map(([id, t]) => [fold(t), id]))
  const unknown = names.filter((n) => !client.has(fold(n)))
  const typo: string[] = []
  const other: string[] = []
  for (const n of unknown) {
    const s = statedName(n, idByTitle)
    if (s !== undefined && s.stated !== '' && client.has(fold(s.stated))) typo.push(`${n} [${s.id}] (|spellname ${s.stated})`)
    else other.push(n)
  }
  console.log(`\nclient audit: ${String(unknown.length)} of ${String(names.length)} names are not in ${clientFile}`)
  console.log(`  title is not a game name but the page's |spellname is (title typo or duplicate page), ${String(typo.length)}:`)
  for (const t of typo) console.log(`    ${t}`)
  console.log(`  neither is, ${String(other.length)}: ${other.join(' | ')}`)
}

const argv = process.argv.slice(2)
const at = argv.indexOf('--client-spells')
checkFactions(checkMobs(checkItems()))
checkQuests()
checkSpells(at === -1 ? undefined : argv[at + 1])
process.exitCode = failed ? 1 : 0
