// THE INTERLEAVED PROGRESS FEED — one pure derivation, in its own file (JOS-511).
//
// It lived inside `LevelingView` until that view reached the measured line ceiling and its folds
// moved out to `useLevelingSeries.ts`. It is here rather than in that file for one reason: this is
// the only piece of the move that is a PURE FUNCTION of two series, so it is the piece a node test
// can drive. `useLevelingSeries` imports `@shared/aa` as a VALUE for the AA headline, and node
// tests run through tsx with no `@shared` alias (the repo-wide `mobSearch.ts` rule) — so a
// derivation worth pinning has to sit where the alias is only ever a type.
//
// tests/levelingFeed.test.mts is that pin.

import type { AAEvent } from '@shared/types'
import { levelFeedEntries, type LevelPoint } from './levelSeries'
import { fmtDelta } from './levelChartGeometry'
import type { FeedItem } from './LedgerColumn'

/**
 * The interleaved level/AA/swap feed, newest first.
 *
 * A post-swap ding is the first level of a NEW loadout: the elapsed time back to the previous
 * ding spans the (unlogged) swap, so it is not a "time to level" — showing `+38.9h` there would
 * be fabricated. Label the swap instead.
 *
 * UNCUT, and the view slices it AFTER scoping (JOS-75): a `.slice(0, 60)` here would take the
 * sixty NEWEST entries in the whole log and then filter, so a window that sits behind them
 * would come up empty with events plainly drawn on the chart above it. Each `sinceMs` is still
 * measured against the ding's true predecessor, in or out of scope — the elapsed time to reach
 * a level is a fact about the level, not about what you are looking at.
 */
export function buildFeed(levels: readonly LevelPoint[], aas: readonly AAEvent[]): FeedItem[] {
  const items: FeedItem[] = []
  for (const e of levelFeedEntries(levels)) {
    items.push({
      ts: e.ts,
      kind: e.afterSwap ? 'swap' : 'level',
      label: e.afterSwap ? `Level ${e.level} (class swap)` : `Level ${e.level}`,
      detail: e.afterSwap ? 'new loadout - level re-reported' : e.sinceMs != null ? `+${fmtDelta(e.sinceMs)}` : ''
    })
  }
  for (const a of aas) {
    items.push({ ts: a.ts, kind: 'aa', label: `+${a.amount} AA`, detail: `${a.nowHave} unspent` })
  }
  return items.sort((a, b) => b.ts - a.ts)
}
