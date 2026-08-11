import { type JSX, memo } from 'react'
import { Box, Chip, Stack, TableCell, TableRow, Typography } from '@mui/material'
import type { ItemKnowledge, LootDisposition, LootEvent } from '@shared/types'
import { formatDateTime } from '../../lib/formatDate'
import { FavoriteStar } from '../favorites/FavoriteStar'
import type { InventoryRow } from '../inventory/reconcile'
import { isQuestItem } from './lootItemData'
import { KnowledgeBadge } from './KnowledgeBadge'
import type { GroupRow } from './lootGrouping'

// Fixed dense-row height (px) for the windowed tables (MUI Table size="small").
export const ROW_HEIGHT = 37

function fmtTime(ts: number): string {
  return formatDateTime(ts, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// A subtle disposition chip (Tasks #40/#47): where a looted-and-routed item went.
// Dense, low-emphasis — no chip for ordinary kept loot. Kept storage (currency/hoard/
// depot) reads info-blue; 'sold' (gone) is dimmed; 'combined' (merged into an upgrade)
// reads success-green.
function DispositionChip({ disposition }: { disposition?: LootDisposition }): JSX.Element | null {
  if (!disposition) return null
  const sx = { height: 18, fontSize: 11 } as const
  if (disposition === 'sold') {
    return <Chip size="small" variant="outlined" color="default" label="sold" sx={{ ...sx, opacity: 0.7 }} />
  }
  if (disposition === 'combined') {
    return <Chip size="small" variant="outlined" color="success" label="combined" sx={sx} />
  }
  return <Chip size="small" variant="outlined" color="info" label={disposition} sx={sx} />
}

/**
 * The "In inventory" cell — an ESTIMATE, never a fact (world-model law 1). The number is
 * the reconciled net held count (inventory/reconcile.ts): the active count source (looted
 * log and/or the last `/outputfile inventory` export) minus everything consumed by a
 * turned-in quest. The log cannot see bank deposits, destroys, trades or vendor sales that
 * happen off-camera, so it renders as a `~` chip like every other inferred value. `+N`
 * upgrade variants pool onto the base counting key, so a `Sphinx Claw` row and a
 * `Sphinx Claw +1` row show the same pooled estimate.
 *
 * IT USED TO SPELL THE INPUTS OUT IN A TOOLTIP, and does not any more (JOS-127). A popper on a
 * table row opens over the NEXT row, and every row here is a control (clicking one takes the
 * pane). The house convention already had the answer: one word, `est.`, beats a sentence — it
 * is in the column header, and the toolbar's "Count from" select names the source. Which
 * quests consumed how many still has a home, at full width, in the drill-down.
 *
 * IT TAKES A NUMBER RATHER THAN A ROW (JOS-160) because the two row kinds ask different witnesses.
 * A loot row's estimate is the reconciled `net` — the active count source, minus turn-ins, exactly
 * as before. An INVENTORY-ONLY row has no loot history at all and its `net` is 0 under the `log`
 * source, so it reports what the export vouches for; a row the app is showing you *because* the
 * export named it, rendering a dash where that count goes, would be the app declining to repeat
 * its own evidence.
 */
const InventoryEstimate = memo(function InventoryEstimate({ n }: { n: number }): JSX.Element {
  if (n <= 0) return <Box component="span" sx={{ color: 'text.disabled' }}>-</Box>
  return (
    <Chip
      size="small"
      variant="outlined"
      label={`~${n}`}
      sx={{ height: 18, fontSize: 11, color: 'text.secondary' }}
    />
  )
})

// Memoized rows (React.memo + stable props) so a re-render that doesn't touch a
// given row's data skips it entirely (precedent: #17's combat work).
export const GroupedRow = memo(function GroupedRow({
  g,
  favorited,
  knowledge,
  inv,
  onToggleFavorite,
  onSelect
}: {
  g: GroupRow
  favorited: boolean
  knowledge?: ItemKnowledge
  inv?: InventoryRow
  onToggleFavorite: (name: string) => void
  onSelect: (item: string) => void
}): JSX.Element {
  const posky = isQuestItem(g.item)
  return (
    <TableRow
      hover
      // The stable handle for "a drill opened from the ledger itself" — a NATIVE arrival, whose
      // Back must still mean this list (JOS-43). Both row kinds carry it: they are one control.
      data-testid="loot-row"
      sx={{ cursor: 'pointer', height: ROW_HEIGHT, '& td': { py: 0 }, opacity: g.invOnly ? 0.7 : 1 }}
      onClick={() => onSelect(g.item)}
    >
      <TableCell padding="checkbox">
        <FavoriteStar name={g.item} favorited={favorited} onToggle={onToggleFavorite} />
      </TableCell>
      <TableCell>
        <Stack direction="row" spacing={1} alignItems="center">
          {/* The NAME is plain text (JOS-127). It used to anchor a `placement="top"`, interactive
              item card, which on the rows nearest the top of the ledger opened straight across
              the toolbar and held the pointer there. Click the row: the drill-down says all of
              it, and is the surface that was always meant to. The testid is the handle
              `loot-sort.e2e.mts` hovers to prove nothing opens there any more. */}
          <Box component="span" data-testid="loot-item-name">
            {g.item}
          </Box>
          {posky && <Chip size="small" color="primary" variant="outlined" label="PoSky" />}
          <KnowledgeBadge knowledge={knowledge} isPosky={posky} />
          <DispositionChip disposition={g.disposition} />
        </Stack>
      </TableCell>
      <TableCell align="right" sx={g.invOnly ? { color: 'text.disabled' } : undefined}>
        {g.invOnly ? '-' : g.count}
      </TableCell>
      <TableCell align="right">
        <InventoryEstimate n={g.invOnly ? (g.owned ?? 0) : (inv?.net ?? 0)} />
      </TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>{g.topSource ?? '-'}</TableCell>
      <TableCell align="right" sx={{ color: 'text.secondary' }}>
        {g.zoneCount || '-'}
      </TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>{g.invOnly ? '-' : fmtTime(g.last)}</TableCell>
    </TableRow>
  )
})

export const FlatRow = memo(function FlatRow({
  e,
  favorited,
  knowledge,
  onToggleFavorite,
  onSelect
}: {
  e: LootEvent
  favorited: boolean
  knowledge?: ItemKnowledge
  onToggleFavorite: (name: string) => void
  onSelect: (item: string) => void
}): JSX.Element {
  const posky = isQuestItem(e.item)
  return (
    <TableRow
      hover
      data-testid="loot-row"
      sx={{ cursor: 'pointer', height: ROW_HEIGHT, '& td': { py: 0 } }}
      onClick={() => onSelect(e.item)}
    >
      <TableCell padding="checkbox">
        <FavoriteStar name={e.item} favorited={favorited} onToggle={onToggleFavorite} />
      </TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>{fmtTime(e.ts)}</TableCell>
      <TableCell>
        <Stack direction="row" spacing={1} alignItems="center">
          {/* Plain text, same reason as GroupedRow above (JOS-127). */}
          <Box component="span" data-testid="loot-item-name">
            {e.count && e.count > 1 ? `${e.count} × ${e.item}` : e.item}
          </Box>
          {posky && <Chip size="small" color="primary" variant="outlined" label="PoSky" />}
          <KnowledgeBadge knowledge={knowledge} isPosky={posky} />
          <DispositionChip disposition={e.disposition} />
          {e.disposition === 'combined' && e.created && (
            <Typography variant="caption" color="text.secondary">
              → {e.created}
            </Typography>
          )}
        </Stack>
      </TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>{e.source ?? '-'}</TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>{e.zone ?? '-'}</TableCell>
    </TableRow>
  )
})
