// IPC: the dev-only restart button (JOS-61, rebuilt in JOS-63 — see ../devRestart.ts for the
// reasoning, and for what the electron-vite sources say about who is allowed to restart us).
//
// REGISTERED UNCONDITIONALLY, REFUSED WHEN PACKAGED. The dev-triage surface takes the other
// route (`if (!app.isPackaged && !E2E)` around the registration itself) because its module
// reaches devDependencies that are not in a shipped build at all. This one is a handful of lines
// of Electron's own API plus one `utimesSync`, so the honest shape is the reverse: one handler
// that always exists and says no in a packaged build. The refusal is then something a test can
// OBSERVE — an absent handler and a handler that declines are indistinguishable from the
// renderer, and only one of them is a decision this code made.
//
// The renderer half is stripped from production bytes independently (`DEV_TOOLS`, anchored on
// `import.meta.env.DEV`), so this is the second lock, not the only one.
//
// EVERYTHING THE DECISION READS IS PASSED IN, so the policy module stays Electron-free and
// node-testable: `app` itself as the restart host, the dev-server URL, the two candidate project
// roots, and the touch. The two roots are the two facts we have about how this process was
// started — Electron's own app path (the `.` entry electron-vite spawns) and the cwd it
// inherited from the CLI.
//
// It LOGS what it did whenever the process is not about to vanish. A 'watcher' restart takes a
// couple of seconds and looks like nothing happening; a 'refused' one looks the same and is
// permanent. The dev console says which, and names the anchor file or the reason.

import { app, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { performDevRestart, touchFile, type WatchContext } from '../devRestart'
import { logInfo } from '../errorLog'

export function registerDevIpc(): void {
  ipcMain.handle(IPC.devRestart, () => {
    const ctx: WatchContext = {
      rendererUrl: process.env.ELECTRON_RENDERER_URL,
      roots: [app.getAppPath(), process.cwd()],
      touch: touchFile
    }
    const result = performDevRestart(app, ctx)
    if (result.action !== 'relaunched') {
      logInfo(
        `[everquest-companion] dev restart: ${result.action}${result.detail === undefined ? '' : ` - ${result.detail}`}`
      )
    }
    return result
  })
}
