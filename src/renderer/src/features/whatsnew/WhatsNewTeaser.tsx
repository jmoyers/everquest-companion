// ============================================================================
// The what's-new TEASER — one quiet line along the bottom, the first launch after an update.
// ============================================================================
//
// IT IS THE TELEMETRY NOTICE'S SHAPE, DELIBERATELY (features/preferences/TelemetryNotice.tsx).
// A fixed-position, portalled Snackbar holding one sentence and two controls along the bottom
// edge: it floats over the content area, reflows nothing, moves nothing above it, and takes no
// focus. This app must never interrupt play — a modal here would be a dialog thrown across a
// raid, and even a banner that pushed the layout down would move a meter someone is reading.
//
// THE RULES IT OBEYS:
//
//   * IT NAMES ONE VERSION — the newest. Somebody who skipped three releases lands with one
//     sentence about where they are, not an inventory of everything they missed. The panel is
//     where the list lives, and it marks all three.
//   * DISMISSAL IS PER VERSION, not forever. The X stamps the newest release as seen
//     (features/whatsnew/session.ts), so this strip is a once-per-update event and the NEXT
//     update earns its own line. There is no "don't show me these again", because a user who
//     never wants release notes simply never clicks, and one line per release is the whole cost.
//   * READING THE NOTES COUNTS AS SEEING THEM. "See what's new" navigates and hides the strip
//     WITHOUT stamping — the panel does that on arrival, and it is the panel's stamp that keeps
//     this launch's highlights on screen while the user reads them.
//   * A FRESH INSTALL NEVER SEES IT. That falls out of the derivation rather than being special
//     cased here: no stored last-seen version means no news (shared/releaseNotes.ts). It is also
//     why this can never collide with the first-run telemetry notice at the same screen edge —
//     the launch that shows one is exactly the launch that cannot show the other.
//   * ABSENT UNDER `EQ_E2E` FOR FREE, for the same reason: the harness gives every launch a
//     temp userData, so the key is absent and the state is "fresh". A spec that wants this strip
//     seeds the store; nothing here checks for a test mode.
//
// Mounted from App.tsx unconditionally: it reads the state itself and renders nothing at all
// when there is no news, which is every launch except the first one after an update.

import { type JSX, useEffect, useState } from 'react'
import { IconButton, Link, Paper, Snackbar, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import { markReleaseNotesSeen, useWhatsNew } from './session'

export function WhatsNewTeaser({ onOpen }: { onOpen: () => void }): JSX.Element | null {
  const state = useWhatsNew()
  const version = state?.teaserVersion ?? null
  const [dismissed, setDismissed] = useState(false)

  // A DIFFERENT version is a different announcement. Nothing but the DEV variant control can
  // change this mid-session, and when it does the strip must come back rather than stay hidden
  // behind a dismissal of some other release.
  useEffect(() => {
    setDismissed(false)
  }, [version])

  if (version === null || dismissed) return null

  return (
    <Snackbar
      open
      // No autoHideDuration, for the reason the telemetry notice states: a line that vanishes on
      // its own was never shown to anyone who looked away. It closes when the user closes it.
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      sx={{ left: 16, right: 16, bottom: 16, transform: 'none' }}
    >
      <Paper
        elevation={6}
        sx={{ px: 2, py: 1, width: '100%', display: 'flex', alignItems: 'center', gap: 1.5 }}
        data-testid="whats-new-teaser"
      >
        <Typography variant="body2" sx={{ flexGrow: 1, minWidth: 0 }} data-testid="whats-new-teaser-text">
          Updated to v{version}
        </Typography>

        {/* Navigates and hides; the PANEL stamps this seen when it opens, which is what keeps
            the new-release marks up while they are being read. */}
        <Link
          component="button"
          type="button"
          variant="body2"
          data-testid="whats-new-teaser-open"
          onClick={() => {
            setDismissed(true)
            onOpen()
          }}
        >
          See what&rsquo;s new
        </Link>

        <IconButton
          size="small"
          aria-label="Dismiss - you can read the notes any time in Preferences"
          data-testid="whats-new-teaser-dismiss"
          onClick={() => {
            setDismissed(true)
            markReleaseNotesSeen()
          }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Paper>
    </Snackbar>
  )
}
