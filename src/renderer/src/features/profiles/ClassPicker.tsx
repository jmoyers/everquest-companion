// ClassPicker — the 16 classes as toggles, capped at a loadout's three slots.
//
// THE CHIPS SAY THE WHOLE CLASS NAME (JOS-402, owner: *anywhere in the app that we have the class
// filter, it should be the whole class name*). The VALUE is still the /who code — that is what the
// caller holds, what the store keeps and what the main process re-validates — and the per-chip
// testid is still `combo-class-<ABBR>`; only the words changed. Sixteen full names wrap onto
// several rows inside the dialog, which the Stack already did.
//
// ONE PICKER, TWO WRITE SURFACES. It was inline in ClassComboEditor until JOS-87 added the
// current-loadout override beside it; two copies of "which classes" would have drifted the
// moment one of them learned something (the cap, the disabled state, the ordering), and the
// cap in particular is a rule the main process re-validates — a renderer that offers a fourth
// chip is offering a write that will be refused.
//
// Selection ORDER is preserved: the array the caller holds is the order the user clicked, and
// that is what reaches the store. The model has no notion of a primary/secondary/tertiary
// ranking, so nothing here sorts and nothing pretends the first pick means more.

import type { JSX } from 'react'
import { Chip, Stack } from '@mui/material'
import { CLASS_ABBRS, MAX_COMBO_SLOTS, type ClassAbbr } from '@shared/classCombo'
import { classDisplayName } from '@shared/spellLevels'

export interface ClassPickerProps {
  picked: ClassAbbr[]
  onToggle: (c: ClassAbbr) => void
}

/** Add or remove `c`, refusing a fourth pick. The one place the cap is implemented. */
export function togglePicked(picked: readonly ClassAbbr[], c: ClassAbbr): ClassAbbr[] {
  if (picked.includes(c)) return picked.filter((x) => x !== c)
  return picked.length < MAX_COMBO_SLOTS ? [...picked, c] : [...picked]
}

/** The 16 classes as toggles. Selection is capped at three; a full selection dims the rest. */
export default function ClassPicker({ picked, onToggle }: ClassPickerProps): JSX.Element {
  const full = picked.length >= MAX_COMBO_SLOTS
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap data-testid="combo-class-picker">
      {CLASS_ABBRS.map((abbr) => {
        const on = picked.includes(abbr)
        return (
          <Chip
            key={abbr}
            size="small"
            label={classDisplayName(abbr)}
            color={on ? 'primary' : 'default'}
            variant={on ? 'filled' : 'outlined'}
            onClick={() => onToggle(abbr)}
            disabled={!on && full}
            data-testid={`combo-class-${abbr}`}
            sx={{ height: 24, fontWeight: on ? 700 : 400 }}
          />
        )
      })}
    </Stack>
  )
}
