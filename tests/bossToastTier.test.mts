// THE CELEBRATION TOAST NAMES THE KILL YOU JUST MADE, NOT YOUR CAREER BEST (JOS-165).
//
// THE INCIDENT, owner 2026-08-09: a Maestro of Rancor kill in a d1 (Awakened) Plane of Hate solo
// raid, and a toast that said d3. The characterization (posted on the ticket) reproduced the whole
// session off the real log: the Maestro toast at 17:29:39 actually read "D4 · Refined · Plane of
// Hate", and the d3 the owner saw was High Priest M`kari 83 seconds earlier — a DIFFERENT boss in
// the same pull sequence, whose career best genuinely is d3. Both toasts were wrong in the same
// way, and so were the other ten that session: every one of them printed `tierStyle(s.bestTier)`,
// the target's ALL-TIME highest tier, plus the roster's static zone string.
//
// WHY THAT IS A BUG AND NOT A SUMMARY (owner semantics, build-brief law): the player repeats his
// clears at LOWER tiers every week — d0 through d4 each — so the last kill of a target is
// routinely below its best. A toast is a sentence about a thing that just happened; it must
// announce the tier the kill HAPPENED ON. The boss CARD keeps the highest-ever badge, because a
// card is a summary and a toast is an event.
//
// THE FIX: `bossKills` returns a BossKill — the status plus the tier whose CREDITED count just
// grew — and the toast reads that tier plus the live zone from the character module.
//
// Fixture: tests/fixtures/bosstier-maestro-ladder.log, cut verbatim from the owner's log by
// tests/extract-boss-tier-fixtures.mjs (raw 839935, 847286-847293, 853620, 863975-863982,
// 1485672, 1489474-1489479): one mob killed at d3, then d4, then — nine days later — d1.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { KillsModule } from '../src/main/modules/kills'
import { CharacterModule } from '../src/main/modules/character'
import { allStatuses, bossKills, type TargetStatus } from '../src/renderer/src/features/bosses/bossStatus'
import { tierStyle } from '../src/renderer/src/lib/tierChip'
import { TIER_UNKNOWN } from '../src/shared/kills'
import type { RaidTarget } from '../src/shared/types'
import { readFixture } from './harness.mts'

/** The roster row as bosses.json really spells it (Plane of Hate). */
const MAESTRO: RaidTarget = {
  name: 'Maestro of Rancor',
  category: 'Plane of Hate',
  match: ['Maestro of Rancor'],
  zone: 'Plane of Hate'
}

/** One toast, exactly as App.tsx builds it from a BossKill. */
interface Toast {
  title: string
  subtitle: string
  /** The status the same kill handed the cards — where `bestTier` still lives. */
  bestTier: number
}

/**
 * Replay the fixture through the REAL kills + character modules and collect the toast every
 * credited kill produced, in order. This is the app's live path with React removed: `useBossKills`
 * folds a delta, diffs the previous statuses against the new ones and calls `onKill` for each
 * kill, and App.tsx composes the subtitle from the kill's tier and the character module's zone.
 */
function toasts(lines: string[]): Toast[] {
  const kills = new KillsModule()
  const who = new CharacterModule()
  kills.reset()
  who.reset()
  const out: Toast[] = []
  let prev = new Map<string, TargetStatus>()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    kills.onEvent(ev)
    who.onEvent(ev)
    if (ev.kind !== 'death') continue
    const next = allStatuses([MAESTRO], kills.snapshot().state.mobs)
    const zone = who.snapshot().state.zone
    for (const { status: s, tier } of bossKills(prev, next)) {
      out.push({
        title: `${s.target.name} defeated`,
        subtitle: [tierStyle(tier).long, zone ?? s.target.zone].filter(Boolean).join(' · '),
        bestTier: s.bestTier
      })
    }
    prev = new Map(next.map((s) => [s.target.name, s]))
  }
  return out
}

test('the ladder: d3, then d4, then d1 — each toast names its OWN kill', () => {
  const fired = toasts(readFixture('bosstier-maestro-ladder.log'))

  assert.equal(fired.length, 3, 'three credited kills, three celebrations')
  assert.deepEqual(
    fired.map((t) => t.subtitle),
    [
      'D3 · Fused · The Plane of Hate - Solo 3 (Fused)',
      'D4 · Refined · The Plane of Hate - Solo 4 (Refined)',
      'D1 · Awakened · The Plane of Hate - Solo 1 (Awakened)'
    ]
  )
  // Every one of them is the same target — this is one boss climbing and descending the ladder,
  // which is exactly the case a career-best badge cannot describe.
  for (const t of fired) assert.equal(t.title, 'Maestro of Rancor defeated')
})

test('THE INCIDENT: the Sun Aug 09 17:29 kill toasts D1 while the record still says d4', () => {
  const fired = toasts(readFixture('bosstier-maestro-ladder.log'))
  const last = fired[fired.length - 1]

  // The regression, in one pair of assertions: the fold's summary is unchanged and still says
  // d4 (the card badge reads this, and is right to), while the toast says the d1 that just
  // happened. Before the fix these two were the same number and the toast read "D4 · Refined".
  assert.equal(last.bestTier, 4, 'the all-time best is untouched — the card still badges d4')
  assert.equal(last.subtitle, 'D1 · Awakened · The Plane of Hate - Solo 1 (Awakened)')
  assert.ok(!last.subtitle.includes('Refined'), 'the career best never appears alone on a toast')
})

test('the zone is the INSTANCE you stood in, not the roster string', () => {
  const fired = toasts(readFixture('bosstier-maestro-ladder.log'))

  // The roster says "Plane of Hate" for all three kills; the log says which instance each one
  // happened in, and the toast now says what the log says (raw, as the game spells it).
  assert.deepEqual(
    fired.map((t) => t.subtitle.split(' · ')[2]),
    [
      'The Plane of Hate - Solo 3 (Fused)',
      'The Plane of Hate - Solo 4 (Refined)',
      'The Plane of Hate - Solo 1 (Awakened)'
    ]
  )
  for (const t of fired) assert.ok(t.subtitle !== `${tierStyle(t.bestTier).long} · Plane of Hate`)
})

test('a target whose zone was never seen falls back to the roster, and invents nothing', () => {
  // The same kills with every `You have entered` line removed: the character module has no zone,
  // so the subtitle keeps the roster's. The TIER comes off the kill record rather than the zone
  // string, and a kill folded before any zone line has no difficulty on it.
  //
  // IT USED TO SAY "D0 · base" HERE (JOS-166). That was the conflation this ticket removed: a
  // kill with no zone line behind it states nothing about where it happened, and announcing the
  // base difficulty for it is the app inventing the one fact the log withheld. The toast now says
  // the difficulty was not stated — the same sentence an instance adjective we cannot decode
  // would produce, because they are the same claim.
  const blind = readFixture('bosstier-maestro-ladder.log').filter((l) => !l.includes('You have entered'))
  const fired = toasts(blind)

  assert.equal(fired.length, 3)
  for (const t of fired) assert.equal(t.subtitle, 'Difficulty not stated · Plane of Hate')
  assert.equal(tierStyle(TIER_UNKNOWN).long, 'Difficulty not stated', 'and the app spells it once')
})
