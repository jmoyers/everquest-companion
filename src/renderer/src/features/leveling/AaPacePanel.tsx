// AaPacePanel — the Leveling tab's answer once the level bar stops moving: how fast AA is
// coming in, when the next point lands, and what the item-shop bottle is doing to the points.
//
// Presentation ONLY. Every number arrives already computed by the pure `shared/aaPace.ts` and
// every string is shaped by the pure `aaPaceRows.ts` beside this file, so the one thing this
// panel exists to make visible — WHICH numbers the game printed and which are a model over
// them — is pinned by tests rather than buried in JSX. The two rate tiles are counts; the ETA
// and the charge count wear an `inferred` chip and say, on hover, exactly what the log stated
// and what was assumed on top of it.

import { type JSX } from 'react'
import { Box, Chip, Paper, Stack, Typography } from '@mui/material'
import SpeedIcon from '@mui/icons-material/Speed'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import HourglassBottomIcon from '@mui/icons-material/HourglassBottom'
import ScienceIcon from '@mui/icons-material/Science'
import type { AaPace } from '@shared/aaPace'
import { Tooltip } from '../../lib/Tooltip'
import { aaPaceCaption, aaPaceTiles, type AaPaceTile } from './aaPaceRows'

/** The leveling feature's existing hero hues, reused rather than re-invented. */
const ACCENT: Record<AaPaceTile['id'], string> = {
  rate: '#6fb3d2',
  points: '#b07fd0',
  eta: '#5fbf72',
  potion: '#d9b25f'
}

const ICON: Record<AaPaceTile['id'], JSX.Element> = {
  rate: <SpeedIcon />,
  points: <AutoAwesomeIcon />,
  eta: <HourglassBottomIcon />,
  potion: <ScienceIcon />
}

function PaceTile({ tile }: { tile: AaPaceTile }): JSX.Element {
  const accent = ACCENT[tile.id]
  return (
    <Tooltip title={tile.title}>
      <Paper
        variant="outlined"
        sx={{ p: 1.25, flex: 1, minWidth: 150, borderLeft: `3px solid ${accent}`, display: 'flex', gap: 1 }}
        data-testid={`leveling-aa-tile-${tile.id}`}
      >
        <Box sx={{ color: accent, display: 'flex', alignItems: 'center' }}>{ICON[tile.id]}</Box>
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={0.5} alignItems="baseline">
            <Typography variant="h5" sx={{ lineHeight: 1.1, color: accent }} noWrap>
              {tile.value}
            </Typography>
            {tile.unit && (
              <Typography variant="caption" color="text.secondary" noWrap>
                {tile.unit}
              </Typography>
            )}
          </Stack>
          <Typography variant="body2" noWrap>
            {tile.label}
          </Typography>
          {/* State, not process: the chip says the number is a model, and the tile's tooltip
              says which part of it the log actually printed. */}
          {tile.inferred && (
            <Chip size="small" variant="outlined" label="inferred" sx={{ height: 18, mt: 0.25 }} />
          )}
        </Box>
      </Paper>
    </Tooltip>
  )
}

export interface AaPacePanelProps {
  pace: AaPace
  /** the window the rates cover, already worded (e.g. 'last hour of the log'). */
  windowLabel: string
}

/**
 * Rendered whenever the log holds any AA at all. A character with no AA yet sees nothing here
 * rather than a row of em-dashes: the panel is a set of facts, and its presence is one of them.
 */
export function AaPacePanel({ pace, windowLabel }: AaPacePanelProps): JSX.Element | null {
  const tiles = aaPaceTiles(pace)
  return (
    <Paper variant="outlined" sx={{ p: 2 }} data-testid="leveling-aa-pace">
      <Typography variant="subtitle2">AA pace</Typography>
      <Typography variant="caption" color="text.secondary" gutterBottom display="block">
        {windowLabel} - {aaPaceCaption(pace)}
      </Typography>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
        {tiles.map((t) => (
          <PaceTile key={t.id} tile={t} />
        ))}
      </Stack>
    </Paper>
  )
}
