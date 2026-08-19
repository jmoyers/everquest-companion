import { type JSX } from 'react'
import { Button, Stack, Typography } from '@mui/material'
import type { AlertDef } from '@shared/alertTypes'

function triggerLabel(def: AlertDef): string {
  const t = def.trigger
  if (t.type === 'event') return t.where?.spell ? `spell ${t.where.spell}` : `event ${t.kind}`
  if (t.type === 'raw') return `regex ${t.regex}`
  return t.type
}

export function AIDraftCard(props: {
  def: AlertDef
  onOpenAlerts: () => void
  onResolved: (id: string) => void
}): JSX.Element {
  const { def, onOpenAlerts, onResolved } = props
  return (
    <Stack spacing={1} sx={{ mt: 1, p: 1, border: 1, borderColor: 'divider', borderRadius: 1 }} data-testid="ai-alert-draft">
      <Typography variant="body2" fontWeight="bold">
        {def.name}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {triggerLabel(def)}
      </Typography>
      <Stack direction="row" spacing={1} flexWrap="wrap">
        <Button
          size="small"
          variant="contained"
          onClick={() => {
            void window.eq.saveAiDraftAlert(def).then(() => onResolved(def.id))
          }}
        >
          Save alert
        </Button>
        <Button size="small" onClick={() => onResolved(def.id)}>
          Dismiss
        </Button>
        <Button size="small" data-testid="ai-open-alerts" onClick={onOpenAlerts}>
          Open in Alerts
        </Button>
      </Stack>
    </Stack>
  )
}
