// AlertBannerSetting — Preferences → Overlays → "Alert banner" (JOS-378).
//
// FOUR controls over one window: is it on, where does it sit, how long a line stays, and how many
// lines fit. (The fifth knob — text size — is on the banner's own frame, because that frame is the
// only chrome this kind ever shows and a size control that lived here would be sizing something
// you cannot see. The toast card next door makes the same choice for the same reason.)
//
// ON/OFF IS THE WINDOW'S OPEN-STATE. There is no second `enabled` flag: the banner is an overlay
// kind, so "on" means its window is open, persisted and restored exactly like every other
// overlay's. Two switches for one state is how they drift.
//
// IT STARTS OFF AND SAYS SO. Unlike the celebration toast this kind ships DISABLED (owner ruling),
// so this card mounts on the shipped defaults and corrects itself from main a beat later — and
// those defaults are the honest guess for the overwhelming majority of installs, which is exactly
// the condition JOS-340's hydration seed exists to satisfy. A card that painted ON and then fell
// to OFF would be the bug that seed was built for; this one cannot.
//
// STATE, NEVER PROCESS (the repo's UI law): every caption says what is true now, not how the
// window is implemented. Nothing here mentions click-through, IPC or queues.

import { type JSX, useCallback, useEffect, useState } from 'react'
import { FormControlLabel, MenuItem, Select, Stack, Switch, Typography } from '@mui/material'
import {
  BANNER_MAX_HOLD_MS,
  DEFAULT_ALERT_BANNER_CONFIG,
  type AlertBannerOverlayConfig
} from '@shared/alertBanner'

/** The holds this card offers, in seconds. A closed list, not a slider: the difference between
 *  4 s and 4.3 s is not a decision anybody has, and the cap is the owner's 15. */
const HOLD_CHOICES_SEC = [2, 3, 4, 6, 8, 10, BANNER_MAX_HOLD_MS / 1000]

/** How many lines may share the strip. Beyond a handful it stops being a glance. */
const LINE_CHOICES = [1, 2, 3, 4, 6, 8]

interface BannerState {
  open: boolean
  locked: boolean
  cfg: AlertBannerOverlayConfig
}

const INITIAL: BannerState = { open: false, locked: true, cfg: DEFAULT_ALERT_BANNER_CONFIG }

/**
 * The banner window's open-state, lock and knobs — hydrated from main, then kept current by the
 * two channels that can change them behind this card's back.
 *
 * THE LISTENERS ARE NOT A SECOND HYDRATION PATH — they are the two ways these values genuinely
 * change while the card is on screen (the ToastSetting card's argument, verbatim). The banner's
 * own frame carries a Done button, so the lock can change in the OTHER window; and an overlay can
 * close itself, so the switch listens rather than trusting what it started with.
 */
function useBannerState(): [BannerState, (patch: Partial<BannerState>) => void] {
  const [state, setState] = useState<BannerState>(INITIAL)

  useEffect(() => {
    let alive = true
    const hydrate = (): void => {
      void Promise.all([window.eq.getOverlayState(), window.eq.getAlertBannerConfig()]).then(
        ([open, cfg]) => {
          if (!alive) return
          setState({
            open: open.alertBanner,
            locked: cfg.locked,
            cfg: cfg.alertBanner ?? DEFAULT_ALERT_BANNER_CONFIG
          })
        }
      )
    }
    hydrate()
    window.addEventListener('focus', hydrate)
    const off = window.eq.onOverlayState((s) => {
      if (s.kind === 'alertBanner') setState((cur) => ({ ...cur, open: s.open }))
    })
    return () => {
      alive = false
      window.removeEventListener('focus', hydrate)
      off()
    }
  }, [])

  const update = useCallback((patch: Partial<BannerState>) => {
    setState((cur) => ({ ...cur, ...patch }))
  }, [])
  return [state, update]
}

/** The two numeric knobs, side by side. Their own component so the card stays under the ceiling. */
function BannerKnobs({
  cfg,
  disabled,
  onChange
}: {
  cfg: AlertBannerOverlayConfig
  disabled: boolean
  onChange: (patch: Partial<AlertBannerOverlayConfig>) => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={3} flexWrap="wrap" useFlexGap>
      <Stack sx={{ minWidth: 160 }}>
        <Typography variant="caption" color="text.secondary">
          A line stays for
        </Typography>
        <Select
          size="small"
          disabled={disabled}
          data-testid="pref-banner-hold"
          value={cfg.holdMs}
          onChange={(e) => onChange({ holdMs: Number(e.target.value) })}
        >
          {HOLD_CHOICES_SEC.map((sec) => (
            <MenuItem key={sec} value={sec * 1000}>
              {`${String(sec)} seconds`}
            </MenuItem>
          ))}
        </Select>
      </Stack>
      <Stack sx={{ minWidth: 160 }}>
        <Typography variant="caption" color="text.secondary">
          Lines on screen at once
        </Typography>
        <Select
          size="small"
          disabled={disabled}
          data-testid="pref-banner-lines"
          value={cfg.maxLines}
          onChange={(e) => onChange({ maxLines: Number(e.target.value) })}
        >
          {LINE_CHOICES.map((n) => (
            <MenuItem key={n} value={n}>
              {String(n)}
            </MenuItem>
          ))}
        </Select>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ flexBasis: '100%' }}>
        The newest alert sits at the bottom; when the strip is full the oldest one leaves.
      </Typography>
    </Stack>
  )
}

export function AlertBannerSetting(): JSX.Element {
  const [state, update] = useBannerState()

  const setLocked = (locked: boolean): void => {
    update({ locked })
    window.eq.setAlertBannerLocked(locked)
  }
  const setCfg = (patch: Partial<AlertBannerOverlayConfig>): void => {
    const cfg = { ...state.cfg, ...patch }
    update({ cfg })
    void window.eq.setAlertBannerConfig({ alertBanner: cfg })
  }

  return (
    <Stack spacing={2} data-testid="pref-alert-banner">
      <Stack spacing={0.5}>
        <FormControlLabel
          control={
            <Switch
              size="small"
              data-testid="pref-banner-enabled"
              checked={state.open}
              onChange={() => void window.eq.toggleOverlay('alertBanner')}
            />
          }
          label={<Typography variant="body2">Show alerts on screen</Typography>}
        />
        <Typography variant="caption" color="text.secondary">
          {state.open
            ? 'Alerts marked Show on screen appear as large text over the game, then fade. Point at a line to keep it up. Each alert says whether it appears here, in the Alerts tab.'
            : 'Off. Your alerts still play their sound and speak - nothing appears over the game.'}
        </Typography>
      </Stack>

      <Stack spacing={0.5}>
        <FormControlLabel
          control={
            <Switch
              size="small"
              data-testid="pref-banner-move"
              disabled={!state.open}
              checked={!state.locked}
              onChange={(e) => setLocked(!e.target.checked)}
            />
          }
          label={<Typography variant="body2">Move it</Typography>}
        />
        <Typography variant="caption" color="text.secondary">
          {state.locked
            ? 'The strip sits where you left it and clicks pass straight through to the game.'
            : 'The strip is showing its outline - drag it anywhere, and size its text with A- / A+ on the frame. Turn this off (or press Done) when it sits where you want it.'}
        </Typography>
      </Stack>

      <BannerKnobs cfg={state.cfg} disabled={!state.open} onChange={setCfg} />
    </Stack>
  )
}
