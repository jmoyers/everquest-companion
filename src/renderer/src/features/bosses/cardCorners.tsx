// THE CARD'S TWO CORNER CONTROLS — the kill badge (top-left) and hide/unhide (top-right).
// Their own file because BossSections is at the measured file ceiling and both are
// self-contained: one draws a fact, the other writes one flag.
//
// HIDE/UNHIDE (GitHub issue #32). Extracted with the badge because BossSections
// is at the measured file ceiling and this control is a self-contained intent: one button, one
// writer of the hidden set (useHiddenTargets via the section props), no reading of the roster.
//
// It sits top-RIGHT because the kill badge owns top-left. It STOPS the click: the card routes
// to the mob page, and hiding a card must not also open it. The icon is the state you would
// MOVE TO (an eye on a hidden card, a struck eye on a visible one), matching the toolbar peek's
// vocabulary. Low opacity until hover on a visible card so the control does not compete with
// the art it sits over; near-full on a hidden card, where the control IS the point.

import type { JSX } from 'react'
import { Box, IconButton } from '@mui/material'
import CheckIcon from '@mui/icons-material/Check'
import type { TierStyle } from '../../lib/tierChip'
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined'
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined'

export function HideTargetButton({
  name,
  hidden,
  onToggle
}: {
  name: string
  hidden: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <IconButton
      data-testid="boss-card-hide"
      aria-label={hidden ? `unhide ${name}` : `hide ${name}`}
      size="small"
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      sx={{
        position: 'absolute',
        top: 2,
        right: 2,
        zIndex: 1,
        color: 'text.secondary',
        bgcolor: 'background.paper',
        opacity: hidden ? 0.9 : 0.35,
        '&:hover': { opacity: 1, bgcolor: 'background.paper' }
      }}
    >
      {hidden ? <VisibilityOutlinedIcon fontSize="inherit" /> : <VisibilityOffOutlinedIcon fontSize="inherit" />}
    </IconButton>
  )
}

export function TargetKilledBadge({ tier }: { tier: TierStyle }): JSX.Element {
  return (
    <Box
      sx={{
        position: 'absolute',
        top: 4,
        left: 4,
        zIndex: 1,
        width: 20,
        height: 20,
        borderRadius: '50%',
        bgcolor: tier.bg,
        color: tier.fg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: 1
      }}
    >
      <CheckIcon sx={{ fontSize: 14 }} />
    </Box>
  )
}
