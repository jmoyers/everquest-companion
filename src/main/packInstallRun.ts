// ============================================================================
// packInstallRun.ts — ONE retry loop for pack installs, for BOTH callers (JOS-307).
// ============================================================================
//
// THE ASYMMETRY THIS DELETES. There were two ways a sound pack got installed and they disagreed
// about everything that matters when the network is having a bad day:
//
//   * startup provisioning (`provisionPacks.ts`) retried three times with backoff, and filed an
//     ERROR for every attempt — three store rows per failed launch, forever, on a machine that
//     simply cannot reach GitHub;
//   * the registry browser (`ipc/sounds.ts`) did not retry AT ALL, and filed one row whose message
//     was `install '<name>' failed` with the cause thrown away.
//
// Neither behaviour was chosen; they were written months apart. So the loop lives once, here, and
// both callers get the same three things: bounded retries on failures a retry could plausibly fix,
// ONE routed log line per attempt (`packInstallLog.ts` decides warn vs error), and a bounded
// sentence naming the cause handed back for the UI to render.
//
// AND THE LOOP ITSELF MOVED OUT (JOS-420). It is `runPackInstallAttempts` in
// `shared/packInstall.ts` now — pure, with the install, the sleep and the randomness handed in —
// because a rate limit's schedule is measured in MINUTES and a test must be able to state fifteen
// of them without living through them. What is left in this file is the I/O: the real installer,
// the real timer, the two log sinks, and the one thing neither of the other two could know — that
// a wait is worth telling the person who clicked Install about.

import { logError, logWarn } from './errorLog'
import { installPack } from './packRegistry'
import { logPackInstallFailure, type PackInstallLogSinks } from './packInstallLog'
import {
  MAX_INSTALL_ATTEMPTS,
  runPackInstallAttempts,
  type PackInstallRunResult
} from '../shared/packInstall'
import type { PackInstallProgress, RegistryPack } from '../shared/types'

/** The two sinks, named once. Same handover as `updater.ts`'s `LOG_SINKS`, same reason. */
const LOG_SINKS: PackInstallLogSinks = { error: logError, warn: logWarn }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export type { PackInstallRunResult }

/** "In 3m 20s", for the waiting line. Seconds under a minute, m/s above it — nobody needs "200s". */
function humanWait(ms: number): string {
  const secs = Math.max(1, Math.round(ms / 1_000))
  if (secs < 60) return `${String(secs)}s`
  const mins = Math.floor(secs / 60)
  const rest = secs % 60
  return rest === 0 ? `${String(mins)}m` : `${String(mins)}m ${String(rest)}s`
}

/**
 * Install a pack, retrying only what a retry could fix.
 *
 * A NON-TRANSIENT FAILURE STOPS IMMEDIATELY and is reported as final on its first attempt —
 * `packInstallFailureLine` then says `attempt 1/3`, which is the honest reading: the budget was
 * three and we spent one because the second would have asked the same question and got the same
 * 404. See `shared/packInstall.ts` for why the default is "not transient", and for why a 429 is
 * the one class that gets a longer budget and a slower clock than everything else here.
 *
 * A RATE-LIMITED WAIT IS SAID OUT LOUD. The registry browser's install has a person watching it,
 * and the difference between a progress bar that has stopped and a progress bar that is waiting
 * out a rate limit is the entire difference between "this app is broken" and "the host is busy" —
 * so the wait gets its own phase and names its own length. Provisioning passes a sink that
 * swallows it, exactly as it swallows every other phase.
 */
export async function installPackWithRetry(
  pack: RegistryPack,
  onProgress: (p: PackInstallProgress) => void,
  opts?: { readonly targetRoot?: string; readonly attempts?: number }
): Promise<PackInstallRunResult> {
  return runPackInstallAttempts({
    install: () => installPack(pack, onProgress, opts?.targetRoot),
    sleep,
    attempts: Math.max(1, opts?.attempts ?? MAX_INSTALL_ATTEMPTS),
    onFailure: (info) => {
      logPackInstallFailure(
        {
          pack: pack.name,
          attempt: info.attempt,
          attempts: info.attempts,
          final: info.final,
          err: info.err
        },
        LOG_SINKS
      )
      if (info.final) return
      onProgress({
        name: pack.name,
        phase: 'waiting',
        retryable: true,
        message: info.rateLimited
          ? `Download host is busy - retrying in ${humanWait(info.delayMs)}`
          : `Retrying in ${humanWait(info.delayMs)}`
      })
    }
  })
}
