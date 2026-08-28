// THE READOUT'S TABLE PRIMITIVES — one cell, one header, one row (JOS-445..JOS-450).
//
// Its own file since JOS-450, and for the reason `NewAtLevelSearch.tsx` is its own file: the readout
// now draws TWO tables. `BestSpellsPanel` draws the ranked one, `BestSpellsSearch` draws the results
// of a whole-catalog query, and the whole point of the second is that a result looks EXACTLY like a
// ranked row — same figures, same columns, same widths, same rank chip — so the comparison the owner
// asked for is a comparison of like with like read straight down one column. Two copies of these
// three components would be two answers to what a row of this readout is.
//
// The measurements behind the widths and behind the two-line row shape live in `BestSpellsPanel`'s
// own header, where they were taken; nothing here re-decides them.

import { type JSX, type ReactNode, memo } from 'react'
import { Stack, TableCell, TableRow, TableSortLabel, Typography } from '@mui/material'
import {
  COLUMN_LABEL,
  COLUMN_TITLE,
  columnValue,
  type BestSpellColumn,
  type BestSpellRow,
  type BestSpellSort,
  type BestSpellTab
} from '@shared/bestSpells'
import type { ObservedSpellRanksSnap } from '@shared/spellRanks'
import { Tooltip } from '../../lib/Tooltip'
import { SpellTooltip } from '../../lib/SpellCard'
import { NONE } from './rangeStatsRows'
import { RankChip } from './UnlockList'

export const CELL_SX = { py: 0.25, px: 0.6, fontSize: 11, borderBottom: 'none' } as const
export const HEAD_SX = {
  ...CELL_SX,
  fontWeight: 700,
  whiteSpace: 'nowrap',
  color: 'text.secondary'
} as const

/**
 * A figure, formatted the way `spellMetricsParts` formats the same figure on an unlock row.
 *
 * Totals and rates are whole numbers (nobody buys a spell on a tenth of a point); the per-mana
 * ratios keep the one decimal `spellMetricsAt` rounded them to, because there the tenth is most of
 * the difference between two spells. An ABSENT figure is the app's null cell, never a zero.
 */
export function cellText(row: BestSpellRow, column: BestSpellColumn): string {
  const v = columnValue(row, column)
  if (v === null) return NONE
  return column === 'damagePerMana' || column === 'healPerMana' ? String(v) : String(Math.round(v))
}

/**
 * The share of the table each column takes, and it is MEASURED rather than left to `fixed`'s equal
 * split: `dmg/mana` is twice the header text of `dps` and an equal quarter clipped its last letters
 * off the right edge of the panel. The four add to 100, so the table never overflows its column.
 */
const COLUMN_WIDTH: Record<BestSpellColumn, string> = {
  dps: '22%',
  hps: '22%',
  damage: '23%',
  heal: '23%',
  mana: '22%',
  damagePerMana: '33%',
  healPerMana: '33%',
  hits: '12%'
}

/**
 * The AOE tab's five shares (owner ask 2026-08-23: the `hits` column). `hits` is the narrowest
 * thing a cell can hold — one digit and a sort arrow — and the 12 points it takes come off the
 * four numeric columns roughly in proportion, so the squeeze the JOS-448 measurement recorded
 * lands on all of them rather than clipping one. The five add to 100, same law as the four.
 */
const AOE_COLUMN_WIDTH: Record<string, string> = {
  dps: '20%',
  damage: '21%',
  hits: '12%',
  mana: '20%',
  damagePerMana: '27%'
}

/** The share one column takes on one tab: the AOE tab has five columns, every other tab four. */
export function widthOf(tab: BestSpellTab, column: BestSpellColumn): string {
  return tab === 'aoe' ? (AOE_COLUMN_WIDTH[column] ?? COLUMN_WIDTH[column]) : COLUMN_WIDTH[column]
}

/** One sortable header. Clicking the active column flips it; clicking another takes it descending. */
export function HeadCell({
  column,
  width,
  sort,
  onSort
}: {
  column: BestSpellColumn
  width: string
  sort: BestSpellSort
  onSort: (s: BestSpellSort) => void
}): JSX.Element {
  const active = sort.column === column
  return (
    <TableCell
      align="right"
      sx={{ ...HEAD_SX, width }}
      sortDirection={active ? (sort.desc ? 'desc' : 'asc') : false}
    >
      <Tooltip title={COLUMN_TITLE[column]}>
        <TableSortLabel
          active={active}
          direction={active && !sort.desc ? 'asc' : 'desc'}
          data-testid="best-spells-sort"
          data-column={column}
          data-active={active ? 'true' : 'false'}
          onClick={() => onSort({ column, desc: active ? !sort.desc : true })}
        >
          {COLUMN_LABEL[column]}
        </TableSortLabel>
      </Tooltip>
    </TableCell>
  )
}

/**
 * One spell, as TWO rows: its name across the whole width, then the side's four figures under it.
 *
 * MEASURED, and it is why the shape is not the obvious one. The first build put the name in a fifth
 * column; at the panel's real width (330px in the e2e's window, 260px at the app minimum) five
 * columns share out to ~62px each and every name in the table renders as `Disco…`, with the last
 * header clipped off the right edge for good measure. A spell you cannot read is not a
 * recommendation. Spending a LINE instead of a COLUMN gives the name the full width and the four
 * figures ~76px each — enough for the numbers, their headers and a sort arrow — and vertical space
 * is the axis this tab has to spare since JOS-289 made the page the scroller.
 *
 * The gain level rides beside the name because it is the whole point of the readout: `Garrison's
 * Mighty Mana Shock` sitting second at level 35 with an `L18` on it is the owner's own question,
 * answered.
 *
 * `extra` IS THE SEARCH ROW'S HALF (JOS-450): the era chip and the class-level chips a result
 * carries and a ranked row does not. The name line wraps because of it — a result for a spell six
 * classes share is six chips, and the alternative to a second line is a clipped one.
 *
 * MEMOIZED (JOS-511 item 3), and the panel's `columns` memo is what makes it hit: this row draws a
 * `SpellTooltip` anchor, a rank chip and four or five formatted cells, up to ~30 times per table,
 * and until the columns array stopped being rebuilt per render every one of them re-rendered on
 * every keystroke in the search box above them. `extra` is a NODE and a caller that mints one per
 * render (the search results do) opts itself out — which is correct rather than a gap: a row whose
 * chips were rebuilt has genuinely changed.
 */
export const SpellRow = memo(function SpellRow({
  row,
  columns,
  ranks,
  extra
}: {
  row: BestSpellRow
  columns: readonly BestSpellColumn[]
  ranks: ObservedSpellRanksSnap | null
  /** drawn after the rank chip on the name line; absent on every ranked row */
  extra?: ReactNode
}): JSX.Element {
  return (
    <>
      <TableRow data-testid="best-spells-name-row" data-name={row.name}>
        <TableCell colSpan={columns.length} sx={{ ...CELL_SX, pt: 0.5, pb: 0 }}>
          <Stack
            direction="row"
            spacing={0.5}
            alignItems="baseline"
            flexWrap="wrap"
            useFlexGap
            sx={{ minWidth: 0 }}
          >
            <SpellTooltip name={row.name}>
              <Typography variant="caption" sx={{ fontSize: 11, fontWeight: 600 }} noWrap>
                {row.name}
              </Typography>
            </SpellTooltip>
            <Typography variant="caption" color="text.disabled" sx={{ fontSize: 9.5 }} noWrap>
              L{row.gainedAt}
            </Typography>
            <RankChip name={row.name} ranks={ranks} />
            {extra}
          </Stack>
        </TableCell>
      </TableRow>
      <TableRow hover data-testid="best-spells-row" data-name={row.name}>
        {columns.map((c) => (
          <TableCell key={c} align="right" sx={CELL_SX} data-testid="best-spells-cell" data-column={c}>
            {cellText(row, c)}
          </TableCell>
        ))}
      </TableRow>
    </>
  )
})
