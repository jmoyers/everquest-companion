// gearplan/GearPlanTotalsPanel.tsx — what the board adds up to, and what it would change.
//
// `GearSetTotalsPanel.tsx` (JOS-286) revived under the gear plan document, with one block added.
//
// FOUR BLOCKS, AND THE ORDER IS THE READING ORDER:
//   1. THE TOTALS. AC, then stats, then saves — `sumGear`'s own ordering, so a number here reads
//      in the same place it reads on the Character tab.
//   2. NOT SUMMED. Percent-valued stats, stated and never added. ALWAYS VISIBLE when non-empty:
//      hiding it behind a disclosure would turn "we cannot say" into "there is nothing here".
//   3. EXALTATIONS PLANNED. The block this panel has that the retired one did not, and the reason
//      it exists is that an exaltation moves an EFFECT while these numbers sum stats — so a planned
//      proc contributes exactly nothing above, and a list of four socketed effects sitting beside
//      a stat total with nothing distinguishing them would be read as having been counted.
//   4. AGAINST EQUIPPED. Only the rows that MOVED: a diff whose zero rows outnumber its answers is
//      a table, not a comparison. Absent entirely when there is no dump — "we cannot see your
//      body" is a different statement from "you are wearing nothing", and claiming the second
//      would make every number here look like a gain.
//
// ---------------------------------------------------------------------------------------------
// THE DELTAS ARE STILL NOT `success.main` AND `error.main` — BUT THEY ARE NOW COLOURED.
//
// This header used to forbid a coloured delta outright, and the half of that argument about the
// SEMANTIC colours was right and still stands. Neither is used here and neither should be:
//
//   * `error.main` is written down as belonging to "the close button's hover fill, a stalled event
//     loop. Almost nothing else — the app rarely has the right to be alarmed", and the colour
//     section's Don't forbids "red for anything that is merely empty or not-yet-known". A helm
//     with less AC than the one you are wearing is not a failure; it is a number.
//   * `success.main` is the LIVE dot, a celebration, a merge into an upgrade. It means something
//     happened, not that a quantity is larger.
//
// The half that has been overturned is the conclusion that therefore NO hue applies. That was
// argued when this panel drew the only delta in the feature — one column, read deliberately, where
// "contrast, not scale" and a run of signed tabular numbers really is fast enough. The board now
// draws a delta on every filled cell and the select panel draws one per candidate across twenty
// rows, and at that density a reader is scanning for a shape rather than reading numbers. This
// header already named the way through: "if a loss ever genuinely needs a hue, the app's adverse
// colour is #cf6679 (KIND_COLOR.enemy)".
//
// So the hue is `KIND_COLOR`'s own friendly/adverse pair, and it lives in ONE file for all three
// surfaces — `GearPlanDeltaLine.tsx`, whose header carries the full argument and the rule that the
// colour is always the SECOND encoding, never the only one. The signs stay.
//
// EVERY BLOCK HEADING IS THE LIBRARY'S CARD-TITLE MICRO TYPE (12px, 700, 0.06em, uppercase,
// secondary ink) and every label is its 9px stat label, so this panel's internal structure reads
// with the same weight as a panel header anywhere else in the app.
//
// THE PANEL IS A `DashCard`, for the reason the cell cards are (house law 7), and it FILLS: its
// content grows with the board, and a growing list lives in a bounded box that scrolls rather than
// one that grows the page.

import type { JSX } from 'react'
import { Box, Stack, Typography } from '@mui/material'
import type { GearStat, GearTotals } from '@shared/characterSheet'
import type { GearPlanSocket } from '@shared/planner/gearPlan'
import type { GearDiffRow, GearPlanDiff } from '@shared/planner/gearPlanTotals'
import { planSlotLabel, type PlanSlotId, type SocketType } from '@shared/planner/types'
import { DashCard, QuietNote } from '../combat/combatShared'
import { GAIN_COLOR, LOSS_COLOR } from './GearPlanDeltaLine'

const signed = (n: number): string => (n > 0 ? `+${String(n)}` : String(n))

/** The library's micro STAT LABEL: 9px, 0.06em, uppercase, disabled ink. */
const STAT_LABEL = {
  fontSize: 9,
  lineHeight: 1.4,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'text.disabled'
} as const

/** The library's CARD TITLE, reused for this panel's internal block headings. */
const BLOCK_TITLE = {
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'text.secondary'
} as const

/** One planned exaltation, as the flat list carries it. */
export interface PlannedSocketRow {
  cell: PlanSlotId
  socket: SocketType
  planned: GearPlanSocket
}

export interface GearPlanTotalsPanelProps {
  totals: GearTotals
  /** how many cells the board fills — the card's one status value */
  assigned: number
  plannedSockets: readonly PlannedSocketRow[]
  /** the comparison, or `null` when there is no dump to compare against */
  diff: GearPlanDiff | null
  /** worn items whose name stated no ` +N` and are therefore read at base */
  unstated: number
  /** worn exaltations the dump named by donor and the corpus could not place — see `equippedRead` */
  unresolved: number
}

/** A label/value pair. The label is the micro stat label; the value is tabular. */
function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ gap: 1 }}>
      <Typography sx={{ ...STAT_LABEL, minWidth: 0 }} noWrap>
        {label}
      </Typography>
      <Typography
        variant="caption"
        sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', flexShrink: 0 }}
      >
        {value}
      </Typography>
    </Stack>
  )
}

function StatRows({ rows }: { rows: readonly GearStat[] }): JSX.Element | null {
  if (rows.length === 0) return null
  return (
    <Box sx={{ flex: '1 1 130px', minWidth: 120 }}>
      {rows.map((s) => (
        <Row key={s.label} label={s.label} value={signed(s.total)} />
      ))}
    </Box>
  )
}

function BlockHeading({ children }: { children: string }): JSX.Element {
  return (
    <Typography variant="caption" sx={{ ...BLOCK_TITLE, display: 'block', mb: 0.25 }}>
      {children}
    </Typography>
  )
}

/** The percent-valued rows, side by side and never added. */
function NotSummed({ totals }: { totals: GearTotals }): JSX.Element | null {
  if (totals.unsummed.length === 0) return null
  return (
    <Box sx={{ mt: 1.25 }} data-testid="gearplan-unsummed">
      <BlockHeading>Not summed</BlockHeading>
      {totals.unsummed.map((u) => (
        <Row key={u.label} label={u.label} value={u.values.join('  ')} />
      ))}
    </Box>
  )
}

/**
 * The planned exaltations, LISTED. This block adds nothing up on purpose — see the header — and
 * says which cell each one is planned into, because a proc means something different on a helm
 * than on a sword.
 */
function SocketsPlanned({ rows }: { rows: readonly PlannedSocketRow[] }): JSX.Element | null {
  if (rows.length === 0) return null
  return (
    <Box sx={{ mt: 1.25 }} data-testid="gearplan-sockets-planned">
      <BlockHeading>Exaltations planned</BlockHeading>
      {rows.map((r) => (
        <Row
          key={`${r.cell}:${r.socket}`}
          label={`${planSlotLabel(r.cell)} · ${r.socket}`}
          value={r.planned.effect}
        />
      ))}
    </Box>
  )
}

/**
 * One moved row of the comparison. The SIGN carries the meaning and the hue seconds it.
 *
 * THE SIGN IS A SAFE VERDICT HERE, AND ONLY HERE. These rows come from `sumGear`'s `GearStat[]`,
 * which the six `STRUCTURAL_KEYS` never reach — so `DELAY` and `WEIGHT`, the two keys a smaller
 * number is better on, cannot appear in this list. The per-cell delta line has no such guarantee
 * and splits on `isImprovement` instead. If a structural key is ever given a total, this row must
 * start asking the same question.
 */
function DiffRow({ row }: { row: GearDiffRow }): JSX.Element {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ gap: 1 }}>
      <Typography sx={{ ...STAT_LABEL, minWidth: 0 }} noWrap>
        {row.label}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          flexShrink: 0,
          color: row.delta > 0 ? GAIN_COLOR : LOSS_COLOR
        }}
      >
        {signed(row.delta)}
      </Typography>
    </Stack>
  )
}

function AgainstEquipped({
  diff,
  unstated,
  unresolved
}: {
  diff: GearPlanDiff | null
  unstated: number
  unresolved: number
}): JSX.Element | null {
  if (diff === null) return null
  const moved = [diff.ac, ...diff.stats, ...diff.saves].filter((r) => r.delta !== 0)
  return (
    <Box sx={{ mt: 1.25 }} data-testid="gearplan-diff">
      <BlockHeading>Against what you are wearing</BlockHeading>
      <Box sx={{ mb: 0.5 }}>
        <QuietNote>
          {diff.cellsChanged === 0
            ? 'Nothing here changes what you have on.'
            : `${String(diff.cellsChanged)} ${diff.cellsChanged === 1 ? 'cell' : 'cells'} would change`}
        </QuietNote>
      </Box>
      {moved.map((row) => (
        <DiffRow key={row.label} row={row} />
      ))}
      {unstated > 0 && (
        <Box sx={{ mt: 0.5 }}>
          <QuietNote>
            {`${String(unstated)} worn ${unstated === 1 ? 'item states' : 'items state'} no merge level and read at base`}
          </QuietNote>
        </Box>
      )}
      {/* The dump names the DONOR ITEM an exaltation came from, never the effect and never which
          socket it went into. Where the effect database settles that, the socket is read; where it
          cannot, this counts it instead of guessing - so an empty socket reads as "not known"
          rather than "not there". Law 1.

          THE LINE DOES NOT SAY WHY, deliberately. There are three reasons (the database carries no
          row for that item, it carries several and the file cannot say which, or it had not
          finished loading) and the difference matters far less to the reader than the fact that
          the board is not the whole story. What this must never do is stay silent - a socket that
          reads empty for a reason nobody stated is the defect this line was added for. */}
      {unresolved > 0 && (
        <Box sx={{ mt: 0.5 }}>
          <QuietNote>
            {`${String(unresolved)} worn ${unresolved === 1 ? 'exaltation' : 'exaltations'} could not be matched to an effect, so ${unresolved === 1 ? 'its socket is' : 'those sockets are'} empty here rather than unused`}
          </QuietNote>
        </Box>
      )}
    </Box>
  )
}

export default function GearPlanTotalsPanel({
  totals,
  assigned,
  plannedSockets,
  diff,
  unstated,
  unresolved
}: GearPlanTotalsPanelProps): JSX.Element {
  return (
    <DashCard
      fill
      title="What this adds up to"
      right={
        <Typography variant="caption" sx={{ color: 'primary.main', flexShrink: 0 }}>
          {`${String(assigned)} planned`}
        </Typography>
      }
      testId="gearplan-totals"
    >
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
        <StatRows rows={[{ label: 'AC', total: totals.ac, from: totals.counted }]} />
        <StatRows rows={totals.stats} />
        <StatRows rows={totals.saves} />
      </Box>

      <NotSummed totals={totals} />
      <SocketsPlanned rows={plannedSockets} />

      {totals.unknown > 0 && (
        <Box sx={{ mt: 0.75 }}>
          <QuietNote>
            {`${String(totals.unknown)} planned ${totals.unknown === 1 ? 'item is' : 'items are'} not in the item database and count toward nothing above`}
          </QuietNote>
        </Box>
      )}

      <AgainstEquipped diff={diff} unstated={unstated} unresolved={unresolved} />
    </DashCard>
  )
}
