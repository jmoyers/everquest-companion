// ============================================================================
// outputs/registry.ts — the RUNTIME registry: one treatment for every `/outputfile` kind.
// ============================================================================
//
// JOS-44. The app leans on EQ's export commands (`/outputfile inventory` today, more next), and
// every surface fed by one owes the player the same three things: the command to run, one clause
// of why, and how old the data is — plus live pickup the moment the game rewrites the file.
// Before this the pieces existed but were scattered: main knew how to find and watch a file,
// each surface hand-typed its own command string, and only the two inventory call sites knew how
// to answer "when".
//
// SO THE FACTS AND THE DISK ARE ONE REGISTRY, IN TWO HALVES:
//   shared/outputs/kinds.ts   the FACTS — command, why-clause, filename pattern, supported.
//   this file                 the DISK — does it exist, when did the player last write it,
//                             and the watcher that notices the next rewrite.
//
// `OutputFileStatus` is what those two halves join into, and it is the ONLY thing that crosses
// IPC (`ipc/outputs.ts`). A renderer therefore never learns a path rule, never re-types a
// command, and never has to decide what "fresh" means.
//
// NOTHING IS CACHED HERE, deliberately. A status is one `readdir` + one `stat` over a directory
// the player rewrites mid-session on purpose; a cache would answer with the state from before
// they typed the command, which is the exact failure this whole ticket is about.

import { statSync } from 'fs'
import {
  outputFileStatus,
  outputKind,
  OUTPUT_KINDS,
  type OutputFileStatus,
  type OutputKindDef,
  type OutputKindId
} from '../../shared/outputs/kinds'
import { effectiveEqRoot } from '../log/config'
import { findOutputFile } from './discovery'
import { watchForOutputFile, watchOutputFile } from './watch'
import type { FSWatcher } from 'chokidar'

/** Whose dumps we are asking about. Both parts optional — an unknown character still resolves
 *  to "the newest file of this kind", which is what a one-character machine always has. */
export interface OutputCharacter {
  name?: string
  server?: string
}

/** The file's mtime as an ISO string, or null when it is gone between the listing and the stat. */
function mtimeIso(path: string): string | null {
  try {
    return new Date(statSync(path).mtimeMs).toISOString()
  } catch {
    // The dump was deleted (or the drive vanished) in the microseconds since discovery listed
    // it. That is "no dump", not an error to render.
    return null
  }
}

/** Join one kind's facts to the file on disk. `path: null` ⇒ the command has never been run. */
export function outputStatus(id: OutputKindId, character?: OutputCharacter): OutputFileStatus {
  const def = outputKind(id)
  const path = findOutputFile(id, character?.name, character?.server)
  const updatedAt = path === null ? null : mtimeIso(path)
  // A path whose stat failed is a file that is no longer there — `outputFileStatus` then reports
  // neither half of it, which is the never-run state and not a half-known file.
  return outputFileStatus(def, path !== null && updatedAt !== null ? { path, updatedAt } : null)
}

/** Every kind's status, in registry order. The one payload `IPC.outputsStatus` answers with. */
export function outputStatuses(character?: OutputCharacter): OutputFileStatus[] {
  return OUTPUT_KINDS.map((def) => outputStatus(def.id, character))
}

export interface OutputWatchOptions {
  /** The dump was (re)written and has settled. */
  onChange: () => void
  /** The watcher itself failed (permissions, the file vanished, …). */
  onError: (err: unknown) => void
  /**
   * Is this watch's subject still current? Checked before EVERY re-arm and every `onChange`, so a
   * watcher that outlives a character switch goes quiet instead of reporting the old character's
   * dump. Defaults to "always" for a caller with nothing to go stale.
   */
  active?: () => boolean
}

/** A live watch on one kind. The caller owns the lifecycle — only it knows when its subject changed. */
export interface OutputKindWatch {
  close: () => void
}

/**
 * Watch one kind's dump for this character, covering BOTH the rewrite and the very first write.
 *
 * TWO WATCHERS, ONE SLOT (owner, 2026-08-05: "type the command, watch it fill"). A character with
 * a dump gets the FILE watched. A character with NO dump has nothing to point a file watcher at,
 * so the install ROOT is watched for one to APPEAR — and that is exactly the player a surface's
 * instructions card is talking to. The appearance re-arms this watch, which then finds the file
 * and switches to watching it.
 *
 * Lifted verbatim (behavior-for-behavior) out of session.ts's inventory watcher in JOS-44, so
 * every future kind inherits the covered first-write instead of re-deriving it.
 *
 * ---------------------------------------------------------------------------------------------
 * TWO WATCHERS, AND THE DIRECTORY ONE NO LONGER STANDS DOWN (JOS-431).
 *
 * It used to be an EITHER/OR: a file matched ⇒ watch the file, nothing matched ⇒ watch the
 * directory. Both halves of that were holes, and one report (01M0FMGA4DQRMG46290GWVVHQ6) sat in
 * the first of them:
 *
 *   A REWRITE CAN DESTROY THE FILE WE ARE WATCHING. A writer that replaces rather than truncates
 *   produces `unlink` + `add`, so the file watcher's subject stops existing mid-session and the
 *   next dump is invisible until the app is restarted — which is what the reporter did, and what
 *   they should not have had to do. (watch.ts now raises both events; this is the other half.)
 *
 *   A FALLBACK MATCH IS NOT THIS CHARACTER'S FILE. `preferredOutputFile` falls back to the newest
 *   dump of the kind belonging to ANYBODY (kinds.ts — it is the right answer for a one-character
 *   machine and a guess everywhere else). A watch armed on that file never notices the active
 *   character's own dump appearing under its own name, because that is an `add` of a DIFFERENT
 *   path and nothing was listening to the directory any more.
 *
 * So the directory watcher is armed for the whole life of the watch, beside the file watcher
 * rather than instead of it, and its `onChange` re-arms the file half onto whatever discovery now
 * prefers. One mechanism covers all three cases — the first-ever write, the recreated file, and
 * the character's own dump arriving late — instead of three conditions to keep in step.
 *
 * THE COST IS ONE EXTRA DEPTH-0 WATCHER on a directory this app already watches on every
 * never-run machine, and the duplicate reload it can produce (the directory sees the same `add`
 * the file watcher does) is one re-read of a file we would have re-read anyway: `outputStatus`
 * caches nothing and `loadInventory` is a parse, not a mutation.
 */
export function watchOutputKind(
  id: OutputKindId,
  character: OutputCharacter,
  opts: OutputWatchOptions
): OutputKindWatch {
  const def: OutputKindDef = outputKind(id)
  const active = opts.active ?? ((): boolean => true)
  // The file half — re-armed whenever the subject changes. The directory half below is armed ONCE
  // and outlives every re-arm, so there is no window in which nobody is watching the root for the
  // dump to come back.
  let fileWatcher: FSWatcher | null = null

  const armFile = (announce = false): void => {
    void fileWatcher?.close()
    fileWatcher = null
    const path = findOutputFile(id, character.name, character.server)
    if (path === null) return
    fileWatcher = watchOutputFile(path, {
      onChange: () => {
        if (active()) opts.onChange()
      },
      // The file was deleted. Re-arm — either the replacement is already on disk (and it must be
      // ANNOUNCED from here, see below) or it is not, in which case the directory watcher below is
      // the one that will see it arrive.
      onGone: () => {
        if (active()) armFile(true)
      },
      onError: opts.onError
    })
    // THE GONE-AND-ALREADY-BACK CASE (JOS-431 audit fix). When the re-arm after an `unlink` finds
    // the replacement on disk, NO future event will announce it: the fresh watcher was armed on an
    // existing file (`ignoreInitial` ⇒ no `add`), and a fast replace reaches the directory watcher
    // as a `change` it deliberately does not subscribe to (tests/outputsWatch.test.mts measured
    // both). The original shape waited for "the settled add that follows" — which is exactly the
    // event that never comes, and the sky-inventory-autoload e2e caught it the moment a second
    // directory watcher (JOS-429's achievements kind) shifted chokidar off the lucky
    // collapse-to-`change` path. So the announcer is this re-arm itself, delayed past
    // `awaitWriteFinish`'s 400 ms stability window so the read sees a whole file; a duplicate
    // reload if the directory watcher DOES also report it is the cost the header above already
    // accepts ("one re-read of a file we would have re-read anyway").
    if (announce) {
      setTimeout(() => {
        if (active()) opts.onChange()
      }, 600)
    }
  }

  const dirWatcher = watchForOutputFile(effectiveEqRoot(), def, {
    onChange: () => {
      if (!active()) return
      // Re-arm FIRST: whatever just appeared may be a better answer than what we were watching,
      // so discovery runs before the consumer is told to read.
      armFile()
      opts.onChange()
    },
    onError: opts.onError
  })

  armFile()
  return {
    close: () => {
      void fileWatcher?.close()
      fileWatcher = null
      void dirWatcher.close()
    }
  }
}
