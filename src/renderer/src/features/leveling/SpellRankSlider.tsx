// leveling/SpellRankSlider.tsx — THE MOTE-RANK SIMULATOR for the best-spells readout (JOS-447).
//
// WHAT IT IS. The gear tab's `UpgradeSlider` metaphor, in a column a fifth of its width: one stop
// per mote rank, and every row of the table below reads at `max(its own observed rank, this)`. The
// owner's ask was a comparison, not a forecast - "compare upgraded damage to the max i have of a
// different spell. then it would be nice to simulate upgrade of a separate spell" - so the control
// lifts the WHOLE table and never pulls a spell the log has watched you cast back down.
//
// STACKED, NOT A ROW, AND THAT IS THE 260px FLOOR TALKING. `UpgradeSlider` puts its caption, slider
// and label on one line because the gear tab is the whole window wide. This panel is a third of the
// row at `lg` with a 260px floor at the app's own minimum width, and `BestSpellsPanel`'s own header
// records that four numeric columns already ask for 272px of it. So the caption and the label share
// one line and the slider takes the next one whole - the same two controls, in the space there is.
//
// SESSION STATE, NOT PERSISTED, and the caller owns it. The gear slider's persistence ruling was
// about a FORM that lost everything on a tab switch; this is one integer with an obvious base, and
// a glance away and back should show the readout's real answer rather than the last question
// somebody asked it - the same rule the tab selection above it already follows.
//
// AND IT SAYS WHAT IT IS SIMULATING, PERMANENTLY (the gear-upgrade-label law). The label is drawn
// at every position, including base, and it names the rank the table is being lifted to. Damage
// and healing both move with it at their own fitted rates (shared/spellScale.ts: six percent and
// three percent a rank); mana and cast time stay at base, which the tooltip states.

import type { JSX } from 'react'
import { Slider, Stack, Typography } from '@mui/material'
import { romanRank } from '@shared/spellLines'
import { SPELL_MAX_RANK } from '@shared/spellScale'
import { Tooltip } from '../../lib/Tooltip'

/** One stop per rank, base included. Ten ranks is the ladder `spellScale` states. */
const RANK_MARKS = Array.from({ length: SPELL_MAX_RANK + 1 }, (_, i) => ({ value: i }))

/** What the label says at a position. Base is a real answer and gets words of its own. */
export function rankSimulationLabel(rank: number): string {
  return rank <= 0 ? 'base ranks' : `all at ${romanRank(rank)}+`
}

export interface SpellRankSliderProps {
  /** 0 is base; 1..10 are the mote ranks the game prints as I..X. */
  rank: number
  onChange: (next: number) => void
}

export default function SpellRankSlider({ rank, onChange }: SpellRankSliderProps): JSX.Element {
  const base = rank <= 0
  return (
    <Stack spacing={0} sx={{ mb: 0.5 }} data-testid="best-spells-rank">
      <Stack direction="row" spacing={1} alignItems="baseline" sx={{ minWidth: 0 }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10, flexShrink: 0 }}>
          Simulate rank
        </Typography>
        <Tooltip title="Every row is read at the higher of the rank you have been observed casting and this one, so a spell you already own at a better rank is never pulled down. Damage and healing move with it; mana and cast time are the base figures.">
          <Typography
            variant="caption"
            data-testid="best-spells-rank-label"
            data-rank={String(rank)}
            color={base ? 'text.disabled' : 'primary.main'}
            sx={{ fontSize: 10, ml: 'auto', whiteSpace: 'nowrap' }}
          >
            {rankSimulationLabel(rank)}
          </Typography>
        </Tooltip>
      </Stack>
      <Slider
        size="small"
        min={0}
        max={SPELL_MAX_RANK}
        step={1}
        marks={RANK_MARKS}
        value={rank}
        data-testid="best-spells-rank-slider"
        aria-label="Simulated mote rank"
        sx={{ py: 0.5, mx: 0.5, width: 'auto' }}
        onChange={(_e, v) => {
          onChange(typeof v === 'number' ? v : v[0])
        }}
      />
    </Stack>
  )
}
