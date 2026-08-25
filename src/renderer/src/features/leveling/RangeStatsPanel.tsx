// RangeStatsPanel — what the time range in force says about progression.
//
// SINCE JOS-75 IT IS ALWAYS MOUNTED. It used to appear only on a drag; now it is the tab's
// answer for whatever scope is in force — the TIMESCALE's window by default, narrowed to a
// committed drag while one exists (`windowScope.ts` decides which, and this panel is told only
// which kind it got). Every string below is unchanged: a window and a selection are the same
// question over different instants, so they get the same panel, and the header states the two
// instants outright rather than making the reader infer them. The ONE difference the `scope`
// prop makes is the dismissal — you cannot clear a window, so the clear button and the
// `selection` chip exist together or not at all.
//
// Presentation ONLY. Every number arrives already computed by the pure
// `shared/progressionStats.rangeStats`, and every string it prints is shaped by the pure
// `rangeStatsRows.ts` beside this file. Nothing is derived here, which is what keeps the
// feature's honesty rules testable instead of buried in JSX:
//
//   • a null rate is an em-dash, NEVER '0.0' (the log declining to report progress is not
//     the same fact as no progress);
//   • `levelEquiv` is "levels of progress", never "xp" — the log states a percentage of the
//     CURRENT level's bar and nothing else;
//   • a range whose experience lines stated no percentage SAYS SO, in a caption on the
//     number it explains;
//   • idle is labeled with the literal rule that produced it, and is called "idle" — never
//     "AFK", never "offline" (the log records events, not presence);
//   • "offline" appears ONLY when a camp/login line actually derived a logout. No offline
//     interval in the range ⇒ no offline chip, no offline column, and every other string on
//     this panel byte-identical to what it printed before offline existed. A logout still in
//     progress is invisible (the evidence is the login line that has not happened yet), so it
//     stays inside idle and the offline chip's tooltip says so.
//
// Zone swatches come from `zoneBands.zoneColor`, the same function the chart strip uses, so a
// row and its band are always the same hue.

import { type JSX, useState } from 'react'
import {
  Box,
  Chip,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TableSortLabel,
  Typography
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import SpeedIcon from '@mui/icons-material/Speed'
import WhatshotIcon from '@mui/icons-material/Whatshot'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import MilitaryTechIcon from '@mui/icons-material/MilitaryTech'
import type { RangeStats } from '@shared/progressionStats'
import type { ScopeKind } from './windowScope'
import { formatDateTime } from '../../lib/formatDate'
import type { RateBasis } from '@shared/rateBasis'
// WHICH HOUR the rates below are per (JOS-288) — read where it is used, exactly as the slice's own
// consumers read `useTimeslice`: the store is app-wide and every consumer of it is a leaf.
import { useRateBasis } from '../timeslice/useRateBasis'
import { fmtDuration } from './levelChartGeometry'
import {
  aaRateTitle,
  AA_RESPEC_CAPTION,
  ACTIVE_TIME_TITLE,
  OFFLINE_CAPTION,
  OFFLINE_TITLE,
  aaRateText,
  aaText,
  activeIdleText,
  comboInferred,
  comboText,
  idleGapsText,
  idleRuleCaption,
  membershipText,
  MEMBERSHIP_TITLE,
  offlineGapsText,
  offlineText,
  rangeHeroes,
  unstatedCaption,
  witnessedText,
  zoneStatRows,
  type HeroStat,
  type ZoneSort,
  type ZoneStatRow
} from './rangeStatsRows'
import { Tooltip } from '../../lib/Tooltip'

export interface RangeStatsPanelProps {
  stats: RangeStats
  /** Which scope produced `stats` — the timescale's window, or a drag that narrowed it. */
  scope: ScopeKind
  /**
   * THE ZONE HALF OF THE SCOPE, WORDED, MEMBERSHIP AND ALL (`windowScope.ScopedStats.zoneCaption`
   * — `The Plane of Hate, this tier only`). Null/absent when the scope is not restricted to a
   * zone, which is when this panel prints exactly what it always printed.
   *
   * It is here because the header's elapsed number is Σ of the ADMITTED visits and the panel used
   * to name neither the zone nor the tier that admitted them — JOS-454, where a 1h51m drag read
   * `15m` and nothing on screen said why.
   */
  zoneCaption?: string | null
  onClear: () => void
}

/** The leveling view's existing hero hues, reused rather than re-invented. */
const ACCENT: Record<HeroStat['id'], string> = {
  rate: '#5fbf72',
  kills: '#b07fd0',
  levels: '#d9b25f',
  range: '#6fb3d2'
}

const ICON: Record<HeroStat['id'], JSX.Element> = {
  rate: <SpeedIcon />,
  kills: <WhatshotIcon />,
  levels: <TrendingUpIcon />,
  range: <MilitaryTechIcon />
}

/**
 * The `HeroCard` idiom from LevelingView, at panel density (h5 rather than h4, tighter
 * padding): a colored left rule, the icon in the same hue, value / label / caption. It is a
 * local copy because `HeroCard` is private to LevelingView.tsx — see the report note; the
 * right fix is to lift that component into its own file and have both views import it.
 */
function StatCard({ stat }: { stat: HeroStat }): JSX.Element {
  const accent = ACCENT[stat.id]
  return (
    <Paper
      variant="outlined"
      sx={{ p: 1.25, flex: 1, minWidth: 150, borderLeft: `3px solid ${accent}`, display: 'flex', gap: 1 }}
      data-testid="leveling-range-hero"
      // A NATIVE title, never a popper (JOS-143), and only on the card that has one: the rate
      // card's denominator is active time and JOS-249 says so on hover.
      title={stat.title}
    >
      <Box sx={{ color: accent, display: 'flex', alignItems: 'center' }}>{ICON[stat.id]}</Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="h5" sx={{ lineHeight: 1.1, color: accent }} noWrap>
          {stat.value}
        </Typography>
        <Typography variant="body2">{stat.label}</Typography>
        <Typography variant="caption" color="text.secondary" display="block">
          {stat.sub}
        </Typography>
      </Box>
    </Paper>
  )
}

const CHIP_SX = { height: 20 } as const

/**
 * The chip row: active/idle with the idle rule as its caption, the class combo, the witnessed
 * kills (dimmed — they are context, and they enter no rate), and the AA gained with the same
 * respec reservation the "AA gained over time" panel carries.
 */
function ChipRow({ stats, basis }: { stats: RangeStats; basis: RateBasis }): JSX.Element {
  const gaps = idleGapsText(stats)
  const witnessed = witnessedText(stats)
  const aa = aaText(stats)
  // The AA pace, beside the AA total it explains. Null together with `aa` — both are gated on
  // the range holding at least one gain line.
  const aaRate = aaRateText(stats, basis)
  // Null unless a login line actually closed a logout inside the range — the offline chip and
  // its caption exist only when the log said so.
  const offline = offlineText(stats)
  const logouts = offlineGapsText(stats)
  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        {/* The chip PRINTS active time, so it carries the definition (JOS-249) — with the gap
            count still leading when there is one, because that is this chip's own detail. */}
        <Tooltip title={gaps ? `${gaps} · ${ACTIVE_TIME_TITLE}` : ACTIVE_TIME_TITLE}>
          <Chip size="small" variant="outlined" label={activeIdleText(stats)} sx={CHIP_SX} />
        </Tooltip>
        {offline && (
          <Tooltip title={logouts ? `${logouts} · ${OFFLINE_TITLE}` : OFFLINE_TITLE}>
            <Chip size="small" variant="outlined" label={offline} sx={CHIP_SX} />
          </Tooltip>
        )}
        <Chip size="small" variant="outlined" label={comboText(stats.combos)} sx={CHIP_SX} />
        {comboInferred(stats.combos) && <Chip size="small" variant="outlined" label="inferred" sx={CHIP_SX} />}
        {witnessed && (
          <Chip size="small" variant="outlined" label={witnessed} sx={{ ...CHIP_SX, opacity: 0.55 }} />
        )}
        {aa && (
          <Tooltip title={AA_RESPEC_CAPTION}>
            <Chip size="small" variant="outlined" label={aa} sx={CHIP_SX} />
          </Tooltip>
        )}
        {aaRate && (
          <Tooltip title={aaRateTitle(stats, basis)}>
            <Chip size="small" variant="outlined" label={aaRate} sx={CHIP_SX} />
          </Tooltip>
        )}
      </Stack>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
        {idleRuleCaption(stats.idleThresholdMs)}
        {offline && ` · offline: ${OFFLINE_CAPTION}`}
        {aa && ` · AA: ${AA_RESPEC_CAPTION}`}
      </Typography>
    </Box>
  )
}

const CELL_SX = { py: 0.35, fontSize: 12 } as const

function ZoneRow({ row }: { row: ZoneStatRow }): JSX.Element {
  return (
    <TableRow hover data-testid="leveling-range-zone-row">
      <TableCell sx={{ ...CELL_SX, width: 18, pr: 0 }}>
        <Box sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: row.color }} />
      </TableCell>
      <TableCell sx={CELL_SX}>
        <Typography variant="caption" noWrap title={row.zone}>
          {row.zone}
        </Typography>
      </TableCell>
      <TableCell align="right" sx={CELL_SX}>
        {row.time}
        {/* '(2h 03m active)', or '(2h 03m active · 8h 12m offline)' for the camp you logged
            out of. Null — and so nothing at all — when the zone was pure activity. */}
        <Box
          component="span"
          sx={{ opacity: 0.55 }}
          // The parenthetical prints this camp's active ms, so it hovers the definition (JOS-249)
          // — and nothing at all when there is no parenthetical to hover.
          title={row.detail ? (row.offline ? `${OFFLINE_CAPTION} · ${ACTIVE_TIME_TITLE}` : ACTIVE_TIME_TITLE) : undefined}
        >
          {row.detail ? ` (${row.detail})` : ''}
        </Box>
      </TableCell>
      <TableCell align="right" sx={CELL_SX}>
        {row.kills}
      </TableCell>
      <TableCell align="right" sx={CELL_SX}>
        {row.levels}
        {row.unstated > 0 && (
          <Box component="span" sx={{ opacity: 0.55 }} title="some experience lines here stated no percentage">
            {' *'}
          </Box>
        )}
      </TableCell>
      <TableCell align="right" sx={CELL_SX}>
        {row.levelsPerHour}
      </TableCell>
      <TableCell align="right" sx={CELL_SX}>
        {row.killsPerHour}
      </TableCell>
    </TableRow>
  )
}

const HEAD_SX = { ...CELL_SX, fontWeight: 700, whiteSpace: 'nowrap' } as const

/**
 * Per-zone rows, sorted by levels/hr (the farming-efficiency question) with a secondary
 * toggle onto time.
 *
 * VERTICALLY IT IS AS TALL AS THE ZONES (JOS-289). It used to live in a `maxHeight: 240` box with
 * `overflow: auto` so it could not squeeze the charts above it; with the page scrolling there is
 * nothing to squeeze, and a range that visited nine camps was reading them six at a time through
 * a sticky-header slot. HORIZONTALLY IT STILL OWNS A SCROLLER, and that is the other half of the
 * same law: seven columns of numbers is genuinely wide content, and wide content scrolls in its
 * OWN container — never by pushing the page sideways. Hence `overflowX` alone, never `overflow`.
 */
function ZoneTable({ zones, basis }: { zones: RangeStats['zones']; basis: RateBasis }): JSX.Element | null {
  const [sort, setSort] = useState<ZoneSort>('levels')
  const rows = zoneStatRows(zones, sort, basis)
  if (rows.length === 0) return null
  const head = (key: ZoneSort, label: string): JSX.Element => (
    <TableSortLabel active={sort === key} direction="desc" onClick={() => { setSort(key) }}>
      {label}
    </TableSortLabel>
  )
  return (
    // `overflowY: hidden` is stated rather than left alone ON PURPOSE: CSS computes a `visible`
    // axis to `auto` the moment its partner is not visible, so `overflowX: 'auto'` alone would
    // leave this box reading as a vertical scroller to anything inspecting it (the e2e layout
    // contract does exactly that). There is no height here to clip, so it clips nothing.
    <Box sx={{ overflowX: 'auto', overflowY: 'hidden' }} data-testid="leveling-range-zones">
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell sx={{ ...HEAD_SX, width: 18, pr: 0 }} />
            <TableCell sx={HEAD_SX}>Zone</TableCell>
            <TableCell align="right" sx={HEAD_SX}>
              {head('time', 'Time')}
            </TableCell>
            <TableCell align="right" sx={HEAD_SX}>
              Kills
            </TableCell>
            <TableCell align="right" sx={HEAD_SX}>
              Levels
            </TableCell>
            {/* Both rates divide by the ROW's own active time, so both headers say what that is
                (JOS-249) — a native title on the label, no popper. */}
            <TableCell align="right" sx={HEAD_SX} title={ACTIVE_TIME_TITLE}>
              {head('levels', 'Levels/hr')}
            </TableCell>
            <TableCell align="right" sx={HEAD_SX} title={ACTIVE_TIME_TITLE}>
              Kills/hr
            </TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r) => (
            <ZoneRow key={r.key} row={r} />
          ))}
        </TableBody>
      </Table>
    </Box>
  )
}

function HeaderRow({ stats, scope, zoneCaption, onClear }: RangeStatsPanelProps): JSX.Element {
  // Null unless a zone membership actually left part of the range out — see `membershipText`.
  const membership = membershipText(stats, zoneCaption)
  return (
    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
      <Typography variant="subtitle2" sx={{ fontWeight: 700 }} data-testid="leveling-range-window">
        {formatDateTime(stats.t0)} → {formatDateTime(stats.t1)}
      </Typography>
      {/* THE ELAPSED SPAN THE NUMBERS COVER — `durationMs`, which under a zone slice is Σ of the
          ADMITTED VISITS and therefore narrows with the tier membership (JOS-332). It carries a
          testid because it is the number the owner's bug report was about: `elapsed 27m` over a
          camp when only one of its tiers was selected. tests/e2e/sliceSteps.mts reads it on both
          sides of the toggle. */}
      <Typography variant="caption" color="text.secondary" data-testid="leveling-range-duration">
        {fmtDuration(stats.durationMs)}
      </Typography>
      {/* …AND WHAT THAT NUMBER LEFT OUT (JOS-454). The elapsed span above is Σ of the visits the
          slice's zone membership ADMITTED; when that is less than the range the header states,
          this says how much less and which membership did it. Absent — and byte-identical to
          every read before this ticket — whenever there is no zone in force or nothing was left
          out. A native title, never a popper (JOS-143). */}
      {membership && (
        <Typography
          variant="caption"
          color="text.secondary"
          data-testid="leveling-range-membership"
          title={MEMBERSHIP_TITLE}
        >
          {membership}
        </Typography>
      )}
      {/* STATE, NOT PROCESS: one word saying these numbers are narrower than the timescale
          above them. Absent for the window, which the timescale bar already names. */}
      {scope === 'selection' && <Chip size="small" variant="outlined" label="selection" sx={CHIP_SX} />}
      {stats.clipped && (
        // State, not process (UI conventions): the analytics store is capped drop-oldest,
        // so a range reaching below `windowStart` is measured over a PARTIAL record and
        // every count under it would silently under-report. Say so rather than round down.
        <Chip
          size="small"
          variant="outlined"
          color="warning"
          label="range starts before the analytics window"
          sx={CHIP_SX}
        />
      )}
      {/* There is nothing to clear about a window — the timescale bar is how you change that,
          and a dead X beside it would be a control that does nothing. */}
      {scope === 'selection' && (
        <IconButton size="small" onClick={onClear} aria-label="Clear selection" sx={{ ml: 'auto' }}>
          <CloseIcon fontSize="small" />
        </IconButton>
      )}
    </Stack>
  )
}

export function RangeStatsPanel({ stats, scope, zoneCaption, onClear }: RangeStatsPanelProps): JSX.Element {
  const { basis } = useRateBasis()
  const footnote = unstatedCaption(stats)
  return (
    <Paper
      variant="outlined"
      // No `flexGrow`/`minHeight` since JOS-289: there is no leftover column height for this panel
      // to be the one that absorbs, and growing into space it did not earn is what stretched the
      // zone table's sticky-header slot in the first place.
      sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1.25 }}
      data-testid="leveling-range-stats"
      data-scope={scope}
    >
      <HeaderRow stats={stats} scope={scope} zoneCaption={zoneCaption} onClear={onClear} />
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        {rangeHeroes(stats, basis).map((s) => (
          <StatCard key={s.id} stat={s} />
        ))}
      </Stack>
      <ChipRow stats={stats} basis={basis} />
      <ZoneTable zones={stats.zones} basis={basis} />
      {footnote && (
        <Typography variant="caption" color="text.secondary">
          {footnote}
        </Typography>
      )}
    </Paper>
  )
}
