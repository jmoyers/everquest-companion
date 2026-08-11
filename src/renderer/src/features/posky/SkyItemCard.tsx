// SkyItemCard — the ONE way a Plane of Sky surface mounts an item hover card (JOS-181).
//
// WHY A WRAPPER AND NOT A `clickThrough` FLAG SPELLED AT EACH SITE. This tab is the surface
// the click-eating defect was reported on, twice removed and now restored by owner ruling: the
// quest rows sit directly under QuestFilterBar's five dropdowns, so a card that can open upward and
// hold pointer events is exactly the bug (JOS-143, and JOS-127 before it on the Loot ledger). A
// boolean spelled at every call site is a boolean somebody forgets on the next one. Spelled ONCE
// here, "the Sky tab's cards are click-through" is a property of the file rather than of a habit —
// and tests/tooltipCursor.test.mts derives that from the tree: the tab's files may mount this
// component and nothing else, and this component always passes `clickThrough`.
//
// WHAT THE CARD SAYS THAT THE TITLE DID NOT. JOS-173's `title={itemDropTitle(it)}` answered "where,
// and who drops it" and could answer nothing else — a native title is one string. The card is the
// item WINDOW (name, flags, stats, effects, in the game's own colours) with that same roster under
// it, plus what the item DB knows about the item's other uses. The roster is the same derivation,
// returning its two parts instead of joining them (`itemDropFacts`, poskyDroppers.ts).
//
// The native title goes when the card arrives: two hover surfaces on one anchor is an OS tooltip
// racing a popper over the same words, and the OS one wins the second hover.

import type { JSX, ReactElement } from 'react'
import { Box, Typography } from '@mui/material'
import { EQ_ITEM_COLORS } from '../../lib/ItemWindow'
import { KnownItemTooltip } from '../../lib/KnownItemTooltip'
import { itemDropFacts, type ItemDropRow } from './poskyDroppers'

/** One line of the block, in the item window's own label colour. */
function Line({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <Typography component="div" sx={{ color: EQ_ITEM_COLORS.label, fontSize: 11, lineHeight: 1.4 }}>
      {children}
    </Typography>
  )
}

/**
 * "Island 5 / Dropped by: / The Spiroc Lord · level 63 · Plane of Sky" — the Sky tab's own
 * knowledge, under a hairline so it reads as ours rather than as part of the game's item window.
 * Nothing known at all ⇒ nothing drawn, which is why the whole block can be null (law 1).
 */
function SkyDropsBlock({ row }: { row: ItemDropRow }): JSX.Element | null {
  const facts = itemDropFacts(row)
  if (facts.where === '' && facts.droppers.length === 0) return null
  return (
    <Box
      // The handle tests/e2e/sky-dropdowns.e2e.mts reads: that spec's second subject is that the
      // dropper roster is still REACHABLE on hover, and it now lives in a rendered node again.
      data-testid="posky-card-drops"
      sx={{ mt: 0.75, pt: 0.6, borderTop: '1px solid rgba(255,255,255,0.12)' }}
    >
      {facts.where !== '' && <Line>{facts.where}</Line>}
      {facts.droppers.length > 0 && (
        <>
          <Line>Dropped by:</Line>
          {facts.droppers.map((d) => (
            <Line key={d}>{d}</Line>
          ))}
        </>
      )}
    </Box>
  )
}

export interface SkyItemCardProps {
  /** item name exactly as displayed */
  name: string
  /** the quest row this name came from, when there is one — a REWARD name has none */
  row?: ItemDropRow
  /** the posky scrape's raw stat text, used only when the item DB has none */
  stats?: string
  /** the anchor: any single element that can hold a ref */
  children: ReactElement
}

/** Hover a Sky item name → the item window, this tab's drop roster, and what else it is for. */
export function SkyItemCard({ name, row, stats, children }: SkyItemCardProps): JSX.Element {
  return (
    <KnownItemTooltip
      name={name}
      stats={stats}
      extra={row ? <SkyDropsBlock row={row} /> : undefined}
      // Never optional on this tab. See the header.
      clickThrough
    >
      {children}
    </KnownItemTooltip>
  )
}
