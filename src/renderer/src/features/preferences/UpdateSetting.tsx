// The Preferences > Updates section: app version, last-checked time, a manual
// check, background download progress, and the "Relaunch to update" action when
// one is waiting.
//
// Split out of PreferencesView.tsx for file mass — the section is self-contained:
// it owns the shared update-status subscription and every piece of UI that reads
// it, and PreferencesView only names the three exports in its section table.

import { type JSX, useCallback, useEffect, useState } from 'react'
import { Box, Button, Chip, FormControlLabel, LinearProgress, Link, Stack, Switch, Typography } from '@mui/material'
import RefreshIcon from '@mui/icons-material/Refresh'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import type { UpdateStatus } from '@shared/types'
import { type UpdateChipState, updateChipState } from '@shared/update'
import { formatDateTime } from '../../lib/formatDate'
import { recordPref, usePrefsSeed } from './prefsHydration'

interface ChipLook {
  label: string
  color: 'default' | 'success' | 'info' | 'warning'
}

const STATE_CHIP: Record<UpdateStatus['state'], ChipLook> = {
  idle: { label: 'up to date', color: 'default' },
  checking: { label: 'checking', color: 'info' },
  available: { label: 'update available', color: 'info' },
  downloading: { label: 'downloading', color: 'info' },
  ready: { label: 'update ready', color: 'success' },
  error: { label: 'check failed', color: 'warning' }
}

/**
 * Shared status state: SEEDED with the last one (pushes predate this mount), then following
 * pushes.
 *
 * The pull used to be an effect that started from `{ state: 'idle' }` (JOS-340), so a user with a
 * downloaded update waiting read "up to date" for a frame before the Relaunch button appeared —
 * the one state in this card where the wrong frame is also the wrong ADVICE. The seed is the same
 * pull, taken by the pane's gate before anything paints (./prefsHydration.tsx); the subscription
 * is untouched, because a push is news rather than hydration.
 */
export function useUpdateStatus(): UpdateStatus {
  const [status, setStatus] = useState<UpdateStatus>(usePrefsSeed().updateStatus)
  useEffect(() => {
    recordPref('updateStatus', status)
  }, [status])
  useEffect(() => window.eq.onUpdateStatus(setStatus), [])
  return status
}

/**
 * The version, and the way from it to what that version changed (JOS-73).
 *
 * The version number is the thing a person is looking at when the question "…and what is
 * different about it?" occurs to them, so the answer is one click from here rather than only
 * from the teaser strip, which a user can dismiss forever in half a second. It is a link and not
 * a second copy of the panel: the notes have ONE home (Preferences → What's new), and this is a
 * rail switch to it — manual navigation inside Preferences, so nothing is parked and there is
 * nothing to come Back from.
 */
export function VersionSetting({
  version,
  onWhatsNew
}: {
  version: string
  onWhatsNew: () => void
}): JSX.Element {
  return (
    <Stack direction="row" alignItems="baseline" spacing={1.5}>
      <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
        {version ? `v${version}` : '-'}
      </Typography>
      <Link component="button" type="button" variant="caption" data-testid="pref-version-whats-new" onClick={onWhatsNew}>
        What&rsquo;s new
      </Link>
    </Stack>
  )
}

/**
 * Which chip the headline shows. `ui` is the same pure mapping the left-nav chip
 * uses, so the two surfaces can never disagree — in particular about the
 * updated-away case (a 'ready' naming the build we are ALREADY running is stale,
 * so updateChipState demotes it to 'quiet' and we must not claim "update ready").
 */
function chipLook(status: UpdateStatus, ui: UpdateChipState): ChipLook {
  // Dev build: the updater is off, so "up to date" would be a claim no check ever made.
  if (status.disabled) return { label: 'dev build - updates off', color: 'default' }
  if (ui.kind === 'quiet' && status.state === 'ready') return STATE_CHIP.idle
  return STATE_CHIP[status.state]
}

/**
 * THE AUTO-UPDATE SWITCH. On by default; the ONLY thing that lets the app check, download or install
 * on its own — the two buttons below work regardless. Optimistic: the switch moves on click, then
 * `status.auto` (pushed back by main) confirms it.
 *
 * It reflects `status.auto` rather than owning the value, so the nav chip and this switch can never
 * disagree — the same discipline the rest of this card follows.
 */
function AutoUpdateToggle({ status }: { status: UpdateStatus }): JSX.Element {
  const [on, setOn] = useState(status.auto ?? false)
  useEffect(() => setOn(status.auto ?? false), [status.auto])
  const toggle = useCallback((next: boolean) => {
    setOn(next)
    void window.eq.setAutoUpdate(next)
  }, [])
  return (
    <Stack spacing={0.5} data-testid="pref-auto-update">
      <FormControlLabel
        control={
          <Switch
            size="small"
            data-testid="pref-auto-update-switch"
            checked={on}
            onChange={(e) => toggle(e.target.checked)}
          />
        }
        label={<Typography variant="body2">Update automatically</Typography>}
      />
      <Typography variant="caption" color="text.secondary">
        {on
          ? 'The app checks for updates in the background, downloads them, and installs the next time you close it.'
          : 'Updates are manual - the app never checks, downloads, or installs on its own. Use “Check for updates” below, then “Restart to update”.'}
      </Typography>
    </Stack>
  )
}

/** The headline: state chip + when we last asked. */
function UpdateHeadline({
  status,
  chip,
  busy
}: {
  status: UpdateStatus
  chip: ChipLook
  busy: boolean
}): JSX.Element {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
      <Chip
        size="small"
        variant="outlined"
        color={chip.color === 'default' ? undefined : chip.color}
        label={busy ? 'checking' : chip.label}
      />
      <Typography variant="caption" color="text.secondary">
        Last checked: {status.checkedAt ? formatDateTime(status.checkedAt) : 'never'}
      </Typography>
    </Box>
  )
}

/** Background download progress — nothing at all unless a download is actually running. */
function UpdateProgress({
  status,
  downloading
}: {
  status: UpdateStatus
  downloading: boolean
}): JSX.Element | null {
  if (!downloading) return null
  return (
    <Box sx={{ maxWidth: 360 }}>
      <LinearProgress
        variant={status.percent != null ? 'determinate' : 'indeterminate'}
        value={status.percent ?? 0}
        sx={{ borderRadius: 1 }}
      />
      <Typography variant="caption" color="text.secondary">
        {status.version ? `v${status.version} - ` : ''}
        {status.percent ?? 0}%
      </Typography>
    </Box>
  )
}

/**
 * The failure DETAIL. Since JOS-307 the nav chip no longer swallows the fact of a failure — it
 * says "update check failed" in its own line — but it still carries only the fact; this is where
 * the sentence lives, at full width and without a hover.
 *
 * `status.message` has exactly one producer (`describeUpdateFailure`), which is what guarantees the
 * two surfaces read the same words. For the JSON-parse family (GitHub issue 29, in-app report
 * 01KZYN843T99R2JHYDTF9TS8AK) that sentence is deliberately not the parser's: `Unexpected end of
 * JSON input` is what a user was left staring at on 0.20, and it is neither true nor actionable.
 */
function UpdateError({ status }: { status: UpdateStatus }): JSX.Element | null {
  if (status.state !== 'error' || !status.message) return null
  return (
    <Typography variant="caption" color="warning.main" sx={{ wordBreak: 'break-word' }}>
      {status.message}
    </Typography>
  )
}

/** Relaunch when a build is staged, otherwise the manual check. */
function UpdateActions({
  status,
  ui,
  ready,
  busy,
  cooldown,
  onCheck
}: {
  status: UpdateStatus
  ui: UpdateChipState
  ready: boolean
  busy: boolean
  cooldown: boolean
  onCheck: () => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={1}>
      {ready ? (
        <Button
          variant="contained"
          color="success"
          size="small"
          startIcon={<RestartAltIcon />}
          onClick={() => void window.eq.installUpdate()}
        >
          Restart to update{ui.kind === 'ready' && ui.version ? ` - v${ui.version}` : ''}
        </Button>
      ) : (
        <Button
          variant="outlined"
          size="small"
          startIcon={<RefreshIcon />}
          onClick={onCheck}
          disabled={busy || cooldown || status.disabled}
        >
          Check for updates
        </Button>
      )}
    </Stack>
  )
}

export function UpdateSetting({
  status,
  version
}: {
  status: UpdateStatus
  version: string
}): JSX.Element {
  const [checking, setChecking] = useState(false)
  // Same post-check cooldown as the nav chip (10s): one answer is valid for at least
  // that long, and it keeps a rapid clicker from hammering the release feed.
  const [cooldown, setCooldown] = useState(false)
  const ui = updateChipState(status, version || undefined)
  const chip = chipLook(status, ui)
  const busy = checking || status.state === 'checking'
  const ready = ui.kind === 'ready'
  const downloading = ui.kind === 'downloading'

  const checkNow = useCallback(async () => {
    setChecking(true)
    try {
      await window.eq.checkForUpdates()
    } finally {
      setChecking(false)
      setCooldown(true)
      setTimeout(() => setCooldown(false), 10_000)
    }
  }, [])

  return (
    <Stack spacing={1.25}>
      <AutoUpdateToggle status={status} />
      <UpdateHeadline status={status} chip={chip} busy={busy} />
      <UpdateProgress status={status} downloading={downloading} />
      <UpdateError status={status} />
      <UpdateActions
        status={status}
        ui={ui}
        ready={ready}
        busy={busy}
        cooldown={cooldown}
        onCheck={() => void checkNow()}
      />
    </Stack>
  )
}
