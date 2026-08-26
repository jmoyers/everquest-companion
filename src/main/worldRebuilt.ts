// ============================================================================
// worldRebuilt.ts — "the world for this character was rebuilt", and who is told (JOS-499 item 3).
// ============================================================================
//
// This is `pipeline.ts`'s cross-cutting half, lifted out ahead of that file's deletion. Every line
// below was written there and every line of reasoning is that file's; what changed is only that its
// readers outlive it. `index.ts`, `session.ts`, `serveDeltas.ts` and `engineClientHost.ts` all need
// the rebuild fan-out, and none of them needs a fold.
//
// IT IS A LEAF, and deliberately so: it imports the window registry, the IPC names and the perf
// seam, and NOTHING that folds a log. That is what lets `serveDeltas.ts` — which pushes the
// ENGINE's cursors to the same windows — reach it without importing a fold, which was the shape of
// the old dependency and would have been a cycle the moment the fold's own construction moved.
//
// ── THE PROPERTY WORTH PRESERVING: ONE ANSWER TO "WHO IS TOLD" ─────────────────────────────────
//
// JOS-172's whole finding was that there used to be SEVERAL call sites, and the overlays were
// missing from some of them. `sendWorldRebuilt` is the one answer, and moving it must not
// re-open that: every `IPC.onCharacter` send in this process still goes through here.

import { IPC } from '../shared/ipc'
// A leaf (see its header) — it starts at `replayDone` and is imported here only to bracket the
// rebuild fan-out below.
import { timeSeam } from './perfAttribution'
import { getOverlayWindow, sendToMain } from './windows'
import type { CharacterRef, OverlayKind } from '../shared/types'

/** The overlay kinds that consume the generic module transport — see the fan-out below. */
// 'xp' (JOS-195) reads TWO of them — `progression` for the pace and the projection, `loot` for
// the mote rates — and needs the rebuild signal below at least as much as the timer windows do:
// its whole subject is a fold over months of log, and a window open at launch hydrates part-way
// through one.
export const MODULE_READING_OVERLAYS: OverlayKind[] = ['events', 'buffs', 'debuffs', 'xp', 'respawn']

/**
 * Push to every overlay window that reads modules.
 *
 * An overlay window that reads a module needs BOTH halves of the transport the main window has
 * always had: the increments, and the "throw it all away and ask again" signal. It had only the
 * first, which is invisible until the moment the two disagree — a COLD START with an overlay
 * already open. The window is created while the historical fold is running (index.ts restores
 * overlays in the same `whenReady` turn that kicked off `startTailing`), so it hydrates from a
 * snapshot taken at a random instant part-way through months of log, and no later increment ever
 * describes the rest of it. A charm or an Ensnare that genuinely survived the fold was in the
 * model, in the main window, and missing from the overlay until the next live event happened to
 * touch that module.
 *
 * THE DELIVERY IS THE FIX, NOT THE DISCARD — JOS-172's rule, and it survives the fold that
 * occasioned it. Under the engine the increments are the engine's CURSORS rather than this
 * process's deltas (`dataServer/serveDeltas.ts` is the caller now), and the argument is unchanged:
 * a cursor is a dirty bit and a rebuild is "everything you hold is from another world".
 *
 * The fan-out stays an explicit per-kind list rather than a broadcast over OVERLAY_KINDS: an
 * overlay that reads no module has no business being woken ~10x/second, and a new kind that DOES
 * read one should have to say so here.
 */
export function sendToModuleOverlays(channel: string, ...args: unknown[]): void {
  for (const kind of MODULE_READING_OVERLAYS) {
    const w = getOverlayWindow(kind)
    if (w && !w.isDestroyed()) w.webContents.send(channel, ...args)
  }
}

/**
 * "The world for this character was rebuilt — re-hydrate." ONE call, every window that folds a
 * module: the main window and the module-reading overlays.
 *
 * Every `log:character` send in this process goes through here, so "who is told the world was
 * rebuilt" is answered in one place rather than at each call site — which is precisely how the
 * overlays came to be missing from it (JOS-172).
 *
 * A TIMED SEAM (JOS-458). It fires in the minute after a fold and its cost is a FAN-OUT: one
 * `webContents.send` per open module-reading window, each of which serializes the payload and
 * wakes a renderer that immediately asks for a full snapshot back. The bracket covers OUR half
 * (the sends), never the renderers' work, so a large number here is main's own bill and nobody
 * else's.
 */
export function sendWorldRebuilt(character: CharacterRef | null): void {
  timeSeam('worldRebuilt', () => {
    sendToMain(IPC.onCharacter, character)
    sendToModuleOverlays(IPC.onCharacter, character)
  })
  // …AND ANYTHING IN-PROCESS THAT NEEDS THE SAME NEWS (JOS-479). See `setWorldRebuiltObserver`.
  worldRebuiltObserver?.(character)
}

/**
 * ONE IN-PROCESS LISTENER FOR "the world for this character was rebuilt" (JOS-479).
 *
 * `sendWorldRebuilt` is already the ONE answer to "who is told" for every WINDOW; the data-server
 * client needs the identical news for a different reason — it is the character-switch funnel, so it
 * is where a re-attach belongs. Hooking it here rather than adding a second call site in session.ts
 * is the whole point: the reason the overlays were once missing from this fan-out is that there
 * used to be several call sites.
 *
 * A REGISTRATION RATHER THAN AN IMPORT, and that is a dependency decision rather than a style one.
 * THE DIRECTION IS PRESERVED THROUGH THE MOVE, which is the part of item 3 worth stating: the old
 * argument was that `engineClientHost.ts` reads `registry` out of `pipeline.ts`, so an import the
 * other way would be a cycle at module-evaluation time. That particular cycle dies with the
 * registry — but the registration stays, because the property it buys is bigger than the cycle it
 * avoided. `engineHost.ts` composes this feature and fills the slot; a launch that never composes
 * one finds a null and pays one comparison per rebuild. An import here would make this leaf drag
 * the whole supervisor and its child-process plumbing into anything that announces a rebuild.
 *
 * IT RUNS OUTSIDE THE `timeSeam` BRACKET on purpose. That bracket measures OUR half of the
 * rebuild fan-out — the `webContents.send`s — and folding a dev-only probe into the same
 * measurement would put an instrument's cost inside the number the instrument reports.
 */
let worldRebuiltObserver: ((character: CharacterRef | null) => void) | null = null

export function setWorldRebuiltObserver(fn: ((character: CharacterRef | null) => void) | null): void {
  worldRebuiltObserver = fn
}
