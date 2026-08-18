// PerOverlaySetting — Preferences → Text size & transparency → the TWELVE ROWS (JOS-405, JOS-407).
//
// ONE LIST, TWO SETTINGS. It arrived in JOS-405 carrying a size per overlay; JOS-407 gave every row
// a transparency beside it rather than adding a second list of the same twelve names. That is the
// whole argument for this file existing: the rows belong to neither setting alone, and a pane with
// two identical twelve-row lists would make the reader match names across them to answer "what is
// this window doing".
//
// EACH CONTROL IS DISABLED BY ITS OWN SWITCH, and they are two switches on purpose (owner,
// 2026-08-17): a player who wants one size everywhere and a fainter respawn window is asking for
// exactly that. So a row can be half live, and each half explains its own disabled state.
//
// THE ROWS SHOW WHAT IS IN FORCE, NEVER WHAT IS REMEMBERED. That is the one design decision in here
// worth defending: while synced, every window genuinely draws at the shared value, and a row that
// printed a remembered 150% next to a meter drawing 100% would be a lie told twelve times. The
// remembered values are not lost — nothing writes them while synced — they are simply not what is
// happening, and the switch is one click away from making them true again.
//
// ALWAYS RENDERED. A list that appeared when a switch went on would make the switch a navigation
// step: you would have to turn something on to find out what it offers.
//
// ONE BORDER: PreferencesView already wraps each item in an outlined Paper, so this renders a bare
// Stack.

import { type JSX, useCallback, useEffect, useState } from 'react'
import { Box, Stack, Typography } from '@mui/material'
import { clampTextScale, effectiveOverlayTextScale } from '@shared/overlayTextScale'
import { clampBgAlpha, effectiveOverlayBgAlpha } from '@shared/overlayBgAlpha'
import { OVERLAY_KIND_LABEL, OVERLAY_LABEL_ORDER, OVERLAY_STRIP_KINDS } from '@shared/overlayLabels'
import type { OverlayKind } from '@shared/types'
// THE app's Tooltip, never MUI's (owner rule 2026-08-04, pinned by tests/tooltipCursor.test.mts):
// anything wearing a tooltip shows the hand, and a DISABLED anchor keeps `not-allowed` — which is
// exactly the state half these controls are in while the overlays share one value.
import { Tooltip } from '../../lib/Tooltip'
import { recordPref, usePrefsSeed } from './prefsHydration'
import { ScaleStepper, SYNCED_SIZE_TOOLTIP, useOverlayTextSize } from './OverlayTextSizeSetting'
import { AlphaSlider, useOverlayBgAlpha } from './OverlayBgAlphaSetting'

/** What a disabled transparency control's hover says — the size tooltip's sentence, one setting
 *  over, because the two disabled states are the same state about different things. */
const SYNCED_ALPHA_TOOLTIP =
  'All overlays share one transparency. Turn on Independent transparency per overlay to set this one by itself.'

/**
 * A control that is live, or disabled and explained.
 *
 * THE TOOLTIP NEEDS THE SPAN. MUI attaches its listeners to the child, and a disabled button (or
 * slider) fires no pointer events at all — so a Tooltip on one is a tooltip that never shows. The
 * wrapping span is the repo's existing answer (UpgradeOffers.tsx), and it goes around the WHOLE
 * control rather than each button so hovering the percentage explains it too.
 */
function Explained({ synced, title, children }: { synced: boolean; title: string; children: JSX.Element }): JSX.Element {
  if (!synced) return children
  return (
    <Tooltip title={title}>
      <span>{children}</span>
    </Tooltip>
  )
}

/** One overlay's row: its name, its size, its transparency. */
function OverlayRow({
  kind,
  scale,
  sizeSynced,
  onStep,
  alpha,
  alphaSynced,
  onAlpha
}: {
  kind: OverlayKind
  scale: number
  sizeSynced: boolean
  onStep: (next: number) => void
  alpha: number
  alphaSynced: boolean
  onAlpha: (next: number) => void
}): JSX.Element {
  return (
    <Stack direction="row" alignItems="center" spacing={1} data-testid={`pref-overlay-row-${kind}`}>
      <Typography
        variant="body2"
        sx={{ flexGrow: 1, minWidth: 0, opacity: sizeSynced && alphaSynced ? 0.7 : 1 }}
      >
        {OVERLAY_KIND_LABEL[kind]}
      </Typography>
      <Explained synced={sizeSynced} title={SYNCED_SIZE_TOOLTIP}>
        <ScaleStepper
          scale={scale}
          onStep={onStep}
          disabled={sizeSynced}
          name={OVERLAY_KIND_LABEL[kind]}
          testid={`pref-overlay-text-size-${kind}`}
        />
      </Explained>
      <Explained synced={alphaSynced} title={SYNCED_ALPHA_TOOLTIP}>
        <AlphaSlider
          alpha={alpha}
          onChange={onAlpha}
          disabled={alphaSynced}
          name={OVERLAY_KIND_LABEL[kind]}
          testid={`pref-overlay-bg-alpha-${kind}`}
        />
      </Explained>
    </Stack>
  )
}

/** Every kind's OWN size, live: seeded from the pane's snapshot, corrected by main's push (a press
 *  made on a WINDOW while this list is open), and written through the same door that press uses. */
function useKindScales(): [Record<OverlayKind, number>, (kind: OverlayKind, next: number) => void] {
  const [scales, setScales] = useState<Record<OverlayKind, number>>(usePrefsSeed().overlayTextScales)

  useEffect(() => {
    return window.eq.onOverlayTextScales((m) => {
      setScales(m)
      recordPref('overlayTextScales', m)
    })
  }, [])

  const setKind = useCallback((kind: OverlayKind, textScale: number) => {
    setScales((cur) => ({ ...cur, [kind]: textScale }))
    void window.eq.setOverlayTextScale(kind, textScale).then((cfg) => {
      const stored = clampTextScale(cfg.textScale)
      setScales((cur) => {
        const next = { ...cur, [kind]: stored }
        recordPref('overlayTextScales', next)
        return next
      })
    })
  }, [])

  return [scales, setKind]
}

/** …and every kind's OWN transparency, on exactly the same terms. */
function useKindAlphas(): [Record<OverlayKind, number>, (kind: OverlayKind, next: number) => void] {
  const [alphas, setAlphas] = useState<Record<OverlayKind, number>>(usePrefsSeed().overlayBgAlphas)

  useEffect(() => {
    return window.eq.onOverlayBgAlphas((m) => {
      setAlphas(m)
      recordPref('overlayBgAlphas', m)
    })
  }, [])

  const setKind = useCallback((kind: OverlayKind, bgAlpha: number) => {
    setAlphas((cur) => ({ ...cur, [kind]: bgAlpha }))
    void window.eq.setOverlayBgAlphaFor(kind, bgAlpha).then((cfg) => {
      const stored = clampBgAlpha(cfg.bgAlpha)
      setAlphas((cur) => {
        const next = { ...cur, [kind]: stored }
        recordPref('overlayBgAlphas', next)
        return next
      })
    })
  }, [])

  return [alphas, setKind]
}

/**
 * THE TWELVE, ALWAYS RENDERED, EACH WITH BOTH CONTROLS.
 *
 * GROUPED AS THE APP NAMES THEM (shared/overlayLabels.ts): the nine windows you open from the
 * Overlay menu, in that menu's order, then the three strips that appear by themselves. A row for a
 * closed window still edits its stored value — it applies the next time that window opens, which is
 * the same promise every other per-window setting in this app makes.
 */
export function PerOverlaySetting(): JSX.Element {
  const [sizePrefs] = useOverlayTextSize()
  const [alphaPrefs] = useOverlayBgAlpha()
  const [scales, setScale] = useKindScales()
  const [alphas, setAlpha] = useKindAlphas()

  return (
    <Stack spacing={0.75}>
      {OVERLAY_LABEL_ORDER.map((kind) => (
        <Box key={kind}>
          {kind === OVERLAY_STRIP_KINDS[0] && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', pt: 1, pb: 0.5 }}>
              These appear by themselves when something happens.
            </Typography>
          )}
          <OverlayRow
            kind={kind}
            // IN FORCE, never remembered: synced controls read the shared value, which is what
            // every one of those windows is genuinely drawing at.
            scale={effectiveOverlayTextScale(sizePrefs, scales[kind])}
            sizeSynced={!sizePrefs.independent}
            onStep={(next) => { setScale(kind, next) }}
            alpha={effectiveOverlayBgAlpha(alphaPrefs, alphas[kind])}
            alphaSynced={!alphaPrefs.independent}
            onAlpha={(next) => { setAlpha(kind, next) }}
          />
        </Box>
      ))}
    </Stack>
  )
}
