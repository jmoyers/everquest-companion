// BuffAllowCheck — ONE checkbox, and it is the same checkbox everywhere (JOS-168).
//
// The owner asked for two places to check a spell: on the CARD for a buff or debuff that is
// currently up, and on a ROW of the searchable per-class stats tables — "a spell's box on a mob's
// card and on your own card is the same box". So there is one component, it keys on the SPELL LINE
// (`timerNameKey` — rank-stripped and case-folded, the same fold every timer row id already uses),
// and both surfaces render it. A second copy would be two boxes for one fact.
//
// IT DOES NOT TAKE THE PREFERENCE AS A PROP. `useBuffAllow` publishes ONE value per window through
// `useSyncExternalStore`, so every box in the tab reads the same object and moves in the same
// commit; drilling it through the card grid and the table body instead would be the same value
// arriving by two routes with a chance to disagree for a frame.
//
// IT EXISTS ONLY IN OPT-IN MODE (owner ruling 2026-08-17: "'only track' should enable the
// checkboxes, when its disabled there shouldn't be any checkboxes. so its opt-in, or no choice.").
// With the mode off this component renders NOTHING — every surface that mounts it gets the same
// answer from the same place, so no caller has to ask the mode itself. On, the box starts unchecked
// and checking ALLOWS; what it shows is "does this draw on the timer windows" (`buffAllowAllowed`).

import type { JSX } from 'react'
import { Checkbox } from '@mui/material'
import { timerNameKey } from '@shared/buffTimers'
import { buffAllowAllowed } from '@shared/buffAllow'
import { useBuffAllow } from './useBuffAllow'
import { Tooltip } from '../../lib/Tooltip'

/**
 * The box for one spell.
 *
 * `dense` is the stats-table variant: the same control at table-row scale, because a durations row
 * is 20px tall and a card header is not.
 */
export function BuffAllowCheck({ spell, dense = false }: { spell: string; dense?: boolean }): JSX.Element | null {
  const { prefs, setLine } = useBuffAllow(window.eq)
  if (!prefs.optIn) return null
  const key = timerNameKey(spell)
  const checked = buffAllowAllowed(prefs, key)
  return (
    // ONE CLAUSE, NAMING THE CONTROL (AGENTS.md's tooltip diet): what the box does, not how the
    // filter works and not a caveat about the mode.
    <Tooltip title={checked ? 'Showing on the overlay' : 'Hidden from the overlay'}>
      <Checkbox
        size="small"
        checked={checked}
        data-testid="buff-allow-check"
        data-line={key}
        data-checked={checked ? 'true' : 'false'}
        slotProps={{ input: { 'aria-label': `Track ${spell} on the overlay` } }}
        onChange={(e) => {
          setLine(key, e.target.checked)
        }}
        sx={{ p: dense ? 0.25 : 0.5, mr: dense ? 0 : -0.5 }}
      />
    </Tooltip>
  )
}
