// planner/PlannerChips.tsx — the planner's shared atoms: the state chip, the era chip, the
// no-slot chip, and a donor NAME that links.
//
// ONE CHIP PER SOCKET (UI conventions: chips convey STATE, never process). The Inventory cell and
// the Farm row show the same four states in the same colours, so a socket you looked at on the
// Inventory tab is recognisable in the rollup without re-reading it.
//
// THE DONOR NAME CLICKS (owner, 2026-08-04) — it is the app's standing link idiom (`openLoot`,
// appRouting): it takes the Loot tab over with that item's drill-down.
//
// IT NO LONGER HOVERS (JOS-143), and that is the same removal JOS-127 made on the Loot ledger.
// The name used to anchor `KnownItemTooltip` (lib/): a `placement="top"`, up-to-380px, INTERACTIVE
// card that holds `pointer-events: auto` for as long as it is up. Donor names are ROWS, and on
// both planner surfaces the rows sit directly under a toolbar full of dropdowns — the Effects
// browser's Slot and Group by selects (EffectFilterBar) and the board's Classes chip-select
// (PlannerView). A card opened from the first row of either list lands on those controls and eats
// the clicks aimed at them. `placement="top"` is what aims it there; removal, not a flip, is the
// owner's direction. The click survives, and it goes somewhere strictly better: the drill-down
// states the item window AND what the committed DBs know (ItemDbSources, below).
//
// WHY THE DRILL-DOWN IS NOW A FAIR DESTINATION. It used to be exactly the wrong one — its "Dropped
// by / Zones" columns were built from OBSERVED loot events alone, so a donor you have never looted
// answered "Times looted 0 · No source recorded" one click after a planner row told you which mob
// in which zone drops it. That contradiction is what `features/loot/ItemDbSources.tsx` closes: the
// drill now also states what the committed DBs know, labelled `db` beside the `observed` columns.
// With both witnesses on screen, the deep link is a promotion, not a downgrade.
//
// THE FIVE STATE CHIPS LOST THEIRS TOO (JOS-143). They are default-placement, so they open DOWN
// rather than onto a toolbar — but they render on the SAME rows as the donor name, and a file that
// is half popper-free is a file whose rule cannot be stated or guarded. Every sentence is a native
// title now, which is what these chips wanted all along: one word on screen, the explanation on
// hover, and nothing in the DOM that can take a click.

import type { JSX } from 'react'
import { Box, Chip } from '@mui/material'
import { EQ_ITEM_COLORS } from '../../lib/ItemWindow'
import { eraChip, type EraSubject } from './plannerData'
import type { DonorProgress, DonorState } from './plannerProgress'

const CHIP_SX = { height: 18, fontSize: 10, '& .MuiChip-label': { px: 0.6 } } as const

type ChipColor = 'default' | 'primary' | 'success' | 'warning' | 'info'

const STATE_COLOR: Record<DonorState, ChipColor> = {
  planned: 'default',
  have: 'primary',
  partial: 'info',
  ready: 'success'
}

/** What each state MEANS, in the hover text — the chip itself stays one word. */
const STATE_HINT: Record<DonorState, string> = {
  planned: 'Nothing observed yet - no copy held, looted or merged.',
  have: 'You hold a copy, not yet merged.',
  partial: 'Merged to the tier shown, short of the extraction tier.',
  ready: 'The log saw this item merged to at least the tier its effect extracts at.'
}

/** The counts behind the chip, stated only when there are any (law 1: silence, not "0"). */
function evidence(progress: DonorProgress): string {
  const parts: string[] = []
  if (progress.held > 0) parts.push(`${String(progress.held)} in your last inventory dump`)
  if (progress.looted > 0) parts.push(`looted ${String(progress.looted)}×`)
  return parts.length === 0 ? '' : ` - ${parts.join(', ')}.`
}

/** The ONE state chip a planned socket carries. */
export function StateChip({ progress }: { progress: DonorProgress }): JSX.Element {
  return (
    <Chip
      size="small"
      label={progress.label}
      title={`${STATE_HINT[progress.state]}${evidence(progress)}`}
      data-testid="planner-state-chip"
      data-state={progress.state}
      color={STATE_COLOR[progress.state]}
      variant={progress.state === 'ready' ? 'filled' : 'outlined'}
      sx={CHIP_SX}
    />
  )
}

/**
 * The era chip, or nothing. An in-era donor says nothing at all (that is the normal case and
 * needs no decoration); `era?` means NOTHING states an era — not the catalog, not the item page's
 * own drop list, not its era banner — which is a fact about our tables, not about the item.
 *
 * The subject is the donor ROW wherever the caller has one, because the page's drop list and era
 * banner ride on it; a plan entry the corpus has no row for passes `{ key }` and gets the
 * catalog-only answer. `plannerData.eraChip` writes the hover text, so the chip never has to guess
 * which witness spoke.
 */
export function EraChip({ subject }: { subject: EraSubject }): JSX.Element | null {
  const info = eraChip(subject)
  if (info === null) return null
  return (
    <Chip
      size="small"
      label={info.label}
      title={info.tooltip}
      data-testid="planner-era-chip"
      color={info.unknown ? 'default' : 'warning'}
      variant="outlined"
      sx={CHIP_SX}
    />
  )
}

/**
 * THE CROWN (V5) — this row carries the highest tier of its focus family that the current filters
 * left visible.
 *
 * Worded as "of the ones on screen" on purpose: turn the era filter off and a Velious donor may
 * take the crown, which is honest rather than surprising. Every row at the top tier wears it — if
 * three items carry Improved Healing III, all three ARE the best, and picking one to crown would
 * be the planner inventing a preference between them.
 */
export function BestChip(): JSX.Element {
  return (
    <Chip
      size="small"
      label="best"
      title="The highest tier of this focus family among the visible donors."
      data-testid="planner-best-chip"
      color="primary"
      sx={CHIP_SX}
    />
  )
}

/**
 * THE CLASS MISMATCH (V2) — this donor is already in the build and no longer matches the set's
 * class filter.
 *
 * NOTHING IS REMOVED, and that is the decision this chip exists to make visible: the trio is a
 * FILTER, not a rule, so re-inference or a loadout switch can never invalidate work you already
 * planned. It can only point at it. Same family as the era chip on purpose — both say "this row
 * survives, and here is why it looks out of place".
 */
export function MismatchChip({ classes }: { classes: readonly string[] }): JSX.Element {
  return (
    <Chip
      size="small"
      label="off filter"
      title={`Usable by ${classes.join('/')}`}
      data-testid="planner-mismatch-chip"
      color="warning"
      sx={CHIP_SX}
    />
  )
}

/**
 * NO EQUIP SLOT — the R2 disqualifier, stated rather than assumed.
 *
 * An exaltation can only be socketed into an item sharing the donor's equipment slot, so a donor
 * with no slot can never legally donate; the browser's default filter drops these entirely and
 * this chip only ever appears once the escape toggle is on. It is worded as a fact about the PAGE,
 * not about the game (law 1): an empty slot list means the wiki stated none, which is nearly
 * always a consumable and occasionally a gap in the scrape.
 */
export function NoSlotChip(): JSX.Element {
  return (
    <Chip
      size="small"
      label="no slot"
      title="This page states no equipment slot, so its effect can never move."
      data-testid="planner-noslot-chip"
      color="warning"
      variant="outlined"
      sx={CHIP_SX}
    />
  )
}

/**
 * An item name: the Loot drill-down on CLICK.
 *
 * `onOpen` is optional and the cursor follows it exactly — a hand only ever appears where a click
 * actually goes somewhere (the complaint behind e8d0fd0's cursor fix). Without it the name is
 * plain text and keeps the default cursor, which is what a name in a non-routed context should be.
 *
 * The name ELLIPSIZES, so it carries a native `title` — the full name with no DOM node and no hit
 * area, which is the one thing the removed card did that nothing else on the row does.
 */
export function DonorName({
  name,
  bold,
  onOpen
}: {
  name: string
  bold?: boolean
  onOpen?: (name: string) => void
}): JSX.Element {
  const linked = onOpen !== undefined
  return (
    <Box
      component="span"
      data-testid="planner-donor-name"
      title={name}
      onClick={linked ? () => onOpen(name) : undefined}
      sx={{
        color: EQ_ITEM_COLORS.name,
        fontWeight: bold === true ? 600 : 400,
        textDecoration: 'underline dotted',
        textUnderlineOffset: 2,
        cursor: linked ? 'pointer' : 'default',
        ...(linked ? { '&:hover': { textDecoration: 'underline' } } : {}),
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }}
    >
      {name}
    </Box>
  )
}
