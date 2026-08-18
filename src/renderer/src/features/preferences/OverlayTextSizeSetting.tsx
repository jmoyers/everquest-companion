// OverlayTextSizeSetting — Preferences → Text size → the OVERLAYS' size (JOS-405).
//
// WHY THIS CARD EXISTS AT ALL. Every overlay window has carried an A− / A+ since 2026-08-05, and
// two 1.4.0 reports still said "the text is so small! and text size options dont effect it". They
// were not wrong about anything except where to look: the meters' stepper is in a footer that a
// PINNED overlay does not draw, and the three strips' is in a drag frame reached from a "Move it"
// button. A player who pinned their meters on day one has never seen the control. So the size
// moves to where they went looking for it — beside the window's own Text size — and the control
// on the overlay stays exactly where it is, writing the same value.
//
// TWO CONTROLS HERE, AND A THIRD NEXT DOOR:
//
//   Overlay text size          the ONE size, and what every overlay uses unless told otherwise.
//   Independent sizes          off by default — the 2026-08-05 rule, now a default rather than a
//                              law (shared/overlayTextScale.ts carries the argument).
//   Per-overlay rows           all twelve, ALWAYS RENDERED — in ./PerOverlaySetting.tsx, because
//                              since JOS-407 each row carries a size AND a transparency and the
//                              list belongs to neither setting alone.
//
// STATE, NEVER PROCESS, AND THE CAVEAT DIET (AGENTS.md): each caption is one sentence about what
// the overlays DO. Nothing here mentions routing, broadcasts, or which process stores the number.
//
// ONE BORDER: PreferencesView already wraps each item in an outlined Paper, so these render bare
// Stacks.

import { type JSX, useCallback, useEffect, useState } from 'react'
import { FormControlLabel, IconButton, Stack, Switch, Typography } from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import RemoveIcon from '@mui/icons-material/Remove'
import {
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  TEXT_SCALE_STEP,
  clampTextScale,
  type OverlayTextSizePrefs
} from '@shared/overlayTextScale'
import { recordPref, usePrefsSeed } from './prefsHydration'

/** The percentage, which is the vocabulary the window's own ladder already taught this pane. */
const pct = (scale: number): string => `${String(Math.round(scale * 100))}%`

/** What a disabled row's hover says. One sentence: what is true, and what would change it.
 *  Lives here rather than with the rows because it is this switch's own explanation. */
export const SYNCED_SIZE_TOOLTIP =
  'All overlays share one text size. Turn on Independent sizes per overlay to set this one by itself.'

/**
 * The prefs blob, SEEDED from the pane's hydration snapshot (JOS-340) and kept current by main's
 * PUSH as well as by this card's own writes.
 *
 * The push is not decoration here, and this value needs it more than any other in the pane: the
 * shared size has THIRTEEN controls — twelve windows' A− / A+ and this stepper — so a Preferences
 * pane left open while somebody scales their fight meter would otherwise print a stale
 * percentage. Same arrangement as `closeToTray`, which has three.
 */
export function useOverlayTextSize(): [OverlayTextSizePrefs, (patch: Partial<OverlayTextSizePrefs>) => void] {
  const [prefs, setPrefs] = useState<OverlayTextSizePrefs>(usePrefsSeed().overlayTextSize)

  useEffect(() => {
    return window.eq.onOverlayTextSize((p) => {
      setPrefs(p)
      recordPref('overlayTextSize', p)
    })
  }, [])

  const update = useCallback((patch: Partial<OverlayTextSizePrefs>) => {
    setPrefs((cur) => ({ ...cur, ...patch }))
    void window.eq.setOverlayTextSize(patch).then((stored) => {
      setPrefs(stored)
      recordPref('overlayTextSize', stored)
    })
  }, [])

  return [prefs, update]
}

/**
 * A− / A+ with the percentage between them. ONE component for the shared control and for all
 * twelve rows, so a row can never step differently from the thing above it.
 *
 * The ends disable at the shared floor and ceiling (`TEXT_SCALE_MIN` / `MAX`), the same two numbers
 * the overlay windows' own stepper stops at — this is the same control in a different frame, not a
 * second opinion about how big an overlay may be.
 */
export function ScaleStepper({
  scale,
  onStep,
  disabled,
  name,
  testid
}: {
  scale: number
  onStep: (next: number) => void
  disabled: boolean
  /** What this stepper is FOR, spoken: "the overlays", or one window's name. */
  name: string
  testid: string
}): JSX.Element {
  const step = (dir: 1 | -1): void => onStep(clampTextScale(scale + dir * TEXT_SCALE_STEP))
  return (
    <Stack direction="row" alignItems="center" spacing={0.5} data-testid={testid}>
      <IconButton
        size="small"
        aria-label={`Smaller text for ${name}`}
        data-testid={`${testid}-minus`}
        disabled={disabled || scale <= TEXT_SCALE_MIN}
        onClick={() => { step(-1) }}
      >
        <RemoveIcon fontSize="inherit" />
      </IconButton>
      <Typography
        variant="body2"
        data-testid={`${testid}-value`}
        // A fixed width so twelve rows' percentages line up and none of them jumps as it changes.
        sx={{ minWidth: 44, textAlign: 'center', fontVariantNumeric: 'tabular-nums', opacity: disabled ? 0.5 : 1 }}
      >
        {pct(scale)}
      </Typography>
      <IconButton
        size="small"
        aria-label={`Larger text for ${name}`}
        data-testid={`${testid}-plus`}
        disabled={disabled || scale >= TEXT_SCALE_MAX}
        onClick={() => { step(1) }}
      >
        <AddIcon fontSize="inherit" />
      </IconButton>
    </Stack>
  )
}

/**
 * THE SHARED SIZE, plus the switch that decides whether it is the one in force.
 *
 * They are one card rather than two because the switch is what the stepper above it MEANS: read
 * apart, "Overlay text size" and "Independent sizes per overlay" are two settings that appear to
 * contradict each other.
 */
export function OverlayTextSizeSetting(): JSX.Element {
  const [prefs, update] = useOverlayTextSize()

  return (
    <Stack spacing={1.25}>
      <Stack spacing={0.5}>
        <ScaleStepper
          scale={prefs.shared}
          onStep={(shared) => { update({ shared }) }}
          disabled={false}
          name="the overlays"
          testid="pref-overlay-text-size"
        />
        <Typography variant="caption" color="text.secondary" data-testid="pref-overlay-text-size-note">
          {prefs.independent
            ? 'Each overlay is using its own size right now, listed below. Turn independent sizes off and they all come back to this one.'
            : 'Every floating overlay draws its text at this size - the meters, the timers, and the cards that appear over your game.'}
        </Typography>
      </Stack>

      <Stack spacing={0.5}>
        <FormControlLabel
          control={
            <Switch
              size="small"
              data-testid="pref-overlay-text-independent"
              checked={prefs.independent}
              onChange={(e) => { update({ independent: e.target.checked }) }}
            />
          }
          label={<Typography variant="body2">Independent sizes per overlay</Typography>}
        />
        <Typography variant="caption" color="text.secondary">
          {prefs.independent
            ? 'On. Each overlay keeps its own size, and its A- / A+ changes only that overlay.'
            : 'Off. One size for all of them, and any overlay’s A- / A+ moves it for every one.'}
        </Typography>
      </Stack>
    </Stack>
  )
}

