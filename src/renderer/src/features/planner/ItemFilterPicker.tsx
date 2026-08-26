// planner/ItemFilterPicker.tsx — "I am holding THIS item; what can go in it?" (JOS-210, feature half).
//
// The browser could already be narrowed to an item, but only to one your SET already plans a host
// for: you reached it by clicking a socket on the Inventory tab. The owner asked for the other
// direction — type ANY item the committed DB carries and browse the proc/worn/focus/click effects
// compatible with it — so this is the filter bar's own door to the same `ItemFocus`.
//
// A POPOVER, NOT A FIELD. The bar is ONE NOWRAP ROW (the flexWrap law) and already carries the
// socket tabs, the effect search, two selects and three chips; a second text input would push the
// list it filters off the bottom of the pane. The chip that opens this is the same chip that then
// shows what is selected, so the row never grows by more than one control.
//
// ONLY ITEMS THAT STATE A SLOT ARE OFFERED, and that is R2 rather than tidiness: an exaltation may
// only move into an item that SHARES the donor's equipment slot, so an item whose page states none
// shares a slot with nothing and no effect can ever be socketed into it. Filtering them out here is
// what lets `itemFits` treat an empty slot list as UNKNOWN everywhere else (law 1) — the only way
// one reaches the filter is a preset host the index does not carry. A query that matches nothing
// BUT those says so, naming the reason, rather than reporting an empty search.
//
// The list is a FIXED-height scroll box for the standing reason (AGENTS.md): a popover that grows
// with its hit count would walk off the screen.

import { type JSX, useDeferredValue, useState } from 'react'
import { Box, Chip, CircularProgress, Popover, Stack, TextField, Typography } from '@mui/material'
import type { PlannerItemHit } from '@shared/planner/types'
import { itemIconUrl } from '../../lib/ItemWindow'
import { MIN_QUERY, useItemSearch } from './plannerPreset'

const LIST_MAX_H = 260

/** An item you can actually socket into: R2's slot half, asked of the HOST. */
function wearable(hit: PlannerItemHit): boolean {
  return hit.slots.length > 0
}

function HitRow({ hit, onPick }: { hit: PlannerItemHit; onPick: (h: PlannerItemHit) => void }): JSX.Element {
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      data-testid="planner-item-hit"
      onClick={() => onPick(hit)}
      sx={{ px: 1, py: 0.5, cursor: 'pointer', flexWrap: 'nowrap', '&:hover': { bgcolor: 'action.hover' } }}
    >
      {hit.iconId !== undefined && (
        <Box
          component="img"
          src={itemIconUrl(hit.iconId)}
          alt=""
          onError={(e: React.SyntheticEvent<HTMLImageElement>) => {
            e.currentTarget.style.display = 'none'
          }}
          sx={{ width: 20, height: 20, imageRendering: 'pixelated', flexShrink: 0 }}
        />
      )}
      <Typography variant="body2" noWrap sx={{ minWidth: 0, flexShrink: 1 }}>
        {hit.name}
      </Typography>
      <Box sx={{ flexGrow: 1, minWidth: 4 }} />
      <Chip
        size="small"
        variant="outlined"
        label={hit.slots.join(' ')}
        sx={{ height: 18, fontSize: 10, flexShrink: 0, maxWidth: 120 }}
      />
    </Stack>
  )
}

/** Why the list is empty, in the words of whichever of the three reasons applies. */
function emptyLine(text: string, loading: boolean, slotless: number): string {
  if (text.trim().length < MIN_QUERY) return 'Type at least two letters.'
  if (loading) return 'Searching…'
  if (slotless > 0) {
    return `${String(slotless)} match, but their pages state no equipment slot - nothing can be socketed into those.`
  }
  return 'No item in the database matches that.'
}

export interface ItemFilterPickerProps {
  anchor: HTMLElement | null
  onClose: () => void
  onPick: (hit: PlannerItemHit) => void
}

export default function ItemFilterPicker({ anchor, onClose, onPick }: ItemFilterPickerProps): JSX.Element {
  const [text, setText] = useState('')
  const query = useDeferredValue(text)
  const open = anchor !== null
  const { hits, loading } = useItemSearch(query, open)
  // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 8: PlannerItemHit comes from a corpus still bundled in the renderer (mobs/posky/bosses JSON). Moves behind knowledge queries when that surface cuts over.
  const usable = hits.filter(wearable)

  return (
    <Popover
      open={open}
      anchorEl={anchor}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      slotProps={{ paper: { sx: { width: 340 } } }}
    >
      <Box sx={{ p: 1 }}>
        <TextField
          autoFocus
          fullWidth
          size="small"
          label="Item to fill"
          value={text}
          data-testid="planner-item-search"
          onChange={(e) => setText(e.target.value)}
        />
      </Box>
      <Box sx={{ maxHeight: LIST_MAX_H, overflow: 'auto', borderTop: 1, borderColor: 'divider' }}>
        {usable.map((hit) => (
          <HitRow key={hit.key} hit={hit} onPick={onPick} />
        ))}
        {usable.length === 0 && (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1.5 }}>
            {loading && <CircularProgress size={14} />}
            <Typography variant="caption" color="text.secondary" data-testid="planner-item-empty">
              {emptyLine(text, loading, hits.length)}
            </Typography>
          </Stack>
        )}
      </Box>
    </Popover>
  )
}
