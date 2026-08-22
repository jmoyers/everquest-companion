// switchNudge.ts — the binding that gives `log/quietSwitch.ts` a clock, a directory and a window.
//
// The DECISION (and the whole never-spam argument) lives in the pure core; read its header first.
// This file is deliberately thin: it stamps when the tail last delivered a line, polls the Logs dir
// while — and only while — the attached log is silent, and sends at most one `log:switchNudge` per
// candidate log per app session. It switches nothing: the owner ruled a nudge, never auto-follow.
//
// THE POLL COSTS NOTHING WHILE THE APP IS WORKING. `logIsQuiet` is checked BEFORE the directory is
// read, so an app tailing a live log never stats a file for this feature — which matters while the
// EQ-hitch program (JOS-363…372) is measuring what the main process does between frames.

import { statSync } from 'fs'
import { IPC } from '../shared/ipc'
import type { CharacterRef, LogSwitchNudge } from '../shared/types'
import { E2E } from './e2e'
import { logInfo } from './errorLog'
import { listCharacters, parseLogName } from './log/config'
import { POLL_MS, QUIET_MS, QuietSwitchWatcher, logIsQuiet, type SiblingSample } from './log/quietSwitch'
import { sendToMain } from './windows'

/**
 * THE E2E-ONLY TIME COMPRESSION. A spec cannot wait five real minutes for a nudge, and a knob that
 * shortened the threshold in a shipped build would be a spam vector wearing a test's clothes — so
 * both overrides are gated on `EQ_E2E` (the same reason `EQ_TRAY_E2E` exists). A packaged app reads
 * neither variable and cannot be made to.
 */
function tuned(name: string, fallback: number): number {
  if (!E2E) return fallback
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

const quietMs = tuned('EQ_QUIET_SWITCH_MS', QUIET_MS)
const pollMs = tuned('EQ_QUIET_SWITCH_POLL_MS', POLL_MS)

/**
 * ONE watcher for the whole app session. It outlives every character switch on purpose — that is
 * what bounds two-account alternation to one nudge per log (quietSwitch.ts's header).
 */
const watcher = new QuietSwitchWatcher(quietMs)

let attached: CharacterRef | null = null
let lastLineAt = 0
let timer: ReturnType<typeof setInterval> | null = null

/**
 * The tail delivered a line. Called from `startTailer`'s line handler, which is the app's hottest
 * path — so it is one assignment and nothing else, and it deliberately counts EVERY raw line rather
 * than only the ones that parsed into an event: the question is whether anything is being written
 * to the file we are attached to, not whether we understood it.
 */
export function noteTailLine(): void {
  lastLineAt = Date.now()
}

/** Every character log in the effective Logs dir, with the size this poll found. */
function sampleLogs(): SiblingSample[] {
  const out: SiblingSample[] = []
  for (const ref of listCharacters()) {
    try {
      out.push({ path: ref.logPath, size: statSync(ref.logPath).size })
    } catch {
      // Deleted or locked between the listing and the stat — it simply is not a candidate.
    }
  }
  return out
}

/** Announce a candidate to the main window. The renderer decides nothing; it asks. */
function offerSwitch(logPath: string, quietFor: number): void {
  const candidate = parseLogName(logPath)
  if (!candidate || !attached) return
  const payload: LogSwitchNudge = {
    candidate,
    attached,
    quietMs: Math.round(quietFor)
  }
  logInfo(
    `[everquest-companion] ${attached.name}'s log has been quiet for ${String(
      Math.round(quietFor / 1000)
    )}s while ${candidate.name}'s is growing — offering a switch (asked at most once per log per session).`
  )
  sendToMain(IPC.onLogSwitchNudge, payload)
}

function poll(): void {
  const ref = attached
  if (!ref) return
  const now = Date.now()
  // The directory read is bought only by silence — see the header.
  const logs = logIsQuiet(lastLineAt, now, quietMs) ? sampleLogs() : []
  const outcome = watcher.observe({ now, activeLogPath: ref.logPath, lastLineAt, logs })
  if (outcome.kind === 'nudge') offerSwitch(outcome.logPath, outcome.quietMs)
}

/**
 * Follow a newly attached character. Called at the end of every `tailCharacter`, so the quiet clock
 * starts when the live tail does — a multi-second historical replay is not silence.
 *
 * The interval is `unref`'d: watching for a switch must never be the reason this process stays up.
 */
export function watchForQuietSwitch(ref: CharacterRef): void {
  stopWatchingForQuietSwitch()
  attached = ref
  lastLineAt = Date.now()
  timer = setInterval(poll, pollMs)
  timer.unref?.()
}

/** Stop following (no character attached, or the app is going away). */
export function stopWatchingForQuietSwitch(): void {
  if (timer) clearInterval(timer)
  timer = null
  attached = null
}
