// ItemDetailPane — the Loot tab's item drill-down, as a PANE TAKEOVER rather than a popover
// (owner decision, 2026-08-04).
//
// WHY THE POPOVER WAS RETIRED. The drill-down is not a confirmation or a peek: it is a full
// second surface — the game's item window, the quest knowledge, who drops it, where, and the
// whole looted-over-time histogram. A modal put all of that in a box floating over a table it
// covered anyway, with a scrim, its own scrollbar, and no address. Taking the pane instead gives
// it the width it always wanted and gives the user the ONE thing a modal cannot: a place in the
// app they can see and step back out of.
//
// THE BREADCRUMB IS THAT ADDRESS, and it is the reason this is a takeover rather than a separate
// tab. "Loot › <item>" says where you are, the root is a real control (not decoration beside a
// close button), and the back chevron sits beside it for the reader who reaches for one. A
// takeover with two exits is a takeover nobody gets stuck in.
//
// THE TWO EXITS ARE NO LONGER THE SAME EXIT (JOS-43). They were, until deep links made "back"
// ambiguous: arrive here from the Planner and the loot ledger is not where you came from, it is
// just the list this item happens to live in. So the ARROW is Back — it returns to the origin the
// navigation stack parked (`origin` names it, in the arrow's ACCESSIBLE NAME) — while the
// breadcrumb ROOT keeps meaning what it reads: the Loot list. With no origin (you clicked a row
// in that list) the two coincide again, exactly as before. The arrow used to say it in a tooltip
// as well; that popper is gone with the rest of the Loot surface's (JOS-127), and the aria-label
// the e2e already reads is now the whole of it.
//
// SCROLL POSITION IS THE LIST'S OWN CONCERN (LootView): this pane replaces the list, so the list
// unmounts, and the view saves the scroll offset before the swap and restores it after. That is
// the one contract this pane owes the surface it took over — you must come back to the row you
// clicked, not to the top of an eleven-thousand-row ledger.
//
// THE BODY IS SHARED WITH THE DIALOG (`ItemDetailContent`). The Mobs tab's drop rows still open
// the drill-down as a dialog over a page they must not lose, so the two chromes wrap ONE body.

import type { JSX } from 'react'
import { Box, Breadcrumbs, Chip, IconButton, Link, Stack, Typography } from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import { EQ_ITEM_COLORS } from '../../lib/ItemWindow'
import { ItemDetailContent, type ItemDetailProps } from './ItemDetailDialog'

export interface ItemDetailPaneProps extends ItemDetailProps {
  /** THE Back: wherever the reader actually came from. Origin-aware — see the header and LootView. */
  onBack: () => void
  /** The breadcrumb root. The loot list, with its scroll position, always. */
  onList: () => void
  /** The tab a deep link arrived from ("Planner"), or null/absent when this drill was opened from
   *  the list itself. Names the back ARROW; the breadcrumb never changes what it says. */
  origin?: string | null
}

/** "Loot › <item>". The root is a control; the leaf is the item, in the game's own item colour so
 *  it reads as the same name the row and the item window use. */
function Breadcrumb({
  item,
  isQuestItem,
  onList
}: {
  item: string
  isQuestItem: boolean
  onList: () => void
}): JSX.Element {
  return (
    <Breadcrumbs aria-label="breadcrumb" sx={{ minWidth: 0 }}>
      <Link
        component="button"
        type="button"
        underline="hover"
        color="inherit"
        data-testid="loot-breadcrumb-root"
        onClick={onList}
        sx={{ font: 'inherit', cursor: 'pointer' }}
      >
        Loot
      </Link>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
        <Typography data-testid="loot-detail-title" noWrap sx={{ color: EQ_ITEM_COLORS.name, minWidth: 0 }}>
          {item}
        </Typography>
        {isQuestItem && <Chip size="small" color="primary" variant="outlined" label="Plane of Sky" />}
      </Stack>
    </Breadcrumbs>
  )
}

export function ItemDetailPane(props: ItemDetailPaneProps): JSX.Element {
  const { item, events, stats, isQuestItem, onBack, onList, origin, slice, owned } = props
  // The arrow's ACCESSIBLE NAME, which the e2e reads to prove it knows where it is going.
  const backLabel = origin ? `Back to ${origin}` : 'Back to the loot list'
  return (
    <Stack spacing={1.5} data-testid="loot-detail" sx={{ height: '100%', minHeight: 0 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0, flexShrink: 0 }}>
        <IconButton size="small" data-testid="loot-back" aria-label={backLabel} onClick={onBack}>
          <ArrowBackIcon fontSize="small" />
        </IconButton>
        <Breadcrumb item={item} isQuestItem={isQuestItem} onList={onList} />
      </Stack>
      {/* The pane owns its own scroll for the same reason every panel in this app does: the
          content area must never grow the document (AGENTS.md's fixed-height law). */}
      <Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto', pr: 0.5 }}>
        <ItemDetailContent item={item} events={events} stats={stats} active slice={slice} owned={owned} />
      </Box>
    </Stack>
  )
}
