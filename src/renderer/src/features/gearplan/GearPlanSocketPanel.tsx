// gearplan/GearPlanSocketPanel.tsx — "what can go in THIS socket of THIS item?", in the right column.
//
// `GearPlanDonorPicker` moved out of its popover for the reasons `GearPlanSelectPanel` did, and one
// more that is specific to exaltations: what an effect DOES is a list, not a phrase, and there was
// nowhere in a 360px popover to put a list.
//
// THE HOVER CARD IS GONE AND THE EFFECT LINES ARE PERMANENT TEXT. That reverses a ruling this
// feature made a few days ago, so here is the argument rather than a quiet edit.
//
// The card was argued in on CONSISTENCY: a planned exaltation on a board cell explains itself on
// hover, so making the picker use a chevron-disclosure instead would teach two gestures for one
// question asked four inches apart. That was right, and against the alternative it was compared to
// — a per-row expander — it is still right. It was never compared to THIS, because in a popover
// this did not fit.
//
// What a hover cannot do is let you COMPARE. Choosing a proc means holding two or three candidates
// against each other, and a fact you have to hover for cannot be held against a fact you have to
// hover for somewhere else; you end up hovering one, remembering it, hovering the next, and
// discovering you have forgotten the first. That is the same argument the delta line already won on
// the item side (`GearPlanDeltaLine`), and an effect list is a harder thing to hold in your head
// than a row of numbers. The column is 380px and full height, so the list simply fits.
//
// THE BOARD CELL KEEPS ITS HOVER CARD, AND THAT IS NOT THE INCONSISTENCY IT LOOKS LIKE. Twenty-three
// cells cannot each carry an effect list; the cell has one socket line and no room, so hover is the
// only depth available there. Here there is room, and where there is room the fact is drawn. The
// rule that comes out of it is "explain in place when the surface can afford to, and on hover when
// it cannot" — which is the design library's own picker rule ("where a picker's options need
// explaining, the explanation goes in the options - a secondary line per row - not in a hover card")
// followed to its end rather than stopped halfway.
//
// -------------------------------------------------------------------------------------------------
// WHAT THE EFFECT LINES COST, AND WHY THE LIST IS PAGED.
//
// The donor corpus carries three facts per effect (type, target, duration — `effectOneLiner`) and
// NOT the numbered effect list. That lives in the spell DB, one IPC lookup per name, and
// `SpellCard`'s header is explicit that there is no renderer cache on purpose: the record carries
// the ranks you have cast, which change while the app runs.
//
// So the lines are fetched per drawn row, on mount, through `useSpellDetail` — and the list is
// PAGED so "per drawn row" is a number this file controls. Measured against the committed corpus, a
// slot-constrained socket is small (6-33 legal donors for HEAD, PRIMARY or a finger) but an ANY cell
// is not (59-208), and PRIMARY/proc alone is 197. A page of `DONOR_PAGE` and a "show more" that
// walks to `DONOR_PAGE_MAX` is the same idiom the item panel uses, for the same reason, and it is
// what keeps opening a socket from firing two hundred lookups at main.
//
// EVERYTHING ELSE IS CARRIED OVER UNCHANGED, because it was right: no IPC for the donor list itself
// (`useDonors` is module-cached), an empty query LISTS (the legal set for one socket is closed, and
// "what are my options" is the question somebody standing on an empty socket has), the cost line is
// read from the rule and never typed (R4), the row warnings ride under every row, and the page's
// filter bar narrows this list and the item list together because "only things I can get" is ONE
// preference.

import { type JSX, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { Box, CircularProgress, Link, Stack, TextField, Typography } from '@mui/material'
import { effectOneLiner } from '@shared/planner/effectText'
import { extractionCost } from '@shared/planner/rules'
import { planSlotLabel, type PlannerDonor } from '@shared/planner/types'
import { useDonors } from '../planner/plannerData'
import { donorPickerRows, type CellContext } from './gearPlanRules'
import { useSpellDetail } from '../../lib/SpellCard'
import { DashCard } from '../combat/combatShared'
import GearPlanRowChips from './GearPlanRowChips'
import { hidesRow, type GearPlanRowFilter, type RowSignals } from './gearPlanSignals'

/** How many rows are drawn - and therefore looked up - before "show more" is offered. */
const DONOR_PAGE = 25
/** The walk-up ceiling. A closed legal set tops out near 200; this is the guard, not a product cap. */
const DONOR_PAGE_MAX = 200
/** Effect lines drawn per row before the rest are counted rather than listed. */
const MAX_LINES = 4

/** "≈15 ordinary copies, or 1 from the hardest tier" — R4, asked rather than typed. */
function costLine(donor: PlannerDonor): string {
  const cost = extractionCost(donor.tierRequired)
  return `+${String(cost.tier)} to extract · ≈${String(cost.d0Copies)} ordinary copies, or ${String(cost.d4Copies)} from the hardest tier`
}

/**
 * WHAT THE EFFECT ACTUALLY DOES, in the wiki's own numbered words.
 *
 * Quoted, never interpreted — the same rule `SpellCard`'s own effect block states: "Increase
 * Hitpoints by 35 per tick" is what the page says, and re-phrasing it would be this app's opinion
 * about a number it did not measure.
 *
 * SILENCE IS DRAWN AS SILENCE. 5.8% of corpus effect rows miss the spell-DB join by name, and a row
 * that misses renders NOTHING here rather than "unknown" or a dash (law 1, and law 12's ban on a
 * fuzzy second pass). While the lookup is in flight the row says so, because "still asking" and
 * "nothing to say" are different answers and a blank would spell them the same way.
 */
function EffectLines({ name }: { name: string }): JSX.Element | null {
  const { data, loading } = useSpellDetail(name)
  if (loading) {
    return (
      <Typography variant="caption" color="text.disabled" sx={{ display: 'block' }}>
        …
      </Typography>
    )
  }
  const lines = data?.effects ?? []
  if (lines.length === 0) return null
  return (
    <Box data-testid="gearplan-donor-effects" sx={{ mt: 0.25 }}>
      {lines.slice(0, MAX_LINES).map((line, i) => (
        <Typography
          key={`${String(i)}:${line}`}
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', lineHeight: 1.45 }}
        >
          {line}
        </Typography>
      ))}
      {lines.length > MAX_LINES && (
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block' }}>
          {`+${String(lines.length - MAX_LINES)} more`}
        </Typography>
      )}
    </Box>
  )
}

/**
 * ONE OPTION, EXPLAINING ITSELF COMPLETELY. The effect name, the item it comes off, the one-liner,
 * what it does, and what it costs — no gesture required to read any of it.
 *
 * THE ONE-LINER SURVIVES THE EFFECT LINES rather than being replaced by them. It is the disposition
 * (Beneficial / Detrimental), the target and the duration, which is what tells you whether a row is
 * even the KIND of thing you are looking for; the effect lines say how much. They answer different
 * questions and the short one is the one you scan on.
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
    <Box
      data-testid="gearplan-donor-hit"
      onClick={() => onPick(donor)}
      sx={{
        px: 1,
        py: 0.75,
        cursor: 'pointer',
        borderTop: 1,
        borderColor: 'divider',
        '&:hover': { bgcolor: 'action.hover' }
      }}
    >
      <Typography variant="body2" sx={{ minWidth: 0 }}>
        {donor.effect}
      </Typography>
      <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
        {donor.name}
      </Typography>
      {says !== '' && (
        <Typography variant="caption" color="text.disabled" noWrap sx={{ display: 'block' }}>
          {says}
        </Typography>
      )}
      <EffectLines name={donor.effect} />
      <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 0.25 }}>
        {costLine(donor)}
      </Typography>
      <GearPlanRowChips signals={signals} />
    </Box>
  )
}

/**
 * EMPTYING THE SOCKET, offered only when there is something in it. It sits above the candidates
 * rather than among them because "none" is not one of the options — it is the opposite of choosing.
 */
function ClearRow({ onClear }: { onClear: (() => void) | null }): JSX.Element | null {
  if (onClear === null) return null
  return (
    <Box
      data-testid="gearplan-donor-clear"
      onClick={onClear}
      sx={{
        px: 1,
        py: 0.75,
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
  )
}

/**
 * THE LIST ITSELF, split out because the panel crossed the 100-line function ceiling.
 *
 * The seam is deliberate rather than arbitrary: everything above it is the QUESTION (the search
 * box, the clear affordance, the card frame) and everything in here is the ANSWER. The paging
 * belongs on this side because the page is a property of the answer's length.
 */
function DonorList({
  rows,
  usable,
  more,
  onPick,
  onMore,
  empty
}: {
  rows: { donor: PlannerDonor; signals: RowSignals }[]
  usable: number
  more: boolean
  onPick: (d: PlannerDonor) => void
  onMore: () => void
  empty: JSX.Element | null
}): JSX.Element {
  return (
    <>
      {rows.map(({ donor, signals }) => (
        <DonorHit key={`${donor.key}:${donor.effect}`} donor={donor} signals={signals} onPick={onPick} />
      ))}
      {/* THE LIST NEVER TRUNCATES IN SILENCE — the same rule the item panel and the filter bar both
          state. Here it is load-bearing twice over: the cap is also what bounds the spell lookups,
          so a silent one would be a performance decision the reader could not see or undo. */}
      {more && (
        <Box
          data-testid="gearplan-donor-more"
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
            {`Showing ${String(rows.length)} of ${String(usable)} - show more`}
          </Typography>
        </Box>
      )}
      {empty}
    </>
  )
}

/** Why the list is empty, in the words of whichever reason applies. */
function emptyLine(ready: boolean, filtered: number, query: string): string {
  if (!ready) return 'Reading the effect database…'
  if (filtered > 0) {
    return `${String(filtered)} ${filtered === 1 ? 'effect fits' : 'effects fit'} this socket, and your filters are hiding ${filtered === 1 ? 'it' : 'them all'}.`
  }
  if (query.trim() === '') {
    return 'Nothing in the database can go in this socket - no effect of this kind shares a slot and a class with this item.'
  }
  return 'No effect that fits this socket matches that.'
}

export interface GearPlanSocketPanelProps {
  /** the cell and socket being filled, plus the planned item's classes — never `null` when mounted */
  ctx: CellContext
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
  /** how many legal donors the filters just held back; `null` when this panel is not up */
  onHidden: (n: number | null) => void
}

export default function GearPlanSocketPanel({
  ctx,
  ready,
  onClose,
  onPick,
  signalsOf,
  onClear,
  filter,
  eraOnly,
  onHidden
}: GearPlanSocketPanelProps): JSX.Element {
  const [text, setText] = useState('')
  const query = useDeferredValue(text)
  const { donors } = useDonors()

  // The page resets with the QUESTION, exactly as the item panel's does: a page walked out to two
  // hundred for one socket has nothing to do with the next one, and carrying it over would make an
  // unrelated socket silently expensive in a way this list can actually feel.
  const [limit, setLimit] = useState(DONOR_PAGE)
  useEffect(() => {
    setLimit(DONOR_PAGE)
  }, [query, ctx])

  const legal = useMemo(
    () => donorPickerRows(donors, ctx, query, DONOR_PAGE_MAX),
    [donors, ctx, query]
  )

  // Folded once and used twice - to decide and to draw. R2 has already run inside
  // `donorPickerRows`; this narrowing is the USER's, and it is applied strictly after the rules so
  // an empty list can say which of the two emptied it.
  const scored = legal.map(({ donor }) => ({ donor, signals: signalsOf(donor) }))
  const usable = scored.filter((r) => !hidesRow(r.signals, filter, eraOnly))
  const filtered = scored.length - usable.length
  const rows = usable.slice(0, limit)
  const more = usable.length > limit

  useEffect(() => {
    onHidden(filtered)
    return () => {
      onHidden(null)
    }
  }, [filtered, onHidden])

  return (
    <DashCard
      fill
      title={`${ctx.socket} for ${planSlotLabel(ctx.cell)}`}
      right={
        <Link
          component="button"
          type="button"
          underline="hover"
          variant="caption"
          data-testid="gearplan-socket-close"
          onClick={onClose}
          sx={{ color: 'text.secondary', flexShrink: 0 }}
        >
          CANCEL
        </Link>
      }
      testId="gearplan-socket-select"
    >
      <TextField
        autoFocus
        fullWidth
        size="small"
        label="Search by effect or item"
        value={text}
        data-testid="gearplan-donor-search"
        onChange={(e) => setText(e.target.value)}
        sx={{ mb: 0.5 }}
      />
      <ClearRow onClear={onClear} />
      <DonorList
        rows={rows}
        usable={usable.length}
        more={more}
        onPick={onPick}
        onMore={() => {
          setLimit((n) => Math.min(n + DONOR_PAGE, DONOR_PAGE_MAX))
        }}
        empty={
          rows.length === 0 ? (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1.5 }}>
              {!ready && <CircularProgress size={14} />}
              <Typography variant="caption" color="text.secondary" data-testid="gearplan-donor-empty">
                {emptyLine(ready, filtered, query)}
              </Typography>
            </Stack>
          ) : null
        }
      />
    </DashCard>
  )
}
