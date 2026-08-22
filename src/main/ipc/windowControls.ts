// IPC: everything the renderer says ABOUT WINDOWS — the frameless title-bar controls, the
// floating overlays' open/config/click-through state, the cross-window deep link, and the
// renderer's own error reports.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { E2E } from '../e2e'
import { logError, logInfo } from '../errorLog'
import { noteOwnWindowRaise } from '../presence'
import { getFightSelection, setFightSelection } from '../fightSelection'
import { getScopeSelection, setScopeSelection } from '../scopeSelection'
import { getSessionMarks, pressNewSession } from '../sessionMarks'
import { getOverlayConfig, setOverlayConfig } from '../store'
import { getOverlaySnap, setOverlaySnap } from '../storeOverlaySnap'
import { getOverlayTextSize, setOverlayTextSize } from '../storeOverlayTextSize'
import type { OverlayTextSizePrefs } from '../../shared/overlayTextScale'
import { getOverlayBgAlpha, setOverlayBgAlpha } from '../storeOverlayBgAlpha'
import { BG_ALPHA_DEFAULT, type OverlayBgAlphaPrefs } from '../../shared/overlayBgAlpha'
import { applyOverlayIndependent } from '../storeOverlayIndependent'
import { getCloseToTray } from '../storeCloseToTray'
import { applyCloseToTray } from '../tray'
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
import { fitOverlayHeight, refitStripsForTextScale } from '../overlayBounds'
import {
  applyOverlayLocked,
  getMainWindow,
  getOverlayWindow,
  isOverlayOpen,
  overlayStateMap,
  setOverlayIgnoreMouse,
  setOverlayOpen
} from '../windows'
import { OVERLAY_KINDS, TEXT_SCALE_DEFAULT } from '../../shared/types'
import type { AppFocus, AppFocusView, OverlayConfig, OverlayKind } from '../../shared/types'

/**
 * ONE VALUE, THIRTEEN CONTROLS — so every change is told to all of them (JOS-405).
 *
 * The overlays' text size can be moved from any of twelve windows' own A− / A+ and from three
 * controls in Preferences, and the thing that decides what a window DRAWS is the preference rather
 * than anything in that window. So a change goes to every OPEN overlay window (which is how a
 * pinned meter — no chrome, no stepper, nothing to press — follows the shared size) and to the app
 * window (so the Preferences stepper and the twelve rows agree with a press made on a meter).
 *
 * Closed windows need nothing: an overlay reads the prefs on mount, so the next one to open comes
 * up at the current size by construction.
 */
function broadcastOverlayTextSize(prefs: OverlayTextSizePrefs): void {
  for (const k of OVERLAY_KINDS) {
    getOverlayWindow(k)?.webContents.send(IPC.onOverlayTextSize, prefs)
  }
  const app = getMainWindow()
  if (app && !app.isDestroyed()) app.webContents.send(IPC.onOverlayTextSize, prefs)
}

/** Every kind's OWN stored scale, clamped by the store on the way out. What Preferences'
 *  per-overlay list edits while independent sizes are on. */
function overlayTextScaleMap(): Record<OverlayKind, number> {
  const out = {} as Record<OverlayKind, number>
  for (const k of OVERLAY_KINDS) out[k] = getOverlayConfig(k).textScale ?? TEXT_SCALE_DEFAULT
  return out
}

/**
 * RE-STATE EVERY OPEN OVERLAY'S OWN CONFIG (JOS-405).
 *
 * An overlay window holds its config locally and only ever hears about changes it made or was
 * echoed. The first opt-in to independent sizes SEEDS all twelve per-kind values in the store
 * (storeOverlayTextSize.ts), which is a change no window made — MEASURED in
 * tests/e2e/text-size.e2e.mts: without this the fight meter went independent still holding the
 * `textScale` it was born with, and snapped to 100% under a store that said 120%.
 *
 * Called only from the two prefs setters (JOS-407 added transparency's, which seeds the same way),
 * not from every shared press: a press changes no kind's config at all, so echoing there would be
 * twelve sends saying nothing.
 */
function echoOverlayConfigs(): void {
  for (const k of OVERLAY_KINDS) {
    getOverlayWindow(k)?.webContents.send(IPC.onOverlayConfig, { kind: k, config: getOverlayConfig(k) })
  }
}

/** …and the push that keeps that list honest when a press is made on a WINDOW instead. Only the
 *  app window has rows to correct; an overlay's own config echo already told it about itself. */
function broadcastOverlayTextScales(): void {
  const app = getMainWindow()
  if (app && !app.isDestroyed()) app.webContents.send(IPC.onOverlayTextScales, overlayTextScaleMap())
}

/** THE SAME THREE, ONE FIELD OVER (JOS-407) — `bgAlpha` is the second overlay setting with a
 *  shared/independent switch, and it is broadcast, mapped and pushed by exactly the rules above.
 *  Separate functions rather than a generic pair because the two are linked and unlinked
 *  separately: a message carrying both would make one switch's flip look like the other's. */
function broadcastOverlayBgAlpha(prefs: OverlayBgAlphaPrefs): void {
  for (const k of OVERLAY_KINDS) {
    getOverlayWindow(k)?.webContents.send(IPC.onOverlayBgAlpha, prefs)
  }
  const app = getMainWindow()
  if (app && !app.isDestroyed()) app.webContents.send(IPC.onOverlayBgAlpha, prefs)
}

/** Every kind's OWN stored alpha, clamped by the store on the way out. What Preferences'
 *  per-overlay list edits while independent transparency is on. */
function overlayBgAlphaMap(): Record<OverlayKind, number> {
  const out = {} as Record<OverlayKind, number>
  for (const k of OVERLAY_KINDS) out[k] = getOverlayConfig(k).bgAlpha ?? BG_ALPHA_DEFAULT
  return out
}

function broadcastOverlayBgAlphas(): void {
  const app = getMainWindow()
  if (app && !app.isDestroyed()) app.webContents.send(IPC.onOverlayBgAlphas, overlayBgAlphaMap())
}

/**
 * THE TWO SHARED FIELDS, TAKEN OUT OF A PER-KIND PATCH BEFORE IT IS STORED (JOS-405, JOS-407).
 *
 * `overlay:setConfig` is one door for everything a window remembers, and two of those fields are
 * not that window's business while their switch is off: a press on the fight meter's A+ or a drag
 * of its `bg` slider moves the SHARED preference and touches no kind's stored value. This lifts
 * whichever of them is currently shared out of the patch, writes it where it actually lives, tells
 * every window, and hands back what remains for the ordinary per-kind path.
 *
 * Its own function because the handler it was inlined in is at the measured complexity ceiling, and
 * because the two fields' rules are now identical enough to read side by side: same test, same
 * setter shape, same broadcast. `routed` is returned rather than inferred from `rest`, because an
 * EMPTY remainder means two completely different things — nothing left to store, versus a patch
 * that was empty to begin with.
 */
function routeSharedOverlayFields(p: Partial<OverlayConfig>): {
  rest: Partial<OverlayConfig>
  routed: boolean
} {
  const rest = { ...p }
  let routed = false
  if (p.textScale !== undefined && !getOverlayTextSize().independent) {
    broadcastOverlayTextSize(setOverlayTextSize({ shared: p.textScale }))
    // …and the THREE STRIPS grow their windows with it (JOS-406): for the toast, the banner and
    // the con card the window IS the card, so a text size that only zoomed the content would lay
    // the card out in half the room. Panels are untouched; they scroll.
    refitStripsForTextScale()
    delete rest.textScale
    routed = true
  }
  if (p.bgAlpha !== undefined && !getOverlayBgAlpha().independent) {
    broadcastOverlayBgAlpha(setOverlayBgAlpha({ shared: p.bgAlpha }))
    // No refit: transparency changes what a card is painted with, never how much room it needs.
    delete rest.bgAlpha
    routed = true
  }
  return { rest, routed }
}

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
function onFocusViewAsk(focus: AppFocus): void {
  // The closed vocabulary, restated here on purpose (see above): 'mobs' from the events
  // overlay's con rows, 'posky' from a celebration toast's reward card (optionally anchored at
  // ONE quest), 'leveling' from a level-up toast (anchored at the level that just dinged).
  const views: AppFocusView[] = ['mobs', 'posky', 'leveling']
  if (!focus || !(views as string[]).includes(focus.view)) return
  const w = getMainWindow()
  if (!w || w.isDestroyed()) return
  if (!E2E) {
    // THE RAISE IS NARRATED AND GRACED (JOS-427). This is one of exactly two paths in the app
    // that move the OS foreground on purpose, and it was the silent activator behind the
    // "flicker" oscillation the narration finally caught: card click → raise → auto-hide parks
    // the overlays → click back into the game → un-park → next card click → raise… The owner's
    // ruling is that an overlay-initiated raise is still EverQuest, "spiritually" — so presence
    // is told before the focus moves, and the overlays stay up while the app is in front FOR
    // THIS REASON. An ordinary alt-tab into the Companion still parks them (JOS-199).
    noteOwnWindowRaise()
    logInfo(`[everquest-companion] presence: focusView raise -> ${focus.view} (overlay deep link)`)
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  }
  w.webContents.send(IPC.onFocusView, sanitizeFocus(focus))
}

export function registerWindowIpc(): void {
  ipcMain.on(IPC.focusView, (_e, focus: AppFocus) => onFocusViewAsk(focus))

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
    // TEXT SCALE AND BACKGROUND ALPHA ARE ROUTED, NOT FANNED OUT (JOS-405, JOS-407).
    //
    // The 2026-08-05 rule was that one text-size press moves every overlay, because scaling the
    // fight meter and watching the overall meter not move reads as broken. It was implemented by
    // WRITING all twelve per-kind fields on every press — which is right until somebody asks for
    // them apart, and then the twelve copies have already been flattened into one and there is
    // nothing to go back to. So the rule is now the DEFAULT of a switch rather than the law of this
    // handler, and transparency arrived a ticket later under the same two modes:
    //
    //   SYNCED       — the press or drag moves the SHARED preference and touches no kind's stored
    //                  value. Every open window is pushed the new prefs and resolves its own
    //                  effective value; a locked window with hidden controls follows along, which
    //                  is half the point.
    //   INDEPENDENT  — it writes THIS kind and echoes THIS window, exactly as the field's own shape
    //                  always said it would.
    //
    // Either way the per-kind value survives what the other mode does to it, which is the promise
    // both switches make: sync for a week, unsync, and your fight meter is 150% and faint again.
    const p = patch ?? {}
    const { rest, routed } = routeSharedOverlayFields(p)
    // Whatever ELSE the patch carried is still this kind's own business. `rest` is almost always
    // EMPTY (a stepper or a slider sends one field) and an empty write is not a no-op here: every
    // write merges over `getOverlayConfig`, which clamps an absent field to its default — so
    // writing nothing would still stamp a `textScale` onto a kind that has never had one.
    if (routed && Object.keys(rest).length === 0) return getOverlayConfig(kind)
    const next = setOverlayConfig(kind, rest)
    // Echo the merged config to that kind's overlay window so its UI stays in sync if the change
    // originated elsewhere (keeps the contract honest and cheap).
    getOverlayWindow(kind)?.webContents.send(IPC.onOverlayConfig, { kind, config: next })
    // …and, when the thing that moved was a per-kind SIZE (independent mode), tell Preferences,
    // whose per-overlay list is the only other place that number is written down.
    if (rest.textScale !== undefined) {
      broadcastOverlayTextScales()
      // …and the strip windows follow the size they are now drawing at (JOS-406), exactly as they
      // do on the shared route above. This is the INDEPENDENT branch, so at most one window moves.
      refitStripsForTextScale()
    }
    // The same correction for a per-kind ALPHA moved on a window while independent transparency is
    // on. No refit: a shade is not a size.
    if (rest.bgAlpha !== undefined) broadcastOverlayBgAlphas()
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
  // "What I drew is this tall" (JOS-386). ONLY the height moves, only for a kind whose height is
  // its content's, and never into the store as a chosen size — all three of those rules live in
  // `fitOverlayHeight` (overlayBounds.ts) beside the window it has to move. The height is
  // renderer input and is validated there rather than here, for the same reason the snap patch is
  // validated inside its setter: one door, one normalizer, and a hand-crafted send cannot find a
  // second one.
  ipcMain.on(IPC.overlayFitHeight, (_e, kind: OverlayKind, height: unknown) => {
    fitOverlayHeight(kind, height)
  })

  // ---- overlay snapping (JOS-217) ----
  // The one preference behind `installOverlaySnap` (src/main/overlaySnapDrag.ts). It needs no
  // apply step and no echo: the drag listener reads the store on every move, so flipping this
  // switch takes effect on the very next drag of an already-open overlay. The patch is renderer
  // input and is re-validated inside `setOverlaySnap` through the shared normalizer, so a
  // hand-edited file and a renderer cannot disagree about what this setting is.
  ipcMain.handle(IPC.overlaySnapGet, () => getOverlaySnap())
  ipcMain.handle(IPC.overlaySnapSet, (_e, patch: unknown) => setOverlaySnap(patch))

  // ---- the overlays' text size (JOS-405) ----
  // The read every overlay window makes on mount and Preferences seeds its three controls from,
  // and the write Preferences makes (a window's own A− / A+ arrives through `overlay:setConfig`
  // above, which routes it here). The patch is renderer input and is re-validated inside
  // `setOverlayTextSize` through the shared normalizer, so a hand-edited file and a renderer
  // cannot disagree about what this setting is.
  //
  // THE WRITE ALWAYS BROADCASTS, including the `independent` flip that carries no number: turning
  // the switch off is what puts every window back on the shared size, and no window can observe
  // that for itself.
  ipcMain.handle(IPC.overlayTextSizeGet, () => getOverlayTextSize())
  ipcMain.handle(IPC.overlayTextScalesGet, () => overlayTextScaleMap())
  ipcMain.handle(IPC.overlayTextSizeSet, (_e, patch: unknown) => {
    const prefs = setOverlayTextSize(patch)
    broadcastOverlayTextSize(prefs)
    // …the per-kind map with it, because the FIRST opt-in seeds all twelve per-kind values
    // (storeOverlayTextSize.ts `seedOnFirstOptIn`, so opting in resizes nothing) and Preferences'
    // rows go live in that same instant and must state the seeded numbers…
    broadcastOverlayTextScales()
    // …and each window's own config, for the same seed: a change no window made is a change no
    // window would otherwise hear about.
    echoOverlayConfigs()
    // …and the three STRIP WINDOWS are re-placed at the size they now draw at (JOS-406). Last,
    // after the seed has been written and told: `refitStripsForTextScale` reads each kind's
    // effective scale out of the store, so it has to run on the store this write leaves behind.
    refitStripsForTextScale()
    return prefs
  })

  // ---- the overlays' BACKGROUND TRANSPARENCY (JOS-407) ----
  // The read every overlay window makes on mount and Preferences seeds its controls from, and the
  // write Preferences makes (a window's own `bg` slider arrives through `overlay:setConfig` above,
  // which routes it here). The patch is renderer input and is re-validated inside `setOverlayBgAlpha`
  // through the shared normalizer, so a hand-edited file and a renderer cannot disagree.
  //
  // THE WRITE ALWAYS BROADCASTS, including the `independent` flip that carries no number: turning
  // the switch off is what puts every window back on the shared alpha, and no window can observe
  // that for itself.
  ipcMain.handle(IPC.overlayBgAlphaGet, () => getOverlayBgAlpha())
  ipcMain.handle(IPC.overlayBgAlphasGet, () => overlayBgAlphaMap())
  ipcMain.handle(IPC.overlayBgAlphaSet, (_e, patch: unknown) => {
    const prefs = setOverlayBgAlpha(patch)
    broadcastOverlayBgAlpha(prefs)
    // …the per-kind map with it, because the FIRST opt-in seeds all twelve per-kind values
    // (storeOverlayBgAlpha.ts `seedOnFirstOptIn`, so opting in re-paints nothing) and Preferences'
    // rows go live in that same instant and must state the seeded numbers…
    broadcastOverlayBgAlphas()
    // …and each window's own config, for the same seed: a change no window made is a change no
    // window would otherwise hear about.
    echoOverlayConfigs()
    return prefs
  })

  // ---- ONE SWITCH OVER BOTH (JOS-408) ----
  // Preferences carries a single `Independent per overlay`, because the owner's review found two
  // identical-looking switches governing different halves of the same twelve rows unreadable. The
  // two STORES are unchanged and so are the two setters above; this handler is the seam that moves
  // both flags in one call and then tells everyone once.
  //
  // THE ORDER MATTERS AND IT IS THE ONE THE TWO SETTERS ALREADY IMPLY: both writes land first
  // (`applyOverlayIndependent`, which runs each feature's seed-on-first-opt-in), and only then does
  // anything broadcast. A renderer making two calls could not promise that — an overlay window
  // would hear about the size flip and re-resolve against a transparency flag that had not moved.
  ipcMain.handle(IPC.overlayIndependentSet, (_e, on: unknown) => {
    applyOverlayIndependent(on === true)
    const text = getOverlayTextSize()
    const bg = getOverlayBgAlpha()
    // The same five sends both setters make, once each rather than twice: the two prefs, the two
    // per-kind maps the seed just wrote, and every window's own config (a change no window made).
    broadcastOverlayTextSize(text)
    broadcastOverlayBgAlpha(bg)
    broadcastOverlayTextScales()
    broadcastOverlayBgAlphas()
    echoOverlayConfigs()
    // …and the strips are re-placed at the size they now draw at (JOS-406), last, on the store this
    // write leaves behind.
    refitStripsForTextScale()
    return { text, bg }
  })

  // ---- what the X does (JOS-139) ----
  // The preference behind the close interceptor (src/main/tray.ts). The patch is renderer input
  // and is re-validated inside `setCloseToTray` through the shared normalizer, so a hand-edited
  // file and a renderer cannot disagree about what this setting is.
  //
  // THE SETTER IS THE TRAY'S OWN APPLY, `applyCloseToTray`: store, rebuild the tray menu's checkbox
  // from what was STORED, and push the value to the app window. The push goes back to the very
  // renderer that asked, on purpose — since 2026-08-16 that renderer holds TWO controls for this
  // one value (the Preferences switch and the title bar's overlay-menu row), and the one that did
  // not write has to learn what the other did. There is no apply to the window itself, because the
  // interceptor reads the store on every close rather than remembering anything.
  ipcMain.handle(IPC.closeToTrayGet, () => getCloseToTray())
  ipcMain.handle(IPC.closeToTraySet, (_e, patch: unknown) => applyCloseToTray(patch))

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

  // ---- the app-wide SESSION MARKS (JOS-436 store, JOS-322 seam) ----
  // A read for a window that mounted after the last press, and the press itself.
  //
  // THE PRESS TAKES NO ARGUMENT, and that absence is the whole design (src/main/sessionMarks.ts):
  // main stamps `Date.now()` ONCE and hands that same number to `combat.sessionMark(ts)` and to the
  // mark list, so the meter's split and the loot ledger's split share one boundary rather than two
  // a round trip apart. There is therefore nothing here to validate — a renderer cannot supply an
  // instant, so it cannot supply a bad one.
  //
  // An INVOKE rather than a send, unlike its two neighbours above: the pressing window needs the new
  // list back to select the segment it just opened, and waiting for its own broadcast to return
  // would leave the picker a frame behind the click that moved it.
  ipcMain.handle(IPC.sessionMarksGet, () => getSessionMarks())
  ipcMain.handle(IPC.sessionMarkAdd, () => pressNewSession())

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
