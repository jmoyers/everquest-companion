// ItemZoneTable — WHERE THIS ITEM DROPS FOR YOU, AND HOW OFTEN (JOS-78).
//
// It replaces the drill-down's old "Seen in zones" bar list. That list answered half the question:
// it said a zone had produced eleven of something, with no way to tell eleven-in-an-evening from
// eleven-over-a-fortnight. The rate is the half that was missing, and the two users who asked for
// this asked for exactly it ("motes per hour, which zone is better").
//
// PRESENTATION ONLY. Every number arrives already computed by the pure `shared/lootRates.ts`; the
// two honesty rules it enforces are visible here as formatting and nothing else:
//   • a null rate is an em-dash (`NONE`), never '0.00' — no active time is not a measured zero;
//   • a rate NEVER appears without the active span it was measured over — the `Active` column,
//     which is not optional and is not a tooltip. One drop in five minutes is a true 12 drops/hr
//     and a very small sample, and the only thing separating the two is the column beside it. The
//     duration is spelled by `fmtDuration`, the leveling tab's own, so a span reads identically
//     wherever it appears.
//
// Zone swatches come from `zoneBands.zoneColor`, the same function the leveling chart strip and
// the range panel use, so one zone is one hue everywhere in the app.

import type { JSX } from 'react'
import { Box, Chip, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material'
import type { ItemZoneRow } from '@shared/lootRates'
import type { ZoneShort } from '@shared/maps'
// A LOG spelling, so the log-side fold — the same lookup the Maps tab runs on your zone line —
// and the refused ones stay the plain text they were.
import { zoneShortName } from '@shared/zones'
import { CellLink } from '../../lib/CellLink'
import { formatDropRate } from '../../lib/formatRate'
import { fmtDuration } from '../leveling/levelChartGeometry'
import { ACTIVE_TIME_TITLE, NONE } from '../leveling/rangeStatsRows'
import { zoneColor } from '../leveling/zoneBands'
import { ObservedChip } from './ItemDbSources'

const CELL_SX = { py: 0.35, fontSize: 12 } as const
const HEAD_SX = { ...CELL_SX, fontWeight: 700, whiteSpace: 'nowrap' } as const

/** The whole rate cell: the number, or an em-dash and the reason it is one. */
function RateCell({ row }: { row: ItemZoneRow }): JSX.Element {
  if (row.dropsPerHourActive == null) {
    return (
      <Box component="span" title="no active time recorded in this zone">
        {NONE}
      </Box>
    )
  }
  return <>{formatDropRate(row.dropsPerHourActive)}</>
}

function ZoneRow({
  row,
  onOpenMapZone
}: {
  row: ItemZoneRow
  onOpenMapZone?: ((zone: ZoneShort) => void) | undefined
}): JSX.Element {
  const stem = onOpenMapZone === undefined ? null : zoneShortName(row.zone)
  return (
    <TableRow hover data-testid="item-zone-row">
      <TableCell sx={{ ...CELL_SX, width: 18, pr: 0 }}>
        <Box sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: zoneColor(row.zone) }} />
      </TableCell>
      <TableCell sx={CELL_SX}>
        <Typography variant="caption" noWrap title={row.zone}>
          {stem === null || onOpenMapZone === undefined ? (
            row.zone
          ) : (
            <CellLink text={row.zone} onOpen={() => { onOpenMapZone(stem) }} />
          )}
        </Typography>
      </TableCell>
      <TableCell align="right" sx={CELL_SX}>
        {row.drops.toLocaleString()}
      </TableCell>
      <TableCell align="right" sx={CELL_SX} data-testid="item-zone-rate">
        <RateCell row={row} />
      </TableCell>
      {/* THE SPAN THE RATE WAS MEASURED OVER. Never optional, never a tooltip: it is what turns a
          number into a measurement. */}
      <TableCell align="right" sx={{ ...CELL_SX, opacity: 0.55, whiteSpace: 'nowrap' }}>
        {row.activeMs > 0 ? fmtDuration(row.activeMs) : NONE}
      </TableCell>
    </TableRow>
  )
}

export interface ItemZoneTableProps {
  rows: ItemZoneRow[]
  /** True when the record reached below the analytics window — some rows have counts but no span. */
  clipped: boolean
  /** True once the character has ANY loot line for this item. Separates "never looted" from
   *  "looted, but the zone timeline has nothing to divide by" — two different empty states. */
  looted: boolean
  /** a zone's door to the Maps tab (App's `openMapZone`); absent, the plain text it was */
  onOpenMapZone?: (zone: ZoneShort) => void
}

export function ItemZoneTable({ rows, clipped, looted, onOpenMapZone }: ItemZoneTableProps): JSX.Element {
  return (
    <Box sx={{ flex: 1.4, minWidth: 0 }} data-testid="item-zone-table">
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.5 }} flexWrap="wrap" useFlexGap>
        <Typography variant="subtitle2">Where it drops</Typography>
        {/* The caption that names the denominator now says what it MEANS on hover (JOS-249) —
            a native title, never a popper, and no new element on a header that is already three
            things wide. */}
        <Typography component="span" variant="caption" color="text.secondary" title={ACTIVE_TIME_TITLE}>
          (per hour of active time)
        </Typography>
        <ObservedChip />
      </Stack>
      {rows.length === 0 && (
        <Typography variant="caption" data-testid="item-zone-empty">
          {looted ? 'No zone recorded for your drops of this item.' : 'You have not looted this yet.'}
        </Typography>
      )}
      {rows.length > 0 && (
        // The fixed-height scroll box law: a well-travelled item can list a dozen zones and must
        // never size to its content and grow the pane it sits in.
        <Box sx={{ maxHeight: 220, overflow: 'auto' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell sx={{ ...HEAD_SX, width: 18, pr: 0 }} />
                <TableCell sx={HEAD_SX}>Zone</TableCell>
                <TableCell align="right" sx={HEAD_SX}>
                  Drops
                </TableCell>
                <TableCell align="right" sx={HEAD_SX}>
                  Rate
                </TableCell>
                <TableCell align="right" sx={HEAD_SX} title={ACTIVE_TIME_TITLE}>
                  Active
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => (
                <ZoneRow key={r.key} row={r} onOpenMapZone={onOpenMapZone} />
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
      {clipped && (
        // State, not process: the analytics zone column is capped drop-oldest, so an old drop can
        // have a true count and no span to divide by. Say so rather than let an em-dash read as
        // a bug.
        <Chip
          size="small"
          variant="outlined"
          color="warning"
          label="older drops reach past the analytics window"
          sx={{ height: 20, mt: 0.75 }}
        />
      )}
    </Box>
  )
}
