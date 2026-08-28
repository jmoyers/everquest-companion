// AA LEDGER PANEL — the per-ability ladder, in the slot the flat purchases list used to hold.
//
// WHAT CHANGED AND WHY. The old panel rendered one row per PURCHASE LINE (deduped by
// ability+rank), newest first. That is the log's own shape, not the player's question: on this
// character 125 post-epoch purchase lines are 50 abilities, 27 of them multi-rung ladders, and
// `Innate Regeneration`'s seven rungs sat scattered through the list with the 18 points they
// cost stated nowhere. The model already knew all of it (src/shared/aaLedger.ts) — only the view
// was flat. Sorted by points invested, because "where did my 341 points go" is the question a
// ledger answers; date order is already the Recent progress feed's job.
//
// THE FOOTER IS THE POINT, not decoration. Σ of the rows' invested is EXACTLY the AA-points-spent
// hero card, by construction (same latest-per-rank dedupe as `computeAAAccounting`), and the
// footer states that equality out loud so a disagreement would be visible rather than silent.
//
// HONESTY BADGES (law 1). Cost-0 rungs are auto-grants — shown, never priced, and never counted
// as purchases. A rung below an ability's top rank with no line in the log is labeled UNLOGGED,
// not "missing": the log window is the only evidence, and re-purchases of a rank already owned
// are labeled as re-purchases (the sole refund signal the log carries — there is no refund line),
// never as a respec count.

import { type JSX, memo, useCallback, useMemo, useState } from 'react'
import { Box, Chip, Paper, Stack, Typography, type SxProps, type Theme } from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import type { AASpendEvent } from '@shared/types'
import { aaLedger, aaLedgerSummary, type AaAbilityRow } from '@shared/aaLedger'
import { Tooltip } from '../../lib/Tooltip'
import { formatDate } from '../../lib/formatDate'

const PAID_COLOR = '#b07fd0'
const AUTO_COLOR = '#7a7a7a'

/** Compact "ranks 1–8" / "ranks 1, 3" for the unlogged badge. */
function rangeLabel(ranks: readonly number[]): string {
  if (ranks.length === 0) return ''
  const contiguous = ranks[ranks.length - 1] - ranks[0] + 1 === ranks.length
  if (contiguous && ranks.length > 1) return `${String(ranks[0])}-${String(ranks[ranks.length - 1])}`
  return ranks.map(String).join(', ')
}

const chipSx = (color: string): SxProps<Theme> => ({
  height: 17,
  fontSize: 10,
  bgcolor: `${color}22`,
  color,
  '& .MuiChip-label': { px: 0.6 }
})

/** The badges that qualify a row: auto-granted, re-purchased, partially logged. */
function RowBadges({ row }: { row: AaAbilityRow }): JSX.Element {
  return (
    <>
      {row.autoRanks > 0 && (
        <Tooltip
          title={`${String(row.autoRanks)} rank${row.autoRanks === 1 ? '' : 's'} granted, not bought`}
        >
          <Chip size="small" label="auto" data-testid="aa-ledger-auto" sx={chipSx(AUTO_COLOR)} />
        </Tooltip>
      )}
      {row.rebuys > 0 && (
        <Tooltip title="a rank already owned was purchased again">
          <Chip
            size="small"
            label={`re-bought ×${String(row.rebuys)}`}
            data-testid="aa-ledger-rebuy"
            sx={chipSx('#d9b25f')}
          />
        </Tooltip>
      )}
      {row.unlogged.length > 0 && (
        <Tooltip
          title={`rank${row.unlogged.length === 1 ? '' : 's'} ${rangeLabel(row.unlogged)} never appear in this log`}
        >
          <Chip
            size="small"
            label={`rank${row.unlogged.length === 1 ? '' : 's'} ${rangeLabel(row.unlogged)} unlogged`}
            data-testid="aa-ledger-unlogged"
            sx={chipSx('#6fb3d2')}
          />
        </Tooltip>
      )}
    </>
  )
}

/** The expanded ladder: one line per logged rung, with the cost and date the log stated. */
function RankRungs({ row }: { row: AaAbilityRow }): JSX.Element {
  return (
    <Box sx={{ pl: 3.5, pb: 0.5 }}>
      {row.ranks.map((r) => (
        <Stack
          key={r.rank}
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ py: 0.1 }}
          data-testid="aa-ledger-rung"
        >
          <Typography variant="caption" color="text.secondary" sx={{ minWidth: 46 }}>
            rank {r.rank}
          </Typography>
          <Typography
            variant="caption"
            sx={{ minWidth: 52, color: r.cost > 0 ? 'text.primary' : 'text.disabled' }}
          >
            {r.cost > 0 ? `${String(r.cost)} pt${r.cost === 1 ? '' : 's'}` : 'granted'}
          </Typography>
          {r.buys > 1 && (
            <Typography variant="caption" color="text.disabled">
              bought {r.buys}×
            </Typography>
          )}
          <Box sx={{ flexGrow: 1 }} />
          <Typography variant="caption" color="text.disabled" noWrap>
            {formatDate(r.ts)}
          </Typography>
        </Stack>
      ))}
    </Box>
  )
}

/**
 * One ability. The bar behind the name is this ability's share of the LARGEST ability's spend —
 * a relative read only, which is why it carries no number of its own; the points are printed.
 */
const AbilityRow = memo(function AbilityRow({
  row,
  max,
  open,
  onToggle
}: {
  row: AaAbilityRow
  max: number
  open: boolean
  /** Takes the ability's NAME (JOS-511 item 3): a per-row `() => toggle(r.name)` closure is a fresh
   *  prop on every row on every render, which is a memo that can never hit. One callback, fifty
   *  rows, and the row hands back the name it already knows. */
  onToggle: (name: string) => void
}): JSX.Element {
  const share = max > 0 ? (row.invested / max) * 100 : 0
  const paid = row.invested > 0
  return (
    <Box data-testid="aa-ledger-row" data-ability={row.name}>
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        onClick={() => {
          onToggle(row.name)
        }}
        sx={{
          py: 0.3,
          px: 0.5,
          cursor: 'pointer',
          position: 'relative',
          borderRadius: 0.5,
          '&:hover': { bgcolor: 'action.hover' }
        }}
      >
        {/* left/top/bottom, never `inset: 0` — that pins `right` too and the width is ignored. */}
        <Box
          sx={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${String(share)}%`,
            bgcolor: `${PAID_COLOR}18`,
            borderRadius: 0.5,
            pointerEvents: 'none'
          }}
        />
        {open ? (
          <ExpandMoreIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
        ) : (
          <ChevronRightIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
        )}
        <AutoAwesomeIcon sx={{ fontSize: 12, color: paid ? PAID_COLOR : AUTO_COLOR }} />
        <Typography
          variant="caption"
          sx={{ flexGrow: 1, minWidth: 0, color: paid ? 'text.primary' : 'text.secondary' }}
          noWrap
          title={row.name}
        >
          {row.name}
        </Typography>
        <RowBadges row={row} />
        <Tooltip
          title={`${String(row.ranks.length)} rank${row.ranks.length === 1 ? '' : 's'} logged, top rank ${String(row.topRank)}`}
        >
          <Chip size="small" label={`R${String(row.topRank)}`} sx={chipSx('#5fbf72')} />
        </Tooltip>
        <Typography
          variant="caption"
          sx={{ minWidth: 46, textAlign: 'right', color: paid ? 'text.secondary' : 'text.disabled' }}
        >
          {paid ? `${String(row.invested)} pts` : '-'}
        </Typography>
      </Stack>
      {open && <RankRungs row={row} />}
    </Box>
  )
})

/**
 * HOW MANY LADDERS ARE MOUNTED BEFORE THE DISCLOSURE (JOS-511 item 5).
 *
 * The panel is ALWAYS mounted — it is the first thing in the right column in the charted state — and
 * it drew one `AbilityRow` per ability with no ceiling at all: 50 on the owner's own log, each one a
 * Stack, three chips, an icon pair and a share bar. That is an unbounded mount on a tab whose whole
 * complaint is wasted render.
 *
 * A DISCLOSURE RATHER THAN A WINDOW, and JOS-289 is the reason: `useWindowedRows` needs a scrolling
 * container with a height, which is precisely the porthole the owner had removed from THIS panel
 * ("the ladder is as tall as the account - you read it down"). A `+N more` hides nothing the page
 * was showing without a click and adds no scroller; it is also the shape the two panels either side
 * of it already use (`best-spells-more`, `unlock-era-toggle`), so a reader has met it.
 *
 * 25 rather than the readout's 10: this is a LEDGER read downward, and the rows are sorted by points
 * invested, so the top 25 is where "where did my points go" is answered on a real account while the
 * tail is one-point abilities and auto-grants. THE TOTALS ARE UNAFFECTED, which is the load-bearing
 * part: the count in the heading and every figure in the footer are computed over ALL rows, so the
 * footer's equality with the AA-points-spent hero card holds whether or not the disclosure is open.
 */
const LADDER_TOP_N = 25

/** A one-click disclosure over the ladders below the ceiling — `RowDisclosure`'s shape next door. */
function MoreLadders({
  rows,
  max,
  open,
  onToggle
}: {
  rows: readonly AaAbilityRow[]
  max: number
  open: ReadonlySet<string>
  onToggle: (name: string) => void
}): JSX.Element | null {
  const [shown, setShown] = useState(false)
  if (rows.length === 0) return null
  return (
    <>
      <Stack
        direction="row"
        alignItems="center"
        role="button"
        tabIndex={0}
        aria-expanded={shown}
        onClick={() => {
          setShown(!shown)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') setShown(!shown)
        }}
        data-testid="aa-ledger-more"
        sx={{
          display: 'inline-flex',
          cursor: 'pointer',
          color: 'text.secondary',
          '&:hover': { color: 'primary.main' }
        }}
      >
        <Typography variant="caption" sx={{ fontSize: 10.5 }}>
          +{rows.length} more
        </Typography>
        <ExpandMoreIcon
          fontSize="inherit"
          sx={{ transition: 'transform 120ms', transform: shown ? 'rotate(180deg)' : undefined }}
        />
      </Stack>
      {shown &&
        rows.map((r) => (
          <AbilityRow key={r.name} row={r} max={max} open={open.has(r.name)} onToggle={onToggle} />
        ))}
    </>
  )
}

/**
 * The panel. `allocated` is the hero card's AA-points-spent figure, passed in so the footer can
 * state the equality rather than re-derive it — the two are the same identity by construction
 * (tests/aaLedger.test.mts pins it against the real log).
 */
export function AaLedgerPanel({
  spends,
  allocated
}: {
  spends: readonly AASpendEvent[]
  allocated: number
}): JSX.Element | null {
  const rows = useMemo(() => aaLedger(spends), [spends])
  const summary = useMemo(() => aaLedgerSummary(rows), [rows])
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set<string>())
  // ONE callback for every row (JOS-511 item 3). It closes over nothing from the render — `setOpen`
  // takes the updater form — so it is stable for the life of the panel and the row memo can hit.
  const toggle = useCallback((name: string): void => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(name)) next.add(name)
      return next
    })
  }, [])
  // The two slices, memoized so the arrays feeding the rows are stable across a render that did not
  // change the ledger.
  const top = useMemo(() => rows.slice(0, LADDER_TOP_N), [rows])
  const rest = useMemo(() => rows.slice(LADDER_TOP_N), [rows])
  if (rows.length === 0) return null
  const max = rows[0].invested
  return (
    <Paper variant="outlined" sx={{ p: 2 }} data-testid="aa-ledger">
      <Typography variant="subtitle2">
        AA abilities{' '}
        <Typography component="span" variant="caption" color="text.secondary">
          ({summary.abilities})
        </Typography>
      </Typography>
      <Typography variant="caption" color="text.secondary" gutterBottom display="block">
        every rank the log recorded, grouped into ladders and sorted by points invested - click a
        row for its rungs
      </Typography>
      {/* THE LADDER IS AS TALL AS THE ACCOUNT (JOS-289). The list used to own a scroll inside a
          `maxHeight: 45%` paper so the reconciliation footer stayed pinned; on the real log that
          is 50 abilities read seven at a time, and the footer was pinned to the top of a porthole.
          The panel is a LEDGER — you read it down — so it takes its honest height, the footer sits
          under the last row where a total belongs, and the page carries the whole thing. */}
      <Box>
        {top.map((r) => (
          <AbilityRow key={r.name} row={r} max={max} open={open.has(r.name)} onToggle={toggle} />
        ))}
        <MoreLadders rows={rest} max={max} open={open} onToggle={toggle} />
      </Box>
      <Typography
        variant="caption"
        color="text.disabled"
        sx={{ pt: 0.75, mt: 0.75, borderTop: 1, borderColor: 'divider' }}
        data-testid="aa-ledger-total"
      >
        {summary.invested.toLocaleString()} pts across {summary.paidRanks} bought rank
        {summary.paidRanks === 1 ? '' : 's'}
        {summary.autoRanks > 0 && ` · ${String(summary.autoRanks)} granted`} - the same total as
        the {allocated.toLocaleString()} AA points spent above
      </Typography>
    </Paper>
  )
}
