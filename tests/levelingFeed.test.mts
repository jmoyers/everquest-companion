// PURE UNIT TESTS for the Leveling tab's progress feed
// (src/renderer/src/features/leveling/levelFeed.ts).
//
// No log, no fixture, no DOM — so this file never skips. `buildFeed` was private to `LevelingView`
// until JOS-511 split that view at its measured line ceiling; the derivation is unchanged, and this
// is the pin the extraction made possible. Four claims, and each is a thing the feed can get
// quietly wrong while still looking like a working panel:
//
//   1. NEWEST FIRST, ACROSS BOTH SERIES. The feed's whole job is interleaving dings with AA gains,
//      so a sort that only ordered within a series would still render a plausible list.
//
//   2. A POST-SWAP DING IS LABELLED, NEVER TIMED. The elapsed time back to the previous ding spans
//      an unlogged loadout swap, so a `+38.9h` there would be a fabricated "time to level" — the
//      one number on this panel that would be an invention rather than a reading (world-model law
//      1). The row says what happened instead.
//
//   3. THE FIRST DING CARRIES NO ELAPSED TIME AT ALL. It has no predecessor in the record, and an
//      empty detail is the honest answer where a zero would claim an instant level.
//
//   4. IT IS UNCUT. The view slices AFTER scoping (JOS-75) — a cap here would take the newest N in
//      the WHOLE log and then filter, so a window sitting behind them would come up empty with its
//      events plainly drawn on the chart above. Every input row comes out.
//
// Imported RELATIVELY: node tests run through tsx with no `@shared` alias.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFeed } from '../src/renderer/src/features/leveling/levelFeed'
import type { LevelPoint } from '../src/renderer/src/features/leveling/levelSeries'
import type { AAEvent } from '../src/shared/types'

const HOUR = 3_600_000
const T0 = 1_700_000_000_000

/** Three dings, the third of which is a class swap (the level goes DOWN, JOS-192's rule). */
const LEVELS: LevelPoint[] = [
  { ts: T0, level: 30 },
  { ts: T0 + 2 * HOUR, level: 31 },
  { ts: T0 + 5 * HOUR, level: 12 }
]

const AAS: AAEvent[] = [
  { ts: T0 + HOUR, amount: 1, nowHave: 4 } as AAEvent,
  { ts: T0 + 6 * HOUR, amount: 2, nowHave: 6 } as AAEvent
]

test('the feed is newest first, with both series interleaved', () => {
  const feed = buildFeed(LEVELS, AAS)
  const ts = feed.map((f) => f.ts)
  assert.deepEqual(ts, [...ts].sort((a, b) => b - a), 'rows are not in descending ts order')
  // The interleave itself: the newest row is an AA gain that falls BETWEEN nothing and the swap,
  // and the second row is the swap ding — a per-series sort could not produce this order.
  assert.equal(feed[0].kind, 'aa')
  assert.equal(feed[1].kind, 'swap')
  assert.equal(feed[2].kind, 'level')
})

test('a post-swap ding is labelled as a swap and states no elapsed time', () => {
  const feed = buildFeed(LEVELS, AAS)
  const swap = feed.find((f) => f.kind === 'swap')
  assert.ok(swap, 'the level-12 ding after a level-31 one is a swap')
  assert.equal(swap.label, 'Level 12 (class swap)')
  assert.equal(swap.detail, 'new loadout - level re-reported')
  // The load-bearing half: no `+3.0h`. That number exists and is arithmetically true; it is not a
  // time to level, because the span it measures contains a loadout change the log never printed.
  assert.ok(!/\+/.test(swap.detail), `a swap row must not state an elapsed time: ${swap.detail}`)
})

test('the first ding states no elapsed time, and a later one states its own', () => {
  const feed = buildFeed(LEVELS, [])
  const first = feed.find((f) => f.ts === T0)
  const second = feed.find((f) => f.ts === T0 + 2 * HOUR)
  assert.ok(first && second)
  assert.equal(first.detail, '', 'the first ding has no predecessor to measure against')
  assert.ok(second.detail.startsWith('+'), `the second ding states its own span: ${second.detail}`)
})

test('the feed is uncut - every input row comes out', () => {
  const many: LevelPoint[] = Array.from({ length: 80 }, (_, i) => ({ ts: T0 + i * HOUR, level: 10 + i }))
  assert.equal(buildFeed(many, AAS).length, many.length + AAS.length)
})
