// IPC: read-only pulls off the log-derived world — the generic module transport and the
// combat engine's snapshot/search surface.
//
// SINCE JOS-489 EACH OF THE THREE HAS TWO ARMS. The app's own fold is one of them and is written
// out below exactly as it always was; the other asks the ENGINE the same question over the data
// server, behind `EQC_ENGINE_SERVE=1` (`src/main/dataServer/serveShim.ts`, which owns the flag, the
// fallback and the coalesced narration). The flag decides PER CALL, and with it off the expression
// each handler returns is the one it has returned since the channel existed — one boolean read in
// front of it and nothing else, no promise where there was a value, no allocation, no engine in the
// module graph's way.
//
// THE TS ARM IS A NAMED THUNK RATHER THAN AN INLINE ELSE-BRANCH, and that is the point of the
// shape: it is handed to the shim as the fallback, handed to the harness seam as the second arm of
// the parity comparison, and read here as the flag-off answer — three readers, one definition, so
// the two worlds can never be given different questions to answer. It is also what the cutover
// deletes: when the engine is the only fold, these three thunks and their imports go and the
// handlers keep their served arm.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { CombatSnapshot, FightSearchResult, SnapshotOpts } from '../../shared/combat'
import { timeSeam } from '../perfAttribution'
import { combat, registry } from '../pipeline'
import {
  installShimProbe,
  serveCombatSnapshot,
  serveModuleSnapshot,
  serveSearchFights,
  shimServing,
  type ModuleSnap,
  type TsArms
} from '../dataServer/serveShim'

/**
 * `limit`, as this channel has always clamped it: a renderer bug can't ask for an unbounded payload
 * over IPC. It is applied BEFORE the arm is chosen rather than inside either one, so both worlds
 * are asked for the same number of hits — the schema mirrors the same rule engine-side
 * (`CombatSearchFightsParams.limit`), and two clamps applied to two different inputs would be a
 * divergence this shim manufactured itself.
 */
function clampLimit(limit: unknown): number | undefined {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return undefined
  return Math.min(Math.max(1, Math.floor(limit)), 500)
}

export function registerWorldIpc(): void {
  // THE APP'S OWN FOLD, all three questions. See the header for why they are named.
  //
  // BOTH SNAPSHOT ARMS ARE TIMED SEAMS (JOS-458). They are synchronous work on main whose cost
  // scales with how long the session has run — a module's whole state, and the engine's — and they
  // are asked for in bursts exactly when the field reports say main stalls: a window hydrating
  // after a fold. `timeSeam` is a pass-through, so the handler's value and its throws are
  // unchanged; the search arm below is deliberately NOT timed, because it is user-initiated and a
  // person who typed into a box is not the "app froze on its own" report this hunts.
  //
  // THE SEAM STAYS ON THE TS ARM ONLY, and deliberately: it measures how long THIS PROCESS blocks,
  // and a served answer does not block it at all. Timing the engine arm through it would put a
  // network round trip into a histogram whose whole subject is main-thread stalls.
  const arms: TsArms = {
    module: (moduleId) => timeSeam('moduleSnapshot', () => registry.snapshot(moduleId)),
    combat: (opts) => timeSeam('combatSnapshot', () => combat.snapshot(Date.now(), opts)),
    // Fight-history search (Task #61). Read-only over the engine.
    search: (text, limit) => combat.searchFights(text, limit)
  }

  // Generic module transport: one handler serves every registered module.
  ipcMain.handle(
    IPC.getModuleSnapshot,
    (_e, moduleId: string): Promise<ModuleSnap | null> | ModuleSnap | null => {
      const own = (): ModuleSnap | null => arms.module(moduleId)
      return shimServing() ? serveModuleSnapshot(moduleId, own) : own()
    }
  )
  ipcMain.handle(
    IPC.getCombatSnapshot,
    (_e, opts: SnapshotOpts | undefined): Promise<CombatSnapshot> | CombatSnapshot => {
      const own = (): CombatSnapshot => arms.combat(opts ?? {})
      return shimServing() ? serveCombatSnapshot(opts ?? {}, own) : own()
    }
  )
  ipcMain.handle(
    IPC.searchFights,
    (_e, text: unknown, limit: unknown): Promise<FightSearchResult> | FightSearchResult => {
      const query = typeof text === 'string' ? text : ''
      const capped = clampLimit(limit)
      const own = (): FightSearchResult => arms.search(query, capped)
      return shimServing() ? serveSearchFights(query, capped, own) : own()
    }
  )

  // THE PARITY SEAM (`EQ_E2E=1` and the serve flag; a no-op otherwise). It is installed with the
  // very thunks above, so what the harness compares the engine against is the same TS arm the
  // product would have fallen back to — not a second read of the fold spelled somewhere else.
  installShimProbe(arms)
}
