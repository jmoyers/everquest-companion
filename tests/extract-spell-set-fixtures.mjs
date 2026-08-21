// Spell-set fixture extractor (JOS-391). Slices the real log's gem traffic into two golden
// windows, keeping only the four line shapes the SpellSetsModule consumes.
//
// Usage: node tests/extract-spell-set-fixtures.mjs "<path to eqlog_Primitive_freeport.txt>"
//
// WHY TWO WINDOWS. The two spell-set verbs mean structurally different things and each needs its
// own evidence:
//
//   ss1-load-burst.log   `Spell set dam loaded.` at Sun Jul 19 21:46:20 — the ten forgets in the
//                        SAME SECOND, the ten memorizes trickling in over the next ten, and then
//                        the player hand-swapping three more gems with never a ten-second gap
//                        until `Spell set dam saved.` at 21:46:57 closes the window. Every clause
//                        of the settle rule is in this one minute.
//
//   ss2-save-over.log    Sun Jul 19 20:11 → 20:34 — `dam saved`, `buff saved`, `buff saved` again
//                        (the save-over the owner named), `dam loaded`, `som saved`, `buff loaded`,
//                        `dam loaded`. Seven spell-set lines over three names in twenty minutes,
//                        which is what "a set is its LATEST definition" has to survive.
//
// Everything here is a GAME line about the player's own client — no chat, no names but the
// character's own spells — so the shared scrub passes it through untouched; it is applied anyway
// because every extractor applies it.
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { scrubKeep } from './fixture-scrub.mjs'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const LOG = process.argv[2]
const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)

const KEEP = [
  /\] Beginning to memorize .+\.\.\.$/,
  /\] You have finished memorizing .+\.$/,
  /\] You forget .+\.$/,
  /\] Spell set .+ (?:saved|loaded|deleted)\.$/
]
const keep = (l) => l.startsWith('[') && scrubKeep(l) && KEEP.some((re) => re.test(l))

function slice(fromLine, toLine, out) {
  const seg = []
  for (let i = fromLine - 1; i < toLine && i < lines.length; i++) if (keep(lines[i])) seg.push(lines[i])
  writeFileSync(join(FIXTURES, out), seg.join('\n') + '\n')
  console.log(`${out}: ${seg.length} lines (from raw ${toLine - fromLine + 1})`)
}

slice(126355, 126475, 'ss1-load-burst.log')
slice(104600, 108520, 'ss2-save-over.log')
