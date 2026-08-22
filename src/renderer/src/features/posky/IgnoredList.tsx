// posky/IgnoredList.tsx — the Ignored tab's flat list.
//
// SPLIT OUT OF PoskyView.tsx FOR FILE MASS, NOT FOR SCOPE (JOS-186), and it is the seam that file's
// measured 400-code-line ceiling was pointing at: every other tab in that view draws the SAME quest
// accordion over a different set of rows, and this one deliberately draws something else — a flat,
// compact, un-expandable row, because there is nothing to work on here. It shares nothing with the
// view but the row shape it refuses. No behaviour changed in the move.

import type { JSX } from 'react'
import { Box, Chip, Stack, Typography } from '@mui/material'
import { QuestIgnoreButton } from '../favorites/QuestFlagButtons'
import { TurnInBadge } from './TurnInControls'
import type { QuestProgress } from './useProgress'

// Every quest the user hid, in one flat compact list (no accordions — there is nothing to work on
// here), each row carrying the same button that put it here, now reading "Stop ignoring".
// Un-ignoring drops the row instantly and the quest reappears under Quests with its favorite state
// untouched.
export function IgnoredList({
  quests,
  onUnignore
}: {
  quests: QuestProgress[]
  onUnignore: (questKey: string) => void
}): JSX.Element {
  if (quests.length === 0) {
    return (
      <Typography color="text.secondary">
        No ignored quests - hide one with the eye icon on its row and it lands here.
      </Typography>
    )
  }
  return (
    <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {quests.length} quest{quests.length === 1 ? '' : 's'} hidden from the list, filters and counts.
      </Typography>
      <Stack spacing={0.5}>
        {quests.map((q) => (
          <Stack
            key={q.key}
            direction="row"
            spacing={2}
            alignItems="center"
            sx={{ px: 1, py: 0.5, borderRadius: 1, '&:hover': { bgcolor: 'action.hover' } }}
          >
            <QuestIgnoreButton ignored onToggle={() => onUnignore(q.key)} />
            <Chip label={q.className} size="small" color="secondary" variant="outlined" sx={{ minWidth: 92 }} />
            <Typography variant="subtitle2" sx={{ minWidth: 220 }}>
              {q.name}
            </Typography>
            {q.reward && (
              <Typography variant="caption" color="primary.main">
                → {q.reward}
              </Typography>
            )}
            <Box sx={{ flexGrow: 1 }} />
            <TurnInBadge count={q.turnIns} evidence={q.completionEvidence} />
          </Stack>
        ))}
      </Stack>
    </Box>
  )
}
