// WindowDropsPanel — WHAT DROPPED IN THE STRETCH YOU ARE LOOKING AT (JOS-78).
//
// The Leveling tab already answers "how fast am I levelling here" for whatever scope is in force
// (JOS-75). This is the same question about LOOT: the items observed dropping inside that scope,
// most-observed first, each with its in-window count and its rate over the scope's own active
// time. It is the panel two users asked for from opposite directions — "which zone pays more
// motes an hour" — and it reads the SAME window every other number on this tab reads, so a change
// of timescale moves it with everything else.
//
// NO INVENTED RANKING. The order is the observation: drops descending, then most recent, then
// name (`shared/lootRates.ts windowItemRows`). Motes float to the top because you loot a lot of
// them, not because anything here knows what a mote is worth — nothing in this repo ranks the ten
// tiers, and a per-tier weighting would be a fact the game never stated.
//
// ONE DENOMINATOR, STATED ONCE. Every row's rate divides by `stats.activeMs`, the scope's own
// active time, so the whole panel is measured over one span and says so in a single caption
// (`activeSpanText` — the leveling tab's existing spelling, not a second one). A rate that never
// stated its span would let one drop in five minutes read as a confident 12/hr.
//
// CLICKING A ROW OPENS THE ITEM DRILL-DOWN through the app's `openLoot` opener, which parks this
// tab on the navigation stack — so the drill's Back says "Back to Leveling" and returns here
// (JOS-43: one mechanism, never a per-view `cameFrom` prop).

import { type JSX, useMemo } from 'react'
import { Box, Link, Paper, Stack, Typography } from '@mui/material'
import { windowItemRows, type WindowItemRow } from '@shared/lootRates'
import { formatDropRate } from '../../lib/formatRate'
import { EQ_ITEM_COLORS } from '../../lib/ItemWindow'
import { useLootHistory } from '../loot/useLootHistory'
import { NONE, activeSpanText } from './rangeStatsRows'
import type { ScopedStats } from './windowScope'

export interface WindowDropsPanelProps {
  /**
   * THE tab's scope (JOS-75), whole. The panel takes the object rather than three unpacked
   * fields so it cannot be handed a range from one scope and a denominator from another — the
   * exact shape of drift `windowScope.ts` exists to make unrepresentable.
   */
  scope: ScopedStats
  /** Opens the item's Loot drill-down. Absent ⇒ the names render as plain text (the panel is
   *  still worth having; it just cannot navigate). */
  onOpenItem?: (item: string) => void
}

/**
 * The rows, derived where they are drawn. The panel owns its own subscription to the loot module
 * for the same reason the AA ledger owns its own data: the view's job is composition, and a
 * derivation lifted into it is a derivation nothing else can read.
 */
function useScopedDrops(scope: ScopedStats): WindowItemRow[] {
  const events = useLootHistory()
  return useMemo(
    () =>
      windowItemRows({
        events,
        t0: scope.range.t0,
        t1: scope.range.t1,
        activeMs: scope.stats.activeMs,
        // BOTH halves of the slice (JOS-130). `activeMs` above is already the zone's own active
        // time when the slice carries a zone, so counting every zone's drops against it would
        // put a rate under a denominator it was never measured over.
        zoneKey: scope.zoneKey
      }),
    [events, scope]
  )
}

function DropRow({ row, onOpenItem }: { row: WindowItemRow; onOpenItem?: (item: string) => void }): JSX.Element {
  const rate = row.dropsPerHourActive == null ? NONE : formatDropRate(row.dropsPerHourActive)
  return (
    <Stack direction="row" spacing={1} alignItems="baseline" sx={{ py: 0.35 }} data-testid="leveling-drop-row">
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        {onOpenItem ? (
          <Link
            component="button"
            type="button"
            underline="hover"
            data-testid="leveling-drop-item"
            onClick={() => {
              onOpenItem(row.item)
            }}
            sx={{
              font: 'inherit',
              fontSize: 13,
              color: EQ_ITEM_COLORS.name,
              cursor: 'pointer',
              display: 'block',
              maxWidth: '100%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textAlign: 'left'
            }}
          >
            {row.item}
          </Link>
        ) : (
          <Typography variant="body2" noWrap sx={{ color: EQ_ITEM_COLORS.name }}>
            {row.item}
          </Typography>
        )}
      </Box>
      <Typography variant="caption" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
        {row.drops.toLocaleString()}×
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap', minWidth: 92, textAlign: 'right' }}>
        {rate}
      </Typography>
    </Stack>
  )
}

export function WindowDropsPanel({ scope, onOpenItem }: WindowDropsPanelProps): JSX.Element {
  const rows = useScopedDrops(scope)
  const activeMs = scope.stats.activeMs
  return (
    <Paper
      variant="outlined"
      // THE FIXED-HEIGHT LAW, on a column that already holds two other panels: an explicit floor
      // AND ceiling, with the scroll on the list inside. Without the floor this is just another
      // shrinkable flex item — MEASURED in the e2e, where the three-panel column squeezed it to a
      // clipped strip whose rows were in the DOM and unclickable. The ceiling is the AA ledger's
      // own recipe (a share of the column, never a pixel count), so a tall window gives the list
      // more room and a short one still leaves the progress feed something.
      sx={{ p: 2, display: 'flex', flexDirection: 'column', minHeight: 132, maxHeight: '40%' }}
      data-testid="leveling-drops"
    >
      <Typography variant="subtitle2">Dropping in this window</Typography>
      <Typography variant="caption" color="text.secondary" gutterBottom display="block">
        {/* ONE span for the whole panel — every rate below divides by it, stated once rather
            than repeated on every row. Nothing is said when there is nothing to measure. */}
        {rows.length > 0 ? activeSpanText(activeMs) : null}
      </Typography>
      {rows.length === 0 && (
        // An empty window is a STATE and says which window it is empty for. A silently blank box
        // reads as a broken panel rather than as a quiet hour.
        <Typography variant="caption" color="text.secondary" data-testid="leveling-drops-empty">
          no drops in {scope.label}
        </Typography>
      )}
      {/* The list owns the scroll — a long window can hold hundreds of distinct items. */}
      <Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto', pr: 0.75 }}>
        {rows.map((r) => (
          <DropRow key={r.key} row={r} onOpenItem={onOpenItem} />
        ))}
      </Box>
    </Paper>
  )
}
