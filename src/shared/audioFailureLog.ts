// audioFailureLog — the rules by which a broken alert sound writes ONE readable line to
// errors.log. Pure, so the whole policy is node-tested with no DOM and no clock.
//
// WHY IT EXISTS (JOS-442). Every alert sound and the spoken voice went silent on the owner's
// machine for an evening while everything upstream was provably healthy — the def enabled, the mp3
// on disk, the trigger firing, the module delta arriving — and the app's own error log had NOTHING
// in it for the whole failure window. Not one line, because there was no code that could have
// written one: `playSound` swallowed every `play()` rejection in an empty catch, and a failed fetch
// was cached as null forever. Silence looked exactly like success.
//
// WHAT THIS FILE IS NOT, ANY MORE (JOS-443, owner ruling, verbatim: "we don't need any special
// audio debugging tools at all"). It briefly also held a DIAGNOSTIC: a WASAPI readout of this app's
// own Windows mixer session and a verdict function that turned it into a sentence for a Sound check
// card in Preferences. The card, the `audio:session` IPC channel, the native reader
// (main/audioSessionNative.ts) and the verdict are all deleted. This is deliberately the boring
// half — the half with no surface, no tool and nothing to find: a failure is never cached
// (renderer/features/alerts/soundCache.ts) and never silent (alerts/audioHealth.ts), and that is
// the whole of what the app does about its own audio.
//
// Value imports of this module stay RELATIVE from the renderer (repo law for anything node:test
// loads); nothing here imports anything.

/**
 * How long ONE audio failure key stays quiet after it has been reported once.
 *
 * A failing audio stack fails on EVERY alert, and an alert-heavy pull can fire a dozen times in
 * as many seconds — so the unthrottled version of this would put hundreds of identical lines in
 * errors.log and make the report unreadable. A minute per key is long enough that a burst is one
 * line and short enough that a failure spanning a play session is still visibly recurring.
 */
export const AUDIO_FAILURE_THROTTLE_MS = 60_000

/**
 * Should this failure be written, given when its key was last written? Pure so the rule is
 * pinned by a test rather than by a Map in a module nobody can reach.
 */
export function shouldReportAudioFailure(
  lastReportedAt: number | undefined,
  now: number,
  throttleMs: number = AUDIO_FAILURE_THROTTLE_MS
): boolean {
  if (lastReportedAt === undefined) return true
  return now - lastReportedAt >= throttleMs
}

/** Which step of the audio path failed. Part of the log line, so it is a closed set. */
export type AudioFailureKind = 'fetch' | 'play'

/**
 * The ONE sentence an audio failure puts in errors.log.
 *
 * Written as a formatter rather than inline at each call site so that the shape — kind, sound
 * key, error name — is the same for every failure and a report can be grouped by it. `suppressed`
 * says how many identical failures the throttle ate since the last line, so a quiet log never
 * under-states a loud problem.
 */
export function audioFailureMessage(
  kind: AudioFailureKind,
  key: string,
  errorName: string,
  suppressed = 0
): string {
  const head =
    kind === 'fetch'
      ? `alert sound '${key}' could not be loaded`
      : `alert sound '${key}' failed to play`
  const why = errorName ? `: ${errorName}` : ''
  const more = suppressed > 0 ? ` (+${String(suppressed)} more since the last report)` : ''
  return `${head}${why}${more}`
}
