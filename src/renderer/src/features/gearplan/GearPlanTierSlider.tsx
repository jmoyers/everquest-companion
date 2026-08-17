// gearplan/GearPlanTierSlider.tsx — the merge tier a cell is PLANNED at.
//
// WHY THIS IS NOT `gear/UpgradeSlider` WITH A `compact` PROP, which is what it was for a while.
//
// That control has two sliders: the whole TIER, and the merge experience banked toward the next
// one. The second was reported as confusing on a board card and is gone here (see below), and once
// it goes the two controls stop being the same control. What is left is a slider from 0 to
// `ITEM_MAX_TIER` and the number it is at — no tick marks, no percent, no fraction, and therefore
// none of `UpgradeSlider`'s actual substance, which is the clamp that stops a tier drop from
// leaving a fraction its new denominator cannot hold.
//
// So this is not the near-copy house law 7 forbids: it shares no rule with the other control,
// because there is only one rule left and `ITEM_MAX_TIER` states it. Keeping the `compact` prop
// would have meant ninety lines of shape-switching inside a file the Gear tab owns, to render
// fifteen lines here. This way that file is untouched by this feature entirely.
//
// ---------------------------------------------------------------------------------------------
// NO FRACTION, AND THE EVIDENCE AGREES WITH THE UI DECISION.
//
// A plan says WHICH TIER you are aiming a cell at. The fraction is progress toward the next one,
// and three things make it noise here: the dump cannot state it (`wornState` reads a worn item as
// a floor with fraction 0, because a name prints ` +5` and never the banked part), a load therefore
// never seeds one, and no socket unlocks on it — `unlockedSockets` reads `state.full` alone, which
// is the coupling this whole board exists for.
//
// A MOVE ZEROES IT rather than leaving a stale value unreachable. A board written before this
// control lost its second slider can still hold a fraction; nothing here can edit it, so the first
// tier move clears it instead of letting it go on quietly scaling that cell's stats.

import type { JSX } from 'react'
import { Slider, Stack, Typography } from '@mui/material'
import { ITEM_MAX_TIER } from '@shared/itemStats'
import type { ItemUpgradeState } from '@shared/itemUpgrade'

export interface GearPlanTierSliderProps {
  state: ItemUpgradeState
  onChange: (next: ItemUpgradeState) => void
}

export default function GearPlanTierSlider({
  state,
  onChange
}: GearPlanTierSliderProps): JSX.Element {
  return (
    <Stack
      direction="row"
      spacing={0.5}
      alignItems="center"
      sx={{ flexWrap: 'nowrap', minWidth: 0 }}
      data-testid="gearplan-upgrade"
    >
      <Slider
        size="small"
        min={0}
        max={ITEM_MAX_TIER}
        step={1}
        value={state.full}
        data-testid="gearplan-tier-slider"
        aria-label="Planned merge tier"
        onChange={(_e, v) => {
          onChange({ full: typeof v === 'number' ? v : v[0], fraction: 0 })
        }}
        sx={{ mx: 1 }}
      />
      <Typography
        variant="caption"
        data-testid="gearplan-upgrade-label"
        color={state.full === 0 ? 'text.secondary' : 'primary.main'}
        sx={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}
        title="The merge tier this cell is planned at. It decides which exaltation sockets are unlocked."
      >
        {`+${String(state.full)}`}
      </Typography>
    </Stack>
  )
}
