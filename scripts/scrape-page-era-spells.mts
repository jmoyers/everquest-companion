// scrape-page-era-spells.mts — the SPELL top-up of the page-era sidecar: ask the wiki's era endpoint
// only for the catalog names `pageEra.json` has no spell verdict for, and merge them in.
//
//   npx tsx scripts/scrape-page-era-spells.mts [--dry-run]
//
// After a spell re-derive a handful of names are new. A full `scrape:page-era` re-asks every
// 450-title batch those names shift (about twenty requests); this asks one, 450 names per request,
// and leaves the rest of the file as it stands (owner, 2026-10-10). Running it is the owner's call.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pageEraKey, type PageEraFile } from '../src/main/pageEraDb'
import type { SpellDbFile } from '../src/shared/types'
import { answered, fetchMetadata, spellTargets } from './scrape-page-era'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = resolve(HERE, '../src/main/data/pageEra.json')
const SPELLS_PATH = resolve(HERE, '../src/main/data/spells.json')
const META_BATCH = 450
const dryRun = process.argv.includes('--dry-run')

async function main(): Promise<void> {
  const prev = JSON.parse(readFileSync(OUT_PATH, 'utf8')) as PageEraFile
  const catalog = JSON.parse(readFileSync(SPELLS_PATH, 'utf8')) as SpellDbFile
  const missing = spellTargets([], catalog).filter((t) => prev.spells[pageEraKey(t)] === undefined)
  console.log(`${String(missing.length)} catalog names with no era verdict: ${missing.join(' | ')}`)
  const posts = Math.ceil(missing.length / META_BATCH)
  if (missing.length === 0) {
    console.log('nothing to ask')
    return
  }
  if (dryRun) {
    console.log(`--dry-run: nothing sent; a run would send ${String(posts)} POST`)
    return
  }
  const added = answered(missing, await fetchMetadata(missing))
  const spells = Object.fromEntries(Object.entries({ ...prev.spells, ...added }).sort((a, b) => a[0].localeCompare(b[0])))
  const out: PageEraFile = { ...prev, scrapedAt: new Date().toISOString(), spells }
  writeFileSync(OUT_PATH, `${JSON.stringify(out)}\n`, 'utf8')
  const silent = missing.filter((t) => added[pageEraKey(t)] === undefined)
  console.log(`  answered ${String(Object.keys(added).length)} of ${String(missing.length)}; ${String(posts)} request sent`)
  if (silent.length) console.log(`  no verdict for: ${silent.join(' | ')}`)
}

void main()
