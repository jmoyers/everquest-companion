import { type JSX, useState } from 'react'
import { Button, Stack, Typography } from '@mui/material'
import type { AiDumpStatus, AiLiveStatus } from '@shared/aiChat'
import { outputKind } from '@shared/outputs/kinds'
import { dumpOf } from './dumpStatus'

function CopyDump(props: { dump: AiDumpStatus; label: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const command = props.dump.command || outputKind(props.dump.kind).command
  const onCopy = (): void => {
    void window.eq.writeClipboard(command).then((ok) => {
      if (ok) setCopied(true)
    })
  }
  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <Button size="small" variant="outlined" onClick={onCopy} data-testid={`ai-copy-${props.dump.kind}`}>
        {copied ? 'Copied' : props.label}
      </Button>
      <Typography variant="caption" color="text.secondary">
        Type this in EverQuest. Do not paste here.
      </Typography>
    </Stack>
  )
}

export function AIDumpCoach({ status }: { status: AiLiveStatus }): JSX.Element | null {
  const inv = dumpOf(status, 'inventory')
  const book = dumpOf(status, 'spellbook')
  const showInv = inv?.empty === true
  const showBook = book?.empty === true
  if (!showInv && !showBook) return null
  return (
    <Stack spacing={0.5} sx={{ px: 1, pb: 0.5 }} data-testid="ai-dump-coach">
      {showInv && inv && <CopyDump dump={inv} label="Copy /outputfile inventory" />}
      {showBook && book && <CopyDump dump={book} label="Copy /outputfile spellbook" />}
    </Stack>
  )
}
