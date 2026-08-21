// planner/PlannerView.tsx — the EXALTATIONS tab: SEARCH, and nothing else (JOS-326).
//
// THE TAB IS CALLED EXALTATIONS (owner, 2026-08-06, JOS-42). "Planner" named what the surface did
// for us; "Exaltations" names the game system a player came here about. The rename is a LABEL —
// the `planner` view id, its route, its `eq.planner.*` keys and every `planner-*` testid are
// unchanged, because renaming those would be a refactor with no user on the other end of it.
//
// WHAT THIS TICKET TOOK OUT, AND WHY THAT LEAVES THE SURFACE BETTER. The tab used to be a shell
// around three modes over a SELECTED SET: Effects picked what you wanted, Inventory laid it over
// the gear you were wearing, Farm turned what was missing into a route. The set switcher, the
// three-mode toggle, the board (PlanBoard/PlanCell/HostPicker) and the Farm rollup are all gone.
// What remains is the one thing a player actually comes to this tab to do — LOOK SOMETHING UP —
// and the thing they do next now has a surface of its own, one tab over.
//
// THE BROWSER IS RETAINED WHOLESALE, WHICH IS THE HARD CONSTRAINT OF THE TICKET. Every grouping
// axis, every donor row, the class and era filters, the non-equippable escape hatch, the item
// narrowing, the detected-classes chip and the search box are exactly what they were. Nothing that
// could find something was allowed to be lost in the removal; the only capability that went is the
// one whose destination no longer exists (writing a socket of a cell of a set).
//
// SO THE ADD BUTTON GOES SOMEWHERE ELSE, AND THAT IS THE WHOLE SEAM BETWEEN THE TWO TABS. A donor
// row's action used to be "add to set" (which cell? replacing what?); it is now "add to wish list",
// which is one click and is deduped by the item — so the browse answers "what do I want" and the
// Wish list answers "and where do I go and get it".
//
// …AND SINCE JOS-343 IT IS A TOGGLE, which retires the "cannot destroy anything" half of that
// sentence rather than qualifying it (owner ruling 2026-08-13). A donor already on the list reads
// REMOVE and a second click takes it off, through `useWishlist.remove` — the Wish list tab's own
// deletion, not a second one. The control is now literally the same component the gear search row
// draws (`features/wishlist/WishToggle.tsx`), which is the parity the ruling was about.
//
// THE EXALTPLANS STORE IS STILL ON DISK AND STILL SERVED. Nothing in this file reads it any more;
// the wish list's one-time seed does, which is how the sockets somebody planned survive the board
// that drew them (features/wishlist/wishSeed.ts).
//
// ONE NOWRAP TOOLBAR ROW (the flexWrap law) — much shorter than it was: the class filter, the
// disagree chip when detection has something to offer, and the permanent `?`, which since JOS-51
// is the ONLY way the rules card ever appears (V10).

import { type JSX, useEffect, useMemo } from 'react'
import { Box, Chip, IconButton, Stack } from '@mui/material'
import HelpOutlineIcon from '@mui/icons-material/HelpOutline'
import { CLASS_ABBRS, MAX_COMBO_SLOTS, resolvedClasses, type ClassAbbr } from '@shared/classCombo'
import { classDisplayName } from '@shared/spellLevels'
import { useComboSnap } from '../profiles/ClassComboData'
import { useWishlist } from '../wishlist/useWishlist'
import { wishFromDonor } from '../wishlist/wishSearch'
import ChipMultiSelect from '../../components/ChipMultiSelect'
import EffectBrowser from './EffectBrowser'
import { boundClasses, detectedOffer } from './plannerClasses'
import type { DonorRow } from './plannerData'
import RulesExplainer, { useExplainer } from './RulesExplainer'
import { useBrowseClasses, type BrowseClassesApi } from './useBrowseClasses'

/**
 * The browse's target classes — the SAME closed-list multi-select the Sky tracker filters with
 * (planner-v2 V3), inline in the toolbar rather than behind a dialog, because a filter has to LOOK
 * mutable to read as a filter. Capped at MAX_COMBO_SLOTS; empty stays legal and means "no class
 * filter" (law 1), which is what the placeholder says while it is empty.
 *
 * `minWidth` is the control's FLOOR, not its width: it gives space back to the row until it hits
 * that floor. 240 was measured against a row that also carried the set switcher and the mode
 * toggle; the row is much emptier now, so the floor is never reached — it stays because a floor
 * that is never hit costs nothing and a window can always be narrower than the one it was measured
 * in.
 */
function ClassFilter({ classes }: { classes: BrowseClassesApi }): JSX.Element {
  // NO tooltip on this control (owner, 2026-08-05): a hover box over an input the user TYPES
  // into floats exactly where the dropdown opens and reads as the UI blocking itself. The
  // socketing-semantics explanation this used to carry belongs to the explainer card (W-G),
  // not to a popper racing the option list.
  return (
    <ChipMultiSelect
      options={CLASS_ABBRS}
      value={classes.classes}
      onChange={(next) => classes.set(next)}
      label="Classes"
      placeholder="All classes"
      optionLabel={classDisplayName}
      max={MAX_COMBO_SLOTS}
      minWidth={240}
      testId="planner-classes"
    />
  )
}

/**
 * THE DISAGREE CHIP (V2) — "detected: Paladin, Enchanter, Monk - apply". It says the CLASSES, not
 * the /who codes, since JOS-402: the control it sits beside picks by full name now, and a chip that
 * answered it in a second vocabulary would read as a different kind of thing.
 *
 * Shown only while the filter is PINNED and live inference has resolved a different trio. It never
 * changes anything on its own: the whole point of the chip idiom here is that the app states what
 * it thinks and the click is the user's. Applying does NOT un-pin the filter either — accepting one
 * answer is not handing it back to inference.
 */
function DetectedChip({ offer, onApply }: { offer: ClassAbbr[]; onApply: () => void }): JSX.Element {
  return (
    // No popper (JOS-143). This chip renders IMMEDIATELY after ClassFilter on a nowrap row, so its
    // card opened into the same space the chip-select's option list uses — which is the hover box
    // ClassFilter's own comment already refused, arriving one control to the right instead.
    <Chip
      size="small"
      color="warning"
      variant="outlined"
      data-testid="planner-detected-chip"
      title="Use the combo detected from your log"
      label={`detected: ${offer.map(classDisplayName).join(', ')} - apply`}
      onClick={onApply}
      sx={{ flexShrink: 0 }}
    />
  )
}

export interface PlannerViewProps {
  /**
   * Deep-link an item name into the Loot tab's drill-down (App's `openLoot`). Optional so the
   * pane still renders standalone; every donor name becomes a link when it is supplied, and stays
   * a pure hover surface when it is not.
   */
  onOpenLoot?: (item: string) => void
}

export default function PlannerView({ onOpenLoot }: PlannerViewProps = {}): JSX.Element {
  const classes = useBrowseClasses()
  const combo = useComboSnap()
  const explainer = useExplainer()
  // The wish list is mounted HERE only so the browse can add to it and mark what is already on it.
  // Coexisting mounts stopped mattering in JOS-346: the hook holds ONE document for the window, so
  // every surface is looking at the same object rather than at its own copy of it.
  const wishlist = useWishlist()

  // What the app currently believes this character is running. An unresolved slot contributes
  // nothing, so a half-known combo yields the classes it does know and nothing it doesn't (law 1).
  const current = combo.current
  const detected = useMemo(() => (current === null ? [] : resolvedClasses(current)), [current])

  // THE BINDING (V2): a filter whose trio came from detection tracks detection. `boundClasses`
  // returns null once they agree, so this settles after one write rather than looping.
  const subject = { classes: classes.classes, classesProvenance: classes.provenance }
  const bound = boundClasses(subject, detected)
  const offer = detectedOffer(subject, detected)
  const { adopt } = classes
  useEffect(() => {
    if (bound !== null) adopt(bound)
  }, [bound, adopt])

  const wished = useMemo(
    () => new Set(wishlist.list.entries.map((e) => e.itemKey)),
    [wishlist.list]
  )
  // JOS-343 — ONE GESTURE, BOTH DIRECTIONS. The owner overruled the disabled-when-wished button on
  // 2026-08-13: a second click on a donor already on the list TAKES IT OFF. The removal door is
  // `useWishlist.remove`, which is the same `removeWish` fold WishlistView's own per-row remove
  // calls — there is one deletion in this app and this is not a second copy of it.
  //
  // THE ROW HANDS BACK THE STATE IT WAS DRAWN IN rather than this closing over `wished`: the set is
  // rebuilt on every edit, and a handler that depended on it would change identity on every click.
  const toggleDonor = (donor: DonorRow, wasWished: boolean): void => {
    if (wasWished) wishlist.remove(donor.key)
    else wishlist.add(wishFromDonor(donor, Date.now()))
  }
  // …AND NOTHING IS HANDED DOWN UNTIL THE DOCUMENT IS LOADED, which is the gear table's rule
  // (JOS-335) arriving here because the toggle gave this tab the same reason to need it. Until
  // `ready`, `wished` is an empty DEFAULT rather than an answer — a one-way add survived reading it
  // wrong (the click was an add either way), a toggle does not: it would send the click the other
  // way. The e2e caught it on this ticket's first run — a remounted browse offered an unadded
  // control for a donor that was on the list, and the click removed the wish instead of adding one.
  const donorToggle = wishlist.ready ? toggleDonor : undefined

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }} data-testid="planner-view">
      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'nowrap', mb: 1.5 }}>
        <ClassFilter classes={classes} />
        {offer !== null && <DetectedChip offer={offer} onApply={() => classes.adopt(offer)} />}
        <Box sx={{ flexGrow: 1, minWidth: 8 }} />
        <IconButton
          size="small"
          aria-label="How exaltation works"
          title="How exaltation works"
          data-testid="planner-explainer-open"
          onClick={explainer.show}
          sx={{ flexShrink: 0 }}
        >
          <HelpOutlineIcon fontSize="small" />
        </IconButton>
      </Stack>

      {explainer.open && <RulesExplainer onDismiss={explainer.dismiss} />}

      <EffectBrowser
        classes={classes.classes}
        wished={wished}
        onToggleWish={donorToggle}
        onOpenLoot={onOpenLoot}
      />
    </Box>
  )
}
