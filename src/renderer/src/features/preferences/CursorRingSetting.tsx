// CursorRingSetting — Preferences → Cursor ring.
//
// A thick circle that follows the mouse, drawn ONLY over the EverQuest window (owner request:
// "I lose my mouse on EQ screens"). Off by default; the toggle is the only thing that makes it
// exist. It is white until the player picks another colour (JOS-125), and the default is the
// old colour exactly, so nobody's ring changes by upgrading.
//
// THE NOTE ABOUT SCOPE IS NOT DECORATION. "Only over EverQuest" is the single most surprising
// thing about this feature — a user who turns it on while reading Preferences sees nothing
// happen, and without that line would reasonably conclude it is broken. It states WHERE the
// ring is, which is state, not process.
//
// Every control here is live: main pushes the whole blob to the ring window on every write
// (presenceEffects.refreshPresenceEffects), so dragging a slider resizes the halo under the
// pointer, and picking a colour recolours it, instead of on the next restart.
//
// ONE BORDER: PreferencesView wraps each item in an outlined Paper, so this renders bare Stacks.

import { type JSX, useCallback, useEffect, useState } from 'react'
import { FormControlLabel, Slider, Stack, Switch, Typography } from '@mui/material'
import AdjustIcon from '@mui/icons-material/Adjust'
import type { PrefSection } from './PreferencesView'
import {
  type CursorRingPrefs,
  DEFAULT_CURSOR_RING,
  MAX_RING_SIZE_PX,
  MAX_RING_THICKNESS_PX,
  MIN_RING_SIZE_PX,
  MIN_RING_THICKNESS_PX,
  ringStrokeColor
} from '@shared/presencePrefs'

/** Hydrate once from main, write back on every change; main's reply is authoritative (every
 *  field is re-clamped there, so a slider at the cap visibly stops instead of drifting). */
function useCursorRing(): [CursorRingPrefs, (patch: Partial<CursorRingPrefs>) => void] {
  const [prefs, setPrefs] = useState<CursorRingPrefs>(DEFAULT_CURSOR_RING)

  useEffect(() => {
    let alive = true
    void window.eq.getCursorRing().then((stored) => {
      if (alive) setPrefs(stored)
    })
    return () => {
      alive = false
    }
  }, [])

  const update = useCallback((patch: Partial<CursorRingPrefs>) => {
    setPrefs((cur) => ({ ...cur, ...patch }))
    void window.eq.setCursorRing(patch).then(setPrefs)
  }, [])

  return [prefs, update]
}

/**
 * A small live sample of the ring, so the sliders describe something you can see without
 * alt-tabbing into the game. Same three shadows as the real thing (cursor.html).
 *
 * IT IS A SAMPLE, NOT A RULER, and one divergence is worth stating rather than rediscovering
 * (JOS-154). This card is drawn in the MAIN window, which carries the app's text size
 * (`uiScale`), while the ring window is pinned at zoom 1 so its CSS pixels stay DIPs — so at 125%
 * this circle is 25% wider on screen than the halo the game gets. Left alone on purpose: a
 * preview that shrank while the labels beside it grew would read as broken, and the number the
 * player is actually choosing is on the slider's own label. The ring's POSITION, which is what
 * the ticket was about, is fixed at the window that draws it.
 */
function RingPreview({ prefs }: { prefs: CursorRingPrefs }): JSX.Element {
  return (
    <div
      data-testid="pref-cursor-ring-preview"
      style={{
        width: prefs.sizePx,
        height: prefs.sizePx,
        boxSizing: 'border-box',
        borderRadius: '50%',
        borderStyle: 'solid',
        borderWidth: prefs.thicknessPx,
        // The SAME seam the ring window paints with, so what this sample shows is what the game
        // gets — not a second opinion about how a hex becomes a stroke.
        borderColor: ringStrokeColor(prefs.colorHex),
        boxShadow:
          '0 0 0 1px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(0,0,0,0.6), 0 0 14px 4px rgba(0,0,0,0.28)',
        flexShrink: 0
      }}
    />
  )
}

/** Size + stroke. Both are whole px and both are clamped in main; the labels state the value so
 *  the cap is legible rather than felt. */
function RingSliders({
  prefs,
  onChange
}: {
  prefs: CursorRingPrefs
  onChange: (patch: Partial<CursorRingPrefs>) => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={3} alignItems="center" flexWrap="wrap" useFlexGap>
      <Stack sx={{ minWidth: 180 }}>
        <Typography variant="caption" color="text.secondary">
          Size ({prefs.sizePx}px)
        </Typography>
        <Slider
          size="small"
          data-testid="pref-cursor-ring-size"
          min={MIN_RING_SIZE_PX}
          max={MAX_RING_SIZE_PX}
          step={2}
          value={prefs.sizePx}
          onChange={(_e, v) => onChange({ sizePx: v as number })}
          sx={{ width: 160 }}
        />
      </Stack>
      <Stack sx={{ minWidth: 180 }}>
        <Typography variant="caption" color="text.secondary">
          Thickness ({prefs.thicknessPx}px)
        </Typography>
        <Slider
          size="small"
          data-testid="pref-cursor-ring-thickness"
          min={MIN_RING_THICKNESS_PX}
          max={MAX_RING_THICKNESS_PX}
          step={1}
          value={prefs.thicknessPx}
          onChange={(_e, v) => onChange({ thicknessPx: v as number })}
          sx={{ width: 160 }}
        />
      </Stack>
    </Stack>
  )
}

/** The one id the caption's `htmlFor` and the colour input share. */
const COLOR_INPUT_ID = 'pref-cursor-ring-color-input'

/**
 * The colour picker (JOS-125). A BARE `<input type="color">` and not an MUI control, because MUI
 * has no colour input and the browser's own is the control every player has already used on the
 * web: click it, get the platform's colour dialog, including its eyedropper. Writing a swatch
 * grid instead would be a smaller set of colours and a bigger surface to maintain.
 *
 * It writes on every `change`. The platform dialog fires that continuously while a colour is
 * being dragged, which is what makes the sample beside it (and a live ring in the game) follow
 * the choice rather than land on it — the same liveness the size and thickness sliders have.
 */
function RingColor({
  prefs,
  onChange
}: {
  prefs: CursorRingPrefs
  onChange: (patch: Partial<CursorRingPrefs>) => void
}): JSX.Element {
  return (
    <Stack sx={{ minWidth: 120 }}>
      <Typography variant="caption" color="text.secondary" component="label" htmlFor={COLOR_INPUT_ID}>
        Color
      </Typography>
      <input
        id={COLOR_INPUT_ID}
        type="color"
        data-testid="pref-cursor-ring-color"
        value={prefs.colorHex}
        onChange={(e) => onChange({ colorHex: e.target.value })}
        style={{
          width: 64,
          height: 32,
          padding: 0,
          border: 'none',
          background: 'none',
          cursor: 'pointer'
        }}
      />
    </Stack>
  )
}

export function CursorRingSetting(): JSX.Element {
  const [prefs, update] = useCursorRing()
  return (
    <Stack spacing={2} data-testid="pref-cursor-ring">
      <Stack spacing={0.5}>
        <FormControlLabel
          control={
            <Switch
              size="small"
              data-testid="pref-cursor-ring-enabled"
              checked={prefs.enabled}
              onChange={(e) => update({ enabled: e.target.checked })}
            />
          }
          label={<Typography variant="body2">Show a ring around your mouse cursor</Typography>}
        />
        <Typography variant="caption" color="text.secondary">
          {prefs.enabled
            ? 'A ring follows your pointer so you can find it on a busy screen. Your real cursor is untouched - the ring never gets in the way of a click.'
            : 'Off. Nothing is drawn and nothing is tracked.'}
        </Typography>
      </Stack>

      <Stack direction="row" spacing={3} alignItems="center" flexWrap="wrap" useFlexGap>
        <RingSliders prefs={prefs} onChange={update} />
        <RingColor prefs={prefs} onChange={update} />
        <RingPreview prefs={prefs} />
      </Stack>

      <Typography variant="caption" color="text.secondary">
        The ring only appears over EverQuest, while the game is the window you’re in.
      </Typography>
    </Stack>
  )
}

/**
 * The Preferences section this card belongs to — its label, icon and search keywords.
 *
 * It lives HERE rather than in PreferencesView, beside `perfSection`, `graphicsSection` and
 * `whatsNewSection`, for the reason that file's header gives: it sits at the repo's
 * 400-code-line factoring ceiling and a split is the answer to that rather than a widened
 * threshold. Co-locating costs nothing — the words somebody types to find this setting belong
 * with the setting.
 */
export function cursorRingSection(): PrefSection {
  return {
    id: 'cursor',
    label: 'Cursor ring',
    icon: <AdjustIcon fontSize="small" />,
    items: [
      {
        id: 'cursor-ring',
        label: 'Cursor ring',
        keywords:
          'cursor mouse pointer ring circle halo highlight find lost locate ultimate size thickness white color colour picker',
        content: <CursorRingSetting />
      }
    ]
  }
}
