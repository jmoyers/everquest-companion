import type { JSX } from 'react'
import { IconButton } from '@mui/material'
import StarIcon from '@mui/icons-material/Star'
import StarBorderIcon from '@mui/icons-material/StarBorder'
import VisibilityIcon from '@mui/icons-material/Visibility'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import { Tooltip } from '../../lib/Tooltip'

// Quest-row affordances. Both live ON the accordion header and are ALWAYS visible
// (never hover-only) — discoverability is the whole point — and both stopPropagation so
// a click flags the quest instead of expanding the row. `p: 0.25` + `fontSize="small"`
// keeps them inside the existing row height.
//
// `component="span"`: AccordionSummary renders a real <button>, so a nested <button>
// is invalid DOM (React logs validateDOMNesting). ButtonBase still applies
// role="button" + tabIndex on a non-button element, which is exactly what MUI's own
// clickable Chip does inside these same summaries.

export function QuestStarButton({
  favorited,
  onToggle
}: {
  favorited: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    // The tooltip states the LIMIT of the pin, because JOS-146 gave it one: sorting by most
    // recently looted answers a question about an event, and a pin that floated over it made the
    // order say the wrong thing. Every other order still pins.
    <Tooltip
      title={
        favorited
          ? 'Unfavorite this quest'
          : 'Favorite this quest - pins it to the top, except when sorting by most recently looted'
      }
    >
      <IconButton
        size="small"
        component="span"
        aria-label={favorited ? 'Unfavorite this quest' : 'Favorite this quest'}
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
        sx={{ color: favorited ? 'warning.main' : 'text.disabled', p: 0.25 }}
      >
        {favorited ? <StarIcon fontSize="small" /> : <StarBorderIcon fontSize="small" />}
      </IconButton>
    </Tooltip>
  )
}

export function QuestIgnoreButton({
  ignored,
  onToggle
}: {
  ignored: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <Tooltip title={ignored ? 'Stop ignoring - show this quest again' : 'Ignore this quest permanently'}>
      <IconButton
        size="small"
        component="span"
        aria-label={ignored ? 'Stop ignoring this quest' : 'Ignore this quest permanently'}
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
        sx={{ color: ignored ? 'primary.main' : 'text.disabled', p: 0.25 }}
      >
        {ignored ? <VisibilityIcon fontSize="small" /> : <VisibilityOffIcon fontSize="small" />}
      </IconButton>
    </Tooltip>
  )
}
