// lib/ItemIcon.tsx — an item's icon in a fixed frame, so a column of them lines up.
//
// WHY IT IS A FRAME AND NOT AN `<img>`. Every surface that draws item icons draws them in a LIST,
// and the corpus does not have an icon for every row — a bare `<img>` that fails to load collapses
// to zero width and takes its whole row's alignment with it. The frame is always the same size, so
// an item with no icon is a quiet empty square rather than a shunted line.
//
// AND THE ERROR HANDLER IS THE SECOND HALF OF THAT. `eqimg://item/<id>` serves from the bundled
// art with a cache fallback (main/bundledImages.ts), and a miss is a real possibility rather than a
// defect — the handler hides the broken-image glyph and leaves the frame, which is the same
// treatment `SlotGrid` and both planner pickers already apply inline.
//
// A `lib/` PRIMITIVE RATHER THAN A FEATURE COMPONENT, because three features want it. It is NOT in
// `lib/ItemWindow.tsx` next to `itemIconUrl` for one measured reason: that file is at 385 code
// lines against the repo's 400 ceiling, and this repo splits rather than ratchets.
//
// KNOWN DUPLICATION, STATED RATHER THAN QUIETLY LEFT: `features/character/SlotGrid.tsx` has a
// private `SlotIcon` that is this component with a `SheetCellView` parameter. Folding it into this
// one is a behaviour-preserving follow-up and deliberately NOT done here — it is a change to a
// shipped surface that this feature does not need, and house law 7's answer to "nearly the same"
// is one component, which this file is now the home for.

import type { JSX } from 'react'
import { Box } from '@mui/material'
import { EQ_ITEM_COLORS, itemIconUrl } from './ItemWindow'

export interface ItemIconProps {
  /** the corpus's `iconId`; absent draws the empty frame, which is the point */
  iconId?: number
  /** frame edge in px — 28 is the Character tab's armoury cell, 20 a dense row */
  size?: number
  /**
   * Draw the item's own gold edge rather than the neutral divider. The Character tab uses this to
   * say "there is something here" at a glance across a 24-cell grid.
   */
  filled?: boolean
}

export default function ItemIcon({ iconId, size = 28, filled }: ItemIconProps): JSX.Element {
  return (
    <Box
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: 0.5,
        border: '1px solid',
        borderColor: filled === true ? EQ_ITEM_COLORS.border : 'divider',
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
          sx={{ width: size - 4, height: size - 4, imageRendering: 'pixelated' }}
        />
      )}
    </Box>
  )
}
