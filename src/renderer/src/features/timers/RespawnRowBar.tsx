// One respawn clock, drawn (JOS-194). Used by the Timers tab; the floating overlay draws the same
// facts with plain divs because that bundle is MUI-free, and both surfaces take the clock's
// WORDING and the provenance line from `shared/respawn.ts` rather than spelling either twice.
//
// WHAT THE ROW IS CAREFUL ABOUT. It never says the mob is up. `due` means the estimate elapsed,
// the label says "due" and not "spawned", and the provenance line under the name states which
// rung of the ladder produced the number and how thin the evidence is ("your kills (2 gaps)").
// A countdown with no provenance is a countdown the user has to trust blindly, and the whole
// argument of this feature is that the number the wiki would have given them does not deserve
// that (shared/respawnWiki.ts).

import { Box, LinearProgress, Stack, Typography } from '@mui/material'
import type { JSX } from 'react'
import {
  respawnClockLabel,
  respawnFloored,
  respawnReading,
  respawnSourceLabel,
  type RespawnRow
} from '@shared/respawn'
import Tooltip from '../../lib/Tooltip'
import { fmtDuration } from '../buffs/format'

/** The sentence that explains a LEARNED number, including what a gap does and does not prove. */
function observedSentence(row: RespawnRow): string {
  const gaps = `${String(row.samples)} gap${row.samples === 1 ? '' : 's'}`
  return (
    `Your shortest gap between two deaths of this mob, in one continuous stay in the zone, was ` +
    `${fmtDuration(row.observedMs)} over ${gaps}. A gap is an upper bound - you cannot kill it ` +
    `before it spawns - so the real respawn is at most this.`
  )
}

/** Why this row's number is the number it is. One rung's sentence, then the wiki's own words. */
const RUNG_SENTENCE: Record<RespawnRow['source'], string> = {
  custom: 'You set this number yourself. Nothing overrides it.',
  observed: '',
  wiki: 'No gap of your own yet, so this is the wiki default.',
  none: 'Nothing states a respawn for this mob yet. Kill it twice in one visit, or type a number.'
}

export function respawnProvenance(row: RespawnRow): string {
  const parts = [row.source === 'observed' ? observedSentence(row) : RUNG_SENTENCE[row.source]]
  if (row.wikiText !== undefined) parts.push(`The wiki says: "${row.wikiText}".`)
  if (respawnFloored(row)) {
    parts.push('The wiki floor lifted this estimate - two mobs of one name can die together and drive your gap too low.')
  }
  parts.push(`Killed ${String(row.kills)} time${row.kills === 1 ? '' : 's'} here.`)
  return parts.filter((p) => p.length > 0).join(' ')
}

/** The left accent: green once the clock ran out, blue while it runs. Every row on screen is a mob
 *  the user asked for (tracking is opt-in), so there is no second class of row to colour apart. */
function accent(due: boolean): string {
  return due ? 'success.main' : 'info.main'
}

export function RespawnRowBar({ row, nowMs }: { row: RespawnRow; nowMs: number }): JSX.Element {
  const r = respawnReading(row, nowMs)
  const hasEstimate = row.estimateMs !== undefined
  return (
    <Tooltip title={respawnProvenance(row)} placement="top-start">
      <Box
        data-testid="respawn-row"
        data-respawn-mob={row.key}
        data-respawn-source={row.source}
        data-respawn-due={r.due ? 'true' : 'false'}
        sx={{
          px: 1,
          py: 0.75,
          borderLeft: 3,
          borderColor: accent(r.due),
          bgcolor: 'action.hover',
          borderRadius: 0.5
        }}
      >
        <Stack direction="row" spacing={1} alignItems="baseline" sx={{ minWidth: 0 }}>
          <Typography
            variant="body2"
            sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {row.display}
          </Typography>
          <Typography
            variant="body2"
            data-testid="respawn-clock"
            sx={{ fontVariantNumeric: 'tabular-nums', color: r.due ? 'success.main' : 'text.primary' }}
          >
            {respawnClockLabel(row, nowMs, fmtDuration)}
          </Typography>
        </Stack>
        <Stack direction="row" spacing={1} alignItems="baseline">
          <Typography variant="caption" sx={{ flex: 1, minWidth: 0, color: 'text.secondary' }}>
            {row.zone.length > 0 ? row.zone : 'unknown zone'} · {respawnSourceLabel(row)}
          </Typography>
          {hasEstimate && (
            <Typography variant="caption" sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
              {row.source === 'observed' ? '<= ' : ''}
              {fmtDuration(row.estimateMs)}
            </Typography>
          )}
        </Stack>
        {/* The bar is the estimate running down. Absent entirely when there is no estimate rather
            than drawn empty - an empty bar reads as "nearly up", which would be a lie. */}
        {hasEstimate && (
          <LinearProgress
            variant="determinate"
            value={(1 - r.fraction) * 100}
            color={r.due ? 'success' : 'info'}
            sx={{ mt: 0.5, height: 3, borderRadius: 2 }}
          />
        )}
      </Box>
    </Tooltip>
  )
}
