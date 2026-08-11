// LevelingCard — "how fast am I actually progressing, right now", and the way down to the
// Leveling tab.
//
// It shows DELIBERATELY LESS than that tab: no charts, no drag-selected range, no AA ledger, no
// per-zone table. A ROW OF TILES (level, the last hour's pace, AA, next level), one sparkline of
// that hour, and the lines that qualify them. If you want any of the rest, that is what the link
// is for.
//
// THE AA LINE IS THE ONE THING THAT KEEPS WORKING AT THE CAP. Every other number here is built
// on stated level-bar percentages, and the game stops stating them at max level — the headline
// becomes an em-dash and the card goes quiet exactly when AA becomes the whole game. So the same
// window carries an AA read (completions/hr · points/hr · the inferred wait for the next one),
// shaped by the Leveling tab's own `aaPaceLine` so the two surfaces cannot word one hour two
// ways. It is a LINE and not a tile because the wait is a model and a tile row is where this
// card puts facts. The wait says so in ONE WORD ('est.'): the tab's tile carries the chip and
// the full account of what the log did and did not state, and repeating that here would be a
// footnote where a caption belongs. No AA in the hour ⇒ no line at all, never em-dashes.
//
// WHY TILES AND NOT A SENTENCE (owner request, 2026-08-04). The card used to be four stacked
// lines of prose with one big number in the middle, and the reader had to parse a sentence to
// find each fact. A tile is the same fact with the number given the whole of the reader's
// attention and the words demoted to a caption — and, load-bearing here, a MISSING fact is
// visibly missing rather than an em-dash mid-sentence. The tiles come from
// `overviewLevelingTiles.ts` already built and already filtered: this component chooses no
// content at all, which is what keeps every one of those rules under a node test.
//
// THE SPARKLINE IS THE LEVELING CHART'S OWN LANGUAGE. Twelve five-minute columns of stated
// progress, each tinted with `zoneBands.zoneColor` — so the camp you spent forty minutes in is
// the same hue here, on the Leveling tab's band strip, and in that tab's per-zone table. It is a
// tiny inline SVG for the same reason the perf popover's is (PerfChip.tsx): twelve numbers do
// not need a chart library, and the shape is the whole message — "was this hour steady, or one
// good pull and then nothing".
//
// THE HEADLINE IS THE LAST HOUR **OF THE LOG**, not of the wall clock (`overviewLevelingData`
// anchors on `snap.lastTs`). Someone reading this card has usually alt-tabbed out of the game;
// a wall-clock hour would empty itself the moment they stopped playing and report the result as
// a rate. The zone line's "since <time>" is the one clock-shaped thing here, and it states an
// instant the log actually recorded.
//
// AN EM-DASH IS A REAL ANSWER. A null rate renders as '—' and never as '0.00': at the level cap
// the game prints experience lines with no percentage at all, so the window's progress is
// genuinely unknown rather than zero, and the `at cap` chip says which unknown it is. The
// sparkline obeys the same rule from the other side — an hour whose every experience line stated
// no percentage draws NO bars and says so, because twelve zero-height columns would claim a
// measured-quiet hour that was never measured.
//
// The words are the feature's words: "levels of progress", never xp; "idle", never AFK. And
// "offline" ONLY when the log said so: the hour can contain a logout (the card's window is an
// hour of LOG time, so coming back at 13:00 after camping at 02:52 puts most of an empty chair
// inside it), and when a login line closes one, a chip states it and every rate on the card
// divides by the ONLINE part of the hour. A logout still in progress has no login line yet, so
// it cannot be seen at all and its silence stays idle — the chip's tooltip says that too.
//
// THE PROJECTION IS A TILE WHEN IT EXISTS AND A LINE WHEN IT DOES NOT. "~2h 10m / to level 44"
// is the answer this card was asked for, so it gets a tile; a REFUSAL is a sentence, because the
// reason is the answer and a tile cannot carry one. Either way the same tooltip slot says why:
// the game states a percentage per experience gain and never your position in the bar, so
// without an observed level-up — or with an at-cap line anywhere since one — how far into the
// bar you are is genuinely unknown.
//
// The `~` is not decoration. This projects ONE hour of your play forward and assumes it repeats:
// same mobs, same camp, same share of medding. It is not a countdown to a known instant, and
// past a day it stops pretending to minutes and says '>1 day'.

import type { JSX } from 'react'
import { Box, Button, Chip, Paper, Stack, Typography } from '@mui/material'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import { DashCard, QuietNote } from '../combat/combatShared'
import { OFFLINE_TITLE } from '../leveling/rangeStatsRows'
import { formatTime } from '../../lib/formatDate'
import type { OverviewLevelingState } from './overviewLevelingData'
import { SPARK_BUCKETS, sparkColor, type LevelingSpark, type LevelingTile } from './overviewLevelingTiles'
import { Tooltip } from '../../lib/Tooltip'

export interface LevelingCardProps {
  state: OverviewLevelingState
  onOpenLeveling: () => void
}

/** The chip's tooltip: WHY the rate is an em-dash. */
const AT_CAP_TITLE = 'At cap: the game prints no level-bar percentage.'

/** `clipped`: the window reaches past the oldest instant the series still holds in full. */
const CLIPPED_TITLE = 'This hour reaches past the oldest samples still held.'

function OpenLeveling({ onOpenLeveling }: { onOpenLeveling: () => void }): JSX.Element {
  return (
    <Button
      size="small"
      data-testid="overview-open-leveling"
      endIcon={<OpenInNewIcon sx={{ fontSize: 14 }} />}
      onClick={onOpenLeveling}
      // Same line box as the DPS card's button, and for the same reason: a small Button's default
      // 1.75 line-height makes a card WITH an action 3px taller in the header than one without,
      // which would start the NOW rank's four bodies on different baselines.
      sx={{ minWidth: 0, py: 0, px: 0.75, lineHeight: 1.4 }}
    >
      Open Leveling
    </Button>
  )
}

/** The label row: which window this is, plus the chips that qualify it. */
function LevelingChips({ state }: { state: OverviewLevelingState }): JSX.Element {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" data-testid="overview-leveling-window" noWrap>
        Last hour
      </Typography>
      {state.atCap && (
        <Tooltip title={AT_CAP_TITLE}>
          <Chip size="small" color="warning" variant="outlined" label="at cap" sx={{ height: 20 }} />
        </Tooltip>
      )}
      {state.clipped && (
        <Tooltip title={CLIPPED_TITLE}>
          <Chip size="small" variant="outlined" label="partial record" sx={{ height: 20 }} />
        </Tooltip>
      )}
      {/* Only ever present when a login line CLOSED a logout inside the hour. Silence the log
          has not explained is idle, not offline, and carries no chip at all. */}
      {state.offline && (
        <Tooltip title={OFFLINE_TITLE}>
          <Chip size="small" variant="outlined" label={state.offline} sx={{ height: 20 }} />
        </Tooltip>
      )}
    </Stack>
  )
}

/**
 * ONE tile. The number owns the tile — `h5`, primary, tabular-nums so a re-rendering rate never
 * makes the row twitch — and the unit rides its baseline at caption size so '1.42 lvl/hr' reads
 * as one quantity rather than two.
 */
function StatTile({ tile }: { tile: LevelingTile }): JSX.Element {
  return (
    <Tooltip title={tile.title}>
      <Paper
        variant="outlined"
        data-testid={`overview-leveling-tile-${tile.id}`}
        sx={{ px: 1, py: 0.5, minWidth: 0, flex: '1 1 0', bgcolor: 'action.hover' }}
      >
        <Stack direction="row" spacing={0.5} alignItems="baseline" sx={{ minWidth: 0 }}>
          <Typography
            variant="h5"
            noWrap
            sx={{ color: 'primary.main', lineHeight: 1.15, fontVariantNumeric: 'tabular-nums', minWidth: 0 }}
          >
            {tile.value}
          </Typography>
          {tile.unit && (
            <Typography variant="caption" color="text.secondary" noWrap sx={{ flexShrink: 0 }}>
              {tile.unit}
            </Typography>
          )}
        </Stack>
        <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', minWidth: 0 }}>
          {tile.label}
        </Typography>
      </Paper>
    </Tooltip>
  )
}

/** The tile row. Wraps rather than shrinks: the card lives in a grid cell that can be as narrow
 *  as one column, and four squeezed tiles read worse than two rows of two. */
function StatTiles({ tiles }: { tiles: LevelingTile[] }): JSX.Element {
  return (
    <Stack
      direction="row"
      spacing={0.75}
      flexWrap="wrap"
      useFlexGap
      data-testid="overview-leveling-tiles"
      sx={{ mt: 0.75, minWidth: 0 }}
    >
      {tiles.map((t) => (
        <StatTile key={t.id} tile={t} />
      ))}
    </Stack>
  )
}

const SPARK_H = 30
/** viewBox units per column — the SVG stretches to the card, so these are ratios, not pixels. */
const SPARK_COL = 10
const SPARK_W = SPARK_BUCKETS * SPARK_COL
/** A bucket with progress never draws thinner than this, so a real-but-tiny gain stays visible. */
const SPARK_MIN_H = 2

/**
 * The hour, in twelve columns. Bars rather than a polyline because the QUANTITY here is per
 * bucket (progress earned in five minutes), not a level being sampled — and because a bar can
 * carry the zone's colour, which a single-stroke line cannot.
 *
 * An hour whose every experience line stated no percentage draws NOTHING and says so: twelve
 * zero-height columns would be a measured-quiet hour, which is the opposite of at-cap's unknown.
 */
function Spark({ spark }: { spark: LevelingSpark }): JSX.Element {
  if (spark.stated === 0 && spark.unstated > 0) {
    return (
      <Typography variant="caption" color="text.disabled" data-testid="overview-leveling-spark-none" sx={{ mt: 0.5 }}>
        No level-bar percentage stated this hour - progress unknown, not zero.
      </Typography>
    )
  }
  const peak = Math.max(spark.peak, 1e-9)
  return (
    <Box
      component="svg"
      data-testid="overview-leveling-spark"
      viewBox={`0 0 ${String(SPARK_W)} ${String(SPARK_H)}`}
      preserveAspectRatio="none"
      sx={{ width: '100%', height: SPARK_H, display: 'block', mt: 0.75, minWidth: 0 }}
    >
      {spark.buckets.map((b, i) => {
        const h = b.value > 0 ? Math.max(SPARK_MIN_H, (b.value / peak) * SPARK_H) : 0
        return (
          <rect
            key={b.t0}
            x={i * SPARK_COL + 0.6}
            y={SPARK_H - h}
            width={SPARK_COL - 1.2}
            height={h}
            fill={sparkColor(b.zone)}
            opacity={0.85}
          >
            <title>
              {`${formatTime(b.t0, { hour: '2-digit', minute: '2-digit' })} · ${b.value.toFixed(2)} levels of progress${b.zone ? ` · ${b.zone}` : ''}`}
            </title>
          </rect>
        )
      })}
      {/* The baseline: without it an empty hour is a blank box rather than a flat reading. */}
      <rect x={0} y={SPARK_H - 0.75} width={SPARK_W} height={0.75} fill="currentColor" opacity={0.25} />
    </Box>
  )
}

/**
 * The qualifying lines under the sparkline: the AA pace, the camp you are in now and — only when
 * the hour spans two rated zones — which of them paid better. The next-level REFUSAL rides here
 * too, because a reason is a sentence and the tile row holds only answers.
 */
function LevelingLines({ state }: { state: OverviewLevelingState }): JSX.Element {
  return (
    <>
      {/* No tooltip, by convention: the estimate's one-word 'est.' is the whole caveat this
          line is allowed, and the tile that owns the number explains itself on the Leveling
          tab. Absent entirely when the hour holds no completion. */}
      {state.aa && (
        <Typography
          variant="caption"
          color="text.secondary"
          data-testid="overview-leveling-aa"
          title={state.aa}
          noWrap
          sx={{ mt: 0.5, minWidth: 0 }}
        >
          {state.aa}
        </Typography>
      )}
      {!state.eta && (
        <Tooltip title={state.etaTitle}>
          <Typography
            variant="caption"
            color="text.secondary"
            data-testid="overview-leveling-eta"
            sx={{ mt: 0.5, minWidth: 0 }}
          >
            - no next-level estimate
          </Typography>
        </Tooltip>
      )}
      {state.zoneLine && (
        <Typography
          variant="caption"
          color="text.secondary"
          data-testid="overview-leveling-zone"
          title={state.zoneLine}
          noWrap
          sx={{ mt: 0.5, minWidth: 0 }}
        >
          {state.zoneLine}
        </Typography>
      )}
      {state.zoneCompare && (
        <Typography
          variant="caption"
          color="text.secondary"
          data-testid="overview-leveling-zone-compare"
          title={state.zoneCompare}
          noWrap
          sx={{ minWidth: 0 }}
        >
          {state.zoneCompare}
        </Typography>
      )}
      {state.history && (
        <Tooltip title={state.historyTitle}>
          <Typography
            variant="caption"
            color="text.secondary"
            data-testid="overview-leveling-history"
            noWrap
            sx={{ minWidth: 0 }}
          >
            {state.verdict ? `${state.history} · ${state.verdict}` : state.history}
          </Typography>
        </Tooltip>
      )}
    </>
  )
}

export function LevelingCard({ state, onOpenLeveling }: LevelingCardProps): JSX.Element {
  // The link down is offered even with nothing to show, for the same reason the DPS card offers
  // it: the one affordance this card exists for must not be the least reliable thing on it.
  return (
    <DashCard title="Leveling" testId="overview-leveling" right={<OpenLeveling onOpenLeveling={onOpenLeveling} />}>
      {state.empty ? (
        <QuietNote>
          No progress recorded yet - levels of progress and credited kills appear here as you play.
        </QuietNote>
      ) : (
        <>
          <LevelingChips state={state} />
          <StatTiles tiles={state.tiles} />
          <Spark spark={state.spark} />
          <Tooltip title={`${String(state.kills)} credited kills · ${state.idleCaption}`}>
            <Typography variant="caption" color="text.secondary" data-testid="overview-leveling-sub" noWrap>
              {state.killRate} · {state.activity}
            </Typography>
          </Tooltip>
          <LevelingLines state={state} />
        </>
      )}
    </DashCard>
  )
}
