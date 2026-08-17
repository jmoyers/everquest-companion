// preload/tray.ts — the bridge for the TRAY POPOVER window (`tray.html`), and the smallest
// WRITE surface in the app: three sends, no reads, no subscriptions (JOS-139).
//
// WHY NOT REUSE `preload/index.ts` or `preload/overlay.ts`. The app bridge is the whole product
// surface and the overlay bridge can persist config, toggle click-through, close its window and
// deep-link into the app. This window draws two sentences and three buttons, and every one of
// those buttons is a decision main carries out — so what it needs is exactly three verbs and no
// way to ask a question. The same argument that made `preload/cursor.ts` a third, receive-only
// bridge rather than a share of the overlay's: a window that cannot act beyond its own three
// buttons cannot be made to.
//
// THERE IS NOTHING TO RECEIVE, either. The card's copy is compiled in and never changes, so main
// has nothing to push at it and this file has no `on*` method. The window's own lifetime (fifteen
// seconds, or a blur, or a button) is decided in main — see src/main/tray.ts.
//
// Exposed as `window.eqTray`.

import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'

const trayApi = {
  /** "Quit now." Ends the app THIS once and leaves the preference alone — somebody who quits
   *  without acknowledging is somebody who may want to read the card again. */
  quitNow: (): void => ipcRenderer.send(IPC.trayNoticeQuit),
  /** "Always quit instead." Turns the preference OFF, then quits: the next X ends the app. */
  alwaysQuit: (): void => ipcRenderer.send(IPC.trayNoticeAlwaysQuit),
  /** "Got it." The card has been read; it never appears again on this install. */
  acknowledge: (): void => ipcRenderer.send(IPC.trayNoticeAcknowledge)
}

export type EqTrayApi = typeof trayApi

contextBridge.exposeInMainWorld('eqTray', trayApi)
