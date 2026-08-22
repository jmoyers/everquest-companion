// PER-ABILITY AA LEDGER TESTS.
//
// The ledger (src/shared/aaLedger.ts) regroups the flat AA purchase list into per-ability
// LADDERS. It is not a new derivation: it applies the SAME latest-purchase-per-(ability, rank)
// dedupe that `computeAAAccounting` applies, so the two must agree exactly —
//   Σ rows.invested   == acct.allocated
//   Σ rows.paidRanks  == acct.boughtCount
// and that pair of equalities is what these tests exist to defend. If the ledger and the hero
// card could ever disagree, the panel's footer ("the same total as the N AA points spent above")
// would be a lie, which is the one failure mode a decomposition of an identity can have.
//
// MEASURED on the real log (read-only, 1.35M lines, 2026-08-05):
//   post-epoch  125 purchase lines → 50 abilities, allocated 341, 91 bought ranks, 34 granted,
//               0 re-buys and 0 unlogged rungs (the respecs are all pre-epoch, on the beta
//               character), ladder depths 1/2/3/4/5/6/7/10 rungs.
//   no-epoch    140 lines → 54 abilities, allocated 354, 96 bought ranks; this is where the
//               respec + partial-ladder evidence lives: Mnemonic Retention (5 re-buys),
//               Lay on Hands (2), Symphonic Aura: Enabled (1), and three abilities whose lower
//               rungs never appear in the log at all (Symphonic Aura: Disabled first appears at
//               rank 9). Both passes are asserted — the second is the only place the badges'
//               inputs are non-zero on real data.
// Frozen-numbers law: the live log only grows, so magnitudes are asserted as FLOORS and the
// load-bearing claims as IDENTITIES.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { EpochDetector } from '../src/main/log/epochDetector'
import { LevelingModule } from '../src/main/modules/leveling'
import { computeAAAccounting } from '../src/shared/aa'
import { aaBaseName, aaLedger, aaLedgerSummary } from '../src/shared/aaLedger'
import type { LevelingSnap } from '../src/shared/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOG =
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Primitive_freeport.txt'

/** Replay raw lines through the real parser + LevelingModule, optionally with the epoch reset. */
function replayLeveling(lines: string[], withEpoch: boolean): LevelingSnap {
  const mod = new LevelingModule()
  mod.reset()
  const epoch = new EpochDetector()
  epoch.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    mod.onEvent(ev)
    if (!withEpoch) continue
    // Exactly index.ts's emitDerived ordering: the primary event is folded, THEN the derived
    // epoch reset lands — so the boundary event itself is wiped with everything before it.
    const e = epoch.observe(ev)
    if (e) mod.onEvent(e)
  }
  return mod.snapshot().state
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIT — the family key. The improved form's `ability` carries its own rank (which is what makes
// that string a valid dedupe key in aa.ts); the quoted rank-1 form does not.
test('aaBaseName strips the improved form rank suffix and leaves the quoted form alone', () => {
  assert.equal(aaBaseName({ ability: 'Innate Regeneration 7', rank: 7 }), 'Innate Regeneration')
  assert.equal(aaBaseName({ ability: 'Innate Regeneration' }), 'Innate Regeneration')
  // Rank ≥10 (Lay on Hands reaches 10 on the real log) must strip two digits, not one.
  assert.equal(aaBaseName({ ability: 'Lay on Hands 10', rank: 10 }), 'Lay on Hands')
  // A name that ENDS in a number but was not improved keeps every character.
  assert.equal(aaBaseName({ ability: 'Symphonic Aura: Disabled' }), 'Symphonic Aura: Disabled')
})

// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN WINDOW — the Mnemonic Retention respec fixture (the same one aaAccounting.test.mts
// pins). One ability, ranks 1–6, ranks 1–5 purchased TWICE across the respec.
test('golden window: the respec fixture is ONE ability with a 6-rung ladder and 5 re-buys', () => {
  const lines = readFileSync(join(HERE, 'fixtures', 'aa-mnemonic-respec.log'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
  const snap = replayLeveling(lines, false)
  const rows = aaLedger(snap.aaSpends)
  const acct = computeAAAccounting(snap.aaGains, snap.aaSpends)

  assert.equal(rows.length, 1, 'eleven purchase lines are one ability')
  const [r] = rows
  assert.equal(r.name, 'Mnemonic Retention')
  assert.equal(r.topRank, 6)
  assert.equal(r.ranks.length, 6, 'six distinct rungs')
  assert.deepEqual(r.ranks.map((x) => x.cost), [1, 1, 2, 2, 3, 3], 'latest cost per rung, ascending')
  assert.equal(r.invested, 12, 'the ladder costs 12 — NOT the raw 21 Σ of every line')
  assert.equal(r.invested, acct.allocated, 'the row IS the allocation identity for this ability')
  assert.equal(r.paidRanks, 6)
  assert.equal(r.autoRanks, 0)
  assert.equal(r.rebuys, 5, 'ranks 1–5 were each purchased a second time after the respec')
  assert.deepEqual(r.unlogged, [], 'every rung below the top is present')

  const sum = aaLedgerSummary(rows)
  assert.equal(sum.rebought, 1, 'one ability carries re-purchase evidence')
  assert.equal(sum.partial, 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// FULL-LOG REPLAY — the identity, both with and without the character epoch.
test('full-log replay: the ledger sums to the accounting identity, exactly', {
  skip: !existsSync(LOG)
}, () => {
  const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)

  for (const withEpoch of [true, false]) {
    const snap = replayLeveling(lines, withEpoch)
    const acct = computeAAAccounting(snap.aaGains, snap.aaSpends)
    const rows = aaLedger(snap.aaSpends)
    const sum = aaLedgerSummary(rows)
    const where = withEpoch ? 'post-epoch' : 'no-epoch'

    // THE load-bearing claims: the decomposition is the same identity.
    assert.equal(sum.invested, acct.allocated, `${where}: Σ invested == allocated`)
    assert.equal(sum.paidRanks, acct.boughtCount, `${where}: Σ paid ranks == boughtCount`)
    assert.equal(sum.abilities, rows.length)

    // Grouping actually happened: fewer abilities than purchase lines, and ladders exist.
    assert.ok(rows.length < snap.aaSpends.length, `${where}: purchase lines collapse into ladders`)
    assert.ok(
      rows.some((r) => r.ranks.length >= 7),
      `${where}: at least one deep ladder (Innate Regeneration reaches rank 7)`
    )

    // Per-row internal consistency, on every row.
    for (const r of rows) {
      assert.equal(r.paidRanks + r.autoRanks, r.ranks.length, `${r.name}: every rung is paid or granted`)
      assert.equal(
        r.invested,
        r.ranks.reduce((n, x) => n + x.cost, 0),
        `${r.name}: invested is the Σ of its rungs (granted rungs cost 0)`
      )
      assert.equal(r.topRank, r.ranks[r.ranks.length - 1].rank, `${r.name}: rungs are rank-ascending`)
      assert.ok(!r.unlogged.includes(r.topRank), `${r.name}: the top rank is never itself unlogged`)
    }

    // Sorted by points invested, descending — the panel renders this order verbatim.
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].invested >= rows[i].invested, `${where}: rows descend by invested`)
    }
  }
})

// The badge inputs are only non-zero on the pre-epoch (beta-contaminated) pass — that is where
// the respec and the partial ladders live. Pinned as floors: the live log only grows.
test('full-log replay: the honesty badges have real evidence behind them', {
  skip: !existsSync(LOG)
}, () => {
  const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)
  const rows = aaLedger(replayLeveling(lines, false).aaSpends)
  const sum = aaLedgerSummary(rows)

  assert.ok(sum.abilities >= 54, `abilities (${String(sum.abilities)}) >= 54`)
  assert.ok(sum.invested >= 354, `invested (${String(sum.invested)}) >= 354`)
  assert.ok(sum.autoRanks >= 36, `granted rungs (${String(sum.autoRanks)}) >= 36`)
  assert.ok(sum.rebought >= 3, `abilities with re-buys (${String(sum.rebought)}) >= 3`)
  // `partial` is the one summary figure that legitimately SHRINKS as the live log grows — an
  // unlogged rung stops being unlogged the day its purchase line finally appears (it rotted from
  // 3 to 2 mid-session, 2026-08-21, while the owner played). So its floor is the badge's own
  // existence claim, not a magnitude: at least one ability still demonstrates the label on real
  // data (the Symphonic pin below is the named witness).
  assert.ok(sum.partial >= 1, `abilities with unlogged rungs (${String(sum.partial)}) >= 1`)

  // `Symphonic Aura: Disabled` first appeared at rank 9 with rungs 1–8 nowhere in 1.35M lines —
  // the exact case the "unlogged" label exists for (law 6: the log cannot say how they came).
  // Re-derived 2026-08-21: the live log grew a lower rung mid-session, so the frozen [1..8] rotted.
  // Per this file's own law the pin is the INVARIANT, not the list: rungs below a top that the log
  // never showed stay labelled unlogged, every one of them genuinely below the top, ascending.
  const sym = rows.find((r) => r.name === 'Symphonic Aura: Disabled')
  assert.ok(sym, 'the partial-ladder ability is present')
  assert.ok(sym.topRank >= 9, `topRank (${String(sym.topRank)}) >= 9 — the log only grows`)
  assert.ok(sym.unlogged.length >= 1, 'the ladder is still partial — some rung below the top is unlogged')
  assert.ok(
    sym.unlogged.every((n) => n >= 1 && n < sym.topRank),
    'every unlogged rung sits strictly below the top'
  )
  for (let i = 1; i < sym.unlogged.length; i++) {
    assert.ok(sym.unlogged[i - 1] < sym.unlogged[i], 'unlogged rungs ascend')
  }

  // Lay on Hands is the fully-granted 10-rung ladder: 10 rungs, 0 points.
  const loh = rows.find((r) => r.name === 'Lay on Hands')
  assert.ok(loh, 'the fully auto-granted ability is present')
  assert.equal(loh.invested, 0, 'a granted ladder costs nothing and must never be priced')
  assert.equal(loh.paidRanks, 0)
  assert.ok(loh.autoRanks >= 10, `granted rungs (${String(loh.autoRanks)}) >= 10`)
})
