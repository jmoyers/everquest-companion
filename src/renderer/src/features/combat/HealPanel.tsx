// THE COMBAT TAB'S HEALING DIMENSION (owner ruling P2, docs/plans/combat-overlay-parity.md):
// "the combat panel lacks the overlay's HEAL functionality — parity".
//
// It is the third position of the meter panel's direction filter (Outgoing | Incoming | Healing)
// and it renders from `healRows.healPanel` — the SAME builder the two floating heal overlays
// call, at the same two levels, printing the same words. This file is MUI chrome over that call
// and nothing else: no folding, no ranking, no phrasing of its own. That is the whole point of
// the ruling, and it is why the panel could not simply grow its own heal fold.
//
// ITS OWN FILE because SegmentPanel.tsx is at the measured line ceiling and the rule here is to
// split rather than ratchet.
//
// WHAT THE LOG SUPPORTS is stated once, in the shared model (shared/combat.ts) and the shared
// builder — HoT ticks are indistinguishable from direct heals, overheal is a floor derived from
// the `(M)` lines, absorption is GRANTED and not consumed. Nothing here restates or softens any
// of it; the hover titles carry the honest figures verbatim from `healRows`.

import type { JSX } from 'react'
import { Box, Breadcrumbs, Button, Link, Stack, Typography } from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import { Bar, QuietNote } from './combatShared'
import {
  UNSTATED_AMOUNT,
  hasAbsorbCounts,
  healPanel,
  healerAmount,
  healerStat,
  healerTitle,
  isAbsorbLane,
  isUnstatedLane,
  laneAmount,
  spellStat,
  spellTitle
} from './healRows'
import { formatNum as fmt } from '../../lib/formatRate'
import { scopeHealing } from './meterScope'
import type { Drill } from './dashboardData'
import type { HealSourceView, HealSpellView, HealingView, MitigationView } from '@shared/combat'
import type { MeterScope, RosterSnap } from '@shared/roster'
import { Tooltip } from '../../lib/Tooltip'

/**
 * A green-leaning ramp, matching the heal overlays' palette so a pinned heal meter and this
 * panel read as the same subject. Absorption gets the deliberately COOLER hue it has there — a
 * rune bar must never be mistaken for a green "hit points restored" bar at a glance.
 */
const HEAL_KIND_COLOR: Record<string, string> = {
  you: '#7fd1a0',
  pet: '#6fb3d2',
  other: '#a98fe0',
  enemy: '#cf6679'
}
const MIT_COLOR = '#8fb8d8'

/** One ranked healer at level 1. Drills into that healer's flat lane list. */
function HealerBar({
  h,
  rank,
  onDrill
}: {
  h: HealSourceView
  rank: number
  onDrill?: () => void
}): JSX.Element {
  return (
    <Tooltip title={healerTitle(h)}>
      <Box>
        <Bar
          color={HEAL_KIND_COLOR[h.kind] ?? '#888'}
          // A row carrying absorption gets the cool accent stripe, so it reads as MIXED before a
          // single number is read. The split itself is in the stat run and in the drill.
          accent={h.absorbedTotal > 0 ? MIT_COLOR : undefined}
          pct={h.pct}
          rank={rank}
          onClick={onDrill}
          name={
            <>
              {h.name}
              {h.kind === 'pet' ? ' ·pet' : h.kind === 'enemy' ? ' ·enemy' : ''}
              <Typography component="span" variant="caption" sx={{ ml: 0.75, color: 'text.secondary', fontWeight: 400 }}>
                {healerStat(h)}
              </Typography>
              {onDrill && (
                <ChevronRightIcon sx={{ fontSize: 13, ml: 0.25, mb: '-2px', color: 'text.disabled' }} />
              )}
            </>
          }
          right={healerAmount(h)}
        />
      </Box>
    </Tooltip>
  )
}

/** One lane inside a healer's drill: a heal spell, or the absorption lane. */
function SpellBar({ s, healerKind }: { s: HealSpellView; healerKind: string }): JSX.Element {
  const color = isAbsorbLane(s) ? MIT_COLOR : HEAL_KIND_COLOR[healerKind] ?? '#888'
  return (
    <Tooltip title={spellTitle(s)}>
      <Box>
        <Bar
          color={color}
          accent={color}
          pct={s.pct}
          name={
            <>
              {s.name}
              {/* Heal lines that named no spell get an explicit, labeled lane — never folded
                  silently into a real spell's numbers. */}
              {s.name === 'Unspecified' && (
                <Typography component="span" variant="caption" sx={{ color: 'text.disabled', fontWeight: 400 }}>
                  {' '}
                  ~no spell named
                </Typography>
              )}
              {/* The classification as a plain suffix, the same convention the overlay uses —
                  never a badge, which would compete with the name for the row's width. */}
              {isAbsorbLane(s) && (
                <Typography component="span" variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
                  {' '}
                  ·absorbed
                </Typography>
              )}
              {/* Same convention for the third classification: a heal the log announced without
                  an amount (Mend). The suffix is what stops the ZERO-length bar beside it from
                  reading as a heal that did nothing. */}
              {isUnstatedLane(s) && (
                <Typography component="span" variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
                  {' '}
                  ·{UNSTATED_AMOUNT}
                </Typography>
              )}
              <Typography component="span" variant="caption" sx={{ ml: 0.75, color: 'text.secondary', fontWeight: 400 }}>
                {spellStat(s)}
              </Typography>
            </>
          }
          right={laneAmount(s)}
        />
      </Box>
    </Tooltip>
  )
}

/**
 * The COUNT-ONLY absorption families. The rune lane is not here — it has an amount, so it ranks
 * among the bars above as an `absorbed` row. These two do not: the log gives them no number at
 * all, so they are counts under the bars, in no total, never a bar (a bar would imply a
 * magnitude that was never recorded).
 */
function AbsorbCounts({ mit }: { mit: MitigationView | null }): JSX.Element | null {
  if (!hasAbsorbCounts(mit) || !mit) return null
  const bits = [
    mit.absorbedSwings > 0 ? `${mit.absorbedSwings} swings absorbed` : '',
    mit.absorbedDamageShields > 0 ? `${mit.absorbedDamageShields} damage shields absorbed` : ''
  ].filter(Boolean)
  return (
    <Tooltip title="The log records these as events with no amount, so they are shown as counts and enter no total.">
      <Typography variant="caption" sx={{ display: 'block', mt: 0.75, color: 'text.secondary' }}>
        {bits.join(' · ')}
        <Typography component="span" variant="caption" sx={{ color: 'text.disabled' }}>
          {' '}
          · no amount logged
        </Typography>
      </Typography>
    </Tooltip>
  )
}

/** Counter-healing is an ANNOTATION on your damage, not part of your sustain, so it never enters
 *  the ranking above — it gets one honest line. */
function EnemyHealedLine({ enemy }: { enemy: { total: number; healers: HealSourceView[] } }): JSX.Element | null {
  if (enemy.total <= 0) return null
  const top = enemy.healers.slice(0, 3).map((h) => `${h.name} ${fmt(h.total)}`).join(', ')
  return (
    <Tooltip title={`Healing that landed on mobs you were engaged with - it undid this much of your damage. Top: ${top}`}>
      <Typography variant="caption" sx={{ display: 'block', mt: 0.75, color: 'text.secondary' }}>
        enemies healed {fmt(enemy.total)}
      </Typography>
    </Tooltip>
  )
}

/** The drill breadcrumb — one level deep, because the heal model has exactly two (see healRows). */
function HealCrumb({ name, setDrill }: { name: string; setDrill: (d: Drill | null) => void }): JSX.Element {
  return (
    <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.75, flexShrink: 0 }}>
      <Button
        size="small"
        data-testid="heal-drill-back"
        startIcon={<ArrowBackIcon sx={{ fontSize: 16 }} />}
        onClick={() => setDrill(null)}
        sx={{ minWidth: 0, py: 0 }}
      >
        Back
      </Button>
      <Breadcrumbs separator="›" sx={{ fontSize: 12 }}>
        <Link component="button" underline="hover" color="inherit" onClick={() => setDrill(null)} sx={{ fontSize: 12 }}>
          All
        </Link>
        <Typography variant="caption" color="text.primary">
          {name}
        </Typography>
      </Breadcrumbs>
    </Stack>
  )
}

/**
 * The Healing dimension's whole body — crumb + bars — for one segment.
 *
 * The drill token is the panel's ORDINARY `{ kind: 'entity', entityId }`: a healer id is just an
 * id, so the tab's existing drill state machine (and its Esc handler, and its per-selection
 * reset) covers this dimension with no new state. A drill id from the damage dimension simply
 * resolves to nothing here and renders level 1 — the same stale-id rule everywhere else.
 */
export function HealBody({
  healing,
  scope,
  roster,
  drill,
  setDrill
}: {
  healing: HealingView | undefined
  scope: MeterScope
  roster: RosterSnap
  drill: Drill | null
  setDrill: (d: Drill | null) => void
}): JSX.Element {
  // SCOPE APPLIES TO HEALERS TOO, and it needed no engine change: `HealSourceKind` has carried
  // an ally lane ('other' — any non-you, non-pet healer) since Task #59, so the group model only
  // had to say which of those the roster names. You keeps you and your pets; Group keeps the
  // healers on the roster; Everyone keeps the passing stranger who topped you up.
  //
  // Through the SHARED filter, in front of the SHARED builder — this surface does not reach into
  // the model itself, for the same reason it does not re-fold it (healRows.test.mts).
  const panel = healPanel(scopeHealing(healing, scope, roster), drill?.kind === 'entity' ? drill.entityId : null)

  if (panel.level === 2) {
    return (
      <>
        <HealCrumb name={panel.subject.name} setDrill={setDrill} />
        {panel.rows.map((s) => (
          <SpellBar key={`${s.classification}:${s.name}`} s={s} healerKind={panel.subject.kind} />
        ))}
        {panel.rows.length === 0 && <QuietNote>No lane breakdown for this healer.</QuietNote>}
      </>
    )
  }

  return (
    <>
      {panel.empty ? (
        // A quiet state, not a zeroed meter: the amount-less absorption families can still have
        // fired with nothing to rank (swings eaten by a rune granted before this fight).
        <QuietNote>No healing in this segment.</QuietNote>
      ) : (
        panel.healers.map((h, i) => (
          <HealerBar key={h.id} h={h} rank={i + 1} onDrill={() => setDrill({ kind: 'entity', entityId: h.id })} />
        ))
      )}
      <AbsorbCounts mit={panel.mitigation} />
      <EnemyHealedLine enemy={panel.enemy} />
    </>
  )
}
