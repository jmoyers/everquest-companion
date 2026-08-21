// provision.ts — downloading the pinned Kokoro model. USER-INITIATED, NEVER AUTOMATIC.
//
// WHEN THIS RUNS: only from `speech:install`, i.e. only when someone clicked "download" in
// the Voice preferences. Never at startup, never on first `speech:say`, never in the e2e
// channel (plan decision D4: "off-by-default features must not spend a stranger's
// bandwidth", and a headless test with a temp userData would re-download 120 MB every run).
// The `sounds` tier self-provisions at startup because it is 2 MB and the seeded alerts
// depend on it; this is sixty times that and nothing depends on it.
//
// WHAT "POLITE" MEANS HERE (AGENTS.md "Scraper etiquette (LAW)"), point by point:
//   * ONE CONNECTION. Assets download strictly one at a time, with a pause between them.
//     Never two sockets, never a parallel chunk fetcher.
//   * IDEMPOTENT. A file already on disk at the right size with the right sha256 is SKIPPED
//     without touching the network — so re-running a finished install is free, and a run
//     that got the model but died on the voices resumes at the voices.
//   * RESUMABLE. A partial download survives in `<name>.part`. The retry re-hashes what it
//     already has, asks for `Range: bytes=<n>-`, and continues. Ninety megabytes that got to
//     95% must not be re-fetched because a laptop lid closed — that is the difference between
//     polite and merely correct.
//   * NO RETRY STORMS. Three attempts per asset, exponential backoff (2s, 4s), then stop and
//     report. A failed install does not schedule itself; the user clicks again.
//
// WHAT "SAFE" MEANS HERE:
//   * SHA256 IS A HARD GATE. The digest is computed while the bytes stream past (never by
//     re-reading 92 MB) and checked before the file is allowed to exist under its real name.
//     A mismatch DELETES the partial and fails loudly. These are model weights that will be
//     executed by onnxruntime — "probably fine" is not a security posture.
//   * ATOMIC. The verified `.part` is RENAMED into place, so `<name>` either does not exist
//     or is the complete, verified file. A torn 92 MB blob under a no-TTL cache is exactly
//     the failure imageCache.ts's atomic write exists to prevent, one thousand times bigger.
//   * PINNED. The model's two URLs are immutable GitHub release assets under a tag; the third
//     caller of this machinery (vcRuntime.ts, JOS-274) fetches a Microsoft payload from a
//     content-addressed URL. Both shapes are in pinned.ts, and both are immutable by
//     construction rather than by promise.
//
// TESTABILITY: `fetch`, the clock and the sleep are all injected, so
// tests/speechEngine.test.mts drives the whole state machine — skip, fresh download, resume,
// hash mismatch, retry/backoff — against an in-memory fetch with no network and no Electron.

import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { KOKORO_ASSETS, kokoroVoicesFor } from './pinned'
import {
  isRateLimitedPackInstall,
  parseRetryAfterMs,
  planPackInstallRetry,
  type PackInstallRetryPlan
} from '../../shared/packInstall'
import { scanVoiceIds } from './voicePack'
import type { FileHandle } from 'node:fs/promises'
import type { PinnedAsset } from './pinned'
import type { SpeechInstallProgress } from '../../shared/alertTypes'
import type { SpeechInstallResult, SpeechVoice } from '../../shared/types'

/** Same polite identity every fetcher in this repo sends (AGENTS.md scraper etiquette). */
const UA = 'everquest-companion/0.1 (personal quest tracker)'

/** Attempts per asset before the install gives up until the user asks again. A rate limit gets
 *  more (`planPackInstallRetry` widens it — see `downloadWithRetries`). */
const MAX_ATTEMPTS = 3
/** Base backoff between attempts, doubled each retry. Not used for a 429. */
const RETRY_BASE_MS = 2_000
/** What a rate-limited install tells the user. The panel already prefixes "Download failed - ", so
 *  this continues that sentence, and it says the two things that are true: the download is fine,
 *  and what was fetched is still on disk for the next try. */
const RATE_LIMITED_TEXT =
  'the download host is rate limiting us. Nothing is wrong with the download, and what was fetched is kept - try again in a few minutes'
/** Spacing between the two assets — one connection, and a beat between them. */
const BETWEEN_ASSETS_MS = 500
/** Progress is emitted at most this often while bytes stream (an IPC message per chunk is
 *  thousands of messages a second for nothing the eye can see). */
const PROGRESS_INTERVAL_MS = 200

/** `<userData>/speech/kokoro` — where the pinned model lives. */
export function kokoroDir(userData: string): string {
  return join(userData, 'speech', 'kokoro')
}

/** Absolute path of one pinned asset. */
export function assetPath(userData: string, asset: PinnedAsset): string {
  return join(kokoroDir(userData), asset.name)
}

/**
 * Is the tier usable right now? The CHEAP check — every asset present at exactly its pinned
 * byte length — and it is what `speech:say` and `speech:voices` consult on every call.
 *
 * Deliberately NOT a hash check: verifying 120 MB costs ~0.4s of CPU and would run on every
 * utterance. The hash gate is at INSTALL time, and the atomic rename means a file under its
 * real name was already verified once. Size is then a sufficient liveness test — it catches
 * the realistic corruption (a truncated file from a disk-full or a killed process mid-copy)
 * and the unrealistic one (silent bit rot) is caught by the engine failing to load, which
 * degrades to the system tier exactly like every other failure.
 */
export function isKokoroInstalled(userData: string): boolean {
  return KOKORO_ASSETS.every((asset) => {
    const path = assetPath(userData, asset)
    if (!existsSync(path)) return false
    try {
      return statSync(path).size === asset.bytes
    } catch {
      return false
    }
  })
}

/**
 * The voices the INSTALLED pack actually contains, intersected with the curated English
 * roster (pinned.ts). Not installed ⇒ `[]`, which is the accurate inventory and the state
 * the prefs UI renders "not installed" from.
 *
 * Reads only the pack's local file headers, not its 28 MB of payloads: entries are uniform,
 * so after the first header the next one's offset is known and a 512-byte positional read
 * lands on it. 54 small reads, ~27 KB total.
 *
 * The walk itself lives in `voicePack.ts scanVoiceIds` (with its own scar-tissue note) so it
 * can be unit-tested against an in-memory pack; this is only the file-handle half.
 */
export async function listKokoroVoices(userData: string): Promise<SpeechVoice[]> {
  if (!isKokoroInstalled(userData)) return []
  const path = join(kokoroDir(userData), KOKORO_ASSETS[1].name)
  let handle: FileHandle | null = null
  try {
    const file = await open(path, 'r')
    handle = file
    const size = (await file.stat()).size
    const window = Buffer.alloc(512)
    const ids = await scanVoiceIds(async (offset, length) => {
      const { bytesRead } = await file.read(window, 0, length, offset)
      return window.subarray(0, bytesRead)
    }, size)
    return kokoroVoicesFor(ids)
  } catch {
    return []
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

// ---- the download state machine --------------------------------------------------------

/** Everything provisioning needs from the outside — all injected, so tests need no network. */
export interface ProvisionOptions {
  readonly userData: string
  readonly fetchImpl?: typeof fetch
  readonly onProgress?: (progress: SpeechInstallProgress) => void
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  /**
   * The assets to fetch. Defaults to the real pinned pair; overridden ONLY by
   * tests/speechEngine.test.mts, which drives this state machine end to end — skip, resume,
   * digest mismatch, retry — against kilobyte-sized stand-ins. Without this seam a test could
   * only ever prove the LENGTH check, because it has no way to produce 92 MB of bytes that
   * hash to the pinned digest, and "the sha256 gate works" would go untested forever.
   */
  readonly assets?: readonly PinnedAsset[]
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * The same options plus the DIRECTORY the assets land in.
 *
 * Split out for JOS-274: the VC++ runtime payload is fetched by this exact machinery — one
 * connection, resumable, sha256-gated, atomic, three attempts with backoff — into a different
 * directory. There is one downloader in this app, and one set of scars.
 */
export interface AssetRunOptions extends ProvisionOptions {
  readonly dir: string
}

/** Bookkeeping shared across one install run. */
interface RunState {
  readonly opts: AssetRunOptions
  /** Where this run's assets land (`<userData>/speech/kokoro` for the model). */
  readonly dir: string
  /** Bytes of COMPLETED assets, so per-asset progress can be reported as whole-install. */
  base: number
  /** Sum of every asset's length in THIS run (the real total, or the tests' stand-ins). */
  readonly total: number
  lastEmit: number
}

function emit(run: RunState, progress: SpeechInstallProgress): void {
  run.opts.onProgress?.(progress)
}

/** Hash the bytes already sitting in a `.part`, so a resumed download continues the digest. */
async function seedFromPartial(path: string, hash: ReturnType<typeof createHash>): Promise<number> {
  try {
    const existing = await readFile(path)
    hash.update(existing)
    return existing.length
  } catch {
    return 0
  }
}

/**
 * What a refused response becomes. THE STATUS AND THE SERVER'S CLOCK RIDE ALONG (JOS-420): the
 * sentence is unchanged — it is what the Voice panel renders — but `downloadWithRetries` cannot
 * tell a 429 from a 500 by reading English, and `Retry-After` exists on this response and nowhere
 * after it.
 */
function refusedResponse(run: RunState, asset: PinnedAsset, res: Response): Error {
  const now = (run.opts.now ?? Date.now)()
  return Object.assign(new Error(`HTTP ${String(res.status)} for ${asset.name}`), {
    statusCode: res.status,
    retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after'), now)
  })
}

/**
 * Stream one asset to `<name>.part`, hashing as it goes. Returns the number of bytes now in
 * the part file. Throws on any transport failure — the caller owns the retry policy.
 *
 * `from > 0` asks the server to resume. A server that ignores the Range header and answers
 * 200 is handled by the CALLER (it restarts from zero) rather than by silently appending a
 * full body onto a partial file, which would produce a plausible-looking wrong-length blob.
 */
async function streamAsset(
  run: RunState,
  asset: PinnedAsset,
  from: number,
  hash: ReturnType<typeof createHash>
): Promise<{ bytes: number; restarted: boolean }> {
  const doFetch = run.opts.fetchImpl ?? fetch
  const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'application/octet-stream' }
  if (from > 0) headers.Range = `bytes=${from}-`
  const res = await doFetch(asset.url, { headers })
  if (!res.ok) throw refusedResponse(run, asset, res)
  const restarted = from > 0 && res.status !== 206
  const path = join(run.dir, `${asset.name}.part`)
  const handle = await open(path, restarted || from === 0 ? 'w' : 'a')
  let written = restarted ? 0 : from
  try {
    if (!res.body) throw new Error(`empty body for ${asset.name}`)
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk)
      await handle.write(chunk)
      written += chunk.length
      const at = (run.opts.now ?? Date.now)()
      if (at - run.lastEmit >= PROGRESS_INTERVAL_MS) {
        run.lastEmit = at
        emit(run, {
          engine: 'kokoro',
          phase: 'downloading',
          asset: asset.name,
          received: run.base + written,
          total: run.total
        })
      }
    }
  } finally {
    await handle.close()
  }
  return { bytes: written, restarted }
}

/** One attempt at one asset: resume-or-start, stream, verify, atomically rename. */
async function attemptAsset(run: RunState, asset: PinnedAsset): Promise<void> {
  const dir = run.dir
  const partPath = join(dir, `${asset.name}.part`)
  const hash = createHash('sha256')
  let from = await seedFromPartial(partPath, hash)
  if (from >= asset.bytes) {
    // A `.part` at or past the full length is not resumable — the previous run either
    // finished the bytes but died before verifying, or wrote garbage. Re-verify from zero.
    from = 0
    hash.destroy()
    return attemptFresh(run, asset)
  }
  const { bytes, restarted } = await streamAsset(run, asset, from, hash)
  if (restarted && from > 0) {
    // Server ignored our Range: the digest we seeded is wrong. Start clean rather than ship
    // a file whose hash we cannot honestly compute.
    await rm(partPath, { force: true })
    return attemptFresh(run, asset)
  }
  await finishAsset(run, asset, bytes, hash.digest('hex'))
}

/** An attempt with no resume state at all. Split out so `attemptAsset` stays shallow. */
async function attemptFresh(run: RunState, asset: PinnedAsset): Promise<void> {
  const hash = createHash('sha256')
  const { bytes } = await streamAsset(run, asset, 0, hash)
  await finishAsset(run, asset, bytes, hash.digest('hex'))
}

/** The gate: length, then digest, then — only then — the atomic rename. */
async function finishAsset(
  run: RunState,
  asset: PinnedAsset,
  bytes: number,
  digest: string
): Promise<void> {
  const dir = run.dir
  const partPath = join(dir, `${asset.name}.part`)
  emit(run, {
    engine: 'kokoro',
    phase: 'verifying',
    asset: asset.name,
    received: run.base + bytes,
    total: run.total
  })
  if (bytes < asset.bytes) {
    // SHORT is the resumable case, and the `.part` is deliberately KEPT: a dropped connection
    // at 95% must leave 95% on disk for the next attempt's Range request. (Deleting here is
    // the bug that made "resumable" a comment rather than a behaviour — caught by
    // tests/speechEngine.test.mts, which drives a truncated first response.)
    throw new Error(`${asset.name}: short read, got ${bytes} of ${asset.bytes} bytes`)
  }
  if (bytes > asset.bytes) {
    // LONGER than pinned is not a prefix of anything we want; there is nothing to resume onto.
    await rm(partPath, { force: true })
    throw new Error(`${asset.name}: got ${bytes} bytes, expected ${asset.bytes}`)
  }
  if (digest !== asset.sha256) {
    // A wrong digest is never kept and never resumed from: the bytes are not what this build
    // was verified against, and the next attempt must start from nothing.
    await rm(partPath, { force: true })
    throw new Error(`${asset.name}: sha256 mismatch (got ${digest})`)
  }
  await rename(partPath, join(dir, asset.name))
}

/** Is this asset already on disk, complete and correct? Full hash — this is the slow path
 *  that runs once per install, not the per-utterance check `isKokoroInstalled` does. */
async function alreadyVerified(dir: string, asset: PinnedAsset): Promise<boolean> {
  const path = join(dir, asset.name)
  try {
    if ((await stat(path)).size !== asset.bytes) return false
    const digest = createHash('sha256').update(await readFile(path)).digest('hex')
    return digest === asset.sha256
  } catch {
    return false
  }
}

/**
 * Fetch a list of pinned assets into one directory: skip what is already verified, download the
 * rest one at a time with retries, and report the whole run as one progress stream.
 *
 * THE DIRECTORY IS A PARAMETER SO THERE IS ONLY EVER ONE DOWNLOADER (JOS-274). The VC++ runtime
 * payload is 3 MB rather than 92 and needs none of the resumability — but a second fetcher would
 * be a second place for the etiquette, the digest gate and the atomic rename to be got subtly
 * wrong, and this repo has already priced that lesson elsewhere. It passes `onProgress:
 * undefined` instead, which is what makes its run silent.
 *
 * Never throws: every failure becomes `{ok:false, reason:'engine-not-installed', message}`,
 * because a failed download is a STATE the Voice panel renders, not an exception the IPC
 * layer has to catch (ipc/speech.ts's stub contract, kept verbatim).
 */
export async function provisionAssets(opts: AssetRunOptions): Promise<SpeechInstallResult> {
  const sleep = opts.sleep ?? defaultSleep
  const assets = opts.assets ?? KOKORO_ASSETS
  const total = assets.reduce((n, a) => n + a.bytes, 0)
  const run: RunState = { opts, dir: opts.dir, base: 0, total, lastEmit: 0 }
  emit(run, { engine: 'kokoro', phase: 'checking', received: 0, total })
  try {
    await mkdir(run.dir, { recursive: true })
  } catch (err) {
    return failed(run, `could not create ${run.dir}: ${String(err)}`)
  }

  for (const [index, asset] of assets.entries()) {
    if (await alreadyVerified(run.dir, asset)) {
      run.base += asset.bytes
      continue
    }
    if (index > 0) await sleep(BETWEEN_ASSETS_MS)
    const err = await downloadWithRetries(run, asset, sleep)
    if (err) return failed(run, err)
    run.base += asset.bytes
  }

  emit(run, { engine: 'kokoro', phase: 'done', received: run.total, total: run.total })
  return { ok: true }
}

/**
 * Provision the Kokoro tier. Resolves with the same verdict the progress channel's terminal
 * phase carries — the two never disagree.
 */
export function provisionKokoro(opts: ProvisionOptions): Promise<SpeechInstallResult> {
  return provisionAssets({ ...opts, dir: kokoroDir(opts.userData) })
}

/**
 * Three attempts, exponential backoff — EXCEPT against a rate limit. Returns null on success, else
 * the message the panel shows.
 *
 * WHY THE 429 IS DIFFERENT (JOS-420, the sound-pack installer's ticket, applied to the second
 * downloader). Every other failure here is about these bytes: a 404 on a pinned URL, a digest that
 * does not match, a short read. Three fast attempts is the right answer to all of them, and none of
 * it changes. A 429 is about the CLOCK, and three attempts inside six seconds cannot outlast a
 * window measured in minutes — so it borrows the policy that was written for exactly this:
 * `Retry-After` when the host sent one, an equal-jitter backoff over minutes when it did not, six
 * attempts inside a fifteen-minute horizon, and then an honest sentence.
 *
 * The wait is ANNOUNCED, because this download is 120 MB behind a bar somebody is watching and a
 * bar that is waiting looks exactly like a bar that is stuck. Nothing is lost meanwhile: the
 * partial `.part` is still there and the next attempt resumes onto it.
 */
async function downloadWithRetries(
  run: RunState,
  asset: PinnedAsset,
  sleep: (ms: number) => Promise<void>
): Promise<string | null> {
  let attempts = MAX_ATTEMPTS
  let waitedMs = 0
  for (let attempt = 1; ; attempt++) {
    const failure = await attemptOnce(run, asset)
    if (failure === null) return null
    const plan = nextAssetAttempt(failure.err, attempt, attempts, waitedMs)
    attempts = plan.attempts
    if (!plan.retry) return assetFailureMessage(failure.err)
    if (plan.rateLimited) {
      emit(run, {
        engine: 'kokoro',
        phase: 'waiting',
        asset: asset.name,
        received: run.base,
        total: run.total,
        message: `the download host is busy; retrying in ${String(Math.round(plan.delayMs / 1_000))}s`
      })
    }
    waitedMs += plan.delayMs
    await sleep(plan.delayMs)
  }
}

/** One attempt: null when the asset landed, the failure boxed when it did not. */
async function attemptOnce(
  run: RunState,
  asset: PinnedAsset
): Promise<{ readonly err: unknown } | null> {
  try {
    await attemptAsset(run, asset)
    return null
  } catch (err) {
    return { err }
  }
}

/** The general schedule — three attempts, 2s then 4s, unchanged — EXCEPT against a rate limit,
 *  which hands the decision to the shared policy (its own clock, budget and horizon). */
function nextAssetAttempt(
  err: unknown,
  attempt: number,
  attempts: number,
  waitedMs: number
): PackInstallRetryPlan {
  if (isRateLimitedPackInstall(err)) return planPackInstallRetry({ err, attempt, waitedMs, attempts })
  const retry = attempt < attempts
  return {
    retry,
    delayMs: retry ? RETRY_BASE_MS * 2 ** (attempt - 1) : 0,
    attempts,
    rateLimited: false
  }
}

/** The sentence for one asset's final failure. A rate limit says the true thing — nothing is wrong
 *  with the download and the bytes already fetched are kept — instead of `HTTP 429 for <file>`. */
function assetFailureMessage(err: unknown): string {
  if (isRateLimitedPackInstall(err)) return RATE_LIMITED_TEXT
  return err instanceof Error ? err.message : String(err)
}

function failed(run: RunState, message: string): SpeechInstallResult {
  emit(run, {
    engine: 'kokoro',
    phase: 'failed',
    received: run.base,
    total: run.total,
    message
  })
  return { ok: false, reason: 'engine-not-installed', message }
}
