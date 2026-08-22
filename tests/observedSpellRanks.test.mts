// GOLDEN-WINDOW OBSERVED-SPELL-RANK TESTS — W46/W47 (JOS-446).
//
// METHODOLOGY (AGENTS.md): every window is a VERBATIM span of the user's real log, cut by
// tests/extract-spell-rank-fixtures.mjs through the shared scrub, hand-read line by line, and
// replayed through the REAL parser + ObservedSpellRanksModule with the REAL spell catalog behind
// the merge lane's gate. The expectations below are what a human counted in the fixture, not what
// the code produced.
//
//   W46  all three witnesses in one evening (Jul 30) — the merge run, the casts that follow it,
//        and one resist line that is the only witness for its own spell.
//   W47  the launch/epoch boundary — the wiped beta character's ranks must not survive.
//   plus w30-item-merge-run.log, REUSED as the negative control: a window of pure ` +N` item
//        merges must mint no spell rank at all.
//
// Plus a FULL-LOG tripwire that asserts INVARIANTS only (the log is live and grows; frozen counts
// rot): rank ranges, the union identity, the catalog gate on every merge-sourced row, the epoch
// floor, and the direction of the contamination the epoch removes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { EpochDetector, LAUNCH_MS } from '../src/main/log/epochDetector'
import { loadSpellDb } from '../src/main/data/spellDb'
import { ObservedSpellRanksModule } from '../src/main/modules/observedSpellRanks'
import { spellCanonKey } from '../src/main/log/parseCommon'
import { observedRankLabel, observedRankRow, type ObservedSpellRanksSnap } from '../src/shared/spellRanks'
import { romanRank, spellLineKey } from '../src/shared/spellLines'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOG =
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Primitive_freeport.txt'

// THE REAL CATALOG behind the merge lane's gate — the same probe wiring.ts installs
// (`spellDb.byKey.has`), so a test can never pass on a catalog the app does not ship.
const db = loadSpellDb()
const knownSpell = (key: string): boolean => db.byKey.has(key)

function readFixture(name: string): string[] {
  return readFileSync(join(HERE, 'fixtures', name), 'utf8').split(/\r?\n/).filter((l) => l.length > 0)
}

/**
 * Replay raw lines through the real parser + ObservedSpellRanksModule. With `withEpoch`, the REAL
 * EpochDetector runs exactly as index.ts's feeder wires it: the primary event is folded first,
 * then the synthesized `epoch` event is delivered (bus.emitDerived semantics).
 */
function replay(lines: string[], withEpoch = false): ObservedSpellRanksSnap {
  const mod = new ObservedSpellRanksModule({ knownSpell })
  mod.reset()
  const epoch = new EpochDetector()
  epoch.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    mod.onEvent(ev, false)
    if (withEpoch) {
      const epochEv = epoch.observe(ev)
      if (epochEv) mod.onEvent(epochEv, false)
    }
  }
  return mod.snapshot().state
}

// ─────────────────────────────────────────────────────────────────────────────
// W46 — the merge census. HAND-READ from tests/fixtures/w46-spell-rank-witnesses.log:
//   17:09:13-17:10:11  Shiftless Deeds  I, I, II, II, II, II, III ×8, IV      (15 merges)
//   17:10:25-17:10:32  Feedback         I, I, II                              (3)
//   17:12:29-17:12:34  Boon of the Garou I, I, II                             (3)
//   17:13:19-17:13:37  Clarity          I, I, II, II, II, II, III             (7)
//   17:14:07-17:14:25  Weakness         I, I, II, II, II, II, III             (7)
test('W46 merge census: every rank-suffixed merge is counted, and the HIGHEST rank wins', () => {
  const ranks = replay(readFixture('w46-spell-rank-witnesses.log'))

  // Shiftless Deeds: fifteen merge lines with REPEATED ranks — several scrolls climbing in
  // parallel, exactly the shape that makes "latest wins" wrong. The last line in the run is IV
  // and so is the max, but the eight IIIs prove the sequence is not one copy stepping up.
  const deeds = ranks['shiftless deeds']
  assert.ok(deeds, 'the Shiftless Deeds row exists')
  assert.equal(deeds.rank, 4, 'highest observed rank')
  assert.equal(deeds.mergedRank, 4, 'the merge family reached IV')
  assert.equal(deeds.merges, 15, 'fifteen rank-suffixed merge lines')
  assert.equal(deeds.name, 'Shiftless Deeds', 'display name keeps its raw base form, numeral off')
  assert.equal(deeds.key, 'shiftless deeds')

  assert.equal(ranks['feedback']?.rank, 2)
  assert.equal(ranks['feedback']?.merges, 3)
  assert.equal(ranks['boon of the garou']?.rank, 2)
  assert.equal(ranks['boon of the garou']?.merges, 3)
  assert.equal(ranks['clarity']?.rank, 3)
  assert.equal(ranks['clarity']?.merges, 7)
  assert.equal(ranks['weakness']?.rank, 3)
  assert.equal(ranks['weakness']?.merges, 7)

  // Ordering sanity: first observation precedes the last, and both are inside the window.
  for (const row of Object.values(ranks)) assert.ok(row.firstAt <= row.lastAt)
})

// ─────────────────────────────────────────────────────────────────────────────
// W46 — the two possession witnesses. HAND-READ from the same fixture:
//   17:16:32 / 17:19:39  You begin casting Boon of the Garou II.
//   17:19:52             You begin casting Shiftless Deeds IV.
//   17:21:22             You begin casting Lay on Hands IX.
//   21:55:33             A revenant resisted your Mesmerization III!
test('W46 cast and resist prove possession, including where no merge line exists', () => {
  const ranks = replay(readFixture('w46-spell-rank-witnesses.log'))

  // THE CASE THE MERGE LANE CANNOT SEE. `Lay on Hands` is merged NOWHERE in the whole log and the
  // wiki scrape carries no page for it at all — so it is proof of both halves of the design at
  // once: casts are the only witness for a rank levelled before logging began, and the catalog
  // gate is on the MERGE lane only (a gated cast lane would have dropped this row entirely).
  const loh = ranks['lay on hands']
  assert.ok(loh, 'a cast alone creates a row')
  assert.equal(loh.rank, 9)
  assert.equal(loh.castRank, 9)
  assert.equal(loh.mergedRank, undefined, 'no merge line was ever printed for it')
  assert.equal(loh.merges, 0)
  assert.equal(knownSpell('lay on hands'), false, 'and the catalog has no page for it')

  // THE RESIST LANE, alone in its window: the span deliberately starts after the cast-begin that
  // preceded this line, so nothing else in the fixture names Mesmerization.
  const mez = ranks['mesmerization']
  assert.ok(mez, '`<mob> resisted your <Spell> III!` is a statement that you hold rank III')
  assert.equal(mez.rank, 3)
  assert.equal(mez.castRank, 3)
  assert.equal(mez.merges, 0)

  // BOTH FAMILIES AGREEING is recorded as both, not as one: the row keeps the two halves apart so
  // a reader can still tell "you levelled this here" from "you were seen using it".
  const deeds = ranks['shiftless deeds']
  assert.ok(deeds && deeds.mergedRank === 4 && deeds.castRank === 4)
  const boon = ranks['boon of the garou']
  assert.ok(boon && boon.mergedRank === 2 && boon.castRank === 2)

  // Exactly seven lines were witnessed in this window. Everything else in 383 lines of combat,
  // loot, buffs and unsuffixed casts mints nothing: an unsuffixed name is the default state, not
  // an observation.
  assert.deepEqual(Object.keys(ranks).sort(), [
    'boon of the garou',
    'clarity',
    'feedback',
    'lay on hands',
    'mesmerization',
    'shiftless deeds',
    'weakness'
  ])
})

// ─────────────────────────────────────────────────────────────────────────────
// THE UNION RULE, pinned as a RULE rather than as a log claim.
//
// No spell in the owner's log has a cast rank ABOVE its merge rank (measured over all 2.3M lines:
// the only cast-side surprises are spells with no merge at all, which W46 covers with Lay on
// Hands). So the strict ordering — a cast at IV wins over a merge at III, and a LATER merge at III
// does not pull it back down — is asserted here by folding real line SHAPES in an order the log
// did not happen to print. Each line below is quoted verbatim from the real log with its raw line
// number; only their adjacency is composed.
test('the union takes the HIGHEST rank whichever witness saw it, and never lowers', () => {
  const mod = new ObservedSpellRanksModule({ knownSpell })
  mod.reset()
  const lines = [
    // raw 502993 — the merge family reaches III.
    '[Thu Jul 30 17:09:41 2026] You have successfully merged two items together to create a new item: Shiftless Deeds III',
    // raw 503320 — a cast at IV. Higher than anything merged so far: the union must move to 4.
    '[Thu Jul 30 17:19:52 2026] You begin casting Shiftless Deeds IV.',
    // raw 502995 — another merge at III. A lower observation LOWERS NOTHING (AGENTS.md carries the
    // owner's ruling that a rank never downgrades) but it does count as a merge.
    '[Thu Jul 30 17:09:45 2026] You have successfully merged two items together to create a new item: Shiftless Deeds III'
  ]
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    assert.ok(ev, raw)
    mod.onEvent(ev, false)
  }
  const row = mod.snapshot().state['shiftless deeds']
  assert.ok(row)
  assert.equal(row.rank, 4, 'cast IV beats merge III')
  assert.equal(row.castRank, 4)
  assert.equal(row.mergedRank, 3, 'the merge half is still honestly III')
  assert.equal(row.merges, 2, 'both merge lines counted')
})

// ─────────────────────────────────────────────────────────────────────────────
// THE CATALOG GATE, and the negative control. w30-item-merge-run.log is the ITEM-tier fixture,
// reused verbatim: seventeen ` +N` merges of Whitened Treant Fists, Umbral Platemail Bracer and
// Thelvorn, Blade of Light. None of them is a spell and none of them carries a numeral, so this
// module must produce an EMPTY map from a window itemTiers reads three rows out of.
test('an item merge is not a spell rank, and an ungated merge lane would be wrong', () => {
  assert.deepEqual(replay(readFixture('w30-item-merge-run.log')), {})

  // AND THE GATE IS LOAD-BEARING, not decorative: with no catalog injected, a merge naming
  // something that ends in a roman numeral is refused outright rather than minting a spell.
  const ungated = new ObservedSpellRanksModule()
  ungated.reset()
  const ev = parseEvent(
    '[Thu Jul 30 17:09:41 2026] You have successfully merged two items together to create a new item: Shiftless Deeds III',
    0
  )
  assert.ok(ev)
  ungated.onEvent(ev, false)
  assert.deepEqual(ungated.snapshot().state, {}, 'no catalog means no merge claim')
})

// ─────────────────────────────────────────────────────────────────────────────
// W47 — the epoch boundary. HAND-READ from tests/fixtures/w47-spell-rank-epoch.log:
//   BETA (Jul 19 08:51-08:52): Instrument of Nife I, II, II merged and cast at II;
//                              Vampiric Embrace I, II merged and cast at II.
//   CURRENT (Jul 30 17:08-17:10, the first at/after-launch event trips the epoch):
//                              Shiftless Deeds I..IV (15 merges), Feedback I, I, II.
test("W47 epoch: the wiped beta character's ranks do not survive the boundary", () => {
  const lines = readFixture('w47-spell-rank-epoch.log')

  // WITHOUT the epoch reset (the contaminated view): both beta lines are right there, and BOTH
  // witness families contributed to them.
  const contaminated = replay(lines, false)
  assert.equal(contaminated['instrument of nife']?.rank, 2)
  assert.equal(contaminated['instrument of nife']?.merges, 3)
  assert.equal(contaminated['instrument of nife']?.castRank, 2)
  assert.equal(contaminated['vampiric embrace']?.rank, 2)
  assert.equal(contaminated['vampiric embrace']?.merges, 2)

  // WITH the epoch reset: they are ABSENT — not rank 0, and not rank 1 either. Unknown is unknown
  // (law 1), and rank 1 would have been the worst possible default here: it is what every spell
  // reads as, so a zeroed row would be indistinguishable from a real un-upgraded one.
  const current = replay(lines, true)
  assert.equal(current['instrument of nife'], undefined)
  assert.ok(!('instrument of nife' in current), 'absent, never a zeroed row')
  assert.equal(current['vampiric embrace'], undefined)

  // The current character's own ranks survive intact.
  assert.equal(current['shiftless deeds']?.rank, 4)
  assert.equal(current['shiftless deeds']?.merges, 15)
  assert.equal(current['feedback']?.rank, 2)
  assert.deepEqual(Object.keys(current).sort(), ['feedback', 'shiftless deeds'])
})

// ─────────────────────────────────────────────────────────────────────────────
// THE CHIP'S WORDING — one function, two surfaces (the unlock row and the spell card), so a test
// here is a test of both. It reads a real fixture rather than a hand-built map.
test('the rank chip says `yours: <numeral>`, and says nothing at rank 1 or with no witness', () => {
  const ranks = replay(readFixture('w46-spell-rank-witnesses.log'))

  // The chip answers a BASE name (which is all the catalog ever spells) and a suffixed one alike:
  // the row is keyed by the line, so both reach it.
  assert.equal(observedRankLabel(ranks, 'Shiftless Deeds'), 'yours: IV')
  assert.equal(observedRankLabel(ranks, 'Shiftless Deeds II'), 'yours: IV')
  assert.equal(observedRankLabel(ranks, 'Lay on Hands'), 'yours: IX')
  // Case is folded exactly the way every other spell-name index folds it.
  assert.equal(observedRankLabel(ranks, 'clarity'), 'yours: III')

  // NO WITNESS ⇒ NO CHIP. Silence is not "rank 1".
  assert.equal(observedRankLabel(ranks, 'Complete Heal'), null)
  assert.equal(observedRankRow(ranks, 'Complete Heal'), undefined)
  assert.equal(observedRankLabel(null, 'Shiftless Deeds'), null, 'un-hydrated draws nothing')

  // A RANK-1 OBSERVATION IS REAL BUT NOT DRAWN: rank 1 is every spell's default, so the chip
  // would restate it. The row still exists and the next merge raises it.
  const mod = new ObservedSpellRanksModule({ knownSpell })
  mod.reset()
  const ev = parseEvent(
    '[Thu Jul 30 17:10:25 2026] You have successfully merged two items together to create a new item: Feedback I',
    0
  )
  assert.ok(ev)
  mod.onEvent(ev, false)
  const rank1 = mod.snapshot().state
  assert.equal(rank1['feedback']?.rank, 1, 'the row is kept')
  assert.equal(observedRankLabel(rank1, 'Feedback'), null, 'and draws nothing')
})

// ─────────────────────────────────────────────────────────────────────────────
// THE TWO RANK FOLDS AGREE. Main keys rows with the parser's `spellCanonKey`; the renderer reads
// them with shared/spellLines.ts's `spellLineKey`, which mirrors it because shared/ may not reach
// into main. A drift between the two would make every chip silently blank, so pin them over every
// name the fixtures actually contain rather than over invented ones.
test('the main-side and shared-side line folds agree on every real spell name in the fixtures', () => {
  const names = new Set<string>()
  for (const f of ['w46-spell-rank-witnesses.log', 'w47-spell-rank-epoch.log']) {
    for (const raw of readFixture(f)) {
      const m =
        /new item: (.+)$/.exec(raw) ??
        /You begin (?:casting|singing) (.+)\.$/.exec(raw) ??
        /resisted your (.+)!$/.exec(raw)
      if (m) names.add(m[1])
    }
  }
  assert.ok(names.size >= 20, `sampled ${String(names.size)} distinct spell names`)
  for (const n of names) assert.equal(spellCanonKey(n), spellLineKey(n), n)
})

// ─────────────────────────────────────────────────────────────────────────────
// FULL-LOG TRIPWIRE — INVARIANTS ONLY. The real log is live and grows every session, so there are
// no fixed counts here: every assertion is either a structural identity or a direction. Skipped
// when the real log is absent (CI).
test('full-log replay: observed ranks are structurally sound and epoch-clean', { skip: !existsSync(LOG) }, () => {
  const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)
  const contaminated = replay(lines, false)
  const current = replay(lines, true)

  const rows = Object.values(current)
  assert.ok(rows.length > 0, 'the current character has ranked at least one spell')

  for (const row of rows) {
    // Range: the log prints I-X and nothing else, so a rank outside it means the numeral table and
    // the parser have drifted apart.
    assert.ok(row.rank >= 1 && row.rank <= 10, `${row.name} rank ${String(row.rank)} in range`)
    // THE UNION IDENTITY — the load-bearing one: `rank` is exactly the max of the two witnesses,
    // and neither half may exceed it.
    assert.equal(row.rank, Math.max(row.mergedRank ?? 0, row.castRank ?? 0), `${row.name}: union`)
    // A row with no merge is a cast-only row and must say so, and vice versa.
    assert.equal(row.merges === 0, row.mergedRank === undefined, `${row.name}: merges vs mergedRank`)
    // Canonicalization: the key IS the folded name, and the display name never keeps a numeral.
    assert.equal(row.key, spellCanonKey(row.name), `${row.name} key is canonical`)
    assert.equal(romanRank(row.rank).length > 0, true)
    assert.ok(row.firstAt <= row.lastAt)
    // THE CATALOG GATE, stated over the whole log: every row a MERGE contributed to joins the
    // committed spell catalog. A cast-only row need not (Lay on Hands does not).
    if (row.mergedRank !== undefined) assert.ok(knownSpell(row.key), `${row.name} is a catalogued spell`)
    // THE EPOCH FLOOR — nothing the wiped character did can appear.
    assert.ok(row.firstAt >= LAUNCH_MS, `${row.name} first observed after the launch boundary`)
  }

  // CONTAMINATION DIRECTION: the epoch can only ever REMOVE evidence, never add it.
  for (const row of rows) {
    const dirty = contaminated[row.key]
    assert.ok(dirty, `${row.name} also present without the epoch reset`)
    assert.ok(dirty.rank >= row.rank, `${row.name}: the epoch never raises a rank`)
    assert.ok(dirty.merges >= row.merges)
  }
  const betaOnly = Object.values(contaminated).filter((r) => r.lastAt < LAUNCH_MS)
  assert.ok(betaOnly.length > 0, 'the beta character did rank spells (the wipe is real)')
  for (const r of betaOnly) {
    assert.equal(current[r.key], undefined, `${r.name} was ranked ONLY pre-launch and must not survive`)
  }

  // AND THE STREAM IS BEING READ AT ALL: the owner's log carries both witness families in volume,
  // so a fold that produced only one kind of row would mean a lane had quietly stopped matching.
  assert.ok(rows.some((r) => r.merges > 0), 'merge-witnessed rows exist')
  assert.ok(rows.some((r) => r.castRank !== undefined), 'cast-witnessed rows exist')
})
