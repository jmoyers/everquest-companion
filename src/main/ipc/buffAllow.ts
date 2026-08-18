// IPC: the buff/debuff TRACKING ALLOW-LIST (JOS-168 — shared/buffAllow.ts).
//
// Three channels over one small preference: a read for a window that mounted after the last
// change, a PATCH that persists and fans out, and the push that carries it to the windows that
// obey it.
//
// WHY THERE IS A PUSH AT ALL, and it is the whole plumbing the ticket adds. The controls are on
// the Buffs TAB, in the main window. The surfaces they filter are the buffs and debuffs OVERLAYS,
// which are separate BrowserWindows — they cannot see the main window's memory and they cannot see
// its localStorage. Main is the only process that can reach both, so a checkbox reaches an
// already-open overlay by being broadcast from here. Without this the window would learn about a
// verdict at its next launch, which for a preference you set WHILE looking at the bars is the same
// as not learning about it.
//
// AND IT IS SENT TO EXACTLY THREE WINDOWS. The scope selection broadcasts to every kind on the
// argument that a window with no listener is cheaper than a registry; this one names its audience
// because that audience is a FACT about the preference rather than an accident — the two timer
// kinds are the only surfaces the filter runs on (`filterAllowedRows` is called nowhere else), and
// the main window is where the controls live. A third window growing a listener would mean the
// filter had grown a third surface, which is a decision, not a wiring detail.
//
// VALIDATED AT THE HANDLER, never trusted because today's only caller is the app's own UI (the
// `sounds:getData` rule). The patch runs through `applyBuffAllowPatch` — which rebuilds through
// the same normalizer the store reader uses — so a renderer, a hand-edited settings file and a
// future build cannot end up with three ideas of what a verdict is.
//
// NO no-op suppression, deliberately, unlike `setScopeSelection`: this setter already writes to
// disk on every call and the payload is one small object, so the saving would be a branch rather
// than a cost. What it would BUY is nothing either — the renderer stores adopt an identical value
// as a no-op of their own (`sameBuffAllowPrefs`), so an echo costs zero renders where it lands.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { applyBuffAllowPatch, type BuffAllowPrefs } from '../../shared/buffAllow'
import { getBuffAllowPrefs, setBuffAllowPrefs } from '../storeBuffAllow'
import { getMainWindow, getOverlayWindow } from '../windows'

/** Tell the windows that draw the filter, and the one that sets it. */
function broadcastBuffAllow(prefs: BuffAllowPrefs): void {
  const targets = [getMainWindow(), getOverlayWindow('buffs'), getOverlayWindow('debuffs')]
  for (const w of targets) {
    if (w && !w.isDestroyed()) w.webContents.send(IPC.onBuffAllow, prefs)
  }
}

export function registerBuffAllowIpc(): void {
  ipcMain.handle(IPC.buffAllowGet, () => getBuffAllowPrefs())
  ipcMain.handle(IPC.buffAllowSet, (_e, patch: unknown) => {
    const next = setBuffAllowPrefs(applyBuffAllowPatch(getBuffAllowPrefs(), patch))
    broadcastBuffAllow(next)
    return next
  })
}
