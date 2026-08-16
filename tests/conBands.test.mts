// conBands.test.mts — THE DIFF TABLE IS RE-DERIVED FROM THE FIXTURE ON EVERY RUN, NEVER READ
// OUT OF THE MODULE IT CHECKS (docs/plans/gear-progression-planner.md §2.1, §6).
//
// THE DEFECT THIS SUITE EXISTS TO PREVENT. `src/shared/conBands.ts` is the first place in this
// app that claims a NUMERIC ordering over the game's difficulty phrases — a thing
// `shared/considerFaction.ts` deliberately refused to claim because its log never stated the
// reader's own level. A seed table like that rots in exactly one way: someone widens a band to
// make a screenshot look right, and the "measurement" in the header quietly stops describing the
// evidence. So nothing here trusts the header. Every test below folds
// tests/fixtures/w69-consider-pairs.log through the REAL parser, re-pairs each consider against
// the own-level series the fixture's own dings state, and re-computes the table from scratch.
// The module is then checked AGAINST that recomputation.
//
// THREE LAYERS:
//   1. THE FIXTURE'S OWN SHAPE — line counts, ding series, and the law that every consider in
//      this window is pairable (the window starts at the first ding for exactly that reason).
//   2. THE GOLDEN TABLE — per-phrase n / min / max / distinct diffs, plus the VERBATIM spellings.
//      A difficulty phrase the log has never printed before turns this red, which is the
//      awaiting-sample law: a new phrase is new evidence and must be looked at by a human, not
//      absorbed silently into a neighbouring band.
//   3. THE MODULE'S CONTRACT — bandOfPhrase over every phrase the fixture states, conBand at the
//      two MEASURED boundary edges and the two GAP-SPLIT edges, and the agreement test that ties
//      the two exports together: for every pair the log states, the phrase's band and the diff's
//      band must be the same band.
//
// Run: `node --import tsx --test tests/conBands.test.mts` (or `npm test` for the whole suite).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { considerDifficultyShort } from '../src/shared/logEvents'
import { SEED_BANDS, bandOfPhrase, conBand } from '../src/shared/conBands'
import type { ConBand } from '../src/shared/conBands'
import { readFixture } from './harness.mts'

const FIXTURE = 'w69-consider-pairs.log'

/** One consider paired with the own level in force when it was printed. */
interface Pair {
  /** the difficulty clause exactly as the log printed it */
  verbatim: string
  /** lowercased, whitespace-collapsed, he/she folded to it */
  stem: string
  /** mobLevel − myLevel, the only quantity conBands claims anything about */
  diff: number
  myLevel: number
  mobLevel: number
  mob: string
  /** the zone in force, or null before the window's first zone line */
  zone: string | null
}

/** The SAME stem conBands.ts and considerDifficultyShort apply — re-implemented, not imported,
 *  so this file measures the fold rather than inheriting it. */
function stem(difficulty: string): string {
  return difficulty.trim().toLowerCase().replace(/\b(?:he|she)\b/g, 'it').replace(/\s+/g, ' ')
}

/** `Befallen 4 (Refined)` / `The Ruins of Old Guk 3 (Fused)` — a tiered instance, not a base zone. */
function isTiered(zone: string | null): boolean {
  return zone != null && / \d+ \([A-Za-z]+\)$/.test(zone)
}

interface Replay {
  pairs: Pair[]
  dings: number[]
  zones: number
  considers: number
  /** considers seen before any own level was stated — must be 0 in THIS window */
  unpaired: number
}

/** Fold the fixture the way the app folds the live tail: dings set own level, zone lines set
 *  place, considers pair against whatever the log last stated. */
function replay(lines: string[]): Replay {
  const out: Replay = { pairs: [], dings: [], zones: 0, considers: 0, unpaired: 0 }
  let myLevel: number | null = null
  let zone: string | null = null
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    assert.ok(ev, `every fixture line parses: ${raw}`)
    if (ev.kind === 'level') {
      myLevel = ev.level
      out.dings.push(ev.level)
    } else if (ev.kind === 'zone') {
      zone = ev.zone
      out.zones++
    } else {
      assert.equal(ev.kind, 'consider', `the window keeps three families only: ${raw}`)
      if (ev.kind !== 'consider') continue
      out.considers++
      if (myLevel == null) {
        out.unpaired++
        continue
      }
      out.pairs.push({
        verbatim: ev.difficulty,
        stem: stem(ev.difficulty),
        diff: ev.level - myLevel,
        myLevel,
        mobLevel: ev.level,
        mob: ev.mob,
        zone
      })
    }
  }
  return out
}

const world = replay(readFixture(FIXTURE))

/** Per-phrase fold: how many, and which distinct diffs, ascending. */
function tableOf(pairs: readonly Pair[]): Record<string, { n: number; diffs: number[] }> {
  const out: Record<string, { n: number; diffs: number[] }> = {}
  for (const p of pairs) {
    const row = (out[p.stem] ??= { n: 0, diffs: [] })
    row.n++
    if (!row.diffs.includes(p.diff)) row.diffs.push(p.diff)
  }
  for (const row of Object.values(out)) row.diffs.sort((a, b) => a - b)
  return out
}

// =============================================================================
// 1. THE FIXTURE'S OWN SHAPE
// =============================================================================

test('W69: the window opens on the first ding, so EVERY consider in it is pairable', () => {
  // 77 kept lines out of raw 103,517 (extract-consider-pairs.mjs, 2026-08-15).
  assert.equal(readFixture(FIXTURE).length, 77)
  assert.equal(world.considers, 54)
  assert.equal(world.zones, 20)
  // Three dings and no fourth: 42 → 43 → 44, the only own-level statements the scrub leaves.
  // The self `/who` row that ALSO stated 42 is dropped (SELF_NAME is Primitive, this is
  // Drywrought) and is not missed — the Aug 12 ding already stated it.
  assert.deepEqual(world.dings, [42, 43, 44])
  // The whole point of the window bound. The 50 considers BEFORE the first ding stay in the log,
  // contribute to the phrase census, and contribute NOTHING to the diff table.
  assert.equal(world.unpaired, 0)
  assert.equal(world.pairs.length, 54)
})

// =============================================================================
// 2. THE GOLDEN TABLE — re-derived here, pinned here
// =============================================================================

test('W69: the measured diff table (a NEW phrase or a wider spread turns this red)', () => {
  assert.deepEqual(tableOf(world.pairs), {
    'you could probably win this fight.': { n: 3, diffs: [-39, -24, -22] },
    'looks kind of risky... you might win.': { n: 1, diffs: [-33] },
    "you would probably win this fight... it's not certain though.": { n: 4, diffs: [-14, -13] },
    'looks kind of dangerous.': { n: 11, diffs: [-11, -10, -9, -6] },
    'it appears to be quite formidable.': { n: 11, diffs: [-5, -4, -3, -2] },
    'looks like quite a gamble.': { n: 1, diffs: [0] },
    'looks like it would wipe the floor with you!': { n: 2, diffs: [1, 2] },
    'what would you like your tombstone to say?': { n: 21, diffs: [7, 8, 27, 28] }
  })
})

test('W69: the VERBATIM spellings, including the two gendered clauses the parser carries through', () => {
  assert.deepEqual([...new Set(world.pairs.map((p) => p.verbatim))].sort(), [
    'You could probably win this fight.',
    "You would probably win this fight... it's not certain though.",
    'he appears to be quite formidable.',
    'it appears to be quite formidable.',
    'looks kind of dangerous.',
    'looks kind of risky... you might win.',
    'looks like it would wipe the floor with you!',
    'looks like quite a gamble.',
    'looks like she would wipe the floor with you!',
    'she appears to be quite formidable.',
    'what would you like your tombstone to say?'
  ])
  // Ten spellings, seven stems: he/she/it fold in both of the gendered clauses.
  assert.equal(Object.keys(tableOf(world.pairs)).length, 8)
})

test('W69: severity is MONOTONIC by measured diff, and English intuition inverts one rung', () => {
  const table = tableOf(world.pairs)
  const banded = Object.entries(table).filter(([s]) => bandOfPhrase(s) != null)
  const order = banded
    .map(([s, r]) => ({ s, min: Math.min(...r.diffs), max: Math.max(...r.diffs) }))
    .sort((a, b) => a.min - b.min)
  // No two banded phrases overlap: each phrase's whole spread sits above the previous one's.
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i].min > order[i - 1].max, `${order[i - 1].s} then ${order[i].s}`)
  }
  assert.deepEqual(order.map((o) => o.s), [
    'you could probably win this fight.',
    "you would probably win this fight... it's not certain though.",
    'looks kind of dangerous.',
    'it appears to be quite formidable.',
    'looks like quite a gamble.',
    'looks like it would wipe the floor with you!',
    'what would you like your tombstone to say?'
  ])
  // The rung intuition gets backwards: "dangerous" is MILDER than "formidable" in this log.
  assert.ok(Math.max(...table['looks kind of dangerous.'].diffs) < Math.min(...table['it appears to be quite formidable.'].diffs))
})

// =============================================================================
// 3. THE MODULE'S CONTRACT
// =============================================================================

test('bandOfPhrase: every phrase the fixture states, in the spelling the log used', () => {
  const expected: Record<string, ConBand | null> = {
    'You could probably win this fight.': 'trivial',
    "You would probably win this fight... it's not certain though.": 'safe',
    'looks kind of dangerous.': 'safe',
    'it appears to be quite formidable.': 'even',
    'he appears to be quite formidable.': 'even',
    'she appears to be quite formidable.': 'even',
    'looks like quite a gamble.': 'even',
    'looks like it would wipe the floor with you!': 'risky',
    'looks like she would wipe the floor with you!': 'risky',
    'what would you like your tombstone to say?': 'deadly',
    // MEASURED ONCE, AT −33, CONTRADICTING ITS NEIGHBOURS (−39 and −24 both read "could
    // probably win"). n=1 does not outvote them, so this stays unbanded until a second sample.
    'looks kind of risky... you might win.': null
  }
  for (const [phrase, band] of Object.entries(expected)) {
    assert.equal(bandOfPhrase(phrase), band, phrase)
  }
  // Every verbatim spelling the fixture contains is covered by the table above.
  for (const p of world.pairs) assert.ok(p.verbatim in expected, p.verbatim)
})

test('bandOfPhrase: a label is not a band — the phrases with no PAIR stay null', () => {
  // These three DO have a short label in considerFaction.ts (they occur in Primitive's log),
  // and they are still null here, because no line in THIS log printed one beside a stated own
  // level. Law 1: absent is not zero.
  for (const phrase of [
    'looks like a reasonably safe opponent.',
    'looks quite risky, but might be worth a try.',
    'looks kind of risky, but you might win.'
  ]) {
    assert.ok(considerDifficultyShort(phrase), `${phrase} is a KNOWN phrase`)
    assert.equal(bandOfPhrase(phrase), null, `${phrase} is an UNMEASURED phrase`)
  }
  // And a clause EQ has never printed at all is null too, never a nearest guess.
  assert.equal(bandOfPhrase('looks like an even fight.'), null)
  assert.equal(bandOfPhrase(''), null)
})

test('bandOfPhrase and considerDifficultyShort fold the SAME spellings (a drift tripwire)', () => {
  // The two modules keep private copies of one stem rule. If either fold changes, a spelling
  // one accepts and the other rejects lands here rather than in a user's plan.
  for (const p of world.pairs) {
    if (bandOfPhrase(p.verbatim) == null) continue
    assert.ok(considerDifficultyShort(p.verbatim), p.verbatim)
  }
})

test('SEED_BANDS: contiguous, gapless, open at both ends, in severity order', () => {
  assert.deepEqual(SEED_BANDS.map((r) => r.band), ['trivial', 'safe', 'even', 'risky', 'deadly'])
  assert.equal(SEED_BANDS[0].minDiff, -Infinity)
  assert.equal(SEED_BANDS[SEED_BANDS.length - 1].maxDiff, Infinity)
  for (let i = 1; i < SEED_BANDS.length; i++) {
    assert.equal(SEED_BANDS[i].minDiff, SEED_BANDS[i - 1].maxDiff + 1, `gap before ${SEED_BANDS[i].band}`)
  }
  // Total over every difference a level-1..70 world can produce, and nothing else in between.
  for (let diff = -80; diff <= 80; diff++) {
    const hits = SEED_BANDS.filter((r) => diff >= r.minDiff && diff <= r.maxDiff)
    assert.equal(hits.length, 1, `diff ${diff}`)
    assert.equal(conBand(40, 40 + diff), hits[0].band, `diff ${diff}`)
  }
})

test('conBand: the two MEASURED edges are exact (both sides observed)', () => {
  // safe/even at −6/−5: "dangerous" was measured at −6, "formidable" at −5. Not a choice.
  assert.equal(conBand(44, 38), 'safe') //  −6, Avatar of Fear, Cazic 4 [Sat Aug 15 17:19:41]
  assert.equal(conBand(43, 38), 'even') //  −5, Avatar of Fear, Cazic 4 [Sat Aug 15 12:39:04]
  // even/risky at 0/+1: "gamble" was measured at 0, "wipe the floor" at +1.
  assert.equal(conBand(43, 43), 'even') //   0, Malkil, Old Guk 3 [Fri Aug 14 22:42:45]
  assert.equal(conBand(43, 44), 'risky') // +1, Malkil, The Rathe Mountains [Fri Aug 14 23:51:43]
})

test('conBand: the two GAP-SPLIT edges are labelled guesses, and are pinned as such', () => {
  // trivial/safe — NOTHING measured in −21..−15. Split at the midpoint of the measured edges
  // (−22 and −14), which is exactly −18. Every diff in the gap resolves, none of them is evidence.
  assert.equal(conBand(40, 40 - 22), 'trivial') // measured edge
  assert.equal(conBand(40, 40 - 18), 'trivial') // split
  assert.equal(conBand(40, 40 - 17), 'safe') //    split
  assert.equal(conBand(40, 40 - 14), 'safe') //    measured edge
  // risky/deadly — NOTHING measured in +3..+6. Midpoint is +4.5, rounded TOWARD DEADLY.
  assert.equal(conBand(40, 42), 'risky') //  measured edge
  assert.equal(conBand(40, 44), 'risky') //  split
  assert.equal(conBand(40, 45), 'deadly') // split
  assert.equal(conBand(40, 47), 'deadly') // measured edge
})

test('AGREEMENT: for every pair the log states, phrase-band and diff-band are the same band', () => {
  let checked = 0
  for (const p of world.pairs) {
    const byPhrase = bandOfPhrase(p.verbatim)
    if (byPhrase == null) continue // the censored outlier, and only it
    assert.equal(
      conBand(p.myLevel, p.mobLevel),
      byPhrase,
      `${p.mob} Lvl ${p.mobLevel} vs own ${p.myLevel} (diff ${p.diff}): "${p.verbatim}"`
    )
    checked++
  }
  assert.equal(checked, 53) // 54 pairs less the one censored phrase
})

test('AGREEMENT HOLDS INSIDE TIERED (+N) ZONES TOO — the plan §3 finding', () => {
  const tiered = world.pairs.filter((p) => isTiered(p.zone))
  const base = world.pairs.filter((p) => !isTiered(p.zone))
  assert.equal(tiered.length, 24)
  assert.equal(base.length, 30)
  assert.deepEqual([...new Set(tiered.map((p) => p.zone))].sort(), [
    'Befallen 4 (Refined)',
    'Temple of Cazic-Thule 4 (Refined)',
    'The Ruins of Old Guk 3 (Fused)'
  ])
  // The tier does NOT shift the verdict off the stated level: a tiered pair bands exactly as its
  // phrase already bands from base-zone evidence. (What a tier does to a mob's POWER is still
  // unstated anywhere, and conBands refuses to guess it.)
  for (const p of tiered) {
    const byPhrase = bandOfPhrase(p.verbatim)
    if (byPhrase == null) continue
    assert.equal(conBand(p.myLevel, p.mobLevel), byPhrase, `${p.mob} @ ${p.zone}`)
  }
  // The overlap that makes the claim testable rather than vacuous: two phrases occur on BOTH
  // sides of the tiered/base split, and their spreads do not separate.
  const spread = (ps: Pair[], s: string): number[] => ps.filter((p) => p.stem === s).map((p) => p.diff)
  assert.deepEqual(spread(tiered, 'looks kind of dangerous.').sort((a, b) => a - b), [-11, -10, -10, -10, -10, -10, -9, -6, -6, -6])
  assert.deepEqual(spread(base, 'looks kind of dangerous.'), [-6])
  assert.deepEqual(spread(tiered, 'it appears to be quite formidable.').sort((a, b) => a - b), [-5, -5, -5, -4, -4, -4, -4, -2])
  assert.deepEqual(spread(base, 'it appears to be quite formidable.'), [-3, -3, -3])
})
