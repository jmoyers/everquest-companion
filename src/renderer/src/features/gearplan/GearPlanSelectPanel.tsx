// gearplan/GearPlanSelectPanel.tsx — choosing an item for one cell, in the right-hand column.
//
// THIS WAS A POPOVER, AND THE POPOVER WAS THE WRONG CONTAINER. `GearPlanItemPicker` anchored a
// 340px card to the cell you clicked, which left no room to say the one thing you are choosing BY —
// what each candidate would change about what you are wearing. Cramming sixteen stat deltas into
// that width would have made a list nobody could scan.
//
// The 380px totals panel sits idle during exactly that moment. So while a cell is being filled, the
// column shows the SELECTION instead of the sum, and hands it the room. Three things follow, and
// each of them was a defect in the popover:
//
//   1. IT IS NOT MODAL. A `Popover` has a backdrop, so while one was open the filter bar above it
//      could be READ but not CLICKED — a click out there dismissed the picker instead of toggling
//      a chip, and `GearPlanFilterBar`'s header had to document that as a limitation. A panel takes
//      no backdrop: the chips, the board and every other cell stay live while you choose.
//   2. NOTHING CAN OPEN OFF-SCREEN. An anchored card near the window's bottom edge is clipped by
//      it; a column is laid out, not positioned.
//   3. THE BOARD STAYS VISIBLE, so the cell being filled is on screen next to its own candidates,
//      and clicking a different cell just re-aims the panel rather than closing and reopening it.
//
// WHAT IS KEPT FROM THE POPOVER, because it was right there: the deferred query, main's slot-first
// search, the "show more" walk-up to `PLANNER_PAGE_MAX`, the row warning chips, the pool filter,
// and an empty line that names WHICH reason applies rather than reporting a bare zero.
//
// THE PANEL OWNS ITS OWN SCROLLER and the card owns the height it was given (`DashCard fill`), so
// a list of four hundred rows scrolls inside a column that fits — the same bounded-layout law the
// totals panel it replaces already obeys.

import { type JSX, useDeferredValue, useEffect, useState } from 'react'
import { Box, CircularProgress, Link, Stack, TextField, Typography } from '@mui/material'
import type { ClassAbbr } from '@shared/classCombo'
import type { CellDelta } from '@shared/planner/gearPlanTotals'
import type { PlannerItemHit } from '@shared/planner/types'
import { equipSlotOf, planSlotLabel, type PlanSlotId } from '@shared/planner/types'
import { DashCard } from '../combat/combatShared'
import { itemIconUrl } from '../../lib/ItemWindow'
import { MIN_QUERY, useItemSearch } from '../planner/plannerPreset'
import GearPlanDeltaLine from './GearPlanDeltaLine'
import GearPlanRatioLine from './GearPlanRatioLine'
import type { WeaponRead } from './gearPlanFold'
import GearPlanRowChips from './GearPlanRowChips'
import { beatsWornOn, pickScore } from '@shared/planner/gearPlanStatPick'
import ToggleChip from '../../components/ToggleChip'
import type { GearStatKey, GearStats } from '@shared/planner/gear'
import { PLANNER_PAGE, PLANNER_PAGE_MAX } from './gearPlanRules'
import { hidesRow, type GearPlanRowFilter, type RowSignals } from './gearPlanSignals'

/**
 * ONE CANDIDATE: what it is, what it would change, and what is worth warning about.
 *
 * THE DELTA IS THE REASON THIS PANEL EXISTS, so it is permanent text rather than a hover — you are
 * comparing candidates against each other, and a fact you have to hover for cannot be compared with
 * a fact you have to hover for somewhere else.
 *
 * `null` and `[]` say different things and are drawn differently: `null` is "nothing to compare
 * against" (no dump, or that cell is empty on your body) and shows nothing at all; `[]` is
 * "compared, and it changes nothing", which is a real answer about a real candidate.
 */
function CandidateRow({
  hit,
  signals,
  delta,
  weapon,
  onPick
}: {
  hit: PlannerItemHit
  signals: RowSignals
  delta: CellDelta[] | null
  weapon: WeaponRead | null
  onPick: (h: PlannerItemHit) => void
}): JSX.Element {
  return (
    <Box
      data-testid="gearplan-item-hit"
      onClick={() => onPick(hit)}
      sx={{
        px: 1,
        py: 0.75,
        cursor: 'pointer',
        borderTop: 1,
        borderColor: 'divider',
        '&:hover': { bgcolor: 'action.hover' }
      }}
    >
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
        <Typography variant="body2" noWrap data-testid="gearplan-hit-name" sx={{ minWidth: 0 }}>
          {hit.name}
        </Typography>
      </Stack>
      {/* THE RATIO FIRST, WHEN THERE IS ONE. Comparing two weapons IS comparing their ratios, and a
          candidate list is where that comparison actually happens - by the time the item is in the
          cell you have already chosen it. Non-weapons draw nothing here and lose no space to it. */}
      {weapon !== null && (
        <Box sx={{ mt: 0.25 }}>
          <GearPlanRatioLine mine={weapon.mine} worn={weapon.worn} testId="gearplan-hit-ratio" />
        </Box>
      )}
      {delta !== null && delta.length > 0 && (
        <Box sx={{ mt: 0.25 }}>
          <GearPlanDeltaLine delta={delta} testId="gearplan-hit-delta" />
        </Box>
      )}
      {delta !== null && delta.length === 0 && (
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 0.25 }}>
          changes nothing you are wearing there
        </Typography>
      )}
      <GearPlanRowChips signals={signals} />
    </Box>
  )
}

/**
 * WHICH BASELINE NOTHING BEAT, in its own words. Same three states the compare chip has, and for
 * the same reason: "beats what you have on" is simply false on a cell that already holds a plan,
 * and an empty list that misreports WHY it is empty is worse than one that says nothing.
 */
const BEATEN_NONE: Record<'planned' | 'worn' | 'nothing', string> = {
  planned: 'Nothing here beats what you have planned.',
  worn: 'Nothing here beats what you have on.',
  nothing: 'Nothing here states every stat you picked.'
}

/**
 * Why the list is empty, in the words of whichever reason applies.
 *
 * THE STAT FILTER GETS ITS OWN SENTENCE and is asked about FIRST, because it is the reason a
 * reader is least likely to guess and the easiest to leave switched on by accident. "Nothing here
 * beats what you have on" is also a genuinely useful answer — it means you are already wearing the
 * best the corpus knows about for that slot, which no other line here can tell you.
 */
function emptyLine(
  q: { text: string; loading: boolean; slotted: boolean },
  held: { filtered: number; byStats: number; against: 'planned' | 'worn' | 'nothing' },
  label: string
): string {
  // The minimum survives for the ONE case it was written for: a cell that names no slot.
  if (!q.slotted && q.text.trim().length < MIN_QUERY) return 'Type at least two letters.'
  if (q.loading) return 'Searching…'
  const { filtered, byStats } = held
  if (byStats > 0) {
    return `${BEATEN_NONE[held.against]} ${String(byStats)} ${byStats === 1 ? 'item fits' : 'items fit'} this slot and ${byStats === 1 ? 'it does' : 'none of them do'} better on every stat you picked.`
  }
  if (filtered > 0) {
    return `${String(filtered)} ${filtered === 1 ? 'match fits' : 'matches fit'} this slot, and your filters are hiding ${filtered === 1 ? 'it' : 'them all'}.`
  }
  if (q.text.trim() === '') {
    return `No item in the database states ${label} - an item can only be planned into a slot its page names.`
  }
  return `No item that fits ${label} matches that.`
}

export interface GearPlanSelectPanelProps {
  /** the cell being filled — this panel is only rendered when there is one */
  cell: PlanSlotId
  onClose: () => void
  onPick: (hit: PlannerItemHit) => void
  /** the row-warning fold, mounted once by the view — see `gearPlanSignalsHook.ts` */
  signalsOf: (subject: { key: string; classes?: readonly ClassAbbr[] }) => RowSignals
  /** what a candidate would change against the item worn in THIS cell — see `GearPlanFold` */
  deltaFor: (key: string, cell: PlanSlotId) => CellDelta[] | null
  /** the same for a weapon's derived ratio, which is not one of the delta's keys */
  weaponFor: (key: string, cell: PlanSlotId) => WeaponRead | null
  /**
   * A candidate's vector and the one it is measured against, for the stat filter to rank and
   * compare on. `against` names WHICH of the two the baseline came from, so the compare chip can
   * say what it is comparing to rather than guessing — see `GearPlanFold.candidateStats`.
   */
  statsFor: (
    key: string,
    cell: PlanSlotId
  ) => { mine: GearStats; worn: GearStats | null; against: 'planned' | 'worn' | 'nothing' } | null
  /** what the page's filter bar is narrowing the pool to */
  filter: GearPlanRowFilter
  /** the shared `eq.planner.era` value, which is not one of `filter`'s fields */
  eraOnly: boolean
  /** how many slot-legal rows the filters just held back; `null` when this panel is not up */
  onHidden: (n: number | null) => void
  /**
   * THE RANKING LENS, OWNED BY THE PAGE. The stats live on the filter bar (see its header) because
   * "which stats do I care about" is the same question at every cell; only the COMPARISON is local,
   * because only a cell knows what "worn" means.
   */
  stats: { keys: GearStatKey[]; beatsWorn: boolean; setBeatsWorn: (v: boolean) => void }
}

/**
 * THE ROWS, NARROWED AND ORDERED — split out of the panel, which crossed the 100-line function
 * ceiling when the stat pick arrived.
 *
 * THE ORDER OF OPERATIONS IS THE DESIGN. The pool filter runs first and the stat filter second, so
 * hidden-by-pool and hidden-by-stats stay counted APART and the empty line can name which of the
 * two emptied the list — "your filters are hiding them" and "nothing here beats what you have on"
 * are different answers and only one of them is about the filter bar. The sort runs last, over what
 * survived, because sorting rows that are about to be dropped is work for nobody.
 */
function useCandidates({
  cell,
  query,
  limit,
  pick,
  signalsOf,
  statsFor,
  filter,
  eraOnly
}: {
  cell: PlanSlotId
  query: string
  limit: number
  pick: { keys: GearStatKey[]; beatsWorn: boolean }
  signalsOf: GearPlanSelectPanelProps['signalsOf']
  statsFor: GearPlanSelectPanelProps['statsFor']
  filter: GearPlanRowFilter
  eraOnly: boolean
}): {
  usable: { hit: PlannerItemHit; signals: RowSignals }[]
  filtered: number
  byStats: number
  against: 'planned' | 'worn' | 'nothing'
  loading: boolean
  more: boolean
} {
  // `undefined` for an any-cell, which is what keeps `MIN_QUERY` in force for it alone.
  const wanted = equipSlotOf(cell) ?? undefined
  // ASK FOR THE WHOLE SLOT ONCE A STAT IS PICKED, because a sort over one page is not a sort.
  // Main ranks by NAME and caps at `limit`, so ordering that page by wisdom would surface the
  // wisest of the fifty best NAME matches — which is not what "sort by wisdom" means, and is wrong
  // in a way nothing on screen would reveal. A slot's legal set is closed and tops out inside
  // `PLANNER_PAGE_MAX`, so asking for all of it makes the ranking honest.
  const wide = pick.keys.length > 0
  const { hits, loading } = useItemSearch(query, true, wanted, wide ? PLANNER_PAGE_MAX : limit)

  // Signals are folded ONCE per row and used twice — to decide and to draw.
  const rows = hits.map((hit) => ({ hit, signals: signalsOf(hit) }))
  const kept = rows.filter((r) => !hidesRow(r.signals, filter, eraOnly))

  // A ROW THE CORPUS HAS NO VECTOR FOR CANNOT BE COMPARED, and it is KEPT rather than hidden. The
  // picker deliberately lets you plan an item the gear index does not carry (the cell then reads
  // `not in the item database` and counts into `unknown`), so dropping those rows here would make
  // a stat filter quietly delete the one class of item the surface promises not to hide. It sorts
  // last instead, because there is nothing to rank it by.
  const pairOf = (key: string): ReturnType<GearPlanSelectPanelProps['statsFor']> => statsFor(key, cell)
  const beaten = pick.beatsWorn
    ? kept.filter((r) => {
        const pair = pairOf(r.hit.key)
        return pair === null || beatsWornOn(pick.keys, pair.mine, pair.worn)
      })
    : kept
  const scored = new Map(
    beaten.map((r) => {
      const pair = pairOf(r.hit.key)
      return [r.hit.key, pair === null ? -Infinity : pickScore(pick.keys, pair.mine)]
    })
  )
  const usable = wide
    ? [...beaten].sort((a, b) => (scored.get(b.hit.key) ?? 0) - (scored.get(a.hit.key) ?? 0))
    : beaten

  return {
    usable,
    filtered: rows.length - kept.length,
    byStats: kept.length - beaten.length,
    // WHAT THE COMPARE CHIP IS ALLOWED TO CALL ITSELF. Read off a row rather than asked separately:
    // `statsFor` already answers what this cell is measured against as part of every pair, and any
    // row will do because they all share the same other side.
    against: rows.length > 0 ? (pairOf(rows[0].hit.key)?.against ?? 'nothing') : 'nothing',
    loading,
    // The walk-up is only offered while the PAGE is what limits the list; with a stat picked the
    // whole slot is already here, so there is nothing left to show more of.
    more: !wide && hits.length >= limit && limit < PLANNER_PAGE_MAX
  }
}

/**
 * THE LIST NEVER TRUNCATES IN SILENCE — the rule the filter bar states about hidden rows, and the
 * reason `Patchwork Boots` (51st of 362 foot items) once read as "not in the database". If the
 * surface is holding something back it says so, and offers the way through.
 */
function MoreRow({ shown, on, onMore }: { shown: number; on: boolean; onMore: () => void }): JSX.Element | null {
  if (!on) return null
  return (
    <Box
      data-testid="gearplan-item-more"
      onClick={onMore}
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
        {`Showing ${String(shown)} - show more`}
      </Typography>
    </Box>
  )
}

/**
 * THE THREE THINGS THIS CHIP CAN HONESTLY BE COMPARING AGAINST, and they are genuinely different
 * claims rather than one claim with three wordings.
 *
 * A cell that already holds a plan is measured against THAT - the decision in front of you is "is
 * this better than what I have already chosen", and the worn item is two decisions ago. An empty
 * cell falls back to what you are wearing there. A cell with neither has a baseline of zero, so the
 * same switch means "states these at all" and says so.
 *
 * One word for all three would make an empty slot look like a comparison it cannot make.
 */
const BEATS_LABEL: Record<'planned' | 'worn' | 'nothing', string> = {
  planned: 'Beats planned',
  worn: 'Beats worn',
  nothing: 'Has these'
}

const BEATS_HINT: Record<'planned' | 'worn' | 'nothing', string> = {
  planned: 'Keep only items better than the one already planned here, on every stat picked above',
  worn: 'Nothing is planned here yet, so this keeps only items better than the one you are wearing',
  nothing: 'Nothing is planned or worn here, so this keeps items that state every stat picked above'
}

/**
 * THE COMPARISON, AND ONLY THE COMPARISON. The stats themselves are picked on the page's filter
 * bar; what is local to this panel is the thing that needs a cell to mean anything.
 *
 * Drawn only once a stat is picked, because "better on nothing" is not a question — absent rather
 * than disabled (house law 9), and present the moment it has something to act on.
 *
 * IT SAYS WHAT IT IS COMPARING AGAINST, and the two cases genuinely differ: with an item worn in
 * this cell it reads `Beats worn` and means it; with nothing worn the baseline is zero, so the same
 * switch means "states these at all" and says `Has these` instead. One word for both would make an
 * empty slot look like a comparison it cannot make.
 */
function BeatsChip({
  stats,
  against
}: {
  stats: GearPlanSelectPanelProps['stats']
  against: 'planned' | 'worn' | 'nothing'
}): JSX.Element | null {
  if (stats.keys.length === 0) return null
  return (
    <Box sx={{ mb: 0.5 }}>
      <ToggleChip
        label={BEATS_LABEL[against]}
        hint={BEATS_HINT[against]}
        testId="gearplan-stat-beats"
        on={stats.beatsWorn}
        onToggle={() => {
          stats.setBeatsWorn(!stats.beatsWorn)
        }}
      />
    </Box>
  )
}

export default function GearPlanSelectPanel({
  cell,
  onClose,
  onPick,
  signalsOf,
  deltaFor,
  weaponFor,
  statsFor,
  filter,
  eraOnly,
  onHidden,
  stats
}: GearPlanSelectPanelProps): JSX.Element {
  const [text, setText] = useState('')
  const query = useDeferredValue(text)
  // The page resets with the QUESTION: a page walked out to four hundred for one query has nothing
  // to do with the next one, and carrying it over would make an unrelated search silently expensive.
  const [limit, setLimit] = useState(PLANNER_PAGE)
  useEffect(() => {
    setLimit(PLANNER_PAGE)
  }, [query, cell])
  const slot = equipSlotOf(cell) ?? undefined
  const { usable, filtered, byStats, against, loading, more } = useCandidates({
    cell,
    query,
    limit,
    pick: stats,
    signalsOf,
    statsFor,
    filter,
    eraOnly
  })

  useEffect(() => {
    onHidden(filtered)
    return () => {
      onHidden(null)
    }
  }, [filtered, onHidden])

  return (
    <DashCard
      fill
      title={`Filling ${planSlotLabel(cell)}`}
      right={
        <Link
          component="button"
          type="button"
          underline="hover"
          variant="caption"
          data-testid="gearplan-select-close"
          onClick={onClose}
          sx={{ color: 'text.secondary', flexShrink: 0 }}
        >
          CANCEL
        </Link>
      }
      testId="gearplan-select"
    >
      <TextField
        autoFocus
        fullWidth
        size="small"
        label="Search by name"
        value={text}
        data-testid="gearplan-item-search"
        onChange={(e) => setText(e.target.value)}
        // THE FLOATING LABEL SITS ABOVE THE FIELD'S OWN BOX, and a `DashCard fill` body is an
        // `overflow: auto` scroller - so at scrollTop 0 the label was clipped in half by the top
        // edge of the scroller and read as "Search by name" with its ascenders shaved off. The
        // margin is the label's room, not decoration: MUI lifts it by 9px and this is the 8px
        // grid step that clears it.
        sx={{ mt: 1, mb: 0.5 }}
      />
      <BeatsChip stats={stats} against={against} />
      {usable.map(({ hit, signals }) => (
        <CandidateRow
          key={hit.key}
          hit={hit}
          signals={signals}
          delta={deltaFor(hit.key, cell)}
          weapon={weaponFor(hit.key, cell)}
          onPick={onPick}
        />
      ))}
      <MoreRow shown={usable.length} on={more} onMore={() => {
        setLimit((n) => Math.min(n + PLANNER_PAGE, PLANNER_PAGE_MAX))
      }} />
      {usable.length === 0 && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1.5 }}>
          {loading && <CircularProgress size={14} />}
          <Typography variant="caption" color="text.secondary" data-testid="gearplan-item-empty">
            {emptyLine({ text, loading, slotted: slot !== undefined }, { filtered, byStats, against }, slot ?? 'this slot')}
          </Typography>
        </Stack>
      )}
    </DashCard>
  )
}
