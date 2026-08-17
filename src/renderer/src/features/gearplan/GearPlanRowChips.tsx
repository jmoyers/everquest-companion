// gearplan/GearPlanRowChips.tsx — the warnings a picker row wears, in the app's chip vocabulary.
//
// ONE COMPONENT FOR BOTH PICKERS (house law 7). The item picker and the donor picker ask different
// corpora and rank differently, but "is this in era / can I use it / do I have one" is the same
// sentence in both, and two copies of it is how one of them silently stops saying it.
//
// THE GEOMETRY IS THE DESIGN LIBRARY'S OUTLINED CHIP, VERBATIM: 18px tall, 10px label,
// `border-radius: 999px`, no fill, and the outline at 0.7 alpha of the semantic hue (0.23 white for
// a neutral one). Filled chips are reserved to the tier ladder and the meter-bar kind tag; nothing
// here is either.
//
// AND THE HUES ARE THE ONES ALREADY SPOKEN FOR:
//   * `out of era` / an expansion name → WARNING `#e0a94a`. The library scopes warning to "No log
//     detected", `LORE`, owner-only — facts that make a thing unusable right now without anything
//     being broken, which is exactly what an unreleased zone is.
//   * `era?` and `class?` → NEUTRAL white 0.23. Both are statements about OUR tables, not about the
//     item, and dressing a gap in a semantic hue would make our ignorance look like your problem.
//   * `wrong class` → `#cf6679`, the app's adverse hue (KIND_COLOR.enemy). NOT `error.main`, which
//     the library scopes to close-hover and real failure: an item your class cannot wear is a fact,
//     not a fault.
//   * an owned place → INFO BLUE `#29b6f6`, which is precisely what the library's own `bank` chip
//     is ("kept-storage dispositions"). A copy you already hold is a kept-storage fact.
//   * `wishlisted` → SUCCESS GREEN `#66bb6a`. It is the only chip here reporting a decision the
//     USER already made rather than a fact about the world, and success is the library's hue for a
//     thing that has gone right. It is deliberately NOT the owned blue: "I want this" and "I have
//     this" are the two states this strip most needs to keep apart.
//
// NO POPPER ANYWHERE. These rows live inside a popover already, and house law 8 forbids a second
// one opening over the first; every explanation rides in a native `title`.

import type { JSX } from 'react'
import { Box, Chip } from '@mui/material'
import type { RowSignals } from './gearPlanSignals'
import { hasSignal } from './gearPlanSignals'

/** The library's outlined state chip. `hue` is the full colour; the border takes it at 0.7. */
function StateChip({
  label,
  hue,
  title
}: {
  label: string
  hue: string
  title?: string
}): JSX.Element {
  return (
    <Chip
      size="small"
      variant="outlined"
      label={label}
      title={title}
      sx={{
        height: 18,
        fontSize: 10,
        flexShrink: 0,
        borderRadius: 999,
        color: hue,
        borderColor: hue === NEUTRAL ? 'rgba(255,255,255,0.23)' : alpha70(hue)
      }}
    />
  )
}

const NEUTRAL = 'rgba(255,255,255,0.7)'
const WARNING = '#e0a94a'
/** KIND_COLOR.enemy — the app's adverse hue, and deliberately not `error.main`. */
const ADVERSE = '#cf6679'
const KEPT = '#29b6f6'
/** The library's success hue - a decision recorded, not a fact observed. */
const WISHED = '#66bb6a'

/** `#rrggbb` → the same colour at 0.7, which is the library's outline alpha for a semantic chip. */
function alpha70(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  return `rgba(${String((n >> 16) & 255)}, ${String((n >> 8) & 255)}, ${String(n & 255)}, 0.7)`
}

export interface GearPlanRowChipsProps {
  signals: RowSignals
}

export default function GearPlanRowChips({ signals }: GearPlanRowChipsProps): JSX.Element | null {
  // A row with nothing to warn about wears nothing. An empty strip would still cost a line of
  // height on every ordinary row, which is most of them.
  if (!hasSignal(signals)) return null
  const { era, classFit, owned, wished } = signals
  return (
    <Box
      data-testid="gearplan-row-chips"
      sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.25 }}
    >
      {/* OWNED FIRST: it is the only one of the three that is good news, and it changes whether the
          other two even matter — a copy in your bank is a copy whatever the wiki says about era. */}
      {owned !== null && (
        <StateChip
          label={owned.label}
          hue={KEPT}
          title={
            owned.lootedOnly
              ? 'The log saw you loot this, and your newest dump does not name a copy - you may have sold, given away or destroyed it.'
              : 'Your newest inventory dump names a copy of this.'
          }
        />
      )}
      {/* SECOND, beside owned, because the two together are the whole acquisition story: you have
          one, you have asked for one, or neither. */}
      {wished && (
        <StateChip
          label="wishlisted"
          hue={WISHED}
          title="This is already on your wish list - adding it again will not duplicate the row."
        />
      )}
      {era !== null && (
        <StateChip
          label={era.label}
          hue={era.unknown ? NEUTRAL : WARNING}
          title={era.tooltip}
          data-testid="gearplan-chip-era"
        />
      )}
      {classFit === 'no' && (
        <StateChip
          label="wrong class"
          hue={ADVERSE}
          title="No class this item names is one your character is currently running. You can still plan it."
        />
      )}
      {classFit === 'unknown' && (
        <StateChip
          label="class?"
          hue={NEUTRAL}
          title="This item's page states no class list, so nothing here can say whether you can wear it."
        />
      )}
    </Box>
  )
}
