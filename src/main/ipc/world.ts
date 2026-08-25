// IPC: read-only pulls off the log-derived world — the generic module transport and the
// combat engine's snapshot/search surface.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { SnapshotOpts } from '../../shared/combat'
import { timeSeam } from '../perfAttribution'
import { combat, registry } from '../pipeline'

export function registerWorldIpc(): void {
  // Generic module transport: one handler serves every registered module.
  //
  // BOTH SNAPSHOT HANDLERS ARE TIMED SEAMS (JOS-458). They are synchronous work on main whose cost
  // scales with how long the session has run — a module's whole state, and the engine's — and they
  // are asked for in bursts exactly when the field reports say main stalls: a window hydrating
  // after a fold. `timeSeam` is a pass-through, so the handler's value and its throws are
  // unchanged; the search handler below is deliberately NOT timed, because it is user-initiated
  // and a person who typed into a box is not the "app froze on its own" report this hunts.
  ipcMain.handle(IPC.getModuleSnapshot, (_e, moduleId: string) =>
    timeSeam('moduleSnapshot', () => registry.snapshot(moduleId))
  )
  ipcMain.handle(IPC.getCombatSnapshot, (_e, opts: SnapshotOpts | undefined) =>
    timeSeam('combatSnapshot', () => combat.snapshot(Date.now(), opts ?? {}))
  )
  // Fight-history search (Task #61). Read-only over the engine; `limit` is clamped here so a
  // renderer bug can't ask for an unbounded payload over IPC.
  ipcMain.handle(IPC.searchFights, (_e, text: unknown, limit: unknown) =>
    combat.searchFights(
      typeof text === 'string' ? text : '',
      typeof limit === 'number' && Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 500) : undefined
    )
  )
}
