// gearplan/GearPlanFilterBar.tsx — which of the pool's rows the pickers are allowed to offer.
//
// ONE BAR FOR BOTH PICKERS, AND THAT IS THE FEATURE. The item picker and the donor picker search
// different corpora, but "only things I can get" is one preference, not two, and setting it twice
// is how the two surfaces end up disagreeing about what you asked for. It lives on the PAGE rather
// than inside either popover for the same reason, and because a filter you can only reach by
// opening a picker cannot tell you what it is currently doing to the picker you have not opened.
//
// A PICKER IS MODAL, SO THIS BAR IS READ-WHILE-OPEN AND SET-WHILE-CLOSED. Both pickers are MUI
// `Popover`s and a Popover has a backdrop: while one is open its chips are VISIBLE (a picker is a
// 340px box anchored to one cell, this bar spans the page above it) and its count keeps updating,
// but a click out here dismisses the picker rather than toggling a chip. That is ordinary modal
// behaviour and it is left alone deliberately - `hideBackdrop` would buy mid-search toggling at the
// price of a picker that no longer closes when you click away from it, which is the gesture every
// other popover in this app answers to.
//
// IT IS A SECOND ROW, NOT MORE CONTROLS IN `GearPlanToolbar`. The Gear tab's bar already models
// this split and states it: row one is "which items", row two is "what they read". Here the toolbar
// is WHAT THIS BOARD DOES (load, wish - two verbs that change the document) and this bar is WHAT
// THE PICKERS SHOW (four adjectives that change nothing at all). Mixing them would also break the
// toolbar's own contract, which is that it renders NOTHING when it has no action to offer.
//
// ---------------------------------------------------------------------------------------------
// THE HIDDEN COUNT IS THE POINT OF THE WHOLE COMPONENT, not a nicety on the end of it.
//
// `gearPlanSignals.ts` used to rule that these verdicts were "warnings, never filters", and the
// half of that argument still worth keeping is that a picker which quietly drops rows answers "why
// isn't it in the list" with silence. So the bar states, always and without being asked, how many
// rows the current settings are holding back. That line is what converts hiding from something the
// app does TO you into something you did.
//
// AND ERA SHIPS ON WHILE THE OTHER THREE SHIP OFF. That is not this file's inconsistency: era is
// `plannerData.useEraOnly`, one shared `eq.planner.era` key already governing the Effects and Wish
// list tabs, and its default is the owner's ruling on that key. A fourth private era toggle would
// be the actual defect. The count means an untouched board still says out loud that it is hiding
// things, which is exactly the case a default-on filter most needs to state.

import type { JSX } from 'react'
import { Paper, Stack, Typography } from '@mui/material'
import ToggleChip from '../../components/ToggleChip'
import { CURRENT_ERA_LABEL } from '../planner/plannerData'
import type { GearPlanRowFilter } from './gearPlanSignals'

export interface GearPlanFilterBarProps {
  filter: GearPlanRowFilter
  setFilter: (next: GearPlanRowFilter) => void
  /** the SHARED era toggle - `plannerData.useEraOnly`, not a field of `filter` */
  eraOnly: boolean
  setEraOnly: (v: boolean) => void
  /**
   * How many rows the current settings are holding back across every picker that has been asked a
   * question. `null` means nothing has been searched yet, so there is no honest number to state -
   * which is different from zero, and reads as silence rather than as "hiding nothing".
   */
  hidden: number | null
}

export default function GearPlanFilterBar({
  filter,
  setFilter,
  eraOnly,
  setEraOnly,
  hidden
}: GearPlanFilterBarProps): JSX.Element {
  const set = (patch: Partial<GearPlanRowFilter>): void => {
    setFilter({ ...filter, ...patch })
  }

  return (
    <Paper
      variant="outlined"
      data-testid="gearplan-filters"
      sx={{ bgcolor: 'rgba(255,255,255,0.015)', px: 1.25, py: 0.75, flexShrink: 0 }}
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'nowrap' }}>
        <Typography variant="caption" color="text.secondary" noWrap sx={{ flexShrink: 0, mr: 0.5 }}>
          Offer me
        </Typography>

        {/* The shared control, wearing the era's own name rather than the word "era" - the same
            label the Effects and Wish list tabs put on this exact value. */}
        <ToggleChip
          label={CURRENT_ERA_LABEL}
          testId="gearplan-filter-era"
          on={eraOnly}
          onToggle={() => setEraOnly(!eraOnly)}
          hint="Keep only what this era can actually drop. Shared with the Effects and Wish list tabs - turning it off here turns it off there."
        />
        <ToggleChip
          label="Owned or looted"
          testId="gearplan-filter-owned"
          on={filter.ownedOnly}
          onToggle={() => set({ ownedOnly: !filter.ownedOnly })}
          hint="Keep only what your newest inventory dump names or your loot history saw."
        />
        <ToggleChip
          label="My classes"
          testId="gearplan-filter-usable"
          on={filter.usableOnly}
          onToggle={() => set({ usableOnly: !filter.usableOnly })}
          hint="Keep only what a class you are running can wear. An item whose page states no class list is kept - nothing has shown you cannot wear it."
        />
        <ToggleChip
          label="Wishlisted"
          testId="gearplan-filter-wished"
          on={filter.wishedOnly}
          onToggle={() => set({ wishedOnly: !filter.wishedOnly })}
          hint="Keep only what is already on your wish list."
        />

        <div style={{ flexGrow: 1, minWidth: 4 }} />

        {/* Never a warning hue and never an error: hiding rows you asked to hide is working
            correctly. It is `text.disabled` for the same reason the wish control's line is. */}
        {hidden !== null && hidden > 0 && (
          <Typography
            variant="caption"
            color="text.disabled"
            noWrap
            data-testid="gearplan-filter-hidden"
          >
            {`${String(hidden)} ${hidden === 1 ? 'match is' : 'matches are'} hidden by these`}
          </Typography>
        )}
      </Stack>
    </Paper>
  )
}
