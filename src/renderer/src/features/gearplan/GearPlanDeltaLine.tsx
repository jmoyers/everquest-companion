// gearplan/GearPlanDeltaLine.tsx — what a change GIVES, then what it COSTS.
//
// ONE COMPONENT, TWO SURFACES (house law 7). The candidate rows in `GearPlanSelectPanel` and the
// filled cells on the board both answer "what would this change", from the same `CellDelta[]`, and
// before this file they each carried their own copy of `deltaText` — two identical four-line
// functions that would have drifted the first time either one grew a rule.
//
// -------------------------------------------------------------------------------------------------
// THIS OVERTURNS THE COLOUR RULING IN `GearPlanTotalsPanel.tsx`, AND THE OLD ARGUMENT WAS RIGHT
// ABOUT THE THING IT WAS ARGUING ABOUT.
//
// That header rejected `success.main` for a gain and `error.main` for a loss, on the design
// library: `error.main` belongs to "a stalled event loop", and the library's Don't forbids red for
// anything merely empty or not-yet-known — a helm with less AC is not a failure. `success.main` is
// the LIVE dot, and it means something HAPPENED, not that a quantity is larger. All of that still
// holds and this file does not touch either colour.
//
// What changed is the surface. That ruling was written for a panel drawing ONE diff of rows a
// planner reads deliberately, where "contrast, not scale" and a column of signed tabular numbers is
// genuinely faster. A candidate list is the opposite job: twenty rows, up to sixteen entries each,
// scanned rather than read, and the reader is not asking "how much AC" but "which of these costs me
// something". The old header left the door open for exactly this case — "if a loss ever genuinely
// needs a hue, the app's adverse colour is #cf6679 (KIND_COLOR.enemy)" — and this is the case.
//
// So the hues are the app's OWN pair, taken from `KIND_COLOR` rather than picked: `member` #7fbf8f
// for a gain and `enemy` #cf6679 for a loss. They are already documented as a friendly green and an
// adverse red in one muted family, tuned against this background, and reusing them means the board
// introduces no colour the app did not already have.
//
// A SIGN IS NOT A VERDICT, WHICH IS WHY THE SPLIT IS `isImprovement` AND NOT `> 0`. `DELAY` and
// `WEIGHT` are better smaller, so `WEIGHT -1.6` is drawn green, in the gains run, still wearing its
// minus sign — the number is what the arithmetic says and the group is what it MEANS. Grouping on
// the sign instead filed a lighter helm under what it costs you, which is how this was first built.
//
// THE COLOUR IS THE SECOND ENCODING AND NEVER THE ONLY ONE. Every entry keeps its explicit sign and
// the two groups are physically separated, so the line reads identically with no colour at all —
// which is what it is for a red-green colourblind reader, in a greyscale screenshot, and in the
// plain-text a copy button produces. Removing the sign to "let the colour say it" would be the
// version of this change that is actually a regression.

import type { JSX } from 'react'
import { Box, Typography } from '@mui/material'
import { splitDelta, type CellDelta } from '@shared/planner/gearPlanTotals'
import { statText } from '../gear/gearColumns'

/** `KIND_COLOR.member` — the app's friendly hue. Not `success.main`; see the header. */
export const GAIN_COLOR = '#7fbf8f'
/** `KIND_COLOR.enemy` — the app's adverse hue. Not `error.main`; see the header. */
export const LOSS_COLOR = '#cf6679'

/** One moved stat: `AC +12`, `SV MAGIC -8`. The sign is always drawn — it is not the colour's job. */
function deltaText(entry: CellDelta): string {
  const sign = entry.delta > 0 ? '+' : ''
  return `${entry.key.replace(/_/g, ' ')} ${sign}${statText(entry.delta, entry.key)}`
}

function Group({ entries, color }: { entries: CellDelta[]; color: string }): JSX.Element | null {
  if (entries.length === 0) return null
  return (
    <Box component="span" sx={{ color }}>
      {entries.map(deltaText).join(' · ')}
    </Box>
  )
}

/**
 * THE DELTA LINE. Gains, then losses, each run in its own hue.
 *
 * Only reached with a non-null list that the caller has already decided is worth drawing: `null`
 * (nothing to compare against) and `[]` (compared, nothing moved) are different statements that
 * each surface words for itself, and neither of them is a line of stats.
 */
export default function GearPlanDeltaLine({
  delta,
  testId
}: {
  delta: readonly CellDelta[]
  testId: string
}): JSX.Element {
  const { gains, losses } = splitDelta(delta)
  return (
    <Typography
      variant="caption"
      data-testid={testId}
      sx={{ display: 'block', fontVariantNumeric: 'tabular-nums', color: 'text.secondary' }}
    >
      <Group entries={gains} color={GAIN_COLOR} />
      {/* The groups are told apart WITHOUT the colour too, which is the whole point of drawing a
          separator rather than trusting two hues to do it. It is disabled ink so it never competes
          with the numbers, and it only exists when there is something on both sides of it. */}
      {gains.length > 0 && losses.length > 0 && (
        <Box component="span" sx={{ color: 'text.disabled', px: 0.75 }}>
          |
        </Box>
      )}
      <Group entries={losses} color={LOSS_COLOR} />
    </Typography>
  )
}
