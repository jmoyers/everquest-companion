// gearplan/GearPlanItemPicker.tsx — "what goes in this cell?"
//
// `HostPicker.tsx` (JOS-326 deleted it with the plan board) revived over the gear plan document,
// with two changes and both of them are subtractions.
//
// 1. NO CLASS FILTER. The retired picker narrowed its hits against the SET's target trio, because
//    a set had one. There is no trio on this board (gearPlanRules.ts argues why the document is
//    better off without one), and the consequence is deliberate rather than unhandled: you CAN
//    plan a helm your character cannot wear. The ROW says so where it matters — the `wrong class`
//    chip rides on the option BEFORE you take it — which is the honest direction: a picker that
//    silently hides items answers "why is it not in the list" with nothing at all.
// 2. (WITHDRAWN.) This slot used to read "NO ERA OR OWNERSHIP DECORATION - the wish list owns
//    those by ruling; a plan is allowed to be aspirational". Both halves lost their case. Every row
//    now wears the full `GearPlanRowChips` strip, because where a thing drops and whether you hold
//    one are the two facts that decide whether a suggestion is any good, and a planner reading them
//    on the wish list AFTERWARDS is reading them a decision too late. The aspiration half survives
//    where it belongs - in the DEFAULTS: the three filters this picker honours all ship OFF, so an
//    untouched board still offers you everything.
//
// WHAT IS KEPT VERBATIM: the fixed-height scroll box (a popover that grows with its hit count
// walks off the screen), the icon, and an empty line that names WHICH reason applies rather than
// reporting a bare zero.
//
// ---------------------------------------------------------------------------------------------
// THE SLOT FILTER MOVED INTO MAIN, AND THE TWO-LETTER MINIMUM WENT WITH IT.
//
// The slot filter is R2 rather than tidiness: `equipSlotOf` is the wiki slot this cell wears, and
// an item that does not state it cannot go here. It used to be applied HERE, to main's answer —
// and that was a bug wearing a filter's clothes. Main caps a search at fifty hits ranked across
// eleven thousand items, so narrowing afterwards meant a FINGER cell searching "ri" kept whichever
// of fifty corpus-wide matches happened to be rings, while hundreds more sat unoffered. Main now
// takes the slot and narrows BEFORE its cap, so fifty hits means fifty usable ones.
//
// AND THAT IS WHAT RETIRED THE MINIMUM. Two letters were required because an unfiltered list of
// eleven thousand items answers nothing — true, and still true for a caller with no cell in mind
// (`MIN_QUERY` keeps saying so). But a slotted search offers a CLOSED set, and an unfiltered list
// of it IS the answer to "what can go here", which is the question somebody who has just opened an
// empty cell actually has. The picker now opens showing exactly that, which is the behaviour the
// donor picker has had all along.
//
// AN ANY-CELL IS THE EXCEPTION AND KEEPS THE MINIMUM. `equipSlotOf` answers `null` there, because
// the game gives you two places that constrain nothing (JOS-104) — so its haystack really is the
// whole corpus, and the rule the minimum exists for applies to it unchanged.

import { type JSX, useDeferredValue, useEffect, useState } from 'react'
import { Box, CircularProgress, Popover, Stack, TextField, Typography } from '@mui/material'
import type { ClassAbbr } from '@shared/classCombo'
import type { PlannerItemHit } from '@shared/planner/types'
import { equipSlotOf, planSlotLabel, type PlanSlotId } from '@shared/planner/types'
import { itemIconUrl } from '../../lib/ItemWindow'
import { MIN_QUERY, useItemSearch } from '../planner/plannerPreset'
import { PLANNER_PAGE, PLANNER_PAGE_MAX } from './gearPlanRules'
import { KnownItemTooltip } from '../../lib/KnownItemTooltip'
import GearPlanRowChips from './GearPlanRowChips'
import { hidesRow, type GearPlanRowFilter, type RowSignals } from './gearPlanSignals'

const LIST_MAX_H = 260

function HitRow({
  hit,
  signals,
  onPick
}: {
  hit: PlannerItemHit
  signals: RowSignals
  onPick: (h: PlannerItemHit) => void
}): JSX.Element {
  return (
    <Box
      data-testid="gearplan-item-hit"
      onClick={() => onPick(hit)}
      sx={{ px: 1, py: 0.5, cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
    >
    {/* WHAT AM I ABOUT TO PLAN? The name and the icon answer together, through the app's own item
        card - the same one the loot ledger, the mob rows and the gear comparison already hang off
        an item name. A picker that offers you a helm and cannot say what the helm DOES is asking
        you to leave and come back.

        `clickThrough` IS LOAD-BEARING ON THIS SURFACE ABOVE ALL OTHERS. Every row here is a click
        target, and the ordinary card is interactive: it would hold `pointer-events: auto` directly
        over the options underneath it, which is the exact defect JOS-127 filed on the loot ledger.
        The mode takes no pointer events and closes on POINTERDOWN, so the card is gone the instant
        you press to pick and the row beneath receives the click it was always going to get. */}
    <KnownItemTooltip name={hit.name} clickThrough>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'nowrap' }}>
        {hit.iconId !== undefined && (
          <Box
            component="img"
            src={itemIconUrl(hit.iconId)}
            alt=""
            onError={(e: React.SyntheticEvent<HTMLImageElement>) => {
              e.currentTarget.style.display = 'none'
            }}
            sx={{ width: 20, height: 20, imageRendering: 'pixelated', flexShrink: 0 }}
          />
        )}
        <Typography
          variant="body2"
          noWrap
          data-testid="gearplan-hit-name"
          sx={{ minWidth: 0, flexShrink: 1 }}
        >
          {hit.name}
        </Typography>
        <Box sx={{ flexGrow: 1, minWidth: 4 }} />
      </Stack>
    </KnownItemTooltip>
      {/* The three warnings, in one strip under the name — `class?` among them, which is why the
          old inline "class unknown" chip is gone rather than duplicated. */}
      <GearPlanRowChips signals={signals} />
    </Box>
  )
}

/**
 * Why the list is empty, in the words of whichever reason applies.
 *
 * THE FILTER REASON GOES FIRST once the slot has been satisfied, because it is the only one of the
 * four the reader can DO something about, and an empty list that blames the database for a choice
 * the user made two clicks ago is the exact dishonesty the filter bar exists to prevent.
 */
function emptyLine(
  q: { text: string; loading: boolean; slotted: boolean },
  filtered: number,
  label: string
): string {
  // The minimum survives for the ONE case it was written for: a cell that names no slot.
  if (!q.slotted && q.text.trim().length < MIN_QUERY) return 'Type at least two letters.'
  if (q.loading) return 'Searching…'
  if (filtered > 0) {
    return `${String(filtered)} ${filtered === 1 ? 'match fits' : 'matches fit'} this slot, and your filters are hiding ${filtered === 1 ? 'it' : 'them all'}.`
  }
  // Main narrowed by slot, so "nothing came back" now means the SLOT is empty of matches - which is
  // a different sentence from the old one and has to name the slot to be worth reading.
  if (q.text.trim() === '') {
    return `No item in the database states ${label} - an item can only be planned into a slot its page names.`
  }
  return `No item that fits ${label} matches that.`
}

export interface GearPlanItemPickerProps {
  /** which cell is being filled; `null` closes the popover */
  cell: PlanSlotId | null
  anchor: HTMLElement | null
  onClose: () => void
  onPick: (hit: PlannerItemHit) => void
  /** the row-warning fold, mounted once by the view — see `gearPlanSignalsHook.ts` */
  signalsOf: (subject: { key: string; classes?: readonly ClassAbbr[] }) => RowSignals
  /** what the page's filter bar is narrowing the pool to */
  filter: GearPlanRowFilter
  /** the shared `eq.planner.era` value, which is not one of `filter`'s fields */
  eraOnly: boolean
  /** how many slot-legal rows the filters just held back; `null` when this picker is closed */
  onHidden: (n: number | null) => void
}

export default function GearPlanItemPicker({
  cell,
  anchor,
  onClose,
  onPick,
  signalsOf,
  filter,
  eraOnly,
  onHidden
}: GearPlanItemPickerProps): JSX.Element {
  const [text, setText] = useState('')
  const query = useDeferredValue(text)
  // HOW MANY ROWS THIS PICKER HAS ASKED FOR. It resets with the question, because a page walked out
  // to four hundred for one query has nothing to do with the next one - carrying it over would make
  // an unrelated search silently expensive.
  const [limit, setLimit] = useState(PLANNER_PAGE)
  useEffect(() => {
    setLimit(PLANNER_PAGE)
  }, [query, cell])
  const open = anchor !== null && cell !== null
  // `undefined` for an any-cell, which is what keeps `MIN_QUERY` in force for it alone.
  const wanted = cell === null ? undefined : (equipSlotOf(cell) ?? undefined)
  const { hits, loading } = useItemSearch(query, open, wanted, limit)

  // Main has already applied R2's slot half, before its own cap — so every hit here is offerable
  // and there is nothing left to filter out. What remains is the USER's narrowing, below.
  const inSlot = hits

  // Signals are folded ONCE per row and then used twice - to decide and to draw. Calling
  // `signalsOf` again inside the map would ask the same three sources the same question a second
  // time for every row on screen.
  const rows = inSlot.map((hit) => ({ hit, signals: signalsOf(hit) }))
  const usable = rows.filter((r) => !hidesRow(r.signals, filter, eraOnly))
  const filtered = rows.length - usable.length
  // A FULL PAGE MEANS THERE MAY BE MORE. Main answers with at most `limit`, so a short answer is
  // proof it gave everything - the honest signal available without a second round trip for a count.
  const more = hits.length >= limit && limit < PLANNER_PAGE_MAX

  // The bar states the number; this picker is the only thing that knows it. Reported on close as
  // `null` rather than 0, because "nothing is hidden" and "nothing has been asked" are different.
  useEffect(() => {
    onHidden(open ? filtered : null)
  }, [open, filtered, onHidden])

  return (
    <Popover
      open={open}
      anchorEl={anchor}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      slotProps={{ paper: { sx: { width: 340 } } }}
    >
      <Box sx={{ p: 1 }}>
        <TextField
          autoFocus
          fullWidth
          size="small"
          label={cell === null ? 'Item' : `Item for ${planSlotLabel(cell)}`}
          value={text}
          data-testid="gearplan-item-search"
          onChange={(e) => setText(e.target.value)}
        />
      </Box>
      <Box sx={{ maxHeight: LIST_MAX_H, overflow: 'auto', borderTop: 1, borderColor: 'divider' }}>
        {usable.map(({ hit, signals }) => (
          <HitRow key={hit.key} hit={hit} signals={signals} onPick={onPick} />
        ))}
        {/* THE LIST NEVER TRUNCATES IN SILENCE. A capped list looks exactly like a complete one, and
            that is how `Patchwork Boots` - 51st of 362 items that fit a foot slot - read as "not in
            the database". The same rule the filter bar states about hidden rows: if the surface is
            holding something back, the surface says so and offers the way through. */}
        {more && (
          <Box
            data-testid="gearplan-item-more"
            onClick={() => setLimit((n) => Math.min(n + PLANNER_PAGE, PLANNER_PAGE_MAX))}
            sx={{
              px: 1,
              py: 0.75,
              cursor: 'pointer',
              borderTop: 1,
              borderColor: 'divider',
              '&:hover': { bgcolor: 'action.hover' }
            }}
          >
            <Typography variant="caption" color="primary.main">
              {`Showing ${String(usable.length)} - show more`}
            </Typography>
          </Box>
        )}
        {usable.length === 0 && (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1.5 }}>
            {loading && <CircularProgress size={14} />}
            <Typography variant="caption" color="text.secondary" data-testid="gearplan-item-empty">
              {emptyLine(
                { text, loading, slotted: wanted !== undefined },
                filtered,
                wanted ?? 'this slot'
              )}
            </Typography>
          </Stack>
        )}
      </Box>
    </Popover>
  )
}
