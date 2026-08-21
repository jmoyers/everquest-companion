// ChipMultiSelect — THE "pick several from a closed list" control (docs/plans/planner-v2.md V3).
//
// A closed list is not a search: every option is known up front, the list is short enough to
// scroll, and what you have already picked must stay VISIBLE while you pick the next one — which
// is why the selection renders as chips inside the field rather than as a count beside it. The
// shape started as nine inline lines in the Sky tracker's class filter and moved here the moment
// a second surface (the planner's target classes) wanted exactly it.
//
// EMPTY IS "NO FILTER", never "none" (world-model law 1). The component never substitutes a
// selection of its own; the caller's `placeholder` is what says so out loud.
//
// `max` is a CAP, not a truncation: at the cap the unpicked options go disabled rather than
// disappearing, so the list keeps showing what exists and why you cannot have more of it.

import type { JSX } from 'react'
import { Autocomplete, TextField } from '@mui/material'

export interface ChipMultiSelectProps<T extends string> {
  options: readonly T[]
  value: T[]
  onChange: (next: T[]) => void
  label: string
  /** shown while nothing is picked — the place to state what an empty selection MEANS */
  placeholder?: string
  /** how many may be picked at once; unset = unlimited */
  max?: number
  /** the control never shrinks inside a nowrap toolbar, so its floor is the caller's call */
  minWidth?: number
  /**
   * THE WORDS AN OPTION WEARS, when the token is not already them (JOS-302's weapon picks:
   * `ONE_HAND` is a fine union key and a terrible chip). Default: the token itself, which is what a
   * caller whose tokens are already words relies on — an island's own name, a slot.
   *
   * The class filters take it too since JOS-402 (`SHD` -> `Shadow Knight`, through the one shared
   * `classDisplayName`), which is the same trade: a closed list stays keyed by the model's codes and
   * is READ in the words a player uses.
   *
   * The option list stays the model's vocabulary either way. This maps tokens to words for the
   * listbox and the chips; nothing about what is stored or compared changes.
   */
  optionLabel?: (option: T) => string
  testId?: string
}

export function ChipMultiSelect<T extends string>({
  options,
  value,
  onChange,
  label,
  placeholder,
  max,
  minWidth = 280,
  optionLabel,
  testId
}: ChipMultiSelectProps<T>): JSX.Element {
  const full = max !== undefined && value.length >= max
  return (
    <Autocomplete
      multiple
      size="small"
      options={options}
      value={value}
      onChange={(_e, v) => onChange(max === undefined ? v : v.slice(0, max))}
      getOptionDisabled={(o) => full && !value.includes(o)}
      getOptionLabel={optionLabel ?? ((o) => o)}
      sx={{ minWidth }}
      data-testid={testId}
      renderInput={(params) => <TextField {...params} label={label} placeholder={placeholder} />}
    />
  )
}

export default ChipMultiSelect
