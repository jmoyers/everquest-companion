// gearplan/GearPlanDonorPicker.tsx — "what can go in THIS socket of THIS item?"
//
// `ItemFilterPicker.tsx`'s shape (popover, deferred query, fixed-height list, an empty line that
// names its reason) over the donor corpus instead of the item index. Four differences, each with a
// reason:
//
// 1. NO IPC. `useDonors()` is already module-cached in this window — the corpus is compiled-in
//    bytes served once per window — so the legal set is a filter over ~1.5k rows rather than a
//    round trip. That is also why this is a second component and not a mode of the item picker:
//    one asks main a question, the other asks an array.
// 2. AN EMPTY QUERY LISTS. The legal set for one socket of one cell is small and CLOSED, so the
//    picker opens showing what fits — an unfiltered list IS the answer to "what are my options",
//    which is the question somebody standing on an empty socket actually has. The item picker has
//    since adopted this too (main narrows it by slot before its cap, which closes its set the same
//    way), so the two now open the same way; only an any-cell still asks you to type.
// 3. THE COST LINE IS READ FROM THE RULE. `extractionCost(donor.tierRequired)` — never a number
//    typed here. `RulesExplainer.costLine()` is the model, and the reason is R4: if the merge
//    ladder is ever corrected, every surface that quotes it moves at once.
// 4. IT WEARS THE ROW WARNINGS, AND HONOURS THE PAGE'S FILTERS. Era, class fit, "you already own
//    one" and "it is already on your wish list" ride under every row (`GearPlanRowChips`), because
//    all four change whether a suggestion is any good - and the page's filter bar can narrow the
//    list to any combination of them. The bar is shared with the item picker deliberately: "only
//    things I can get" is ONE preference, and setting it per-popover is how two surfaces end up
//    disagreeing about what was asked for.
//
// EVERY ROW EXPLAINS ITSELF IN ITS OWN SECOND LINE, which is the design library's rule for a
// picker verbatim: "where a picker's options need explaining, the explanation goes in the options
// - a secondary line per row - not in a hover card that cannot safely mount over a toolbar." That
// rule is honoured, not replaced: the donor, the one-liner, the cost and the warnings are all
// PERMANENT text on the row. The hover card is the depth BELOW that, for the row you have already
// narrowed to - never the only place a fact lives.
//
// ---------------------------------------------------------------------------------------------
// THE FULL SPELL DETAIL IS A HOVER CARD, THE SAME ONE A PLANNED SOCKET WEARS.
//
// A one-liner ("Detrimental · Single · Instant") is not enough to choose a proc by — you want the
// numbers, the duration, the messages, the class levels. The app already renders exactly that:
// `lib/SpellCard`, which every other surface reaches through `SpellTooltip`.
//
// THIS USED TO BE A PER-ROW DISCLOSURE, expanding the card inline behind a chevron, on the grounds
// that house law 8 — "a popper may never cover a control" — names "any table row" and "a combobox's
// own bar" among the no-popper zones, and these rows are both. The reasoning was wrong twice over:
//
//   1. A NON-INTERACTIVE TOOLTIP CANNOT COVER A CONTROL. `SpellTooltip` passes `disableInteractive`,
//      and MUI gives a non-interactive popper `pointer-events: none` (Tooltip.js, the base `popper`
//      style). Clicks pass straight through it to the row underneath. "Covering" in that law means
//      INTERCEPTING; a card that cannot take a click is not in the way of one.
//   2. AT `placement="right"` IT IS NOT EVEN OVER THE LIST. The picker is a 360px popover anchored
//      to one cell; a card opening to the right of a row lands beside it, over the board, which is
//      scenery. The search box it was supposed to threaten is above and to the left.
//
// AND CONSISTENCY IS THE REST OF THE ARGUMENT. A planned exaltation on a cell explains itself on
// HOVER. If choosing one required finding and clicking a chevron instead, the app would be teaching
// two different gestures for one question — "what does this effect do" — asked four inches apart.
// House law 7 is about components, but the same reasoning covers gestures: one question, one move.
//
// WHAT THE OLD SHAPE NEEDED AND THIS ONE DOES NOT: a `stopPropagation` to keep reading a row apart
// from choosing it. There is no second click to keep apart any more, because reading is not a click.
//
// THE CARD IS STILL ONLY MOUNTED WHILE IT IS OPEN. `SpellCard` fetches on mount (`lookupSpell` per
// name), and a tooltip mounts its title on hover — so a list of a hundred rows still costs zero
// lookups until a pointer lands on one, which is the property the `Collapse` was chosen for.

import { type JSX, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { Box, Popover, Stack, TextField, Typography } from '@mui/material'
import { effectOneLiner } from '@shared/planner/effectText'
import { extractionCost } from '@shared/planner/rules'
import { planSlotLabel, type PlannerDonor } from '@shared/planner/types'
import { useDonors } from '../planner/plannerData'
import { donorPickerRows, type CellContext } from './gearPlanRules'
import { SpellTooltip } from '../../lib/SpellCard'
import GearPlanRowChips from './GearPlanRowChips'
import { hidesRow, type GearPlanRowFilter, type RowSignals } from './gearPlanSignals'

const LIST_MAX_H = 260
/** A closed legal set is small; this is a runaway guard, not a product decision. */
const LIST_LIMIT = 120

/** "≈15 ordinary copies, or 1 from the hardest tier" — R4, asked rather than typed. */
function costLine(donor: PlannerDonor): string {
  const cost = extractionCost(donor.tierRequired)
  return `+${String(cost.tier)} to extract · ≈${String(cost.d0Copies)} ordinary copies, or ${String(cost.d4Copies)} from the hardest tier`
}

/**
 * ONE OPTION. The WHOLE ROW is the hover anchor, not just the effect name — a row is already the
 * click target, so making a smaller strip of it the read target would be two different shapes for
 * one line. There is no second control in here at all now, which is why the row needs no
 * `stopPropagation`: every gesture it can receive means the same thing.
 */
function DonorHit({
  donor,
  signals,
  onPick
}: {
  donor: PlannerDonor
  signals: RowSignals
  onPick: (d: PlannerDonor) => void
}): JSX.Element {
  const says = effectOneLiner(donor)
  return (
    <SpellTooltip name={donor.effect} placement="right">
      <Box
        data-testid="gearplan-donor-hit"
        onClick={() => onPick(donor)}
        sx={{ px: 1.5, py: 0.5, cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
      >
        <Stack direction="row" alignItems="center" spacing={0.5} sx={{ flexWrap: 'nowrap' }}>
          <Typography variant="body2" noWrap sx={{ minWidth: 0, flexGrow: 1 }}>
            {donor.effect}
          </Typography>
        </Stack>
        <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
          {donor.name}
        </Typography>
        {/* THE ONE-LINER STAYS even though the card says more. It is what you read while SCANNING
            twenty rows; the card is what you read once you have narrowed to one. Deleting it would
            make every comparison a hover. */}
        {says !== '' && (
          <Typography variant="caption" color="text.disabled" noWrap sx={{ display: 'block' }}>
            {says}
          </Typography>
        )}
        <Typography variant="caption" color="text.disabled" noWrap sx={{ display: 'block' }}>
          {costLine(donor)}
        </Typography>
        <GearPlanRowChips signals={signals} />
      </Box>
    </SpellTooltip>
  )
}

export interface GearPlanDonorPickerProps {
  /** the cell and socket being filled, plus the planned item's classes; `null` closes it */
  ctx: CellContext | null
  anchor: HTMLElement | null
  ready: boolean
  onClose: () => void
  onPick: (donor: PlannerDonor) => void
  /** the row-warning fold, mounted once by the view — see `gearPlanSignalsHook.ts` */
  signalsOf: (subject: PlannerDonor) => RowSignals
  /** clear whatever is planned in this socket — `null` when it is already empty */
  onClear: (() => void) | null
  /** what the page's filter bar is narrowing the pool to */
  filter: GearPlanRowFilter
  /** the shared `eq.planner.era` value, which is not one of `filter`'s fields */
  eraOnly: boolean
  /** how many legal donors the filters just held back; `null` when this picker is closed */
  onHidden: (n: number | null) => void
}

export default function GearPlanDonorPicker({
  ctx,
  anchor,
  ready,
  onClose,
  onPick,
  signalsOf,
  onClear,
  filter,
  eraOnly,
  onHidden
}: GearPlanDonorPickerProps): JSX.Element {
  const [text, setText] = useState('')
  const query = useDeferredValue(text)
  const open = anchor !== null && ctx !== null
  const { donors } = useDonors()

  const legal = useMemo(
    () => (ctx === null ? [] : donorPickerRows(donors, ctx, query, LIST_LIMIT)),
    [donors, ctx, query]
  )

  // Folded once and used twice - to decide and to draw. R2 has already run inside
  // `donorPickerRows`; this narrowing is the USER's, and it is applied strictly after the rules so
  // an empty list can say which of the two emptied it.
  const scored = legal.map(({ donor }) => ({ donor, signals: signalsOf(donor) }))
  const rows = scored.filter((r) => !hidesRow(r.signals, filter, eraOnly))
  const filtered = scored.length - rows.length

  useEffect(() => {
    onHidden(open ? filtered : null)
  }, [open, filtered, onHidden])

  const label = ctx === null ? '' : `${ctx.socket} for ${planSlotLabel(ctx.cell)}`

  return (
    <Popover
      open={open}
      anchorEl={anchor}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      slotProps={{ paper: { sx: { width: 360 } } }}
    >
      <Box sx={{ p: 1 }}>
        <TextField
          autoFocus
          fullWidth
          size="small"
          label={label}
          value={text}
          data-testid="gearplan-donor-search"
          onChange={(e) => setText(e.target.value)}
        />
      </Box>
      {onClear !== null && (
        <Box
          data-testid="gearplan-donor-clear"
          onClick={onClear}
          sx={{
            px: 1.5,
            py: 0.5,
            cursor: 'pointer',
            borderTop: 1,
            borderColor: 'divider',
            '&:hover': { bgcolor: 'action.hover' }
          }}
        >
          <Typography variant="body2" color="text.secondary">
            Clear this socket
          </Typography>
        </Box>
      )}
      <Box sx={{ maxHeight: LIST_MAX_H, overflow: 'auto', borderTop: 1, borderColor: 'divider' }}>
        {rows.map(({ donor, signals }) => (
          <DonorHit
            key={`${donor.key}:${donor.effect}`}
            donor={donor}
            signals={signals}
            onPick={onPick}
          />
        ))}
        {rows.length === 0 && (
          <Box sx={{ p: 1.5 }}>
            <Typography variant="caption" color="text.secondary" data-testid="gearplan-donor-empty">
              {!ready
                ? 'Reading the effect database…'
                : filtered > 0
                  ? `${String(filtered)} ${filtered === 1 ? 'effect fits' : 'effects fit'} this socket, and your filters are hiding ${filtered === 1 ? 'it' : 'them all'}.`
                  : query.trim() === ''
                    ? 'Nothing in the database can go in this socket - no effect of this kind shares a slot and a class with this item.'
                    : 'No effect that fits this socket matches that.'}
            </Typography>
          </Box>
        )}
      </Box>
    </Popover>
  )
}
