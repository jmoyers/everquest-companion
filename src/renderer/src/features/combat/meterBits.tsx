// Two presentational atoms that outgrew `combatShared.tsx`.
//
// That file is the meter's primitives module and sits at the measured line ceiling — the rule
// there is to SPLIT rather than ratchet a threshold (the CopyButton precedent, same header). Both
// of these are now read from outside it as well as inside it, so they live here:
//
//   StatItem  — one labeled figure in a readout (the per-ability expansion).
//   MoreRows  — the honest tail when a GLANCE cap is truncating a list. Shared because both levels
//               of the Overview card cap at the same five rows and must say so identically.
//   MultiAttackStats — the double/triple/quad reading for one ability (JOS-113), off the engine's
//               own round-lane buckets; a section of the per-ability readout (combatShared).

import { Box, Typography } from '@mui/material'
import type { AbilityMulti } from './abilityStats'
import { formatNum as fmt } from '../../lib/formatRate'

/** One labeled figure in a readout: a small uppercase caption over the value. */
export function StatItem({ label, value, color }: { label: string; value: string; color?: string }): React.JSX.Element {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography
        variant="caption"
        noWrap
        sx={{
          display: 'block',
          fontSize: 9,
          lineHeight: 1.4,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'text.disabled'
        }}
      >
        {label}
      </Typography>
      <Typography variant="caption" noWrap sx={{ display: 'block', fontWeight: 600, color: color ?? 'text.primary' }}>
        {value}
      </Typography>
    </Box>
  )
}

/**
 * `+3 more` — what a capped list says about the rows it is not showing, and (when the surface
 * offers one) the way to the full list. A cap that stays silent is the one thing a glance card
 * may not do.
 */
export function MoreRows({ n, onMore }: { n: number; onMore?: () => void }): React.JSX.Element {
  return (
    <Typography
      variant="caption"
      color="text.disabled"
      data-testid="meter-more"
      onClick={onMore}
      sx={onMore ? { cursor: 'pointer', '&:hover': { color: 'text.secondary' } } : undefined}
    >
      +{n} more
    </Typography>
  )
}

/**
 * THE MULTI-ATTACK STATS (JOS-113) — double / triple / quad attack for ONE ability, off the
 * engine's own round-lane buckets (abilityStats.abilityMultiAttack). This is where the readout the
 * owner rejected a whole drill level for actually lives: the double/triple that used to sit one
 * click down, on the ability it belongs to. The percentages are over ROUNDS, so the rounds
 * denominator rides beside them (law 11's spirit — a rate whose exposure is off screen is a lie).
 * Flurry (auto-attack ability only, law 6) rides beside these on the SkillReadout, not here.
 * Rendered as StatItems inside the readout's own flex Stack, so it never introduces a second row.
 */
export function MultiAttackStats({ multi, a }: { multi: AbilityMulti; a: string }): React.JSX.Element | null {
  if (multi.rounds <= 0) return null
  const round = (p: number): string => `${a}${Math.round(p)}%`
  return (
    <>
      <StatItem label="Rounds" value={`${a}${fmt(multi.rounds)}`} />
      {multi.doubledPct > 0 && <StatItem label="Double attack" value={round(multi.doubledPct)} />}
      {multi.tripledPct > 0 && <StatItem label="Triple attack" value={round(multi.tripledPct)} />}
      {multi.quadPct > 0 && <StatItem label="Quad+ attack" value={round(multi.quadPct)} />}
      {multi.estimated && <StatItem label="Multi-attack" value="estimated" color="text.disabled" />}
    </>
  )
}
