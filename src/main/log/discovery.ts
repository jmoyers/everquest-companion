// EverQuest Legends install-root DISCOVERY (pure, dependency-free core).
//
// A friend installing the game should need zero config: the app sweeps sensible
// candidate install roots and picks the first one that actually holds a `Logs`
// directory with an `eqlog_*.txt` in it. A manual override (persisted in
// electron-store) always wins — that lives in config.ts's `resolveEqDir`, which
// is the ONLY consumer that needs the store. This module stays free of the store
// (and thus of electron) so the discovery logic is unit-testable under plain node.
//
// What a manual override MEANS is decided here too, by `normalizeEqDirOverride`
// (JOS-53): the install root, the `Logs` folder or a log file all resolve to the
// same `{ root, logsDir }` pair. See the block comment above that function.
//
// Discovery order (first hit wins, see `discoverEqRoot`):
//   1. `extraCandidates()` — env escape hatch, then registry InstallLocations.
//   2. `<drive>\<Daybreak subpath>` across every fixed drive.
// On THIS machine (2026-08) there are no Daybreak/EverQuest registry keys — the
// game lives at the public path — so discovery resolves via the drive sweep.
//
// NOTHING HERE SPAWNS A SUBPROCESS (JOS-184). The registry and drive-topology questions
// are asked through `native-reg`, an in-process N-API binding to the Win32 registry API.
// They used to be `reg.exe query … /s` and `wmic logicaldisk`, and an unsigned app that
// shells out to `reg`/`wmic` seconds after install is the exact behavioural signature AV
// heuristics score on — discovery is what a friend's Defender/Norton sees this app do
// FIRST. See the block comments on `registryInstallCandidates` and `fixedDrives`.

import { existsSync, readdirSync, statSync } from 'fs'
import type * as NativeReg from 'native-reg'
import { join } from 'path'

/** The canonical Daybreak install root on a default EQ Legends install. */
export const EQ_ROOT =
  'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends'

/** Relative sub-paths (below a drive root) where a Daybreak install commonly lands. */
const DAYBREAK_SUBPATHS = [
  'Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends',
  'Daybreak Game Company\\Installed Games\\EverQuest Legends',
  'Program Files\\Daybreak Game Company\\Installed Games\\EverQuest Legends',
  'Program Files (x86)\\Daybreak Game Company\\Installed Games\\EverQuest Legends',
  // Legacy Sony Online Entertainment layout (pre-Daybreak rename), just in case.
  'Users\\Public\\Sony Online Entertainment\\Installed Games\\EverQuest Legends',
  'Program Files (x86)\\Sony Online Entertainment\\Installed Games\\EverQuest Legends'
]

// ---------------------------------------------------------------------------
// Pure discovery core (injectable probes → unit-testable without a real disk /
// registry). The exported wrappers below bind the real fs + `reg query`.
// ---------------------------------------------------------------------------

export interface DiscoveryProbes {
  /** True if `<root>\Logs` exists AND contains at least one `eqlog_*.txt`. */
  hasLogs: (root: string) => boolean
  /** Ordered candidate roots to try before the drive sweep (env, registry). */
  extraCandidates: () => string[]
  /** Fixed-drive letters to sweep, e.g. ['C:', 'D:']. */
  fixedDrives: () => string[]
  /**
   * Wall-clock CEILING for the whole sweep, in ms (JOS-112). Omitted ⇒ unbounded (the unit
   * tests, whose probes never block). When set, `discoverEqRoot` stops probing candidates once
   * the budget is spent and returns null — a BOUNDED MISS (fall back to "user picks manually")
   * beats an UNBOUNDED HANG. The individual blocking calls are bounded elsewhere (per-`reg`
   * timeouts; `fixedDrives` skips the offline mapped drives that block on the SMB timeout), so
   * this is the backstop that caps the CUMULATIVE cost, not a per-call interrupt: a single
   * synchronous `readdir` cannot be aborted mid-flight, but the ones AFTER the deadline never run.
   */
  budgetMs?: number
  /** Injectable clock for the ceiling (tests advance it deterministically). Defaults to `Date.now`. */
  now?: () => number
}

/** The character-log filename the game writes: `eqlog_<Char>_<server>.txt`. */
const EQLOG_RE = /^eqlog_.+\.txt$/i

/** A candidate path that names THIS game rather than one of its siblings. See `legendsFirst`. */
const EQ_LEGENDS_PATH_RE = /everquest\s*legends/i

/**
 * THIS APP IS FOR EVERQUEST **LEGENDS**, AND A MACHINE CAN HAVE MORE THAN ONE EVERQUEST ON IT
 * (2026-08-17). Stable-partition a tier of candidates so the ones whose path names Legends are
 * probed first.
 *
 * MEASURED on the reporting machine, whose registry yields all of these and in this order:
 *
 *     C:\Users\wange\AppData\Local\Programs\everquest-companion   (this app's own uninstall entry)
 *     D:\Games\EverQuest                                          (retail/Teek — 38 character logs)
 *     D:\Games\EverQuest II
 *     D:\Games\EverQuest Legends                                  (the one we want)
 *
 * `discoverEqRoot` returns the FIRST candidate that has logs, and `D:\Games\EverQuest` has 38 of
 * them — so without this the registry lookup does not merely fail, it succeeds at tailing the
 * WRONG GAME, which is a worse outcome than finding nothing (the user gets a confidently populated
 * app full of data from a game this app does not model). `hasLogs` cannot break the tie: a retail
 * EverQuest log directory is shaped exactly like a Legends one, same `eqlog_<Char>_<server>.txt`.
 * The path is the only evidence available at this point, and where the path is silent (an install
 * at `D:\Games\EQL`) the tie genuinely cannot be broken here — that is what the Settings override
 * is for, and it always wins.
 *
 * WHY PER-TIER AND NOT ONE GLOBAL SORT: "an explicit env/registry candidate outranks the drive
 * sweep" is its own precedence law, pinned by eqDiscovery.test.mts, and a registry candidate whose
 * path happens not to say "Legends" (`E:\Games\EQL`) must still be probed before a swept public
 * path that does. So each tier is partitioned on its own and the tiers stay in order. STABLE, so
 * within a tier nothing else about the existing order changes — on a machine with exactly one
 * EverQuest, every candidate lands in the same bucket and this is a no-op.
 */
export function legendsFirst(candidates: readonly string[]): string[] {
  const named: string[] = []
  const rest: string[] = []
  for (const c of candidates) (EQ_LEGENDS_PATH_RE.test(c) ? named : rest).push(c)
  return [...named, ...rest]
}

/**
 * THE OUTCOME OF READING A LOGS DIR — three answers, never two (JOS-82).
 *
 * `countCharacterLogs` used to answer `0` for all of "the folder is not there", "the folder is
 * there and holds no character log" and "the OS refused to let me list the folder". The Settings
 * card then printed ONE sentence for all three — *"No character logs (eqlog_*.txt) found here.
 * Make sure EverQuest logging is enabled (/log on)"* — which is actively misleading for the third:
 * the user is looking at their files in Explorer while the app tells them to go turn logging on.
 * A prod reporter on 0.6.3 hit exactly that shape ("I pointed it directly to the log folder and it
 * said there were no character logs in that directory"), and a swallowed `readdir` throw is the
 * only way the app can say that about a folder that demonstrably has logs in it.
 *
 * So the read REPORTS ITS FAILURE. Callers that must keep moving (discovery's predicate) still
 * collapse it to "no", but the surface the user reads gets to say something true.
 */
export type LogsDirRead =
  /** The directory was listed successfully; `count` character logs are in it (possibly 0). */
  | { ok: true; count: number }
  /** The directory does not exist. */
  | { ok: false; reason: 'missing' }
  /** The directory exists but could not be listed — permissions, a dead junction, an offline share. */
  | { ok: false; reason: 'unreadable'; code: string }

/**
 * List a Logs dir and count its `eqlog_*.txt` files, distinguishing a FAILED read from an empty
 * one. `existsSync` is not consulted first: a single `readdirSync` answers both questions and
 * cannot race between them (a dir can vanish between the two calls), and ENOENT is exactly the
 * "missing" answer.
 */
export function readLogsDir(logsDir: string): LogsDirRead {
  try {
    return { ok: true, count: readdirSync(logsDir).filter((f) => EQLOG_RE.test(f)).length }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    // ENOENT (nothing there) and ENOTDIR (a FILE where a directory was expected) are both
    // "there is no such directory" — neither is a permission story and neither should be
    // reported to the user as one.
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'missing' }
    return { ok: false, reason: 'unreadable', code: code ?? 'UNKNOWN' }
  }
}

/**
 * Does `<root>\Logs` hold at least one character log? The discovery predicate.
 *
 * A dir we cannot read is `false` here on purpose — discovery is a sweep over candidate roots
 * and must keep moving. The honest three-way answer is for the folder the user CHOSE, which is
 * `resolveEqDir`'s business, not the sweep's.
 */
export function rootHasLogs(root: string): boolean {
  const read = readLogsDir(join(root, 'Logs'))
  return read.ok && read.count > 0
}

/** Count the `eqlog_*.txt` files under a Logs dir (0 if the dir is absent or unreadable). */
export function countCharacterLogs(logsDir: string): number {
  const read = readLogsDir(logsDir)
  return read.ok ? read.count : 0
}

/** Does this directory hold an `eqlog_*.txt` DIRECTLY (i.e. is it itself a Logs dir)? */
export function dirHasCharacterLogs(dir: string): boolean {
  return countCharacterLogs(dir) > 0
}

// ---------------------------------------------------------------------------
// MANUAL-OVERRIDE NORMALIZATION — "wherever the user points it" (JOS-53).
//
// The override used to be trusted VERBATIM as the install ROOT, with `Logs` joined onto it.
// Two prod reports on 2026-08-06 (installs 23e958f4… and 88f3835a…) hit the other reading:
// they pointed the picker at their `…\EverQuest Legends\Logs` folder — the folder that
// literally contains the file the app is looking for — and got "no logs detected", because
// we then looked in `…\Logs\Logs`. One of them filed a second report apologizing for
// "total user error". That is the signature of a SILENT WRONG ANSWER: the app resolved a
// path with source 'manual' and characterCount 0 and never said the folder it actually read.
//
// So the seam normalizes instead of trusting. Three shapes a reasonable person picks:
//   * a log FILE (`eqlog_*.txt`)          → its folder is the Logs dir, its parent the root
//   * the `Logs` folder itself            → it is the Logs dir, its parent the root
//   * the install ROOT (a `Logs` subdir)  → unchanged, this is what already worked
// Anything else keeps the old behavior (root as given), and `characterCount` tells the
// Settings pane the truth as it always did.
//
// It is a pure function over injected probes so the whole table is unit-tested against temp
// dirs, and — because it runs at RESOLUTION time, not at save time — an override that was
// already persisted in a broken shape starts working on upgrade with no re-save.
// ---------------------------------------------------------------------------

/** The filesystem questions override normalization asks. Injected → testable. */
export interface OverrideProbes {
  /** Is this an existing directory? */
  isDir: (p: string) => boolean
  /** Is this an existing FILE (as opposed to a directory / nothing)? */
  isFile: (p: string) => boolean
  /** Does this directory hold an `eqlog_*.txt` directly? */
  hasCharacterLogs: (dir: string) => boolean
}

/** The two paths every consumer needs, resolved from one user-supplied path. */
export interface NormalizedEqDir {
  /** The install root (`<root>\Logs` is the log directory). */
  root: string
  /** The directory the `eqlog_*.txt` files actually live in. */
  logsDir: string
}

/**
 * Drop trailing separators — but never turn a drive root (`D:\`) into a bare drive
 * (`D:`), which Windows reads as "the current directory ON D:" and which `join`
 * would happily concatenate into `D:Logs`.
 */
function stripTrailingSep(p: string): string {
  const t = p.replace(/[\\/]+$/, '')
  if (t === '') return p
  return /^[A-Za-z]:$/.test(t) ? `${t}\\` : t
}

/** Index of the last separator of either flavour (paths reach us from store, picker and env). */
function lastSep(p: string): number {
  return Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
}

/** The last path segment, separator- and trailing-slash-tolerant. */
function baseSegment(p: string): string {
  const t = stripTrailingSep(p)
  const cut = lastSep(t)
  return cut < 0 ? t : t.slice(cut + 1)
}

/** The containing directory, separator- and trailing-slash-tolerant. */
function parentDir(p: string): string {
  const t = stripTrailingSep(p)
  const cut = lastSep(t)
  if (cut < 0) return t
  const parent = t.slice(0, cut)
  if (parent === '') return t.slice(0, cut + 1)
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent
}

/**
 * Resolve one user-supplied path into `{ root, logsDir }`. See the block comment above for
 * why. The order of the tests is deliberate:
 *   1. a FILE is reasoned about through its containing folder (a picked `eqlog_*.txt`, or
 *      anything else sitting in the install — the folder is the useful part either way);
 *   2. a folder NAMED `Logs` is the log directory (case-insensitive; true even when logging
 *      has never been turned on, which is exactly when it holds no `eqlog_*.txt` to detect);
 *   3. a folder holding a `Logs` SUBDIR is the install root — this is the shape that already
 *      worked and it is tested before the content sniff so the pathological folder that is
 *      both stays interpreted the way it is today;
 *   4. a folder holding `eqlog_*.txt` directly is the log directory whatever it is called;
 *   5. anything else (a typo, an unplugged drive, a folder with neither) keeps the old
 *      behavior — root as given, `<root>\Logs` beneath it.
 */
export function normalizeEqDirOverride(picked: string, probes: OverrideProbes): NormalizedEqDir {
  const path = stripTrailingSep(picked.trim())
  const asRoot = (root: string): NormalizedEqDir => ({ root, logsDir: join(root, 'Logs') })

  const dir = probes.isFile(path) ? parentDir(path) : path
  if (!probes.isDir(dir)) return asRoot(path)
  if (baseSegment(dir).toLowerCase() === 'logs') return { root: parentDir(dir), logsDir: dir }
  if (probes.isDir(join(dir, 'Logs'))) return asRoot(dir)
  if (probes.hasCharacterLogs(dir)) return { root: parentDir(dir), logsDir: dir }
  return asRoot(dir)
}

/** The real-filesystem probe set for `normalizeEqDirOverride`. */
export function realOverrideProbes(): OverrideProbes {
  const stat = (p: string): ReturnType<typeof statSync> | undefined => {
    try {
      return statSync(p, { throwIfNoEntry: false })
    } catch {
      // A path we cannot stat (permissions, a disconnected UNC share) is "not there".
      return undefined
    }
  }
  return {
    isDir: (p) => stat(p)?.isDirectory() ?? false,
    isFile: (p) => stat(p)?.isFile() ?? false,
    hasCharacterLogs: dirHasCharacterLogs
  }
}

/**
 * Normalize a Windows path for comparison: one separator style, no trailing
 * separator, case-folded (NTFS is case-insensitive and the log/override paths
 * reach us from three different sources — the store, a folder picker, readdir).
 */
function normPath(p: string): string {
  return p.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** Is `logPath` a file sitting DIRECTLY in `logsDir` (not merely existing somewhere)? */
export function logIsUnderLogsDir(logPath: string, logsDir: string): boolean {
  const dir = normPath(logsDir)
  const file = normPath(logPath)
  const cut = file.lastIndexOf('\\')
  return cut > 0 && file.slice(0, cut) === dir
}

/**
 * THE ROOT-CHANGE DECISION, pure and injected so it can be tested without a disk.
 *
 * When the effective EQ root moves (the Settings override is set or cleared), may the tail
 * that is already running survive it? ONLY if its log lives under the NEW `Logs` dir and is
 * still there. "The file still exists" is NOT sufficient and was the bug: a user whose game
 * lives off the default path gets auto-discovery pointed somewhere else (or nowhere), and if
 * anything was being tailed from the OLD root its file is still perfectly readable — so the
 * app kept reading it and the folder the user just picked did nothing until a restart.
 */
export function tailSurvivesRootChange(
  logPath: string | null | undefined,
  logsDir: string,
  exists: (p: string) => boolean
): boolean {
  if (!logPath) return false
  return logIsUnderLogsDir(logPath, logsDir) && exists(logPath)
}

/**
 * Pure ordered discovery: return the first candidate root whose `Logs` dir holds
 * an `eqlog_*.txt`, or null if none match. Candidates, in order:
 *   1. `extraCandidates()` (env override, then registry InstallLocations)
 *   2. `<drive>\<subpath>` for every fixed drive × every Daybreak subpath
 * Duplicates are collapsed so a candidate is probed at most once.
 */
export function discoverEqRoot(probes: DiscoveryProbes): string | null {
  const now = probes.now ?? Date.now
  // The ceiling is an absolute instant computed once, at entry. `extraCandidates()` (env +
  // registry) runs first and carries its OWN per-`reg` timeout, so by the time we reach the
  // probe loop the clock already reflects whatever that phase cost.
  const deadline = probes.budgetMs === undefined ? Infinity : now() + probes.budgetMs
  const overBudget = (): boolean => now() >= deadline

  const seen = new Set<string>()
  const candidates: string[] = []
  const push = (c: string | undefined | null): void => {
    if (!c) return
    const key = c.replace(/[\\/]+$/, '').toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(c)
  }

  // Each tier is `legendsFirst`-partitioned on its own, so a path naming Legends outranks a
  // sibling EverQuest install WITHIN its tier while the tiers keep their own precedence.
  for (const c of legendsFirst(probes.extraCandidates())) push(c)
  // Skip generating (and thus probing) the drive-sweep candidates once we are already over
  // budget — the env/registry phase alone can spend it on a pathological Uninstall hive.
  if (!overBudget()) {
    const swept: string[] = []
    for (const drive of probes.fixedDrives()) {
      const d = drive.replace(/[\\/]+$/, '')
      for (const sub of DAYBREAK_SUBPATHS) swept.push(`${d}\\${sub}`)
    }
    for (const c of legendsFirst(swept)) push(c)
  }

  for (const c of candidates) {
    // Check BEFORE each probe: a `readdir` on an offline share can take tens of seconds, so the
    // guarantee is "no further probes after the deadline", which bounds the total to one such
    // stall plus the budget. `fixedDrives` keeps those shares out of the list in the first place.
    if (overBudget()) return null
    if (probes.hasLogs(c)) return c
  }
  return null
}

// ---------------------------------------------------------------------------
// PERSISTED-ACROSS-LAUNCHES discovery (JOS-112). The pure precedence logic, injected so it is
// unit-testable without a store or a disk — config.ts binds it to electron-store + the real sweep.
// ---------------------------------------------------------------------------

/** What `resolveDiscoveredRoot` needs, all injected → testable without electron-store or fs. */
export interface CachedRootDeps {
  /** The root a PREVIOUS launch persisted, or null if none is stored. */
  persisted: string | null
  /** Revalidate a candidate root — the one `readdir` `rootHasLogs` already does. */
  hasLogs: (root: string) => boolean
  /** Run the full (expensive) discovery sweep — registry subprocesses + the drive walk. */
  sweep: () => string | null
  /** Persist a POSITIVE discovery so the next launch can skip the sweep entirely. */
  persist: (root: string) => void
  /** Drop a persisted root that no longer validates — SELF-HEAL across sessions. */
  dropPersisted: () => void
}

/**
 * Resolve the discovered root with cross-launch persistence, first launch and every re-discovery:
 *
 *   1. a persisted root that STILL passes `hasLogs` (one readdir) wins — the sweep never runs;
 *   2. a persisted root that FAILS revalidation is dropped (self-heal: the install moved or was
 *      uninstalled under us) and we fall through to the sweep;
 *   3. the sweep runs, and ONLY a positive hit is persisted — a null "not found" is NEVER cached,
 *      so a brand-new user who has not run `/log on` yet keeps getting the cheap idle rescan
 *      rather than a sticky negative.
 *
 * This is the ACROSS-SESSIONS extension of config.ts's in-memory invalidate/revalidate pattern.
 */
export function resolveDiscoveredRoot(deps: CachedRootDeps): string | null {
  if (deps.persisted !== null) {
    if (deps.hasLogs(deps.persisted)) return deps.persisted
    deps.dropPersisted()
  }
  const found = deps.sweep()
  if (found !== null) deps.persist(found)
  return found
}

// ---------------------------------------------------------------------------
// Real-environment probes (fs + registry). Defensive: absent keys / drives are
// fine and never throw.
// ---------------------------------------------------------------------------

/**
 * THE REGISTRY BINDING, LOADED LAZILY AND ALLOWED TO BE ABSENT (JOS-184).
 *
 * `native-reg` is an N-API binding to the Win32 registry API — ABI-stable across Node and
 * Electron (so `npmRebuild` stays false, see electron-builder.yml) and shipped as a prebuilt
 * `.node` INSIDE the npm tarball, which is what makes it work under `.npmrc`'s
 * `ignore-scripts=true`. That last point is why it is this package and not the more obvious
 * `registry-js`: registry-js downloads its prebuild from an `install` script, which this repo
 * never runs.
 *
 * `require` at first use rather than a top-level `import`, and a swallowed failure, because
 * this module sits on the STARTUP path: config.ts imports it, and an import-time throw from a
 * missing or unloadable `.node` would stop the app from launching at all rather than costing us
 * one of three ways to find the install. With the binding absent, `registryInstallCandidates`
 * returns nothing and `fixedDrives` falls back to the A-Z sweep — the same degradation as a
 * machine with no Daybreak keys, which is most machines.
 */
let registryModule: typeof NativeReg | null | undefined

function registry(): typeof NativeReg | null {
  if (registryModule === undefined) {
    try {
      // Deferring the native load past module evaluation, and being able to CATCH it failing, is
      // the whole point of this function; a static `import` can do neither. The main bundle is
      // CJS (electron-vite), so this is the real require, not a shim.
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
      registryModule = require('native-reg') as typeof NativeReg
    } catch {
      registryModule = null
    }
  }
  return registryModule
}

/**
 * The LOCAL (non-network) drive letters, read out of the mount table (JOS-112, JOS-184).
 *
 * WHY A DRIVE FILTER AT ALL, NOT A PER-LETTER TIMEOUT: the hang this bounds is a
 * `readdir`/`existsSync` on an OFFLINE MAPPED NETWORK DRIVE blocking on the SMB timeout (tens of
 * seconds). A synchronous fs call cannot be aborted once started, so a "per-letter timeout" would
 * need a subprocess per letter — 26 of them — and the offline share would still be TOUCHED. The
 * fix is to never put those letters in the candidate list.
 *
 * WHY THE REGISTRY AND NOT `wmic` (JOS-184): this used to shell out to
 * `wmic logicaldisk get DeviceID,DriveType` and keep DriveType 3. It worked, and it is also
 * exactly what AV heuristics score: `wmic` is deprecated, is on its way out of Windows entirely,
 * and a freshly-installed unsigned exe spawning it to enumerate the machine's disks reads as
 * reconnaissance. `HKLM\SYSTEM\MountedDevices` answers the same question in-process, from a key
 * every user can read (verified on a non-elevated 10.0.22631 session), by reading the mount table
 * as DATA — no drive is opened, so an offline share stays untouched exactly as before.
 *
 * WHAT CHANGED IN THE ANSWER, precisely: MountedDevices names LOCAL volumes only —
 * `\DosDevices\C:` and friends. A mapped network drive is NEVER in it, which is the property that
 * replaces the DriveType-4 filter and the whole reason this substitution is safe. Removable local
 * volumes (a USB stick) ARE in it, where DriveType 3 excluded them, so the sweep may now also
 * probe an external drive. That is a superset of the old candidate list, it costs a handful of
 * INSTANT `existsSync` calls on a local device, and it finds a game installed on an external disk
 * that we used to walk straight past. Stale entries for long-removed devices are filtered by the
 * one `existsSync` on the drive root below — safe precisely because every letter here is local.
 *
 * MEMOIZED for the process (drive topology barely changes and the idle rescan calls this every
 * couple of seconds — see refreshEqDiscoveryCheaply). Null means "could not read the mount table",
 * and the caller falls back.
 */
function queryLocalDriveLetters(): string[] | null {
  const reg = registry()
  if (!reg) return null
  const names = enumValueNames(reg, reg.HKLM, 'SYSTEM\\MountedDevices')
  if (names === null) return null
  const letters = driveLettersFromMountedDevices(names).filter((d) => existsSync(`${d}\\`))
  return letters.length > 0 ? letters : null
}

/**
 * Pull drive roots (`['C:', 'D:']`) out of `HKLM\SYSTEM\MountedDevices` value names. Pure, so the
 * shape of that key is a unit test rather than a claim.
 *
 * The key holds two kinds of value name: `\DosDevices\<letter>:` (a mounted drive letter) and
 * `\??\Volume{<guid>}` (the same volume by GUID, no letter). Only the first kind is a candidate.
 * Sorted so the sweep order is deterministic across machines — and so C: is probed first.
 */
export function driveLettersFromMountedDevices(valueNames: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const name of valueNames) {
    const m = /^\\DosDevices\\([A-Za-z]):$/.exec(name)
    if (m) seen.add(m[1].toUpperCase())
  }
  return [...seen].sort().map((letter) => `${letter}:`)
}

/**
 * The drive letters currently taken by a PERSISTENT mapped network drive, from the subkey names of
 * `HKCU\Network` (`HKCU\Network\Z` = `Z:` is mapped). Pure over the enumerated names.
 *
 * Only used by the FALLBACK sweep below, as the "do not touch these" list — these are the letters
 * that block on the SMB timeout when the share is offline.
 */
export function networkDriveLetters(subKeyNames: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const name of subKeyNames) {
    if (/^[A-Za-z]$/.test(name)) out.add(name.toUpperCase())
  }
  return out
}

/** Process-lifetime memo for the mount-table read (undefined = not yet asked, null = read failed). */
let cachedFixedLetters: string[] | null | undefined

/**
 * Enumerate LOCAL drive roots (e.g. ['C:', 'D:']), skipping network drives so an offline mapped
 * share can never wedge the sweep (JOS-112). Falls back to the legacy A–Z existence sweep — minus
 * any letter `HKCU\Network` says is a mapped share — and then to ['C:'].
 *
 * The name is historical (the probe interface field is `fixedDrives`); "local" is the honest word
 * for what it now returns. See `queryLocalDriveLetters` for what changed and why.
 */
export function fixedDrives(): string[] {
  if (cachedFixedLetters === undefined) cachedFixedLetters = queryLocalDriveLetters()
  if (cachedFixedLetters) return cachedFixedLetters
  // The mount table was unreadable. Probe A–Z, but never touch a letter we KNOW is a mapped share:
  // the old wmic fallback had no such list and could block for tens of seconds on an offline one.
  const reg = registry()
  const mapped = networkDriveLetters(reg ? (enumKeyNames(reg, reg.HKCU, 'Network') ?? []) : [])
  const found: string[] = []
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    const letter = String.fromCharCode(code)
    if (mapped.has(letter)) continue
    if (existsSync(`${letter}:\\`)) found.push(`${letter}:`)
  }
  return found.length > 0 ? found : ['C:']
}

// ---------------------------------------------------------------------------
// REGISTRY INSTALL CANDIDATES — in-process, scoped reads (JOS-184).
// ---------------------------------------------------------------------------

/** The value names that hold an install path in the Uninstall/launcher keys, in no order. */
const INSTALL_PATH_VALUES = ['InstallLocation', 'InstallPath', 'InstallDir'] as const

/**
 * The value names holding a FILE inside the install dir rather than the dir itself. The Daybreak
 * launcher writes these and none of the three above — see `eqInstallDirFromFileValue` for the
 * measured registry shape and why this list is exactly two names long.
 */
const INSTALL_FILE_VALUES = ['UninstallString', 'DisplayIcon'] as const

/**
 * The game's name has to appear in the path itself for it to be a candidate. This is the
 * `reg query … /f EverQuest` filter, preserved EXACTLY — see `registryInstallCandidates`.
 */
const EQ_PATH_RE = /everquest/i

/**
 * The roots probed for an install path, in the order they are asked — the same eight the eight
 * `reg query` subprocesses covered, spelled the same way. The hive is a TAG rather than a
 * `native-reg` constant so this table can exist without the binding being loaded.
 */
const INSTALL_PATH_KEYS: readonly { hive: 'HKLM' | 'HKCU'; path: string }[] = [
  { hive: 'HKLM', path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
  { hive: 'HKLM', path: 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
  { hive: 'HKCU', path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
  { hive: 'HKLM', path: 'SOFTWARE\\Daybreak Game Company' },
  { hive: 'HKLM', path: 'SOFTWARE\\WOW6432Node\\Daybreak Game Company' },
  { hive: 'HKCU', path: 'SOFTWARE\\Daybreak Game Company' },
  { hive: 'HKLM', path: 'SOFTWARE\\WOW6432Node\\Sony Online Entertainment' },
  { hive: 'HKCU', path: 'SOFTWARE\\Sony Online Entertainment' }
]

/**
 * How deep below each root an install path is looked for. The Uninstall hives are FLAT (one subkey
 * per installed product), and the Daybreak/SOE launcher keys nest one or two deep
 * (`…\Daybreak Game Company\Installed Games\EverQuest`). Three levels covers both with room to
 * spare; `reg query /s` was unbounded, which is only a difference for a shape nobody ships.
 */
const MAX_KEY_DEPTH = 3

/** Hard ceiling on keys opened per sweep, so a pathological hive cannot turn this into a walk. */
const MAX_KEYS_VISITED = 8000

/**
 * Keep a registry value only if it is a non-empty install path that names the game.
 *
 * PURE, and the exact contract the `reg.exe` command it replaces had — which was verified against
 * the real tool rather than read off the docs (2026-08-10, Windows 11 10.0.22631):
 *   * `reg query <key> /s /f EverQuest /t REG_SZ` prints one line per REG_SZ value whose NAME or
 *     DATA contains "everquest", case-insensitively, plus the key header;
 *   * with `/t` present a KEY-NAME match prints NOTHING AT ALL (`…\CurrentVersion /s /f RunMRU
 *     /t REG_SZ` finds 0 matches although the RunMRU key exists; without `/t` it finds 1, the key
 *     line alone and none of its values);
 *   * so the old `installPathFromRegLine` regex — an InstallLocation/InstallPath/InstallDir line,
 *     whose own NAME never contains "everquest" — could only ever fire on a DATA match.
 * Hence: value name in `INSTALL_PATH_VALUES`, data a string containing "everquest". Same installs
 * discovered, and a key named `EverQuest` whose InstallLocation does not say so is still skipped,
 * exactly as it was.
 */
export function eqInstallPathValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const p = value.trim()
  return p && EQ_PATH_RE.test(p) ? p : null
}

/**
 * THE DAYBREAK LAUNCHER WRITES NO `InstallLocation`, SO THE INSTALL DIR HAS TO COME OUT OF A FILE
 * PATH — one `dirname` away, and this is that step.
 *
 * MEASURED on a reporter's machine (2026-08-17, Windows 11 10.0.26200), a real EQ Legends install
 * at `D:\Games\EverQuest Legends` that discovery could not find AT ALL. The registry knew exactly
 * where it was; the values above were simply not the ones it used:
 *
 *   HKCU\…\CurrentVersion\Uninstall\DGC-EverQuest Legends
 *       DisplayName        EverQuest Legends
 *       UninstallString    D:\Games\EverQuest Legends\Uninstaller.exe
 *       DisplayIcon        D:\Games\EverQuest Legends\Everquest.ico
 *
 * No `InstallLocation`, no `InstallPath`, no `InstallDir` — so `eqInstallPathValue` could never
 * fire, and the drive sweep's `DAYBREAK_SUBPATHS` do not contain a `Games\` layout either. The
 * `DGC-` prefix is the Daybreak launcher's own key-naming convention (`DGC-EverQuest`,
 * `DGC-EverQuest II`, `DGC-EverQuest Legends` all present on that box), so this shape is the
 * launcher's, not one machine's peculiarity.
 *
 * WHY THE FILTER STAYS ON THE RAW VALUE, not on the derived directory: that is exactly what
 * `eqInstallPathValue` does, and it is the more permissive of the two — an `EverQuest.exe` sitting
 * in a folder whose own name never says so still yields its folder as a CANDIDATE. Being a
 * candidate costs one `readdir`; `hasLogs` is what actually decides, and it is the only thing that
 * should. The same permissiveness admits the harmless near-misses this necessarily picks up (an
 * EverQuest II install, and this app's OWN uninstall entry, whose InstallLocation says
 * "everquest-companion") — none of them hold a `Logs\eqlog_*.txt` and all of them fail the probe.
 *
 * PURE, and separated from the registry walk, so the command-line shapes below are a unit test
 * rather than a claim about someone's machine.
 */
export function eqInstallDirFromFileValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (!raw || !EQ_PATH_RE.test(raw)) return null
  const file = programPathFromCommand(raw)
  if (file === null) return null
  const dir = parentDir(file)
  // `parentDir` hands back its argument unchanged when there is no separator at all (a bare
  // `Uninstaller.exe`), which is not a directory and must not become a candidate.
  return dir === file ? null : dir
}

/**
 * The program/icon path out of one of those values. Three shapes, and the order matters:
 *
 *   1. `"C:\…\Uninstall EQ.exe" /currentuser` — QUOTED. The quotes are the delimiter, so this is
 *      the only shape where arguments can be split off unambiguously, and it is tried first.
 *   2. `C:\…\App.exe,0` — `DisplayIcon`'s optional icon INDEX (negative indices are legal too).
 *   3. `D:\Games\EverQuest Legends\Uninstaller.exe /S` — UNQUOTED, and the path may itself contain
 *      spaces (the measured case does). Splitting on whitespace would cut `EverQuest Legends` in
 *      half, so the file EXTENSION is the only reliable cut. Lazy, so the FIRST extension wins and
 *      an argument that is itself a path cannot extend the match.
 *
 * Anything with no recognizable executable/icon extension returns null rather than a guess — a
 * wrong directory here would be probed, fail `hasLogs`, and cost nothing, but inventing a path
 * shape nobody has observed is how a matcher starts drifting.
 */
function programPathFromCommand(raw: string): string | null {
  if (raw.startsWith('"')) {
    const close = raw.indexOf('"', 1)
    if (close < 0) return null
    const quoted = raw.slice(1, close).trim()
    return quoted === '' ? null : quoted
  }
  const withoutIconIndex = raw.replace(/,\s*-?\d+\s*$/, '')
  const m = /^(.*?\.(?:exe|ico|dll|cmd|bat))(?:\s|$)/i.exec(withoutIconIndex)
  return m ? m[1] : null
}

/** Open a key defensively — a missing key, a denied ACL and a malformed path are all `null`. */
function openKey(reg: typeof NativeReg, parent: NativeReg.HKEY, path: string): NativeReg.HKEY | null {
  try {
    // KEY_READ plus the 64-bit view: every path above spells out WOW6432Node when it wants the
    // 32-bit one, which is what `reg.exe` from this (x64) process resolved to as well.
    return reg.openKey(parent, path, reg.Access.READ | reg.Access.WOW64_64KEY)
  } catch {
    return null
  }
}

/** Enumerate a key's value names, or null if the key cannot be opened/read. */
function enumValueNames(
  reg: typeof NativeReg,
  parent: NativeReg.HKEY,
  path: string
): string[] | null {
  const key = openKey(reg, parent, path)
  if (!key) return null
  try {
    return reg.enumValueNames(key)
  } catch {
    return null
  } finally {
    reg.closeKey(key)
  }
}

/** Enumerate a key's subkey names, or null if the key cannot be opened/read. */
function enumKeyNames(reg: typeof NativeReg, parent: NativeReg.HKEY, path: string): string[] | null {
  const key = openKey(reg, parent, path)
  if (!key) return null
  try {
    return reg.enumKeyNames(key)
  } catch {
    return null
  } finally {
    reg.closeKey(key)
  }
}

/** Shared state for one `registryInstallCandidates` sweep. */
interface RegistrySweep {
  reg: typeof NativeReg
  out: string[]
  visited: number
  deadline: number
}

/**
 * The candidates stated by ONE key's OWN values — the two decoders, over their two value lists.
 *
 * Split out of `collectInstallPaths` so that function stays under the complexity ceiling and so the
 * "read a value defensively" wrapper is written once instead of per list. A value we cannot read is
 * simply not a source of candidates.
 *
 * ORDER IS PRECEDENCE: the explicit install-DIR values run first, so a key carrying both an
 * `InstallLocation` and an `UninstallString` yields the explicit one ahead of the derived one.
 * `discoverEqRoot` returns the first candidate that has logs.
 */
function collectKeyOwnValues(key: NativeReg.HKEY, sweep: RegistrySweep): void {
  const read = (name: string): unknown => {
    try {
      return sweep.reg.getValue(key, null, name)
    } catch {
      return undefined
    }
  }
  for (const name of INSTALL_PATH_VALUES) {
    const path = eqInstallPathValue(read(name))
    if (path) sweep.out.push(path)
  }
  for (const name of INSTALL_FILE_VALUES) {
    const dir = eqInstallDirFromFileValue(read(name))
    if (dir) sweep.out.push(dir)
  }
}

/**
 * Collect install paths from `key` and (to `MAX_KEY_DEPTH`) its subkeys. Every registry call is
 * wrapped: a key we cannot read is simply not a source of candidates.
 */
function collectInstallPaths(key: NativeReg.HKEY, depth: number, sweep: RegistrySweep): void {
  const reg = sweep.reg
  if (sweep.visited++ >= MAX_KEYS_VISITED || Date.now() >= sweep.deadline) return
  collectKeyOwnValues(key, sweep)
  if (depth >= MAX_KEY_DEPTH) return
  let subKeys: string[]
  try {
    subKeys = reg.enumKeyNames(key)
  } catch {
    return
  }
  for (const name of subKeys) {
    if (sweep.visited >= MAX_KEYS_VISITED || Date.now() >= sweep.deadline) return
    const child = openKey(reg, key, name)
    if (!child) continue
    try {
      collectInstallPaths(child, depth + 1, sweep)
    } finally {
      reg.closeKey(child)
    }
  }
}

/**
 * Probe the Windows registry (defensively) for an EverQuest / Daybreak install location. Checks the
 * standard Uninstall hives (both HKLM 64/32-bit views and HKCU) plus Daybreak/SOE launcher keys.
 * Returns any `InstallLocation` / `InstallPath` / `InstallDir` value that names EverQuest, plus the
 * containing directory of any `UninstallString` / `DisplayIcon` that does — the Daybreak launcher
 * writes only the latter kind (`eqInstallDirFromFileValue` carries the measured key). Plenty of
 * machines have neither and resolve through the drive sweep instead, which is fine and is the
 * documented normal for a default public-folder install.
 *
 * IN-PROCESS AND SCOPED SINCE JOS-184. This was EIGHT synchronous `reg.exe query … /s /f EverQuest`
 * subprocesses: a recursive TEXT SEARCH of the whole Uninstall hive whose stdout we then grepped
 * with a regex. Two things were wrong with that beyond taste. It cost ~150 ms of blocked main
 * thread and scaled with the size of the user's Uninstall hive — the JOS-112 deadline exists
 * because of it. And spawning `reg.exe` to sweep the uninstall registry is, to a heuristic AV
 * engine, indistinguishable from what an infostealer does in its first seconds; a friend's Norton
 * sees this happen moments after the install it already distrusts.
 *
 * Now it asks the registry directly, and asks a NARROW question: for each root, the three named
 * install-path values, down `MAX_KEY_DEPTH` levels, with the same result filter as before
 * (`eqInstallPathValue`). MEASURED on a 119-subkey Uninstall hive: 4 ms for the 64-bit view and
 * 2 ms for the 32-bit one, against ~150 ms for the eight subprocesses — the same Steam
 * "EverQuest Free-to-Play" install found by both.
 *
 * `deadline` is kept: it is the JOS-112 discovery ceiling and it now bounds a loop rather than a
 * queue of subprocesses. It is checked per key, not per root, which is strictly tighter.
 */
export function registryInstallCandidates(deadline = Infinity): string[] {
  const reg = registry()
  if (!reg) return []
  const sweep: RegistrySweep = { reg, out: [], visited: 0, deadline }
  for (const { hive, path } of INSTALL_PATH_KEYS) {
    if (Date.now() >= sweep.deadline) break
    const key = openKey(reg, hive === 'HKLM' ? reg.HKLM : reg.HKCU, path)
    if (!key) continue
    try {
      collectInstallPaths(key, 1, sweep)
    } finally {
      reg.closeKey(key)
    }
  }
  return sweep.out
}
