// gearplan/GearPlanStatPicker.tsx — the two controls that turn a name search into a stat search.
//
// `ChipMultiSelect` IS THE APP'S ONE "pick several from a closed list" control (house law 7) — the
// Gear tab's class filter, the Sky tracker and the exaltation board all already use it, so this
// introduces no new gesture. Only the vocabulary is new: stat keys instead of class abbreviations.
//
// TWO CONTROLS, DOING TWO THINGS, AND THAT SEPARATION IS THE POINT:
//
//   * THE PICK ORDERS. Choosing WIS puts the highest-wisdom candidates first and removes nothing,
//     so it costs nothing to try and answers "what is out there" — which is the question you have
//     before you know whether anything beats what you own.
//   * THE TOGGLE FILTERS, against the item worn in this cell. It is the one that hides rows, so it
//     is a separate deliberate act rather than a side effect of expressing interest in a stat.
//
// The toggle is drawn only once a stat is picked, because "better on nothing" is not a question.
// That is not a disabled control (house law 9 — unselected is not disabled); it is a control that
// has nothing to act on yet, and it appears the moment it does.
//
// IT SAYS WHAT IT IS COMPARING AGAINST, and the two cases genuinely differ. With an item worn in
// the cell the toggle reads `Beats worn` and means it. With nothing worn — no dump, or an empty
// slot — the baseline is zero, so the same switch means "states this stat at all", and the label
// says `Has these` instead. Same code path, honestly different claim, and drawing them with one
// word would make the empty-slot case look like a comparison it cannot make.

import type { JSX } from 'react'
import { Stack } from '@mui/material'
import type { GearStatKey } from '@shared/planner/gear'
import { STAT_PICK_OPTIONS } from '@shared/planner/gearPlanStatPick'
import { ChipMultiSelect } from '../../components/ChipMultiSelect'
import ToggleChip from '../../components/ToggleChip'

/** `SV_MAGIC` is a fine key and a terrible chip — `ChipMultiSelect`'s own `optionLabel` case. */
function statWords(key: GearStatKey): string {
  return key.replace(/_/g, ' ')
}

export interface StatPick {
  keys: GearStatKey[]
  beatsWorn: boolean
}

export const NO_STAT_PICK: StatPick = { keys: [], beatsWorn: false }

export default function GearPlanStatPicker({
  pick,
  onChange,
  /** whether the cell has a worn item to compare against — see the header */
  hasWorn
}: {
  pick: StatPick
  onChange: (next: StatPick) => void
  hasWorn: boolean
}): JSX.Element {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', mb: 0.5 }}>
      <ChipMultiSelect
        options={STAT_PICK_OPTIONS}
        value={pick.keys}
        onChange={(keys) => {
          // DROPPING THE LAST STAT DROPS THE FILTER WITH IT. Leaving `beatsWorn` armed against an
          // empty pick would leave a switch on with nothing under it, and it would come back on
          // the next stat picked — a filter nobody asked for twice.
          onChange({ keys, beatsWorn: keys.length === 0 ? false : pick.beatsWorn })
        }}
        label="Stats"
        placeholder="any stats"
        minWidth={180}
        optionLabel={statWords}
        testId="gearplan-stat-pick"
      />
      {pick.keys.length > 0 && (
        <ToggleChip
          label={hasWorn ? 'Beats worn' : 'Has these'}
          hint={
            hasWorn
              ? 'Only items better than the one worn in this slot, on every picked stat'
              : 'Nothing is worn in this slot, so this shows items that state every picked stat'
          }
          testId="gearplan-stat-beats"
          on={pick.beatsWorn}
          onToggle={() => {
            onChange({ ...pick, beatsWorn: !pick.beatsWorn })
          }}
        />
      )}
    </Stack>
  )
}
