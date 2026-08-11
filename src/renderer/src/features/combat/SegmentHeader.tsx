// THE METER PANEL'S HEADER ROW — the segment's title, its stat run, and hard right of it the
// copy affordance. Split out of SegmentPanel.tsx, which sits at the measured 400-code-line
// ceiling (the rule here is to split, never to ratchet).
//
// It is the one place the panel states WHAT DIMENSION you are looking at in numbers: outgoing
// dps, incoming dps, or (since P2 — docs/plans/combat-overlay-parity.md) healing hps. The rate's
// UNIT WORD does that work, not a caption — `formatRate` prints 'dps' and `formatHealRate`
// prints 'hps', from the one formatter every surface in the app uses.

import { Stack, Typography } from '@mui/material'
import CircleIcon from '@mui/icons-material/Circle'
import { CopyButton, KIND_COLOR, fmtDur } from './combatShared'
import { healTotalTitle } from './healRows'
import { fmtElapsed } from './copyText'
import { formatNum as fmt, formatHealRate, formatRate } from '../../lib/formatRate'
import type { MeterMode } from './dashboardData'
import type { SegmentView } from '@shared/combat'
import { Tooltip } from '../../lib/Tooltip'

/** The Healing dimension's accent — the heal overlays' green, so the two read as one subject. */
const HEAL_COLOR = '#7fd1a0'


/**
 * Active-time DPS: only worth printing when the fight actually had idle gaps.
 *
 * BOTH RATES ARE THE CALLER'S, not the segment's (JOS-170). The headline beside this note
 * describes what the panel is showing — the scoped list, or the drilled subject with its nested
 * pets — so an `(act …)` read straight off `seg` would put the whole fight's rate in brackets
 * next to one source's. Only the DURATIONS below come from the segment: they are the divisors,
 * and they are the same for every row in it.
 */
function ActiveDpsNote({
  seg,
  mode,
  dps,
  activeDps
}: {
  seg: SegmentView
  mode: MeterMode
  /** the wall-clock rate this header is printing — what the tooltip contrasts against. */
  dps: number
  activeDps: number
}): React.JSX.Element | null {
  if (mode !== 'out' || seg.activeSec <= 0 || seg.activeSec >= seg.durationSec) return null
  return (
    <Tooltip
      title={`Active-time DPS: damage ÷ ${fmtDur(
        seg.activeSec
      )} of actual combat time (gaps between hits capped at 3s each). Wall-clock DPS (${formatRate(
        dps
      )}) divides by the full ${fmtDur(seg.durationSec)} fight length.`}
    >
      <Typography component="span" variant="caption" sx={{ color: 'text.secondary', mr: 0.25 }}>
        (act {formatRate(activeDps)})
      </Typography>
    </Tooltip>
  )
}

/** How much of your damage the enemies healed back — effective DPS is lower by exactly this. */
function EnemyHealNote({ seg, mode }: { seg: SegmentView; mode: MeterMode }): React.JSX.Element | null {
  if (mode !== 'out' || seg.enemyHealTotal <= 0) return null
  return (
    <Tooltip
      title={`Enemies healed for ${fmt(
        seg.enemyHealTotal
      )} during this fight - that much of your damage was undone (effective DPS is lower).`}
    >
      <Typography component="span" variant="caption" sx={{ color: '#5fbf7f', ml: 0.5 }}>
        · +{fmt(seg.enemyHealTotal)} enemy heal
      </Typography>
    </Tooltip>
  )
}

/**
 * SLOW CHIP (Task #64). Shown ONLY when a slow-capable coat was actually on at engage — that is
 * what makes "not landed" a fact about the poison rather than about the loadout, and it keeps the
 * chip off the header of every fight the user wasn't running slow poison for.
 */
function SlowChip({ seg, mode }: { seg: SegmentView; mode: MeterMode }): React.JSX.Element | null {
  if (mode !== 'out' || !seg.procs.slowExpected) return null
  const landed = seg.procs.slowLandMs !== undefined
  return (
    <Tooltip
      title={
        seg.procs.slowLandMs !== undefined
          ? `${seg.procs.coatAtEngage?.poison} was coated at engage; its Weakening Strike proc landed ${fmtElapsed(
              seg.procs.slowLandMs
            )} in (${seg.procs.slowLands} landing${seg.procs.slowLands === 1 ? '' : 's'} this fight).`
          : `${seg.procs.coatAtEngage?.poison} was coated at engage, but its slow proc has not landed in this fight.`
      }
    >
      <Typography component="span" variant="caption" sx={{ color: landed ? '#57e0a0' : 'text.disabled', ml: 0.5 }}>
        · {seg.procs.slowLandMs !== undefined ? `slow @ ${fmtElapsed(seg.procs.slowLandMs)}` : 'slow: not landed'}
      </Typography>
    </Tooltip>
  )
}

/**
 * The panel's title + stat run, and hard right of it the copy affordance — it belongs to THIS
 * panel (not to the tab's top bar), because what it copies is whatever level this panel is
 * currently showing.
 */
export function SegmentHeader({
  seg,
  mode,
  total,
  dps,
  activeDps,
  copyView
}: {
  seg: SegmentView
  mode: MeterMode
  /**
   * WHAT THE PANEL BELOW IS SHOWING, never the raw segment (JOS-170): the scoped ranked list at
   * level 1, the drilled subject with its nested pets at level 2 — `petRows.panelTotals`. This
   * number carries no label, so it has to be the one the visible rows add up to; the overlay's
   * crumb figure is labelled `all` and is allowed to state the whole fight instead.
   */
  total: number
  dps: number
  /** the same figures' active-time rate, scaled by the same fraction (SegmentPanel.headline). */
  activeDps: number
  /** null in the Healing dimension — see the comment below. */
  copyView: (() => string) | null
}): React.JSX.Element {
  const heal = mode === 'heal'
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ mb: 1, flexShrink: 0 }}>
      <Typography variant="subtitle1" noWrap>
        {seg.name}
        {seg.active && <CircleIcon sx={{ fontSize: 10, color: 'success.main', ml: 1, verticalAlign: 'middle' }} />}
      </Typography>
      <Stack direction="row" spacing={0.5} alignItems="baseline" sx={{ minWidth: 0 }}>
        {/* The rate carries its own UNIT WORD, so a healing headline can never be read as dps:
            `formatHealRate` prints 'hps' (lib/formatRate — one formatter, every surface). */}
        <Typography
          variant="body2"
          sx={{ color: heal ? HEAL_COLOR : mode === 'out' ? 'primary.main' : KIND_COLOR.enemy }}
          title={heal ? healTotalTitle(seg.healing) : undefined}
        >
          {heal ? formatHealRate(dps) : formatRate(dps)}{' '}
          <ActiveDpsNote seg={seg} mode={mode} dps={dps} activeDps={activeDps} />
          <Typography component="span" variant="caption" color="text.secondary">
            {/* The bare total, testid'd because it is the number JOS-170 is about: it must follow
                the drill and the pet preference, and only the real app can say that it does. */}
            · <span data-testid="meter-total">{fmt(total)}</span> · {fmtDur(seg.durationSec)}
            <EnemyHealNote seg={seg} mode={mode} />
            <SlowChip seg={seg} mode={mode} />
          </Typography>
        </Typography>
        {/* NO COPY IN THE HEALING DIMENSION. "Copy this view" means THIS view, and copyText.ts
            serializes damage tables only — a button here would put the damage meter on the
            clipboard while the panel shows healers, which is worse than no button. The heal
            overlays have no copy affordance either, so the two surfaces still match. */}
        {copyView && <CopyButton getText={copyView} />}
      </Stack>
    </Stack>
  )
}
