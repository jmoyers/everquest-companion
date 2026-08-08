// posky/QuestItemsTable.tsx — the expanded quest panel's item listing, and the item-name LINK
// both halves of the accordion draw.
//
// Split out of `QuestAccordion.tsx` when the item deep link pushed that file past the measured
// 400-code-line ceiling (2026-08-04). The seam is real rather than arbitrary: everything here is
// the "what do I still need, who drops it, where" table, while what stays behind is the collapsed
// summary row and the accordion chrome around it. No behaviour changed in the move.
//
// THE ITEM NAME IS A LINK (owner, 2026-08-04): "clicking on a sky item while you are hovering
// should take you to the item drill-down page." The hover card is unchanged — still `ItemTooltip`,
// the compact game-window popover — and the click is the app's standing link idiom (`openLoot`,
// appRouting.ts), the same one the Planner's donor names use. `ItemNameLink` is exported because
// the summary row's REWARD caption is the accordion's other clickless item name and gets the same
// affordance; the required-item chips beside it do NOT, because their click already toggles the
// favorite star and swapping that would trade a feature for a link.

import type { JSX, MouseEvent } from 'react'
import { Box, Table, TableBody, TableCell, TableHead, TableRow } from '@mui/material'
import type { QuestProgress } from './useProgress'
import { ItemTooltip } from './ItemTooltip'
import { DropperCell } from './DropperCell'
import type { MobTarget } from '../mobs/mobTarget'
import { FavoriteStar } from '../favorites/FavoriteStar'

/**
 * An item NAME that opens that item's Loot drill-down. The cursor follows the handler exactly —
 * a hand only where a click actually goes somewhere — so a tree rendered without the router keeps
 * the plain hover surface it has always had.
 *
 * It sets no colour: the table cell already tints a completed item green and the reward caption is
 * already primary, so borrowing the item-window green here would erase the state those colours
 * carry. The dotted underline is the whole affordance.
 */
export function ItemNameLink({
  name,
  label,
  onOpenLoot,
  inSummary
}: {
  name: string
  /** display text when it differs from the item name */
  label?: string
  onOpenLoot?: (item: string) => void
  /** inside the AccordionSummary, where a bare click would also expand/collapse the quest */
  inSummary?: boolean
}): JSX.Element {
  const linked = onOpenLoot !== undefined
  const click = (e: MouseEvent): void => {
    if (inSummary === true) e.stopPropagation()
    onOpenLoot?.(name)
  }
  return (
    <Box
      component="span"
      data-testid="posky-item-link"
      onClick={linked ? click : undefined}
      sx={
        linked
          ? {
              cursor: 'pointer',
              textDecoration: 'underline dotted',
              textUnderlineOffset: 2,
              '&:hover': { textDecoration: 'underline' }
            }
          : undefined
      }
    >
      {label ?? name}
    </Box>
  )
}

/** The expanded panel's item table — the full "what, how many, who drops it, where" listing. */
export function QuestItemsTable({
  q,
  isFavorite,
  toggleFavorite,
  onOpenMob,
  onOpenLoot
}: {
  q: QuestProgress
  isFavorite: (name: string) => boolean
  toggleFavorite: (name: string) => void
  onOpenMob: (t: MobTarget) => void
  onOpenLoot?: (item: string) => void
}): JSX.Element {
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell padding="checkbox" />
          <TableCell>Item</TableCell>
          <TableCell>Have</TableCell>
          <TableCell>Dropped by</TableCell>
          <TableCell>Where</TableCell>
        </TableRow>
      </TableHead>
      <TableBody sx={{ '& > tr:last-child > *': { borderBottom: 0 } }}>
        {q.items.map((it) => {
          const done = it.have >= it.need
          return (
            <TableRow key={it.name}>
              <TableCell padding="checkbox">
                <FavoriteStar name={it.name} favorited={isFavorite(it.name)} onToggle={toggleFavorite} />
              </TableCell>
              <TableCell sx={{ color: done ? 'success.main' : 'text.primary' }}>
                <ItemTooltip name={it.name} stats={it.stats} who={it.who} where={it.where} droppers={it.droppers}>
                  <ItemNameLink name={it.name} onOpenLoot={onOpenLoot} />
                </ItemTooltip>
              </TableCell>
              <TableCell>
                {it.have}/{it.need}
              </TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>
                <DropperCell droppers={it.droppers} who={it.who} where={it.where} onOpenMob={onOpenMob} />
              </TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>{it.where}</TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
