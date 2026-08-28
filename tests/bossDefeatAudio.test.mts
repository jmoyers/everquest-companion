// THE BOSS-DEFEAT SOUND FIRES ON EVERY KILL (owner, 2026-08-04: "every time is worth
// celebrating").
//
// WHAT IT USED TO BE. Task #24 split boss detection in two: `bossKills` (any kill, including a
// repeat at the same instance tier) drove the confetti, the card flash and the snackbar, while a
// narrower `newDefeats` (first kill at a NEW tier) drove the `bossDefeat` app signal — the
// alert sound — alone. The consequence was a screen that cheered and a room that stayed quiet:
// kill Lord Nagafen on Tuesday and again on Thursday and only Tuesday made a sound. The gate was
// a first-time-only SIGNAL EMISSION, not a def-level dedupe and not the celebrations law.
//
// WHAT IT IS NOW. One predicate — `bossKills` — behind confetti, snackbar AND sound. `newDefeats`
// is gone rather than left unused, because a second defeat predicate sitting in the file is how
// the split grows back. Rate limiting is the alert's own `cooldownMs`, applied by `fireAppSignal`.
//
// WHAT CHANGED UNDER IT (2026-08-05): that predicate now compares the CREDITED kill count rather
// than the raw one, so a boss killed by a stranger in open world is tracked and celebrated by
// nobody. Every kill in this file is yours, which is why every assertion below reads the same as
// it always did; the credit rule itself is pinned in tests/bossCreditedKills.test.mts.
//
// WHAT DID NOT CHANGE, and must not: the BASELINE. The celebrations law (AGENTS.md) is about
// replay vs live, not first vs every — a character switch re-hydrates every historical kill and
// must celebrate none of them. `useBossKills` seeds `prevRef` silently on the first snapshot and
// only compares afterwards; T3 below pins that guard is still in the source.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { allStatuses, bossKills } from '../src/renderer/src/features/bosses/bossStatus'
import type { KillMap, KillTierRun, RaidTarget } from '../src/shared/types'

const NAGAFEN: RaidTarget = {
  name: 'Lord Nagafen',
  category: 'Dragons',
  match: ['Lord Nagafen']
} as RaidTarget

/**
 * A kill map holding ONE mob, at one tier, killed `count` times — all of them CREDITED to you
 * (an experience line joined each slain line). That is what these tests are about: this file
 * pins "a repeat kill of YOUR boss still celebrates", and whether a kill is yours at all is the
 * separate predicate pinned in tests/bossCreditedKills.test.mts.
 */
function killed(count: number, tier: number, lastTs: number): KillMap {
  const run: KillTierRun = { count, firstTs: 1_785_000_000_000, lastTs, credited: count }
  return {
    'lord nagafen': {
      count,
      bestTier: tier,
      firstTs: run.firstTs,
      lastTs,
      credited: count,
      display: 'Lord Nagafen',
      tiers: { [tier]: run }
    }
  }
}

function prevOf(kills: KillMap): Map<string, ReturnType<typeof allStatuses>[number]> {
  return new Map(allStatuses([NAGAFEN], kills).map((s) => [s.target.name, s]))
}

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('B1 a REPEAT kill at the SAME tier is a kill — the case the sound used to miss', () => {
  const prev = prevOf(killed(1, 0, 1_785_000_000_000))
  const next = allStatuses([NAGAFEN], killed(2, 0, 1_785_000_600_000))

  const fired = bossKills(prev, next)
  assert.equal(fired.length, 1, 'the second kill counts')
  assert.equal(fired[0].status.target.name, 'Lord Nagafen')
  assert.equal(fired[0].status.count, 2)
  assert.equal(fired[0].status.bestTier, 0, 'no new tier was reached — that used to be the disqualifier')
  assert.equal(fired[0].tier, 0, 'and the kill reports the tier it happened on (JOS-165)')

  // The third, the fourth, the tenth: nothing about the predicate decays with repetition.
  const third = allStatuses([NAGAFEN], killed(3, 0, 1_785_001_200_000))
  assert.equal(bossKills(prevOf(killed(2, 0, 1_785_000_600_000)), third).length, 1)
})

test('B2 no kill, no signal — the credited count must actually move', () => {
  const same = killed(2, 0, 1_785_000_600_000)
  assert.equal(bossKills(prevOf(same), allStatuses([NAGAFEN], same)).length, 0, 'a re-render is not a kill')

  // An unkilled roster entry is never a defeat, and a FIRST kill still is (the old predicate's
  // one true case is still true).
  assert.equal(bossKills(prevOf({}), allStatuses([NAGAFEN], {})).length, 0)
  assert.equal(bossKills(prevOf({}), allStatuses([NAGAFEN], killed(1, 0, 1_785_000_000_000))).length, 1)
})

test('B3 the sound rides the every-kill callback, and the baseline guard is still there', () => {
  // THE DETECTOR MOVED OUT OF App.tsx IN JOS-510, and the claim did not move with it — it got
  // stricter. It used to run at the app's ROOT, so every push to the four modules these watches
  // read re-rendered the whole application tree; it now lives in `components/AppCelebrations.tsx`,
  // a component whose entire output is two snackbars. "SINGLE always-mounted detector" is
  // unchanged and is still the rule being pinned: the emitter is asked for in the file that holds
  // the detector, and App.tsx is separately asked to no longer hold one.
  const app = read('../src/renderer/src/App.tsx')
  const celebrations = read('../src/renderer/src/components/AppCelebrations.tsx')
  const hook = read('../src/renderer/src/features/bosses/useBossKills.ts')
  const status = read('../src/renderer/src/features/bosses/bossStatus.ts')

  // ONE signal call site (AGENTS.md: app signals fire from single always-mounted detectors),
  // and it is inside `onKill` — the callback that fires for repeats too.
  const calls = celebrations.match(/fireAppSignal\('bossDefeat'/g) ?? []
  assert.equal(calls.length, 1, 'exactly one bossDefeat emitter in the celebration surface')
  assert.equal(
    (app.match(/fireAppSignal\('bossDefeat'/g) ?? []).length,
    0,
    'the app root grew a second always-mounted boss detector'
  )
  // The callback takes the KILL, not the target (JOS-165): `{ status: s, tier }`.
  const onKill = /onKill:\s*\(\{[^}]*\}\)\s*=>\s*\{([\s\S]*?)\n\s{4}\}/.exec(celebrations)
  assert.ok(onKill, 'the detector wires onKill to a block')
  assert.match(onKill[1], /fireAppSignal\('bossDefeat', s\.target\.name\)/)

  // The narrow predicate is GONE as CODE from both the hook's surface and the pure module — an
  // unused second definition of "defeat" is how the split grows back. All three files still
  // NAME it in prose, deliberately: the next reader should learn it was retired on purpose
  // rather than rediscover the idea, so the check strips comments instead of banning the word.
  const code = (src: string): string => src.replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, '')
  assert.equal(
    /onNewDefeat/.test(code(app) + code(celebrations) + code(hook)),
    false,
    'no first-kill-only callback remains'
  )
  assert.equal(/newDefeats/.test(code(status) + code(hook)), false, 'and no first-kill-only predicate')

  // THE CELEBRATIONS LAW IS UNTOUCHED: hydration still seeds a silent baseline (`prevRef`
  // starts null and is only compared once set), which is what keeps replay quiet.
  assert.match(hook, /prevRef\s*=\s*useRef<Map<string, TargetStatus>\s*\|\s*null>\(null\)/)
  assert.match(hook, /if \(prev != null\) \{/)
})
