// CELEBRATIONS FIRE ONLY FOR KILLS CREDITED TO YOU (owner, 2026-08-05).
//
// THE BUG, in the owner's words: "it looks like its celebrating even when im not the killer of
// the boss - im in open world and somebody killed. if im not in a group with them, it should not
// count." The incident is in the real log, and it is the fixture below:
//
//   [Wed Aug 05 00:33:45 2026] A thunder spirit princess has been slain by Pesmerga!
//
// Pesmerga is a stranger standing in the same Plane of Sky. Nothing in that second paid the
// player anything — no experience line, no faction line, no coin — and the app cheered anyway:
// confetti, a card flash, the boss-defeat alert and a celebration toast, because the kills module
// counts every boss that DIES in your log and `bossKills` compared that count.
//
// THE SEAM. Counting is right; celebrating is not. The distinction the log itself makes is the
// EXPERIENCE LINE, which precedes its kill line in the same second (AGENTS.md, log format; the
// sweep in main/modules/progression.ts). Your own kill has one:
//
//   [Tue Aug 04 22:55:08 2026] You gain experience!
//   [Tue Aug 04 22:55:08 2026] You have slain a thunder spirit princess!
//
// …and so does a GROUP-mate's killing blow ("You gain party experience!"), which is precisely why
// the owner's "if im not in a group with them" is satisfied by this rule and not by a second one.
// So main/modules/kills.ts now runs the same backward join progression.ts does and records
// `credited` per tier run; `bossStatus.bossKills` — the ONE predicate behind confetti, the card
// flash, the snackbar, the toast and the bossDefeat signal — compares that instead of `count`.
//
// Fixture: tests/fixtures/boss-credit-open-world.log, verbatim from raw lines 1330761 (zone),
// 1332806-1332809 (the credited kill), 1350093 (zone) and 1350515-1350517 (the incident).
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseEvent, parseEqTimestamp } from '../src/main/log/parser'
import { KillsModule } from '../src/main/modules/kills'
import { allStatuses, bossKills, type TargetStatus } from '../src/renderer/src/features/bosses/bossStatus'
import { TIER_OPEN_WORLD } from '../src/shared/kills'
import type { KillsSnap, RaidTarget } from '../src/shared/types'
import { readFixture } from './harness.mts'

/** The roster row as bosses.json really spells it (Plane of Sky). */
const PRINCESS: RaidTarget = {
  name: 'Thunder Spirit Princess',
  category: 'Plane of Sky',
  match: ['Thunder Spirit Princess']
}

const MINE = parseEqTimestamp('Tue Aug 04 22:55:08 2026')
const STRANGERS = parseEqTimestamp('Wed Aug 05 00:33:45 2026')

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

/** The statuses after replaying a prefix of the fixture (the app's live snapshots, in order). */
function statusesAfter(lines: string[], upToTs: number): TargetStatus[] {
  const cut = lines.filter((l) => {
    const stamp = /^\[(.+?)\]/.exec(l)
    return stamp ? parseEqTimestamp(stamp[1]) <= upToTs : true
  })
  return allStatuses([PRINCESS], replay(cut).mobs)
}

const prevOf = (list: TargetStatus[]): Map<string, TargetStatus> =>
  new Map(list.map((s) => [s.target.name, s]))

test('the incident: an open-world kill by a stranger celebrates NOTHING', () => {
  const lines = readFixture('boss-credit-open-world.log')

  // The world as it stood one second before Pesmerga's kill, and immediately after it.
  const before = statusesAfter(lines, STRANGERS - 1000)
  const after = statusesAfter(lines, STRANGERS)

  // TRACKING IS UNTOUCHED: the princess died, the roster says so, and the count moved.
  assert.equal(after[0].killed, true, 'the roster still records the defeat')
  assert.equal(after[0].count, before[0].count + 1, 'and still counts the kill')
  assert.equal(after[0].lastTs, STRANGERS, 'dated by the kill that actually happened')

  // CELEBRATION DOES NOT FIRE. No confetti, no card flash, no snackbar, no bossDefeat signal,
  // no toast — every one of them is downstream of this single predicate.
  assert.deepEqual(bossKills(prevOf(before), after), [], 'a witnessed kill is not a celebration')
  assert.equal(after[0].credited, before[0].credited, 'nothing was credited to the player')
})

test('the same boss killed by YOU celebrates — the exp line is the whole difference', () => {
  const lines = readFixture('boss-credit-open-world.log')

  const before = statusesAfter(lines, MINE - 1000)
  const after = statusesAfter(lines, MINE)

  assert.equal(before[0].killed, false, 'undefeated before your kill')
  const fired = bossKills(prevOf(before), after)
  assert.equal(fired.length, 1, 'your own kill fires the one predicate')
  assert.equal(fired[0].status.target.name, 'Thunder Spirit Princess')
  assert.equal(fired[0].status.credited, 1)
  assert.equal(fired[0].status.count, 1, 'one kill, credited — count and credit agree here')
  // And the kill carries the tier it happened on (JOS-165). It used to read `0`, the base
  // difficulty, because a bare zone name and a base INSTANCE both decoded to tier 0. This kill
  // happened in the open-world Plane of Sky, which is not a difficulty at all (JOS-166), and the
  // toast now says so rather than announcing a d0 clear the player never made.
  assert.equal(fired[0].tier, TIER_OPEN_WORLD)
})

test('the whole fixture, folded: two kills of one boss, exactly one of them yours', () => {
  const snap = replay(readFixture('boss-credit-open-world.log'))
  const princess = snap.mobs['a thunder spirit princess']
  assert.ok(princess, 'both casings fold onto the canonical lowercase key')
  assert.equal(princess.count, 2, 'both deaths are recorded — the tracker is not a credit filter')
  assert.equal(princess.credited, 1, 'and exactly one of them paid you experience')
  // Same zone, same key: the credit lives on the RUN, beside the kills it describes — and
  // `lastCreditedTs` dates YOUR kill, not the stranger's, which is exactly the distinction the
  // weekly lockout view rests on (`lastTs` here is the kill that paid you nothing).
  //
  // THE KEY IS THE OPEN WORLD, NOT d0 (JOS-166). `You have entered The Plane of Sky.` names no
  // instance, and there is no lockout on an open-world spawn — so this run is filed where it can
  // never green a ladder rung, while still counting toward the mob's kill history exactly as it
  // did before.
  assert.deepEqual(princess.tiers, {
    [TIER_OPEN_WORLD]: { count: 2, firstTs: MINE, lastTs: STRANGERS, credited: 1, lastCreditedTs: MINE }
  })
  assert.equal(princess.bestTier, TIER_OPEN_WORLD, 'and the summary reports no difficulty either')
})

test('an exp line is consumed once — it cannot credit the next mob that dies near you', () => {
  // Synthesized from the join's own rule rather than cut from the log: your kill claims the
  // line, and a stranger's kill four seconds later finds nothing left to claim. Without the
  // consume, every third-party kill after one of yours would celebrate.
  const lines = [
    '[Tue Aug 04 22:48:11 2026] You have entered The Plane of Sky.',
    '[Tue Aug 04 22:55:08 2026] You gain experience!',
    '[Tue Aug 04 22:55:08 2026] You have slain a thunder spirit princess!',
    '[Tue Aug 04 22:55:12 2026] A thunder spirit princess has been slain by Pesmerga!'
  ]
  const princess = replay(lines).mobs['a thunder spirit princess']
  assert.equal(princess.count, 2)
  assert.equal(princess.credited, 1, 'the second kill had no line of its own to claim')
})

test('the celebration surfaces all hang off the ONE credited predicate', () => {
  const app = readFileSync(
    new URL('../src/renderer/src/App.tsx', import.meta.url),
    'utf8'
  )
  // The signal AND the toast live inside the same `onKill` block, so gating the predicate gates
  // both — there is no second producer that could still speak for a stranger's kill.
  const onKill = /onKill:\s*\(\{[^}]*\}\)\s*=>\s*\{([\s\S]*?)\n\s{4}\}/.exec(app)
  assert.ok(onKill, 'the always-mounted detector wires onKill to a block')
  assert.match(onKill[1], /fireAppSignal\('bossDefeat'/)
  assert.match(onKill[1], /window\.eq\.showToast\(/)

  // And the predicate itself reads `credited`, never the raw count.
  const status = readFileSync(
    new URL('../src/renderer/src/features/bosses/bossStatus.ts', import.meta.url),
    'utf8'
  )
  const fn = /export function bossKills\(([\s\S]*?)\n\}/.exec(status)
  assert.ok(fn, 'bossKills is still the single exported predicate')
  assert.match(fn[1], /s\.credited > prevCredited/)
  assert.equal(/s\.count > prev/.test(fn[1]), false, 'the raw-count comparison is gone')
})
