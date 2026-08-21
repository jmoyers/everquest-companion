// JOS-213 — PACIFY AND THE CALM LINE REPORT TO THE DEBUFF OVERLAY.
//
// Report 01KZSDPV3NV8NWK2GF01MCQMK3 quotes three of its own lines — `You begin casting Pacify IV.`
// / `Your Nisch Mas Ilkvel (Exaltation) flickers with a pale light.` / `an icy terror looks less
// aggressive.` — and asks for the timer to report to the debuff overlay. The owner's log prints
// the identical shape 206 times over 55 distinct subjects, so the fixtures here are HIS bytes and
// nothing is injected. The extractor (tests/extract-calm-fixtures.mjs) carries the hand-read
// timelines and why those two windows and not the others.
//
// WHY IT LANDED IN THE WRONG WINDOW. The calm line is `Beneficial` in the committed spells.json,
// so `cls`/`kind` is 'buff' and the JOS-119 split filed it on the buffs surface beside the
// player's own Clarity — while the thing they are actually watching is how long that giant stays
// calm, which is a mob-state timer like every other one on the debuffs surface.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND SINCE JOS-413 THE SPELL IS A DEBUFF, WHICH CHANGES THE ANSWER TO ONE ASSERTION HERE AND
// NOTHING ELSE IN THE FILE.
//
// Report 6BM6Y5 said the same inconsistency from the other side: Pacify reaches the debuffs OVERLAY
// and the Buffs SECTION still lists it under Buffs, because JOS-213 deliberately left `kind` alone
// and routed on a second, orthogonal fact. The owner ruled (2026-08-19) that a lull IS a debuff, so
// `spellCorrectionsPolarity.ts` writes `spellType: Detrimental` into the registry and `cls`/`kind`
// are 'debuff' now — the row reaches this window on its KIND, the way every other mob timer does.
//
// THE ROUTING FACT AND ITS AUDIT STAY, and this file is why. `calmsTarget` is still derived, still
// true for the family, and still the thing that keeps a friendly buff OFF the debuffs window — the
// last two tests are that guard and they are the reason the first cut of JOS-213 was caught. It is
// also the answer that would still be right for a calm-line spell the polarity ruling has no row
// for. What changed is that it is no longer carrying the routing alone.
//
// WHAT THE FIX READS, AND THE CUT IT REPLACED. The SPELL, via a roster spells.json's landing
// messages DERIVE (src/main/data/spellDb.ts `spellCalmsTarget`) — the same oracle `ccSpell`,
// `charmSpell` and the slow group are built from. The first cut of this ticket routed on the
// TARGET instead ("send it to debuffs when the mob it is on cannot be a player"), which is the
// obvious reading of the report and is the mistake JOS-136/JOS-140 ruling 8 outlawed one level
// down: `disposition: 'hostile'` means only "not you and not a pet I am currently holding", so a
// friendly buff on somebody the model has lost track of tallies hostile. TWO COMMITTED GOLDENS
// went red under it and both are real users' shapes — `Resist Disease` from a Quick Buff burst on
// a spider (tests/buffUnifiedModel.test.mts) and the owner's own `Valor` on a charmed fire giant
// warrior whose charm line falls outside the window (tests/fixtures/e2e-overlay.log). The last
// test in this file is the guard that keeps the roster honest in the other direction.
//
// This file lives beside tests/buffTimers.test.mts rather than inside it for the reason that file
// already states about the death path: it is at the 400-code-line factoring ceiling.
//
// Run: `npm test`.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFixture, replayBuffTimers, tsOf } from './harness.mts'
import { rowsForSurface, timerDrops, timerRowSurface } from '../src/shared/buffTimers.ts'
import { CALM_LANDING_MESSAGES, loadSpellDb, spellCalmsTarget } from '../src/main/data/spellDb.ts'

const W64 = readFixture('w64-pacify-mob.log')
/** The fourth warrior landing is up, and the wizard has not been cast yet. */
const PACIFY_ON_WARRIOR = tsOf('[Wed Aug 05 20:31:07 2026] a fire giant warrior looks less aggressive.')
/** …and the wizard's landing, four seconds after the warrior's row was closed by its wear-off. */
const PACIFY_ON_WIZARD = tsOf('[Wed Aug 05 20:31:19 2026] a fire giant wizard looks less aggressive.')

test('a Pacify on a mob is a DEBUFFS-window row, not a buff on your own bar', () => {
  const { buffs, rows } = replayBuffTimers(W64, { until: PACIFY_ON_WARRIOR })
  const pacify = rows.filter((r) => r.name === 'Pacify')
  assert.equal(pacify.length, 1, `expected one Pacify row, got ${pacify.map((r) => r.target ?? '?').join(', ')}`)
  const row = pacify[0]

  // JOS-413: the spell is what the OWNER says it is. `spells.json` says `Beneficial` and the
  // polarity overlay overrules it, so the row and the instance both call a Pacify a debuff — which
  // is the half of report 6BM6Y5 the JOS-213 split could not answer.
  assert.equal(row.kind, 'debuff', 'the owner ruled a lull is a debuff, and the row must say so')
  assert.equal(buffs.active.find((a) => a.spell === 'Pacify')?.cls, 'debuff')
  // …and the routing fact is still derived and still stated, because it is still the guard that
  // keeps a friendly buff off this window (the last two tests) and still the answer for a calm-line
  // spell the polarity ruling has no row for.
  assert.equal(row.calmsTarget, true, 'the row must still state the evidence JOS-213 routes on')
  assert.equal(row.target, 'a fire giant warrior')
  assert.equal(timerRowSurface(row), 'debuffs')

  assert.deepEqual(
    rowsForSurface(rows, 'buffs').map((r) => r.id),
    [],
    'the buffs window must not carry a spell you cast to calm an enemy'
  )
  assert.deepEqual(
    rowsForSurface(rows, 'debuffs').map((r) => r.target),
    ['a fire giant warrior'],
    '…and the debuffs window carries it, under the mob it is on'
  )
})

test('…and it behaves like every other mob timer: a countdown, per target, closed by its wear-off', () => {
  // The DB states Pacify at 42 s and this span mints no sample of its own (four landings in four
  // separate seconds are four REFRESHES of one hold, and a refresh contaminates — buffRounds.ts
  // ruling 5), so the honest number is the DB floor and the row counts DOWN from it.
  const { rows } = replayBuffTimers(W64, { until: PACIFY_ON_WARRIOR })
  const row = rows.find((r) => r.name === 'Pacify')
  assert.ok(row)
  assert.equal(row.mode, 'countdown')
  assert.equal(row.durationMs, 42_000, "the DB's stated Pacify duration — nothing invented, nothing mined")
  assert.equal(row.group, 'target', 'a mob timer is filed under the mob, never under a self heading')
  assert.equal(row.count, undefined, 'a refresh keeps the hold at one — the count chip is for a real round')

  // `Your Pacify spell has worn off of a fire giant warrior.` at 20:31:15 closes THAT row and
  // leaves the next cast's row (a fire giant wizard, 20:31:19) as the only one standing.
  const later = replayBuffTimers(W64, { until: PACIFY_ON_WIZARD })
  assert.deepEqual(
    later.rows.filter((r) => r.name === 'Pacify').map((r) => r.target),
    ['a fire giant wizard'],
    'the wear-off must clear only the mob it names'
  )
  assert.equal(rowsForSurface(later.rows, 'buffs').length, 0)
})

test('the debuffs window stays SILENT about drops — a mob timer is not a buff of yours lapsing', () => {
  // `timerDrops` used to read `kind === 'buff'`, which WAS the buffs surface until a Pacify became
  // a 'buff' row on the debuffs one. It routes through `timerRowSurface` now, so the flash the
  // owner asked for ("flash when a positive spell drops") stays a buffs-window feature.
  const before = replayBuffTimers(W64, { until: PACIFY_ON_WARRIOR })
  const after = replayBuffTimers(W64, { until: PACIFY_ON_WIZARD })
  const debuffsBefore = rowsForSurface(before.rows, 'debuffs')
  const debuffsAfter = rowsForSurface(after.rows, 'debuffs')
  assert.ok(
    debuffsBefore.some((r) => r.target === 'a fire giant warrior') &&
      !debuffsAfter.some((r) => r.target === 'a fire giant warrior'),
    'the warrior`s Pacify must genuinely have gone, or this proves nothing'
  )
  assert.deepEqual(
    timerDrops(debuffsBefore, debuffsAfter, { rebuilt: false }),
    [],
    'the warrior`s Pacify ended, and the debuffs window must not announce it as a buff that dropped'
  )
})

// ---------------------------------------------------------------------------------------------
// THE ORACLE. The roster is DERIVED from the committed spells.json on every run (the
// charmCcRoster.test.mts pattern), so a re-scrape that widens one of the three landing sentences
// fails the suite instead of quietly re-routing somebody's buff onto the wrong window.
// ---------------------------------------------------------------------------------------------

test('THE ORACLE: the calm line is exactly the spells that print one of the three sentences', () => {
  const spells = loadSpellDb().spells
  const claimed = spells.filter((s) => spellCalmsTarget(s)).map((s) => s.name)
  assert.deepEqual(
    [...claimed].sort(),
    [
      'Alliance', // 'Someone looks friendly.'  — the Enchanter lull ladder, 8/20/50
      'Atone', // 'Someone calms down.'      — Cleric 32
      'Benevolence',
      'Calm',
      'Calm Animal',
      'Collaboration',
      'Lull',
      'Pacify',
      'Soothe',
      'Wake of Tranquility'
    ],
    'the calm family moved — re-read src/main/data/spellDb.ts spellCalmsTarget before widening it'
  )
  // Every member's landing message is one of the three, and no other spell prints any of them.
  for (const s of spells) {
    const prints = s.msgCastOnOther != null && CALM_LANDING_MESSAGES.has(s.msgCastOnOther)
    assert.equal(spellCalmsTarget(s), prints, `${s.name}: the roster and the sentence disagree`)
  }
})

test('…and NOTHING ELSE the owner has ever had on a bar joins it — the friendly-buff guard', () => {
  // The cut this replaced sent a real Valor and a real Resist Disease to the debuffs window. These
  // are those two plus the buffs the committed fixtures put on other entities; every one of them
  // is a `Beneficial` spell that lands on a NAMED target, which is exactly the shape the calm line
  // shares, and not one of them may be claimed.
  const db = loadSpellDb()
  const friendly = [
    'Valor',
    'Resist Disease',
    'Resist Magic',
    'Center',
    'Breeze',
    'Clarity',
    'Reckless Strength',
    'Symbol of Pinzarn',
    'Swift Like the Wind',
    'Boon of the Garou',
    'Aegolism',
    'Complete Healing'
  ]
  for (const name of friendly) {
    const entry = db.byKey.get(name.toLowerCase())
    assert.ok(entry, `${name} is no longer in the committed DB — the guard would be vacuous`)
    assert.equal(spellCalmsTarget(entry), false, `${name} must never be filed as a mob-state timer`)
  }
})
