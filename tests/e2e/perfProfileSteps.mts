/**
 * perfProfileSteps.mts — the FILE half of the Performance spec: everything asserted about
 * <userData>/perf-startup.json once the app that wrote it has exited.
 *
 * SPLIT OUT of tests/e2e/perf.e2e.mts when JOS-57's scope addition (the stutter probe and the
 * cold-read delta) pushed that file past the repo's 400-code-line ceiling — a split, not a widened
 * threshold, and along a seam the spec already had: what stays there DRIVES A WINDOW, what lives
 * here READS A FILE. tests/e2e/buffRestartSteps.mts is the precedent for a spec's steps living in
 * a module beside it.
 *
 * IDENTITIES ONLY, never today's numbers: a launch is asserted to have STATED its measurements and
 * to have stated them consistently. How blocked, or how stuttery, one machine got is the bench's
 * question (npm run bench:replay) against a known log on one machine — never a spec's.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { check } from './appHarness.mjs'

/**
 * The strictly-sequential head of the boot, asserted as a LIST: a profile whose phases arrived
 * in a different order would still be "monotonic" by timestamp alone, so the order is checked
 * as well as the timestamps.
 */
const SEQUENTIAL_PHASES = [
  'storeLoaded',
  'dataLoaded',
  'appReady',
  'protocols',
  'windowCreated',
  'tailAttached'
]
/** …and the tail, which RACES: the window paints while the historical scan is still folding, so
 *  either of these can land first depending on how much log there is. */
const CONCURRENT_PHASES = ['replayDone', 'rendererHydrated']

interface Phase {
  phase: string
  atMs: number
  durationMs: number
}
interface BlockStats {
  samples: number
  maxBlockMs: number
  blocksOver50Ms: number
}
/** What the duty-cycled replay spent, as the profile states it (JOS-50). */
interface ReplayStats {
  slices: number
  workMs: number
  restMs: number
}
/** The system-stutter proxy's own answer (JOS-57 scope addition), in milliseconds. */
interface StutterStats {
  samples: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  lateTicks: number
  latePct: number
}
interface Profile {
  startedAt: number
  version: string
  phases: Phase[]
  totalMs: number
  eventsReplayed?: number
  block?: BlockStats
  replay?: ReplayStats
  stutter?: StutterStats
  newBytes?: number
  firstMbMs?: number
  complete: boolean
}
/** THE FILE. Written on every launch, HUD or no HUD — this is the "the launch you wish you had
 *  profiled is the one that already happened" promise, asserted against real bytes. */
export function stepProfileFile(userData: string, firstRun: boolean): void {
  const path = join(userData, 'perf-startup.json')
  let profile: Profile | null = null
  try {
    profile = JSON.parse(readFileSync(path, 'utf8')) as Profile
  } catch (err) {
    check('every launch writes <userData>/perf-startup.json', false, String(err))
    return
  }
  if (!check('every launch writes <userData>/perf-startup.json', profile.phases.length > 0)) return

  const names = profile.phases.map((p) => p.phase)
  check(
    'it records the sequential half of the boot, in order',
    JSON.stringify(names.slice(0, SEQUENTIAL_PHASES.length)) === JSON.stringify(SEQUENTIAL_PHASES),
    names.join(' → ')
  )
  check(
    '…and both of the phases that race, in whichever order this launch produced',
    [...names.slice(SEQUENTIAL_PHASES.length)].sort().join(',') === [...CONCURRENT_PHASES].sort().join(','),
    names.slice(SEQUENTIAL_PHASES.length).join(' → ')
  )
  const marks = profile.phases.map((p) => p.atMs)
  check(
    'the phase marks are MONOTONIC — no phase lands before the one it follows',
    marks.every((at, i) => i === 0 || at >= (marks[i - 1] ?? 0)),
    marks.map((m) => Math.round(m)).join(', ')
  )
  const summed = profile.phases.reduce((n, p) => n + p.durationMs, 0)
  check(
    'the durations account for the whole launch, exactly (nothing is NaN or negative)',
    profile.phases.every((p) => Number.isFinite(p.durationMs) && p.durationMs >= 0) &&
      Math.abs(summed - profile.totalMs) < 1,
    `Σ ${String(Math.round(summed))}ms vs total ${String(Math.round(profile.totalMs))}ms`
  )
  check('…and states the launch it describes', profile.complete && profile.startedAt > 0, JSON.stringify({ complete: profile.complete, startedAt: profile.startedAt }))
  // ── THE FOUR FOLD MEASUREMENTS RETIRE HERE (JOS-499) ────────────────────────────────────────
  //
  // `eventsReplayed`, the duty ledger, the block probe and the stutter probe were four readings of
  // ONE subject: what THIS PROCESS'S historical fold cost, and what it did to the app's own
  // responsiveness while it ran. That fold is deleted. None of these is weakened by the change —
  // each is unstatable, and asserting them against a launch that folds nothing would pin zeroes.
  //
  // THE PROBES ARE THE SUBTLE ONES AND ARE WORTH THE PARAGRAPH. Both bracketed
  // `appReady → replayDone`, which WAS the fold — seconds long on a real log, which is what made
  // "a window that banked no ticks means a probe that never ran" a sound inference. That window is
  // now the tail of boot: ~450 ms, most of it the synchronous dump loads, and a run measured ZERO
  // ticks in it legitimately. The question they asked — did the app stay responsive while it read
  // months of log — has no answer in this process, because reading the log is not something it
  // does. The LIVE probes that take over at `replayDone` (JOS-367) are where main's responsiveness
  // is measured now, and they are not this file's subject.
  //
  // WHAT REPLACES THEM IS NOT NOTHING. The fold still happens and is still measured — by the
  // process that performs it (owner ruling 19). `stepColdRead` below is untouched, and the engine's
  // own fold report is asserted by `engine-boots.e2e.mts`, which reads the health mark: the event
  // count and the byte offset it reached, the same claim `eventsReplayed` made about the same log.
  stepColdRead(profile, firstRun)
}




/**
 * THE COLD-READ HALF (JOS-57 scope addition) — and the assertion that matters is about the FIRST
 * launch, which is the one case a fleet reading could most easily fake.
 *
 * A fresh userData has no mark from a previous clean shutdown, so "how many bytes were new" has no
 * answer, and the profile must say nothing rather than 0. A SECOND launch against the same
 * userData is the other half of the loop and is asserted by the caller re-running this spec's
 * launch — see `main()`.
 */
function stepColdRead(profile: Profile, firstRun: boolean): void {
  // ── THE FIFTH FOLD MEASUREMENT, AND IT RETIRES WITH THE OTHER FOUR (JOS-499) ────────────────
  //
  // `newBytes` answered "how much of this launch's read was bytes appended since our last clean
  // exit" — the cold-disk discriminator (JOS-57). It was computed as `newBytesSince(mark, size)`
  // against THE TAIL MARK this process wrote on its way out, and boundary verdict 4 gave the tail
  // to the engine: "the log tail mark — the engine owns the tail". `markTailPosition` is deleted,
  // so nothing app-side writes a mark and nothing can subtract two of them.
  //
  // BOTH ARMS GO, not just the second. The first-run arm asserted the ABSENCE, which now holds
  // trivially and for the wrong reason — it would pass on a launch that had simply stopped
  // measuring, which is exactly the failure this whole file exists to catch. An assertion that
  // cannot fail is worse than none.
  //
  // THE FIRST-MEGABYTE HINT BELOW SURVIVES as a shape check only, and is left standing for the
  // same reason `stepProfileFile` keeps its phase assertions: it is a claim about the profile's
  // internal consistency rather than about a fold.
  void firstRun
  // The cold-disk hint is only asked of a log at least a megabyte long, so its ABSENCE is correct
  // on a fixture and only its sanity can be pinned here.
  check(
    'the first-megabyte hint is a duration when it is there at all, never a negative or a NaN',
    profile.firstMbMs === undefined || (Number.isFinite(profile.firstMbMs) && profile.firstMbMs >= 0),
    `firstMbMs ${String(profile.firstMbMs)}`
  )
}





