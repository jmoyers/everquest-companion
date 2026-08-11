// JOS-176 — A CC HOLD SPEAKS FOR AN ENGAGED HOSTILE, AND ONLY WHILE IT IS ONE.
//
// THE REPORT (owner, Sun Aug 09, Fused Hate run): the Grandmaster R`tal encounter opened at
// 20:10:02, SEVENTY-EIGHT SECONDS before the pull, so the boss fight's meter carried the whole
// preceding twin skirmish and its start clock was nonsense.
//
// WHAT THE REAL BYTES SAY (measured with a throwaway replay of the owner's log, and the reason
// the brief's diagnosis is only half the story). `Encounter.ccActiveUntil` is a per-instance
// claim that a mez'd mob is alive and still in this fight; it vetoes the DEATH-CLOSE. Two kinds
// of entity can carry that stamp and can never be an answer to the question it asks:
//
//   1. A RETIRED INSTANCE. Retirement is final — any later action by that name mints a fresh
//      `nameKey#gen` — so the hold is unredeemable the instant the world model retires the slot.
//      Only `ingestDeath` used to clear it, so a mob aged out by STALENESS kept vetoing for the
//      rest of its 120 seconds. Whole-log measurement: 1,311 retirements carried an unexpired
//      hold via the death path (cleaned up) and 614 via the staleness path (not).
//   2. A LIVE PET OF YOURS. `hostilePresence()` has always excluded live pets from "is anything
//      still alive here" — a pet never dies, so counting it would pin every charm-grind fight
//      open forever — but the hold loop beside it did not. This is the case the owner actually
//      hit, and it exists because in the Plane of Hate his charmed pet and the mobs he is killing
//      SHARE ONE NAME (`Innoruuk`s Chosen`): when the last hostile twin died, the caster-only
//      `Your Dazzle spell has worn off of <name>` line (a CC refresh, JOS-161) resolved to the
//      only instance of that name still live — the pet — and stamped 120 seconds on it. 507 CC
//      events in the owner's log land their hold on a live pet this way.
//
// The mez-and-wait veto for a LIVE MEZZED HOSTILE is untouched and is pinned here and in
// tests/combatClosureDiscipline.test.mts (CC1–CC3).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { CombatEngine } from '../src/main/combat/engine'
import { CC_HOLD_MS, LINGER_MS, PRESENCE_GONE_MS } from '../src/main/combat/encounter'
import { INSTANCE_STALE_MS } from '../src/main/combat/world'
import { readFixture } from './harness.mts'
import type { SegmentSummary } from '../src/shared/combat'

const T = (clock: string): number => Date.parse(`Sun Aug 09 ${clock} 2026`)

function feed(eng: CombatEngine, lines: string[], seq: { n: number }): number {
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq.n++)
    if (!ev) continue
    eng.ingestEvent(ev, false)
    lastTs = ev.ts
  }
  return lastTs
}

/** Replay synthetic lines (they carry their own dates) and return the finalized fights, oldest
 *  first, observed long after the last line. */
function fights(lines: string[]): SegmentSummary[] {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  const lastTs = feed(eng, lines, { n: 0 })
  return eng
    .snapshot(lastTs + 300_000, {})
    .segments.filter((s) => s.kind === 'fight')
    .reverse()
}

// ============================================================================
// THE GOLDEN WINDOW — the owner's own bytes.
//
// tests/fixtures/w61-twin-mez-prime.log      raw 1502972..1503072 (20:02:45 → 20:03:17)
// tests/fixtures/w61-twin-mez-skirmish.log   raw 1505971..1507053 (20:08:50 → 20:11:59)
// Cut by tests/extract-combat-fixtures.mjs (see its W61 header for the hand-read beats). The
// prime exists because the pet is bound six minutes before the window: `You begin casting
// Allure VI.` → `Innoruuk`s Chosen has been charmed.` → the pet's own claim tell. A combat-only
// cut cannot establish that, and without it the whole shape disappears.
// ============================================================================

test('W61: the boss pull opens at the pull, not 78 seconds early', () => {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  const seq = { n: 0 }
  feed(eng, readFixture('w61-twin-mez-prime.log'), seq)
  const lastTs = feed(eng, readFixture('w61-twin-mez-skirmish.log'), seq)

  const fs = eng
    .snapshot(lastTs + 300_000, {})
    .segments.filter((s) => s.kind === 'fight')
    .reverse()

  // The skirmish's second half and the R`tal pull are TWO fights now. Pre-fix they were one
  // 117-second blob opening at 20:10:02 and named `Innoruuk`s Chosen (3) +1`.
  const rtal = fs.find((f) => f.name.startsWith('Grandmaster R`tal'))
  assert.ok(rtal, 'the boss pull is a fight of its own')
  assert.equal(rtal.startTs, T('20:11:26'), 'and it opens on its own first attributed damage')

  const skirmish = fs.find((f) => f.startTs === T('20:10:02'))
  assert.ok(skirmish, 'the second half of the twin skirmish keeps its own encounter')
  assert.equal(
    skirmish.startTs + Math.round(skirmish.durationSec * 1000),
    T('20:10:38'),
    'and it ends on the last twin death, not 46 seconds later'
  )
  assert.ok(!skirmish.name.startsWith('Grandmaster'), 'the boss is not in it')

  // LAW 8's TRIPWIRE: segmentation moved, damage did not. 15,305 + 11,110 is exactly the
  // 26,415 the single pre-fix blob carried.
  assert.equal(skirmish.total + rtal.total, 26_415)
})

test('W61: the skirmish closes ~5s after the last death, not 46s later', () => {
  // The live app evaluates closure from snapshot(Date.now()) two or three times a second, so
  // "when does it close" is answerable at any instant — this is the reading the owner would
  // have had on screen. The last twin dies at 20:10:38; LINGER_MS is 5s.
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  const seq = { n: 0 }
  feed(eng, readFixture('w61-twin-mez-prime.log'), seq)
  const win = readFixture('w61-twin-mez-skirmish.log')
  // Fold only the lines up to the last death — everything after it is the 46 seconds of silence
  // and then the pull, neither of which may be needed to reach the closure.
  const upToDeath = win.filter((l) => {
    const ev = parseEvent(l, 0)
    return ev === null || ev.ts <= T('20:10:38')
  })
  feed(eng, upToDeath, seq)

  const at = (clock: string): SegmentSummary | undefined =>
    eng.snapshot(T(clock), {}).segments.find((s) => s.kind === 'current')
  assert.ok(at('20:10:42'), 'still open inside the linger')
  assert.equal(at('20:10:44'), undefined, `closed once ${String(LINGER_MS / 1000)}s of linger elapsed`)
})

// ============================================================================
// THE BOUNDARY, PINNED SYNTHETICALLY. Each needs a controlled gap no single real window
// happens to contain — the same reason combatClosureDiscipline.test.mts carries CC1–CC3.
// ============================================================================

test('CC4 (THE LAW): a LIVE mezzed hostile still holds the fight open through silence', () => {
  // This is the behavior CC_HOLD_MS exists for and the one thing this change may not cost.
  // The beetle we were killing dies; the goblin is asleep, alive, and says nothing at all.
  assert.ok(CC_HOLD_MS > PRESENCE_GONE_MS, 'the hold has to outlive the presence leash to mean anything')
  const lines = [
    '[Sun Jul 19 09:00:00 2026] You begin casting Mesmerization III.',
    '[Sun Jul 19 09:00:01 2026] a cave goblin has been mesmerized.',
    '[Sun Jul 19 09:00:02 2026] You crush a fire beetle for 100 points of damage.',
    '[Sun Jul 19 09:00:04 2026] You crush a fire beetle for 100 points of damage.',
    '[Sun Jul 19 09:00:06 2026] You have slain a fire beetle!'
  ]
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  feed(eng, lines, { n: 0 })
  // 39s after the beetle died: nine times LINGER_MS, past PRESENCE_GONE_MS, and still inside
  // FALLBACK_IDLE_MS — so the ONLY thing that can keep this fight open is the goblin's hold.
  const now = Date.parse('Sun Jul 19 09:00:45 2026')
  const snap = eng.snapshot(now, {})
  assert.ok(snap.segments.some((s) => s.kind === 'current'), 'the mez-and-wait gap is not the end of a pull')
  assert.equal(snap.segments.filter((s) => s.kind === 'fight').length, 0, 'and nothing has finalized')
})

test('CC5: a hold left on a STALENESS-retired mob is unredeemable and stops vetoing', () => {
  // The mez'd goblin is never seen again — killed off-screen, despawned, or simply walked away,
  // and EQ logs none of those. A LATER goblin is a different spawn (INSTANCE_STALE_MS), and the
  // first one can never rejoin: the sighting mints `a cave goblin#2`. Its hold ran to 09:02:01.
  assert.ok(INSTANCE_STALE_MS < CC_HOLD_MS, 'a slot can age out with 100 seconds of hold still on it')
  const lines = [
    '[Sun Jul 19 09:00:00 2026] You begin casting Mesmerization III.',
    '[Sun Jul 19 09:00:01 2026] a cave goblin has been mesmerized.',
    '[Sun Jul 19 09:00:02 2026] You crush a fire beetle for 100 points of damage.',
    '[Sun Jul 19 09:00:06 2026] You have slain a fire beetle!',
    // 44s later — well past the staleness horizon — a goblin of that name is pulled and killed.
    // The sighting retires gen 1 (clearing its hold) and engages a fresh gen 2.
    '[Sun Jul 19 09:00:50 2026] You crush a cave goblin for 100 points of damage.',
    '[Sun Jul 19 09:00:52 2026] You crush a cave goblin for 100 points of damage.',
    '[Sun Jul 19 09:00:55 2026] You have slain a cave goblin!',
    // …and 15s after THAT, a wholly separate pull. Inside FALLBACK_IDLE_MS, so the death-close
    // is the only thing that can keep these apart — and pre-fix gen 1's dead hold vetoed it.
    '[Sun Jul 19 09:01:10 2026] You crush a wandering rat for 50 points of damage.',
    '[Sun Jul 19 09:01:12 2026] You crush a wandering rat for 50 points of damage.'
  ]
  const fs = fights(lines)
  assert.equal(fs.length, 2, 'the rat pull is its own fight')
  assert.equal(fs[0].total, 300, 'beetle + goblin — they ARE one pull (see the note below)')
  assert.equal(fs[1].name, 'a wandering rat')
  assert.equal(fs[1].total, 100)
  // NOTE, stated rather than hidden: the beetle and the goblin stay fused, because closure is
  // evaluated at the TOP of the damage ingest and the stale slot is not retired until that same
  // line is routed. The hold is honest for exactly one more event; what it can no longer do is
  // outlive the mob by a further minute.
})

test('CC6: a hold that landed on your own live PET never vetoes anything', () => {
  // The owner's mechanism in miniature. `Your <spell> spell has worn off of <mob>` is the
  // caster-only line, so it parses as a CC REFRESH and is exempt from the ownership gate by
  // construction (JOS-161) — and it names a mob whose name your charmed pet also carries. By the
  // time it prints, the mob it describes is dead, so the only live instance of that name is the
  // pet, and the refresh stamps 120 seconds on something that is never going to die.
  const lines = [
    '[Sun Jul 19 10:00:00 2026] a kodiak has been charmed.',
    "[Sun Jul 19 10:00:02 2026] A kodiak told you, 'Attacking a cave goblin Master.'",
    '[Sun Jul 19 10:00:05 2026] You crush a cave goblin for 100 points of damage.',
    '[Sun Jul 19 10:00:09 2026] You crush a cave goblin for 100 points of damage.',
    '[Sun Jul 19 10:00:11 2026] You have slain a cave goblin!',
    // Inside LINGER_MS of the last hit, so the pull is still open when this lands.
    '[Sun Jul 19 10:00:13 2026] Your Dazzle spell has worn off of a kodiak.',
    // A fresh pull 32s later — inside FALLBACK_IDLE_MS of that refresh, so only the death-close
    // can separate them, and pre-fix the pet's hold defeated it.
    '[Sun Jul 19 10:00:45 2026] You crush a wandering rat for 50 points of damage.',
    '[Sun Jul 19 10:00:47 2026] You crush a wandering rat for 50 points of damage.'
  ]
  const fs = fights(lines)
  assert.equal(fs.length, 2, 'two pulls, not one blob')
  assert.equal(fs[0].name, 'a cave goblin')
  assert.equal(fs[0].total, 200)
  assert.equal(fs[1].name, 'a wandering rat')
  assert.equal(fs[1].total, 100)
})
