import { type JSX, useState } from 'react'
import { Box, Button, Chip, Collapse, Stack, Typography } from '@mui/material'
import type { AiLiveStatus } from '@shared/aiChat'
import { bagsLabel, spellbookLabel } from './dumpStatus'

function trioLine(status: AiLiveStatus): string | null {
  if (status.loadout.classes.length === 0) return null
  return status.loadout.classes.slice(0, 3).join(' / ')
}

export function AIStatusStrip(props: { status: AiLiveStatus; dumpNotices: string[] }): JSX.Element {
  const { status, dumpNotices } = props
  const [recapOpen, setRecapOpen] = useState(false)
  const trio = trioLine(status)
  const bags = bagsLabel(status, Date.now())
  const book = spellbookLabel(status, Date.now())
  const recap = status.recap.slice(-8)

  return (
    <Box
      data-testid="ai-status-strip"
      sx={{ px: 1.25, py: 0.75, flexShrink: 0, borderRadius: 1, bgcolor: 'background.paper' }}
    >
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="nowrap" sx={{ minWidth: 0 }}>
        <Typography variant="body2" noWrap sx={{ fontWeight: 600, flexShrink: 0 }}>
          AI Assistant
        </Typography>
        <Typography variant="body2" noWrap color="text.secondary" sx={{ minWidth: 0 }}>
          {status.zone ?? 'zone unknown'}
        </Typography>
        {trio && (
          <Typography variant="caption" noWrap color="text.secondary" sx={{ minWidth: 0 }}>
            {trio}
          </Typography>
        )}
        {status.loadout.inferred && <Chip size="small" variant="outlined" label="inferred" sx={{ height: 20, flexShrink: 0 }} />}
        {bags && (
          <Typography variant="caption" noWrap color="text.secondary" sx={{ flexShrink: 0 }}>
            {bags}
          </Typography>
        )}
        {book && (
          <Typography variant="caption" noWrap color="text.secondary" sx={{ flexShrink: 0 }}>
            {book}
          </Typography>
        )}
        {dumpNotices.map((n) => (
          <Chip key={n} size="small" label={n} data-testid="ai-dump-notice" sx={{ height: 20, flexShrink: 0 }} />
        ))}
        {recap.length > 0 && (
          <Button size="small" sx={{ ml: 'auto', flexShrink: 0 }} onClick={() => setRecapOpen((o) => !o)}>
            {recapOpen ? 'Hide recap' : 'Recap'}
          </Button>
        )}
      </Stack>
      <Collapse in={recapOpen}>
        <Box data-testid="ai-recap" sx={{ mt: 0.75 }}>
          {recap.map((line, i) => (
            <Typography key={i} variant="caption" display="block" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
              {line}
            </Typography>
          ))}
        </Box>
      </Collapse>
    </Box>
  )
}
