// LoadoutOverride — "these are the classes I am actually running", the control JOS-87 exists for.
//
// WHY IT IS SEPARATE FROM ClassComboEditor. The editor corrects a HISTORICAL SPAN: you open it
// from a row in the interval list, and what it writes is a statement about a window of time that
// has already happened. That is the right tool for repairing the record, and the wrong one for
// the thing a user actually asks for when detection gets them wrong — which is not "relabel
// 8/2 02:13 → 8/4 19:31", it is "I play SHD/ROG/DRU, stop saying NEC". The report this ticket
// came from said there was no way to correct it while the editor was already shipping, which is
// what a correction surface reachable only by opening a history row and pressing Edit amounts to.
//
// SO THIS CONTROL SPEAKS IN THE PRESENT TENSE. It states what is in effect right now and where
// that came from, it takes a manual setting for the CURRENT loadout, and it has one button that
// undoes it. Underneath it is still a time-keyed correction — `[current.startTs, null)`, i.e.
// "from the start of the span I am in, onward" — because that is the only durable combo state
// there is (§ 7) and an id-keyed override would detach on the very next fold.
//
// AND IT STAYS SET. `endTs: null` means autodetection cannot take it back: a later swap the log
// infers does not clear it, because the user telling us their classes is better evidence than
// the inference that got them wrong. The escape is this control's own "Back to autodetect", and
// the one thing that still outranks it is a `/who` row — which the model flags (`userOverruled`)
// and which is said out loud below rather than swallowed.

import { type JSX, useState } from 'react'
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography
} from '@mui/material'
import EditIcon from '@mui/icons-material/Edit'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import { MAX_COMBO_SLOTS, resolvedClasses, type ClassAbbr, type ComboInterval } from '@shared/classCombo'
import { classDisplayName } from '@shared/spellLevels'
import { ProvenanceChip, SlotChips } from './ClassComboChips'
import { loadoutSourceText, overruledText } from './ClassComboLabels'
import ClassPicker, { togglePicked } from './ClassPicker'

/**
 * The span a current-loadout override is written against: the interval you are in, open-ended.
 * Exported so the dialog and the reset button cannot disagree about what they are writing to.
 */
export function currentRange(interval: ComboInterval): { startTs: number; endTs: null } {
  return { startTs: interval.startTs, endTs: null }
}

/** Run a write, close on success, surface the main process's own refusal on failure. */
function useWriter(onDone: () => void): {
  busy: boolean
  error: string | null
  run: (fn: () => Promise<{ ok: boolean; error?: string }>) => void
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>): void => {
    setBusy(true)
    void (async () => {
      try {
        const res = await fn()
        if (res.ok) onDone()
        else setError(res.error ?? 'That setting could not be saved.')
      } finally {
        setBusy(false)
      }
    })()
  }
  return { busy, error, run }
}

/** The picker dialog. Seeded from what is in effect, so fixing one wrong slot is two clicks. */
function OverrideDialog({
  interval,
  open,
  onClose
}: {
  interval: ComboInterval
  open: boolean
  onClose: () => void
}): JSX.Element {
  // An ambiguous or unknown slot seeds NOTHING — a guess wearing the user's name is exactly
  // what this feature exists to prevent (the same rule ClassComboEditor states).
  const [picked, setPicked] = useState<ClassAbbr[]>(() => resolvedClasses(interval))
  const { busy, error, run } = useWriter(onClose)

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>Set your current classes</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          <ClassPicker picked={picked} onToggle={(c) => setPicked((prev) => togglePicked(prev, c))} />
          <Typography variant="caption" color="text.secondary" data-testid="loadout-override-count">
            {picked.length === 0
              ? 'Pick 1 to 3 classes.'
              : `${picked.map(classDisplayName).join(' / ')} - ${picked.length} of ${MAX_COMBO_SLOTS} slots.`}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            This applies from the start of your current loadout onward and stays until you change
            it or go back to autodetect.
          </Typography>
          {error && <Alert severity="warning">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button size="small" color="inherit" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={busy || picked.length === 0}
          data-testid="loadout-override-save"
          onClick={() =>
            run(() => window.eq.setComboCorrection({ ...currentRange(interval), classes: picked }))
          }
        >
          Use these classes
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/**
 * The whole control. Renders nothing but honest text when there is no interval yet — a loadout
 * override needs a span to attach to, and manufacturing one before the log has said anything
 * would put a correction on a timeline that does not exist.
 */
export default function LoadoutOverride({ current }: { current: ComboInterval | null }): JSX.Element {
  const [editing, setEditing] = useState(false)
  const { busy, error, run } = useWriter(() => undefined)

  if (!current) {
    return (
      <Typography variant="caption" color="text.disabled" data-testid="loadout-override">
        No loadout read yet - one appears as soon as the log names classes you played, and you
        can set it by hand from there.
      </Typography>
    )
  }

  const overruled = overruledText(current)
  return (
    <Stack spacing={0.75} data-testid="loadout-override">
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="caption" color="text.secondary">
          In effect now
        </Typography>
        <SlotChips slots={current.slots} />
        <ProvenanceChip interval={current} />
        <Stack sx={{ flexGrow: 1 }} />
        <Button
          size="small"
          startIcon={<EditIcon sx={{ fontSize: 14 }} />}
          onClick={() => setEditing(true)}
          data-testid="loadout-override-open"
          sx={{ minWidth: 0, py: 0, px: 0.75 }}
        >
          Set classes
        </Button>
        {current.userLocked && (
          <Button
            size="small"
            color="inherit"
            disabled={busy}
            startIcon={<RestartAltIcon sx={{ fontSize: 14 }} />}
            onClick={() => run(() => window.eq.clearComboCorrection(currentRange(current)))}
            data-testid="loadout-override-clear"
            sx={{ minWidth: 0, py: 0, px: 0.75 }}
          >
            Back to autodetect
          </Button>
        )}
      </Stack>
      <Typography variant="caption" color="text.secondary" data-testid="loadout-override-source">
        {loadoutSourceText(current)}
      </Typography>
      {overruled && (
        <Alert severity="info" sx={{ py: 0 }} data-testid="loadout-override-overruled">
          {overruled}
        </Alert>
      )}
      {error && <Alert severity="warning">{error}</Alert>}
      {editing && (
        <OverrideDialog
          key={current.startTs}
          interval={current}
          open
          onClose={() => setEditing(false)}
        />
      )}
    </Stack>
  )
}
