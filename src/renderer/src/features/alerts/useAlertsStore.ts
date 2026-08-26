// useAlertsStore — the alerts view's data layer: defs, prefs and installed sound
// packs over IPC, plus the live recent-fires history from the alerts module.
// Extracted from AlertsView.tsx (Wave D factoring); every call and its ordering
// is unchanged.
//
// Recent fires come from the alerts module's per-alert ring buffer (the single
// source of truth), hydrated + kept live via useModule: event/raw fires arrive as
// module deltas, and renderer 'app' fires are routed back through main (appFired)
// so they land in the same history.
//
// Everything else is persisted via IPC (alerts:save / alerts:reset /
// alertPrefs:set); after any write we call refreshAlertStore() so the always-
// mounted AlertPlayer picks up the change immediately (it shares def/pref state).

import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AlertDef,
  AlertFireRecord,
  AlertPrefs,
  AlertsSnap,
  PoisonSlowRecency,
  SoundPack
} from '@shared/types'
import type { SoundPackPrefs } from '@shared/soundPacks'
import { useModule } from '../../lib/useModule'
import { onAlertStoreChange, refreshAlertStore } from './player'
import { invalidateSoundCaches } from './soundCache'



export interface AlertsStore {
  alerts: AlertDef[]
  prefs: AlertPrefs
  sortedPacks: SoundPack[]
  /**
   * THE USER'S DEFAULT SOUND PACK (JOS-273), or undefined when they have expressed no preference
   * and the shipped pack is therefore what everything means. It is the id whether or not that pack
   * is installed — "the pack I chose is gone" is a thing the surfaces have to be able to SAY, and
   * healing it here would delete the user's statement.
   */
  defaultPackId: string | undefined
  /** "Make this pack my default" — or null for "use whatever the app ships". */
  setDefaultPack: (packId: string | null) => Promise<void>
  history: Record<string, AlertFireRecord[]>
  /**
   * Rank-preserving cast recency from the alerts module ("Mesmerization III" → ts). Drives
   * the "recently cast" ordering in the suggestions surface and the upgrade offers.
   */
  spellLastCast: Record<string, number>
  /**
   * Rogue slow-poison recency from the alerts module, or null when none has ever been seen.
   * Drives the observed-driven "alert when a mob gets slowed?" offer.
   */
  poisonSlowSeen: PoisonSlowRecency | null
  /** Re-read defs + prefs + packs from main. */
  reload: () => Promise<void>
  /** Re-list packs after a registry install/uninstall. */
  refreshPacks: () => Promise<void>
  persistAlerts: (def: AlertDef) => Promise<void>
  removeAlert: (id: string) => Promise<void>
  resetAlerts: () => Promise<void>
  persistPrefs: (next: AlertPrefs) => Promise<void>
  /** Local-only prefs update (volume slider drag; committed separately). */
  setPrefs: (next: AlertPrefs) => void
  /** Local-only per-alert volume update while its slider is dragged. */
  setAlertVolume: (id: string, volume: number) => void
}

export function useAlertsStore(): AlertsStore {
  const [alerts, setAlerts] = useState<AlertDef[]>([])
  const [prefs, setPrefs] = useState<AlertPrefs>({ globalVolume: 0.7, muted: false })
  const [packs, setPacks] = useState<SoundPack[]>([])
  const [packPrefs, setPackPrefs] = useState<SoundPackPrefs>({})

  // Live recent-fires history from the alerts module (single source of truth).
  const snap = useModule<AlertsSnap>('alerts')
  const history = snap?.history ?? {}
  const spellLastCast = snap?.spellLastCast ?? {}
  const poisonSlowSeen = snap?.poisonSlowSeen ?? null

  const reload = useCallback(async () => {
    const [a, p, ps, sp] = await Promise.all([
      window.eq.listAlerts(),
      window.eq.getAlertPrefs(),
      window.eq.listSoundPacks(),
      window.eq.getSoundPackPrefs()
    ])
    setAlerts(a)
    setPrefs(p)
    setPacks(ps)
    setPackPrefs(sp)
  }, [])

  useEffect(() => {
    void reload()
    // Keep in sync if the player refreshes the shared store (e.g. on focus).
    const off = onAlertStoreChange(() => void reload())
    // A shipped default pack may finish auto-provisioning after startup — re-list packs
    // and drop any stale sound caches so it's immediately selectable/playable (Task #39).
    const offPacks = window.eq.onSoundPacksChanged(() => {
      invalidateSoundCaches()
      void reload()
    })
    return () => {
      off()
      offPacks()
    }
  }, [reload])

  // After a registry install/uninstall, re-list packs so the inline pickers +
  // add/edit dialog surface the change immediately, and refresh the always-mounted
  // player's shared store (it caches nothing pack-related, but keeps everything in
  // sync on the same tick).
  const refreshPacks = useCallback(async () => {
    // The default-pack preference is re-read WITH the pack list, because an install/uninstall can
    // change it: uninstalling a shipped pack tombstones it, and installing one clears that stone
    // (main/ipc/sounds.ts). Two round trips that always happen together are one refresh.
    const [ps, sp] = await Promise.all([window.eq.listSoundPacks(), window.eq.getSoundPackPrefs()])
    setPacks(ps)
    setPackPrefs(sp)
    await refreshAlertStore()
  }, [])

  /**
   * "Make this pack my default". The reply is the stored blob, so the UI shows what was actually
   * persisted rather than what it asked for — the same read-back discipline every prefs write in
   * this app follows.
   */
  const setDefaultPack = useCallback(async (packId: string | null) => {
    setPackPrefs(await window.eq.setDefaultSoundPack(packId))
  }, [])

  const persistAlerts = useCallback(async (def: AlertDef) => {
    const list = await window.eq.saveAlert(def)
    setAlerts(list)
    await refreshAlertStore()
  }, [])

  const removeAlert = useCallback(async (id: string) => {
    const list = await window.eq.deleteAlert(id)
    setAlerts(list)
    await refreshAlertStore()
  }, [])

  const resetAlerts = useCallback(async () => {
    const list = await window.eq.resetAlerts()
    setAlerts(list)
    await refreshAlertStore()
  }, [])

  const persistPrefs = useCallback(async (next: AlertPrefs) => {
    setPrefs(next)
    await window.eq.setAlertPrefs(next)
    await refreshAlertStore()
  }, [])

  const setAlertVolume = useCallback((id: string, volume: number) => {
    setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, volume } : a)))
  }, [])

  const sortedPacks = useMemo(
    () => [...packs].sort((a, b) => (a.source === b.source ? 0 : a.source === 'bundled' ? -1 : 1)),
    [packs]
  )

  return {
    alerts,
    prefs,
    sortedPacks,
    defaultPackId: packPrefs.defaultPackId,
    setDefaultPack,
    history,
    spellLastCast,
    poisonSlowSeen,
    reload,
    refreshPacks,
    persistAlerts,
    removeAlert,
    resetAlerts,
    persistPrefs,
    setPrefs,
    setAlertVolume
  }
}
