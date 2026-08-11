// posky/QuestItemsTable.tsx — the expanded quest panel's item listing, and the item-name LINK
// both halves of the accordion draw.
//
// Split out of `QuestAccordion.tsx` when the item deep link pushed that file past the measured
// 400-code-line ceiling (2026-08-04). The seam is real rather than arbitrary: everything here is
// the "what do I still need, who drops it, where" table, while what stays behind is the collapsed
// summary row and the accordion chrome around it. No behaviour changed in the move.
//
// THE ITEM NAME IS A LINK (owner, 2026-08-04): "clicking on a sky item while you are hovering
// should take you to the item drill-down page." The click is the app's standing link idiom
// (`openLoot`, appRouting.ts), the same one the Planner's donor names use. `ItemNameLink` is
// exported because the summary row's REWARD caption is the accordion's other clickless item name
// and gets the same affordance; the required-item chips beside it do NOT, because their click
// already toggles the favorite star and swapping that would trade a feature for a link.
//
// AND THE HOVER CARD IS BACK (JOS-181), after JOS-143 removed it. The name used to anchor
// `ItemTooltip`, a `placement="top"`, INTERACTIVE card that opened UPWARD — out of this table,
// through the accordion summary, and onto the tab's dropdown toolbar, where it ate the clicks aimed
// at them (the owner's report; JOS-127 is the same defect on the Loot ledger). Removal was the
// answer then; the owner's v0.18.0 ruling is that the card is worth more than the removal, and the
// defect is now fixed IN THE POPPER instead: every card on this tab goes through `SkyItemCard`,
// which opens downward, cannot flip up onto the toolbar, holds no pointer events, and closes the
// moment a pointer goes down. HOVER EXPLAINS, CLICK INVESTIGATES — the click still opens the Loot
// drill-down, which is the deep dive the card is a preview of.

import type { JSX, MouseEvent } from 'react'
import { Box, Table, TableBody, TableCell, TableHead, TableRow } from '@mui/material'
import type { QuestProgress } from './useProgress'
import { DropperCell } from './DropperCell'
import { SkyItemCard } from './SkyItemCard'
import type { ItemDropRow } from './poskyDroppers'
import type { MobTarget } from '../mobs/mobTarget'
import { FavoriteStar } from '../favorites/FavoriteStar'

/**
 * An item NAME that opens that item's Loot drill-down, and hovers into the item card. The cursor
 * follows the CLICK handler exactly — a hand only where a click actually goes somewhere — so a tree
 * rendered without the router keeps the plain hover surface it has always had.
 *
 * It sets no colour: the table cell already tints a completed item green and the reward caption is
 * already primary, so borrowing the item-window green here would erase the state those colours
 * carry. The dotted underline is the whole affordance.
 *
 * The card is mounted HERE rather than around this component at the two call sites, because a MUI
 * Tooltip hands its anchor a ref and a plain function component cannot hold one — the anchor has to
 * be the Box itself. Both call sites get the card for free, which is also what makes the reward
 * caption in the summary row hoverable without a second wrapper.
 */
export function ItemNameLink({
  name,
  label,
  onOpenLoot,
  inSummary,
  row,
  stats
}: {
  name: string
  /** display text when it differs from the item name */
  label?: string
  onOpenLoot?: (item: string) => void
  /** inside the AccordionSummary, where a bare click would also expand/collapse the quest */
  inSummary?: boolean
  /** the quest row behind this name, for the card's drop roster. A REWARD name has none. */
  row?: ItemDropRow
  /** the posky scrape's stat text for this name, when the caller holds one */
  stats?: string
}): JSX.Element {
  const linked = onOpenLoot !== undefined
  const click = (e: MouseEvent): void => {
    if (inSummary === true) e.stopPropagation()
    onOpenLoot?.(name)
  }
  return (
    <SkyItemCard name={name} row={row} stats={stats}>
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
    </SkyItemCard>
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
                {/* The row itself feeds the card's Drops block — built from THIS row rather than
                    looked up by name, because the same item appears on several quests with its own
                    stated `where` and the one the player hovered is the one that must be right. */}
                <ItemNameLink name={it.name} onOpenLoot={onOpenLoot} row={it} stats={it.stats} />
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
