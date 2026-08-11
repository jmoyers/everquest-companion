// IPC: the MAIN WINDOW's text size (JOS-123 — shared/uiScale.ts).
//
// Two channels and one rule: the write and the visible change are the SAME call. Every other
// prefs setter in this folder either brings the session into line (the perf sampler starts) or
// says plainly that it cannot (src/main/ipc/graphics.ts — safe mode is a before-`ready` flag, an
// overlay's transparency is fixed at construction). This one can, and must: the person using it
// is choosing a size by looking at it, so a value that landed only in a file would leave them
// pressing buttons at an unchanged window.
//
// THE STARTUP HALF IS NOT HERE, deliberately. `windows.ts` reads the stored scale and hands it to
// the BrowserWindow as `webPreferences.zoomFactor`, so a launch paints at the right size instead
// of painting at 100% and then jumping. This handler owns the change; that owns the arrival.
//
// VALIDATED AT THE HANDLER, never trusted because today's only caller is the app's own UI (the
// `sounds:getData` rule) — `setUiScale` runs the value through the same `normalizeUiScale` the
// store reader and the window factory use, and returns what was actually stored, so a renderer
// cannot leave the window at a size its own control has no button for.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { getUiScale, setUiScale } from '../uiScale'
import { applyMainWindowScale } from '../windows'

export function registerUiScaleIpc(): void {
  ipcMain.handle(IPC.uiScaleGet, () => getUiScale())
  ipcMain.handle(IPC.uiScaleSet, (_e, value: unknown) => {
    const next = setUiScale(value)
    applyMainWindowScale(next)
    return next
  })
}
