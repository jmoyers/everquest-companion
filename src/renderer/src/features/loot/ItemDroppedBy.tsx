// loot/ItemDroppedBy.tsx — the drill-down's OBSERVED mob column: who dropped this for YOU, as a
// bar per name, most-seen first. Split out of ItemDetailDialog.tsx when that file hit the
// factoring ceiling (the same reason ItemDetailPane left it) — the dialog keeps the fold
// (`aggregateLoot`) and this file keeps the drawing.
//
// The names are LOG names, so the door they open is the bare-name `MobTarget` — the same payload
// Overview's recent-kills rows send, and the same honest degradation when no catalog page pins
// the spelling ("unknown" simply is not a mob, and opens a page that says so).

import type { JSX, ReactNode } from 'react'
import { Box, Stack, Typography } from '@mui/material'
import { CellLink } from '../../lib/CellLink'
import type { MobTarget } from '../mobs/mobTarget'
import { ObservedChip } from './ItemDbSources'

/** One name's tally — the dialog's `aggregateLoot` builds these for mobs and zones alike. */
export interface LootTally {
  name: string
  count: number
}

/* The observed columns are YOUR loot history — chipped `observed` since 2026-08-04, because the
   `db` columns below them answer the same question from the committed wiki data and the two must
   never read as one list. "You have never looted this" is now a statement about you, not about
   the item. */
export function ObservedHead({ title, hint }: { title: string; hint?: string }): JSX.Element {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.5 }}>
      <Typography variant="subtitle2">{title}</Typography>
      {hint !== undefined && (
        <Typography component="span" variant="caption" color="text.secondary">
          {hint}
        </Typography>
      )}
      <ObservedChip />
    </Stack>
  )
}

function Bar({
  label,
  value,
  max,
  right
}: {
  label: ReactNode
  value: number
  max: number
  right: string
}): JSX.Element {
  const pct = max > 0 ? (value / max) * 100 : 0
  return (
    <Box sx={{ mb: 0.75 }}>
      <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.25 }}>
        <Typography variant="caption" noWrap sx={{ maxWidth: 220 }}>
          {label}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {right}
        </Typography>
      </Stack>
      <Box sx={{ height: 8, bgcolor: 'action.hover', borderRadius: 1 }}>
        <Box sx={{ height: 8, width: `${pct}%`, bgcolor: 'secondary.main', borderRadius: 1 }} />
      </Box>
    </Box>
  )
}

export function DroppedByColumn({
  sources,
  max,
  onOpenMob
}: {
  sources: LootTally[]
  max: number
  onOpenMob?: (t: MobTarget) => void
}): JSX.Element {
  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <ObservedHead title="Dropped by" hint="(times seen)" />
      {sources.length === 0 && <Typography variant="caption">You have not looted this yet.</Typography>}
      {sources.map((s) => (
        <Bar
          key={s.name}
          // A LOG name, so the bare-name target — the same payload Overview's recent-kills rows
          // send, and the same honest degradation when no catalog page pins it.
          label={onOpenMob === undefined ? s.name : (
            <CellLink text={s.name} onOpen={() => { onOpenMob({ mob: s.name }) }} />
          )}
          value={s.count}
          max={max}
          right={`${s.count}× seen`}
        />
      ))}
    </Box>
  )
}
