// BOSS TIER-RUN golden-window fixture extractor (the Lord of Ire misattribution, 2026-08-04).
//
// Cuts VERBATIM spans of the real log (only third-party chat/social dropped, via the shared
// scrub tests/fixture-scrub.mjs — never a hand-copied or rewritten line) into
// tests/fixtures/. Fixtures are COMMITTED and CI runs them, so this must be DETERMINISTIC:
// re-running it against the same log rewrites every file byte-identically.
//
// Usage: node tests/extract-boss-tier-fixtures.mjs "<path to eqlog_Primitive_freeport.txt>"
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

// THE MISATTRIBUTION, cut from the two real kills that produced it. One mob, two instance
// tiers, two days apart, with a class-loadout swap in between (Sun Aug 02 01:57:42) — so the
// two kills belong to two DIFFERENT combo intervals and the roster used to file the higher
// tier under the later loadout.
//
// Four spans, in log order (each zone line is the nearest preceding `You have entered` for the
// kill that follows it — verified: nothing re-zones in between, which is why the fixture can
// skip the ~12k intervening lines and still state the truth):
//   1. Sat Aug 01 15:33:26, raw 853620 — `You have entered The Plane of Hate - Solo 4
//      (Refined).` The `- Solo N` is stripped as noise and `(Refined)` reads as tier 4.
//   2. Sat Aug 01 16:09:29, raw 865678..865690 — `You have slain Lord of Ire!` at d4, with its
//      exp line, its corpse loot and the con of Innoruuk`s Chosen riding along.
//   3. Mon Aug 03 22:45:48, raw 1205559 — `You have entered The Plane of Hate.` No suffix, so
//      the same zone at BASE tier (0).
//   4. Mon Aug 03 23:02:44, raw 1211528..1211542 — `You have slain Lord of Ire!` at d0.
//
// Expected fold: ONE KillMap entry, count 2, tiers { 4: {1 kill, Aug 01 16:09:29}, 0: {1 kill,
// Aug 03 23:02:44} } — two runs whose timestamps and tiers stay attached to each other.
slice(
  'bosstier-lord-of-ire.log',
  [853620, 853620],
  [865678, 865690],
  [1205559, 1205559],
  [1211528, 1211542]
)

// THE TOAST THAT ANNOUNCED THE WRONG TIER (JOS-165, owner 2026-08-09). Same mob, three tiers,
// nine days: the ladder the owner actually climbs. He clears d0 through d4 every week, so his
// LAST kill of a target is routinely at a LOWER tier than his best — and the celebration toast
// was built from `bestTier`, the all-time maximum, so a Sunday d1 kill kept announcing itself as
// the d4 he beat on the first Saturday.
//
// Six spans, in log order (each zone line is the nearest preceding `You have entered` for the
// kill that follows it — verified against the full log: nothing re-zones in between, which is
// what lets the fixture skip the ~7k intervening lines and still state the truth):
//   1. Sat Aug 01 14:35:15, raw 839935 — `You have entered The Plane of Hate - Solo 3 (Fused).`
//   2. Sat Aug 01 14:56:20, raw 847286..847293 — the d3 kill. The killing blow is the charmed
//      pet`s (`Maestro of Rancor has been slain by Innoruuk\`s Chosen!`), which is still YOUR
//      kill: the `You gain experience!` line four lines above it is the credit join.
//   3. Sat Aug 01 15:33:26, raw 853620 — `... - Solo 4 (Refined).`
//   4. Sat Aug 01 16:02:37, raw 863975..863982 — the d4 kill, `You have slain Maestro of
//      Rancor!`, with its own exp line. This is the kill that poisoned every later toast.
//   5. Sun Aug 09 17:18:56, raw 1485672 — `... - Solo 1 (Awakened).`
//   6. Sun Aug 09 17:29:39, raw 1489474..1489479 — THE INCIDENT: the d1 kill that toasted
//      "D4 · Refined · Plane of Hate".
//
// Expected fold: ONE KillMap entry, count 3, credited 3, tiers { 3, 4, 1 } — and three
// celebrations whose tiers are 3, then 4, then 1, against a `bestTier` that is 4 from the
// second kill onward.
slice(
  'bosstier-maestro-ladder.log',
  [839935, 839935],
  [847286, 847293],
  [853620, 853620],
  [863975, 863982],
  [1485672, 1485672],
  [1489474, 1489479]
)

// THE FIVE-RUNG WEEK (JOS-166, owner decision 2026-08-09: d0 is a real difficulty). The owner
// clears a raid target at every difficulty each week — FIVE weekly lockouts per target, d0
// through d4 — and Sat Aug 01 is the whole ladder in one afternoon, one boss, in log order:
//
//   1. 13:07:45, raw 815345   — `You have entered The Plane of Hate - Solo.` The BASE INSTANCE:
//      the `- Solo` suffix with NO difficulty adjective after it. This is the shape the app used
//      to read as "tier 0, and we cannot say which of three worlds that means".
//   2. 13:23:07, raw 819632..819636 — the d0 kill. The killing blow is the charmed pet's
//      (`Maestro of Rancor has been slain by Innoruuk\`s Chosen!`); the `You gain experience!`
//      three lines above it is the credit join, so the kill is YOURS.
//   3. 13:38:00, raw 822348   — `... - Solo 1 (Awakened).`
//   4. 13:47:58, raw 825748..825752 — the d1 kill.
//   5. 13:57:08, raw 828266   — `... - Solo 2 (Adaptive).`
//   6. 14:18:07, raw 835548..835552 — the d2 kill.
//   7. 14:35:15, raw 839935   — `... - Solo 3 (Fused).`
//   8. 14:56:20, raw 847286..847293 — the d3 kill (the same span the toast fixture above cuts).
//   9. 15:33:26, raw 853620   — `... - Solo 4 (Refined).`
//  10. 16:02:37, raw 863975..863982 — the d4 kill.
//
// He leaves to The Oasis of Marr between instances (raw 822328, 828137, 839575, 853093), which is
// why the fixture can drop the ~48k intervening lines and still state the truth: for every kill
// here, the nearest PRECEDING `You have entered` is the instance line above it. Verified against
// the full log rather than assumed.
//
// Expected fold: ONE KillMap entry, count 5, credited 5, tiers {0,1,2,3,4} with one kill each —
// and, read as a lockout week, FIVE GREEN RUNGS.
slice(
  'bosstier-hate-ladder-aug01.log',
  [815345, 815345],
  [819632, 819636],
  [822348, 822348],
  [825748, 825752],
  [828266, 828266],
  [835548, 835552],
  [839935, 839935],
  [847286, 847293],
  [853620, 853620],
  [863975, 863982]
)

// THE OPEN WORLD, WHICH TAKES NOTHING OFF YOUR WEEK (JOS-166). The counterpart to the ladder
// above: the same zone, the same player, credited kills of a roster boss — and no instance, so no
// lockout exists to be spent. Four spans, in log order:
//
//   1. Mon Aug 03 22:45:48, raw 1205559 — `You have entered The Plane of Hate.` A bare zone name:
//      no `- Solo`, no ordinal, no adjective. THE OPEN WORLD.
//   2. Tue Aug 04 00:25:52, raw 1241344..1241348 — `You have slain Master of Spite!`, with the
//      `You gain experience! (1.880%)` line that credits it. This one lands BEFORE the Tue 08:00
//      Pacific reset, so it sits inside the same lockout week as the Aug 01 ladder run.
//   3. Tue Aug 04 20:19:56, raw 1296559 — the open world again, after the reset.
//   4. Tue Aug 04 20:44:38, raw 1303994..1304000 — a second credited Master of Spite kill, in the
//      NEW week.
//
// Expected fold: ONE KillMap entry, count 2, credited 2, and a SINGLE run under the open-world
// key — no difficulty key at all. Whichever week you stand in, its ladder is five grey rungs.
slice(
  'boss-open-world-hate.log',
  [1205559, 1205559],
  [1241344, 1241348],
  [1296559, 1296559],
  [1303994, 1304000]
)
