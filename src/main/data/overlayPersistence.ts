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
import { writeFileDurable } from '../telemetry/durableWrite'
import type { MessageOverlay } from '../../shared/types'
import {
  BASELINE_SOURCE,
  persistableSources,
  type OverlayRegister,
  type OverlaySourceCounts
} from './messageOverlay'
// Inlined committed baseline (bundled into the main build, like spells.json).
import baselineJson from './messageOverlay.baseline.json'

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

/**
 * Persist the user's register to userData (best-effort; a write error is swallowed).
 *
 * ATOMIC SINCE JOS-419, and it was the last in-place truncating write of a user-knowledge store in
 * the app. `writeFileSync` onto the live path truncates it FIRST: a process killed mid-write — an
 * update's force-quit, a full disk, the power going — left a half-written register, and
 * `loadUserSources` reads a file that will not parse as an EMPTY one. Every message this install
 * had ever learned, silently gone, with nothing on disk to say so. `writeFileDurable` is the same
 * temp+fsync+rename the telemetry ring (JOS-265), the settings store (JOS-272) and the resist
 * ledger (JOS-419) write through, so the file on disk is either the last complete register or the
 * new one and never a half of either.
 */
export function saveUserOverlay(register: OverlayRegister): void {
  const file: OverlayRegisterFile = {
    version: OVERLAY_REGISTER_VERSION,
    updatedAt: register.updatedAt,
    sources: persistableSources(register)
  }
  try {
    writeFileDurable(app.getPath('userData'), userOverlayPath(), JSON.stringify(file))
  } catch {
    // Non-fatal — the overlay is a nicety, not required state.
  }
}
