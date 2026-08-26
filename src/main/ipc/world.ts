// IPC: read-only pulls off the log-derived world — the generic module transport and the combat
// engine's snapshot/search surface.
//
// ── ONE ARM (JOS-499, the deletion release) ────────────────────────────────────────────────────
//
// Each of these three used to have TWO. The app's own fold answered one of them and the ENGINE
// answered the other, and `EQC_ENGINE_SERVE` decided per call. The TS fold is deleted (owner ruling
// 12: once proven, move fully), so the branch is gone, the flag is gone, and what is left is the
// served arm each handler always had.
//
// WHAT WENT WITH THE SECOND ARM. `TsArms` — the named thunks that were the fallback, the parity
// probe's second arm and the flag-off answer all at once — has no third reader left and dies with
// the fold it read. `installShimProbe` dies with it, and so does the parity e2e that consumed it:
// a probe that compares two worlds has one world to compare.
//
// ── WHAT A HANDLER ANSWERS WHEN THE ENGINE CANNOT ─────────────────────────────────────────────
//
// This is the honest half of the release and it is worth reading before changing anything here.
// There is no fallback: an engine that is absent, still folding, or on another log means the app
// has NO ANSWER to give, and it says so rather than inventing one.
//
//   * `module:getSnapshot` answers `null`, which is what the renderer's `useModule` already reads
//     as "no state yet" and now also reads as "nothing can answer this". Views draw their
//     loading/unavailable state.
//   * `combat:snapshot` answers an EMPTY snapshot rather than null, because its renderer contract
//     is non-nullable and always has been — an empty meter is the same shape as a meter before the
//     first fight, which is exactly what an unattached engine means.
//   * `combat:searchFights` answers no hits over an empty corpus, which is the truthful answer to
//     "search a history that is not loaded".
//
// None of these is a silent lie: each is the shape the surface draws when there is nothing to show,
// and `readShim.ts` still counts and narrates every one of them into the dev log with the REASON,
// so a developer sees "the engine is still folding x12" rather than an empty tab and no idea why.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { CombatSnapshot, FightSearchResult, SnapshotOpts } from '../../shared/combat'
import {
  serveCombatSnapshot,
  serveModuleSnapshot,
  serveSearchFights,
  type ModuleSnap
} from '../dataServer/serveShim'

/**
 * `limit`, as this channel has always clamped it: a renderer bug can't ask for an unbounded payload
 * over IPC. The schema mirrors the same rule engine-side (`CombatSearchFightsParams.limit`); the
 * clamp stays here so what goes on the wire is already bounded rather than being bounded twice
 * against two different inputs.
 */
function clampLimit(limit: unknown): number | undefined {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return undefined
  return Math.min(Math.max(1, Math.floor(limit)), 500)
}

/**
 * THE EMPTY METER — what `combat:snapshot` answers when nothing can.
 *
 * WHY A SHAPE AND NOT A NULL: `CombatSnapshot` is non-nullable in the renderer's contract and every
 * meter surface dereferences it on first paint. `hydrating: true` is the honest flag — the app has
 * no answer YET — and it is precisely the state the UI already draws a quiet loading meter for
 * (`shared/combat.ts CombatSnapshot.hydrating`), so nothing here invents a fight that did not happen.
 *
 * IT IS DELIBERATELY NOT CAST, and that is the whole reason this function exists rather than an
 * object literal at the call site. The first version of it WAS a cast — `{…} as unknown as
 * CombatSnapshot` with a hand-guessed field set — and it compiled, shipped, and took the renderer
 * down with `Cannot read properties of undefined (reading 'some')` the moment a meter component
 * touched a field the guess had omitted. Every e2e spec in the suite failed on a blank window.
 * Typing it properly makes the compiler the thing that knows this shape, which is what it is for:
 * the day `CombatSnapshot` grows a required field, this is a build error rather than a black app.
 */
function emptyCombat(): CombatSnapshot {
  return {
    selectedId: '',
    selected: null,
    segments: [],
    inCombat: false,
    recent: [],
    stance: {},
    poison: { coat: { combat: [] }, slow: { pulls: 0, landed: 0, noLand: 0, window: 0 } },
    zoneSessions: [],
    // THE ONE FIELD THAT CARRIES THE MEANING. Not "there was no combat" — "nobody can say yet".
    hydrating: true,
    roster: { members: [], seen: false, lastSignalTs: 0 }
  }
}

export function registerWorldIpc(): void {
  // Generic module transport: one handler serves every registered module.
  ipcMain.handle(
    IPC.getModuleSnapshot,
    (_e, moduleId: string): Promise<ModuleSnap | null> => serveModuleSnapshot(moduleId)
  )
  ipcMain.handle(
    IPC.getCombatSnapshot,
    (_e, opts: SnapshotOpts | undefined): Promise<CombatSnapshot> =>
      serveCombatSnapshot(opts ?? {}, emptyCombat)
  )
  ipcMain.handle(
    IPC.searchFights,
    (_e, text: unknown, limit: unknown): Promise<FightSearchResult> => {
      const query = typeof text === 'string' ? text : ''
      return serveSearchFights(query, clampLimit(limit), () => ({ hits: [], corpus: 0 }))
    }
  )
}
