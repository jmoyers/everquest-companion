// TextSizeSetting — Preferences → Appearance → In-app text size (JOS-123, JOS-408).
//
// A player on v0.13.0 wrote "Please allow us to enlarge the text. I can barely read it." This is
// the answer for the MAIN window, and since JOS-408 that is ALL it is: the card is named for the
// app itself, and everything about the floating overlays is the one card below it
// (./OverlaysAppearanceSetting.tsx).
//
// A STEPPER, NOT FIVE BUTTONS (owner review, 2026-08-17: "make the controls uniform - the +/-
// version of the control on the whole page"). The five percentage buttons were the odd one out on a
// page whose other four values are all A− / A+, and a ladder is a strange thing to render as a
// radio group anyway — nobody chooses 110% over 125% on the merits, they press bigger until they
// can read it. THE LADDER ITSELF IS UNCHANGED and is still the detents: A+ from 110% lands on 125%
// (`stepUiScale`, shared/uiScale.ts, which carries the reasoning for the five stops).
//
// IT APPLIES ON THE PRESS. Main stores the value and zooms the live window in the same call, so the
// button you just pressed is being read at the size it chose. That is the whole evaluation loop for
// a setting like this, and it is why there is no "restart to apply" sentence anywhere in here
// (compare GraphicsSetting, whose switches genuinely cannot).
//
// THE ONLY DISABLED BUTTONS IN THIS SECTION ARE THIS STEPPER'S ENDS AND THE OVERLAY ONES', at 90%
// and 150%, and they are disabled because the value cannot move rather than because something else
// is switched off. That distinction is the whole of the owner's review — see PrefStepper.tsx.
//
// STATE, NEVER PROCESS, AND THE CAVEAT DIET (AGENTS.md): one caption, one sentence, no explanation
// of zoom factors or device pixels.
//
// ONE BORDER: PreferencesView already wraps each item in an outlined Paper, so this renders a bare
// Stack.

import { type JSX, useCallback, useState } from 'react'
import { Stack, Typography } from '@mui/material'
import FormatSizeIcon from '@mui/icons-material/FormatSize'
import { UI_SCALE_MAX, UI_SCALE_MIN, normalizeUiScale, stepUiScale, uiScalePercent } from '@shared/uiScale'
import { PrefStepper } from './PrefStepper'
import { recordPref, usePrefsSeed } from './prefsHydration'
// The OVERLAYS' appearance (JOS-405, JOS-407, folded into one card by JOS-408), which is the second
// item in THIS section: someone who came here to fix their meters has to find it without leaving
// the card they landed on.
import { OverlaysAppearanceSetting } from './OverlaysAppearanceSetting'
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
 * The words somebody types when they cannot read something, shared by every item in this section.
 *
 * SYMPTOM VOCABULARY AS HEAVILY AS MECHANISM ("small", "tiny", "hard to read", "eyes", "squint",
 * "accessibility"): the person searching for this is describing what they are experiencing, not
 * naming a feature. Hoisted out of the one item that used to carry it because JOS-405 added more
 * and the search has to find all of them from the same words.
 */
const SIZE_WORDS =
  'text size font bigger larger smaller enlarge shrink zoom scale magnify percent ' +
  'readable read reading small tiny huge big hard to see eyes eyesight squint vision ' +
  'accessibility accessible interface ui display appearance look'

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
 * THE SECTION IS CALLED APPEARANCE (owner, 2026-08-17), and the `textsize` id is deliberately
 * unchanged: it is what the rail's testid, the deep link and every existing e2e step address it by,
 * and renaming an id to match a label is how a working route breaks for a cosmetic reason.
 *
 * TWO ITEMS, in this order, which is the hierarchy the owner asked for: what the APP draws at, then
 * what the floating windows draw at.
 */
export function appearanceSection(): PrefSection {
  return {
    id: 'textsize',
    label: 'Appearance',
    icon: <FormatSizeIcon fontSize="small" />,
    items: [
      {
        id: 'ui-scale',
        label: 'In-app text size',
        keywords: `${SIZE_WORDS} window app main`,
        content: <TextSizeSetting />
      },
      // ONE CARD for the overlays' size, their transparency, and the switch that decides whether
      // either is shared — because they pertain to the same twelve windows (owner, 2026-08-17).
      {
        id: 'overlays-appearance',
        label: 'Overlays',
        keywords: `${SIZE_WORDS} ${ALPHA_WORDS} ${OVERLAY_WORDS}`,
        content: <OverlaysAppearanceSetting />
      }
    ]
  }
}

export function TextSizeSetting(): JSX.Element {
  const [scale, choose] = useUiScale()

  return (
    // The `pref-text-size` testid is the STEPPER's, not this wrapper's — it is the control the
    // deep links and the e2e steps mean, and two elements answering to one testid is a selector
    // that silently matches the wrong thing.
    <Stack spacing={0.75}>
      <PrefStepper
        kind="size"
        value={uiScalePercent(scale)}
        name="the app window"
        atMin={scale <= UI_SCALE_MIN}
        atMax={scale >= UI_SCALE_MAX}
        onStep={(dir) => {
          choose(stepUiScale(scale, dir))
        }}
        testid="pref-text-size"
      />

      <Typography variant="caption" color="text.secondary" data-testid="pref-text-size-note">
        This sizes the app window only, meters and numbers included, and it stays this way next time
        you open the app. The floating overlays are below.
      </Typography>
    </Stack>
  )
}
