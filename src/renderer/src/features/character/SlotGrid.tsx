// character/SlotGrid — the armory grid: two flanking columns and the bottom row.
//
// The column split is the game's own inventory window (shared/characterSheet.ts SHEET_SLOTS),
// which is also the armory shape: eight down the left, eight down the right, hands/rings/ammo
// along the bottom. On a narrow window the three groups stack instead of squeezing.
//
// EVERY CELL IS ALWAYS DRAWN, filled or not. An empty slot is the point of a character sheet —
// it is the thing you have not equipped — so it renders quiet (the slot's name, dimmed) rather
// than being omitted, and it is never an error or a warning.
//
// The item name is the hover surface, through `KnownItemTooltip` — the SAME card every other
// item name in the app opens, which fetches its knowledge only while the tooltip is open. The
// icon is `eqimg://item/<id>` off the permanent cache and hides itself if the fetch 404s.
//
// ---------------------------------------------------------------------------
// AND SINCE JOS-327 A CELL SHOWS WHAT IS SOCKETED INTO IT
// ---------------------------------------------------------------------------
// An exaltation is the whole point of the Exaltations tab, and until now the one place the game
// states which ones a player has ALREADY SOCKETED — the inventory dump — was parsed for them
// (`SheetItem.exaltations`) and then not drawn. Each worn item's exaltations render as small chips
// under its name: no hover, no click, no count line. They are a fact about the item, so they sit on
// the item.
//
// THE CHIPS ARE CONFIDENT HERE, AND THAT IS A PROPERTY OF *WORN* SLOTS. The dump spells bag
// CONTENTS and exaltation SOCKETS the same way — both are `-Slot<n>` children, and `Slots` is
// merely how many child slots the parent provides (shared/outputs/inventory.ts, "what the file does
// NOT say"). The one thing the file volunteers is the child's NAME: `<Item> (Exaltation)`. That
// suffix is what `exaltationsOf` reads, so a chip here is the client's own word and not an
// inference — and the ambiguity that would matter, a ten-slot BAG being read as a ten-socket item,
// cannot arise in a cell of this grid, because a top-level `Location` equipment row is a thing worn
// on the body and nobody wears a backpack in an ear. The general case is left to
// `looksLikeContainer()`, which is an opt-in guess with its evidence attached; this surface never
// needs it. None of that reaches the screen: there is no "probably" chip and no footnote.

import type { JSX } from 'react'
import { Box, Chip, Paper, Stack, Typography } from '@mui/material'
import type { SheetCellView, SheetColumn } from '@shared/characterSheet'
import { EQ_ITEM_COLORS, itemIconUrl } from '../../lib/ItemWindow'
import { KnownItemTooltip } from '../../lib/KnownItemTooltip'

const ICON = 28

/** The item's icon, or a same-sized empty frame so every cell lines up. */
function SlotIcon({ cell }: { cell: SheetCellView }): JSX.Element {
  const iconId = cell.item?.iconId
  return (
    <Box
      sx={{
        width: ICON,
        height: ICON,
        flexShrink: 0,
        borderRadius: 0.5,
        border: '1px solid',
        borderColor: cell.item ? EQ_ITEM_COLORS.border : 'divider',
        bgcolor: 'rgba(255,255,255,0.03)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      {iconId !== undefined && (
        <Box
          component="img"
          src={itemIconUrl(iconId)}
          alt=""
          onError={(e: React.SyntheticEvent<HTMLImageElement>) => {
            e.currentTarget.style.display = 'none'
          }}
          sx={{ width: ICON - 4, height: ICON - 4, imageRendering: 'pixelated' }}
        />
      )}
    </Box>
  )
}

/**
 * What is socketed into this cell's item, as the client named it — nothing at all when the item
 * carries none, which is most of them.
 *
 * The names are printed with the ` (Exaltation)` suffix ALREADY REMOVED: `SheetItem.exaltations`
 * holds `parsedName.base`, so the chip reads `Golden Efreeti Boots` rather than repeating a word
 * that the row of chips is already saying by existing. The chips wrap; a cell with four of them is
 * two lines tall, which is fine here because this grid is not windowed and no hook is assuming a
 * row height.
 */
function ExaltationChips({ names }: { names: readonly string[] }): JSX.Element | null {
  if (names.length === 0) return null
  return (
    <Box
      data-testid="character-exaltations"
      sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.3, mt: 0.3 }}
    >
      {names.map((name, i) => (
        <Chip
          // The same exaltation can legitimately be socketed twice into one item, so the name is
          // not a key — the position is.
          key={`${name}#${String(i)}`}
          label={name}
          size="small"
          variant="outlined"
          data-testid="character-exaltation"
          sx={{
            height: 16,
            maxWidth: '100%',
            borderColor: EQ_ITEM_COLORS.border,
            '& .MuiChip-label': { px: 0.5, fontSize: 10, lineHeight: 1.6 }
          }}
        />
      ))}
    </Box>
  )
}

/** One cell: icon, slot label, the item name (hoverable) with its exaltations, or a quiet empty line. */
function SlotCell({ cell }: { cell: SheetCellView }): JSX.Element {
  const item = cell.item
  return (
    <Paper
      variant="outlined"
      data-testid={`character-slot-${cell.id}`}
      sx={{ p: 0.6, display: 'flex', gap: 0.75, alignItems: 'center', minWidth: 0 }}
    >
      <SlotIcon cell={cell} />
      <Box sx={{ minWidth: 0, flexGrow: 1 }}>
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block', lineHeight: 1.2 }}>
          {cell.label}
        </Typography>
        {item ? (
          <>
            <KnownItemTooltip name={item.name}>
              <Box
                component="span"
                sx={{
                  display: 'block',
                  color: EQ_ITEM_COLORS.name,
                  fontSize: 12,
                  lineHeight: 1.3,
                  textDecoration: 'underline dotted',
                  textUnderlineOffset: 2,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {item.name}
              </Box>
            </KnownItemTooltip>
            <ExaltationChips names={item.exaltations} />
          </>
        ) : (
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', opacity: 0.6 }}>
            empty
          </Typography>
        )}
      </Box>
    </Paper>
  )
}

function Column({ cells }: { cells: SheetCellView[] }): JSX.Element {
  return (
    <Stack spacing={0.6} sx={{ flex: 1, minWidth: 190 }}>
      {cells.map((c) => (
        <SlotCell key={c.id} cell={c} />
      ))}
    </Stack>
  )
}

const inColumn = (cells: SheetCellView[], column: SheetColumn): SheetCellView[] =>
  // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives SheetCellView. Becomes a view descriptor when the source lands.
  cells.filter((c) => c.column === column)

export default function SlotGrid({ cells }: { cells: SheetCellView[] }): JSX.Element {
  const bottom = inColumn(cells, 'bottom')
  return (
    <Stack spacing={0.6} data-testid="character-slot-grid">
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={0.6} alignItems="stretch">
        <Column cells={inColumn(cells, 'left')} />
        <Column cells={inColumn(cells, 'right')} />
      </Stack>
      {/* The bottom row wraps rather than shrinking — a weapon name is world-supplied text. */}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.6 }}>
        {bottom.map((c) => (
          <Box key={c.id} sx={{ flex: '1 1 190px', minWidth: 190 }}>
            <SlotCell cell={c} />
          </Box>
        ))}
      </Box>
    </Stack>
  )
}
