// leveling/LevelStepper.tsx — the left/right arrows around the tab's viewed level.
//
// ONE CONTROL, TWO PLACEMENTS (owner ask 2026-08-23: "we need the same left right arrows for
// scaling level, but on the damage/healing table"). It lived inside `NewAtLevelPanel` while that
// panel was the only one with a level to step; the best-spells readout in the other column reads
// the SAME lifted state (`viewedLevel.ts`), so a second stepper is a second handle on one number —
// both always show the same level, which is what keeps "two steppers" from meaning "two levels".
//
// The testid prefix is a prop because the e2e drives each placement by name (`new-at-level-prev`,
// `best-spells-level-prev`) and a shared literal would make the two indistinguishable.
//
// IT GREYS WHILE A SEARCH IS RUNNING (JOS-392) rather than unmounting: the search results are about
// the whole game and no level on screen governs them, but the stepper is where the reader came in
// and a control that vanishes under a keystroke is a control they have to go looking for. Dimmed
// and disabled says "not what you are looking at right now"; gone says "was that ever there". Only
// the unlock panel has a search, so only that placement ever dims.

import type { JSX } from 'react'
import { IconButton, Stack, Typography } from '@mui/material'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import { LEVEL_MAX, LEVEL_MIN, clampLevel } from './viewedLevel'

export interface LevelStepperProps {
  level: number
  onChange: (n: number) => void
  /** Grey and disable without unmounting (the unlock panel's search state). Default false. */
  dimmed?: boolean
  /** The placement's testid family: `<prefix>-stepper`, `<prefix>-prev`, `<prefix>-value`, `<prefix>-next`. */
  testidPrefix: string
}

/** −/+ around the level, with the character's own level as the default and the reset. */
export function LevelStepper({ level, onChange, dimmed = false, testidPrefix }: LevelStepperProps): JSX.Element {
  return (
    <Stack
      direction="row"
      spacing={0.25}
      alignItems="center"
      data-testid={`${testidPrefix}-stepper`}
      data-dimmed={dimmed ? 'true' : 'false'}
      sx={{ opacity: dimmed ? 0.4 : 1 }}
    >
      <IconButton
        size="small"
        aria-label="previous level"
        data-testid={`${testidPrefix}-prev`}
        disabled={dimmed || level <= LEVEL_MIN}
        onClick={() => onChange(clampLevel(level - 1))}
      >
        <ChevronLeftIcon fontSize="small" />
      </IconButton>
      <Typography variant="subtitle2" data-testid={`${testidPrefix}-value`} sx={{ minWidth: 64, textAlign: 'center' }}>
        Level {level}
      </Typography>
      <IconButton
        size="small"
        aria-label="next level"
        data-testid={`${testidPrefix}-next`}
        disabled={dimmed || level >= LEVEL_MAX}
        onClick={() => onChange(clampLevel(level + 1))}
      >
        <ChevronRightIcon fontSize="small" />
      </IconButton>
    </Stack>
  )
}
