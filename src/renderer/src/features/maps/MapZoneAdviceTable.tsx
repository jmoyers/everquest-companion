// maps/MapZoneAdviceTable — the "Where to level" rows, as the Gear table draws its own.
//
// Owner (2026-09-12), on the first version: *"this is a horrible gridview why put all the stuff
// way over on the right and make it look so much worse than the gear or other tabs gridviews?"*.
// Fair. That version was a list of flex rows with two numbers pushed to the far edge. This is a
// `Table` in `GearTable.tsx`'s exact arrangement - `size="small"`, `stickyHeader`, sortable heads
// through `TableSortLabel`, every row a fixed `ROW_HEIGHT` so `useWindowedRows` can window it -
// so a reader who knows the Gear tab knows this one.
//
// THE ROW HEIGHT IS THE CONTRACT. `useWindowedRows` assumes every row is exactly `ROW_HEIGHT`
// tall (GearTable states it in full): a row that wraps drifts every row below it. The zone name
// ellipsizes rather than wrapping for that reason.
//
// NOTHING IS SORTED HERE. The rows arrive in order (`shared/zoneAdvice.sortAdvice`, ruling 4);
// the header only says which column they are in and asks for another.

import type { JSX, RefObject } from 'react'
import { Box, Chip, Link, Table, TableBody, TableCell, TableHead, TableRow, TableSortLabel } from '@mui/material'
import type { AdviceSort, AdviceSortKey, ZoneAdvice } from '@shared/zoneAdvice'
import { zoneShortNameFromCatalog } from '@shared/zones'
import type { WindowedRows } from '../../lib/useWindowedRows'
import { FIT, type GoalColumn } from './zoneAdviceUi'

/** Dense row height (px), MUI `size="small"` — the number the windowing hook is handed. */
export const ROW_HEIGHT = 37

const FIXED_ROW = {
  height: ROW_HEIGHT,
  maxHeight: ROW_HEIGHT,
  '& td': { py: 0, maxHeight: ROW_HEIGHT, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
} as const

const TINY = { height: 18, fontSize: 10, '& .MuiChip-label': { px: 0.6 } } as const

interface Column {
  key: AdviceSortKey
  label: string
  title?: string
  align?: 'right'
  width?: string
}

/** The fixed columns; the goal's own column is spliced in before `n` when the goal has one. */
const LEAD: readonly Column[] = [
  { key: 'fit', label: 'Fit', width: '96px' },
  { key: 'zone', label: 'Zone' },
  { key: 'low', label: 'From', align: 'right', width: '72px', title: 'The tenth percentile of the zone`s documented mob levels - where it starts, ignoring the odd low straggler' },
  { key: 'high', label: 'To', align: 'right', width: '72px', title: 'The ninetieth percentile - where it ends, ignoring the wandering named' }
]
const MOBS: Column = {
  key: 'n',
  label: 'Mobs',
  align: 'right',
  width: '72px',
  title: 'How many catalog mobs the level band rests on. A band drawn from a handful is a weaker claim than one drawn from a hundred.'
}

/** `sort` null means the goal's own order is in force and no column is lit. */
function SortHeader({ column, sort, onSort }: { column: Column; sort: AdviceSort | null; onSort: (key: AdviceSortKey) => void }): JSX.Element {
  // The lit direction, or null: one expression so the null check and the key check narrow together.
  const dir = sort !== null && sort.key === column.key ? sort.dir : null
  return (
    <TableCell align={column.align} title={column.title} sx={column.width === undefined ? {} : { width: column.width }}>
      <TableSortLabel active={dir !== null} direction={dir ?? 'desc'} data-testid={`zone-advice-sort-${column.key}`} onClick={() => onSort(column.key)}>
        {column.label}
      </TableSortLabel>
    </TableCell>
  )
}

/** A spacer row the windowing hook sizes, so the scrollbar is honest about the rows not drawn. */
function PadRow({ height, colSpan }: { height: number; colSpan: number }): JSX.Element | null {
  if (height <= 0) return null
  return (
    <TableRow sx={{ height }}>
      <TableCell colSpan={colSpan} sx={{ p: 0, border: 0 }} />
    </TableRow>
  )
}

function AdviceRow({ row, column, onPick }: { row: ZoneAdvice; column: GoalColumn | null; onPick?: (zone: string) => void }): JSX.Element {
  const fit = FIT[row.fit]
  const stem = zoneShortNameFromCatalog(row.zone)
  const [low, high] = row.band.typical
  return (
    <TableRow hover data-testid="zone-advice-row" data-fit={row.fit} sx={FIXED_ROW}>
      <TableCell>
        <Chip size="small" variant="outlined" color={fit.color} label={fit.label} sx={TINY} />
      </TableCell>
      <TableCell>
        {/* The app's link colour and dotted underline, so it reads as a thing to click - and plain
            text for the few zones the catalog names that no map stem answers to. */}
        {stem === null || onPick === undefined ? (
          row.zone
        ) : (
          <Link
            component="button"
            variant="body2"
            underline="none"
            title={`Open the ${row.zone} map`}
            data-testid="zone-advice-open"
            onClick={() => onPick(stem)}
            sx={{ color: 'primary.main', textDecoration: 'underline dotted', textUnderlineOffset: 2, '&:hover': { textDecoration: 'underline solid' } }}
          >
            {row.zone}
          </Link>
        )}
      </TableCell>
      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{low}</TableCell>
      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{high}</TableCell>
      {column !== null && (
        <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{column.value(row)}</TableCell>
      )}
      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.secondary' }}>{row.n}</TableCell>
    </TableRow>
  )
}

export default function MapZoneAdviceTable({
  rows,
  win,
  sort,
  column,
  scrollRef,
  onSort,
  onPick
}: {
  rows: readonly ZoneAdvice[]
  win: WindowedRows
  /** the column the rows are in, or null when the goal's own order is in force */
  sort: AdviceSort | null
  /** the goal's own column, or null for the mote goal - whose driver is the fit and the band */
  column: GoalColumn | null
  scrollRef: RefObject<HTMLDivElement | null>
  onSort: (key: AdviceSortKey) => void
  onPick?: (zone: string) => void
}): JSX.Element {
  const columns: Column[] = [
    ...LEAD,
    ...(column === null ? [] : [{ key: column.head === 'Wished' ? ('wished' as const) : ('motes' as const), label: column.head, title: column.title, align: 'right' as const, width: '96px' }]),
    MOBS
  ]
  return (
    <Box ref={scrollRef} data-testid="zone-advice-scroll" sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}>
      <Table size="small" stickyHeader data-testid="zone-advice-table" sx={{ tableLayout: 'fixed' }}>
        <TableHead>
          <TableRow>
            {columns.map((c) => (
              <SortHeader key={c.key} column={c} sort={sort} onSort={onSort} />
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          <PadRow height={win.topPad} colSpan={columns.length} />
          {rows.slice(win.start, win.end).map((row) => (
            <AdviceRow key={row.zone} row={row} column={column} onPick={onPick} />
          ))}
          <PadRow height={win.bottomPad} colSpan={columns.length} />
        </TableBody>
      </Table>
    </Box>
  )
}
