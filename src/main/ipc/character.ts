// IPC: the active character, the EQ install dir, and the per-character progress/inventory
// state that hangs off both. One domain because they are one causal chain — changing the dir
// re-lists characters, which can re-tail, which re-keys progress.

import { dialog, ipcMain } from 'electron'
import { existsSync } from 'fs'
import { IPC } from '../../shared/ipc'
import type { EqConfigResult } from '../../shared/types'
import { listCharacters, parseLogName, resolveEqDir } from '../log/config'
import { loadInventory } from '../inventory/parseInventory'
import {
  activeCharId,
  applyEqDirChange,
  buildEqConfig,
  getActiveCharacter,
  inventoryWrittenAt,
  tailCharacter
} from '../session'
import { getProgress, setEqInstallDir, setInventory, setQuestTurnIns } from '../store'
import { setItemOverride } from '../storeItemOverrides'
import { getMainWindow, sendToMain } from '../windows'

export function registerCharacterIpc(): void {
  ipcMain.handle(IPC.getCharacter, () => getActiveCharacter())
  ipcMain.handle(IPC.listCharacters, () => listCharacters())
  ipcMain.handle(IPC.setCharacter, async (_e, logPath: string) => {
    const ref = listCharacters().find((c) => c.logPath === logPath) ?? parseLogName(logPath)
    if (!ref) return { ok: false as const, error: 'Character log not found.' }
    await tailCharacter(ref)
    return { ok: true as const, character: ref }
  })

  // ---- EQ install-dir discovery + override (Settings gear) ----
  ipcMain.handle(IPC.getEqConfig, () => buildEqConfig())

  /**
   * Run one OS open-dialog and, on a pick, persist it as the override + re-scan/re-tail.
   * Cancel leaves everything untouched. Shared by the folder and file pickers because the
   * ONLY difference between them is the dialog options — what a picked path MEANS is
   * `normalizeEqDirOverride`'s job (log file, Logs folder and install root all resolve to
   * the same pair), so both buttons can hand it whatever the user chose.
   */
  const pickInto = async (opts: Electron.OpenDialogOptions): Promise<EqConfigResult> => {
    // Parent the dialog to the main window (modal) when we have one.
    const mainWindow = getMainWindow()
    const res = mainWindow
      ? await dialog.showOpenDialog(mainWindow, opts)
      : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) {
      return { ok: false as const, config: buildEqConfig() }
    }
    setEqInstallDir(res.filePaths[0])
    return { ok: true as const, config: await applyEqDirChange() }
  }

  // The folder picker, rooted at the current effective dir.
  ipcMain.handle(IPC.pickEqDir, () => {
    const current = resolveEqDir()
    return pickInto({
      title: 'Select your EverQuest Legends install folder',
      defaultPath: existsSync(current.root) ? current.root : undefined,
      properties: ['openDirectory']
    })
  })

  /**
   * THE FILE PICKER (JOS-82) — the affordance the folder button structurally cannot be.
   *
   * Windows' folder dialog is `IFileOpenDialog` + `FOS_PICKFOLDERS`, which lists ONLY
   * containers. A real EQ Legends `Logs` folder holds character logs and no subdirectories
   * at all (measured: 6 files, 0 dirs), so a user who navigates into it looking for the file
   * the app keeps naming — `eqlog_*.txt` — is shown an EMPTY pane while Explorer shows the
   * files. That is report 01M0Q… on 0.10.0, near-verbatim. openFile and openDirectory cannot
   * be combined on Windows (Electron shows the directory selector), so the honest fix is a
   * SECOND dialog rather than a cleverer single one.
   *
   * It opens on the resolved LOGS dir, not the root: that is the folder the files are in, so
   * the picker lands where the user was already looking.
   */
  ipcMain.handle(IPC.pickEqLogFile, () => {
    const current = resolveEqDir()
    const start = existsSync(current.logsDir) ? current.logsDir : current.root
    return pickInto({
      title: 'Select one of your EverQuest character logs',
      defaultPath: existsSync(start) ? start : undefined,
      filters: [
        { name: 'EverQuest character log', extensions: ['txt'] },
        { name: 'All files', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
  })
  // Set the override to an explicit dir (undefined/'' ⇒ revert to auto-detect).
  ipcMain.handle(IPC.setEqDir, async (_e, dir: string | undefined) => {
    setEqInstallDir(dir)
    return applyEqDirChange()
  })
  // Clear the override → auto-discovery.
  ipcMain.handle(IPC.resetEqDir, async () => {
    setEqInstallDir(undefined)
    return applyEqDirChange()
  })
  ipcMain.handle(IPC.getProgress, () => getProgress(activeCharId()))
  ipcMain.handle(IPC.reloadInventory, () => {
    const active = getActiveCharacter()
    const res = loadInventory(active?.name, active?.server, inventoryWrittenAt)
    if (!res) return { ok: false as const, error: 'No *-Inventory.txt found in the EQ folder.' }
    setInventory(activeCharId(), res.counts, res.source)
    const progress = getProgress(activeCharId())
    // A MANUAL RE-READ IS THE SAME NEWS AS AN AUTOMATIC ONE (JOS-431). This pushed `progress` and
    // nothing else, so the surfaces that read the FILE's own status — the `/outputfile` freshness
    // line, which re-asks the registry on `inventory:reload` and on nothing else — kept showing
    // the age they had before the click. That is the reported symptom (a stale timestamp) wearing
    // the fix's own clothes, so both pushes go out here exactly as `loadInventoryNow` sends them.
    sendToMain(IPC.onInventoryReload, { path: res.path, loadedAt: res.loadedAt })
    // Keep other views consistent (Plane of Sky derives held-item counts too).
    sendToMain(IPC.onProgress, progress)
    return { ok: true as const, path: res.path, loadedAt: res.loadedAt, progress }
  })
  ipcMain.handle(IPC.setQuestTurnIns, (_e, questKey: string, instants: number[]) => {
    const progress = setQuestTurnIns(activeCharId(), questKey, instants)
    // Push so a turn-in recorded in one view (or detected from the log) reaches every other
    // view without a refetch race.
    sendToMain(IPC.onProgress, progress)
    return progress
  })
  // ONE item's held count, stated (or taken back) by hand — JOS-186. Pushed like every other
  // progress write, because the Loot ledger and the Sky tab read the same corrected number.
  ipcMain.handle(
    IPC.setItemOverride,
    (_e, key: string, name: string, count: number | null) => {
      const progress = setItemOverride(activeCharId(), key, name, count)
      sendToMain(IPC.onProgress, progress)
      return progress
    }
  )
}
