// MapMobPaneRow.tsx — the pieces of ONE sidebar row that are not the row itself: its caption
// (the facts note and the wish-list clause) and the page door wrapped around it.
//
// Split out of MapMobPane.tsx when that file reached the repo's 400-code-line factoring ceiling —
// the LootChrome precedent (JOS-160): nothing here changed in the move except where it lives.
// The seam is the one the file already had: MapMobPane owns the sections, the rows and the
// header; this file owns what a row SAYS under its name and how it opens a page. `rowCaption`
// returns a node rather than a string because the wished drop names inside it are links.

import type { JSX, ReactNode } from 'react'
import { Box, IconButton, ListItem } from '@mui/material'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import type { MapPaneRow } from './mobPins'
// The app's one item-name link span (dotted underline, hand only when routed) — the same node the
// gear table, the wish list and the plan draw, so a wished drop here reads and routes like theirs.
import { DonorName } from '../planner/PlannerChips'
import { Tooltip } from '../../lib/Tooltip'

/**
 * The one-line "and what else does this row know" text. Null when it knows nothing extra.
 *
 * The two "no pin" reasons are DIFFERENT FACTS and are said differently: a page that stated
 * nothing, and a page that stated a position but named several zones so it cannot be attributed
 * to this map. Collapsing them into one message would misreport the second as missing data.
 * The wish-list clause joins it on the same caption, but is built in `rowCaption` — its item
 * names are links, so it is a node, not a string.
 */
function rowNote(row: MapPaneRow): string | null {
  if (row.kind !== 'mob') return null
  if (row.unattributable) return `position stated, but the page lists ${String(row.zoneCount)} zones`
  if (row.pins.length === 0) return 'no location on the wiki page'
  if (row.pins.length > 1) return `${String(row.pins.length)} spawn points`
  return null
}

/**
 * The wish-list clause of a row's caption: "drops X, Y (wish list)" with each name a Loot link.
 *
 * `stopPropagation` (only when routed) so the click opens the item, not the row's pin — and
 * `pointerEvents:'auto'` because an unlocatable mob's row button is DISABLED, which turns pointer
 * events off for the whole subtree: the mob has no spot on this map, but its drop still has a page.
 */
function WishDrops({ names, onOpenLoot }: { names: readonly string[]; onOpenLoot?: ((name: string) => void) | undefined }): JSX.Element {
  return (
    <Box
      component="span"
      onClick={onOpenLoot == null ? undefined : (e) => { e.stopPropagation() }}
      sx={onOpenLoot == null ? undefined : { pointerEvents: 'auto' }}
    >
      {'drops '}
      {names.map((n, i) => (
        <Box component="span" key={n}>
          {i > 0 && ', '}
          <DonorName name={n} onOpen={onOpenLoot} />
        </Box>
      ))}
      {' (wish list)'}
    </Box>
  )
}

/** The caption under a row's name: the facts note, the wish clause, both, or nothing. */
export function rowCaption(
  row: MapPaneRow,
  wished: readonly string[] | undefined,
  onOpenLoot: ((name: string) => void) | undefined
): ReactNode {
  const note = rowNote(row)
  const hasWish = wished != null && wished.length > 0
  if (note == null && !hasWish) return null
  return (
    <>
      {note}
      {note != null && hasWish && ' - '}
      {hasWish && <WishDrops names={wished} onOpenLoot={onOpenLoot} />}
    </>
  )
}

/** Wraps a row's button with the mob-page door — OUTSIDE the button, so a row whose jump or pin
 *  is disabled (no map, no stated spot) still offers the page, which is live regardless. */
export function WithPageDoor({ onOpen, children }: { onOpen: () => void; children: ReactNode }): JSX.Element {
  return (
    <ListItem disablePadding secondaryAction={
      <Tooltip title="Open this mob's page">
        <IconButton size="small" edge="end" data-testid="maps-pane-open-mob" onClick={onOpen}>
          <OpenInNewIcon sx={{ fontSize: 15 }} />
        </IconButton>
      </Tooltip>
    }>
      {children}
    </ListItem>
  )
}
