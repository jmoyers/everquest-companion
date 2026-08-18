// TextSizeSetting — Preferences → Text size (JOS-123).
//
// A player on v0.13.0 wrote "Please allow us to enlarge the text. I can barely read it." This is
// the answer for the MAIN window.
//
// AND THE OVERLAYS' ANSWER IS NOW THE NEXT ITEM DOWN (JOS-405), not "on the overlay itself". The
// caption used to send them there, and two 1.4.0 reporters proved that sentence was not enough:
// the stepper it pointed at is in a footer a PINNED overlay does not draw. The section now carries
// all three controls — this ladder, the shared overlay size, and the twelve per-overlay rows —
// which is what "someone who came here to fix their meters and left thinking nothing happened"
// looked like when it actually happened. See ./OverlayTextSizeSetting.tsx.
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

import { type JSX, useCallback, useState } from 'react'
import { Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import FormatSizeIcon from '@mui/icons-material/FormatSize'
import { UI_SCALE_STEPS, normalizeUiScale, uiScalePercent } from '@shared/uiScale'
import { recordPref, usePrefsSeed } from './prefsHydration'
// The OVERLAYS' size, their TRANSPARENCY and the per-overlay list (JOS-405, JOS-407), which are
// items in THIS section: someone who came here to fix their meters has to find them without leaving
// the card they landed on.
import { OverlayTextSizeSetting } from './OverlayTextSizeSetting'
import { OverlayBgAlphaSetting } from './OverlayBgAlphaSetting'
import { PerOverlaySetting } from './PerOverlaySetting'
import type { PrefSection } from './PreferencesView'

/**
 * The stored scale, SEEDED from the pane's hydration snapshot and written back on every press. The
 * local write is optimistic (a size button must not lag an IPC round trip) and main's reply is
 * authoritative, being what was actually stored: the normalizer snaps to the ladder, so a reply
 * that disagrees with the request is a reply worth taking.
 *
 * IT USED TO MOUNT ON `UI_SCALE_DEFAULT` AND CORRECT ITSELF (JOS-340), and this card is where that
 * was most absurd: a person who came here BECAUSE they cannot read the screen — and who therefore
 * has the ladder somewhere above 100% — opened the section and watched 100% light up first. The
 * window was already at their size; only the control disagreed, for a frame, about what they had
 * chosen. The snapshot already holds the value, snapped to the ladder.
 */
function useUiScale(): [number, (next: number) => void] {
  const [scale, setScale] = useState(usePrefsSeed().uiScale)

  const choose = useCallback((next: number) => {
    setScale(normalizeUiScale(next))
    void window.eq.setUiScale(next).then((stored) => {
      const snapped = normalizeUiScale(stored)
      setScale(snapped)
      recordPref('uiScale', snapped)
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
/**
 * The words somebody types when they cannot read something, shared by every item in this section.
 *
 * SYMPTOM VOCABULARY AS HEAVILY AS MECHANISM ("small", "tiny", "hard to read", "eyes", "squint",
 * "accessibility"): the person searching for this is describing what they are experiencing, not
 * naming a feature. Hoisted out of the one item that used to carry it because JOS-405 added two
 * more and the search has to find all three from the same words.
 */
const SIZE_WORDS =
  'text size font bigger larger smaller enlarge shrink zoom scale magnify percent ' +
  'readable read reading small tiny huge big hard to see eyes eyesight squint vision ' +
  'accessibility accessible interface ui display'

/** …and the words for the OVERLAYS' half of it (JOS-405) — including what the reporter SAW (a
 *  card, a meter, a banner) rather than what the app calls it. */
const OVERLAY_WORDS =
  'overlay overlays meter card con mob toast banner independent separate each individually unpin ' +
  'window windows floating pinned locked strip popup timers respawn xp healing'

/** …and the words for the overlays' BACKGROUND (JOS-407) — again what the reporter SEES (a card
 *  they cannot read through, a meter that hides the game) rather than the field's name. */
const ALPHA_WORDS =
  'transparency transparent opacity opaque see-through solid background bg dim darker lighter faded'

/**
 * THE SECTION IS NAMED FOR BOTH SETTINGS NOW (JOS-407), and the `textsize` id is deliberately
 * unchanged: it is what the rail's testid, the deep link and every existing e2e step address it by,
 * and renaming an id to match a label is how a working route breaks for a cosmetic reason.
 */
export function textSizeSection(): PrefSection {
  return {
    id: 'textsize',
    label: 'Text size & transparency',
    icon: <FormatSizeIcon fontSize="small" />,
    items: [
      {
        id: 'ui-scale',
        label: 'Text size',
        keywords: `${SIZE_WORDS} window overlay`,
        content: <TextSizeSetting />
      },
      // JOS-405: the overlays' size, in the place two 1.4.0 reporters went looking for it. The
      // controls on the overlays themselves are unchanged and write the same value.
      {
        id: 'overlay-text-size',
        label: 'Overlay text size',
        keywords: `${SIZE_WORDS} ${OVERLAY_WORDS}`,
        content: <OverlayTextSizeSetting />
      },
      // JOS-407: the same story one field over — and for the three strips, the first transparency
      // control they have ever had.
      {
        id: 'overlay-bg-alpha',
        label: 'Overlay transparency',
        keywords: `${ALPHA_WORDS} ${OVERLAY_WORDS}`,
        content: <OverlayBgAlphaSetting />
      },
      {
        id: 'overlay-per-kind',
        label: 'Per-overlay size & transparency',
        keywords: `${SIZE_WORDS} ${ALPHA_WORDS} ${OVERLAY_WORDS}`,
        content: <PerOverlaySetting />
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
        you open the app. The floating overlays have their own size and transparency, right below
        this.
      </Typography>
    </Stack>
  )
}
