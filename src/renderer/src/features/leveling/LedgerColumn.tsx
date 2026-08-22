import type { JSX } from 'react'
import { Box, Chip, Paper, Stack, Typography } from '@mui/material'
import type { AASpendEvent } from '@shared/types'
import { formatDate } from '../../lib/formatDate'
import { SWAP_COLOR } from './levelCharts'
import type { ScopedStats } from './windowScope'
// The per-ability AA ladder — the flat purchases list's replacement in the same slot.
import { AaLedgerPanel } from './AaLedgerPanel'
// What DROPPED in the scope (JOS-78) — the loot half of the same question the rates answer. It
// takes the whole `ScopedStats` and derives its own rows (pure `shared/lootRates.ts`), so nothing
// here assembles a second denominator.
import { WindowDropsPanel } from './WindowDropsPanel'

/**
 * THE LEVELING TAB'S RIGHT COLUMN — the account of what you bought, what dropped while you were
 * buying it, and the running record of both.
 *
 * ITS OWN FILE SINCE JOS-300, for the reason `LevelingHeroes` got one: LevelingView reached the
 * measured `max-lines` ceiling and the rule here is to SPLIT rather than ratchet. This is the
 * natural seam — the column is a self-contained composition over three panels and a scope, it
 * shares no state with the charts beside it, and moving "New at this level" into the LEFT column
 * is what made the two columns independent enough to say so.
 */

/** One row of the interleaved progress feed. Built in LevelingView (`buildFeed`), drawn here. */
export interface FeedItem {
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
 * Interleaved level/AA/swap feed, newest first — SCOPED like every other number on the tab
 * (JOS-75). A feed still listing last week's dings under an hour-wide chart is the same
 * disagreement the rates had.
 *
 * The empty case is STATED. A narrow window legitimately holds no ding and no gain line, and a
 * silently empty box reads as a broken panel rather than as a quiet hour.
 */
function ProgressFeedPanel({ feed, scopeLabel }: { feed: FeedItem[]; scopeLabel: string }): JSX.Element {
  return (
    <Paper variant="outlined" sx={{ p: 2 }} data-testid="leveling-feed">
      <Typography variant="subtitle2" gutterBottom>
        Recent progress
      </Typography>
      {feed.length === 0 && (
        <Typography variant="caption" color="text.secondary" data-testid="leveling-feed-empty">
          no level-ups or AA gains in {scopeLabel}
        </Typography>
      )}
      {/* NO INNER SCROLLER (JOS-289). The feed is already CAPPED at `FEED_MAX` rows, so its
          honest height is bounded by construction and the page carries it. */}
      <Box>
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

/**
 * The three panels themselves. Height is whatever they need — since JOS-289 there is no shared
 * fixed height for the two columns to split, and no scroller anywhere inside them except the drops
 * list's earned `maxHeight` ceiling.
 *
 * IT OWNS NO WIDTH SINCE JOS-445, and the move is the same one `ChartsColumn` made under JOS-300.
 * This used to BE the right column, so it carried the `flex`/`minWidth`; the column now has a
 * second tenant above it (`BestSpellsPanel`) that renders on a log too thin to chart, so the
 * wrapper in LevelingView is the right column and sizing belongs on the box that is drawn whenever
 * EITHER tenant is. Leaving the flex here would nest a sized column inside a sized column.
 *
 * THESE THREE ARE STILL THE CHARTED STATE'S, and that is deliberate: all three are reads of a
 * SCOPE, and a scope exists exactly when the charts do. The left column has the opposite
 * obligation (see LevelingView's placement law) — it must render with no log at all.
 */
export function LedgerColumn(p: {
  spends: readonly AASpendEvent[]
  allocated: number
  scope: ScopedStats
  feed: FeedItem[]
  onOpenItem?: (item?: string) => void
}): JSX.Element {
  return (
    <Stack spacing={2}>
      {/* The AA LEDGER stays full-history on purpose: it is an ACCOUNT of what you have bought,
          and its footer must equal the AA-points-spent hero card. "AA allocated in the last hour"
          is not a thing anyone owns. */}
      <AaLedgerPanel spends={p.spends} allocated={p.allocated} />
      {/* SCOPED, like the feed below it: the items observed dropping in the stretch the charts are
          drawing, ordered by how many you saw. Clicking one opens its Loot drill-down through the
          app's own opener (JOS-43/JOS-78). */}
      <WindowDropsPanel scope={p.scope} onOpenItem={p.onOpenItem} />
      <ProgressFeedPanel feed={p.feed} scopeLabel={p.scope.label} />
    </Stack>
  )
}
