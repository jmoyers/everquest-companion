// AlertsView — manage triggered-sound alerts + global sound preferences.
//
// Layout (dense, dark, matches the app):
//   - a top bar with the global volume slider + mute toggle, "Sound packs…"
//     (opens the openpeon.com registry browser — Task #29), "Add alert", and a
//     "Reset to defaults" button (restores the seeded built-in set, confirmed)
//     — AlertsToolbar.tsx,
//   - a list of alerts in the stored order, narrowed by the toolbar's search box (JOS-178),
//     each with an enable switch, per-alert volume, a
//     pack→sound picker, a compact trigger chip, Test / Edit / Delete, and an
//     expandable "recent fires" panel (time + the actual matched log line)
//     — AlertList.tsx,
//   - an add/EDIT dialog: every alert — including the seeded built-ins — opens in
//     it (name, trigger type/kind/where, raw regex with live validation, sound,
//     volume, cooldown). Built-ins are just stored defs with stable ids
//     — AlertDialog.tsx (+ ConditionEditor.tsx / conditionDraft.ts).
//
// This file is now the composition root: dialog open/close state, the share
// toast, and wiring the pieces to useAlertsStore.ts (defs/prefs/packs over IPC
// plus the live recent-fires history from the alerts module).

import { type JSX, useCallback, useState } from 'react'
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography
} from '@mui/material'
import Snackbar from '@mui/material/Snackbar'
import MuiAlert from '@mui/material/Alert'
import type { AlertDef } from '@shared/types'
import type { ShareApplyResult } from '@shared/profiles'
import { previewAlertNow, refreshAlertStore } from './player'
import SoundPacksDialog from './SoundPacksDialog'
import MySoundsDialog from './MySoundsDialog'
import SuggestAlertsDialog from './SuggestAlertsDialog'
import AlertDialog from './AlertDialog'
import AlertList from './AlertList'
import AlertsToolbar from './AlertsToolbar'
import UpgradeOffers from './UpgradeOffers'
import { useUpgradeOffers } from './lineIntel'
import { useAlertsStore, type AlertsStore } from './useAlertsStore'
import { useAlertFilter } from './useAlertFilter'
import { useBannerOverlay } from './useBannerOverlay'
import type { VoiceSetupNotice } from './VoiceSetupLink'
import ShareImportDialog from '../profiles/ShareImportDialog'
import { copyText } from '../../lib/clipboard'
import { useSpeechSetup } from '../../lib/useVoices'

interface Toast {
  severity: 'success' | 'warning'
  text: string
}

/** Toast for a share-string copy of one alert (`ids:[id]`) or every alert. */
function shareToast(ok: boolean, ids: string[] | undefined, len: number): Toast {
  const what = ids?.length === 1 ? 'Alert' : 'All alerts'
  return ok
    ? { severity: 'success', text: `${what} copied - paste it to share (${len} chars).` }
    : { severity: 'warning', text: 'Could not reach the clipboard.' }
}

/** Toast for an applied (additive) share import. */
function importToast(res: ShareApplyResult): Toast {
  return {
    severity: res.ok ? 'success' : 'warning',
    text: res.ok
      ? res.added
        ? `Added ${res.added} alert${res.added === 1 ? '' : 's'}${res.skipped ? `, skipped ${res.skipped} you already had` : ''}.`
        : 'Nothing to add - you already have every alert in that string.'
      : res.error ?? 'Import failed.'
  }
}

function AlertsToast({ toast, onClose }: { toast: Toast | null; onClose: () => void }): JSX.Element {
  return (
    <Snackbar
      open={!!toast}
      autoHideDuration={5000}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      <MuiAlert severity={toast?.severity ?? 'success'} variant="filled" onClose={onClose}>
        {toast?.text}
      </MuiAlert>
    </Snackbar>
  )
}

/** Open/close + "add vs edit" state for the one AlertDialog instance. */
interface EditDialog {
  open: boolean
  target: AlertDef | null
  openAdd: () => void
  openEdit: (def: AlertDef) => void
  close: () => void
}

function useEditDialog(): EditDialog {
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<AlertDef | null>(null)
  return {
    open,
    target,
    openAdd: () => {
      setTarget(null)
      setOpen(true)
    },
    openEdit: (def) => {
      setTarget(def)
      setOpen(true)
    },
    close: () => setOpen(false)
  }
}

function ConfirmResetDialog({
  open,
  onCancel,
  onConfirm
}: {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs">
      <DialogTitle>Reset alerts to defaults?</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary">
          This replaces all alerts, including any you added or edited, with the
          seeded built-in set (Charm break + Raid target defeated). This can&apos;t be undone.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button color="warning" variant="contained" onClick={onConfirm}>
          Reset
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/**
 * The reset confirmation, whole: its flag, the confirm that performs the reset, and the
 * dialog itself. A hook rather than four things in the view body, matching `useEditDialog`
 * and `useShareToast` above — the view asks for a reset, it does not sequence one.
 */
function useResetConfirm(store: AlertsStore): { request: () => void; dialog: JSX.Element } {
  const [open, setOpen] = useState(false)
  const confirm = useCallback(async () => {
    await store.resetAlerts()
    setOpen(false)
  }, [store])
  return {
    request: () => setOpen(true),
    dialog: (
      <ConfirmResetDialog
        open={open}
        onCancel={() => setOpen(false)}
        onConfirm={() => void confirm()}
      />
    )
  }
}

/** Which sound surface is open: the registry browser, the user's own imports, or neither. */
type SoundSurface = 'packs' | 'mine' | null

/**
 * The two sound-library dialogs. One browses packs somebody PUBLISHED (the openpeon
 * registry); the other manages the pack the user MADE (JOS-68) — import, hear, remove. They
 * are mutually exclusive by construction: ONE piece of state, never two booleans that could
 * both be true. `alerts` is read-only, and only so a removal can name what plays the sound.
 */
function SoundLibraryDialogs({
  surface,
  store,
  onClose,
  onChanged
}: {
  surface: SoundSurface
  /**
   * The view's data layer, whole. Four of its fields are needed here — the alerts (so a removal
   * can name what plays the sound), the installed packs, the default-pack preference and the
   * setter for it — and passing them individually was four props for one object the caller
   * already holds.
   */
  store: AlertsStore
  onClose: () => void
  onChanged: () => void
}): JSX.Element {
  return (
    <>
      <SoundPacksDialog
        open={surface === 'packs'}
        packs={store.sortedPacks}
        defaultPackId={store.defaultPackId}
        onSetDefault={(id) => void store.setDefaultPack(id)}
        onClose={onClose}
        onInstalledChange={onChanged}
      />
      <MySoundsDialog
        open={surface === 'mine'}
        alerts={store.alerts}
        onClose={onClose}
        onChanged={onChanged}
      />
    </>
  )
}

/** The share/import toast, plus the one action that raises it (copy a share string). */
function useShareToast(): {
  toast: Toast | null
  setToast: (t: Toast | null) => void
  copyShare: (ids?: string[]) => Promise<void>
} {
  const [toast, setToast] = useState<Toast | null>(null)
  /** Copy a share string for one alert (`ids:[id]`) or every alert (`ids` omitted). */
  const copyShare = useCallback(async (ids?: string[]) => {
    const text = await window.eq.exportAlertsShare(ids)
    const ok = await copyText(text)
    setToast(shareToast(ok, ids, text.length))
  }, [])
  return { toast, setToast, copyShare }
}

/**
 * THE UPGRADE STRIP — the one place THIS view volunteers an alert, and it never acts on its own
 * (AGENTS.md: state, never process). Levelling intelligence: an alert pinned to a rank you have
 * outgrown. "Add alongside" (the default) keeps the old rank firing for the loadout that still
 * uses it. It renders nothing at all when there is nothing to say.
 *
 * IT BELONGS HERE BECAUSE IT EDITS THIS LIST. The observed-driven poison-slow offer used to sit
 * beside it and does NOT (docs/plans/suggest-dialog-redesign.md §2): that one CREATES an alert
 * from something the log showed, which is exactly what the suggest dialog is for, so it moved
 * into that dialog's "From your fights" section. This strip rewrites alerts that already exist.
 */
function OfferStrips({ store }: { store: AlertsStore }): JSX.Element {
  const { alerts, spellLastCast, persistAlerts } = store
  const upgrades = useUpgradeOffers(alerts, spellLastCast)
  const persist = (def: AlertDef): void => void persistAlerts(def)
  return (
    <UpgradeOffers
      offers={upgrades.offers}
      alerts={alerts}
      onPersist={persist}
      onDismiss={upgrades.dismiss}
    />
  )
}

/**
 * "Is there a voice to speak with, and how do I go fix it" — resolved ONCE for the whole view.
 *
 * Once, not per row: the answer is global (it is a property of the machine and the chosen tier),
 * and asking the kokoro tier costs an IPC round trip per ask. The list and the editor read the
 * same object, so a row and the dialog opened from it can never disagree.
 */
function useVoiceSetupNotice(onOpen?: () => void): VoiceSetupNotice {
  const gap = useSpeechSetup()
  return { gap, ...(onOpen ? { onOpen } : {}) }
}

/**
 * The one AlertDialog instance, with everything it needs read off the objects this view already
 * holds. Its own component because `AlertsView` sits against the 100-code-line function ceiling —
 * a dialog with nine props is exactly the shape that breaches it — and because a caller passing a
 * whole store is a smaller surface than one restating six of its fields.
 */
function EditAlertDialog({
  store,
  edit,
  voiceSetup,
  banner
}: {
  store: AlertsStore
  edit: EditDialog
  voiceSetup: VoiceSetupNotice
  /** The banner overlay's state for this tab, plus the way to the switch that changes it. */
  banner: { on: boolean; onOpenPrefs?: () => void }
}): JSX.Element {
  return (
    <AlertDialog
      open={edit.open}
      initial={edit.target}
      packs={store.sortedPacks}
      defaultPackId={store.defaultPackId}
      voiceSetup={voiceSetup}
      allAlwaysPlay={store.prefs.alwaysPlayAll === true}
      bannerOverlayOn={banner.on}
      onOpenOverlayPrefs={banner.onOpenPrefs}
      onClose={edit.close}
      onSave={(def) => {
        void store.persistAlerts(def)
        edit.close()
      }}
    />
  )
}

/**
 * `onOpenVoicePrefs` is the ONE App-facing prop of this view, and it is optional by agreement:
 * App.tsx hands it `prefsRouting.openSection('voice')` so a row that offers voice output while
 * the chosen tier has nothing to speak with can LINK to the place that fixes it instead of naming
 * it in prose. Optional because a caller that has no router (and every test that mounts this view
 * bare) must still compile — the link simply does not render.
 */
export default function AlertsView({
  onOpenVoicePrefs,
  onOpenOverlayPrefs
}: {
  onOpenVoicePrefs?: () => void
  /**
   * The SECOND such prop, on the same terms (JOS-378): App.tsx hands it
   * `prefsRouting.openSection('overlays')` so an alert editor whose on-screen controls are hidden
   * — because the banner overlay is off — can LINK to the switch instead of naming it in prose.
   */
  onOpenOverlayPrefs?: () => void
} = {}): JSX.Element {
  const store = useAlertsStore()
  const { alerts, prefs, sortedPacks, history, persistAlerts, removeAlert } = store
  const voiceSetup = useVoiceSetupNotice(onOpenVoicePrefs)
  // ONE reader for the whole tab (useBannerOverlay.ts): the list's column and the dialog's block
  // obey the same visibility rule, so they must read the same answer rather than each asking.
  const bannerOverlayOn = useBannerOverlay()
  // Local search over every facet an alert carries (JOS-178). It narrows the LIST and nothing
  // else: every alert still fires, whatever the box says.
  const filter = useAlertFilter(alerts, sortedPacks)

  const edit = useEditDialog()
  const reset = useResetConfirm(store)
  const [soundSurface, setSoundSurface] = useState<SoundSurface>(null)
  const [suggestOpen, setSuggestOpen] = useState(false)
  // Sharing (src/shared/profiles.ts): copy one/all alerts as a paste-safe EQC1- string, or
  // import someone else's ADDITIVELY through the shared preview dialog.
  const [importOpen, setImportOpen] = useState(false)
  const { toast, setToast, copyShare } = useShareToast()

  return (
    <Stack spacing={2} sx={{ height: '100%' }}>
      {/* Global controls */}
      <AlertsToolbar
        prefs={prefs}
        onPrefsDrag={store.setPrefs}
        onPrefsCommit={(next) => void store.persistPrefs(next)}
        search={filter}
        hasAlerts={alerts.length > 0}
        onOpenPacks={() => setSoundSurface('packs')}
        onOpenMySounds={() => setSoundSurface('mine')}
        onCopyAll={() => void copyShare()}
        onOpenImport={() => setImportOpen(true)}
        onReset={reset.request}
      />

      {/* What the app has noticed and would like to offer — see OfferStrips above. */}
      <OfferStrips store={store} />

      {/* Alert list */}
      <AlertList
        alerts={filter.visible}
        history={history}
        packs={sortedPacks}
        voiceSetup={voiceSetup}
        defaultPackId={store.defaultPackId}
        bannerOverlayOn={bannerOverlayOn}
        filtering={filter.filtering}
        onAddSuggestion={() => setSuggestOpen(true)}
        handlers={{
          onPersist: (def) => void persistAlerts(def),
          onVolumeDrag: store.setAlertVolume,
          onTest: previewAlertNow,
          onCopyShare: (ids) => void copyShare(ids),
          onEdit: edit.openEdit,
          onRemove: (id) => void removeAlert(id)
        }}
      />

      <EditAlertDialog
        store={store}
        edit={edit}
        voiceSetup={voiceSetup}
        banner={{ on: bannerOverlayOn, ...(onOpenOverlayPrefs ? { onOpenPrefs: onOpenOverlayPrefs } : {}) }}
      />

      <SoundLibraryDialogs
        surface={soundSurface}
        store={store}
        onClose={() => setSoundSurface(null)}
        onChanged={() => void store.refreshPacks()}
      />

      <SuggestAlertsDialog
        open={suggestOpen}
        alerts={alerts}
        defaultPackId={store.defaultPackId}
        poisonSlowSeen={store.poisonSlowSeen}
        onClose={() => setSuggestOpen(false)}
        onCreate={persistAlerts}
        onDelete={removeAlert}
        spellLastCast={store.spellLastCast}
        onCreateManually={() => {
          // Escape hatch: close the picker and open the blank manual editor.
          setSuggestOpen(false)
          edit.openAdd()
        }}
      />

      <ShareImportDialog
        open={importOpen}
        scope="alerts"
        onClose={() => setImportOpen(false)}
        onApplied={(res) => {
          void store.reload()
          void refreshAlertStore()
          setToast(importToast(res))
        }}
      />

      <AlertsToast toast={toast} onClose={() => setToast(null)} />

      {reset.dialog}
    </Stack>
  )
}
