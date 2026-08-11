import { type JSX, useMemo } from 'react'
import { Box, Chip, Paper, Stack, Typography } from '@mui/material'
import type {
  AAEvent,
  LevelingDelta,
  LevelingSnap,
  ProgressionDelta,
  ProgressionSnap
} from '@shared/types'
import { computeAAAccounting } from '@shared/aa'
import { aaPace, type AaPace } from '@shared/aaPace'
import { useModule } from '../../lib/useModule'
import { formatDate } from '../../lib/formatDate'
import {
  buildLevelSegments,
  latestLevel,
  levelFeedEntries,
  peakLevel,
  sortLevels,
  swapCount,
  type LevelPoint,
  type LevelSegment
} from './levelSeries'
import { AreaChart, LevelStepChart, SWAP_COLOR, ZoneLegendStrip, type ChartChrome } from './levelCharts'
import { CHART_W, fmtDelta, type AaPoint } from './levelChartGeometry'
import { PAD_X, mergeZoneBands, zoneLegend, type DataBounds, type ZoneLegend } from './zoneBands'
// The window math (JOS-71): the pad, the bucket grid and the two series clips. Since JOS-130 the
// PICK is no longer this tab's own — it is the app-wide timeslice, and these are the drawing rules
// whatever slice is in force.
import { visibleFrom, visibleSegments, windowFor, windowOver, type TimescaleId } from './chartWindow'
// THE TIMESLICE (JOS-130): the one control every loot and xp analysis surface reads. It absorbed
// this tab's timescale — the duration rungs are four more slices in the same id space — so a
// reader who narrows to this session on the Loot ledger finds the xp rates already narrowed.
import { SliceBar } from '../timeslice/SliceBar'
import { useTimeslice } from '../timeslice/useTimeslice'
import { TAIL_MS, sliceDurationMs, type SliceId, type SliceRange, type Timeslice } from '@shared/timeslice'
// The SCOPE (JOS-75): which stretch of the log every number on this tab describes. The timescale
// moved the curves; this moves the arithmetic with them — one `rangeStats` call over one range,
// narrowed by a drag when there is one. Nothing here re-derives a rate.
import { scopedStats, type ScopedStats } from './windowScope'
import { useChartSelection } from './useChartSelection'
import { EMPTY_PROGRESSION, applyProgressionDelta } from './progressionDelta'
import { RangeStatsPanel } from './RangeStatsPanel'
import { comboSource } from './comboAdapter'
import { useComboIntervals } from '../profiles/ClassComboData'
// The module fold moved beside the view (levelingModule.ts) the day a SECOND reader appeared:
// the always-mounted ding detector behind the level-up toast watches the same append-only series.
import { EMPTY_LEVELING, applyLevelingDelta } from './levelingModule'
// The four hero cards — split into their own file the day this one reached the measured ceiling.
import { LevelingHeroes } from './LevelingHeroes'
import { NewAtLevelPanel } from './NewAtLevelPanel'
// The per-ability AA ladder — the flat purchases list's replacement in the same slot.
import { AaLedgerPanel } from './AaLedgerPanel'
// AA pace (AA/hr, points/hr, next-AA estimate, potion charges) — the tab's answer once the
// level bar caps out. It used to be pinned to the Overview card's "last hour of LOG time"
// window; since JOS-75 it reads the tab's own SCOPE, like every other number here, and states
// which one it got. The Overview card keeps its hour — that surface has no timescale to follow.
import { AaPacePanel } from './AaPacePanel'
// What DROPPED in the scope (JOS-78) — the loot half of the same question the rates answer. It
// takes the whole `ScopedStats` and derives its own rows (pure `shared/lootRates.ts`), so this
// view stays a composition and no second denominator can ever be assembled here.
import { WindowDropsPanel } from './WindowDropsPanel'

interface FeedItem {
  ts: number
  kind: 'level' | 'aa' | 'swap'
  label: string
  detail: string
}

const FEED_COLOR: Record<FeedItem['kind'], string> = {
  level: '#d9b25f',
  aa: '#6fb3d2',
  swap: SWAP_COLOR
}

/**
 * Cumulative AA gained. Deliberately NOT the earned headline: this is Σ of the gain
 * lines, so points re-gained after a respec are counted again and the curve runs
 * ahead of `earned` — the caption says so rather than quietly reconciling them.
 * Nothing is drawn until there are two points to draw a line between.
 */
function AaOverTimePanel({
  points,
  drawn,
  aaEarned,
  chrome
}: {
  /** the WHOLE series — it decides whether this character has a curve at all. */
  points: AaPoint[]
  /** the part of it inside the chosen timescale — what the chart draws and the hover reads. */
  drawn: AaPoint[]
  aaEarned: number
  chrome: ChartChrome
}): JSX.Element | null {
  if (points.length < 2) return null
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle2">AA gained over time</Typography>
      <Typography variant="caption" color="text.secondary" gutterBottom display="block">
        cumulative gain lines - includes points re-gained after a respec, so the final
        value runs ahead of the {aaEarned.toLocaleString()} earned headline
      </Typography>
      <AreaChart points={drawn} color="#6fb3d2" chrome={chrome} />
    </Paper>
  )
}

/** Level over time, with the caption that explains the dashed class-swap breaks. */
function LevelOverTimePanel({
  segments,
  levelCount,
  swaps,
  aaPoints,
  chrome,
  legend
}: {
  /** the runs inside the chosen timescale (the whole history at `All`). */
  segments: LevelSegment[]
  /** dings in the WHOLE series — it decides whether this character has a curve at all. */
  levelCount: number
  swaps: number
  /** Context for the hover readout only ("AA gained by then") — nothing is drawn from it. */
  aaPoints: AaPoint[]
  chrome: ChartChrome
  /** The zone legend for the shared domain. Rendered ONCE, under the lower chart: the band
   *  strip is identical on both plots, so a second copy would be pure noise. */
  legend: ZoneLegend
}): JSX.Element | null {
  if (levelCount < 2) return null
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle2">Level over time</Typography>
      <Typography variant="caption" color="text.secondary" gutterBottom display="block">
        {swaps > 0 ? (
          <>
            steps hold until the next ding; a{' '}
            <Box component="span" sx={{ color: SWAP_COLOR }}>
              dashed break
            </Box>{' '}
            is a class swap - the level is re-reported for the new loadout, not lost
          </>
        ) : (
          'steps hold until the next ding'
        )}
      </Typography>
      <LevelStepChart segments={segments} color="#d9b25f" aaPoints={aaPoints} chrome={chrome} />
      <ZoneLegendStrip legend={legend} fmtDuration={fmtDelta} />
    </Paper>
  )
}

/**
 * Interleaved level/AA/swap feed, newest first — SCOPED like every other number on the tab
 * (JOS-75). A feed still listing last week's dings under an hour-wide chart is the same
 * disagreement the rates had.
 *
 * The empty case is STATED. A narrow window legitimately holds no ding and no gain line, and a
 * silently empty box reads as a broken panel rather than as a quiet hour.
 */
function ProgressFeedPanel({ feed, scopeLabel }: { feed: FeedItem[]; scopeLabel: string }): JSX.Element {
  return (
    <Paper variant="outlined" sx={{ p: 2, flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Typography variant="subtitle2" gutterBottom>
        Recent progress
      </Typography>
      {feed.length === 0 && (
        <Typography variant="caption" color="text.secondary" data-testid="leveling-feed-empty">
          no level-ups or AA gains in {scopeLabel}
        </Typography>
      )}
      <Box sx={{ overflow: 'auto', pr: 0.75 }}>
        {feed.map((f, i) => (
          <Stack
            key={`${f.ts}-${f.kind}-${i}`}
            direction="row"
            spacing={1}
            alignItems="center"
            sx={{ py: 0.4 }}
          >
            <Chip
              size="small"
              label={f.label}
              sx={{
                height: 20,
                bgcolor: `${FEED_COLOR[f.kind]}22`,
                color: FEED_COLOR[f.kind],
                fontWeight: 700,
                minWidth: 68
              }}
            />
            <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }} noWrap>
              {f.detail}
            </Typography>
            <Typography variant="caption" color="text.disabled" noWrap>
              {formatDate(f.ts)}
            </Typography>
          </Stack>
        ))}
      </Box>
    </Paper>
  )
}

interface LevelingCharts {
  /** null only when NOTHING in any series carries a timestamp — the view shows its empty state. */
  chrome: ChartChrome | null
  legend: ZoneLegend
  /**
   * THE ONE SCOPE every number on this tab reads (JOS-75): the timescale's window, or the drag
   * that narrowed it. Null exactly when `chrome` is — there is no scope without a domain.
   */
  scope: ScopedStats | null
  clear: () => void
  /** The AA curve CLIPPED to the window. Drawn by the chart and read by its hover layer — one
   *  array, so the tooltip can never name a point the curve does not show. */
  aaVisible: AaPoint[]
  /** The level runs clipped to the same window, with the same one-array rule. */
  segVisible: LevelSegment[]
}

/**
 * Everything the two charts must AGREE on, derived once.
 *
 * The domain is the seam (plan §6.1): both charts used to compute their own `t0/t1`, so a
 * zone band or a range selection at the same pixel meant two different instants. One
 * `ChartScale` over the level dings + AA gains + every progression column feeds the strip,
 * the drag selection and both plots — and since JOS-71 the TIMESCALE replaces that one object
 * wholesale, so a zoom moves everything at once or nothing at all (world-model law 9).
 *
 * The selection lives here (one hook call, not one per chart) — that is what makes a drag on
 * the AA chart and a drag on the level chart the SAME selection, with the newer one winning.
 */
function useLevelingCharts(o: {
  prog: ProgressionSnap
  aas: readonly AaPoint[]
  segments: readonly LevelSegment[]
  /** The slice in force, app-wide (JOS-130). Already resolved against what this log can define. */
  slice: Timeslice
  /** Where the record starts and ends. It is where a window's numbers stop: the drawn window runs
   *  past the newest event by design (the trailing gutter), and counting that as time would invent
   *  silence. See windowScope.ts rule 2. */
  bounds: DataBounds | null
}): LevelingCharts {
  const { prog, aas, segments, slice, bounds } = o
  // A FIXED-LENGTH RUNG SLIDES; EVERY OTHER SLICE STATES BOTH ENDS. The rung keeps JOS-71's window
  // verbatim — anchored on the newest event, snapped outward to the bucket grid so it advances a
  // whole bucket at a time — and hands its stats range to `statsRangeFor` as it always did. A
  // semantic slice (this session, this zone, a custom pair) is anchored on the DATA at both ends,
  // like `All`, so it draws with `windowOver` and carries its own exact range into the numbers.
  const fixed = sliceDurationMs(slice.id) != null
  const scale = useMemo(() => {
    if (!bounds) return null
    // `- TAIL_MS`: the slice's range ends one ms past the newest event so the half-open query
    // holds it; the DRAWN domain wants the event's own instant, which is what `All` has always
    // drawn (`windowFor(lo, hi, 'full')` is `windowOver(lo, hi)`, byte for byte).
    const drawnEnd = Math.max(slice.range.t0, slice.range.t1 - TAIL_MS)
    const win = fixed
      ? windowFor(bounds.lo, bounds.hi, slice.id as TimescaleId)
      : windowOver(slice.range.t0, drawnEnd)
    return { ...win, w: CHART_W, padX: PAD_X }
  }, [bounds, slice, fixed])
  // The two windowed series. Both charts and both hover layers read exactly these.
  const aaVisible = useMemo(() => (scale ? visibleFrom(aas, scale.t0) : []), [aas, scale])
  const segVisible = useMemo(() => (scale ? visibleSegments(segments, scale.t0) : []), [segments, scale])
  const bands = useMemo(() => (scale ? mergeZoneBands(prog, scale.t0, scale.t1) : []), [prog, scale])
  const legend = useMemo(() => zoneLegend(bands), [bands])
  const { sel, draft, dragging, clear, onPointerDown, onPointerMove, onPointerUp, onPointerCancel } =
    useChartSelection(scale)
  // The combo seam (progressionStats §ComboSource). `rangeStats` declared the SHAPE it needs and
  // never imports the combo module, so the adapter beside this file is what reconciles the two
  // `ComboInterval` types — and passing it here is the whole reason the range panel's combo chip
  // has anything to print.
  const intervals = useComboIntervals()
  const combo = useMemo(() => comboSource(intervals), [intervals])
  // ONE query, whichever scope won. The losing candidate is never computed — widening the tab's
  // scope-awareness took a `rangeStats` call OUT of this view rather than adding one.
  const scope = useMemo(
    () =>
      scale && bounds
        ? scopedStats({
            snap: prog,
            win: scale,
            bounds,
            // The rung's own id still supplies the JOS-71 clamp; a semantic slice hands its exact
            // range in and the id is then only a fallback nothing reaches.
            id: fixed ? (slice.id as TimescaleId) : 'full',
            range: fixed ? undefined : slice.range,
            zoneKey: slice.zoneKey,
            zoneName: slice.zoneName,
            label: slice.caption,
            selection: sel,
            combo
          })
        : null,
    [scale, bounds, prog, slice, fixed, sel, combo]
  )
  // Rebuilt narrow, NOT the whole SelectionApi: the charts spread this straight onto a DOM
  // element, so anything else on the object would land there as an unknown attribute.
  const pointer = { onPointerDown, onPointerMove, onPointerUp, onPointerCancel }
  const chrome = scale ? { scale, bands, range: draft ?? sel, suppressed: dragging, pointer } : null
  return { chrome, legend, scope, clear, aaVisible, segVisible }
}

/**
 * The interleaved level/AA/swap feed, newest first — a pure derivation, lifted out of the view
 * so the component stays inside its measured line budget.
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
function buildFeed(levels: readonly LevelPoint[], aas: readonly AAEvent[]): FeedItem[] {
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

/** How many feed rows the panel draws. Applied AFTER the scope filter — see `buildFeed`. */
const FEED_MAX = 60

/**
 * The two reads that follow the SCOPE rather than the character: the progress feed cut to it, and
 * the AA pace measured over it (JOS-75). Its own hook so the view stays inside the measured line
 * budget and so the pairing is stated once — both describe the same stretch or neither does.
 *
 * The feed is filtered THEN capped: a `.slice(0, 60)` first would take the sixty newest entries in
 * the whole log and then filter, so a slice sitting behind them would come up empty with events
 * plainly drawn on the chart above it.
 */
function useScopedReads(o: {
  scope: ScopedStats | null
  feed: FeedItem[]
  state: LevelingSnap
  prog: ProgressionSnap
}): { feed: FeedItem[]; pace: AaPace | null } {
  const { scope, feed, state, prog } = o
  const scoped = useMemo(
    () => (scope ? feed.filter((f) => f.ts >= scope.range.t0 && f.ts <= scope.range.t1) : feed).slice(0, FEED_MAX),
    [feed, scope]
  )
  // Null before the snapshot has folded anything at all, and for a character with no AA in the log.
  const pace = useMemo(
    () => (scope && state.aaGains.length > 0 ? aaPace({ leveling: state, prog, window: scope.stats }) : null),
    [scope, prog, state]
  )
  return { feed: scoped, pace }
}

/** The record's bounds also depend on THIS tab's own two series, which the progression snapshot
 *  does not carry. Memoized here because the timeslice hook takes it as a dependency. */
function useExtraTs(levels: readonly LevelPoint[], aas: readonly AaPoint[]): number[] {
  return useMemo(() => [...levels.map((p) => p.ts), ...aas.map((a) => a.ts)], [levels, aas])
}

/**
 * The charts column: the AA pace tiles, the timescale control, the two plots, and the window's
 * own read under them. Its own component because the column is where the scope becomes visible —
 * every surface in it describes the SAME stretch of time, and keeping them in one place is what
 * makes that reviewable (it also keeps the view inside its measured line budget).
 *
 * It OWNS ITS SCROLL (the standing list law) WHILE IT IS A COLUMN: the papers are intrinsically
 * tall, and without this the column grew the app's content area instead — the one thing a view
 * may never do. Below `lg` there are no columns to share a height, so it hands the scroll up to
 * the stack that holds it (JOS-151) and takes its natural height instead.
 */
function ChartsColumn(p: {
  chrome: ChartChrome
  scope: ScopedStats
  charts: Pick<LevelingCharts, 'legend' | 'clear' | 'aaVisible' | 'segVisible'>
  pace: AaPace | null
  aaPoints: AaPoint[]
  aaEarned: number
  levelCount: number
  swaps: number
  slice: Timeslice
  available: SliceId[]
  onPick: (id: SliceId) => void
  onCustom: (range: SliceRange) => void
}): JSX.Element {
  const { chrome, scope, charts } = p
  return (
    <Stack
      spacing={2}
      sx={{
        // Two thirds of the height while there are two columns to share one; below `lg` it is
        // simply the first band of a single column, so it takes its natural height, hands the
        // scroll up, and drops the 320px floor that would otherwise push the page sideways.
        flex: { xs: '0 0 auto', lg: 2 },
        minWidth: { lg: 320 },
        minHeight: 0,
        overflow: { xs: 'visible', lg: 'auto' },
        pr: { lg: 0.5 }
      }}
    >
      {p.pace && <AaPacePanel pace={p.pace} windowLabel={scope.label} />}
      {/* Directly above the plots it governs, and ABOVE BOTH of them: the two charts draw one
          time base, so there is one control for it — and since JOS-75 one scope under it. Since
          JOS-130 it is the APP'S control, not this tab's (features/timeslice). */}
      <SliceBar
        available={p.available}
        slice={p.slice}
        onPick={p.onPick}
        onCustom={p.onCustom}
        testId="leveling-slice"
      />
      <AaOverTimePanel points={p.aaPoints} drawn={charts.aaVisible} aaEarned={p.aaEarned} chrome={chrome} />
      <LevelOverTimePanel
        segments={charts.segVisible}
        levelCount={p.levelCount}
        swaps={p.swaps}
        aaPoints={charts.aaVisible}
        chrome={chrome}
        legend={charts.legend}
      />
      {/* ALWAYS mounted since JOS-75: it is the window's own read, narrowed by a drag while one
          exists. Below the plots it explains, so the picture stays the first thing on the tab. */}
      <RangeStatsPanel stats={scope.stats} scope={scope.kind} onClear={charts.clear} />
    </Stack>
  )
}

/**
 * The tab's deep-link payload: the level a level-up toast asked us to open on
 * (docs/plans/levelup-whats-new.md §2). Absent ⇒ a plain tab switch, and the panel follows the
 * character's own level. The nonce is the standing contract (appRouting.ts): the tab stays
 * MOUNTED across a link, so the same level asked for twice must arrive twice.
 */
export interface LevelingViewProps {
  focusLevel?: number | null
  focusNonce?: number
  onFocusConsumed?: () => void
  /**
   * The app's Loot opener (`AppRouting.openLoot`), handed down so the in-window drops panel can
   * link out to an item's drill-down (JOS-78). It is the SAME opener the Planner's donor names
   * use — every cross-view link goes through `useAppRouting`, which is what parks this tab on the
   * navigation stack so the drill's Back reads "Back to Leveling" (JOS-43).
   */
  onOpenLoot?: (item?: string) => void
}

export default function LevelingView({
  focusLevel = null,
  focusNonce = 0,
  onFocusConsumed,
  onOpenLoot
}: LevelingViewProps): JSX.Element {
  const state = useModule<LevelingSnap, LevelingDelta>('leveling', applyLevelingDelta) ?? EMPTY_LEVELING
  const { levels, aaGains: aas, aaSpends: spends } = state
  // The SECOND module this view reads: the capped, range-queryable analytics series behind
  // the zone bands and the range panel. Deliberately separate from `leveling`, whose
  // contract is "everything, forever" (see src/main/modules/progression.ts).
  const prog = useModule<ProgressionSnap, ProgressionDelta>('progression', applyProgressionDelta) ?? EMPTY_PROGRESSION

  const sortedLevels = useMemo(() => sortLevels(levels), [levels])
  const sortedAAs = useMemo(() => [...aas].sort((a, b) => a.ts - b.ts), [aas])

  // CURRENT level is the LATEST reported one, never max(). You level three classes at once
  // and a loadout swap re-reports the level of the new (lowest) class — so the peak belongs
  // to a class that may no longer be in the loadout. It's surfaced separately as "peak".
  const levelSegments = useMemo(() => buildLevelSegments(sortedLevels), [sortedLevels])
  const currentLevel = latestLevel(sortedLevels)
  const peak = peakLevel(sortedLevels)
  const swaps = swapCount(levelSegments)

  // Refund-proof AA accounting (Task #48). The headline is NOT Σ gains — a respec
  // refunds points with no log line, they re-enter as fresh gain lines, so Σ gains
  // double-counts every refunded point. Instead:
  //   allocated = latest-epoch cost per (ability,rank), cost-0 auto-grants excluded
  //   unspent   = last authoritative "you now have" − spends after it
  //   earned    = allocated + unspent   (the identity the user validated)
  // See src/shared/aa.ts for the full derivation.
  const acct = useMemo(() => computeAAAccounting(aas, spends), [aas, spends])
  const aaEarned = acct.earned
  const aaSpent = acct.allocated
  const aaUnspent = aas.length ? acct.unspent : null
  const boughtCount = acct.boughtCount

  // The purchases list itself moved into AaLedgerPanel, which regroups the same deduped
  // (ability, rank) purchases into per-ability LADDERS (src/shared/aaLedger.ts) — the model
  // always knew the rungs; only this view was flat.

  // `nowHave` rides along so the hover readout can state the unspent balance the gain line
  // itself reported, instead of re-deriving a balance the log already gave us.
  // `gain` rides along for the same reason: a windowed curve can open on a gain that has no
  // predecessor in the drawn array, and the tooltip must still name that LINE's own points.
  const aaCumulative = useMemo<AaPoint[]>(() => {
    let sum = 0
    return sortedAAs.map((a) => ({ ts: a.ts, y: (sum += a.amount), nowHave: a.nowHave, gain: a.amount }))
  }, [sortedAAs])

  const feed = useMemo(() => buildFeed(sortedLevels, sortedAAs), [sortedLevels, sortedAAs])

  // THE SLICE — app-wide, session-lifetime, `All` by default (features/timeslice/useTimeslice).
  const { bounds, available, slice, setId, setCustom } = useTimeslice(useExtraTs(sortedLevels, aaCumulative))
  const charts = useLevelingCharts({ prog, aas: aaCumulative, segments: levelSegments, slice, bounds })
  const { chrome, scope } = charts
  // The feed and the AA pace both follow that scope (JOS-75): the pace was its own hour-wide
  // window until the timescale existed, and now the tab has ONE answer to "which stretch".
  const { feed: scopedFeed, pace } = useScopedReads({ scope, feed, state, prog })

  const nothing = sortedLevels.length === 0 && sortedAAs.length === 0
  // One props object, two placements (see both call sites): the panel is the same surface in the
  // charted and the chart-less state, and spelling its four props twice is how they drift.
  const unlockPanel = {
    currentLevel,
    focusLevel,
    focusNonce,
    onFocusConsumed: onFocusConsumed ?? ((): void => undefined)
  }

  return (
    <Stack spacing={2} sx={{ height: '100%' }} data-testid="leveling-view">
      {/* THE FOUR HEROES DO NOT FOLLOW THE SCOPE, and that is a decision rather than an
          omission (JOS-75). Character level is your level RIGHT NOW — a level "as of an hour
          ago" is a different fact wearing this one's label. The three AA figures are the
          refund-proof identity (earned == allocated + unspent, shared/aa.ts): allocation is a
          balance, not a flow, and a windowed "earned" could only be Σ of the gain lines in
          range, which is precisely the double-counting world-model law 5 forbids. The windowed
          AA reads live one panel down, where they are labelled as rates. */}
      <LevelingHeroes
        currentLevel={currentLevel}
        levelCount={sortedLevels.length}
        peak={peak}
        swaps={swaps}
        aaEarned={aaEarned}
        aaSpent={aaSpent}
        aaUnspent={aaUnspent}
        boughtCount={boughtCount}
      />

      {nothing || !chrome || !scope ? (
        <Typography color="text.secondary" sx={{ p: 2 }} data-testid="leveling-empty">
          No level-ups or AA gains found in this character&apos;s log yet. They&apos;ll appear here live as you play.
        </Typography>
      ) : (
        // THE COLUMNS ONLY SHARE A HEIGHT WHILE THEY ARE SIDE BY SIDE (JOS-151, GitHub issue 14).
        // Below `lg` the row becomes a column, and a 2:1 split of a FIXED height then crushed the
        // second band until its papers overflowed and drew straight over "New at this level" —
        // measured at 1073x937, the reporter's window: the ledger squeezed to 89px and the feed to
        // 34px, both spilling. Stacked, the bands take their natural heights and THIS becomes the
        // scroller, which keeps the standing layout law (the view never grows the content area)
        // and matches what the combat dashboard already does when it collapses to one column.
        <Stack
          direction={{ xs: 'column', lg: 'row' }}
          spacing={2}
          data-testid="leveling-columns"
          sx={{ flexGrow: 1, minHeight: 0, overflowY: { xs: 'auto', lg: 'visible' }, pr: { xs: 0.5, lg: 0 } }}
        >
          <ChartsColumn
            chrome={chrome}
            scope={scope}
            charts={charts}
            pace={pace}
            aaPoints={aaCumulative}
            aaEarned={aaEarned}
            levelCount={sortedLevels.length}
            swaps={swaps}
            slice={slice}
            available={available}
            onPick={setId}
            onCustom={setCustom}
          />

          <Stack spacing={2} sx={{ flex: { xs: '0 0 auto', lg: 1 }, minWidth: { lg: 260 }, minHeight: 0 }}>
            {/* The AA LEDGER stays full-history on purpose: it is an ACCOUNT of what you have
                bought, and its footer must equal the AA-points-spent hero card. "AA allocated
                in the last hour" is not a thing anyone owns. */}
            <AaLedgerPanel spends={spends} allocated={aaSpent} />
            {/* SCOPED, like the feed below it: the items observed dropping in the stretch the
                charts are drawing, ordered by how many you saw. Clicking one opens its Loot
                drill-down through the app's own opener (JOS-43/JOS-78). */}
            <WindowDropsPanel scope={scope} onOpenItem={onOpenLoot} />
            <ProgressFeedPanel feed={scopedFeed} scopeLabel={scope.label} />
          </Stack>
        </Stack>
      )}

      {/* OUTSIDE the branch, and LAST. Outside because it is the one surface here that needs no
          log at all — "what do I get at 30" is answered by the committed DBs, so a character with
          too few dings to draw a chart still gets it, and rendering it in both arms would remount
          it (and drop a deep link's level) every time the charts appeared. Last because the two
          plots are what this tab is for at a glance; pushing them down a screen for a browsable
          reference panel would cost the primary surface its position. */}
      <NewAtLevelPanel {...unlockPanel} />
    </Stack>
  )
}
