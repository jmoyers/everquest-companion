// telemetry/ring.ts — `<userData>/telemetry.json`, the local event ring.
//
// TWO HALVES, split for the same reason `storeMigrations.ts` splits its runner from its file
// I/O: the RING ITSELF is pure and node-testable (`pushCapped`, `parseRingFile`), and the file
// half is a thin, Electron-dependent shell over it.
//
// WHY NOT electron-store (a decision, not an oversight — the same one feedback/state.ts made):
// the store-migration law exists so the SETTINGS file written by any past build loads in
// today's build, indefinitely. Buffered telemetry is disposable by design — the whole feature
// is "counts we would like to have" — and paying the migration tax for it would be wrong twice
// over. So: its own file, its own tiny `version` integer, corrupt ⇒ start from empty.
//
// The user's PREFERENCES (enabled / noticeShown / analyticsId) do live in the settings store,
// behind schema migration 5 → 6, because those are not disposable: forgetting that a user
// turned analytics off would be the worst bug this feature could have.
//
// Everything resolves through `app.getPath('userData')`, so channel.ts's decision redirects it
// automatically: the dev app, the installed app and an e2e run can never share a ring.
//
// THE FILE HALF IS ITSELF SPLIT NOW (JOS-265), for the third time and the same reason: the
// DURABILITY of the write — temp, flush, rename, clean up, and back off when the volume is full —
// lives in `./durableWrite.ts`, which imports `node:fs` and nothing else and is therefore
// node-testable. What is left here is only what needs `app` or the logger.

import { app } from 'electron'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  TELEMETRY_BUFFER_CAP,
  type TelemetryBatch,
  type TelemetryRecord
} from '../../shared/telemetry'
import { validateRecord } from '../../shared/telemetryValidate'
import { logError, logInfo } from '../errorLog'
// The durability half, in its own Electron-free leaf (JOS-265). Its header carries the whole
// argument — the error store's ENOSPC exemplars, why there is no writer queue and no lock retry,
// and what the fsync is for. This file keeps only the decisions that need `app` or a logger.
import {
  createWriteGate,
  FINAL_TEMP_TAG,
  tempPathFor,
  writeFileDurableAsync,
  writeFileDurableFinal
} from './durableWrite'

/** Bumped only if this file's shape changes. Unreadable/older ⇒ start empty, never migrate. */
export const TELEMETRY_RING_VERSION = 1

const RING_FILE = 'telemetry.json'

export interface TelemetryRing {
  version: number
  /** Oldest first. At most `TELEMETRY_BUFFER_CAP`; the oldest is dropped, never the newest. */
  events: TelemetryRecord[]
  /**
   * The last batch this install actually SENT — written only after the server accepted it
   * (flush.ts `retireBatch`), and kept so Preferences can show it verbatim (T4). Null until the
   * first accepted batch, and the pane says which of the two silences that is.
   */
  lastBatch: TelemetryBatch | null
}

export function emptyRing(): TelemetryRing {
  return { version: TELEMETRY_RING_VERSION, events: [], lastBatch: null }
}

/**
 * Append with the cap applied — THE ring's whole behavior, as a pure function.
 *
 * A full ring drops the OLDEST record. That is the honest choice for a counter feed: the
 * newest events describe the session someone is actually having, and refusing to record
 * anything once 500 have piled up would silently stop measuring exactly the long sessions
 * most worth measuring. Never mutates its input.
 */
export function pushCapped(
  events: readonly TelemetryRecord[],
  next: TelemetryRecord,
  cap = TELEMETRY_BUFFER_CAP
): TelemetryRecord[] {
  if (cap <= 0) return []
  const out = [...events, next]
  return out.length <= cap ? out : out.slice(out.length - cap)
}

/**
 * Shape check, not a migration: anything unexpected means "start fresh". Individual records are
 * re-validated through the SHARED validator, so a hand-edited file cannot smuggle a field the
 * schema does not have into a batch — the ring is an input like any other.
 */
export function parseRingFile(raw: unknown): TelemetryRing | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.version !== TELEMETRY_RING_VERSION) return null
  if (!Array.isArray(o.events)) return null
  const events: TelemetryRecord[] = []
  for (const entry of o.events) {
    const rec = validateRecord(entry)
    if (rec.ok) events.push(rec.value)
  }
  return {
    version: TELEMETRY_RING_VERSION,
    events: events.slice(Math.max(0, events.length - TELEMETRY_BUFFER_CAP)),
    // The last-sent batch is display-only; a malformed one is simply forgotten.
    lastBatch: null
  }
}

// ------------------------------------------------------------------ the file half

function ringPath(): string {
  return join(app.getPath('userData'), RING_FILE)
}

let cached: TelemetryRing | null = null

/**
 * THE ONE WRITER'S FAILURE STATE (JOS-265). Module-level because there is exactly one ring file
 * and exactly one process writing it — the same reason `cached` is module-level.
 */
const writeGate = createWriteGate()

/** Read (and memoize) the ring. Missing or corrupt ⇒ empty, and nothing is written until the
 *  first record arrives — a user who turned analytics off never grows the file at all. */
export function readRing(): TelemetryRing {
  if (cached) return cached
  const path = ringPath()
  if (existsSync(path)) {
    try {
      const parsed = parseRingFile(JSON.parse(readFileSync(path, 'utf8')) as unknown)
      if (parsed) {
        cached = parsed
        return cached
      }
      logInfo('[everquest-companion] telemetry.json unreadable/foreign - starting from empty')
    } catch (err) {
      logError('main:telemetryRing', { message: 'telemetry.json parse failed; starting empty', err })
    }
  }
  cached = emptyRing()
  return cached
}

/**
 * THE ONE WRITE IN FLIGHT (JOS-371), and the file that is owed once it lands.
 *
 * The durable write is asynchronous now, which is the one property the synchronous version gave
 * away for free: two of them CAN interleave, and two interleaved writers share one `.tmp` path, so
 * the second would rename a scratch file the first is still filling. So there is exactly one at a
 * time. A write that arrives while one is running does not queue — it REPLACES what is owed, because
 * a ring write is the whole file and the newest ring already contains every event an older one had.
 * The gate's own coalescing argument, one layer up.
 */
let writing = false
let owed: { data: string; now: number } | null = null
/** Set when `dropRing` ran while a write was in the threadpool — see its header. */
let dropDuringWrite = false

/** Report a settled write. Split out so the async path and the sync final say the same two things
 *  about the same gate — the recovery line once, the failure line with its pause. */
function noteWriteResult(err: unknown, now: number): void {
  if (err === null) {
    if (writeGate.succeeded()) {
      logInfo('[everquest-companion] telemetry.json is writable again; the buffer was persisted')
    }
    return
  }
  // THE PAYLOAD IS BYTE-IDENTICAL TO THE ONE 0.18-0.23 FILED, deliberately: the error store's
  // fingerprint is built from the message and the frames, so keeping this string exact means the
  // fleet's existing `telemetry.json write failed` families keep aggregating across the fix
  // instead of splitting in two — and `errorRepeat`'s identical-line cap still recognises the
  // line. The pause is narrated to the console instead, where a varying number costs nothing.
  logError('main:telemetryRing', { message: 'telemetry.json write failed', err })
  const { delayMs } = writeGate.failed(now)
  logInfo(
    `[everquest-companion] telemetry.json is unwritable; pausing the buffer's writes for ${Math.round(delayMs / 1000)}s`
  )
}

/**
 * Drain `owed` until nothing is owed. The ONLY caller of the async durable write in this file.
 *
 * WHAT IS OWED STAYS OWED UNTIL THE BYTES ARE DOWN, and that is not tidiness — it is the whole
 * reason the quit final has anything to write. Clearing `owed` on the way IN looked equivalent and
 * was not: `drainWrites()` runs synchronously up to its first `await`, so a `writeRing` during
 * `window-all-closed` emptied `owed` in the same tick, `before-quit` then found nothing outstanding,
 * and the process exited before the threadpool write ever landed. MEASURED: the telemetry e2e's
 * restart assertions went red on exactly that — the heartbeat's `startupReplay`, `liveStall` and
 * `errorReport` records never reached the ring on disk.
 */
async function drainWrites(): Promise<void> {
  while (owed !== null) {
    const pending = owed
    const dir = app.getPath('userData')
    try {
      await writeFileDurableAsync(dir, join(dir, RING_FILE), pending.data)
      // …and only what THIS write carried is discharged: a newer ring that arrived mid-write is
      // still owed, and the loop takes it next.
      if (owed === pending) owed = null
      noteWriteResult(null, pending.now)
    } catch (err) {
      if (owed === pending) owed = null
      noteWriteResult(err, pending.now)
    }
  }
  writing = false
  if (dropDuringWrite) {
    dropDuringWrite = false
    removeRingFiles()
  }
}

/**
 * Persist durably (temp file + flush + rename), and STOP TRYING for a while when the disk says no.
 *
 * THE CACHE IS SET FIRST, BEFORE THE GATE IS ASKED, and that order is the entire reason a paused
 * writer costs nothing: memory is this ring's truth (every reader — `pendingBatch`,
 * `telemetryPayload`, the next `recordEvent` — comes through `readRing`, which returns `cached`),
 * so a skipped write loses only the crash-safety of a file that was refusing to be written
 * anyway. NOTHING about what is collected changes; the first write that lands persists the lot.
 *
 * `now` is a parameter for the same reason the rest of this app takes one — the pause is a clock
 * decision and a clock decision should be drivable.
 *
 * THE GATE IS ASKED AT EXACTLY THE SAME MOMENT IT ALWAYS WAS (JOS-371): synchronously, here, with
 * this call's `now`, before a byte is touched — the doomed-write storm is skipped without ever
 * reaching the disk, which is the whole of `ring.ts:149`'s contract and is unchanged. What moved is
 * only when the ANSWER comes back: `succeeded()`/`failed(now)` now run when the write settles rather
 * than before this function returns, and `failed` is handed the `now` of the call that started the
 * write, so the pause it opens is measured from the same instant it always was.
 */
export function writeRing(next: TelemetryRing, now = Date.now()): void {
  cached = next
  if (!writeGate.ready(now)) return
  owed = { data: JSON.stringify(next, null, 2), now }
  if (writing) return
  writing = true
  void drainWrites()
}

/**
 * THE LAST WRITE THIS PROCESS OWES, ON DISK NOW — the documented quit final, and the reason the
 * asynchronous writer above is allowed to exist.
 *
 * `window-all-closed` records `sessionEnd` into the ring and then quits; an async write scheduled at
 * that moment is a write the process may never turn the event loop for again, and the last session's
 * duration would be lost on every single launch. This is the same temp+fsync+rename, synchronously,
 * for the one instant where "later" does not arrive.
 *
 * It writes only what is OWED — a launch whose last write already landed does no I/O at all — and it
 * respects the gate exactly as the async path does, so a quit on a full disk does not restart the
 * storm on its way out.
 *
 * IT WRITES THROUGH ITS OWN SCRATCH FILE, and that is what makes it safe to run on top of a write
 * that is still in the threadpool. Sharing one `.tmp` would be two writers filling one scratch file
 * with one of them renaming mid-fill — a TORN telemetry.json, the exact failure temp+fsync+rename
 * exists to make impossible. With two scratch paths, whichever rename lands last publishes a
 * COMPLETE file and the loser's bytes were complete too; at quit the process almost always goes
 * before the threadpool write returns, so the last record is the one that survives.
 */
export function flushRingSync(): void {
  if (owed === null) return
  const { data, now } = owed
  owed = null
  if (!writeGate.ready(now)) return
  const dir = app.getPath('userData')
  const path = join(dir, RING_FILE)
  try {
    writeFileDurableFinal(dir, path, data)
    noteWriteResult(null, now)
  } catch (err) {
    noteWriteResult(err, now)
  }
}

/** The live file AND the scratch file (JOS-265). A write that failed part-way leaves
 *  `telemetry.json.tmp` holding up to a full ring of events; deleting only the live file would leave
 *  those events on disk after "turn it off" — the same lie `dropRing` exists to prevent, in another
 *  filename. */
function removeRingFiles(): void {
  const path = ringPath()
  try {
    rmSync(path, { force: true })
    rmSync(tempPathFor(path), { force: true })
    rmSync(tempPathFor(path, FINAL_TEMP_TAG), { force: true })
  } catch (err) {
    logError('main:telemetryRing', { message: 'telemetry.json delete failed', err })
  }
}

/**
 * DROP EVERYTHING, now — the buffer AND the file. This is what "turn it off" means, and what a
 * rotation means: a switch that left 500 events sitting on disk would be a switch that lied.
 *
 * AND A DROP HAS TO OUTLIVE AN IN-FLIGHT WRITE (JOS-371). A write in the threadpool cannot be
 * cancelled and its rename may land AFTER these deletes, re-creating the file the switch just
 * removed — the sync writer could never do that, because a drop could not begin while a write was
 * running. What is owed is discarded immediately, and a drop that caught a write mid-flight asks
 * the drain to delete again on its way out.
 */
export function dropRing(): void {
  cached = emptyRing()
  // A pause is failure state about the OLD file. Dropping it frees space and gives the next write
  // a genuinely different situation, so it starts from a clean gate rather than serving out a
  // fifteen-minute wait the user's switch has just made meaningless.
  writeGate.reset()
  owed = null
  if (writing) dropDuringWrite = true
  removeRingFiles()
}

/** Test/dev seam: forget the memoized ring so the next read hits disk again. */
export function resetRingCache(): void {
  cached = null
  writeGate.reset()
  owed = null
  dropDuringWrite = false
}
