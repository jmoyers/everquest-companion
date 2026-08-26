// Observed-message-overlay persistence (Task #36; re-shaped by JOS-231).
//
// The overlay has TWO on-disk sources, merged at startup (both feed the miner additively):
//   1. the COMMITTED BASELINE — messageOverlay.baseline.json, generated from the full log by
//      scripts/gen-message-overlay.ts and imported (so electron-vite INLINES it into the main
//      bundle, exactly like spells.json — a path-relative read would miss it in prod). Ships
//      with the app so a fresh install starts warm.
//   2. the USER REGISTER — <userData>/message-overlay.json, what THIS user's logs have taught
//      us since install. Written debounced by session.ts + at teardown, loaded here on startup.
//
// THE USER FILE IS A REGISTER, NOT A SNAPSHOT (JOS-231, version 2). It used to be one flat
// `MessageOverlay` — the served view, counts and verdicts together — and seeding the next
// launch's miner with it fed the fold its own previous output: the app re-mines the whole log
// every launch, so every count the log accounts for doubled per launch (MEASURED 22 -> 44 -> 88).
// The file now stores counts PER SOURCE (`sources: [{ key, messages }]`, key = the character id
// whose log produced them), so re-folding a log REPLACES that log's bucket instead of adding to
// it. Verdicts and stats are not stored at all: they are derived from the summed counts, and a
// stored verdict is a second opinion waiting to disagree with the first.
//
// The committed baseline is filed under its own key and deliberately NOT written back — it is
// re-seeded from the bundle on every launch, and copying 400 kB of it into userData would only
// create a second, staler copy.
//
// A version mismatch (including every v1 file in the field, whose counts carry exactly the
// inflation this fixes) is ignored — the baseline still seeds, and the active character's log
// re-mines itself honestly on the next fold, which is the whole of what a v1 file could have
// said about it. What a v1 file cannot be salvaged for is another character's bucket: those
// counts are unattributable, which is the defect, not a loss the migration caused.

import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileDurableAsync, writeFileDurableFinal } from '../telemetry/durableWrite'
import type { MessageOverlay } from '../../shared/types'
import {
  BASELINE_SOURCE,
  persistableSources,
  type OverlayRegister,
  type OverlaySourceCounts
} from './messageOverlay'
// Inlined committed baseline (bundled into the main build, like spells.json).
import baselineJson from './messageOverlay.baseline.json'
import { appOwnsArtifacts } from '../dataServer/artifactOwner'

/** Register schema version — bump to invalidate a stale on-disk register. */
export const OVERLAY_REGISTER_VERSION = 2

/** The persisted file: the register plus its schema version. */
interface OverlayRegisterFile extends OverlayRegister {
  version: number
}

/** The committed baseline overlay (typed). */
export function baselineOverlay(): MessageOverlay {
  return baselineJson as unknown as MessageOverlay
}

/** Path of the user's persisted overlay register in userData. */
function userOverlayPath(): string {
  return join(app.getPath('userData'), 'message-overlay.json')
}

/** Load the user's persisted buckets, or [] when absent / stale-version / unreadable. */
export function loadUserSources(): OverlaySourceCounts[] {
  try {
    const txt = readFileSync(userOverlayPath(), 'utf8')
    const file = JSON.parse(txt) as OverlayRegisterFile
    if (file?.version !== OVERLAY_REGISTER_VERSION || !Array.isArray(file.sources)) return []
    return file.sources.filter((s) => s.key !== BASELINE_SOURCE && Array.isArray(s.messages))
  } catch {
    return []
  }
}

// PERSIST THE USER'S REGISTER — atomically since JOS-419, and off the main thread since JOS-371.
//
// ATOMIC SINCE JOS-419, and it was the last in-place truncating write of a user-knowledge store in
// the app. A `writeFileSync` onto the live path truncates it FIRST: a process killed mid-write — an
// update's force-quit, a full disk, the power going — left a half-written register, and
// `loadUserSources` reads a file that will not parse as an EMPTY one. Every message this install had
// ever learned, silently gone, with nothing on disk to say so. The durable write is the same
// temp+fsync+rename the telemetry ring (JOS-265), the settings store (JOS-272) and the resist ledger
// (JOS-419) go through, so the file is either the last complete register or the new one and never a
// half of either.
//
// AND OFF THE THREAD SINCE JOS-371. It was synchronous only because `writeFileDurable` was, and what
// that meant in practice is that every sixty seconds — session.ts's tick, for the whole time the app
// is open — the main process stopped to write a file AND fsync it. While one of this app's overlays
// holds the mouse, a main-thread stall is a system-wide one, and an fsync is exactly the syscall
// that goes from microseconds to milliseconds on a busy volume. The atomicity argument above is
// untouched: same steps, same order, `writeFileDurableAsync`.
//
// WHAT ASYNC COSTS, and how it is paid: two writes can now overlap, and two overlapping writes would
// share one `.tmp` path. `writing` is the latch on the periodic saver — a save arriving while one is
// in flight is dropped rather than queued, which costs at most one 60-second window of a register
// that only ever accretes, and the next tick writes the superset. The QUIT FINAL cannot be dropped
// that way, so it writes through its own scratch file instead (`writeFileDurableFinal`).

/** True while a durable write is in libuv's threadpool. See the note above: one at a time. */
let writing = false

/** The file this register serialises to. One spelling, so the async saver and the quit final can
 *  never write two different shapes of the same document. */
function overlayFile(register: OverlayRegister): string {
  const file: OverlayRegisterFile = {
    version: OVERLAY_REGISTER_VERSION,
    updatedAt: register.updatedAt,
    sources: persistableSources(register)
  }
  return JSON.stringify(file)
}

/**
 * The debounced periodic save.
 *
 * THE FIRST GUARD IS OWNERSHIP (JOS-497 item 2, boundary verdict 4) and it comes before the
 * in-flight latch because it is a different kind of question: `writing` asks whether THIS process is
 * mid-write, and `appOwnsArtifacts()` asks whether this process writes this file at all on this
 * launch. Under serve the engine has been handed `stateDir` and owns `message-overlay.json`,
 * reading and writing it in this app's byte-verbatim format on its own cadence; a second writer
 * here would be the two-processes-one-file hazard JOS-496 named and declined to ship. See
 * `dataServer/artifactOwner.ts` for the latch, the boot ordering, and why the predicate is a live
 * connection rather than a flag.
 */
export function saveUserOverlay(register: OverlayRegister): void {
  if (!appOwnsArtifacts()) return
  if (writing) return
  writing = true
  const data = overlayFile(register)
  void writeFileDurableAsync(app.getPath('userData'), userOverlayPath(), data)
    .catch(() => {
      // Non-fatal — the overlay is a nicety, not required state.
    })
    .finally(() => {
      writing = false
    })
}

/**
 * THE QUIT FINAL (JOS-371) — the documented synchronous survivor, called from `window-all-closed`
 * so the final session's observations are not lost between debounced saves. That teardown step
 * already existed and was already the last save of a run; all that changed is that it is now the
 * only one that blocks.
 *
 * IT WRITES THROUGH ITS OWN SCRATCH FILE, for the reason the telemetry ring's final does: sharing
 * one `.tmp` with a write that is still in the threadpool is two writers filling one scratch file
 * with one of them renaming mid-fill — a torn register, which is the exact failure temp+fsync+rename
 * exists to prevent. With two scratch paths, whichever rename lands last publishes a COMPLETE
 * register; at quit the process almost always goes before the threadpool write returns, so the
 * final's own bytes are the ones that survive.
 */
export function saveUserOverlaySync(register: OverlayRegister): void {
  // THE QUIT FINAL IS STILL A WRITE, so it asks the same ownership question the periodic saver does
  // (JOS-497 item 2). A launch that handed this file to the engine must not, on its way out,
  // publish its own register over the one the owner has been maintaining — which would be the app
  // getting the LAST word about a file it does not own, at the one moment nothing is left to
  // correct it.
  if (!appOwnsArtifacts()) return
  const path = userOverlayPath()
  try {
    writeFileDurableFinal(app.getPath('userData'), path, overlayFile(register))
  } catch {
    // Non-fatal — the overlay is a nicety, not required state.
  }
}
