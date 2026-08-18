// OverlayBgAlphaSetting — Preferences → Text size & transparency → the OVERLAYS' background
// (JOS-407).
//
// WHY THIS CARD EXISTS. The nine panels have had a `bg` slider in their footer forever and the
// three strips have never had one at all — so a player who pinned their meters, or who wanted the
// mob card less solid over the game, had no control to reach. The owner asked for the text size's
// answer a second time, the day after it shipped: put it where people go looking, and let it be one
// setting for everything unless somebody says otherwise.
//
// TWO CONTROLS, AND THE SECOND CHANGES WHAT THE FIRST MEANS — OverlayTextSizeSetting's shape,
// deliberately unchanged so the two settings read as siblings rather than as two designs:
//
//   Overlay transparency                the ONE alpha, and what every overlay paints with unless
//                                       told otherwise.
//   Independent transparency            its OWN switch, separate from the text size's. A player who
//                                       wants one size everywhere and a fainter respawn window is
//                                       asking for exactly that, so the two are linked and unlinked
//                                       separately (owner, 2026-08-17).
//
// AND ITS DEFAULT IS THE OTHER WAY UP, which is the one thing here that is NOT its twin. Nothing
// ever fanned this field out, so an install's twelve values are whatever twelve separate decisions
// left behind: the migration reads them and comes up INDEPENDENT when they differ
// (shared/overlayBgAlpha.ts). The rule above all is do the least harm — if their overlays are
// separately set today, they stay separate.
//
// LEFT IS MORE SEE-THROUGH, because that is which way the overlays' own sliders already run, and
// the percentage is opacity because that is what the number in the store means.
//
// STATE, NEVER PROCESS, AND THE CAVEAT DIET (AGENTS.md): each caption is one sentence about what
// the overlays DO. Nothing here mentions routing, broadcasts, or which process stores the number.
//
// ONE BORDER: PreferencesView already wraps each item in an outlined Paper, so these render bare
// Stacks.

import { type JSX, useCallback, useEffect, useState } from 'react'
import { FormControlLabel, Slider, Stack, Switch, Typography } from '@mui/material'
import {
  BG_ALPHA_MAX,
  BG_ALPHA_MIN,
  BG_ALPHA_STEP,
  clampBgAlpha,
  type OverlayBgAlphaPrefs
} from '@shared/overlayBgAlpha'
import { recordPref, usePrefsSeed } from './prefsHydration'

/** Opacity, as a percentage — the vocabulary `background opacity` already uses in an import
 *  preview, and the only reading of this number a person can check against their own screen. */
export const alphaPct = (alpha: number): string => `${String(Math.round(alpha * 100))}%`

/**
 * The prefs blob, SEEDED from the pane's hydration snapshot (JOS-340) and kept current by main's
 * PUSH as well as by this card's own writes.
 *
 * The push carries more here than it does for the text size: this value has FIFTEEN controls —
 * twelve windows' own `bg` sliders and this pane's slider, switch and rows — so a Preferences pane
 * left open while somebody fades their fight meter would otherwise print a stale percentage.
 */
export function useOverlayBgAlpha(): [OverlayBgAlphaPrefs, (patch: Partial<OverlayBgAlphaPrefs>) => void] {
  const [prefs, setPrefs] = useState<OverlayBgAlphaPrefs>(usePrefsSeed().overlayBgAlpha)

  useEffect(() => {
    return window.eq.onOverlayBgAlpha((p) => {
      setPrefs(p)
      recordPref('overlayBgAlpha', p)
    })
  }, [])

  const update = useCallback((patch: Partial<OverlayBgAlphaPrefs>) => {
    setPrefs((cur) => ({ ...cur, ...patch }))
    void window.eq.setOverlayBgAlpha(patch).then((stored) => {
      setPrefs(stored)
      recordPref('overlayBgAlpha', stored)
    })
  }, [])

  return [prefs, update]
}

/**
 * The slider with its percentage beside it. ONE component for the shared control and for all twelve
 * rows, so a row can never fade differently from the thing above it.
 *
 * It stops at the same two numbers the overlays' own sliders do (`BG_ALPHA_MIN` / `MAX`) and walks
 * in the same step: this is the same control in a different frame, not a second opinion about how
 * see-through an overlay may be.
 */
export function AlphaSlider({
  alpha,
  onChange,
  disabled,
  name,
  testid
}: {
  alpha: number
  onChange: (next: number) => void
  disabled: boolean
  /** What this slider is FOR, spoken: "the overlays", or one window's name. */
  name: string
  testid: string
}): JSX.Element {
  return (
    <Stack direction="row" alignItems="center" spacing={1} data-testid={testid} sx={{ minWidth: 0 }}>
      <Slider
        size="small"
        aria-label={`Background transparency for ${name}`}
        data-testid={`${testid}-slider`}
        disabled={disabled}
        min={BG_ALPHA_MIN}
        max={BG_ALPHA_MAX}
        step={BG_ALPHA_STEP}
        value={alpha}
        // LIVE, not on release: every overlay repaints as the slider moves, which is the only way
        // to aim a transparency at all — you are choosing it against the game behind it.
        onChange={(_e, v) => { onChange(clampBgAlpha(typeof v === 'number' ? v : alpha)) }}
        sx={{ flexGrow: 1, minWidth: 90 }}
      />
      <Typography
        variant="body2"
        data-testid={`${testid}-value`}
        // A fixed width so twelve rows' percentages line up and none of them jumps as it changes.
        sx={{ minWidth: 44, textAlign: 'right', fontVariantNumeric: 'tabular-nums', opacity: disabled ? 0.5 : 1 }}
      >
        {alphaPct(alpha)}
      </Typography>
    </Stack>
  )
}

/**
 * THE SHARED TRANSPARENCY, plus the switch that decides whether it is the one in force.
 *
 * One card rather than two because the switch is what the slider above it MEANS: read apart,
 * "Overlay transparency" and "Independent transparency per overlay" are two settings that appear to
 * contradict each other. (Its twin one card up is arranged the same way, for the same sentence.)
 */
export function OverlayBgAlphaSetting(): JSX.Element {
  const [prefs, update] = useOverlayBgAlpha()

  return (
    <Stack spacing={1.25}>
      <Stack spacing={0.5}>
        <AlphaSlider
          alpha={prefs.shared}
          onChange={(shared) => { update({ shared }) }}
          disabled={false}
          name="the overlays"
          testid="pref-overlay-bg-alpha"
        />
        <Typography variant="caption" color="text.secondary" data-testid="pref-overlay-bg-alpha-note">
          {prefs.independent
            ? 'Each overlay is using its own transparency right now, listed below. Turn independent transparency off and they all come back to this one.'
            : 'Every floating overlay paints its background at this opacity - lower is more see-through, so more of your game shows through it.'}
        </Typography>
      </Stack>

      <Stack spacing={0.5}>
        <FormControlLabel
          control={
            <Switch
              size="small"
              data-testid="pref-overlay-bg-independent"
              checked={prefs.independent}
              onChange={(e) => { update({ independent: e.target.checked }) }}
            />
          }
          label={<Typography variant="body2">Independent transparency per overlay</Typography>}
        />
        <Typography variant="caption" color="text.secondary">
          {prefs.independent
            ? 'On. Each overlay keeps its own transparency, and its bg slider changes only that overlay.'
            : 'Off. One transparency for all of them, and any overlay’s bg slider moves it for every one.'}
        </Typography>
      </Stack>
    </Stack>
  )
}
