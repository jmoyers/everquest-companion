import { type JSX, useMemo } from 'react'
import { Box, Paper, Stack, Typography } from '@mui/material'
import type {
  AAEvent,
  AASpendEvent,
  LevelingDelta,
  LevelingSnap,
  ProgressionDelta,
  ProgressionSnap
} from '@shared/types'
import { computeAAAccounting } from '@shared/aa'
import { aaPace, type AaPace } from '@shared/aaPace'
// "What level am I" is the STATED fact now (JOS-192) — the later of your last ding and your own
// `/who` row — not the tail of the dings. `peakLevel`/`swapCount` still read the ding series,
// because those two really are questions about the level-up record.
import { useStatedLevel } from './useStatedLevel'
import { useModule } from '../../lib/useModule'
import {
  buildLevelSegments,
  levelFeedEntries,
  peakLevel,
  sortLevels,
  swapCount,
  type LevelPoint,
  type LevelSegment
} from './levelSeries'
import { AreaChart, LevelStepChart, SWAP_COLOR, ZoneLegendStrip, type ChartChrome } from './levelCharts'
import { CHART_W, fmtDelta, type AaPoint } from './levelChartGeometry'
// THE FRACTIONAL CURVE (JOS-292): the dings are anchors now, and the percentages the game states
// between them are the rest of the picture. Derived HERE, in the same memo layer as the bands and
// the scope, so a pointermove still reaches nothing but the two selection bands (JOS-290).
import { levelCurve, type LevelCurve } from './levelCurve'
import { PAD_X, mergeZoneBands, zoneLegend, type DataBounds, type ZoneLegend } from './zoneBands'
// The window math (JOS-71): the pad, the bucket grid and the two series clips. Since JOS-130 the
// PICK is no longer this tab's own — it is the app-wide timeslice, and these are the drawing rules
// whatever slice is in force.
import { visibleFrom, visibleSegments, windowFor, windowOver, type TimescaleId } from './chartWindow'
// THE TIMESLICE (JOS-130): the one control every loot and xp analysis surface reads. It absorbed
// this tab's timescale — the duration rungs are four more slices in the same id space — so a
// reader who narrows to this session on the Loot ledger finds the xp rates already narrowed.
import { ScopeBar } from '../timeslice/ScopeBar'
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
// THE RIGHT COLUMN'S FIRST PANEL (JOS-445): of everything the loadout already owns, what is best at
// the level being viewed. It reads no scope and no chart — only the loadout — so it is the reason
// the right column can exist on a log the charts cannot draw.
import { BestSpellsPanel, useBestSpellsVisible } from './BestSpellsPanel'
// The tab's viewed level, lifted out of `NewAtLevelPanel` the day a second panel needed it.
import { useViewedLevel, type ViewedLevel } from './viewedLevel'
// The RIGHT column, whole: the AA ledger, the in-window drops and the progress feed, plus the
// `FeedItem` shape `buildFeed` below fills. Split out at the measured max-lines ceiling (JOS-300),
// on the LevelingHeroes precedent — the column is a composition over a scope and nothing else here
// reads its internals.
import { LedgerColumn, type FeedItem } from './LedgerColumn'
// AA pace (AA/hr, points/hr, next-AA estimate, potion charges) — the tab's answer once the
// level bar caps out. It used to be pinned to the Overview card's "last hour of LOG time"
// window; since JOS-75 it reads the tab's own SCOPE, like every other number here, and states
// which one it got. The Overview card keeps its hour — that surface has no timescale to follow.
import { AaPacePanel } from './AaPacePanel'

/**
 * Cumulative AA gained. Deliberately NOT the earned headline: this is Σ of the gain
 * lines, so points re-gained after a respec are counted again and the curve runs
 * ahead of `earned`.
 *
 * THE CAPTION STATES THE DISAGREEMENT, NOT ITS MECHANISM (owner, 2026-08-13). It used to spell
 * out the respec clause — "includes points re-gained after a respec, so…" — and the owner ruled
 * that obvious: a reader who has respecced knows why, and a reader who has not is being taught
 * accounting they never asked about. So the caption now claims only the observable fact (the
 * final value can run ahead of the headline) and the WHY lives here, where the next person to
 * wonder whether this curve is a bug will look. `shared/aa.ts` remains the derivation of record.
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
        cumulative gain lines - the final value can run ahead of the{' '}
        {aaEarned.toLocaleString()} earned headline
      </Typography>
      <AreaChart points={drawn} color="#6fb3d2" chrome={chrome} />
    </Paper>
  )
}

/**
 * Level over time, with the caption that says what the curve is made of.
 *
 * The caption names the two things a reader cannot infer from the picture: that the line between
 * dings is the game's OWN stated percentages (not a smoothing of them), and that a shaded span is
 * where it stopped stating them. The class-swap clause is unchanged and still appears only when
 * this character has one.
 */
function LevelOverTimePanel({
  segments,
  curve,
  levelCount,
  swaps,
  aaPoints,
  chrome,
  legend
}: {
  /** the runs inside the chosen timescale (the whole history at `All`). */
  segments: LevelSegment[]
  /** the fractional curve over the same window, already down-sampled per pixel column. */
  curve: LevelCurve
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
        the curve is your last level-up plus every percentage the game has stated since; a{' '}
        <Box component="span" sx={{ color: SWAP_COLOR }}>shaded span</Box> is experience the log did not state
        {swaps > 0 ? ', and a dashed break is a class swap - the level is re-reported for the new loadout, not lost' : ''}
      </Typography>
      <LevelStepChart segments={segments} curve={curve} color="#d9b25f" aaPoints={aaPoints} chrome={chrome} />
      <ZoneLegendStrip legend={legend} fmtDuration={fmtDelta} />
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
  /** The fractional curve over that window — drawn by the chart AND read by its hover layer,
   *  which is what stops the readout naming a bar position the picture refused to draw. */
  curve: LevelCurve | null
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
  // THE CURVE, DERIVED WHERE EVERY OTHER WINDOWED SERIES IS. It is one ascending pass over the
  // CAPPED exp column (~7k rows for a 1.64M-line log — JOS-290 measured the cap, and this memo
  // re-measures the pass in tests/levelCurve.test.mts), then a collapse to at most two vertices
  // per pixel column. It depends on the snapshot and the scale and on NOTHING a pointer does, so
  // a drag still re-renders the two selection bands and nothing else.
  const curve = useMemo(
    () => (scale ? levelCurve({ snap: prog, segments: segVisible, t0: scale.t0, t1: scale.t1 }, scale) : null),
    [prog, segVisible, scale]
  )
  const bands = useMemo(() => (scale ? mergeZoneBands(prog, scale.t0, scale.t1) : []), [prog, scale])
  const legend = useMemo(() => zoneLegend(bands), [bands])
  // `draft` is a STORE, not a value (JOS-290): it rides down into `ChartChrome` untouched and
  // this component is never re-rendered by a pointermove again. `sel` and `dragging` are still
  // ordinary state — they move on pointer-up and once per gesture respectively.
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
            // The TIER half of the same membership (JOS-291) — null unless the reader asked for
            // this tier alone, so the default is the read this tab has always given.
            zoneExactKey: slice.zoneExactKey,
            zoneName: slice.zoneName,
            // The zone half WORDED, membership and all (JOS-454). A drag replaces the slice's
            // caption with its own, and the tier clause used to be lost in that swap — which is
            // how an `exactTier` slice came to answer a 1h51m drag with 15 minutes and name
            // neither the zone nor the tier that decided it.
            zoneCaption: slice.zoneCaption,
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
  const chrome = scale ? { scale, bands, range: sel, draft, suppressed: dragging, pointer } : null
  return { chrome, legend, scope, clear, aaVisible, segVisible, curve }
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
 * THE REFUND-PROOF AA HEADLINE (Task #48), in the shape the four hero cards take.
 *
 * The identity is NOT Σ gains — a respec refunds points with no log line, they re-enter as fresh
 * gain lines, so Σ gains double-counts every refunded point. Instead:
 *   allocated = latest-epoch cost per (ability,rank), cost-0 auto-grants excluded
 *   unspent   = last authoritative "you now have" − spends after it
 *   earned    = allocated + unspent   (the identity the user validated)
 * See src/shared/aa.ts for the full derivation, and `AaOverTimePanel` above for why the cumulative
 * curve is allowed to disagree with `earned`.
 *
 * Its own hook, and its keys are the hero card's prop names on purpose: the view spreads it
 * straight onto `LevelingHeroes`, which is one fewer place for four numbers to be mis-paired.
 * `unspent` is null rather than 0 for a character with no AA line at all — an unknown balance and
 * an empty one are different facts.
 */
// Not `readonly`: `computeAAAccounting` declares mutable arrays, and these come straight off the
// module snapshot that already owns them. Widening here would only move the cast.
function useAaHeadline(
  aas: AAEvent[],
  spends: AASpendEvent[]
): { aaEarned: number; aaSpent: number; aaUnspent: number | null; boughtCount: number } {
  const acct = useMemo(() => computeAAAccounting(aas, spends), [aas, spends])
  return {
    aaEarned: acct.earned,
    aaSpent: acct.allocated,
    aaUnspent: aas.length ? acct.unspent : null,
    boughtCount: acct.boughtCount
  }
}

/**
 * THE CHARTED GATE, resolved ONCE and named — the three values that only exist together, or null.
 *
 * Two separate placements read it now (JOS-300): the left column swaps the charts for the stated
 * empty sentence, and the right column is present or absent wholesale. Re-testing
 * `!chrome || !scope || !curve` at each of them is exactly how one arm ends up drawing while the
 * other does not, so the test is spelled here and both sites read its answer. Returning the three
 * values in an object rather than a boolean is what carries TypeScript's narrowing across the
 * seam, so neither call site needs a non-null assertion to prove what this function already knew.
 */
function chartedOf(
  nothing: boolean,
  charts: LevelingCharts
): { chrome: ChartChrome; scope: ScopedStats; curve: LevelCurve } | null {
  const { chrome, scope, curve } = charts
  return !nothing && chrome && scope && curve ? { chrome, scope, curve } : null
}

/**
 * The charts column: the AA pace tiles, the timescale control, the two plots, and the window's
 * own read under them. Its own component because the column is where the scope becomes visible —
 * every surface in it describes the SAME stretch of time, and keeping them in one place is what
 * makes that reviewable (it also keeps the view inside its measured line budget).
 *
 * IT OWNS NO SCROLL AT ALL SINCE JOS-289. It used to take `overflow: auto` at `lg` on the
 * standing list law's reasoning — the papers are intrinsically tall, so the column absorbed the
 * height rather than growing the app's content area. The owner overturned the premise for this
 * tab: growing the content area is exactly what should happen, and a column-sized porthole in
 * front of two charts and a stats table was the cramping. The column is now a plain natural-height
 * band and `[data-testid="app-content"]` is the one scroller between here and the window.
 *
 * IT OWNS NO WIDTH EITHER SINCE JOS-300. The `flex`/`minWidth` that used to live on this Stack
 * moved UP to the left wrapper in the view, because the wrapper — not this component — is now the
 * left column: `NewAtLevelPanel` is its second child, and it renders in the chart-less state where
 * this component does not exist at all. Sizing has to sit on the box that is always there, or the
 * empty state would lose the two-thirds share and the 320px floor along with the charts.
 */
function ChartsColumn(p: {
  chrome: ChartChrome
  scope: ScopedStats
  curve: LevelCurve
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
  /** The RAW custom pick, so the two datetime fields display what was typed (JOS-436). */
  custom: SliceRange | null
}): JSX.Element {
  const { chrome, scope, charts } = p
  return (
    <Stack spacing={2}>
      {p.pace && <AaPacePanel pace={p.pace} windowLabel={scope.label} />}
      {/* Directly above the plots it governs, and ABOVE BOTH of them: the two charts draw one
          time base, so there is one control for it — and since JOS-75 one scope under it. Since
          JOS-130 it is the APP'S control, not this tab's (features/timeslice). */}
      {/* BOTH halves of one sentence (JOS-288): which stretch, and per hour of what inside it. The
          prefix is unchanged — `ScopeBar` spells the slice half's testids `leveling-slice…`. Since
          JOS-301 it is ONE row of controls with ONE caption line under it, so this is a single band
          of the column rather than the three stacked bars the owner called unbalanced. */}
      <ScopeBar
        available={p.available}
        slice={p.slice}
        onPick={p.onPick}
        onCustom={p.onCustom}
        custom={p.custom}
        testId="leveling"
      />
      <AaOverTimePanel points={p.aaPoints} drawn={charts.aaVisible} aaEarned={p.aaEarned} chrome={chrome} />
      <LevelOverTimePanel
        segments={charts.segVisible}
        curve={p.curve}
        levelCount={p.levelCount}
        swaps={p.swaps}
        aaPoints={charts.aaVisible}
        chrome={chrome}
        legend={charts.legend}
      />
      {/* ALWAYS mounted since JOS-75: it is the window's own read, narrowed by a drag while one
          exists. Below the plots it explains, so the picture stays the first thing on the tab. */}
      <RangeStatsPanel stats={scope.stats} scope={scope.kind} zoneCaption={scope.zoneCaption} onClear={charts.clear} />
    </Stack>
  )
}

/**
 * THE RIGHT COLUMN. It used to BE `LedgerColumn` and to exist only in the charted state, on the
 * argument that all three of that component's panels are reads of a SCOPE and there is no scope
 * without a domain to draw. The argument still governs the ledger; it never governed the COLUMN,
 * and since JOS-445 the column has a second tenant that answers to the LOADOUT rather than to a
 * scope — a fresh character with two dings has no charts and still wants to know which nuke is his
 * best. So either tenant alone is enough for there to be a column, and the wrapper owns the width,
 * because sizing has to sit on the box that decides whether there is a column at all.
 *
 * `present` is asked by the caller rather than derived here: `columnsInfo` in
 * tests/e2e/levelingLayoutSteps.mts counts the bands of `leveling-columns`, and a band drawn around
 * two absent panels would be a column with nothing in it. The charted count is still exactly two.
 */
function RightColumn(p: {
  present: boolean
  /** The tab's ONE viewed-level state, whole — the readout carries its own stepper now. */
  viewed: ViewedLevel
  charted: { scope: ScopedStats } | null
  spends: AASpendEvent[]
  allocated: number
  feed: FeedItem[]
  onOpenLoot?: (item?: string) => void
}): JSX.Element | null {
  if (!p.present) return null
  return (
    <Stack
      spacing={2}
      sx={{ flex: { xs: '0 0 auto', lg: 1 }, minWidth: { lg: 260 } }}
      data-testid="leveling-right-column"
    >
      <BestSpellsPanel viewed={p.viewed} />
      {p.charted && (
        <LedgerColumn
          spends={p.spends}
          allocated={p.allocated}
          scope={p.charted.scope}
          feed={p.feed}
          onOpenItem={p.onOpenLoot}
        />
      )}
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
  // The THIRD module, through its own hook: `character`, for the stated level fact (JOS-192). It
  // is the only one carrying your own `/who` row's number, which is what corrects the level after
  // a loadout swap the log never announced.
  const stated = useStatedLevel(prog)

  const sortedLevels = useMemo(() => sortLevels(levels), [levels])
  const sortedAAs = useMemo(() => [...aas].sort((a, b) => a.ts - b.ts), [aas])

  // CURRENT level is the level the log last STATED — the later of your last ding and your own
  // `/who` row (JOS-192). Never max(): you level three classes at once and a loadout swap
  // re-reports the level of the new (lowest) class, so the peak belongs to a class that may no
  // longer be in the loadout. It's surfaced separately as "peak", off the ding series, which is
  // exactly the question that series answers.
  const levelSegments = useMemo(() => buildLevelSegments(sortedLevels), [sortedLevels])
  const currentLevel = stated.level
  const peak = peakLevel(sortedLevels)
  const swaps = swapCount(levelSegments)

  // The refund-proof AA identity, in hero-card shape — derivation and reasoning in `useAaHeadline`.
  const aa = useAaHeadline(aas, spends)

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

  // THE SLICE — app-wide and session-lifetime (features/timeslice/useTimeslice). THIS TAB OPENS ON
  // `Zone + Session` (owner ruling, JOS-288): the exp surfaces are about the camp you are in right
  // now, and a session that spans a loadout swap sums `levelEquiv` straight across the boundary. The
  // Loot ledger's own opening (`All`, hiding nothing) is untouched — useTimeslice's header states
  // why those two coexist under one shared pick.
  const { bounds, available, slice, setId, setCustom, custom } = useTimeslice(useExtraTs(sortedLevels, aaCumulative), 'zoneSession')
  const charts = useLevelingCharts({ prog, aas: aaCumulative, segments: levelSegments, slice, bounds })
  // The SCOPE on its own — the only one of the three the reads below need before the charted gate
  // has been asked. `chrome` and `curve` are null on exactly the same condition it is, and all
  // three are tested together, once, by `chartedOf`.
  const { scope } = charts
  // The feed and the AA pace both follow that scope (JOS-75): the pace was its own hour-wide
  // window until the timescale existed, and now the tab has ONE answer to "which stretch".
  const { feed: scopedFeed, pace } = useScopedReads({ scope, feed, state, prog })

  const nothing = sortedLevels.length === 0 && sortedAAs.length === 0
  // ONE GATE, TWO PLACEMENTS — see `chartedOf` for why the test is not spelled inline any more.
  const charted = chartedOf(nothing, charts)
  // THE VIEWED LEVEL IS THE TAB'S SINCE JOS-445. It used to be private to `NewAtLevelPanel`; the
  // best-spells readout in the RIGHT column ranks against the same number, and the owner's ask is
  // that stepping the level re-ranks it. One state, one stepper, two columns.
  const viewed = useViewedLevel(currentLevel)
  // THE SECOND REASON THE RIGHT COLUMN EXISTS (JOS-445) — one gate, two placements, the `chartedOf`
  // arrangement: the panel decides whether it can say anything and the column asks the same
  // question before drawing a band around it.
  const bestSpells = useBestSpellsVisible()
  // One props object, two placements (see both call sites): the panel is the same surface in the
  // charted and the chart-less state, and spelling its props twice is how they drift.
  const unlockPanel = {
    currentLevel,
    viewed,
    focusLevel,
    focusNonce,
    onFocusConsumed: onFocusConsumed ?? ((): void => undefined)
  }

  return (
    // NO HEIGHT, NO SCROLLER — THE PAGE IS THE SCROLLER (JOS-289, owner directive 2026-08-13:
    // *the entire pane should scroll*). `height: '100%'` used to pin this stack to the viewport,
    // which is what forced every panel below to fight for a share of one screen and produced the
    // portholes the ticket removes (the per-level spell readout at 120px was the named one). The
    // view now takes its honest height and `[data-testid="app-content"]` — the app shell's
    // `overflow: auto` box — scrolls it, which is the SAME rule as before read the other way
    // round: there is exactly one scroller between a panel and the window, and it is not here.
    <Stack spacing={2} data-testid="leveling-view">
      {/* THE FOUR HEROES DO NOT FOLLOW THE SCOPE, and that is a decision rather than an
          omission (JOS-75). Character level is your level RIGHT NOW — a level "as of an hour
          ago" is a different fact wearing this one's label. The three AA figures are the
          refund-proof identity (earned == allocated + unspent, shared/aa.ts): allocation is a
          balance, not a flow, and a windowed "earned" could only be Σ of the gain lines in
          range, which is precisely the double-counting world-model law 5 forbids. The windowed
          AA reads live one panel down, where they are labelled as rates. */}
      <LevelingHeroes
        currentLevel={currentLevel}
        levelCue={stated.cue}
        levelTitle={stated.title}
        levelCount={sortedLevels.length}
        peak={peak}
        swaps={swaps}
        {...aa}
      />

      {/* THE COLUMNS NEVER SHARE A HEIGHT ANY MORE (JOS-289). JOS-151 fixed the reporter's
          1073x937 collision by taking the scroll into this stack below `lg` — the two bands were
          splitting one FIXED height 2:1 and the second one's papers spilled out of it and drew
          over "New at this level" (89px ledger, 34px feed, measured). The collision is gone at
          the root now: there is no fixed height to split. `flex-start` at `lg` is what says so —
          each column is as tall as its own panels, neither is stretched to the other's height,
          and no panel inside either one is asked to grow into space it did not earn.

          THE ROW IS UNCONDITIONAL SINCE JOS-300, and the empty state lives INSIDE it. Two bands
          when there are charts, one when there are not — `columnsInfo` in
          tests/e2e/levelingLayoutSteps.mts counts these children and the charted count is still
          exactly two. */}
      <Stack
        direction={{ xs: 'column', lg: 'row' }}
        spacing={2}
        data-testid="leveling-columns"
        sx={{ alignItems: { xs: 'stretch', lg: 'flex-start' } }}
      >
        {/* THE LEFT COLUMN, AND IT IS THIS WRAPPER RATHER THAN `ChartsColumn` (JOS-300). It owns
            the width — two thirds of it while there are two columns to share it; below `lg` it is
            simply the first band of a single column, and it drops the 320px floor that would
            otherwise push the page sideways. Height is whatever its panels need, at every width.
            The sizing had to move up here because this box, unlike the charts, is ALWAYS drawn. */}
        <Stack spacing={2} sx={{ flex: { xs: '0 0 auto', lg: 2 }, minWidth: { lg: 320 } }}>
          {charted ? (
            <ChartsColumn
              chrome={charted.chrome}
              scope={charted.scope}
              curve={charted.curve}
              charts={charts}
              pace={pace}
              aaPoints={aaCumulative}
              aaEarned={aa.aaEarned}
              levelCount={sortedLevels.length}
              swaps={swaps}
              slice={slice}
              available={available}
              onPick={setId}
              onCustom={setCustom}
              custom={custom}
            />
          ) : (
            <Typography color="text.secondary" sx={{ p: 2 }} data-testid="leveling-empty">
              No level-ups or AA gains found in this character&apos;s log yet. They&apos;ll appear here live as you play.
            </Typography>
          )}

          {/* ONE MOUNT SITE, AND IT IS THE BOTTOM OF THE LEFT COLUMN (JOS-300, owner directive
              2026-08-13). Two laws meet here and both are load-bearing:

              STILL ONE POSITION IN THE TREE, whatever the charts do. This is the one surface on
              the tab that needs no log at all — "what do I get at 30" is answered by the committed
              DBs — so it renders in the chart-less state too, and it is the wrapper above, not the
              conditional, that guarantees it. Writing it into both arms of that conditional would
              remount it every time the charts appeared and drop a level-up toast's deep link
              (focusLevel/focusNonce) on the way. It is the second child of a box that is always
              there, so React reconciles it in place across the flip.

              NO LONGER LAST ON THE PAGE. It used to sit outside the row entirely, full width, on
              the argument that the two plots deserve the top of the tab and a browsable reference
              panel should not push them down a screen. That argument still holds — this is below
              the charts, not above them — but the owner ruled its cost worse than its benefit: the
              charts column ends well short of the ledger/drops/feed column, and a full-width panel
              underneath left an enormous hole at the bottom left of the tab. Filling that hole is
              what this placement is for. The consequence, stated so the specs can measure it: the
              tab's deepest pixel is now usually the RIGHT column's, so scrolling the page to the
              very bottom no longer guarantees this panel is in frame. */}
          <NewAtLevelPanel {...unlockPanel} />
        </Stack>

        <RightColumn
          present={bestSpells || charted !== null}
          viewed={viewed}
          charted={charted}
          spends={spends}
          allocated={aa.aaSpent}
          feed={scopedFeed}
          onOpenLoot={onOpenLoot}
        />
      </Stack>
    </Stack>
  )
}
