// preload/uiScale.ts — the main window's text size, on the app bridge (JOS-123).
//
// Its own module, spread into `api` in index.ts, for the same reason `./perf.ts` and
// `./graphics.ts` are: that file is at the repo's 400-code-line factoring ceiling and the answer
// to that is a split, not a widened threshold. On `window.eq` these two methods are
// indistinguishable from the ones written out there.
//
// NO `webFrame` HERE, and that is the design rather than an omission. A preload could zoom its own
// frame directly, but then the size would live in the renderer's hands and the window would still
// paint at 100% first on every launch — main sets `webPreferences.zoomFactor` at construction and
// owns the change, so there is exactly one thing that decides how big this window is.

import { ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'

export const uiScaleBridge = {
  /** The persisted zoom factor for this window. 1 on every install that never chose one. */
  getUiScale: (): Promise<number> => ipcRenderer.invoke(IPC.uiScaleGet),
  /**
   * Choose a size. Applies to the live window in the same call and resolves to what was ACTUALLY
   * stored — snapped to the ladder in `shared/uiScale.ts`, so a caller can render the answer
   * rather than assume its request.
   */
  setUiScale: (scale: number): Promise<number> => ipcRenderer.invoke(IPC.uiScaleSet, scale)
}
