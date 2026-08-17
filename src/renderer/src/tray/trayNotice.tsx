// trayNotice.tsx — the card that says where the app went (JOS-139).
//
// A FOURTH RENDERER ENTRY (index / overlay / cursor / tray), and the smallest: one static card in
// a 380x170 frameless window that main puts just above the notification-area icon the first time
// closing the main window HIDES it instead of quitting.
//
// PLAIN DIVS AND INLINE STYLES, no MUI — the overlay bundle's rule, applied here for the sharper
// version of the same reason. This window is created at the moment of a close and has to be on
// screen immediately; pulling the app's theme, emotion and the MUI button surface into it would
// buy two sentences and three buttons a framework they do not need, and would pay for it in the
// one place the user is watching. The colours are the app's own tokens written out (theme.ts:
// `background.default` #0f1115, `background.paper` #171a21, `primary.main` #d9b25f), the same
// arrangement overlay.html already lives with.
//
// IT IS NOT A DIALOG. The close it explains has ALREADY happened; nothing here is a confirmation
// and there is no way to cancel anything. The three buttons are three ways out of a state the
// user is already in, and doing nothing is a fourth: main takes the card away after fifteen
// seconds or on blur, WITHOUT acknowledging, so somebody who did not read it sees it again next
// time (shared/closeToTray.ts).
//
// STATE, NEVER PROCESS (the repo's UI law): the copy says what the companion is doing and how to
// get the window back. It does not mention windows, hiding, processes or preferences.

import React from 'react'
import ReactDOM from 'react-dom/client'

/** The three verbs this window has (src/preload/tray.ts). Declared here rather than imported from
 *  the preload, so this bundle depends on nothing outside the renderer — the same shape the
 *  overlay entry's `window.eqOverlay` typing takes. */
interface EqTray {
  quitNow: () => void
  alwaysQuit: () => void
  acknowledge: () => void
}

declare global {
  interface Window {
    eqTray?: EqTray
  }
}

const BUTTON: React.CSSProperties = {
  font: 'inherit',
  fontSize: 12,
  padding: '6px 12px',
  borderRadius: 6,
  border: '1px solid rgba(255, 255, 255, 0.18)',
  background: '#171a21',
  color: '#e6e8ee',
  cursor: 'pointer'
}

/** The one button that ends the card without ending anything else, so it carries the app's accent
 *  and the other two do not. */
const PRIMARY: React.CSSProperties = {
  ...BUTTON,
  borderColor: 'rgba(217, 178, 95, 0.55)',
  color: '#d9b25f'
}

function TrayNotice(): React.JSX.Element {
  const tray = window.eqTray
  return (
    <div
      data-testid="tray-notice"
      style={{
        boxSizing: 'border-box',
        width: '100%',
        height: '100%',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        border: '1px solid rgba(255, 255, 255, 0.12)',
        borderRadius: 8
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 700 }}>Still running in the tray</div>
      <div style={{ fontSize: 12, lineHeight: 1.45, color: '#b6bcc9', flexGrow: 1 }}>
        The companion keeps watching your log so your timers, alerts and overlays carry on. Click
        the tray icon to bring the window back.
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" style={BUTTON} data-testid="tray-notice-quit" onClick={() => tray?.quitNow()}>
          Quit now
        </button>
        <button
          type="button"
          style={BUTTON}
          data-testid="tray-notice-always-quit"
          onClick={() => tray?.alwaysQuit()}
        >
          Always quit instead
        </button>
        <button type="button" style={PRIMARY} data-testid="tray-notice-ack" onClick={() => tray?.acknowledge()}>
          Got it
        </button>
      </div>
    </div>
  )
}

// tray.html always carries #tray-root; fail loudly rather than mounting nothing into a window
// the user can see (the overlay entry's rule).
const root = document.getElementById('tray-root')
if (!root) throw new Error('tray.html is missing #tray-root')
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <TrayNotice />
  </React.StrictMode>
)
