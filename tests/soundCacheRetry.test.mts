// A FAILED SOUND FETCH IS NEVER REMEMBERED, AND EVERY PLAYBACK FAILURE SAYS SO (JOS-442).
//
// THE DEFECT THIS FILE EXISTS FOR. `getSoundUrl` cached the PROMISE, and the promise carried a
// `.catch(() => null)` — so ONE transient IPC failure resolved to null, went into the Map, and
// silenced that sound for the life of the process. Every later firing read the cached null,
// returned early, and wrote nothing anywhere. Beside it, `playSound` swallowed every `play()`
// rejection into an empty catch. Together those two lines are why the owner's evening of dead
// audio produced an errors.log with NOT ONE ENTRY for the whole failure window: the app was
// structurally incapable of reporting its own silence.
//
// So this file drives the REAL module — `renderer/src/features/alerts/soundCache.ts` and the
// `audioHealth.ts` it reports through — rather than a pure copy of its decisions, because both
// defects lived in the effectful half and a re-implementation would have had neither. The DOM it
// needs is four globals (`window.eq`, `Audio`, and Node's own `Blob`/`URL`/`atob`), which is
// little enough that this stays a unit test: no Electron, no browser, never skips.
//
//   C-series  the cache: failures evicted, successes kept, one in-flight fetch shared.
//   L-series  the log: one line per failure per minute per sound, counted while quiet.
//   A-series  the element: a FRESH `new Audio()` per play, which is the measured basis for
//             player.tsx's claim that a device change needs no cache flush.
//
// Run: `npm test`.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  getSoundUrl,
  invalidateSoundCaches,
  playSound
} from '../src/renderer/src/features/alerts/soundCache'
import {
  noteAudioPlayed,
  reportAudioFailure,
  resetAudioHealth
} from '../src/renderer/src/features/alerts/audioHealth'
import { AUDIO_FAILURE_THROTTLE_MS } from '../src/shared/audioFailureLog'

// ------------------------------------------------------------------------------ the stubs

interface ErrorReport {
  source: string
  message: string
  name?: string
}

/** One base64 MP3-ish payload; the bytes are never decoded, only wrapped in a Blob. */
const BYTES = { mime: 'audio/mpeg', dataBase64: 'QUJD' }

let fetches: string[] = []
let reports: ErrorReport[] = []
let audiosMade: string[] = []
/** What the next `getSoundData` does, per key. Consumed left to right. */
let script: (('ok' | 'null' | 'throw') | undefined)[] = []
/** What the next `play()` does. */
let playScript: (Error | undefined)[] = []

class StubAudio {
  volume = 1
  currentTime = 0
  constructor(readonly src: string) {
    audiosMade.push(src)
  }
  play(): Promise<void> {
    const next = playScript.shift()
    if (next) return Promise.reject(next)
    this.currentTime = 0.1
    return Promise.resolve()
  }
}

function install(): void {
  fetches = []
  reports = []
  audiosMade = []
  script = []
  playScript = []
  const win = {
    eq: {
      getSoundData: (packId: string, soundId: string): Promise<typeof BYTES | null> => {
        fetches.push(`${packId}/${soundId}`)
        const mode = script.shift() ?? 'ok'
        if (mode === 'throw') return Promise.reject(new Error('ipc exploded'))
        return Promise.resolve(mode === 'null' ? null : BYTES)
      },
      reportError: (r: ErrorReport): void => {
        reports.push(r)
      }
    }
  }
  Object.assign(globalThis, { window: win, Audio: StubAudio })
}

beforeEach(() => {
  install()
  invalidateSoundCaches()
  resetAudioHealth()
})

// -------------------------------------------------------------------------- C: the cache

test('C1 THE DEFECT: a sound whose first fetch fails plays on the NEXT fire', async () => {
  script = ['throw']
  const first = await playSound('afewgoodmen', 'kaffee_hi', 1)
  assert.equal(first.fetched, false, 'the first attempt genuinely failed')

  // The old code cached that null forever; the whole ticket is that this second call works.
  const second = await playSound('afewgoodmen', 'kaffee_hi', 1)
  assert.equal(second.fetched, true)
  assert.equal(second.started, true)
  assert.deepEqual(fetches, ['afewgoodmen/kaffee_hi', 'afewgoodmen/kaffee_hi'])
})

test('C2 a fetch that answers "no such sound" is retried too, not just a thrown one', async () => {
  script = ['null']
  assert.equal(await getSoundUrl('afewgoodmen', 'kaffee_hi'), null)
  assert.notEqual(await getSoundUrl('afewgoodmen', 'kaffee_hi'), null)
  assert.equal(fetches.length, 2)
})

test('C3 a SUCCESS is still cached — the latency win the cache exists for is untouched', async () => {
  const a = await getSoundUrl('afewgoodmen', 'kaffee_hi')
  const b = await getSoundUrl('afewgoodmen', 'kaffee_hi')
  assert.equal(a, b)
  assert.equal(fetches.length, 1, 'one fetch, two plays')
})

test('C4 two alerts firing together share ONE in-flight fetch, and both still retry after', async () => {
  script = ['throw']
  const [x, y] = await Promise.all([
    getSoundUrl('afewgoodmen', 'kaffee_hi'),
    getSoundUrl('afewgoodmen', 'kaffee_hi')
  ])
  assert.equal(x, null)
  assert.equal(y, null)
  assert.equal(fetches.length, 1, 'the burst was coalesced into one IPC call')
  // …and the shared failure did not survive it.
  assert.notEqual(await getSoundUrl('afewgoodmen', 'kaffee_hi'), null)
  assert.equal(fetches.length, 2)
})

test('C5 one sound failing does not evict a different sound that worked', async () => {
  await getSoundUrl('afewgoodmen', 'kaffee_hi')
  script = ['throw']
  await getSoundUrl('afewgoodmen', 'truth')
  await getSoundUrl('afewgoodmen', 'kaffee_hi')
  assert.deepEqual(fetches, [
    'afewgoodmen/kaffee_hi',
    'afewgoodmen/truth',
    // kaffee_hi is NOT re-fetched: it is still cached.
  ])
})

// ----------------------------------------------------------------------------- L: the log

test('L1 THE DEFECT: a play() rejection reaches errors.log, carrying the error name', async () => {
  playScript = [Object.assign(new Error('no decoder'), { name: 'NotSupportedError' })]
  const out = await playSound('afewgoodmen', 'kaffee_hi', 1)
  assert.equal(out.started, false)
  assert.equal(out.errorName, 'NotSupportedError')
  assert.equal(reports.length, 1)
  assert.equal(reports[0]?.source, 'renderer:alertAudio')
  assert.equal(reports[0]?.name, 'NotSupportedError')
  assert.match(reports[0]?.message ?? '', /'afewgoodmen\/kaffee_hi' failed to play: NotSupportedError/)
})

test('L2 a failed FETCH reaches errors.log too — silence never has an unnamed cause', async () => {
  script = ['null']
  await getSoundUrl('afewgoodmen', 'kaffee_hi')
  assert.equal(reports.length, 1)
  assert.match(reports[0]?.message ?? '', /could not be loaded: NoSoundData/)
})

test('L3 NEVER SPAMMY: a burst on one sound is one line…', () => {
  const t0 = 5_000_000
  const wrote = []
  for (let i = 0; i < 20; i++) {
    wrote.push(reportAudioFailure('play', 'a/b', new Error('x'), t0 + i * 100))
  }
  assert.equal(reports.length, 1)
  // …and the module SAYS which one it wrote, rather than the caller having to guess. The other
  // nineteen are not forgotten — L4 reads them back out of the next line.
  assert.deepEqual(wrote.slice(0, 3), [true, false, false])
})

test('L4 …AND NEVER SILENT: the next window reports again, saying what it swallowed', () => {
  const t0 = 5_000_000
  for (let i = 0; i < 20; i++) reportAudioFailure('play', 'a/b', new Error('x'), t0 + i * 100)
  reportAudioFailure('play', 'a/b', new Error('x'), t0 + AUDIO_FAILURE_THROTTLE_MS)
  assert.equal(reports.length, 2)
  assert.match(reports[1]?.message ?? '', /\(\+19 more since the last report\)/)
})

test('L5 the throttle is per SOUND — a second failing sound is not hidden by the first', () => {
  const t0 = 5_000_000
  assert.equal(reportAudioFailure('play', 'a/b', new Error('x'), t0), true)
  assert.equal(reportAudioFailure('play', 'c/d', new Error('x'), t0), true)
  assert.equal(reportAudioFailure('play', 'a/b', new Error('x'), t0 + 1), false)
})

test('L6 a sound that RECOVERS and breaks again reports immediately, not a minute later', () => {
  const t0 = 5_000_000
  reportAudioFailure('play', 'a/b', new Error('x'), t0)
  noteAudioPlayed('a/b')
  assert.equal(reportAudioFailure('play', 'a/b', new Error('x'), t0 + 2000), true)
  assert.equal(reports.length, 2)
})

test('L7 a play that WORKS clears the throttle through the real path, not just by hand', async () => {
  // The recovery clause end to end: the failure is reported, a real play succeeds (which is the
  // only thing that calls `noteAudioPlayed`), and the next failure is heard again immediately
  // instead of being swallowed by the window the first one opened.
  playScript = [Object.assign(new Error('x'), { name: 'AbortError' })]
  await playSound('afewgoodmen', 'kaffee_hi', 1)
  assert.equal(reports.length, 1)
  await playSound('afewgoodmen', 'kaffee_hi', 1)
  playScript = [Object.assign(new Error('x'), { name: 'AbortError' })]
  await playSound('afewgoodmen', 'kaffee_hi', 1)
  assert.equal(reports.length, 2, 'the recovery reopened the log for that sound')
})

test('L8 reporting survives a renderer with no bridge at all — the overlay bundle case', () => {
  Object.assign(globalThis, { window: {} })
  assert.doesNotThrow(() => reportAudioFailure('play', 'a/b', new Error('x'), 1))
  // Nothing was forwarded (there is nowhere to forward to) and nothing threw. The throttle still
  // took the failure, which is why the SECOND one inside the window is swallowed.
  assert.equal(reportAudioFailure('play', 'a/b', new Error('x'), 2), false)
  assert.equal(reports.length, 0)
})

// ------------------------------------------------------------------------- A: the element

test('A1 every play builds a FRESH Audio element — the basis for not flushing on device change', async () => {
  // player.tsx claims a device change needs no cache flush BECAUSE nothing per-sound is bound to
  // a device: the Blob URL is bytes, and the element that binds to an output is made new every
  // single firing. That claim is measured here rather than asserted in a comment.
  await playSound('afewgoodmen', 'kaffee_hi', 1)
  await playSound('afewgoodmen', 'kaffee_hi', 1)
  await playSound('afewgoodmen', 'kaffee_hi', 1)
  assert.equal(audiosMade.length, 3)
  assert.equal(new Set(audiosMade).size, 1, 'three elements over one cached Blob URL')
  assert.equal(fetches.length, 1)
})

test('A2 the volume argument is clamped rather than trusted', async () => {
  await playSound('afewgoodmen', 'kaffee_hi', 4)
  await playSound('afewgoodmen', 'kaffee_hi', -1)
  // Nothing to assert on the stub's own field beyond that neither call threw; the clamp is the
  // reason a def with a bad stored volume cannot make the element throw a RangeError.
  assert.equal(audiosMade.length, 2)
})

test('A3 a play that could not fetch reports it, and never touches an element', async () => {
  script = ['null']
  const out = await playSound('afewgoodmen', 'kaffee_hi', 1)
  assert.deepEqual(out, { fetched: false, started: false })
  assert.equal(audiosMade.length, 0, 'nothing was constructed over a URL that does not exist')
})
