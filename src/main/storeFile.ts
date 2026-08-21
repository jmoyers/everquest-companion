// storeFile.ts — the store file ON DISK: read it, quarantine it, salvage it, write it back.
//
// SPLIT OUT OF storeMigrations.ts (JOS-272), which was sitting at 399 of the repo's 400 code-line
// ceiling before this ticket added a recovery path to it. The cut is the one that module's own
// header already describes: a PURE runner over plain objects on one side (`migrateStoreData`, the
// chain, every step), and the file I/O on the other. Nothing moved but the file half; the imports go
// ONE WAY (this file → storeMigrations) so there is no cycle to reason about at module-init time,
// which matters more here than usual because `store.ts` calls into this from module scope.
//
// FAILURE POLICY (the whole of it — storeMigrations.ts's header states the rest of the contract):
//   * unreadable file  → leave it alone, no stamp (electron-store will raise its own error)
//   * unparseable file → QUARANTINE it to `<name>.corrupt.json`, then TRY TO SALVAGE it (below)
//     and only start fresh if nothing could be recovered. conf's `clearInvalidConfig` defaults to
//     false, so a truncated write (power loss mid-save, an update's force-quit) otherwise throws on
//     EVERY read forever — an app bricked by one bad byte.
//   * a step throws    → keep everything the earlier steps produced, stamp the last version that
//     fully succeeded, log, and retry the failing step on the next launch.
//   * newer than we know → see the downgrade note on `migrateStoreData`.
// Before the FIRST write of a run the original file is copied byte-for-byte to
// `<name>.v<from>.backup.json` (written once per source version — a later run never overwrites the
// pristine copy). At most one small file per schema version the machine has ever held: cheap
// insurance for a promise that has to hold forever, and since JOS-272 a recovery source as well.
//
// EVERY WRITE HERE IS ATOMIC (JOS-272), and it was not. A bare `writeFileSync` onto `<name>.json`
// was the ONE non-atomic write to the settings file anywhere in this app: electron-store's own
// `set` has gone through `atomically` (temp + fsync + rename) since conf 10, which is worth
// stating plainly because "add atomic saves to the store" is the obvious fix and it would have been
// a second, redundant, competing writer. What was actually missing was this module's own writes and
// the RECOVERY below them.

import { existsSync, readdirSync, readFileSync, renameSync } from 'fs'
import { basename, dirname, join } from 'path'
// THE ATOMIC WRITE, REUSED RATHER THAN RE-SPELLED (JOS-272). `telemetry/durableWrite.ts` imports
// `node:fs` and nothing else — no Electron, no app paths, no logger — which is exactly the property
// that makes it safe to call from a module that runs before `app.ready`. It lives under
// `telemetry/` because that is who needed it first; a second copy of temp+fsync+rename here would
// be a second answer to a question this repo has already answered once and tested (JOS-265,
// tests/telemetryRingDurability.test.mts).
import { writeFileDurable } from './telemetry/durableWrite'
// AND THE TORN-BYTE SCANNER IS SHARED NOW (JOS-419). The salvage below was written here first; the
// resist ledger then needed the same reasoning about the same failure, so the pure string half —
// de-padding, the balanced-prefix scan, the parse-if-acceptable wrapper, the `.corrupt.json` name —
// moved to `tornJson.ts` verbatim and both callers read it from there. The POLICY (what counts as
// this app's store, and the ladder that falls back to a backup) stayed here, where it belongs.
import { quarantinePathFor, salvageJsonObject } from './tornJson'
import {
  CURRENT_SCHEMA_VERSION,
  SCHEMA_VERSION_KEY,
  isPlainObject,
  migrateStoreData,
  type MigrationOutcome,
  type StoreData
} from './storeMigrations'

export interface MigrationHooks {
  info?: (message: string) => void
  error?: (message: string) => void
}

export interface StoreFileMigration extends MigrationOutcome {
  path: string
  /** Where the pristine pre-migration copy went (absent ⇒ nothing needed backing up). */
  backupPath?: string
  /** Whether the migrated data was written back. */
  wrote: boolean
  /** No store file yet — a fresh install. Nothing to migrate; the store starts CURRENT. */
  fileMissing: boolean
  /** The file was unparseable and was moved aside. Unless `salvagedFrom` is set too, the store
   *  starts CURRENT and empty. */
  quarantinedPath?: string
  /** Set when a quarantined store was RECOVERED rather than abandoned (JOS-272). */
  salvagedFrom?: SalvageSource
  /** The file exists but could not be read. Nothing was touched and nothing may be stamped. */
  readError?: string
}

/**
 * Where a recovered store came from. Reported (and logged) because the two are worth telling apart:
 * `torn-bytes` is the user's OWN latest settings, read out of the file that failed to parse;
 * `backup` is an older but complete copy this module wrote itself at some past schema upgrade.
 */
export type SalvageSource = 'torn-bytes' | 'backup'

/** `…/x.json` → `…/x.v3.backup.json` — one per source version, self-describing, bounded. */
export function backupPathFor(storePath: string, fromVersion: number): string {
  const stem = storePath.replace(/\.json$/i, '')
  return `${stem}.v${fromVersion}.backup.json`
}

/** `…/x.json` → `…/x.corrupt.json`. Re-exported from `tornJson.ts`, where it moved with the rest of
 *  the torn-file mechanics (JOS-419); every existing caller and test still reads it from here. */
export { quarantinePathFor }

/** A store that needs nothing: a fresh install, or one we just quarantined. */
const startsCurrent = (): MigrationOutcome => ({
  status: 'up-to-date',
  from: CURRENT_SCHEMA_VERSION,
  to: CURRENT_SCHEMA_VERSION,
  applied: [],
  data: {},
  changed: false
})

/** How every failure path below names a thrown value. One spelling, so the logged text of a
 *  read/rename/write failure is identical whichever step produced it. */
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Either the file's bytes, or the finished outcome the caller must return unchanged. */
type ReadStoreStep = { raw: string; result?: undefined } | { raw?: undefined; result: StoreFileMigration }

/** Read the store bytes. A missing file is a fresh install; any other read failure leaves the
 *  file untouched and unstamped (a file we could not read is a file we must not describe). */
function readStoreBytes(storePath: string, hooks: MigrationHooks): ReadStoreStep {
  try {
    return { raw: readFileSync(storePath, 'utf8') }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { result: { ...startsCurrent(), path: storePath, wrote: false, fileMissing: true } }
    }
    const message = errText(err)
    hooks.error?.(`store schema: cannot read ${storePath} (${message}); leaving it untouched`)
    return { result: { ...startsCurrent(), path: storePath, wrote: false, fileMissing: false, readError: message } }
  }
}

// ------------------------------------------------------------------- salvage (JOS-272)
//
// A QUARANTINE USED TO BE THE END OF THE STORY: the file went to `<name>.corrupt.json` and the user
// came up on factory settings with every alert, character, preference and window position gone —
// and no notice, because from inside the app "the store did not parse" and "this is a fresh install"
// were the same state. The corrupt file was always the recovery; nobody could reach it.
//
// THE ONE RULE THIS SECTION IS BUILT AROUND: A SALVAGE THAT HALF-RESTORES IS WORSE THAN DEFAULTS.
// Defaults are at least a state the user can recognise and rebuild from. A store missing an
// arbitrary tail of its keys is a store where some settings came back and others silently did not,
// which is indistinguishable from the app losing them again later. So every repair is LOSSLESS — it
// either recovers a COMPLETE object or it recovers nothing. The three mechanics that make it so
// (de-padding, the balanced top-level prefix, and the refusal to close unbalanced brackets) are
// `tornJson.ts`'s header now, and the reasoning went with them.
//
// And the recovered object is then VALIDATED before it is adopted: a plain object, non-empty,
// carrying at least one key that identifies it as this app's store in some era it has had, and a
// `schemaVersion` that is a whole number if it is there at all. Failing any of those, we fall to the
// pristine `<name>.v<N>.backup.json` copy — older, but complete, and written by this module itself —
// and failing THAT, to defaults exactly as before. The quarantined file is kept either way.

/** Top-level keys that identify a file as THIS app's settings store, across every era it has had:
 *  the version stamp, today's per-character progress, the pre-41831cc single `progress` blob, and
 *  the alert list. A file carrying none of them is not our store and is never adopted. */
const STORE_ANCHOR_KEYS = ['schemaVersion', 'byCharacter', 'progress', 'alerts']

/** Is this recovered value a store we are willing to run on? See the section header. */
function looksLikeStore(v: unknown): v is StoreData {
  if (!isPlainObject(v)) return false
  if (!STORE_ANCHOR_KEYS.some((k) => k in v)) return false
  const version = v[SCHEMA_VERSION_KEY]
  if (version === undefined) return true
  return typeof version === 'number' && Number.isInteger(version) && version >= 1
}

/** THE SCANNER MOVED (JOS-419): `stripTornPadding`, `balancedObjectPrefix` and the parse-if-
 *  acceptable wrapper are `tornJson.ts`'s now, byte-for-byte, so the resist ledger reads the same
 *  answer instead of a second copy of them. What stayed here is this app's STORE policy. */

/** What a successful salvage recovered, and how. `detail` is the human half of the log line. */
interface Salvage {
  data: StoreData
  from: SalvageSource
  detail: string
}

/** Recover a complete store from torn bytes, or answer undefined. Lossless only — header. The scan
 *  is shared; the only thing the STORE adds to it is `looksLikeStore`. */
function salvageBytes(raw: string): { data: StoreData; residue: number } | undefined {
  const found = salvageJsonObject(raw, looksLikeStore)
  return found === undefined ? undefined : { data: found.value, residue: found.residue }
}

/** `<name>.v<N>.backup.json` siblings, newest schema version first. Never throws. */
function backupCandidates(storePath: string): { path: string; v: number }[] {
  const dir = dirname(storePath)
  const prefix = `${basename(storePath).replace(/\.json$/i, '')}.v`
  const suffix = '.backup.json'
  const found: { path: string; v: number }[] = []
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue
      const v = Number(name.slice(prefix.length, name.length - suffix.length))
      if (Number.isInteger(v) && v >= 1) found.push({ path: join(dir, name), v })
    }
  } catch {
    return []
  }
  return found.sort((a, b) => b.v - a.v)
}

/**
 * THE RECOVERY LADDER: the user's own torn bytes first (freshest), then the newest pristine backup
 * this module wrote at some past schema upgrade (older, but complete and written by us). Both ends
 * answer a WHOLE store or nothing at all.
 *
 * `detail` CARRIES NO PATH, deliberately. It is read twice — once by a human in `errors.log`, where
 * the path is on the same line anyway, and once by the fleet after `redactMessage` has replaced
 * every path-shaped run with `<path>`, taking the rest of the line with it. Naming the backup by its
 * VERSION instead of its filename is what keeps the outcome legible on the second reading.
 */
function salvageStore(storePath: string, raw: string): Salvage | undefined {
  const torn = salvageBytes(raw)
  if (torn) {
    const residue = torn.residue > 0 ? `, ${torn.residue} stale trailing bytes discarded` : ''
    const count = Object.keys(torn.data).length
    return { data: torn.data, from: 'torn-bytes', detail: `${count} settings out of the torn file${residue}` }
  }
  for (const candidate of backupCandidates(storePath)) {
    let bytes: string
    try {
      bytes = readFileSync(candidate.path, 'utf8')
    } catch {
      continue
    }
    const backup = salvageBytes(bytes)
    if (backup) {
      const count = Object.keys(backup.data).length
      return { data: backup.data, from: 'backup', detail: `${count} settings out of the v${candidate.v} backup` }
    }
  }
  return undefined
}

// ------------------------------------------------------------------------- writing

/**
 * THE STORE FILE'S ONE WRITER, and it is atomic (JOS-272): temp + fsync + rename, the JOS-265
 * pattern, so a process killed part-way through leaves either the old complete file or the new one
 * and never a half of either. Tab-indented to match conf's serializer, so our write and
 * electron-store's writes produce identical formatting instead of churning the whole file.
 */
function writeStoreFile(path: string, data: StoreData): void {
  writeFileDurable(dirname(path), path, JSON.stringify(data, undefined, '\t'))
}

/** Unparseable (or not an object): conf would throw on every single read from here on. Moves the
 *  file aside and answers where it went, or the finished (failed) outcome. */
function quarantineStore(storePath: string, hooks: MigrationHooks): string | StoreFileMigration {
  const quarantine = quarantinePathFor(storePath)
  try {
    renameSync(storePath, quarantine)
    return quarantine
  } catch (err) {
    const message = errText(err)
    hooks.error?.(`store schema: ${storePath} is not valid JSON and could not be moved aside (${message})`)
    return { ...startsCurrent(), path: storePath, wrote: false, fileMissing: false, readError: message }
  }
}

/**
 * Pristine copy of the ORIGINAL bytes, once per source version. A failure here is logged
 * but never blocks the migration: refusing to upgrade forever because a backup could not
 * be written is strictly worse than upgrading without one.
 *
 * IT IS ALSO A SALVAGE SOURCE NOW (JOS-272), which is why it goes through the atomic write like
 * everything else here: a backup torn by the same kill that tore the store would be a recovery
 * that cannot recover.
 */
function writeBackupOnce(
  storePath: string,
  raw: string,
  fromVersion: number,
  hooks: MigrationHooks
): string | undefined {
  const backup = backupPathFor(storePath, fromVersion)
  try {
    // BYTE-FOR-BYTE, still: the pristine copy is the ORIGINAL text, not a re-serialisation of the
    // parsed value. Only the WRITE became atomic.
    if (!existsSync(backup)) writeFileDurable(dirname(backup), backup, raw)
    return backup
  } catch (err) {
    hooks.error?.(`store schema: backup to ${backup} failed (${errText(err)})`)
    return undefined
  }
}

/** Write the migrated data back, recording the result of the attempt on `result`. */
function writeMigrated(
  storePath: string,
  outcome: MigrationOutcome,
  result: StoreFileMigration,
  hooks: MigrationHooks
): void {
  try {
    writeStoreFile(storePath, outcome.data)
    result.wrote = true
    hooks.info?.(
      `store schema: v${outcome.from} → v${outcome.to} (${outcome.applied.join(', ') || 'no steps'}); ` +
        `backup ${result.backupPath ?? 'none'}`
    )
  } catch (err) {
    const message = errText(err)
    hooks.error?.(`store schema: v${outcome.from} → v${outcome.to} could not be written (${message}); will retry next launch`)
    result.wrote = false
    // Nothing persisted ⇒ nothing may be stamped, or the failed steps would be skipped forever.
    result.to = outcome.from
  }
}

/**
 * PUT A SALVAGED STORE BACK where the app will look for it. The migration chain writes only when it
 * changed something; a salvage that needed no steps changed nothing and would otherwise leave the
 * live path EMPTY (the bytes are in the quarantine file), which is the defaults boot all over again.
 */
function restoreSalvaged(
  storePath: string,
  data: StoreData,
  result: StoreFileMigration,
  hooks: MigrationHooks
): void {
  try {
    writeStoreFile(storePath, data)
    result.wrote = true
    hooks.info?.(`store schema: salvaged store written back to ${storePath}`)
  } catch (err) {
    hooks.error?.(
      `store schema: the salvaged store could not be written to ${storePath} (${errText(err)}); starting from defaults`
    )
    result.fileMissing = true
  }
}

/** The store this run is going to migrate, however we came by it. */
interface StoreSource {
  data: StoreData
  /** The bytes the pristine backup is taken from: the file's own text on the ordinary path, the
   *  re-serialised recovery on a salvage (the original bytes are already in the quarantine file). */
  raw: string
  /** Set when `data` was RECOVERED from a quarantined file rather than simply read. */
  quarantinedPath?: string
  salvagedFrom?: SalvageSource
}

/** Run the chain over one source, back it up and write the result. The whole of the old
 *  `migrateStoreFile` below the parse, unchanged except for the salvage write-backs. */
function runMigration(storePath: string, source: StoreSource, hooks: MigrationHooks): StoreFileMigration {
  const outcome = migrateStoreData(source.data)
  const result: StoreFileMigration = { ...outcome, path: storePath, wrote: false, fileMissing: false }
  if (source.quarantinedPath !== undefined) result.quarantinedPath = source.quarantinedPath
  if (source.salvagedFrom !== undefined) result.salvagedFrom = source.salvagedFrom
  const salvaged = source.salvagedFrom !== undefined

  if (outcome.status === 'up-to-date') {
    if (salvaged) restoreSalvaged(storePath, outcome.data, result, hooks)
    return result
  }

  const backup = writeBackupOnce(storePath, source.raw, outcome.from, hooks)
  if (backup !== undefined) result.backupPath = backup

  if (outcome.status === 'future') {
    hooks.error?.(
      `store schema: ${storePath} is at v${outcome.from} but this build only knows v${CURRENT_SCHEMA_VERSION}. ` +
        'Leaving it untouched and running best-effort - a downgrade never rewrites a newer store.'
    )
    // …except when there is nothing left on disk to leave untouched: a salvaged newer store still
    // has to be put back, verbatim, or the "downgrade never rewrites" promise costs the user the file.
    if (salvaged) restoreSalvaged(storePath, source.data, result, hooks)
    return result
  }

  writeMigrated(storePath, outcome, result, hooks)
  if (outcome.status === 'partial' && outcome.failed) {
    hooks.error?.(
      `store schema: migration to v${outcome.failed.to} failed (${outcome.failed.error}); ` +
        `store left at v${result.to}, retrying next launch`
    )
  }
  return result
}

/**
 * Read the store file, run the chain, back it up, write it back. Call ONCE at startup,
 * before electron-store is constructed. Never throws.
 */
export function migrateStoreFile(storePath: string, hooks: MigrationHooks = {}): StoreFileMigration {
  const read = readStoreBytes(storePath, hooks)
  if (read.result) return read.result
  const raw = read.raw

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    parsed = undefined
    void err
  }
  if (isPlainObject(parsed)) return runMigration(storePath, { data: parsed, raw }, hooks)

  const quarantine = quarantineStore(storePath, hooks)
  if (typeof quarantine !== 'string') return quarantine

  // ONE ERROR LINE EITHER WAY, AND THE OUTCOME COMES BEFORE THE PATHS. This is the line JOS-272 (iv)
  // finally makes visible to the fleet, and the fleet reads it AFTER `redactMessage`, which replaces
  // a path-shaped run with `<path>` and eats everything to the end of the line with it. Written the
  // obvious way round — "<path> is not valid JSON, moved to <path>, salvaged 12 settings" — every
  // report in the error store would redact down to `store schema: <path>` and the one thing worth
  // knowing (did the user keep their settings?) would be the part that got redacted away.
  const salvage = salvageStore(storePath, raw)
  const verdict = salvage ? `salvaged ${salvage.detail}` : 'starting from defaults'
  const line = `store schema: the store file is not valid JSON, ${verdict} - ${storePath} was moved to ${quarantine}`
  if (!salvage) {
    hooks.error?.(line)
    return { ...startsCurrent(), path: storePath, wrote: false, fileMissing: true, quarantinedPath: quarantine }
  }
  hooks.error?.(line)
  return runMigration(
    storePath,
    {
      data: salvage.data,
      raw: JSON.stringify(salvage.data, undefined, '\t'),
      quarantinedPath: quarantine,
      salvagedFrom: salvage.from
    },
    hooks
  )
}
