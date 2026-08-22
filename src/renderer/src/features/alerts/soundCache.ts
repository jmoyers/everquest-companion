// soundCache — fetch a pack sound's bytes once (over IPC), build a CSP-safe Blob
// URL, and cache it keyed by packId/soundId. The app's CSP forbids file:// and
// remote audio, but a Blob URL made from bytes we already have is allowed. Blob
// URLs live for the app's lifetime (we intentionally never revoke — the set of
// sounds is tiny and re-fetching on every play would add latency to alerts).
//
// THE CACHE HOLDS SUCCESSES. IT MUST NEVER HOLD A FAILURE (JOS-442).
//
// It used to hold both, because it cached the PROMISE — and the promise had a `.catch(() => null)`
// on it, so one transient IPC failure resolved to null, went into the Map, and silenced that
// sound FOREVER: every later play read the cached null, returned early, and said nothing. There
// was no expiry, no retry and no log line, so the only cure was relaunching the app and the only
// symptom was silence. The rationale in the header above — "re-fetching on every play would add
// latency" — is an argument about SUCCESSES and was never an argument for remembering a failure,
// which costs latency exactly once and buys a working alert.
//
// So: a resolution of `null` is evicted from the Map before it is handed back, and the next play
// tries again. The in-flight promise is still shared (two alerts firing together make one fetch),
// which is the whole latency win; only the OUTCOME is conditional.
//
// AND EVERY FAILURE SAYS SO. Both the fetch path and the `play()` path report through
// `audioHealth.ts`, which throttles per sound and writes one line to errors.log. The empty catch
// that used to sit on `play()` is the reason the owner's evening-long silence produced a
// completely empty error log for the entire failure window.

import { noteAudioPlayed, reportAudioFailure } from './audioHealth'

const cache = new Map<string, Promise<string | null>>()

function key(packId: string, soundId: string): string {
  return `${packId}/${soundId}`
}

/**
 * Drop all cached sound Blob URLs (revoking them). Call after a pack is
 * installed/uninstalled so the next play re-fetches fresh bytes over IPC — a
 * reinstalled pack may have changed, and a stale cache would keep old audio.
 */
export function invalidateSoundCaches(): void {
  for (const p of cache.values()) {
    void p.then((url) => {
      if (url) URL.revokeObjectURL(url)
    })
  }
  cache.clear()
}

/**
 * Resolve a Blob URL for a pack sound. Null if the sound can't be loaded — and a null is NOT
 * remembered: the entry is evicted so the next play re-fetches (see the header). Successes are
 * cached for the app's lifetime, which is the whole point of the cache.
 */
export function getSoundUrl(packId: string, soundId: string): Promise<string | null> {
  const k = key(packId, soundId)
  const hit = cache.get(k)
  if (hit) return hit
  const p = window.eq
    .getSoundData(packId, soundId)
    .then((data) => {
      if (!data) {
        // Main answered, and its answer was "no such sound". Reported like a thrown failure
        // because from the alert's point of view it is the same event: silence where a sound
        // was configured.
        reportAudioFailure('fetch', k, 'NoSoundData')
        return null
      }
      const bytes = Uint8Array.from(atob(data.dataBase64), (c) => c.charCodeAt(0))
      const blob = new Blob([bytes], { type: data.mime })
      return URL.createObjectURL(blob)
    })
    .catch((err: unknown) => {
      reportAudioFailure('fetch', k, err)
      return null
    })
  cache.set(k, p)
  // THE EVICTION. Registered on the cached promise itself — and BEFORE any caller gets to await
  // it, so by the time `playSound` sees the null the Map is already clean and the next firing
  // re-fetches. Two alerts landing together still share the ONE in-flight fetch (that is the
  // latency win the cache exists for); only the OUTCOME decides whether it is remembered.
  void p.then((url) => {
    if (url === null && cache.get(k) === p) cache.delete(k)
  })
  return p
}

/**
 * What one play did. Handed back rather than swallowed so the hardening above is TESTABLE — the
 * retry after a failed fetch and the line every failure writes are both properties of this
 * function, and a `Promise<void>` would leave a unit test with nothing to assert on but a stub's
 * side effects. Every caller in the app fires and forgets.
 *
 * IT IS NOT A DIAGNOSTIC (JOS-443). It briefly also reported whether the element's clock had
 * ADVANCED, watched over an `observeMs` window, because the Preferences sound check needed a
 * three-valued "did anything actually come out". That card is gone, and the observation went with
 * it: nothing in the app waits on a sound it has already started.
 */
export interface PlayOutcome {
  readonly fetched: boolean
  readonly started: boolean
  readonly errorName?: string
}

/**
 * Play a pack sound at `volume` (0..1). Overlapping plays are allowed — each call
 * uses its own <audio> element so a rapid burst doesn't cut off the previous
 * sound. Resolves when playback starts (or immediately on failure).
 *
 * IT TAKES NO CONTINUATION ANY MORE (JOS-362). There used to be an `onEnded` callback — the seam
 * the `audio:'both'` alerts queued their utterance behind (voice alerts, decision D5), with an
 * every-path `finish()` and a 10s cap so a stuck decoder could not swallow the spoken half. The
 * combined channel is retired ("also remove sound + spoken - too much garbage", owner
 * 2026-08-14), so a firing plays a sound OR speaks, and the only caller left wants neither the
 * callback nor the timer. Deleted rather than kept for a caller that no longer exists.
 */
export async function playSound(
  packId: string,
  soundId: string,
  volume: number
): Promise<PlayOutcome> {
  const k = key(packId, soundId)
  const url = await getSoundUrl(packId, soundId)
  // getSoundUrl has already reported WHY, and evicted itself so the next firing retries.
  if (!url) return { fetched: false, started: false }
  const audio = new Audio(url)
  audio.volume = Math.max(0, Math.min(1, volume))
  try {
    await audio.play()
  } catch (err: unknown) {
    // THE EMPTY CATCH THAT USED TO BE HERE IS THE BUG (JOS-442). Autoplay policy is a real
    // rejection this path can see — and so is every failure of the machine's audio stack, and
    // for an entire evening of dead audio it produced exactly zero log lines. It says so now.
    reportAudioFailure('play', k, err)
    const name = err instanceof Error ? err.name : ''
    return { fetched: true, started: false, ...(name ? { errorName: name } : {}) }
  }
  noteAudioPlayed(k)
  return { fetched: true, started: true }
}

// ----- registry PREVIEW playback (Task #31) -----
//
// Preview an UN-installed registry pack's audio: bytes are fetched over the
// `packs:previewSound` IPC (off GitHub raw, main-side LRU) and turned into a Blob
// URL cached keyed by packName/file. Unlike installed-sound URLs (kept for the app
// lifetime), preview URLs are tied to the dialog: `revokePreviewCache()` drops them
// all when the registry dialog closes. Only one preview plays at a time.

const previewCache = new Map<string, Promise<string | null>>()
let previewAudio: HTMLAudioElement | null = null

function previewKey(packName: string, file: string): string {
  return `${packName}::${file}`
}

/** Resolve a Blob URL for a registry pack's preview file (cached). Null on failure. */
function getPreviewUrl(packName: string, file: string): Promise<string | null> {
  const k = previewKey(packName, file)
  const hit = previewCache.get(k)
  if (hit) return hit
  const p = window.eq
    .previewPackSound(packName, file)
    .then((data) => {
      if (!data) return null
      const bytes = Uint8Array.from(atob(data.dataBase64), (c) => c.charCodeAt(0))
      return URL.createObjectURL(new Blob([bytes], { type: data.mime }))
    })
    .catch(() => null)
  previewCache.set(k, p)
  return p
}

/**
 * Play a registry pack's preview sound at `volume` (0..1). Stops any preview
 * already playing (only one at a time). Resolves once the fetch + play kicks off;
 * returns false if the sound couldn't be loaded.
 */
export async function playPreviewSound(
  packName: string,
  file: string,
  volume: number
): Promise<boolean> {
  const url = await getPreviewUrl(packName, file)
  if (!url) return false
  stopPreview()
  const audio = new Audio(url)
  audio.volume = Math.max(0, Math.min(1, volume))
  previewAudio = audio
  try {
    await audio.play()
  } catch {
    // Autoplay/user-gesture policies can reject; nothing to do.
  }
  return true
}

/** Stop the currently-playing preview (if any). */
export function stopPreview(): void {
  if (previewAudio) {
    previewAudio.pause()
    previewAudio.currentTime = 0
    previewAudio = null
  }
}

/**
 * Drop all cached preview Blob URLs (revoking them) and stop playback. Call when the
 * registry dialog closes so preview bytes don't leak for the app's lifetime.
 */
export function revokePreviewCache(): void {
  stopPreview()
  for (const p of previewCache.values()) {
    void p.then((url) => {
      if (url) URL.revokeObjectURL(url)
    })
  }
  previewCache.clear()
}
