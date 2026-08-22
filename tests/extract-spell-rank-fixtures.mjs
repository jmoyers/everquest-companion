// SPELL-RANK golden-window fixture extractor (JOS-446 — observed spell ranks).
//
// Cuts VERBATIM spans of the real log (only third-party chat/social dropped, via the shared scrub
// tests/fixture-scrub.mjs — never a hand-copied or rewritten line) into tests/fixtures/. Fixtures
// are COMMITTED and CI runs them, so this must be DETERMINISTIC: re-running it against the same
// log rewrites every file byte-identically.
//
// Usage: node --import tsx tests/extract-spell-rank-fixtures.mjs "<path to eqlog_Primitive_freeport.txt>"
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { scrubKeep } from './fixture-scrub.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOG = process.argv[2]
const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)

/** Collect a raw 1-based inclusive line range, scrubbed. */
function span(fromLine, toLine) {
  const seg = []
  for (let i = fromLine - 1; i < toLine && i < lines.length; i++) {
    const l = lines[i]
    if (!l.startsWith('[')) continue
    if (!scrubKeep(l)) continue
    seg.push(l)
  }
  return seg
}

/** Write one fixture from one or more raw spans (concatenated in the order given). */
function slice(out, ...ranges) {
  const seg = ranges.flatMap(([from, to]) => span(from, to))
  writeFileSync(join(HERE, 'fixtures', out), seg.join('\n') + '\n')
  const raw = ranges.reduce((n, [from, to]) => n + (to - from + 1), 0)
  console.log(`${out}: ${seg.length} lines (from raw ${raw})`)
}

// W46 ALL THREE WITNESSES, ONE EVENING (Thu Jul 30, three real spans of the same session). The
// module unions a merge (the moment of levelling) with a cast and a resist (possession), and this
// fixture is chosen so each family is the ONLY witness for at least one line:
//   A  17:09:13 → 17:19:52 (raw 502975..503330) — the levelling run and the casts that follow it.
//      Shiftless Deeds I,I,II,II,II,II,III×8,IV then, ten minutes later, `You begin casting
//      Shiftless Deeds IV.`: both families agreeing on rank 4. Feedback I,I,II; Boon of the Garou
//      I,I,II (and TWO casts of `Boon of the Garou II`); Clarity I,I,II,II,II,II,III; Weakness
//      I,I,II,II,II,II,III. The repeated ranks are two scrolls climbing in parallel — the same
//      shape w30's item merges have, and the reason "highest wins" is not "latest wins".
//   B  17:21:22 (raw 503875..503895) — `You begin casting Lay on Hands IX.` The owner's log
//      contains no Lay on Hands merge ANYWHERE, and the wiki scrape carries no page for it at all,
//      so this rank exists only because he was watched using it. It is the case the merge lane
//      cannot see and the catalog gate would have refused.
//   C  21:55:33 (raw 582510..582525) — `A revenant resisted your Mesmerization III!` The span
//      deliberately starts AFTER the cast-begin that preceded it, so the resist line is the only
//      witness in the window for that line: 861 such lines exist in the log and none of them was
//      being read.
slice('w46-spell-rank-witnesses.log', [502975, 503330], [503875, 503895], [582510, 582525])

// W47 THE EPOCH BOUNDARY (two real spans, concatenated — the construction w33-item-tier-epoch.log
// uses, for the same reason: the two sides of the launch boundary are half a million lines apart
// and only the rank lines matter).
//   BETA side  (Sun Jul 19 08:51:28 → 08:52:26, raw 3330..3400): the WIPED character merging
//     `Instrument of Nife I, II, II` and `Vampiric Embrace I, II`, and CASTING both at rank II.
//     Both witness families on the dead character's side, so the reset has to drop both.
//   CURRENT side (Thu Jul 30 17:09:04 → 17:10:32, raw 502975..503020): the first line is well
//     after the 2026-07-28 launch instant, so it trips the EpochDetector; then Shiftless Deeds
//     I..IV and Feedback I,I,II — the live character's own ranks.
// Post-epoch the beta lines must be GONE (not "rank 0" — absent), the Jul 30 ones present.
slice('w47-spell-rank-epoch.log', [3330, 3400], [502975, 503020])
