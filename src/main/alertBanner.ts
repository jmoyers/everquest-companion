// alertBanner.ts — main's half of the ALERT BANNER overlay (JOS-378, shared/alertBanner.ts).
//
// ONE HOP IN, ONE HOP OUT, and less work than the toast's: the producer (the always-mounted
// AlertPlayer in the main window) has already resolved the sentence through the SAME derivation
// the spoken channel uses, so there is nothing for main to look up. What main owns is what only
// main can: the overlay window handle, the persisted per-kind config the hold comes from, and
// the re-validation every renderer→main payload gets at its handler.
//
// A CLOSED OVERLAY IS SILENT. Nothing is forwarded when the window is not open — the banner
// belongs to the overlay, not to the firing (the firing already has its sound, its speech and its
// entry in the event log). That is what makes the Preferences switch honest: off means off.
//
// THE PER-ALERT SWITCH IS THE RENDERER'S (it holds the def, and it is where "would this even have
// been heard" is already decided); the OVERLAY switch is this file's. Two halves of one gate, each
// asked where its answer lives.
//
// NO GATE ON MUTE, DELIBERATELY. Mute is a promise about SOUND — a player on Discord runs the app
// muted precisely so they can still be told things (the 2026-08-15 report this ticket exists for).
// A banner is not noise, so nothing here consults the alerts module's mute, and nothing upstream
// does either (features/alerts/player.tsx posts the banner before the audio plan is consulted).

import { ipcMain } from 'electron'
import { IPC } from '../shared/ipc'
import { logError } from './errorLog'
import { getOverlayConfig } from './store'
import { getOverlayWindow } from './windows'
import {
  DEFAULT_ALERT_BANNER_CONFIG,
  validateAlertBannerPayload,
  type AlertBannerPayload
} from '../shared/alertBanner'

/**
 * Push a validated line at the banner overlay. A window that is still loading its page (the first
 * firing after the overlay is switched on, and every firing in the e2e harness's first moments)
 * would silently drop the send, so the push waits for `did-finish-load` instead — the celebration
 * toast learned this the same way.
 */
function sendToBannerOverlay(payload: AlertBannerPayload): void {
  const w = getOverlayWindow('alertBanner')
  if (!w || w.isDestroyed()) return
  const wc = w.webContents
  if (wc.isLoading()) wc.once('did-finish-load', () => wc.send(IPC.onAlertBanner, payload))
  else wc.send(IPC.onAlertBanner, payload)
}

/**
 * The whole flow for one firing: validate, bail if the overlay is off, fill the hold from the
 * kind's config when the payload named none, forward. Exported for the tests that drive it
 * without an IPC round trip.
 */
export function showAlertBanner(input: unknown): boolean {
  const payload = validateAlertBannerPayload(input)
  if (!payload) return false
  const cfg = getOverlayConfig('alertBanner')
  if (!cfg.open) return false
  const bannerCfg = cfg.alertBanner ?? DEFAULT_ALERT_BANNER_CONFIG
  sendToBannerOverlay({ ...payload, holdMs: payload.holdMs ?? bannerCfg.holdMs })
  return true
}

export function registerAlertBannerIpc(): void {
  ipcMain.on(IPC.alertsBanner, (_e, payload: unknown) => {
    try {
      showAlertBanner(payload)
    } catch (err: unknown) {
      logError('main:alertsBanner', err)
    }
  })
}
