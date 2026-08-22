// ============================================================================
// outputs/ — the ENGINE that reads EQ `/outputfile` dumps. Public surface.
// ============================================================================
//
// Five pieces, deliberately separable:
//   shared/outputs/kinds.ts  the FACTS: which kinds exist, the command, the why-clause, the
//                            filename pattern, and which ones we may parse (the no-guessing law).
//   kinds.ts                 the PARSE half of that registry (parsers are main's).
//   discovery.ts             finding a kind's file under `effectiveEqRoot()`.
//   watch.ts                 the shared "a dump was rewritten"/"a dump appeared" watchers.
//   registry.ts              the RUNTIME registry: status (path + the player's own mtime) and
//                            the one watch entry point every consumer uses.
//   inventoryParse.ts        the one graduated kind's pure parser (model: shared/outputs/inventory.ts).
//
// NOTHING IS PERSISTED FROM HERE. Dumps are parsed on demand and held in memory by their caller.
// The only persisted artifact remains the flat `HeldCounts` map the reconcile surfaces already
// store (`store.ts setInventory`, `ProgressState.inventory`) — see the note on
// `loadInventoryDump` below.

import { readFileSync } from 'fs'
import type { InventoryDump } from '../../shared/outputs/inventory'
import {
  classUnlockClaims,
  type AchievementsSource,
  type ClassUnlockClaim
} from '../../shared/outputs/achievements'
import type { OutputKindId } from '../../shared/outputs/kinds'
import { parseOutput, type OutputParseResult } from './kinds'
import { outputStatus, type OutputCharacter } from './registry'

export { findOutputFile } from './discovery'
export { watchForOutputFile, watchOutputFile, type OutputWatchHandlers } from './watch'
export { inventoryHeldCounts, parseInventoryDump } from './inventoryParse'
export {
  outputStatus,
  outputStatuses,
  watchOutputKind,
  type OutputCharacter,
  type OutputKindWatch,
  type OutputWatchOptions
} from './registry'
export {
  isOutputFileName,
  outputFileNames,
  OUTPUT_KINDS,
  outputKind,
  parseOutput,
  preferredOutputFile,
  type AchievementsOutput,
  type InventoryOutput,
  type OutputData,
  type OutputFileStatus,
  type OutputKindDef,
  type OutputKindId,
  type OutputParseResult
} from './kinds'

/** A dump that was found on disk, with whatever the registry made of it. */
export interface LoadedOutput {
  kind: OutputKindId
  path: string
  /** The file's mtime — when the PLAYER produced the dump, not when we read it. */
  loadedAt: string
  result: OutputParseResult
}

/**
 * Find + read + parse a kind's dump for a character. Null when there is no such file.
 *
 * The find + the mtime both come from `outputStatus`, so "where is it" and "how old is it" have
 * exactly ONE answer in this process — the same one the UI's freshness line is rendering.
 */
export function loadOutput(
  id: OutputKindId,
  characterName?: string,
  server?: string
): LoadedOutput | null {
  const character: OutputCharacter = { name: characterName, server }
  const status = outputStatus(id, character)
  if (status.path === null || status.updatedAt === null) return null
  return {
    kind: id,
    path: status.path,
    loadedAt: status.updatedAt,
    result: parseOutput(id, readFileSync(status.path, 'utf8'))
  }
}

/** The deep inventory model for a character's newest dump. */
export interface LoadedInventoryDump {
  path: string
  loadedAt: string
  dump: InventoryDump
}

/**
 * Load + parse the character's inventory dump into the DEEP model.
 *
 * PERSISTENCE (decided this wave, deliberately): the dump is NOT written to the store. It
 * is ~256 rows of nested objects derived from a file that is already on disk and re-read in
 * milliseconds, it has no consumer that outlives the process, and the store-migration law
 * (`storeMigrations.ts`) means every persisted shape is owed a migration step forever. A
 * key nobody reads is pure migration debt. When a surface finally needs it across restarts,
 * it lands as an ADDITIVE key with a defaulting reader plus its migration step, in the same
 * commit — until then, parse on demand.
 */
export function loadInventoryDump(
  characterName?: string,
  server?: string
): LoadedInventoryDump | null {
  const loaded = loadOutput('inventory', characterName, server)
  if (!loaded) return null
  const { result } = loaded
  // The registry types this narrowing honestly: an unsupported kind never yields data.
  if (!result.ok || result.data.kind !== 'inventory') return null
  return { path: loaded.path, loadedAt: loaded.loadedAt, dump: result.data.dump }
}

/** The achievements dump's earned class-unlock rewards, plus the record of where they came from. */
export interface LoadedAchievements {
  path: string
  /** The earned `Obtain <Item>` rows — the flat artifact that gets persisted (JOS-429). */
  unlocks: ClassUnlockClaim[]
  /** Exactly what gets persisted as `ProgressState.achievementsSource`. */
  source: AchievementsSource
}

/**
 * Load + parse the character's achievements dump into the EARNED class-unlock claims (JOS-429).
 *
 * THE FLAT ARTIFACT, not the dump — the `loadInventory` arrangement one file over, and for the
 * identical reason. The parsed dump is 1,857 rows of which this app reads 95, it has no consumer
 * that outlives the process, and the store-migration law makes every persisted shape a debt
 * forever. So the projection is taken HERE, at the one place the file becomes the model, and the
 * rows themselves are dropped.
 *
 * `now` is injected for the same reason `loadInventory`'s is: a test that pins the record should
 * not have to pin a clock.
 */
export function loadAchievements(
  characterName?: string,
  server?: string,
  now: () => number = Date.now
): LoadedAchievements | null {
  const loaded = loadOutput('achievements', characterName, server)
  if (!loaded) return null
  const { result } = loaded
  if (!result.ok || result.data.kind !== 'achievements') return null
  return {
    path: loaded.path,
    unlocks: classUnlockClaims(result.data.dump),
    // `loadedAt` is the FILE's mtime (when the player typed the command) and `readAt` is ours —
    // the JOS-253 pair, kept because a single timestamp cannot answer both questions.
    source: { path: loaded.path, loadedAt: loaded.loadedAt, readAt: now() }
  }
}
