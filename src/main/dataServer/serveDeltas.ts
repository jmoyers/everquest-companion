// ============================================================================
// serveDeltas.ts — THE DELTA ARM (JOS-493, phase 2 of the cutover).
// ============================================================================
//
// `serveShim.ts` moved the app's READS onto the engine. This file moves the half a read cannot
// carry: the NOTIFICATION that there is something newer to read. Without it the cutover is not
// half-done, it is BROKEN, and JOS-490 measured exactly how.
//
// ── THE DEFECT THIS FILE EXISTS FOR, MEASURED ──────────────────────────────────────────────────
//
// `useModule` hydrates from `module:getSnapshot` and remembers the seq it got, then rides
// `module:delta` and drops anything at or below that seq as a dupe. With `EQC_ENGINE_SERVE=1` the
// two halves stopped being one world: the snapshot came out of the ENGINE (its own revision
// counter) and the deltas kept coming out of this process's fold (a LogEvent seq, or a module's own
// private revision). MEASURED on a respawn watch: engine seq 4, app seq 3 — so every delta the app
// pushed was dropped as already-covered and the surface simply stopped moving. It is STRUCTURAL for
// the four modules that publish a private revision counter (combo, character, respawn, buffTimers),
// where the two numbers are unrelated by construction, and a coincidence away from being structural
// for the rest.
//
// ── THE FIX: ONE WORLD, ONE NUMBERING SPACE ────────────────────────────────────────────────────
//
// A folder rides exactly ONE channel, and WHICH ONE is stated by the snapshot it is holding rather
// than by a flag it would have to be told about:
//
//   * `ModuleSnapshot.served === true` — the ENGINE answered. The folder ignores `module:delta`
//     entirely and re-fetches when this file forwards a cursor of the engine's.
//   * `served` absent — this process's own fold answered, exactly as in every launch before the
//     flag existed. The folder rides `module:delta` and ignores this channel.
//
// So the two worlds are never mixed, and neither renderer hook has to know a flag exists.
//
// ── WHY THE TS DELTAS STILL GO OUT ─────────────────────────────────────────────────────────────
//
// The ticket's words were "TS-fold deltas are SUPPRESSED to renderers under serve", and suppressing
// them AT THE WIRE was the first thing tried. It is wrong, and the reason is that two consumers read
// a `module:delta` as an EVENT rather than as state:
//
//   * `features/alerts/player.tsx` plays the SOUND off `delta.fired`. `EQC_ENGINE_ALERTS=1`
//     (JOS-491) is what moves the sound to the engine's `fire` frames, and it is a SEPARATE flag
//     that is off by default — so a wire-level suppression under `EQC_ENGINE_SERVE=1` alone makes
//     the app silent. The owner is the regression test for this whole program; a silent alert is
//     not a cosmetic difference.
//   * `App.tsx` lights the live dot on any delta at all.
//
// Neither HOLDS a snapshot, so neither has the numbering-space problem — the defect belongs to the
// folders, and that is where it is fixed. The TS fold keeps running regardless (the parity probe
// compares it every rebuild), so the deltas cost nothing that was not already being spent.
//
// ── THE GATE, AND WHY IT IS ONE `process.env` READ HERE ─────────────────────────────────────────
//
// `serveShim.ts` spells the gate `engineEnabled() && engineFlagOn(EQC_ENGINE_SERVE)` and this file
// spells only the second half — deliberately, and it is not a second gate. Every function below is
// reached from ONE place, `engineClientHost.ts`, which exists only because `engineHost.ts` called
// `installEngineClient` from inside its own `EQC_ENGINE` guard. The first half of the gate is
// therefore structural: with no engine there is no client, with no client there is no
// `moduleChanged` frame, and nothing here is ever called. Importing `engineEnabled()` to say it
// again would buy a module-evaluation CYCLE for a boolean that is already true —
// engineHost → engineClientHost → here → engineHost, with a top-level call in the middle of it.
//
// IT INVERTS WITH THE SHIM, AND IT HAS TO (JOS-495). The two halves of the read path are one
// feature described by one flag: a launch whose SNAPSHOTS come from the engine and whose CURSORS
// were still suppressed is the exact defect this file was written to fix (see above — engine seq 4
// against app seq 3, and every surface frozen). So when the serve default flipped to ON, a gate
// here still reading `=== '1'` would have shipped that defect to every ordinary launch. The
// comparison is `engineFlagOn` for that reason: one predicate, five readers, no chance to invert
// four of them (`shared/dataServer/engineFlags.ts`).
//
// ── AND IT IMPORTS THE PIPELINE, WHICH `serveShim.ts` REFUSES TO ───────────────────────────────
//
// That refusal is about the READ path: `world.ts` hands the shim its TS arm so the fold stays
// visible at the call site the cutover deletes. This is a PUSH path and there is no call site to
// keep honest — the fan-out to the module-reading overlays is `pipeline.ts`'s own list and has been
// since JOS-172, and a second copy of that list is precisely how the overlays came to be missing
// from a fan-out once already.

import { engineFlagOn } from '../../shared/dataServer/engineFlags'
import { IPC } from '../../shared/ipc'
import { MODULE_WORLD_CHANGED, type ModuleChanged } from '../../shared/types'
import { sendToModuleOverlays } from '../pipeline'
import { sendToMain } from '../windows'

/** See the header: the second half of a gate whose first half is structural, and ON by default. */
const SERVE_ASKED = engineFlagOn(process.env.EQC_ENGINE_SERVE)

/** Every window that folds a module — the main window and `pipeline.ts`'s own overlay list. */
function push(frame: ModuleChanged): void {
  sendToMain(IPC.onModuleChanged, frame)
  sendToModuleOverlays(IPC.onModuleChanged, frame)
}

/**
 * ONE MODULE'S CURSOR MOVED, as the engine reported it.
 *
 * COALESCED ALREADY, by the engine: the protocol guarantees at most one frame per module per serve
 * beat (~10 Hz) and nothing at all for a module whose seq did not move, so an idle session costs
 * nothing and a busy tail costs one small frame per module per beat. This file adds no throttle of
 * its own — a second one would only be able to make the cursor STALER than the engine already
 * decided it should be.
 */
export function pushModuleChanged(moduleId: string, seq: number): void {
  if (!SERVE_ASKED) return
  push({ moduleId, seq })
}

/**
 * "THE WORLD THAT ANSWERS YOUR READS CHANGED" — the two edges a cursor cannot describe.
 *
 * THE ENGINE WENT LIVE. Windows that hydrated during the fold hold this process's own state and are
 * riding its deltas, which is correct and self-consistent — but the shim has just started serving,
 * so the next thing they ask for comes from the other world. Saying so makes them take it at once
 * rather than at whatever unrelated moment happens to re-hydrate them next.
 *
 * THE ENGINE WENT AWAY. This is the one that would otherwise be a FREEZE: a window holding a served
 * snapshot is ignoring `module:delta` BECAUSE it is being served, so an engine that dies leaves it
 * with no channel at all until the next character rebuild. One frame puts it back on the app's own
 * fold, where the shim's fallback has already put its reads.
 */
export function pushWorldChanged(): void {
  if (!SERVE_ASKED) return
  push({ moduleId: MODULE_WORLD_CHANGED, seq: -1 })
}
