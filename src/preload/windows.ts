// windows.ts — the slice of the main app's bridge that is about WINDOWS: this window's own
// frameless title-bar controls (Task #23), the floating overlays' open-state, and the
// celebration toast (docs/plans/celebration-toasts.md).
//
// A separate file for FILE MASS, not for scope: src/preload/index.ts sits at the measured
// 400-code-line ceiling and the rule here is to split rather than ratchet (perf.ts is the same
// pattern). This object is spread into that bridge, so every method below is an ordinary member
// of the one `window.eq` surface — nothing about the trust boundary changes by being written
// next door.
//
// Showing a toast is FIRE-AND-FORGET: a producer never waits on a notification.

import { ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { ToastRequest } from '../shared/toast'
import type { AlertBannerPayload } from '../shared/alertBanner'
import type { ScopeSelection } from '../shared/scopeSelection'
import type { BuffAllowPatch, BuffAllowPrefs } from '../shared/buffAllow'
import type { CloseToTrayPrefs } from '../shared/closeToTray'
import type { OverlayConfig, OverlayKind } from '../shared/types'

export const windowsApi = {
  // ---- frameless window controls (Task #23) ----
  // The React title bar (App.tsx) drives the native window: these mirror the OS min/max/close
  // chrome removed with `frame: false`. They moved here from index.ts when that file hit the
  // 400-code-line ceiling again — the same split, and this is the file about windows.
  minimizeWindow: (): void => ipcRenderer.send(IPC.windowMinimize),
  toggleMaximizeWindow: (): void => ipcRenderer.send(IPC.windowToggleMaximize),
  closeWindow: (): void => ipcRenderer.send(IPC.windowClose),
  /** Subscribe to maximize/unmaximize so the title bar can swap the max/restore icon. */
  onWindowMaximized: (cb: (maximized: boolean) => void): (() => void) => {
    const listener = (_e: unknown, maximized: boolean): void => cb(maximized)
    ipcRenderer.on(IPC.onWindowMaximized, listener)
    return () => ipcRenderer.removeListener(IPC.onWindowMaximized, listener)
  },

  // ---- what the X does (JOS-139; shared/closeToTray.ts) ----
  // IT LIVES IN THIS SLICE, not in a fourth prefs bridge of its own, for the reason this file
  // exists: src/preload/index.ts is at the 400-code-line ceiling, and a preference about what
  // CLOSING THIS WINDOW means is a window control wearing a Switch. The setter is a MERGE-PATCH
  // and resolves to what was actually stored (main re-validates through the shared normalizer),
  // so the Preferences card renders main's answer rather than assuming its request landed.
  /** The close-to-tray preference. ON on every install that has not turned it off. */
  getCloseToTray: (): Promise<CloseToTrayPrefs> => ipcRenderer.invoke(IPC.closeToTrayGet),
  /** Merge-patch it; the very next close of this window obeys the new value. */
  setCloseToTray: (patch: Partial<CloseToTrayPrefs>): Promise<CloseToTrayPrefs> =>
    ipcRenderer.invoke(IPC.closeToTraySet, patch),
  /** Subscribe to changes made where this window could not see them — the tray menu's checkbox,
   *  the popover's `Always quit instead`. This is what keeps the two controls agreeing. */
  onCloseToTray: (cb: (p: CloseToTrayPrefs) => void): (() => void) => {
    const listener = (_e: unknown, p: CloseToTrayPrefs): void => cb(p)
    ipcRenderer.on(IPC.onCloseToTray, listener)
    return () => ipcRenderer.removeListener(IPC.onCloseToTray, listener)
  },

  // ---- the floating overlays' open-state (Task #52; per-kind in Task #54) ----
  /** Toggle a kind's overlay window; resolves to the resulting open-state. */
  toggleOverlay: (kind: OverlayKind): Promise<boolean> => ipcRenderer.invoke(IPC.overlayToggle, kind),
  /** Read the open-state map for all overlay kinds. */
  getOverlayState: (): Promise<Record<OverlayKind, boolean>> => ipcRenderer.invoke(IPC.overlayGetState),
  /** Subscribe to overlay open-state changes (so the TitleBar menu stays in sync). Payload {kind, open}. */
  onOverlayState: (cb: (s: { kind: OverlayKind; open: boolean }) => void): (() => void) => {
    const listener = (_e: unknown, s: { kind: OverlayKind; open: boolean }): void => cb(s)
    ipcRenderer.on(IPC.onOverlayState, listener)
    return () => ipcRenderer.removeListener(IPC.onOverlayState, listener)
  },

  // ---- global fight selection (docs/plans/combat-overlay-parity.md P4) ----
  // It lives in THIS slice rather than beside the combat snapshot because it is a CROSS-WINDOW
  // fact, not a combat one: main holds it precisely so the Combat tab and the fight overlays
  // (separate renderer processes) can agree. The overlay bridge carries the same three members
  // under the same names — that structural identity is what lets ONE renderer hook drive both
  // surfaces (`useGlobalFight`), and it is pinned by tests/fightSelection.test.mts.
  /** The currently selected fight ('__live__' or an 'e<n>' encounter id). */
  getFightSelection: (): Promise<string> => ipcRenderer.invoke(IPC.fightSelectionGet),
  /** "The user picked this fight." Fire-and-forget; main validates and fans out. */
  setFightSelection: (id: string): void => ipcRenderer.send(IPC.fightSelectionSet, id),
  /** Subscribe to selection changes made anywhere in the app. Payload {fightId}. */
  onFightSelection: (cb: (s: { fightId: string }) => void): (() => void) => {
    const listener = (_e: unknown, s: { fightId: string }): void => cb(s)
    ipcRenderer.on(IPC.onFightSelection, listener)
    return () => ipcRenderer.removeListener(IPC.onFightSelection, listener)
  },

  // ---- the app-wide SCOPE selection (JOS-332) ----
  // WHICH TIERS of the current camp count and WHICH HOUR the rates divide by — one answer for this
  // window and the XP overlay together. It lives in THIS slice for the fight selection's reason
  // above: it is a CROSS-WINDOW fact, main holds it precisely so two renderer processes can agree,
  // and the overlay bridge carries the same three members under the same names so ONE renderer
  // hook (`useScopeSelection`) drives the tab's toggle row and the overlay's footer buttons alike.
  // Pinned by tests/scopeSelection.test.mts.
  /** The membership + denominator in force everywhere. */
  getScopeSelection: (): Promise<ScopeSelection> => ipcRenderer.invoke(IPC.scopeSelectionGet),
  /** "The user moved one of these knobs." A PARTIAL — the half you do not mention does not move.
   *  Fire-and-forget; main rebuilds the patch and fans the result out. */
  setScopeSelection: (patch: Partial<ScopeSelection>): void => ipcRenderer.send(IPC.scopeSelectionSet, patch),
  /** Subscribe to scope changes made in ANY window. Payload is the whole selection. */
  onScopeSelection: (cb: (s: ScopeSelection) => void): (() => void) => {
    const listener = (_e: unknown, s: ScopeSelection): void => cb(s)
    ipcRenderer.on(IPC.onScopeSelection, listener)
    return () => ipcRenderer.removeListener(IPC.onScopeSelection, listener)
  },

  // ---- the buff/debuff TRACKING ALLOW-LIST (JOS-168) ----
  // WHICH of your spells the two timer overlays may draw: the opt-in mode switch that lives on the
  // Buffs tab, and the tri-state verdict per spell line behind it. It lives in THIS slice for the
  // scope selection's reason directly above — it is a CROSS-WINDOW fact, main holds it precisely so
  // two renderer processes can agree about it, and the overlay bridge carries the same READERS
  // under the same names so ONE renderer hook (`useBuffAllow`) drives the tab's checkboxes and the
  // windows' filter alike. The difference from the two facts above it: this one is PERSISTED, since
  // which spells you track is not a thing you re-choose every launch.
  /** The persisted allow-list. Default mode with no verdicts — everything draws — until set. */
  getBuffAllow: (): Promise<BuffAllowPrefs> => ipcRenderer.invoke(IPC.buffAllowGet),
  /** Apply a PARTIAL: the mode, some verdicts, or both. Resolves to what was ACTUALLY stored, and
   *  main fans the result out — so a box checked here reaches an already-open overlay window. */
  setBuffAllow: (patch: BuffAllowPatch): Promise<BuffAllowPrefs> =>
    ipcRenderer.invoke(IPC.buffAllowSet, patch),
  /** Subscribe to changes made anywhere. Payload is the whole preference. */
  onBuffAllow: (cb: (p: BuffAllowPrefs) => void): (() => void) => {
    const listener = (_e: unknown, p: BuffAllowPrefs): void => cb(p)
    ipcRenderer.on(IPC.onBuffAllow, listener)
    return () => ipcRenderer.removeListener(IPC.onBuffAllow, listener)
  },

  // ---- celebration toasts (docs/plans/celebration-toasts.md) ----
  /**
   * "Celebrate this." Called by the app's EXISTING always-mounted celebration detectors — the
   * same callbacks that fire the bossDefeat / questComplete app signals, so the live-only
   * discipline is owned in one place. Main re-validates the request, resolves the reward item
   * card and forwards it to the toast overlay window.
   */
  showToast: (req: ToastRequest): void => ipcRenderer.send(IPC.toastShow, req),

  // ---- the Preferences panel's door to `overlays.toast` -------------------------------
  // The overlay windows read their own config through the overlay bridge; the MAIN window
  // needs one read for exactly one kind, so it is spelled kind-first here rather than exposing
  // a general per-kind config surface to the app. (Its WRITE twin, `setToastConfig`, existed
  // for the sound picker alone and went with it on 2026-08-05 — the panel's two remaining
  // controls are the window's open-state and its lock, and both have their own calls.)
  /** Read the toast overlay's persisted config (duration + lock + bounds). */
  getToastConfig: (): Promise<OverlayConfig> => ipcRenderer.invoke(IPC.overlayGetConfig, 'toast'),
  /**
   * Lock (click-through) / unlock (position it) the toast window. A separate call from the
   * config patch above because this one is APPLIED to the live window as well as persisted —
   * `overlay:setConfig` only stores.
   */
  setToastLocked: (locked: boolean): void => ipcRenderer.send(IPC.overlaySetLocked, 'toast', locked),

  // ---- the alert banner (JOS-378, shared/alertBanner.ts) ------------------------------
  /**
   * "Show this alert on screen." Called by the ALWAYS-MOUNTED AlertPlayer, which is the one place
   * a fired alert becomes something the user experiences — so the banner rides the same firing
   * paths as the sound and the speech and can never disagree with them about which alerts fired.
   * Fire-and-forget; main re-validates and drops it when the overlay is off.
   */
  showAlertBanner: (payload: AlertBannerPayload): void => ipcRenderer.send(IPC.alertsBanner, payload),
  /**
   * Read the banner overlay's persisted config (its hold, its line budget, its lock).
   *
   * Kind-first like `getToastConfig` above, and for the same reason: the overlay WINDOWS read
   * their own config through the overlay bridge, and the main window needs this for exactly the
   * two kinds it draws a Preferences card for. Two spelled-out doors are still a smaller surface
   * than a general per-kind config API handed to the app.
   */
  getAlertBannerConfig: (): Promise<OverlayConfig> => ipcRenderer.invoke(IPC.overlayGetConfig, 'alertBanner'),
  /** Patch the banner overlay's config (Preferences owns its hold + line budget). Main clamps. */
  setAlertBannerConfig: (patch: Partial<OverlayConfig>): Promise<OverlayConfig> =>
    ipcRenderer.invoke(IPC.overlaySetConfig, 'alertBanner', patch),
  /** Lock (click-through) / unlock (position it). APPLIED to the live window as well as stored. */
  setAlertBannerLocked: (locked: boolean): void =>
    ipcRenderer.send(IPC.overlaySetLocked, 'alertBanner', locked),

  // ---- the con card (JOS-383, shared/conCard.ts) --------------------------------------
  //
  // THREE DOORS, NOT FOUR: there is no `showConCard` twin of `showAlertBanner`, because this
  // feature has no renderer producer at all — the trigger is a log line and main owns the log.
  /** Read the con card overlay's persisted config (its auto-hide, its lock). Kind-first, like the
   *  two cards above it, for the reason stated there. */
  getConCardConfig: (): Promise<OverlayConfig> => ipcRenderer.invoke(IPC.overlayGetConfig, 'conCard'),
  /** Patch the con card's config (Preferences owns the auto-hide). Main clamps; 0 means never. */
  setConCardConfig: (patch: Partial<OverlayConfig>): Promise<OverlayConfig> =>
    ipcRenderer.invoke(IPC.overlaySetConfig, 'conCard', patch),
  /** Lock (click-through) / unlock (position it). APPLIED to the live window as well as stored. */
  setConCardLocked: (locked: boolean): void => ipcRenderer.send(IPC.overlaySetLocked, 'conCard', locked)
}
