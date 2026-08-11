// THE KILLERLESS MOB DEATH — `<Name> died.` (JOS-101).
//
// THE REPORT: a 0.12.0 user holding Lord Nagafen loot saw "0 kills" against him in raid
// targets, and noticed Phinigel was not on the roster at all.
//
// WHAT THE USER'S LOG ACTUALLY SAID. The attached slice carries the whole fight and its end,
// and the end is NOT a slain sentence:
//
//   [Sat Aug 08 10:37:57 2026] Lord Nagafen has taken 89 damage from Envenomed Breath by Konekn.
//   [Sat Aug 08 10:37:57 2026] You gain experience!
//   [Sat Aug 08 10:37:57 2026] You receive 20 platinum, 5 gold and 6 silver from the corpse.
//   [Sat Aug 08 10:37:57 2026] Lord Nagafen died.
//   [Sat Aug 08 10:38:03 2026] --You have looted a Cloak of Flames +1 from Lord Nagafen's corpse.--
//
// The killing blow was a damage-over-time tick, so there was no attacker to name and the client
// printed `Lord Nagafen died.` INSTEAD of `You have slain Lord Nagafen!`. The parser knew the
// player's own killerless death (`You died.`, JOS-88) but not its third-person twin, so the line
// fell through to `{kind:'unknown'}`: no death event, no kill, no credit — "0 kills" beside the
// loot the same corpse had just paid out. The loot lines parsed fine, which is exactly why the
// report reads as a contradiction.
//
// WHY IT IS SAFE TO CLAIM A PATTERN THIS WIDE. Full-log sweep (read-only, 2026-08-08) of the
// owner's eqlog_Primitive_freeport.txt, 1.44M lines: 21 lines end in " died." — 2 are `You
// died.` and 19 are mob names. NOT ONE of the 21 has a `slain` line within ±3 lines, so the
// shape never duplicates a slain sentence and cannot double-count. Player chat is immune by
// grammar, not by luck: a say/tell wraps its text in quotes and therefore ends `died.'`.
//
// The real-log window replayed below is verbatim from raw lines 1333573-1333575 (plus its zone
// line from 1333, "The Plane of Sky" at 22:48:11) — the owner's own killerless kill, which is
// the same shape the user hit on a boss.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent, parseEqTimestamp } from '../src/main/log/parser'
import { KillsModule } from '../src/main/modules/kills'
import { allStatuses, bossKills, type TargetStatus } from '../src/renderer/src/features/bosses/bossStatus'
import bossData from '../src/renderer/src/data/eqlegends/bosses.json'
import type { BossData, KillsSnap, RaidTarget } from '../src/shared/types'

const ROSTER = (bossData as BossData).targets

const NAGAFEN = ROSTER.find((t) => t.name === 'Lord Nagafen') as RaidTarget
const PHINIGEL = ROSTER.find((t) => t.name === 'Phinigel Autropos') as RaidTarget

/** Replay raw lines through the REAL parser into a fresh kills module. */
function replay(lines: string[]): KillsSnap {
  const mod = new KillsModule()
  mod.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  return mod.snapshot().state
}

const prevOf = (list: TargetStatus[]): Map<string, TargetStatus> =>
  new Map(list.map((s) => [s.target.name, s]))

// ----- the parser, on the shape itself -----

test('`<Name> died.` parses as a death with NO killer — the honest shape', () => {
  const ev = parseEvent('[Tue Aug 04 22:57:14 2026] An azarack died.', 0)
  assert.ok(ev, 'the line is no longer unknown')
  assert.equal(ev.kind, 'death')
  assert.equal(ev.name, 'An azarack', 'the raw display name, article and all')
  // NOT bySelf. Claiming the kill would credit the player with a stranger's boss and make the
  // combat engine attribute the killing blow to them; the line names nobody, so neither do we.
  assert.equal(ev.bySelf, false)
  assert.equal(ev.killer, undefined, 'no killer is invented — law 1, messages over inference')
})

test('the boss line from the user report parses — the whole bug, in one line', () => {
  const ev = parseEvent('[Sat Aug 08 10:37:57 2026] Lord Nagafen died.', 0)
  assert.ok(ev)
  assert.equal(ev.kind, 'death')
  assert.equal(ev.name, 'Lord Nagafen')
})

test('the player`s own `You died.` is still a playerDeath, not a mob death', () => {
  // The exact-equality check runs BEFORE the new regex, which would otherwise claim this line
  // as a mob named "You" and stop clearing the player's buffs.
  const ev = parseEvent('[Sun Jul 19 20:31:32 2026] You died.', 0)
  assert.ok(ev)
  assert.equal(ev.kind, 'playerDeath')
})

test('chat that merely ENDS in "died." is not a kill — the quote is the guard', () => {
  // The closing quote is why a 1.44M-line sweep of a pattern this wide finds zero chat lines.
  for (const raw of [
    "[Sat Aug 08 10:36:04 2026] Konekn told you, 'my pet died.'",
    "[Sat Aug 08 10:36:04 2026] Valok says, 'that is the third time he died.'"
  ]) {
    const ev = parseEvent(raw, 0)
    assert.notEqual(ev?.kind, 'death', `chat must not mint a kill: ${raw}`)
  }
})

test('the slain shapes are untouched — the new branch is reached only after they miss', () => {
  const self = parseEvent('[Tue Aug 04 22:55:08 2026] You have slain a thunder spirit princess!', 0)
  assert.equal(self?.kind, 'death')
  assert.equal(self?.bySelf, true)

  const by = parseEvent('[Wed Aug 05 00:33:45 2026] A thunder spirit princess has been slain by Pesmerga!', 0)
  assert.equal(by?.kind, 'death')
  assert.equal(by?.bySelf, false)
  assert.equal(by?.killer, 'Pesmerga', 'a NAMED killer still arrives named')
})

// ----- the real-log window: the owner's own killerless kill, end to end -----

test('a killerless death is counted AND credited when the exp line joins it', () => {
  // Verbatim from eqlog_Primitive_freeport.txt (raw 1333573-1333575), with the zone line the
  // window sits under. The exp line precedes the death line in the same second, which is the
  // join shared/kills.ts already ran for slain sentences.
  const snap = replay([
    '[Tue Aug 04 22:48:11 2026] You have entered The Plane of Sky.',
    '[Tue Aug 04 22:57:14 2026] An azarack has taken 12 damage from Choking by a thunder spirit.',
    '[Tue Aug 04 22:57:14 2026] You gain experience!',
    '[Tue Aug 04 22:57:14 2026] An azarack died.'
  ])
  const azarack = snap.mobs['an azarack']
  assert.ok(azarack, 'the kill is recorded under the canonical lowercase key')
  assert.equal(azarack.count, 1)
  assert.equal(azarack.credited, 1, 'the experience line credits it exactly as a slain line would')
})

test('without an exp line the same death is counted but NOT credited', () => {
  // The credit rule does not soften just because the killer is unnamed: a boss that dies across
  // the zone to somebody else still prints nothing for you, and still must not celebrate.
  const snap = replay([
    '[Tue Aug 04 22:48:11 2026] You have entered The Plane of Sky.',
    '[Tue Aug 04 22:57:14 2026] An azarack died.'
  ])
  assert.equal(snap.mobs['an azarack'].count, 1, 'tracking counts every defeat')
  assert.equal(snap.mobs['an azarack'].credited, 0, 'celebration reads credit, and there is none')
})

// ----- the roster: the reported symptom, and the missing target -----

test('THE REPORT: Lord Nagafen killed by a DoT tick now reads as a kill, not "0 kills"', () => {
  // The user's fight, ended the way their log ended it.
  const lines = [
    "[Sat Aug 08 10:32:10 2026] You have entered Nagafen's Lair - Solo 1 (Awakened).",
    '[Sat Aug 08 10:37:57 2026] Lord Nagafen has taken 89 damage from Envenomed Breath by Konekn.',
    '[Sat Aug 08 10:37:57 2026] You gain experience!',
    '[Sat Aug 08 10:37:57 2026] Lord Nagafen died.'
  ]
  const before = allStatuses([NAGAFEN], replay(lines.slice(0, 1)).mobs)
  const after = allStatuses([NAGAFEN], replay(lines).mobs)

  assert.equal(before[0].killed, false, 'undefeated before the fight ends')
  assert.equal(after[0].killed, true, 'the roster records the defeat the loot already proved')
  assert.equal(after[0].count, 1, 'one kill — the symptom in the report was zero')
  assert.equal(after[0].credited, 1, 'and it was the player`s own')
  assert.equal(after[0].lastTs, parseEqTimestamp('Sat Aug 08 10:37:57 2026'))

  // The instance tier still comes from the zone line, so the kill lands on the run it belongs
  // to — d1 (Awakened), not the base instance.
  assert.deepEqual(Object.keys(after[0].tiers), ['1'], 'credited to the Awakened run')

  // And the one celebration predicate fires: confetti, card flash, snackbar, toast, bossDefeat.
  const fired = bossKills(prevOf(before), after)
  assert.equal(fired.length, 1)
  assert.equal(fired[0].status.target.name, 'Lord Nagafen')
  // The kill reports d1, the run it landed on — not the target's highest ever (JOS-165).
  assert.equal(fired[0].tier, 1)
})

test('Phinigel Autropos is on the raid-target roster', () => {
  // Reported missing by the same 0.12.0 user. Log-form name verified against two sources that
  // predate this ticket: mobs.json (scraped from eqlwiki) carries `Phinigel Autropos`, level 53,
  // zone Kedge Keep; and the owner's own log prints `Your faction standing with Phinigel
  // Autropos has been adjusted by ...` 17 times — the faction is named for him, so that
  // spelling is the game's own, not the wiki's.
  assert.ok(PHINIGEL, 'Phinigel Autropos is in bosses.json')
  assert.equal(PHINIGEL.category, 'Open World', 'grouped with the pre-plane open-world bosses')
  assert.equal(PHINIGEL.zone, 'Kedge Keep')
  assert.deepEqual(PHINIGEL.match, ['Phinigel Autropos'])
})

test('Phinigel folds kills like any other target — both death shapes reach him', () => {
  const slain = allStatuses(
    [PHINIGEL],
    replay([
      '[Sat Aug 08 11:00:00 2026] You have entered Kedge Keep.',
      '[Sat Aug 08 11:05:00 2026] You gain experience!',
      '[Sat Aug 08 11:05:00 2026] You have slain Phinigel Autropos!'
    ]).mobs
  )
  assert.equal(slain[0].killed, true, 'the ordinary slain sentence matches the roster name')
  assert.equal(slain[0].credited, 1)

  const died = allStatuses(
    [PHINIGEL],
    replay([
      '[Sat Aug 08 11:00:00 2026] You have entered Kedge Keep.',
      '[Sat Aug 08 11:05:00 2026] You gain experience!',
      '[Sat Aug 08 11:05:00 2026] Phinigel Autropos died.'
    ]).mobs
  )
  assert.equal(died[0].killed, true, 'and so does the killerless form this ticket added')
  assert.equal(died[0].credited, 1)
})

test('the roster grew by exactly one target, and the other 31 are untouched', () => {
  assert.equal(ROSTER.length, 32, 'was 31 before JOS-101')
  const openWorld = ROSTER.filter((t) => t.category === 'Open World').map((t) => t.name)
  assert.deepEqual(openWorld, ['Lord Nagafen', 'Lady Vox', 'Master Yael', 'Phinigel Autropos'])
})
