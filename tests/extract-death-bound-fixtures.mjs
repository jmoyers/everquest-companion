// DEATH-LOWER-BOUND golden-window fixture extractor (JOS-379, owner report 2026-08-15).
//
// Same law as every other extractor here: the window is kept VERBATIM and only what the shared
// scrub (tests/fixture-scrub.mjs `scrubKeep`) classifies as third-party chat/social is dropped.
// NEVER hand-copy a span into fixtures/ and never re-implement the drop list —
// `tests/fixtures/*.log` is COMMITTED to a PUBLIC repo. And never write to the game log.
//
// Usage: npm run fixtures:death-bound -- "<path to eqlog_Primitive_freeport.txt>"
//    or: node --import tsx tests/extract-death-bound-fixtures.mjs "<path>"
//
// Line numbers are against the LIVE log (1,967,000 lines as of Sat Aug 15 2026 23:1x). The log
// only ever grows by APPENDING, so a span's raw range stays valid; the timestamps in the headers
// below are the real anchor if a number ever looks wrong.
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { scrubKeep } from './fixture-scrub.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOG = process.argv[2]
const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)

function slice(fromLine, toLine, out) {
  const seg = []
  for (let i = fromLine - 1; i < toLine && i < lines.length; i++) {
    const l = lines[i]
    if (!l.startsWith('[')) continue
    if (!scrubKeep(l)) continue
    seg.push(l)
  }
  writeFileSync(join(HERE, 'fixtures', out), seg.join('\n') + '\n')
  console.log(`${out}: ${seg.length} lines (from raw ${toLine - fromLine + 1})`)
}

// ---------------------------------------------------------------------------------------
// W69 THE CYCLE THAT DOES COMPLETE (Fri Aug 14 21:03:22 → 21:06:01, raw 1793860..1794875).
//
// A rock golem in the Plane of Growth, and the reason the death bound is allowed to exist at all:
// on an ordinary mob the wear-off sentence DOES arrive, so an absence of one is informative.
//
//   21:03:35  You begin casting Togor's Insects.               ← the anchor
//   21:03:39  a rock golem yawns.                              ← the landing (shared sentence:
//                                                                8 spells print "Someone yawns.")
//   21:05:59  Your Togor's Insects spell has worn off of a rock golem.
//
// 2:20 exactly, against the committed spells.json's 2:30 — one of five clean Togor cycles that
// night, all of them between 2:20 and 2:29. Two things this window is the evidence for:
//   * the WEAR-OFF CHANNEL for this line is WITNESSED (buffsStats.ts `wearOffWitnessed`), which is
//     the precondition for reading a later silence as anything at all; and
//   * a below-floor clean cycle does NOT move the estimate — the DB floor holds at 2:30, exactly
//     as JOS-117's floor law says and JOS-212's cluster rule declines to overrule on one sample.
//
// It opens 17 s before the cast so the fight is already running, and closes 2 s past the wear-off.
slice(1793860, 1794875, 'w69-golem-slow-cycle.log')

// ---------------------------------------------------------------------------------------
// W70 THE CYCLE THAT NEVER CAN (Sat Aug 15 22:38:26 → 22:42:04, raw 1954040..1955968).
//
// The owner's report, cut whole: a Plane of Fear dracoliche, slowed and killed, and the alert that
// announced the slow had worn off while it was visibly still on the mob.
//
//   22:38:33  You begin casting Togor's Insects V.             ← first attempt (out of range)
//   22:38:41  You begin casting Togor's Insects V.
//   22:38:51  You begin casting Togor's Insects V.             ← the anchor that lands
//   22:38:54  a dracoliche yawns.                              ← the landing
//   22:41:19  (the "Slow wore off a mob" alert would fire here: 2:30 DB floor, 5 s early warning)
//   22:42:02  A dracoliche has been slain by Vebn!             ← ANOTHER PLAYER lands the kill
//
// AND NO `Your Togor's Insects spell has worn off of a dracoliche.` ANYWHERE IN BETWEEN — hand-read
// line by line over the whole span. So the real duration is at least 3:08, and 2:30 is wrong by at
// least 38 seconds. (Corroborated later the same night outside this window: the dracoliche slowed
// at 23:07:49 DID print its wear-off, at 23:11:59 — a 4:10 cycle. The learner is under-reading by
// a lot, and this window is the only kind of evidence a raid mob ever produces.)
//
// The window carries other deaths on purpose — `a dracoliche pet` at 22:39:31 and `a nightmare` at
// 22:39:23, both of them slowed and both of them dying INSIDE the dracoliche's span — because the
// identity guard has to be seen refusing the wrong ones while admitting this one.
slice(1954040, 1955968, 'w70-dracoliche-death-bound.log')
