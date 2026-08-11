// CROWD-CONTROL DURATION-LEARNING golden-window extractor (JOS-180).
//
// Same law as every other extractor in this directory: the span comes from the owner's real log
// and every line routes through the shared scrub (tests/fixture-scrub.mjs `scrubKeep`) before it
// can reach a COMMITTED fixture in a PUBLIC repo. Never hand-copy a span into fixtures/ and never
// re-implement the drop list.
//
// Usage: npm run fixtures:cc-duration -- "<path to eqlog_Primitive_freeport.txt>"
//    or: node --import tsx tests/extract-cc-duration-fixtures.mjs "<path>"
//
// WHY THIS IS A SEPARATE EXTRACTOR AND NOT A SLICE IN extract-fixtures.mjs. That script's KEEP
// whitelist is shared by every buffs/entity fixture in the tree, and this window needs a shape none
// of them carry: `<mob> has been awakened by <name>.`, the CC break annotation JOS-180 taught the
// parser. Adding it there would silently re-cut a dozen committed fixtures the next time anyone ran
// `npm run fixtures:buffs`. A new family gets a new extractor; the existing goldens stay byte-frozen
// until somebody deliberately re-cuts them.
//
// IT IS A FILTERED CUT, NOT A VERBATIM ONE, and the whitelist below is the whole of what the
// subject needs: the cast lines that ANCHOR a landing, the mez/charm landings, the wear-offs that
// close them, the wake lines that say a hold was broken, the deaths that censor, and the zone lines
// that clear. The window's combat spam is ~4,300 lines of damage the duration learner never reads.
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { scrubKeep } from './fixture-scrub.mjs'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const LOG = process.argv[2]
const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)

const KEEP = [
  /You begin (casting|singing) /, // the ANCHOR — no bar without a cast line
  /spell (fizzles!|is interrupted\.)/, // …and the two lines that retract one
  /spell has worn off/, // the close: a CC refresh, a charm break, a named-target fade
  /has been (mesmerized|enthralled|entranced|ensnared)\./, // the hold opening
  /has been charmed\./,
  /has been awakened by /, // JOS-180: the hold being BROKEN rather than ending
  /has been slain by /, // a corpse contaminates the group and forgets the memory
  /You have slain /,
  /You have been slain by /,
  /You have entered /, // a zone censors every hold
  /Welcome to EverQuest Legends!/
]

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

// ---------------------------------------------------------------------------------------------
// W63 THE MEZ THAT OUTLIVED ITS OWN BAR (Sun Aug 09 22:40:58 → 22:55:43, raw 1549400..1553910).
//
// The owner's Plane of Fear solo instance, cut from the zone-in to the last mez of the sequence.
// It is the whole of JOS-180's evidence in one contiguous span: SIX Dazzle IV cycles that reach the
// learner, five of them ended early by the player's own damage and one that ran its natural course.
//
// Hand-read, in order (every wear-off but the toad's is followed in the SAME SECOND by the wake
// line that says who broke it):
//
//   22:40:58  You have entered The Plane of Fear - Solo 1 (Awakened).   ← the fold starts clean
//   22:41:23  You begin casting Dazzle IV.
//   22:41:25  a nightmare has been mesmerized.
//   22:43:05  Your Dazzle spell has worn off of a nightmare.            ← 100 s, BROKEN
//   22:43:05  A nightmare has been awakened by Primitive.
//   22:45:13  You begin casting Dazzle IV.
//   22:45:14  a turmoil toad has been mesmerized.                       ← THE CYCLE THIS IS ABOUT
//   22:47:30  Your Dazzle spell has worn off of a turmoil toad.         ← 136 s, and NO wake line
//   22:47:40  You have slain a turmoil toad!
//   22:49:22  You begin casting Dazzle IV.
//   22:49:23  a shiverback has been mesmerized.
//   22:49:34  Your Dazzle spell has worn off of a shiverback.           ← 11 s, BROKEN
//   22:50:15  You begin casting Mesmerization III.                     ← a DIFFERENT line, and
//   22:50:17  phoboplasm has been mesmerized.                            its own hold on one mob
//   22:50:33  You begin casting Dazzle IV.
//   22:50:34  phoboplasm has been mesmerized.                          ← the Dazzle hold opens clean
//   22:51:48  Your Dazzle spell has worn off of phoboplasm.             ← 74 s, BROKEN
//   22:52:49  You begin casting Dazzle IV.
//   22:52:50  a boogeyman has been mesmerized.
//   22:54:21  Your Dazzle spell has worn off of a boogeyman.            ← 91 s, BROKEN
//   22:55:00  You begin casting Dazzle IV.
//   22:55:00  a fetid fiend has been mesmerized.
//   22:55:27  Your Dazzle spell has worn off of a fetid fiend.          ← 27 s, BROKEN
//
// WHY 22:45:14 → 22:47:30 IS THE WHOLE POINT. Dazzle's committed DB row states 96 s (the base
// rank's; the scrape has no rank IV). The nightmare's broken 100 s beats that floor, so the estimate
// becomes 'observed' and the unwitnessed-expiry grace drops from 60 s to 15 s — the toad's hold is
// culled at 22:47:09, and its natural wear-off 21 s later arrives to an empty model. That is the
// first full-duration Dazzle cycle in a 1.5M-line log, and before JOS-180 the app destroyed it with
// a number the same cycle would have corrected.
//
// THE CONTROL COMES FREE. The same window holds three Allure VI charms, two of which end by their
// own `Your Allure spell has worn off of <mob>.` with NO wake line beside them (22:54:17, 22:55:23).
// Charm is a hold learned through the identical path, and nothing about the CC break annotation may
// touch it — so the fixture proves the censoring is driven by the log's own sentence rather than by
// "it is a crowd-control spell".
//
// The window opens on the zone line so no hold is carried in from The Feerrott, and closes 16 s
// after the last wear-off, before the 22:59 Cazic-Thule kill changes the subject.
slice(1549400, 1553910, 'w63-dazzle-break-vs-full.log')
