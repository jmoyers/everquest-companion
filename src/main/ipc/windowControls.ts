// IPC: everything the renderer says ABOUT WINDOWS — the frameless title-bar controls, the
// floating overlays' open/config/click-through state, the cross-window deep link, and the
// renderer's own error reports.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { E2E } from '../e2e'
import { logError } from '../errorLog'
import { getFightSelection, setFightSelection } from '../fightSelection'
import { getScopeSelection, setScopeSelection } from '../scopeSelection'
import { getOverlayConfig, setOverlayConfig } from '../store'
import { getOverlaySnap, setOverlaySnap } from '../storeOverlaySnap'
import { getCloseToTray, setCloseToTray } from '../storeCloseToTray'
import { syncTrayMenu } from '../tray'
import { noteCurrentView } from '../telemetry/errorReports'

/** What the preload's `RendererErrorReport` puts on the wire. Every field is optional here
 *  because the sender is untrusted and nothing downstream requires any of them. */
interface RendererErrorPayload {
  message?: string
  stack?: string
  source?: string
  name?: string
  view?: string
}
import {
  applyOverlayLocked,
  getMainWindow,
  getOverlayWindow,
  isOverlayOpen,
  overlayStateMap,
  setOverlayIgnoreMouse,
  setOverlayOpen
} from '../windows'
import { OVERLAY_KINDS } from '../../shared/types'
import type { AppFocus, AppFocusView, OverlayConfig, OverlayKind } from '../../shared/types'

/** A non-empty display string, or undefined. Trimmed only for the emptiness test — the receiving
 *  view looks the value up verbatim, exactly as the sending window read it. */
function focusText(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

/** The deep link, rebuilt from the fields this boundary names. See the comment at its caller. */
function sanitizeFocus(focus: AppFocus): AppFocus {
  const out: AppFocus = { view: focus.view }
  const mob = focusText(focus.mob)
  if (mob) out.mob = mob
  const quest = focusText(focus.quest)
  if (quest) out.quest = quest
  if (typeof focus.level === 'number' && Number.isInteger(focus.level) && focus.level > 0) {
    out.level = focus.level
  }
  return out
}

export function registerWindowIpc(): void {
  // ---- cross-window deep link (Task #64) ----
  // An overlay row says a thing happened; clicking it asks the APP to answer it properly. Main
  // is the only process that can raise a window it doesn't own, so the hop goes through here.
  //
  // The `view` is re-validated against the closed AppFocusView union rather than trusted
  // because today's only caller is the app's own overlay (the same rule `sounds:getData`'s
  // packId follows): a renderer telling another renderer where to navigate is a capability, and
  // its vocabulary is fixed here. The ANCHORS are forwarded on the same terms: `mob` and `quest`
  // only when non-empty strings (pure display/lookup text in the receiving view, never a path),
  // `level` only as a small positive integer. The forwarded object is REBUILT from those fields,
  // so nothing else the asking window attached ever reaches the app's renderer.
  //
  // E2E never shows a window (src/main/e2e.ts is the whole test mode), so the raise is skipped
  // there; the forward still happens, which is the half a test could observe.
  ipcMain.on(IPC.focusView, (_e, focus: AppFocus) => {
    // The closed vocabulary, restated here on purpose (see above): 'mobs' from the events
    // overlay's con rows, 'posky' from a celebration toast's reward card (optionally anchored at
    // ONE quest), 'leveling' from a level-up toast (anchored at the level that just dinged).
    const views: AppFocusView[] = ['mobs', 'posky', 'leveling']
    if (!focus || !(views as string[]).includes(focus.view)) return
    const w = getMainWindow()
    if (!w || w.isDestroyed()) return
    if (!E2E) {
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
    }
    w.webContents.send(IPC.onFocusView, sanitizeFocus(focus))
  })

  // ---- frameless window controls (Task #23) ----
  // The React title bar (App.tsx) drives the native window: these mirror the
  // OS min/max/close chrome we removed with `frame: false`. `ipcMain.on` matches
  // the preload's fire-and-forget `send`.
  ipcMain.on(IPC.windowMinimize, () => getMainWindow()?.minimize())
  ipcMain.on(IPC.windowToggleMaximize, () => {
    const mainWindow = getMainWindow()
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on(IPC.windowClose, () => getMainWindow()?.close())

  // ---- floating overlay DPS meters (Task #52; per-kind in Task #54) ----
  // Toggle a kind from the main app's TitleBar menu; returns the resulting open-state.
  ipcMain.handle(IPC.overlayToggle, (_e, kind: OverlayKind) =>
    setOverlayOpen(kind, !isOverlayOpen(kind))
  )
  ipcMain.handle(IPC.overlayGetState, () => overlayStateMap())
  ipcMain.handle(IPC.overlayGetConfig, (_e, kind: OverlayKind) => getOverlayConfig(kind))
  ipcMain.handle(IPC.overlaySetConfig, (_e, kind: OverlayKind, patch: Partial<OverlayConfig>) => {
    // TEXT SCALE IS ONE VALUE ACROSS EVERY OVERLAY (owner, 2026-08-05: scaling the fight meter
    // and watching the overall meter not move reads as broken). The field still LIVES per kind
    // (config shape untouched, every reader unchanged) — this setter is the one door every
    // patch walks through, so a textScale write simply fans out to all kinds and every open
    // overlay window hears its own echo. A locked window with hidden controls follows along,
    // which is half the point.
    const p = patch ?? {}
    if (p.textScale !== undefined) {
      let out: OverlayConfig | null = null
      for (const k of OVERLAY_KINDS) {
        const merged = setOverlayConfig(k, k === kind ? p : { textScale: p.textScale })
        getOverlayWindow(k)?.webContents.send(IPC.onOverlayConfig, { kind: k, config: merged })
        if (k === kind) out = merged
      }
      return out ?? setOverlayConfig(kind, {})
    }
    const next = setOverlayConfig(kind, p)
    // Echo the merged config to that kind's overlay window so its UI stays in sync if the change
    // originated elsewhere (keeps the contract honest and cheap).
    getOverlayWindow(kind)?.webContents.send(IPC.onOverlayConfig, { kind, config: next })
    return next
  })
  // Locked (click-through) vs interactive. Persist + apply to the live window + ECHO.
  //
  // The echo is not decoration: this used to be called only BY the overlay that owns the lock
  // (which patches its own state first), so nothing had to tell it. The celebration toast is
  // driven from PREFERENCES as well — "Move it" is in the main window — and a toast overlay
  // that never heard about the change would keep rendering as though it were still locked.
  ipcMain.on(IPC.overlaySetLocked, (_e, kind: OverlayKind, locked: boolean) => {
    const next = setOverlayConfig(kind, { locked })
    applyOverlayLocked(kind, locked)
    getOverlayWindow(kind)?.webContents.send(IPC.onOverlayConfig, { kind, config: next })
  })
  // Fine-grained pass-through toggle: the meters' hover sensor (locked mode), and the toast
  // overlay's queue transitions (empty ⇒ pass everything through; a card on screen ⇒ capture).
  // Whether mouse-move is FORWARDED is decided per kind in windows.ts, in one place.
  ipcMain.on(IPC.overlaySetIgnoreMouse, (_e, kind: OverlayKind, ignore: boolean) => {
    setOverlayIgnoreMouse(kind, ignore)
  })
  ipcMain.on(IPC.overlayClose, (_e, kind: OverlayKind) => setOverlayOpen(kind, false))

  // ---- overlay snapping (JOS-217) ----
  // The one preference behind `installOverlaySnap` (src/main/overlaySnapDrag.ts). It needs no
  // apply step and no echo: the drag listener reads the store on every move, so flipping this
  // switch takes effect on the very next drag of an already-open overlay. The patch is renderer
  // input and is re-validated inside `setOverlaySnap` through the shared normalizer, so a
  // hand-edited file and a renderer cannot disagree about what this setting is.
  ipcMain.handle(IPC.overlaySnapGet, () => getOverlaySnap())
  ipcMain.handle(IPC.overlaySnapSet, (_e, patch: unknown) => setOverlaySnap(patch))

  // ---- what the X does (JOS-139) ----
  // The preference behind the close interceptor (src/main/tray.ts). The patch is renderer input
  // and is re-validated inside `setCloseToTray` through the shared normalizer, so a hand-edited
  // file and a renderer cannot disagree about what this setting is.
  //
  // THE SETTER HAS AN APPLY STEP, and it is the tray's own checkbox: the menu is rebuilt from
  // what was STORED, so the two controls can never be two answers to one question. There is no
  // echo back to this renderer — it is the one that asked — and no apply to the window itself,
  // because the interceptor reads the store on every close rather than remembering anything.
  ipcMain.handle(IPC.closeToTrayGet, () => getCloseToTray())
  ipcMain.handle(IPC.closeToTraySet, (_e, patch: unknown) => {
    const next = setCloseToTray(patch)
    syncTrayMenu(next)
    return next
  })

  // ---- global fight selection (docs/plans/combat-overlay-parity.md P4) ----
  // A read for a surface that mounted after the last change, and a fire-and-forget write that
  // fans out to every window. The write's argument is renderer input and is shape-checked inside
  // `setFightSelection` (shared/fightSelection.ts) — a zone-session id or a hand-crafted string
  // is dropped there, never broadcast. Nothing here can move a surface's Fight/Overall SCOPE.
  ipcMain.handle(IPC.fightSelectionGet, () => getFightSelection())
  ipcMain.on(IPC.fightSelectionSet, (_e, id: unknown) => {
    setFightSelection(id)
  })

  // ---- the app-wide SCOPE selection (JOS-332) ----
  // The same two-call shape as the fight selection above, for the same reason and by the same
  // argument: a read for a window that mounted after the last change, and a fire-and-forget PATCH
  // that fans out to every window. The patch is renderer input and is rebuilt inside
  // `setScopeSelection` (shared/scopeSelection.ts) — an unknown membership or a denominator this
  // build cannot name is dropped there, never broadcast, and the half a patch does not mention
  // never moves. Nothing here can touch a surface's SLICE.
  ipcMain.handle(IPC.scopeSelectionGet, () => getScopeSelection())
  ipcMain.on(IPC.scopeSelectionSet, (_e, patch: unknown) => {
    setScopeSelection(patch)
  })

  // Fire-and-forget renderer error reports (window.onerror / unhandledrejection /
  // React ErrorBoundary). `ipcMain.on` (not handle) matches the preload's `send`.
  //
  // Structurally the preload's `RendererErrorReport`; see `RendererErrorPayload` below.
  //
  // `logError` is still the ONE funnel: it writes the file, bumps `mainErrorLogLines`, and —
  // since JOS-100 — builds the error REPORT. So the payload handed to it carries `name` and
  // `code` as their own fields rather than mashed into the message, because `errorFingerprint`
  // groups on the name and the frames.
  //
  // The VIEW is noted separately and BEFORE the log call, not passed through it: it is state
  // that outlives this error (a later main-process throw reports the same view), and it is
  // untrusted renderer input, so it goes through `noteCurrentView`'s closed-enum check.
  // The parameter is spelled out rather than importing `RendererErrorReport` from the preload:
  // main does not depend on the preload bundle in either direction, and a type-only import
  // would be the first. It is IPC input, so `unknown`-ish fields and defensive reads are the
  // honest shape anyway — nothing here trusts the renderer.
  ipcMain.on(IPC.reportError, (_e, report: RendererErrorPayload | undefined) => {
    noteCurrentView(report?.view)
    const source = report?.source ? `renderer:${report.source}` : 'renderer:report'
    logError(source, { name: report?.name, message: report?.message, stack: report?.stack })
  })
}
