// preload/sounds.ts — the SOUND half of the app bridge: installed packs, audio bytes, the
// openpeon registry browser, and the user's own imported sounds (JOS-68).
//
// Spread into `api` in index.ts rather than written there, for the reason perf.ts states: that
// file sits at the repo's 400-code-line factoring ceiling and the answer to that is a split,
// not a widened threshold. It is the same one-module-per-domain shape main's `ipc/` uses — this
// file is the mirror of `src/main/ipc/sounds.ts` — and it changes nothing about the surface:
// `window.eq.listSoundPacks()` and friends sit exactly where they always did.
//
// NO PATH EVER CROSSES THIS BRIDGE. `getSoundData` takes a pack id (validated at the handler
// with `isSafePackId`) and a manifest key; `importUserSounds` opens the OS picker in MAIN and
// answers with minted ids and display labels, never a filename the renderer could store.

import { ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  PackInstallProgress,
  PackMutationResult,
  PackPreviewList,
  RegistryListResult,
  SoundData,
  SoundPack,
  UserSound,
  UserSoundImportResult,
  UserSoundRemoveResult
} from '../shared/types'
import type { SoundPackPrefs } from '../shared/soundPacks'

export const soundsBridge = {
  listSoundPacks: (): Promise<SoundPack[]> => ipcRenderer.invoke(IPC.listSoundPacks),
  getSoundData: (packId: string, soundId: string): Promise<SoundData | null> =>
    ipcRenderer.invoke(IPC.getSoundData, packId, soundId),
  // ---- the default-pack preference (JOS-273) ----
  /** The stored blob: the user's default pack and the shipped packs they deleted. */
  getSoundPackPrefs: (): Promise<SoundPackPrefs> => ipcRenderer.invoke(IPC.getSoundPackPrefs),
  /** "Make this pack my default" — or null for "use whatever the app ships". */
  setDefaultSoundPack: (packId: string | null): Promise<SoundPackPrefs> =>
    ipcRenderer.invoke(IPC.setDefaultSoundPack, packId),
  // NO `readAudioSession` HERE ANY MORE (JOS-443, owner: "we don't need any special audio
  // debugging tools at all"). It bridged a WASAPI read of this app's own mixer session for the
  // Preferences sound check; card, channel and native reader are all deleted. Audio failures are
  // still never silent — they go to errors.log from alerts/audioHealth.ts — they simply have no
  // surface of their own.
  /** Subscribe to "available sound packs changed" pushes (startup auto-provisioning). */
  onSoundPacksChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.onSoundPacksChanged, listener)
    return () => ipcRenderer.removeListener(IPC.onSoundPacksChanged, listener)
  },

  // ---- the user's own sounds (JOS-68) ----
  /** Every sound the user has imported into the reserved `my-sounds` pack. */
  listUserSounds: (): Promise<UserSound[]> => ipcRenderer.invoke(IPC.listUserSounds),
  /** Open the OS file picker in main and copy what was chosen into that pack. */
  importUserSounds: (): Promise<UserSoundImportResult> => ipcRenderer.invoke(IPC.importUserSounds),
  /** Remove one imported sound by its manifest key (alerts pointing at it are left alone). */
  removeUserSound: (soundId: string): Promise<UserSoundRemoveResult> =>
    ipcRenderer.invoke(IPC.removeUserSound, soundId),

  // ---- sound-pack registry (openpeon.com integration, Task #29) ----
  /** List registry packs (installed-flag reconciled). `force` bypasses the 24h cache. */
  listRegistryPacks: (force?: boolean): Promise<RegistryListResult> =>
    ipcRenderer.invoke(IPC.packsRegistry, force ?? false),
  /** Install a pack by name; watch onPackProgress for per-phase progress. */
  installPack: (name: string): Promise<PackMutationResult> =>
    ipcRenderer.invoke(IPC.packsInstall, name),
  /** Uninstall a user-installed pack by name. */
  uninstallPack: (name: string): Promise<PackMutationResult> =>
    ipcRenderer.invoke(IPC.packsUninstall, name),
  /** Preview a registry pack's sounds BEFORE install (fetched off GitHub raw). */
  previewPackSounds: (name: string): Promise<PackPreviewList> =>
    ipcRenderer.invoke(IPC.packsPreviewList, name),
  /** Fetch one preview audio file's bytes for a registry pack (null on failure). */
  previewPackSound: (name: string, file: string): Promise<SoundData | null> =>
    ipcRenderer.invoke(IPC.packsPreviewSound, name, file),
  /** Subscribe to install progress pushes. */
  onPackProgress: (cb: (p: PackInstallProgress) => void): (() => void) => {
    const listener = (_e: unknown, p: PackInstallProgress): void => cb(p)
    ipcRenderer.on(IPC.onPackProgress, listener)
    return () => ipcRenderer.removeListener(IPC.onPackProgress, listener)
  }
}
