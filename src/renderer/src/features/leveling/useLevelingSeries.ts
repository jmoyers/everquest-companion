// THE TAB'S OWN SERIES — everything derived from the `leveling` snapshot alone (JOS-511).
//
// Its own file for the reason `LevelingHeroes` and `LedgerColumn` got theirs: `LevelingView`
// reached the measured `max-lines` ceiling and the rule here is to SPLIT rather than ratchet
// (AGENTS.md). This is the natural seam — five folds over ONE module snapshot, read by the charts,
// the heroes, the feed and the timeslice's bounds, and none of them touching a scope, a slice or a
// pointer. Nothing is re-decided; every comment travelled with the derivation it was written for.
//
// AND THE SEAM IS WHERE THE MEMOS BELONG. Each of these is a dependency of something bigger — the
// bounds the slice is resolved against, the segments the curve is folded over, the feed the scope
// filters — so their IDENTITIES are what decide whether the layer above them re-runs. Keeping them
// together is what makes that reviewable in one screen.

import { useMemo } from 'react'
import type { AAEvent, AASpendEvent, LevelingSnap } from '@shared/types'
import { computeAAAccounting } from '@shared/aa'
import { buildLevelSegments, sortLevels, type LevelPoint, type LevelSegment } from './levelSeries'
import type { AaPoint } from './levelChartGeometry'
import type { FeedItem } from './LedgerColumn'
// The feed is the one PURE piece of this move, so it sits where a node test can reach it — see
// levelFeed.ts's header, and tests/levelingFeed.test.mts.
import { buildFeed } from './levelFeed'

/**
 * THE REFUND-PROOF AA HEADLINE (Task #48), in the shape the four hero cards take.
 *
 * The identity is NOT Σ gains — a respec refunds points with no log line, they re-enter as fresh
 * gain lines, so Σ gains double-counts every refunded point. Instead:
 *   allocated = latest-epoch cost per (ability,rank), cost-0 auto-grants excluded
 *   unspent   = last authoritative "you now have" − spends after it
 *   earned    = allocated + unspent   (the identity the user validated)
 * See src/shared/aa.ts for the full derivation, and `AaOverTimePanel` for why the cumulative curve
 * is allowed to disagree with `earned`.
 *
 * Its keys are the hero card's prop names on purpose: the view spreads it straight onto
 * `LevelingHeroes`, which is one fewer place for four numbers to be mis-paired. `unspent` is null
 * rather than 0 for a character with no AA line at all — an unknown balance and an empty one are
 * different facts.
 */
export interface AaHeadline {
  aaEarned: number
  aaSpent: number
  aaUnspent: number | null
  boughtCount: number
}

export interface LevelingSeries {
  /** The dings, ascending. `peakLevel`/`swapCount` are questions about exactly this series. */
  sortedLevels: LevelPoint[]
  /** The AA gain lines, ascending. */
  sortedAAs: AAEvent[]
  /** The runs between swaps, over the sorted dings. */
  levelSegments: LevelSegment[]
  /**
   * Cumulative AA gained. Deliberately NOT the earned headline: this is Σ of the gain lines, so
   * points re-gained after a respec are counted again and the curve runs ahead of `earned`.
   *
   * `nowHave` rides along so the hover readout can state the unspent balance the gain line itself
   * reported, instead of re-deriving a balance the log already gave us. `gain` rides along for the
   * same reason: a windowed curve can open on a gain that has no predecessor in the drawn array,
   * and the tooltip must still name that LINE's own points.
   */
  aaCumulative: AaPoint[]
  /** The interleaved progress feed, UNCUT — see `buildFeed`. */
  feed: FeedItem[]
  /** The record's bounds also depend on THIS tab's own two series, which the progression snapshot
   *  does not carry. Memoized because the timeslice hook takes it as a dependency. */
  extraTs: number[]
  aa: AaHeadline
}

/** Every fold over the `leveling` snapshot, once. See the file header for why they live together. */
export function useLevelingSeries(state: LevelingSnap): LevelingSeries {
  const { levels, aaGains: aas, aaSpends: spends } = state
  const sortedLevels = useMemo(() => sortLevels(levels), [levels])
  // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives AAEvent. Becomes a view descriptor when the source lands.
  const sortedAAs = useMemo(() => [...aas].sort((a, b) => a.ts - b.ts), [aas])
  const levelSegments = useMemo(() => buildLevelSegments(sortedLevels), [sortedLevels])
  const aaCumulative = useMemo<AaPoint[]>(() => {
    let sum = 0
    return sortedAAs.map((a) => ({ ts: a.ts, y: (sum += a.amount), nowHave: a.nowHave, gain: a.amount }))
  }, [sortedAAs])
  const feed = useMemo(() => buildFeed(sortedLevels, sortedAAs), [sortedLevels, sortedAAs])
  const extraTs = useMemo(
    () => [...sortedLevels.map((p) => p.ts), ...aaCumulative.map((a) => a.ts)],
    [sortedLevels, aaCumulative]
  )
  const aa = useAaHeadline(aas, spends)
  return { sortedLevels, sortedAAs, levelSegments, aaCumulative, feed, extraTs, aa }
}

// Not `readonly`: `computeAAAccounting` declares mutable arrays, and these come straight off the
// module snapshot that already owns them. Widening here would only move the cast.
function useAaHeadline(aas: AAEvent[], spends: AASpendEvent[]): AaHeadline {
  const acct = useMemo(() => computeAAAccounting(aas, spends), [aas, spends])
  // MEMOIZED AS AN OBJECT TOO (JOS-511 item 2): the view SPREADS this onto `LevelingHeroes`, so a
  // fresh literal per render is four changed props on the hero row whatever moved on the tab.
  return useMemo(
    () => ({
      aaEarned: acct.earned,
      aaSpent: acct.allocated,
      aaUnspent: aas.length ? acct.unspent : null,
      boughtCount: acct.boughtCount
    }),
    [acct, aas]
  )
}
