// wishlist/WishToggle.tsx — ONE CONTROL, BOTH SURFACES: add this thing to the wish list, click it
// again to take it off (JOS-343, owner ruling 2026-08-13).
//
// WHY THIS FILE EXISTS AT ALL. Until this ticket there were two controls that meant the same thing
// and agreed about none of it. The Exaltations donor row had a TEXT button reading "Add to wish
// list" that went DISABLED and read "Wished" once the item was on (JOS-326); the gear search row —
// added one day earlier — had a HEART that lit up and, lit, did nothing (JOS-335). The owner ruled
// the same day the heart shipped: the gear row gets the donor row's control, and BOTH of them
// toggle. Two components that must stay word-for-word identical is a rule nobody can enforce, so
// there is one component and the two surfaces differ by a prop.
//
// THE OVERRULED ARGUMENTS, NAMED, because both were written down as reasoning and both are now
// wrong — a revision that leaves its predecessor's case standing is how a file starts lying:
//
//   * "THE GEAR ROW MUST BE AN ICON" (JOS-335, GearTable.tsx `WishButton`). The case was width: a
//     `tableLayout: fixed` name column against a ~130px text button on 6,766 rows. OVERRULED for
//     parity — the two surfaces are one feature and must read as one.
//   * "…AND THE GEAR ROW GETS SHORTER WORDS" (JOS-343, the `compact` prop this file used to carry:
//     Wish / Remove for the dense table, measured against the Item column in the e2e). OVERRULED
//     IN TURN by the owner on 2026-08-13 (JOS-346): same words both places, and the width cost is
//     ACCEPTED rather than measured around. Half-parity was the worst of the two — a reader who
//     learns the control on one tab meets a different pair of words on the other and has to work
//     out that they are the same thing. The measurement that pinned the short wording went with
//     it: an assertion that a control fits under a third of its column is an assertion that the
//     SHORT wording is in force, so keeping it would have failed on the ruling rather than
//     testing it.
//   * "LIT IS A NO-OP" / "WISHED IS DISABLED". Both surfaces used to answer a second click with
//     nothing — the donor row by refusing it, the gear row by swallowing it. OVERRULED: a second
//     click REMOVES the wish, through `useWishlist.remove`, which is the same `removeWish` fold the
//     Wish list tab's own per-row remove calls. There is exactly one deletion shape in the app.
//
// THE TITLE STATES THE ACTION FOR THE STATE THE CONTROL IS IN, never the state itself. "Add to the
// wish list" when it is off, "Remove from the wish list" when it is on — a caption on a toggle is
// read as a prediction of the click, and one that reported status instead ("Already on your wish
// list") is what made the old heart's second click feel broken.
//
// NATIVE `title`, NEVER A POPPER (JOS-143). Both hosts are dense scrolling rows under a toolbar of
// dropdowns, and GearTable.tsx's header holds the full argument plus the one narrow exception the
// owner granted it (the hover compare card, which is not interactive and never opens upward).

import { type JSX } from 'react'
import { Box, Button } from '@mui/material'

/**
 * The two sentences, in ONE place, so the parity the owner ruled for cannot drift apart again.
 * They are the whole explanation on either surface — no popper, no helper text, no chip carrying
 * half the meaning.
 */
export const WISH_ADD_TITLE = 'Add to the wish list, where it joins the route grouped by where it drops.'
export const WISH_REMOVE_TITLE = 'Remove from the wish list. It comes off the route with it.'

/**
 * The words on the button — ONE PAIR, on every surface (JOS-346). There is no per-host wording any
 * more: the owner's parity ruling is about what the control SAYS, and a second pair of words is
 * exactly the drift the shared component was made to stop.
 */
const LABEL = { add: 'Add to wish list', remove: 'Remove from wish list' } as const

/**
 * THE COMPACT PAIR RETURNS (user ruling, 2026-08-15), overruling JOS-346's same-words-everywhere
 * for ONE surface: the gear table's control moved out of the Item cell into its own `WL` column,
 * where the header carries the words and a 168px button would be wider than the column it sits in.
 * The donor row keeps the full pair; both use this one component, so the drift JOS-346 feared is
 * still impossible — there is exactly one place either pair is spelled.
 */
const LABEL_COMPACT = { add: 'Add', remove: 'Remove' } as const

export interface WishToggleProps {
  /** the item's name — the accessible label says which row this control belongs to */
  name: string
  /** already on the wish list; the control reads its added state, and a click REMOVES */
  wished: boolean
  /**
   * The control cannot act at all — the Exaltations donor with no equipment slot, which can never
   * donate (R2) and is chipped `no slot` beside this button saying so. NOT used for "already
   * wished": that state is now the REMOVE half of a toggle, not a dead end.
   */
  disabled?: boolean
  /** `gear-wish` on the search row, `planner-add` on the donor row — both predate this file */
  testId: string
  /** the `WL` column's short pair (2026-08-15) — see `LABEL_COMPACT` for the ruling */
  compact?: boolean
  /** add when off, remove when on. The host owns which door; this control owns the reading. */
  onToggle: () => void
}

/**
 * ADD / REMOVE, in the state it is in. `data-wished` is the machine-readable half of the same
 * statement the words make, and both e2e steps read it rather than the label — the wording is a
 * product decision and a spec pinned to it would fail on the next one.
 */
export default function WishToggle({
  name,
  wished,
  disabled = false,
  testId,
  compact = false,
  onToggle
}: WishToggleProps): JSX.Element {
  const label = compact ? LABEL_COMPACT : LABEL
  return (
    <Button
      size="small"
      data-testid={testId}
      data-wished={wished ? 'true' : undefined}
      color={wished ? 'success' : 'primary'}
      disabled={disabled}
      aria-label={wished ? `Remove ${name} from your wish list` : `Add ${name} to your wish list`}
      title={wished ? WISH_REMOVE_TITLE : WISH_ADD_TITLE}
      onClick={onToggle}
      // ONE STATED WIDTH FOR BOTH LABELS, so the button does not RESIZE when it is clicked: both
      // surfaces sit in a `nowrap` row where a control that grew mid-click would shove the text
      // beside it. 168 is the wider of the pair, "Remove from wish list".
      //
      // …AND IT SHRINKS, WHICH IS THE WIDTH COST BEING PAID RATHER THAN PASSED ON (JOS-346). The
      // control used to refuse to shrink at all, which was free while the gear table had the short
      // wording and is not free now: the Item column is a share of a fixed table, and at a narrow
      // pane with the era chip up, an unshrinkable 168px control took the whole cell and left the
      // ITEM NAME at zero width — an unreadable, unclickable row (caught by gear.e2e.mts's Back
      // round trip, which clicks that name). So both give: the flex line shrinks the name and this
      // control in proportion, each keeps a legible share, and the label clips with the full
      // sentence still in `title`. Same width for both states either way, so a click never resizes.
      // 66 is the compact pair's wider word, "Remove" — the same one-width-for-both-states rule,
      // and small enough to sit whole inside the WL column at the 900px window minimum.
      sx={{ flexShrink: 1, width: compact ? 66 : 168, minWidth: 0 }}
    >
      <Box component="span" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {wished ? label.remove : label.add}
      </Box>
    </Button>
  )
}
