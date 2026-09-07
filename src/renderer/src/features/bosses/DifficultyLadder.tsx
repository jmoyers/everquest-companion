// THE PER-BOSS DIFFICULTY LADDER (JOS-152) — five rungs on a THIS WEEK card, one per instance
// difficulty, grey while the week still has it and green once a credited kill has taken it.
//
// The derivation is `tierLadder` (lockout.ts), which also carries the whole argument for what the
// log can and cannot state about a difficulty. This file is the drawing, and it makes exactly
// four decisions of its own:
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
//
// 4. THE BASE RUNG IS CLICKABLE IN THE WEEK VIEW (section 2a). When a credited open-world/unknown
//    kill of this target landed this week, BossView hands the d0 rung a `canMark` gate and an
//    `onMark` toggle: an OPEN rung then wears a dashed border as an affordance hint and marks
//    itself cleared on click, stopping propagation so the card's mob page stays shut. A
//    hand-marked rung draws as an ordinary solid-green rung — `data-manual="1"` is a test tell,
//    not a visual one (owner ruling 2).

import type { JSX, MouseEvent } from 'react'
import { Box, Stack, type SxProps, type Theme } from '@mui/material'
import { rungTitle, type LadderRung } from './lockout'
import { tierStyle } from '../../lib/tierChip'

// The rung's box: a yes/no fill (never the tier palette — see 1 above), plus, on an OPEN clickable
// d0 rung, the dashed border + hover that hint the affordance. A cleared rung is solid green
// whether it was derived or hand-marked (owner ruling 2).
function rungSx(rung: LadderRung, size: number, clickable: boolean): SxProps<Theme> {
  return {
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
    userSelect: 'none',
    cursor: clickable ? 'pointer' : 'inherit',
    ...(clickable && !rung.cleared
      ? { borderStyle: 'dashed', '&:hover': { borderColor: 'success.main' } }
      : {})
  }
}

/**
 * The d0 hand-mark affordance for the week view (section 2a). Absent ⇒ the base rung is inert.
 * One object rather than a `canMark`/`onToggle` pair so the three components between here and
 * `BossView` forward one prop, not two.
 */
export interface BaseRungMark {
  /** the gate: a credited open-world/unknown kill of this target landed this lockout week. */
  canMark: boolean
  /** flip the mark (BossView's toggle, already bound to this target and the week). */
  onToggle: () => void
}

function Rung({
  rung,
  size,
  canMark,
  onMark
}: {
  rung: LadderRung
  size: number
  /** the base (d0) rung only, in the week view, when a credited open-world/unknown kill of this
      target landed this week (BossView computes it). */
  canMark?: boolean
  onMark?: () => void
}): JSX.Element {
  const label = tierStyle(rung.tier).label
  const clickable = canMark === true && onMark !== undefined
  const onClick = clickable
    ? (e: MouseEvent) => {
        // the card under it opens the mob page; a rung toggle must not.
        e.stopPropagation()
        onMark()
      }
    : undefined
  return (
    <Box
      data-testid={`boss-rung-d${String(rung.tier)}`}
      data-cleared={rung.cleared ? '1' : '0'}
      data-manual={rung.manual ? '1' : undefined}
      data-can-mark={clickable ? '1' : undefined}
      title={rungTitle(rung) ?? (clickable ? 'Click to mark this difficulty cleared this week' : undefined)}
      onClick={onClick}
      sx={rungSx(rung, size, clickable)}
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
  compact,
  baseMark
}: {
  rungs: LadderRung[]
  compact: boolean
  /** week view only: the d0 rung may be hand-marked (see BaseRungMark). */
  baseMark?: BaseRungMark
}): JSX.Element {
  return (
    <Stack
      data-testid="boss-difficulty-ladder"
      direction="row"
      spacing={0.25}
      sx={{ mt: 0.25, mb: 0.25 }}
    >
      {rungs.map((rung) => (
        <Rung
          key={rung.tier}
          rung={rung}
          size={compact ? 14 : 18}
          // d0 only, and only while the rung is still togglable: an OPEN rung (mark it), or one
          // this store marked by hand (undo it). A rung greened by a REAL lock is not ours to
          // clear — leaving it clickable is a dead no-op click (whole-branch review, Minor 6).
          canMark={
            rung.tier === 0 && (!rung.cleared || rung.manual === true) ? baseMark?.canMark : undefined
          }
          onMark={rung.tier === 0 ? baseMark?.onToggle : undefined}
        />
      ))}
    </Stack>
  )
}
