// gear plan/GearPlanBoard.tsx — the twenty-three cells, in board order.
//
// `PlanBoard.tsx`'s shape (JOS-326), over the gear plan document. It draws EVERY cell, filled or
// not, and that is the ruling that file argued and this one keeps: "a board that only drew the
// slots you had already planned would answer 'what have you done' when the question is 'what is
// left'."
//
// AUTO-FILL RATHER THAN A FIXED COLUMN COUNT, so the board uses whatever width the window has left
// after the totals panel takes its 380. `PlanBoard` learned the same thing and then had to split
// its cell into its own file when auto-fill pushed it past the code-line ceiling — which is why
// `GearPlanCellCard.tsx` is a separate file from the first commit rather than after the first
// overrun.
//
// THE BOARD IS ITS OWN SCROLLER and the caller sets that (`GearPlanView`): a component that scrolled
// itself would clamp nothing, because the app's content area is already `overflow:auto`.

import type { JSX } from 'react'
import { Box } from '@mui/material'
import type { ItemStatBlock } from '@shared/itemStats'
import { gearPlanCells, type GearPlan } from '@shared/planner/gearPlan'
import type { PlanSlotId } from '@shared/planner/types'
import GearPlanCellCard, { type GearPlanCellHandlers } from './GearPlanCellCard'

export interface GearPlanBoardProps {
  gearPlan: GearPlan
  /**
   * A cell's planned item as a stat block at its own plus-state, or `undefined` when the corpus has
   * no row for it. Resolved once per render by the view, which is the only thing holding the gear
   * index — a card that looked its own item up would hold the corpus twenty-three times.
   */
  blockOf: (cell: PlanSlotId) => ItemStatBlock | undefined
  /** the corpus's icon for a cell's planned item, resolved by the view for the same reason */
  iconOf: (cell: PlanSlotId) => number | undefined
  /**
   * The controls, threaded straight through. The board holds no popover state of its own for the
   * reason the cards do not: one open popover is a property of the SURFACE, not of a cell.
   */
  on: GearPlanCellHandlers
}

export default function GearPlanBoard({
  gearPlan,
  blockOf,
  iconOf,
  on
}: GearPlanBoardProps): JSX.Element {
  return (
    <Box
      data-testid="gearplan-board"
      sx={{
        display: 'grid',
        // `minmax(0, 1fr)` on both axes, which the design library states as a rule rather than a
        // habit: "a track that can shrink below its content is what stops any one card dictating
        // the page's size". The 260px is the COLUMN floor; `gridAutoRows` carries the row floor.
        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
        // A MEASURED floor, and a floor rather than a cap. A filled cell is a title row, an item
        // name, its stat line and four socket lines; 152px is a hair over that, so an ordinary
        // cell never scrolls and an exceptional one (a long stat line, wrapped) pushes its row
        // taller and its row-mates follow — which is exactly what the library says a row floor is
        // for. The cards are `fill`, so they take the track rather than setting it.
        gridAutoRows: 'minmax(152px, 1fr)',
        // 1.5 = 12px: the library's gap WITHIN a region of cards. (16px is the gap BETWEEN
        // regions, and the view spends it between this board and the totals panel.)
        gap: 1.5,
        alignContent: 'start'
      }}
    >
      {gearPlanCells(gearPlan).map(({ cell, planned }) => (
        <GearPlanCellCard
          key={cell}
          cell={cell}
          planned={planned}
          block={blockOf(cell)}
          iconId={iconOf(cell)}
          on={on}
        />
      ))}
    </Box>
  )
}
