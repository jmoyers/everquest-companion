import React from 'react'
import ReactDOM from 'react-dom/client'
import OverlayMeter from './OverlayMeter'
import EventLogOverlay from './EventLogOverlay'
import HealMeter from './HealMeter'
import ToastOverlay from './ToastOverlay'
import AlertBannerOverlay from './AlertBannerOverlay'
import BuffsOverlay from './BuffsOverlay'
import XpOverlay from './XpOverlay'
import RespawnOverlay from './RespawnOverlay'
import { isHealOverlayKind } from '@shared/types'
import { isTimerOverlayKind } from '@shared/buffTimers'
import { installOverlayPointerExit } from './pointerExit'

// The overlay renders in its OWN transparent BrowserWindow (Task #52). It is a
// standalone React root — deliberately NOT wrapped in the app's MUI ThemeProvider
// or ErrorBoundary. Every surface here is a tiny, dependency-light component (plain
// divs + inline styles) so it stays cheap to paint on top of the game and has no
// reason to pull the whole MUI/theme surface into a second window bundle.
//
// ONE bundle serves every overlay KIND; which component mounts is decided by the
// `?kind=` query the window was opened with (read + validated by the preload):
//   'events'                          → the event log (alerts / notable loot / quests)
//   'heal-fight' | 'heal-overall'     → the healing meter (Task #59)
//   'toast'                           → the celebration strip (usually renders nothing)
//   'buffs' | 'debuffs'               → the timer bars (JOS-89, split in two by JOS-119): ONE
//                                       component with a `kind` prop, never two copies — the
//                                       buffs window keeps the beneficial rows, the debuffs
//                                       window keeps the debuff + crowd-control rows, and both
//                                       read the same two modules
//   'xp'                              → the progress read (JOS-195): xp/hr, next level (or the AA
//                                       pace at the cap) and motes per hour, over the app-wide
//                                       slice vocabulary with `session` as its own default
//   'alertBanner'                     → the alert banner (JOS-378): one large line per firing of an
//                                       alert marked "Show on screen", where the eyes are. Shares
//                                       the toast's queue (./cardQueue.ts), not its window
//   'respawn'                         → the respawn clocks (JOS-194): one countdown per watched
//                                       mob that has died, started by the death message and
//                                       numbered from your own kills
//   everything else                   → the damage meter (fight / zone selection lives inside)
const kind = window.eqOverlay?.kind ?? 'fight'

function Surface(): React.JSX.Element {
  if (kind === 'events') return <EventLogOverlay />
  if (kind === 'toast') return <ToastOverlay />
  if (kind === 'alertBanner') return <AlertBannerOverlay />
  if (kind === 'xp') return <XpOverlay />
  if (kind === 'respawn') return <RespawnOverlay />
  if (isTimerOverlayKind(kind)) return <BuffsOverlay kind={kind} />
  if (isHealOverlayKind(kind)) return <HealMeter />
  return <OverlayMeter />
}

// EVERY KIND GETS THE ORPHAN GUARD (JOS-358). A native tooltip that outlives the pointer sits on
// top of the GAME, and a click-through window has nothing left to un-hover it — so the dismissal
// is installed here, once, for whichever surface mounts below. See overlay/pointerExit.ts for
// which three things count as "the pointer left" on an always-on-top window.
installOverlayPointerExit()

// overlay.html always carries #overlay-root; fail loudly rather than letting
// createRoot throw a container error nobody can trace back.
const container = document.getElementById('overlay-root')
if (!container) throw new Error('overlay: #overlay-root container missing from overlay.html')

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <Surface />
  </React.StrictMode>
)
