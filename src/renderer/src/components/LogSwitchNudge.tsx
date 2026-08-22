// components/LogSwitchNudge.tsx — "another character's log is active — switch?" (JOS-432).
//
// The on-screen half of the quiet-switch mechanism. Main decides WHEN to ask and guarantees it asks
// at most once per candidate log per app session (src/main/log/quietSwitch.ts holds both the
// decision and the argument); this card's whole job is to state the offer and carry the click.
//
// SELF-CONTAINED ON PURPOSE. App.tsx sits at the measured 400-line factoring ceiling, and this
// needs nothing from the shell: it subscribes to its own push, holds its own one-slot state, and
// switches through the same `character:set` IPC the title bar's selector uses — after which main's
// `log:character` rebuild lands in App's existing subscription and re-hydrates every view. So the
// shell gains one element and no state.
//
// NO RATE LIMITING LIVES HERE, deliberately. A renderer-side "don't show it again" would be a
// SECOND memory that could disagree with main's — and it would be the one that forgets, since the
// renderer reloads on an ErrorBoundary recovery and main does not. Dismissing therefore only clears
// the card: the fact that we asked was recorded in main the instant it asked.
//
// It does NOT auto-hide. A card that appears at most once per log per session and answers "is this
// app broken?" is worth waiting for the user to actually see — and, unlike the celebration toasts,
// it has an action. Clickaway is ignored for the same reason.

import { type JSX, useEffect, useState } from 'react'
import { Alert, AlertTitle, Button, Snackbar, Stack } from '@mui/material'
import SwapHorizIcon from '@mui/icons-material/SwapHoriz'
import type { LogSwitchNudge as Nudge } from '@shared/types'

/** "12 minutes" / "5 minutes" — the silence, in the words a person would use. */
function quietFor(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`
}

export default function LogSwitchNudge(): JSX.Element | null {
  const [nudge, setNudge] = useState<Nudge | null>(null)

  useEffect(() => window.eq.onLogSwitchNudge(setNudge), [])

  if (!nudge) return null
  const { attached, candidate } = nudge

  const switchTo = (): void => {
    setNudge(null)
    void window.eq.setCharacter(candidate.logPath)
  }

  return (
    <Snackbar
      open
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      data-testid="log-switch-nudge"
    >
      <Alert
        severity="info"
        variant="filled"
        icon={<SwapHorizIcon fontSize="inherit" />}
        sx={{ alignItems: 'flex-start', maxWidth: 420 }}
      >
        <AlertTitle>Another character&apos;s log is active</AlertTitle>
        <Stack spacing={1} alignItems="flex-start">
          <span data-testid="log-switch-nudge-text">
            {attached.name}&apos;s log has been quiet for {quietFor(nudge.quietMs)}, but{' '}
            {candidate.name}&apos;s is being written to right now. Switch to {candidate.name}?
          </span>
          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              color="inherit"
              variant="outlined"
              data-testid="log-switch-nudge-switch"
              onClick={switchTo}
            >
              Switch to {candidate.name}
            </Button>
            {/* Dismissing clears the CARD and nothing else — main already recorded that it asked,
                which is why this cannot be the step that forgets. */}
            <Button
              size="small"
              color="inherit"
              data-testid="log-switch-nudge-dismiss"
              onClick={() => {
                setNudge(null)
              }}
            >
              Not now
            </Button>
          </Stack>
        </Stack>
      </Alert>
    </Snackbar>
  )
}
