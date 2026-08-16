// plan/PlanBracketCard.tsx — ONE STEP OF THE ROUTE, DRAWN
// (docs/plans/gear-progression-planner.md §1, §4).
//
// WHAT A CARD SAYS, in the plan's own sentence: *where should I be at these levels, and what am I
// there FOR?* The levels are the heading, the exp-zone chips are where to grind, the RUNS are the
// trips worth making while you are there, and the button is the one door out of this tab.
//
// IT IS ZONE-FIRST NOW, AND THAT WAS A CORRECTION RATHER THAN A REFACTOR. This card used to draw a
// flat top-eight list of items, and `progressionPlan.ts` rule 7 records what that cost: at level 44
// the Refined runs the owner actually farms never cracked a bracket-wide top eight against planes
// loot, so the feature's own subject — "it should say crushbone … mistmoore splitpaw" — never
// rendered. The item rows moved one level down, under the place they come from (`PlanRunRow.tsx`),
// and the card kept everything else.
//
// EVERY DERIVATION IS LABELLED, AND THAT IS STILL THE POINT. Nothing here is a number EverQuest
// states: a zone's band is a MEDIAN over the levels its mobs state, so the chip carries `from N
// stated mob levels` (`ZonePick.sampled`, printed rather than merely computed); a target's rank is
// `roleValue`, an invented ordering, so it is on the row's hover and never in a column; and a `+N`
// run has no band at all and says so in words.
//
// THE TWO ZONE LISTS ON THIS CARD ARE NOT THE SAME LIST, and the difference is the whole shape of
// the advice. The CHIPS are exp zones — where the experience is — and their gate deliberately
// excludes `trivial`, because a grey mob pays none. The RUNS are gear trips, and theirs deliberately
// includes it, because a grey mob is the easiest farm in the game. A zone can legitimately appear in
// one, both, or neither (fold rule 5).
//
// NOT WINDOWED, MEASURED RATHER THAN ASSUMED: the fold caps a bracket at `EXP_ZONE_CAP` (4) chips
// and `RUN_CAP` (6) runs of `RUN_TARGET_CAP` (3), and the route at seven brackets, so the whole page
// is bounded at ~126 rows by construction. `useWindowedRows` exists for the 6,766-row gear table;
// mounting it over eighteen rows would be machinery guarding nothing.

import type { JSX } from 'react'
import { Box, Button, Chip, Stack, Typography } from '@mui/material'
import type { PlanBracket, ZonePick } from '@shared/planner/progressionPlan'
import type { GearCompareData } from '../gear/gearData'
import { bracketTargets } from './planData'
import PlanRunRow from './PlanRunRow'

/**
 * One exp zone. The band is what the zone's MEDIAN mob cons at the bracket midpoint, and the hover
 * carries the spread and the sample size — because a zone with a level-6 entrance and a level-40
 * basement has a median that describes neither, and the fold says so in as many words.
 */
function ZoneChip({ pick }: { pick: ZonePick }): JSX.Element {
  return (
    <Chip
      size="small"
      variant="outlined"
      data-testid="plan-zone"
      label={`${pick.zone} · ${pick.band}`}
      title={`Median mob level ${String(pick.median)}, lowest ${String(pick.low)} - from ${String(pick.sampled)} stated mob levels. A median is a coarse stand-in for a zone, not its range.`}
      sx={{ flexShrink: 0, maxWidth: 320 }}
    />
  )
}

export interface PlanBracketCardProps {
  bracket: PlanBracket
  /** absent until the wish list document has loaded — see `usePlanWishes` for the rule */
  onAdd?: (bracket: PlanBracket) => void
  /** the Gear tab's hover-comparison seam, passed straight through to the item rows */
  compare?: GearCompareData
  onOpenLoot?: (item: string) => void
}

/**
 * ONE BRACKET.
 *
 * A BRACKET WITH EXP ZONES AND NO RUNS STILL DRAWS, and that is information rather than an
 * oversight: "there is somewhere to be at 30-35 and nothing here worth a detour" is an answer, and a
 * card that hid itself would read as a gap in the route. Only the fold's own trailing-silence trim
 * removes a bracket, and it removes only the ones at the END (`buildProgressionPlan`).
 *
 * THE BUTTON CARRIES WHAT THE CARD IS SHOWING — every target across every run (`bracketTargets`),
 * never the fold's flat top-eight, which is capped differently and would add rows no run drew. The
 * rows STAY afterwards, wearing the `wished` flag: rule 9 flags rather than filters, so pressing
 * this does not make the answer disappear.
 */
export default function PlanBracketCard({ bracket, onAdd, compare, onOpenLoot }: PlanBracketCardProps): JSX.Element {
  const addable = bracketTargets(bracket).length
  return (
    <Box
      data-testid="plan-bracket"
      data-from={String(bracket.from)}
      sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5, mb: 1.5 }}
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'nowrap', minWidth: 0 }}>
        <Typography variant="subtitle2" sx={{ flexShrink: 0 }}>
          {bracket.from}-{bracket.to}
        </Typography>
        <Box sx={{ display: 'flex', gap: 0.5, minWidth: 0, flexGrow: 1, overflow: 'hidden' }}>
          {bracket.expZones.map((pick) => (
            <ZoneChip key={pick.zone} pick={pick} />
          ))}
          {bracket.expZones.length === 0 && (
            <Typography variant="caption" color="text.secondary" noWrap>
              no zone this era profiles for experience at these levels
            </Typography>
          )}
        </Box>
        {addable > 0 && onAdd !== undefined && (
          <Button
            size="small"
            variant="outlined"
            data-testid="plan-add-bracket"
            title="Adds every item listed under this bracket`s runs to the Wish list. They stay on the card afterwards, flagged as wished - the plan keeps routing you to a thing you asked for."
            onClick={() => {
              onAdd(bracket)
            }}
            sx={{ flexShrink: 0 }}
          >
            Add {addable} to wish list
          </Button>
        )}
      </Stack>

      {bracket.runs.map((run) => (
        <PlanRunRow key={`${run.zone}#${String(run.plus ?? 0)}`} run={run} compare={compare} onOpenLoot={onOpenLoot} />
      ))}
      {bracket.runs.length === 0 && (
        <Typography variant="caption" color="text.secondary" data-testid="plan-no-targets" sx={{ display: 'block', mt: 0.5 }}>
          Nothing here beats what you are already wearing - grind it, and keep going.
        </Typography>
      )}
    </Box>
  )
}
