// userSounds.ts — "bring your own sound" (JOS-68), main half: the OS file picker, the copy
// into the reserved pack, and the removal.
//
// THE FILE IS COPIED, NEVER REFERENCED. An alert that pointed at
// `C:\Users\me\Downloads\fanfare.mp3` would go mute the day that folder is tidied, and it
// would put an absolute path in the store and across IPC. So an import reads the bytes once
// and writes them into `<userData>/my-sounds/sounds/<soundId>.<ext>` — a filename minted
// from the sanitized id, so not one byte of user-supplied path text ever reaches `join()`.
// The original filename survives only as the DISPLAY label inside manifest.json.
//
// THE PICKER IS MAIN'S. `dialog.showOpenDialog` runs here (the share / character-sheet
// precedent), so the renderer never sees a filesystem path at all: it asks, and it is told
// which sounds now exist. There is no renderer `<input type=file>` anywhere in this flow.
//
// WHAT THE PACK IS: an ordinary pack directory — `manifest.json` + `sounds/` — so
// `readManifest`, `getSoundData` and every picker read it with the code they already had.
// Only its ROOT is different (`<userData>/my-sounds/`, never inside `soundpacks/`), which is
// what makes it uncollidable with a registry pack; see shared/userSounds.ts.
//
// EVERY FILE OPERATION TAKES ITS ROOT (the maps-library pattern): the two exported entry
// points resolve `userSoundsRoot()` and everything below is Electron-free, so
// tests/userSounds.test.mts drives the real copy/remove against a temp dir.

import { dialog, type BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logError } from './errorLog'
import { isInsideDir } from './security'
import { userSoundsRoot } from './sounds'
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_MB,
  USER_SOUNDS_PACK_ID,
  USER_SOUNDS_PACK_NAME,
  USER_SOUND_EXTENSIONS,
  baseName,
  userSoundId,
  userSoundLabel
} from '../shared/userSounds'
import type {
  SoundPackManifest,
  UserSound,
  UserSoundImportResult,
  UserSoundRejection,
  UserSoundRemoveResult
} from '../shared/types'

/**
 * Read the reserved pack's manifest under `root`, or a fresh empty one. Never throws: a
 * corrupt file is logged and treated as empty rather than taking the alerts view down with
 * it (the audio is still on disk, and the next import rewrites the manifest).
 */
export function readUserManifest(root: string): SoundPackManifest {
  // The id and name are OURS, not the file's — a hand-edited manifest must not be able to
  // re-title the reserved pack into something a picker would read as a registry pack.
  const empty: SoundPackManifest = { id: USER_SOUNDS_PACK_ID, name: USER_SOUNDS_PACK_NAME, sounds: {} }
  const file = join(root, 'manifest.json')
  if (!existsSync(file)) return empty
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as SoundPackManifest
    if (!parsed || typeof parsed.sounds !== 'object') return empty
    return { ...empty, sounds: parsed.sounds }
  } catch (err) {
    logError('main:userSounds', { message: `bad manifest at ${file}`, err })
    return empty
  }
}

function writeUserManifest(root: string, manifest: SoundPackManifest): void {
  mkdirSync(join(root, 'sounds'), { recursive: true })
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
}

/** The pack's sounds as the management list shows them (manifest order = import order). */
export function listUserSounds(root: string): UserSound[] {
  return Object.entries(readUserManifest(root).sounds).map(([soundId, s]) => ({
    soundId,
    label: s.label
  }))
}

/** The extension (lowercase, no dot) if this file is one we accept, else null. */
function acceptedExt(path: string): string | null {
  const name = baseName(path).toLowerCase()
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  const ext = name.slice(dot + 1)
  return (USER_SOUND_EXTENSIONS as readonly string[]).includes(ext) ? ext : null
}

/**
 * Copy ONE chosen file into the pack, mutating `manifest`. Returns the new entry, or the
 * rejection sentence the user reads. Every refusal names the file by BASENAME — a reply
 * carrying the folder the user browsed would put a path back on the channel this whole
 * design exists to keep clean.
 */
function importOne(
  root: string,
  path: string,
  manifest: SoundPackManifest
): { added: UserSound } | { rejected: UserSoundRejection } {
  const file = baseName(path)
  const ext = acceptedExt(path)
  if (!ext) {
    return { rejected: { file, reason: `only ${USER_SOUND_EXTENSIONS.join(', ')} files can be played` } }
  }
  let bytes: number
  try {
    bytes = statSync(path).size
  } catch (err) {
    logError('main:userSounds', { message: `cannot stat import ${file}`, err })
    return { rejected: { file, reason: 'the file could not be read' } }
  }
  if (bytes > MAX_IMPORT_BYTES) {
    const mb = (bytes / (1024 * 1024)).toFixed(1)
    const reason = `${mb} MB is too large - alert sounds are capped at ${MAX_IMPORT_MB} MB`
    return { rejected: { file, reason } }
  }

  const soundId = userSoundId(file, new Set(Object.keys(manifest.sounds)))
  const rel = `sounds/${soundId}.${ext}`
  try {
    mkdirSync(join(root, 'sounds'), { recursive: true })
    writeFileSync(join(root, rel), readFileSync(path))
  } catch (err) {
    logError('main:userSounds', { message: `failed copying ${file}`, err })
    return { rejected: { file, reason: 'the file could not be copied' } }
  }
  const label = userSoundLabel(file)
  manifest.sounds[soundId] = { file: rel, label }
  return { added: { soundId, label } }
}

/**
 * Import a batch of already-chosen files into `root`. The manifest is written ONCE, after
 * the whole batch, so a failure part-way leaves the pack exactly as consistent as it was.
 */
export function importUserSoundFiles(root: string, paths: readonly string[]): UserSoundImportResult {
  const manifest = readUserManifest(root)
  const added: UserSound[] = []
  const rejected: UserSoundRejection[] = []
  for (const path of paths) {
    const outcome = importOne(root, path, manifest)
    if ('added' in outcome) added.push(outcome.added)
    else rejected.push(outcome.rejected)
  }
  if (added.length) writeUserManifest(root, manifest)
  return { canceled: false, added, rejected, sounds: listUserSounds(root) }
}

/**
 * Open the OS picker and import everything chosen. The `sounds:importUser` handler.
 *
 * The parent window is PASSED IN rather than fetched from `./windows`: importing that module
 * pulls the whole main process (store → channel → `app.isPackaged`) into anything that reads
 * this file, and the unit test reads this file.
 */
export async function importUserSounds(parent: BrowserWindow | null): Promise<UserSoundImportResult> {
  const root = userSoundsRoot()
  const opts = {
    title: 'Add a sound',
    buttonLabel: 'Add',
    properties: ['openFile' as const, 'multiSelections' as const],
    filters: [{ name: 'Audio', extensions: [...USER_SOUND_EXTENSIONS] }]
  }
  const res = parent
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts)
  if (res.canceled || !res.filePaths.length) {
    return { canceled: true, added: [], rejected: [], sounds: listUserSounds(root) }
  }
  return importUserSoundFiles(root, res.filePaths)
}

/**
 * Remove one imported sound: its manifest entry and its copied file.
 *
 * `soundId` is a manifest KEY, never a path — the file deleted is the manifest's own `file`
 * value, and it is deleted only after `isInsideDir` proves it resolves inside the pack. An
 * unknown key removes nothing and says so.
 *
 * ALERTS THAT REFERENCED IT ARE LEFT ALONE, DELIBERATELY. The renderer warns by name before
 * calling this, and a def the user chose is not the app's to rewrite (the retired-pack
 * migration rewrites refs into packs the APP withdrew; this is the user's own removal, and
 * re-importing the same file re-mints the same id, whole again). Meanwhile the alert is not
 * mute: `getSoundData` answers a missing custom sound with the shipped default's "A moment
 * of your time" line — see sounds.ts.
 */
export function removeUserSoundFrom(root: string, soundId: string): UserSoundRemoveResult {
  const manifest = readUserManifest(root)
  const entry = manifest.sounds[soundId] as SoundPackManifest['sounds'][string] | undefined
  if (!entry) return { removed: false, sounds: listUserSounds(root) }

  const file = join(root, entry.file)
  if (isInsideDir(file, root) && existsSync(file)) {
    try {
      rmSync(file, { force: true })
    } catch (err) {
      // The manifest entry still goes: a file we cannot delete must not keep a row on
      // screen that the user has already dismissed.
      logError('main:userSounds', { message: `failed removing ${entry.file}`, err })
    }
  }
  const { [soundId]: _gone, ...rest } = manifest.sounds
  writeUserManifest(root, { ...manifest, sounds: rest })
  return { removed: true, sounds: listUserSounds(root) }
}

/** The `sounds:removeUser` handler: remove one imported sound from the real pack. */
export function removeUserSound(soundId: string): UserSoundRemoveResult {
  return removeUserSoundFrom(userSoundsRoot(), soundId)
}

/** The `sounds:listUser` handler: the real pack's imported sounds. */
export function listImportedSounds(): UserSound[] {
  return listUserSounds(userSoundsRoot())
}
