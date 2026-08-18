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
import type { CellDelta } from '@shared/planner/gearPlanTotals'
import { gearPlanCells, type GearPlan } from '@shared/planner/gearPlan'
import type { PlanSlotId } from '@shared/planner/types'
import GearPlanCellCard, { type GearPlanCellHandlers } from './GearPlanCellCard'
import type { WeaponRead } from './gearPlanFold'

export interface GearPlanBoardProps {
  gearPlan: GearPlan
  /**
   * A cell's planned item as a stat block at its own plus-state, or `undefined` when the corpus has
   * no row for it. Resolved once per render by the view, which is the only thing holding the gear
   * index — a card that looked its own item up would hold the corpus twenty-three times.
   */
  blockOf: (cell: PlanSlotId) => ItemStatBlock | undefined
  /** what planning this cell would CHANGE against the worn item — see `GearPlanFold.deltaOf` */
  deltaOf: (cell: PlanSlotId) => CellDelta[] | null
  /** the corpus's icon for a cell's planned item, resolved by the view for the same reason */
  iconOf: (cell: PlanSlotId) => number | undefined
  /** a weapon's ratio and what it would replace; `null` for every cell that is not a weapon */
  weaponOf: (cell: PlanSlotId) => WeaponRead | null
  /**
   * The controls, threaded straight through. The board holds no popover state of its own for the
   * reason the cards do not: one open popover is a property of the SURFACE, not of a cell.
   */
  on: GearPlanCellHandlers
}

export default function GearPlanBoard({
  gearPlan,
  blockOf,
  deltaOf,
  iconOf,
  weaponOf,
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
        // ROWS SIZE TO THEIR CONTENT, and the `1fr` that used to be here is why they did not.
        //
        // `minmax(152px, 1fr)` reads like a floor and behaves like a LEVELLER: `1fr` shares the
        // container's height out equally, so every row in the board took the height of the tallest
        // row anywhere in it. One weapon cell carrying a ratio line and a wrapped delta set the
        // height of all eight rows, and the other twenty-two cells drew a third of a card of empty
        // space underneath their sockets. That is the blank space; it was never padding.
        //
        // `auto` sizes each row to its own tallest card. Cards WITHIN a row still match each other,
        // which is alignment rather than waste - a ragged bottom edge across a row of four cards
        // reads as broken, where a ragged edge between ROWS is just cells that hold less.
        //
        // NO FLOOR AT ALL, because there is no longer anything to protect. The floor existed so a
        // `1fr` track could not collapse a card below its content; an `auto` track is its content.
        // An empty cell is a title and one link and should be exactly that tall.
        gridAutoRows: 'auto',
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
          delta={deltaOf(cell)}
          iconId={iconOf(cell)}
          weapon={weaponOf(cell)}
          on={on}
        />
      ))}
    </Box>
  )
}
