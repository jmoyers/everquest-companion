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

import { type JSX, memo, useMemo, useRef } from 'react'
import { Box, Link, Paper, Stack, Typography } from '@mui/material'
import { windowItemRows, type WindowItemRow } from '@shared/lootRates'
import { formatDropRate } from '../../lib/formatRate'
import { useWindowedRows } from '../../lib/useWindowedRows'
import { EQ_ITEM_COLORS } from '../../lib/ItemWindow'
import { useLootHistory } from '../loot/useLootHistory'
import { basisRead, pickRate, type BasisRead } from '@shared/rateBasis'
import { useRateBasis } from '../timeslice/useRateBasis'
import { NONE, basisSpanText, withBasis } from './rangeStatsRows'
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
        // The scope's own spans, whole (JOS-288) — `RangeStats` is assignable to `WindowSpans`, so
        // both denominators arrive together and the panel picks the one in force.
        spans: scope.stats,
        // BOTH halves of the slice (JOS-130). `spans` above is already the zone's own time when
        // the slice carries a zone, so counting every zone's drops against it would put a rate
        // under a denominator it was never measured over.
        zoneKey: scope.zoneKey,
        zoneExactKey: scope.zoneExactKey
      }),
    [events, scope]
  )
}

/**
 * ONE ROW's height in px — FIXED since JOS-511 item 5, which is what lets the list be windowed.
 *
 * It is what the row already measured (a 13px name line inside `py: 0.35`), written down rather
 * than inferred: `useWindowedRows` reserves the un-mounted rows' height with two spacers, and a
 * spacer can only be right if every row really is this tall.
 */
const DROP_ROW_H = 26

const DropRow = memo(function DropRow({
  row,
  read,
  onOpenItem
}: {
  row: WindowItemRow
  read: BasisRead
  onOpenItem?: (item: string) => void
}): JSX.Element {
  const perHour = pickRate(read, row.dropsPerHourActive, row.dropsPerHourWall)
  const rate = perHour == null ? NONE : formatDropRate(perHour)
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      sx={{ height: DROP_ROW_H }}
      data-testid="leveling-drop-row"
    >
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
})

/**
 * The panel's ceiling in px — about eighteen rows, which is the "generous, not a porthole" the
 * JOS-289 constraint asks for. A pixel count rather than a percentage on purpose: the tab has no
 * fixed height any more, so a `%` max-height has nothing to be a percentage OF and resolves to
 * none — which for a 641-row `All` scope would be twenty thousand pixels of page.
 */
const DROPS_MAX_H = 520

export function WindowDropsPanel({ scope, onOpenItem }: WindowDropsPanelProps): JSX.Element {
  const rows = useScopedDrops(scope)
  // ONE basis read for the panel (JOS-288): the caption's span and every row's denominator are the
  // same number, and the just-arrived gate fires once for all of them. MEMOIZED since JOS-511 item
  // 3: it is a fresh object, it is a prop on every row, and it decides nothing per render.
  const { basis } = useRateBasis()
  const read = useMemo(() => basisRead(basis, scope.stats), [basis, scope])
  // THE LIST IS WINDOWED (JOS-511 item 5), and this is the one panel on the tab where that is the
  // right answer rather than the forbidden one: it ALREADY owns a scroller by an owner-sanctioned
  // exception (`DROPS_MAX_H` below states the argument), so windowing adds no porthole — it only
  // stops mounting the rows the porthole was already hiding. 641 distinct looted item names in the
  // owner's log, all of which the `All` slice legitimately asks for, were 641 mounted Stacks with a
  // Link each; what is mounted now is the slice in view plus the hook's overscan.
  const scrollRef = useRef<HTMLDivElement>(null)
  const win = useWindowedRows({ count: rows.length, rowHeight: DROP_ROW_H, scrollRef })
  return (
    <Paper
      variant="outlined"
      // THE ONE PANEL ON THIS TAB THAT KEEPS A WINDOW, AND IT IS A CEILING RATHER THAN A HEIGHT
      // (JOS-289). Every other panel here now takes its honest height and lets the page scroll;
      // this list cannot, because its row count is unbounded by the SCOPE rather than by the data:
      // 641 distinct looted item names in the owner's log (measured 2026-08-13), all of which the
      // `All` slice legitimately asks for. So the rule is the JOS-260 one — windowed where the row
      // count demands it, and GENEROUS rather than a porthole. `maxHeight` (never `height`, never
      // the old `40%` share of a column height that no longer exists) means a scope with a dozen
      // drops shows all twelve with no scrollbar at all, and only a genuinely long list scrolls.
      sx={{ p: 2, display: 'flex', flexDirection: 'column', maxHeight: DROPS_MAX_H }}
      data-testid="leveling-drops"
    >
      <Typography variant="subtitle2">Dropping in this window</Typography>
      <Typography
        variant="caption"
        color="text.secondary"
        gutterBottom
        display="block"
        // The span every drops/hr on this panel divides by, so it hovers what that span IS
        // (JOS-249). Native title, no popper.
        title={rows.length > 0 ? withBasis('How much of this window the rates below are per.', read) : undefined}
      >
        {/* ONE span for the whole panel — every rate below divides by it, stated once rather
            than repeated on every row. Nothing is said when there is nothing to measure. */}
        {rows.length > 0 ? basisSpanText(read) : null}
        {rows.length > 0 && !read.measurable ? ' · too short to rate' : null}
      </Typography>
      {rows.length === 0 && (
        // An empty window is a STATE and says which window it is empty for. A silently blank box
        // reads as a broken panel rather than as a quiet hour.
        <Typography variant="caption" color="text.secondary" data-testid="leveling-drops-empty">
          no drops in {scope.label}
        </Typography>
      )}
      {/* The list owns the scroll, and only once it has outgrown the ceiling above — a long
          window really can hold hundreds of distinct items (641 measured). */}
      <Box ref={scrollRef} sx={{ minHeight: 0, overflowY: 'auto', pr: 0.75 }} data-testid="leveling-drops-list">
        {/* The two spacers reserve the un-mounted rows' height, so the scrollbar describes the whole
            list and not just the slice — see `useWindowedRows`. */}
        <Box sx={{ height: win.topPad }} />
        {rows.slice(win.start, win.end).map((r) => (
          <DropRow key={r.key} row={r} read={read} onOpenItem={onOpenItem} />
        ))}
        <Box sx={{ height: win.bottomPad }} />
      </Box>
    </Paper>
  )
}
