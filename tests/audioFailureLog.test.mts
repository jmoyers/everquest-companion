// AN AUDIO FAILURE IS NEVER SILENT AND NEVER SPAMMY (JOS-442, trimmed to this by JOS-443).
//
// The owner's alert audio went completely silent for an evening while the app said nothing at
// all — the empty catch in `playSound` meant a failing audio stack produced zero log lines, and
// a null fetch was cached forever so the sound could never come back without a relaunch. The fix
// had two halves: a retry (pinned in tests/soundCacheRetry.test.mts) and a LOG. This file pins the
// log's rules, which live in `shared/audioFailureLog.ts` as pure functions precisely so they can be
// pinned without a DOM.
//
// WHAT THIS FILE NO LONGER PINS, and why the deletion is the point: JOS-442 also shipped a
// diagnostic — a WASAPI readout of this app's own Windows mixer session, and a verdict function
// that turned it into a sentence for a Sound check card in Preferences. The owner ruled it out
// entirely ("we don't need any special audio debugging tools at all"), so the card, the
// `audio:session` channel, the native reader and the verdict are deleted, and the V/P/G series that
// pinned them went with them. The T-series below is what is left: the invisible half.
//
// No DOM, no Electron, no fixture: it never skips. Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUDIO_FAILURE_THROTTLE_MS,
  audioFailureMessage,
  shouldReportAudioFailure
} from '../src/shared/audioFailureLog'

test('T1 the first failure of a key always reports', () => {
  assert.equal(shouldReportAudioFailure(undefined, 1_000_000), true)
})

test('T2 a repeat inside the window is swallowed, and the window is exactly one minute', () => {
  const t0 = 1_000_000
  assert.equal(shouldReportAudioFailure(t0, t0 + 1), false)
  assert.equal(shouldReportAudioFailure(t0, t0 + AUDIO_FAILURE_THROTTLE_MS - 1), false)
  assert.equal(shouldReportAudioFailure(t0, t0 + AUDIO_FAILURE_THROTTLE_MS), true)
  assert.equal(AUDIO_FAILURE_THROTTLE_MS, 60_000)
})

test('T3 the line names the step, the sound and the error — and never drops the count', () => {
  assert.equal(
    audioFailureMessage('play', 'afewgoodmen/kaffee_hi', 'NotSupportedError'),
    "alert sound 'afewgoodmen/kaffee_hi' failed to play: NotSupportedError"
  )
  assert.equal(
    audioFailureMessage('fetch', 'afewgoodmen/kaffee_hi', 'NoSoundData'),
    "alert sound 'afewgoodmen/kaffee_hi' could not be loaded: NoSoundData"
  )
  // NEVER SILENT: a quiet log must not under-state a loud problem.
  assert.match(audioFailureMessage('play', 'x/y', 'AbortError', 41), /\(\+41 more since the last report\)/)
  // A nameless throw still produces a readable line rather than a dangling colon.
  assert.equal(audioFailureMessage('play', 'x/y', ''), "alert sound 'x/y' failed to play")
})
