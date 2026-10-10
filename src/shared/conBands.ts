// conBands.ts — THE LEVEL DIFFERENCE AT WHICH THE GAME CHANGES ITS OWN VERDICT, MEASURED FROM
// 54 CONSIDERS THIS LOG PAIRED WITH A STATED OWN LEVEL (docs/plans/gear-progression-planner.md
// §2.1, §3, §6).
//
// THE QUESTION THAT MADE THIS FILE. The planner has to answer "will this mob be blue at 19?"
// before the player walks there, and nothing in the app could. `shared/considerFaction.ts`
// (`considerDifficultyShort`, ~line 92) states the reason outright: its difficulty table carries
// "deliberately NO numeric ordering, which the log does not state." That was an honest refusal
// against the log it was written for — Primitive's Freeport log has 357 consider lines and never
// states the reader's own level, so the phrases could be labelled but never RANKED.
//
// THIS FILE IS THE NEW CLAIM, AND IT IS NEW ONLY BECAUSE A NEW LOG STATES MORE. Drywrought's
// oggok log dings three times in plain text, so every consider after the first ding states BOTH
// levels and the ordering stops being an inference. conBands adds the ordering
// considerFaction.ts refused; considerFaction.ts is not wrong and does not change.
//
// ---------------------------------------------------------------------------
// THE MEASUREMENT (read-only sweep, 2026-08-15, eqlog_Drywrought_oggok.txt, 136,604 lines and
// still growing — the owner was playing). Evidence committed as tests/fixtures/w69-consider-
// pairs.log (77 lines, cut from raw 103,517 by tests/extract-consider-pairs.mjs); the table below
// is re-derived from that fixture on every run by tests/conBands.test.mts, not trusted from here.
//
//   104 lines match `-- <difficulty> (Lvl: N)$`; the parser turns all 104 into ConsiderEvents
//   (src/shared/logEvents.ts, faction split off by CONSIDER_FACTION_RUNGS), difficulty VERBATIM.
//   Own level is stated 3 times: 42 [Wed Aug 12 22:20:55], 43 [Fri Aug 14 22:33:15],
//   44 [Sat Aug 15 16:32:22]. 50 considers PRECEDE the first statement and are therefore
//   unpairable — they are censored from the diff table, never corrected into it (law 1: absent
//   is not zero). 54 pairs remain. Phrases are stemmed the way considerDifficultyShort stems
//   them: lowercased, whitespace collapsed, gendered he/she folded to it.
//
//   diff = mobLevel − myLevel        n    measured diffs          band
//   -------------------------------------------------------------------
//   You could probably win…          3    −39, −24, −22           trivial
//   You would probably win… though.  4    −14, −13                safe
//   looks kind of dangerous.        11    −11, −10, −9, −6        safe
//   …appears to be quite formidable.11    −5, −4, −3, −2          even
//   looks like quite a gamble.       1    0                       even
//   …would wipe the floor with you!  2    +1, +2                  risky
//   …your tombstone to say?         21    +7, +8, +27, +28        deadly
//   looks kind of risky… you might win.  1  −33                   CENSORED, see below
//
// SEVERITY ORDER IS THE DIFFS' TO DECIDE, NOT ENGLISH'S. The seven banded phrases are strictly
// monotonic by measured diff — probably-win < would-probably-win < dangerous < formidable <
// gamble < wipe-floor < tombstone — which puts "looks kind of DANGEROUS" (−11..−6) MILDER than
// "appears to be quite FORMIDABLE" (−5..−2). Intuition reads that backwards. The log does not.
//
// THE ONE CENSORED PHRASE. "looks kind of risky... you might win." was measured EXACTLY ONCE, at
// −33: `A froglok guardsman` stating Lvl 10 against own level 43, The Rathe Mountains,
// [Sat Aug 15 00:42:58 2026]. −33 sits INSIDE the range where every other sample says "You could
// probably win this fight." (−39 and −24 bracket it), so this line contradicts its neighbours and
// n=1 cannot outvote them. `bandOfPhrase` returns null for it — measured-once-contradictory,
// AWAITING SAMPLE. It is not folded into trivial to make the table look complete.
//
// TIERED (+N) ZONES FIT THE SAME TABLE — the load-bearing finding for the plan's §3. 24 of the
// 54 pairs were measured inside a tiered instance: `Temple of Cazic-Thule 4 (Refined)` ×19,
// `The Ruins of Old Guk 3 (Fused)` ×4, `Befallen 4 (Refined)` ×1; the other 30 came from
// `The Rathe Mountains` ×21, `New Sebilis Expedition` ×6, and one each from
// `Temple of Cazic-Thule`, `The Northern Desert of Ro` and a pre-first-zone-line consider. Every
// tiered pair lands in the band its phrase already claimed from base-zone pairs — dangerous reads
// −11..−6 inside Cazic 4 and −6 in The Rathe Mountains; formidable reads −5..−2 inside the tiers
// and −3 outside. So the con verdict tracks the STATED level even in a tiered zone; the tier does
// NOT shift the verdict away from the number on the line. What is still unstated, and what §3
// refuses to invent, is whether a tiered mob HITS harder than its stated level — con is a level
// comparison, and no line in any log here says anything about a +N power multiplier.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE REFUSES TO DO.
//   * It will not band a phrase it has no pair for. Three difficulty phrases that
//     considerFaction.ts's LABEL table knows — "looks like a reasonably safe opponent.",
//     "looks quite risky, but might be worth a try.", "looks kind of risky, but you might win." —
//     occur in the OTHER character's log and never beside a stated own level. `bandOfPhrase`
//     returns null for all three. A short label is a rename; a band is a measurement.
//   * It will not turn a band back into a level difference. The map is diff → band; band → diff
//     is not a function (a band is a range) and no caller may pretend otherwise.
//   * It will not claim a +N offset (see above, and §3).
//   * It does not learn at runtime. This is the SEED the plan asks for, pinned to a committed
//     fixture; a live re-learner is a later wave's problem and would need its own evidence.

/** The five bands the planner gates on. `safe`/`even` are the ask's "blue and white solo". */
export type ConBand = 'trivial' | 'safe' | 'even' | 'risky' | 'deadly'

/** One band's closed diff interval, in `mobLevel − myLevel`. */
export interface ConBandRange {
  band: ConBand
  minDiff: number
  maxDiff: number
}

/**
 * The seed table: contiguous, total, and gapless over every integer difference.
 *
 * TWO EDGES ARE MEASURED ON BOTH SIDES and are therefore exact:
 *   safe/even  at −6/−5  (dangerous measured at −6, formidable at −5)
 *   even/risky at  0/+1  (gamble measured at 0, wipe-floor at +1)
 *
 * TWO EDGES FALL IN AN UNSAMPLED GAP and are SPLITS, not observations:
 *   trivial/safe — nothing measured in −21..−15 (trivial's edge is −22, safe's is −14).
 *     Placed at the midpoint of the measured edges, (−22 + −14) / 2 = −18 exactly.
 *   risky/deadly — nothing measured in +3..+6 (risky's edge is +2, deadly's is +7).
 *     Midpoint is +4.5, so it is rounded TOWARD THE DEADLIER BAND: deadly starts at +5. A plan
 *     that calls a mob risky when it is deadly gets someone killed; the reverse wastes a pull.
 * Both splits move the day a pair lands in the gap. The test names them as splits so a future
 * measurement overturns a labelled guess rather than an assumed fact.
 *
 * THE OPEN ENDS ARE ±Infinity, not a large number. −99 would be a fabricated boundary implying
 * this table has an opinion about a 100-level gap; Infinity states exactly what is true, that
 * nothing bounds the ends. CONSEQUENCE: never JSON-serialize SEED_BANDS across IPC — Infinity
 * becomes null. Send the band, which is a string, or call `conBand` on the far side.
 */
export const SEED_BANDS: readonly ConBandRange[] = [
  { band: 'trivial', minDiff: -Infinity, maxDiff: -18 },
  { band: 'safe', minDiff: -17, maxDiff: -6 },
  { band: 'even', minDiff: -5, maxDiff: 0 },
  { band: 'risky', minDiff: 1, maxDiff: 4 },
  { band: 'deadly', minDiff: 5, maxDiff: Infinity }
]

/**
 * Stemmed difficulty phrase → band. Keys are the VERBATIM clauses this log states, stemmed; the
 * counts and diffs behind each entry are in the header's table.
 *
 * The two-phrases-one-band pairs are the fold the measurement forced, not tidying: dangerous and
 * would-probably-win both sit in −14..−6, formidable and gamble both sit in −5..0.
 */
const PHRASE_BANDS: Record<string, ConBand> = {
  'you could probably win this fight.': 'trivial',
  "you would probably win this fight... it's not certain though.": 'safe',
  'looks kind of dangerous.': 'safe',
  'it appears to be quite formidable.': 'even',
  'looks like quite a gamble.': 'even',
  'looks like it would wipe the floor with you!': 'risky',
  'what would you like your tombstone to say?': 'deadly'
}

/**
 * The SAME stem `considerDifficultyShort` applies — lowercase, collapse whitespace, fold the
 * gendered he/she variants onto the neuter key. Duplicated rather than shared because
 * considerFaction.ts keeps it private inside its own function and this module is not that file's
 * owner; tests/conBands.test.mts pins the two folds to the same phrase set, so a drift goes red.
 */
function stemPhrase(difficulty: string): string {
  return difficulty
    .trim()
    .toLowerCase()
    .replace(/\b(?:he|she)\b/g, 'it')
    .replace(/\s+/g, ' ')
}

/**
 * The game's own words → a band, or null when this log never paired that phrase with a stated
 * own level. Null is an ANSWER — "unstated here" — and callers render it as such; it is never a
 * cue to fall back on a neighbouring band.
 */
export function bandOfPhrase(difficulty: string): ConBand | null {
  return PHRASE_BANDS[stemPhrase(difficulty)] ?? null
}

/**
 * (my level, mob level) → band, from SEED_BANDS. Total over every integer pair, because the
 * table is gapless and open at both ends. The trailing return is unreachable for finite input and
 * exists so a NaN can only ever land on the cautious side.
 */
export function conBand(myLevel: number, mobLevel: number): ConBand {
  const diff = mobLevel - myLevel
  for (const range of SEED_BANDS) {
    if (diff >= range.minDiff && diff <= range.maxDiff) return range.band
  }
  return 'deadly'
}
