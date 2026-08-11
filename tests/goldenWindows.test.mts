// GOLDEN-WINDOW WORLD-MODEL TESTS (Task #33).
//
// The user saw the Buffs tab display days-old "active" buffs on long-dead pets while
// their real self buffs were invisible, and mandated: unit tests built on HAND-EXAMINED
// time spans of the real log, asserting a plausible world model. This file is that
// deliverable.
//
// METHODOLOGY (documented here + in AGENTS.md for future changes):
//   1. A real log window is located and READ LINE-BY-LINE by a human (see each test's
//      header — raw line refs into eqlog_Primitive_freeport.txt + the verified sequence).
//   2. The window is extracted verbatim (chat/spam trimmed) into tests/fixtures/*.log via
//      tests/extract-fixtures.mjs. Fixtures are committed — they are the user's own log.
//   3. Some windows are PRIMED with an earlier real excerpt (tests/fixtures/*-priming.log)
//      that warms the learned classifier / everFaded set BEFORE the window — exactly what
//      the full-log replay does ahead of the live tail in production. A golden window is a
//      slice; priming gives it the history the real app already has.
//   4. The window is replayed through the REAL parser + BuffsModule and the resulting
//      world model (active buffs w/ target + class, mined stats) is asserted.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFixture, replayBuffs, findActive, activeNames, tsOf } from './harness.mts'
import type { BuffsSnap } from '../src/shared/types.ts'

const MIN = 60_000

// ─────────────────────────────────────────────────────────────────────────────
// W1 — CURRENT PERMAFROST SESSION (the user's ground truth).
// Raw: eqlog lines 895658 (zone 19:02:06) → 905700 (19:56:13), Sat Aug 01.
// HAND-VERIFIED sequence:
//   19:51:10  You have entered The Permafrost Caverns - Solo 4 (Refined).  (zone)
//   19:51:33  You begin casting Swift Like the Wind I.
//   19:51:35  You feel much faster.        ← SELF landing emote (2s later) ⇒ SELF cast
//   19:54:48  You begin casting Tashani.   (a debuff)
//   19:54:56  an ice giant has been charmed.
//   19:55:52  Your Allure spell has worn off of an ice giant.   (uncharm)
//   19:55:59  an ice giant has been charmed.                    (re-charm)
// "You feel much faster." recurs adjacent to Swift casts within the session (19:23:50,
// 19:51:35), so it is a RECOGNIZED landing emote by 19:51:35 → the 19:51:33 cast binds
// SELF even though a charmed pet is (later) live. This is the exact fix for the user's
// complaint: a real self buff, previously invisible because every cast was assumed to be
// on the charmed pet, now shows as SELF.
// EXPECT at ~19:56: Swift Like the Wind active, SELF target; and ZERO pet-buff actives
// carried over from before this session (no Gibober/Xeneker/Zektik/Jeber/Gebantik).
test('W1 current session: self Swift Like the Wind active, no stale pre-session pet buffs', () => {
  const lines = readFixture('w1-current-session.log')
  const observe = tsOf('[Sat Aug 01 19:56:00 2026] x') // user's ground-truth instant
  const snap = replayBuffs(lines, observe)

  const swift = findActive(snap, 'swift like the wind')
  assert.ok(swift, 'Swift Like the Wind should be an active buff at ~19:56')
  assert.equal(swift!.cls, 'buff', 'Swift is a beneficial buff (spell property, Task #35)')
  assert.equal(swift!.self, true, 'this instance is on the player (self landing emote)')
  assert.equal(swift!.disposition, 'self', 'bound disposition is self')
  assert.equal(swift!.target ?? undefined, undefined, 'a self buff has no target chip')
  assert.equal(swift!.messageDriven, true, 'opened by the landing line, the only way (JOS-118)')

  // Swift landed 19:51:33 → elapsed ~4.5m at 19:56 (loose — the user reported ~11m
  // REMAINING on the real 15m self-buff; the mined estimate is imperfect, but the
  // active + self-target facts are the assertion that matters).
  const elapsedMin = (observe - swift!.startedTs) / MIN
  assert.ok(elapsedMin > 4 && elapsedMin < 6, `Swift elapsed ~4.5m, got ${elapsedMin.toFixed(1)}m`)

  // ZERO stale pet buffs from before this session.
  for (const stale of ['intensify death', 'clarity', 'spinechiller']) {
    assert.ok(!activeNames(snap).includes(stale), `no stale "${stale}" active from a prior session`)
  }
  // No active older than an hour (the "287h" class is impossible now).
  for (const a of snap.active) {
    assert.ok(observe - a.startedTs < 60 * MIN, `no hours-old active (${a.spell})`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// W2 — XENEKER DEATH (finding #4: a retired entity drops its actives + censors opens).
// Raw: eqlog lines 159640 → 167260, Mon Jul 20. Primed with the single real Intensify
// Death fade (line 97684, Jul 19) so it's a KNOWN buff (everFaded + class 'buff').
// HAND-VERIFIED sequence:
//   19:52:31  You begin casting Intensify Death.   (a buff; NO pet claimed yet, NO emote)
//   19:57:42  Xeneker told you, 'Attacking … Master.'   (Xeneker = your summoned pet, LATER)
//   …          (Intensify never fades — no "pet's Intensify Death worn off" after)
//   20:22:03  Xeneker has been slain by a wan ghoul knight!   (a DIFFERENT killer)
//
// JOS-118 CHANGED THE ANSWER HERE, and this is the one golden row in the file that moves.
// MEASURED on these exact bytes (scripts probe, DB installed as production installs it): the
// whole window emits ONE relevant event for this spell — `castBegin Intensify Death` at
// 19:52:31 — and NO landing line of any kind, which is what the hand-read above already
// recorded ("NEITHER a message NOR a landing emote"). Under the old model the cast ITSELF
// opened an instance 15 s later, bound to a target the model inferred; the test asserted that
// inferred row was present and merely checked it had not guessed "Xeneker". Under JOS-118 a
// cast opens nothing, so there is no Intensify instance at all.
//
// That is MORE honest, not less: the log never said this buff landed, never said on whom, and
// the app now says nothing rather than showing a bar attributed to a guess. It is the ticket's
// stated honesty limit — where EQ surfaces no landing, silence stays silence — and it is the
// same rule that makes a RESISTED debuff show nothing.
//
// Both properties the user's original complaint was actually about are unchanged and now hold
// a fortiori: nothing is bound to the (later-dead) pet Xeneker, so no stale "Intensify on a
// corpse" active, and no bogus multi-hour "287h" duration sample from the unobserved fade.
test('W2 Xeneker death: no stale buff bound to the dead pet, no bogus multi-hour sample', () => {
  const prime = readFixture('w2-priming.log')
  const lines = readFixture('w2-xeneker-death.log')

  const slainTs = tsOf('[Mon Jul 20 20:22:03 2026] x')
  const before = lines.filter((l) => tsOf(l) > 0 && tsOf(l) < slainTs)
  const throughDeath = lines.filter((l) => tsOf(l) > 0 && tsOf(l) <= slainTs)

  // The cast with no landing line tracks NOTHING (JOS-118) — not a self row, not a pet row.
  const snapBefore = replayBuffs(before, slainTs - 1000, { prime })
  assert.equal(
    findActive(snapBefore, 'intensify death'),
    undefined,
    'a cast the log never confirmed landing opens no instance — no target was ever named'
  )

  const snapAfter = replayBuffs(throughDeath, slainTs, { prime })
  // No active is bound to the now-dead pet Xeneker (the actual user complaint).
  for (const a of snapAfter.active) {
    assert.notEqual((a.target ?? '').toLowerCase(), 'xeneker', `no active on the dead pet (${a.spell})`)
  }
  // Censored: no bogus multi-hour sample was mined from the unobserved fade.
  const stat = snapAfter.stats['intensify death']
  assert.ok(!stat || stat.n === 0, 'no duration sample recorded from the unobserved fade')
})

// ─────────────────────────────────────────────────────────────────────────────
// W3 — PET SUCCESSION (finding #3: a new pet retires the previous pet's actives).
// Raw: eqlog lines 80900 → 97700, Sun Jul 19.
// HAND-VERIFIED sequence:
//   18:23:20  Gibober told you, '… Master.'          (Gibober = summoned pet)
//   18:40:05  You begin casting Intensify Death.      (on Gibober)
//   19:02:24  Jenann told you, '… Master.'            (Jenann = the SUCCESSOR pet)
//   19:41:58  Your pet's Intensify Death spell has worn off.   (Jenann's, ~62m after cast)
// Without the single-pet invariant, the 18:40:05 open cast pairs with the 19:41:58 fade →
// a bogus ~62-minute sample on a pet Jenann already replaced. Claiming Jenann at 19:02:24
// must RETIRE Gibober and CENSOR his open Intensify cast → no such sample.
test('W3 pet succession: successor claim retires prior pet, no 62-minute bogus sample', () => {
  const lines = readFixture('w3-pet-succession.log')
  const snap = replayBuffs(lines, tsOf('[Sun Jul 19 19:41:58 2026] x'))
  const stat = snap.stats['intensify death']
  // If a sample leaked, it would be the ~62-min Gibober→Jenann pairing. Assert none.
  assert.ok(!stat || stat.n === 0, 'Gibober→Jenann succession must not mine a duration sample')
  assert.ok(!findActive(snap, 'intensify death'), 'no lingering Intensify active after succession')
})

// ─────────────────────────────────────────────────────────────────────────────
// W4 — LOGOUT GAP (finding #5: a ≥30-min event-time gap clears ALL actives).
// Raw: eqlog lines 814800 → 815210, Sat Aug 01. Primed with a real Clarity fade
// (line 407668) so Clarity is a KNOWN buff.
// HAND-VERIFIED sequence:
//   02:15:04  You begin casting Clarity III.       (a buff; open, no fade before the gap)
//   02:52:14  … last event before the pause …
//   13:00:28  Welcome to EverQuest Legends!        (relog — a 608-MINUTE gap)
//   13:03:08  You have entered The Southern Desert of Ro.
// The Clarity cast before the logout must NOT replay as a live active after the 608-min
// gap: the gap boundary clears every active + censors opens.
test('W4 logout gap: a buff cast before a ≥30-min gap is cleared after relog', () => {
  const prime = readFixture('w4-priming.log')
  const lines = readFixture('w4-logout-gap.log')

  // The pause is 02:52:14 → 13:00:28. Cut BEFORE the pause (any pre-13:00 instant) to get
  // the pre-gap state, and observe while Clarity is genuinely up so the gap-clear below is a
  // real delta.
  //
  // THE OBSERVATION INSTANT MOVED 02:53 → 02:30 (JOS-118), because the log says so. Clarity
  // lands 02:15:05 (`Boon of the Clear Mind` family landing, resolved to Clarity by the own
  // cast at 02:15:04) and the log prints its WEARS-OFF at 02:52:05 — 37 minutes, a clean
  // sample the model now mines. So at 02:53 Clarity is legitimately gone, and asserting it
  // active there would be asserting against the log. It used to "survive" to 02:53 only
  // because this replay ran with the spell DB cleared, which parses neither the landing nor
  // the wear-off: the row was the cast-timing inference, held up by the absence of the very
  // line that ends it. 02:30 is inside the real 02:15:05 → 02:52:05 span.
  // Cut the LINES at the observation instant, not merely the tick: the wear-off at 02:52:05 is
  // a real event in this window and folding it would (correctly) clear Clarity before we look.
  const observeBefore = tsOf('[Sat Aug 01 02:30:00 2026] x')
  const beforeGap = lines.filter((l) => tsOf(l) > 0 && tsOf(l) <= observeBefore)

  // Clarity is active/open right up to the gap (assert it was there to be cleared).
  const snapBefore = replayBuffs(beforeGap, observeBefore, { prime })
  assert.ok(findActive(snapBefore, 'clarity'), 'Clarity should be active just before the gap')

  // After the full replay (through the relog), the pre-gap buff is gone.
  const snapAfter = replayBuffs(lines, tsOf(lines[lines.length - 1]), { prime })
  assert.ok(!findActive(snapAfter, 'clarity'), 'Clarity cleared by the ≥30-min session gap')
  assert.equal(snapAfter.active.length, 0, 'no actives survive the logout gap')
})

// ─────────────────────────────────────────────────────────────────────────────
// W5 — CHARMED PET ZONED AWAY (finding: zone left-behind censors charmed-pet buffs).
// Raw: eqlog lines 486900 → 490943, Thu Jul 30. Primed (w5-priming.log) so Boon of the
// Garou / Tashani classify as PET buffs (the full-log verdict).
// HAND-VERIFIED sequence:
//   15:31:08  Your Boon of the Garou spell has worn off of an imp protector.  (pet fade)
//   15:43:53  an imp protector has been charmed.
//   15:43:56  an imp protector feels a healing touch.   ← PET landing emote names the pet
//   15:44:25  You begin casting Boon of the Garou.       (on the charmed imp)
//   15:50:54  You have entered The Lavastorm Mountains.  (zone — mob LEFT BEHIND)
// A mob cannot follow you through a zone, so a debuff open on it can never be observed
// fading → CENSORED + removed from the active display on the zone line.
//
// THE INSTANCE THIS ASSERTS CHANGED (JOS-118), and it changed to the one the log confirms.
// MEASURED on these bytes with the DB installed as production installs it: the 15:44:25
// `You begin casting Boon of the Garou.` has NO landing line after it in any form — the next
// imp line is `an imp protector slows down.` (a different spell) at 15:44:42 and the imp is
// SLAIN at 15:45:30, 65 s after the cast. The DB does know Boon's cast-on-other message (the
// priming excerpt lands it on `Innoruuk\`s Chosen` five times), so had it landed the log would
// have said so. It did not, so no Boon-on-the-imp instance exists — the old "Boon active on
// the charmed pet" row was the cast-timing guess, and asserting it is asserting the guess.
// The only Boon here is a SELF one that really did land, at 15:32:16.
//
// What the window DOES confirm is the same law by a named instance: `Tashani` lands on `an imp
// protector` at 15:40:52 (a message that NAMES the mob) and a zone censors it, while the player's
// self buffs ride through.
//
// …AND THE 15:45:30 SLAIN LINE GETS THERE FIRST NOW (JOS-156). `An imp protector has been slain
// by an imp protector!` — the charmed imp killing a same-named imp, the identical shape as the
// owner's Plane of Sky bee fight nine days later. That line used to do NOTHING: the name matched
// the live charmed pet, so the death went into the branch that refuses to censor a live pet on an
// ambiguous death and the two debuffs standing on that name (Tashani, and the Tepid Deeds landed
// at 15:44:42) rode on to the zone. They are censored by the death now, five minutes earlier,
// which is why the zone half of this window is asserted against a control with that ONE line
// removed. Both halves are real bytes and both laws are pinned; what changed is which of them
// this window's Tashani actually meets.
test('W5 a same-named third-party kill censors the debuffs on that name (JOS-156)', () => {
  const prime = readFixture('w5-priming.log')
  const lines = readFixture('w5-charm-zone.log')
  const upTo = (ts: number): BuffsSnap =>
    replayBuffs(lines.filter((l) => tsOf(l) > 0 && tsOf(l) <= ts), ts, { prime })

  const before = upTo(tsOf('[Thu Jul 30 15:45:29 2026] x'))
  const tashBefore = findActive(before, 'tashani')
  assert.ok(tashBefore, 'Tashani is active on the imp a second before the slain line')
  assert.equal(tashBefore!.cls, 'debuff', 'Tashani is a detrimental spell (spell property)')
  assert.equal(tashBefore!.self, false, 'this instance is on the mob, not the player')
  assert.equal(tashBefore!.target, 'an imp protector', 'keyed to the entity the landing line NAMED')
  assert.equal(tashBefore!.messageDriven, true, 'opened by that landing line, never by the cast')
  assert.ok(findActive(before, 'tepid deeds'), 'and so is the slow landed on that name at 15:44:42')
  // The cast the log never confirmed landing tracks nothing at all — no invented pet row.
  assert.equal(findActive(before, 'boon of the garou')?.self, true, 'the only Boon is the SELF one that landed')

  const after = upTo(tsOf('[Thu Jul 30 15:45:31 2026] x'))
  for (const spell of ['tashani', 'tepid deeds']) {
    assert.equal(findActive(after, spell), undefined, `${spell} goes with the corpse the pet made`)
  }
  assert.equal(after.active.every((a) => a.self), true, 'nothing but the player own buffs is left')
})

// The ZONE half of W5, on a control with the 15:45:30 slain line removed — the one line, and the
// whole diff. Without it the imp's Tashani survives to 15:50:54 exactly as it always did, and the
// zone is what censors it: a mob cannot follow you through a zone, so a debuff open on it can
// never be observed fading.
test('W5 mob zoned away: its named debuff is censored + gone after the zone, self buffs ride', () => {
  const prime = readFixture('w5-priming.log')
  const slain = '[Thu Jul 30 15:45:30 2026] An imp protector has been slain by an imp protector!'
  const lines = readFixture('w5-charm-zone.log').filter((l) => l !== slain)
  const zoneTs = tsOf('[Thu Jul 30 15:50:54 2026] x')

  const before = lines.filter((l) => tsOf(l) > 0 && tsOf(l) < zoneTs)
  const tashBefore = findActive(replayBuffs(before, zoneTs - 1000, { prime }), 'tashani')
  assert.ok(tashBefore, 'Tashani should be active on the imp before the zone')
  assert.equal(tashBefore!.target, 'an imp protector', 'still keyed to the entity the landing line NAMED')

  const snapAfter = replayBuffs(lines, tsOf(lines[lines.length - 1]), { prime })
  assert.ok(!findActive(snapAfter, 'tashani'), 'the mob debuff is censored + gone after the zone')
  // Nothing left behind survives the zone; the player's own buffs do.
  for (const a of snapAfter.active) {
    assert.notEqual(a.disposition, 'charmed', `no charmed-pet buff survives a zone (${a.spell})`)
    assert.notEqual(a.cls, 'debuff', `no mob debuff survives a zone (${a.spell})`)
  }
  assert.ok(findActive(snapAfter, 'clarity'), 'a self buff rides through the zone (law 4)')
})

// ─────────────────────────────────────────────────────────────────────────────
// W6 — RANK PAIRING (finding #1: strip a trailing Roman rank so cast↔fade pair).
// Raw: eqlog lines 901690 → 903370, Sat Aug 01.
// HAND-VERIFIED sequence:
//   19:41:59  You begin casting Shiftless Deeds IV.                (RANKED cast)
//   19:45:53  Your Shiftless Deeds spell has worn off of Lady Vox. (RANK-LESS fade)
// The cast carries a rank ("IV"); the fade drops it. Only the rank-stripped canonical key
// makes them pair → a ~3m54s duration sample. Without the fix (name-keyed), "shiftless
// deeds iv" ≠ "shiftless deeds" and NO sample is mined.
test('W6 rank pairing: "Shiftless Deeds IV" cast pairs with "Shiftless Deeds" fade', () => {
  const lines = readFixture('w6-rank-pairing.log')
  const snap = replayBuffs(lines, tsOf(lines[lines.length - 1]))
  const stat = snap.stats['shiftless deeds']
  assert.ok(stat, 'Shiftless Deeds should be a mined spell (rank-merged key)')
  assert.equal(stat!.n, 1, 'exactly one cast→fade sample mined from the ranked/rankless pair')
  // 19:41:59 → 19:45:53 = 3m54s = 234s.
  const sec = Math.round((stat!.medianMs ?? 0) / 1000)
  assert.ok(sec >= 230 && sec <= 240, `sample ~3m54s (234s), got ${sec}s`)
})
