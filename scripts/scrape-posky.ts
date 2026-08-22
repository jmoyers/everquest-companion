/**
 * Scrapes quest data for a given source/profile and writes it to
 * src/renderer/src/data/<sourceId>/posky.json.
 *
 *   npm run scrape:posky                  # default source (eqlegends)
 *   npm run scrape:posky -- --source p99  # once a p99 source is implemented
 */
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { SOURCES, getSource } from './sources'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const flagIdx = args.indexOf('--source')
  // Absent OR empty (`--source ""`, `EQ_SOURCE=`) both mean "not specified" — hence the
  // emptiness test rather than a bare nullish fallback.
  const requested = (flagIdx >= 0 ? args[flagIdx + 1] : process.env.EQ_SOURCE) ?? ''
  const sourceId = requested.length > 0 ? requested : 'eqlegends'

  const source = getSource(sourceId)
  if (!source) {
    console.error(`Unknown source "${sourceId}". Available: ${Object.keys(SOURCES).join(', ')}`)
    process.exit(1)
  }

  console.log(`Scraping with source: ${source.label}\n`)
  const data = await source.scrape()

  // NEVER WRITE A GUTTED FILE (2026-08-22): a wiki restructure once renamed every class heading,
  // the parser found nothing, and this script overwrote the committed 95-quest dataset with an
  // empty one and exited 0. Zero quests is never a scrape result — it is a parser that stopped
  // matching the page, and the only honest outcome is a loud failure that leaves the file alone.
  if (data.quests.length === 0) {
    console.error('\nRefusing to write: the scrape produced 0 quests (parser no longer matches the page?)')
    process.exit(1)
  }

  const here = dirname(fileURLToPath(import.meta.url))
  const outDir = resolve(here, `../src/renderer/src/data/${source.id}`)
  mkdirSync(outDir, { recursive: true })
  const outPath = resolve(outDir, 'posky.json')
  writeFileSync(outPath, JSON.stringify(data, null, 2))
  console.log(`\nWrote ${data.quests.length} quests → ${outPath}`)
}

void main()
