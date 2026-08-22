// audioHealth — the ONE door every audio failure leaves through, and the throttle on it.
//
// WHY IT EXISTS (JOS-442). Before this module the app had no audio reporting at all: `playSound`
// caught every `play()` rejection into an empty block, a failed fetch was cached as null for the
// life of the process, and nothing anywhere recorded that a sound had failed. When the owner's
// audio went silent for an entire evening, the app's own error log had NOTHING in it for the whole
// failure window — not one line — because there was no code that could have written one. That
// absence is the defect this module closes.
//
// IT IS A LOG, NOT A TOOL (JOS-443, owner ruling: "we don't need any special audio debugging tools
// at all"). It used to also keep a READOUT — last-played-ok, last device change, last failure, a
// running count — for one consumer: the Preferences sound check card, which is deleted along with
// the WASAPI reader and the `audio:session` channel it asked Windows through. That state had no
// other reader, so it is gone with it. What is left is the part that works with nothing on screen:
//
//   EVERY FAILURE SAYS SO, ONCE PER MINUTE PER KEY. A broken audio stack breaks on every alert, so
//   an unthrottled report would put hundreds of identical lines in errors.log and bury the
//   diagnosis in its own noise. The throttle is per (kind, sound) and it COUNTS what it swallowed,
//   so the line that does get written says how many it stands for — quiet, but never under-stating.
//   And a sound that RECOVERS clears its cell, so the next break reports at once rather than a
//   minute later.
//
// THE THROTTLE'S RULE IS PURE AND LIVES ELSEWHERE (`shared/audioFailureLog.ts`): this file holds
// the state the rule is applied to, so the rule itself stays testable without one.
//
// Value imports from `shared/` are RELATIVE, never `@shared/*` — the repo-wide rule for anything
// node:test loads (AGENTS.md toolchain gotchas, the mobSearch.ts precedent).

import {
  audioFailureMessage,
  shouldReportAudioFailure,
  type AudioFailureKind
} from '../../../../shared/audioFailureLog'

interface ThrottleCell {
  reportedAt: number
  suppressed: number
}

const throttle = new Map<string, ThrottleCell>()

/** Drop every throttle cell. Tests only — nothing in the app has a reason to forget this. */
export function resetAudioHealth(): void {
  throttle.clear()
}

/**
 * A sound started playing: clear that sound's throttle cell, so a sound that recovers and breaks
 * again gets a fresh line rather than being silenced by the minute it failed in an hour ago.
 *
 * Called from the ONE place that knows it — after `play()` resolves. It records nothing else: "when
 * did audio last work" was a fact kept for a card that no longer exists.
 */
export function noteAudioPlayed(key: string): void {
  throttle.delete(`play:${key}`)
  throttle.delete(`fetch:${key}`)
}

/** An error's own name, which is the useful half at an audio boundary (`NotSupportedError`). */
function errorName(err: unknown): string {
  if (err instanceof Error && err.name) return err.name
  if (typeof err === 'string' && err) return err
  return ''
}

/**
 * The renderer's error channel, guarded.
 *
 * `window.eq` is absent in the overlay bundle and in node:test, and an audio failure must never
 * become a SECOND failure — this module exists because the last one was invisible, not so it can
 * throw on the way to saying so.
 */
function forward(message: string, name: string): void {
  try {
    const bridge = (globalThis as { window?: { eq?: { reportError?: (r: unknown) => void } } })
      .window?.eq?.reportError
    if (typeof bridge !== 'function') return
    bridge({ source: 'renderer:alertAudio', message, ...(name ? { name } : {}) })
  } catch {
    // A broken bridge is not worth a second exception on the path that reports breakage.
  }
}

/**
 * Record an audio failure, and write ONE line to errors.log if this key has been quiet for the
 * throttle window. Returns whether it wrote — which is what the unit test asserts on, and what
 * makes "never spammy, never silent" a checkable claim rather than a promise.
 */
export function reportAudioFailure(
  kind: AudioFailureKind,
  key: string,
  err: unknown,
  now: number = Date.now()
): boolean {
  const name = errorName(err)
  const cell = throttle.get(`${kind}:${key}`)
  if (!shouldReportAudioFailure(cell?.reportedAt, now)) {
    if (cell) cell.suppressed += 1
    return false
  }
  forward(audioFailureMessage(kind, key, name, cell?.suppressed ?? 0), name)
  throttle.set(`${kind}:${key}`, { reportedAt: now, suppressed: 0 })
  return true
}
