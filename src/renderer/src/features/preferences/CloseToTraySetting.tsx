// CloseToTraySetting — Preferences → Window → "Closing the window" (JOS-139).
//
// ONE SWITCH, AND IT SHIPS ON. Five players across four releases asked for a companion that does
// not end when its window does, and the owner's design makes that the default: closing the window
// hides it and everything the app is doing carries on. This card is for the person who means
// "quit" when they press X — and it is where they will look, because the first thing that happens
// to them is a tray card telling them the app is still running.
//
// STATE, NEVER PROCESS (the repo's UI law): the captions say what closing the window WILL DO and
// how to get it back. Neither of them mentions hiding, processes, the notification area's API, or
// the fact that main is the one intercepting anything.
//
// IT LISTENS, AND THAT IS NOT A SECOND HYDRATION PATH (the ToastSetting precedent). This
// preference has a second control — the tray icon's own checkbox — and that one is used precisely
// when this window is not on screen. So the card seeds from the pane's snapshot (JOS-340: a
// control never paints a value it does not know) and then follows main's pushes, which is what
// makes "the menu checkbox and the Preferences switch never disagree" true rather than hoped for.
// The snapshot is kept current at the app root as well (App.tsx), for the case where the tray
// changed it while this card was not even mounted.
//
// ONE BORDER: PreferencesView already wraps each item in an outlined Paper, so this renders bare
// Stacks — a Paper here would draw a second frame inside the first.

import { type JSX, useCallback, useEffect, useState } from 'react'
import { FormControlLabel, Stack, Switch, Typography } from '@mui/material'
import WebAssetIcon from '@mui/icons-material/WebAsset'
import type { CloseToTrayPrefs } from '@shared/closeToTray'
import { recordPref, usePrefsSeed } from './prefsHydration'
import type { PrefSection } from './PreferencesView'

/**
 * The prefs blob, seeded from the pane's hydration snapshot, written back on every change, and
 * corrected by main whenever the tray moves it. Optimistic locally, authoritative from the reply.
 */
function useCloseToTray(): [CloseToTrayPrefs, (patch: Partial<CloseToTrayPrefs>) => void] {
  const [prefs, setPrefs] = useState<CloseToTrayPrefs>(usePrefsSeed().closeToTray)

  useEffect(() => window.eq.onCloseToTray(setPrefs), [])

  // ONE place writes the snapshot back, for the ToastSetting reason: there are two ways this value
  // moves (this switch and the tray's checkbox) and a `useState` updater has to stay pure.
  useEffect(() => {
    recordPref('closeToTray', prefs)
  }, [prefs])

  const update = useCallback((patch: Partial<CloseToTrayPrefs>) => {
    setPrefs((cur) => ({ ...cur, ...patch }))
    void window.eq.setCloseToTray(patch).then(setPrefs)
  }, [])

  return [prefs, update]
}

export function CloseToTraySetting(): JSX.Element {
  const [prefs, update] = useCloseToTray()
  return (
    <Stack spacing={0.5} data-testid="pref-close-to-tray">
      <FormControlLabel
        control={
          <Switch
            size="small"
            data-testid="pref-keep-in-tray"
            checked={prefs.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
          />
        }
        label={
          <Typography variant="body2">
            Keep running in the system tray when I close the window
          </Typography>
        }
      />
      <Typography variant="caption" color="text.secondary">
        {prefs.enabled
          ? 'Closing the window keeps the companion and its overlays running. Click the tray icon to bring the window back; right-click it to quit.'
          : 'Closing the window quits the companion and closes its overlays.'}
      </Typography>
    </Stack>
  )
}

/**
 * The section this card is the whole of.
 *
 * A SECTION OF ITS OWN rather than a line under Overlays, because it is not about the overlays: it
 * is about the app WINDOW, which is the thing the user just closed. Its descriptor lives here
 * beside the card for the reason `graphicsSection` and `perfSection` do — PreferencesView.tsx is
 * near the 400-code-line ceiling and `buildSections` is at the 100-line one.
 *
 * The keywords are the words the five reports actually used ("minimize to the notification icon
 * area", "system tray", "alt-tab", "taskbar"), plus the two spellings of minimise and the letter
 * people call the button.
 */
export function windowSection(): PrefSection {
  return {
    id: 'window',
    label: 'Window',
    icon: <WebAssetIcon fontSize="small" />,
    items: [
      {
        id: 'close-to-tray',
        label: 'Closing the window',
        keywords:
          'tray systray system tray minimize minimise close closing quit exit x background hide notification area taskbar alt tab',
        content: <CloseToTraySetting />
      }
    ]
  }
}
