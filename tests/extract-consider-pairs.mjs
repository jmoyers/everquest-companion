// extract-consider-pairs.mjs — CUTS THE ONE WINDOW WHERE THIS LOG STATES BOTH LEVELS AT ONCE
// (docs/plans/gear-progression-planner.md §2.1, §6).
//
//   node --import tsx tests/extract-consider-pairs.mjs "<path-to-eqlog>"
//
// THE DEFECT THIS FILE ANSWERS. `src/shared/considerFaction.ts` (line ~92) says of its difficulty
// table, in as many words, that it carries "deliberately NO numeric ordering, which the log does
// not state". That was true of the log it was written against. It is no longer true of THIS one:
// eqlog_Drywrought_oggok.txt states the character's own level three times (three dings) and then
// goes on considering mobs whose `(Lvl: N)` the same lines print, so every consider after the
// first ding is a MEASURED (myLevel, mobLevel, verdict) triple. `src/shared/conBands.ts` is the
// claim that adds the ordering; this extractor cuts the evidence it is pinned to.
//
// SIBLING, NOT REPLACEMENT of extract-consider-fixtures.mjs (w22–w24). Those windows were cut
// from Primitive's Freeport log to cover consider SHAPES — backtick names, the rare infix, the
// faction ladder — and state no own-level anywhere, so not one of their lines can be paired.
// This one exists for the pairing alone and keeps three families instead of two.
//
// WHY THE WINDOW STARTS AT THE FIRST DING. A consider line alone is half a pair: it states the
// MOB's level and nothing about the reader's. Own level enters this log only at
// `[Wed Aug 12 22:20:55 2026] You have gained a level! Welcome to level 42!` (raw line 33088),
// so the 50 considers BEFORE it can never be paired — they contribute to the phrase census and
// to nothing else, and the census is censored rather than corrected (law 1: absent is not zero).
// Cutting from the ding means every consider in the fixture is pairable, and the fixture's own
// replay proves it (tests/conBands.test.mts asserts 0 unpaired).
//
// THE ONE REDUNDANT OWN-LEVEL STATEMENT, AND WHY IT IS NOT MISSED. The log also carries a self
// `/who` row — `[Fri Aug 14 21:47:45 2026] [42 WAR/MNK/SHM] Drywrought (Iksar) ...` (raw line
// 61330) — which the shared scrub DROPS here, because its self-name carve-out is gated on
// `SELF_NAME = 'Primitive'` (tests/fixture-scrub.mjs) and this log is Drywrought's. Losing it
// costs NOTHING: it restates level 42, which the Aug 12 ding already stated and no later ding
// contradicts until Aug 14 22:33. The scrub is NOT modified for this fixture — a committed
// fixture that widened the public-repo scrub to save a redundant line would be a bad trade.
// MEASURED 2026-08-15: 19 `/who` rows in the log, 19 dropped, 0 of them load-bearing.
//
// SCRUB SURVIVAL, MEASURED 2026-08-15 over the full 136,400-line log: 104 consider lines,
// 0 dropped; 3 ding lines, 0 dropped; 37 zone-enter lines, 0 dropped. No carve-out needed.
// A consider line carries no quoted speech and its subject is a mob; a ding and a zone-enter
// are second-person system lines. Re-run the check if the scrub's DROP list ever grows.
//
// Line numbers below were located in eqlog_Drywrought_oggok.txt on 2026-08-15, when the log had
// 136,604 lines and was still growing (the owner was playing). RE-LOCATE before re-cutting —
// the end bound is "the log as it stood", not a landmark.
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { scrubKeep } from './fixture-scrub.mjs'

// Fixtures resolve RELATIVE to this file — never hardcode a repo path here.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const LOG = process.argv[2]
const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)

// THREE FAMILIES, because a pair needs all three. `(Lvl: N)` is the consider anchor (it appears
// on consider lines and nowhere else — the w22–w24 sweep established that and this log agrees:
// 104 matches, 104 considers). The ding is the ONLY own-level statement that survives the scrub.
// Zone-enters ride along so the replay knows WHERE each pair was measured, which is the whole
// evidence for the tiered-zone finding in conBands.ts's header.
const KEEP = [/\(Lvl: \d+\)$/, /\] You have entered /, /You have gained a level!/]
function keep(line) {
  if (!line.startsWith('[')) return false
  if (!scrubKeep(line)) return false
  return KEEP.some((re) => re.test(line))
}

function slice(fromLine, toLine, out) {
  const seg = []
  for (let i = fromLine - 1; i < toLine && i < lines.length; i++) {
    if (keep(lines[i])) seg.push(lines[i])
  }
  writeFileSync(join(FIXTURES, out), seg.join('\n') + '\n')
  console.log(`${out}: ${seg.length} lines (from raw ${toLine - fromLine + 1})`)
}

// W69 PAIRED CONSIDERS (Aug 12 22:20 → end of log): ONE window, opened by the level-42 ding and
// closed by the tail, holding all 54 pairable considers, all 3 dings (42 / 43 / 44) and the 20
// zone-enters between them. Seven distinct difficulty phrases and eight distinct zones, three of
// them TIERED (`Temple of Cazic-Thule 4 (Refined)`, `The Ruins of Old Guk 3 (Fused)`,
// `Befallen 4 (Refined)`) — the pairs that make the +N question answerable at all.
slice(33088, 136604, 'w69-consider-pairs.log')
