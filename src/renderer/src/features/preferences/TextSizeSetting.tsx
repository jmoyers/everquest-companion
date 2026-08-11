// TextSizeSetting — Preferences → Text size (JOS-123).
//
// A player on v0.13.0 wrote "Please allow us to enlarge the text. I can barely read it." This is
// the answer for the MAIN window; the floating overlays got theirs in an earlier round and keep
// it (the A− / A+ stepper in their own footer), which is why the caption says so out loud. Someone
// who came here to fix their meters and left thinking nothing happened would be the one way this
// card can fail.
//
// FIVE BUTTONS, NOT A SLIDER. The ladder lives in shared/uiScale.ts with the reasoning; what
// matters here is that a person who cannot read the screen should not have to aim at a 4px track
// to make it bigger. Every stop is one press away, the current one is lit, and the labels are
// percentages because that is the vocabulary browsers taught everybody.
//
// IT APPLIES ON THE PRESS. Main stores the value and zooms the live window in the same call, so
// the button you just pressed is being read at the size it chose. That is the whole evaluation
// loop for a setting like this, and it is why there is no "restart to apply" sentence anywhere in
// here (compare GraphicsSetting, whose switches genuinely cannot).
//
// STATE, NEVER PROCESS, AND THE CAVEAT DIET (AGENTS.md): one caption, two plain sentences, no
// explanation of zoom factors or device pixels.
//
// ONE BORDER: PreferencesView already wraps each item in an outlined Paper, so this renders a bare
// Stack.

import { type JSX, useCallback, useEffect, useState } from 'react'
import { Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import FormatSizeIcon from '@mui/icons-material/FormatSize'
import { UI_SCALE_DEFAULT, UI_SCALE_STEPS, normalizeUiScale, uiScalePercent } from '@shared/uiScale'
import type { PrefSection } from './PreferencesView'

/**
 * The stored scale, hydrated once from main and written back on every press — the
 * GraphicsSetting / OverlayAutoHide pattern exactly. The local write is optimistic (a size button
 * must not lag an IPC round trip) and main's reply is authoritative, being what was actually
 * stored: the normalizer snaps to the ladder, so a reply that disagrees with the request is a
 * reply worth taking.
 */
function useUiScale(): [number, (next: number) => void] {
  const [scale, setScale] = useState(UI_SCALE_DEFAULT)

  useEffect(() => {
    let alive = true
    void window.eq.getUiScale().then((stored) => {
      if (alive) setScale(normalizeUiScale(stored))
    })
    return () => {
      alive = false
    }
  }, [])

  const choose = useCallback((next: number) => {
    setScale(normalizeUiScale(next))
    void window.eq.setUiScale(next).then((stored) => {
      setScale(normalizeUiScale(stored))
    })
  }, [])

  return [scale, choose]
}

/**
 * The section descriptor, living with its card like `perfSection` and `graphicsSection` do —
 * PreferencesView is at the 400-code-line factoring ceiling, and the words someone types to find
 * this setting belong beside the setting.
 *
 * The keywords carry the SYMPTOM vocabulary as heavily as the mechanism ("small", "tiny", "hard to
 * read", "eyes", "squint", "accessibility") because the person searching for this is describing
 * what they are experiencing, not naming a feature. "overlay" is in there too: the overlays' own
 * control is somewhere else entirely, and this card is the one that says where.
 */
export function textSizeSection(): PrefSection {
  return {
    id: 'textsize',
    label: 'Text size',
    icon: <FormatSizeIcon fontSize="small" />,
    items: [
      {
        id: 'ui-scale',
        label: 'Text size',
        keywords:
          'text size font bigger larger smaller enlarge shrink zoom scale magnify percent ' +
          'readable read reading small tiny huge big hard to see eyes eyesight squint vision ' +
          'accessibility accessible interface ui display window overlay',
        content: <TextSizeSetting />
      }
    ]
  }
}

export function TextSizeSetting(): JSX.Element {
  const [scale, choose] = useUiScale()

  return (
    <Stack spacing={1} data-testid="pref-text-size">
      <ToggleButtonGroup
        exclusive
        size="small"
        value={scale}
        aria-label="Text size"
        // A null value is the press that would DESELECT the current button, which for an exclusive
        // group is what clicking the lit one does. There is no such thing as "no size", so it is
        // simply ignored and the window keeps the size it has.
        onChange={(_e, next: number | null) => {
          if (next !== null) choose(next)
        }}
      >
        {UI_SCALE_STEPS.map((step) => (
          <ToggleButton
            key={step}
            value={step}
            data-testid={`pref-text-size-${uiScalePercent(step).replace('%', '')}`}
            sx={{ px: 2, textTransform: 'none' }}
          >
            {uiScalePercent(step)}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      <Typography variant="caption" color="text.secondary" data-testid="pref-text-size-note">
        This sizes the whole window, meters and numbers included, and it stays this way next time
        you open the app. The floating overlays keep their own size control, on the overlay itself.
      </Typography>
    </Stack>
  )
}
