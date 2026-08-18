// components/ToggleChip.tsx — the app's ON/OFF filter chip: one chip, lit when the filter is on.
//
// THIS SHAPE ALREADY EXISTS THREE TIMES and that is why it is here. `GearFilterBar` declares a
// private copy and its own comment admits the provenance ("lifted verbatim from EffectFilterBar");
// `EffectFilterBar` is where it started; `WishGroups.WishEraBar` writes it inline a third time. All
// three bodies are the same `Chip`, the same `size`, the same colour/variant pair. House law 7 is
// "one component, every surface", and a fourth private copy is how one of them silently drifts.
//
// THE THREE EXISTING COPIES ARE DELIBERATELY LEFT ALONE. This lands in a contribution PR whose
// whole promise is that it ADDS a tab without editing anyone else's files, so rewriting three
// established bars to import this one would put three files nobody asked about into the review.
// The consolidation is a separate, mechanical follow-up and is worth offering as one — this file
// existing is what makes that follow-up a two-line change per call site rather than a design.
//
// THE HINT IS A NATIVE `title` AND NOT A TOOLTIP. AGENTS.md's tooltip diet is explicit that a
// tooltip is "for enabling an action or naming a control - one clause, no caveats", and a filter
// chip's hint is exactly that: what turning this on will do. A MUI popper here would also open over
// the neighbouring chips, which are themselves controls.

import type { JSX } from 'react'
import { Chip } from '@mui/material'

export interface ToggleChipProps {
  label: string
  /** one clause naming what turning it ON does — a native `title`, never a popper */
  hint: string
  on: boolean
  testId: string
  onToggle: () => void
}

export default function ToggleChip({
  label,
  hint,
  on,
  testId,
  onToggle
}: ToggleChipProps): JSX.Element {
  return (
    <Chip
      size="small"
      label={label}
      data-testid={testId}
      title={hint}
      color={on ? 'primary' : 'default'}
      variant={on ? 'filled' : 'outlined'}
      onClick={onToggle}
      sx={{ flexShrink: 0 }}
    />
  )
}
