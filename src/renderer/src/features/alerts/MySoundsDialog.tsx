// MySoundsDialog — "bring your own sound" (JOS-68): import your own wav/mp3/ogg, hear them,
// remove them. Opens from the alerts toolbar, beside "Sound packs…".
//
// WHY IT IS NOT A SECTION OF SoundPacksDialog. That dialog browses the openpeon REGISTRY:
// every row there is a pack somebody publishes, with Install/Uninstall. "My sounds" is not a
// registry pack and must never be listed as installable or removable there — it is the one
// pack the user MAKES. Two verbs, two dialogs, and the registry browser is untouched.
//
// ONCE A SOUND IS IN HERE IT IS REFERENCEABLE EVERYWHERE, with no code in this file: main
// lists the reserved pack from `listPacks()`, so it arrives in `sortedPacks` and shows up in
// the alert-row picker and the add/edit dialog through the seam they already had.
//
// REMOVAL WARNS BUT DOES NOT REWRITE. If alerts point at the sound, the confirmation names
// them and says what they will do instead; it never edits a def the user wrote (AGENTS.md:
// the retired-pack migration rewrites refs into packs the APP withdrew — this is the user's
// own removal). Nothing goes mute either: main answers a missing custom sound with the
// shipped default's line (src/main/sounds.ts).

import { type JSX, useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  Stack,
  Typography
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import LibraryMusicIcon from '@mui/icons-material/LibraryMusic'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import type { AlertDef, UserSound, UserSoundRejection } from '@shared/types'
import {
  MAX_IMPORT_MB,
  USER_SOUNDS_PACK_ID,
  USER_SOUND_EXTENSIONS,
  USER_SOUNDS_PACK_NAME
} from '@shared/userSounds'
import { currentPrefs } from './player'
import { invalidateSoundCaches, playSound } from './soundCache'

/** Alerts whose sound is this imported one — what the delete confirmation names. */
function alertsUsing(alerts: readonly AlertDef[], soundId: string): AlertDef[] {
  return alerts.filter((a) => a.sound.packId === USER_SOUNDS_PACK_ID && a.sound.soundId === soundId)
}

/** The imported-sounds list, plus the two writes that change it. */
function useUserSounds(open: boolean, onChanged: () => void): {
  sounds: UserSound[]
  rejected: UserSoundRejection[]
  busy: boolean
  addSounds: () => Promise<void>
  removeSound: (soundId: string) => Promise<void>
} {
  const [sounds, setSounds] = useState<UserSound[]>([])
  const [rejected, setRejected] = useState<UserSoundRejection[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setRejected([])
    void window.eq.listUserSounds().then(setSounds)
  }, [open])

  const addSounds = useCallback(async () => {
    setBusy(true)
    try {
      const res = await window.eq.importUserSounds()
      if (res.canceled) return
      setSounds(res.sounds)
      setRejected(res.rejected)
      if (res.added.length) {
        // A re-import can re-mint an id that was removed, so the cached Blob for that key
        // would be the OLD bytes. Drop the caches and tell the store to re-list packs.
        invalidateSoundCaches()
        onChanged()
      }
    } finally {
      setBusy(false)
    }
  }, [onChanged])

  const removeSound = useCallback(
    async (soundId: string) => {
      const res = await window.eq.removeUserSound(soundId)
      setSounds(res.sounds)
      if (res.removed) {
        invalidateSoundCaches()
        onChanged()
      }
    },
    [onChanged]
  )

  return { sounds, rejected, busy, addSounds, removeSound }
}

/** One imported sound: hear it, or remove it. */
function SoundRow({
  sound,
  onPlay,
  onRemove
}: {
  sound: UserSound
  onPlay: (soundId: string) => void
  onRemove: (sound: UserSound) => void
}): JSX.Element {
  return (
    <Paper variant="outlined" sx={{ px: 1, py: 0.5 }} data-testid="my-sound-row">
      <Stack direction="row" spacing={1} alignItems="center">
        <IconButton size="small" title="Play" onClick={() => onPlay(sound.soundId)}>
          <PlayArrowIcon fontSize="small" />
        </IconButton>
        <Typography variant="body2" sx={{ flexGrow: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {sound.label}
        </Typography>
        <IconButton size="small" title="Remove" onClick={() => onRemove(sound)}>
          <DeleteOutlineIcon fontSize="small" />
        </IconButton>
      </Stack>
    </Paper>
  )
}

/**
 * The removal confirmation. It only appears when alerts actually reference the sound, and it
 * states BOTH facts the user needs: which alerts, and that they keep firing on the shipped
 * default line rather than going silent.
 */
function ConfirmRemoveDialog({
  target,
  users,
  onCancel,
  onConfirm
}: {
  target: UserSound | null
  users: AlertDef[]
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  return (
    <Dialog open={!!target} onClose={onCancel} maxWidth="xs">
      <DialogTitle>Remove “{target?.label}”?</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary">
          {users.length === 1 ? 'One alert plays it' : `${users.length} alerts play it`}:{' '}
          {users.map((a) => a.name).join(', ')}. They keep firing on the default alert line
          until you point them at another sound. Import the file again to get it back.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button color="warning" variant="contained" onClick={onConfirm}>
          Remove
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default function MySoundsDialog({
  open,
  alerts,
  onClose,
  onChanged
}: {
  open: boolean
  /** Read-only: which alerts reference a sound, so a removal can name them. */
  alerts: AlertDef[]
  onClose: () => void
  /** Called after an import/removal so the parent re-lists packs for every picker. */
  onChanged: () => void
}): JSX.Element {
  const { sounds, rejected, busy, addSounds, removeSound } = useUserSounds(open, onChanged)
  const [confirm, setConfirm] = useState<UserSound | null>(null)
  const users = confirm ? alertsUsing(alerts, confirm.soundId) : []

  const play = (soundId: string): void => {
    const prefs = currentPrefs()
    if (prefs.muted) return
    void playSound(USER_SOUNDS_PACK_ID, soundId, prefs.globalVolume)
  }

  // Referenced sounds ask first; an unreferenced one is a one-click removal (re-importing
  // the file restores it, so there is nothing here to lose that a second dialog would save).
  const requestRemove = (sound: UserSound): void => {
    if (alertsUsing(alerts, sound.soundId).length) setConfirm(sound)
    else void removeSound(sound.soundId)
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box sx={{ flexGrow: 1 }}>{USER_SOUNDS_PACK_NAME}</Box>
        <IconButton size="small" onClick={onClose} title="Close">
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ mt: 0.5 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Button
              startIcon={<LibraryMusicIcon />}
              variant="contained"
              size="small"
              disabled={busy}
              data-testid="my-sounds-add"
              onClick={() => void addSounds()}
            >
              Add a sound…
            </Button>
            <Typography variant="caption" color="text.secondary">
              {USER_SOUND_EXTENSIONS.join(', ')} · up to {MAX_IMPORT_MB} MB
            </Typography>
          </Stack>

          {rejected.map((r) => (
            <Alert key={r.file} severity="warning" variant="outlined">
              {r.file} - {r.reason}
            </Alert>
          ))}

          <Box sx={{ maxHeight: '45vh', overflow: 'auto' }}>
            <Stack spacing={0.5}>
              {sounds.map((s) => (
                <SoundRow key={s.soundId} sound={s} onPlay={play} onRemove={requestRemove} />
              ))}
              {sounds.length === 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
                  Nothing here yet. Add an audio file and it becomes a choice in every alert.
                </Typography>
              )}
            </Stack>
          </Box>
        </Stack>
      </DialogContent>

      <ConfirmRemoveDialog
        target={confirm}
        users={users}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm) void removeSound(confirm.soundId)
          setConfirm(null)
        }}
      />
    </Dialog>
  )
}
