// THE PER-BOSS DIFFICULTY LADDER (JOS-152) — five rungs on a THIS WEEK card, one per instance
// difficulty, grey while the week still has it and green once a credited kill has taken it.
//
// The derivation is `tierLadder` (lockout.ts), which also carries the whole argument for what the
// log can and cannot state about a difficulty. This file is the drawing, and it makes exactly
// three decisions of its own:
//
// 1. ONE GREEN, NOT THE TIER PALETTE. Every other tier surface in the app paints d0..d4 in their
//    own colours (lib/tierChip.ts), and reusing them here would be actively wrong: D0's swatch
//    IS grey, so a cleared base difficulty would render as the open state. A rung's identity is
//    its position and its label; its colour is a yes/no. The reporter asked for exactly that
//    ("1 2 3 4 5 in gray, green when defeated this week") and the palette collision makes it the
//    only readable option, so the labels still come from `tierStyle` and nothing else does.
//
// 2. FIVE RUNGS DRAWN THE SAME WAY (JOS-166 — this used to be the opposite rule). The base rung
//    was drawn as an outline rather than a fill, because tier 0 in the kill record meant "base
//    instance OR open world OR no zone line seen" and the component was not allowed to promise a
//    lockout the model could not see. The three are separated at the fold now, and only a real d0
//    instance clear ever reaches a rung — so a filled base rung is a true statement and drawing
//    it differently would be the app doubting a fact it has.
//
// 3. NATIVE `title`, NEVER A POPPER. These rungs sit in a scrolling grid directly beneath the
//    view's toolbar, which is the geometry that produced JOS-127 and JOS-143: a `placement="top"`
//    card anchored here opens up across the controls the user was aiming at. An OS tooltip is not
//    in the DOM and has no hit area, so it cannot eat a click. What it shows lives in lockout.ts
//    (`rungTitle`) rather than here, so it is reachable from a node test instead of stranded
//    behind an MUI import — and since JOS-171 it is a DATE and nothing else, because the ladder
//    is now the last thing on the card: the `Locked · <date>` caption under it is gone and the
//    chips answer in its place. A rung with nothing to add (an open one) gets NO `title`
//    attribute at all — `rungTitle` returns `undefined`, which React omits, where `''` would be
//    a present-and-empty attribute that also swallows the card's own tooltip.

import type { JSX } from 'react'
import { Box, Stack } from '@mui/material'
import { rungTitle, type LadderRung } from './lockout'
import { tierStyle } from '../../lib/tierChip'

function Rung({ rung, size }: { rung: LadderRung; size: number }): JSX.Element {
  const label = tierStyle(rung.tier).label
  return (
    <Box
      data-testid={`boss-rung-d${String(rung.tier)}`}
      data-cleared={rung.cleared ? '1' : '0'}
      title={rungTitle(rung)}
      sx={{
        flex: '1 1 0',
        minWidth: 0,
        height: size,
        lineHeight: `${String(size - 2)}px`,
        borderRadius: 0.5,
        border: '1px solid',
        borderColor: rung.cleared ? 'success.main' : 'divider',
        bgcolor: rung.cleared ? 'success.main' : 'transparent',
        color: rung.cleared ? 'background.default' : 'text.disabled',
        fontWeight: 700,
        fontSize: size > 15 ? 10 : 9,
        textAlign: 'center',
        letterSpacing: '-0.02em',
        userSelect: 'none'
      }}
    >
      {label}
    </Box>
  )
}

/**
 * The ladder. `compact` is the card density the roster is already drawing at, so the rungs shrink
 * with everything else rather than forcing the compact card wider.
 */
export default function DifficultyLadder({
  rungs,
  compact
}: {
  rungs: LadderRung[]
  compact: boolean
}): JSX.Element {
  return (
    <Stack
      data-testid="boss-difficulty-ladder"
      direction="row"
      spacing={0.25}
      sx={{ mt: 0.25, mb: 0.25 }}
    >
      {rungs.map((rung) => (
        <Rung key={rung.tier} rung={rung} size={compact ? 14 : 18} />
      ))}
    </Stack>
  )
}
