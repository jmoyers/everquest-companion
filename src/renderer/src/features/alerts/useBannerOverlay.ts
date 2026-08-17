// useBannerOverlay — is the ALERT BANNER overlay switched on (JOS-378)?
//
// WHY THE ALERTS TAB ASKS AT ALL. The owner's second ruling is that the per-alert "Show on screen"
// controls are VISIBLE ONLY WHILE THE OVERLAY IS ON. That is not decoration: a switch that
// silently does nothing is worse than a missing one, and an alert editor that grew three
// permanent controls for a window most installs never open would be paying every user for a
// feature they have not asked for.
//
// ONE READER FOR THE WHOLE TAB. AlertsView calls this once and hands the answer to the list and
// the dialog, so the two surfaces cannot disagree — the "both surfaces" rule, sourced rather than
// duplicated.
//
// IT LISTENS, because the state genuinely changes while the tab is on screen: Preferences is a
// click away in the same window, and the overlay can close itself (its own controls, the app
// quitting). The ToastSetting card's arrangement, from the other end of the same channel.
//
// IT STARTS FALSE, and that is the honest default here rather than a flicker to paper over: the
// overlay ships OFF, so false is what the overwhelming majority of installs will resolve to, and
// a control that appears a beat late is a much smaller lie than one that appears and vanishes.

import { useEffect, useState } from 'react'

export function useBannerOverlay(): boolean {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    let alive = true
    const hydrate = (): void => {
      void window.eq.getOverlayState().then((s) => {
        if (alive) setEnabled(s.alertBanner)
      })
    }
    hydrate()
    // A user who turns the overlay on in another window (or in Preferences, then alt-tabs) must
    // find the controls waiting when they come back — the alert player's focus-refresh precedent.
    window.addEventListener('focus', hydrate)
    const off = window.eq.onOverlayState((s) => {
      if (s.kind === 'alertBanner') setEnabled(s.open)
    })
    return () => {
      alive = false
      window.removeEventListener('focus', hydrate)
      off()
    }
  }, [])
  return enabled
}
