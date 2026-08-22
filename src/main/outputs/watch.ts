// ============================================================================
// outputs/watch.ts — the shared watcher layer for `/outputfile` dumps.
// ============================================================================
//
// EQ REWRITES a dump file wholesale every time the player runs `/outputfile <kind>`, so the
// interesting event is "the file settled after a rewrite", not "a byte changed". That is
// what `awaitWriteFinish` buys: chokidar holds the change until the size has been stable
// for `stabilityThreshold` ms, so a consumer never reads a half-written table.
//
// The numbers below were the inventory watcher's from the day it shipped (session.ts) and
// are preserved exactly — this module is a generalization of that watcher, not a retune.
// One place to change them means every future kind inherits the same settle behavior.

import { watch, type FSWatcher } from 'chokidar'
import { basename } from 'path'
import { isOutputFileName, type OutputKindDef } from '../../shared/outputs/kinds'

/** Hold a change until the file has been the same size for this long (ms). */
const STABILITY_THRESHOLD_MS = 400
/** How often to re-check the size while waiting (ms). */
const POLL_INTERVAL_MS = 100

export interface OutputWatchHandlers {
  /** The file finished being rewritten. */
  onChange: () => void
  /**
   * The watched file VANISHED (JOS-431). Optional, and only the single-file watcher can raise it:
   * a caller that owns a re-arm uses this to point the watch at whatever is there now, instead of
   * holding a watcher whose subject no longer exists.
   */
  onGone?: () => void
  /** The watcher itself failed (permissions, the file vanished, …). */
  onError: (err: unknown) => void
}

/**
 * Watch ONE dump file for rewrites. Returns the watcher so the owner can close it —
 * ownership of the lifecycle stays with the caller (session.ts closes on character switch
 * and on quit), because only the caller knows when its subject changed.
 *
 * A REWRITE IS NOT ALWAYS A `change` (JOS-431), AND WHICH EVENT IT IS IS NOT OURS TO PREDICT.
 * This subscribed to `change` alone. A writer that REPLACES the dump rather than truncating it
 * deletes and recreates, and what chokidar makes of that is decided inside chokidar: measured on
 * the dev machine (tests/outputsWatch.test.mts) the deletion arrives as `unlink` and the return as
 * a `change`, because chokidar re-arms on a vanished file by itself — but that re-arm is
 * conditional on its own internal state and on the platform's file-watching primitives, which is
 * precisely the kind of thing that holds here and not on a reporter's machine.
 *
 * And a reporter is where this came from: they re-ran `/outputfile inventory`, the file on disk
 * was fresh (their log named the write to the second and the attached dump's mtime matched it),
 * and the running app kept showing a days-old timestamp until it was restarted (report
 * 01M0FMGA4DQRMG46290GWVVHQ6, v1.6.0).
 *
 * So all three events are wired and the guess is gone. The settle behavior covers `add` exactly
 * as it covers `change` — chokidar's `awaitWriteFinish` holds either one until the size stops
 * moving — so a recreated dump is read once, whole, and never half-written.
 */
export function watchOutputFile(path: string, handlers: OutputWatchHandlers): FSWatcher {
  const watcher = watch(path, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: STABILITY_THRESHOLD_MS,
      pollInterval: POLL_INTERVAL_MS
    }
  })
  watcher.on('change', handlers.onChange)
  // The recreated file, settled. `ignoreInitial` means this can only be a file that came BACK, so
  // it is news by definition — there is no first-sight `add` to filter out here.
  watcher.on('add', handlers.onChange)
  // …and the half of the pair that arrives first. The caller re-arms; this watcher's own fs handle
  // was opened on a file that is gone, and whether it survives the deletion is a platform detail
  // we would rather not bet the player's data freshness on.
  watcher.on('unlink', () => {
    handlers.onGone?.()
  })
  watcher.on('error', handlers.onError)
  return watcher
}

/**
 * Watch a DIRECTORY for a kind's dump to APPEAR — the other half of "type the command and watch
 * it fill" (owner, 2026-08-05).
 *
 * `watchOutputFile` needs a path, so a character who has never run `/outputfile <kind>` had
 * nothing to watch and their first dump was invisible until the next launch. That is precisely
 * the player the Planner's instructions card is talking to. This covers them: depth 0 (the dump
 * lives in the install root beside a great many files we do not care about), the same settle
 * behavior, and `add` filtered by the kind's own filename suffix.
 *
 * The caller re-arms the file watcher from `onChange`. SINCE JOS-431 IT IS NOT ONLY THE NEVER-RUN
 * CASE: this stays armed beside the file watcher for the whole life of a watch, because "a dump of
 * this kind appeared" is also what a delete-and-recreate rewrite looks like from outside, and what
 * the active character's OWN dump looks like when the file watcher is parked on somebody else's
 * (registry.ts states both arguments).
 */
export function watchForOutputFile(
  dir: string,
  def: OutputKindDef,
  handlers: OutputWatchHandlers
): FSWatcher {
  const watcher = watch(dir, {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: {
      stabilityThreshold: STABILITY_THRESHOLD_MS,
      pollInterval: POLL_INTERVAL_MS
    }
  })
  watcher.on('add', (path: string) => {
    if (isOutputFileName(def, basename(path))) handlers.onChange()
  })
  watcher.on('error', handlers.onError)
  return watcher
}
