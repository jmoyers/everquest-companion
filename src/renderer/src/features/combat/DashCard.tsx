// combat/DashCard.tsx — THE app's card chrome, in its own file.
//
// SPLIT OUT OF `combatShared.tsx`, which was sitting exactly on the 400-code-line ceiling. That
// file has done this three times already and says so each time ("The copy affordance moved to its
// own file (see its header — this one hit the line ceiling). Re-exported so every panel header
// keeps the import it already had"), so this follows the pattern rather than inventing one: the
// component moves, `combatShared` re-exports it, and not one of its sixteen callers changes a line.
//
// It was the right thing to move. `DashCard` is imported by the overview cards, four combat panels
// and the whole gear plan; it shares nothing with the meter rows and the copy helpers it used to
// sit beside, and being the app's single card shape (house law 7) it is the piece most likely to
// keep being asked for a new mode.

import type { ReactNode } from 'react'
import { Box, Paper, Stack, Typography } from '@mui/material'

/**
 * Dashboard card chrome: dense uppercase caption on the left, a free-form status slot on
 * the right, body fills the rest. Matches the app's outlined-Paper card style.
 *
 * TWO sizing modes, and a card must pick exactly one — a card NEVER sizes itself to its
 * content, because a content-sized card in a shared box silently steals the whole box from
 * its shrinkable siblings (that is precisely how the combat log once ate the dashboard):
 *  - `fill`   — the card takes 100% of whatever box it was given (a 2x2 grid CELL) and
 *               contributes NO intrinsic height. Its body scrolls internally, so a cramped
 *               cell clips nothing and cannot push the grid past the viewport.
 *  - `height` — FIXED px height, for a body that is an ever-growing append-only ring.
 */
export function DashCard({
  title,
  right,
  children,
  fill,
  height,
  titleLead,
  onTitle,
  titleTestId,
  testId
}: {
  title: string
  right?: ReactNode
  children: ReactNode
  /**
   * Draw the title as the card's LEAD rather than its caption — `body2` at the same weight and
   * tracking, in primary ink.
   *
   * The default is right for a dashboard card, where the title names a panel you already know you
   * are looking at and the numbers are the subject. It is wrong where the title IS the subject: on
   * the gear plan's board, twenty-three cards differ only by which equipment slot they are, so the
   * slot name is the first thing to find and the smallest thing on the card. Opt-in, so no existing
   * card moves.
   */
  titleLead?: boolean
  /**
   * Make the title itself a control.
   *
   * FOR THE CARD WHOSE TITLE NAMES THE THING YOU WOULD CHANGE. On the gear plan's board the title
   * is an equipment slot, and "swap what is in this slot" is the card's primary action — so the
   * word HEAD is the most obvious thing on the card to click, and it was inert.
   *
   * Absent leaves the title exactly as it was: plain text, default cursor, no hit area. A hand
   * appears only where a click actually goes somewhere.
   */
  onTitle?: () => void
  /** the title control's own testid — only meaningful with `onTitle` */
  titleTestId?: string
  /**
   * Grid-cell mode: `height: 100%` + `minHeight: 0` let a `minmax(0, 1fr)` track shrink the
   * card freely, and the body gets its own `overflow: auto` so content scrolls INSIDE the cell
   * instead of growing it.
   */
  fill?: boolean
  /** FIXED card height (`flex: 0 0 <height>px`) — the combat log's ring. */
  height?: number
  /** Marks the card as one of the dashboard's measurable panels (e2e layout assertions). */
  testId?: string
}): React.JSX.Element {
  return (
    <Paper
      variant="outlined"
      data-testid={testId}
      sx={{
        p: 1.25,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        ...(fill
          ? { height: '100%', minHeight: 0, overflow: 'hidden' }
          : height != null
            ? { flex: `0 0 ${height}px`, minHeight: 0, maxHeight: height }
            : { flex: '0 0 auto' })
      }}
    >
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="baseline"
        spacing={1}
        sx={{ mb: 0.75, flexShrink: 0 }}
      >
        <Typography
          component={onTitle === undefined ? 'span' : 'button'}
          type={onTitle === undefined ? undefined : 'button'}
          data-testid={titleTestId}
          onClick={onTitle}
          variant={titleLead === true ? 'body2' : 'caption'}
          noWrap
          sx={{
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: titleLead === true ? 'text.primary' : 'text.secondary',
            ...(onTitle === undefined
              ? {}
              : {
                  p: 0,
                  border: 0,
                  bgcolor: 'transparent',
                  font: 'inherit',
                  cursor: 'pointer',
                  textAlign: 'left',
                  '&:hover': { color: 'primary.main' }
                })
          }}
        >
          {title}
        </Typography>
        {right}
      </Stack>
      <Box
        sx={{
          minWidth: 0,
          minHeight: 0,
          flexGrow: 1,
          display: 'flex',
          flexDirection: 'column',
          ...(fill ? { overflow: 'auto' } : null)
        }}
      >
        {children}
      </Box>
    </Paper>
  )
}
