import { type JSX } from 'react'
import { Box, Typography } from '@mui/material'
import { formatAiSpend } from '@shared/aiModels'
import type { AiUsageSnap } from '@shared/aiChat'
import { aiChatPhaseLabel, type AiChatPhase } from '@shared/aiSlash'

export function AISpendBar({ usage, phase }: { usage: AiUsageSnap; phase: AiChatPhase }): JSX.Element {
  return (
    <Box
      data-testid="ai-spend-bar"
      sx={{
        px: 1.5,
        py: 0.5,
        borderTop: 1,
        borderColor: 'divider',
        display: 'flex',
        justifyContent: 'space-between',
        gap: 1,
        flexShrink: 0
      }}
    >
      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
        {formatAiSpend(usage.spendUsd)}
      </Typography>
      <Typography
        variant="caption"
        color={phase === 'error' ? 'error' : phase === 'awaiting' ? 'warning' : 'text.secondary'}
        data-testid="ai-chat-phase"
        sx={{ flexShrink: 0 }}
      >
        {aiChatPhaseLabel(phase)}
      </Typography>
      <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0, textAlign: 'right' }}>
        {usage.modelLabel}
      </Typography>
    </Box>
  )
}
