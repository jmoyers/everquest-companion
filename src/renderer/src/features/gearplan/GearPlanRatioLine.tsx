// gearplan/GearPlanRatioLine.tsx — a weapon's damage ratio, on a line of its own.
//
// WHY IT IS NOT IN THE DELTA LINE. `cellDelta` walks `GEAR_STAT_KEYS`, and ratio is not one of them
// — it is a QUOTIENT of two of them. It could have been forced in as a synthetic entry; it is not,
// because it does not read like the others. Every entry in the delta line is a quantity the item
// page states and the two sides subtract; the ratio is derived, is the only entry with decimals,
// and for a weapon it is the number that decides the choice. Buried at position eleven between
// `SV POISON` and `WEIGHT` it would be none of those things.
//
// THE RATIO LEADS AND ITS INPUTS FOLLOW. `RATIO 0.77 · DMG 20 · DLY 26` — you scan the ratio and
// keep the two numbers behind it in reach, which is the order the Gear tab's own columns put them
// in (`CORE_COLUMNS` carries RATIO; DMG and DELAY sort next to it).
//
// AND IT IS THE NUMBER THE SLIDER MOVES, which is the whole reason this line belongs on THIS
// surface rather than only on the Gear tab. `scaleGearStat` scales DMG and leaves DELAY alone, on
// purpose — `gearScale.ts` states it as "a game fact with a consequence (it is the whole reason a
// weapon's damage RATIO improves)". So dragging a weapon's tier moves this line and nothing else on
// the board says so.
//
// TWO DECIMALS, FROM THE ONE PLACE THAT DECIDES THAT. `statText(value, 'RATIO')` is the Gear tab's
// own formatter, so a ratio reads identically on both surfaces and neither can drift into three
// places or a percentage.
//
// THE COMPARISON IS ABSENT RATHER THAN ZERO when there is nothing to compare against — no dump,
// nothing worn in that cell, or a worn item that is not a weapon. A `+0.00` would read as "no
// better", which is a claim, where silence is the truth (law 2).

import type { JSX } from 'react'
import { Box, Typography } from '@mui/material'
import type { WeaponFacts } from '@shared/planner/gearPlanTotals'
import { statText } from '../gear/gearColumns'
import { GAIN_COLOR, LOSS_COLOR } from './GearPlanDeltaLine'

/** Higher is better on a ratio, so the sign reads straight — unlike `DELAY`, one of its inputs. */
function RatioDelta({ mine, worn }: { mine: WeaponFacts; worn: WeaponFacts }): JSX.Element | null {
  const moved = mine.ratio - worn.ratio
  // Under half a hundredth prints as `0.00`, and a signed zero is worse than nothing: it claims a
  // difference the printed number cannot show. The rounding decides, so it is asked before the sign.
  const text = statText(Math.abs(moved), 'RATIO')
  if (text === '0.00') return null
  return (
    <Box component="span" sx={{ color: moved > 0 ? GAIN_COLOR : LOSS_COLOR }}>
      {` ${moved > 0 ? '+' : '-'}${text}`}
    </Box>
  )
}

/**
 * THE LINE. Drawn only for a weapon — `weaponFacts` already answered that question by returning
 * `null` for everything else, so there is no second opinion about what a weapon is here.
 */
export default function GearPlanRatioLine({
  mine,
  worn,
  testId
}: {
  mine: WeaponFacts
  worn: WeaponFacts | null
  testId: string
}): JSX.Element {
  return (
    <Typography
      variant="caption"
      data-testid={testId}
      sx={{ display: 'block', fontVariantNumeric: 'tabular-nums', color: 'text.secondary' }}
    >
      <Box component="span" sx={{ color: 'text.primary' }}>
        {`RATIO ${statText(mine.ratio, 'RATIO')}`}
      </Box>
      {worn !== null && <RatioDelta mine={mine} worn={worn} />}
      <Box component="span" sx={{ color: 'text.disabled' }}>
        {` · DMG ${String(mine.dmg)} · DLY ${String(mine.delay)}`}
      </Box>
    </Typography>
  )
}
