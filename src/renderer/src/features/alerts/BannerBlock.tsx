// BannerBlock — the alert editor's ON-SCREEN half (JOS-378): does this alert put a line on the
// alert banner overlay, what does that line say, and what colour is it.
//
// IT SITS BESIDE THE SOUND/VOICE CHOICE because it is the same question asked about a third
// channel. An alert has always been "when this happens, make this noise"; this is "…and put these
// words on screen", and separating the two into different parts of the dialog would suggest they
// are different features.
//
// IT RENDERS ONLY WHILE THE OVERLAY IS ON (owner ruling 2). Off, it prints ONE quiet line naming
// the switch and offering to go there — not nothing, and that is a deliberate call: a user who
// read the release note and came looking for "Show on screen" must be told where the feature
// lives, and a control that is simply absent teaches them the app does not have it. It is the
// VoiceSetupLink shape (a caption plus a link into the Preferences section that fixes it), which
// is the app's existing answer to "the thing you want is one switch away".
//
// THE TEXT FIELD IS AN OVERRIDE, AND ITS PLACEHOLDER SAYS SO. Empty means the line is the ALERT'S
// NAME (JOS-380, shared/alertBanner.ts), so the field shows the name being typed in this same
// dialog as its placeholder rather than a generic hint. What you see greyed out is literally what
// will appear on screen if you type nothing.
//
// STATE, NEVER PROCESS (the repo's UI law): every caption says what is true now. Nothing here
// mentions overlay windows, IPC or queues.

import { type Dispatch, type JSX, type SetStateAction, useEffect, useState } from 'react'
import { FormControlLabel, Link, Stack, Switch, TextField, Typography } from '@mui/material'
// THE app's Tooltip, never MUI's directly (lib/Tooltip.tsx): a swatch is a hover anchor and has
// to show the hand before it is hovered. tests/tooltipCursor.test.mts pins the rule.
import { Tooltip } from '../../lib/Tooltip'
import type { AlertDef, AlertTrigger } from '@shared/types'
import {
  ALERT_BANNER_COLORS,
  ALERT_BANNER_COLOR_HEX,
  MAX_BANNER_CHARS,
  alertShowsOnScreen,
  defaultShowOnScreen,
  type AlertBannerColor
} from '@shared/alertBanner'

/** The dialog's banner sub-form. `'default'` is the FORM's spelling of the def's absent colour. */
export interface BannerForm {
  showOnScreen: boolean
  setShowOnScreen: Dispatch<SetStateAction<boolean>>
  bannerText: string
  setBannerText: Dispatch<SetStateAction<string>>
  bannerColor: AlertBannerColor
  setBannerColor: Dispatch<SetStateAction<AlertBannerColor>>
}

/**
 * Hydrate the banner fields from the def being edited, once per OPENING.
 *
 * The `[open, initial]` dependency pair is the SpeechBlock's, deliberately: it is the shape that
 * never carried JOS-122's bug (a re-listed prop wiping what the user typed), because it answers
 * "the dialog opened" rather than "a prop changed identity".
 */
export function useBannerForm(open: boolean, initial: AlertDef | null): BannerForm {
  const [showOnScreen, setShowOnScreen] = useState(true)
  const [bannerText, setBannerText] = useState('')
  const [bannerColor, setBannerColor] = useState<AlertBannerColor>('default')
  useEffect(() => {
    if (!open) return
    // WHAT AN ABSENT KEY MEANS IS `alertShowsOnScreen`'s to say, never this file's — since JOS-380
    // it depends on the trigger, and a switch that showed ON for an alert the banner will not draw
    // is the exact lie a second implementation of a default produces. A NEW alert has no trigger
    // yet, so it starts on; if the user then picks an app signal and leaves it on, `bannerFieldsFor`
    // writes that ON explicitly and the def means what the switch said.
    setShowOnScreen(initial ? alertShowsOnScreen(initial) : true)
    setBannerText(initial?.bannerText ?? '')
    setBannerColor(initial?.bannerColor ?? 'default')
  }, [open, initial])
  return {
    showOnScreen,
    setShowOnScreen,
    bannerText,
    setBannerText,
    bannerColor,
    setBannerColor
  }
}

/**
 * The def's banner keys, or nothing at all where the form says the default.
 *
 * The whole file's rule, and the one `speechFieldsFor` keeps beside it: write a key ONLY when it
 * is not the default, so an alert that asked for none of this saves BYTE-IDENTICALLY to how it
 * always did and import dedupe keeps matching it.
 *
 * WHICH IS WHY THE TRIGGER IS A PARAMETER (JOS-380): the switch's default is now the trigger's to
 * decide, so "not the default" is a question about this def and not a constant. An app-signal alert
 * the user deliberately turns ON therefore stores an explicit `true` — the one value that used to
 * be unwritable, and the only way that alert can beat the celebration card it doubles.
 */
export function bannerFieldsFor(
  f: BannerForm,
  trigger: AlertTrigger
): Pick<AlertDef, 'showOnScreen' | 'bannerText' | 'bannerColor'> {
  const text = f.bannerText.trim()
  return {
    ...(f.showOnScreen === defaultShowOnScreen({ trigger }) ? {} : { showOnScreen: f.showOnScreen }),
    ...(text ? { bannerText: text.slice(0, MAX_BANNER_CHARS) } : {}),
    ...(f.bannerColor === 'default' ? {} : { bannerColor: f.bannerColor })
  }
}

/** Sentence-case label for a swatch's tooltip. The colours are the only vocabulary here. */
function swatchLabel(c: AlertBannerColor): string {
  return c === 'default' ? 'Default' : c[0].toUpperCase() + c.slice(1)
}

/** The one swatch row. Six buttons, no picker — the argument is in shared/alertBanner.ts. */
function ColorRow({ value, onChange }: { value: AlertBannerColor; onChange: (c: AlertBannerColor) => void }): JSX.Element {
  return (
    <Stack direction="row" spacing={1} alignItems="center" data-testid="alert-banner-colors">
      <Typography variant="caption" color="text.secondary">
        Colour
      </Typography>
      {ALERT_BANNER_COLORS.map((c) => (
        // A one-clause title NAMING the control, which is what the tooltip diet allows: the
        // swatches are colour with no words on them, so the name has to live somewhere.
        <Tooltip key={c} title={swatchLabel(c)}>
          <button
            type="button"
            aria-label={swatchLabel(c)}
            data-testid={`alert-banner-color-${c}`}
            aria-pressed={value === c}
            onClick={() => onChange(c)}
            style={{
              width: 22,
              height: 22,
              borderRadius: 4,
              cursor: 'pointer',
              background: ALERT_BANNER_COLOR_HEX[c],
              border: value === c ? '2px solid #fff' : '1px solid rgba(255,255,255,0.25)'
            }}
          />
        </Tooltip>
      ))}
    </Stack>
  )
}

/** The quiet line an alert wears when the overlay this block configures is switched off. */
function OverlayOffNote({ onOpenPrefs }: { onOpenPrefs?: () => void }): JSX.Element {
  return (
    <Typography
      variant="caption"
      color="text.secondary"
      data-testid="alert-banner-off-note"
      sx={{ display: 'block', lineHeight: 1.4 }}
    >
      Turn on the Alert banner overlay to show alerts on screen.
      {onOpenPrefs && (
        <>
          {' '}
          <Link
            component="button"
            type="button"
            variant="caption"
            underline="hover"
            data-testid="alert-banner-prefs-link"
            onClick={onOpenPrefs}
            sx={{ verticalAlign: 'baseline' }}
          >
            Preferences - Overlays
          </Link>
        </>
      )}
    </Typography>
  )
}

export default function BannerBlock({
  alertName,
  form,
  enabled,
  onOpenPrefs
}: {
  /**
   * What this alert would PRINT right now with the field left empty — its name, live from the
   * dialog's own name field rather than from the saved def, so the placeholder follows what is
   * being typed. That is the whole point: what you see greyed out is literally what will appear
   * on screen.
   */
  alertName: string
  form: BannerForm
  /** Is the alert banner overlay switched on (useBannerOverlay)? */
  enabled: boolean
  /** Navigate to Preferences → Overlays. Absent ⇒ the note renders without a link. */
  onOpenPrefs?: () => void
}): JSX.Element {
  if (!enabled) return <OverlayOffNote onOpenPrefs={onOpenPrefs} />
  return (
    <Stack spacing={1} data-testid="alert-banner-block">
      <FormControlLabel
        control={
          <Switch
            size="small"
            data-testid="alert-show-on-screen"
            checked={form.showOnScreen}
            onChange={(e) => form.setShowOnScreen(e.target.checked)}
          />
        }
        label={<Typography variant="body2">Show on screen</Typography>}
      />
      {form.showOnScreen && (
        <>
          <TextField
            size="small"
            label="On-screen text"
            data-testid="alert-banner-text"
            value={form.bannerText}
            placeholder={alertName}
            onChange={(e) => form.setBannerText(e.target.value.slice(0, MAX_BANNER_CHARS))}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <Typography variant="caption" color="text.secondary">
            Leave it empty and the banner shows the alert&apos;s name.
          </Typography>
          <ColorRow value={form.bannerColor} onChange={form.setBannerColor} />
        </>
      )}
    </Stack>
  )
}
